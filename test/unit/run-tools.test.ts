import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { createRunTools } from "../../src/tools/run.js";
import { FakeAddonPeer, errorOutcome } from "../support/fake-addon-peer.js";

const SERVER_VERSION = "2.0.0-alpha.0";
const BUFFER_LINES = 1000;

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
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-run-unit-"));
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

async function callRun(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createRunTools({ bridge, outputBufferLines: BUFFER_LINES });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

/** A bridge that can never connect - the REQ-A-04/A-10 error path. */
function downBridge(): BridgeConnection {
  const bridge = new BridgeConnection({
    url: "ws://127.0.0.1:1",
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: 100,
    reconnectDelayMs: 5_000,
  });
  cleanups.push(() => bridge.stop());
  return bridge;
}

describe("run_project", () => {
  it("defaults to the main scene and forwards buffer_lines", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "run/play": (params) => {
        seen = params;
        return { mode: "main", scene_path: "res://scenes/main.tscn", replaced_active: false };
      },
    });
    const result = await callRun(bridge, "run_project");
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ mode: "main", buffer_lines: BUFFER_LINES });
    expect(result.structuredContent).toMatchObject({
      mode: "main",
      scene_path: "res://scenes/main.tscn",
      replaced_active: false,
    });
  });

  it("scene_path alone implies mode custom and is contained to canonical res://", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "run/play": (params) => {
        seen = params;
        return {
          mode: "custom",
          scene_path: "res://scenes/print_marker.tscn",
          replaced_active: false,
        };
      },
    });
    const result = await callRun(bridge, "run_project", { scene_path: "scenes/print_marker.tscn" });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({
      mode: "custom",
      scene_path: "res://scenes/print_marker.tscn",
      buffer_lines: BUFFER_LINES,
    });
  });

  it("forwards mode current with no scene_path", async () => {
    let seen: Record<string, unknown> = {};
    const { bridge } = await connectedPeer({
      "run/play": (params) => {
        seen = params;
        return { mode: "current", scene_path: "res://scenes/meshes.tscn", replaced_active: true };
      },
    });
    const result = await callRun(bridge, "run_project", { mode: "current" });
    expect(result.isError).toBeUndefined();
    expect(seen).toEqual({ mode: "current", buffer_lines: BUFFER_LINES });
    expect(result.structuredContent).toMatchObject({ replaced_active: true });
  });

  it("rejects a scene_path escape before anything crosses the bridge (REQ-M-01)", async () => {
    const { peer, bridge } = await connectedPeer({});
    const result = await callRun(bridge, "run_project", { scene_path: "../../etc/passwd" });
    expect(result.isError).toBe(true);
    expect(peer.requests).toHaveLength(0);
  });

  it("rejects mode custom without scene_path, without bridge traffic", async () => {
    const { peer, bridge } = await connectedPeer({});
    const result = await callRun(bridge, "run_project", { mode: "custom" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("scene_path");
    expect(peer.requests).toHaveLength(0);
  });

  it("rejects scene_path combined with a non-custom mode, without bridge traffic", async () => {
    const { peer, bridge } = await connectedPeer({});
    const result = await callRun(bridge, "run_project", {
      mode: "main",
      scene_path: "res://scenes/print_marker.tscn",
    });
    expect(result.isError).toBe(true);
    expect(peer.requests).toHaveLength(0);
  });

  it("surfaces the addon's no_main_scene refusal as a guided error", async () => {
    const { bridge } = await connectedPeer({
      "run/play": () =>
        errorOutcome({
          code: "no_main_scene",
          message: "This project has no main scene set (application/run/main_scene).",
          possibleSolutions: ["Play a specific scene instead: run_project with scene_path."],
        }),
    });
    const result = await callRun(bridge, "run_project");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("no main scene");
  });

  it("turns a malformed addon payload into a guided error (REQ-A-08)", async () => {
    const { bridge } = await connectedPeer({
      "run/play": () => ({ unexpected: true }),
    });
    const result = await callRun(bridge, "run_project");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("malformed");
  });

  it("returns the structured editor-not-connected error when the bridge is down (REQ-A-04/A-10)", async () => {
    const result = await callRun(downBridge(), "run_project");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("not connected");
  });
});
