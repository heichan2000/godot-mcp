import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProjectTools } from "../../src/tools/project.js";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";
import type { runGodotImport, RunGodotImportResult } from "../../src/godot/runner.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "godot-mcp-project-tools-"));
}

function makeDeps(overrides: {
  config?: Partial<Config>;
  resolution?: GodotPathResolution;
  runGodotImportResult?: RunGodotImportResult;
  runGodotImport?: typeof runGodotImport;
  hasGodotCacheDirResult?: boolean;
}) {
  const resolution: GodotPathResolution = overrides.resolution ?? {
    found: true,
    path: "/usr/bin/godot",
    source: "configured",
  };
  return {
    loadConfig: vi.fn((): Config => ({ godotPath: undefined, debug: false, ...overrides.config })),
    detectGodotPath: vi.fn(() => resolution),
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
    hasGodotCacheDir: vi.fn(() => overrides.hasGodotCacheDirResult ?? true),
  };
}

function getImportProjectTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createProjectTools(deps);
  const tool = tools.find((t) => t.name === "import_project");
  if (!tool) throw new Error("import_project descriptor not found");
  return tool;
}

describe("createProjectTools", () => {
  it("exposes the import_project descriptor with just a project_path input", () => {
    const deps = makeDeps({});
    const tools = createProjectTools(deps);

    expect(tools.map((t) => t.name)).toEqual(["import_project"]);
    const importProject = tools[0]!;
    expect(Object.keys(importProject.inputSchema)).toEqual(["project_path"]);
  });

  it("calls runGodotImport with the resolved godot path and given project_path", async () => {
    const root = makeRoot();
    const deps = makeDeps({});
    const tool = getImportProjectTool(deps);

    await tool.handler({ project_path: root }, {} as never);

    expect(deps.runGodotImport).toHaveBeenCalledWith(
      expect.objectContaining({ godotPath: "/usr/bin/godot", projectPath: root }),
    );
  });

  it("returns success content with duration_ms when the run completed and the cache exists afterward", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runGodotImportResult: {
        kind: "completed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 4321,
      },
      hasGodotCacheDirResult: true,
    });
    const tool = getImportProjectTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ project_path: root, duration_ms: 4321 });
  });

  it("still reports success when Godot exits nonzero, as long as the cache exists afterward (benign nonzero exit)", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runGodotImportResult: {
        kind: "completed",
        exitCode: 1,
        stdout: "",
        stderr: "some benign noise",
        durationMs: 500,
      },
      hasGodotCacheDirResult: true,
    });
    const tool = getImportProjectTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBeFalsy();
  });

  it("returns a structured error naming the missing cache when the run completed but no .godot cache was produced", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runGodotImportResult: {
        kind: "completed",
        exitCode: 1,
        stdout: "",
        stderr: "Invalid project path specified",
        durationMs: 10,
      },
      hasGodotCacheDirResult: false,
    });
    const tool = getImportProjectTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("project.godot");
  });

  it("returns a structured guided error when Godot cannot be resolved, without invoking runGodotImport", async () => {
    const root = makeRoot();
    const deps = makeDeps({ resolution: { found: false, candidates: ["/usr/bin/godot"] } });
    const tool = getImportProjectTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBe(true);
    expect(deps.runGodotImport).not.toHaveBeenCalled();
  });

  it("returns a structured error for a spawn-error result", async () => {
    const root = makeRoot();
    const deps = makeDeps({ runGodotImportResult: { kind: "spawn-error", message: "ENOENT" } });
    const tool = getImportProjectTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("ENOENT");
  });

  it("returns a guided timeout error naming the timeout duration", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runGodotImportResult: { kind: "timeout", timeoutMs: 300_000 },
    });
    const tool = getImportProjectTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("300000");
  });

  it("mentions that the import may be slow in its tool description", () => {
    const deps = makeDeps({});
    const tool = getImportProjectTool(deps);

    expect(tool.description.toLowerCase()).toContain("slow");
  });
});
