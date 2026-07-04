import { createErrorResponse } from "../errors.js";
import type { RunOperationResult } from "../godot/runner.js";

/**
 * Shared `possibleSolutions` for an `operation-error` whose dispatcher error
 * text matches `/scene does not exist at/i` - identical guidance in both
 * `tools/scene.ts` (create_scene et al.) and `tools/readback.ts`
 * (get_scene_tree/read_node_properties), since both mean the same thing:
 * scene_path doesn't point at an existing .tscn file yet. Exported here
 * rather than duplicated so the wording only needs updating once; every
 * *other* `operationErrorSolutions` branch is genuinely per-domain and stays
 * local to its own tool file.
 */
export const sceneNotFoundSolutions: string[] = [
  "Check that scene_path points at an existing .tscn file relative to project_path.",
  "Use create_scene first if the scene does not exist yet.",
];

/**
 * Converts a `RunOperationResult` into an MCP tool result. `success` is the
 * only non-error branch; every other kind maps to a guided
 * `createErrorResponse`, tailored to what actually went wrong (an op-level
 * failure reported by the dispatcher vs. a version mismatch vs. Godot
 * failing to even respond). `successLabel` prefixes the human-readable text
 * for a successful call (e.g. "Created scene", "Read node properties").
 *
 * This is the single shared copy for every tool file that goes through
 * `runOperation` (`tools/scene.ts` and `tools/readback.ts` as of this
 * writing) - both used to carry verbatim-identical copies of this function,
 * which meant a future change (a new `RunOperationResult` variant, a wording
 * fix) had to be made in both places with nothing enforcing it. Two things
 * vary per caller and are passed in rather than hardcoded:
 *
 * - `operationErrorSolutions`: the `operation-error` mapping from dispatcher
 *   error text to guidance is specific to the set of ops each tool file
 *   implements, so each caller supplies its own (see `scene.ts`'s and
 *   `readback.ts`'s own `operationErrorSolutions` functions).
 * - `timeoutSolutions`: the `timeout` message is identical everywhere, but
 *   `scene.ts`'s ops can be slowed by asset import / project size in a way
 *   `readback.ts`'s read-only ops aren't, so its guidance has an extra
 *   import-cache/timeoutMs hint readback.ts's doesn't.
 */
export function operationResultToToolResult(
  result: RunOperationResult,
  successLabel: string,
  options: {
    operationErrorSolutions: (error: string) => string[];
    timeoutSolutions: string[];
  },
) {
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
        possibleSolutions: options.operationErrorSolutions(result.error),
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
          "means the process hung (e.g. a stuck asset import, a blocking dialog, or a deadlock " +
          "in headless mode) rather than finishing.",
        possibleSolutions: options.timeoutSolutions,
      });
  }
}
