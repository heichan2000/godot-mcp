import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createProjectTools } from "../../src/tools/project.js";
import { freshSampleProject, SAMPLE_PROJECT_DIR } from "./support.js";

// Both list_projects and get_project_info are pure filesystem operations -
// neither invokes Godot - so unlike the other test/integration/*.test.ts
// files, this suite never skips even when GODOT_PATH is unset.

function makeTools() {
  return createProjectTools();
}

function getTool(tools: ReturnType<typeof makeTools>, name: string) {
  const tool = tools.find((t) => t.name === name);
  if (!tool) throw new Error(`${name} descriptor not found`);
  return tool;
}

describe("get_project_info (integration, real filesystem, examples/sample-project)", () => {
  it("returns the sample project's name, Godot version, and file/asset counts", async () => {
    const projectPath = freshSampleProject();
    const tool = getTool(makeTools(), "get_project_info");

    const result = await tool.handler({ project_path: projectPath }, {} as never);

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as {
      project_path: string;
      name: string | null;
      godot_version: string | null;
      file_count: number;
      asset_count: number;
    };

    // Independent evidence: these values come straight from
    // examples/sample-project/project.godot's own text
    // (config/name="godot-mcp Sample Project", config/features contains
    // "4.3") rather than being re-derived through the tool under test.
    expect(structured.name).toBe("godot-mcp Sample Project");
    expect(structured.godot_version).toBe("4.3");
    // Fixture contains: project.godot, scenes/meshes.tscn,
    // scenes/print_marker.tscn, scripts/print_marker.gd,
    // scripts/print_marker.gd.uid, textures/sprite.png = 6 files, 1 asset
    // (sprite.png) - independently confirmed by find/ls when this test was
    // authored (see task report), not by trusting the tool's own count.
    expect(structured.file_count).toBe(6);
    expect(structured.asset_count).toBe(1);
  });

  it("returns a guided structured error for a directory with no project.godot", async () => {
    const emptyDir = mkdtempSync(path.join(tmpdir(), "godot-mcp-no-project-"));
    const tool = getTool(makeTools(), "get_project_info");

    const result = await tool.handler({ project_path: emptyDir }, {} as never);

    expect(result.isError).toBe(true);
    const text = (result.content[0] as { text: string }).text;
    expect(text).toContain("project.godot");
    const structured = result.structuredContent as { possibleSolutions: string[] };
    expect(structured.possibleSolutions.length).toBeGreaterThan(0);
  });
});

describe("list_projects (integration, real filesystem)", () => {
  it("finds the sample project directly inside the search directory", async () => {
    // Deliberately scoped to a fresh, otherwise-empty parent directory
    // rather than freshSampleProject()'s own location directly under
    // os.tmpdir() - that directory can accumulate many unrelated entries
    // across test runs and would risk tripping MAX_LIST_PROJECTS_RESULTS
    // before ever reaching this fixture, which is a real but separate
    // concern from what this test is checking.
    const parent = mkdtempSync(path.join(tmpdir(), "godot-mcp-list-projects-parent-"));
    const projectPath = path.join(parent, "sample-project");
    cpSync(SAMPLE_PROJECT_DIR, projectPath, { recursive: true });
    const tool = getTool(makeTools(), "list_projects");

    const result = await tool.handler({ directory: parent }, {} as never);

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { projects: string[]; truncated: boolean };
    expect(structured.projects).toEqual([projectPath]);
  });

  it("finds a project nested a few levels under the search directory, within the depth cap", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "godot-mcp-list-projects-"));
    const nestedProjectDir = path.join(root, "a", "b", "sample-project");
    mkdirSync(nestedProjectDir, { recursive: true });
    writeFileSync(
      path.join(nestedProjectDir, "project.godot"),
      'config/name="Nested Sample"\nconfig/features=PackedStringArray("4.3", "Forward Plus")\n',
    );

    const tool = getTool(makeTools(), "list_projects");
    const result = await tool.handler({ directory: root }, {} as never);

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { projects: string[]; truncated: boolean };
    expect(structured.projects).toEqual([nestedProjectDir]);
  });
});
