import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createRunTools } from "../../src/tools/run.js";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";
import type {
  DebugOutput,
  GodotProcessManager,
  RunProjectOutcome,
  StopOutcome,
} from "../../src/godot/process.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "godot-mcp-run-tools-"));
}

function makeFakeProcessManager(overrides: {
  runResult?: RunProjectOutcome;
  getOutputResult?: DebugOutput | undefined;
  stopResult?: StopOutcome;
}) {
  return {
    run: vi.fn(
      (): RunProjectOutcome => overrides.runResult ?? { pid: 1234, replacedActive: false },
    ),
    getOutput: vi.fn((): DebugOutput | undefined => overrides.getOutputResult),
    stop: vi.fn((): StopOutcome => overrides.stopResult ?? { kind: "not-running" }),
  } as unknown as GodotProcessManager;
}

function makeDeps(overrides: {
  config?: Partial<Config>;
  resolution?: GodotPathResolution;
  processManager?: ReturnType<typeof makeFakeProcessManager>;
}) {
  const resolution: GodotPathResolution = overrides.resolution ?? {
    found: true,
    path: "/usr/bin/godot",
    source: "configured",
  };
  return {
    loadConfig: vi.fn((): Config => ({
      godotPath: undefined,
      debug: false,
      outputBufferLines: 1000,
      ...overrides.config,
    })),
    detectGodotPath: vi.fn(() => resolution),
    processManager: overrides.processManager ?? makeFakeProcessManager({}),
  };
}

function getTool(deps: ReturnType<typeof makeDeps>, name: string) {
  const tools = createRunTools(deps);
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

describe("createRunTools", () => {
  it("exposes run_project, get_debug_output, and stop_project with their expected schema keys", () => {
    const deps = makeDeps({});
    const tools = createRunTools(deps);

    expect(tools.map((t) => t.name).sort()).toEqual([
      "get_debug_output",
      "run_project",
      "stop_project",
    ]);

    const runProject = tools.find((t) => t.name === "run_project")!;
    expect(Object.keys(runProject.inputSchema).sort()).toEqual(
      ["project_path", "scene", "headless"].sort(),
    );

    const getDebugOutput = tools.find((t) => t.name === "get_debug_output")!;
    expect(getDebugOutput.inputSchema).toEqual({});

    const stopProject = tools.find((t) => t.name === "stop_project")!;
    expect(stopProject.inputSchema).toEqual({});
  });

  describe("run_project", () => {
    it("resolves Godot and calls processManager.run with headless: false by default (windowed)", async () => {
      const root = makeRoot();
      const deps = makeDeps({});
      const tool = getTool(deps, "run_project");

      const result = await tool.handler({ project_path: root }, {} as never);

      expect(deps.processManager.run).toHaveBeenCalledWith({
        godotPath: "/usr/bin/godot",
        projectPath: root,
        scene: undefined,
        headless: false,
        outputBufferLines: 1000,
      });
      expect(result.isError).toBeFalsy();
    });

    it("passes headless: true through when requested", async () => {
      const root = makeRoot();
      const deps = makeDeps({});
      const tool = getTool(deps, "run_project");

      await tool.handler({ project_path: root, headless: true }, {} as never);

      expect(deps.processManager.run).toHaveBeenCalledWith(
        expect.objectContaining({ headless: true }),
      );
    });

    it("converts a relative scene path into res:// form for the process manager", async () => {
      const root = makeRoot();
      const deps = makeDeps({});
      const tool = getTool(deps, "run_project");

      await tool.handler(
        { project_path: root, scene: path.join("scenes", "hero.tscn") },
        {} as never,
      );

      expect(deps.processManager.run).toHaveBeenCalledWith(
        expect.objectContaining({ scene: "res://scenes/hero.tscn" }),
      );
    });

    it("rejects an escaping scene path with a containment error WITHOUT starting Godot", async () => {
      const root = makeRoot();
      const deps = makeDeps({});
      const tool = getTool(deps, "run_project");

      const result = await tool.handler(
        { project_path: root, scene: path.join("..", "escape.tscn") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(deps.processManager.run).not.toHaveBeenCalled();
    });

    it("returns a structured guided error when Godot cannot be resolved, without starting a process", async () => {
      const deps = makeDeps({ resolution: { found: false, candidates: ["/usr/bin/godot"] } });
      const tool = getTool(deps, "run_project");

      const result = await tool.handler({ project_path: makeRoot() }, {} as never);

      expect(result.isError).toBe(true);
      expect(deps.processManager.run).not.toHaveBeenCalled();
    });

    it("notes in the response when a previous run was replaced", async () => {
      const processManager = makeFakeProcessManager({
        runResult: { pid: 99, replacedActive: true },
      });
      const deps = makeDeps({ processManager });
      const tool = getTool(deps, "run_project");

      const result = await tool.handler({ project_path: makeRoot() }, {} as never);

      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { replaced_active: boolean };
      expect(structured.replaced_active).toBe(true);
    });
  });

  describe("get_debug_output", () => {
    it("returns the current { output, errors } from the process manager", async () => {
      const processManager = makeFakeProcessManager({
        getOutputResult: { output: ["line 1", "line 2"], errors: ["err 1"] },
      });
      const deps = makeDeps({ processManager });
      const tool = getTool(deps, "get_debug_output");

      const result = await tool.handler({}, {} as never);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        output: ["line 1", "line 2"],
        errors: ["err 1"],
      });
    });

    it("returns a clear structured error when no process is active", async () => {
      const processManager = makeFakeProcessManager({ getOutputResult: undefined });
      const deps = makeDeps({ processManager });
      const tool = getTool(deps, "get_debug_output");

      const result = await tool.handler({}, {} as never);

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as { message: string };
      expect(structured.message).toMatch(/no.*process|not.*running/i);
    });
  });

  describe("stop_project", () => {
    it("returns the captured tail and clears state on success", async () => {
      const processManager = makeFakeProcessManager({
        stopResult: { kind: "stopped", output: ["a", "b"], errors: ["e"] },
      });
      const deps = makeDeps({ processManager });
      const tool = getTool(deps, "stop_project");

      const result = await tool.handler({}, {} as never);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({ output: ["a", "b"], errors: ["e"] });
    });

    it("returns a clear structured error when nothing is running", async () => {
      const processManager = makeFakeProcessManager({ stopResult: { kind: "not-running" } });
      const deps = makeDeps({ processManager });
      const tool = getTool(deps, "stop_project");

      const result = await tool.handler({}, {} as never);

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as { message: string };
      expect(structured.message).toMatch(/no.*process|not.*running/i);
    });
  });
});
