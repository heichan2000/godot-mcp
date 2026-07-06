import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createProjectTools } from "../../src/tools/project.js";
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
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createProjectTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe.runIf(hasGodot)("project reads against the sample project (REQ-B-02/B-05)", () => {
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

  it("get_project_info reports the sample project's real metadata", async () => {
    const result = await callTool(bridge, "get_project_info");
    expect(result.isError).toBeFalsy();
    const info = result.structuredContent!;
    expect(info.name).toBe("godot-mcp Sample Project");
    expect(String(info.godot_version_string)).toMatch(/^4\.\d+/);
    // The sample ships scenes/ (meshes.tscn, print_marker.tscn) and scripts/.
    const counts = info.file_counts as { total: number; scenes: number; scripts: number };
    expect(counts.total).toBeGreaterThan(0);
    expect(counts.scenes).toBeGreaterThanOrEqual(2);
    expect(counts.scripts).toBeGreaterThanOrEqual(1);
    expect(Array.isArray(info.autoloads)).toBe(true);
  });

  it("list_resources returns the sample's files with types and a uid where present", async () => {
    const result = await callTool(bridge, "list_resources");
    expect(result.isError).toBeFalsy();
    const resources = result.structuredContent!.resources as Array<{
      path: string;
      type: string;
      uid?: string;
    }>;
    const byPath = new Map(resources.map((r) => [r.path, r]));
    expect(byPath.has("res://scenes/print_marker.tscn")).toBe(true);
    expect(byPath.get("res://scenes/print_marker.tscn")!.type).toBe("PackedScene");
    const script = byPath.get("res://scripts/print_marker.gd");
    expect(script?.type).toBe("GDScript");
    expect(typeof script?.uid).toBe("string"); // sample ships print_marker.gd.uid
    const sprite = byPath.get("res://textures/sprite.png");
    expect(sprite?.type).toMatch(/Texture/);
  });

  it("list_resources honors a directory filter", async () => {
    const result = await callTool(bridge, "list_resources", { directory: "res://scenes" });
    const resources = result.structuredContent!.resources as Array<{ path: string }>;
    expect(resources.length).toBeGreaterThan(0);
    expect(resources.every((r) => r.path.startsWith("res://scenes"))).toBe(true);
  });
});
