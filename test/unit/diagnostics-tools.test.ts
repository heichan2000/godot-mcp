import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { LspError, type CheckScriptsOptions, type LspDiagnostic } from "../../src/lsp/client.js";
import { createDiagnosticsTools } from "../../src/tools/diagnostics.js";
import { FakeAddonPeer } from "../support/fake-addon-peer.js";

const SERVER_VERSION = "2.0.0-alpha.0";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

/** A real project dir with a real script file, so file reads resolve. */
function tempProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-diag-unit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  writeFileSync(path.join(dir, "scripts", "a.gd"), "extends Node\n");
  return dir;
}

type Handlers = NonNullable<Parameters<typeof FakeAddonPeer.start>[0]>["handlers"];

async function connectedBridge(handlers: Handlers, projectPath: string): Promise<BridgeConnection> {
  const peer = await FakeAddonPeer.start({
    handlers,
    helloOverrides: { project_path: projectPath },
  });
  cleanups.push(() => peer.close());
  const bridge = new BridgeConnection({
    url: peer.url,
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: 2_000,
    reconnectDelayMs: 50,
  });
  bridge.start();
  cleanups.push(() => bridge.stop());
  await bridge.waitForState("connected", 5_000);
  return bridge;
}

function deadBridge(): BridgeConnection {
  const bridge = new BridgeConnection({
    url: "ws://127.0.0.1:1",
    serverVersion: SERVER_VERSION,
    requestTimeoutMs: 100,
    reconnectDelayMs: 5_000,
  });
  cleanups.push(() => bridge.stop());
  return bridge;
}

/** Records checkScripts calls and returns canned diagnostics. */
function fakeChecker(result: LspDiagnostic[] = []) {
  const calls: CheckScriptsOptions[] = [];
  const checkScripts = async (options: CheckScriptsOptions) => {
    calls.push(options);
    return result;
  };
  return { calls, checkScripts };
}

async function callErrors(
  bridge: BridgeConnection,
  checkScripts: (o: CheckScriptsOptions) => Promise<LspDiagnostic[]>,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createDiagnosticsTools({ bridge, lspPort: 6005, checkScripts });
  const tool = tools.find((candidate) => candidate.name === "get_script_errors");
  if (!tool) throw new Error("tool not registered: get_script_errors");
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe("get_script_errors", () => {
  it("single-script mode reads the file and hands the LSP client one contained script", async () => {
    const project = tempProject();
    const bridge = await connectedBridge({}, project);
    const { calls, checkScripts } = fakeChecker([
      { file: "res://scripts/a.gd", line: 4, message: "boom", severity: "error" },
    ]);
    const result = await callErrors(bridge, checkScripts, { script_path: "scripts/a.gd" });
    expect(result.isError).toBeUndefined();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.port).toBe(6005);
    expect(calls[0]!.projectRoot).toBe(project);
    expect(calls[0]!.scripts).toEqual([
      {
        resPath: "res://scripts/a.gd",
        absPath: path.join(project, "scripts", "a.gd"),
        text: "extends Node\n",
      },
    ]);
    expect(result.structuredContent).toMatchObject({
      errors: [{ file: "res://scripts/a.gd", line: 4, message: "boom", severity: "error" }],
      count: 1,
      scripts_checked: 1,
    });
  });

  it("whole-project mode enumerates GDScript resources over the bridge", async () => {
    const project = tempProject();
    writeFileSync(path.join(project, "scripts", "b.gd"), "extends Node2D\n");
    let seen: Record<string, unknown> = {};
    const bridge = await connectedBridge(
      {
        "project/list_resources": (params) => {
          seen = params;
          return {
            resources: [
              { path: "res://scripts/a.gd", type: "GDScript" },
              { path: "res://scripts/b.gd", type: "GDScript" },
            ],
            count: 2,
          };
        },
      },
      project,
    );
    const { calls, checkScripts } = fakeChecker([]);
    const result = await callErrors(bridge, checkScripts);
    expect(result.isError).toBeUndefined();
    expect(seen).toMatchObject({ type: "GDScript" });
    expect(calls[0]!.scripts.map((s) => s.resPath)).toEqual([
      "res://scripts/a.gd",
      "res://scripts/b.gd",
    ]);
    expect(result.structuredContent).toMatchObject({ errors: [], count: 0, scripts_checked: 2 });
  });

  it("rejects an escaping script_path before bridge or LSP", async () => {
    const { calls, checkScripts } = fakeChecker();
    const result = await callErrors(deadBridge(), checkScripts, { script_path: "../evil.gd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("outside the project root");
    expect(calls).toHaveLength(0);
  });

  it("returns a guided not-found error for a missing script file", async () => {
    const project = tempProject();
    const bridge = await connectedBridge({}, project);
    const { calls, checkScripts } = fakeChecker();
    const result = await callErrors(bridge, checkScripts, { script_path: "scripts/ghost.gd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("res://scripts/ghost.gd");
    expect(calls).toHaveLength(0);
  });

  it("maps an LspError to a guided tool error", async () => {
    const project = tempProject();
    const bridge = await connectedBridge({}, project);
    const checkScripts = async () => {
      throw new LspError("no LSP here", ["Start the editor."]);
    };
    const result = await callErrors(bridge, checkScripts, { script_path: "scripts/a.gd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("no LSP here");
  });

  it("reports not-connected guidance when no editor is attached", async () => {
    const { checkScripts } = fakeChecker();
    const result = await callErrors(deadBridge(), checkScripts, { script_path: "scripts/a.gd" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("editor");
  });
});
