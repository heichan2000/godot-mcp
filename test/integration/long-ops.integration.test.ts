import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createProjectTools } from "../../src/tools/project.js";
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

// A minimal valid 1x1 PNG — the "asset dropped into the project" fixture
// (same bytes as project-reads.integration.test.ts uses).
const ONE_BY_ONE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

async function callProjectTool(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createProjectTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

async function callSceneTool(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createSceneTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

/** Received progress frames in the traffic log whose payload mentions `stage`. */
function receivedProgressFrames(bridge: BridgeConnection, stage: string): number {
  return bridge
    .traffic(200)
    .filter(
      (entry) =>
        entry.direction === "received" &&
        entry.text.includes('"progress"') &&
        entry.text.includes(`"${stage}"`),
    ).length;
}

describe.runIf(hasGodot)("long ops vs a real editor (REQ-A-11)", () => {
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

  it("targeted reimport emits reimport progress frames and succeeds", async () => {
    writeFileSync(
      path.join(projectDir, "textures", "long_ops_drop.png"),
      Buffer.from(ONE_BY_ONE_PNG_BASE64, "base64"),
    );
    const result = await callProjectTool(bridge, "import_assets", {
      paths: ["res://textures/long_ops_drop.png"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.scan_started).toBe(false);
    expect(result.structuredContent!.reimported).toEqual(["res://textures/long_ops_drop.png"]);
    expect(receivedProgressFrames(bridge, "reimport")).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("bare import waits for the whole-project scan to complete", async () => {
    const result = await callProjectTool(bridge, "import_assets", {});
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.scan_started).toBe(true);
    expect(result.structuredContent!.scan_completed).toBe(true);
  }, 120_000);

  it("exports every mesh in meshes.tscn to a MeshLibrary .res, emitting progress", async () => {
    const result = await callSceneTool(bridge, "export_mesh_library", {
      scene_path: "res://scenes/meshes.tscn",
      output_path: "res://libraries/meshes.res",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toMatchObject({
      scene_path: "res://scenes/meshes.tscn",
      output_path: "res://libraries/meshes.res",
      item_names: ["Box", "Sphere"],
    });
    expect(existsSync(path.join(projectDir, "libraries", "meshes.res"))).toBe(true);
    expect(receivedProgressFrames(bridge, "load")).toBeGreaterThanOrEqual(1);
    expect(receivedProgressFrames(bridge, "save")).toBeGreaterThanOrEqual(1);
  }, 60_000);

  it("the exported file registers as a MeshLibrary resource in the editor", async () => {
    const listing = (await bridge.request("project/list_resources", {
      directory: "res://libraries",
    })) as { resources: Array<{ path: string; type: string }> };
    const exported = listing.resources.find((r) => r.path === "res://libraries/meshes.res");
    expect(exported?.type).toBe("MeshLibrary");
  }, 60_000);

  it("filters by mesh_item_names (1.0 parity)", async () => {
    const result = await callSceneTool(bridge, "export_mesh_library", {
      scene_path: "res://scenes/meshes.tscn",
      output_path: "res://libraries/box_only.res",
      mesh_item_names: ["Box"],
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.item_names).toEqual(["Box"]);
  }, 60_000);

  it("an unmatched name filter is a structured error naming the available items", async () => {
    const result = await callSceneTool(bridge, "export_mesh_library", {
      scene_path: "res://scenes/meshes.tscn",
      output_path: "res://libraries/none.res",
      mesh_item_names: ["Cylinder"],
    });
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("Box");
    expect(text).toContain("Sphere");
    expect(existsSync(path.join(projectDir, "libraries", "none.res"))).toBe(false);
  }, 60_000);

  it("re-exporting overwrites the existing output (derived artifact)", async () => {
    const result = await callSceneTool(bridge, "export_mesh_library", {
      scene_path: "res://scenes/meshes.tscn",
      output_path: "res://libraries/meshes.res",
    });
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.item_names).toEqual(["Box", "Sphere"]);
  }, 60_000);

  it("rejects an output_path that escapes the project (REQ-M-01)", async () => {
    const result = await callSceneTool(bridge, "export_mesh_library", {
      scene_path: "res://scenes/meshes.tscn",
      output_path: "res://../outside.res",
    });
    expect(result.isError).toBe(true);
    expect(existsSync(path.join(path.dirname(projectDir), "outside.res"))).toBe(false);
  }, 60_000);
});
