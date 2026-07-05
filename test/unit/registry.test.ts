import { describe, expect, it } from "vitest";
import { registerAll, type ToolDescriptor } from "../../src/registry.js";

function fakeServer() {
  const registered: string[] = [];
  return {
    registered,
    registerTool: (name: string) => {
      registered.push(name);
    },
  };
}

const descriptor = (name: string): ToolDescriptor => ({
  name,
  description: "test tool",
  inputSchema: {},
  handler: async () => ({ content: [] }),
});

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
