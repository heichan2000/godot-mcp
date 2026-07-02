import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import {
  DISPATCHER_VERSION,
  assertOperationsScriptExists,
  resolveOperationsScriptPath,
  runOperation,
  type RunnerExecFile,
} from "../../src/godot/runner.js";

function makeExecFile(
  impl: (
    file: string,
    args: string[],
  ) => Promise<{ stdout: string; stderr: string; exitCode: number | null }>,
): RunnerExecFile {
  return vi.fn(impl);
}

function resultLine(payload: Record<string, unknown>): string {
  return `Godot Engine v4.6.3.stable\n\nGODOT_MCP_RESULT:${JSON.stringify(payload)}\n`;
}

describe("resolveOperationsScriptPath", () => {
  it("resolves operations.gd next to the given module URL", () => {
    const moduleUrl = "file:///C:/fake/dist/index.js";
    const result = resolveOperationsScriptPath(moduleUrl);
    expect(result).toBe(path.join("C:", "fake", "dist", "operations.gd"));
  });

  it("defaults to this module's own directory (src/godot in dev/test)", () => {
    const result = resolveOperationsScriptPath();
    expect(result.endsWith(path.join("godot", "operations.gd"))).toBe(true);
  });
});

describe("assertOperationsScriptExists", () => {
  it("does not throw when the file exists", () => {
    expect(() => assertOperationsScriptExists("/fake/operations.gd", () => true)).not.toThrow();
  });

  it("throws a guided error naming the missing path when absent", () => {
    expect(() => assertOperationsScriptExists("/fake/operations.gd", () => false)).toThrow(
      /operations\.gd/,
    );
  });
});

describe("runOperation", () => {
  const baseOptions = {
    godotPath: "/usr/bin/godot",
    projectPath: "/projects/demo",
    operationScriptPath: "/dist/operations.gd",
    operation: "create_scene",
    params: { scene_path: "scenes/hero.tscn" },
  };

  it("invokes execFile with the exact argv contract: headless, path, script, --, op, json", async () => {
    const execFile = makeExecFile(async () => ({
      stdout: resultLine({
        ok: true,
        version: DISPATCHER_VERSION,
        operation: "create_scene",
        result: { scene_path: "res://scenes/hero.tscn" },
      }),
      stderr: "",
      exitCode: 0,
    }));

    await runOperation(baseOptions, { execFile });

    expect(execFile).toHaveBeenCalledWith("/usr/bin/godot", [
      "--headless",
      "--path",
      "/projects/demo",
      "--script",
      "/dist/operations.gd",
      "--",
      "create_scene",
      JSON.stringify({ scene_path: "scenes/hero.tscn" }),
    ]);
  });

  it("returns a success result when the dispatcher reports ok:true at the expected version", async () => {
    const execFile = makeExecFile(async () => ({
      stdout: resultLine({
        ok: true,
        version: DISPATCHER_VERSION,
        operation: "create_scene",
        result: { scene_path: "res://scenes/hero.tscn" },
      }),
      stderr: "",
      exitCode: 0,
    }));

    const result = await runOperation(baseOptions, { execFile });

    expect(result).toEqual({
      kind: "success",
      version: DISPATCHER_VERSION,
      operation: "create_scene",
      result: { scene_path: "res://scenes/hero.tscn" },
    });
  });

  it("returns an operation-error result when the dispatcher reports ok:false", async () => {
    const execFile = makeExecFile(async () => ({
      stdout: resultLine({
        ok: false,
        version: DISPATCHER_VERSION,
        operation: "create_scene",
        error: "root_node_type is not an instantiable Node class: Bogus",
      }),
      stderr: "",
      exitCode: 1,
    }));

    const result = await runOperation(baseOptions, { execFile });

    expect(result).toEqual({
      kind: "operation-error",
      version: DISPATCHER_VERSION,
      operation: "create_scene",
      error: "root_node_type is not an instantiable Node class: Bogus",
    });
  });

  it("returns a version-mismatch result naming both versions when they differ", async () => {
    const execFile = makeExecFile(async () => ({
      stdout: resultLine({
        ok: true,
        version: 999,
        operation: "create_scene",
        result: {},
      }),
      stderr: "",
      exitCode: 0,
    }));

    const result = await runOperation({ ...baseOptions, expectedVersion: 1 }, { execFile });

    expect(result).toEqual({
      kind: "version-mismatch",
      expectedVersion: 1,
      actualVersion: 999,
    });
  });

  it("returns a protocol-error result when no result marker line is present in stdout", async () => {
    const execFile = makeExecFile(async () => ({
      stdout: "Godot Engine v4.6.3.stable\n\n(no marker here)\n",
      stderr: "some engine warning",
      exitCode: 1,
    }));

    const result = await runOperation(baseOptions, { execFile });

    expect(result.kind).toBe("protocol-error");
    if (result.kind === "protocol-error") {
      expect(result.stderr).toContain("some engine warning");
      expect(result.exitCode).toBe(1);
    }
  });

  it("returns a protocol-error result when the marker line is not valid JSON", async () => {
    const execFile = makeExecFile(async () => ({
      stdout: "GODOT_MCP_RESULT:{not valid json",
      stderr: "",
      exitCode: 1,
    }));

    const result = await runOperation(baseOptions, { execFile });

    expect(result.kind).toBe("protocol-error");
  });

  it("uses the last marker line when the output contains more than one", async () => {
    const execFile = makeExecFile(async () => ({
      stdout: [
        `GODOT_MCP_RESULT:${JSON.stringify({ ok: false, version: DISPATCHER_VERSION, operation: "create_scene", error: "stale" })}`,
        `GODOT_MCP_RESULT:${JSON.stringify({ ok: true, version: DISPATCHER_VERSION, operation: "create_scene", result: { scene_path: "res://x.tscn" } })}`,
      ].join("\n"),
      stderr: "",
      exitCode: 0,
    }));

    const result = await runOperation(baseOptions, { execFile });

    expect(result).toEqual({
      kind: "success",
      version: DISPATCHER_VERSION,
      operation: "create_scene",
      result: { scene_path: "res://x.tscn" },
    });
  });

  it("returns a spawn-error result when execFile rejects (e.g. Godot binary missing)", async () => {
    const execFile: RunnerExecFile = vi.fn(async () => {
      throw new Error("ENOENT: spawn /usr/bin/godot");
    });

    const result = await runOperation(baseOptions, { execFile });

    expect(result.kind).toBe("spawn-error");
    if (result.kind === "spawn-error") {
      expect(result.message).toContain("ENOENT");
    }
  });
});
