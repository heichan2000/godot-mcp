import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import {
  assertInsideRoot,
  detectGodotPath,
  godotNotFoundError,
  PathContainmentError,
  pathContainmentErrorResponse,
} from "../godot/paths.js";
import { runCheckOnly, type RunCheckOnlyResult } from "../godot/runner.js";
import {
  extractSceneScriptPaths,
  parseCheckOnlyStderr,
  type ScriptErrorEntry,
} from "../godot/script-errors.js";
import type { ToolDescriptor } from "../registry.js";
import { projectPathSchema, relativePathSchema, scenePathSchema } from "../schemas.js";

export interface ReadbackToolsDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  runCheckOnly: typeof runCheckOnly;
  /** Checks whether a resolved absolute path exists on disk. */
  fileExists: (candidate: string) => boolean;
  /** Reads a resolved absolute path's contents as UTF-8 text (used to parse a scene's ext_resource entries). */
  readFile: (candidate: string) => string;
}

const defaultDeps: ReadbackToolsDeps = {
  loadConfig,
  detectGodotPath,
  runCheckOnly,
  fileExists: existsSync,
  readFile: (candidate) => readFileSync(candidate, "utf-8"),
};

/**
 * Converts a project-relative path (already containment-checked) into the
 * res:// form Godot's CLI expects. Mirrors `tools/run.ts`'s
 * `toResourcePath` and `operations.gd`'s `to_res_path` - kept as its own
 * copy rather than shared, matching this codebase's existing convention of
 * one small helper per file rather than a premature shared utility.
 */
function toResourcePath(relative: string): string {
  const normalized = relative.split(path.sep).join("/");
  return `res://${normalized.replace(/^\/+/, "")}`;
}

/** Inverse of `toResourcePath`: strips a leading `res://` so the path can be re-validated with `assertInsideRoot`. */
function fromResourcePath(resPath: string): string {
  return resPath.startsWith("res://") ? resPath.slice("res://".length) : resPath;
}

/**
 * Converts one `RunCheckOnlyResult` into either a parsed contribution (more
 * errors + a raw chunk to append) or a terminal MCP error result. Godot's
 * exit code is deliberately not consulted here - only `stderr`, via the
 * best-effort `parseCheckOnlyStderr` regex - matching `runCheckOnly`'s own
 * contract that a nonzero exit from `--check-only` is an expected, parseable
 * outcome, not a sign Godot failed to run.
 */
function interpretCheckOnlyResult(
  result: RunCheckOnlyResult,
):
  | { kind: "ok"; errors: ScriptErrorEntry[]; raw: string }
  | { kind: "error"; response: ReturnType<typeof createErrorResponse> } {
  switch (result.kind) {
    case "completed":
      return { kind: "ok", errors: parseCheckOnlyStderr(result.stderr), raw: result.stderr };
    case "spawn-error":
      return {
        kind: "error",
        response: createErrorResponse({
          message: `Failed to launch Godot: ${result.message}`,
          possibleSolutions: [
            "Confirm GODOT_PATH points at a valid, executable Godot 4.x binary.",
            "Try running the executable manually from a terminal to confirm it works.",
          ],
        }),
      };
    case "timeout":
      return {
        kind: "error",
        response: createErrorResponse({
          message:
            `Godot did not respond within ${result.timeoutMs}ms and was killed. This usually ` +
            "means the process hung rather than finishing a simple script parse.",
          possibleSolutions: [
            "Try running the same check-only command manually from a terminal to see whether it hangs.",
            "Confirm GODOT_PATH points at a working Godot 4.x headless-capable executable.",
          ],
        }),
      };
  }
}

const getScriptErrorsInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema
    .optional()
    .describe(
      "Path to an existing .tscn scene, relative to project_path - every external script the " +
        "scene references via ext_resource is checked. Exactly one of scene_path or script_path " +
        "must be provided.",
    ),
  script_path: relativePathSchema
    .optional()
    .describe(
      "Path to a single existing .gd script, relative to project_path, to check directly. " +
        "Exactly one of scene_path or script_path must be provided.",
    ),
};

/**
 * Builds the `tools/readback.ts` descriptor group. Currently just
 * `get_script_errors`; other read-back tools (get_scene_tree,
 * read_node_properties, list_resources - see godot-prd.md §6.2) belong in
 * this same file per the PRD's source layout table but are separate tasks.
 *
 * Unlike every other tool file, this one never goes through
 * `operations.gd`/`runOperation` - Godot exposes no error-reporting API, so
 * the only mechanism available is a plain `godot --check-only --script ...`
 * invocation (see `godot/runner.ts`'s `runCheckOnly`) and a best-effort
 * regex parse of its stderr (see `godot/script-errors.ts`). `raw` always
 * carries the untouched stderr text - a missed parse (e.g. a future Godot
 * stderr format change) loses structure, never information.
 */
export function createReadbackTools(deps: ReadbackToolsDeps = defaultDeps): ToolDescriptor[] {
  const getScriptErrors: ToolDescriptor<typeof getScriptErrorsInputSchema> = {
    name: "get_script_errors",
    description:
      "Best-effort GDScript error read-back: runs `godot --check-only` against one or more " +
      "scripts and returns { errors: [{file, line, message}], raw }. Provide script_path to " +
      "check a single script directly, or scene_path to check every external script the scene " +
      "references (via ext_resource) - exactly one of the two is required. errors are " +
      "best-effort regex parses of Godot's stderr (Godot exposes no structured error API); raw " +
      "always contains the full, untouched stderr so a missed parse never loses information. A " +
      "script with no errors returns errors: [] and empty raw; a scene with no referenced " +
      "scripts returns errors: [] and empty raw without invoking Godot at all.",
    inputSchema: getScriptErrorsInputSchema,
    handler: async ({ project_path, scene_path, script_path }) => {
      if ((scene_path === undefined) === (script_path === undefined)) {
        return createErrorResponse({
          message: "Exactly one of scene_path or script_path must be provided.",
          possibleSolutions: [
            "Provide script_path to check a single script file directly.",
            "Provide scene_path to check every script referenced by a scene.",
          ],
        });
      }

      let scriptsToCheck: string[]; // res:// paths

      if (script_path !== undefined) {
        let resolvedAbsolute: string;
        try {
          resolvedAbsolute = assertInsideRoot(project_path, script_path);
        } catch (error) {
          if (error instanceof PathContainmentError) {
            return pathContainmentErrorResponse(error);
          }
          throw error;
        }

        if (!deps.fileExists(resolvedAbsolute)) {
          return createErrorResponse({
            message: `Script does not exist at ${toResourcePath(script_path)}.`,
            possibleSolutions: [
              "Check that script_path points at an existing .gd file relative to project_path.",
            ],
          });
        }

        scriptsToCheck = [toResourcePath(script_path)];
      } else {
        const scenePathParam = scene_path as string;
        let resolvedSceneAbsolute: string;
        try {
          resolvedSceneAbsolute = assertInsideRoot(project_path, scenePathParam);
        } catch (error) {
          if (error instanceof PathContainmentError) {
            return pathContainmentErrorResponse(error);
          }
          throw error;
        }

        if (!deps.fileExists(resolvedSceneAbsolute)) {
          return createErrorResponse({
            message: `Scene does not exist at ${toResourcePath(scenePathParam)}.`,
            possibleSolutions: [
              "Check that scene_path points at an existing .tscn file relative to project_path.",
            ],
          });
        }

        const sceneText = deps.readFile(resolvedSceneAbsolute);
        const referenced = extractSceneScriptPaths(sceneText);

        for (const resPath of referenced) {
          try {
            assertInsideRoot(project_path, fromResourcePath(resPath));
          } catch (error) {
            if (error instanceof PathContainmentError) {
              return pathContainmentErrorResponse(error);
            }
            throw error;
          }
        }

        scriptsToCheck = referenced;
      }

      if (scriptsToCheck.length === 0) {
        return {
          content: [{ type: "text" as const, text: "No scripts referenced; nothing to check." }],
          structuredContent: { errors: [], raw: "" },
        };
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] get_script_errors: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const allErrors: ScriptErrorEntry[] = [];
      const rawParts: string[] = [];
      const multiple = scriptsToCheck.length > 1;

      for (const scriptResPath of scriptsToCheck) {
        const checkResult = await deps.runCheckOnly({
          godotPath: resolution.path,
          projectPath: project_path,
          scriptPath: scriptResPath,
        });

        const interpreted = interpretCheckOnlyResult(checkResult);
        if (interpreted.kind === "error") {
          return interpreted.response;
        }

        allErrors.push(...interpreted.errors);
        rawParts.push(multiple ? `[${scriptResPath}]\n${interpreted.raw}` : interpreted.raw);
      }

      const raw = rawParts.join("\n\n");

      return {
        content: [
          {
            type: "text" as const,
            text: `Checked ${scriptsToCheck.length} script(s); found ${allErrors.length} error(s).`,
          },
        ],
        structuredContent: { errors: allErrors, raw },
      };
    },
  };

  return [getScriptErrors as unknown as ToolDescriptor];
}

export const readbackTools: ToolDescriptor[] = createReadbackTools();
