import { z } from "zod";
import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import { hasGodotCacheDir, hasImportCache } from "../godot/cache.js";
import {
  DEFAULT_LIST_PROJECTS_MAX_DEPTH,
  HARD_MAX_LIST_PROJECTS_DEPTH,
  listProjectDirs,
  MAX_LIST_PROJECTS_RESULTS,
  readProjectInfo,
} from "../godot/discovery.js";
import { detectGodotPath, godotNotFoundError } from "../godot/paths.js";
import { runGodotImport, type RunGodotImportResult } from "../godot/runner.js";
import type { ToolDescriptor } from "../registry.js";
import { directoryPathSchema, projectPathSchema } from "../schemas.js";

export interface ProjectToolsDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  runGodotImport: typeof runGodotImport;
  hasGodotCacheDir: typeof hasGodotCacheDir;
  hasImportCache: typeof hasImportCache;
  listProjectDirs: typeof listProjectDirs;
  readProjectInfo: typeof readProjectInfo;
}

const defaultDeps: ProjectToolsDeps = {
  loadConfig,
  detectGodotPath,
  runGodotImport,
  hasGodotCacheDir,
  hasImportCache,
  listProjectDirs,
  readProjectInfo,
};

/**
 * Converts a `RunGodotImportResult` into an MCP tool result. Godot's exit
 * code is not trusted as the success signal for a `"completed"` run (see
 * `runGodotImport`'s doc comment) - success is instead judged by
 * `hasImportCache`, the exact same predicate `load_sprite` (and any future
 * asset-dependent tool) gates on, so the two can never disagree: an
 * `import_project` success guarantees the next `load_sprite` call won't hit
 * the cold-cache error. `hasGodotCacheDir` is still checked first only to
 * pick the more specific of two error messages - it does not by itself
 * decide success.
 *
 * This does mean a project with zero importable assets (whose
 * `.godot/imported/` legitimately stays empty - see `hasImportCache`'s doc
 * comment) would be reported as a failed import here. That's an accepted
 * trade-off for keeping the success predicate simple and identical to
 * `load_sprite`'s gate; the bundled sample project always has at least one
 * importable texture, so it never exercises that edge case.
 */
function importResultToToolResult(
  result: RunGodotImportResult,
  projectPath: string,
  deps: Pick<ProjectToolsDeps, "hasGodotCacheDir" | "hasImportCache">,
) {
  switch (result.kind) {
    case "completed": {
      if (!deps.hasGodotCacheDir(projectPath)) {
        return createErrorResponse({
          message:
            `Godot exited (code ${result.exitCode ?? "unknown"}) without producing a project ` +
            `cache (.godot/) at "${projectPath}". This usually means project_path does not point ` +
            "at a valid Godot project, rather than an individual asset failing to import.",
          possibleSolutions: [
            "Confirm project_path points at the directory that directly contains project.godot.",
            'Run the same command manually to see Godot\'s full output: godot --headless --path "<project_path>" --import',
          ],
        });
      }
      if (!deps.hasImportCache(projectPath)) {
        return createErrorResponse({
          message:
            `Godot exited (code ${result.exitCode ?? "unknown"}) and created a project cache ` +
            `(.godot/) at "${projectPath}", but no import cache (.godot/imported/) was built. ` +
            "This usually means the import step failed partway through rather than project_path " +
            "being invalid, and asset-dependent tools (e.g. load_sprite) would still fail against it.",
          possibleSolutions: [
            'Run the same command manually to see Godot\'s full output: godot --headless --path "<project_path>" --import',
            "Confirm project_path contains at least one importable asset (e.g. a .png) if you expect a non-empty cache.",
          ],
        });
      }
      const exitNote =
        result.exitCode !== 0
          ? ` Godot exited with code ${result.exitCode}, which can happen even on a successful ` +
            "import - the cache was verified to exist afterward."
          : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Imported project in ${result.durationMs}ms.${exitNote}`,
          },
        ],
        structuredContent: { project_path: projectPath, duration_ms: result.durationMs },
      };
    }
    case "spawn-error":
      return createErrorResponse({
        message: `Failed to launch Godot: ${result.message}`,
        possibleSolutions: [
          "Confirm GODOT_PATH points at a valid, executable Godot 4.x binary.",
          "Try running the executable manually from a terminal to confirm it works.",
        ],
      });
    case "timeout":
      return createErrorResponse({
        message:
          `Godot did not finish importing within ${result.timeoutMs}ms and was killed. Large ` +
          "projects with many assets can take a while to import.",
        possibleSolutions: [
          "Run the same command manually from a terminal to see whether it hangs or is just " +
            'slow: godot --headless --path "<project_path>" --import',
          "Retry once whatever caused the hang (e.g. a stuck asset, a blocking dialog) is resolved.",
        ],
      });
  }
}

const importProjectInputSchema = {
  project_path: projectPathSchema,
};

const listProjectsInputSchema = {
  directory: directoryPathSchema,
  recursive: z
    .boolean()
    .optional()
    .describe(
      "Whether to search subdirectories under directory. Defaults to true. When false, only " +
        "directory itself is checked for project.godot - no subdirectories are scanned.",
    ),
  max_depth: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe(
      `Maximum subdirectory depth to descend when recursive (default ` +
        `${DEFAULT_LIST_PROJECTS_MAX_DEPTH}). Silently clamped to a hard ceiling of ` +
        `${HARD_MAX_LIST_PROJECTS_DEPTH} regardless of the value given, to rule out an ` +
        "effectively unbounded walk - never rejected as an error.",
    ),
};

const getProjectInfoInputSchema = {
  project_path: projectPathSchema,
};

/**
 * Builds the `tools/project.ts` descriptor group. Godot resolution and the
 * import invocation both happen lazily inside the handler (never at
 * registration time), matching `tools/scene.ts` and `tools/editor.ts`.
 */
export function createProjectTools(deps: ProjectToolsDeps = defaultDeps): ToolDescriptor[] {
  const importProject: ToolDescriptor<typeof importProjectInputSchema> = {
    name: "import_project",
    description:
      "Builds (or rebuilds) the Godot import cache for project_path by running " +
      "`godot --headless --import`. Required before any asset-dependent tool (e.g. load_sprite) " +
      "can load a texture or other importable resource - those tools check for an existing cache " +
      "first and fail fast with a guided error naming this tool instead of importing implicitly. " +
      "This can be slow on large projects (potentially minutes), since Godot (re)imports every " +
      "asset that needs it - expect this call to take a while to return on a big project.",
    inputSchema: importProjectInputSchema,
    handler: async ({ project_path }) => {
      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] import_project: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const result = await deps.runGodotImport({
        godotPath: resolution.path,
        projectPath: project_path,
      });

      return importResultToToolResult(result, project_path, deps);
    },
  };

  const listProjects: ToolDescriptor<typeof listProjectsInputSchema> = {
    name: "list_projects",
    description:
      "Finds Godot projects (directories directly containing a project.godot) under directory. " +
      "A bounded, depth-capped filesystem walk - never a whole-disk search: hidden " +
      "(dot-prefixed) and known system/dependency directories (.git, node_modules, AppData, " +
      "the OS recycle bin, ...) are always skipped, and the number of projects returned is " +
      `capped at ${MAX_LIST_PROJECTS_RESULTS} (structuredContent.truncated is true if more may ` +
      "exist). Does not invoke Godot - this is a pure filesystem search.",
    inputSchema: listProjectsInputSchema,
    handler: async ({ directory, recursive, max_depth }) => {
      let result;
      try {
        result = deps.listProjectDirs(directory, { recursive, maxDepth: max_depth });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return createErrorResponse({
          message: `Could not read directory "${directory}": ${reason}`,
          possibleSolutions: [
            "Confirm directory points at an existing, accessible directory.",
            "Check filesystem permissions for this path.",
          ],
        });
      }

      const truncatedNote = result.truncated
        ? ` Result count hit the cap (${MAX_LIST_PROJECTS_RESULTS}); more projects may exist under directory.`
        : "";
      return {
        content: [
          {
            type: "text" as const,
            text: `Found ${result.projects.length} project(s) under "${directory}".${truncatedNote}`,
          },
        ],
        structuredContent: { projects: result.projects, truncated: result.truncated },
      };
    },
  };

  const getProjectInfo: ToolDescriptor<typeof getProjectInfoInputSchema> = {
    name: "get_project_info",
    description:
      "Returns a Godot project's name, engine version (from project.godot's config/features " +
      "tag), and file/asset counts. project_path must directly contain project.godot - use " +
      "list_projects to find candidates first if unsure. Does not invoke Godot - this is a pure " +
      "filesystem read.",
    inputSchema: getProjectInfoInputSchema,
    handler: async ({ project_path }) => {
      const info = deps.readProjectInfo(project_path);
      if (info === null) {
        return createErrorResponse({
          message: `No project.godot found at "${project_path}".`,
          possibleSolutions: [
            "Confirm project_path points at the directory that directly contains project.godot.",
            "Use list_projects to discover Godot projects under a parent directory.",
          ],
        });
      }

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Project "${info.name ?? "(unnamed)"}" - Godot ${info.godotVersion ?? "unknown"}, ` +
              `${info.fileCount} file(s), ${info.assetCount} asset(s).`,
          },
        ],
        structuredContent: {
          project_path,
          name: info.name ?? null,
          godot_version: info.godotVersion ?? null,
          file_count: info.fileCount,
          asset_count: info.assetCount,
        },
      };
    },
  };

  return [
    importProject as unknown as ToolDescriptor,
    listProjects as unknown as ToolDescriptor,
    getProjectInfo as unknown as ToolDescriptor,
  ];
}

export const projectTools: ToolDescriptor[] = createProjectTools();
