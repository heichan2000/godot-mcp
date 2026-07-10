import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeConnection } from "./bridge/connection.js";
import { DEFAULT_LSP_PORT, loadConfig } from "./config.js";
import { registerAll, type ToolDescriptor } from "./registry.js";
import { createBridgeTools, type BridgePort } from "./tools/bridge.js";
import { createDiagnosticsTools } from "./tools/diagnostics.js";
import { createNodeTools } from "./tools/node.js";
import { createOnboardingTools } from "./tools/onboarding.js";
import { createProjectTools } from "./tools/project.js";
import { createSceneTools } from "./tools/scene.js";

const SERVER_NAME = "godot-mcp";
/** Kept in lockstep with package.json - asserted by test/unit/server.test.ts. */
export const SERVER_VERSION = "2.0.0-alpha.0";

export interface ServerDeps {
  bridge: BridgePort;
  /** GDScript language-server port; defaults to DEFAULT_LSP_PORT for stub callers (lint/tests). */
  lspPort?: number;
}

/**
 * The complete tool inventory, in registration order. Exported (rather than
 * inlined in createServer) so the REQ-A-05 naming lint and the REQ-M-03
 * code-exec audit (#76) can walk exactly what ships, with a stub bridge.
 */
export function buildToolInventory(deps: ServerDeps): ToolDescriptor[] {
  return [
    ...createBridgeTools({ bridge: deps.bridge, serverVersion: SERVER_VERSION }),
    ...createOnboardingTools({
      serverVersion: SERVER_VERSION,
      bundledAddonDir: resolveBundledAddonDir(),
    }),
    ...createProjectTools({ bridge: deps.bridge }),
    ...createSceneTools({ bridge: deps.bridge }),
    ...createNodeTools({ bridge: deps.bridge }),
    ...createDiagnosticsTools({ bridge: deps.bridge, lspPort: deps.lspPort ?? DEFAULT_LSP_PORT }),
  ];
}

/** Builds the MCP server and registers every tool. Pure wiring; never touches the network itself. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAll(server, buildToolInventory(deps), {
    engineVersion: () => deps.bridge.status().hello?.godot_version,
  });
  return server;
}

export interface CreateShutdownOptions {
  stopBridge: () => Promise<void>;
  closeServer: () => Promise<void>;
  exit: (code: number) => void;
  debugLog: (message: string) => void;
}

/**
 * Tears down bridge + server on SIGINT/SIGTERM. Exits even if either close
 * fails - shutdown must never hang.
 */
export function createShutdown(options: CreateShutdownOptions): (signal: string) => void {
  return (signal) => {
    options.debugLog(`received ${signal}, shutting down`);
    void Promise.allSettled([options.stopBridge(), options.closeServer()])
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            options.debugLog(`shutdown step failed: ${String(result.reason)}`);
          }
        }
      })
      .finally(() => options.exit(0));
  };
}

/** Sanity check that the packaged addon payload shipped next to the build (successor of 1.0's operations.gd check). */
export function resolveBundledAddonDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "addon", "godot_mcp");
}

/** Starts the server over stdio. Logs (stderr only) are gated by DEBUG (REQ-A-09/M-07). */
export async function main(): Promise<void> {
  const config = loadConfig();
  const debugLog = (message: string) => {
    if (config.debug) console.error(`[godot-mcp] ${message}`);
  };

  debugLog("starting stdio MCP server (v2 bridge mode)");

  const bridge = new BridgeConnection({
    url: `ws://127.0.0.1:${config.bridgePort}`,
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: config.bridgeTimeoutMs,
    log: debugLog,
  });
  bridge.start();

  const server = createServer({ bridge, lspPort: config.lspPort });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  debugLog(`connected; bridging to ws://127.0.0.1:${config.bridgePort}`);

  const shutdown = createShutdown({
    stopBridge: () => bridge.stop(),
    closeServer: () => server.close(),
    exit: (code) => process.exit(code),
    debugLog,
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Test hook: reads package.json's version for the lockstep assertion. */
export function packageJsonVersion(): string {
  const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(packagePath, "utf8")) as { version: string }).version;
}
