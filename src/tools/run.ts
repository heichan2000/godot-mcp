import { z } from "zod";
import { createErrorResponse } from "../errors.js";
import type { ToolDescriptor } from "../registry.js";
import type { BridgePort } from "./bridge.js";
import { bridgeErrorToResponse, requestValidated, resolveProjectPath } from "./bridge.js";
import { successResult } from "./result.js";

export interface RunToolsDeps {
  bridge: BridgePort;
  /** Ring-buffer capacity plumbed to the addon per run/play (OUTPUT_BUFFER_LINES). */
  outputBufferLines: number;
}

type PlayMode = "main" | "current" | "custom";

const PlayOutcomeSchema = z
  .object({ mode: z.string(), scene_path: z.string(), replaced_active: z.boolean() })
  .catchall(z.unknown());

const StopOutcomeSchema = z.object({ was_running: z.boolean() }).catchall(z.unknown());

const OutputSchema = z
  .object({
    lines: z.array(z.object({ stream: z.string(), text: z.string() }).catchall(z.unknown())),
    next_cursor: z.number(),
    dropped_lines: z.number(),
    playing: z.boolean(),
  })
  .catchall(z.unknown());

/**
 * The run-control tools at 1.0 parity plus scene selection (REQ-E-01..E-03),
 * reimplemented through the editor's own play machinery (#72). Task 3 of the
 * plan appends stop_project and get_debug_output here.
 */
export function createRunTools(deps: RunToolsDeps): ToolDescriptor[] {
  const runProject: ToolDescriptor = {
    name: "run_project",
    description:
      "Play the project from the editor: the main scene by default, the current scene (mode: current), or a named scene (scene_path). Output is captured for get_debug_output.",
    inputSchema: {
      mode: z
        .enum(["main", "current", "custom"])
        .optional()
        .describe(
          'What to play: "main" (default) = the project main scene, "current" = the scene open in the editor, "custom" = the scene named by scene_path.',
        ),
      scene_path: z
        .string()
        .optional()
        .describe(
          'Scene to play, e.g. "res://scenes/main.tscn". Passing it alone implies mode "custom".',
        ),
    },
    handler: async (args) => {
      const { mode, scene_path } = args as { mode?: PlayMode; scene_path?: string };
      const effectiveMode: PlayMode = mode ?? (scene_path !== undefined ? "custom" : "main");
      if (effectiveMode !== "custom" && scene_path !== undefined) {
        return createErrorResponse({
          message: `scene_path was given but mode is "${effectiveMode}" - only mode "custom" plays a named scene.`,
          possibleSolutions: [
            'Drop the mode param: scene_path alone implies mode "custom".',
            "Or drop scene_path to play the main/current scene.",
          ],
        });
      }
      const params: Record<string, unknown> = {
        mode: effectiveMode,
        buffer_lines: deps.outputBufferLines,
      };
      if (effectiveMode === "custom") {
        if (scene_path === undefined || scene_path === "") {
          return createErrorResponse({
            message: 'mode "custom" requires scene_path.',
            possibleSolutions: [
              'Pass scene_path, e.g. "res://scenes/main.tscn".',
              'Or use mode "main" / "current" to play without naming a scene.',
            ],
          });
        }
        const contained = resolveProjectPath(deps.bridge, scene_path);
        if ("error" in contained) return contained.error;
        params.scene_path = contained.resPath;
      }
      try {
        const outcome = await requestValidated(deps.bridge, "run/play", params, PlayOutcomeSchema);
        return successResult("Playing", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const stopProject: ToolDescriptor = {
    name: "stop_project",
    description:
      "Stop the running game session started from the editor. Safe to call when nothing is playing: returns was_running: false as a structured no-op.",
    inputSchema: {},
    handler: async () => {
      try {
        const outcome = await requestValidated(deps.bridge, "run/stop", {}, StopOutcomeSchema);
        const label = outcome.was_running
          ? "Stopped the running session"
          : "Nothing was running (no-op)";
        return successResult(label, { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const getDebugOutput: ToolDescriptor = {
    name: "get_debug_output",
    description:
      "Tail the running (or last) game session's captured output from the editor's bounded ring buffer; pass the previous call's next_cursor to read only new lines.",
    inputSchema: {
      cursor: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(
          "Return lines after this cursor (omit or 0 = oldest retained). Use next_cursor from the previous call; repeat until lines comes back empty.",
        ),
    },
    handler: async (args) => {
      const cursor = (args as { cursor?: number }).cursor ?? 0;
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "run/get_output",
          { after: cursor },
          OutputSchema,
        );
        return successResult(`Session output (${outcome.lines.length} line(s))`, { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  return [runProject, stopProject, getDebugOutput];
}
