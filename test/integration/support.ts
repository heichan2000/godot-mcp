import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Emits a loud, greppable warning when integration coverage is skipped
 * because GODOT_PATH isn't set (or doesn't point at a real binary) on this
 * machine, rather than silently reporting green with zero tests run. Mirrors
 * test/unit/path-containment.test.ts's warnSkippedCoverage.
 */
export function warnSkippedCoverage(caseName: string, reason: string): void {
  console.warn(`[coverage] SKIPPED mandated case "${caseName}": ${reason}`);
}

const SAMPLE_PROJECT_DIR = path.join(
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
