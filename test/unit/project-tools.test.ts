import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProjectTools } from "../../src/tools/project.js";
import type { Config } from "../../src/config.js";
import type { ListProjectsResult, ProjectInfo } from "../../src/godot/discovery.js";
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
  hasImportCacheResult?: boolean;
  listProjectDirsResult?: ListProjectsResult;
  readProjectInfoResult?: ProjectInfo | null;
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
    hasImportCache: vi.fn(() => overrides.hasImportCacheResult ?? true),
    listProjectDirs: vi.fn(
      (): ListProjectsResult =>
        overrides.listProjectDirsResult ?? { projects: [], truncated: false },
    ),
    readProjectInfo: vi.fn((): ProjectInfo | null =>
      overrides.readProjectInfoResult === undefined ? null : overrides.readProjectInfoResult,
    ),
  };
}

function getImportProjectTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createProjectTools(deps);
  const tool = tools.find((t) => t.name === "import_project");
  if (!tool) throw new Error("import_project descriptor not found");
  return tool;
}

describe("createProjectTools", () => {
  it("exposes import_project, list_projects, and get_project_info descriptors", () => {
    const deps = makeDeps({});
    const tools = createProjectTools(deps);

    expect(tools.map((t) => t.name).sort()).toEqual(
      ["get_project_info", "import_project", "list_projects"].sort(),
    );
    const importProject = tools.find((t) => t.name === "import_project")!;
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

  it("returns a structured error, not success, when the run completed and .godot/ exists but no import cache was built (partial/failed import)", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      runGodotImportResult: {
        kind: "completed",
        exitCode: 0,
        stdout: "",
        stderr: "",
        durationMs: 50,
      },
      hasGodotCacheDirResult: true,
      hasImportCacheResult: false,
    });
    const tool = getImportProjectTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("import cache");
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

function getListProjectsTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createProjectTools(deps);
  const tool = tools.find((t) => t.name === "list_projects");
  if (!tool) throw new Error("list_projects descriptor not found");
  return tool;
}

function getGetProjectInfoTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createProjectTools(deps);
  const tool = tools.find((t) => t.name === "get_project_info");
  if (!tool) throw new Error("get_project_info descriptor not found");
  return tool;
}

describe("list_projects", () => {
  it("exposes directory, recursive, and max_depth as its input schema", () => {
    const deps = makeDeps({});
    const tool = getListProjectsTool(deps);

    expect(Object.keys(tool.inputSchema).sort()).toEqual(
      ["directory", "max_depth", "recursive"].sort(),
    );
  });

  it("calls listProjectDirs with directory, recursive, and max_depth", async () => {
    const deps = makeDeps({});
    const tool = getListProjectsTool(deps);

    await tool.handler({ directory: "/projects", recursive: false, max_depth: 2 }, {} as never);

    expect(deps.listProjectDirs).toHaveBeenCalledWith(
      "/projects",
      expect.objectContaining({ recursive: false, maxDepth: 2 }),
    );
  });

  it("returns the found project paths in structuredContent", async () => {
    const deps = makeDeps({
      listProjectDirsResult: { projects: ["/projects/a", "/projects/b"], truncated: false },
    });
    const tool = getListProjectsTool(deps);

    const result = await tool.handler({ directory: "/projects" }, {} as never);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      projects: ["/projects/a", "/projects/b"],
      truncated: false,
    });
  });

  it("mentions the cap being hit when the result was truncated", async () => {
    const deps = makeDeps({
      listProjectDirsResult: { projects: ["/projects/a"], truncated: true },
    });
    const tool = getListProjectsTool(deps);

    const result = await tool.handler({ directory: "/projects" }, {} as never);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({ projects: ["/projects/a"], truncated: true });
    const text = (result.content[0] as { text: string }).text;
    expect(text.toLowerCase()).toContain("cap");
  });

  it("returns a guided structured error, not a throw, when the search directory cannot be read", async () => {
    const deps = makeDeps({});
    deps.listProjectDirs.mockImplementation(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });
    const tool = getListProjectsTool(deps);

    const result = await tool.handler({ directory: "/does/not/exist" }, {} as never);

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as { possibleSolutions: string[] };
    expect(structured.possibleSolutions.length).toBeGreaterThan(0);
  });

  it("never invokes Godot resolution - this is a pure filesystem walk", async () => {
    const deps = makeDeps({});
    const tool = getListProjectsTool(deps);

    await tool.handler({ directory: "/projects" }, {} as never);

    expect(deps.detectGodotPath).not.toHaveBeenCalled();
  });
});

describe("get_project_info", () => {
  it("exposes just a project_path input", () => {
    const deps = makeDeps({});
    const tool = getGetProjectInfoTool(deps);

    expect(Object.keys(tool.inputSchema)).toEqual(["project_path"]);
  });

  it("returns name, godot_version, and counts in structuredContent when the project exists", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      readProjectInfoResult: {
        name: "Demo",
        godotVersion: "4.3",
        configVersion: 5,
        fileCount: 4,
        assetCount: 1,
      },
    });
    const tool = getGetProjectInfoTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      project_path: root,
      name: "Demo",
      godot_version: "4.3",
      file_count: 4,
      asset_count: 1,
    });
  });

  it("returns a guided structured error when project.godot is missing at project_path", async () => {
    const root = makeRoot();
    const deps = makeDeps({ readProjectInfoResult: null });
    const tool = getGetProjectInfoTool(deps);

    const result = await tool.handler({ project_path: root }, {} as never);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("project.godot");
    const structured = result.structuredContent as { possibleSolutions: string[] };
    expect(structured.possibleSolutions.length).toBeGreaterThan(0);
  });

  it("never invokes Godot resolution - this is a pure filesystem read", async () => {
    const root = makeRoot();
    const deps = makeDeps({
      readProjectInfoResult: {
        name: "Demo",
        godotVersion: "4.3",
        configVersion: 5,
        fileCount: 1,
        assetCount: 0,
      },
    });
    const tool = getGetProjectInfoTool(deps);

    await tool.handler({ project_path: root }, {} as never);

    expect(deps.detectGodotPath).not.toHaveBeenCalled();
  });
});
