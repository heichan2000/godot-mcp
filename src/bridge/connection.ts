import { EventEmitter } from "node:events";
import WebSocket from "ws";
import {
  PROTOCOL_VERSION,
  encodeRequest,
  helloAck,
  parseAddonFrame,
  type Hello,
} from "./protocol.js";
import { TrafficLog, type TrafficEntry } from "./traffic-log.js";

export type BridgeState = "connecting" | "handshaking" | "connected" | "mismatch" | "disconnected";

export interface BridgeStatus {
  state: BridgeState;
  hello?: Hello;
  serverVersion: string;
  protocolVersion: number;
  pendingRequests: number;
  lastDisconnectReason?: string;
  /**
   * Reconnects scheduled since the last successful handshake. Climbs on every
   * connect/close cycle - including a repeating protocol mismatch - and resets
   * to 0 only when a hello is accepted. Diagnostic only.
   */
  reconnectAttempts: number;
  /** Set while state === "mismatch": both protocol versions, for diagnostics. */
  mismatch?: ProtocolMismatch;
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
    super(
      `The editor did not answer or report progress on bridge method "${method}" within ${timeoutMs}ms.`,
    );
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
  /** Backoff cap for repeated failed reconnects. Default 10000ms. */
  maxReconnectDelayMs?: number;
  /** DEBUG-gated stderr logger; never stdout (REQ-A-09). */
  log?: (message: string) => void;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
  method: string;
}

/**
 * Capped exponential backoff for reconnect attempts (REQ-A-04): base, 2x,
 * 4x ... capped at maxMs. Exponent is clamped so large attempt counts cannot
 * overflow to Infinity.
 */
export function reconnectBackoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(baseMs * 2 ** Math.min(attempt, 20), maxMs);
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
  private readonly trafficLog = new TrafficLog();
  private socket: WebSocket | null = null;
  private state: BridgeState = "disconnected";
  private hello: Hello | undefined;
  private mismatch: ProtocolMismatch | undefined;
  private lastDisconnectReason: string | undefined;
  private nextId = 1;
  private reconnectAttempts = 0;
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
      reconnectAttempts: this.reconnectAttempts,
      mismatch: this.mismatch,
    };
  }

  /** The most recent bridge frames and lifecycle events, oldest-first (REQ-A-09). */
  traffic(limit: number): TrafficEntry[] {
    return this.trafficLog.tail(limit);
  }

  /**
   * Arms (or re-arms) the per-request deadline (REQ-A-11). Progress frames
   * call this again with the same args - every sign of life restarts the
   * full window; only silence for requestTimeoutMs kills a request.
   */
  private armRequestTimeout(
    id: number,
    method: string,
    reject: (reason: Error) => void,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      this.pending.delete(id);
      reject(new BridgeTimeoutError(method, this.options.requestTimeoutMs));
    }, this.options.requestTimeoutMs);
  }

  // Deliberately not `async`: the caller must receive the exact promise we
  // attach the backstop rejection handler to (an async wrapper's outer promise
  // would surface peer-death rejections as unhandled before the caller awaits).
  request(method: string, params: Record<string, unknown> = {}): Promise<unknown> {
    if (this.state !== "connected" || this.socket === null) {
      const rejection = Promise.reject<unknown>(this.unavailableError());
      // Backstop handler: see the identical comment below - a fire-and-forget
      // caller on this early-guard path must not cause an unhandled rejection.
      void rejection.catch(() => undefined);
      return rejection;
    }
    const id = this.nextId++;
    const socket = this.socket;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = this.armRequestTimeout(id, method, reject);
      this.pending.set(id, { resolve, reject, timer, method });
      const encoded = encodeRequest({ id, method, params });
      this.trafficLog.record("sent", encoded);
      socket.send(encoded, (error) => {
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
    // Backstop handler: a pending request can be rejected (peer death, stop())
    // before the caller has attached its own handler, which Node would report
    // as an unhandled rejection. Callers still observe the rejection normally.
    void promise.catch(() => undefined);
    return promise;
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

    socket.on("message", (data) => {
      const text = String(data);
      this.trafficLog.record("received", text);
      this.onFrame(text);
    });

    socket.on("close", (code, reason) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.clearHandshakeTimer();
      this.lastDisconnectReason = reason.toString() || `socket closed (code ${code})`;
      this.trafficLog.record("event", `socket closed: ${this.lastDisconnectReason}`);
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
    if (frame.kind === "hello_mismatch") {
      this.clearHandshakeTimer();
      this.mismatch = {
        addonProtocolVersion: frame.protocolVersion,
        serverProtocolVersion: PROTOCOL_VERSION,
      };
      this.setState("mismatch");
      this.log(
        `protocol mismatch: addon speaks v${frame.protocolVersion}, server speaks v${PROTOCOL_VERSION}`,
      );
      this.socket?.close(1002, "protocol version mismatch");
      return;
    }
    if (frame.kind === "hello") {
      this.clearHandshakeTimer();
      this.hello = frame.hello;
      this.mismatch = undefined;
      this.reconnectAttempts = 0;
      const ack = helloAck(this.options.serverVersion);
      this.trafficLog.record("sent", ack);
      this.socket?.send(ack);
      this.setState("connected");
      return;
    }
    if (frame.kind === "progress") {
      const entry = this.pending.get(frame.progress.id);
      if (!entry) {
        this.log(`ignoring progress for unknown request id ${frame.progress.id}`);
        return;
      }
      clearTimeout(entry.timer);
      entry.timer = this.armRequestTimeout(frame.progress.id, entry.method, entry.reject);
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
    const delayMs = reconnectBackoffMs(
      this.reconnectAttempts,
      this.options.reconnectDelayMs ?? 1_000,
      this.options.maxReconnectDelayMs ?? 10_000,
    );
    this.reconnectAttempts += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delayMs);
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
    this.trafficLog.record("event", `state -> ${state}`);
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
