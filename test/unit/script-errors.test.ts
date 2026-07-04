import { describe, expect, it } from "vitest";
import { extractSceneScriptPaths, parseCheckOnlyStderr } from "../../src/godot/script-errors.js";

/**
 * Real stderr samples captured locally by running
 * `godot --headless --path <project> --check-only --script res://scripts/<name>.gd`
 * against Godot v4.6.3.stable.official.7d41c59c4 (Windows) with deliberately
 * broken fixture scripts, per the task-10 brief's "capture real output
 * locally first" instruction. See task-10-report.md for the exact repro
 * steps and fixture contents.
 */
const REAL_STDERR_SINGLE_ERROR =
  'SCRIPT ERROR: Parse Error: Expected expression for variable initial value after "=".\n' +
  "   at: GDScript::reload (res://scripts/broken.gd:4)\n" +
  'ERROR: Failed to load script "res://scripts/broken.gd" with error "Parse error".\n' +
  "   at: load (modules/gdscript/gdscript.cpp:2907)\n";

const REAL_STDERR_UNDEFINED_FUNCTION =
  'SCRIPT ERROR: Parse Error: Function "undefined_function_call()" not found in base self.\n' +
  "   at: GDScript::reload (res://scripts/broken2.gd:4)\n" +
  'ERROR: Failed to load script "res://scripts/broken2.gd" with error "Parse error".\n' +
  "   at: load (modules/gdscript/gdscript.cpp:2907)\n";

const REAL_STDERR_TWO_ERRORS_SAME_FILE =
  'SCRIPT ERROR: Parse Error: Cannot assign a value of type "String" as "int".\n' +
  "   at: GDScript::reload (res://scripts/broken4.gd:3)\n" +
  'SCRIPT ERROR: Parse Error: Cannot assign a value of type String to variable "typed_number" with specified type int.\n' +
  "   at: GDScript::reload (res://scripts/broken4.gd:3)\n" +
  'ERROR: Failed to load script "res://scripts/broken4.gd" with error "Parse error".\n' +
  "   at: load (modules/gdscript/gdscript.cpp:2907)\n";

const REAL_STDERR_VALID_SCRIPT = "";

/** A nonexistent-script failure has a completely different shape (no "SCRIPT ERROR"/"GDScript::reload" lines at all) - captured for real too. */
const REAL_STDERR_NONEXISTENT_SCRIPT =
  "ERROR: Attempt to open script 'res://scripts/does_not_exist.gd' resulted in error 'File not found'.\n" +
  "   at: load_source_code (modules/gdscript/gdscript.cpp:1127)\n" +
  "ERROR: Failed loading resource: res://scripts/does_not_exist.gd.\n" +
  "   at: _load (core/io/resource_loader.cpp:343)\n" +
  "ERROR: Can't load script: res://scripts/does_not_exist.gd\n" +
  "   at: start (main/main.cpp:4271)\n";

describe("parseCheckOnlyStderr", () => {
  it("parses a single SCRIPT ERROR + GDScript::reload location pair into one structured entry", () => {
    const result = parseCheckOnlyStderr(REAL_STDERR_SINGLE_ERROR);

    expect(result).toEqual([
      {
        file: "res://scripts/broken.gd",
        line: 4,
        message: 'Parse Error: Expected expression for variable initial value after "=".',
      },
    ]);
  });

  it("parses an undefined-function-call parse error with its own message and line", () => {
    const result = parseCheckOnlyStderr(REAL_STDERR_UNDEFINED_FUNCTION);

    expect(result).toEqual([
      {
        file: "res://scripts/broken2.gd",
        line: 4,
        message: 'Parse Error: Function "undefined_function_call()" not found in base self.',
      },
    ]);
  });

  it("parses multiple SCRIPT ERROR blocks for the same file into separate entries (not deduped)", () => {
    const result = parseCheckOnlyStderr(REAL_STDERR_TWO_ERRORS_SAME_FILE);

    expect(result).toHaveLength(2);
    expect(result[0]).toEqual({
      file: "res://scripts/broken4.gd",
      line: 3,
      message: 'Parse Error: Cannot assign a value of type "String" as "int".',
    });
    expect(result[1]).toEqual({
      file: "res://scripts/broken4.gd",
      line: 3,
      message:
        'Parse Error: Cannot assign a value of type String to variable "typed_number" with specified type int.',
    });
  });

  it("returns an empty array for empty stderr (valid script)", () => {
    expect(parseCheckOnlyStderr(REAL_STDERR_VALID_SCRIPT)).toEqual([]);
  });

  it("is a best-effort miss (empty array, not a throw) when stderr doesn't match the SCRIPT ERROR/GDScript::reload shape - e.g. a nonexistent-script failure", () => {
    expect(() => parseCheckOnlyStderr(REAL_STDERR_NONEXISTENT_SCRIPT)).not.toThrow();
    expect(parseCheckOnlyStderr(REAL_STDERR_NONEXISTENT_SCRIPT)).toEqual([]);
  });

  it("is a best-effort miss (empty array) against an invented future stderr format, demonstrating format drift silently loses structure but never throws", () => {
    const hypotheticalFutureFormat =
      'SCRIPT_PARSE_FAILURE res://scripts/broken.gd line=4 msg="unexpected token"\n';
    expect(parseCheckOnlyStderr(hypotheticalFutureFormat)).toEqual([]);
  });

  it("does not match a bare SCRIPT ERROR line with no following GDScript::reload location line", () => {
    const stderr = "SCRIPT ERROR: Some error with no location line after it\n";
    expect(parseCheckOnlyStderr(stderr)).toEqual([]);
  });
});

describe("extractSceneScriptPaths", () => {
  it('extracts the res:// path of an ext_resource with type="Script"', () => {
    const sceneText =
      "[gd_scene load_steps=2 format=3]\n\n" +
      '[ext_resource type="Script" path="res://scripts/print_marker.gd" id="1"]\n\n' +
      '[node name="PrintMarker" type="Node"]\n' +
      'script = ExtResource("1")\n';

    expect(extractSceneScriptPaths(sceneText)).toEqual(["res://scripts/print_marker.gd"]);
  });

  it("returns an empty array for a scene with no ext_resource entries at all", () => {
    const sceneText =
      "[gd_scene load_steps=3 format=3]\n\n" +
      '[sub_resource type="BoxMesh" id="BoxMesh_box"]\n\n' +
      '[node name="Meshes" type="Node3D"]\n';

    expect(extractSceneScriptPaths(sceneText)).toEqual([]);
  });

  it("ignores ext_resource entries whose type is not Script (e.g. Texture2D)", () => {
    const sceneText =
      "[gd_scene load_steps=2 format=3]\n\n" +
      '[ext_resource type="Texture2D" path="res://textures/sprite.png" id="1"]\n';

    expect(extractSceneScriptPaths(sceneText)).toEqual([]);
  });

  it("extracts a Script ext_resource even when path appears before type in the attribute list", () => {
    const sceneText = '[ext_resource path="res://scripts/print_marker.gd" type="Script" id="1"]\n';

    expect(extractSceneScriptPaths(sceneText)).toEqual(["res://scripts/print_marker.gd"]);
  });

  it("extracts every Script ext_resource when a scene references more than one script", () => {
    const sceneText =
      '[ext_resource type="Script" path="res://scripts/a.gd" id="1"]\n' +
      '[ext_resource type="Texture2D" path="res://textures/sprite.png" id="2"]\n' +
      '[ext_resource type="Script" path="res://scripts/b.gd" id="3"]\n';

    expect(extractSceneScriptPaths(sceneText)).toEqual([
      "res://scripts/a.gd",
      "res://scripts/b.gd",
    ]);
  });
});
