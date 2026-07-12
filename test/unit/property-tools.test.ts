import { afterEach, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { createPropertyTools } from "../../src/tools/properties.js";
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

/** A connected bridge fronting the given op handlers, plus the peer for request inspection. */
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

/** A bridge that can never connect - the REQ-A-04/A-10 error path. */
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

async function callProps(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createPropertyTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe("read_node_properties", () => {
  it("default mode forwards only node_path and returns the non-default state", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "node/get_properties": (params) => {
        seen = params;
        return {
          node_path: "Hero",
          node_type: "Sprite2D",
          properties: {
            position: "Vector2(100, 50)",
            texture: 'Resource("res://textures/sprite.png")',
          },
        };
      },
    });
    const result = await callProps(bridge, "read_node_properties", { node_path: "Hero" });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ node_path: "Hero" });
    expect(result.structuredContent).toMatchObject({
      node_path: "Hero",
      node_type: "Sprite2D",
      properties: { position: "Vector2(100, 50)" },
    });
  });

  it("named mode forwards the properties list", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "node/get_properties": (params) => {
        seen = params;
        return {
          node_path: "Hero",
          node_type: "Sprite2D",
          properties: { visible: true, z_index: 0 },
        };
      },
    });
    const result = await callProps(bridge, "read_node_properties", {
      node_path: "Hero",
      properties: ["visible", "z_index"],
    });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ node_path: "Hero", properties: ["visible", "z_index"] });
    expect(result.structuredContent).toMatchObject({ properties: { visible: true, z_index: 0 } });
  });

  it("surfaces the addon's unknown_property refusal with the valid-names list", async () => {
    const { bridge } = await connectedPeer({
      "node/get_properties": () =>
        errorOutcome({
          code: "unknown_property",
          message:
            "'positon' is not a property of Sprite2D. Valid properties: modulate, position, texture",
          possibleSolutions: ["Pick one of the listed names."],
        }),
    });
    const result = await callProps(bridge, "read_node_properties", {
      node_path: "Hero",
      properties: ["positon"],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Valid properties:");
    expect(result.content[0]!.text).toContain("position");
  });

  it("surfaces the addon's node_not_found refusal as a guided error", async () => {
    const { bridge } = await connectedPeer({
      "node/get_properties": () =>
        errorOutcome({
          code: "node_not_found",
          message: "No node exists at node_path 'Ghost'.",
          possibleSolutions: ["Read the tree with get_scene_tree to see valid node paths."],
        }),
    });
    const result = await callProps(bridge, "read_node_properties", { node_path: "Ghost" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No node exists at node_path");
  });

  it("turns a malformed addon payload into a guided error (REQ-A-08)", async () => {
    const { bridge } = await connectedPeer({
      "node/get_properties": () => ({ unexpected: true }),
    });
    const result = await callProps(bridge, "read_node_properties", { node_path: "Hero" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("malformed");
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callProps(deadBridge(), "read_node_properties", { node_path: "Hero" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not connected");
  });
});

describe("set_node_properties", () => {
  it("forwards the batch untouched and returns the post-set read-back", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "node/set_properties": (params) => {
        seen = params;
        return {
          node_path: "Hero",
          properties: {
            position: "Vector2(100, 50)",
            texture: 'Resource("res://textures/sprite.png")',
            visible: false,
          },
        };
      },
    });
    const result = await callProps(bridge, "set_node_properties", {
      node_path: "Hero",
      properties: {
        position: "Vector2(100, 50)",
        texture: "res://textures/sprite.png",
        visible: false,
      },
    });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({
      node_path: "Hero",
      properties: {
        position: "Vector2(100, 50)",
        texture: "res://textures/sprite.png",
        visible: false,
      },
    });
    expect(result.structuredContent).toMatchObject({
      node_path: "Hero",
      properties: { position: "Vector2(100, 50)", visible: false },
    });
  });

  it("forwards null values (clears an Object-typed property)", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "node/set_properties": (params) => {
        seen = params;
        return { node_path: "Hero", properties: { texture: null } };
      },
    });
    const result = await callProps(bridge, "set_node_properties", {
      node_path: "Hero",
      properties: { texture: null },
    });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ node_path: "Hero", properties: { texture: null } });
  });

  it("rejects an empty properties object without bridge traffic", async () => {
    const { peer, bridge } = await connectedPeer({});
    const result = await callProps(bridge, "set_node_properties", {
      node_path: "Hero",
      properties: {},
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("at least one");
    expect(peer.requests).toHaveLength(0);
  });

  it("surfaces the addon's resource_type_mismatch refusal as a guided error", async () => {
    const { bridge } = await connectedPeer({
      "node/set_properties": () =>
        errorOutcome({
          code: "resource_type_mismatch",
          message:
            "res://scenes/print_marker.tscn is a PackedScene, but property 'texture' expects Texture2D.",
          possibleSolutions: ["Pick a resource of the expected type."],
        }),
    });
    const result = await callProps(bridge, "set_node_properties", {
      node_path: "Hero",
      properties: { texture: "res://scenes/print_marker.tscn" },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("expects Texture2D");
  });

  it("surfaces the addon's invalid_value refusal for null on a value-typed property", async () => {
    const { bridge } = await connectedPeer({
      "node/set_properties": () =>
        errorOutcome({
          code: "invalid_value",
          message: "null can only clear Object-typed properties; 'position' is not one.",
          possibleSolutions: ["Send a value of the property's type instead."],
        }),
    });
    const result = await callProps(bridge, "set_node_properties", {
      node_path: "Hero",
      properties: { position: null },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("Object-typed");
  });

  it("turns a malformed addon payload into a guided error (REQ-A-08)", async () => {
    const { bridge } = await connectedPeer({
      "node/set_properties": () => ({ nope: 1 }),
    });
    const result = await callProps(bridge, "set_node_properties", {
      node_path: "Hero",
      properties: { visible: true },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("malformed");
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callProps(deadBridge(), "set_node_properties", {
      node_path: "Hero",
      properties: { visible: true },
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not connected");
  });
});
