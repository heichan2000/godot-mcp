import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createUidTools, MIN_UID_GODOT_VERSION } from "../../src/tools/uid.js";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";
import type {
  runGodotImport,
  runOperation,
  RunGodotImportResult,
  RunOperationResult,
} from "../../src/godot/runner.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "godot-mcp-uid-tools-"));
}

function makeDeps(overrides: {
  config?: Partial<Config>;
  resolution?: GodotPathResolution;
  runOperationResult?: RunOperationResult;
  runOperation?: typeof runOperation;
  runGodotImportResult?: RunGodotImportResult;
  runGodotImport?: typeof runGodotImport;
  hasImportCacheResult?: boolean;
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
    runOperation:
      overrides.runOperation ??
      vi.fn(
        async (): Promise<RunOperationResult> =>
          overrides.runOperationResult ?? {
            kind: "success",
            version: 1,
            operation: "get_uid",
            result: { file_path: "res://scripts/print_marker.gd", uid: "uid://48o0gvc1i7pu" },
          },
      ),
    runGodotImport:
      overrides.runGodotImport ??
      vi.fn(
        async (): Promise<RunGodotImportResult> =>
          overrides.runGodotImportResult ?? {
            kind: "completed",
            exitCode: 0,
            stdout: "",
            stderr: "",
            durationMs: 1234,
          },
      ),
    hasImportCache: vi.fn(() => overrides.hasImportCacheResult ?? true),
    operationsScriptPath: "/dist/operations.gd",
  };
}

function getTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

describe("createUidTools", () => {
  it("exposes get_uid and update_project_uids descriptors, both requiring Godot >= 4.4", () => {
    const deps = makeDeps({});
    const tools = createUidTools(deps);

    expect(tools.map((t) => t.name).sort()).toEqual(["get_uid", "update_project_uids"]);

    const getUid = getTool(tools, "get_uid");
    expect(Object.keys(getUid.inputSchema).sort()).toEqual(["file_path", "project_path"]);
    expect(getUid.minGodotVersion).toBe(MIN_UID_GODOT_VERSION);
    expect(getUid.description).toContain("4.4");

    const updateProjectUids = getTool(tools, "update_project_uids");
    expect(Object.keys(updateProjectUids.inputSchema)).toEqual(["project_path"]);
    expect(updateProjectUids.minGodotVersion).toBe(MIN_UID_GODOT_VERSION);
    expect(updateProjectUids.description).toContain("4.4");
  });

  it("MIN_UID_GODOT_VERSION is 4.4 (godot-prd.md §6.1)", () => {
    expect(MIN_UID_GODOT_VERSION).toBe("4.4");
  });

  describe("get_uid", () => {
    it("rejects an escaping file_path with a containment error WITHOUT invoking Godot", async () => {
      const projectPath = makeRoot();
      const runOperationSpy = vi.fn();
      const deps = makeDeps({ runOperation: runOperationSpy as unknown as typeof runOperation });
      const tool = getTool(createUidTools(deps), "get_uid");

      const result = await tool.handler(
        { project_path: projectPath, file_path: path.join("..", "escape.tscn") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(runOperationSpy).not.toHaveBeenCalled();
    });

    it("rejects an absolute file_path with a containment error WITHOUT invoking Godot", async () => {
      const projectPath = makeRoot();
      const runOperationSpy = vi.fn();
      const deps = makeDeps({ runOperation: runOperationSpy as unknown as typeof runOperation });
      const tool = getTool(createUidTools(deps), "get_uid");

      const result = await tool.handler(
        { project_path: projectPath, file_path: path.resolve(projectPath, "x.tscn") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(runOperationSpy).not.toHaveBeenCalled();
    });

    it("returns a guided cold-import-cache error naming import_project when the cache is missing, WITHOUT invoking Godot", async () => {
      const projectPath = makeRoot();
      const runOperationSpy = vi.fn();
      const detectGodotPathSpy = vi.fn();
      const deps = {
        ...makeDeps({
          runOperation: runOperationSpy as unknown as typeof runOperation,
          hasImportCacheResult: false,
        }),
        detectGodotPath: detectGodotPathSpy,
      };
      const tool = getTool(createUidTools(deps), "get_uid");

      const result = await tool.handler(
        { project_path: projectPath, file_path: "scripts/foo.gd" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("import_project");
      expect(runOperationSpy).not.toHaveBeenCalled();
      expect(detectGodotPathSpy).not.toHaveBeenCalled();
    });

    it("returns a structured guided error when Godot cannot be resolved, without invoking runOperation", async () => {
      const projectPath = makeRoot();
      const runOperationSpy = vi.fn();
      const deps = makeDeps({
        resolution: { found: false, candidates: ["/usr/bin/godot"] },
        runOperation: runOperationSpy as unknown as typeof runOperation,
      });
      const tool = getTool(createUidTools(deps), "get_uid");

      const result = await tool.handler(
        { project_path: projectPath, file_path: "scripts/foo.gd" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as { possibleSolutions: string[] };
      expect(structured.possibleSolutions.join(" ")).toContain("GODOT_PATH");
      expect(runOperationSpy).not.toHaveBeenCalled();
    });

    it("invokes the get_uid operation with file_path and returns the resolved uid on success", async () => {
      const projectPath = makeRoot();
      const runOperationSpy = vi.fn(async (): Promise<RunOperationResult> => ({
        kind: "success",
        version: 1,
        operation: "get_uid",
        result: { file_path: "res://scripts/print_marker.gd", uid: "uid://48o0gvc1i7pu" },
      }));
      const deps = makeDeps({ runOperation: runOperationSpy });
      const tool = getTool(createUidTools(deps), "get_uid");

      const result = await tool.handler(
        { project_path: projectPath, file_path: "scripts/print_marker.gd" },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        file_path: "res://scripts/print_marker.gd",
        uid: "uid://48o0gvc1i7pu",
      });
      expect(runOperationSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: "get_uid",
          params: { file_path: "scripts/print_marker.gd" },
        }),
      );
    });

    it("returns a guided error naming update_project_uids when the dispatcher reports no UID assigned", async () => {
      const projectPath = makeRoot();
      const deps = makeDeps({
        runOperationResult: {
          kind: "operation-error",
          version: 1,
          operation: "get_uid",
          error:
            "No UID is assigned to resource at res://scenes/foo.tscn yet. Run update_project_uids first.",
        },
      });
      const tool = getTool(createUidTools(deps), "get_uid");

      const result = await tool.handler(
        { project_path: projectPath, file_path: "scenes/foo.tscn" },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const structured = result.structuredContent as { possibleSolutions: string[] };
      expect(structured.possibleSolutions.join(" ")).toContain("update_project_uids");
    });
  });

  describe("update_project_uids", () => {
    it("invokes the update_project_uids operation, then re-runs import, returning the op's touched/failed lists", async () => {
      const projectPath = makeRoot();
      const runOperationSpy = vi.fn(async (): Promise<RunOperationResult> => ({
        kind: "success",
        version: 1,
        operation: "update_project_uids",
        result: {
          touched: ["res://scenes/a.tscn", "res://scenes/b.tscn"],
          touched_count: 2,
          already_had_uid: [],
          failed: [],
        },
      }));
      const runGodotImportSpy = vi.fn(async (): Promise<RunGodotImportResult> => ({
        kind: "completed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 42,
      }));
      const deps = makeDeps({ runOperation: runOperationSpy, runGodotImport: runGodotImportSpy });
      const tool = getTool(createUidTools(deps), "update_project_uids");

      const result = await tool.handler({ project_path: projectPath }, {} as never);

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        touched: ["res://scenes/a.tscn", "res://scenes/b.tscn"],
        touched_count: 2,
        already_had_uid: [],
        failed: [],
      });
      expect(runOperationSpy).toHaveBeenCalledWith(
        expect.objectContaining({ operation: "update_project_uids", params: {} }),
      );
      expect(runGodotImportSpy).toHaveBeenCalledWith(expect.objectContaining({ projectPath }));
    });

    it("does not re-run import when the update_project_uids operation itself fails", async () => {
      const projectPath = makeRoot();
      const runGodotImportSpy = vi.fn();
      const deps = makeDeps({
        runOperationResult: {
          kind: "operation-error",
          version: 1,
          operation: "update_project_uids",
          error: "something went wrong",
        },
        runGodotImport: runGodotImportSpy as unknown as typeof runGodotImport,
      });
      const tool = getTool(createUidTools(deps), "update_project_uids");

      const result = await tool.handler({ project_path: projectPath }, {} as never);

      expect(result.isError).toBe(true);
      expect(runGodotImportSpy).not.toHaveBeenCalled();
    });

    it("reports a structured error (mentioning import_project as a manual fallback) when the post-update import fails to launch", async () => {
      const projectPath = makeRoot();
      const deps = makeDeps({
        runGodotImportResult: { kind: "spawn-error", message: "ENOENT" },
      });
      const tool = getTool(createUidTools(deps), "update_project_uids");

      const result = await tool.handler({ project_path: projectPath }, {} as never);

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("ENOENT");
      expect(text.toLowerCase()).toContain("import_project");
    });

    it("returns a structured guided error when Godot cannot be resolved, without invoking runOperation", async () => {
      const projectPath = makeRoot();
      const runOperationSpy = vi.fn();
      const deps = makeDeps({
        resolution: { found: false, candidates: ["/usr/bin/godot"] },
        runOperation: runOperationSpy as unknown as typeof runOperation,
      });
      const tool = getTool(createUidTools(deps), "update_project_uids");

      const result = await tool.handler({ project_path: projectPath }, {} as never);

      expect(result.isError).toBe(true);
      expect(runOperationSpy).not.toHaveBeenCalled();
    });
  });
});
