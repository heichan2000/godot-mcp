import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import { coldImportCacheError, hasImportCache } from "../godot/cache.js";
import {
  assertInsideRoot,
  detectGodotPath,
  godotNotFoundError,
  PathContainmentError,
  pathContainmentErrorResponse,
} from "../godot/paths.js";
import {
  resolveOperationsScriptPath,
  runGodotImport,
  runOperation,
  type RunGodotImportResult,
  type RunOperationResult,
} from "../godot/runner.js";
import type { ToolDescriptor } from "../registry.js";
import { projectPathSchema, relativePathSchema } from "../schemas.js";

/**
 * Both UID tools require Godot >= 4.4 - Resource UIDs only cover every
 * resource type (not just scripts) as of that version. Enforced centrally
 * by `registerAll`'s version gate (see `registry.ts`/`godot/version-gate.ts`)
 * via each descriptor's `minGodotVersion`, not hand-coded here.
 */
export const MIN_UID_GODOT_VERSION = "4.4";

export interface UidToolsDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  runOperation: typeof runOperation;
  /** Runs `godot --headless --import`, used by update_project_uids to refresh the cache. */
  runGodotImport: typeof runGodotImport;
  /** Checks whether project_path already has a built Godot import cache. */
  hasImportCache: typeof hasImportCache;
  /** Path to the bundled operations.gd dispatcher script. */
  operationsScriptPath: string;
}

const defaultDeps: UidToolsDeps = {
  loadConfig,
  detectGodotPath,
  runOperation,
  runGodotImport,
  hasImportCache,
  operationsScriptPath: resolveOperationsScriptPath(),
};

/**
 * Builds guided `possibleSolutions` for an `operation-error` result, matching
 * the dispatcher's error text against the known failure shapes `get_uid` and
 * `update_project_uids` can produce. Falls back to a generic hint for
 * anything unrecognized. Mirrors `tools/scene.ts`'s
 * `operationErrorSolutions` in shape, but kept separate: each file's matcher
 * only needs to know its own ops' error strings.
 */
function operationErrorSolutions(error: string): string[] {
  if (/file does not exist at/i.test(error)) {
    return [
      "Check that file_path points at an existing file relative to project_path.",
      "Use list_resources (once available) or inspect the project directly to confirm the exact path.",
    ];
  }
  if (/no uid is assigned to resource/i.test(error)) {
    return [
      "Run update_project_uids with this project_path first, then retry get_uid.",
      "Godot only assigns a UID to a resource that has been through update_project_uids (or was " +
        "already resaved in the editor since 4.4) - a resource authored before 4.4 and never " +
        "resaved yet has none.",
    ];
  }
  return ["Check that project_path and the other parameters are valid for this project."];
}

/**
 * Converts a `RunOperationResult` into an MCP tool result. Mirrors
 * `tools/scene.ts`'s `operationResultToToolResult` (same non-op-specific
 * branches: version mismatch, protocol error, spawn error, timeout), but
 * kept as its own copy rather than a shared export - each op-error branch
 * defers to a file-local `operationErrorSolutions`, so sharing the outer
 * function would still need a parameter for that piece anyway.
 */
function operationResultToToolResult(result: RunOperationResult, successLabel: string) {
  switch (result.kind) {
    case "success":
      return {
        content: [
          {
            type: "text" as const,
            text: `${successLabel}: ${JSON.stringify(result.result)}`,
          },
        ],
        structuredContent: result.result,
      };
    case "operation-error":
      return createErrorResponse({
        message: result.error,
        possibleSolutions: operationErrorSolutions(result.error),
      });
    case "version-mismatch":
      return createErrorResponse({
        message:
          `Dispatcher version mismatch: the runner expects operations.gd version ` +
          `${result.expectedVersion}, but the dispatcher reported version ${result.actualVersion}.`,
        possibleSolutions: [
          "Reinstall or rebuild the package so the bundled operations.gd matches this server version (npm install / npm run build).",
          "If you customized operations.gd, update its VERSION constant to match the runner's expected version.",
        ],
      });
    case "protocol-error":
      return createErrorResponse({
        message: result.message,
        possibleSolutions: [
          "Run with DEBUG=1 and inspect stderr for the underlying Godot error.",
          "Confirm GODOT_PATH points at a working Godot 4.x headless-capable executable.",
        ],
      });
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
          `Godot did not respond within ${result.timeoutMs}ms and was killed. This usually ` +
          "means the process hung rather than finishing.",
        possibleSolutions: [
          "Try running the same Godot command manually from a terminal to see whether it hangs or prompts for input.",
          "update_project_uids walks every resource in the project and can take a while on a large project - a future call may need a larger timeoutMs than the default.",
        ],
      });
  }
}

/**
 * Converts the post-update `runGodotImport` outcome into an MCP tool result
 * for `update_project_uids`, folding in the op's own reported
 * touched/already_had_uid/failed lists. A rebuild failure here is reported
 * as an error even though the header rewrite itself already succeeded on
 * disk: without a fresh import, get_uid can't yet see the newly-embedded
 * uid= values, so leaving the project in that in-between state silently
 * would be misleading about what "update_project_uids completed" means for
 * callers.
 */
function importResultToUpdateUidsToolResult(
  importResult: RunGodotImportResult,
  opResult: Record<string, unknown>,
) {
  switch (importResult.kind) {
    case "completed":
      return {
        content: [
          {
            type: "text" as const,
            text: `Updated project UIDs: ${JSON.stringify(opResult)}`,
          },
        ],
        structuredContent: opResult,
      };
    case "spawn-error":
      return createErrorResponse({
        message:
          "UIDs were written to disk, but re-running the import cache afterward failed to " +
          `launch Godot: ${importResult.message}`,
        possibleSolutions: [
          "Confirm GODOT_PATH points at a valid, executable Godot 4.x binary.",
          "Run import_project manually to finish refreshing the cache once Godot is reachable again.",
        ],
      });
    case "timeout":
      return createErrorResponse({
        message:
          "UIDs were written to disk, but re-running the import cache afterward did not finish " +
          `within ${importResult.timeoutMs}ms and was killed.`,
        possibleSolutions: [
          "Run import_project manually to finish refreshing the cache.",
          "Large projects can take a while to import - retry with more time if this keeps happening.",
        ],
      });
  }
}

const getUidInputSchema = {
  project_path: projectPathSchema,
  file_path: relativePathSchema.describe(
    "Path to an existing resource file (e.g. .tscn, .tres, .gd), relative to project_path.",
  ),
};

const updateProjectUidsInputSchema = {
  project_path: projectPathSchema,
};

/**
 * Builds the `tools/uid.ts` descriptor group. Godot resolution and the
 * dispatcher invocation both happen lazily inside each handler (never at
 * registration time), matching `tools/scene.ts`/`tools/project.ts`. Both
 * descriptors set `minGodotVersion: MIN_UID_GODOT_VERSION` - they are always
 * registered/listed (see `server.ts`), and `registerAll`'s version gate
 * (not this file) is what actually blocks a call on an older Godot.
 */
export function createUidTools(deps: UidToolsDeps = defaultDeps): ToolDescriptor[] {
  const getUid: ToolDescriptor<typeof getUidInputSchema> = {
    name: "get_uid",
    description:
      "Requires Godot ≥ 4.4. Returns the resource UID (uid://...) already assigned to " +
      "file_path. Requires project_path's Godot import cache to already be built (like " +
      "load_sprite) - a resource's UID is only recognized after a project scan, which " +
      "import_project triggers; if the cache is missing, this returns a guided error naming " +
      "import_project instead. Resources authored before Godot 4.4 (or never resaved since) may " +
      "not have a UID yet even with a fresh cache - if this returns a guided 'no UID assigned' " +
      "error, run update_project_uids first.",
    inputSchema: getUidInputSchema,
    minGodotVersion: MIN_UID_GODOT_VERSION,
    handler: async ({ project_path, file_path }) => {
      try {
        assertInsideRoot(project_path, file_path);
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return pathContainmentErrorResponse(error);
        }
        throw error;
      }

      if (!deps.hasImportCache(project_path)) {
        return coldImportCacheError(project_path);
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] get_uid: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "get_uid",
        params: { file_path },
      });

      return operationResultToToolResult(result, "Resolved UID");
    },
  };

  const updateProjectUids: ToolDescriptor<typeof updateProjectUidsInputSchema> = {
    name: "update_project_uids",
    description:
      "Requires Godot ≥ 4.4. Ensures every .tscn/.tres resource under project_path (res://) has " +
      "a uid:// embedded in its header, generating and writing one in place for any that don't " +
      "(files that already have one are left untouched). Useful after upgrading a project " +
      "authored pre-4.4, or whenever get_uid reports a resource with no UID yet. Also re-runs " +
      "the project's import cache afterward (like import_project) so a newly-assigned UID is " +
      "immediately visible to the very next get_uid call. Returns the resource paths touched " +
      "(given a new UID), left alone (already had one), and any that failed to read or write.",
    inputSchema: updateProjectUidsInputSchema,
    minGodotVersion: MIN_UID_GODOT_VERSION,
    handler: async ({ project_path }) => {
      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] update_project_uids: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const opResult = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "update_project_uids",
        params: {},
      });

      if (opResult.kind !== "success") {
        return operationResultToToolResult(opResult, "Updated project UIDs");
      }

      const importResult = await deps.runGodotImport({
        godotPath: resolution.path,
        projectPath: project_path,
      });

      return importResultToUpdateUidsToolResult(importResult, opResult.result);
    },
  };

  return [getUid as unknown as ToolDescriptor, updateProjectUids as unknown as ToolDescriptor];
}

export const uidTools: ToolDescriptor[] = createUidTools();
