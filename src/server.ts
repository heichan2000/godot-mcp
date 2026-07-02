import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { assertOperationsScriptExists, resolveOperationsScriptPath } from "./godot/runner.js";
import type { GodotProcessManager } from "./godot/process.js";
import { registerAll } from "./registry.js";
import { createEditorTools, type EditorToolsDeps } from "./tools/editor.js";
import { createProjectTools, type ProjectToolsDeps } from "./tools/project.js";
import { createRunTools, defaultProcessManager, type RunToolsDeps } from "./tools/run.js";
import { createSceneTools, type SceneToolsDeps } from "./tools/scene.js";

const SERVER_NAME = "godot-mcp";
const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  /** Override tool dependencies (used by tests; production uses real env/fs/exec). */
  editorToolsDeps?: EditorToolsDeps;
  sceneToolsDeps?: SceneToolsDeps;
  projectToolsDeps?: ProjectToolsDeps;
  runToolsDeps?: RunToolsDeps;
}

/**
 * Builds the MCP server and registers every tool descriptor. Pure wiring:
 * no Godot resolution happens here, so this always succeeds even with no
 * Godot installed.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const tools = [
    ...createEditorTools(options.editorToolsDeps),
    ...createSceneTools(options.sceneToolsDeps),
    ...createProjectTools(options.projectToolsDeps),
    ...createRunTools(options.runToolsDeps),
  ];
  registerAll(server, tools);
  return server;
}

export interface CreateShutdownOptions {
  /** The manager owning any active run_project child (see tools/run.ts's defaultProcessManager). */
  processManager: Pick<GodotProcessManager, "stop">;
  closeServer: () => Promise<void>;
  exit: (code: number) => void;
  debugLog: (message: string) => void;
}

/**
 * Builds the signal handler that tears the server down. Kills any active
 * `run_project` child first: it is a plain non-detached spawn (unlike
 * `launch_editor`'s deliberately detached editor), so exiting without
 * stopping it would orphan a Godot process that keeps running indefinitely
 * after Ctrl-C. Exits even if closing the server fails - shutdown must
 * never hang.
 */
export function createShutdown(options: CreateShutdownOptions): (signal: string) => void {
  return (signal) => {
    options.debugLog(`received ${signal}, shutting down`);
    try {
      options.processManager.stop();
    } catch {
      // Best-effort: an already-dead child must not block shutdown.
    }
    void options
      .closeServer()
      .catch((error: unknown) => {
        // A close failure must neither block the exit below nor surface as
        // an unhandled rejection during shutdown.
        options.debugLog(`server close failed: ${String(error)}`);
      })
      .finally(() => options.exit(0));
  };
}

/** Starts the server over stdio. Logs (stderr only) are gated by DEBUG. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const debugLog = (message: string) => {
    if (config.debug) console.error(`[godot-mcp] ${message}`);
  };

  debugLog("starting stdio MCP server");

  // The bundled dispatcher must exist next to the built server code before
  // we accept any tool calls - a missing operations.gd means the
  // install/build itself is broken, not a user-fixable env issue, so this
  // check runs eagerly at startup (unlike Godot executable resolution,
  // which stays lazy per-call).
  try {
    assertOperationsScriptExists(resolveOperationsScriptPath());
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[godot-mcp] ${message}`);
    process.exit(1);
  }

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  debugLog("connected; awaiting requests over stdio");

  const shutdown = createShutdown({
    processManager: defaultProcessManager,
    closeServer: () => server.close(),
    exit: (code) => process.exit(code),
    debugLog,
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
