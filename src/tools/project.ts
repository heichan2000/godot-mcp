import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import { hasGodotCacheDir, hasImportCache } from "../godot/cache.js";
import { detectGodotPath, godotNotFoundError } from "../godot/paths.js";
import { runGodotImport, type RunGodotImportResult } from "../godot/runner.js";
import type { ToolDescriptor } from "../registry.js";
import { projectPathSchema } from "../schemas.js";

export interface ProjectToolsDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  runGodotImport: typeof runGodotImport;
  hasGodotCacheDir: typeof hasGodotCacheDir;
  hasImportCache: typeof hasImportCache;
}

const defaultDeps: ProjectToolsDeps = {
  loadConfig,
  detectGodotPath,
  runGodotImport,
  hasGodotCacheDir,
  hasImportCache,
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

  return [importProject as unknown as ToolDescriptor];
}

export const projectTools: ToolDescriptor[] = createProjectTools();
