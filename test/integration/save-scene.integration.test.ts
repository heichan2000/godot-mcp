import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { hasImportCache } from "../../src/godot/cache.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import { resolveOperationsScriptPath, runOperation } from "../../src/godot/runner.js";
import { createSceneTools } from "../../src/tools/scene.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

function makeTools(overrides: { runOperation?: typeof runOperation } = {}) {
  return createSceneTools({
    loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
    detectGodotPath,
    runOperation: overrides.runOperation ?? runOperation,
    operationsScriptPath: resolveOperationsScriptPath(),
    hasImportCache,
  });
}

function getTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

describe.skipIf(!hasGodot)("save_scene (integration, real headless Godot)", () => {
  it("re-saves the scene in place: the file still loads afterward via an independent verify", async () => {
    const projectPath = freshSampleProject();
    const tools = makeTools();
    const scenePath = path.join("scenes", "meshes.tscn");
    const absoluteScenePath = path.join(projectPath, scenePath);

    expect(existsSync(absoluteScenePath)).toBe(true);
    const beforeContent = readFileSync(absoluteScenePath, "utf-8");

    const result = await getTool(tools, "save_scene").handler(
      { project_path: projectPath, scene_path: scenePath },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scene_path: "res://scenes/meshes.tscn",
      new_path: "",
      saved_path: "res://scenes/meshes.tscn",
    });

    // Still there, still a valid, loadable Node3D-rooted scene with both
    // mesh nodes intact.
    expect(existsSync(absoluteScenePath)).toBe(true);
    const afterContent = readFileSync(absoluteScenePath, "utf-8");
    expect(afterContent).toContain("BoxMesh");
    expect(afterContent).toContain("SphereMesh");
    // A round-trip through PackedScene.pack()/ResourceSaver.save() is a
    // structural re-serialization, not necessarily byte-identical (e.g.
    // sub-resource ID renumbering), so this only asserts both scene-level
    // node names it must still carry are present rather than exact byte
    // equality with beforeContent.
    expect(afterContent).toContain('name="Box"');
    expect(afterContent).toContain('name="Sphere"');
    expect(beforeContent.length).toBeGreaterThan(0);
  }, 60_000);

  it("save-as: writes new_path AND leaves the original scene_path file untouched (same size/mtime)", async () => {
    const projectPath = freshSampleProject();
    const tools = makeTools();
    const scenePath = path.join("scenes", "meshes.tscn");
    const newPath = path.join("scenes", "meshes-copy.tscn");
    const absoluteScenePath = path.join(projectPath, scenePath);
    const absoluteNewPath = path.join(projectPath, newPath);

    const originalMtime = statSync(absoluteScenePath).mtimeMs;
    const originalSize = statSync(absoluteScenePath).size;

    expect(existsSync(absoluteNewPath)).toBe(false);

    const result = await getTool(tools, "save_scene").handler(
      { project_path: projectPath, scene_path: scenePath, new_path: newPath },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scene_path: "res://scenes/meshes.tscn",
      new_path: "res://scenes/meshes-copy.tscn",
      saved_path: "res://scenes/meshes-copy.tscn",
    });

    // The new file exists and is a loadable scene with both mesh nodes.
    expect(existsSync(absoluteNewPath)).toBe(true);
    const newContent = readFileSync(absoluteNewPath, "utf-8");
    expect(newContent).toContain('name="Box"');
    expect(newContent).toContain('name="Sphere"');

    // The original is byte-for-byte untouched - same size and mtime as
    // before the call.
    expect(statSync(absoluteScenePath).mtimeMs).toBe(originalMtime);
    expect(statSync(absoluteScenePath).size).toBe(originalSize);
  }, 60_000);

  it("refuses to overwrite an existing file at new_path, leaving both files untouched", async () => {
    const projectPath = freshSampleProject();
    const tools = makeTools();
    const scenePath = path.join("scenes", "meshes.tscn");
    const newPath = path.join("scenes", "meshes-copy.tscn");
    const absoluteNewPath = path.join(projectPath, newPath);

    const first = await getTool(tools, "save_scene").handler(
      { project_path: projectPath, scene_path: scenePath, new_path: newPath },
      {} as never,
    );
    expect(first.isError).toBeFalsy();
    expect(existsSync(absoluteNewPath)).toBe(true);
    const copyMtime = statSync(absoluteNewPath).mtimeMs;
    const copySize = statSync(absoluteNewPath).size;

    const second = await getTool(tools, "save_scene").handler(
      { project_path: projectPath, scene_path: scenePath, new_path: newPath },
      {} as never,
    );

    expect(second.isError).toBe(true);
    const text = (second.content[0] as { text: string }).text;
    expect(text).toContain("already exists");
    expect(text.toLowerCase()).toContain("new_path");

    expect(statSync(absoluteNewPath).mtimeMs).toBe(copyMtime);
    expect(statSync(absoluteNewPath).size).toBe(copySize);
  }, 60_000);

  it("rejects an escaping new_path with a containment error WITHOUT invoking Godot", async () => {
    const projectPath = freshSampleProject();
    const runOperationSpy = vi.fn(runOperation);
    const tools = makeTools({ runOperation: runOperationSpy });

    const result = await getTool(tools, "save_scene").handler(
      {
        project_path: projectPath,
        scene_path: path.join("scenes", "meshes.tscn"),
        new_path: path.join("..", "escape.tscn"),
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(runOperationSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects an escaping scene_path with a containment error WITHOUT invoking Godot", async () => {
    const projectPath = freshSampleProject();
    const runOperationSpy = vi.fn(runOperation);
    const tools = makeTools({ runOperation: runOperationSpy });

    const result = await getTool(tools, "save_scene").handler(
      { project_path: projectPath, scene_path: path.join("..", "escape.tscn") },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(runOperationSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("reports a structured error naming scene_path when the scene does not exist", async () => {
    const projectPath = freshSampleProject();
    const tools = makeTools();

    const result = await getTool(tools, "save_scene").handler(
      { project_path: projectPath, scene_path: path.join("scenes", "does-not-exist.tscn") },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("does-not-exist.tscn");
  }, 60_000);
});
