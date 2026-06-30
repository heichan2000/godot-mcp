/**
 * Godot binary resolution + filesystem containment.
 *
 * Resolution order (strict, no silent fallback): config → GODOT_PATH →
 * autodetect. On failure, callers surface a structured guided error with
 * candidate paths + how to set GODOT_PATH.
 *
 * Containment: assertInsideRoot resolves `candidate` against `root` and
 * rejects absolute inputs, `..` traversal, and symlinks that escape the
 * root (realpath check). Enforced here in TS and re-checked in operations.gd.
 */
import { resolve, sep } from "node:path";

export class PathContainmentError extends Error {}

export class GodotNotFoundError extends Error {
  constructor(
    message: string,
    readonly candidates: string[] = [],
  ) {
    super(message);
  }
}

/**
 * Resolve `candidate` (project-relative) against `root` and assert the result
 * stays inside `root`. Returns the absolute, contained path.
 *
 * TODO(M2): add realpath/symlink-escape check.
 */
export function assertInsideRoot(root: string, candidate: string): string {
  const absRoot = resolve(root);
  const resolved = resolve(absRoot, candidate);
  if (resolved !== absRoot && !resolved.startsWith(absRoot + sep)) {
    throw new PathContainmentError(
      `path "${candidate}" escapes project root "${root}"`,
    );
  }
  return resolved;
}

/**
 * Resolve the Godot binary. Throws GodotNotFoundError with candidates on
 * failure (no silent hardcoded fallback).
 *
 * TODO(M1): implement config → GODOT_PATH → autodetect with --version probe.
 */
export async function detectGodotPath(
  _explicit?: string,
): Promise<string> {
  throw new GodotNotFoundError("Godot path resolution not yet implemented (M1)");
}
