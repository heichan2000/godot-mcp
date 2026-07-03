import { copyFileSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import { runCheckOnly } from "../../src/godot/runner.js";
import { createReadbackTools } from "../../src/tools/readback.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

function makeTools(overrides: { runCheckOnly?: typeof runCheckOnly } = {}) {
  return createReadbackTools({
    loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
    detectGodotPath,
    runCheckOnly: overrides.runCheckOnly ?? runCheckOnly,
    fileExists: existsSync,
    readFile: (candidate) => readFileSync(candidate, "utf-8"),
  });
}

function getTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

/**
 * Copies the deliberately-broken script/scene fixtures (test/integration/
 * fixtures/broken_script.gd, broken_scene.tscn) into a fresh sample-project
 * tempdir copy. These fixtures are NOT committed inside examples/
 * sample-project itself - other integration tests (project-discovery,
 * run_project, uid-tools, ...) operate against the whole sample project,
 * including a real `--import` and, for run_project, an actual scene run, and
 * a broken script sitting in scripts/ risks noisy/failing side effects on
 * tests that have nothing to do with get_script_errors. Materializing the
 * fixture only inside this test's own ephemeral tempdir copy keeps that
 * blast radius at zero.
 */
function addBrokenScriptFixture(projectPath: string): void {
  copyFileSync(
    path.join(FIXTURES_DIR, "broken_script.gd"),
    path.join(projectPath, "scripts", "broken.gd"),
  );
}

function addBrokenSceneFixture(projectPath: string): void {
  addBrokenScriptFixture(projectPath);
  copyFileSync(
    path.join(FIXTURES_DIR, "broken_scene.tscn"),
    path.join(projectPath, "scenes", "broken_scene.tscn"),
  );
}

describe.skipIf(!hasGodot)("get_script_errors (integration, real headless Godot)", () => {
  describe("script_path mode", () => {
    it("a deliberately broken script fixture yields >=1 structured entry pinned to its KNOWN error position (not just nonempty) - this assertion runs on every Godot version in the CI matrix, so a stderr format change fails CI instead of silently returning []", async () => {
      const projectPath = freshSampleProject();
      addBrokenScriptFixture(projectPath);
      const tools = makeTools();

      const result = await getTool(tools, "get_script_errors").handler(
        { project_path: projectPath, script_path: path.join("scripts", "broken.gd") },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        errors: Array<{ file: string; line: number; message: string }>;
        raw: string;
      };

      // Independent evidence, not just "nonempty": the fixture's bug is a
      // known, deliberate one (an assignment with no right-hand-side
      // expression on line 4 of broken_script.gd) - assert the parsed entry
      // actually matches that known position and message shape, not merely
      // that *something* was returned.
      expect(structured.errors.length).toBeGreaterThanOrEqual(1);
      const firstError = structured.errors[0]!;
      expect(firstError.file).toBe("res://scripts/broken.gd");
      expect(firstError.line).toBe(4);
      expect(firstError.message.toLowerCase()).toContain("parse error");

      // raw always carries the full stderr, unconditionally on every Godot
      // version this test runs against.
      expect(structured.raw).toContain("SCRIPT ERROR");
      expect(structured.raw).toContain("res://scripts/broken.gd:4");
    }, 60_000);

    it("a valid script (the sample project's own print_marker.gd) returns errors: [] with a successful (empty) raw", async () => {
      const projectPath = freshSampleProject();
      const tools = makeTools();

      const result = await getTool(tools, "get_script_errors").handler(
        { project_path: projectPath, script_path: path.join("scripts", "print_marker.gd") },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ errors: [], raw: "" });
    }, 60_000);

    it("reports a structured error naming script_path when the script does not exist, without invoking Godot", async () => {
      const projectPath = freshSampleProject();
      const runCheckOnlySpy = vi.fn(runCheckOnly);
      const tools = makeTools({ runCheckOnly: runCheckOnlySpy });

      const result = await getTool(tools, "get_script_errors").handler(
        { project_path: projectPath, script_path: path.join("scripts", "does-not-exist.gd") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("does-not-exist.gd");
      expect(runCheckOnlySpy).not.toHaveBeenCalled();
    }, 30_000);

    it("rejects an escaping script_path with a containment error WITHOUT invoking Godot", async () => {
      const projectPath = freshSampleProject();
      const runCheckOnlySpy = vi.fn(runCheckOnly);
      const tools = makeTools({ runCheckOnly: runCheckOnlySpy });

      const result = await getTool(tools, "get_script_errors").handler(
        { project_path: projectPath, script_path: path.join("..", "escape.gd") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(runCheckOnlySpy).not.toHaveBeenCalled();
    }, 30_000);
  });

  describe("scene_path mode", () => {
    it("resolves and checks the broken script a scene references, yielding >=1 structured entry pinned to its KNOWN error position", async () => {
      const projectPath = freshSampleProject();
      addBrokenSceneFixture(projectPath);
      const tools = makeTools();

      const result = await getTool(tools, "get_script_errors").handler(
        { project_path: projectPath, scene_path: path.join("scenes", "broken_scene.tscn") },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        errors: Array<{ file: string; line: number; message: string }>;
        raw: string;
      };
      expect(structured.errors.length).toBeGreaterThanOrEqual(1);
      expect(structured.errors[0]).toEqual({
        file: "res://scripts/broken.gd",
        line: 4,
        message: 'Parse Error: Expected expression for variable initial value after "=".',
      });
      expect(structured.raw).toContain("SCRIPT ERROR");
    }, 60_000);

    it("a scene referencing only a valid script (print_marker.tscn) returns errors: []", async () => {
      const projectPath = freshSampleProject();
      const tools = makeTools();

      const result = await getTool(tools, "get_script_errors").handler(
        { project_path: projectPath, scene_path: path.join("scenes", "print_marker.tscn") },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ errors: [], raw: "" });
    }, 60_000);

    it("a scene with no script references at all (meshes.tscn) returns errors: [] WITHOUT invoking Godot", async () => {
      const projectPath = freshSampleProject();
      const runCheckOnlySpy = vi.fn(runCheckOnly);
      const tools = makeTools({ runCheckOnly: runCheckOnlySpy });

      const result = await getTool(tools, "get_script_errors").handler(
        { project_path: projectPath, scene_path: path.join("scenes", "meshes.tscn") },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ errors: [], raw: "" });
      expect(runCheckOnlySpy).not.toHaveBeenCalled();
    }, 30_000);

    it("reports a structured error naming scene_path when the scene does not exist", async () => {
      const projectPath = freshSampleProject();
      const tools = makeTools();

      const result = await getTool(tools, "get_script_errors").handler(
        { project_path: projectPath, scene_path: path.join("scenes", "does-not-exist.tscn") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("does-not-exist.tscn");
    }, 30_000);
  });

  it("rejects a call with neither scene_path nor script_path, without invoking Godot", async () => {
    const projectPath = freshSampleProject();
    const runCheckOnlySpy = vi.fn(runCheckOnly);
    const tools = makeTools({ runCheckOnly: runCheckOnlySpy });

    const result = await getTool(tools, "get_script_errors").handler(
      { project_path: projectPath },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(runCheckOnlySpy).not.toHaveBeenCalled();
  }, 30_000);
});
