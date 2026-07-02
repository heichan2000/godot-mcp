import { z } from "zod";

const TRUTHY_DEBUG_VALUES = new Set(["1", "true", "yes", "on"]);

/** Default ring-buffer cap for run_project's captured output (godot-prd.md §8). */
export const DEFAULT_OUTPUT_BUFFER_LINES = 1000;

const ConfigSchema = z.object({
  /** Explicit path to the Godot executable, as configured by the user. */
  godotPath: z.string().min(1).optional(),
  /** Enables verbose stderr diagnostics. Never affects stdout. */
  debug: z.boolean(),
  /** Max lines retained per stream (stdout/stderr) by run_project's ring buffer. */
  outputBufferLines: z.number().int().positive(),
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
 * Loads typed, validated server configuration from environment variables.
 * Pass a custom `env` (e.g. in tests) instead of relying on the process default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    godotPath: readGodotPath(env),
    debug: readDebug(env),
    outputBufferLines: readOutputBufferLines(env),
  });
}
