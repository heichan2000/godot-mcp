import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../src/config.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import {
  compareGodotVersions,
  defaultExecFile,
  parseGodotVersion,
  probeGodotVersion,
} from "../../src/godot/version-gate.js";
import { MIN_UID_GODOT_VERSION } from "../../src/tools/uid.js";

/**
 * Emits a loud, greppable warning when integration coverage is skipped
 * because GODOT_PATH isn't set (or doesn't point at a real binary) on this
 * machine, rather than silently reporting green with zero tests run. Mirrors
 * test/unit/path-containment.test.ts's warnSkippedCoverage.
 */
export function warnSkippedCoverage(caseName: string, reason: string): void {
  console.warn(`[coverage] SKIPPED mandated case "${caseName}": ${reason}`);
}

export const SAMPLE_PROJECT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "sample-project",
);

export const godotPath = process.env.GODOT_PATH?.trim();
export const hasGodot = Boolean(godotPath && existsSync(godotPath));

if (!hasGodot) {
  warnSkippedCoverage(
    "all test/integration/* cases",
    "GODOT_PATH is unset or does not point at an existing file - integration tests require a " +
      "real headless Godot 4.x binary. Set GODOT_PATH (e.g. to a downloaded Godot_v4.x-stable " +
      "executable) and re-run `npm run test:integration` to exercise this coverage.",
  );
}

/**
 * Copies examples/sample-project into a fresh temp directory so integration
 * tests never mutate (or leave generated scenes/import caches inside) the
 * committed fixture.
 */
export function freshSampleProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-sample-project-"));
  cpSync(SAMPLE_PROJECT_DIR, dir, { recursive: true });
  return dir;
}

/**
 * Probes GODOT_PATH's actual Godot version ONCE (via top-level await - safe
 * here since this module is ESM and only ever imported by test files that
 * already gate everything else on `hasGodot`), so every integration test
 * that needs to branch on "is this CI leg's Godot < 4.4" (Resource UIDs,
 * gated by tools/uid.ts's MIN_UID_GODOT_VERSION, only exist from 4.4
 * onward) can import a single already-resolved answer instead of each
 * re-probing its own copy.
 *
 * This exists because the CI matrix (godot-prd.md §9, Task 12's review
 * carried into Task 13) deliberately runs integration on one Godot version
 * below 4.4 and one at/above it, specifically so both halves of
 * UID-dependent behavior - the version-gate REJECTION path, and
 * list_resources' "uid gracefully absent" path - get exercised by a real CI
 * leg rather than only ever simulated with a fake version.
 */
export const godotVersionInfo: { version: string; isBelowUidMinVersion: boolean } | null = hasGodot
  ? await (async () => {
      const probe = await probeGodotVersion({
        loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
        detectGodotPath,
        execFile: defaultExecFile,
      });
      if (probe.kind !== "resolved") {
        throw new Error(
          `Could not probe GODOT_PATH's version for version-aware integration tests: ${JSON.stringify(probe)}`,
        );
      }
      const actual = parseGodotVersion(probe.version);
      const min = parseGodotVersion(MIN_UID_GODOT_VERSION);
      if (!actual || !min) {
        throw new Error(
          `Could not parse the probed/min version: "${probe.version}" / "${MIN_UID_GODOT_VERSION}"`,
        );
      }
      return {
        version: probe.version,
        isBelowUidMinVersion: compareGodotVersions(actual, min) < 0,
      };
    })()
  : null;
