import { execFile as execFileCb } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { hasImportCache } from "../../src/godot/cache.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import { resolveOperationsScriptPath, runOperation } from "../../src/godot/runner.js";
import { createSceneTools } from "../../src/tools/scene.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

const VERIFY_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "verify_node_property.gd",
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
  node_found: boolean;
  node_class: string;
  property_value_str: string;
}

/**
 * Round-trips a scene through a real Godot `load()` call, independent of
 * operations.gd, and reports the class + (optionally) one property's
 * var_to_str encoding for the node at node_path (relative to the scene
 * root; empty string means the root itself).
 */
async function verifyNode(
  projectPath: string,
  resScenePath: string,
  nodePath: string,
  propertyName = "",
): Promise<VerifyResult> {
  const { stdout } = await execFile(godotPath!, [
    "--headless",
    "--path",
    projectPath,
    "--script",
    VERIFY_SCRIPT,
    "--",
    resScenePath,
    nodePath,
    propertyName,
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

function makeTools() {
  return createSceneTools({
    loadConfig: (): Config => ({ godotPath, debug: false }),
    detectGodotPath,
    runOperation,
    operationsScriptPath: resolveOperationsScriptPath(),
    hasImportCache,
  });
}

function getTool(tools: ReturnType<typeof makeTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

/** Creates a fresh sample project with a base scene ready for add_node calls. */
async function projectWithScene(): Promise<{ projectPath: string; scenePath: string }> {
  const projectPath = freshSampleProject();
  const scenePath = path.join("scenes", "hero.tscn");
  const tools = makeTools();
  const result = await getTool(tools, "create_scene").handler(
    { project_path: projectPath, scene_path: scenePath, root_node_type: "Node2D" },
    {} as never,
  );
  if (result.isError) {
    throw new Error(`Failed to set up base scene: ${JSON.stringify(result)}`);
  }
  return { projectPath, scenePath };
}

describe.skipIf(!hasGodot)("add_node (integration, real headless Godot)", () => {
  it("adds a node under the scene root with a var_to_str Vector2 property that round-trips into the saved scene", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "Sprite2D",
        node_name: "Hero",
        properties: { position: "Vector2(100, 50)" },
      },
      {} as never,
    );

    expect(result.isError).toBeFalsy();

    const verified = await verifyNode(projectPath, "res://scenes/hero.tscn", "Hero", "position");
    expect(verified.ok).toBe(true);
    expect(verified.node_found).toBe(true);
    expect(verified.node_class).toBe("Sprite2D");
    expect(verified.property_value_str).toBe("Vector2(100, 50)");
  });

  it("forces a literal string onto a String-typed property via the quoted var_to_str escape hatch", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "Label",
        node_name: "Score",
        // A bare "42" would decode via str_to_var to the int 42. Quoting it
        // var_to_str-style (matching .tscn's own string syntax) is the
        // documented escape hatch that forces the literal String "42"
        // instead - see add_node's tool description and the properties
        // field description in src/tools/scene.ts.
        properties: { text: '"42"' },
      },
      {} as never,
    );

    expect(result.isError).toBeFalsy();

    const verified = await verifyNode(projectPath, "res://scenes/hero.tscn", "Score", "text");
    expect(verified.ok).toBe(true);
    expect(verified.node_found).toBe(true);
    expect(verified.node_class).toBe("Label");
    // var_to_str of the String "42" is the quoted form `"42"` - this
    // confirms the saved property is the *string* "42", not the int 42
    // (which would var_to_str to the bare `42`, no quotes).
    expect(verified.property_value_str).toBe('"42"');
  });

  it("pins actual Godot set() coercion behavior when a bare (unquoted) numeric-looking string hits a String-typed property", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "Label",
        node_name: "Score",
        // decode_property_value runs this through str_to_var first: "42"
        // parses as the int 42, not the string "42" - the exact ambiguity
        // Finding 1 requires documenting at the tool boundary. This test
        // pins what Godot's Node.set("text", 42) actually does when the
        // declared property type is String, whatever that behavior is.
        properties: { text: "42" },
      },
      {} as never,
    );

    expect(result.isError).toBeFalsy();

    const verified = await verifyNode(projectPath, "res://scenes/hero.tscn", "Score", "text");
    expect(verified.ok).toBe(true);
    expect(verified.node_found).toBe(true);
    expect(verified.node_class).toBe("Label");
    // Godot's set() coerces the int 42 to the String property via its own
    // Variant conversion rules, landing on the string "42" - so the
    // *saved* result is indistinguishable from the quoted escape-hatch
    // form above. This assertion pins that actual coercion behavior; if a
    // future Godot version changes it, this test will fail loudly rather
    // than silently drifting.
    expect(verified.property_value_str).toBe('"42"');
  });

  it("attaches the new node under an explicit parent_node_path", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const parentResult = await getTool(tools, "add_node").handler(
      { project_path: projectPath, scene_path: scenePath, node_type: "Node2D", node_name: "Body" },
      {} as never,
    );
    expect(parentResult.isError).toBeFalsy();

    const childResult = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "Sprite2D",
        node_name: "Hero",
        parent_node_path: "Body",
      },
      {} as never,
    );
    expect(childResult.isError).toBeFalsy();

    const verified = await verifyNode(projectPath, "res://scenes/hero.tscn", "Body/Hero");
    expect(verified.ok).toBe(true);
    expect(verified.node_found).toBe(true);
    expect(verified.node_class).toBe("Sprite2D");
  });

  it("rejects a parent_node_path that does not exist in the scene, naming the missing path", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "Sprite2D",
        node_name: "Hero",
        parent_node_path: "DoesNotExist",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("DoesNotExist");
  });

  it("rejects an unknown class name with a structured error", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "TotallyBogusClassName",
        node_name: "Hero",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("TotallyBogusClassName");
  });

  it("rejects a non-Node class (Resource) with a structured error", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "Resource",
        node_name: "Hero",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Resource");
  });

  it("rejects a res:// path used as node_type with a structured error", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "res://scenes/hero.tscn",
        node_name: "Hero",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
  });

  it("rejects an abstract/non-instantiable class (EditorPlugin) with a structured error", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "EditorPlugin",
        node_name: "Hero",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
  });

  it("rejects a property that does not exist on the node, rather than silently ignoring it", async () => {
    const { projectPath, scenePath } = await projectWithScene();
    const tools = makeTools();

    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: scenePath,
        node_type: "Sprite2D",
        node_name: "Hero",
        properties: { not_a_real_property_xyz: "hello" },
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("not_a_real_property_xyz");
  });

  it("rejects add_node against a scene that does not exist", async () => {
    const projectPath = freshSampleProject();

    const tools = makeTools();
    const result = await getTool(tools, "add_node").handler(
      {
        project_path: projectPath,
        scene_path: path.join("scenes", "missing.tscn"),
        node_type: "Sprite2D",
        node_name: "Hero",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
  });
});
