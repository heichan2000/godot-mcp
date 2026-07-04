import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import type { ErrorResponse } from "../../src/errors.js";
import type { GodotVersionGate, GodotVersionGateCheck } from "../../src/godot/version-gate.js";
import { registerAll, type ToolDescriptor } from "../../src/registry.js";

function fakeServer() {
  return { registerTool: vi.fn() };
}

function fakeVersionGate(result: GodotVersionGateCheck): GodotVersionGate {
  return { checkMinVersion: vi.fn(async () => result) };
}

const blockedError: ErrorResponse = {
  isError: true,
  content: [{ type: "text", text: "blocked" }],
  structuredContent: { message: "blocked", possibleSolutions: [] },
};

describe("registerAll", () => {
  it("registers every descriptor exactly once, in order", () => {
    const server = fakeServer();
    const descriptors: ToolDescriptor[] = [
      {
        name: "tool_a",
        description: "does a",
        inputSchema: {},
        handler: async () => ({ content: [] }),
      },
      {
        name: "tool_b",
        description: "does b",
        inputSchema: { count: z.number() },
        handler: async () => ({ content: [] }),
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAll(server as any, descriptors);

    const [toolA, toolB] = descriptors;
    expect(server.registerTool).toHaveBeenCalledTimes(2);
    expect(server.registerTool).toHaveBeenNthCalledWith(
      1,
      "tool_a",
      { description: "does a", inputSchema: {} },
      toolA!.handler,
    );
    expect(server.registerTool).toHaveBeenNthCalledWith(
      2,
      "tool_b",
      { description: "does b", inputSchema: { count: toolB!.inputSchema.count } },
      toolB!.handler,
    );
  });

  it("throws on duplicate tool names and registers nothing", () => {
    const server = fakeServer();
    const descriptors: ToolDescriptor[] = [
      {
        name: "dup",
        description: "first",
        inputSchema: {},
        handler: async () => ({ content: [] }),
      },
      {
        name: "dup",
        description: "second",
        inputSchema: {},
        handler: async () => ({ content: [] }),
      },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registerAll(server as any, descriptors)).toThrow(/dup/);
    expect(server.registerTool).not.toHaveBeenCalled();
  });

  it("registers cleanly against a real McpServer instance", () => {
    const server = new McpServer({ name: "test-server", version: "0.0.0" });
    const descriptors: ToolDescriptor[] = [
      {
        name: "get_thing",
        description: "returns a thing",
        inputSchema: {},
        handler: async () => ({ content: [{ type: "text", text: "thing" }] }),
      },
    ];

    expect(() => registerAll(server, descriptors)).not.toThrow();
  });

  it("registers a descriptor with no minGodotVersion using its handler completely untouched", () => {
    const server = fakeServer();
    const handler = vi.fn(async () => ({ content: [] }));
    const descriptors: ToolDescriptor[] = [
      { name: "ungated", description: "d", inputSchema: {}, handler },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAll(server as any, descriptors, { versionGate: fakeVersionGate({ kind: "pass" }) });

    const [, , registeredHandler] = server.registerTool.mock.calls[0]!;
    expect(registeredHandler).toBe(handler);
  });

  it("gates a minGodotVersion descriptor: passes through to the real handler when the gate passes", async () => {
    const server = fakeServer();
    const handler = vi.fn(async () => ({ content: [{ type: "text" as const, text: "ok" }] }));
    const versionGate = fakeVersionGate({ kind: "pass" });
    const descriptors: ToolDescriptor[] = [
      { name: "gated", description: "d", inputSchema: {}, handler, minGodotVersion: "4.4" },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAll(server as any, descriptors, { versionGate });

    const [, , registeredHandler] = server.registerTool.mock.calls[0]!;
    expect(registeredHandler).not.toBe(handler);

    const result = await registeredHandler({}, {} as never);

    expect(versionGate.checkMinVersion).toHaveBeenCalledWith("4.4");
    expect(handler).toHaveBeenCalledWith({}, {});
    expect(result).toEqual({ content: [{ type: "text", text: "ok" }] });
  });

  it("gates a minGodotVersion descriptor: short-circuits to the gate's error and never calls the real handler when blocked", async () => {
    const server = fakeServer();
    const handler = vi.fn(async () => ({ content: [] }));
    const versionGate = fakeVersionGate({ kind: "blocked", error: blockedError });
    const descriptors: ToolDescriptor[] = [
      { name: "gated", description: "d", inputSchema: {}, handler, minGodotVersion: "4.4" },
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    registerAll(server as any, descriptors, { versionGate });

    const [, , registeredHandler] = server.registerTool.mock.calls[0]!;
    const result = await registeredHandler({}, {} as never);

    expect(handler).not.toHaveBeenCalled();
    expect(result).toBe(blockedError);
  });

  it("defaults to a real (lazy, non-probing) version gate when none is supplied", () => {
    const server = fakeServer();
    const handler = vi.fn(async () => ({ content: [] }));
    const descriptors: ToolDescriptor[] = [
      { name: "gated", description: "d", inputSchema: {}, handler, minGodotVersion: "4.4" },
    ];

    // Must not throw or attempt to probe Godot just from registering - the
    // default gate is only ever invoked lazily, inside a call.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => registerAll(server as any, descriptors)).not.toThrow();
  });
});
