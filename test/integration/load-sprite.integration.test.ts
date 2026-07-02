import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import { hasGodotCacheDir, hasImportCache } from "../../src/godot/cache.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import {
  resolveOperationsScriptPath,
  runGodotImport,
  runOperation,
} from "../../src/godot/runner.js";
import { createProjectTools } from "../../src/tools/project.js";
import { createSceneTools } from "../../src/tools/scene.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

const VERIFY_SCRIPT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "verify_sprite_texture.gd",
);

const TEXTURE_PATH = path.join("textures", "sprite.png");

function execFile(file: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFileCb(file, args, (_error, stdout, stderr) => {
      resolve({ stdout: stdout.toString(), stderr: stderr.toString() });
    });
  });
}

interface VerifyResult {
  ok: boolean;
  node_found: boolean;
  node_class: string;
  has_texture: boolean;
  texture_resource_path: string;
}

/**
 * Round-trips a scene through a real Godot `load()` call, independent of
 * operations.gd, and reports whether the node at node_path has a `texture`
 * assigned plus that texture's resource_path.
 */
async function verifySprite(
  projectPath: string,
  resScenePath: string,
  nodePath: string,
): Promise<VerifyResult> {
  const { stdout } = await execFile(godotPath!, [
    "--headless",
    "--path",
    projectPath,
    "--script",
    VERIFY_SCRIPT,
    "--",
    resScenePath,
    nodePath,
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

function makeSceneTools(overrides: { runOperation?: typeof runOperation } = {}) {
  return createSceneTools({
    loadConfig: (): Config => ({ godotPath, debug: false }),
    detectGodotPath,
    runOperation: overrides.runOperation ?? runOperation,
    operationsScriptPath: resolveOperationsScriptPath(),
    hasImportCache,
  });
}

function makeProjectTools() {
  return createProjectTools({
    loadConfig: (): Config => ({ godotPath, debug: false }),
    detectGodotPath,
    runGodotImport,
    hasGodotCacheDir,
    hasImportCache,
  });
}

function getTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

/**
 * Creates a fresh sample project (cold - no .godot/ - since it's a plain
 * copy of the committed fixture) containing a scene with both a Sprite2D
 * node ("Hero") and a plain Node2D ("NotASprite"), ready for load_sprite
 * calls. Does NOT build the import cache - callers that need a warm
 * project call import_project themselves so cold-cache behavior stays
 * independently testable.
 */
async function coldProjectWithSpriteScene(): Promise<{ projectPath: string; scenePath: string }> {
  const projectPath = freshSampleProject();
  const sceneTools = makeSceneTools();
  const scenePath = path.join("scenes", "hero.tscn");

  const createResult = await getTool(sceneTools, "create_scene").handler(
    { project_path: projectPath, scene_path: scenePath, root_node_type: "Node2D" },
    {} as never,
  );
  if (createResult.isError) {
    throw new Error(`Failed to set up base scene: ${JSON.stringify(createResult)}`);
  }

  const addSpriteResult = await getTool(sceneTools, "add_node").handler(
    { project_path: projectPath, scene_path: scenePath, node_type: "Sprite2D", node_name: "Hero" },
    {} as never,
  );
  if (addSpriteResult.isError) {
    throw new Error(`Failed to add Sprite2D node: ${JSON.stringify(addSpriteResult)}`);
  }

  const addPlainNodeResult = await getTool(sceneTools, "add_node").handler(
    {
      project_path: projectPath,
      scene_path: scenePath,
      node_type: "Node2D",
      node_name: "NotASprite",
    },
    {} as never,
  );
  if (addPlainNodeResult.isError) {
    throw new Error(`Failed to add plain Node2D: ${JSON.stringify(addPlainNodeResult)}`);
  }

  return { projectPath, scenePath };
}

/** Same as coldProjectWithSpriteScene, but also runs import_project so the cache is warm. */
async function warmProjectWithSpriteScene(): Promise<{ projectPath: string; scenePath: string }> {
  const { projectPath, scenePath } = await coldProjectWithSpriteScene();
  const projectTools = makeProjectTools();

  const importResult = await getTool(projectTools, "import_project").handler(
    { project_path: projectPath },
    {} as never,
  );
  if (importResult.isError) {
    throw new Error(`Failed to import project: ${JSON.stringify(importResult)}`);
  }

  return { projectPath, scenePath };
}

describe.skipIf(!hasGodot)(
  "load_sprite + import_project (integration, real headless Godot)",
  () => {
    it(
      "full sequence: cold project -> guided import error naming import_project (no import ran) -> " +
        "import_project builds the cache -> load_sprite succeeds with the texture reference " +
        "persisted in the re-opened scene",
      async () => {
        const { projectPath, scenePath } = await coldProjectWithSpriteScene();
        const sceneTools = makeSceneTools();
        const projectTools = makeProjectTools();

        expect(existsSync(path.join(projectPath, ".godot"))).toBe(false);

        const coldStart = Date.now();
        const coldResult = await getTool(sceneTools, "load_sprite").handler(
          {
            project_path: projectPath,
            scene_path: scenePath,
            node_path: "Hero",
            texture_path: TEXTURE_PATH,
          },
          {} as never,
        );
        const coldDurationMs = Date.now() - coldStart;

        expect(coldResult.isError).toBe(true);
        const coldText = (coldResult.content[0] as { text: string }).text;
        expect(coldText).toContain("import_project");
        // The cold-cache check is a filesystem check, not a Godot invocation -
        // this should return in well under the time an actual import would take.
        expect(coldDurationMs).toBeLessThan(10_000);
        // No import ran as a side effect of the failed call.
        expect(existsSync(path.join(projectPath, ".godot"))).toBe(false);

        const importResult = await getTool(projectTools, "import_project").handler(
          { project_path: projectPath },
          {} as never,
        );
        expect(importResult.isError).toBeFalsy();
        expect(existsSync(path.join(projectPath, ".godot", "imported"))).toBe(true);

        const warmResult = await getTool(sceneTools, "load_sprite").handler(
          {
            project_path: projectPath,
            scene_path: scenePath,
            node_path: "Hero",
            texture_path: TEXTURE_PATH,
          },
          {} as never,
        );
        expect(warmResult.isError).toBeFalsy();

        const verified = await verifySprite(projectPath, "res://scenes/hero.tscn", "Hero");
        expect(verified.ok).toBe(true);
        expect(verified.node_found).toBe(true);
        expect(verified.node_class).toBe("Sprite2D");
        expect(verified.has_texture).toBe(true);
        expect(verified.texture_resource_path).toBe("res://textures/sprite.png");
      },
      60_000,
    );

    it("rejects a target node that is not a Sprite2D/Sprite3D with a structured error naming both classes", async () => {
      const { projectPath, scenePath } = await warmProjectWithSpriteScene();
      const sceneTools = makeSceneTools();

      const result = await getTool(sceneTools, "load_sprite").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_path: "NotASprite",
          texture_path: TEXTURE_PATH,
        },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("Sprite2D");
      expect(text).toContain("Sprite3D");
      expect(text).toContain("Node2D");
    }, 60_000);

    it("rejects a texture_path that does not exist with a structured error naming the missing file", async () => {
      const { projectPath, scenePath } = await warmProjectWithSpriteScene();
      const sceneTools = makeSceneTools();

      const result = await getTool(sceneTools, "load_sprite").handler(
        {
          project_path: projectPath,
          scene_path: scenePath,
          node_path: "Hero",
          texture_path: path.join("textures", "does-not-exist.png"),
        },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("does-not-exist.png");
    }, 60_000);

    it("rejects an escaping texture_path with a containment error WITHOUT invoking Godot", async () => {
      const projectPath = freshSampleProject();
      const runOperationSpy = vi.fn(runOperation);
      const sceneTools = makeSceneTools({ runOperation: runOperationSpy });

      const result = await getTool(sceneTools, "load_sprite").handler(
        {
          project_path: projectPath,
          scene_path: path.join("scenes", "hero.tscn"),
          texture_path: path.join("..", "escape.png"),
        },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(runOperationSpy).not.toHaveBeenCalled();
    }, 30_000);

    it("rejects an escaping scene_path with a containment error WITHOUT invoking Godot", async () => {
      const projectPath = freshSampleProject();
      const runOperationSpy = vi.fn(runOperation);
      const sceneTools = makeSceneTools({ runOperation: runOperationSpy });

      const result = await getTool(sceneTools, "load_sprite").handler(
        {
          project_path: projectPath,
          scene_path: path.join("..", "escape.tscn"),
          texture_path: TEXTURE_PATH,
        },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(runOperationSpy).not.toHaveBeenCalled();
    }, 30_000);
  },
);
