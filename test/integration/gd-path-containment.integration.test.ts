import { describe, expect, it } from "vitest";
import { resolveOperationsScriptPath, runOperation } from "../../src/godot/runner.js";
import { freshSampleProject, godotPath, hasGodot } from "./support.js";

/**
 * Defense-in-depth: operations.gd re-checks path containment ITSELF for
 * every op that takes a path parameter, independent of the TS layer's
 * `assertInsideRoot` (src/godot/paths.ts). This suite proves that second
 * wall actually holds by calling `runOperation` DIRECTLY - the same seam
 * `tools/*.ts` handlers use to invoke the dispatcher - completely bypassing
 * every TS-side tool handler (and therefore every TS-side containment
 * check). If a TS-layer bug ever let an escaping path through, this is the
 * layer that must still catch it.
 *
 * Every case here supplies just enough params to reach the path check under
 * test (operations.gd validates each op's own path param(s) before anything
 * else - see the check_path_contained call sites), never a full valid op
 * call, since the point is to prove the check fires before Godot ever
 * touches the filesystem for that param.
 */

interface ContainmentCase {
  name: string;
  operation: string;
  params: Record<string, unknown>;
  /** Case-insensitive substring expected in the rejected op's error message. */
  expectedErrorSubstring: string;
}

const TRAVERSAL_CASES: ContainmentCase[] = [
  {
    name: "create_scene: PRD §11's exact escape example (../../etc/passwd)",
    operation: "create_scene",
    params: { scene_path: "../../etc/passwd" },
    expectedErrorSubstring: "..",
  },
  {
    name: "create_scene: backslash traversal",
    operation: "create_scene",
    params: { scene_path: "..\\..\\secret.tscn" },
    expectedErrorSubstring: "..",
  },
  {
    name: "create_scene: res://-prefixed traversal",
    operation: "create_scene",
    params: { scene_path: "res://../../escape.tscn" },
    expectedErrorSubstring: "..",
  },
  {
    name: "add_node: escaping scene_path",
    operation: "add_node",
    params: { scene_path: "../../etc/passwd", node_type: "Node", node_name: "x" },
    expectedErrorSubstring: "..",
  },
  {
    name: "save_scene: escaping scene_path",
    operation: "save_scene",
    params: { scene_path: "../../etc/passwd" },
    expectedErrorSubstring: "..",
  },
  {
    name: "save_scene: valid scene_path but escaping new_path",
    operation: "save_scene",
    params: { scene_path: "scenes/does_not_exist.tscn", new_path: "../../escape.tscn" },
    expectedErrorSubstring: "..",
  },
  {
    name: "export_mesh_library: escaping scene_path",
    operation: "export_mesh_library",
    params: { scene_path: "../../etc/passwd", output_path: "meshes/lib.res" },
    expectedErrorSubstring: "..",
  },
  {
    name: "export_mesh_library: valid scene_path but escaping output_path",
    operation: "export_mesh_library",
    params: { scene_path: "scenes/does_not_exist.tscn", output_path: "../../escape.res" },
    expectedErrorSubstring: "..",
  },
  {
    name: "get_scene_tree: escaping scene_path",
    operation: "get_scene_tree",
    params: { scene_path: "../../etc/passwd" },
    expectedErrorSubstring: "..",
  },
  {
    name: "read_node_properties: escaping scene_path",
    operation: "read_node_properties",
    params: { scene_path: "../../etc/passwd", node_path: "." },
    expectedErrorSubstring: "..",
  },
  {
    name: "load_sprite: escaping scene_path",
    operation: "load_sprite",
    params: { scene_path: "../../etc/passwd", texture_path: "textures/sprite.png" },
    expectedErrorSubstring: "..",
  },
  {
    name: "load_sprite: valid scene_path but escaping texture_path",
    operation: "load_sprite",
    params: { scene_path: "scenes/does_not_exist.tscn", texture_path: "../../etc/passwd" },
    expectedErrorSubstring: "..",
  },
  {
    name: "get_uid: escaping file_path",
    operation: "get_uid",
    params: { file_path: "../../etc/passwd" },
    expectedErrorSubstring: "..",
  },
];

const ABSOLUTE_CASES: ContainmentCase[] = [
  {
    name: "create_scene: absolute POSIX path",
    operation: "create_scene",
    params: { scene_path: "/etc/passwd" },
    expectedErrorSubstring: "absolute",
  },
  {
    name: "create_scene: absolute Windows drive-letter path",
    operation: "create_scene",
    params: { scene_path: "C:\\Windows\\Temp\\evil.tscn" },
    expectedErrorSubstring: "absolute",
  },
  {
    name: "create_scene: absolute UNC path",
    operation: "create_scene",
    params: { scene_path: "\\\\server\\share\\evil.tscn" },
    expectedErrorSubstring: "absolute",
  },
  {
    name: "create_scene: user:// scheme (not this project's own res:// root)",
    operation: "create_scene",
    params: { scene_path: "user://evil.tscn" },
    expectedErrorSubstring: "user://",
  },
  {
    name: "get_uid: absolute POSIX file_path",
    operation: "get_uid",
    params: { file_path: "/etc/passwd" },
    expectedErrorSubstring: "absolute",
  },
];

describe.skipIf(!hasGodot)(
  "operations.gd path containment (integration, real headless Godot, bypassing the TS layer entirely)",
  () => {
    describe.each(TRAVERSAL_CASES)("$name", (testCase) => {
      it("is rejected by the dispatcher itself, without the TS layer's assertInsideRoot in the loop", async () => {
        const projectPath = freshSampleProject();

        const result = await runOperation({
          godotPath: godotPath!,
          projectPath,
          operationScriptPath: resolveOperationsScriptPath(),
          operation: testCase.operation,
          params: testCase.params,
        });

        expect(result.kind).toBe("operation-error");
        const error = (result as { kind: "operation-error"; error: string }).error;
        expect(error.toLowerCase()).toContain(testCase.expectedErrorSubstring.toLowerCase());
      }, 30_000);
    });

    describe.each(ABSOLUTE_CASES)("$name", (testCase) => {
      it("is rejected by the dispatcher itself, without the TS layer's assertInsideRoot in the loop", async () => {
        const projectPath = freshSampleProject();

        const result = await runOperation({
          godotPath: godotPath!,
          projectPath,
          operationScriptPath: resolveOperationsScriptPath(),
          operation: testCase.operation,
          params: testCase.params,
        });

        expect(result.kind).toBe("operation-error");
        const error = (result as { kind: "operation-error"; error: string }).error;
        expect(error.toLowerCase()).toContain(testCase.expectedErrorSubstring.toLowerCase());
      }, 30_000);
    });

    it(
      "does NOT reject a legitimate filename that merely contains a literal '..' substring " +
        "(regression test for the segment-aware fix - a naive scene_path.contains('..') check " +
        "used to false-positive here)",
      async () => {
        const projectPath = freshSampleProject();

        const result = await runOperation({
          godotPath: godotPath!,
          projectPath,
          operationScriptPath: resolveOperationsScriptPath(),
          operation: "create_scene",
          params: { scene_path: "v2..0.tscn" },
        });

        expect(result.kind).toBe("success");
      },
      30_000,
    );
  },
);
