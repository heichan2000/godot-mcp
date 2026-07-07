import { z } from "zod";
import type { ErrorResponse } from "../errors.js";
import {
  assertInsideRoot,
  containResPath,
  PathContainmentError,
  pathContainmentErrorResponse,
} from "../godot/paths.js";
import type { ToolDescriptor } from "../registry.js";
import type { BridgePort } from "./bridge.js";
import { bridgeErrorToResponse, requestValidated } from "./bridge.js";
import { successResult } from "./result.js";

export interface SceneToolsDeps {
  bridge: BridgePort;
}

/**
 * Contains a caller scene path (REQ-M-01) before it crosses the bridge:
 * structural res:// guard (foreign scheme / absolute / `..` escape) always,
 * plus a symlink-safe realpath check against the connected project root when an
 * editor is attached (its project_path is a real local dir — same machine,
 * loopback bridge). Returns the canonical res:// path to forward, or a
 * structured containment error to return as-is. When disconnected there is no
 * root to realpath and the op will not run anyway; the structural guard still
 * blocks escapes and the bridge request surfaces the not-connected error.
 */
function resolveScenePath(
  bridge: BridgePort,
  scenePath: string,
): { resPath: string } | { error: ErrorResponse } {
  try {
    const { resPath, relative } = containResPath(scenePath);
    const projectRoot = bridge.status().hello?.project_path;
    if (projectRoot) assertInsideRoot(projectRoot, relative);
    return { resPath };
  } catch (error) {
    if (error instanceof PathContainmentError)
      return { error: pathContainmentErrorResponse(error) };
    throw error;
  }
}

const CreateSceneSchema = z
  .object({
    scene_path: z.string(),
    root_node_type: z.string(),
    created: z.boolean(),
  })
  .catchall(z.unknown());

export function createSceneTools(deps: SceneToolsDeps): ToolDescriptor[] {
  const createScene: ToolDescriptor = {
    name: "create_scene",
    description:
      "Create a .tscn scene with a chosen root node type and open it in the editor; refuses to overwrite an existing scene.",
    inputSchema: {
      scene_path: z
        .string()
        .min(1, "scene_path must not be empty.")
        .describe(
          'Project path for the new scene, e.g. "res://scenes/main.tscn" or "scenes/main.tscn".',
        ),
      root_node_type: z
        .string()
        .min(1)
        .optional()
        .describe('Root node class (default "Node"), e.g. "Node2D", "Node3D", "Control".'),
    },
    handler: async (args) => {
      const { scene_path, root_node_type } = args as {
        scene_path: string;
        root_node_type?: string;
      };
      const contained = resolveScenePath(deps.bridge, scene_path);
      if ("error" in contained) return contained.error;
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "scene/create",
          { scene_path: contained.resPath, root_node_type: root_node_type ?? "Node" },
          CreateSceneSchema,
        );
        return successResult("Created scene", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  return [createScene];
}
