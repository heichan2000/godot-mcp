import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  encodeRequest,
  helloAck,
  parseAddonFrame,
  SystemStatusSchema,
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

  it("classifies a future-protocol hello as a mismatch naming both versions, not invalid", () => {
    const futureHello = {
      type: "hello",
      protocol_version: 2,
      // No addon_version, no godot_version, no features, no project_path -
      // a v2 addon may have renamed/dropped/added any of these. An
      // unrecognizable extra field is thrown in too.
      surprise_field: "unrecognizable",
    };
    const frame = parseAddonFrame(JSON.stringify(futureHello));
    expect(frame.kind).toBe("hello_mismatch");
    if (frame.kind !== "hello_mismatch") throw new Error("unreachable");
    expect(frame.protocolVersion).toBe(2);
    expect(frame.protocolVersion).not.toBe(PROTOCOL_VERSION);
  });

  it("still rejects a same-version hello with a malformed body as invalid", () => {
    const malformed = {
      type: "hello",
      protocol_version: PROTOCOL_VERSION,
      // Missing addon_version, godot_version, features, project_path.
    };
    expect(parseAddonFrame(JSON.stringify(malformed)).kind).toBe("invalid");
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

describe("SystemStatusSchema", () => {
  const valid = {
    protocol_version: 1,
    addon_version: "2.0.0-alpha.0",
    godot_version: { major: 4, minor: 7, patch: 1, status: "stable" },
    godot_version_string: "4.7.1.stable",
    features: { dotnet: false },
    project_path: "/tmp/p",
    uptime_ms: 12,
    queue_depth: 0,
  };

  it("accepts a valid payload and passes unknown future fields through", () => {
    const parsed = SystemStatusSchema.safeParse({ ...valid, future_field: "kept" });
    expect(parsed.success).toBe(true);
    expect((parsed.data as Record<string, unknown>).future_field).toBe("kept");
  });

  it("rejects a payload missing required fields", () => {
    expect(SystemStatusSchema.safeParse({ uptime_ms: 5 }).success).toBe(false);
  });
});
