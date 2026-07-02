import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { hasImportCache } from "../../src/godot/cache.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import { resolveOperationsScriptPath, runOperation } from "../../src/godot/runner.js";
import { createSceneTools } from "../../src/tools/scene.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

const VERIFY_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "verify_mesh_library.gd",
);

function execFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFileCb(file, args, (_error, stdout, stderr) => {
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

interface VerifyItem {
  id: number;
  name: string;
  has_mesh: boolean;
}

interface VerifyResult {
  ok: boolean;
  item_count: number;
  items: VerifyItem[];
}

/**
 * Round-trips a MeshLibrary resource through a real Godot `load()` call,
 * independent of operations.gd, and reports its items.
 */
async function verifyMeshLibrary(
  projectPath: string,
  resOutputPath: string,
): Promise<VerifyResult> {
  const { stdout } = await execFile(godotPath!, [
    "--headless",
    "--path",
    projectPath,
    "--script",
    VERIFY_SCRIPT,
    "--",
    resOutputPath,
  ]);
  const marker = "GODOT_MCP_VERIFY:";
  const line = stdout
    .split("\n")
    .map((l) => l.trim())
    .reverse()
    .find((l) => l.startsWith(marker));
  if (!line) {
    throw new Error(`No ${marker} marker found in verify script stdout:\n${stdout}`);
  }
  return JSON.parse(line.slice(marker.length)) as VerifyResult;
}

function makeTools(overrides: { runOperation?: typeof runOperation } = {}) {
  return createSceneTools({
    loadConfig: (): Config => ({ godotPath, debug: false }),
    detectGodotPath,
    runOperation: overrides.runOperation ?? runOperation,
    operationsScriptPath: resolveOperationsScriptPath(),
    hasImportCache,
  });
}

function getTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

describe.skipIf(!hasGodot)("export_mesh_library (integration, real headless Godot)", () => {
  it(
    "produces a .res that loads as a MeshLibrary with the expected item names, with no import " +
      "cache built - primitive meshes (BoxMesh/SphereMesh) need no import step",
    async () => {
      const projectPath = freshSampleProject();
      expect(existsSync(path.join(projectPath, ".godot"))).toBe(false);
      const tools = makeTools();

      const result = await getTool(tools, "export_mesh_library").handler(
        {
          project_path: projectPath,
          scene_path: path.join("scenes", "meshes.tscn"),
          output_path: "meshlib.res",
        },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        scene_path: "res://scenes/meshes.tscn",
        output_path: "res://meshlib.res",
        item_names: ["Box", "Sphere"],
      });
      expect(existsSync(path.join(projectPath, "meshlib.res"))).toBe(true);
      // Still no import cache - export_mesh_library never triggered one.
      expect(existsSync(path.join(projectPath, ".godot"))).toBe(false);

      const verified = await verifyMeshLibrary(projectPath, "res://meshlib.res");
      expect(verified.ok).toBe(true);
      expect(verified.item_count).toBe(2);
      const names = verified.items.map((item) => item.name).sort();
      expect(names).toEqual(["Box", "Sphere"]);
      for (const item of verified.items) {
        expect(item.has_mesh).toBe(true);
      }
    },
    60_000,
  );

  it("mesh_item_names filters the exported library to only the requested item(s)", async () => {
    const projectPath = freshSampleProject();
    const tools = makeTools();

    const result = await getTool(tools, "export_mesh_library").handler(
      {
        project_path: projectPath,
        scene_path: path.join("scenes", "meshes.tscn"),
        output_path: "meshlib-box-only.res",
        mesh_item_names: ["Box"],
      },
      {} as never,
    );

    expect(result.isError).toBeFalsy();
    expect(result.structuredContent).toEqual({
      scene_path: "res://scenes/meshes.tscn",
      output_path: "res://meshlib-box-only.res",
      item_names: ["Box"],
    });

    const verified = await verifyMeshLibrary(projectPath, "res://meshlib-box-only.res");
    expect(verified.ok).toBe(true);
    expect(verified.item_count).toBe(1);
    expect(verified.items[0]?.name).toBe("Box");
  }, 60_000);

  it("reports a structured error naming the available item names when mesh_item_names matches nothing", async () => {
    const projectPath = freshSampleProject();
    const tools = makeTools();

    const result = await getTool(tools, "export_mesh_library").handler(
      {
        project_path: projectPath,
        scene_path: path.join("scenes", "meshes.tscn"),
        output_path: "meshlib-bogus.res",
        mesh_item_names: ["DoesNotExist"],
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("Box");
    expect(text).toContain("Sphere");
    expect(existsSync(path.join(projectPath, "meshlib-bogus.res"))).toBe(false);
  }, 60_000);

  it("reports a structured error when the scene has no MeshInstance3D nodes with an assigned mesh", async () => {
    const projectPath = freshSampleProject();
    const sceneTools = makeTools();

    const createResult = await getTool(sceneTools, "create_scene").handler(
      {
        project_path: projectPath,
        scene_path: path.join("scenes", "empty.tscn"),
        root_node_type: "Node3D",
      },
      {} as never,
    );
    expect(createResult.isError).toBeFalsy();

    const result = await getTool(sceneTools, "export_mesh_library").handler(
      {
        project_path: projectPath,
        scene_path: path.join("scenes", "empty.tscn"),
        output_path: "meshlib-empty.res",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("MeshInstance3D");
    expect(existsSync(path.join(projectPath, "meshlib-empty.res"))).toBe(false);
  }, 60_000);

  it("rejects an escaping output_path with a containment error WITHOUT invoking Godot", async () => {
    const projectPath = freshSampleProject();
    const runOperationSpy = vi.fn(runOperation);
    const tools = makeTools({ runOperation: runOperationSpy });

    const result = await getTool(tools, "export_mesh_library").handler(
      {
        project_path: projectPath,
        scene_path: path.join("scenes", "meshes.tscn"),
        output_path: path.join("..", "escape.res"),
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(runOperationSpy).not.toHaveBeenCalled();
  }, 30_000);

  it("rejects an escaping scene_path with a containment error WITHOUT invoking Godot", async () => {
    const projectPath = freshSampleProject();
    const runOperationSpy = vi.fn(runOperation);
    const tools = makeTools({ runOperation: runOperationSpy });

    const result = await getTool(tools, "export_mesh_library").handler(
      {
        project_path: projectPath,
        scene_path: path.join("..", "escape.tscn"),
        output_path: "meshlib.res",
      },
      {} as never,
    );

    expect(result.isError).toBe(true);
    expect(runOperationSpy).not.toHaveBeenCalled();
  }, 30_000);
});
