import { z } from "zod";
import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import {
  assertInsideRoot,
  detectGodotPath,
  PathContainmentError,
  pathContainmentErrorResponse,
} from "../godot/paths.js";
import {
  resolveOperationsScriptPath,
  runOperation,
  type RunOperationResult,
} from "../godot/runner.js";
import type { ToolDescriptor } from "../registry.js";
import { projectPathSchema, scenePathSchema } from "../schemas.js";

const DEFAULT_ROOT_NODE_TYPE = "Node2D";

export interface SceneToolsDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  runOperation: typeof runOperation;
  /** Path to the bundled operations.gd dispatcher script. */
  operationsScriptPath: string;
}

const defaultDeps: SceneToolsDeps = {
  loadConfig,
  detectGodotPath,
  runOperation,
  operationsScriptPath: resolveOperationsScriptPath(),
};

function godotNotFoundError(candidates: string[]) {
  return createErrorResponse({
    message: "Could not locate a Godot executable.",
    possibleSolutions: [
      "Set the GODOT_PATH environment variable to the full path of your Godot 4.x executable.",
      `Checked these common install locations: ${candidates.join(", ")}`,
      "Download Godot 4.x from https://godotengine.org/download if it is not installed.",
    ],
  });
}

/**
 * Converts a `RunOperationResult` into an MCP tool result. `success` is the
 * only non-error branch; every other kind maps to a guided
 * `createErrorResponse`, tailored to what actually went wrong (an op-level
 * failure reported by the dispatcher vs. a version mismatch vs. Godot
 * failing to even respond).
 */
function operationResultToToolResult(result: RunOperationResult) {
  switch (result.kind) {
    case "success":
      return {
        content: [
          {
            type: "text" as const,
            text: `Created scene: ${JSON.stringify(result.result)}`,
          },
        ],
        structuredContent: result.result,
      };
    case "operation-error":
      return createErrorResponse({
        message: result.error,
        possibleSolutions: ["Check that scene_path and root_node_type are valid for this project."],
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
  }
}

/**
 * Builds the `tools/scene.ts` descriptor group. Godot resolution and the
 * dispatcher invocation both happen lazily inside the handler (never at
 * registration time), matching `tools/editor.ts`.
 */
const createSceneInputSchema = {
  project_path: projectPathSchema,
  scene_path: scenePathSchema,
  root_node_type: z
    .string()
    .min(1)
    .optional()
    .describe(`Godot node class for the scene root. Defaults to ${DEFAULT_ROOT_NODE_TYPE}.`),
};

export function createSceneTools(deps: SceneToolsDeps = defaultDeps): ToolDescriptor[] {
  const createScene: ToolDescriptor<typeof createSceneInputSchema> = {
    name: "create_scene",
    description:
      "Creates a new .tscn scene file containing a single root node (default Node2D). " +
      "scene_path is relative to project_path and must not exist yet.",
    inputSchema: createSceneInputSchema,
    handler: async ({ project_path, scene_path, root_node_type }) => {
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
        console.error(`[godot-mcp] create_scene: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const result = await deps.runOperation({
        godotPath: resolution.path,
        projectPath: project_path,
        operationScriptPath: deps.operationsScriptPath,
        operation: "create_scene",
        params: {
          scene_path,
          root_node_type: root_node_type ?? DEFAULT_ROOT_NODE_TYPE,
        },
      });

      return operationResultToToolResult(result);
    },
  };

  // registerAll pairs each descriptor's handler with its own inputSchema at
  // registration time (the SDK only ever invokes a handler with args already
  // validated against that same schema), so widening the concrete
  // ToolDescriptor<typeof createSceneInputSchema> into the heterogeneous
  // ToolDescriptor[] return type is safe in practice even though the
  // handler parameter types are contravariant and TS can't verify that
  // pairing across a shared array element type.
  return [createScene as unknown as ToolDescriptor];
}

export const sceneTools: ToolDescriptor[] = createSceneTools();
