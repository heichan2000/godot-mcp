import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createOnboardingTools } from "../../src/tools/onboarding.js";
import { SERVER_VERSION, resolveBundledAddonDir } from "../../src/server.js";
import {
  godotMinorTag,
  hasGodot,
  importProjectCaptured,
  probeGodotVersionString,
} from "./support.js";

function onboardingTool(name: string) {
  const tools = createOnboardingTools({
    serverVersion: SERVER_VERSION,
    bundledAddonDir: resolveBundledAddonDir(),
  });
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

describe.runIf(hasGodot)("create_project scaffold imports clean (REQ-B-01)", () => {
  it("a scaffolded project imports with no errors or warnings", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "godot-mcp-scaffold-"));
    try {
      const projectDir = path.join(workspace, "fresh-game");
      const minor = godotMinorTag(await probeGodotVersionString());
      const result = (await onboardingTool("create_project").handler(
        { project_path: projectDir, godot_version: minor },
        {} as never,
      )) as { isError?: boolean };
      expect(result.isError).toBeFalsy();

      const output = await importProjectCaptured(projectDir);
      // The acceptance criterion: zero errors or import warnings. Godot prints
      // "ERROR:", "WARNING:", or "SCRIPT ERROR:" for anything wrong; a clean
      // minimal project emits none. A hit here is a real REQ-B-01 regression -
      // fix the scaffold, not this assertion.
      expect(output).not.toMatch(/SCRIPT ERROR|ERROR:|WARNING:/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});
