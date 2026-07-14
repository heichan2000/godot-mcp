import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import type { ToolDescriptor } from "../../src/registry.js";
import { SERVER_VERSION, buildToolInventory } from "../../src/server.js";
import {
  enablePlugin,
  freshSampleProject,
  godotMinorTag,
  hasGodot,
  importPass,
  launchEditor,
  pickFreePort,
  probeGodotVersionString,
  setBridgePort,
  type EditorHandle,
} from "./support.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type?: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

// The 19 rows of PRD §6.6 (1.0 -> M1 migration map). `tool` is the SHIPPED
// registry name (the PRD's M1 column has a few stale names). Every row must be
// walked by a real, non-error tool call below, or the final ledger test fails.
interface ParityRow {
  row: number;
  legacy: string;
  tool: string;
  req: string;
}
const PARITY_ROWS: ParityRow[] = [
  { row: 1, legacy: "get_godot_version", tool: "get_godot_version", req: "REQ-A-02, A-07" },
  { row: 2, legacy: "launch_editor", tool: "install_addon", req: "REQ-A-03, A-04" },
  { row: 3, legacy: "import_project", tool: "import_assets", req: "REQ-J-01" },
  { row: 4, legacy: "list_projects", tool: "list_projects", req: "REQ-B-02" },
  { row: 5, legacy: "get_project_info", tool: "get_project_info", req: "REQ-B-02" },
  { row: 6, legacy: "run_project", tool: "run_project", req: "REQ-E-01" },
  { row: 7, legacy: "get_debug_output", tool: "get_debug_output", req: "REQ-E-03" },
  { row: 8, legacy: "stop_project", tool: "stop_project", req: "REQ-E-02" },
  { row: 9, legacy: "create_scene", tool: "create_scene", req: "REQ-C-01" },
  { row: 10, legacy: "add_node", tool: "add_node", req: "REQ-C-04" },
  { row: 11, legacy: "load_sprite", tool: "set_node_properties", req: "REQ-C-06" },
  { row: 12, legacy: "save_scene", tool: "save_scene", req: "REQ-C-02" },
  { row: 13, legacy: "export_mesh_library", tool: "export_mesh_library", req: "REQ-G-01" },
  { row: 14, legacy: "get_uid", tool: "get_uid", req: "REQ-B-08" },
  { row: 15, legacy: "update_project_uids", tool: "update_project_uids", req: "REQ-B-09" },
  { row: 16, legacy: "get_scene_tree", tool: "get_scene_tree", req: "REQ-C-10" },
  { row: 17, legacy: "read_node_properties", tool: "read_node_properties", req: "REQ-C-06" },
  { row: 18, legacy: "get_script_errors", tool: "get_script_errors", req: "REQ-D-01" },
  { row: 19, legacy: "list_resources", tool: "list_resources", req: "REQ-B-05" },
];

const SCENE = "res://mcp_test/exit_demo.tscn";
const TEXTURE = "res://textures/sprite.png";
const POSITION_TEXT = "Vector2(100, 50)";
const MESHES_SCENE = "res://scenes/meshes.tscn";
const CLEAN_SCRIPT = "scripts/print_marker.gd";

describe.runIf(hasGodot)("M1 exit demo: the §11 smoke loop walking all 19 §6.6 rows", () => {
  let workspace: string;
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let tools: ToolDescriptor[];
  let lspPort: number;
  let port: number;

  const walked = new Set<number>();
  /** Record that a §6.6 row was demonstrated by a real successful call. */
  function walk(row: number): void {
    walked.add(row);
  }

  async function callTool(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = tools.find((candidate) => candidate.name === name);
    if (!tool) throw new Error(`tool not registered: ${name}`);
    return (await tool.handler(args as never, {} as never)) as ToolResult;
  }

  beforeAll(async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "godot-mcp-exit-demo-"));
    projectDir = freshSampleProject();
    port = await pickFreePort();
    lspPort = await pickFreePort();

    // The tool inventory drives the whole demo through the real registered
    // handlers. Onboarding tools ignore the bridge; the rest use it once live.
    bridge = new BridgeConnection({
      url: `ws://127.0.0.1:${port}`,
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 30_000,
      reconnectDelayMs: 500,
      log: (message) => {
        if (process.env.DEBUG) console.error(message);
      },
    });
    tools = buildToolInventory({ bridge, lspPort, outputBufferLines: 1000 });

    // §11 scaffold beat (REQ-B-01; create_project is NEW, not a §6.6 row):
    // an empty folder becomes a valid project. Demonstrated, not connected to.
    const minor = godotMinorTag(await probeGodotVersionString());
    const scaffoldDir = path.join(workspace, "scaffolded-game");
    const scaffold = await callTool("create_project", {
      project_path: scaffoldDir,
      project_name: "Exit Demo Scaffold",
      godot_version: minor,
    });
    expect(scaffold.isError).toBeFalsy();

    // Row 2: install the bundled addon into the live sample project.
    const install = await callTool("install_addon", { project_path: projectDir });
    expect(install.isError).toBeFalsy();
    expect(install.structuredContent!.action).toBe("installed");
    walk(2);

    // The one documented manual step, then point the addon at our port, warm
    // the import cache, and boot a real editor.
    enablePlugin(projectDir);
    setBridgePort(projectDir, port);
    await importPass(projectDir);
    editor = launchEditor(projectDir, { lspPort });
    bridge.start();
    await bridge.waitForState("connected", 150_000);
  }, 300_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("handshake: bridge_status + get_godot_version report a live session (rows 1)", async () => {
    const status = await callTool("bridge_status");
    expect(status.isError).toBeFalsy();
    expect(status.structuredContent!.state).toBe("connected");

    const version = await callTool("get_godot_version");
    expect(version.isError).toBeFalsy();
    expect(String(version.structuredContent!.godot_version)).toMatch(/^4\.\d+/);
    walk(1);
  });

  it("orientation: list_projects, get_project_info, list_resources (rows 4, 5, 19)", async () => {
    const projects = await callTool("list_projects", { directory: path.dirname(projectDir) });
    expect(projects.isError).toBeFalsy();
    walk(4);

    const info = await callTool("get_project_info");
    expect(info.isError).toBeFalsy();
    expect(String(info.structuredContent!.name).length).toBeGreaterThan(0);
    walk(5);

    const resources = await callTool("list_resources");
    expect(resources.isError).toBeFalsy();
    expect((resources.structuredContent!.resources as unknown[]).length).toBeGreaterThan(0);
    walk(19);
  });

  it("assets & UIDs: import a dropped PNG, resolve and backfill UIDs (rows 3, 14, 15)", async () => {
    // 1x1 PNG, dropped after the editor booted — invisible until import_assets scans.
    const onePixelPng =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
    writeFileSync(path.join(projectDir, "dropped.png"), Buffer.from(onePixelPng, "base64"));
    const imported = await callTool("import_assets", { paths: ["res://dropped.png"] });
    expect(imported.isError).toBeFalsy();
    expect(imported.structuredContent!.reimported).toContain("res://dropped.png");
    walk(3);

    // print_marker.gd ships with a .uid sidecar — get_uid resolves it directly.
    const uid = await callTool("get_uid", { file_path: "res://scripts/print_marker.gd" });
    expect(uid.isError).toBeFalsy();
    expect(String(uid.structuredContent!.uid)).toMatch(/^uid:\/\//);
    walk(14);

    // meshes.tscn ships UID-less — the resave backfills it.
    const backfill = await callTool("update_project_uids");
    expect(backfill.isError).toBeFalsy();
    expect(backfill.structuredContent!.touched as string[]).toContain(MESHES_SCENE);
    walk(15);
  }, 120_000);

  it("authoring: create scene, add nodes, round-trip a property, read the tree (rows 9, 10, 11, 16, 17)", async () => {
    const created = await callTool("create_scene", { scene_path: SCENE, root_node_type: "Node2D" });
    expect(created.isError).toBeFalsy();
    walk(9);

    const hero = await callTool("add_node", { node_type: "Sprite2D", node_name: "Hero" });
    expect(hero.isError).toBeFalsy();
    const target = await callTool("add_node", { node_type: "Node2D", node_name: "Target" });
    expect(target.isError).toBeFalsy();
    walk(10);

    // Row 11: absorbs load_sprite — one call decodes a Vector2 text form AND
    // loads a texture from a res:// path.
    const set = await callTool("set_node_properties", {
      node_path: "Hero",
      properties: { position: POSITION_TEXT, texture: TEXTURE },
    });
    expect(set.isError).toBeFalsy();
    walk(11);

    const read = await callTool("read_node_properties", {
      node_path: "Hero",
      properties: ["position", "texture"],
    });
    expect(read.isError).toBeFalsy();
    const props = (read.structuredContent as { properties: Record<string, unknown> }).properties;
    expect(props.position).toBe(POSITION_TEXT);
    expect(String(props.texture)).toContain(TEXTURE);
    walk(17);

    const tree = await callTool("get_scene_tree");
    expect(tree.isError).toBeFalsy();
    walk(16);
  }, 120_000);

  it("mutate, undo (Ctrl+Z), and save (row 12)", async () => {
    const moved = await callTool("move_node", { node_path: "Hero", new_parent_path: "Target" });
    expect(moved.isError).toBeFalsy();
    const renamed = await callTool("rename_node", {
      node_path: "Target/Hero",
      new_name: "HeroRenamed",
    });
    expect(renamed.isError).toBeFalsy();

    const removed = await callTool("remove_node", { node_path: "Target/HeroRenamed" });
    expect(removed.isError).toBeFalsy();
    expect(removed.structuredContent!.removed_count as number).toBeGreaterThanOrEqual(1);

    // The Ctrl+Z leg: the editor's own undo restores the removed subtree.
    const undone = (await bridge.request("edit/undo", {})) as { stepped: boolean };
    expect(undone.stepped).toBe(true);

    const saved = await callTool("save_scene");
    expect(saved.isError).toBeFalsy();
    walk(12);
  }, 120_000);

  it("diagnostics, run/tail/stop, and mesh-library export (rows 18, 6, 7, 8, 13)", async () => {
    const errors = await callTool("get_script_errors", { script_path: CLEAN_SCRIPT });
    expect(errors.isError).toBeFalsy();
    walk(18);

    const run = await callTool("run_project", { scene_path: "res://scenes/print_marker.tscn" });
    expect(run.isError).toBeFalsy();
    walk(6);

    const output = await callTool("get_debug_output");
    expect(output.isError).toBeFalsy();
    walk(7);

    const stop = await callTool("stop_project");
    expect(stop.isError).toBeFalsy();
    walk(8);

    const exported = await callTool("export_mesh_library", {
      scene_path: MESHES_SCENE,
      output_path: "res://libraries/exit_demo_meshes.res",
    });
    expect(exported.isError).toBeFalsy();
    walk(13);
  }, 120_000);

  it("containment: an escaping scene_path is rejected (REQ-M-01)", async () => {
    const escape = await callTool("run_project", { scene_path: "../../etc/passwd" });
    expect(escape.isError).toBe(true);
  });

  it("resilience: kill the editor, get a structured disconnect error, relaunch, auto-reconnect (REQ-A-04)", async () => {
    await editor.kill();
    await bridge.waitForState("disconnected", 30_000);
    const disconnected = await callTool("get_godot_version");
    expect(disconnected.isError).toBe(true);
    expect(disconnected.content[0]!.text).toContain("@cradial/godot-mcp@1.x");

    editor = launchEditor(projectDir, { lspPort });
    await bridge.waitForState("connected", 150_000);
    const recovered = await callTool("get_godot_version");
    expect(recovered.isError).toBeFalsy();
  }, 210_000);

  it("walked all 19 §6.6 parity rows through the addon", () => {
    // Every PARITY_ROWS.tool must exist in the shipped inventory (catches a rename).
    const registered = new Set(tools.map((tool) => tool.name));
    for (const entry of PARITY_ROWS) {
      expect(registered.has(entry.tool), `row ${entry.row}: ${entry.tool} not registered`).toBe(
        true,
      );
    }
    // Every row must have been demonstrated by a real successful call above.
    const missing = PARITY_ROWS.filter((entry) => !walked.has(entry.row));
    expect(missing.map((entry) => `row ${entry.row} (${entry.legacy} -> ${entry.tool})`)).toEqual(
      [],
    );
    expect(walked.size).toBe(PARITY_ROWS.length);
  });
});
