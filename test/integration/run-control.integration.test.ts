import { readFileSync, rmSync } from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import type { ToolDescriptor } from "../../src/registry.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createRunTools } from "../../src/tools/run.js";
import { createSceneTools } from "../../src/tools/scene.js";
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

const MARKER = "GODOT_MCP_RUN_MARKER: hello from run_project";
const MARKER_SCENE = "res://scenes/print_marker.tscn";
const SPAM_SCENE = "res://scenes/log_spam.tscn";
const BUFFER_LINES = 1000;

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

type OutputPayload = {
  lines: Array<{ stream: string; text: string }>;
  next_cursor: number;
  dropped_lines: number;
  playing: boolean;
};

async function callTool(
  tools: ToolDescriptor[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

describe.runIf(hasGodot)("run control against a real editor (#72)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let runTools: ToolDescriptor[];
  let sceneTools: ToolDescriptor[];

  async function readOutput(after: number): Promise<OutputPayload> {
    const result = await callTool(runTools, "get_debug_output", { cursor: after });
    expect(result.isError).toBeUndefined();
    return result.structuredContent as unknown as OutputPayload;
  }

  /** Cursor-tails the session output until a line matches, collecting as it goes. */
  async function tailUntil(
    fromCursor: number,
    predicate: (line: { stream: string; text: string }) => boolean,
    timeoutMs: number,
  ): Promise<{ lines: Array<{ stream: string; text: string }>; cursor: number }> {
    const collected: Array<{ stream: string; text: string }> = [];
    let cursor = fromCursor;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const out = await readOutput(cursor);
      collected.push(...out.lines);
      cursor = out.next_cursor;
      if (collected.some(predicate)) return { lines: collected, cursor };
      if (Date.now() > deadline) {
        throw new Error(`timed out tailing output; collected ${collected.length} line(s)`);
      }
      await delay(250);
    }
  }

  async function pollUntil<T>(
    probe: () => Promise<T | undefined>,
    timeoutMs: number,
    what: string,
  ): Promise<T> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await probe();
      if (value !== undefined) return value;
      if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
      await delay(250);
    }
  }

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
      requestTimeoutMs: 60_000,
      reconnectDelayMs: 500,
      log: (message) => {
        if (process.env.DEBUG) console.error(message);
      },
    });
    bridge.start();
    await bridge.waitForState("connected", 150_000);
    runTools = createRunTools({ bridge, outputBufferLines: BUFFER_LINES });
    sceneTools = createSceneTools({ bridge });
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("the forwarding autoload is on disk by the time the bridge accepts ops (#96)", () => {
    // Spawned games read project.godot from disk; if the plugin's boot
    // self-heal hasn't flushed the GodotMCPRuntime autoload before the
    // bridge comes up, a first-play game boots without the forwarding
    // logger and the whole session's output is silently lost.
    const settings = readFileSync(path.join(projectDir, "project.godot"), "utf8");
    expect(settings).toContain("[autoload]");
    expect(settings).toContain("GodotMCPRuntime");
  });

  it("get_debug_output is safe before any run: empty, not playing", async () => {
    const out = await readOutput(0);
    expect(out.lines).toEqual([]);
    expect(out.dropped_lines).toBe(0);
    expect(out.playing).toBe(false);
  });

  it("run_project plays a named scene and its output tails through the cursor (REQ-E-01/E-03)", async () => {
    const result = await callTool(runTools, "run_project", { scene_path: MARKER_SCENE });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({
      mode: "custom",
      scene_path: MARKER_SCENE,
      replaced_active: false,
    });
    const { lines, cursor } = await tailUntil(0, (line) => line.text.includes(MARKER), 90_000);
    expect(lines.filter((line) => line.text.includes(MARKER))).toHaveLength(1);
    // Incremental cursor: reading from where we stopped never replays the marker.
    const next = await readOutput(cursor);
    expect(next.lines.some((line) => line.text.includes(MARKER))).toBe(false);
  }, 120_000);

  it("the last session's output survives game exit (REQ-E-03)", async () => {
    // print_marker.gd quits on its own; wait for the editor to notice.
    await pollUntil(
      async () => ((await readOutput(0)).playing === false ? true : undefined),
      90_000,
      "the marker scene to exit",
    );
    const out = await readOutput(0);
    expect(out.lines.some((line) => line.text.includes(MARKER))).toBe(true);
  }, 120_000);

  it("stop with nothing running is a structured success no-op (REQ-E-02)", async () => {
    const result = await callTool(runTools, "stop_project");
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ was_running: false });
  });

  it("run_project plays the current scene, and a new run owns a cleared buffer (REQ-E-01)", async () => {
    const opened = await callTool(sceneTools, "open_scene", { scene_path: MARKER_SCENE });
    expect(opened.isError).toBeUndefined();
    const result = await callTool(runTools, "run_project", { mode: "current" });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ mode: "current", scene_path: MARKER_SCENE });
    const { lines } = await tailUntil(0, (line) => line.text.includes(MARKER), 90_000);
    // Exactly one marker from cursor 0: the previous session's buffer was cleared.
    expect(lines.filter((line) => line.text.includes(MARKER))).toHaveLength(1);
    expect((await readOutput(0)).dropped_lines).toBe(0);
  }, 120_000);

  it("run_project plays the main scene (REQ-E-01)", async () => {
    await pollUntil(
      async () => ((await readOutput(0)).playing === false ? true : undefined),
      90_000,
      "the previous session to exit",
    );
    const result = await callTool(runTools, "run_project", {});
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ mode: "main", scene_path: MARKER_SCENE });
    await tailUntil(0, (line) => line.text.includes(MARKER), 90_000);
  }, 120_000);

  it("the buffer stays bounded under sustained spam, and stop ends the session (REQ-E-02/E-03)", async () => {
    const started = await callTool(runTools, "run_project", { scene_path: SPAM_SCENE });
    expect(started.isError).toBeUndefined();
    // Boundedness: the ring evicts while the game keeps spamming.
    const firstOverflow = await pollUntil(
      async () => {
        const out = await readOutput(0);
        return out.dropped_lines > 0 ? out : undefined;
      },
      90_000,
      "the ring buffer to overflow",
    );
    expect(firstOverflow.lines.length).toBeLessThanOrEqual(500); // per-read page cap
    await delay(2_000);
    const laterOverflow = await readOutput(0);
    expect(laterOverflow.dropped_lines).toBeGreaterThan(firstOverflow.dropped_lines);
    // Stop ends the session...
    const stopped = await callTool(runTools, "stop_project");
    expect(stopped.isError).toBeUndefined();
    expect(stopped.structuredContent).toMatchObject({ was_running: true });
    await pollUntil(
      async () => ((await readOutput(0)).playing === false ? true : undefined),
      60_000,
      "the spam scene to stop",
    );
    // ...and its output remains readable afterwards.
    const after = await readOutput(0);
    expect(after.lines.length).toBeGreaterThan(0);
    expect(after.lines.some((line) => line.text.includes("GODOT_MCP_SPAM"))).toBe(true);
  }, 180_000);

  it("run_project rejects a containment escape (REQ-M-01)", async () => {
    const result = await callTool(runTools, "run_project", { scene_path: "../../etc/passwd" });
    expect(result.isError).toBe(true);
  });

  it("an editor death during a run yields the structured disconnected error, never a hang (REQ-A-04)", async () => {
    const started = await callTool(runTools, "run_project", { scene_path: SPAM_SCENE });
    expect(started.isError).toBeUndefined();
    await editor.kill();
    await bridge.waitForState("disconnected", 30_000);
    const result = await callTool(runTools, "get_debug_output");
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text).toMatch(/not connected|disconnect/i);
  }, 120_000);
});
