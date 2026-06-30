/**
 * Typed, zod-validated configuration from environment + defaults.
 *
 * stdout is reserved for the stdio transport, so all logging is stderr only
 * and gated by DEBUG.
 *
 * TODO(M2): finalize parsing/validation and document in docs/config.md.
 */
import { z } from "zod";

const boolFromEnv = z
  .string()
  .optional()
  .transform((v) => v === "1" || v?.toLowerCase() === "true");

export const ConfigSchema = z.object({
  /** Explicit Godot binary; strict resolution (config → GODOT_PATH → autodetect). */
  godotPath: z.string().optional(),
  /** Verbose stderr logging. */
  debug: z.boolean().default(false),
  /** Ring-buffer cap for run output. */
  outputBufferLines: z.number().int().positive().default(1000),
  /** Path containment enforcement. Documented, default on. */
  strictPaths: z.boolean().default(true),
  /** Reserved (M4): optional startup allow-list of roots. */
  allowedRoots: z.array(z.string()).optional(),
});

export type Config = z.infer<typeof ConfigSchema>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return ConfigSchema.parse({
    godotPath: env.GODOT_PATH,
    debug: boolFromEnv.parse(env.DEBUG),
    outputBufferLines: env.OUTPUT_BUFFER_LINES
      ? Number(env.OUTPUT_BUFFER_LINES)
      : undefined,
    strictPaths: env.STRICT_PATHS ? boolFromEnv.parse(env.STRICT_PATHS) : true,
    allowedRoots: env.GODOT_ALLOWED_ROOTS?.split(",").filter(Boolean),
  });
}
