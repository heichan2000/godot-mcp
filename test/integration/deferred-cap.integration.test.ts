import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createProjectTools } from "../../src/tools/project.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  setBridgePort,
  setDeferredOpTimeout,
  type EditorHandle,
} from "./support.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

async function callProjectTool(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createProjectTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

// A 1 ms cap: the deadline check runs before the task's first tick, and that
// tick arrives no earlier than the next editor frame (> 1 ms after arming),
// so expiry fires deterministically - even an instantly-finishing scan cannot
// complete first (completion needs at least two ticks via the observed path,
// or ten via the grace). See the #95 design spec, §4.
describe.runIf(hasGodot)("deferred-op wall-clock cap vs a real editor (#95, REQ-A-12)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
    const port = await pickFreePort();
    setBridgePort(projectDir, port);
    setDeferredOpTimeout(projectDir, 1);
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
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("a deferred op exceeding the cap fails with a structured deferred_op_timeout", async () => {
    const result = await callProjectTool(bridge, "import_assets", {});
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("deferred_op_timeout");
    expect(text).toContain("wall-clock cap");
    expect(text).toContain("deferred_op_timeout_ms");
  }, 120_000);

  it("the queue drains after the timeout - the next op is served (REQ-A-12)", async () => {
    const listing = (await bridge.request("project/list_resources", {})) as {
      resources: Array<{ path: string }>;
      count: number;
    };
    expect(listing.count).toBeGreaterThan(0);
  }, 60_000);
});
