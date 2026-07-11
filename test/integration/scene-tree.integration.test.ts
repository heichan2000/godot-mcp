import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createNodeTools } from "../../src/tools/node.js";
import { createSceneTools, type SceneTreeNode } from "../../src/tools/scene.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  setBridgePort,
  type EditorHandle,
} from "./support.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

async function callTool(
  tools: ReturnType<typeof createSceneTools>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

/** Depth-first flatten so assertions can find nodes by name anywhere. */
function flatten(node: SceneTreeNode): SceneTreeNode[] {
  return [node, ...node.children.flatMap(flatten)];
}

const SUB_SCENE = `[gd_scene format=3]

[node name="SubRoot" type="Node2D"]
`;

const TREE_SCENE = `[gd_scene load_steps=3 format=3]

[ext_resource type="Script" path="res://scripts/print_marker.gd" id="1_s"]
[ext_resource type="PackedScene" path="res://mcp_fixtures/sub.tscn" id="2_p"]

[node name="Root" type="Node2D"]

[node name="Scripted" type="Node2D" parent="."]
script = ExtResource("1_s")

[node name="SubInstance" parent="." instance=ExtResource("2_p")]
`;

describe.runIf(hasGodot)("scene tree readback against a real editor (REQ-C-10)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let sceneTools: ReturnType<typeof createSceneTools>;
  let nodeTools: ReturnType<typeof createNodeTools>;

  const FIXTURE = "res://mcp_fixtures/tree_fixture.tscn";

  function fixtureOnDisk(): string {
    return readFileSync(path.join(projectDir, "mcp_fixtures", "tree_fixture.tscn"), "utf8");
  }

  async function readTree(): Promise<{ scene_path: string | null; tree: SceneTreeNode }> {
    const result = await callTool(sceneTools, "get_scene_tree");
    expect(result.isError).toBeFalsy();
    return result.structuredContent as { scene_path: string | null; tree: SceneTreeNode };
  }

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
    // #72 gave the shared sample project a run/main_scene so run-control's
    // suite can play it; that makes a freshly-opened editor auto-restore the
    // main scene as the current edited scene (no prior editor layout to
    // restore from), which would break this suite's "nothing is open yet"
    // precondition below. Strip it from THIS copy only - scene-tree's own
    // fixture scenes are unrelated to run/play and never need a main scene.
    const projectFile = path.join(projectDir, "project.godot");
    writeFileSync(
      projectFile,
      readFileSync(projectFile, "utf8").replace(/^run\/main_scene=.*\r?\n/m, ""),
    );
    mkdirSync(path.join(projectDir, "mcp_fixtures"), { recursive: true });
    writeFileSync(path.join(projectDir, "mcp_fixtures", "sub.tscn"), SUB_SCENE);
    writeFileSync(path.join(projectDir, "mcp_fixtures", "tree_fixture.tscn"), TREE_SCENE);
    const port = await pickFreePort();
    setBridgePort(projectDir, port);
    await importPass(projectDir);
    editor = launchEditor(projectDir);
    bridge = new BridgeConnection({
      url: `ws://127.0.0.1:${port}`,
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 30_000,
      reconnectDelayMs: 500,
      log: (message) => {
        if (process.env.DEBUG) console.error(message);
      },
    });
    bridge.start();
    await bridge.waitForState("connected", 150_000);
    sceneTools = createSceneTools({ bridge });
    nodeTools = createNodeTools({ bridge });
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("reports no_current_scene before any scene is open", async () => {
    const result = await callTool(sceneTools, "get_scene_tree");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("no open scene");
  });

  it("reads types, attached scripts, and instancing markers from the live tree (REQ-C-10)", async () => {
    const opened = await callTool(sceneTools, "open_scene", { scene_path: FIXTURE });
    expect(opened.isError).toBeFalsy();

    const { scene_path, tree } = await readTree();
    expect(scene_path).toBe(FIXTURE);

    expect(tree.name).toBe("Root");
    expect(tree.type).toBe("Node2D");
    expect(tree.path).toBe(".");
    expect(tree.script).toBeNull();
    expect(tree.instance).toBeNull();

    const nodes = flatten(tree);
    const scripted = nodes.find((n) => n.name === "Scripted");
    expect(scripted).toBeDefined();
    expect(scripted!.type).toBe("Node2D");
    expect(scripted!.path).toBe("Scripted");
    expect(scripted!.script).toBe("res://scripts/print_marker.gd");
    expect(scripted!.instance).toBeNull();

    const instanced = nodes.find((n) => n.name === "SubInstance");
    expect(instanced).toBeDefined();
    expect(instanced!.type).toBe("Node2D");
    expect(instanced!.instance).toBe("res://mcp_fixtures/sub.tscn");
    expect(instanced!.script).toBeNull();
  });

  it("reflects an UNSAVED mutation the disk does not have (acceptance: edited != disk)", async () => {
    const added = await callTool(nodeTools as never, "add_node", {
      node_type: "Node2D",
      node_name: "Fresh",
    });
    expect(added.isError).toBeFalsy();

    const { tree } = await readTree();
    const fresh = flatten(tree).find((n) => n.name === "Fresh");
    expect(fresh).toBeDefined();
    expect(fresh!.type).toBe("Node2D");

    // The tree sees it; the .tscn on disk does not — the readback is live.
    expect(fixtureOnDisk()).not.toContain('name="Fresh"');
  });

  it("shows a colliding sibling under its auto-suffixed name (carried from #69)", async () => {
    const added = await callTool(nodeTools as never, "add_node", {
      node_type: "Node2D",
      node_name: "Fresh",
    });
    expect(added.isError).toBeFalsy();
    const returnedName = (added.structuredContent as { name: string }).name;
    expect(returnedName).not.toBe("Fresh");

    const { tree } = await readTree();
    const freshLike = flatten(tree).filter((n) => n.name.includes("Fresh"));
    expect(freshLike).toHaveLength(2);
    expect(freshLike.map((n) => n.name)).toContain(returnedName);
  });
});
