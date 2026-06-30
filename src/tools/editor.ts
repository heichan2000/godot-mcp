/** Editor + version tools: launch_editor, get_godot_version. */
import { z } from "zod";
import { defineTool } from "../registry.js";
import { projectPath } from "../schemas.js";

defineTool({
  name: "launch_editor",
  description: "Open the Godot editor GUI for the given project.",
  input: z.object({ project_path: projectPath }),
  handler: async () => {
    throw new Error("launch_editor not yet implemented (M1)");
  },
});

defineTool({
  name: "get_godot_version",
  description: "Return the detected Godot version string.",
  input: z.object({}),
  handler: async () => {
    throw new Error("get_godot_version not yet implemented (M1)");
  },
});
