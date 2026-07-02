import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createSceneTools } from "../../src/tools/scene.js";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";
import type { runOperation, RunOperationResult } from "../../src/godot/runner.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "godot-mcp-scene-tools-"));
}

function makeDeps(overrides: {
  config?: Partial<Config>;
  resolution?: GodotPathResolution;
  runOperationResult?: RunOperationResult;
  runOperation?: typeof runOperation;
}) {
  const resolution: GodotPathResolution = overrides.resolution ?? {
    found: true,
    path: "/usr/bin/godot",
    source: "configured",
  };
  return {
    loadConfig: vi.fn((): Config => ({ godotPath: undefined, debug: false, ...overrides.config })),
    detectGodotPath: vi.fn(() => resolution),
    runOperation:
      overrides.runOperation ??
      vi.fn(
        async (): Promise<RunOperationResult> =>
          overrides.runOperationResult ?? {
            kind: "success",
            version: 1,
            operation: "create_scene",
            result: { scene_path: "res://scenes/hero.tscn" },
          },
      ),
    operationsScriptPath: "/dist/operations.gd",
  };
}

function getCreateSceneTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createSceneTools(deps);
  const tool = tools.find((t) => t.name === "create_scene");
  if (!tool) throw new Error("create_scene descriptor not found");
  return tool;
}

describe("createSceneTools", () => {
  it("exposes exactly one descriptor named create_scene with project_path/scene_path/root_node_type in its schema", () => {
    const deps = makeDeps({});
    const tools = createSceneTools(deps);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("create_scene");
    expect(Object.keys(tools[0]!.inputSchema).sort()).toEqual(
      ["project_path", "root_node_type", "scene_path"].sort(),
    );
  });

  it("calls runOperation with the exact op/params contract, defaulting root_node_type to Node2D", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getCreateSceneTool(deps);

    await tool.handler({ project_path: root, scene_path: "scenes/hero.tscn" }, {} as never);

    expect(deps.runOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        godotPath: "/usr/bin/godot",
        projectPath: root,
        operationScriptPath: "/dist/operations.gd",
        operation: "create_scene",
        params: { scene_path: "scenes/hero.tscn", root_node_type: "Node2D" },
      }),
    );
  });

  it("passes an explicit root_node_type through untouched", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getCreateSceneTool(deps);

    await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn", root_node_type: "Node3D" },
      {} as never,
    );

    expect(deps.runOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        params: { scene_path: "scenes/hero.tscn", root_node_type: "Node3D" },
      }),
    );
  });

  it("returns success content with the dispatcher's result as structuredContent", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "success",
        version: 1,
        operation: "create_scene",
        result: { scene_path: "res://scenes/hero.tscn", root_node_type: "Node2D" },
      },
    });
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn" },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      scene_path: "res://scenes/hero.tscn",
      root_node_type: "Node2D",
    });
  });

  it("rejects an escaping scene_path with a containment error WITHOUT invoking Godot", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: path.join("..", "escape.tscn") },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.detectGodotPath).not.toHaveBeenCalled();
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("rejects an absolute scene_path with a containment error WITHOUT invoking Godot", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getCreateSceneTool(deps);

    const absolute = path.join(tmpdir(), "elsewhere.tscn");
    const result = await tool.handler({ project_path: root, scene_path: absolute }, {} as never);

    expect(result.isError).toBe(true);
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("returns a structured guided error when Godot cannot be resolved, without invoking runOperation", async () => {
    const root = makeRoot();
    const deps = makeDeps({ resolution: { found: false, candidates: ["/usr/bin/godot"] } });
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("returns a structured error for an operation-error result", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "operation-error",
        version: 1,
        operation: "create_scene",
        error: "root_node_type is not an instantiable Node class: Bogus",
      },
    });
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn", root_node_type: "Bogus" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("Bogus");
  });

  it("returns a structured error naming both versions on a version mismatch", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: { kind: "version-mismatch", expectedVersion: 1, actualVersion: 2 },
    });
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1");
    expect(text).toContain("2");
  });

  it("returns a structured error for a protocol-error result", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "protocol-error",
        message: "no result marker found",
        stdout: "",
        stderr: "",
        exitCode: 1,
      },
    });
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("no result marker found");
  });

  it("returns a structured error for a spawn-error result", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: { kind: "spawn-error", message: "ENOENT" },
    });
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("ENOENT");
  });

  it("returns a guided timeout error naming the timeout duration for a timeout result", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: { kind: "timeout", timeoutMs: 60_000 },
    });
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("60000");
    expect(text.toLowerCase()).toContain("did not respond");
    expect(text.toLowerCase()).toContain("kill");
  });

  it("suggests a different scene_path when the dispatcher reports the scene already exists", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "operation-error",
        version: 1,
        operation: "create_scene",
        error:
          "Scene already exists at res://scenes/hero.tscn. create_scene refuses to overwrite an existing scene.",
      },
    });
    const tool = getCreateSceneTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("already exists");
    expect(text.toLowerCase()).toContain("different scene_path");
  });

  it("never writes to stdout while handling a call", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getCreateSceneTool(deps);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await tool.handler({ project_path: root, scene_path: "scenes/hero.tscn" }, {} as never);

    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });
});
