import { existsSync, realpathSync as realpathSyncFs } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createErrorResponse, type ErrorResponse } from "../errors.js";

export interface DetectGodotPathOptions {
  /** Explicit path from config/env (see config.ts's GODOT_PATH). */
  configuredPath?: string;
  /** Defaults to the running process's platform; overridable for tests. */
  platform?: NodeJS.Platform;
  /** Defaults to a real filesystem check; overridable for tests. */
  fileExists?: (candidate: string) => boolean;
}

export type GodotPathResolution =
  | { found: true; path: string; source: "configured" | "autodetect" }
  | { found: false; candidates: string[] };

/**
 * Common Godot 4 executable install locations per platform, used only when
 * no explicit path was configured. Not exhaustive - just the well-known spots.
 */
export function getCandidatePaths(platform: NodeJS.Platform): string[] {
  const home = homedir();

  switch (platform) {
    case "win32": {
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
      const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
      return [
        path.join(programFiles, "Godot", "Godot.exe"),
        path.join(programFilesX86, "Godot", "Godot.exe"),
        path.join(localAppData, "Godot", "Godot.exe"),
        path.join(programFilesX86, "Steam", "steamapps", "common", "Godot Engine", "godot.exe"),
      ];
    }
    case "darwin":
      return [
        "/Applications/Godot.app/Contents/MacOS/Godot",
        path.join(home, "Applications", "Godot.app", "Contents", "MacOS", "Godot"),
        "/opt/homebrew/bin/godot",
        "/usr/local/bin/godot",
      ];
    default:
      return [
        "/usr/bin/godot",
        "/usr/local/bin/godot",
        "/snap/bin/godot",
        path.join(home, ".local", "bin", "godot"),
        "/var/lib/flatpak/exports/bin/org.godotengine.Godot",
      ];
  }
}

/**
 * Resolves the Godot executable using the strict chain: an explicitly
 * configured path (config → GODOT_PATH env, already merged by config.ts),
 * then platform autodetection. Never silently substitutes a hardcoded
 * fallback - an invalid configured path fails with guidance instead of
 * falling through to autodetect.
 */
export function detectGodotPath(options: DetectGodotPathOptions = {}): GodotPathResolution {
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;

  if (options.configuredPath) {
    const configuredPath = options.configuredPath;
    if (fileExists(configuredPath)) {
      return { found: true, path: configuredPath, source: "configured" };
    }
    return { found: false, candidates: [configuredPath] };
  }

  const candidates = getCandidatePaths(platform);
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return { found: true, path: candidate, source: "autodetect" };
    }
  }
  return { found: false, candidates };
}

export type PathContainmentReason = "absolute" | "root-not-found" | "outside-root";

/**
 * Thrown by `assertInsideRoot` when a candidate path fails containment.
 * Callers convert this to an MCP error result via `pathContainmentErrorResponse`.
 */
export class PathContainmentError extends Error {
  readonly reason: PathContainmentReason;
  readonly root: string;
  readonly candidate: string;

  constructor(reason: PathContainmentReason, root: string, candidate: string, message: string) {
    super(message);
    this.name = "PathContainmentError";
    this.reason = reason;
    this.root = root;
    this.candidate = candidate;
  }
}

export interface AssertInsideRootOptions {
  /**
   * Defaults to `fs.realpathSync.native` (the OS-backed variant); overridable
   * for tests (e.g. simulating a UNC namespace). The pure-JS `fs.realpathSync`
   * only resolves symlinks - it leaves drive-letter casing and 8.3 short
   * names (`C:\PROGRA~1`) untouched, which would defeat containment on
   * Windows, so it is deliberately not the default here.
   */
  realpathSync?: (candidate: string) => string;
}

/**
 * Resolves the deepest *existing* ancestor of `absolutePath` (which itself
 * may not exist yet), realpath's it, then re-appends any not-yet-existing
 * trailing segments untouched. This lets containment checks work for
 * targets that don't exist yet (e.g. a scene about to be created) while
 * still fully resolving symlinks/junctions/short-names on the part of the
 * path that does exist.
 */
function resolveDeepestExisting(
  absolutePath: string,
  realpathSync: (candidate: string) => string,
): string {
  const pendingSegments: string[] = [];
  let current = absolutePath;

  for (;;) {
    try {
      const real = realpathSync(current);
      return pendingSegments.length > 0 ? path.join(real, ...pendingSegments.reverse()) : real;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw error;
      }
      const parent = path.dirname(current);
      if (parent === current) {
        // Walked all the way to the filesystem/drive root without resolving anything.
        throw error;
      }
      pendingSegments.push(path.basename(current));
      current = parent;
    }
  }
}

/**
 * Confines `candidate` (interpreted relative to `root`) inside `root`. This
 * is the project's core security boundary - every path parameter a tool
 * accepts must be checked here before it touches the filesystem.
 *
 * Algorithm (godot-prd.md §7.1): realpath the deepest *existing* ancestor of
 * the candidate (the target itself may not exist yet, e.g. a scene about to
 * be created), reattach any not-yet-existing trailing segments, then
 * require `path.relative(root, resolvedCandidate)` to be non-empty,
 * non-absolute, and not start with `..`. Never a naive `startsWith` prefix
 * check - it breaks under Windows case-insensitivity, 8.3 short names
 * (`C:\PROGRA~1`), and UNC paths, and it would wrongly accept sibling
 * directories that merely share a name prefix (`project` vs
 * `project-evil-twin`).
 *
 * Returns the fully resolved absolute path on success. Throws
 * `PathContainmentError` on any violation.
 */
export function assertInsideRoot(
  root: string,
  candidate: string,
  options: AssertInsideRootOptions = {},
): string {
  const realpathSync = options.realpathSync ?? realpathSyncFs.native;

  if (path.isAbsolute(candidate)) {
    throw new PathContainmentError(
      "absolute",
      root,
      candidate,
      `Path "${candidate}" must be relative to the project root, not absolute.`,
    );
  }

  let resolvedRoot: string;
  try {
    resolvedRoot = realpathSync(path.resolve(root));
  } catch {
    throw new PathContainmentError(
      "root-not-found",
      root,
      candidate,
      `Project root "${root}" does not exist or is not accessible.`,
    );
  }

  const absoluteCandidate = path.resolve(resolvedRoot, candidate);
  const resolvedCandidate = resolveDeepestExisting(absoluteCandidate, realpathSync);

  const relative = path.relative(resolvedRoot, resolvedCandidate);
  const escapesRoot =
    relative === "" ||
    relative === ".." ||
    path.isAbsolute(relative) ||
    relative.startsWith(`..${path.sep}`);

  if (escapesRoot) {
    throw new PathContainmentError(
      "outside-root",
      root,
      candidate,
      `Path "${candidate}" resolves outside the project root "${root}".`,
    );
  }

  return resolvedCandidate;
}

function possibleSolutionsFor(reason: PathContainmentReason): string[] {
  switch (reason) {
    case "absolute":
      return ["Provide a path relative to project_path, not an absolute path."];
    case "root-not-found":
      return ["Confirm project_path points at an existing, accessible directory."];
    case "outside-root":
      return [
        'Remove any ".." segments so the resolved path stays inside project_path.',
        "If the path passes through a symlink or junction, make sure the link target is inside project_path.",
      ];
  }
}

/**
 * Converts a `PathContainmentError` into the standard guided MCP error
 * result (`createErrorResponse`), tailoring `possibleSolutions` to the
 * specific violation.
 */
export function pathContainmentErrorResponse(error: PathContainmentError): ErrorResponse {
  return createErrorResponse({
    message: error.message,
    possibleSolutions: possibleSolutionsFor(error.reason),
  });
}
