import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { hasImportCache } from "../../src/godot/cache.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import {
  resolveOperationsScriptPath,
  runGodotImport,
  runOperation,
} from "../../src/godot/runner.js";
import { registerAll } from "../../src/registry.js";
import { createUidTools, MIN_UID_GODOT_VERSION } from "../../src/tools/uid.js";
import { freshSampleProject, godotPath, godotVersionInfo, hasGodot } from "./support.js";

/**
 * Exercises `registerAll`'s call-time `minGodotVersion` gate (registry.ts /
 * godot/version-gate.ts) against the REAL Godot resolved via GODOT_PATH -
 * not a fake/injected `GodotVersionGate` like test/unit/registry.test.ts
 * uses. Per godot-prd.md §3/§9 and the Task 12 review carried into Task 13:
 * the CI matrix deliberately includes one Godot version < 4.4 specifically
 * so the UID tools' gate REJECTION path (not just the "passes on a new
 * enough Godot" path already covered by uid-tools.integration.test.ts) is
 * exercised by a real CI leg, not merely simulated with a fake gate.
 *
 * Branches on `support.ts`'s `godotVersionInfo` (GODOT_PATH's actual probed
 * version), loudly logging which branch ran - so it stays meaningful (and
 * exercises BOTH halves of the gate across the CI matrix) rather than
 * silently only ever covering whichever branch happens to match the
 * developer's local Godot.
 */
describe.skipIf(!hasGodot)(
  "minGodotVersion call-time gate (integration, real headless Godot, real registerAll wiring)",
  () => {
    it("get_uid: the gate rejects on Godot < 4.4, or passes through to the tool's own logic on Godot >= 4.4", async () => {
      const { version, isBelowUidMinVersion } = godotVersionInfo!;

      const projectPath = freshSampleProject();
      const registerTool = vi.fn();
      registerAll(
        { registerTool },
        createUidTools({
          loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
          detectGodotPath,
          runOperation,
          runGodotImport,
          hasImportCache,
          operationsScriptPath: resolveOperationsScriptPath(),
        }),
      );

      const getUidCall = registerTool.mock.calls.find((call) => call[0] === "get_uid");
      if (!getUidCall) throw new Error("get_uid was not registered by createUidTools/registerAll");
      const getUidHandler = getUidCall[2] as (
        args: Record<string, unknown>,
        extra: unknown,
      ) => Promise<{ isError?: boolean; content: Array<{ type: string; text: string }> }>;

      const result = await getUidHandler(
        { project_path: projectPath, file_path: "scripts/print_marker.gd" },
        {},
      );

      if (isBelowUidMinVersion) {
        console.warn(
          `[version-gate] probed Godot "${version}" is below ${MIN_UID_GODOT_VERSION}: ` +
            "asserting the call-time gate REJECTS get_uid before it ever reaches the dispatcher.",
        );
        expect(result.isError).toBe(true);
        const text = result.content[0]!.text;
        expect(text).toContain(MIN_UID_GODOT_VERSION);
        expect(text.toLowerCase()).toContain("requires godot");
      } else {
        console.warn(
          `[version-gate] probed Godot "${version}" is >= ${MIN_UID_GODOT_VERSION}: ` +
            "asserting the call-time gate PASSES get_uid through (its own success/failure behavior " +
            "beyond the gate is covered by uid-tools.integration.test.ts, not re-asserted here).",
        );
        if (result.isError) {
          const text = result.content[0]!.text;
          expect(text).not.toContain(`requires Godot >= ${MIN_UID_GODOT_VERSION}`);
        }
      }
    }, 60_000);
  },
);
