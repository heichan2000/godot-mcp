import { execFile as execFileCb } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import {
  DISPATCHER_VERSION,
  resolveOperationsScriptPath,
  runOperation,
} from "../../src/godot/runner.js";
import { createSceneTools } from "../../src/tools/scene.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

const VERIFY_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "verify_scene_loads.gd",
);

function execFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFileCb(file, args, (_error, stdout, stderr) => {
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

interface VerifyResult {
  ok: boolean;
  root_class: string;
}

/** Round-trips a scene through a real Godot `load()` call, independent of operations.gd. */
async function loadScene(projectPath: string, resScenePath: string): Promise<VerifyResult> {
  const { stdout } = await execFile(godotPath!, [
    "--headless",
    "--path",
    projectPath,
    "--script",
    VERIFY_SCRIPT,
    "--",
    resScenePath,
  ]);
  const marker = "GODOT_MCP_VERIFY:";
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith(marker));
  if (!line) {
    throw new Error(`No ${marker} marker found in verify script stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(marker.length)) as VerifyResult;
}

function makeTools(overrides: { runOperation?: typeof runOperation } = {}) {
  return createSceneTools({
    loadConfig: (): Config => ({ godotPath, debug: false }),
    detectGodotPath,
    runOperation: overrides.runOperation ?? runOperation,
    operationsScriptPath: resolveOperationsScriptPath(),
  });
}

function getCreateSceneTool(tools: ReturnType<typeof makeTools>) {
  const tool = tools.find((t) => t.name === "create_scene");
  if (!tool) throw new Error("create_scene descriptor not found");
  return tool;
}

describe.skipIf(!hasGodot)("create_scene (integration, real headless Godot)", () => {
  it("writes a .tscn that Godot can load, applying the default root node type (Node2D) when omitted", async () => {
    const projectPath = freshSampleProject();
    const tool = getCreateSceneTool(makeTools());

    const result = await tool.handler(
      { project_path: projectPath, scene_path: "scenes/hero.tscn" },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    expect(existsSync(path.join(projectPath, "scenes", "hero.tscn"))).toBe(true);

    const loaded = await loadScene(projectPath, "res://scenes/hero.tscn");
    expect(loaded.ok).toBe(true);
    expect(loaded.root_class).toBe("Node2D");
  });

  it("creates parent directories as needed and honors an explicit root_node_type", async () => {
    const projectPath = freshSampleProject();
    const tool = getCreateSceneTool(makeTools());

    const result = await tool.handler(
      {
        project_path: projectPath,
        scene_path: path.join("scenes", "deeply", "nested", "world.tscn"),
        root_node_type: "Node3D",
      },
      {} as never,
    );

    expect(result.isError).toBeFalsy();

    const loaded = await loadScene(projectPath, "res://scenes/deeply/nested/world.tscn");
    expect(loaded.ok).toBe(true);
    expect(loaded.root_class).toBe("Node3D");
  });

  it("rejects an escaping scene_path with a containment error WITHOUT invoking Godot", async () => {
    const projectPath = freshSampleProject();
    const runOperationSpy = vi.fn(runOperation);
    const tool = getCreateSceneTool(makeTools({ runOperation: runOperationSpy }));

    const result = await tool.handler(
      { project_path: projectPath, scene_path: path.join("..", "escape.tscn") },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(runOperationSpy).not.toHaveBeenCalled();
  });

  it("refuses to overwrite an existing scene: the second create_scene call for the same path fails and the original file is untouched", async () => {
    const projectPath = freshSampleProject();
    const tool = getCreateSceneTool(makeTools());
    const scenePath = path.join("scenes", "hero.tscn");
    const absoluteScenePath = path.join(projectPath, scenePath);

    const first = await tool.handler(
      { project_path: projectPath, scene_path: scenePath, root_node_type: "Node2D" },
      {} as never,
    );
    expect(first.isError).toBeFalsy();
    expect(existsSync(absoluteScenePath)).toBe(true);
    const originalMtime = statSync(absoluteScenePath).mtimeMs;
    const originalSize = statSync(absoluteScenePath).size;

    const second = await tool.handler(
      { project_path: projectPath, scene_path: scenePath, root_node_type: "Node3D" },
      {} as never,
    );

    expect(second.isError).toBe(true);
    const text = (second.content[0] as { text: string }).text;
    expect(text).toContain("already exists");

    // The original file must be untouched - same size and modification time,
    // and still loadable as the original root node type (not overwritten
    // with Node3D from the second, rejected call).
    expect(statSync(absoluteScenePath).mtimeMs).toBe(originalMtime);
    expect(statSync(absoluteScenePath).size).toBe(originalSize);
    const loaded = await loadScene(projectPath, "res://scenes/hero.tscn");
    expect(loaded.ok).toBe(true);
    expect(loaded.root_class).toBe("Node2D");
  });

  it("produces a structured version-mismatch error naming both versions when the runner's expected version differs from the dispatcher's", async () => {
    const projectPath = freshSampleProject();
    const bogusExpectedVersion = DISPATCHER_VERSION + 12345;

    const result = await runOperation({
      godotPath: godotPath!,
      projectPath,
      operationScriptPath: resolveOperationsScriptPath(),
      operation: "create_scene",
      params: { scene_path: "scenes/mismatch.tscn" },
      expectedVersion: bogusExpectedVersion,
    });

    expect(result).toEqual({
      kind: "version-mismatch",
      expectedVersion: bogusExpectedVersion,
      actualVersion: DISPATCHER_VERSION,
    });
  });
});
