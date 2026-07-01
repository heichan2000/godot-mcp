import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { registerAll } from "./registry.js";
import { createEditorTools, type EditorToolsDeps } from "./tools/editor.js";

const SERVER_NAME = "godot-mcp";
const SERVER_VERSION = "0.1.0";

export interface CreateServerOptions {
  /** Override tool dependencies (used by tests; production uses real env/fs/exec). */
  editorToolsDeps?: EditorToolsDeps;
}

/**
 * Builds the MCP server and registers every tool descriptor. Pure wiring:
 * no Godot resolution happens here, so this always succeeds even with no
 * Godot installed.
 */
export function createServer(options: CreateServerOptions = {}): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  const tools = createEditorTools(options.editorToolsDeps);
  registerAll(server, tools);
  return server;
}

/** Starts the server over stdio. Logs (stderr only) are gated by DEBUG. */
export async function main(): Promise<void> {
  const config = loadConfig();
  const debugLog = (message: string) => {
    if (config.debug) console.error(`[godot-mcp] ${message}`);
  };

  debugLog("starting stdio MCP server");

  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);

  debugLog("connected; awaiting requests over stdio");

  const shutdown = (signal: string) => {
    debugLog(`received ${signal}, shutting down`);
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}
