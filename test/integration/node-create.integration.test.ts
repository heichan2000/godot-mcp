import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createNodeTools } from "../../src/tools/node.js";
import { createSceneTools } from "../../src/tools/scene.js";
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
  tools: ReturnType<typeof createNodeTools>,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe.runIf(hasGodot)("node create against the sample project (REQ-C-04/M-05)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;

  const SCENE = "res://mcp_test/nodes.tscn";
  const NODE_NAME = "Hero";
  const NODE_TYPE = "Sprite2D";

  // The child node's .tscn attributes; present only when the node exists AND
  // has its owner set (unowned nodes are not serialized). Split into three
  // substring checks rather than one exact node-line string: Godot 4.6.3 adds a
  // trailing `unique_id=...` attribute to node lines that older 4.x builds
  // don't emit, so pinning the full bracketed line is brittle across patch
  // versions. `parent="."` is kept as its own assertion — it is the
  // owner-persistence proof (unowned nodes never get a parent attribute at
  // all), not incidental to the node-line format.
  const NODE_NAME_ATTR = `name="${NODE_NAME}"`;
  const NODE_TYPE_ATTR = `type="${NODE_TYPE}"`;
  const PARENT_ROOT_ATTR = `parent="."`;

  function onDisk(): string {
    return readFileSync(path.join(projectDir, "mcp_test", "nodes.tscn"), "utf8");
  }

  function expectHeroNodePresent(text: string): void {
    expect(text).toContain(NODE_NAME_ATTR);
    expect(text).toContain(NODE_TYPE_ATTR);
    expect(text).toContain(PARENT_ROOT_ATTR);
  }

  let sceneTools: ReturnType<typeof createSceneTools>;
  let nodeTools: ReturnType<typeof createNodeTools>;

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
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
    // A saved scene to author into.
    const created = await callTool(sceneTools, "create_scene", {
      scene_path: SCENE,
      root_node_type: "Node2D",
    });
    expect(created.isError).toBeFalsy();
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("adds a ClassDB-gated node that persists through save with its owner set (REQ-C-04)", async () => {
    const result = await callTool(nodeTools, "add_node", {
      node_type: NODE_TYPE,
      node_name: NODE_NAME,
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      name: NODE_NAME,
      node_type: NODE_TYPE,
      node_path: NODE_NAME,
      parent_path: ".",
    });

    // Adding a node marks the scene dirty (first real content edit — REQ-C-02).
    const open = await callTool(sceneTools, "get_open_scenes");
    const scenes = (open.structuredContent as { scenes: Array<{ path: string; dirty: boolean }> })
      .scenes;
    expect(scenes.find((s) => s.path === SCENE)!.dirty).toBe(true);

    // Save, then independent readback: the node serialized under the root.
    const saved = await callTool(sceneTools, "save_scene");
    expect(saved.isError).toBeFalsy();
    expectHeroNodePresent(onDisk());
  });

  it("Ctrl+Z reverts the agent's node addition (REQ-M-05)", async () => {
    const undone = await bridge.request("edit/undo", {});
    expect((undone as { stepped: boolean }).stepped).toBe(true);

    // Save the reverted tree; the node is gone from disk (real undo, not a shim).
    const saved = await callTool(sceneTools, "save_scene");
    expect(saved.isError).toBeFalsy();
    expect(onDisk()).not.toContain(NODE_NAME_ATTR);
  });

  it("redo restores the node — the UndoRedo registration is real (REQ-M-05)", async () => {
    const redone = await bridge.request("edit/redo", {});
    expect((redone as { stepped: boolean }).stepped).toBe(true);

    const saved = await callTool(sceneTools, "save_scene");
    expect(saved.isError).toBeFalsy();
    expectHeroNodePresent(onDisk());
  });

  it("rejects a typo'd type, a non-Node type, and a missing parent before touching the tree (REQ-C-04)", async () => {
    const typo = await callTool(nodeTools, "add_node", { node_type: "Sprtouto2D" });
    expect(typo.isError).toBe(true);
    expect(typo.content[0]!.text).toContain("not an instantiable Node class");

    const nonNode = await callTool(nodeTools, "add_node", { node_type: "Resource" });
    expect(nonNode.isError).toBe(true);
    expect(nonNode.content[0]!.text).toContain("not an instantiable Node class");

    const badParent = await callTool(nodeTools, "add_node", {
      node_type: "Node2D",
      parent_path: "Ghost",
    });
    expect(badParent.isError).toBe(true);
    expect(badParent.content[0]!.text).toContain("No node exists at parent_path");

    // None of the rejects mutated the scene: the disk still holds exactly one Hero.
    const saved = await callTool(sceneTools, "save_scene");
    expect(saved.isError).toBeFalsy();
    const text = onDisk();
    expectHeroNodePresent(text);
    expect(text.split(NODE_NAME_ATTR).length - 1).toBe(1);
  });
});
