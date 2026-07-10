import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { applyVersionGate, type ToolDescriptor } from "../../src/registry.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createUidTools } from "../../src/tools/uid.js";
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

describe.runIf(hasGodot)("UID tools + version gate against a real editor (#71)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let uidTools: ToolDescriptor[];

  // Committed WITHOUT uid= headers - the REQ-B-09 "previously UID-less" fixtures.
  const UIDLESS_SCENES = ["res://scenes/meshes.tscn", "res://scenes/print_marker.tscn"];
  // Committed WITH a .uid sidecar - proves lookups work without any refresh.
  const SCRIPT_PATH = "res://scripts/print_marker.gd";

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
    uidTools = createUidTools({ bridge });
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("get_uid round-trips a resource that already has a UID (REQ-B-08)", async () => {
    const sidecar = readFileSync(
      path.join(projectDir, "scripts", "print_marker.gd.uid"),
      "utf8",
    ).trim();
    const result = await callTool(uidTools, "get_uid", { file_path: SCRIPT_PATH });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ path: SCRIPT_PATH, uid: sidecar });
    expect(String(result.structuredContent?.uid)).toMatch(/^uid:\/\//);
  });

  it("get_uid on a UID-less scene returns the guided no-uid error naming update_project_uids", async () => {
    const result = await callTool(uidTools, "get_uid", { file_path: UIDLESS_SCENES[0]! });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No UID is assigned");
    expect(result.content[0]!.text).toContain("update_project_uids");
  });

  it("get_uid rejects a containment escape without touching the editor (REQ-M-01)", async () => {
    const result = await callTool(uidTools, "get_uid", { file_path: "../../etc/passwd" });
    expect(result.isError).toBe(true);
  });

  it("update_project_uids gives every UID-less fixture a UID, embedded on disk (REQ-B-09)", async () => {
    const result = await callTool(uidTools, "update_project_uids");
    expect(result.isError).toBeUndefined();
    const touched = result.structuredContent?.touched as string[];
    const failed = result.structuredContent?.failed as unknown[];
    for (const scene of UIDLESS_SCENES) expect(touched).toContain(scene);
    expect(failed).toEqual([]);
    // Independent readback: the uid= header now exists in the file on disk.
    const onDisk = readFileSync(path.join(projectDir, "scenes", "meshes.tscn"), "utf8");
    expect(onDisk).toMatch(/^\[gd_scene[^\]]*uid="uid:\/\//);
  });

  it("get_uid resolves the just-assigned UID and it matches the on-disk header", async () => {
    const onDisk = readFileSync(path.join(projectDir, "scenes", "meshes.tscn"), "utf8");
    const headerUid = /uid="(uid:\/\/[^"]+)"/.exec(onDisk)?.[1];
    expect(headerUid).toBeDefined();
    const result = await callTool(uidTools, "get_uid", { file_path: UIDLESS_SCENES[0]! });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.uid).toBe(headerUid);
  });

  it("a second update_project_uids run touches nothing (idempotent; no diff churn)", async () => {
    const result = await callTool(uidTools, "update_project_uids");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent?.touched).toEqual([]);
    const already = result.structuredContent?.already_had_uid as string[];
    for (const scene of UIDLESS_SCENES) expect(already).toContain(scene);
  });

  it("the version gate blocks or passes a gated call per the REAL handshake engine (REQ-A-07)", async () => {
    // Test-local canary gated on the NEWER supported minor: on the older CI
    // leg (4.6) the gate must reject with the structured "requires >= x.y"
    // error; on the newer leg (4.7) the same gate must pass. Both legs
    // exercise the gate against a real editor handshake - the demo the
    // issue asks for. The canary never ships: it exists only in this test.
    const CANARY_FLOOR = "4.7";
    let ran = 0;
    const canary: ToolDescriptor = {
      name: "canary_gated_probe",
      description: "integration-only gated canary",
      inputSchema: {},
      minGodotVersion: CANARY_FLOOR,
      handler: async () => {
        ran += 1;
        return { content: [{ type: "text" as const, text: "canary ran" }] };
      },
    };
    const engine = bridge.status().hello!.godot_version;
    const gated = applyVersionGate(canary, () => bridge.status().hello?.godot_version);
    const result = (await gated.handler({} as never, {} as never)) as ToolResult;

    const meetsFloor = engine.major > 4 || (engine.major === 4 && engine.minor >= 7);
    if (meetsFloor) {
      expect(result.isError).toBeUndefined();
      expect(ran).toBe(1);
    } else {
      expect(result.isError).toBe(true);
      expect(result.content[0]!.text).toContain(`requires Godot >= ${CANARY_FLOOR}`);
      expect(result.content[0]!.text).toContain(`${engine.major}.${engine.minor}`);
      expect(ran).toBe(0);
    }
  });

  it("the UID tools themselves pass the 4.4 gate on every supported minor", async () => {
    const engine = () => bridge.status().hello?.godot_version;
    const gatedGetUid = applyVersionGate(
      uidTools.find((tool) => tool.name === "get_uid")!,
      engine,
    );
    const result = (await gatedGetUid.handler(
      { file_path: SCRIPT_PATH } as never,
      {} as never,
    )) as ToolResult;
    // Not gate-blocked: the call reached the addon and resolved a UID.
    expect(result.isError).toBeUndefined();
    expect(String(result.structuredContent?.uid)).toMatch(/^uid:\/\//);
  });
});
