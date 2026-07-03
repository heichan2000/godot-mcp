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

/**
 * Creates a fresh temp root and immediately canonicalizes it through the
 * same realpath variant `assertInsideRoot` uses by default
 * (`fs.realpathSync.native`). On some Windows CI runners `os.tmpdir()`
 * returns an 8.3 short-form path (e.g. `C:\Users\RUNNER~1\...`); only the
 * native realpath fully expands that to its long form
 * (`C:\Users\runneradmin\...`). Canonicalizing here - once - means every
 * expected value derived from `root` below is already in the same form
 * `assertInsideRoot` returns, instead of each test re-deriving it (and
 * risking a non-native `realpathSync` call that doesn't expand 8.3 names
 * the same way).
 */
function makeRoot(prefix = "godot-mcp-root-"): string {
  return realpathSync.native(mkdtempSync(path.join(tmpdir(), prefix)));
}

/** Directory symlink that does not require elevated privileges on Windows. */
function linkDir(target: string, linkPath: string): void {
  symlinkSync(target, linkPath, isWin32 ? "junction" : "dir");
}

/**
 * Emits a loud, greppable warning when a mandated coverage case is skipped
 * because its filesystem prerequisite isn't available on this machine.
 * Silent skips let real coverage regressions (e.g. hardened images with 8.3
 * short-name generation or admin shares disabled) go unnoticed - anyone
 * grepping test output for "[coverage] SKIPPED" will see exactly what
 * mandated case went unexercised and why.
 */
function warnSkippedCoverage(caseName: string, reason: string): void {
  console.warn(`[coverage] SKIPPED mandated case "${caseName}": ${reason}`);
}

/**
 * Converts a local absolute path like `C:\foo\bar` to its UNC spelling via
 * the loopback administrative share, e.g. `\\localhost\C$\foo\bar`. This
 * lets tests exercise a *real* UNC path - resolved by the real
 * `fs.realpathSync.native` - without depending on an actual network share.
 */
function toUncPath(localAbsolutePath: string): string {
  const drive = localAbsolutePath[0]!;
  const rest = localAbsolutePath.slice(2);
  return `\\\\localhost\\${drive}$${rest}`;
}

describe("assertInsideRoot", () => {
  it("accepts a relative path to an existing file inside the root", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "scene.tscn"), "");

    const result = assertInsideRoot(root, "scene.tscn");

    expect(result).toBe(path.join(root, "scene.tscn"));
  });

  it("accepts a relative path whose target does not exist yet, nested under existing dirs", () => {
    const root = makeRoot();

    const result = assertInsideRoot(root, path.join("scenes", "new_scene.tscn"));

    expect(result).toBe(path.join(root, "scenes", "new_scene.tscn"));
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

  it("rejects godot-prd.md §11's exact security-smoke example (../../etc/passwd) as a scene_path", () => {
    const root = makeRoot();

    expect(() => assertInsideRoot(root, "../../etc/passwd")).toThrow(PathContainmentError);
  });

  it("does not reject a filename that merely starts with .. (no traversal)", () => {
    const root = makeRoot();
    writeFileSync(path.join(root, "..hidden-ish"), "");

    const result = assertInsideRoot(root, "..hidden-ish");

    expect(result).toBe(path.join(root, "..hidden-ish"));
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

      // Expected value is built from the canonicalized root (via makeRoot)
      // plus the real target dir the "scenes" symlink resolves to.
      expect(result).toBe(path.join(root, "real-scenes", "main.tscn"));
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

    if (isWin32 && !has8dot3Fixture) {
      warnSkippedCoverage(
        "resolves an 8.3 short-name root identically to its long form",
        `"${programFilesShort}" / "${path.join(programFilesLong, "Common Files")}" not found - ` +
          "8.3 short-name generation is likely disabled on this machine.",
      );
    }

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

    it.skipIf(!isWin32)("accepts a relative path inside a UNC root (arithmetic only)", () => {
      // This does NOT exercise the real default realpathSync - it injects an
      // identity function to document the relative/absolute path arithmetic
      // in isolation, independent of any real UNC resolution. The real
      // default-realpathSync UNC coverage lives in the
      // "UNC real filesystem containment" describe block below.
      const identity = (candidate: string) => candidate;

      const result = assertInsideRoot("\\\\server\\share\\project", "scenes\\main.tscn", {
        realpathSync: identity,
      });

      expect(result).toBe("\\\\server\\share\\project\\scenes\\main.tscn");
    });

    it.skipIf(!isWin32)(
      "rejects a UNC root escape via traversal to a sibling share dir (arithmetic only)",
      () => {
        // See note above: identity-injected, arithmetic-only coverage.
        const identity = (candidate: string) => candidate;

        expect(() =>
          assertInsideRoot("\\\\server\\share\\project", "..\\..\\share2\\secrets", {
            realpathSync: identity,
          }),
        ).toThrow(PathContainmentError);
      },
    );
  });

  describe("UNC real filesystem containment (loopback admin share)", () => {
    // Uses the Windows loopback administrative share (`\\localhost\C$\...`)
    // to build a UNC spelling of a real temp directory. Unlike the
    // identity-injected "arithmetic only" cases above, these tests pass NO
    // `realpathSync` option, so `assertInsideRoot` uses its real default
    // (`fs.realpathSync.native`) against an actual UNC path - no network
    // share required, since `localhost` loops back to this machine.
    const hasUncFixture = (() => {
      if (!isWin32) return false;
      try {
        realpathSync.native(toUncPath(tmpdir()));
        return true;
      } catch {
        return false;
      }
    })();

    if (isWin32 && !hasUncFixture) {
      warnSkippedCoverage(
        "UNC root containment resolved by the real default realpathSync",
        `fs.realpathSync.native could not resolve the loopback admin share ` +
          `(${toUncPath(tmpdir())}) - it may be disabled or locked down on this machine.`,
      );
    }

    it.skipIf(!hasUncFixture)(
      "accepts a relative path inside a real UNC root, via the real default realpathSync",
      () => {
        const parent = makeRoot("godot-mcp-unc-parent-");
        const root = path.join(parent, "project");
        mkdirSync(root);
        mkdirSync(path.join(root, "scenes"));
        writeFileSync(path.join(root, "scenes", "main.tscn"), "");
        const uncRoot = toUncPath(root);

        // No injected realpathSync here: this is the real default seam.
        const result = assertInsideRoot(uncRoot, path.join("scenes", "main.tscn"));

        expect(result).toBe(path.join(realpathSync.native(uncRoot), "scenes", "main.tscn"));
      },
    );

    it.skipIf(!hasUncFixture)(
      "rejects a real UNC root escape via traversal, via the real default realpathSync",
      () => {
        const parent = makeRoot("godot-mcp-unc-parent-");
        const root = path.join(parent, "project");
        mkdirSync(root);
        const outside = path.join(parent, "outside");
        mkdirSync(outside);
        writeFileSync(path.join(outside, "secret.txt"), "top secret");
        const uncRoot = toUncPath(root);

        // No injected realpathSync here: this is the real default seam.
        expect(() => assertInsideRoot(uncRoot, path.join("..", "outside", "secret.txt"))).toThrow(
          PathContainmentError,
        );
      },
    );
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

  it("tailors possibleSolutions to a root-not-found violation", () => {
    const missingRoot = path.join(tmpdir(), `godot-mcp-missing-root-${Date.now()}`);
    let caught: unknown;
    try {
      assertInsideRoot(missingRoot, "scene.tscn");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(PathContainmentError);

    const response = pathContainmentErrorResponse(caught as PathContainmentError);

    expect(response.structuredContent.possibleSolutions).toEqual([
      "Confirm project_path points at an existing, accessible directory.",
    ]);
  });
});

describe("resolveDeepestExisting's unexpected-error paths (via assertInsideRoot's injectable realpathSync)", () => {
  it("rethrows a non-ENOENT/ENOTDIR error raw, without wrapping it as a PathContainmentError", () => {
    const root = makeRoot();
    const eaccesError = Object.assign(new Error("permission denied"), { code: "EACCES" });
    const realpathSync = (candidate: string) => {
      if (candidate === path.resolve(root)) return root;
      throw eaccesError;
    };

    expect(() => assertInsideRoot(root, "scene.tscn", { realpathSync })).toThrow(eaccesError);
  });

  it(
    "rethrows the underlying ENOENT once the walk-up reaches the filesystem/drive root without " +
      "resolving anything, without wrapping it as a PathContainmentError",
    () => {
      const root = makeRoot();
      let rootCallCount = 0;
      const enoentError = Object.assign(new Error("no such file"), { code: "ENOENT" });
      // Succeeds exactly once for the initial root-resolution call (so
      // assertInsideRoot gets past its own root check), then fails
      // unconditionally afterward - forcing resolveDeepestExisting's
      // walk-up to retry every ancestor, all the way to the real
      // filesystem/drive root, without ever resolving.
      const realpathSync = (candidate: string) => {
        if (candidate === path.resolve(root) && rootCallCount === 0) {
          rootCallCount += 1;
          return root;
        }
        throw enoentError;
      };

      expect(() => assertInsideRoot(root, "scene.tscn", { realpathSync })).toThrow(enoentError);
    },
  );
});
