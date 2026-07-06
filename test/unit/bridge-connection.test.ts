import { afterEach, describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../src/bridge/protocol.js";
import {
  BridgeConnection,
  BridgeOpError,
  BridgeTimeoutError,
  BridgeUnavailableError,
  reconnectBackoffMs,
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

  it("records sent/received frames and lifecycle events in a bounded traffic log", async () => {
    const peer = await startPeer({
      handlers: { "system/status": () => ({ ok: true }) },
    });
    const bridge = startConnection(peer.url);
    await bridge.waitForState("connected", 5_000);
    await bridge.request("system/status");
    const entries = bridge.traffic(50);
    const directions = new Set(entries.map((entry) => entry.direction));
    expect(directions).toContain("sent");
    expect(directions).toContain("received");
    expect(directions).toContain("event");
    const texts = entries.map((entry) => entry.text).join("\n");
    expect(texts).toContain("system/status"); // the request frame
    expect(texts).toContain("state -> connected"); // the lifecycle event
    expect(texts).toContain('"type":"hello"'); // the received hello
  });

  it("backs off between reconnect attempts and resets the counter once connected", async () => {
    const port = (await startPeer({})).port; // grab a real free port...
    await cleanups.pop()!(); // ...then close the peer so nothing listens on it
    const bridge = startConnection(`ws://127.0.0.1:${port}`);
    // With base 50ms the first retries are fast; the counter must climb.
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(bridge.status().reconnectAttempts).toBeGreaterThanOrEqual(2);
    await startPeer({ port });
    await bridge.waitForState("connected", 10_000);
    expect(bridge.status().reconnectAttempts).toBe(0);
  });

  it("executes a parallel burst serially in arrival order (REQ-A-12, staged on the fake peer)", async () => {
    const completed: number[] = [];
    const peer = await startPeer({
      handlers: {
        "test/op": async (params) => {
          const n = params.n as number;
          // Earlier-arriving ops sleep LONGER - only a serial queue preserves arrival order.
          await new Promise((resolve) => setTimeout(resolve, (5 - n) * 15));
          completed.push(n);
          return { n };
        },
      },
    });
    const bridge = startConnection(peer.url);
    await bridge.waitForState("connected", 5_000);
    const results = await Promise.all([0, 1, 2, 3, 4].map((n) => bridge.request("test/op", { n })));
    expect(peer.requests.map((request) => request.params.n)).toEqual([0, 1, 2, 3, 4]);
    expect(completed).toEqual([0, 1, 2, 3, 4]);
    expect(results.map((result) => (result as { n: number }).n)).toEqual([0, 1, 2, 3, 4]);
  });

  it("maps a throwing fake-peer handler to an error frame instead of a hang", async () => {
    const peer = await startPeer({
      handlers: {
        "boom/op": () => {
          throw new Error("handler exploded");
        },
      },
    });
    const bridge = startConnection(peer.url, { requestTimeoutMs: 2_000 });
    await bridge.waitForState("connected", 5_000);
    const failure = bridge.request("boom/op");
    await expect(failure).rejects.toBeInstanceOf(BridgeOpError);
    await failure.catch((error: BridgeOpError) => {
      expect(error.code).toBe("fake_peer_handler_error");
      expect(error.message).toContain("handler exploded");
    });
  });

  it("refuses a second concurrent client with close code 1013", async () => {
    const peer = await startPeer();
    const bridge = startConnection(peer.url);
    await bridge.waitForState("connected", 5_000);
    const { default: WebSocket } = await import("ws");
    const second = new WebSocket(peer.url);
    const closeCode = await new Promise<number>((resolve) => {
      second.on("close", (code) => resolve(code));
    });
    expect(closeCode).toBe(1013);
  });

  it("fake peer survives a malformed frame without wedging its serial queue", async () => {
    const peer = await startPeer({ handlers: { "test/op": () => ({ ok: true }) } });
    const { default: WebSocket } = await import("ws");
    const raw = new WebSocket(peer.url);
    await new Promise<void>((resolve) => raw.once("open", () => resolve()));
    raw.send("this is not json");
    raw.send(JSON.stringify({ id: 7, method: "test/op", params: {} }));
    const reply = await new Promise<Record<string, unknown>>((resolve) => {
      raw.on("message", (data) => {
        const frame = JSON.parse(String(data)) as Record<string, unknown>;
        if (frame.id === 7) resolve(frame);
      });
    });
    expect(reply.result).toEqual({ ok: true });
    raw.close();
  });
});

describe("reconnectBackoffMs", () => {
  it("doubles from the base and caps at max", () => {
    expect(reconnectBackoffMs(0, 1_000, 10_000)).toBe(1_000);
    expect(reconnectBackoffMs(1, 1_000, 10_000)).toBe(2_000);
    expect(reconnectBackoffMs(2, 1_000, 10_000)).toBe(4_000);
    expect(reconnectBackoffMs(3, 1_000, 10_000)).toBe(8_000);
    expect(reconnectBackoffMs(4, 1_000, 10_000)).toBe(10_000);
    expect(reconnectBackoffMs(50, 1_000, 10_000)).toBe(10_000); // no overflow at large attempts
  });
});
