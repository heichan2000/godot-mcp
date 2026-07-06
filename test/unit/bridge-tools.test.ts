import { afterEach, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { PROTOCOL_VERSION } from "../../src/bridge/protocol.js";
import { createBridgeTools } from "../../src/tools/bridge.js";
import { FakeAddonPeer } from "../support/fake-addon-peer.js";

const SERVER_VERSION = "2.0.0-alpha.0";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

const statusResult = {
  protocol_version: PROTOCOL_VERSION,
  addon_version: "2.0.0-alpha.0",
  godot_version: { major: 4, minor: 7, patch: 1, status: "stable" },
  godot_version_string: "4.7.1.stable",
  features: { dotnet: true },
  project_path: "/tmp/fake-project",
  uptime_ms: 1234,
  queue_depth: 0,
};

async function connectedBridge(options: Parameters<typeof FakeAddonPeer.start>[0] = {}) {
  const peer = await FakeAddonPeer.start({
    handlers: { "system/status": () => statusResult },
    ...options,
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
  await bridge.waitForState(
    options.protocolVersion === undefined ? "connected" : "mismatch",
    5_000,
  );
  return bridge;
}

function toolByName(bridge: BridgeConnection, name: string) {
  const tools = createBridgeTools({ bridge, serverVersion: SERVER_VERSION });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return tool;
}

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

async function call(bridge: BridgeConnection, name: string): Promise<ToolResult> {
  const tool = toolByName(bridge, name);
  return (await tool.handler({}, {} as never)) as ToolResult;
}

async function callWith(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown>,
): Promise<ToolResult> {
  const tool = toolByName(bridge, name);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe("get_godot_version", () => {
  it("returns engine + addon + server versions over the bridge when connected", async () => {
    const bridge = await connectedBridge();
    const result = await call(bridge, "get_godot_version");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      godot_version_string: "4.7.1.stable",
      addon_version: "2.0.0-alpha.0",
      server_version: SERVER_VERSION,
      features: { dotnet: true },
    });
  });

  it("returns the structured not-connected error with the 1.x pointer when disconnected", async () => {
    const bridge = new BridgeConnection({
      url: "ws://127.0.0.1:1",
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 100,
      reconnectDelayMs: 5_000,
    });
    cleanups.push(() => bridge.stop());
    const result = await call(bridge, "get_godot_version");
    expect(result.isError).toBe(true);
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.join(" ")).toContain("@cradial/godot-mcp@1.x");
    expect(solutions.join(" ").toLowerCase()).toContain("editor");
  });

  it("names both protocol versions on a mismatch", async () => {
    const bridge = await connectedBridge({ protocolVersion: 99 });
    const result = await call(bridge, "get_godot_version");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("99");
    expect(result.content[0]!.text).toContain(String(PROTOCOL_VERSION));
  });
});

describe("bridge_status", () => {
  it("reports connected state with live handshake data (never an error)", async () => {
    const bridge = await connectedBridge();
    const result = await call(bridge, "bridge_status");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      state: "connected",
      server_version: SERVER_VERSION,
      protocol_version: PROTOCOL_VERSION,
      godot_version_string: "4.7.1.stable",
      queue_depth: 0,
    });
  });

  it("reports disconnected state with guidance - still not an error", async () => {
    const bridge = new BridgeConnection({
      url: "ws://127.0.0.1:1",
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 100,
      reconnectDelayMs: 5_000,
    });
    cleanups.push(() => bridge.stop());
    const result = await call(bridge, "bridge_status");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ state: "disconnected" });
    const guidance = (result.structuredContent as { guidance: string[] }).guidance;
    expect(guidance.join(" ")).toContain("@cradial/godot-mcp@1.x");
  });
});

describe("bridge_status hardening (#65)", () => {
  it("reports the addon's protocol version in mismatch state (not null)", async () => {
    const bridge = await connectedBridge({ protocolVersion: 99 });
    const result = await call(bridge, "bridge_status");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      state: "mismatch",
      addon_protocol_version: 99,
    });
  });

  it("includes pending_requests in the disconnected payload", async () => {
    const bridge = new BridgeConnection({
      url: "ws://127.0.0.1:1",
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 100,
      reconnectDelayMs: 5_000,
    });
    cleanups.push(() => bridge.stop());
    const result = await call(bridge, "bridge_status");
    expect(result.structuredContent).toMatchObject({ pending_requests: 0 });
  });

  it("returns a structured error when the addon sends a malformed system/status", async () => {
    const bridge = await connectedBridge({
      handlers: { "system/status": () => ({ nonsense: true }) },
    });
    const result = await call(bridge, "bridge_status");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("system/status");
    const solutions = (result.structuredContent as { possibleSolutions: string[] })
      .possibleSolutions;
    expect(solutions.length).toBeGreaterThan(0);
  });

  it("not-connected guidance covers setup steps and the 1.x pointer (REQ-A-10)", async () => {
    const bridge = new BridgeConnection({
      url: "ws://127.0.0.1:1",
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 100,
      reconnectDelayMs: 5_000,
    });
    cleanups.push(() => bridge.stop());
    const result = await call(bridge, "get_godot_version");
    expect(result.isError).toBe(true);
    const joined = (
      result.structuredContent as { possibleSolutions: string[] }
    ).possibleSolutions.join(" ");
    expect(joined).toContain("Godot editor"); // open the editor
    expect(joined).toContain("addons/"); // install the addon
    expect(joined).toContain("bridge_status"); // diagnose
    expect(joined).toContain("@cradial/godot-mcp@1.x"); // headless pointer
  });
});

describe("bridge_status addon staleness (REQ-A-03)", () => {
  it("flags a stale addon with an install_addon update action", async () => {
    const staleStatus = { ...statusResult, addon_version: "1.9.0" };
    const bridge = await connectedBridge({ handlers: { "system/status": () => staleStatus } });
    const result = await call(bridge, "bridge_status");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      state: "connected",
      addon_version: "1.9.0",
      bundled_addon_version: SERVER_VERSION,
      addon_update_available: true,
    });
    const action = (result.structuredContent as { addon_update_action: string })
      .addon_update_action;
    expect(action).toContain("install_addon");
  });

  it("marks a matching addon version up to date", async () => {
    const bridge = await connectedBridge(); // default addon_version === SERVER_VERSION
    const result = await call(bridge, "bridge_status");
    expect(result.structuredContent).toMatchObject({
      addon_update_available: false,
      bundled_addon_version: SERVER_VERSION,
    });
    expect(result.structuredContent).not.toHaveProperty("addon_update_action");
  });
});

describe("get_bridge_log", () => {
  it("returns recent traffic entries after a round-trip", async () => {
    const bridge = await connectedBridge();
    await call(bridge, "bridge_status"); // generate request/response traffic
    const result = await call(bridge, "get_bridge_log");
    expect(result.isError).toBeUndefined();
    const payload = result.structuredContent as {
      entries: Array<{ at: string; direction: string; text: string }>;
      count: number;
    };
    expect(payload.count).toBe(payload.entries.length);
    expect(payload.entries.length).toBeGreaterThan(0);
    expect(payload.entries.map((entry) => entry.text).join("\n")).toContain("system/status");
  });

  it("honors the lines parameter", async () => {
    const bridge = await connectedBridge();
    await call(bridge, "bridge_status");
    const result = await callWith(bridge, "get_bridge_log", { lines: 2 });
    const payload = result.structuredContent as { entries: unknown[] };
    expect(payload.entries).toHaveLength(2);
  });

  it("is not an error when the bridge is disconnected - the log is exactly what you want then", async () => {
    const bridge = new BridgeConnection({
      url: "ws://127.0.0.1:1",
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 100,
      reconnectDelayMs: 5_000,
    });
    cleanups.push(() => bridge.stop());
    const result = await call(bridge, "get_bridge_log");
    expect(result.isError).toBeUndefined();
  });
});
