# M1 #64 — v2 Walking Skeleton Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the headless-CLI execution path with the v2 addon-first tracer bullet: a GDScript editor addon hosting a localhost WebSocket bridge, a reconnecting TS client, a versioned handshake, and two real tools (`bridge_status`, `get_godot_version`) that round-trip through all of it — plus the REQ-A-05 naming lint and both test harnesses (fake addon peer + real editor in CI).

**Architecture:** The addon (`addon/godot_mcp/`, pure GDScript `EditorPlugin`) listens on `ws://127.0.0.1:6510` and sends a `hello` handshake on connect; the MCP server (`src/bridge/connection.ts`) is a reconnecting WebSocket client that validates `protocol_version`, correlates `{id, method, params}` → `{id, result | error}` frames, and times out per request. Tools become thin descriptors over bridge ops. All 1.0 headless modules (runner, process spawn, GDScript dispatcher, per-call `--version` probing) are deleted on `main`; a `1.x` branch preserves them.

**Tech Stack:** Node ≥20 ESM, TypeScript, `@modelcontextprotocol/sdk` ^1.29, zod v4, `ws` ^8, vitest, tsup, GDScript (Godot 4.x editor plugin).

## Global Constraints

- Issue #64 / PRD (`.claude/prd/godotmcpv2m1prd.md`); REQs: A-01, A-02, A-05, A-07 (version-query half), A-08.
- `main` becomes the v2 line: version `2.0.0-alpha.0`; `1.x` maintenance branch cut from current `main` **before any deletion**.
- Product code must never spawn a Godot process (REQ-A-01). Test infrastructure MAY exec Godot (import pass, `--version` probe) — tests are not product tools.
- Bridge binds loopback only; addon refuses a second concurrent client; `PROTOCOL_VERSION = 1`; default port 6510 (`GODOT_MCP_PORT`), per-request timeout 30000ms (`BRIDGE_TIMEOUT_MS`).
- Every tool failure: `createErrorResponse` with `possibleSolutions[]` + `isError: true` (REQ-A-08). Disconnected-editor errors must name `@cradial/godot-mcp@1.x` for headless needs (REQ-A-10 wording arrives fully in #65; the pointer text ships now).
- Naming lint (REQ-A-05): tool names match `/^[a-z][a-z0-9]*(_[a-z0-9]+)+$/`, descriptions 1–200 chars single-line, param keys `snake_case`, no duplicate names.
- Carried modules stay untouched unless stated: `src/errors.ts`, `src/godot/paths.ts`, `src/godot/values.ts`, `src/schemas.ts`.
- Gates that must stay green at every commit: `npm run lint`, `npm run format` (prettier — run `npm run format:fix` after creating files), `npm run typecheck`, `npm test` (+ coverage thresholds 95/90/95/95 on the pure layers).
- Dev machine is Windows (PowerShell); all commands below are cross-platform npm/git unless marked CI-only.

---

### Task 1: Cut the 1.x line, start the v2 line

**Files:**

- Modify: `package.json` (version, description, deps)

**Interfaces:**

- Produces: branch `1.x` (pushed later with the PR), working branch `m1/64-walking-skeleton`, `ws` + `@types/ws` installed, version `2.0.0-alpha.0`.

- [ ] **Step 1: Create the maintenance branch and the working branch**

```bash
git branch 1.x main
git switch -c m1/64-walking-skeleton main
```

- [ ] **Step 2: Bump version + description, add ws deps**

In `package.json`: `"version": "2.0.0-alpha.0"`; `"description": "MCP server that bridges AI agents to a live Godot 4 editor via the Godot MCP addon."`. Then:

```bash
npm install ws
npm install --save-dev @types/ws
```

- [ ] **Step 3: Verify the tree still passes**

Run: `npm run typecheck; npm test`
Expected: PASS (nothing else changed yet).

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: start v2 line (2.0.0-alpha.0); 1.x maintenance branch cut for headless users"
```

---

### Task 2: Bridge protocol module

**Files:**

- Create: `src/bridge/protocol.ts`
- Test: `test/unit/bridge-protocol.test.ts`

**Interfaces:**

- Produces: `PROTOCOL_VERSION: 1`; `Hello`, `ResponseFrame`, `BridgeErrorPayload`, `RequestFrame` types; `parseAddonFrame(text): AddonFrame` (`{kind:"hello"|"response"|"invalid"}`); `helloAck(serverVersion): string`; `encodeRequest(frame): string`. Consumed by connection.ts, fake peer, addon parity.

- [ ] **Step 1: Write the failing tests**

`test/unit/bridge-protocol.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  encodeRequest,
  helloAck,
  parseAddonFrame,
} from "../../src/bridge/protocol.js";

const validHello = {
  type: "hello",
  protocol_version: PROTOCOL_VERSION,
  addon_version: "2.0.0-alpha.0",
  godot_version: { major: 4, minor: 7, patch: 1, status: "stable" },
  godot_version_string: "4.7.1.stable",
  features: { dotnet: false },
  project_path: "/tmp/fake-project",
};

describe("parseAddonFrame", () => {
  it("parses a valid hello frame", () => {
    const frame = parseAddonFrame(JSON.stringify(validHello));
    expect(frame.kind).toBe("hello");
    if (frame.kind !== "hello") throw new Error("unreachable");
    expect(frame.hello.protocol_version).toBe(PROTOCOL_VERSION);
    expect(frame.hello.features.dotnet).toBe(false);
    expect(frame.hello.project_path).toBe("/tmp/fake-project");
  });

  it("parses a success response frame", () => {
    const frame = parseAddonFrame(JSON.stringify({ id: 3, result: { ok: true } }));
    expect(frame).toEqual({ kind: "response", response: { id: 3, result: { ok: true } } });
  });

  it("parses an error response frame with possibleSolutions", () => {
    const frame = parseAddonFrame(
      JSON.stringify({
        id: 4,
        error: { code: "unknown_method", message: "nope", possibleSolutions: ["update"] },
      }),
    );
    expect(frame.kind).toBe("response");
    if (frame.kind !== "response") throw new Error("unreachable");
    expect(frame.response.error?.possibleSolutions).toEqual(["update"]);
  });

  it("rejects non-JSON, non-objects, and frames matching neither shape", () => {
    expect(parseAddonFrame("not json").kind).toBe("invalid");
    expect(parseAddonFrame('"just a string"').kind).toBe("invalid");
    expect(parseAddonFrame(JSON.stringify({ id: 9 })).kind).toBe("invalid");
    expect(parseAddonFrame(JSON.stringify({ type: "hello" })).kind).toBe("invalid");
  });

  it("rejects a hello with a non-integer protocol_version", () => {
    expect(parseAddonFrame(JSON.stringify({ ...validHello, protocol_version: "1" })).kind).toBe(
      "invalid",
    );
  });
});

describe("encodeRequest / helloAck", () => {
  it("encodes a request frame as JSON", () => {
    expect(JSON.parse(encodeRequest({ id: 1, method: "system/status", params: {} }))).toEqual({
      id: 1,
      method: "system/status",
      params: {},
    });
  });

  it("helloAck carries server_version and protocol_version", () => {
    expect(JSON.parse(helloAck("2.0.0-alpha.0"))).toEqual({
      type: "hello_ack",
      server_version: "2.0.0-alpha.0",
      protocol_version: PROTOCOL_VERSION,
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/bridge-protocol.test.ts`
Expected: FAIL — cannot resolve `src/bridge/protocol.js`.

- [ ] **Step 3: Implement `src/bridge/protocol.ts`**

```ts
import { z } from "zod";

/**
 * Bridge protocol version, mirrored by the addon's PROTOCOL_VERSION
 * (addon/godot_mcp/server.gd). Bump BOTH on any breaking envelope or
 * handshake change; the client refuses to talk across a mismatch
 * (REQ-A-02) rather than guessing.
 */
export const PROTOCOL_VERSION = 1;

export const GodotVersionSchema = z.object({
  major: z.number().int(),
  minor: z.number().int(),
  patch: z.number().int(),
  status: z.string(),
});
export type GodotVersion = z.infer<typeof GodotVersionSchema>;

/**
 * First frame the addon sends after the WebSocket opens (REQ-A-02). The
 * feature map is open-ended (`catchall`) so future addon versions can add
 * flags without a protocol bump; `dotnet` is the one every consumer may
 * rely on today.
 */
export const HelloSchema = z.object({
  type: z.literal("hello"),
  protocol_version: z.number().int(),
  addon_version: z.string(),
  godot_version: GodotVersionSchema,
  godot_version_string: z.string(),
  features: z.object({ dotnet: z.boolean() }).catchall(z.boolean()),
  project_path: z.string(),
});
export type Hello = z.infer<typeof HelloSchema>;

/** Error payload inside a response frame - same shape createErrorResponse consumes. */
export const BridgeErrorSchema = z.object({
  code: z.string().optional(),
  message: z.string(),
  possibleSolutions: z.array(z.string()).optional(),
});
export type BridgeErrorPayload = z.infer<typeof BridgeErrorSchema>;

export const ResponseFrameSchema = z.object({
  id: z.number().int(),
  result: z.unknown().optional(),
  error: BridgeErrorSchema.optional(),
});
export type ResponseFrame = z.infer<typeof ResponseFrameSchema>;

export interface RequestFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export type AddonFrame =
  | { kind: "hello"; hello: Hello }
  | { kind: "response"; response: ResponseFrame }
  | { kind: "invalid"; reason: string };

/**
 * Classifies one inbound text frame from the addon. Never throws: transport
 * code branches on `kind` and logs invalid frames instead of crashing the
 * connection over one bad packet.
 */
export function parseAddonFrame(text: string): AddonFrame {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { kind: "invalid", reason: "frame is not valid JSON" };
  }
  if (typeof raw !== "object" || raw === null) {
    return { kind: "invalid", reason: "frame is not a JSON object" };
  }
  const hello = HelloSchema.safeParse(raw);
  if (hello.success) return { kind: "hello", hello: hello.data };
  const response = ResponseFrameSchema.safeParse(raw);
  if (response.success && ("result" in raw || "error" in raw)) {
    return { kind: "response", response: response.data };
  }
  return { kind: "invalid", reason: "frame matches neither hello nor response shape" };
}

/** The client's reply to a hello - lets the addon log/flag the server it serves. */
export function helloAck(serverVersion: string): string {
  return JSON.stringify({
    type: "hello_ack",
    server_version: serverVersion,
    protocol_version: PROTOCOL_VERSION,
  });
}

export function encodeRequest(frame: RequestFrame): string {
  return JSON.stringify(frame);
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/bridge-protocol.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Commit**

```bash
git add src/bridge/protocol.ts test/unit/bridge-protocol.test.ts
git commit -m "feat: versioned bridge protocol envelope + handshake codec (REQ-A-02)"
```

---

### Task 3: Fake addon peer (unit-test harness, no Godot)

**Files:**

- Create: `test/support/fake-addon-peer.ts`

**Interfaces:**

- Produces: `FakeAddonPeer.start(options): Promise<FakeAddonPeer>` with `port`, `url`, `requests[]`, `acks[]`, `close()`. Options: `port?` (default ephemeral), `protocolVersion?`, `helloOverrides?`, `omitHello?`, `handlers?: Record<string, (params) => unknown | Promise<unknown>>`; a handler may return `{ __error: BridgeErrorPayload }` to send an error frame. Consumed by Tasks 4, 5, 7.

- [ ] **Step 1: Implement (exercised by Task 4's tests — test infra carries no own suite)**

```ts
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer, type WebSocket } from "ws";
import {
  PROTOCOL_VERSION,
  type BridgeErrorPayload,
  type Hello,
} from "../../src/bridge/protocol.js";

type HandlerResult = unknown | { __error: BridgeErrorPayload };

export interface FakeAddonPeerOptions {
  /** Bind port; defaults to an ephemeral free port (read it back via `peer.port`). */
  port?: number;
  /** Overrides the hello's protocol_version (mismatch tests). */
  protocolVersion?: number;
  /** Shallow-merged over the default hello frame. */
  helloOverrides?: Partial<Hello>;
  /** When true, never sends hello - exercises the client's handshake timeout. */
  omitHello?: boolean;
  /** Bridge method -> handler. Missing methods get an unknown_method error frame. */
  handlers?: Record<
    string,
    (params: Record<string, unknown>) => HandlerResult | Promise<HandlerResult>
  >;
}

/**
 * In-process stand-in for the Godot addon's WebSocket server: speaks the
 * versioned bridge protocol so connection/tool unit tests run with no Godot
 * installed (PRD #63 testing decisions; issue #64). Single-client policy
 * mirrors the real addon: a second concurrent socket is closed immediately
 * with code 1013.
 */
export class FakeAddonPeer {
  readonly requests: Array<{ id: number; method: string; params: Record<string, unknown> }> = [];
  readonly acks: unknown[] = [];

  private constructor(
    private readonly wss: WebSocketServer,
    readonly port: number,
    private readonly options: FakeAddonPeerOptions,
  ) {}

  static async start(options: FakeAddonPeerOptions = {}): Promise<FakeAddonPeer> {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: options.port ?? 0 });
    await new Promise<void>((resolve, reject) => {
      wss.once("listening", resolve);
      wss.once("error", reject);
    });
    const address = wss.address();
    if (address === null || typeof address === "string") {
      throw new Error("FakeAddonPeer: could not determine bound port");
    }
    const peer = new FakeAddonPeer(wss, address.port, options);
    wss.on("connection", (socket) => peer.onConnection(socket));
    return peer;
  }

  get url(): string {
    return `ws://127.0.0.1:${this.port}`;
  }

  async close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    await new Promise<void>((resolve) => this.wss.close(() => resolve()));
    // Give the OS a beat to fully release the port for same-port restarts.
    await delay(10);
  }

  private activeClient: WebSocket | null = null;

  private onConnection(socket: WebSocket): void {
    if (this.activeClient !== null && this.activeClient.readyState === this.activeClient.OPEN) {
      socket.close(1013, "godot-mcp: a bridge client is already connected");
      return;
    }
    this.activeClient = socket;
    socket.on("close", () => {
      if (this.activeClient === socket) this.activeClient = null;
    });
    socket.on("message", (data) => {
      void this.onMessage(socket, String(data));
    });
    if (!this.options.omitHello) {
      socket.send(JSON.stringify(this.hello()));
    }
  }

  private hello(): Record<string, unknown> {
    return {
      type: "hello",
      protocol_version: this.options.protocolVersion ?? PROTOCOL_VERSION,
      addon_version: "2.0.0-alpha.0",
      godot_version: { major: 4, minor: 7, patch: 1, status: "stable" },
      godot_version_string: "4.7.1.stable",
      features: { dotnet: false },
      project_path: "/tmp/fake-project",
      ...this.options.helloOverrides,
    };
  }

  private async onMessage(socket: WebSocket, text: string): Promise<void> {
    const frame: unknown = JSON.parse(text);
    if (typeof frame !== "object" || frame === null) return;
    const record = frame as Record<string, unknown>;
    if (record.type === "hello_ack") {
      this.acks.push(record);
      return;
    }
    const id = record.id as number;
    const method = String(record.method ?? "");
    const params = (record.params ?? {}) as Record<string, unknown>;
    this.requests.push({ id, method, params });
    const handler = this.options.handlers?.[method];
    if (!handler) {
      socket.send(
        JSON.stringify({
          id,
          error: {
            code: "unknown_method",
            message: `Unknown bridge method: ${method}`,
            possibleSolutions: ["Update the Godot MCP addon to match the server version."],
          },
        }),
      );
      return;
    }
    const outcome = await handler(params);
    if (typeof outcome === "object" && outcome !== null && "__error" in outcome) {
      socket.send(
        JSON.stringify({ id, error: (outcome as { __error: BridgeErrorPayload }).__error }),
      );
      return;
    }
    socket.send(JSON.stringify({ id, result: outcome }));
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/support/fake-addon-peer.ts
git commit -m "test: fake addon peer - in-process bridge endpoint for Godot-free unit tests"
```

---

### Task 4: BridgeConnection client (reconnect, correlation, timeout, mismatch)

**Files:**

- Create: `src/bridge/connection.ts`
- Test: `test/unit/bridge-connection.test.ts`

**Interfaces:**

- Consumes: protocol.ts exports; FakeAddonPeer.
- Produces:
  - `type BridgeState = "connecting" | "handshaking" | "connected" | "mismatch" | "disconnected"`
  - `interface BridgeStatus { state; hello?; serverVersion; protocolVersion; pendingRequests; lastDisconnectReason? }`
  - `class BridgeConnection { constructor(options); start(); stop(): Promise<void>; status(): BridgeStatus; request(method, params?): Promise<unknown>; waitForState(state, timeoutMs): Promise<void> }`
  - Options: `{ url, serverVersion, requestTimeoutMs, reconnectDelayMs?, log? }`
  - Errors: `BridgeUnavailableError { state, mismatch? }`, `BridgeTimeoutError { method, timeoutMs }`, `BridgeOpError { code?, possibleSolutions[] }` — all `extends Error`, all exported.

- [ ] **Step 1: Write the failing tests**

`test/unit/bridge-connection.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/bridge-connection.test.ts`
Expected: FAIL — cannot resolve `src/bridge/connection.js`.

- [ ] **Step 3: Implement `src/bridge/connection.ts`**

```ts
import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  encodeRequest,
  helloAck,
  parseAddonFrame,
  type Hello,
} from "./protocol.js";

export type BridgeState = "connecting" | "handshaking" | "connected" | "mismatch" | "disconnected";

export interface BridgeStatus {
  state: BridgeState;
  hello?: Hello;
  serverVersion: string;
  protocolVersion: number;
  pendingRequests: number;
  lastDisconnectReason?: string;
}

export interface ProtocolMismatch {
  addonProtocolVersion: number;
  serverProtocolVersion: number;
}

/** Thrown when a request is made with no usable editor connection (REQ-A-04/A-10). */
export class BridgeUnavailableError extends Error {
  constructor(
    message: string,
    readonly state: BridgeState,
    readonly mismatch?: ProtocolMismatch,
  ) {
    super(message);
    this.name = "BridgeUnavailableError";
  }
}

/** Thrown when the addon does not answer a request within requestTimeoutMs (REQ-A-11 floor). */
export class BridgeTimeoutError extends Error {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
  ) {
    super(`The editor did not answer bridge method "${method}" within ${timeoutMs}ms.`);
    this.name = "BridgeTimeoutError";
  }
}

/** An error frame returned by the addon for one specific op. */
export class BridgeOpError extends Error {
  constructor(
    message: string,
    readonly code: string | undefined,
    readonly possibleSolutions: string[],
  ) {
    super(message);
    this.name = "BridgeOpError";
  }
}

export interface BridgeConnectionOptions {
  /** ws://127.0.0.1:<port> - loopback only by design. */
  url: string;
  /** Reported to the addon in hello_ack and in status(). */
  serverVersion: string;
  /** Per-request deadline (config.bridgeTimeoutMs). */
  requestTimeoutMs: number;
  /** Delay between reconnect attempts. Default 1000ms; tests use ~50ms. */
  reconnectDelayMs?: number;
  /** DEBUG-gated stderr logger; never stdout (REQ-A-09). */
  log?: (message: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

/**
 * Reconnecting WebSocket client for the editor addon's bridge (REQ-A-02/A-04).
 * One instance lives for the whole server process: `start()` begins a
 * connect/retry loop that survives any number of editor restarts, and
 * `request()` correlates {id, method, params} -> {id, result|error} frames
 * with a per-request timeout. All failures surface as typed errors that
 * tools/bridge.ts maps onto structured MCP error responses.
 */
export class BridgeConnection {
  private readonly emitter = new EventEmitter();
  private readonly pending = new Map<number, PendingRequest>();
  private socket: WebSocket | null = null;
  private state: BridgeState = "disconnected";
  private hello: Hello | undefined;
  private mismatch: ProtocolMismatch | undefined;
  private lastDisconnectReason: string | undefined;
  private nextId = 1;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private handshakeTimer: NodeJS.Timeout | null = null;
  private stopped = true;

  constructor(private readonly options: BridgeConnectionOptions) {}

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.clearReconnectTimer();
    this.clearHandshakeTimer();
    this.rejectAllPending("bridge client stopped");
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.terminate();
      });
    }
    this.setState("disconnected");
  }

  status(): BridgeStatus {
    return {
      state: this.state,
      hello: this.hello,
      serverVersion: this.options.serverVersion,
      protocolVersion: PROTOCOL_VERSION,
      pendingRequests: this.pending.size,
      lastDisconnectReason: this.lastDisconnectReason,
    };
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.state !== "connected" || this.socket === null) {
      throw this.unavailableError();
    }
    const id = this.nextId++;
    const socket = this.socket;
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new BridgeTimeoutError(method, this.options.requestTimeoutMs));
      }, this.options.requestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      socket.send(encodeRequest({ id, method, params }), (error) => {
        if (error) {
          const entry = this.pending.get(id);
          if (entry) {
            clearTimeout(entry.timer);
            this.pending.delete(id);
            reject(
              new BridgeUnavailableError(
                `Failed to send to the editor: ${error.message}`,
                this.state,
              ),
            );
          }
        }
      });
    });
  }

  /** Resolves once `state` is reached; rejects after timeoutMs. Test/integration helper. */
  async waitForState(state: BridgeState, timeoutMs: number): Promise<void> {
    if (this.state === state) return;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.emitter.off("state", onState);
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for bridge state "${state}" (currently "${this.state}")`,
          ),
        );
      }, timeoutMs);
      const onState = (next: BridgeState) => {
        if (next === state) {
          clearTimeout(timer);
          this.emitter.off("state", onState);
          resolve();
        }
      };
      this.emitter.on("state", onState);
    });
  }

  private connect(): void {
    if (this.stopped) return;
    this.setState("connecting");
    const socket = new WebSocket(this.options.url);
    this.socket = socket;

    socket.on("open", () => {
      this.setState("handshaking");
      // The addon speaks first; if hello never arrives, tear down and retry.
      this.handshakeTimer = setTimeout(() => {
        this.log("handshake timed out waiting for hello; reconnecting");
        socket.terminate();
      }, this.options.requestTimeoutMs);
    });

    socket.on("message", (data) => this.onFrame(String(data)));

    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearHandshakeTimer();
      this.lastDisconnectReason = reason.toString() || `socket closed (code ${code})`;
      this.rejectAllPending("editor connection closed mid-request");
      if (this.state !== "mismatch") this.setState("disconnected");
      this.scheduleReconnect();
    });

    socket.on("error", (error) => {
      this.log(`socket error: ${error.message}`);
      // "close" always follows "error"; reconnect is scheduled there.
    });
  }

  private onFrame(text: string): void {
    const frame = parseAddonFrame(text);
    if (frame.kind === "invalid") {
      this.log(`ignoring invalid frame: ${frame.reason}`);
      return;
    }
    if (frame.kind === "hello") {
      this.clearHandshakeTimer();
      this.hello = frame.hello;
      if (frame.hello.protocol_version !== PROTOCOL_VERSION) {
        this.mismatch = {
          addonProtocolVersion: frame.hello.protocol_version,
          serverProtocolVersion: PROTOCOL_VERSION,
        };
        this.setState("mismatch");
        this.log(
          `protocol mismatch: addon speaks v${frame.hello.protocol_version}, server speaks v${PROTOCOL_VERSION}`,
        );
        this.socket?.close(1002, "protocol version mismatch");
        return;
      }
      this.mismatch = undefined;
      this.socket?.send(helloAck(this.options.serverVersion));
      this.setState("connected");
      return;
    }
    const entry = this.pending.get(frame.response.id);
    if (!entry) {
      this.log(`ignoring response for unknown request id ${frame.response.id}`);
      return;
    }
    this.pending.delete(frame.response.id);
    clearTimeout(entry.timer);
    if (frame.response.error) {
      entry.reject(
        new BridgeOpError(
          frame.response.error.message,
          frame.response.error.code,
          frame.response.error.possibleSolutions ?? [],
        ),
      );
      return;
    }
    entry.resolve(frame.response.result);
  }

  private unavailableError(): BridgeUnavailableError {
    if (this.state === "mismatch" && this.mismatch) {
      return new BridgeUnavailableError(
        `Bridge protocol mismatch: the addon speaks v${this.mismatch.addonProtocolVersion} but this server speaks v${this.mismatch.serverProtocolVersion}. ` +
          "Update the addon copy in the project (and/or update @cradial/godot-mcp) so both sides match, then restart the editor.",
        this.state,
        this.mismatch,
      );
    }
    return new BridgeUnavailableError(
      "The Godot editor is not connected to the MCP server.",
      this.state,
    );
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer !== null) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.options.reconnectDelayMs ?? 1_000);
  }

  private rejectAllPending(reason: string): void {
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new BridgeUnavailableError(reason, this.state));
      this.pending.delete(id);
    }
  }

  private setState(state: BridgeState): void {
    if (this.state === state) return;
    this.state = state;
    this.emitter.emit("state", state);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  private log(message: string): void {
    this.options.log?.(`[bridge] ${message}`);
  }
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/bridge-connection.test.ts`
Expected: PASS (7 cases). If the reconnect case flakes on port reuse, re-run once; a persistent failure means `FakeAddonPeer.close()` isn't fully releasing the port — fix the harness, not the test.

- [ ] **Step 5: Commit**

```bash
git add src/bridge/connection.ts test/unit/bridge-connection.test.ts
git commit -m "feat: reconnecting bridge client - handshake, correlation, timeout, mismatch (REQ-A-02)"
```

---

### Task 5: Bridge tools — `bridge_status` + `get_godot_version`

**Files:**

- Create: `src/tools/bridge.ts`
- Test: `test/unit/bridge-tools.test.ts`

**Interfaces:**

- Consumes: `BridgeConnection` + error classes; `createErrorResponse`; `ToolDescriptor`.
- Produces: `interface BridgePort { status(): BridgeStatus; request(method, params?): Promise<unknown> }`; `createBridgeTools(deps: { bridge: BridgePort; serverVersion: string }): ToolDescriptor[]`; `EDITOR_NOT_CONNECTED_SOLUTIONS: string[]`; `bridgeErrorToResponse(error: unknown)`. Consumed by server.ts (Task 6) and every future tool slice (#65–#77 reuse `bridgeErrorToResponse` + the solutions constant).

- [ ] **Step 1: Write the failing tests**

`test/unit/bridge-tools.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run test/unit/bridge-tools.test.ts`
Expected: FAIL — cannot resolve `src/tools/bridge.js`.

- [ ] **Step 3: Implement `src/tools/bridge.ts`**

```ts
import { createErrorResponse } from "../errors.js";
import type { ToolDescriptor } from "../registry.js";
import type { BridgeStatus } from "../bridge/connection.js";
import { BridgeOpError, BridgeTimeoutError, BridgeUnavailableError } from "../bridge/connection.js";

/** The narrow slice of BridgeConnection tools depend on (fake-able in tests). */
export interface BridgePort {
  status(): BridgeStatus;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

export interface BridgeToolsDeps {
  bridge: BridgePort;
  serverVersion: string;
}

/**
 * Standard guidance for "no editor is connected" (REQ-A-10). Reused verbatim
 * by every tool slice; the final wording (incl. addon_install, which arrives
 * in #66) is refined by #65/#66 without changing the 1.x pointer.
 */
export const EDITOR_NOT_CONNECTED_SOLUTIONS: string[] = [
  "Open the project in the Godot editor and keep it running - v2 tools execute inside a live editor.",
  "Install the bridge addon by copying addon/godot_mcp into the project's addons/ folder, then enable 'Godot MCP' under Project > Project Settings > Plugins.",
  "Check bridge_status for the connection state and last disconnect reason the server sees.",
  "Need headless (no-editor) workflows? Use @cradial/godot-mcp@1.x - the 1.x line keeps the CLI-based tools.",
];

/**
 * Maps a typed bridge failure onto the structured error shape (REQ-A-08).
 * Anything unrecognized is re-thrown - a genuine bug should crash loudly in
 * dev rather than masquerade as a guided tool error.
 */
export function bridgeErrorToResponse(error: unknown) {
  if (error instanceof BridgeUnavailableError) {
    return createErrorResponse({
      message: error.message,
      possibleSolutions: error.mismatch
        ? [
            "Update the addon copy inside the project to the version bundled with this server.",
            "Or update @cradial/godot-mcp so the server matches the project's addon.",
            "Restart the Godot editor after updating, then retry.",
          ]
        : EDITOR_NOT_CONNECTED_SOLUTIONS,
    });
  }
  if (error instanceof BridgeTimeoutError) {
    return createErrorResponse({
      message: error.message,
      possibleSolutions: [
        "Check whether the editor is busy (importing assets, showing a modal dialog) and retry.",
        "Raise BRIDGE_TIMEOUT_MS if this project legitimately needs longer operations.",
      ],
    });
  }
  if (error instanceof BridgeOpError) {
    return createErrorResponse({
      message: error.message,
      possibleSolutions: error.possibleSolutions,
    });
  }
  throw error;
}

interface SystemStatusResult {
  [key: string]: unknown;
  protocol_version: number;
  addon_version: string;
  godot_version: Record<string, unknown>;
  godot_version_string: string;
  features: Record<string, boolean>;
  project_path: string;
  uptime_ms: number;
  queue_depth: number;
}

function successResult(label: string, payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: `${label}: ${JSON.stringify(payload)}` }],
    structuredContent: payload,
  };
}

/**
 * The two walking-skeleton tools (#64). Both round-trip a real bridge op
 * (`system/status`) when connected - REQ-A-01's "no headless process" proof
 * runs through these in integration.
 */
export function createBridgeTools(deps: BridgeToolsDeps): ToolDescriptor[] {
  const getGodotVersion: ToolDescriptor = {
    name: "get_godot_version",
    description:
      "Report the connected editor's Godot version plus the bridge addon and MCP server versions.",
    inputSchema: {},
    handler: async () => {
      try {
        const live = (await deps.bridge.request("system/status")) as SystemStatusResult;
        return successResult("Godot version", {
          godot_version: live.godot_version,
          godot_version_string: live.godot_version_string,
          features: live.features,
          addon_version: live.addon_version,
          server_version: deps.serverVersion,
          protocol_version: live.protocol_version,
        });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const bridgeStatus: ToolDescriptor = {
    name: "bridge_status",
    description:
      "Report the editor bridge state: connection, handshake data (Godot/addon versions, project path), and op queue depth.",
    inputSchema: {},
    handler: async () => {
      const status = deps.bridge.status();
      if (status.state !== "connected") {
        return successResult("Bridge status", {
          state: status.state,
          server_version: deps.serverVersion,
          protocol_version: status.protocolVersion,
          last_disconnect_reason: status.lastDisconnectReason ?? null,
          addon_protocol_version: status.hello?.protocol_version ?? null,
          guidance: EDITOR_NOT_CONNECTED_SOLUTIONS,
        });
      }
      try {
        const live = (await deps.bridge.request("system/status")) as SystemStatusResult;
        return successResult("Bridge status", {
          state: "connected",
          server_version: deps.serverVersion,
          protocol_version: status.protocolVersion,
          addon_version: live.addon_version,
          godot_version: live.godot_version,
          godot_version_string: live.godot_version_string,
          features: live.features,
          project_path: live.project_path,
          uptime_ms: live.uptime_ms,
          queue_depth: live.queue_depth,
          pending_requests: status.pendingRequests,
        });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  return [bridgeStatus, getGodotVersion];
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run test/unit/bridge-tools.test.ts`
Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

```bash
git add src/tools/bridge.ts test/unit/bridge-tools.test.ts
git commit -m "feat: bridge_status + get_godot_version served over the bridge (REQ-A-02, A-07 query half, A-08)"
```

---

### Task 6: Retire the headless path; rewire server, registry, config

**Files:**

- Delete: `src/godot/runner.ts`, `src/godot/process.ts`, `src/godot/discovery.ts`, `src/godot/cache.ts`, `src/godot/script-errors.ts`, `src/godot/version-gate.ts`, `src/godot/operations.gd`, `src/tools/editor.ts`, `src/tools/project.ts`, `src/tools/readback.ts`, `src/tools/run.ts`, `src/tools/scene.ts`, `src/tools/uid.ts`, `src/tools/operation-result.ts`
- Delete tests: `test/unit/editor-tools.test.ts`, `test/unit/project-tools.test.ts`, `test/unit/readback-tools.test.ts`, `test/unit/run-tools.test.ts`, `test/unit/runner.test.ts`, `test/unit/scene-tools.test.ts`, `test/unit/uid-tools.test.ts`, `test/unit/script-errors.test.ts`, `test/unit/process.test.ts`, `test/unit/discovery.test.ts`, `test/unit/godot-cache.test.ts`, `test/unit/version-gate.test.ts`, entire `test/integration/` directory (rebuilt in Task 9)
- Modify: `src/registry.ts`, `src/server.ts`, `src/config.ts`, `src/index.ts` (unchanged import path — verify only), `tsup.config.ts`, `vitest.config.ts`
- Rewrite tests: `test/unit/server.test.ts`, `test/unit/registry.test.ts` (drop gate cases), `test/unit/config.test.ts` (add new keys)

**Interfaces:**

- Produces: `SERVER_VERSION = "2.0.0-alpha.0"` (exported from server.ts); `buildToolInventory(deps: { bridge: BridgePort }): ToolDescriptor[]`; `createServer(options: { bridge: BridgePort }): McpServer`; `createShutdown({ stopBridge, closeServer, exit, debugLog })`; config gains `bridgePort` (`GODOT_MCP_PORT`, default 6510) and `bridgeTimeoutMs` (`BRIDGE_TIMEOUT_MS`, default 30000). `registry.ts` loses `minGodotVersion`/version-gate entirely (reintroduced handshake-keyed by #71). Consumed by Tasks 7 and 9.

- [ ] **Step 1: Delete the retired modules and their tests**

```bash
git rm src/godot/runner.ts src/godot/process.ts src/godot/discovery.ts src/godot/cache.ts src/godot/script-errors.ts src/godot/version-gate.ts src/godot/operations.gd
git rm src/tools/editor.ts src/tools/project.ts src/tools/readback.ts src/tools/run.ts src/tools/scene.ts src/tools/uid.ts src/tools/operation-result.ts
git rm test/unit/editor-tools.test.ts test/unit/project-tools.test.ts test/unit/readback-tools.test.ts test/unit/run-tools.test.ts test/unit/runner.test.ts test/unit/scene-tools.test.ts test/unit/uid-tools.test.ts test/unit/script-errors.test.ts test/unit/process.test.ts test/unit/discovery.test.ts test/unit/godot-cache.test.ts test/unit/version-gate.test.ts
git rm -r test/integration
```

Note: keep `src/godot/paths.ts`, `src/godot/values.ts`, `src/schemas.ts`, `src/errors.ts` and their tests — carried forward per issue #64. If `test/unit/path-containment.test.ts` or others import a deleted module, fix the import (they should only use `paths.ts`).

- [ ] **Step 2: Simplify `src/registry.ts` (drop version gating — YAGNI until #71)**

Replace the whole file with:

```ts
import type { McpServer, ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { z } from "zod";

/**
 * A plain, unit-testable description of one MCP tool. Registration is a
 * generic loop over an array of these (see `registerAll`) - there is no
 * hand-rolled list/dispatch; the SDK derives the JSON schema from
 * `inputSchema` and routes calls to `handler`.
 *
 * v2 note: 1.0's `minGodotVersion` call-time gating was removed with the
 * headless `--version` probe; REQ-A-07's handshake-keyed gate reintroduces
 * descriptor-level version metadata in #71. Descriptors stay otherwise
 * identical, so tool slices #65-#77 add entries without touching this file.
 */
export interface ToolDescriptor<Args extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  description: string;
  /** Zod raw shape (plain object of zod schemas), not a wrapped ZodObject. */
  inputSchema: Args;
  handler: ToolCallback<Args>;
}

/**
 * Registers every descriptor on `server` via `McpServer.registerTool()`.
 * Fails fast (no partial registration) if any descriptor names collide.
 */
export function registerAll(
  server: Pick<McpServer, "registerTool">,
  descriptors: readonly ToolDescriptor[],
): void {
  const seen = new Set<string>();
  for (const descriptor of descriptors) {
    if (seen.has(descriptor.name)) {
      throw new Error(`Duplicate tool name registered: "${descriptor.name}"`);
    }
    seen.add(descriptor.name);
  }
  for (const descriptor of descriptors) {
    server.registerTool(
      descriptor.name,
      { description: descriptor.description, inputSchema: descriptor.inputSchema },
      descriptor.handler,
    );
  }
}
```

Update `test/unit/registry.test.ts`: delete every case that injects/exercises a version gate or `minGodotVersion`; keep (or re-add) these two:

```ts
import { describe, expect, it } from "vitest";
import { registerAll, type ToolDescriptor } from "../../src/registry.js";

function fakeServer() {
  const registered: string[] = [];
  return {
    registered,
    registerTool: (name: string) => {
      registered.push(name);
    },
  };
}

const descriptor = (name: string): ToolDescriptor => ({
  name,
  description: "test tool",
  inputSchema: {},
  handler: async () => ({ content: [] }),
});

describe("registerAll", () => {
  it("registers every descriptor once", () => {
    const server = fakeServer();
    registerAll(server as never, [descriptor("tool_one"), descriptor("tool_two")]);
    expect(server.registered).toEqual(["tool_one", "tool_two"]);
  });

  it("throws on duplicate names before registering anything", () => {
    const server = fakeServer();
    expect(() =>
      registerAll(server as never, [descriptor("tool_one"), descriptor("tool_one")]),
    ).toThrow('Duplicate tool name registered: "tool_one"');
    expect(server.registered).toEqual([]);
  });
});
```

- [ ] **Step 3: Extend `src/config.ts`**

Add after `DEFAULT_OUTPUT_BUFFER_LINES`:

```ts
/** Default bridge WebSocket port - must match the addon's godot_mcp/network/port setting. */
export const DEFAULT_BRIDGE_PORT = 6510;
/** Default per-op bridge timeout (REQ-A-11 floor; progress-frame extension arrives in #75). */
export const DEFAULT_BRIDGE_TIMEOUT_MS = 30_000;
```

Extend `ConfigSchema` with:

```ts
  /** Bridge WebSocket port (GODOT_MCP_PORT). Loopback-only by construction. */
  bridgePort: z.number().int().min(1).max(65_535),
  /** Per-request bridge timeout in ms (BRIDGE_TIMEOUT_MS). */
  bridgeTimeoutMs: z.number().int().positive(),
```

Add readers (same lenient style as `readOutputBufferLines` — fall back to the default on unset/garbage/out-of-range):

```ts
function readBridgePort(env: NodeJS.ProcessEnv): number {
  const value = env.GODOT_MCP_PORT?.trim();
  if (!value) return DEFAULT_BRIDGE_PORT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65_535) return DEFAULT_BRIDGE_PORT;
  return parsed;
}

function readBridgeTimeoutMs(env: NodeJS.ProcessEnv): number {
  const value = env.BRIDGE_TIMEOUT_MS?.trim();
  if (!value) return DEFAULT_BRIDGE_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) return DEFAULT_BRIDGE_TIMEOUT_MS;
  return parsed;
}
```

Wire both into `loadConfig`. Keep `godotPath` (create_project scaffolding, #66) and `outputBufferLines` (run-output buffer, #72) with a one-line comment each saying which slice consumes them.

Add to `test/unit/config.test.ts` (match its existing style):

```ts
it("defaults bridgePort to 6510 and honors GODOT_MCP_PORT", () => {
  expect(loadConfig({}).bridgePort).toBe(6510);
  expect(loadConfig({ GODOT_MCP_PORT: "7000" }).bridgePort).toBe(7000);
  expect(loadConfig({ GODOT_MCP_PORT: "0" }).bridgePort).toBe(6510);
  expect(loadConfig({ GODOT_MCP_PORT: "not-a-port" }).bridgePort).toBe(6510);
});

it("defaults bridgeTimeoutMs to 30000 and honors BRIDGE_TIMEOUT_MS", () => {
  expect(loadConfig({}).bridgeTimeoutMs).toBe(30_000);
  expect(loadConfig({ BRIDGE_TIMEOUT_MS: "5000" }).bridgeTimeoutMs).toBe(5_000);
  expect(loadConfig({ BRIDGE_TIMEOUT_MS: "-1" }).bridgeTimeoutMs).toBe(30_000);
});
```

- [ ] **Step 4: Rewrite `src/server.ts`**

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { BridgeConnection } from "./bridge/connection.js";
import { loadConfig } from "./config.js";
import { registerAll, type ToolDescriptor } from "./registry.js";
import { createBridgeTools, type BridgePort } from "./tools/bridge.js";

const SERVER_NAME = "godot-mcp";
/** Kept in lockstep with package.json - asserted by test/unit/server.test.ts. */
export const SERVER_VERSION = "2.0.0-alpha.0";

export interface ServerDeps {
  bridge: BridgePort;
}

/**
 * The complete tool inventory, in registration order. Exported (rather than
 * inlined in createServer) so the REQ-A-05 naming lint and the REQ-M-03
 * code-exec audit (#76) can walk exactly what ships, with a stub bridge.
 */
export function buildToolInventory(deps: ServerDeps): ToolDescriptor[] {
  return [...createBridgeTools({ bridge: deps.bridge, serverVersion: SERVER_VERSION })];
}

/** Builds the MCP server and registers every tool. Pure wiring; never touches the network itself. */
export function createServer(deps: ServerDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  registerAll(server, buildToolInventory(deps));
  return server;
}

export interface CreateShutdownOptions {
  stopBridge: () => Promise<void>;
  closeServer: () => Promise<void>;
  exit: (code: number) => void;
  debugLog: (message: string) => void;
}

/**
 * Tears down bridge + server on SIGINT/SIGTERM. Exits even if either close
 * fails - shutdown must never hang.
 */
export function createShutdown(options: CreateShutdownOptions): (signal: string) => void {
  return (signal) => {
    options.debugLog(`received ${signal}, shutting down`);
    void Promise.allSettled([options.stopBridge(), options.closeServer()])
      .then((results) => {
        for (const result of results) {
          if (result.status === "rejected") {
            options.debugLog(`shutdown step failed: ${String(result.reason)}`);
          }
        }
      })
      .finally(() => options.exit(0));
  };
}

/** Sanity check that the packaged addon payload shipped next to the build (successor of 1.0's operations.gd check). */
export function resolveBundledAddonDir(): string {
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "addon", "godot_mcp");
}

/** Starts the server over stdio. Logs (stderr only) are gated by DEBUG (REQ-A-09/M-07). */
export async function main(): Promise<void> {
  const config = loadConfig();
  const debugLog = (message: string) => {
    if (config.debug) console.error(`[godot-mcp] ${message}`);
  };

  debugLog("starting stdio MCP server (v2 bridge mode)");

  const bridge = new BridgeConnection({
    url: `ws://127.0.0.1:${config.bridgePort}`,
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: config.bridgeTimeoutMs,
    log: debugLog,
  });
  bridge.start();

  const server = createServer({ bridge });
  const transport = new StdioServerTransport();
  await server.connect(transport);

  debugLog(`connected; bridging to ws://127.0.0.1:${config.bridgePort}`);

  const shutdown = createShutdown({
    stopBridge: () => bridge.stop(),
    closeServer: () => server.close(),
    exit: (code) => process.exit(code),
    debugLog,
  });
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
}

/** Test hook: reads package.json's version for the lockstep assertion. */
export function packageJsonVersion(): string {
  const packagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");
  return (JSON.parse(readFileSync(packagePath, "utf8")) as { version: string }).version;
}
```

Note: `resolveBundledAddonDir` resolves relative to the module file; from `src/` that is the repo root's `addon/godot_mcp`, from `dist/` the packaged `addon/godot_mcp` (#77 wires the startup assert + packaging; the resolver ships now so Task 9's support code and #66 share it).

- [ ] **Step 5: Rewrite `test/unit/server.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import {
  SERVER_VERSION,
  buildToolInventory,
  createServer,
  createShutdown,
  packageJsonVersion,
} from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";

const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
  }),
  request: async () => {
    throw new Error("stub bridge has no editor");
  },
};

describe("server wiring", () => {
  it("SERVER_VERSION stays in lockstep with package.json", () => {
    expect(SERVER_VERSION).toBe(packageJsonVersion());
  });

  it("builds the walking-skeleton inventory", () => {
    const names = buildToolInventory({ bridge: stubBridge }).map((tool) => tool.name);
    expect(names).toEqual(["bridge_status", "get_godot_version"]);
  });

  it("createServer registers without touching the bridge", () => {
    expect(() => createServer({ bridge: stubBridge })).not.toThrow();
  });

  it("createShutdown exits even when both closes fail", async () => {
    let exitCode: number | null = null;
    const shutdown = createShutdown({
      stopBridge: () => Promise.reject(new Error("bridge close failed")),
      closeServer: () => Promise.reject(new Error("server close failed")),
      exit: (code) => {
        exitCode = code;
      },
      debugLog: () => undefined,
    });
    shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitCode).toBe(0);
  });
});
```

- [ ] **Step 6: Update `tsup.config.ts` and `vitest.config.ts`**

`tsup.config.ts` — delete the `onSuccess` block and its comment (no more operations.gd; the addon ships as plain files via the package `files` array in #77):

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
```

`vitest.config.ts` — COVERAGE_INCLUDE becomes (comment updated to cite PRD #63 §9: gate on the pure layers; `bridge/connection.ts` is deliberately excluded — socket/timer-driven, unit-tested but not gate-scoped):

```ts
const COVERAGE_INCLUDE = [
  "src/schemas.ts",
  "src/godot/paths.ts",
  "src/godot/values.ts",
  "src/config.ts",
  "src/registry.ts",
  "src/bridge/protocol.ts",
];
```

- [ ] **Step 7: Full local gate**

Run: `npm run format:fix; npm run lint; npm run typecheck; npm test`
Expected: ALL PASS. Coverage thresholds hold (protocol.ts is fully covered by Task 2's tests). If lint flags unused exports in `schemas.ts` (its consumers were deleted), do NOT delete the schemas — suppress nothing; they're consumed again by #66/#67. If eslint complains about genuinely-unused _imports_ in kept files, fix those imports.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat!: retire headless execution path; server runs on the editor bridge (REQ-A-01, AD-3)"
```

---

### Task 7: REQ-A-05 naming lint + strategy doc

**Files:**

- Create: `test/unit/naming-lint.test.ts`, `docs/tool-naming.md`

**Interfaces:**

- Consumes: `buildToolInventory`, `BridgePort`.
- Produces: the standing lint every future slice must pass (it runs in `npm test`, which CI runs — that makes it "a CI lint" per REQ-A-05).

- [ ] **Step 1: Write the lint test (it should pass immediately for the two tools — the point is the standing gate)**

`test/unit/naming-lint.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, buildToolInventory } from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";

/**
 * REQ-A-05: every tool ships with a snake_case multi-segment name
 * (domain_verb_noun style), a lean single-line description, and snake_case
 * params. This suite runs in `npm test` on every CI leg - adding a tool that
 * violates the strategy fails the build, which is the enforcement REQ-A-05
 * demands. The human-facing strategy lives in docs/tool-naming.md.
 */
const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const PARAM_PATTERN = /^[a-z][a-z0-9_]*$/;
const DESCRIPTION_BUDGET = 200;

const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
  }),
  request: async () => {
    throw new Error("stub bridge - lint never calls tools");
  },
};

const inventory = buildToolInventory({ bridge: stubBridge });

describe("REQ-A-05 naming lint", () => {
  it("has at least the walking-skeleton tools", () => {
    expect(inventory.length).toBeGreaterThanOrEqual(2);
  });

  it("every tool name is snake_case with >= 2 segments", () => {
    for (const tool of inventory) {
      expect(tool.name, `tool name violates naming pattern: ${tool.name}`).toMatch(NAME_PATTERN);
    }
  });

  it("tool names are unique", () => {
    const names = inventory.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it(`every description is single-line and <= ${DESCRIPTION_BUDGET} chars`, () => {
    for (const tool of inventory) {
      expect(tool.description.length, `${tool.name}: empty description`).toBeGreaterThan(0);
      expect(
        tool.description.length,
        `${tool.name}: description over budget (${tool.description.length})`,
      ).toBeLessThanOrEqual(DESCRIPTION_BUDGET);
      expect(tool.description, `${tool.name}: description must be single-line`).not.toContain("\n");
    }
  });

  it("every param key is snake_case", () => {
    for (const tool of inventory) {
      for (const key of Object.keys(tool.inputSchema)) {
        expect(key, `${tool.name}: param violates snake_case: ${key}`).toMatch(PARAM_PATTERN);
      }
    }
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/unit/naming-lint.test.ts`
Expected: PASS.

- [ ] **Step 3: Write `docs/tool-naming.md`**

```markdown
# Tool naming & progressive disclosure (REQ-A-05)

v2 ships large per-domain tool suites (AD-8). What keeps that usable is a
context-discipline strategy enforced by a standing lint
(`test/unit/naming-lint.test.ts`, run on every CI leg):

## Rules (lint-enforced)

1. **Names**: `snake_case`, at least two segments, `domain_verb_noun` style —
   the segments an agent scans first carry the domain and the action
   (`bridge_status`, `get_godot_version`, `create_scene`, `add_node`).
   Prefer the established Godot term over an invented one.
2. **Descriptions**: single line, ≤ 200 characters, starting with the verb
   phrase ("Report…", "Create…"). No usage essays — parameter docs belong on
   the zod schemas, error guidance belongs in `possibleSolutions`.
3. **Params**: `snake_case` keys, validated by zod schemas
   (`src/schemas.ts` fragments where shared).
4. **Uniqueness**: duplicate names fail registration (`registerAll`) _and_
   the lint.

## Strategy (human judgment, reviewed at PR time)

- **Domain grouping**: tools live in per-domain files under `src/tools/`;
  registration order groups domains together so clients that list tools see
  a coherent catalogue.
- **Deferred discovery**: lean names + lean descriptions are what make
  deferred/searchable tool loading work in capable clients; write for the
  agent that greps a 150-tool list, not for a README reader.
- **Router meta-tools** (REQ-A-06) arrive in M3 for clients without deferred
  loading; nothing in M1/M2 may depend on their existence.
- **Renames are breaking**: after the first `2.0.0-alpha` publish, renaming a
  tool requires a changelog entry and a deprecation note in the description
  of any transitional alias.
```

- [ ] **Step 4: Full unit run + commit**

Run: `npm test`
Expected: PASS.

```bash
git add test/unit/naming-lint.test.ts docs/tool-naming.md
git commit -m "feat: REQ-A-05 naming lint (standing CI gate) + strategy doc"
```

---

### Task 8: The editor addon (GDScript)

**Files:**

- Create: `addon/godot_mcp/plugin.cfg`, `addon/godot_mcp/plugin.gd`, `addon/godot_mcp/server.gd`

**Interfaces:**

- Produces: WebSocket server on `127.0.0.1:<godot_mcp/network/port or 6510>` inside the editor; sends `hello`; serves `system/status`; refuses a second client; logs to the editor Output panel. Version string in `plugin.cfg` must equal `SERVER_VERSION` (2.0.0-alpha.0) — the handshake carries it.
- Consumed by: Task 9's integration harness; #65+ add ops to `_dispatch`.

- [ ] **Step 1: `addon/godot_mcp/plugin.cfg`**

```ini
[plugin]

name="Godot MCP"
description="Bridge for AI agents: hosts a loopback WebSocket server the @cradial/godot-mcp MCP server connects to."
author="cradial"
version="2.0.0-alpha.0"
script="plugin.gd"
```

- [ ] **Step 2: `addon/godot_mcp/plugin.gd`**

```gdscript
@tool
extends EditorPlugin

## Entry point of the Godot MCP addon (REQ-A-01): owns the bridge server's
## lifecycle. All logging goes to the editor Output panel (REQ-A-09/M-07).

const BRIDGE_SERVER_SCRIPT := preload("res://addons/godot_mcp/server.gd")

var _server: Node = null


func _enter_tree() -> void:
	_server = BRIDGE_SERVER_SCRIPT.new()
	_server.name = "GodotMcpBridgeServer"
	add_child(_server)


func _exit_tree() -> void:
	if _server != null:
		_server.queue_free()
		_server = null
```

- [ ] **Step 3: `addon/godot_mcp/server.gd`**

```gdscript
@tool
extends Node

## Loopback WebSocket bridge server (REQ-A-02). One client at a time; a
## versioned hello on connect; requests execute serially in arrival order
## (REQ-A-12) - one op per editor frame, popped from _queue.
##
## PROTOCOL_VERSION mirrors src/bridge/protocol.ts - bump both together.

const PROTOCOL_VERSION := 1
const DEFAULT_PORT := 6510
const PORT_SETTING := "godot_mcp/network/port"

var _tcp := TCPServer.new()
var _peer: WebSocketPeer = null
var _hello_sent := false
var _queue: Array[Dictionary] = []
var _start_ms := 0


func _ready() -> void:
	_start_ms = Time.get_ticks_msec()
	var port := DEFAULT_PORT
	if ProjectSettings.has_setting(PORT_SETTING):
		port = int(ProjectSettings.get_setting(PORT_SETTING))
	var err := _tcp.listen(port, "127.0.0.1")
	if err != OK:
		push_error("[godot-mcp] Failed to listen on 127.0.0.1:%d (error %d). Is another editor already bridging this port?" % [port, err])
		return
	print("[godot-mcp] Bridge listening on ws://127.0.0.1:%d" % port)


func _exit_tree() -> void:
	if _peer != null:
		_peer.close()
	_tcp.stop()


func _process(_delta: float) -> void:
	_accept_pending()
	if _peer == null:
		return
	_peer.poll()
	var state := _peer.get_ready_state()
	if state == WebSocketPeer.STATE_OPEN:
		if not _hello_sent:
			_send_json(_hello())
			_hello_sent = true
		while _peer.get_available_packet_count() > 0:
			_receive(_peer.get_packet().get_string_from_utf8())
		_drain_queue()
	elif state == WebSocketPeer.STATE_CLOSED:
		print("[godot-mcp] Bridge client disconnected (code %d)." % _peer.get_close_code())
		_reset_peer()


func _accept_pending() -> void:
	while _tcp.is_connection_available():
		var conn := _tcp.take_connection()
		if conn == null:
			continue
		if _peer != null and _peer.get_ready_state() != WebSocketPeer.STATE_CLOSED:
			# Single-client policy (PRD #63 §7): drop the extra connection.
			push_warning("[godot-mcp] Refused a second concurrent bridge client.")
			conn.disconnect_from_host()
			continue
		var ws := WebSocketPeer.new()
		var err := ws.accept_stream(conn)
		if err != OK:
			push_warning("[godot-mcp] WebSocket accept failed (error %d)." % err)
			continue
		_peer = ws
		_hello_sent = false


func _reset_peer() -> void:
	_peer = null
	_hello_sent = false
	_queue.clear()


func _receive(text: String) -> void:
	var parsed: Variant = JSON.parse_string(text)
	if typeof(parsed) != TYPE_DICTIONARY:
		push_warning("[godot-mcp] Ignoring malformed (non-object) frame.")
		return
	var frame: Dictionary = parsed
	if str(frame.get("type", "")) == "hello_ack":
		print("[godot-mcp] MCP server connected: v%s (protocol %s)." % [
			str(frame.get("server_version", "?")),
			str(frame.get("protocol_version", "?")),
		])
		return
	if not frame.has("id") or not frame.has("method"):
		push_warning("[godot-mcp] Ignoring frame with no id/method.")
		return
	_queue.push_back(frame)


func _drain_queue() -> void:
	# Serialized execution, arrival order (REQ-A-12): one op per frame keeps
	# the editor responsive and makes op interleaving deterministic.
	if _queue.is_empty():
		return
	var frame: Dictionary = _queue.pop_front()
	var id: Variant = frame.get("id")
	var method := str(frame.get("method", ""))
	var params: Dictionary = {}
	if typeof(frame.get("params")) == TYPE_DICTIONARY:
		params = frame["params"]
	var outcome := _dispatch(method, params)
	if outcome.has("error"):
		_send_json({"id": id, "error": outcome["error"]})
	else:
		_send_json({"id": id, "result": outcome.get("result")})


## Named-op dispatch table (REQ-M-03: only named ops exist - there is no
## eval/exec pathway). Later slices append branches here via ops/*.gd.
func _dispatch(method: String, _params: Dictionary) -> Dictionary:
	match method:
		"system/status":
			return {"result": _status()}
		_:
			return {"error": {
				"code": "unknown_method",
				"message": "Unknown bridge method: %s" % method,
				"possibleSolutions": [
					"Update the Godot MCP addon in this project to match the MCP server version.",
					"Call bridge_status and compare addon_version and server_version.",
				],
			}}


func _hello() -> Dictionary:
	var v := Engine.get_version_info()
	return {
		"type": "hello",
		"protocol_version": PROTOCOL_VERSION,
		"addon_version": _addon_version(),
		"godot_version": {
			"major": int(v.get("major", 0)),
			"minor": int(v.get("minor", 0)),
			"patch": int(v.get("patch", 0)),
			"status": str(v.get("status", "unknown")),
		},
		"godot_version_string": "%d.%d.%d.%s" % [
			int(v.get("major", 0)), int(v.get("minor", 0)), int(v.get("patch", 0)), str(v.get("status", "unknown")),
		],
		"features": {"dotnet": ClassDB.class_exists("CSharpScript")},
		"project_path": ProjectSettings.globalize_path("res://"),
	}


func _status() -> Dictionary:
	var hello := _hello()
	return {
		"protocol_version": PROTOCOL_VERSION,
		"addon_version": hello["addon_version"],
		"godot_version": hello["godot_version"],
		"godot_version_string": hello["godot_version_string"],
		"features": hello["features"],
		"project_path": hello["project_path"],
		"uptime_ms": Time.get_ticks_msec() - _start_ms,
		"queue_depth": _queue.size(),
	}


func _addon_version() -> String:
	var cfg := ConfigFile.new()
	if cfg.load("res://addons/godot_mcp/plugin.cfg") == OK:
		return str(cfg.get_value("plugin", "version", "unknown"))
	return "unknown"


func _send_json(data: Dictionary) -> void:
	if _peer != null and _peer.get_ready_state() == WebSocketPeer.STATE_OPEN:
		_peer.send_text(JSON.stringify(data))
```

- [ ] **Step 4: Commit (verified end-to-end by Task 9)**

```bash
git add addon/godot_mcp
git commit -m "feat: godot_mcp editor addon - loopback WS bridge, hello handshake, system/status op (REQ-A-01, A-02)"
```

---

### Task 9: Sample project wiring + real-editor integration harness

**Files:**

- Modify: `examples/sample-project/project.godot` (enable the plugin; keep existing content), `.gitignore` (ignore `examples/sample-project/addons/`), `vitest.integration.config.ts` (timeouts)
- Create: `test/integration/support.ts` (rewrite from scratch — old one was deleted in Task 6), `test/integration/bridge.integration.test.ts`

**Interfaces:**

- Consumes: `BridgeConnection`, `createServer`, `SERVER_VERSION`, `resolveBundledAddonDir`, MCP SDK `Client` + `InMemoryTransport`.
- Produces: `support.ts` exports `godotPath`, `hasGodot`, `freshSampleProject()`, `installAddon(projectDir)`, `setBridgePort(projectDir, port)`, `pickFreePort()`, `launchEditor(projectDir)`, `importPass(projectDir)`, `warnSkippedCoverage()` — reused by every later integration slice.

- [ ] **Step 1: Enable the plugin in the sample project**

Append to `examples/sample-project/project.godot` (read the file first; add the section only if absent, after the existing sections):

```ini
[editor_plugins]

enabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")
```

Add to `.gitignore`:

```
# Test-installed addon copy (installAddon copies addon/godot_mcp here; source of truth is /addon)
examples/sample-project/addons/
```

- [ ] **Step 2: `test/integration/support.ts`**

```ts
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolveBundledAddonDir } from "../../src/server.js";

const execFileAsync = promisify(execFile);

/** Loud, greppable skip warning - never silently green with zero tests run. */
export function warnSkippedCoverage(caseName: string, reason: string): void {
  console.warn(`[coverage] SKIPPED mandated case "${caseName}": ${reason}`);
}

export const SAMPLE_PROJECT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "sample-project",
);

export const godotPath = process.env.GODOT_PATH?.trim();
export const hasGodot = Boolean(godotPath && existsSync(godotPath));

if (!hasGodot) {
  warnSkippedCoverage(
    "all test/integration/* cases",
    "GODOT_PATH is unset or does not point at an existing file - v2 integration tests drive a " +
      "real Godot 4.x EDITOR. Set GODOT_PATH to a Godot editor binary and re-run " +
      "`npm run test:integration`.",
  );
}

/** Copies the committed sample project into a disposable temp dir. */
export function freshSampleProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-sample-project-"));
  cpSync(SAMPLE_PROJECT_DIR, dir, { recursive: true });
  return dir;
}

/** Installs the repo's addon source into the project (what addon_install will do in #66). */
export function installAddon(projectDir: string): void {
  cpSync(resolveBundledAddonDir(), path.join(projectDir, "addons", "godot_mcp"), {
    recursive: true,
  });
}

/**
 * Points the addon at a test-chosen port by appending the godot_mcp section
 * to project.godot (ProjectSettings reads custom sections verbatim).
 */
export function setBridgePort(projectDir: string, port: number): void {
  const projectFile = path.join(projectDir, "project.godot");
  const current = readFileSync(projectFile, "utf8");
  if (current.includes("[godot_mcp]")) {
    throw new Error("sample project already has a [godot_mcp] section; refusing to double-append");
  }
  appendFileSync(projectFile, `\n[godot_mcp]\n\nnetwork/port=${port}\n`);
}

/** Asks the OS for a free loopback port, then releases it for the editor to claim. */
export async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not determine free port")));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * One-shot import pass so the editor boots with a warm .godot cache. Test
 * infrastructure may exec Godot directly - the PRODUCT no longer does
 * (REQ-A-01); this is exactly the split issue #64 prescribes.
 */
export async function importPass(projectDir: string): Promise<void> {
  await execFileAsync(godotPath!, ["--headless", "--import", "--path", projectDir], {
    timeout: 120_000,
  });
}

export interface EditorHandle {
  child: ChildProcess;
  /** SIGKILL + wait for exit - used by the disconnect test and afterAll. */
  kill(): Promise<void>;
}

/**
 * Boots a real Godot EDITOR on the project. CI wraps the whole test run in
 * xvfb-run (see .github/workflows/ci.yml); locally this opens a visible
 * editor window unless GODOT_MCP_TEST_HEADLESS=1 adds --headless.
 */
export function launchEditor(projectDir: string): EditorHandle {
  const args = ["--editor", "--path", projectDir];
  if (process.env.GODOT_MCP_TEST_HEADLESS === "1") {
    args.unshift("--headless");
  }
  const child = spawn(godotPath!, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => {
    if (process.env.DEBUG) console.error(`[editor stdout] ${chunk.toString().trimEnd()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (process.env.DEBUG) console.error(`[editor stderr] ${chunk.toString().trimEnd()}`);
  });
  return {
    child,
    kill: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

/** Probes `godot --version` (test-infra only) for handshake cross-checks. */
export async function probeGodotVersionString(): Promise<string> {
  const { stdout } = await execFileAsync(godotPath!, ["--version"], { timeout: 60_000 });
  return stdout.trim();
}
```

- [ ] **Step 3: `test/integration/bridge.integration.test.ts`**

```ts
import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { PROTOCOL_VERSION } from "../../src/bridge/protocol.js";
import { SERVER_VERSION, createServer } from "../../src/server.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  probeGodotVersionString,
  setBridgePort,
  type EditorHandle,
} from "./support.js";

/**
 * The #64 walking-skeleton loop (REQ-A-01/A-02): real editor + real addon +
 * real bridge + real MCP client, no headless Godot in the product path.
 */
describe.runIf(hasGodot)("bridge walking skeleton (real editor)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let client: Client;

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

    const server = createServer({ bridge });
    client = new Client({ name: "godot-mcp-integration", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("get_godot_version reports the real engine version over the bridge", async () => {
    const result = (await client.callTool({ name: "get_godot_version", arguments: {} })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent!;
    const probed = await probeGodotVersionString(); // e.g. "4.7.1.stable.official.abc123"
    const reported = structured.godot_version_string as string; // e.g. "4.7.1.stable"
    expect(probed.startsWith(reported.split(".").slice(0, 2).join("."))).toBe(true);
    expect(structured.addon_version).toBe(SERVER_VERSION);
    expect(structured.server_version).toBe(SERVER_VERSION);
  });

  it("bridge_status reports connected with the project path and queue depth", async () => {
    const result = (await client.callTool({ name: "bridge_status", arguments: {} })) as {
      structuredContent?: Record<string, unknown>;
    };
    const structured = result.structuredContent!;
    expect(structured.state).toBe("connected");
    expect(structured.protocol_version).toBe(PROTOCOL_VERSION);
    expect(typeof structured.queue_depth).toBe("number");
    // globalize_path("res://") ends with a separator; normalize both sides.
    const reportedProject = path.resolve(String(structured.project_path));
    expect(reportedProject.toLowerCase()).toBe(path.resolve(projectDir).toLowerCase());
    expect(structured.features).toHaveProperty("dotnet");
  });

  it("killing the editor turns tool calls into structured disconnect errors (REQ-A-08)", async () => {
    await editor.kill();
    await bridge.waitForState("disconnected", 30_000);
    const result = (await client.callTool({ name: "get_godot_version", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("@cradial/godot-mcp@1.x");
  }, 60_000);
});
```

- [ ] **Step 4: Raise integration timeouts**

`vitest.integration.config.ts`: set `testTimeout: 180_000, hookTimeout: 240_000` (editor boot on CI runners is slow); update the header comment to say the suite drives a real Godot EDITOR (xvfb on CI) instead of a headless binary.

- [ ] **Step 5: Run locally (Windows, GODOT_PATH set — editor window will appear briefly; that is expected)**

Run: `npm run test:integration`
Expected: 3 passing (or a loud skip warning if GODOT_PATH is unset — in that case verify in CI). Then run `npm test` to confirm unit suite still green.

- [ ] **Step 6: Commit**

```bash
git add examples/sample-project/project.godot .gitignore test/integration vitest.integration.config.ts
git commit -m "test: real-editor integration harness - boot editor, handshake, status round-trip, disconnect error"
```

---

### Task 10: CI — editor-under-xvfb matrix (the #64 spike, now enforced)

**Files:**

- Modify: `.github/workflows/ci.yml`

**Interfaces:**

- Produces: unit job unchanged (ubuntu + windows); integration job = ubuntu × the two supported stable minors, full editor under xvfb; the old headless-specific `integration-windows-smoke` job is removed (its rationale — headless Godot filesystem semantics — retired with the headless path; the v2 Windows integration leg is #77's matrix-completion call).

- [ ] **Step 1: Replace the `integration` and delete the `integration-windows-smoke` jobs**

New `integration` job (keep the `unit` job exactly as-is):

```yaml
integration:
  name: integration (ubuntu, Godot ${{ matrix.godot_version }} editor under xvfb)
  strategy:
    fail-fast: false
    matrix:
      # Rolling policy (REQ-A-07): the latest 2 stable Godot minors. Bump
      # both entries deliberately when a new stable minor ships; #77 gates
      # the release on this matrix being green.
      godot_version: ["4.6-stable", "4.7-stable"]
  runs-on: ubuntu-latest
  env:
    GODOT_VERSION: ${{ matrix.godot_version }}
  steps:
    - uses: actions/checkout@v4

    - uses: actions/setup-node@v4
      with:
        node-version: "20"
        cache: "npm"

    - name: Install dependencies
      run: npm ci

    - name: Download Godot ${{ env.GODOT_VERSION }} (linux x86_64, full editor build)
      run: |
        curl -sL -o godot.zip \
          "https://github.com/godotengine/godot/releases/download/${GODOT_VERSION}/Godot_v${GODOT_VERSION}_linux.x86_64.zip"
        unzip -q godot.zip -d godot-bin
        chmod +x "godot-bin/Godot_v${GODOT_VERSION}_linux.x86_64"
        echo "GODOT_PATH=$PWD/godot-bin/Godot_v${GODOT_VERSION}_linux.x86_64" >> "$GITHUB_ENV"

    - name: Sanity-check the downloaded Godot binary
      run: "$GODOT_PATH --version"

    # The #64 feasibility spike, enforced forever after: a real editor
    # process under a virtual display, the bundled addon, a WebSocket
    # handshake, and tool calls through the bridge.
    - name: Integration tests (real editor under xvfb)
      run: xvfb-run --auto-servernum npm run test:integration
```

- [ ] **Step 2: Sanity-check workflow syntax**

Run: `npx --yes yaml-lint .github/workflows/ci.yml` — or, if that package is unavailable, `node -e "const yaml=require('js-yaml')"` is NOT a dependency; instead rely on: `git diff --stat` review + pushing the branch and watching the PR checks. YAML syntax errors surface immediately in the Actions tab.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/ci.yml
git commit -m "ci: integration matrix drives a real editor under xvfb on the latest 2 stable minors (REQ-A-07 spike)"
```

---

### Task 11: Full verification sweep

**Files:** none new — this is the gate before the PR.

- [ ] **Step 1: The complete local gate, in order**

```bash
npm run format:fix
npm run lint
npm run typecheck
npm run test:coverage
npm run build
npm run test:integration   # requires GODOT_PATH; editor window appears locally
```

Expected: every step PASS; coverage thresholds hold; `dist/index.js` builds with the shebang banner and NO operations.gd copy step.

- [ ] **Step 2: Verify the walking-skeleton demo criteria against issue #64's acceptance list**

- Status tool returns handshake data + server version over the bridge, no headless spawn → covered by `bridge.integration.test.ts` cases 1–2.
- Protocol mismatch returns structured error naming both versions + upgrade step → `bridge-connection.test.ts` mismatch case + `bridge-tools.test.ts` mismatch case (fake peer stages it, per the issue).
- CI lint fails naming/description violations; strategy doc in repo → `naming-lint.test.ts` + `docs/tool-naming.md`.
- Unit suite runs with no Godot installed → `npm test` green without GODOT_PATH.
- Headless path retired on main; `1.x` branch exists; errors carry `possibleSolutions[]` + `isError: true` → Task 6 deletions + `git branch --list 1.x` + error-shape tests.

- [ ] **Step 3: Commit any format/lint fallout**

```bash
git add -A
git commit -m "chore: format + lint sweep after walking-skeleton assembly" || echo "nothing to commit"
```

---

## Self-Review Checklist (run after drafting — resolved)

1. **Spec coverage:** issue #64's five acceptance criteria each map to a task (see Task 11 Step 2). The "1.x maintenance branch" requirement is Task 1. The "both test harnesses" requirement is Tasks 3 (fake peer) + 9 (real editor). REQ-A-05 is Task 7. ✔
2. **Placeholder scan:** no TBDs; every code step carries complete code. ✔
3. **Type consistency:** `BridgePort` defined in Task 5, consumed in Tasks 6/7/9; `SERVER_VERSION` exported in Task 6, consumed in 7/9; `resolveBundledAddonDir` defined in Task 6, consumed in Task 9's `installAddon`; fake-peer option names (`protocolVersion`, `handlers`, `omitHello`) match usage in Tasks 4/5. ✔

## Known risks the executor should watch

- **`4.6-stable` release asset name**: if the download 404s in CI, check the exact tag/asset naming on godotengine/godot releases and adjust (the policy is "latest 2 stable minors", not those literal strings).
- **Editor-under-xvfb boot time**: first boot does shader/import warmup; the 150s `waitForState` budget is deliberate. If CI still flakes, add `--rendering-driver opengl3` to `launchEditor` args.
- **Windows local runs**: the editor window appearing is expected; `GODOT_MCP_TEST_HEADLESS=1` is the opt-out.
- **`ws` types**: `@types/ws` must match the `ws` major (8.x).
