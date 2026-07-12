import { z } from "zod";
import type { ToolDescriptor } from "../registry.js";
import type { BridgePort } from "./bridge.js";
import { bridgeErrorToResponse, requestValidated, resolveProjectPath } from "./bridge.js";
import { successResult } from "./result.js";

export interface SceneToolsDeps {
  bridge: BridgePort;
}

const CreateSceneSchema = z
  .object({
    scene_path: z.string(),
    root_node_type: z.string(),
    created: z.boolean(),
  })
  .catchall(z.unknown());

const OpenSceneSchema = z
  .object({ scene_path: z.string(), current: z.string() })
  .catchall(z.unknown());

const OpenScenesSchema = z
  .object({
    current: z.string().nullable(),
    scenes: z.array(z.object({ path: z.string(), dirty: z.boolean() })),
    count: z.number().int(),
  })
  .catchall(z.unknown());

const SaveSceneSchema = z
  .object({
    saved: z.array(z.string()),
    current: z.string().nullable(),
    all: z.boolean(),
  })
  .catchall(z.unknown());

const CloseSceneSchema = z
  .object({
    scene_path: z.string(),
    closed: z.boolean(),
    current: z.string().nullable(),
  })
  .catchall(z.unknown());

export interface SceneTreeNode {
  name: string;
  type: string;
  path: string;
  script: string | null;
  instance: string | null;
  children: SceneTreeNode[];
}

/** Recursive node shape for scene/get_tree — z.lazy because children nest. */
const SceneTreeNodeSchema: z.ZodType<SceneTreeNode> = z.lazy(() =>
  z.object({
    name: z.string(),
    type: z.string(),
    path: z.string(),
    script: z.string().nullable(),
    instance: z.string().nullable(),
    children: z.array(SceneTreeNodeSchema),
  }),
);

const SceneTreeSchema = z
  .object({ scene_path: z.string().nullable(), tree: SceneTreeNodeSchema })
  .catchall(z.unknown());

const ExportMeshLibrarySchema = z
  .object({
    scene_path: z.string(),
    output_path: z.string(),
    item_names: z.array(z.string()),
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
      const contained = resolveProjectPath(deps.bridge, scene_path);
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

  const openScene: ToolDescriptor = {
    name: "open_scene",
    description:
      "Open (or focus) a scene tab in the editor and make it the current scene that authoring ops target.",
    inputSchema: {
      scene_path: z
        .string()
        .min(1, "scene_path must not be empty.")
        .describe('Project path of the scene to open, e.g. "res://scenes/main.tscn".'),
    },
    handler: async (args) => {
      const { scene_path } = args as { scene_path: string };
      const contained = resolveProjectPath(deps.bridge, scene_path);
      if ("error" in contained) return contained.error;
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "scene/open",
          { scene_path: contained.resPath },
          OpenSceneSchema,
        );
        return successResult("Opened scene", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const getOpenScenes: ToolDescriptor = {
    name: "get_open_scenes",
    description:
      "List the editor's open scene tabs with each scene's unsaved (dirty) flag, and which scene is current.",
    inputSchema: {},
    handler: async () => {
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "scene/list_open",
          {},
          OpenScenesSchema,
        );
        return successResult("Open scenes", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const saveScene: ToolDescriptor = {
    name: "save_scene",
    description:
      "Save the current scene, a named scene, a save-as copy (new_path), or all open scenes; reports what was saved.",
    inputSchema: {
      scene_path: z
        .string()
        .min(1)
        .optional()
        .describe("Scene to save; defaults to the current scene. Must be open."),
      new_path: z
        .string()
        .min(1)
        .optional()
        .describe("Save-as target path; saves the current/named scene to this new res:// path."),
      all: z.boolean().optional().describe("Save every open scene (default false)."),
    },
    handler: async (args) => {
      const { scene_path, new_path, all } = args as {
        scene_path?: string;
        new_path?: string;
        all?: boolean;
      };
      const params: Record<string, unknown> = { all: all ?? false };
      if (scene_path !== undefined) {
        const contained = resolveProjectPath(deps.bridge, scene_path);
        if ("error" in contained) return contained.error;
        params.scene_path = contained.resPath;
      }
      if (new_path !== undefined) {
        const contained = resolveProjectPath(deps.bridge, new_path);
        if ("error" in contained) return contained.error;
        params.new_path = contained.resPath;
      }
      try {
        const outcome = await requestValidated(deps.bridge, "scene/save", params, SaveSceneSchema);
        return successResult("Saved scene", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const closeScene: ToolDescriptor = {
    name: "close_scene",
    description:
      "Close a scene tab (default: the current scene); refuses to discard unsaved changes unless discard is true.",
    inputSchema: {
      scene_path: z
        .string()
        .min(1)
        .optional()
        .describe("Scene to close; defaults to the current scene. Must be open."),
      discard: z
        .boolean()
        .optional()
        .describe("Close even with unsaved changes, discarding them (default false)."),
    },
    handler: async (args) => {
      const { scene_path, discard } = args as { scene_path?: string; discard?: boolean };
      const params: Record<string, unknown> = { discard: discard ?? false };
      if (scene_path !== undefined) {
        const contained = resolveProjectPath(deps.bridge, scene_path);
        if ("error" in contained) return contained.error;
        params.scene_path = contained.resPath;
      }
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "scene/close",
          params,
          CloseSceneSchema,
        );
        return successResult("Closed scene", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const getSceneTree: ToolDescriptor = {
    name: "get_scene_tree",
    description:
      "Read the current edited scene's live node tree (unsaved state included): each node's type, path, attached script, and instanced-scene marker.",
    inputSchema: {},
    handler: async () => {
      try {
        const outcome = await requestValidated(deps.bridge, "scene/get_tree", {}, SceneTreeSchema);
        return successResult("Scene tree", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const exportMeshLibrary: ToolDescriptor = {
    name: "export_mesh_library",
    description:
      "Export a scene's MeshInstance3D meshes as a MeshLibrary .res resource (for GridMap), optionally filtered by node name; overwrites the output file.",
    inputSchema: {
      scene_path: z
        .string()
        .min(1, "scene_path must not be empty.")
        .describe('Scene to export from, e.g. "res://scenes/meshes.tscn".'),
      output_path: z
        .string()
        .min(1, "output_path must not be empty.")
        .describe(
          'Output resource path, e.g. "res://libraries/meshes.res"; overwritten if present.',
        ),
      mesh_item_names: z
        .array(z.string().min(1))
        .optional()
        .describe("Only export mesh items with these node names; omit to export every mesh."),
    },
    handler: async (args) => {
      const { scene_path, output_path, mesh_item_names } = args as {
        scene_path: string;
        output_path: string;
        mesh_item_names?: string[];
      };
      const scene = resolveProjectPath(deps.bridge, scene_path);
      if ("error" in scene) return scene.error;
      const output = resolveProjectPath(deps.bridge, output_path);
      if ("error" in output) return output.error;
      const params: Record<string, unknown> = {
        scene_path: scene.resPath,
        output_path: output.resPath,
      };
      if (mesh_item_names !== undefined) params.mesh_item_names = mesh_item_names;
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "scene/export_mesh_library",
          params,
          ExportMeshLibrarySchema,
        );
        return successResult("Exported mesh library", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  return [
    createScene,
    openScene,
    getOpenScenes,
    saveScene,
    closeScene,
    getSceneTree,
    exportMeshLibrary,
  ];
}
