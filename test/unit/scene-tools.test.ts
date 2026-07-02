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
  hasImportCacheResult?: boolean;
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
    hasImportCache: vi.fn(() => overrides.hasImportCacheResult ?? true),
  };
}

function getCreateSceneTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createSceneTools(deps);
  const tool = tools.find((t) => t.name === "create_scene");
  if (!tool) throw new Error("create_scene descriptor not found");
  return tool;
}

function getAddNodeTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createSceneTools(deps);
  const tool = tools.find((t) => t.name === "add_node");
  if (!tool) throw new Error("add_node descriptor not found");
  return tool;
}

function getLoadSpriteTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createSceneTools(deps);
  const tool = tools.find((t) => t.name === "load_sprite");
  if (!tool) throw new Error("load_sprite descriptor not found");
  return tool;
}

describe("createSceneTools", () => {
  it("exposes create_scene, add_node, and load_sprite descriptors with their expected schema keys", () => {
    const deps = makeDeps({});
    const tools = createSceneTools(deps);

    expect(tools.map((t) => t.name).sort()).toEqual(["add_node", "create_scene", "load_sprite"]);

    const createScene = tools.find((t) => t.name === "create_scene")!;
    expect(Object.keys(createScene.inputSchema).sort()).toEqual(
      ["project_path", "root_node_type", "scene_path"].sort(),
    );

    const addNode = tools.find((t) => t.name === "add_node")!;
    expect(Object.keys(addNode.inputSchema).sort()).toEqual(
      [
        "project_path",
        "scene_path",
        "node_type",
        "node_name",
        "parent_node_path",
        "properties",
      ].sort(),
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

describe("add_node tool", () => {
  it("discloses the str_to_var decode ambiguity and the quoted-string escape hatch at the tool boundary", () => {
    const deps = makeDeps({});
    const tool = getAddNodeTool(deps);

    expect(tool.description).toContain("str_to_var");
    expect(tool.description).toContain('"\\"42\\""');

    const propertiesDescription = (
      tool.inputSchema.properties! as unknown as { description?: string }
    ).description;
    expect(propertiesDescription).toContain("str_to_var");
    expect(propertiesDescription).toContain('"\\"42\\""');
  });

  it("calls runOperation with the exact op/params contract, defaulting parent_node_path and properties", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "success",
        version: 1,
        operation: "add_node",
        result: { scene_path: "res://scenes/hero.tscn", node_name: "Sprite" },
      },
    });
    const tool = getAddNodeTool(deps);

    await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_type: "Sprite2D",
        node_name: "Sprite",
      },
      {} as never,
    );

    expect(deps.runOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        godotPath: "/usr/bin/godot",
        projectPath: root,
        operationScriptPath: "/dist/operations.gd",
        operation: "add_node",
        params: {
          scene_path: "scenes/hero.tscn",
          node_type: "Sprite2D",
          node_name: "Sprite",
          parent_node_path: "",
          properties: {},
        },
      }),
    );
  });

  it("passes an explicit parent_node_path and properties (mixing primitives and var_to_str strings) through untouched", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getAddNodeTool(deps);

    await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_type: "Sprite2D",
        node_name: "Sprite",
        parent_node_path: "Body",
        properties: { position: "Vector2(100, 50)", visible: true, z_index: 3 },
      },
      {} as never,
    );

    expect(deps.runOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          scene_path: "scenes/hero.tscn",
          node_type: "Sprite2D",
          node_name: "Sprite",
          parent_node_path: "Body",
          properties: { position: "Vector2(100, 50)", visible: true, z_index: 3 },
        },
      }),
    );
  });

  it("returns success content with the dispatcher's result as structuredContent", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "success",
        version: 1,
        operation: "add_node",
        result: {
          scene_path: "res://scenes/hero.tscn",
          node_type: "Sprite2D",
          node_name: "Sprite",
          node_path: "Sprite",
        },
      },
    });
    const tool = getAddNodeTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_type: "Sprite2D",
        node_name: "Sprite",
      },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("Added node");
    expect(result.structuredContent).toEqual({
      scene_path: "res://scenes/hero.tscn",
      node_type: "Sprite2D",
      node_name: "Sprite",
      node_path: "Sprite",
    });
  });

  it("rejects an escaping scene_path with a containment error WITHOUT invoking Godot", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getAddNodeTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: path.join("..", "escape.tscn"),
        node_type: "Sprite2D",
        node_name: "Sprite",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.detectGodotPath).not.toHaveBeenCalled();
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("returns a structured guided error when Godot cannot be resolved, without invoking runOperation", async () => {
    const root = makeRoot();
    const deps = makeDeps({ resolution: { found: false, candidates: ["/usr/bin/godot"] } });
    const tool = getAddNodeTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_type: "Sprite2D",
        node_name: "Sprite",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("suggests checking the class name against ClassDB when node_type is rejected", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "operation-error",
        version: 1,
        operation: "add_node",
        error: "node_type is not an instantiable Node class: Resource",
      },
    });
    const tool = getAddNodeTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_type: "Resource",
        node_name: "Bogus",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Resource");
    expect(text.toLowerCase()).toContain("class reference");
  });

  it("suggests checking the node path when parent_node_path is not found", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "operation-error",
        version: 1,
        operation: "add_node",
        error: "parent_node_path not found in scene: Missing/Path",
      },
    });
    const tool = getAddNodeTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_type: "Sprite2D",
        node_name: "Sprite",
        parent_node_path: "Missing/Path",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Missing/Path");
    expect(text.toLowerCase()).toContain("omit parent_node_path");
  });

  it("suggests checking the property name when a property does not exist on the node", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "operation-error",
        version: 1,
        operation: "add_node",
        error: "Property does not exist on Sprite2D: not_a_real_property",
      },
    });
    const tool = getAddNodeTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_type: "Sprite2D",
        node_name: "Sprite",
        properties: { not_a_real_property: "hi" },
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not_a_real_property");
    expect(text).toContain("var_to_str");
  });

  it("returns a structured error naming both versions on a version mismatch", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: { kind: "version-mismatch", expectedVersion: 1, actualVersion: 2 },
    });
    const tool = getAddNodeTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_type: "Sprite2D",
        node_name: "Sprite",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1");
    expect(text).toContain("2");
  });
});

describe("load_sprite tool", () => {
  it("calls runOperation with the exact op/params contract, defaulting node_path to the scene root", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "success",
        version: 1,
        operation: "load_sprite",
        result: { scene_path: "res://scenes/hero.tscn" },
      },
    });
    const tool = getLoadSpriteTool(deps);

    await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        texture_path: "textures/sprite.png",
      },
      {} as never,
    );

    expect(deps.runOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        godotPath: "/usr/bin/godot",
        projectPath: root,
        operationScriptPath: "/dist/operations.gd",
        operation: "load_sprite",
        params: {
          scene_path: "scenes/hero.tscn",
          node_path: "",
          texture_path: "textures/sprite.png",
        },
      }),
    );
  });

  it("passes an explicit node_path through untouched", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getLoadSpriteTool(deps);

    await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_path: "Hero",
        texture_path: "textures/sprite.png",
      },
      {} as never,
    );

    expect(deps.runOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        params: {
          scene_path: "scenes/hero.tscn",
          node_path: "Hero",
          texture_path: "textures/sprite.png",
        },
      }),
    );
  });

  it("returns success content with the dispatcher's result as structuredContent", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "success",
        version: 1,
        operation: "load_sprite",
        result: {
          scene_path: "res://scenes/hero.tscn",
          node_path: "Hero",
          texture_path: "res://textures/sprite.png",
        },
      },
    });
    const tool = getLoadSpriteTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_path: "Hero",
        texture_path: "textures/sprite.png",
      },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    expect((result.content[0] as { text: string }).text).toContain("Loaded sprite texture");
    expect(result.structuredContent).toEqual({
      scene_path: "res://scenes/hero.tscn",
      node_path: "Hero",
      texture_path: "res://textures/sprite.png",
    });
  });

  it("rejects an escaping scene_path with a containment error WITHOUT invoking Godot", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getLoadSpriteTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: path.join("..", "escape.tscn"),
        texture_path: "textures/sprite.png",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.detectGodotPath).not.toHaveBeenCalled();
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("rejects an escaping texture_path with a containment error WITHOUT invoking Godot", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getLoadSpriteTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        texture_path: path.join("..", "escape.png"),
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.detectGodotPath).not.toHaveBeenCalled();
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("rejects an absolute texture_path with a containment error WITHOUT invoking Godot", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getLoadSpriteTool(deps);

    const absolute = path.join(tmpdir(), "elsewhere.png");
    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn", texture_path: absolute },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("returns a guided cold-cache error naming import_project WITHOUT invoking Godot, when the import cache is missing", async () => {
    const root = makeRoot();
    const deps = makeDeps({ hasImportCacheResult: false });
    const tool = getLoadSpriteTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        texture_path: "textures/sprite.png",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("import_project");
    expect(deps.detectGodotPath).not.toHaveBeenCalled();
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("checks the import cache for project_path", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getLoadSpriteTool(deps);

    await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn", texture_path: "textures/sprite.png" },
      {} as never,
    );

    expect(deps.hasImportCache).toHaveBeenCalledWith(root);
  });

  it("returns a structured guided error when Godot cannot be resolved, without invoking runOperation", async () => {
    const root = makeRoot();
    const deps = makeDeps({ resolution: { found: false, candidates: ["/usr/bin/godot"] } });
    const tool = getLoadSpriteTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn", texture_path: "textures/sprite.png" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.runOperation).not.toHaveBeenCalled();
  });

  it("suggests checking the node's class when the target node is not a Sprite2D/Sprite3D", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "operation-error",
        version: 1,
        operation: "load_sprite",
        error: "Node at Body is a Node2D, not a Sprite2D or Sprite3D.",
      },
    });
    const tool = getLoadSpriteTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        node_path: "Body",
        texture_path: "textures/sprite.png",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Sprite2D");
    expect(text).toContain("Sprite3D");
  });

  it("suggests checking texture_path when the texture does not exist", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: {
        kind: "operation-error",
        version: 1,
        operation: "load_sprite",
        error: "Texture does not exist at res://textures/missing.png.",
      },
    });
    const tool = getLoadSpriteTool(deps);

    const result = await tool.handler(
      {
        project_path: root,
        scene_path: "scenes/hero.tscn",
        texture_path: "textures/missing.png",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("texture_path");
  });

  it("returns a structured error naming both versions on a version mismatch", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runOperationResult: { kind: "version-mismatch", expectedVersion: 1, actualVersion: 2 },
    });
    const tool = getLoadSpriteTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn", texture_path: "textures/sprite.png" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("1");
    expect(text).toContain("2");
  });
});
