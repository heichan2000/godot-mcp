/**
 * Scene-mutation tools: create_scene, add_node, load_sprite,
 * export_mesh_library, save_scene.
 *
 * add_node restricts node_type to a vetted allow-list of Godot built-ins
 * (rejects res:///script-class injection). TODO(M1): finalize default
 * root_node_type and the initial allow-list set.
 */
import { z } from "zod";
import { defineTool } from "../registry.js";
import { nodePath, projectPath, relativePath, scenePath } from "../schemas.js";

defineTool({
  name: "create_scene",
  description: "Create a .tscn scene with the given root node type.",
  input: z.object({
    project_path: projectPath,
    scene_path: scenePath,
    root_node_type: z.string().optional(),
  }),
  handler: async () => {
    throw new Error("create_scene not yet implemented (M1)");
  },
});

defineTool({
  name: "add_node",
  description:
    "Add a node (type allow-listed) under a parent; apply simple properties.",
  input: z.object({
    project_path: projectPath,
    scene_path: scenePath,
    node_type: z.string().min(1),
    node_name: z.string().min(1),
    parent_node_path: nodePath.optional(),
    properties: z.record(z.unknown()).optional(),
  }),
  handler: async () => {
    throw new Error("add_node not yet implemented (M1)");
  },
});

defineTool({
  name: "load_sprite",
  description: "Assign a texture to a Sprite2D/3D node.",
  input: z.object({
    project_path: projectPath,
    scene_path: scenePath,
    node_path: nodePath,
    texture_path: relativePath,
  }),
  handler: async () => {
    throw new Error("load_sprite not yet implemented (M1)");
  },
});

defineTool({
  name: "export_mesh_library",
  description: "Export scene meshes as a MeshLibrary .res.",
  input: z.object({
    project_path: projectPath,
    scene_path: scenePath,
    output_path: relativePath,
    mesh_item_names: z.array(z.string()).optional(),
  }),
  handler: async () => {
    throw new Error("export_mesh_library not yet implemented (M1)");
  },
});

defineTool({
  name: "save_scene",
  description: 'Save the scene (optionally as a new path / "save as").',
  input: z.object({
    project_path: projectPath,
    scene_path: scenePath,
    new_path: scenePath.optional(),
  }),
  handler: async () => {
    throw new Error("save_scene not yet implemented (M1)");
  },
});
