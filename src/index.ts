/**
 * Bin entry for @heichan2000/godot-mcp.
 *
 * Thin wrapper: load config, build the server, connect stdio transport.
 * Keep this file minimal — wiring lives in server.ts.
 */
import { startServer } from "./server.js";

startServer().catch((err: unknown) => {
  // stderr only — stdout is reserved for the stdio transport.
  console.error("[godot-mcp] fatal:", err);
  process.exit(1);
});
