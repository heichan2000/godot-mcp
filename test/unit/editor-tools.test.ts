import { describe, expect, it, vi } from "vitest";
import { createEditorTools } from "../../src/tools/editor.js";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";

function makeDeps(overrides: {
  config?: Partial<Config>;
  resolution: GodotPathResolution;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
}) {
  return {
    loadConfig: vi.fn((): Config => ({ godotPath: undefined, debug: false, ...overrides.config })),
    detectGodotPath: vi.fn(() => overrides.resolution),
    execFile:
      overrides.execFile ??
      vi.fn(async () => ({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" })),
  };
}

function getVersionTool(deps: ReturnType<typeof makeDeps>) {
  const tools = createEditorTools(deps);
  const tool = tools.find((t) => t.name === "get_godot_version");
  if (!tool) throw new Error("get_godot_version descriptor not found");
  return tool;
}

describe("createEditorTools", () => {
  it("exposes exactly one descriptor named get_godot_version with an empty input schema", () => {
    const deps = makeDeps({ resolution: { found: false, candidates: [] } });
    const tools = createEditorTools(deps);

    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("get_godot_version");
    expect(tools[0]!.inputSchema).toEqual({});
    expect(tools[0]!.description.length).toBeGreaterThan(0);
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
});
