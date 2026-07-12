import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import type { ToolDescriptor } from "../../src/registry.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createNodeTools } from "../../src/tools/node.js";
import { createPropertyTools } from "../../src/tools/properties.js";
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

const SCENE = "res://mcp_test/props.tscn";
const TEXTURE = "res://textures/sprite.png";
const POSITION_TEXT = "Vector2(100, 50)";

async function callTool(
  tools: ToolDescriptor[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe.runIf(hasGodot)("node properties against the sample project (REQ-C-06/M-05)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let sceneTools: ReturnType<typeof createSceneTools>;
  let nodeTools: ReturnType<typeof createNodeTools>;
  let propertyTools: ReturnType<typeof createPropertyTools>;

  function onDisk(): string {
    return readFileSync(path.join(projectDir, "mcp_test", "props.tscn"), "utf8");
  }

  async function readProps(args: Record<string, unknown>): Promise<Record<string, unknown>> {
    const result = await callTool(propertyTools, "read_node_properties", args);
    expect(result.isError).toBeUndefined();
    return (result.structuredContent as { properties: Record<string, unknown> }).properties;
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
    propertyTools = createPropertyTools({ bridge });
    const created = await callTool(sceneTools, "create_scene", {
      scene_path: SCENE,
      root_node_type: "Node2D",
    });
    expect(created.isError).toBeFalsy();
    const added = await callTool(nodeTools, "add_node", {
      node_type: "Sprite2D",
      node_name: "Hero",
    });
    expect(added.isError).toBeFalsy();
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("one set call decodes a text form and loads a texture from res:// (REQ-C-06, absorbs load_sprite)", async () => {
    const result = await callTool(propertyTools, "set_node_properties", {
      node_path: "Hero",
      properties: { position: POSITION_TEXT, texture: TEXTURE },
    });
    expect(result.isError).toBeUndefined();
    const props = (result.structuredContent as { properties: Record<string, unknown> }).properties;
    expect(props.position).toBe(POSITION_TEXT);
    expect(String(props.texture)).toContain("Resource(");
    expect(String(props.texture)).toContain(TEXTURE);
  }, 120_000);

  it("named get returns both values through the codec (REQ-C-06)", async () => {
    const result = await callTool(propertyTools, "read_node_properties", {
      node_path: "Hero",
      properties: ["position", "texture"],
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ node_path: "Hero", node_type: "Sprite2D" });
    const props = (result.structuredContent as { properties: Record<string, unknown> }).properties;
    expect(props.position).toBe(POSITION_TEXT);
    expect(String(props.texture)).toContain(TEXTURE);
  }, 120_000);

  it("default get returns the non-default state including both set properties (REQ-C-06)", async () => {
    const props = await readProps({ node_path: "Hero" });
    expect(props.position).toBe(POSITION_TEXT);
    expect(String(props.texture)).toContain(TEXTURE);
    // Untouched defaults are NOT in the non-default state.
    expect(props).not.toHaveProperty("visible");
  }, 120_000);

  it("the set persists identically through save + close + reopen (REQ-C-06)", async () => {
    expect((await callTool(sceneTools, "save_scene")).isError).toBeFalsy();
    const text = onDisk();
    expect(text).toContain("position = Vector2(100, 50)");
    expect(text).toContain("texture = ExtResource(");
    expect((await callTool(sceneTools, "close_scene", { scene_path: SCENE })).isError).toBeFalsy();
    expect((await callTool(sceneTools, "open_scene", { scene_path: SCENE })).isError).toBeFalsy();
    const props = await readProps({ node_path: "Hero", properties: ["position", "texture"] });
    expect(props.position).toBe(POSITION_TEXT);
    expect(String(props.texture)).toContain(TEXTURE);
  }, 120_000);

  it("undo reverts the whole batch in one step; redo restores it (REQ-M-05)", async () => {
    // Re-establish the batch as the newest action in THIS scene's history
    // (the reopened scene has a fresh history).
    const set = await callTool(propertyTools, "set_node_properties", {
      node_path: "Hero",
      properties: { position: "Vector2(7, 7)", texture: null },
    });
    expect(set.isError).toBeUndefined();
    const undone = await bridge.request("edit/undo", {});
    expect((undone as { stepped: boolean }).stepped).toBe(true);
    let props = await readProps({ node_path: "Hero", properties: ["position", "texture"] });
    expect(props.position).toBe(POSITION_TEXT);
    expect(String(props.texture)).toContain(TEXTURE);
    const redone = await bridge.request("edit/redo", {});
    expect((redone as { stepped: boolean }).stepped).toBe(true);
    props = await readProps({ node_path: "Hero", properties: ["position", "texture"] });
    expect(props.position).toBe("Vector2(7, 7)");
    expect(props.texture).toBeNull();
    // Leave the scene back in the saved state for the rejection sweep.
    const restored = await bridge.request("edit/undo", {});
    expect((restored as { stepped: boolean }).stepped).toBe(true);
  }, 120_000);

  it("invalid sets are rejected before any mutation (REQ-C-06)", async () => {
    const unknown = await callTool(propertyTools, "set_node_properties", {
      node_path: "Hero",
      properties: { positon: "Vector2(1, 1)" },
    });
    expect(unknown.isError).toBe(true);
    expect(unknown.content[0]!.text).toContain("Valid properties:");
    expect(unknown.content[0]!.text).toContain("position");

    // Type-directed rule: a res:// string into a String-typed property stays literal.
    const literal = await callTool(propertyTools, "set_node_properties", {
      node_path: "Hero",
      properties: { editor_description: TEXTURE },
    });
    expect(literal.isError).toBeUndefined();
    const desc = await readProps({ node_path: "Hero", properties: ["editor_description"] });
    expect(desc.editor_description).toBe(TEXTURE);

    const missing = await callTool(propertyTools, "set_node_properties", {
      node_path: "Hero",
      properties: { texture: "res://textures/missing.png" },
    });
    expect(missing.isError).toBe(true);
    expect(missing.content[0]!.text).toContain("No resource exists");

    const escape = await callTool(propertyTools, "set_node_properties", {
      node_path: "Hero",
      properties: { texture: "res://../outside.png" },
    });
    expect(escape.isError).toBe(true);
    expect(escape.content[0]!.text).toContain("not a valid in-project");

    const mismatch = await callTool(propertyTools, "set_node_properties", {
      node_path: "Hero",
      properties: { texture: "res://scenes/print_marker.tscn" },
    });
    expect(mismatch.isError).toBe(true);
    expect(mismatch.content[0]!.text).toContain("expects");

    const nullOnValue = await callTool(propertyTools, "set_node_properties", {
      node_path: "Hero",
      properties: { position: null },
    });
    expect(nullOnValue.isError).toBe(true);
    expect(nullOnValue.content[0]!.text).toContain("Object-typed");

    const ghost = await callTool(propertyTools, "read_node_properties", { node_path: "Ghost" });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0]!.text).toContain("No node exists at node_path");

    // None of the rejects moved the node.
    const props = await readProps({ node_path: "Hero", properties: ["position"] });
    expect(props.position).toBe(POSITION_TEXT);
  }, 120_000);
});
