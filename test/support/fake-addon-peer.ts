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
