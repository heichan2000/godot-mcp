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

/**
 * Payload of the addon's `system/status` op. Validated (not cast) on the
 * server side so a stale or buggy addon surfaces as a structured error
 * instead of undefined fields leaking into tool output. `catchall` lets
 * future addon versions add fields without a server release.
 */
export const SystemStatusSchema = z
  .object({
    protocol_version: z.number().int(),
    addon_version: z.string(),
    godot_version: GodotVersionSchema,
    godot_version_string: z.string(),
    features: z.object({ dotnet: z.boolean() }).catchall(z.boolean()),
    project_path: z.string(),
    uptime_ms: z.number(),
    queue_depth: z.number().int(),
  })
  .catchall(z.unknown());
export type SystemStatus = z.infer<typeof SystemStatusSchema>;

/**
 * Minimal shape used to recognize a hello frame and read its
 * `protocol_version` before attempting the full schema. A future addon
 * speaking a different protocol version may rename, drop, or add required
 * fields anywhere else in the hello - this schema only pins down the two
 * fields the client needs in order to report a version mismatch (REQ-A-02)
 * rather than misclassifying the frame as `invalid` and retrying forever.
 */
const HelloVersionSchema = z.object({
  type: z.literal("hello"),
  protocol_version: z.number().int(),
});

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

/**
 * Progress frame: a long-running op's "signs of life" (REQ-A-11), keyed by
 * the request id it belongs to. Each one re-arms the client's per-request
 * deadline. Payload fields are advisory; `catchall` lets ops add detail
 * without a protocol change.
 */
export const ProgressFrameSchema = z.object({
  id: z.number().int(),
  progress: z
    .object({
      stage: z.string().optional(),
      current: z.number().optional(),
      total: z.number().optional(),
      message: z.string().optional(),
    })
    .catchall(z.unknown()),
});
export type ProgressFrame = z.infer<typeof ProgressFrameSchema>;

export interface RequestFrame {
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export type AddonFrame =
  | { kind: "hello"; hello: Hello }
  | { kind: "hello_mismatch"; protocolVersion: number }
  | { kind: "progress"; progress: ProgressFrame }
  | { kind: "response"; response: ResponseFrame }
  | { kind: "invalid"; reason: string };

/**
 * Classifies one inbound text frame from the addon. Never throws: transport
 * code branches on `kind` and logs invalid frames instead of crashing the
 * connection over one bad packet.
 *
 * Hello frames are classified in two stages so a protocol-version mismatch
 * is always reported as a mismatch, never as `invalid` (REQ-A-02): first the
 * frame is matched against the minimal `HelloVersionSchema` to read
 * `protocol_version` regardless of what else the frame contains; only once
 * that version matches `PROTOCOL_VERSION` is the full `HelloSchema` applied.
 * A same-version hello that fails the full schema is still `invalid`.
 *
 * Progress frames (REQ-A-11) are checked after hello and before response: a
 * `{id, progress}` object with neither `result` nor `error` is `progress`;
 * once either of those keys appears the frame is a `response` instead.
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
  const helloVersion = HelloVersionSchema.safeParse(raw);
  if (helloVersion.success) {
    if (helloVersion.data.protocol_version !== PROTOCOL_VERSION) {
      return { kind: "hello_mismatch", protocolVersion: helloVersion.data.protocol_version };
    }
    const hello = HelloSchema.safeParse(raw);
    if (hello.success) return { kind: "hello", hello: hello.data };
    return {
      kind: "invalid",
      reason: "hello frame matches this protocol version but fails full validation",
    };
  }
  // A frame with both `progress` and `result` deliberately falls through to
  // the response check below - a result always outranks advisory progress.
  const progress = ProgressFrameSchema.safeParse(raw);
  if (progress.success && !("result" in raw) && !("error" in raw)) {
    return { kind: "progress", progress: progress.data };
  }
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
