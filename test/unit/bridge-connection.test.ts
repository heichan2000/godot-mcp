import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../src/bridge/protocol.js";
import {
  BridgeConnection,
  BridgeOpError,
  BridgeTimeoutError,
  BridgeUnavailableError,
} from "../../src/bridge/connection.js";
import { FakeAddonPeer } from "../support/fake-addon-peer.js";

const SERVER_VERSION = "2.0.0-alpha.0";

function makeConnection(url: string, overrides: { requestTimeoutMs?: number } = {}) {
  return new BridgeConnection({
    url,
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: overrides.requestTimeoutMs ?? 2_000,
    reconnectDelayMs: 50,
  });
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function startPeer(options: Parameters<typeof FakeAddonPeer.start>[0] = {}) {
  const peer = await FakeAddonPeer.start(options);
  cleanups.push(() => peer.close());
  return peer;
}

function startConnection(url: string, overrides: { requestTimeoutMs?: number } = {}) {
  const bridge = makeConnection(url, overrides);
  bridge.start();
  cleanups.push(() => bridge.stop());
  return bridge;
}

describe("BridgeConnection", () => {
  it("connects, handshakes, and acks with the server version", async () => {
    const peer = await startPeer();
    const bridge = startConnection(peer.url);
    await bridge.waitForState("connected", 5_000);
    const status = bridge.status();
    expect(status.hello?.godot_version_string).toBe("4.7.1.stable");
    expect(status.protocolVersion).toBe(PROTOCOL_VERSION);
    // ack reaches the peer (poll briefly - delivery is async)
    await bridge.request("system/status").catch(() => undefined);
    expect(peer.acks).toHaveLength(1);
    expect((peer.acks[0] as { server_version: string }).server_version).toBe(SERVER_VERSION);
  });

  it("round-trips a request to a handler", async () => {
    const peer = await startPeer({
      handlers: { "system/status": (params) => ({ echoed: params.x, ok: true }) },
    });
    const bridge = startConnection(peer.url);
    await bridge.waitForState("connected", 5_000);
    await expect(bridge.request("system/status", { x: 42 })).resolves.toEqual({
      echoed: 42,
      ok: true,
    });
  });

  it("maps addon error frames to BridgeOpError with possibleSolutions", async () => {
    const peer = await startPeer(); // no handlers -> unknown_method error frame
    const bridge = startConnection(peer.url);
    await bridge.waitForState("connected", 5_000);
    const failure = bridge.request("no/such_method");
    await expect(failure).rejects.toBeInstanceOf(BridgeOpError);
    await failure.catch((error: BridgeOpError) => {
      expect(error.code).toBe("unknown_method");
      expect(error.possibleSolutions.length).toBeGreaterThan(0);
    });
  });

  it("times out a request the addon never answers", async () => {
    const peer = await startPeer({
      handlers: { "system/status": () => new Promise(() => undefined) },
    });
    const bridge = startConnection(peer.url, { requestTimeoutMs: 100 });
    await bridge.waitForState("connected", 5_000);
    await expect(bridge.request("system/status")).rejects.toBeInstanceOf(BridgeTimeoutError);
  });

  it("flags a protocol mismatch naming both versions", async () => {
    const peer = await startPeer({ protocolVersion: 99 });
    const bridge = startConnection(peer.url);
    await bridge.waitForState("mismatch", 5_000);
    const rejection = bridge.request("system/status");
    await expect(rejection).rejects.toBeInstanceOf(BridgeUnavailableError);
    await rejection.catch((error: Error) => {
      expect(error.message).toContain("99");
      expect(error.message).toContain(String(PROTOCOL_VERSION));
      expect(error.message.toLowerCase()).toContain("update");
    });
  });

  it("flags a mismatch for a future-protocol hello even when the rest of the body is unrecognizable", async () => {
    const peer = await startPeer({
      protocolVersion: 2,
      helloOverrides: { addon_version: undefined as unknown as string },
    });
    const bridge = startConnection(peer.url);
    await bridge.waitForState("mismatch", 5_000);
    const rejection = bridge.request("system/status");
    await expect(rejection).rejects.toBeInstanceOf(BridgeUnavailableError);
    await rejection.catch((error: Error) => {
      expect(error.message).toContain("2");
      expect(error.message).toContain(String(PROTOCOL_VERSION));
      expect(error.message.toLowerCase()).toContain("update");
    });
  });

  it("rejects requests while disconnected", async () => {
    const bridge = startConnection("ws://127.0.0.1:1"); // nothing listens on port 1
    await expect(bridge.request("system/status")).rejects.toBeInstanceOf(BridgeUnavailableError);
  });

  it("rejects in-flight requests when the peer dies, then reconnects to a new peer on the same port", async () => {
    const first = await FakeAddonPeer.start({
      handlers: { "system/status": () => new Promise(() => undefined) },
    });
    const port = first.port;
    const bridge = startConnection(first.url);
    await bridge.waitForState("connected", 5_000);
    const inFlight = bridge.request("system/status");
    await first.close();
    await expect(inFlight).rejects.toBeInstanceOf(BridgeUnavailableError);
    await bridge.waitForState("disconnected", 5_000);
    const second = await FakeAddonPeer.start({ port });
    cleanups.push(() => second.close());
    await bridge.waitForState("connected", 10_000);
    expect(bridge.status().state).toBe("connected");
  });
});
