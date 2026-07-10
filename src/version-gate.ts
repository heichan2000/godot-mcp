import type { GodotVersion } from "./bridge/protocol.js";
import { createErrorResponse, type ErrorResponse } from "./errors.js";

/** A parsed `minGodotVersion` descriptor literal ("major.minor"). */
export interface MinGodotVersion {
  major: number;
  minor: number;
}

/**
 * Where the gate reads the connected engine's version: the bridge handshake
 * (REQ-A-02). Returns undefined while no editor is connected - the gate then
 * steps aside so the handler's own bridge call produces the standard
 * structured "editor not connected" error (REQ-A-10) instead of a misleading
 * version verdict about an engine nobody has seen.
 */
export type EngineVersionSource = () => GodotVersion | undefined;

const MIN_VERSION_PATTERN = /^(\d+)\.(\d+)$/;

/**
 * Parses a descriptor's `minGodotVersion` literal, e.g. "4.4". Throws on any
 * other shape: descriptors are static data, so a malformed literal is a
 * programming error surfaced at registration time, never a runtime condition.
 */
export function parseMinGodotVersion(spec: string): MinGodotVersion {
  const match = MIN_VERSION_PATTERN.exec(spec.trim());
  if (!match) {
    throw new Error(`Invalid minGodotVersion "${spec}": expected "<major>.<minor>", e.g. "4.4".`);
  }
  return { major: Number(match[1]), minor: Number(match[2]) };
}

/**
 * True when the handshake-reported engine satisfies the floor. Patch is
 * deliberately ignored - the support policy and every 1.0 gate are expressed
 * in minors (REQ-A-07's "requires >= x.y").
 */
export function meetsMinVersion(min: MinGodotVersion, actual: GodotVersion): boolean {
  if (actual.major !== min.major) return actual.major > min.major;
  return actual.minor >= min.minor;
}

/**
 * The structured "requires >= x.y" error (REQ-A-07): names the tool, the
 * requirement, and the engine version the handshake reported.
 */
export function versionGateError(
  toolName: string,
  spec: string,
  actual: GodotVersion,
): ErrorResponse {
  const reported = `${actual.major}.${actual.minor}.${actual.patch}.${actual.status}`;
  return createErrorResponse({
    message:
      `${toolName} requires Godot >= ${spec}, but the connected editor reports ` +
      `Godot ${reported}.`,
    possibleSolutions: [
      `Open this project in Godot ${spec} or newer, then retry.`,
      "Run get_godot_version to confirm which engine version the editor handshake reported.",
    ],
  });
}
