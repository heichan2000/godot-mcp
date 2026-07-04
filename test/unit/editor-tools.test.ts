import { describe, expect, it, vi } from "vitest";
import { createEditorTools } from "../../src/tools/editor.js";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";
import type { DetachedProcessHandle } from "../../src/godot/process.js";

function makeDeps(overrides: {
  config?: Partial<Config>;
  resolution: GodotPathResolution;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  spawnDetached?: (file: string, args: string[]) => DetachedProcessHandle;
}) {
  return {
    loadConfig: vi.fn((): Config => ({
      godotPath: undefined,
      debug: false,
      outputBufferLines: 1000,
      ...overrides.config,
    })),
    detectGodotPath: vi.fn(() => overrides.resolution),
    execFile:
      overrides.execFile ??
      vi.fn(async () => ({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" })),
    spawnDetached: overrides.spawnDetached ?? vi.fn(() => ({ pid: 5555 })),
  };
}

function getVersionTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createEditorTools(deps);
  const tool = tools.find((t) => t.name === "get_godot_version");
  if (!tool) throw new Error("get_godot_version descriptor not found");
  return tool;
}

function getLaunchEditorTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createEditorTools(deps);
  const tool = tools.find((t) => t.name === "launch_editor");
  if (!tool) throw new Error("launch_editor descriptor not found");
  return tool;
}

describe("createEditorTools", () => {
  it("exposes get_godot_version and launch_editor descriptors", () => {
    const deps = makeDeps({ resolution: { found: false, candidates: [] } });
    const tools = createEditorTools(deps);

    expect(tools.map((t) => t.name).sort()).toEqual(["get_godot_version", "launch_editor"]);
    const getVersion = tools.find((t) => t.name === "get_godot_version")!;
    expect(getVersion.inputSchema).toEqual({});
    expect(getVersion.description.length).toBeGreaterThan(0);
    const launchEditor = tools.find((t) => t.name === "launch_editor")!;
    expect(Object.keys(launchEditor.inputSchema)).toEqual(["project_path"]);
    expect(launchEditor.description.length).toBeGreaterThan(0);
  });

  it("returns the trimmed version string when Godot resolves successfully", async () => {
    const deps = makeDeps({
      resolution: { found: true, path: "/opt/godot/godot", source: "configured" },
      execFile: vi.fn(async () => ({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" })),
    });
    const tool = getVersionTool(deps);

    const result = await tool.handler({}, {} as never);

    expect(result.isError).toBeFalsy();
    expect(result.content).toEqual([{ type: "text", text: "4.6.3.stable.official.abcd1234" }]);
    expect(deps.execFile).toHaveBeenCalledWith("/opt/godot/godot", ["--version"]);
  });

  it("returns a structured guided error when Godot cannot be resolved, without throwing", async () => {
    const deps = makeDeps({
      resolution: {
        found: false,
        candidates: ["/usr/bin/godot", "/usr/local/bin/godot"],
      },
    });
    const tool = getVersionTool(deps);

    const result = await tool.handler({}, {} as never);

    expect(result.isError).toBe(true);
    const structured = result.structuredContent as {
      message: string;
      possibleSolutions: string[];
    };
    expect(structured.message).toMatch(/godot/i);
    expect(structured.possibleSolutions.join(" ")).toContain("GODOT_PATH");
    const [content] = result.content;
    expect((content as { text: string }).text).toContain("/usr/bin/godot");
  });

  it("returns a structured error (not a throw) when the resolved executable fails to run", async () => {
    const deps = makeDeps({
      resolution: { found: true, path: "/bad/godot", source: "configured" },
      execFile: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    });
    const tool = getVersionTool(deps);

    const result = await tool.handler({}, {} as never);

    expect(result.isError).toBe(true);
    const [content] = result.content;
    expect((content as { text: string }).text).toContain("ENOENT");
  });

  it("never writes to stdout while handling a call", async () => {
    const deps = makeDeps({
      resolution: { found: true, path: "/opt/godot/godot", source: "configured" },
    });
    const tool = getVersionTool(deps);
    const writeSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);

    await tool.handler({}, {} as never);

    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  it("logs diagnostics to stderr only when DEBUG is enabled", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const quietDeps = makeDeps({
      config: { debug: false },
      resolution: { found: true, path: "/opt/godot/godot", source: "configured" },
    });
    await getVersionTool(quietDeps).handler({}, {} as never);
    expect(errorSpy).not.toHaveBeenCalled();

    const debugDeps = makeDeps({
      config: { debug: true },
      resolution: { found: true, path: "/opt/godot/godot", source: "configured" },
    });
    await getVersionTool(debugDeps).handler({}, {} as never);
    expect(errorSpy).toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  describe("launch_editor", () => {
    it("spawns the resolved Godot binary with -e --path <project_path> and returns immediately", async () => {
      const spawnDetached = vi.fn(() => ({ pid: 7777 }));
      const deps = makeDeps({
        resolution: { found: true, path: "/opt/godot/godot", source: "configured" },
        spawnDetached,
      });
      const tool = getLaunchEditorTool(deps);

      const result = await tool.handler({ project_path: "/projects/demo" }, {} as never);

      expect(spawnDetached).toHaveBeenCalledWith("/opt/godot/godot", [
        "-e",
        "--path",
        "/projects/demo",
      ]);
      expect(result.isError).toBeFalsy();
      const structured = result.structuredContent as { pid: number | null };
      expect(structured.pid).toBe(7777);
    });

    it("returns a structured guided error when Godot cannot be resolved, without spawning", async () => {
      const spawnDetached = vi.fn(() => ({ pid: 1 }));
      const deps = makeDeps({
        resolution: { found: false, candidates: ["/usr/bin/godot"] },
        spawnDetached,
      });
      const tool = getLaunchEditorTool(deps);

      const result = await tool.handler({ project_path: "/projects/demo" }, {} as never);

      expect(result.isError).toBe(true);
      expect(spawnDetached).not.toHaveBeenCalled();
    });
  });
});
