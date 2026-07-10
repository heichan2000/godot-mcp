import { describe, expect, it } from "vitest";
import { applyVersionGate, registerAll, type ToolDescriptor } from "../../src/registry.js";
import type { GodotVersion } from "../../src/bridge/protocol.js";

type RegisteredHandler = (args: unknown, extra: unknown) => Promise<unknown>;

function fakeServer() {
  const registered: string[] = [];
  const handlers = new Map<string, RegisteredHandler>();
  return {
    registered,
    handlers,
    registerTool: (name: string, _config: unknown, handler: RegisteredHandler) => {
      registered.push(name);
      handlers.set(name, handler);
    },
  };
}

const descriptor = (name: string): ToolDescriptor => ({
  name,
  description: "test tool",
  inputSchema: {},
  handler: async () => ({ content: [] }),
});

const engine = (major: number, minor: number): GodotVersion => ({
  major,
  minor,
  patch: 1,
  status: "stable",
});

type GateResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
};

/** A gated descriptor whose inner handler records whether it ran. */
function gatedDescriptor(minGodotVersion: string) {
  let ran = 0;
  const tool: ToolDescriptor = {
    ...descriptor("gated_tool"),
    minGodotVersion,
    handler: async () => {
      ran += 1;
      return { content: [{ type: "text" as const, text: "inner ran" }] };
    },
  };
  return { tool, timesRan: () => ran };
}

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

describe("registerAll version gate (REQ-A-07)", () => {
  it("blocks a gated call on an older engine with the structured error, without running the handler", async () => {
    const server = fakeServer();
    const { tool, timesRan } = gatedDescriptor("4.7");
    registerAll(server as never, [tool], { engineVersion: () => engine(4, 6) });
    const result = (await server.handlers.get("gated_tool")!({}, {})) as GateResult;
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("requires Godot >= 4.7");
    expect(timesRan()).toBe(0);
  });

  it("runs the handler when the engine meets the floor", async () => {
    const server = fakeServer();
    const { tool, timesRan } = gatedDescriptor("4.4");
    registerAll(server as never, [tool], { engineVersion: () => engine(4, 6) });
    const result = (await server.handlers.get("gated_tool")!({}, {})) as GateResult;
    expect(result.isError).toBeUndefined();
    expect(timesRan()).toBe(1);
  });

  it("steps aside when no handshake exists (handler produces the not-connected error itself)", async () => {
    const server = fakeServer();
    const { tool, timesRan } = gatedDescriptor("4.7");
    registerAll(server as never, [tool], { engineVersion: () => undefined });
    await server.handlers.get("gated_tool")!({}, {});
    expect(timesRan()).toBe(1);
  });

  it("registers ungated descriptors with their handler untouched", () => {
    const server = fakeServer();
    const plain = descriptor("plain_tool");
    registerAll(server as never, [plain], { engineVersion: () => engine(4, 6) });
    expect(server.handlers.get("plain_tool")).toBe(plain.handler);
  });

  it("throws at registration when a gated descriptor arrives without an engineVersion source", () => {
    const server = fakeServer();
    const { tool } = gatedDescriptor("4.4");
    expect(() => registerAll(server as never, [tool])).toThrow(/engineVersion/);
  });

  it("throws at registration on a malformed minGodotVersion literal", () => {
    const server = fakeServer();
    const { tool } = gatedDescriptor("4.4.1");
    expect(() => registerAll(server as never, [tool], { engineVersion: () => undefined })).toThrow(
      /Invalid minGodotVersion/,
    );
  });
});

describe("applyVersionGate", () => {
  it("is the identity for an ungated descriptor", () => {
    const plain = descriptor("plain_tool");
    expect(applyVersionGate(plain, () => undefined)).toBe(plain);
  });

  it("wraps a gated descriptor so the gate runs before the handler", async () => {
    const { tool, timesRan } = gatedDescriptor("4.7");
    const gated = applyVersionGate(tool, () => engine(4, 6));
    const blocked = (await gated.handler({} as never, {} as never)) as GateResult;
    expect(blocked.isError).toBe(true);
    expect(blocked.content[0]!.text).toContain("requires Godot >= 4.7");
    expect(timesRan()).toBe(0);
  });
});
