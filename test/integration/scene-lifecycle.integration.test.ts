import { existsSync, readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { SERVER_VERSION } from "../../src/server.js";
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

async function callScene(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createSceneTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe.runIf(hasGodot)("scene lifecycle against the sample project (REQ-C-01/02/03)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;

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
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  const SCENE = "res://mcp_test/level.tscn";

  it("create_scene writes a .tscn with the chosen root and opens it clean (REQ-C-01)", async () => {
    const result = await callScene(bridge, "create_scene", {
      scene_path: SCENE,
      root_node_type: "Node2D",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ scene_path: SCENE, created: true });

    // Independent readback: the file exists on disk and holds a Node2D root.
    const onDisk = path.join(projectDir, "mcp_test", "level.tscn");
    expect(existsSync(onDisk)).toBe(true);
    expect(readFileSync(onDisk, "utf8")).toContain('type="Node2D"');

    // It is the current scene and starts clean.
    const open = await callScene(bridge, "get_open_scenes");
    expect(open.structuredContent).toMatchObject({ current: SCENE });
    const scenes = (open.structuredContent as { scenes: Array<{ path: string; dirty: boolean }> })
      .scenes;
    expect(scenes.find((s) => s.path === SCENE)!.dirty).toBe(false);
  });

  it("refuses to overwrite an existing scene (REQ-C-01)", async () => {
    const result = await callScene(bridge, "create_scene", { scene_path: SCENE });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("already exists");
  });

  it("dirty flag flips true after an edit and clears after save (REQ-C-02)", async () => {
    // scene/mark_unsaved is the internal dirty producer this slice ships (node
    // ops arrive in #69). Drive it directly over the bridge.
    await bridge.request("scene/mark_unsaved", {});
    let open = await callScene(bridge, "get_open_scenes");
    let scenes = (open.structuredContent as { scenes: Array<{ path: string; dirty: boolean }> })
      .scenes;
    expect(scenes.find((s) => s.path === SCENE)!.dirty).toBe(true);

    const saved = await callScene(bridge, "save_scene");
    expect(saved.isError).toBeFalsy();
    expect((saved.structuredContent as { saved: string[] }).saved).toContain(SCENE);

    open = await callScene(bridge, "get_open_scenes");
    scenes = (open.structuredContent as { scenes: Array<{ path: string; dirty: boolean }> }).scenes;
    expect(scenes.find((s) => s.path === SCENE)!.dirty).toBe(false);
  });

  it("close_scene refuses a dirty scene, then closes with discard (REQ-C-03)", async () => {
    await bridge.request("scene/mark_unsaved", {});
    const refused = await callScene(bridge, "close_scene", { scene_path: SCENE });
    expect(refused.isError).toBe(true);
    expect(refused.content[0]!.text).toContain("unsaved changes");

    const closed = await callScene(bridge, "close_scene", { scene_path: SCENE, discard: true });
    expect(closed.isError).toBeFalsy();

    // Independent readback: the tab is gone.
    const open = await callScene(bridge, "get_open_scenes");
    const scenes = (open.structuredContent as { scenes: Array<{ path: string }> }).scenes;
    expect(scenes.some((s) => s.path === SCENE)).toBe(false);
  });

  it("open_scene re-opens a saved scene and makes it current (REQ-C-03)", async () => {
    const result = await callScene(bridge, "open_scene", { scene_path: SCENE });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({ current: SCENE });
    const open = await callScene(bridge, "get_open_scenes");
    expect(open.structuredContent).toMatchObject({ current: SCENE });
  });

  it("rejects an escaping scene_path server-side (REQ-M-01)", async () => {
    const result = await callScene(bridge, "create_scene", { scene_path: "../../etc/passwd.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("outside the project root");
    // Nothing was written outside the project.
    expect(existsSync(path.join(projectDir, "..", "..", "etc", "passwd.tscn"))).toBe(false);
  });
});
