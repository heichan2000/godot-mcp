import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer } from "../../src/server.js";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";

async function connectedClient(resolution: GodotPathResolution) {
  const server = createServer({
    editorToolsDeps: {
      loadConfig: (): Config => ({ godotPath: undefined, debug: false }),
      detectGodotPath: () => resolution,
      execFile: vi.fn(async () => ({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" })),
    },
    sceneToolsDeps: {
      loadConfig: (): Config => ({ godotPath: undefined, debug: false }),
      detectGodotPath: () => resolution,
      runOperation: vi.fn(async () => ({
        kind: "success" as const,
        version: 1,
        operation: "create_scene",
        result: {},
      })),
      operationsScriptPath: "/dist/operations.gd",
      hasImportCache: vi.fn(() => true),
    },
  });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test-client", version: "0.0.0" });

  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return { client, server };
}

describe("createServer (stdio MCP wiring)", () => {
  it("lists get_godot_version and create_scene as registered tools", async () => {
    const { client } = await connectedClient({ found: false, candidates: [] });

    const { tools } = await client.listTools();

    expect(tools.map((t) => t.name)).toContain("get_godot_version");
    expect(tools.map((t) => t.name)).toContain("create_scene");
  });

  it("returns the Godot version over the wire when resolution succeeds", async () => {
    const { client } = await connectedClient({
      found: true,
      path: "/opt/godot/godot",
      source: "configured",
    });

    const result = await client.callTool({ name: "get_godot_version", arguments: {} });

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "4.6.3.stable.official.abcd1234" }]);
  });

  it("returns a structured guided error over the wire when Godot cannot be resolved", async () => {
    const { client } = await connectedClient({
      found: false,
      candidates: ["/usr/bin/godot"],
    });

    const result = await client.callTool({ name: "get_godot_version", arguments: {} });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { possibleSolutions: string[] };
    expect(structured.possibleSolutions.join(" ")).toContain("GODOT_PATH");
  });
});
