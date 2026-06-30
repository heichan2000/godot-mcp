import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  PathContainmentError,
  assertInsideRoot,
} from "../../src/godot/paths.js";

describe("assertInsideRoot", () => {
  // Use an absolute root resolved for the current platform so the test
  // passes on both POSIX and Windows.
  const root = resolve("/projects/game");

  it("accepts a simple project-relative path", () => {
    expect(assertInsideRoot(root, "scenes/main.tscn")).toBe(
      resolve(root, "scenes/main.tscn"),
    );
  });

  it("accepts the root itself", () => {
    expect(assertInsideRoot(root, ".")).toBe(root);
  });

  it("rejects ../ traversal escaping the root", () => {
    expect(() => assertInsideRoot(root, "../../etc/passwd")).toThrow(
      PathContainmentError,
    );
  });

  it("rejects an absolute path outside the root", () => {
    expect(() => assertInsideRoot(root, resolve("/etc/passwd"))).toThrow(
      PathContainmentError,
    );
  });

  // TODO(M2): symlink-escape rejection once realpath check lands.
});
