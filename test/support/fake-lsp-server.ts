import { createServer, type Server, type Socket } from "node:net";

/**
 * A scriptable stand-in for Godot's GDScript language server, for
 * lsp-client unit tests. Speaks Content-Length-framed JSON-RPC over TCP:
 * answers `initialize`, and on every `textDocument/didOpen` pushes one
 * `textDocument/publishDiagnostics` for that uri with the diagnostics
 * registered under the opened file's basename (default: empty array).
 */
export interface FakeLspOptions {
  /** Diagnostics arrays keyed by file basename (e.g. "broken.gd"). */
  diagnostics?: Record<string, unknown[]>;
  /** Never respond to didOpen — drives the client's per-script timeout. */
  silentOnDidOpen?: boolean;
  /** Split every outgoing frame across two socket writes (framing test). */
  splitWrites?: boolean;
}

interface JsonRpcMessage {
  id?: number;
  method?: string;
  params?: { textDocument?: { uri?: string } };
}

function frame(payload: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

export class FakeLspServer {
  private constructor(
    private readonly server: Server,
    readonly port: number,
    private readonly options: FakeLspOptions,
  ) {}

  static async start(options: FakeLspOptions = {}): Promise<FakeLspServer> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("no port");
    const fake = new FakeLspServer(server, address.port, options);
    server.on("connection", (socket) => fake.serve(socket));
    return fake;
  }

  private send(socket: Socket, payload: unknown): void {
    const buffer = frame(payload);
    if (this.options.splitWrites && buffer.length > 4) {
      const cut = Math.floor(buffer.length / 2);
      socket.write(buffer.subarray(0, cut));
      setTimeout(() => socket.write(buffer.subarray(cut)), 5);
      return;
    }
    socket.write(buffer);
  }

  private serve(socket: Socket): void {
    let pending = Buffer.alloc(0);
    socket.on("data", (chunk: Buffer) => {
      pending = Buffer.concat([pending, chunk]);
      for (;;) {
        const headerEnd = pending.indexOf("\r\n\r\n");
        if (headerEnd === -1) return;
        const header = pending.subarray(0, headerEnd).toString("ascii");
        const length = Number(/Content-Length: (\d+)/i.exec(header)?.[1] ?? NaN);
        if (!Number.isFinite(length)) throw new Error(`fake LSP: bad header ${header}`);
        const bodyStart = headerEnd + 4;
        if (pending.length < bodyStart + length) return;
        const body = pending.subarray(bodyStart, bodyStart + length).toString("utf8");
        pending = pending.subarray(bodyStart + length);
        this.handle(socket, JSON.parse(body) as JsonRpcMessage);
      }
    });
  }

  private handle(socket: Socket, message: JsonRpcMessage): void {
    if (message.method === "initialize") {
      this.send(socket, { jsonrpc: "2.0", id: message.id, result: { capabilities: {} } });
      return;
    }
    if (message.method === "textDocument/didOpen" && !this.options.silentOnDidOpen) {
      const uri = message.params?.textDocument?.uri ?? "";
      const basename = uri.split("/").pop() ?? "";
      this.send(socket, {
        jsonrpc: "2.0",
        method: "textDocument/publishDiagnostics",
        params: { uri, diagnostics: this.options.diagnostics?.[basename] ?? [] },
      });
    }
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}
