import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { hasGodotCacheDir, hasImportCache } from "../../src/godot/cache.js";
import { listProjectDirs, readProjectInfo } from "../../src/godot/discovery.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import {
  resolveOperationsScriptPath,
  runCheckOnly,
  runGodotImport,
  runOperation,
} from "../../src/godot/runner.js";
import { createProjectTools } from "../../src/tools/project.js";
import { createReadbackTools } from "../../src/tools/readback.js";
import { createSceneTools } from "../../src/tools/scene.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

interface SceneTreeNode {
  name: string;
  type: string;
  path: string;
  children: SceneTreeNode[];
}

function makeSceneTools() {
  return createSceneTools({
    loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
    detectGodotPath,
    runOperation,
    operationsScriptPath: resolveOperationsScriptPath(),
    hasImportCache,
  });
}

function makeReadbackTools() {
  return createReadbackTools({
    loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
    detectGodotPath,
    runCheckOnly,
    fileExists: () => true,
    readFile: () => "",
    runOperation,
    operationsScriptPath: resolveOperationsScriptPath(),
  });
}

function makeProjectTools() {
  return createProjectTools({
    loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
    detectGodotPath,
    runGodotImport,
    hasGodotCacheDir,
    hasImportCache,
    listProjectDirs,
    readProjectInfo,
  });
}

function getTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

/** Flattens a get_scene_tree result into a path -> node map for easy lookup by test assertions. */
function flattenTree(node: SceneTreeNode, out: Record<string, SceneTreeNode> = {}) {
  out[node.path] = node;
  for (const child of node.children) {
    flattenTree(child, out);
  }
  return out;
}

/** Creates a fresh sample project with a base scene ready for add_node calls. */
async function projectWithScene(): Promise<{ projectPath: string; scenePath: string }> {
  const projectPath = freshSampleProject();
  const scenePath = path.join("scenes", "hero.tscn");
  const tools = makeSceneTools();
  const result = await getTool(tools, "create_scene").handler(
    { project_path: projectPath, scene_path: scenePath, root_node_type: "Node2D" },
    {} as never,
  );
  if (result.isError) {
    throw new Error(`Failed to set up base scene: ${JSON.stringify(result)}`);
  }
  return { projectPath, scenePath };
}

describe.skipIf(!hasGodot)(
  "get_scene_tree / read_node_properties (integration, real headless Godot)",
  () => {
    it("returns the full multi-level tree with names/types/paths usable as node_path inputs elsewhere", async () => {
      const { projectPath, scenePath } = await projectWithScene();
      const sceneTools = makeSceneTools();

      // Root (Node2D, unnamed path ".")
      //  +- Body (Node2D, path "Body")
      //  |   +- Hero (Sprite2D, path "Body/Hero")
      //  +- Label (Label, path "Label")
      const bodyResult = await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Node2D",
          node_name: "Body",
        },
        {} as never,
      );
      expect(bodyResult.isError).toBeFalsy();

      const heroResult = await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Sprite2D",
          node_name: "Hero",
          parent_node_path: "Body",
        },
        {} as never,
      );
      expect(heroResult.isError).toBeFalsy();

      const labelResult = await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Label",
          node_name: "Label",
        },
        {} as never,
      );
      expect(labelResult.isError).toBeFalsy();

      const readbackTools = makeReadbackTools();
      const treeResult = await getTool(readbackTools, "get_scene_tree").handler(
        { project_path: projectPath, scene_path: scenePath },
        {} as never,
      );

      expect(treeResult.isError).toBeFalsy();
      const structured = treeResult.structuredContent as {
        scene_path: string;
        tree: SceneTreeNode;
      };
      const flattened = flattenTree(structured.tree);

      // Known fixture structure, pinned exactly - not just "some tree".
      expect(structured.tree.path).toBe(".");
      expect(structured.tree.type).toBe("Node2D");
      expect(Object.keys(flattened).sort()).toEqual([".", "Body", "Body/Hero", "Label"].sort());
      expect(flattened["Body"]).toMatchObject({ name: "Body", type: "Node2D", path: "Body" });
      expect(flattened["Body/Hero"]).toMatchObject({
        name: "Hero",
        type: "Sprite2D",
        path: "Body/Hero",
      });
      expect(flattened["Label"]).toMatchObject({ name: "Label", type: "Label", path: "Label" });
      expect(flattened["Body"]!.children.map((c) => c.path)).toEqual(["Body/Hero"]);
      expect(flattened["Body/Hero"]!.children).toEqual([]);

      // Every returned path is directly usable as another tool's node_path input.
      const readResult = await getTool(readbackTools, "read_node_properties").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_path: flattened["Body/Hero"]!.path,
        },
        {} as never,
      );
      expect(readResult.isError).toBeFalsy();
    });

    it("returns the scene root itself with path '.' when the scene has no children yet", async () => {
      const { projectPath, scenePath } = await projectWithScene();
      const readbackTools = makeReadbackTools();

      const treeResult = await getTool(readbackTools, "get_scene_tree").handler(
        { project_path: projectPath, scene_path: scenePath },
        {} as never,
      );

      expect(treeResult.isError).toBeFalsy();
      const structured = treeResult.structuredContent as {
        scene_path: string;
        tree: SceneTreeNode;
      };
      expect(structured.tree).toEqual({
        name: expect.any(String),
        type: "Node2D",
        path: ".",
        children: [],
      });
    });

    it("rejects get_scene_tree against a scene that does not exist", async () => {
      const projectPath = freshSampleProject();
      const readbackTools = makeReadbackTools();

      const result = await getTool(readbackTools, "get_scene_tree").handler(
        { project_path: projectPath, scene_path: path.join("scenes", "missing.tscn") },
        {} as never,
      );

      expect(result.isError).toBe(true);
    });

    it("default mode returns EXACTLY the one explicitly-set property, not the ~40+ Sprite2D engine defaults", async () => {
      const { projectPath, scenePath } = await projectWithScene();
      const sceneTools = makeSceneTools();

      const addResult = await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Sprite2D",
          node_name: "Hero",
          properties: { position: "Vector2(100, 50)" },
        },
        {} as never,
      );
      expect(addResult.isError).toBeFalsy();

      const readbackTools = makeReadbackTools();
      const result = await getTool(readbackTools, "read_node_properties").handler(
        { project_path: projectPath, scene_path: scenePath, node_path: "Hero" },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        scene_path: string;
        node_path: string;
        node_type: string;
        properties: Record<string, unknown>;
      };
      expect(structured.node_type).toBe("Sprite2D");
      // Exactly one stored property - the compact .tscn-mirroring shape, not a
      // dump of every Sprite2D default (visible, scale, rotation, modulate,
      // z_index, ... none of which were ever explicitly set here).
      expect(structured.properties).toEqual({ position: "Vector2(100, 50)" });
      expect(Object.keys(structured.properties)).not.toContain("visible");
      expect(Object.keys(structured.properties)).not.toContain("scale");
      expect(Object.keys(structured.properties)).not.toContain("modulate");
    });

    it("default mode returns an empty properties object for a node with no explicitly-set properties", async () => {
      const { projectPath, scenePath } = await projectWithScene();
      const sceneTools = makeSceneTools();

      const addResult = await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Node2D",
          node_name: "Plain",
        },
        {} as never,
      );
      expect(addResult.isError).toBeFalsy();

      const readbackTools = makeReadbackTools();
      const result = await getTool(readbackTools, "read_node_properties").handler(
        { project_path: projectPath, scene_path: scenePath, node_path: "Plain" },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { properties: Record<string, unknown> };
      expect(structured.properties).toEqual({});
    });

    it("named-properties mode returns a default-valued property that default mode would omit", async () => {
      const { projectPath, scenePath } = await projectWithScene();
      const sceneTools = makeSceneTools();

      const addResult = await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Sprite2D",
          node_name: "Hero",
          properties: { position: "Vector2(100, 50)" },
        },
        {} as never,
      );
      expect(addResult.isError).toBeFalsy();

      const readbackTools = makeReadbackTools();
      const result = await getTool(readbackTools, "read_node_properties").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_path: "Hero",
          properties: ["position", "visible"],
        },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { properties: Record<string, unknown> };
      // position was explicitly set; visible was never touched and still holds
      // its Sprite2D class default (true) - named mode returns it anyway.
      expect(structured.properties).toEqual({ position: "Vector2(100, 50)", visible: true });
    });

    it("rejects a named property that does not exist on the node", async () => {
      const { projectPath, scenePath } = await projectWithScene();
      const readbackTools = makeReadbackTools();

      const result = await getTool(readbackTools, "read_node_properties").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_path: ".",
          properties: ["not_a_real_property_xyz"],
        },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("not_a_real_property_xyz");
    });

    it("returns a guided error listing available node paths for an unknown node_path", async () => {
      const { projectPath, scenePath } = await projectWithScene();
      const sceneTools = makeSceneTools();
      await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Node2D",
          node_name: "Body",
        },
        {} as never,
      );

      const readbackTools = makeReadbackTools();
      const result = await getTool(readbackTools, "read_node_properties").handler(
        { project_path: projectPath, scene_path: scenePath, node_path: "TotallyBogus/Path" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("TotallyBogus/Path");
      expect(text).toContain("Body");
    });

    it("closes the full write->verify loop: add_node -> get_scene_tree shows it -> read_node_properties confirms the identical Vector2 string", async () => {
      const { projectPath, scenePath } = await projectWithScene();
      const sceneTools = makeSceneTools();
      const readbackTools = makeReadbackTools();

      const addResult = await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Sprite2D",
          node_name: "Hero",
          properties: { position: "Vector2(100, 50)" },
        },
        {} as never,
      );
      expect(addResult.isError).toBeFalsy();

      const treeResult = await getTool(readbackTools, "get_scene_tree").handler(
        { project_path: projectPath, scene_path: scenePath },
        {} as never,
      );
      expect(treeResult.isError).toBeFalsy();
      const treeStructured = treeResult.structuredContent as { tree: SceneTreeNode };
      const flattened = flattenTree(treeStructured.tree);
      expect(flattened["Hero"]).toMatchObject({ name: "Hero", type: "Sprite2D", path: "Hero" });

      const readResult = await getTool(readbackTools, "read_node_properties").handler(
        { project_path: projectPath, scene_path: scenePath, node_path: flattened["Hero"]!.path },
        {} as never,
      );
      expect(readResult.isError).toBeFalsy();
      const readStructured = readResult.structuredContent as {
        properties: Record<string, unknown>;
      };
      // Exact string identity, not just a value that happens to be equivalent.
      expect(readStructured.properties.position).toBe("Vector2(100, 50)");
    });
  },
);

interface ListedResource {
  path: string;
  type: string;
  uid?: string;
}

describe.skipIf(!hasGodot)("list_resources (integration, real headless Godot)", () => {
  it("lists the sample project's committed scenes/scripts by res:// path and type, skipping .godot", async () => {
    const projectPath = freshSampleProject();
    const readbackTools = makeReadbackTools();

    const result = await getTool(readbackTools, "list_resources").handler(
      { project_path: projectPath },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { resources: ListedResource[] };
    const byPath = new Map(structured.resources.map((r) => [r.path, r]));

    expect(byPath.get("res://scenes/meshes.tscn")).toMatchObject({ type: "PackedScene" });
    expect(byPath.get("res://scenes/print_marker.tscn")).toMatchObject({ type: "PackedScene" });
    expect(byPath.get("res://scripts/print_marker.gd")).toMatchObject({ type: "GDScript" });

    // Never leaks Godot's own internal cache directory or project.godot itself.
    for (const resource of structured.resources) {
      expect(resource.path).not.toContain("/.godot/");
      expect(resource.path).not.toBe("res://project.godot");
      expect(resource.path.endsWith(".import")).toBe(false);
      expect(resource.path.endsWith(".uid")).toBe(false);
    }
  }, 60_000);

  it("an unimported texture does not appear on a cold project (no error), but does after import_project - with a real uid, since imported-resource UIDs have existed since Godot 4.0", async () => {
    const projectPath = freshSampleProject();
    expect(existsSync(path.join(projectPath, ".godot"))).toBe(false);
    const readbackTools = makeReadbackTools();

    const coldResult = await getTool(readbackTools, "list_resources").handler(
      { project_path: projectPath },
      {} as never,
    );
    expect(coldResult.isError).toBeFalsy();
    const coldStructured = coldResult.structuredContent as { resources: ListedResource[] };
    expect(coldStructured.resources.some((r) => r.path === "res://textures/sprite.png")).toBe(
      false,
    );
    // Scenes/scripts don't need an import cache, so they're already visible.
    expect(coldStructured.resources.some((r) => r.path === "res://scripts/print_marker.gd")).toBe(
      true,
    );

    const projectTools = makeProjectTools();
    const importResult = await getTool(projectTools, "import_project").handler(
      { project_path: projectPath },
      {} as never,
    );
    expect(importResult.isError).toBeFalsy();

    const warmResult = await getTool(readbackTools, "list_resources").handler(
      { project_path: projectPath },
      {} as never,
    );
    expect(warmResult.isError).toBeFalsy();
    const warmStructured = warmResult.structuredContent as { resources: ListedResource[] };
    const sprite = warmStructured.resources.find((r) => r.path === "res://textures/sprite.png");
    expect(sprite).toBeDefined();
    expect(sprite!.type).toBe("CompressedTexture2D");
    // Imported resources (like this texture) have had Resource UIDs since
    // Godot 4.0 - unlike scripts/scenes, whose UIDs are only assigned via the
    // .uid sidecar mechanism added in MIN_UID_GODOT_VERSION (4.4, see
    // tools/uid.ts). So a warm-imported texture's uid is expected to be
    // present and well-formed on every Godot version in the CI matrix, not
    // just >= 4.4.
    expect(sprite!.uid).toMatch(/^uid:\/\/[0-9a-z]+$/);
  }, 90_000);

  it("type filter narrows to exactly the matching subclass (Texture2D matches CompressedTexture2D)", async () => {
    const projectPath = freshSampleProject();
    const readbackTools = makeReadbackTools();
    const projectTools = makeProjectTools();
    const importResult = await getTool(projectTools, "import_project").handler(
      { project_path: projectPath },
      {} as never,
    );
    expect(importResult.isError).toBeFalsy();

    const result = await getTool(readbackTools, "list_resources").handler(
      { project_path: projectPath, type: "Texture2D" },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { resources: ListedResource[] };
    // uid is present (a real uid:// string) on every Godot version in the
    // matrix: imported resources (like this texture) have had Resource UIDs
    // since Godot 4.0, unlike scripts/scenes, whose UIDs depend on the .uid
    // sidecar mechanism added in MIN_UID_GODOT_VERSION (4.4, see
    // tools/uid.ts).
    expect(structured.resources).toEqual([
      {
        path: "res://textures/sprite.png",
        type: "CompressedTexture2D",
        uid: expect.any(String),
      },
    ]);
  }, 90_000);

  it("a type filter that matches nothing returns an empty list rather than an error", async () => {
    const projectPath = freshSampleProject();
    const readbackTools = makeReadbackTools();

    const result = await getTool(readbackTools, "list_resources").handler(
      { project_path: projectPath, type: "TotallyNotARealGodotClass" },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { resources: ListedResource[] };
    expect(structured.resources).toEqual([]);
  }, 60_000);

  it(
    "closes the discovery->use loop: list_resources finds the sample texture, and its returned " +
      "path feeds a successful load_sprite call",
    async () => {
      const projectPath = freshSampleProject();
      const scenePath = path.join("scenes", "hero.tscn");

      const sceneTools = createSceneTools({
        loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
        detectGodotPath,
        runOperation,
        operationsScriptPath: resolveOperationsScriptPath(),
        hasImportCache,
      });
      const projectTools = makeProjectTools();
      const readbackTools = makeReadbackTools();

      const importResult = await getTool(projectTools, "import_project").handler(
        { project_path: projectPath },
        {} as never,
      );
      expect(importResult.isError).toBeFalsy();

      const createResult = await getTool(sceneTools, "create_scene").handler(
        { project_path: projectPath, scene_path: scenePath, root_node_type: "Node2D" },
        {} as never,
      );
      expect(createResult.isError).toBeFalsy();

      const addSpriteResult = await getTool(sceneTools, "add_node").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_type: "Sprite2D",
          node_name: "Hero",
        },
        {} as never,
      );
      expect(addSpriteResult.isError).toBeFalsy();

      const listResult = await getTool(readbackTools, "list_resources").handler(
        { project_path: projectPath, type: "Texture2D" },
        {} as never,
      );
      expect(listResult.isError).toBeFalsy();
      const listStructured = listResult.structuredContent as { resources: ListedResource[] };
      const texture = listStructured.resources.find((r) => r.path === "res://textures/sprite.png");
      expect(texture).toBeDefined();

      // res:// -> project-relative, the form load_sprite's texture_path expects.
      const texturePath = texture!.path.replace(/^res:\/\//, "");

      const loadResult = await getTool(sceneTools, "load_sprite").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_path: "Hero",
          texture_path: texturePath,
        },
        {} as never,
      );

      expect(loadResult.isError).toBeFalsy();
      const loadStructured = loadResult.structuredContent as { texture_path: string };
      expect(loadStructured.texture_path).toBe("res://textures/sprite.png");
    },
    60_000,
  );
});
