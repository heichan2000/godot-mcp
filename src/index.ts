import { main } from "./server.js";

main().catch((error: unknown) => {
  console.error("[godot-mcp] fatal error:", error);
  process.exit(1);
});
