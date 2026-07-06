import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createOnboardingTools } from "../../src/tools/onboarding.js";

const SERVER_VERSION = "2.0.0-alpha.0";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-onboarding-unit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function tool(name: string) {
  const tools = createOnboardingTools({
    serverVersion: SERVER_VERSION,
    bundledAddonDir: tempDir(),
  });
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

async function callCreate(args: Record<string, unknown>): Promise<ToolResult> {
  return (await tool("create_project").handler(args, {} as never)) as ToolResult;
}

describe("create_project", () => {
  it("scaffolds a valid project into a not-yet-existing folder", async () => {
    const projectDir = path.join(tempDir(), "new-game");
    const result = await callCreate({
      project_path: projectDir,
      project_name: "My Game",
      godot_version: "4.5",
    });

    expect(result.isError).toBeUndefined();
    expect(existsSync(path.join(projectDir, "project.godot"))).toBe(true);
    expect(existsSync(path.join(projectDir, "icon.svg"))).toBe(true);
    expect(existsSync(path.join(projectDir, "scenes", "main.tscn"))).toBe(true);
    expect(existsSync(path.join(projectDir, "scripts"))).toBe(true);
    expect(existsSync(path.join(projectDir, "assets"))).toBe(true);

    const projectGodot = readFileSync(path.join(projectDir, "project.godot"), "utf8");
    expect(projectGodot).toContain('config/name="My Game"');
    expect(projectGodot).toContain('PackedStringArray("4.5", "Forward Plus")');
    expect(projectGodot).toContain('run/main_scene="res://scenes/main.tscn"');

    const mainScene = readFileSync(path.join(projectDir, "scenes", "main.tscn"), "utf8");
    expect(mainScene).toContain('[node name="Main" type="Node2D"]');

    expect(result.structuredContent).toMatchObject({
      project_path: projectDir,
      project_name: "My Game",
      main_scene: "res://scenes/main.tscn",
    });
  });

  it("defaults project_name to the folder name and godot_version to the floor", async () => {
    const projectDir = path.join(tempDir(), "platformer");
    const result = await callCreate({ project_path: projectDir });
    expect(result.isError).toBeUndefined();
    const projectGodot = readFileSync(path.join(projectDir, "project.godot"), "utf8");
    expect(projectGodot).toContain('config/name="platformer"');
    expect(projectGodot).toContain('PackedStringArray("4.4", "Forward Plus")');
  });

  it("rejects a non-empty target with its own guidance, not the no-editor error", async () => {
    const projectDir = tempDir();
    writeFileSync(path.join(projectDir, "existing.txt"), "hi", "utf8");
    const result = await callCreate({ project_path: projectDir });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("not empty");
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("install_addon");
    // Bootstrap exception: never the no-editor pointer.
    expect(result.content[0]!.text).not.toContain("@cradial/godot-mcp@1.x");
  });

  it("rejects a relative project_path", async () => {
    const result = await callCreate({ project_path: "relative/path" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("absolute");
  });
});
