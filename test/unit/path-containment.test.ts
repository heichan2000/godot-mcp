import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertInsideRoot,
  PathContainmentError,
  pathContainmentErrorResponse,
} from "../../src/godot/paths.js";

const isWin32 = process.platform === "win32";

function makeRoot(prefix = "godot-mcp-root-"): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

/** Directory symlink that does not require elevated privileges on Windows. */
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, isWin32 ? "junction" : "dir");
}

describe("assertInsideRoot", () => {
  it("accepts a relative path to an existing file inside the root", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "scene.tscn"), "");

    const result = assertInsideRoot(root, "scene.tscn");

    expect(result).toBe(path.join(realpathSync(root), "scene.tscn"));
  });

  it("accepts a relative path whose target does not exist yet, nested under existing dirs", () => {
    const root = makeRoot();

    const result = assertInsideRoot(root, path.join("scenes", "new_scene.tscn"));

    expect(result).toBe(path.join(realpathSync(root), "scenes", "new_scene.tscn"));
  });

  it("rejects the root itself (empty relative path)", () => {
    const root = makeRoot();

    expect(() => assertInsideRoot(root, ".")).toThrow(PathContainmentError);
    expect(() => assertInsideRoot(root, "")).toThrow(PathContainmentError);
  });

  it("rejects an absolute candidate path", () => {
    const root = makeRoot();
    const absoluteElsewhere = path.join(tmpdir(), "some-other-file.txt");

    expect(() => assertInsideRoot(root, absoluteElsewhere)).toThrow(PathContainmentError);
    try {
      assertInsideRoot(root, absoluteElsewhere);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PathContainmentError);
      expect((error as PathContainmentError).reason).toBe("absolute");
    }
  });

  it("rejects a relative path that escapes the root via ..", () => {
    const root = makeRoot();

    expect(() => assertInsideRoot(root, path.join("..", "escape.txt"))).toThrow(
      PathContainmentError,
    );
  });

  it("rejects a relative path that escapes the root via a nested ../..", () => {
    const root = makeRoot();

    expect(() => assertInsideRoot(root, path.join("scenes", "..", "..", "escape.txt"))).toThrow(
      PathContainmentError,
    );
  });

  it("does not reject a filename that merely starts with .. (no traversal)", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "..hidden-ish"), "");

    const result = assertInsideRoot(root, "..hidden-ish");

    expect(result).toBe(path.join(realpathSync(root), "..hidden-ish"));
  });

  it("throws a root-not-found PathContainmentError when the root does not exist", () => {
    const missingRoot = path.join(tmpdir(), `godot-mcp-missing-root-${Date.now()}`);

    try {
      assertInsideRoot(missingRoot, "scene.tscn");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(PathContainmentError);
      expect((error as PathContainmentError).reason).toBe("root-not-found");
    }
  });

  it("never uses a naive startsWith check: a sibling dir sharing the root's name prefix is rejected", () => {
    const parent = makeRoot("godot-mcp-parent-");
    const root = path.join(parent, "project");
    mkdirSync(root);
    const sibling = path.join(parent, "project-evil-twin");
    mkdirSync(sibling);
    writeFileSync(path.join(sibling, "secret.txt"), "");

    // A naive `resolvedCandidate.startsWith(resolvedRoot)` check would wrongly
    // accept this, since "project-evil-twin" starts with "project".
    const absoluteSibling = path.join(sibling, "secret.txt");
    expect(() => assertInsideRoot(root, absoluteSibling)).toThrow(PathContainmentError);
  });

  describe("symlink escapes", () => {
    it("rejects a candidate that resolves outside the root through a symlinked dir", () => {
      const root = makeRoot();
      const outside = makeRoot("godot-mcp-outside-");
      writeFileSync(path.join(outside, "secret.txt"), "top secret");
      linkDir(outside, path.join(root, "linked"));

      expect(() => assertInsideRoot(root, path.join("linked", "secret.txt"))).toThrow(
        PathContainmentError,
      );
    });

    it("accepts a symlinked dir that resolves inside the root", () => {
      const root = makeRoot();
      mkdirSync(path.join(root, "real-scenes"));
      linkDir(path.join(root, "real-scenes"), path.join(root, "scenes"));

      const result = assertInsideRoot(root, path.join("scenes", "main.tscn"));

      expect(result).toBe(path.join(realpathSync(root), "real-scenes", "main.tscn"));
    });
  });

  describe("Windows-specific cases", () => {
    it.skipIf(!isWin32)("treats differently-cased drive letters in the root as equivalent", () => {
      const root = makeRoot();
      writeFileSync(path.join(root, "scene.tscn"), "");
      const upperRoot = root[0]!.toUpperCase() + root.slice(1);
      const lowerRoot = root[0]!.toLowerCase() + root.slice(1);

      const viaUpper = assertInsideRoot(upperRoot, "scene.tscn");
      const viaLower = assertInsideRoot(lowerRoot, "scene.tscn");

      expect(viaUpper).toBe(viaLower);
    });

    it.skipIf(!isWin32)("treats backslash and forward-slash separators equivalently", () => {
      const root = makeRoot();
      mkdirSync(path.join(root, "scenes"));
      writeFileSync(path.join(root, "scenes", "main.tscn"), "");

      const viaBackslash = assertInsideRoot(root, "scenes\\main.tscn");
      const viaForwardSlash = assertInsideRoot(root, "scenes/main.tscn");

      expect(viaBackslash).toBe(viaForwardSlash);
    });

    const programFilesShort = "C:\\PROGRA~1";
    const programFilesLong = "C:\\Program Files";
    const has8dot3Fixture =
      isWin32 &&
      existsSync(programFilesShort) &&
      existsSync(programFilesLong) &&
      existsSync(path.join(programFilesLong, "Common Files"));

    it.skipIf(!has8dot3Fixture)(
      "resolves an 8.3 short-name root identically to its long form",
      () => {
        const viaShort = assertInsideRoot(programFilesShort, "Common Files");
        const viaLong = assertInsideRoot(programFilesLong, "Common Files");

        expect(viaShort).toBe(viaLong);
      },
    );

    it.skipIf(!isWin32)("rejects an absolute UNC candidate path", () => {
      expect(() =>
        assertInsideRoot("\\\\server\\share\\project", "\\\\server\\share\\other"),
      ).toThrow(PathContainmentError);
    });

    it.skipIf(!isWin32)("accepts a relative path inside a UNC root", () => {
      // Real network shares are unreliable in CI/sandboxed environments, so this
      // uses the injected realpathSync seam to simulate an already-resolved UNC
      // namespace while still exercising the real relative/absolute logic.
      const identity = (candidate: string) => candidate;

      const result = assertInsideRoot("\\\\server\\share\\project", "scenes\\main.tscn", {
        realpathSync: identity,
      });

      expect(result).toBe("\\\\server\\share\\project\\scenes\\main.tscn");
    });

    it.skipIf(!isWin32)("rejects a UNC root escape via traversal to a sibling share dir", () => {
      const identity = (candidate: string) => candidate;

      expect(() =>
        assertInsideRoot("\\\\server\\share\\project", "..\\..\\share2\\secrets", {
          realpathSync: identity,
        }),
      ).toThrow(PathContainmentError);
    });
  });
});

describe("pathContainmentErrorResponse", () => {
  it("converts a PathContainmentError into the standard guided error result", () => {
    const root = makeRoot();
    let caught: unknown;
    try {
      assertInsideRoot(root, path.join("..", "escape.txt"));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PathContainmentError);

    const response = pathContainmentErrorResponse(caught as PathContainmentError);

    expect(response.isError).toBe(true);
    expect(response.content).toHaveLength(1);
    expect(response.content[0]!.text.length).toBeGreaterThan(0);
    expect(response.structuredContent.possibleSolutions.length).toBeGreaterThan(0);
  });

  it("tailors possibleSolutions to an absolute-path violation", () => {
    const root = makeRoot();
    let caught: unknown;
    try {
      assertInsideRoot(root, path.join(tmpdir(), "elsewhere.txt"));
    } catch (error) {
      caught = error;
    }

    const response = pathContainmentErrorResponse(caught as PathContainmentError);

    expect(response.structuredContent.message).toContain("absolute");
  });
});
