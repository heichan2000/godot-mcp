import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import type { ToolDescriptor } from "../../src/registry.js";
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

type RemovedEntry = { path: string; name: string; type: string };

const SCENE = "res://mcp_test/node_ops.tscn";

async function callTool(
  tools: ToolDescriptor[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe.runIf(hasGodot)("node ops against the sample project (REQ-C-05/M-04/M-05)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let sceneTools: ReturnType<typeof createSceneTools>;
  let nodeTools: ReturnType<typeof createNodeTools>;
  /** Actual (auto-suffixed) name of the duplicated branch, captured in the duplicate test. */
  let copyName = "";

  function onDisk(): string {
    return readFileSync(path.join(projectDir, "mcp_test", "node_ops.tscn"), "utf8");
  }

  async function tree(): Promise<SceneTreeNode> {
    const result = await callTool(sceneTools, "get_scene_tree");
    expect(result.isError).toBeUndefined();
    return (result.structuredContent as { tree: SceneTreeNode }).tree;
  }

  function childNames(node: SceneTreeNode): string[] {
    return node.children.map((child) => child.name);
  }

  function findChild(node: SceneTreeNode, name: string): SceneTreeNode | undefined {
    return node.children.find((child) => child.name === name);
  }

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
    // Base tree: root(Node2D) { Branch(Node2D) { Leaf(Sprite2D) }, Target(Node2D) }.
    const created = await callTool(sceneTools, "create_scene", {
      scene_path: SCENE,
      root_node_type: "Node2D",
    });
    expect(created.isError).toBeFalsy();
    for (const [node_type, node_name, parent_path] of [
      ["Node2D", "Branch", undefined],
      ["Sprite2D", "Leaf", "Branch"],
      ["Node2D", "Target", undefined],
    ] as const) {
      const added = await callTool(nodeTools, "add_node", {
        node_type,
        node_name,
        ...(parent_path ? { parent_path } : {}),
      });
      expect(added.isError).toBeFalsy();
    }
    const saved = await callTool(sceneTools, "save_scene");
    expect(saved.isError).toBeFalsy();
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("duplicate_node makes a uniquely named sibling copy that persists through save + reload (REQ-C-05)", async () => {
    const result = await callTool(nodeTools, "duplicate_node", { node_path: "Branch" });
    expect(result.isError).toBeUndefined();
    const outcome = result.structuredContent as {
      node_path: string;
      name: string;
      source_path: string;
    };
    expect(outcome.source_path).toBe("Branch");
    expect(outcome.name).not.toBe("Branch"); // unique auto-suffix (e.g. Branch2)
    expect(outcome.node_path).toBe(outcome.name); // sibling of Branch under the root
    copyName = outcome.name;

    // The copy sits right after its source and carries the subtree.
    let root = await tree();
    expect(childNames(root)).toEqual(["Branch", copyName, "Target"]);
    expect(childNames(findChild(root, copyName)!)).toEqual(["Leaf"]);

    // Persists through save + close + reopen: the copy's subtree was re-owned.
    expect((await callTool(sceneTools, "save_scene")).isError).toBeFalsy();
    expect((await callTool(sceneTools, "close_scene", { scene_path: SCENE })).isError).toBeFalsy();
    expect((await callTool(sceneTools, "open_scene", { scene_path: SCENE })).isError).toBeFalsy();
    root = await tree();
    expect(childNames(root)).toEqual(["Branch", copyName, "Target"]);
    expect(childNames(findChild(root, copyName)!)).toEqual(["Leaf"]);
  }, 120_000);

  it("move_node reparents the copy under Target and reports the transform handling (REQ-C-05)", async () => {
    const result = await callTool(nodeTools, "move_node", {
      node_path: copyName,
      new_parent_path: "Target",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      node_path: `Target/${copyName}`,
      parent_path: "Target",
      index: 0,
      transform_handling: "kept_global_transform",
    });
    const root = await tree();
    expect(childNames(root)).toEqual(["Branch", "Target"]);
    expect(childNames(findChild(root, "Target")!)).toEqual([copyName]);
  }, 120_000);

  it("move_node reorders siblings in place with the transform untouched (REQ-C-05)", async () => {
    const result = await callTool(nodeTools, "move_node", { node_path: "Branch", index: 1 });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      node_path: "Branch",
      parent_path: ".",
      index: 1,
      transform_handling: "unchanged",
    });
    expect(childNames(await tree())).toEqual(["Target", "Branch"]);
  }, 120_000);

  it("rename_node returns the new path for the renamed subtree (REQ-C-05)", async () => {
    const result = await callTool(nodeTools, "rename_node", {
      node_path: `Target/${copyName}`,
      new_name: "RenamedBranch",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      node_path: "Target/RenamedBranch",
      name: "RenamedBranch",
      old_path: `Target/${copyName}`,
    });
    const root = await tree();
    expect(childNames(findChild(root, "Target")!)).toEqual(["RenamedBranch"]);
  }, 120_000);

  it("remove_node manifests the removed subtree, and undo restores it intact (REQ-M-04/M-05)", async () => {
    const result = await callTool(nodeTools, "remove_node", { node_path: "Target/RenamedBranch" });
    expect(result.isError).toBeUndefined();
    const outcome = result.structuredContent as {
      node_path: string;
      removed_subtree: RemovedEntry[];
      removed_count: number;
    };
    expect(outcome.node_path).toBe("Target/RenamedBranch");
    expect(outcome.removed_count).toBe(2);
    expect(outcome.removed_subtree).toEqual([
      { path: "Target/RenamedBranch", name: "RenamedBranch", type: "Node2D" },
      { path: "Target/RenamedBranch/Leaf", name: "Leaf", type: "Sprite2D" },
    ]);

    // Gone from the tree and (after save) from disk.
    expect(childNames(findChild(await tree(), "Target")!)).toEqual([]);
    expect((await callTool(sceneTools, "save_scene")).isError).toBeFalsy();
    expect(onDisk()).not.toContain('name="RenamedBranch"');

    // Ctrl+Z: the whole subtree comes back, and re-serializes - the owner
    // links were restored, not just the nodes (REQ-M-05 + REQ-M-04's intent).
    const undone = await bridge.request("edit/undo", {});
    expect((undone as { stepped: boolean }).stepped).toBe(true);
    const restoredRoot = await tree();
    const restored = findChild(findChild(restoredRoot, "Target")!, "RenamedBranch");
    expect(restored).toBeDefined();
    expect(childNames(restored!)).toEqual(["Leaf"]);
    expect((await callTool(sceneTools, "save_scene")).isError).toBeFalsy();
    const text = onDisk();
    expect(text).toContain('name="RenamedBranch"');
    expect(text).toContain('parent="Target/RenamedBranch"'); // Leaf re-owned and re-serialized

    // Redo removes it again - the registration is a real two-way action.
    const redone = await bridge.request("edit/redo", {});
    expect((redone as { stepped: boolean }).stepped).toBe(true);
    expect((await callTool(sceneTools, "save_scene")).isError).toBeFalsy();
    expect(onDisk()).not.toContain('name="RenamedBranch"');
  }, 120_000);

  it("invalid targets are rejected before any mutation (REQ-C-05)", async () => {
    const before = await tree();

    const ghost = await callTool(nodeTools, "remove_node", { node_path: "Ghost" });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0]!.text).toContain("No node exists at node_path");

    const cycle = await callTool(nodeTools, "move_node", {
      node_path: "Branch",
      new_parent_path: "Branch/Leaf",
    });
    expect(cycle.isError).toBe(true);
    expect(cycle.content[0]!.text).toContain("its own subtree");

    const moveRoot = await callTool(nodeTools, "move_node", { node_path: ".", index: 0 });
    expect(moveRoot.isError).toBe(true);
    expect(moveRoot.content[0]!.text).toContain("scene root cannot be moved");

    const removeRoot = await callTool(nodeTools, "remove_node", { node_path: "." });
    expect(removeRoot.isError).toBe(true);
    expect(removeRoot.content[0]!.text).toContain("scene root cannot be removed");

    const badName = await callTool(nodeTools, "rename_node", {
      node_path: "Branch",
      new_name: "a/b",
    });
    expect(badName.isError).toBe(true);
    expect(badName.content[0]!.text).toContain("cannot hold");

    // None of the rejects touched the scene.
    expect(await tree()).toEqual(before);
  }, 120_000);
});
