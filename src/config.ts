import { z } from "zod";

const TRUTHY_DEBUG_VALUES = new Set(["1", "true", "yes", "on"]);

const ConfigSchema = z.object({
  /** Explicit path to the Godot executable, as configured by the user. */
  godotPath: z.string().min(1).optional(),
  /** Enables verbose stderr diagnostics. Never affects stdout. */
  debug: z.boolean(),
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
 * Loads typed, validated server configuration from environment variables.
 * Pass a custom `env` (e.g. in tests) instead of relying on the process default.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    godotPath: readGodotPath(env),
    debug: readDebug(env),
  });
}
