/**
 * Read-back tools (M2 / 1.0): the write→verify feedback loop.
 * get_scene_tree, read_node_properties, get_script_errors, list_resources.
 */
import { z } from "zod";
import { defineTool } from "../registry.js";
import { nodePath, projectPath, relativePath, scenePath } from "../schemas.js";

defineTool({
  name: "get_scene_tree",
  description:
    "Return a nested tree of { name, type, path, children[] } for a scene.",
  input: z.object({
    project_path: projectPath,
    scene_path: scenePath,
  }),
  handler: async () => {
    throw new Error("get_scene_tree not yet implemented (M2)");
  },
});

defineTool({
  name: "read_node_properties",
  description: "Return { property: value, ... } for a node in a scene.",
  input: z.object({
    project_path: projectPath,
    scene_path: scenePath,
    node_path: nodePath,
  }),
  handler: async () => {
    throw new Error("read_node_properties not yet implemented (M2)");
  },
});

defineTool({
  name: "get_script_errors",
  description:
    "Return [{ file, line, message }] parsed from headless parse/compile.",
  input: z
    .object({
      project_path: projectPath,
      scene_path: scenePath.optional(),
      script_path: relativePath.optional(),
    })
    .refine((v) => v.scene_path != null || v.script_path != null, {
      message: "provide either scene_path or script_path",
    }),
  handler: async () => {
    throw new Error("get_script_errors not yet implemented (M2)");
  },
});

defineTool({
  name: "list_resources",
  description: "Return [{ path (res://), type, uid? }] for project resources.",
  input: z.object({
    project_path: projectPath,
    type: z.string().optional(),
  }),
  handler: async () => {
    throw new Error("list_resources not yet implemented (M2)");
  },
});
