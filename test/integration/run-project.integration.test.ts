import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import { GodotProcessManager } from "../../src/godot/process.js";
import { createRunTools } from "../../src/tools/run.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

const MARKER = "GODOT_MCP_RUN_MARKER: hello from run_project";

function makeRunTools() {
  // A fresh GodotProcessManager per test - never the module-level default
  // singleton - so tests never share an active process with each other.
  return createRunTools({
    loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
    detectGodotPath,
    processManager: new GodotProcessManager(),
  });
}

function getTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Polls get_debug_output until its captured output contains `marker` or
 * `timeoutMs` elapses, returning the last seen { output, errors }. Godot's
 * headless boot is not instantaneous, so run_project returning does not
 * itself mean the marker has been printed yet.
 */
async function pollForMarker(
  tools: ReturnType<typeof makeRunTools>,
  marker: string,
  timeoutMs = 20_000,
): Promise<{ output: string[]; errors: string[] }> {
  const deadline = Date.now() + timeoutMs;
  let last: { output: string[]; errors: string[] } = { output: [], errors: [] };

  while (Date.now() < deadline) {
    const result = await getTool(tools, "get_debug_output").handler({}, {} as never);
    if (!result.isError) {
      last = result.structuredContent as { output: string[]; errors: string[] };
      if (last.output.some((line) => line.includes(marker))) {
        return last;
      }
    }
    await sleep(250);
  }
  return last;
}

describe.skipIf(!hasGodot)(
  "run_project + get_debug_output (integration, real headless Godot)",
  () => {
    it(
      "headless run of the sample project's print_marker scene captures its print() output " +
        "(independent evidence: the marker line originates from Godot's real engine, not from " +
        "this tool's own success report)",
      async () => {
        const projectPath = freshSampleProject();
        const tools = makeRunTools();
        const scenePath = path.join("scenes", "print_marker.tscn");

        const runResult = await getTool(tools, "run_project").handler(
          { project_path: projectPath, scene: scenePath, headless: true },
          {} as never,
        );
        expect(runResult.isError).toBeFalsy();

        const captured = await pollForMarker(tools, MARKER);

        expect(captured.output.some((line) => line.includes(MARKER))).toBe(true);
      },
      30_000,
    );

    it("stop_project returns the same captured tail and then reports not-running", async () => {
      const projectPath = freshSampleProject();
      const tools = makeRunTools();
      const scenePath = path.join("scenes", "print_marker.tscn");

      await getTool(tools, "run_project").handler(
        { project_path: projectPath, scene: scenePath, headless: true },
        {} as never,
      );
      await pollForMarker(tools, MARKER);

      const stopResult = await getTool(tools, "stop_project").handler({}, {} as never);
      expect(stopResult.isError).toBeFalsy();
      const structured = stopResult.structuredContent as { output: string[]; errors: string[] };
      expect(structured.output.some((line) => line.includes(MARKER))).toBe(true);

      const secondStop = await getTool(tools, "stop_project").handler({}, {} as never);
      expect(secondStop.isError).toBe(true);

      const debugAfterStop = await getTool(tools, "get_debug_output").handler({}, {} as never);
      expect(debugAfterStop.isError).toBe(true);
    }, 30_000);
  },
);
