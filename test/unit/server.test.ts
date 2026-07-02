import { EventEmitter } from "node:events";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createServer, createShutdown } from "../../src/server.js";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";
import {
  GodotProcessManager,
  type ManagedChildProcess,
  type SpawnFn,
} from "../../src/godot/process.js";

async function connectedClient(resolution: GodotPathResolution) {
  const server = createServer({
    editorToolsDeps: {
      loadConfig: (): Config => ({ godotPath: undefined, debug: false, outputBufferLines: 1000 }),
      detectGodotPath: () => resolution,
      execFile: vi.fn(async () => ({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" })),
      spawnDetached: vi.fn(() => ({ pid: 123, unref: vi.fn() })),
    },
    sceneToolsDeps: {
      loadConfig: (): Config => ({ godotPath: undefined, debug: false, outputBufferLines: 1000 }),
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

describe("createShutdown", () => {
  function makeManagerWithActiveChild() {
    const killSpy = vi.fn(() => true);
    const child = Object.assign(new EventEmitter(), {
      pid: 4242,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      kill: killSpy,
    }) as unknown as ManagedChildProcess;
    const spawn: SpawnFn = vi.fn(() => child);
    const manager = new GodotProcessManager({ spawn });
    manager.run({
      godotPath: "/opt/godot/godot",
      projectPath: "/projects/demo",
      headless: true,
      outputBufferLines: 1000,
    });
    return { manager, killSpy };
  }

  it("kills the active run_project child before closing the server and exiting", async () => {
    const { manager, killSpy } = makeManagerWithActiveChild();
    const closeServer = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdown({
      processManager: manager,
      closeServer,
      exit,
      debugLog: () => {},
    });

    shutdown("SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(killSpy).toHaveBeenCalled();
    expect(closeServer).toHaveBeenCalled();
  });

  it("still closes the server and exits when no run is active", async () => {
    const manager = new GodotProcessManager({ spawn: vi.fn() });
    const closeServer = vi.fn(async () => {});
    const exit = vi.fn();
    const shutdown = createShutdown({
      processManager: manager,
      closeServer,
      exit,
      debugLog: () => {},
    });

    shutdown("SIGTERM");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(closeServer).toHaveBeenCalled();
  });

  it("still exits even when closing the server rejects", async () => {
    const { manager, killSpy } = makeManagerWithActiveChild();
    const closeServer = vi.fn(async () => {
      throw new Error("close failed");
    });
    const exit = vi.fn();
    const shutdown = createShutdown({
      processManager: manager,
      closeServer,
      exit,
      debugLog: () => {},
    });

    shutdown("SIGINT");
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));

    expect(killSpy).toHaveBeenCalled();
  });
});
