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

/**
 * Default ceiling on how long a single dispatcher invocation may run before
 * it's killed. Dispatcher ops are short (a headless boot plus one op), so
 * 60s is generous; later slices with slower ops (e.g. importing large
 * assets) can override this per call via `RunOperationOptions.timeoutMs`.
 */
export const DEFAULT_OPERATION_TIMEOUT_MS = 60_000;

/**
 * Default ceiling for `runGodotImport`. `godot --headless --import`
 * (re)imports every asset that needs it, which can take minutes on a large
 * project - empirically far longer than a single dispatcher op - so this
 * gets its own, much larger default, still overridable per call via
 * `RunGodotImportOptions.timeoutMs`.
 */
export const DEFAULT_IMPORT_TIMEOUT_MS = 5 * 60_000;

export interface RunnerExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code. Nonzero does not necessarily mean a spawn failure - the dispatcher exits 1 on op-level errors too. */
  exitCode: number | null;
}

export interface RunnerExecFileOptions {
  /** Kills the process (and rejects with a killed/signal-shaped error) if it runs longer than this. */
  timeoutMs: number;
}

/**
 * `execFile`-based invocation seam, injected for testing. The default
 * implementation never rejects on a nonzero exit code (the dispatcher exits
 * 1 for ordinary op failures and we still need stdout to read its
 * structured error) - it only rejects when the process could not be spawned
 * at all (e.g. ENOENT) or was killed for running past `timeoutMs`.
 */
export type RunnerExecFile = (
  file: string,
  args: string[],
  options: RunnerExecFileOptions,
) => Promise<RunnerExecResult>;

const defaultExecFile: RunnerExecFile = (file, args, { timeoutMs }) =>
  new Promise((resolve, reject) => {
    execFileCb(
      file,
      args,
      { maxBuffer: MAX_BUFFER_BYTES, timeout: timeoutMs, killSignal: "SIGTERM" },
      (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (typeof code !== "number") {
            // Either no process ran at all (e.g. ENOENT/EACCES), or Node
            // killed it for exceeding `timeoutMs` - both leave `code`
            // non-numeric (null on timeout). `runOperation` distinguishes
            // the two by checking `killed`/`signal` on the rejected error.
            reject(error);
            return;
          }
          resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: code });
          return;
        }
        resolve({ stdout: stdout.toString(), stderr: stderr.toString(), exitCode: 0 });
      },
    );
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
  /** Kills a hung Godot subprocess after this many ms; defaults to DEFAULT_OPERATION_TIMEOUT_MS. */
  timeoutMs?: number;
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
  | { kind: "spawn-error"; message: string }
  | { kind: "timeout"; timeoutMs: number };

/**
 * Recognizes the error shape Node's `child_process.execFile` produces when it
 * kills a process for exceeding the configured `timeout`: `killed: true`
 * plus a non-empty `signal`. Used to tell a timeout apart from a genuine
 * spawn failure (e.g. ENOENT), both of which reject with a non-numeric
 * `error.code`.
 */
function isTimeoutError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const candidate = error as { killed?: unknown; signal?: unknown };
  return (
    candidate.killed === true && typeof candidate.signal === "string" && candidate.signal !== ""
  );
}

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
  const timeoutMs = options.timeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;

  let execResult: RunnerExecResult;
  try {
    execResult = await deps.execFile(
      options.godotPath,
      [
        "--headless",
        "--path",
        options.projectPath,
        "--script",
        options.operationScriptPath,
        "--",
        options.operation,
        JSON.stringify(options.params),
      ],
      { timeoutMs },
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      return { kind: "timeout", timeoutMs };
    }
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

export interface RunGodotImportOptions {
  godotPath: string;
  projectPath: string;
  /** Kills a hung import after this many ms; defaults to DEFAULT_IMPORT_TIMEOUT_MS. */
  timeoutMs?: number;
}

export type RunGodotImportResult =
  | {
      kind: "completed";
      exitCode: number | null;
      stdout: string;
      stderr: string;
      durationMs: number;
    }
  | { kind: "spawn-error"; message: string }
  | { kind: "timeout"; timeoutMs: number };

/**
 * Runs `godot --headless --path <project> --import` to (re)build a
 * project's asset import cache. This is a plain Godot invocation, not a
 * dispatcher call - there's no `--script operations.gd`, no JSON result
 * marker, and no version handshake, so it shares only the exec/timeout
 * seam and error mapping with `runOperation`, not its protocol parsing.
 *
 * Deliberately does not itself decide success or failure: Godot's exit
 * code is not a reliable signal here (empirically, `--import` can exit 0
 * even when an individual asset fails to import, and in principle the
 * reverse - a benign nonzero exit on an otherwise-successful run - is a
 * known Godot quirk). Every non-exec-failure outcome comes back as
 * `"completed"` with the raw exit code, stdout, and stderr; callers (see
 * `tools/project.ts`) judge success by checking cache state afterward
 * (`hasGodotCacheDir`/`hasImportCache` in `./cache.js`) instead.
 */
export async function runGodotImport(
  options: RunGodotImportOptions,
  deps: RunOperationDeps = defaultDeps,
): Promise<RunGodotImportResult> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_IMPORT_TIMEOUT_MS;
  const startedAt = Date.now();

  let execResult: RunnerExecResult;
  try {
    execResult = await deps.execFile(
      options.godotPath,
      ["--headless", "--path", options.projectPath, "--import"],
      { timeoutMs },
    );
  } catch (error) {
    if (isTimeoutError(error)) {
      return { kind: "timeout", timeoutMs };
    }
    return {
      kind: "spawn-error",
      message: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    kind: "completed",
    exitCode: execResult.exitCode,
    stdout: execResult.stdout,
    stderr: execResult.stderr,
    durationMs: Date.now() - startedAt,
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
