import { copyFileSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import type { LspDiagnostic } from "../../src/lsp/client.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createDiagnosticsTools } from "../../src/tools/diagnostics.js";
import { createProjectTools } from "../../src/tools/project.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  setBridgePort,
  type EditorHandle,
} from "./support.js";

const FIXTURES_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures");

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type ErrorsPayload = { errors: LspDiagnostic[]; count: number; scripts_checked: number };

describe.runIf(hasGodot)("script diagnostics via the editor's language server (REQ-D-01)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let diagnosticsTools: ReturnType<typeof createDiagnosticsTools>;

  async function callErrors(args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = diagnosticsTools.find((candidate) => candidate.name === "get_script_errors");
    if (!tool) throw new Error("tool not registered: get_script_errors");
    return (await tool.handler(args as never, {} as never)) as ToolResult;
  }

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
    // The deliberately-broken fixture lives ONLY in this ephemeral copy —
    // never in examples/sample-project (same blast-radius-zero pattern 1.x
    // used: other suites' import/run steps must not see a broken script).
    copyFileSync(
      path.join(FIXTURES_DIR, "broken_script.gd"),
      path.join(projectDir, "scripts", "broken.gd"),
    );
    const port = await pickFreePort();
    const lspPort = await pickFreePort();
    setBridgePort(projectDir, port);
    await importPass(projectDir);
    editor = launchEditor(projectDir, { lspPort });
    bridge = new BridgeConnection({
      url: `ws://127.0.0.1:${port}`,
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 30_000,
      reconnectDelayMs: 500,
      log: (message) => {
        if (process.env.DEBUG) console.error(message);
      },
    });
    bridge.start();
    await bridge.waitForState("connected", 150_000);
    diagnosticsTools = createDiagnosticsTools({ bridge, lspPort });
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("returns structured file/line/message records for a broken script (REQ-D-01)", async () => {
    const result = await callErrors({ script_path: "scripts/broken.gd" });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as ErrorsPayload;
    expect(payload.scripts_checked).toBe(1);
    const errors = payload.errors.filter((entry) => entry.severity === "error");
    expect(errors.length).toBeGreaterThanOrEqual(1);
    for (const entry of errors) {
      expect(entry.file).toBe("res://scripts/broken.gd");
      expect(entry.message.length).toBeGreaterThan(0);
    }
    // The parse error sits on line 4 ("var x =") — 1-based, like 1.0's records.
    expect(errors.map((entry) => entry.line)).toContain(4);
  });

  it("returns no error-severity records for a clean script", async () => {
    const result = await callErrors({ script_path: "scripts/print_marker.gd" });
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as ErrorsPayload;
    expect(payload.scripts_checked).toBe(1);
    expect(payload.errors.filter((entry) => entry.severity === "error")).toEqual([]);
  });

  it("whole-project mode finds the broken script among all GDScripts", async () => {
    // Make sure the editor's filesystem knows the fixture (it was on disk
    // before the import pass, so this is belt-and-braces, not load-bearing).
    const projectTools = createProjectTools({ bridge });
    const importTool = projectTools.find((candidate) => candidate.name === "import_assets")!;
    await importTool.handler({} as never, {} as never);

    const result = await callErrors();
    expect(result.isError).toBeFalsy();
    const payload = result.structuredContent as ErrorsPayload;
    expect(payload.scripts_checked).toBeGreaterThanOrEqual(2);
    const brokenErrors = payload.errors.filter(
      (entry) => entry.file === "res://scripts/broken.gd" && entry.severity === "error",
    );
    expect(brokenErrors.length).toBeGreaterThanOrEqual(1);
    const cleanErrors = payload.errors.filter(
      (entry) => entry.file === "res://scripts/print_marker.gd" && entry.severity === "error",
    );
    expect(cleanErrors).toEqual([]);
  });

  it("rejects an escaping script_path and a missing script with guided errors", async () => {
    const escape = await callErrors({ script_path: "../../etc/passwd" });
    expect(escape.isError).toBe(true);
    expect(escape.content[0]!.text.toLowerCase()).toContain("outside the project root");

    const ghost = await callErrors({ script_path: "scripts/ghost.gd" });
    expect(ghost.isError).toBe(true);
    expect(ghost.content[0]!.text).toContain("res://scripts/ghost.gd");
  });
});
