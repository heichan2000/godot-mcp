import { execFile as execFileCb } from "node:child_process";
import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import { detectGodotPath, godotNotFoundError } from "../godot/paths.js";
import { createSpawnDetached, type SpawnDetachedFn } from "../godot/process.js";
import type { ToolDescriptor } from "../registry.js";
import { projectPathSchema } from "../schemas.js";

type ExecFileFn = (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;

const defaultExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFileCb(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });

export interface EditorToolsDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  execFile: ExecFileFn;
  spawnDetached: SpawnDetachedFn;
}

const defaultDeps: EditorToolsDeps = {
  loadConfig,
  detectGodotPath,
  execFile: defaultExecFile,
  spawnDetached: createSpawnDetached(),
};

/**
 * Builds the `tools/editor.ts` descriptor group. Godot resolution happens
 * lazily inside the handler (never at startup/registration time) so the
 * server boots fine even with no Godot installed.
 */
export function createEditorTools(deps: EditorToolsDeps = defaultDeps): ToolDescriptor[] {
  const getGodotVersion: ToolDescriptor = {
    name: "get_godot_version",
    description:
      "Returns the version string reported by the resolved Godot 4.x executable (config -> GODOT_PATH -> autodetect).",
    inputSchema: {},
    handler: async () => {
      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] get_godot_version: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      try {
        const { stdout } = await deps.execFile(resolution.path, ["--version"]);
        return { content: [{ type: "text" as const, text: stdout.trim() }] };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return createErrorResponse({
          message: `Failed to run "${resolution.path} --version": ${reason}`,
          possibleSolutions: [
            "Confirm GODOT_PATH points at a valid, executable Godot 4.x binary.",
            "Try running the executable manually from a terminal to confirm it works.",
          ],
        });
      }
    },
  };

  const launchEditorInputSchema = { project_path: projectPathSchema };

  const launchEditor: ToolDescriptor<typeof launchEditorInputSchema> = {
    name: "launch_editor",
    description:
      "Opens the Godot editor GUI for project_path, detached from this MCP server's own " +
      "process - the editor keeps running even after the server exits. Returns immediately " +
      "once the editor process has been started; does not wait for the editor window to finish " +
      "loading.",
    inputSchema: launchEditorInputSchema,
    handler: async ({ project_path }) => {
      const config = deps.loadConfig();
      const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

      if (config.debug) {
        console.error(`[godot-mcp] launch_editor: resolution=${JSON.stringify(resolution)}`);
      }

      if (!resolution.found) {
        return godotNotFoundError(resolution.candidates);
      }

      const handle = deps.spawnDetached(resolution.path, ["-e", "--path", project_path]);

      return {
        content: [{ type: "text" as const, text: `Launched Godot editor for "${project_path}".` }],
        structuredContent: { project_path, pid: handle.pid ?? null },
      };
    },
  };

  return [getGodotVersion, launchEditor as unknown as ToolDescriptor];
}

export const editorTools: ToolDescriptor[] = createEditorTools();
