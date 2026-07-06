import { rmSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { PROTOCOL_VERSION } from "../../src/bridge/protocol.js";
import { SERVER_VERSION, createServer } from "../../src/server.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  probeGodotVersionString,
  setBridgePort,
  type EditorHandle,
} from "./support.js";

/**
 * The #64 walking-skeleton loop (REQ-A-01/A-02): real editor + real addon +
 * real bridge + real MCP client, no headless Godot in the product path.
 */
describe.runIf(hasGodot)("bridge walking skeleton (real editor)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let client: Client;

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
    const port = await pickFreePort();
    setBridgePort(projectDir, port);
    await importPass(projectDir);

    editor = launchEditor(projectDir);
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

    const server = createServer({ bridge });
    client = new Client({ name: "godot-mcp-integration", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("get_godot_version reports the real engine version over the bridge", async () => {
    const result = (await client.callTool({ name: "get_godot_version", arguments: {} })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent!;
    const probed = await probeGodotVersionString(); // e.g. "4.7.1.stable.official.abc123"
    const reported = structured.godot_version_string as string; // e.g. "4.7.1.stable"
    expect(probed.startsWith(reported.split(".").slice(0, 2).join("."))).toBe(true);
    expect(structured.addon_version).toBe(SERVER_VERSION);
    expect(structured.server_version).toBe(SERVER_VERSION);
  });

  it("bridge_status reports connected with the project path and queue depth", async () => {
    const result = (await client.callTool({ name: "bridge_status", arguments: {} })) as {
      structuredContent?: Record<string, unknown>;
    };
    const structured = result.structuredContent!;
    expect(structured.state).toBe("connected");
    expect(structured.protocol_version).toBe(PROTOCOL_VERSION);
    expect(typeof structured.queue_depth).toBe("number");
    // globalize_path("res://") ends with a separator; normalize both sides.
    const reportedProject = path.resolve(String(structured.project_path));
    expect(reportedProject.toLowerCase()).toBe(path.resolve(projectDir).toLowerCase());
    expect(structured.features).toHaveProperty("dotnet");
  });

  it("killing the editor turns tool calls into structured disconnect errors (REQ-A-08)", async () => {
    await editor.kill();
    await bridge.waitForState("disconnected", 30_000);
    const result = (await client.callTool({ name: "get_godot_version", arguments: {} })) as {
      isError?: boolean;
      content: Array<{ text: string }>;
    };
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toContain("@cradial/godot-mcp@1.x");
  }, 60_000);

  it("relaunching the editor restores service with no MCP-server restart (REQ-A-04)", async () => {
    editor = launchEditor(projectDir); // same project, same port; bridge must re-handshake
    await bridge.waitForState("connected", 150_000);
    const result = (await client.callTool({ name: "get_godot_version", arguments: {} })) as {
      isError?: boolean;
      structuredContent?: Record<string, unknown>;
    };
    expect(result.isError).toBeFalsy();
    expect(result.structuredContent!.server_version).toBe(SERVER_VERSION);
  }, 180_000);

  it("get_bridge_log returns bounded recent traffic including the reconnect events", async () => {
    const result = (await client.callTool({
      name: "get_bridge_log",
      arguments: { lines: 50 },
    })) as { isError?: boolean; structuredContent?: Record<string, unknown> };
    expect(result.isError).toBeFalsy();
    const entries = result.structuredContent!.entries as Array<{
      direction: string;
      text: string;
    }>;
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.length).toBeLessThanOrEqual(50);
    const joined = entries.map((entry) => entry.text).join("\n");
    expect(joined).toContain("state -> connected"); // lifecycle events made it into the log
  }, 60_000);
});
