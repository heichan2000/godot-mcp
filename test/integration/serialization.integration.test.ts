import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import type { ToolDescriptor } from "../../src/registry.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createNodeTools } from "../../src/tools/node.js";
import { createPropertyTools } from "../../src/tools/properties.js";
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
  tools: ToolDescriptor[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

/**
 * REQ-A-12 real-op half (#76): a Promise.all burst of 10 mutating tool calls
 * against the live editor executes serially in arrival order. Calls 2-5 are
 * order-DEPENDENT (rename A->B, then add/set/duplicate under B): any
 * reordering makes them fail on a missing node, so 10 successes + one exact
 * final tree IS the serialization proof. Two rounds on fresh scenes pin
 * "the same scene every run".
 */
describe.runIf(hasGodot)("real-op serialization burst (REQ-A-12)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let tools: ToolDescriptor[];

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
      requestTimeoutMs: 60_000,
      reconnectDelayMs: 500,
      log: (message) => {
        if (process.env.DEBUG) console.error(message);
      },
    });
    bridge.start();
    await bridge.waitForState("connected", 150_000);
    tools = [
      ...createSceneTools({ bridge }),
      ...createNodeTools({ bridge }),
      ...createPropertyTools({ bridge }),
    ];
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  /** Fires the 10-call burst on a fresh scene; returns the final tree + C's position. */
  async function burstRound(scenePath: string): Promise<{ tree: SceneTreeNode; cPos: string }> {
    const created = await callTool(tools, "create_scene", {
      scene_path: scenePath,
      root_node_type: "Node2D",
    });
    expect(created.isError).toBeFalsy();

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "add_node", args: { node_type: "Node2D", node_name: "A" } },
      { name: "rename_node", args: { node_path: "A", new_name: "B" } },
      { name: "add_node", args: { node_type: "Node2D", parent_path: "B", node_name: "C" } },
      {
        name: "set_node_properties",
        args: { node_path: "B/C", properties: { position: "Vector2(3, 4)" } },
      },
      { name: "duplicate_node", args: { node_path: "B/C", new_name: "C2" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P1" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P2" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P3" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P4" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P5" } },
    ];

    // The burst: all 10 in flight at once, completion order recorded.
    const completionOrder: number[] = [];
    const results = await Promise.all(
      calls.map((call, index) =>
        callTool(tools, call.name, call.args).then((result) => {
          completionOrder.push(index);
          return result;
        }),
      ),
    );

    results.forEach((result, index) => {
      expect(
        result.isError,
        `burst call ${index} (${calls[index]!.name}) failed: ${result.content?.[0]?.text}`,
      ).toBeFalsy();
    });
    // FIFO end-to-end: replies land in send order.
    expect(completionOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const treeResult = await callTool(tools, "get_scene_tree");
    expect(treeResult.isError).toBeUndefined();
    const tree = (treeResult.structuredContent as { tree: SceneTreeNode }).tree;

    const propsResult = await callTool(tools, "read_node_properties", {
      node_path: "B/C",
      properties: ["position"],
    });
    expect(propsResult.isError).toBeUndefined();
    const cPos = String(
      (propsResult.structuredContent as { properties: Record<string, unknown> }).properties
        .position,
    );
    return { tree, cPos };
  }

  it("a 10-call concurrent mutating burst lands serially in arrival order, twice, identically", async () => {
    const first = await burstRound("res://mcp_test/burst_a.tscn");
    const second = await burstRound("res://mcp_test/burst_b.tscn");

    for (const round of [first, second]) {
      expect(round.tree.children.map((child) => child.name)).toEqual([
        "B",
        "P1",
        "P2",
        "P3",
        "P4",
        "P5",
      ]);
      const b = round.tree.children.find((child) => child.name === "B")!;
      expect(b.children.map((child) => child.name)).toEqual(["C", "C2"]);
      expect(round.cPos).toBe("Vector2(3, 4)");
    }
    // Same scene every run: the rounds are structurally identical below the
    // (scene-named) roots.
    expect(JSON.stringify(first.tree.children)).toBe(JSON.stringify(second.tree.children));
  }, 300_000);
});
