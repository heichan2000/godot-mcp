import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import {
  assertInsideRoot,
  detectGodotPath,
  godotNotFoundError,
  PathContainmentError,
  pathContainmentErrorResponse,
} from "../godot/paths.js";
import {
  resolveOperationsScriptPath,
  runCheckOnly,
  runOperation,
  type RunCheckOnlyResult,
  type RunOperationResult,
} from "../godot/runner.js";
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
  /** Used by get_scene_tree/read_node_properties, which - unlike get_script_errors - go through the operations.gd dispatcher. */
  runOperation: typeof runOperation;
  /** Path to the bundled operations.gd dispatcher script. */
  operationsScriptPath: string;
}

const defaultDeps: ReadbackToolsDeps = {
  loadConfig,
  detectGodotPath,
  runCheckOnly,
  fileExists: existsSync,
  readFile: (candidate) => readFileSync(candidate, "utf-8"),
  runOperation,
  operationsScriptPath: resolveOperationsScriptPath(),
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
 * Builds guided `possibleSolutions` for an `operation-error` result from
 * `get_scene_tree`/`read_node_properties` - the two ops in this file that DO
 * go through `operations.gd`/`runOperation` (unlike `get_script_errors`,
 * see the module doc comment below). Kept as its own copy rather than
 * imported from `tools/scene.ts` - that function is unexported and, per this
 * codebase's convention (see `toResourcePath` above), each tool file owns
 * its own small copy of a helper like this rather than sharing a
 * premature abstraction across unrelated op sets.
 */
function operationErrorSolutions(error: string): string[] {
  if (/scene does not exist at/i.test(error)) {
    return [
      "Check that scene_path points at an existing .tscn file relative to project_path.",
      "Use create_scene first if the scene does not exist yet.",
    ];
  }
  if (/node_path not found in scene/i.test(error)) {
    return [
      "Check the exact node path against the error's list of available node paths.",
      "Call get_scene_tree first to discover valid node paths for this scene.",
    ];
  }
  if (/property does not exist on/i.test(error)) {
    return [
      "Check the property name against the Godot class reference for this node's type - it is case-sensitive.",
      "Call read_node_properties without a properties filter first to see the node's actual stored properties.",
    ];
  }
  return ["Check that scene_path and the other parameters are valid for this project."];
}

/**
 * Converts a `RunOperationResult` into an MCP tool result for
 * `get_scene_tree`/`read_node_properties`. Mirrors `tools/scene.ts`'s
 * `operationResultToToolResult` exactly (same `RunOperationResult` contract,
 * same error-mapping shape) - kept as its own copy for the same reason
 * `operationErrorSolutions` above is.
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
          "means the process hung (e.g. a stuck asset import, a blocking dialog, or a deadlock " +
          "in headless mode) rather than finishing.",
        possibleSolutions: [
          "Try running the same Godot command manually from a terminal to see whether it hangs or prompts for input.",
          "Confirm GODOT_PATH points at a working Godot 4.x headless-capable executable.",
        ],
      });
  }
}

const getSceneTreeInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema.describe(
    "Path to an existing .tscn scene file, relative to project_path.",
  ),
};

const readNodePropertiesInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema.describe(
    "Path to an existing .tscn scene file, relative to project_path.",
  ),
  node_path: z
    .string()
    .min(1)
    .describe(
      'Path (relative to the scene root) of the node to read properties from - "." for the ' +
        'scene root itself, or a NodePath like "Body/Hero" for a nested node. Same convention ' +
        "get_scene_tree's returned paths and add_node's parent_node_path already use. Must " +
        "already exist in the scene - an unresolvable node_path is a structured error listing " +
        "every available node path.",
    ),
  properties: z
    .array(z.string().min(1))
    .optional()
    .describe(
      "Optional list of specific property names to fetch from the LIVE instantiated node via " +
        "get() - returned even when the property still holds its class default (e.g. an " +
        "untouched position). When omitted, only properties actually stored in the .tscn (the " +
        "node's non-default state) are returned - never the class's full ~40+-entry default " +
        "property list. Values use the shared codec: bool/int/float/string travel natively, " +
        'every other type as its var_to_str text form, e.g. "Vector2(100, 50)" - the same ' +
        "encoding add_node's properties param accepts, so a value written that way reads back " +
        "here as that identical string.",
    ),
};

/**
 * Builds the `tools/readback.ts` descriptor group: `get_script_errors`,
 * `get_scene_tree`, and `read_node_properties` (the latter two close the
 * write->verify loop with `add_node` - see godot-prd.md §6.2). `list_resources`
 * belongs in this same file per the PRD's source layout table but is a
 * separate task.
 *
 * `get_script_errors` never goes through `operations.gd`/`runOperation` -
 * Godot exposes no error-reporting API, so the only mechanism available is a
 * plain `godot --check-only --script ...` invocation (see `godot/runner.ts`'s
 * `runCheckOnly`) and a best-effort regex parse of its stderr (see
 * `godot/script-errors.ts`). `raw` always carries the untouched stderr text -
 * a missed parse (e.g. a future Godot stderr format change) loses structure,
 * never information.
 *
 * `get_scene_tree` and `read_node_properties`, by contrast, DO go through the
 * dispatcher exactly like `tools/scene.ts`'s ops: they load the scene
 * read-only (never saving anything back) via `operations.gd`'s
 * `op_get_scene_tree`/`op_read_node_properties`.
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

        // Defense in depth (see assertInsideRoot's other call sites): a
        // path parsed out of file content, not a direct caller-supplied
        // param, still gets the same containment check before use. Not
        // deduped and not existence-checked here - a scene referencing the
        // same script twice runs the check twice (harmless, if slightly
        // redundant), and a scene referencing a script that's gone missing
        // on disk simply flows into runCheckOnly and gets whatever Godot's
        // stderr says (a different, unparsed shape - "best effort" applies
        // here too, and raw still carries it).
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

  const getSceneTree: ToolDescriptor<typeof getSceneTreeInputSchema> = {
    name: "get_scene_tree",
    description:
      "Returns the full node tree of an existing scene as a nested " +
      "{ name, type, path, children[] } structure: name is the node's name, type is its " +
      'actual Godot class, and path is root-relative ("." for the scene root itself, e.g. ' +
      '"Body/Hero" for a nested node) - directly usable as node_path/parent_node_path input to ' +
      "other tools (add_node, load_sprite, read_node_properties, ...). Lets an agent verify " +
      "scene structure and discover valid node paths without guessing.",
    inputSchema: getSceneTreeInputSchema,
    handler: async ({ project_path, scene_path }) => {
      try {
        assertInsideRoot(project_path, scene_path);
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return pathContainmentErrorResponse(error);
        }
        throw error;
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] get_scene_tree: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "get_scene_tree",
        params: { scene_path },
      });

      return operationResultToToolResult(result, "Got scene tree");
    },
  };

  const readNodeProperties: ToolDescriptor<typeof readNodePropertiesInputSchema> = {
    name: "read_node_properties",
    description:
      "Reads properties from a node in an existing scene - the read half of the write->verify " +
      "loop with add_node. Default (properties omitted): returns only properties actually " +
      "stored in the .tscn for this node (its non-default state), never the ~40+ engine " +
      "defaults every node class carries. Pass properties (a list of names) to instead fetch " +
      "those specific named properties from the live node via get(), returned even when they " +
      'still hold their class default. node_path is root-relative ("." for the scene root ' +
      "itself) - the same convention get_scene_tree's returned paths use; an unresolvable " +
      "node_path is a structured error listing every available node path in the scene. Every " +
      "value uses the shared codec: bool/int/float/string travel natively, every other type as " +
      'its var_to_str text form, so a property add_node wrote as "Vector2(100, 50)" reads back ' +
      "here as that identical string.",
    inputSchema: readNodePropertiesInputSchema,
    handler: async ({ project_path, scene_path, node_path, properties }) => {
      try {
        assertInsideRoot(project_path, scene_path);
      } catch (error) {
        if (error instanceof PathContainmentError) {
          return pathContainmentErrorResponse(error);
        }
        throw error;
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] read_node_properties: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const params: Record<string, unknown> = { scene_path, node_path };
      if (properties !== undefined) {
        params.properties = properties;
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "read_node_properties",
        params,
      });

      return operationResultToToolResult(result, "Read node properties");
    },
  };

  return [
    getScriptErrors as unknown as ToolDescriptor,
    getSceneTree as unknown as ToolDescriptor,
    readNodeProperties as unknown as ToolDescriptor,
  ];
}

export const readbackTools: ToolDescriptor[] = createReadbackTools();
