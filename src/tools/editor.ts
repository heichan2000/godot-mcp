import { loadConfig } from "../config.js";
import { createErrorResponse } from "../errors.js";
import { detectGodotPath, godotNotFoundError } from "../godot/paths.js";
import { createSpawnDetached, type SpawnDetachedFn } from "../godot/process.js";
import { defaultExecFile, probeGodotVersion, type ExecFileFn } from "../godot/version-gate.js";
import type { ToolDescriptor } from "../registry.js";
import { projectPathSchema } from "../schemas.js";

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
      // Reuses the same config -> detectGodotPath -> `--version` probe the
      // call-time minGodotVersion gate uses (godot/version-gate.ts) - this
      // tool always probes fresh (no caching) so it reflects the current
      // GODOT_PATH/environment on every call, unlike the gate's cached
      // resolution shared across get_uid/update_project_uids.
      const result = await probeGodotVersion(deps);

      if (deps.loadConfig().debug) {
        console.error(`[godot-mcp] get_godot_version: probe=${JSON.stringify(result)}`);
      }

      switch (result.kind) {
        case "not-found":
          return godotNotFoundError(result.candidates);
        case "resolved":
          return { content: [{ type: "text" as const, text: result.version }] };
        case "exec-failed":
          return createErrorResponse({
            message: `Failed to run "${result.godotPath} --version": ${result.message}`,
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
