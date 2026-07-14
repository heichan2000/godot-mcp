import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../../src/bridge/protocol.js";

export interface RawReply {
  result?: unknown;
  error?: { code: string; message: string; possibleSolutions: string[] };
}

export interface RawBridgeClient {
  hello: Record<string, unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<RawReply>;
  close(): void;
}

/**
 * Test-only bridge client that bypasses ALL server-side code (#76, REQ-M-01):
 * it speaks raw {id, method, params} frames straight at the addon, so
 * whatever safety the reply shows is the addon's own. Ignores progress
 * frames; single in-flight request at a time is all the suite needs.
 * Retries the connect until the editor's bridge is up (editor boot is slow).
 */
export async function connectRawClient(
  port: number,
  timeoutMs = 150_000,
): Promise<RawBridgeClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attemptConnect(port);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(1_000);
    }
  }
}

async function attemptConnect(port: number): Promise<RawBridgeClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const frames: Array<Record<string, unknown>> = [];
  let notify: (() => void) | undefined;
  socket.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>);
    notify?.();
  });

  async function nextFrame(timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = frames.shift();
      if (frame !== undefined) return frame;
      if (Date.now() >= deadline) throw new Error("raw client: timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        notify = resolve;
        setTimeout(resolve, 100);
      });
    }
  }

  const hello = await nextFrame(30_000);
  if (hello.type !== "hello" || hello.protocol_version !== PROTOCOL_VERSION) {
    socket.terminate();
    throw new Error(
      `raw client: expected hello v${PROTOCOL_VERSION}, got ${JSON.stringify(hello)}`,
    );
  }

  let nextId = 1;
  return {
    hello,
    async request(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      for (;;) {
        const frame = await nextFrame(30_000);
        if (frame.id !== id) continue; // stray frame from a previous request
        if ("progress" in frame) continue; // REQ-A-11 progress - not the reply
        return frame as RawReply;
      }
    },
    close() {
      socket.terminate();
    },
  };
}
