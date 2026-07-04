import { execFile as execFileCb } from "node:child_process";
import { loadConfig } from "../config.js";
import { createErrorResponse, type ErrorResponse } from "../errors.js";
import { detectGodotPath, godotNotFoundError } from "../godot/paths.js";

/**
 * Shape of the `execFile` seam every Godot `--version`-probing caller uses,
 * injected for testing. Shared by `tools/editor.ts`'s `get_godot_version`
 * handler and this module's version gate (see `defaultExecFile`) rather than
 * each defining its own copy.
 */
export type ExecFileFn = (
  file: string,
  args: string[],
) => Promise<{ stdout: string; stderr: string }>;

/** Default `execFile`-based implementation of `ExecFileFn`, shared by every caller in this file. */
export const defaultExecFile: ExecFileFn = (file, args) =>
  new Promise((resolve, reject) => {
    execFileCb(file, args, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });

/**
 * Dependencies needed to probe the resolved Godot executable's `--version`
 * output. Shared by `tools/editor.ts`'s `get_godot_version` handler and this
 * module's version gate - both need the exact same
 * config -> detectGodotPath -> `<godot> --version` chain, just for different
 * purposes (report it verbatim vs. gate a call on it).
 */
export interface GodotVersionProbeDeps {
  loadConfig: typeof loadConfig;
  detectGodotPath: typeof detectGodotPath;
  execFile: ExecFileFn;
}

export type GodotVersionProbeResult =
  | { kind: "resolved"; version: string; godotPath: string }
  | { kind: "not-found"; candidates: string[] }
  | { kind: "exec-failed"; godotPath: string; message: string };

/**
 * Resolves Godot the strict way (config -> GODOT_PATH -> autodetect) and runs
 * `--version` against it. Never throws: every failure mode (unresolved
 * executable, a spawn/exec failure) comes back as a distinct result kind so
 * callers can produce their own guided error, tailored to context (a direct
 * tool call vs. a version-gate check).
 */
export async function probeGodotVersion(
  deps: GodotVersionProbeDeps,
): Promise<GodotVersionProbeResult> {
  const config = deps.loadConfig();
  const resolution = deps.detectGodotPath({ configuredPath: config.godotPath });

  if (!resolution.found) {
    return { kind: "not-found", candidates: resolution.candidates };
  }

  try {
    const { stdout } = await deps.execFile(resolution.path, ["--version"]);
    return { kind: "resolved", version: stdout.trim(), godotPath: resolution.path };
  } catch (error) {
    return {
      kind: "exec-failed",
      godotPath: resolution.path,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export interface GodotVersionParts {
  major: number;
  minor: number;
  patch: number;
}

/**
 * Parses the leading `major.minor[.patch]` off a Godot version string -
 * either the raw `--version` output (e.g. `"4.6.3.stable.official.abcd1234"`)
 * or a plain minimum-version literal like `"4.4"`. `patch` defaults to 0 when
 * omitted (Godot itself omits a trailing `.0`, e.g. `"4.4.stable..."`).
 * Returns `null` when the string does not even start with `major.minor`
 * (an unrecognized/garbled `--version` output) - callers treat that as
 * "cannot confirm the requirement is met" rather than guessing.
 */
export function parseGodotVersion(raw: string): GodotVersionParts | null {
  const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(raw.trim());
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: match[3] !== undefined ? Number(match[3]) : 0,
  };
}

/** -1 if `a < b`, 0 if equal, 1 if `a > b`, comparing major, then minor, then patch. */
export function compareGodotVersions(a: GodotVersionParts, b: GodotVersionParts): number {
  if (a.major !== b.major) return a.major < b.major ? -1 : 1;
  if (a.minor !== b.minor) return a.minor < b.minor ? -1 : 1;
  if (a.patch !== b.patch) return a.patch < b.patch ? -1 : 1;
  return 0;
}

/**
 * Guided error for a resolved-but-too-old Godot executable. Distinct from
 * `godotNotFoundError` (no executable at all) and
 * `godotVersionUnparseableError` (an executable whose `--version` output
 * couldn't even be parsed) - each names a different fix.
 */
export function godotVersionTooOldError(
  minGodotVersion: string,
  actualVersion: string,
): ErrorResponse {
  return createErrorResponse({
    message:
      `This tool requires Godot >= ${minGodotVersion}, but the resolved executable reports ` +
      `version "${actualVersion}".`,
    possibleSolutions: [
      `Install Godot ${minGodotVersion} or newer and point GODOT_PATH at it.`,
      "Run get_godot_version to confirm which executable and version is currently resolved.",
    ],
  });
}

/** Guided error when the resolved executable's `--version` output could not be parsed at all. */
export function godotVersionUnparseableError(
  minGodotVersion: string,
  actualVersion: string,
): ErrorResponse {
  return createErrorResponse({
    message:
      `This tool requires Godot >= ${minGodotVersion}, but the resolved executable's version ` +
      `output ("${actualVersion}") could not be parsed, so the requirement cannot be confirmed.`,
    possibleSolutions: [
      "Run get_godot_version to see the raw version string the resolved executable reports.",
      `Confirm GODOT_PATH points at a genuine Godot ${minGodotVersion}+ executable.`,
    ],
  });
}

/** Guided error when running `--version` against the resolved executable itself failed. */
export function godotVersionProbeFailedError(godotPath: string, message: string): ErrorResponse {
  return createErrorResponse({
    message: `Failed to determine the Godot version by running "${godotPath} --version": ${message}`,
    possibleSolutions: [
      "Confirm GODOT_PATH points at a valid, executable Godot 4.x binary.",
      "Try running the executable manually from a terminal to confirm it works.",
    ],
  });
}

export type GodotVersionGateCheck = { kind: "pass" } | { kind: "blocked"; error: ErrorResponse };

/**
 * Enforces a tool's `minGodotVersion` at call time. `registry.ts` is the sole
 * caller (see `registerAll`) - this is the one central gate, not something
 * hand-coded per tool handler.
 */
export interface GodotVersionGate {
  checkMinVersion(minGodotVersion: string): Promise<GodotVersionGateCheck>;
}

const defaultProbeDeps: GodotVersionProbeDeps = {
  loadConfig,
  detectGodotPath,
  execFile: defaultExecFile,
};

/**
 * Builds a version gate with its own lazily-resolved, cached probe: the
 * first `checkMinVersion` call (across every gated tool sharing this gate
 * instance - see `registerAll`) runs `probeGodotVersion` once; every
 * subsequent call, for any `minGodotVersion`, reuses that same result. A
 * successful resolution is cached permanently (never re-probed); a failure
 * (`not-found`/`exec-failed`) is NOT cached, so a later call retries -
 * useful if the environment gets fixed (e.g. GODOT_PATH corrected) without
 * restarting the server. Concurrent calls made before the first probe
 * settles share a single in-flight probe rather than launching one each.
 */
export function createGodotVersionGate(
  deps: GodotVersionProbeDeps = defaultProbeDeps,
): GodotVersionGate {
  let cachedVersion: string | undefined;
  let inFlight: Promise<GodotVersionProbeResult> | undefined;

  async function getProbeResult(): Promise<GodotVersionProbeResult> {
    if (cachedVersion !== undefined) {
      return { kind: "resolved", version: cachedVersion, godotPath: "" };
    }
    if (!inFlight) {
      inFlight = probeGodotVersion(deps).finally(() => {
        inFlight = undefined;
      });
    }
    const result = await inFlight;
    if (result.kind === "resolved") {
      cachedVersion = result.version;
    }
    return result;
  }

  return {
    async checkMinVersion(minGodotVersion: string): Promise<GodotVersionGateCheck> {
      const probeResult = await getProbeResult();

      switch (probeResult.kind) {
        case "not-found":
          return { kind: "blocked", error: godotNotFoundError(probeResult.candidates) };
        case "exec-failed":
          return {
            kind: "blocked",
            error: godotVersionProbeFailedError(probeResult.godotPath, probeResult.message),
          };
        case "resolved": {
          const actual = parseGodotVersion(probeResult.version);
          const min = parseGodotVersion(minGodotVersion);
          if (!actual || !min) {
            return {
              kind: "blocked",
              error: godotVersionUnparseableError(minGodotVersion, probeResult.version),
            };
          }
          if (compareGodotVersions(actual, min) < 0) {
            return {
              kind: "blocked",
              error: godotVersionTooOldError(minGodotVersion, probeResult.version),
            };
          }
          return { kind: "pass" };
        }
      }
    },
  };
}
