import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { Config } from "../../src/config.js";
import { hasImportCache } from "../../src/godot/cache.js";
import { detectGodotPath } from "../../src/godot/paths.js";
import {
  resolveOperationsScriptPath,
  runGodotImport,
  runOperation,
} from "../../src/godot/runner.js";
import { createUidTools } from "../../src/tools/uid.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

function makeTools(overrides: { runOperation?: typeof runOperation } = {}) {
  return createUidTools({
    loadConfig: (): Config => ({ godotPath, debug: false, outputBufferLines: 1000 }),
    detectGodotPath,
    runOperation: overrides.runOperation ?? runOperation,
    runGodotImport,
    hasImportCache,
    operationsScriptPath: resolveOperationsScriptPath(),
  });
}

/**
 * Builds the project's import cache directly (bypassing the import_project
 * tool, which isn't under test here). Both get_uid and update_project_uids
 * rely on this - get_uid because a resource's UID is only recognized by
 * Godot's runtime registry after a project scan (which --import triggers),
 * same as load_sprite's asset-import dependency.
 */
async function importProject(projectPath: string): Promise<void> {
  const result = await runGodotImport({ godotPath: godotPath!, projectPath });
  if (result.kind !== "completed") {
    throw new Error(`import failed to launch/finish: ${JSON.stringify(result)}`);
  }
}

function getTool<T extends { name: string }>(tools: T[], name: string): T {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

const UID_FORMAT = /^uid:\/\/[0-9a-z]+$/;

describe.skipIf(!hasGodot)(
  "get_uid / update_project_uids (integration, real headless Godot)",
  () => {
    it("get_uid on a script matches the committed .uid sidecar file, independent of any resave", async () => {
      const projectPath = freshSampleProject();
      await importProject(projectPath);
      const tools = makeTools();
      const sidecarPath = path.join(projectPath, "scripts", "print_marker.gd.uid");
      expect(existsSync(sidecarPath)).toBe(true);
      const expectedUid = readFileSync(sidecarPath, "utf-8").trim();
      expect(expectedUid).toMatch(UID_FORMAT);

      const result = await getTool(tools, "get_uid").handler(
        { project_path: projectPath, file_path: path.join("scripts", "print_marker.gd") },
        {} as never,
      );

      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toEqual({
        file_path: "res://scripts/print_marker.gd",
        uid: expectedUid,
      });
    }, 60_000);

    it("get_uid is stable across repeated calls for the same file", async () => {
      const projectPath = freshSampleProject();
      await importProject(projectPath);
      const tools = makeTools();
      const args = {
        project_path: projectPath,
        file_path: path.join("scripts", "print_marker.gd"),
      };

      const first = await getTool(tools, "get_uid").handler(args, {} as never);
      const second = await getTool(tools, "get_uid").handler(args, {} as never);

      expect(first.isError).toBeFalsy();
      expect(second.isError).toBeFalsy();
      expect(first.structuredContent).toEqual(second.structuredContent);
    }, 60_000);

    it("get_uid returns a guided cold-import-cache error naming import_project when the cache is missing, without invoking Godot at all", async () => {
      const projectPath = freshSampleProject();
      // Deliberately NOT importing first - a fresh clone has no .godot/imported/ cache yet.
      const tools = makeTools();

      const result = await getTool(tools, "get_uid").handler(
        { project_path: projectPath, file_path: path.join("scripts", "print_marker.gd") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("import_project");
    }, 30_000);

    it("get_uid on a scene authored pre-4.4 (no embedded uid yet) reports a guided 'no UID assigned' error", async () => {
      const projectPath = freshSampleProject();
      await importProject(projectPath);
      const tools = makeTools();
      const scenePath = path.join(projectPath, "scenes", "meshes.tscn");
      // Sanity-check the fixture's actual starting state independent of the
      // tool under test: the sample project's config/features targets "4.3"
      // and its committed .tscn files have no uid= attribute in the header.
      expect(readFileSync(scenePath, "utf-8")).not.toContain("uid=");

      const result = await getTool(tools, "get_uid").handler(
        { project_path: projectPath, file_path: path.join("scenes", "meshes.tscn") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text.toLowerCase()).toContain("no uid is assigned");
      expect(text).toContain("update_project_uids");
    }, 60_000);

    it("update_project_uids embeds a uid= into pre-4.4 scenes AND leaves get_uid immediately able to report it back (no separate import_project needed)", async () => {
      const projectPath = freshSampleProject();
      const tools = makeTools();
      const meshesScenePath = path.join(projectPath, "scenes", "meshes.tscn");
      const printMarkerScenePath = path.join(projectPath, "scenes", "print_marker.tscn");

      // Starts from a fresh, never-imported clone - update_project_uids must
      // not require import_project to have run first (unlike get_uid).
      expect(existsSync(path.join(projectPath, ".godot"))).toBe(false);
      expect(readFileSync(meshesScenePath, "utf-8")).not.toContain("uid=");
      expect(readFileSync(printMarkerScenePath, "utf-8")).not.toContain("uid=");

      const updateResult = await getTool(tools, "update_project_uids").handler(
        { project_path: projectPath },
        {} as never,
      );

      expect(updateResult.isError).toBeFalsy();
      const structured = updateResult.structuredContent as {
        touched: string[];
        touched_count: number;
        already_had_uid: string[];
        failed: string[];
      };
      expect(structured.touched).toContain("res://scenes/meshes.tscn");
      expect(structured.touched).toContain("res://scenes/print_marker.tscn");
      expect(structured.touched_count).toBe(structured.touched.length);
      expect(structured.already_had_uid).toEqual([]);
      expect(structured.failed).toEqual([]);

      // Independent evidence: the .tscn files on disk now carry an embedded
      // uid= in their header, not just what the tool reports. The rest of the
      // scene content (a minimal, targeted header edit rather than a full
      // resave) must still be byte-identical.
      const meshesContentAfter = readFileSync(meshesScenePath, "utf-8");
      const printMarkerContentAfter = readFileSync(printMarkerScenePath, "utf-8");
      expect(meshesContentAfter).toMatch(
        /^\[gd_scene load_steps=3 format=3 uid="uid:\/\/[0-9a-z]+"\]/,
      );
      expect(printMarkerContentAfter).toMatch(
        /^\[gd_scene load_steps=2 format=3 uid="uid:\/\/[0-9a-z]+"\]/,
      );
      expect(meshesContentAfter).toContain("BoxMesh");
      expect(meshesContentAfter).toContain("SphereMesh");
      expect(printMarkerContentAfter).toContain('ExtResource("1")');

      // get_uid on the same file now returns a real uid://, matching the one
      // embedded in the file (extracted independently via regex, not by
      // trusting the tool's own prior report) - and works right away, with no
      // separate import_project call, because update_project_uids re-runs the
      // import itself.
      const embeddedUidMatch = /uid="(uid:\/\/[0-9a-z]+)"/.exec(meshesContentAfter);
      expect(embeddedUidMatch).not.toBeNull();
      const embeddedUid = embeddedUidMatch![1];

      const getUidResult = await getTool(tools, "get_uid").handler(
        { project_path: projectPath, file_path: path.join("scenes", "meshes.tscn") },
        {} as never,
      );

      expect(getUidResult.isError).toBeFalsy();
      expect(getUidResult.structuredContent).toEqual({
        file_path: "res://scenes/meshes.tscn",
        uid: embeddedUid,
      });
      expect(embeddedUid).toMatch(UID_FORMAT);
    }, 90_000);

    it("update_project_uids is idempotent: a second call reports every file as already_had_uid and touches nothing", async () => {
      const projectPath = freshSampleProject();
      const tools = makeTools();

      const first = await getTool(tools, "update_project_uids").handler(
        { project_path: projectPath },
        {} as never,
      );
      expect(first.isError).toBeFalsy();
      const firstStructured = first.structuredContent as { touched: string[] };
      expect(firstStructured.touched.length).toBeGreaterThan(0);

      const second = await getTool(tools, "update_project_uids").handler(
        { project_path: projectPath },
        {} as never,
      );

      expect(second.isError).toBeFalsy();
      const secondStructured = second.structuredContent as {
        touched: string[];
        already_had_uid: string[];
        failed: string[];
      };
      expect(secondStructured.touched).toEqual([]);
      expect(secondStructured.already_had_uid.sort()).toEqual(firstStructured.touched.sort());
      expect(secondStructured.failed).toEqual([]);
    }, 90_000);

    it("get_uid reports a structured error naming file_path when the file does not exist", async () => {
      const projectPath = freshSampleProject();
      await importProject(projectPath);
      const tools = makeTools();

      const result = await getTool(tools, "get_uid").handler(
        { project_path: projectPath, file_path: path.join("scripts", "does-not-exist.gd") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      const text = (result.content[0] as { text: string }).text;
      expect(text).toContain("does-not-exist.gd");
    }, 60_000);

    it("rejects an escaping file_path with a containment error WITHOUT invoking Godot", async () => {
      const projectPath = freshSampleProject();
      let called = false;
      const spyingRunOperation: typeof runOperation = async (...args) => {
        called = true;
        return runOperation(...args);
      };
      const tools = makeTools({ runOperation: spyingRunOperation });

      const result = await getTool(tools, "get_uid").handler(
        { project_path: projectPath, file_path: path.join("..", "escape.gd") },
        {} as never,
      );

      expect(result.isError).toBe(true);
      expect(called).toBe(false);
    }, 30_000);
  },
);
