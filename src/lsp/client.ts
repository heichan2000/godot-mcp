import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * Minimal client for the GDScript language server every Godot editor runs
 * (Editor Settings → Network → Language Server; default 127.0.0.1:6005).
 * This is get_script_errors' diagnostics source: Godot exposes NO scripting
 * API for parse errors, and REQ-A-01 bans 1.0's headless --check-only spawn,
 * so the LSP's textDocument/publishDiagnostics is the one editor-native,
 * structured channel. One short-lived connection per checkScriptsViaLsp call:
 * initialize → initialized → per script (didOpen → await publishDiagnostics →
 * didClose) → destroy. Independent of the WebSocket bridge by design — an LSP
 * failure surfaces as a guided tool error and never disturbs bridge state.
 */

export class LspError extends Error {
  constructor(
    message: string,
    readonly possibleSolutions: string[],
  ) {
    super(message);
    this.name = "LspError";
  }
}

export interface LspDiagnostic {
  /** Canonical res:// path of the script the diagnostic belongs to. */
  file: string;
  /** 1-based line (LSP wire format is 0-based). */
  line: number;
  message: string;
  severity: "error" | "warning";
}

export interface ScriptToCheck {
  /** Canonical res:// path used in returned records. */
  resPath: string;
  /** Absolute on-disk path — becomes the didOpen file:// URI. */
  absPath: string;
  /** Script source text, sent to the language server verbatim. */
  text: string;
}

export interface CheckScriptsOptions {
  port: number;
  /** Absolute project root (the LSP session's rootUri). */
  projectRoot: string;
  scripts: ScriptToCheck[];
  /** Per-request and per-script diagnostics wait. */
  timeoutMs: number;
}

const CONNECT_SOLUTIONS = [
  "Keep the Godot editor running - diagnostics come from its built-in GDScript language server.",
  "Check Editor Settings → Network → Language Server: the port must match (default 6005, override via GODOT_MCP_LSP_PORT).",
  "If several editors are open, the language server port belongs to whichever bound it first - close the others or use --lsp-port.",
];

/** Raw publishDiagnostics entry (LSP wire shape, best-effort typed). */
interface WireDiagnostic {
  range?: { start?: { line?: number } };
  severity?: number;
  message?: string;
}

interface WireMessage {
  id?: number;
  method?: string;
  result?: unknown;
  error?: { message?: string };
  params?: { uri?: string; diagnostics?: WireDiagnostic[] };
}

function encodeFrame(payload: Record<string, unknown>): Buffer {
  const body = Buffer.from(JSON.stringify({ jsonrpc: "2.0", ...payload }), "utf8");
  return Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
}

/** Case-tolerant absolute-path equality (Windows drive letters / separators). */
function samePath(a: string, b: string): boolean {
  const na = path.resolve(a);
  const nb = path.resolve(b);
  return process.platform === "win32" ? na.toLowerCase() === nb.toLowerCase() : na === nb;
}

function connectOrThrow(port: number): Promise<Socket> {
  return new Promise<Socket>((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port });
    socket.once("connect", () => resolve(socket));
    socket.once("error", (error) => {
      reject(
        new LspError(
          `Could not reach the editor's GDScript language server on 127.0.0.1:${port}: ${String(error)}`,
          CONNECT_SOLUTIONS,
        ),
      );
    });
  });
}

/**
 * One in-flight LSP session over an already-connected socket: frames the wire,
 * resolves request ids, and hands publishDiagnostics notifications to the
 * current waiter. Not exported — checkScriptsViaLsp is the module's API.
 */
class LspSession {
  private pending = Buffer.alloc(0);
  private nextId = 1;
  private readonly awaitingReplies = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  private diagnosticsWaiter: {
    absPath: string;
    resolve: (diagnostics: WireDiagnostic[]) => void;
  } | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => this.receive(chunk));
    socket.on("error", (error) =>
      this.failAll(
        new LspError(
          `The language-server connection failed mid-session: ${String(error)}`,
          CONNECT_SOLUTIONS,
        ),
      ),
    );
    socket.on("close", () =>
      this.failAll(
        new LspError(
          "The language server closed the connection before responding.",
          CONNECT_SOLUTIONS,
        ),
      ),
    );
  }

  private failAll(error: Error): void {
    for (const waiter of this.awaitingReplies.values()) waiter.reject(error);
    this.awaitingReplies.clear();
    // A diagnostics waiter times out on its own timer; nothing to do here.
  }

  private receive(chunk: Buffer): void {
    this.pending = Buffer.concat([this.pending, chunk]);
    for (;;) {
      const headerEnd = this.pending.indexOf("\r\n\r\n");
      if (headerEnd === -1) return;
      const header = this.pending.subarray(0, headerEnd).toString("ascii");
      const length = Number(/Content-Length:\s*(\d+)/i.exec(header)?.[1] ?? NaN);
      if (!Number.isFinite(length)) {
        // Unparseable header — drop the connection-level buffer; the per-call
        // timeout surfaces the failure with guidance.
        this.pending = Buffer.alloc(0);
        return;
      }
      const bodyStart = headerEnd + 4;
      if (this.pending.length < bodyStart + length) return;
      const body = this.pending.subarray(bodyStart, bodyStart + length).toString("utf8");
      this.pending = this.pending.subarray(bodyStart + length);
      let message: WireMessage;
      try {
        message = JSON.parse(body) as WireMessage;
      } catch {
        continue; // Malformed body: skip the frame, keep the stream.
      }
      this.dispatch(message);
    }
  }

  private dispatch(message: WireMessage): void {
    if (message.id !== undefined && message.method === undefined) {
      const waiter = this.awaitingReplies.get(message.id);
      if (waiter) {
        this.awaitingReplies.delete(message.id);
        if (message.error) {
          waiter.reject(
            new LspError(
              `The language server rejected a request: ${message.error.message ?? "unknown error"}`,
              CONNECT_SOLUTIONS,
            ),
          );
        } else {
          waiter.resolve(message.result);
        }
      }
      return;
    }
    if (message.method === "textDocument/publishDiagnostics" && this.diagnosticsWaiter) {
      const uri = message.params?.uri ?? "";
      let published: string;
      try {
        published = fileURLToPath(new URL(uri));
      } catch {
        return; // A non-file uri (or garbage) is not ours; keep waiting.
      }
      if (samePath(published, this.diagnosticsWaiter.absPath)) {
        const waiter = this.diagnosticsWaiter;
        this.diagnosticsWaiter = null;
        waiter.resolve(message.params?.diagnostics ?? []);
      }
    }
  }

  request(method: string, params: Record<string, unknown>, timeoutMs: number): Promise<unknown> {
    const id = this.nextId++;
    this.socket.write(encodeFrame({ id, method, params }));
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.awaitingReplies.delete(id);
        reject(
          new LspError(
            `The language server did not answer ${method} within ${timeoutMs}ms.`,
            CONNECT_SOLUTIONS,
          ),
        );
      }, timeoutMs);
      this.awaitingReplies.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  notify(method: string, params: Record<string, unknown>): void {
    this.socket.write(encodeFrame({ method, params }));
  }

  waitForDiagnostics(
    absPath: string,
    resPath: string,
    timeoutMs: number,
  ): Promise<WireDiagnostic[]> {
    return new Promise<WireDiagnostic[]>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.diagnosticsWaiter = null;
        reject(
          new LspError(
            `The editor's language server returned no diagnostics for ${resPath} within ${timeoutMs}ms.`,
            CONNECT_SOLUTIONS,
          ),
        );
      }, timeoutMs);
      this.diagnosticsWaiter = {
        absPath,
        resolve: (diagnostics) => {
          clearTimeout(timer);
          resolve(diagnostics);
        },
      };
    });
  }
}

function toRecord(resPath: string, wire: WireDiagnostic): LspDiagnostic | null {
  // LSP severity: 1=Error, 2=Warning, 3/4=Info/Hint (dropped). An omitted
  // severity is treated as an error, per the LSP spec's "client should
  // interpret it as Error" guidance.
  const severity = wire.severity ?? 1;
  if (severity !== 1 && severity !== 2) return null;
  return {
    file: resPath,
    line: (wire.range?.start?.line ?? 0) + 1,
    message: wire.message ?? "",
    severity: severity === 1 ? "error" : "warning",
  };
}

/** Opens one LSP session and checks every script, in order. See module doc. */
export async function checkScriptsViaLsp(options: CheckScriptsOptions): Promise<LspDiagnostic[]> {
  const socket = await connectOrThrow(options.port);
  try {
    const session = new LspSession(socket);
    await session.request(
      "initialize",
      {
        processId: null,
        rootUri: pathToFileURL(options.projectRoot).toString(),
        capabilities: {},
      },
      options.timeoutMs,
    );
    session.notify("initialized", {});

    const collected: LspDiagnostic[] = [];
    for (const script of options.scripts) {
      const uri = pathToFileURL(script.absPath).toString();
      const waiter = session.waitForDiagnostics(script.absPath, script.resPath, options.timeoutMs);
      session.notify("textDocument/didOpen", {
        textDocument: { uri, languageId: "gdscript", version: 1, text: script.text },
      });
      const wireDiagnostics = await waiter;
      for (const wire of wireDiagnostics) {
        const record = toRecord(script.resPath, wire);
        if (record !== null) collected.push(record);
      }
      session.notify("textDocument/didClose", { textDocument: { uri } });
    }
    return collected;
  } finally {
    socket.destroy();
  }
}
