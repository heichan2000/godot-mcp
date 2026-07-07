import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { createSceneTools } from "../../src/tools/scene.js";
import { FakeAddonPeer, errorOutcome } from "../support/fake-addon-peer.js";

const SERVER_VERSION = "2.0.0-alpha.0";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A real, existing temp dir to stand in for the connected project root so the
 *  server-side assertInsideRoot check resolves (it realpaths this root). */
function tempProjectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-scene-unit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

type Handlers = NonNullable<Parameters<typeof FakeAddonPeer.start>[0]>["handlers"];

/** A connected bridge whose handshake advertises `projectPath` as project_path. */
async function connectedBridge(
  handlers: Handlers,
  projectPath: string = tempProjectDir(),
): Promise<BridgeConnection> {
  const peer = await FakeAddonPeer.start({
    handlers,
    helloOverrides: { project_path: projectPath },
  });
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

/** A bridge that never connects (dead port) — exercises disconnected + pre-bridge containment. */
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

describe("create_scene", () => {
  it("forwards the contained res:// path and root type, returns created", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "scene/create": (params) => {
        seen = params;
        return { scene_path: "res://levels/one.tscn", root_node_type: "Node2D", created: true };
      },
    });
    const result = await callScene(bridge, "create_scene", {
      scene_path: "levels/one.tscn",
      root_node_type: "Node2D",
    });
    expect(result.isError).toBeUndefined();
    expect(seen).toMatchObject({ scene_path: "res://levels/one.tscn", root_node_type: "Node2D" });
    expect(result.structuredContent).toMatchObject({
      scene_path: "res://levels/one.tscn",
      root_node_type: "Node2D",
      created: true,
    });
  });

  it("defaults the root type to Node when omitted", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "scene/create": (params) => {
        seen = params;
        return { scene_path: "res://a.tscn", root_node_type: "Node", created: true };
      },
    });
    await callScene(bridge, "create_scene", { scene_path: "res://a.tscn" });
    expect(seen).toMatchObject({ scene_path: "res://a.tscn", root_node_type: "Node" });
  });

  it("rejects an escaping scene_path server-side, before the bridge", async () => {
    // deadBridge never connects; a bridge error would surface as not-connected.
    // A containment error here proves the check ran BEFORE bridge.request.
    const result = await callScene(deadBridge(), "create_scene", { scene_path: "../evil.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("outside the project root");
  });

  it("rejects an absolute scene_path server-side", async () => {
    const result = await callScene(deadBridge(), "create_scene", { scene_path: "/etc/passwd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("absolute");
  });

  it("surfaces the addon's overwrite refusal as a guided error", async () => {
    const bridge = await connectedBridge({
      "scene/create": () =>
        errorOutcome({
          code: "scene_exists",
          message: "A scene already exists at res://a.tscn.",
          possibleSolutions: ["Choose a different scene_path, or open the existing scene."],
        }),
    });
    const result = await callScene(bridge, "create_scene", { scene_path: "res://a.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("already exists");
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callScene(deadBridge(), "create_scene", { scene_path: "res://a.tscn" });
    expect(result.isError).toBe(true);
    const solutions = (result.structuredContent as unknown as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("@cradial/godot-mcp@1.x");
  });
});

describe("open_scene", () => {
  it("opens the contained scene and reports it current", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "scene/open": (params) => {
        seen = params;
        return { scene_path: "res://scenes/main.tscn", current: "res://scenes/main.tscn" };
      },
    });
    const result = await callScene(bridge, "open_scene", { scene_path: "scenes/main.tscn" });
    expect(result.isError).toBeUndefined();
    expect(seen).toMatchObject({ scene_path: "res://scenes/main.tscn" });
    expect(result.structuredContent).toMatchObject({ current: "res://scenes/main.tscn" });
  });

  it("surfaces the addon's not-found refusal as a guided error", async () => {
    const bridge = await connectedBridge({
      "scene/open": () =>
        errorOutcome({
          code: "scene_not_found",
          message: "No scene exists at res://missing.tscn.",
          possibleSolutions: ["Create it with create_scene, or check the path."],
        }),
    });
    const result = await callScene(bridge, "open_scene", { scene_path: "res://missing.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No scene exists");
  });

  it("rejects an escaping scene_path before the bridge", async () => {
    const result = await callScene(deadBridge(), "open_scene", { scene_path: "res://../x.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("outside the project root");
  });
});

describe("get_open_scenes", () => {
  it("reports the current scene and per-scene dirty flags", async () => {
    const bridge = await connectedBridge({
      "scene/list_open": () => ({
        current: "res://a.tscn",
        scenes: [
          { path: "res://a.tscn", dirty: true },
          { path: "res://b.tscn", dirty: false },
        ],
        count: 2,
      }),
    });
    const result = await callScene(bridge, "get_open_scenes");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ current: "res://a.tscn", count: 2 });
    const scenes = (result.structuredContent as { scenes: Array<{ path: string; dirty: boolean }> })
      .scenes;
    expect(scenes.find((s) => s.path === "res://a.tscn")!.dirty).toBe(true);
  });

  it("reports current as null when no scene is open", async () => {
    const bridge = await connectedBridge({
      "scene/list_open": () => ({ current: null, scenes: [], count: 0 }),
    });
    const result = await callScene(bridge, "get_open_scenes");
    expect(result.structuredContent).toMatchObject({ current: null, count: 0 });
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callScene(deadBridge(), "get_open_scenes");
    expect(result.isError).toBe(true);
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("@cradial/godot-mcp@1.x");
  });
});

describe("save_scene", () => {
  it("saves the current scene and reports it clean", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "scene/save": (params) => {
        seen = params;
        return { saved: ["res://a.tscn"], current: "res://a.tscn", all: false };
      },
    });
    const result = await callScene(bridge, "save_scene");
    expect(result.isError).toBeUndefined();
    expect(seen).toMatchObject({ all: false });
    expect(result.structuredContent).toMatchObject({ saved: ["res://a.tscn"], all: false });
  });

  it("forwards a contained new_path for save-as", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "scene/save": (params) => {
        seen = params;
        return { saved: ["res://copy.tscn"], current: "res://copy.tscn", all: false };
      },
    });
    await callScene(bridge, "save_scene", { new_path: "copy.tscn" });
    expect(seen).toMatchObject({ new_path: "res://copy.tscn" });
  });

  it("forwards all:true to save every open scene", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "scene/save": (params) => {
        seen = params;
        return { saved: ["res://a.tscn", "res://b.tscn"], current: "res://a.tscn", all: true };
      },
    });
    const result = await callScene(bridge, "save_scene", { all: true });
    expect(seen).toMatchObject({ all: true });
    expect((result.structuredContent as { saved: string[] }).saved).toHaveLength(2);
  });

  it("rejects an escaping new_path before the bridge", async () => {
    const result = await callScene(deadBridge(), "save_scene", { new_path: "../out.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("outside the project root");
  });
});

describe("close_scene", () => {
  it("closes the named scene and reports the new current", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "scene/close": (params) => {
        seen = params;
        return { scene_path: "res://a.tscn", closed: true, current: "res://b.tscn" };
      },
    });
    const result = await callScene(bridge, "close_scene", { scene_path: "a.tscn" });
    expect(result.isError).toBeUndefined();
    expect(seen).toMatchObject({ scene_path: "res://a.tscn", discard: false });
    expect(result.structuredContent).toMatchObject({ closed: true, current: "res://b.tscn" });
  });

  it("forwards discard:true so a dirty scene can be closed", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "scene/close": (params) => {
        seen = params;
        return { scene_path: "res://a.tscn", closed: true, current: null };
      },
    });
    await callScene(bridge, "close_scene", { scene_path: "res://a.tscn", discard: true });
    expect(seen).toMatchObject({ discard: true });
  });

  it("surfaces the addon's unsaved-changes refusal as a guided error", async () => {
    const bridge = await connectedBridge({
      "scene/close": () =>
        errorOutcome({
          code: "unsaved_changes",
          message: "res://a.tscn has unsaved changes.",
          possibleSolutions: ["Save it with save_scene first, or pass discard:true to lose them."],
        }),
    });
    const result = await callScene(bridge, "close_scene", { scene_path: "res://a.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("unsaved changes");
  });
});
