import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Must match `VERSION` in operations.gd. Bump both together whenever the
 * argv or result-line contract changes.
 */
export const DISPATCHER_VERSION = 1;

/** Unique prefix marking the dispatcher's single JSON result line on stdout. */
const RESULT_MARKER = "GODOT_MCP_RESULT:";

const MAX_BUFFER_BYTES = 10 * 1024 * 1024;

export interface RunnerExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code. Nonzero does not necessarily mean a spawn failure - the dispatcher exits 1 on op-level errors too. */
  exitCode: number | null;
}

/**
 * `execFile`-based invocation seam, injected for testing. The default
 * implementation never rejects on a nonzero exit code (the dispatcher exits
 * 1 for ordinary op failures and we still need stdout to read its
 * structured error) - it only rejects when the process could not be spawned
 * at all (e.g. ENOENT).
 */
export type RunnerExecFile = (file: string, args: string[]) => Promise<RunnerExecResult>;

const defaultExecFile: RunnerExecFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFileCb(file, args, { maxBuffer: MAX_BUFFER_BYTES }, (error, stdout, stderr) => {
      if (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (typeof code !== "number") {
          // No process ran at all (e.g. ENOENT/EACCES) - a genuine spawn failure.
          reject(error);
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: code });
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 });
    });
  });

export interface RunOperationDeps {
  execFile: RunnerExecFile;
}

const defaultDeps: RunOperationDeps = { execFile: defaultExecFile };

export interface RunOperationOptions {
  godotPath: string;
  projectPath: string;
  operationScriptPath: string;
  operation: string;
  params: Record<string, unknown>;
  /** Dispatcher version this runner call expects; defaults to DISPATCHER_VERSION. Overridable for tests. */
  expectedVersion?: number;
}

export type RunOperationResult =
  | { kind: "success"; version: number; operation: string; result: Record<string, unknown> }
  | { kind: "operation-error"; version: number; operation: string; error: string }
  | { kind: "version-mismatch"; expectedVersion: number; actualVersion: number }
  | {
      kind: "protocol-error";
      message: string;
      stdout: string;
      stderr: string;
      exitCode: number | null;
    }
  | { kind: "spawn-error"; message: string };

interface DispatcherResultPayload {
  ok: boolean;
  version: number;
  operation: string;
  result?: Record<string, unknown>;
  error?: string;
}

function isDispatcherResultPayload(value: unknown): value is DispatcherResultPayload {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.ok === "boolean" && typeof candidate.version === "number";
}

/**
 * Extracts the dispatcher's JSON result from `stdout`. The dispatcher emits
 * exactly one marker-prefixed line, but engine banners/warnings surround
 * it - and in principle it could be printed more than once - so this scans
 * every line and returns the last valid match.
 */
function extractDispatcherResult(stdout: string): DispatcherResultPayload | undefined {
  let latest: DispatcherResultPayload | undefined;
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(RESULT_MARKER)) continue;
    const jsonText = trimmed.slice(RESULT_MARKER.length);
    try {
      const parsed: unknown = JSON.parse(jsonText);
      if (isDispatcherResultPayload(parsed)) {
        latest = parsed;
      }
    } catch {
      // Ignore an unparsable marker line; a later valid one (or none) decides the outcome.
    }
  }
  return latest;
}

/**
 * Runs one dispatcher operation and interprets its result. Never throws for
 * expected failure modes (op errors, version mismatches, missing/garbled
 * output, spawn failures) - each maps to a distinct `RunOperationResult`
 * kind so callers can produce a precise guided error.
 */
export async function runOperation(
  options: RunOperationOptions,
  deps: RunOperationDeps = defaultDeps,
): Promise<RunOperationResult> {
  const expectedVersion = options.expectedVersion ?? DISPATCHER_VERSION;

  let execResult: RunnerExecResult;
  try {
    execResult = await deps.execFile(options.godotPath, [
      "--headless",
      "--path",
      options.projectPath,
      "--script",
      options.operationScriptPath,
      "--",
      options.operation,
      JSON.stringify(options.params),
    ]);
  } catch (error) {
    return {
      kind: "spawn-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  const payload = extractDispatcherResult(execResult.stdout);
  if (!payload) {
    return {
      kind: "protocol-error",
      message:
        "Godot exited without emitting a recognizable result line. This usually means the " +
        "dispatcher crashed before it could respond, or its output contract changed.",
      stdout: execResult.stdout,
      stderr: execResult.stderr,
      exitCode: execResult.exitCode,
    };
  }

  if (payload.version !== expectedVersion) {
    return {
      kind: "version-mismatch",
      expectedVersion,
      actualVersion: payload.version,
    };
  }

  if (payload.ok) {
    return {
      kind: "success",
      version: payload.version,
      operation: payload.operation,
      result: payload.result ?? {},
    };
  }

  return {
    kind: "operation-error",
    version: payload.version,
    operation: payload.operation,
    error: payload.error ?? "Unknown dispatcher error.",
  };
}

/** This module's own directory - operations.gd ships alongside it in both src/godot (dev/test) and dist/ (built, bundled into a single file). */
const OWN_MODULE_URL = import.meta.url;

/**
 * Resolves the bundled dispatcher script path relative to this module's own
 * location. Works unmodified in both contexts because the build mirrors the
 * source layout: `tsup` bundles every module into a single `dist/index.js`
 * and a copy step places `operations.gd` next to it, while at dev/test time
 * (running from `src` via tsx/vitest) this module itself lives in
 * `src/godot/`, right next to the source `operations.gd`. Either way,
 * "next to this file" is the right answer - so `import.meta.url` is the one
 * resolution strategy needed for both.
 */
export function resolveOperationsScriptPath(moduleUrl: string = OWN_MODULE_URL): string {
  return path.join(path.dirname(fileURLToPath(moduleUrl)), "operations.gd");
}

/**
 * Verifies the bundled dispatcher exists on disk. Intended to be called
 * once at server startup (not lazily per-call, unlike Godot resolution) -
 * a missing `operations.gd` means the install/build itself is broken, not
 * that the user forgot to configure something.
 */
export function assertOperationsScriptExists(
  scriptPath: string,
  fileExists: (candidate: string) => boolean = existsSync,
): void {
  if (!fileExists(scriptPath)) {
    throw new Error(
      `Bundled dispatcher script not found at "${scriptPath}". This indicates a broken ` +
        "install or build - operations.gd should always ship next to the server's built code. " +
        "Try reinstalling the package (npm install) or rebuilding from source (npm run build).",
    );
  }
}
