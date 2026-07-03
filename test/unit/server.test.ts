import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
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
import type { GodotVersionGate, GodotVersionGateCheck } from "../../src/godot/version-gate.js";
import type { runOperation, RunOperationResult } from "../../src/godot/runner.js";

function fakeVersionGate(result: GodotVersionGateCheck): GodotVersionGate {
  return { checkMinVersion: vi.fn(async () => result) };
}

async function connectedClient(
  resolution: GodotPathResolution,
  options: {
    versionGate?: GodotVersionGate;
    uidRunOperation?: typeof runOperation;
  } = {},
) {
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
    uidToolsDeps: {
      loadConfig: (): Config => ({ godotPath: undefined, debug: false, outputBufferLines: 1000 }),
      detectGodotPath: () => resolution,
      runOperation:
        options.uidRunOperation ??
        vi.fn(async (): Promise<RunOperationResult> => ({
          kind: "success",
          version: 1,
          operation: "get_uid",
          result: { file_path: "res://scripts/print_marker.gd", uid: "uid://48o0gvc1i7pu" },
        })),
      runGodotImport: vi.fn(async () => ({
        kind: "completed" as const,
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 1,
      })),
      hasImportCache: vi.fn(() => true),
      operationsScriptPath: "/dist/operations.gd",
    },
    versionGate: options.versionGate,
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

  it("always lists get_uid and update_project_uids, describing the Godot >= 4.4 requirement, even with no Godot installed", async () => {
    const { client } = await connectedClient({ found: false, candidates: [] });

    const { tools } = await client.listTools();

    const getUid = tools.find((t) => t.name === "get_uid");
    const updateProjectUids = tools.find((t) => t.name === "update_project_uids");
    expect(getUid).toBeDefined();
    expect(updateProjectUids).toBeDefined();
    expect(getUid?.description).toContain("4.4");
    expect(updateProjectUids?.description).toContain("4.4");
  });

  it("blocks get_uid over the wire with a structured error when the version gate reports Godot is too old, WITHOUT touching the filesystem for containment", async () => {
    // A version-gate block happens before the handler's own assertInsideRoot
    // check, so this uses a project_path that doesn't even exist on disk -
    // if the gate weren't checked first, this would fail on containment
    // instead, for the wrong reason.
    const { client } = await connectedClient(
      { found: true, path: "/opt/godot/godot", source: "configured" },
      {
        versionGate: fakeVersionGate({
          kind: "blocked",
          error: {
            isError: true,
            content: [{ type: "text", text: "requires Godot >= 4.4" }],
            structuredContent: {
              message: "requires Godot >= 4.4",
              possibleSolutions: ["Install Godot 4.4 or newer."],
            },
          },
        }),
      },
    );

    const result = await client.callTool({
      name: "get_uid",
      arguments: { project_path: "/projects/does-not-exist", file_path: "scripts/foo.gd" },
    });

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { message: string };
    expect(structured.message).toContain("4.4");
  });

  it("passes get_uid through over the wire when the version gate reports pass", async () => {
    const projectPath = mkdtempSync(path.join(tmpdir(), "godot-mcp-server-test-"));
    const { client } = await connectedClient(
      { found: true, path: "/opt/godot/godot", source: "configured" },
      { versionGate: fakeVersionGate({ kind: "pass" }) },
    );

    const result = await client.callTool({
      name: "get_uid",
      arguments: { project_path: projectPath, file_path: "scripts/print_marker.gd" },
    });

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      file_path: "res://scripts/print_marker.gd",
      uid: "uid://48o0gvc1i7pu",
    });
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
