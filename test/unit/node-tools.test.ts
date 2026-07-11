import { afterEach, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { createNodeTools } from "../../src/tools/node.js";
import { FakeAddonPeer, errorOutcome } from "../support/fake-addon-peer.js";

const SERVER_VERSION = "2.0.0-alpha.0";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type Handlers = NonNullable<Parameters<typeof FakeAddonPeer.start>[0]>["handlers"];

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A connected bridge fronting the given op handlers. */
async function connectedBridge(handlers: Handlers): Promise<BridgeConnection> {
  const peer = await FakeAddonPeer.start({ handlers });
  cleanups.push(() => peer.close());
  const bridge = new BridgeConnection({
    url: peer.url,
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: 2_000,
    reconnectDelayMs: 50,
  });
  bridge.start();
  cleanups.push(() => bridge.stop());
  await bridge.waitForState("connected", 5_000);
  return bridge;
}

/** A bridge that never connects (dead port) — exercises the disconnected path. */
function deadBridge(): BridgeConnection {
  const bridge = new BridgeConnection({
    url: "ws://127.0.0.1:1",
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: 100,
    reconnectDelayMs: 5_000,
  });
  cleanups.push(() => bridge.stop());
  return bridge;
}

/** Like connectedBridge, but also exposes the peer for request inspection. */
async function connectedPeer(handlers: Handlers) {
  const peer = await FakeAddonPeer.start({ handlers });
  cleanups.push(() => peer.close());
  const bridge = new BridgeConnection({
    url: peer.url,
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: 2_000,
    reconnectDelayMs: 50,
  });
  bridge.start();
  cleanups.push(() => bridge.stop());
  await bridge.waitForState("connected", 5_000);
  return { peer, bridge };
}

async function callNode(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createNodeTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe("add_node", () => {
  it("forwards node_type, parent_path, and node_name, returns the new node path", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "node/add": (params) => {
        seen = params;
        return {
          node_path: "Player/Sword",
          name: "Sword",
          node_type: "Sprite2D",
          parent_path: "Player",
        };
      },
    });
    const result = await callNode(bridge, "add_node", {
      node_type: "Sprite2D",
      parent_path: "Player",
      node_name: "Sword",
    });
    expect(result.isError).toBeUndefined();
    expect(seen).toMatchObject({
      node_type: "Sprite2D",
      parent_path: "Player",
      node_name: "Sword",
    });
    expect(result.structuredContent).toMatchObject({
      node_path: "Player/Sword",
      name: "Sword",
      node_type: "Sprite2D",
      parent_path: "Player",
    });
  });

  it("omits parent_path and node_name when the caller does (addon applies defaults)", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "node/add": (params) => {
        seen = params;
        return { node_path: "Node2D", name: "Node2D", node_type: "Node2D", parent_path: "." };
      },
    });
    await callNode(bridge, "add_node", { node_type: "Node2D" });
    expect(seen).toEqual({ node_type: "Node2D" });
  });

  it("surfaces the addon's ClassDB gate rejection as a guided error", async () => {
    const bridge = await connectedBridge({
      "node/add": () =>
        errorOutcome({
          code: "invalid_node_type",
          message: "node_type 'Sprtouto2D' is not an instantiable Node class.",
          possibleSolutions: ["Use a concrete Node subclass such as Node, Node2D, or Control."],
        }),
    });
    const result = await callNode(bridge, "add_node", { node_type: "Sprouto2D" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not an instantiable Node class");
  });

  it("surfaces the addon's parent_not_found refusal as a guided error", async () => {
    const bridge = await connectedBridge({
      "node/add": () =>
        errorOutcome({
          code: "parent_not_found",
          message: "No node exists at parent_path 'Ghost'.",
          possibleSolutions: ['Pass a node path relative to the scene root, e.g. "." or "Player".'],
        }),
    });
    const result = await callNode(bridge, "add_node", {
      node_type: "Node2D",
      parent_path: "Ghost",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No node exists at parent_path");
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callNode(deadBridge(), "add_node", { node_type: "Node2D" });
    expect(result.isError).toBe(true);
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("@cradial/godot-mcp@1.x");
  });
});

describe("remove_node", () => {
  const manifest = [
    { path: "Enemies", name: "Enemies", type: "Node2D" },
    { path: "Enemies/Slime", name: "Slime", type: "Sprite2D" },
    { path: "Enemies/Bat", name: "Bat", type: "Sprite2D" },
  ];

  it("forwards node_path and returns the removed-subtree manifest (REQ-M-04)", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "node/remove": (params) => {
        seen = params;
        return { node_path: "Enemies", removed_subtree: manifest, removed_count: 3 };
      },
    });
    const result = await callNode(bridge, "remove_node", { node_path: "Enemies" });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ node_path: "Enemies" });
    expect(result.structuredContent).toMatchObject({
      node_path: "Enemies",
      removed_subtree: manifest,
      removed_count: 3,
    });
  });

  it("surfaces the addon's node_not_found refusal as a guided error", async () => {
    const { bridge } = await connectedPeer({
      "node/remove": () =>
        errorOutcome({
          code: "node_not_found",
          message: "No node exists at node_path 'Ghost'.",
          possibleSolutions: ["Read the tree with get_scene_tree to see valid node paths."],
        }),
    });
    const result = await callNode(bridge, "remove_node", { node_path: "Ghost" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No node exists at node_path");
  });

  it("surfaces the addon's cannot_remove_root refusal as a guided error", async () => {
    const { bridge } = await connectedPeer({
      "node/remove": () =>
        errorOutcome({
          code: "cannot_remove_root",
          message: "The scene root cannot be removed.",
          possibleSolutions: ["Remove a child of the root, or close the scene instead."],
        }),
    });
    const result = await callNode(bridge, "remove_node", { node_path: "." });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("scene root cannot be removed");
  });

  it("turns a malformed addon payload into a guided error (REQ-A-08)", async () => {
    const { bridge } = await connectedPeer({
      "node/remove": () => ({ unexpected: true }),
    });
    const result = await callNode(bridge, "remove_node", { node_path: "Enemies" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("malformed");
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callNode(deadBridge(), "remove_node", { node_path: "Enemies" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not connected");
  });
});
