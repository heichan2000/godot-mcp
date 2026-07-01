import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { registerAll, type ToolDescriptor } from "../../src/registry.js";

function fakeServer() {
  return { registerTool: vi.fn() };
}

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
});
