import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { hasImportCache } from "../../src/godot/cache.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import { resolveOperationsScriptPath, runCheckOnly, runOperation } from "../../src/godot/runner.js";
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
