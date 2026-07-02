import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  countProjectFiles,
  DEFAULT_LIST_PROJECTS_MAX_DEPTH,
  HARD_MAX_LIST_PROJECTS_DEPTH,
  listProjectDirs,
  MAX_LIST_PROJECTS_RESULTS,
  MAX_PROJECT_FILE_COUNT,
  MAX_PROJECT_FILE_WALK_DEPTH,
  parseProjectGodot,
  readProjectInfo,
} from "../../src/godot/discovery.js";

function makeRoot(): string {
  return mkdtempSync(path.join(tmpdir(), "godot-mcp-discovery-"));
}

function writeProjectGodot(dir: string, contents = 'config/name="Demo"\n'): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "project.godot"), contents);
}

describe("listProjectDirs", () => {
  it("finds a project directly inside the search directory", () => {
    const root = makeRoot();
    writeProjectGodot(root);

    const result = listProjectDirs(root);

    expect(result.projects).toEqual([root]);
    expect(result.truncated).toBe(false);
  });

  it("finds nested projects within the default depth cap", () => {
    const root = makeRoot();
    const nested = path.join(root, "a", "b", "project-one");
    writeProjectGodot(nested);

    const result = listProjectDirs(root);

    expect(result.projects).toEqual([nested]);
  });

  it("finds multiple nested projects at different depths", () => {
    const root = makeRoot();
    const shallow = path.join(root, "shallow");
    const deep = path.join(root, "x", "y", "deep");
    writeProjectGodot(shallow);
    writeProjectGodot(deep);

    const result = listProjectDirs(root);

    expect(result.projects.sort()).toEqual([deep, shallow].sort());
  });

  it("does not descend past the default max depth (3)", () => {
    const root = makeRoot();
    // 4 levels deep - one past the default cap of 3.
    const tooDeep = path.join(root, "l1", "l2", "l3", "l4-project");
    writeProjectGodot(tooDeep);

    const result = listProjectDirs(root);

    expect(result.projects).toEqual([]);
  });

  it("honors an explicit max_depth within the hard cap", () => {
    const root = makeRoot();
    const level4 = path.join(root, "l1", "l2", "l3", "l4-project");
    writeProjectGodot(level4);

    const result = listProjectDirs(root, { maxDepth: 4 });

    expect(result.projects).toEqual([level4]);
  });

  it("clamps a requested max_depth above the hard max, rather than erroring", () => {
    const root = makeRoot();

    // Must not throw, even though this asks for a depth far beyond the hard cap.
    const result = listProjectDirs(root, { maxDepth: HARD_MAX_LIST_PROJECTS_DEPTH + 1000 });

    expect(result.projects).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it("does not walk deeper than the hard max even when max_depth is absurdly large", () => {
    const readdirSync = vi.fn((dir: string) => {
      // Every directory has exactly one subdirectory, "child" - an
      // effectively infinite/very deep tree if not bounded.
      if (dir.endsWith("child")) {
        return [{ name: "child", isDirectory: () => true, isFile: () => false }];
      }
      return [{ name: "child", isDirectory: () => true, isFile: () => false }];
    });

    listProjectDirs("/root", { maxDepth: 1_000_000 }, { readdirSync: readdirSync as never });

    // Called once per visited directory; bounded by HARD_MAX_LIST_PROJECTS_DEPTH + 1 (root + N levels).
    expect(readdirSync.mock.calls.length).toBeLessThanOrEqual(HARD_MAX_LIST_PROJECTS_DEPTH + 2);
  });

  it("does not recurse when recursive is false, even if nested projects exist", () => {
    const root = makeRoot();
    writeProjectGodot(path.join(root, "nested"));

    const result = listProjectDirs(root, { recursive: false });

    expect(result.projects).toEqual([]);
  });

  it("still finds a project directly in the search directory when recursive is false", () => {
    const root = makeRoot();
    writeProjectGodot(root);
    writeProjectGodot(path.join(root, "nested"));

    const result = listProjectDirs(root, { recursive: false });

    expect(result.projects).toEqual([root]);
  });

  it("skips hidden directories (dot-prefixed)", () => {
    const root = makeRoot();
    writeProjectGodot(path.join(root, ".hidden", "project"));

    const result = listProjectDirs(root);

    expect(result.projects).toEqual([]);
  });

  it("skips known system/dependency directories (.git, node_modules)", () => {
    const root = makeRoot();
    writeProjectGodot(path.join(root, ".git", "project"));
    writeProjectGodot(path.join(root, "node_modules", "some-pkg"));
    const legit = path.join(root, "real-project");
    writeProjectGodot(legit);

    const result = listProjectDirs(root);

    expect(result.projects).toEqual([legit]);
  });

  it("caps the number of results at MAX_LIST_PROJECTS_RESULTS and reports truncated", () => {
    const readdirSync = vi.fn((dir: string) => {
      if (dir === "/root") {
        return Array.from({ length: MAX_LIST_PROJECTS_RESULTS + 10 }, (_, i) => ({
          name: `p${i}`,
          isDirectory: () => true,
          isFile: () => false,
        }));
      }
      return [{ name: "project.godot", isDirectory: () => false, isFile: () => true }];
    });

    const result = listProjectDirs("/root", {}, { readdirSync: readdirSync as never });

    expect(result.projects.length).toBe(MAX_LIST_PROJECTS_RESULTS);
    expect(result.truncated).toBe(true);
  });

  it("does not abort the walk when a subdirectory throws EACCES/EPERM - it just skips that subtree", () => {
    const readdirSync = vi.fn((dir: string) => {
      if (dir === "/root") {
        return [
          { name: "locked", isDirectory: () => true, isFile: () => false },
          { name: "ok", isDirectory: () => true, isFile: () => false },
        ];
      }
      if (dir === path.join("/root", "locked")) {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        throw err;
      }
      if (dir === path.join("/root", "ok")) {
        return [{ name: "project.godot", isDirectory: () => false, isFile: () => true }];
      }
      return [];
    });

    const result = listProjectDirs("/root", {}, { readdirSync: readdirSync as never });

    expect(result.projects).toEqual([path.join("/root", "ok")]);
  });

  it("propagates an error reading the top-level search directory itself (not silently empty)", () => {
    const readdirSync = vi.fn(() => {
      const err = new Error("ENOENT: no such file or directory") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    expect(() =>
      listProjectDirs("/does/not/exist", {}, { readdirSync: readdirSync as never }),
    ).toThrow();
  });

  it("exposes the default and hard-max depth constants used above", () => {
    expect(DEFAULT_LIST_PROJECTS_MAX_DEPTH).toBe(3);
    expect(HARD_MAX_LIST_PROJECTS_DEPTH).toBeGreaterThan(DEFAULT_LIST_PROJECTS_MAX_DEPTH);
  });
});

describe("parseProjectGodot", () => {
  it("extracts the project name from config/name", () => {
    const info = parseProjectGodot('config_version=5\n\n[application]\n\nconfig/name="My Game"\n');
    expect(info.name).toBe("My Game");
  });

  it("extracts the Godot version tag from config/features", () => {
    const info = parseProjectGodot(
      'config/name="My Game"\nconfig/features=PackedStringArray("4.3", "Forward Plus")\n',
    );
    expect(info.godotVersion).toBe("4.3");
  });

  it("extracts config_version as a number", () => {
    const info = parseProjectGodot("config_version=5\n");
    expect(info.configVersion).toBe(5);
  });

  it("returns undefined fields when the relevant lines are absent", () => {
    const info = parseProjectGodot("; just a comment\n");
    expect(info.name).toBeUndefined();
    expect(info.godotVersion).toBeUndefined();
    expect(info.configVersion).toBeUndefined();
  });
});

describe("countProjectFiles", () => {
  it("counts total files and recognized asset files under the project", () => {
    const root = makeRoot();
    writeProjectGodot(root);
    mkdirSync(path.join(root, "scenes"));
    writeFileSync(path.join(root, "scenes", "main.tscn"), "");
    mkdirSync(path.join(root, "scripts"));
    writeFileSync(path.join(root, "scripts", "player.gd"), "");
    mkdirSync(path.join(root, "textures"));
    writeFileSync(path.join(root, "textures", "sprite.png"), "");

    const counts = countProjectFiles(root);

    // project.godot + main.tscn + player.gd + sprite.png = 4 files.
    expect(counts.fileCount).toBe(4);
    // Only sprite.png is a recognized asset extension.
    expect(counts.assetCount).toBe(1);
    expect(counts.truncated).toBe(false);
  });

  it("does not walk deeper than MAX_PROJECT_FILE_WALK_DEPTH on an effectively infinite tree", () => {
    // Every directory contains one file and one subdirectory - unbounded
    // depth if the walk itself is not capped.
    const readdirSync = vi.fn(() => [
      { name: "file.txt", isDirectory: () => false, isFile: () => true },
      { name: "child", isDirectory: () => true, isFile: () => false },
    ]);

    const counts = countProjectFiles("/root", { readdirSync: readdirSync as never });

    // Called once per visited directory: the root plus at most
    // MAX_PROJECT_FILE_WALK_DEPTH levels below it.
    expect(readdirSync.mock.calls.length).toBeLessThanOrEqual(MAX_PROJECT_FILE_WALK_DEPTH + 1);
    expect(counts.truncated).toBe(true);
  });

  it("caps fileCount at MAX_PROJECT_FILE_COUNT and reports truncated", () => {
    const readdirSync = vi.fn((dir: string) => {
      if (dir === "/root") {
        return Array.from({ length: MAX_PROJECT_FILE_COUNT + 10 }, (_, i) => ({
          name: `f${i}.png`,
          isDirectory: () => false,
          isFile: () => true,
        }));
      }
      return [];
    });

    const counts = countProjectFiles("/root", { readdirSync: readdirSync as never });

    expect(counts.fileCount).toBe(MAX_PROJECT_FILE_COUNT);
    expect(counts.assetCount).toBeLessThanOrEqual(MAX_PROJECT_FILE_COUNT);
    expect(counts.truncated).toBe(true);
  });

  it("stops reading further sibling directories once the file-count ceiling is hit", () => {
    const perDir = Math.ceil(MAX_PROJECT_FILE_COUNT / 2) + 1;
    const dirsRead: string[] = [];
    const readdirSync = vi.fn((dir: string) => {
      dirsRead.push(dir);
      if (dir === "/root") {
        return [
          { name: "a", isDirectory: () => true, isFile: () => false },
          { name: "b", isDirectory: () => true, isFile: () => false },
          { name: "c", isDirectory: () => true, isFile: () => false },
        ];
      }
      return Array.from({ length: perDir }, (_, i) => ({
        name: `f${i}.txt`,
        isDirectory: () => false,
        isFile: () => true,
      }));
    });

    const counts = countProjectFiles("/root", { readdirSync: readdirSync as never });

    expect(counts.fileCount).toBe(MAX_PROJECT_FILE_COUNT);
    expect(counts.truncated).toBe(true);
    // a and b together already exceed the ceiling, so c must never be read.
    expect(dirsRead).not.toContain(path.join("/root", "c"));
  });

  it("excludes the .godot cache directory from counts", () => {
    const root = makeRoot();
    writeProjectGodot(root);
    mkdirSync(path.join(root, ".godot", "imported"), { recursive: true });
    writeFileSync(path.join(root, ".godot", "imported", "sprite.png-abc.ctex"), "");

    const counts = countProjectFiles(root);

    expect(counts.fileCount).toBe(1);
  });
});

describe("readProjectInfo", () => {
  it("returns null when project.godot does not exist at project_path", () => {
    const root = makeRoot();
    expect(readProjectInfo(root)).toBeNull();
  });

  it("returns combined name/version/counts when project.godot exists", () => {
    const root = makeRoot();
    writeProjectGodot(
      root,
      'config_version=5\n\n[application]\n\nconfig/name="Demo"\nconfig/features=PackedStringArray("4.3", "Forward Plus")\n',
    );
    writeFileSync(path.join(root, "sprite.png"), "");

    const info = readProjectInfo(root);

    expect(info).not.toBeNull();
    expect(info?.name).toBe("Demo");
    expect(info?.godotVersion).toBe("4.3");
    expect(info?.fileCount).toBe(2);
    expect(info?.assetCount).toBe(1);
    expect(info?.truncated).toBe(false);
  });
});
