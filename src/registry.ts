import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";
import {
  meetsMinVersion,
  parseMinGodotVersion,
  versionGateError,
  type EngineVersionSource,
} from "./version-gate.js";

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
   * Minimum engine version this tool requires, as a "major.minor" literal
   * (e.g. "4.4"). Purely generic descriptor metadata: `registerAll` (via
   * `applyVersionGate`) is the single place that enforces it, at call time,
   * against the handshake-reported engine version (REQ-A-07, 1.0 contract
   * carried forward - no version probe). A descriptor's own `handler` never
   * hand-codes this check.
   */
  minGodotVersion?: string;
}

export interface RegisterAllOptions {
  /**
   * Where the gate reads the connected engine's version - `createServer`
   * wires this to the bridge handshake. Required as soon as any descriptor
   * declares `minGodotVersion`: `registerAll` throws otherwise, so forgotten
   * wiring can never silently ship ungated tools.
   */
  engineVersion?: EngineVersionSource;
}

/**
 * Wraps a gated descriptor's handler so the version check runs before the
 * tool's own logic (REQ-A-07); returns ungated descriptors unchanged. With
 * no handshake available (editor not connected) the gate steps aside: the
 * handler's own bridge call produces the standard structured "editor not
 * connected" error (REQ-A-10), keeping one error shape per failure mode.
 * Exported so the integration suite can gate a test-local canary descriptor
 * against a real editor handshake.
 */
export function applyVersionGate<Args extends z.ZodRawShape>(
  descriptor: ToolDescriptor<Args>,
  engineVersion: EngineVersionSource,
): ToolDescriptor<Args> {
  const spec = descriptor.minGodotVersion;
  if (spec === undefined) return descriptor;
  const min = parseMinGodotVersion(spec);
  const gated = (async (...callArgs: Parameters<ToolCallback<Args>>) => {
    const actual = engineVersion();
    if (actual !== undefined && !meetsMinVersion(min, actual)) {
      return versionGateError(descriptor.name, spec, actual);
    }
    return descriptor.handler(callArgs[0], callArgs[1]);
  }) as ToolCallback<Args>;
  return { ...descriptor, handler: gated };
}

/**
 * Registers every descriptor on `server` via `McpServer.registerTool()`.
 * Fails fast (no partial registration) on duplicate names, on a gated
 * descriptor with no `engineVersion` source, and on a malformed
 * `minGodotVersion` literal.
 */
export function registerAll(
  server: Pick<McpServer, "registerTool">,
  descriptors: readonly ToolDescriptor[],
  options: RegisterAllOptions = {},
): void {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new Error(`Duplicate tool name registered: "${descriptor.name}"`);
    }
    seen.add(descriptor.name);
    if (descriptor.minGodotVersion !== undefined) {
      if (options.engineVersion === undefined) {
        throw new Error(
          `Tool "${descriptor.name}" declares minGodotVersion but registerAll received no ` +
            "engineVersion source - wire it from the bridge handshake (see createServer).",
        );
      }
      parseMinGodotVersion(descriptor.minGodotVersion);
    }
  }
  for (const descriptor of descriptors) {
    const toRegister = options.engineVersion
      ? applyVersionGate(descriptor, options.engineVersion)
      : descriptor;
    server.registerTool(
      toRegister.name,
      { description: toRegister.description, inputSchema: toRegister.inputSchema },
      toRegister.handler,
    );
  }
}
