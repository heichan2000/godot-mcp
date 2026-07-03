import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import { createGodotVersionGate, type GodotVersionGate } from "./godot/version-gate.js";

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
  /**
   * Minimum Godot version this tool requires, e.g. "4.4". Purely generic
   * descriptor metadata - `registerAll` is the single place that enforces
   * it, at call time, against a lazily-resolved and cached `--version`
   * probe (see `godot/version-gate.ts`). A descriptor's own `handler` never
   * hand-codes this check; a tool declares the requirement here and gets it
   * enforced for free.
   */
  minGodotVersion?: string;
}

export interface RegisterAllOptions {
  /**
   * Resolves and enforces `minGodotVersion` for every gated descriptor.
   * Defaults to a fresh `createGodotVersionGate()` - constructing it here
   * does not itself invoke Godot; the underlying `--version` probe only
   * runs lazily, on the first call to a gated tool. All descriptors passed
   * to the same `registerAll` call share one gate instance (and therefore
   * one cached probe) unless a caller overrides this for tests.
   */
  versionGate?: GodotVersionGate;
}

/**
 * Registers every descriptor on `server` via `McpServer.registerTool()`.
 * Fails fast (no partial registration) if any descriptor names collide.
 * Descriptors with a `minGodotVersion` get their handler wrapped so the
 * version gate runs before the tool's own logic; every other descriptor's
 * handler is registered completely untouched.
 */
export function registerAll(
  server: Pick<McpServer, "registerTool">,
  descriptors: readonly ToolDescriptor[],
  options: RegisterAllOptions = {},
): void {
  const versionGate = options.versionGate ?? createGodotVersionGate();
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new Error(`Duplicate tool name registered: "${descriptor.name}"`);
    }
    seen.add(descriptor.name);
  }

  for (const descriptor of descriptors) {
    const handler = descriptor.minGodotVersion
      ? gateHandler(descriptor.minGodotVersion, versionGate, descriptor.handler)
      : descriptor.handler;
    server.registerTool(
      descriptor.name,
      { description: descriptor.description, inputSchema: descriptor.inputSchema },
      handler,
    );
  }
}

/**
 * Wraps `handler` so it only runs once `versionGate.checkMinVersion` passes;
 * a blocked check short-circuits straight to the gate's structured error
 * without ever invoking the tool's own logic.
 */
function gateHandler<Args extends z.ZodRawShape>(
  minGodotVersion: string,
  versionGate: GodotVersionGate,
  handler: ToolCallback<Args>,
): ToolCallback<Args> {
  const wrapped = async (...callArgs: Parameters<ToolCallback<Args>>) => {
    const check = await versionGate.checkMinVersion(minGodotVersion);
    if (check.kind === "blocked") {
      return check.error;
    }
    return handler(callArgs[0], callArgs[1]);
  };
  return wrapped as ToolCallback<Args>;
}
