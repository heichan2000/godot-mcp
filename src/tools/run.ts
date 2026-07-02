import path from "node:path";
import { z } from "zod";
import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import {
  assertInsideRoot,
  detectGodotPath,
  godotNotFoundError,
  PathContainmentError,
  pathContainmentErrorResponse,
} from "../godot/paths.js";
import { GodotProcessManager } from "../godot/process.js";
import type { ToolDescriptor } from "../registry.js";
import { projectPathSchema, scenePathSchema } from "../schemas.js";

export interface RunToolsDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  processManager: GodotProcessManager;
}

/**
 * The process manager the production server actually uses (the default-deps
 * singleton behind `runTools`). Exported so `server.ts`'s shutdown path can
 * kill an active run before the server process exits - the child is a plain
 * non-detached spawn, so without this it would be orphaned and keep running
 * indefinitely after Ctrl-C.
 */
export const defaultProcessManager = new GodotProcessManager();

const defaultDeps: RunToolsDeps = {
  loadConfig,
  detectGodotPath,
  processManager: defaultProcessManager,
};

/**
 * Converts a project-relative path (already containment-checked) into the
 * res:// form Godot's CLI expects as its positional "scene to run" argument
 * - forward slashes always, mirroring the `to_res_path` helper in
 * `godot/operations.gd` even though this call never goes through the
 * dispatcher itself.
 */
function toResourcePath(relative: string): string {
  const normalized = relative.split(path.sep).join("/");
  return `res://${normalized.replace(/^\/+/, "")}`;
}

function noActiveProcessError(action: "get_debug_output" | "stop_project") {
  return createErrorResponse({
    message: `No Godot process is currently running - ${action} has nothing to report.`,
    possibleSolutions: [
      "Call run_project first to start a project (windowed by default, or headless: true for a log-only run).",
      "If a process was already stopped (or replaced by a newer run_project call), its output was cleared - run_project again to capture fresh output.",
    ],
  });
}

const runProjectInputSchema = {
  project_path: projectPathSchema,
  scene: scenePathSchema
    .optional()
    .describe(
      "Optional path to a specific .tscn scene to run instead of the project's main scene, " +
        "relative to project_path.",
    ),
  headless: z
    .boolean()
    .optional()
    .describe(
      "Run without a visible window (godot --headless -d), for CI/agent use. Defaults to " +
        "false: a visible window opens (godot -d), matching the original godot-mcp. Output is " +
        "captured into the debug buffer (readable via get_debug_output) either way.",
    ),
};

/**
 * Builds the `tools/run.ts` descriptor group: the single-active-process
 * runner (godot-prd.md §3/§5/§6.1). `processManager` is shared across all
 * three tools (and across calls) so state persists for the lifetime of the
 * server - starting a new run_project replaces whatever was active, and
 * get_debug_output / stop_project observe or end that same run.
 */
export function createRunTools(deps: RunToolsDeps = defaultDeps): ToolDescriptor[] {
  const runProject: ToolDescriptor<typeof runProjectInputSchema> = {
    name: "run_project",
    description:
      "Runs a Godot project (or one specific scene), capturing stdout/stderr into a bounded " +
      "ring buffer readable via get_debug_output. Windowed by default (a visible Godot window " +
      "opens); pass headless: true for a log-only run with no window (CI/agents). Starting a " +
      "new run terminates any previously active run and resets its buffer - only one run is " +
      "tracked at a time. Returns immediately once the process has been started.",
    inputSchema: runProjectInputSchema,
    handler: async ({ project_path, scene, headless }) => {
      let resourceScene: string | undefined;
      if (scene !== undefined) {
        try {
          assertInsideRoot(project_path, scene);
        } catch (error) {
          if (error instanceof PathContainmentError) {
            return pathContainmentErrorResponse(error);
          }
          throw error;
        }
        resourceScene = toResourcePath(scene);
      }

      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] run_project: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const isHeadless = headless ?? false;
      const outcome = deps.processManager.run({
        godotPath: resolution.path,
        projectPath: project_path,
        scene: resourceScene,
        headless: isHeadless,
        outputBufferLines: config.outputBufferLines,
      });

      const modeNote = isHeadless ? "headless" : "windowed";
      const replacedNote = outcome.replacedActive
        ? " A previously active run was stopped and its buffer cleared."
        : "";

      return {
        content: [
          {
            type: "text" as const,
            text:
              `Started Godot (${modeNote}) for "${project_path}".${replacedNote} ` +
              "Use get_debug_output to read captured output.",
          },
        ],
        structuredContent: {
          project_path,
          headless: isHeadless,
          pid: outcome.pid ?? null,
          replaced_active: outcome.replacedActive,
        },
      };
    },
  };

  const getDebugOutput: ToolDescriptor = {
    name: "get_debug_output",
    description:
      "Returns the current captured output from the active (or most recently finished) Godot " +
      "run as { output: string[], errors: string[] } (stdout and stderr, captured separately), " +
      "without disturbing it. Structured error if run_project has not been called yet, or its " +
      "output was already cleared by stop_project or a newer run_project call.",
    inputSchema: {},
    handler: async () => {
      const debugOutput = deps.processManager.getOutput();
      if (!debugOutput) {
        return noActiveProcessError("get_debug_output");
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `${debugOutput.output.length} output line(s), ${debugOutput.errors.length} error line(s).`,
          },
        ],
        structuredContent: { output: debugOutput.output, errors: debugOutput.errors },
      };
    },
  };

  const stopProject: ToolDescriptor = {
    name: "stop_project",
    description:
      "Kills the active Godot run and returns its captured output tail as " +
      "{ output: string[], errors: string[] }, then clears the tracked process. Structured " +
      "error if run_project has not been called yet (or was already stopped).",
    inputSchema: {},
    handler: async () => {
      const outcome = deps.processManager.stop();
      if (outcome.kind === "not-running") {
        return noActiveProcessError("stop_project");
      }
      return {
        content: [
          {
            type: "text" as const,
            text: `Stopped Godot run. Captured ${outcome.output.length} output line(s), ${outcome.errors.length} error line(s).`,
          },
        ],
        structuredContent: { output: outcome.output, errors: outcome.errors },
      };
    },
  };

  return [runProject as unknown as ToolDescriptor, getDebugOutput, stopProject];
}

export const runTools: ToolDescriptor[] = createRunTools();
