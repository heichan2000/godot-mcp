import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

/**
 * A plain, unit-testable description of one MCP tool. Registration is a
 * generic loop over an array of these (see `registerAll`) - there is no
 * hand-rolled list/dispatch; the SDK derives the JSON schema from
 * `inputSchema` and routes calls to `handler`.
 */
export interface ToolDescriptor<Args extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  /** Zod raw shape (plain object of zod schemas), not a wrapped ZodObject. */
  inputSchema: Args;
  handler: ToolCallback<Args>;
  /** Minimum Godot version this tool requires, e.g. "4.4". Checked at call time. */
  minGodotVersion?: string;
}

/**
 * Registers every descriptor on `server` via `McpServer.registerTool()`.
 * Fails fast (no partial registration) if any descriptor names collide.
 */
export function registerAll(
  server: Pick<McpServer, "registerTool">,
  descriptors: readonly ToolDescriptor[],
): void {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new Error(`Duplicate tool name registered: "${descriptor.name}"`);
    }
    seen.add(descriptor.name);
  }

  for (const descriptor of descriptors) {
    server.registerTool(
      descriptor.name,
      { description: descriptor.description, inputSchema: descriptor.inputSchema },
      descriptor.handler,
    );
  }
}
