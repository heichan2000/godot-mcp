/**
 * UID tools: get_uid, update_project_uids.
 *
 * Feature-gated to Godot ≥ 4.4 (detect via --version). On older runtimes
 * these are hidden/disabled and return a clear "requires Godot ≥ 4.4" error.
 * TODO(M1): wire `gated` to the detected version.
 */
import { z } from "zod";
import { defineTool } from "../registry.js";
import { projectPath, relativePath } from "../schemas.js";

defineTool({
  name: "get_uid",
  description: "(Godot ≥ 4.4) Return the resource UID for a file.",
  input: z.object({
    project_path: projectPath,
    file_path: relativePath,
  }),
  handler: async () => {
    throw new Error("get_uid not yet implemented (M1)");
  },
});

defineTool({
  name: "update_project_uids",
  description: "(Godot ≥ 4.4) Resave resources to refresh UID references.",
  input: z.object({ project_path: projectPath }),
  handler: async () => {
    throw new Error("update_project_uids not yet implemented (M1)");
  },
});
