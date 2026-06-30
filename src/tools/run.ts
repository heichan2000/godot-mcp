/** Run + debug tools: run_project, get_debug_output, stop_project. */
import { z } from "zod";
import { defineTool } from "../registry.js";
import { projectPath, scenePath } from "../schemas.js";

defineTool({
  name: "run_project",
  description:
    "Run the project headless (or a specific scene); capture output into the ring buffer. Replaces any active process.",
  input: z.object({
    project_path: projectPath,
    scene: scenePath.optional(),
  }),
  handler: async () => {
    throw new Error("run_project not yet implemented (M1)");
  },
});

defineTool({
  name: "get_debug_output",
  description: "Return the current { output[], errors[] } from the ring buffer.",
  input: z.object({}),
  handler: async () => {
    throw new Error("get_debug_output not yet implemented (M1)");
  },
});

defineTool({
  name: "stop_project",
  description: "Kill the active process; return the captured tail; clear it.",
  input: z.object({}),
  handler: async () => {
    throw new Error("stop_project not yet implemented (M1)");
  },
});
