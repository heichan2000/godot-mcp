import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createOnboardingTools } from "../../src/tools/onboarding.js";
import { SERVER_VERSION, resolveBundledAddonDir } from "../../src/server.js";
import { BridgeConnection } from "../../src/bridge/connection.js";
import {
  enablePlugin,
  godotMinorTag,
  hasGodot,
  importPass,
  importProjectCaptured,
  launchEditor,
  pickFreePort,
  probeGodotVersionString,
  setBridgePort,
  type EditorHandle,
} from "./support.js";

function onboardingTool(name: string) {
  const tools = createOnboardingTools({
    serverVersion: SERVER_VERSION,
    bundledAddonDir: resolveBundledAddonDir(),
  });
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

describe.runIf(hasGodot)("create_project scaffold imports clean (REQ-B-01)", () => {
  it("a scaffolded project imports with no errors or warnings", async () => {
    const workspace = mkdtempSync(path.join(tmpdir(), "godot-mcp-scaffold-"));
    try {
      const projectDir = path.join(workspace, "fresh-game");
      const minor = godotMinorTag(await probeGodotVersionString());
      const result = (await onboardingTool("create_project").handler(
        { project_path: projectDir, godot_version: minor },
        {} as never,
      )) as { isError?: boolean };
      expect(result.isError).toBeFalsy();

      const output = await importProjectCaptured(projectDir);
      // The acceptance criterion: zero errors or import warnings. Godot prints
      // "ERROR:", "WARNING:", or "SCRIPT ERROR:" for anything wrong; a clean
      // minimal project emits none. A hit here is a real REQ-B-01 regression -
      // fix the scaffold, not this assertion.
      expect(output).not.toMatch(/SCRIPT ERROR|ERROR:|WARNING:/);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }, 180_000);
});

describe.runIf(hasGodot)("onboarding tracer (empty folder -> connected session, REQ-A-03)", () => {
  let workspace: string;
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;

  beforeAll(async () => {
    workspace = mkdtempSync(path.join(tmpdir(), "godot-mcp-onboarding-"));
    projectDir = path.join(workspace, "game");

    // 1. Scaffold into the empty folder, tagged for the running editor's minor.
    const minor = godotMinorTag(await probeGodotVersionString());
    const scaffold = (await onboardingTool("create_project").handler(
      { project_path: projectDir, project_name: "Onboarding Tracer", godot_version: minor },
      {} as never,
    )) as { isError?: boolean };
    expect(scaffold.isError).toBeFalsy();

    // 2. Install the bundled addon (the single install call).
    const install = (await onboardingTool("install_addon").handler(
      { project_path: projectDir },
      {} as never,
    )) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(install.isError).toBeFalsy();
    expect(install.structuredContent!.action).toBe("installed");
    expect(existsSync(path.join(projectDir, "addons", "godot_mcp", "plugin.cfg"))).toBe(true);

    // 3. The one documented manual step: enable the plugin.
    enablePlugin(projectDir);

    // 4. Point the addon at a free port, warm the import cache, boot the editor.
    const port = await pickFreePort();
    setBridgePort(projectDir, port);
    await importPass(projectDir);
    editor = launchEditor(projectDir);

    // 5. Connect the server-side bridge client and wait for the handshake.
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
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  });

  it("reports a connected session running the bundled addon version", async () => {
    const status = bridge.status();
    expect(status.state).toBe("connected");
    expect(status.hello?.addon_version).toBe(SERVER_VERSION);

    const live = (await bridge.request("system/status")) as { addon_version: string };
    expect(live.addon_version).toBe(SERVER_VERSION);
  });
});
