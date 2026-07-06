import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectTools } from "../../src/tools/project.js";
import type { BridgePort } from "../../src/tools/bridge.js";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { FakeAddonPeer } from "../support/fake-addon-peer.js";

const SERVER_VERSION = "2.0.0-alpha.0";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-project-unit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A bridge stub that fails loudly if list_projects ever touches it (it must not). */
const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
    reconnectAttempts: 0,
  }),
  request: async () => {
    throw new Error("list_projects must not touch the bridge");
  },
  traffic: () => [],
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function tool(name: string) {
  const tools = createProjectTools({ bridge: stubBridge });
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

async function callList(args: Record<string, unknown>): Promise<ToolResult> {
  return (await tool("list_projects").handler(args, {} as never)) as ToolResult;
}

/** Writes a minimal project.godot with a name + features tag. */
function writeProject(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "project.godot"),
    `config_version=5\n\n[application]\n\nconfig/name="${name}"\nconfig/features=PackedStringArray("${version}", "Forward Plus")\n`,
    "utf8",
  );
}

/** A connected BridgeConnection backed by a FakeAddonPeer with the given op handlers. */
async function connectedBridge(
  handlers: NonNullable<Parameters<typeof FakeAddonPeer.start>[0]>["handlers"],
): Promise<BridgeConnection> {
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

/** A BridgeConnection that never connects (dead port) — exercises disconnected-tool behavior. */
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

function bridgeTool(bridge: BridgeConnection, name: string) {
  const tools = createProjectTools({ bridge });
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

async function callBridge(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  return (await bridgeTool(bridge, name).handler(args as never, {} as never)) as ToolResult;
}

const PROJECT_INFO_PAYLOAD = {
  name: "Sample Game",
  main_scene: "res://scenes/main.tscn",
  features: ["4.5", "Forward Plus"],
  godot_version: { major: 4, minor: 5, patch: 1, status: "stable" },
  godot_version_string: "4.5.1.stable",
  autoloads: [{ name: "GameState", path: "res://autoload/game_state.gd" }],
  file_counts: { total: 7, scenes: 2, scripts: 3, resources: 2 },
};

describe("get_project_info", () => {
  it("returns the connected project's info over the bridge", async () => {
    const bridge = await connectedBridge({ "project/info": () => PROJECT_INFO_PAYLOAD });
    const result = await callBridge(bridge, "get_project_info");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      name: "Sample Game",
      main_scene: "res://scenes/main.tscn",
      godot_version_string: "4.5.1.stable",
    });
    const autoloads = (result.structuredContent as { autoloads: Array<{ name: string }> })
      .autoloads;
    expect(autoloads[0]!.name).toBe("GameState");
    expect(result.structuredContent).toHaveProperty("file_counts.scenes", 2);
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callBridge(deadBridge(), "get_project_info");
    expect(result.isError).toBe(true);
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("@cradial/godot-mcp@1.x");
  });

  it("maps a malformed op payload to a guided error", async () => {
    const bridge = await connectedBridge({ "project/info": () => ({ name: 123 }) });
    const result = await callBridge(bridge, "get_project_info");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("malformed");
  });
});

describe("list_projects", () => {
  it("finds nested projects with their name and version, skipping hidden/system dirs", async () => {
    const root = tempDir();
    writeProject(path.join(root, "game-a"), "Game A", "4.3");
    writeProject(path.join(root, "nested", "game-b"), "Game B", "4.5");
    // A project's own subfolders are not separate projects:
    mkdirSync(path.join(root, "game-a", "scenes"), { recursive: true });
    // Hidden + system dirs are skipped even if they contain a project.godot:
    writeProject(path.join(root, ".hidden", "ghost"), "Ghost", "4.4");
    writeProject(path.join(root, "node_modules", "dep"), "Dep", "4.4");

    const result = await callList({ directory: root });
    expect(result.isError).toBeUndefined();
    const projects = (
      result.structuredContent as {
        projects: Array<{ name: string; godot_version: string }>;
      }
    ).projects;
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(["Game A", "Game B"]);
    expect(result.structuredContent).toMatchObject({ directory: root, count: 2 });
    const gameA = projects.find((p) => p.name === "Game A")!;
    expect(gameA.godot_version).toBe("4.3");
  });

  it("honors max_depth to bound traversal", async () => {
    const root = tempDir();
    writeProject(path.join(root, "a", "b", "c", "deep"), "Deep", "4.4");
    const shallow = await callList({ directory: root, max_depth: 1 });
    expect((shallow.structuredContent as { count: number }).count).toBe(0);
    const deep = await callList({ directory: root, max_depth: 10 });
    expect((deep.structuredContent as { count: number }).count).toBe(1);
  });

  it("does not recurse when recursive is false", async () => {
    const root = tempDir();
    writeProject(path.join(root, "child"), "Child", "4.4");
    const result = await callList({ directory: root, recursive: false });
    expect((result.structuredContent as { count: number }).count).toBe(0);
  });

  it("returns a structured error for a missing directory", async () => {
    const result = await callList({ directory: path.join(tempDir(), "does-not-exist") });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("does not exist");
  });

  it("rejects a relative directory", async () => {
    const result = await callList({ directory: "relative/dir" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("absolute");
  });
});

const RESOURCES_PAYLOAD = {
  resources: [
    { path: "res://scenes/main.tscn", type: "PackedScene", uid: "uid://abc123" },
    { path: "res://textures/sprite.png", type: "CompressedTexture2D" },
    { path: "res://scripts/player.gd", type: "GDScript", uid: "uid://def456" },
  ],
  count: 3,
};

describe("list_resources", () => {
  it("returns the editor's resource listing over the bridge", async () => {
    const bridge = await connectedBridge({ "project/list_resources": () => RESOURCES_PAYLOAD });
    const result = await callBridge(bridge, "list_resources");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ count: 3 });
    const resources = (result.structuredContent as { resources: Array<{ path: string }> })
      .resources;
    expect(resources.map((r) => r.path)).toContain("res://textures/sprite.png");
  });

  it("forwards type and directory filters to the op params", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "project/list_resources": (params) => {
        seen = params;
        return { resources: [], count: 0 };
      },
    });
    await callBridge(bridge, "list_resources", { type: "PackedScene", directory: "res://scenes" });
    expect(seen).toMatchObject({ type: "PackedScene", directory: "res://scenes" });
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callBridge(deadBridge(), "list_resources");
    expect(result.isError).toBe(true);
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("@cradial/godot-mcp@1.x");
  });
});

describe("import_assets", () => {
  it("forwards named paths and returns the reimported list", async () => {
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge({
      "assets/import": (params) => {
        seen = params;
        return { scan_started: false, reimported: ["res://dropped.png"] };
      },
    });
    const result = await callBridge(bridge, "import_assets", { paths: ["res://dropped.png"] });
    expect(result.isError).toBeUndefined();
    expect(seen).toMatchObject({ paths: ["res://dropped.png"] });
    expect(result.structuredContent).toMatchObject({
      scan_started: false,
      reimported: ["res://dropped.png"],
    });
  });

  it("triggers a whole-project scan when no paths are given", async () => {
    const bridge = await connectedBridge({
      "assets/import": () => ({ scan_started: true, reimported: [] }),
    });
    const result = await callBridge(bridge, "import_assets");
    expect(result.structuredContent).toMatchObject({ scan_started: true, reimported: [] });
  });

  it("returns the structured not-connected error when no editor is attached", async () => {
    const result = await callBridge(deadBridge(), "import_assets");
    expect(result.isError).toBe(true);
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("@cradial/godot-mcp@1.x");
  });
});
