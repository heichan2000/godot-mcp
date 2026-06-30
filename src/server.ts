/**
 * MCP wiring only: transport, registry hookup, SIGINT handling.
 *
 * No tool logic lives here. Tools register themselves into the registry
 * (see registry.ts and tools/*.ts); the server exposes Registry.list()
 * via ListTools and routes CallTool through Registry.dispatch().
 *
 * TODO(M1): instantiate Server from @modelcontextprotocol/sdk, wire
 * ListTools/CallTool handlers to the registry, connect StdioServerTransport.
 */
import { loadConfig } from "./config.js";
import { registry } from "./registry.js";

// Importing the tool modules registers their descriptors as a side effect.
import "./tools/editor.js";
import "./tools/run.js";
import "./tools/project.js";
import "./tools/scene.js";
import "./tools/uid.js";
import "./tools/readback.js";

export async function startServer(): Promise<void> {
  const config = loadConfig();
  void config;
  void registry;

  // TODO(M1): build MCP Server, register handlers, connect transport.
  throw new Error("server not yet implemented (M1)");
}
