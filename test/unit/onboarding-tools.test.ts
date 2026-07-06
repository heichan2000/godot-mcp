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

/** Builds a fake bundled-addon source dir with a plugin.cfg carrying `version`. */
function fakeBundledAddon(version: string): string {
  const dir = tempDir();
  writeFileSync(
    path.join(dir, "plugin.cfg"),
    `[plugin]\nname="Godot MCP"\nversion="${version}"\nscript="plugin.gd"\n`,
    "utf8",
  );
  writeFileSync(path.join(dir, "plugin.gd"), "@tool\nextends EditorPlugin\n", "utf8");
  return dir;
}

/** A minimal existing Godot project directory (has project.godot). */
function fakeProject(): string {
  const dir = tempDir();
  writeFileSync(path.join(dir, "project.godot"), "config_version=5\n", "utf8");
  return dir;
}

async function callInstall(
  bundledAddonDir: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tools = createOnboardingTools({ serverVersion: SERVER_VERSION, bundledAddonDir });
  const found = tools.find((candidate) => candidate.name === "install_addon");
  if (!found) throw new Error("tool not registered: install_addon");
  return (await found.handler(args, {} as never)) as ToolResult;
}

describe("install_addon", () => {
  it("installs the addon into a project and reports enable steps", async () => {
    const bundled = fakeBundledAddon(SERVER_VERSION);
    const projectDir = fakeProject();
    const result = await callInstall(bundled, { project_path: projectDir });

    expect(result.isError).toBeUndefined();
    expect(existsSync(path.join(projectDir, "addons", "godot_mcp", "plugin.cfg"))).toBe(true);
    expect(result.structuredContent).toMatchObject({
      action: "installed",
      installed_version: SERVER_VERSION,
      previous_version: null,
      addon_path: "res://addons/godot_mcp",
    });
    const steps = (result.structuredContent as { enable_steps: string[] }).enable_steps;
    expect(steps.join(" ")).toContain("Plugins");
  });

  it("updates an already-installed addon and reports the previous version", async () => {
    const projectDir = fakeProject();
    await callInstall(fakeBundledAddon("2.0.0-alpha.0"), { project_path: projectDir });
    const result = await callInstall(fakeBundledAddon("2.0.0-alpha.1"), {
      project_path: projectDir,
    });

    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      action: "updated",
      installed_version: "2.0.0-alpha.1",
      previous_version: "2.0.0-alpha.0",
    });
    const cfg = readFileSync(path.join(projectDir, "addons", "godot_mcp", "plugin.cfg"), "utf8");
    expect(cfg).toContain('version="2.0.0-alpha.1"');
  });

  it("rejects a folder that is not a Godot project", async () => {
    const notAProject = tempDir();
    const result = await callInstall(fakeBundledAddon(SERVER_VERSION), {
      project_path: notAProject,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("project.godot");
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("create_project");
    expect(result.content[0]!.text).not.toContain("@cradial/godot-mcp@1.x");
  });

  it("rejects a relative project_path", async () => {
    const result = await callInstall(fakeBundledAddon(SERVER_VERSION), {
      project_path: "rel/proj",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("absolute");
  });
});
