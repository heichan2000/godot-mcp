/** Project discovery tools: list_projects, get_project_info. */
import { z } from "zod";
import { defineTool } from "../registry.js";
import { projectPath } from "../schemas.js";

defineTool({
  name: "list_projects",
  description: "Find project.godot files under a directory.",
  input: z.object({
    directory: z.string().min(1),
    recursive: z.boolean().optional(),
  }),
  handler: async () => {
    throw new Error("list_projects not yet implemented (M1)");
  },
});

defineTool({
  name: "get_project_info",
  description: "Return name, Godot version, and file/asset counts for a project.",
  input: z.object({ project_path: projectPath }),
  handler: async () => {
    throw new Error("get_project_info not yet implemented (M1)");
  },
});
