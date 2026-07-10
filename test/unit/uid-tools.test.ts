import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { createUidTools, MIN_UID_GODOT_VERSION } from "../../src/tools/uid.js";
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

/** A real, existing temp dir to stand in for the connected project root so the
 *  server-side assertInsideRoot check resolves (it realpaths this root). */
function tempProjectDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-uid-unit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A connected bridge fronting the given op handlers, plus the peer for request inspection. */
async function connectedPeer(handlers: Handlers, projectPath: string = tempProjectDir()) {
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
  return { peer, bridge };
}

async function callUid(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createUidTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe("get_uid", () => {
  it("declares the 1.0 version floor as descriptor metadata, not handler logic", () => {
    const tools = createUidTools({ bridge: null as never });
    const getUid = tools.find((tool) => tool.name === "get_uid");
    expect(getUid?.minGodotVersion).toBe(MIN_UID_GODOT_VERSION);
    expect(MIN_UID_GODOT_VERSION).toBe("4.4");
  });

  it("contains a relative file_path to canonical res:// and forwards it as uid/get", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "uid/get": (params) => {
        seen = params;
        return { path: "res://scenes/meshes.tscn", uid: "uid://abc123" };
      },
    });
    const result = await callUid(bridge, "get_uid", { file_path: "scenes/meshes.tscn" });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ path: "res://scenes/meshes.tscn" });
    expect(result.structuredContent).toMatchObject({
      path: "res://scenes/meshes.tscn",
      uid: "uid://abc123",
    });
  });

  it("rejects a path escape before anything crosses the bridge (REQ-M-01)", async () => {
    const { peer, bridge } = await connectedPeer({});
    const result = await callUid(bridge, "get_uid", { file_path: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(peer.requests).toHaveLength(0);
  });

  it("surfaces the addon's no_uid refusal as a guided error", async () => {
    const { bridge } = await connectedPeer({
      "uid/get": () =>
        errorOutcome({
          code: "no_uid",
          message: "No UID is assigned to the resource at res://scenes/meshes.tscn yet.",
          possibleSolutions: ["Run update_project_uids to resave UID-less resources, then retry."],
        }),
    });
    const result = await callUid(bridge, "get_uid", { file_path: "res://scenes/meshes.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("No UID is assigned");
    expect(result.content[0]!.text).toContain("update_project_uids");
  });

  it("turns a malformed addon payload into a guided error (REQ-A-08)", async () => {
    const { bridge } = await connectedPeer({
      "uid/get": () => ({ unexpected: true }),
    });
    const result = await callUid(bridge, "get_uid", { file_path: "res://scenes/meshes.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("malformed");
  });

  it("returns the structured editor-not-connected error when the bridge is down (REQ-A-10)", async () => {
    const bridge = new BridgeConnection({
      url: "ws://127.0.0.1:1",
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 100,
      reconnectDelayMs: 5_000,
    });
    cleanups.push(() => bridge.stop());
    const result = await callUid(bridge, "get_uid", { file_path: "res://scenes/meshes.tscn" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not connected");
  });
});

describe("update_project_uids", () => {
  it("declares the 1.0 version floor as descriptor metadata", () => {
    const tools = createUidTools({ bridge: null as never });
    const update = tools.find((tool) => tool.name === "update_project_uids");
    expect(update?.minGodotVersion).toBe(MIN_UID_GODOT_VERSION);
  });

  it("forwards uid/update_project with no params and returns the parity lists", async () => {
    let seen: Record<string, unknown> | undefined;
    const { bridge } = await connectedPeer({
      "uid/update_project": (params) => {
        seen = params;
        return {
          touched: ["res://scenes/meshes.tscn"],
          already_had_uid: ["res://scenes/other.tscn"],
          failed: [{ path: "res://broken.tres", reason: "failed to load" }],
        };
      },
    });
    const result = await callUid(bridge, "update_project_uids");
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({});
    expect(result.structuredContent).toMatchObject({
      touched: ["res://scenes/meshes.tscn"],
      already_had_uid: ["res://scenes/other.tscn"],
      failed: [{ path: "res://broken.tres", reason: "failed to load" }],
    });
  });

  it("turns a malformed addon payload into a guided error (REQ-A-08)", async () => {
    const { bridge } = await connectedPeer({
      "uid/update_project": () => ({ touched: "not-an-array" }),
    });
    const result = await callUid(bridge, "update_project_uids");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("malformed");
  });
});
