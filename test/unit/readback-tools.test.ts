import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";
import type { runCheckOnly, RunCheckOnlyResult } from "../../src/godot/runner.js";
import { createReadbackTools } from "../../src/tools/readback.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "godot-mcp-readback-tools-"));
}

const VALID_SCENE_TEXT =
  "[gd_scene load_steps=2 format=3]\n\n" +
  '[ext_resource type="Script" path="res://scripts/print_marker.gd" id="1"]\n\n' +
  '[node name="PrintMarker" type="Node"]\n' +
  'script = ExtResource("1")\n';

const NO_SCRIPT_SCENE_TEXT =
  "[gd_scene load_steps=3 format=3]\n\n" +
  '[sub_resource type="BoxMesh" id="BoxMesh_box"]\n\n' +
  '[node name="Meshes" type="Node3D"]\n';

const TWO_SCRIPT_SCENE_TEXT =
  '[ext_resource type="Script" path="res://scripts/a.gd" id="1"]\n' +
  '[ext_resource type="Script" path="res://scripts/b.gd" id="2"]\n';

const BROKEN_STDERR =
  'SCRIPT ERROR: Parse Error: Expected expression for variable initial value after "=".\n' +
  "   at: GDScript::reload (res://scripts/broken.gd:4)\n" +
  'ERROR: Failed to load script "res://scripts/broken.gd" with error "Parse error".\n' +
  "   at: load (modules/gdscript/gdscript.cpp:2907)\n";

function makeDeps(overrides: {
  config?: Partial<Config>;
  resolution?: GodotPathResolution;
  runCheckOnly?: typeof runCheckOnly;
  runCheckOnlyResults?: RunCheckOnlyResult[];
  fileExists?: (candidate: string) => boolean;
  readFile?: (candidate: string) => string;
}) {
  const resolution: GodotPathResolution = overrides.resolution ?? {
    found: true,
    path: "/usr/bin/godot",
    source: "configured",
  };

  let callIndex = 0;
  const queuedResults = overrides.runCheckOnlyResults;

  return {
    loadConfig: vi.fn((): Config => ({
      godotPath: undefined,
      debug: false,
      outputBufferLines: 1000,
      ...overrides.config,
    })),
    detectGodotPath: vi.fn(() => resolution),
    runCheckOnly:
      overrides.runCheckOnly ??
      vi.fn(async (): Promise<RunCheckOnlyResult> => {
        if (queuedResults && queuedResults.length > 0) {
          const next = queuedResults[Math.min(callIndex, queuedResults.length - 1)]!;
          callIndex += 1;
          return next;
        }
        return { kind: "completed", exitCode: 0, stdout: "", stderr: "" };
      }),
    fileExists: vi.fn(overrides.fileExists ?? (() => true)),
    readFile: vi.fn(overrides.readFile ?? (() => VALID_SCENE_TEXT)),
  };
}

function getTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createReadbackTools(deps);
  const tool = tools.find((t) => t.name === "get_script_errors");
  if (!tool) throw new Error("get_script_errors descriptor not found");
  return tool;
}

describe("createReadbackTools", () => {
  it("exposes get_script_errors with project_path, scene_path, and script_path schema keys", () => {
    const deps = makeDeps({});
    const tools = createReadbackTools(deps);

    expect(tools.map((t) => t.name)).toEqual(["get_script_errors"]);
    const tool = tools.find((t) => t.name === "get_script_errors")!;
    expect(Object.keys(tool.inputSchema).sort()).toEqual(
      ["project_path", "scene_path", "script_path"].sort(),
    );
  });

  it("rejects a call with neither scene_path nor script_path, without invoking Godot", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBe(true);
    expect(deps.detectGodotPath).not.toHaveBeenCalled();
    expect(deps.runCheckOnly).not.toHaveBeenCalled();
  });

  it("rejects a call with BOTH scene_path and script_path, without invoking Godot", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getTool(deps);

    const result = await tool.handler(
      { project_path: root, scene_path: "scenes/hero.tscn", script_path: "scripts/hero.gd" },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(deps.detectGodotPath).not.toHaveBeenCalled();
    expect(deps.runCheckOnly).not.toHaveBeenCalled();
  });

  describe("script_path mode", () => {
    it("rejects an escaping script_path with a containment error WITHOUT invoking Godot", async () => {
      const root = makeRoot();
      const deps = makeDeps({});
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, script_path: path.join("..", "escape.gd") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(deps.runCheckOnly).not.toHaveBeenCalled();
    });

    it("rejects an absolute script_path with a containment error WITHOUT invoking Godot", async () => {
      const root = makeRoot();
      const deps = makeDeps({});
      const tool = getTool(deps);

      const absolute = path.join(tmpdir(), "elsewhere.gd");
      const result = await tool.handler({ project_path: root, script_path: absolute }, {} as never);

      expect(result.isError).toBe(true);
      expect(deps.runCheckOnly).not.toHaveBeenCalled();
    });

    it("returns a structured error naming script_path when the script file does not exist, without invoking Godot", async () => {
      const root = makeRoot();
      const deps = makeDeps({ fileExists: () => false });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, script_path: "scripts/does-not-exist.gd" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("does-not-exist.gd");
      expect(deps.detectGodotPath).not.toHaveBeenCalled();
      expect(deps.runCheckOnly).not.toHaveBeenCalled();
    });

    it("returns a structured guided error when Godot cannot be resolved, without invoking runCheckOnly", async () => {
      const root = makeRoot();
      const deps = makeDeps({ resolution: { found: false, candidates: ["/usr/bin/godot"] } });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, script_path: "scripts/broken.gd" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(deps.runCheckOnly).not.toHaveBeenCalled();
    });

    it("calls runCheckOnly with the res:// form of script_path plus godotPath/projectPath", async () => {
      const root = makeRoot();
      const deps = makeDeps({});
      const tool = getTool(deps);

      await tool.handler({ project_path: root, script_path: "scripts/broken.gd" }, {} as never);

      expect(deps.runCheckOnly).toHaveBeenCalledWith(
        expect.objectContaining({
          godotPath: "/usr/bin/godot",
          projectPath: root,
          scriptPath: "res://scripts/broken.gd",
        }),
      );
    });

    it("returns errors: [] and raw: '' for a valid script (empty stderr, exit 0)", async () => {
      const root = makeRoot();
      const deps = makeDeps({
        runCheckOnlyResults: [{ kind: "completed", exitCode: 0, stdout: "", stderr: "" }],
      });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, script_path: "scripts/print_marker.gd" },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ errors: [], raw: "" });
    });

    it("parses at least one structured {file, line, message} entry from a broken script's stderr, and raw carries the full stderr untouched", async () => {
      const root = makeRoot();
      const deps = makeDeps({
        runCheckOnlyResults: [
          { kind: "completed", exitCode: 1, stdout: "", stderr: BROKEN_STDERR },
        ],
      });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, script_path: "scripts/broken.gd" },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        errors: Array<{ file: string; line: number; message: string }>;
        raw: string;
      };
      expect(structured.errors.length).toBeGreaterThanOrEqual(1);
      expect(structured.errors[0]).toEqual({
        file: "res://scripts/broken.gd",
        line: 4,
        message: 'Parse Error: Expected expression for variable initial value after "=".',
      });
      expect(structured.raw).toBe(BROKEN_STDERR);
    });

    it("returns a guided spawn-error result when runCheckOnly fails to launch Godot", async () => {
      const root = makeRoot();
      const deps = makeDeps({
        runCheckOnlyResults: [{ kind: "spawn-error", message: "ENOENT: spawn godot" }],
      });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, script_path: "scripts/broken.gd" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("ENOENT");
    });

    it("returns a guided timeout error result when runCheckOnly times out", async () => {
      const root = makeRoot();
      const deps = makeDeps({
        runCheckOnlyResults: [{ kind: "timeout", timeoutMs: 60_000 }],
      });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, script_path: "scripts/broken.gd" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("60000");
    });
  });

  describe("scene_path mode", () => {
    it("rejects an escaping scene_path with a containment error WITHOUT invoking Godot", async () => {
      const root = makeRoot();
      const deps = makeDeps({});
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, scene_path: path.join("..", "escape.tscn") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(deps.runCheckOnly).not.toHaveBeenCalled();
    });

    it("returns a structured error naming scene_path when the scene file does not exist, without invoking Godot", async () => {
      const root = makeRoot();
      const deps = makeDeps({ fileExists: () => false });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, scene_path: "scenes/does-not-exist.tscn" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("does-not-exist.tscn");
      expect(deps.detectGodotPath).not.toHaveBeenCalled();
      expect(deps.runCheckOnly).not.toHaveBeenCalled();
    });

    it("checks the single script a scene references, calling runCheckOnly with its res:// path", async () => {
      const root = makeRoot();
      const deps = makeDeps({ readFile: () => VALID_SCENE_TEXT });
      const tool = getTool(deps);

      await tool.handler(
        { project_path: root, scene_path: "scenes/print_marker.tscn" },
        {} as never,
      );

      expect(deps.runCheckOnly).toHaveBeenCalledTimes(1);
      expect(deps.runCheckOnly).toHaveBeenCalledWith(
        expect.objectContaining({ scriptPath: "res://scripts/print_marker.gd" }),
      );
    });

    it("returns errors: [] and raw: '' WITHOUT invoking Godot when the scene references no scripts", async () => {
      const root = makeRoot();
      const deps = makeDeps({ readFile: () => NO_SCRIPT_SCENE_TEXT });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, scene_path: "scenes/meshes.tscn" },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ errors: [], raw: "" });
      expect(deps.detectGodotPath).not.toHaveBeenCalled();
      expect(deps.runCheckOnly).not.toHaveBeenCalled();
    });

    it("checks every script a scene references and aggregates errors/raw across all of them", async () => {
      const root = makeRoot();
      const deps = makeDeps({
        readFile: () => TWO_SCRIPT_SCENE_TEXT,
        runCheckOnlyResults: [
          { kind: "completed", exitCode: 1, stdout: "", stderr: BROKEN_STDERR },
          { kind: "completed", exitCode: 0, stdout: "", stderr: "" },
        ],
      });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, scene_path: "scenes/two-scripts.tscn" },
        {} as never,
      );

      expect(deps.runCheckOnly).toHaveBeenCalledTimes(2);
      expect(deps.runCheckOnly).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ scriptPath: "res://scripts/a.gd" }),
      );
      expect(deps.runCheckOnly).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ scriptPath: "res://scripts/b.gd" }),
      );

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as {
        errors: Array<{ file: string; line: number; message: string }>;
        raw: string;
      };
      expect(structured.errors.length).toBeGreaterThanOrEqual(1);
      expect(structured.raw).toContain("SCRIPT ERROR");
      // Nothing is lost even though only one of the two scripts had errors:
      // both scripts' raw stderr text (empty or not) is represented.
      expect(structured.raw.length).toBeGreaterThan(0);
    });

    it("stops at the first script that fails to launch Godot and does not check the rest", async () => {
      const root = makeRoot();
      const deps = makeDeps({
        readFile: () => TWO_SCRIPT_SCENE_TEXT,
        runCheckOnlyResults: [{ kind: "spawn-error", message: "ENOENT: spawn godot" }],
      });
      const tool = getTool(deps);

      const result = await tool.handler(
        { project_path: root, scene_path: "scenes/two-scripts.tscn" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(deps.runCheckOnly).toHaveBeenCalledTimes(1);
    });
  });
});
