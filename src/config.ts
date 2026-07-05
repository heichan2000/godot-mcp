import { z } from "zod";

const TRUTHY_DEBUG_VALUES = new Set(["1", "true", "yes", "on"]);

/** Default ring-buffer cap for run_project's captured output (godot-prd.md §8). */
export const DEFAULT_OUTPUT_BUFFER_LINES = 1000;
/** Default bridge WebSocket port - must match the addon's godot_mcp/network/port setting. */
export const DEFAULT_BRIDGE_PORT = 6510;
/** Default per-op bridge timeout (REQ-A-11 floor; progress-frame extension arrives in #75). */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;

const ConfigSchema = z.object({
  /** Explicit path to the Godot executable, as configured by the user. Consumed by create_project scaffolding (#66). */
  godotPath: z.string().min(1).optional(),
  /** Enables verbose stderr diagnostics. Never affects stdout. */
  debug: z.boolean(),
  /** Max lines retained per stream (stdout/stderr) by the run-output ring buffer. Consumed by the run-output buffer (#72). */
  outputBufferLines: z.number().int().positive(),
  /** Bridge WebSocket port (GODOT_MCP_PORT). Loopback-only by construction. */
  bridgePort: z.number().int().min(1).max(65_535),
  /** Per-request bridge timeout in ms (BRIDGE_TIMEOUT_MS). */
  bridgeTimeoutMs: z.number().int().positive(),
});

export type Config = z.infer<typeof ConfigSchema>;

function readGodotPath(env: NodeJS.ProcessEnv): string | undefined {
  const value = env.GODOT_PATH?.trim();
  return value ? value : undefined;
}

function readDebug(env: NodeJS.ProcessEnv): boolean {
  const value = env.DEBUG?.trim().toLowerCase();
  return value !== undefined && TRUTHY_DEBUG_VALUES.has(value);
}

/**
 * Reads OUTPUT_BUFFER_LINES as a positive integer, falling back to
 * DEFAULT_OUTPUT_BUFFER_LINES for anything unset, unparseable, non-integer,
 * or non-positive - lenient like readDebug rather than throwing on a
 * malformed env value.
 */
function readOutputBufferLines(env: NodeJS.ProcessEnv): number {
  const value = env.OUTPUT_BUFFER_LINES?.trim();
  if (!value) return DEFAULT_OUTPUT_BUFFER_LINES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_OUTPUT_BUFFER_LINES;
  return parsed;
}

/**
 * Reads GODOT_MCP_PORT as a valid TCP port, falling back to
 * DEFAULT_BRIDGE_PORT on unset/garbage/out-of-range values - lenient like
 * readOutputBufferLines rather than throwing.
 */
function readBridgePort(env: NodeJS.ProcessEnv): number {
  const value = env.GODOT_MCP_PORT?.trim();
  if (!value) return DEFAULT_BRIDGE_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return DEFAULT_BRIDGE_PORT;
  return parsed;
}

/**
 * Reads BRIDGE_TIMEOUT_MS as a positive integer, falling back to
 * DEFAULT_BRIDGE_TIMEOUT_MS on unset/garbage/non-positive values.
 */
function readBridgeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = env.BRIDGE_TIMEOUT_MS?.trim();
  if (!value) return DEFAULT_BRIDGE_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_BRIDGE_TIMEOUT_MS;
  return parsed;
}

/**
 * Loads typed, validated server configuration from environment variables.
 * Pass a custom `env` (e.g. in tests) instead of relying on the process default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    godotPath: readGodotPath(env),
    debug: readDebug(env),
    outputBufferLines: readOutputBufferLines(env),
    bridgePort: readBridgePort(env),
    bridgeTimeoutMs: readBridgeTimeoutMs(env),
  });
}
