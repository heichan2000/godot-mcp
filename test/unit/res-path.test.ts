import { describe, expect, it } from "vitest";
import { containResPath } from "../../src/godot/paths.js";
import { PathContainmentError } from "../../src/godot/paths.js";

describe("containResPath", () => {
  it("accepts a res:// path and returns canonical + relative forms", () => {
    expect(containResPath("res://scenes/main.tscn")).toEqual({
      resPath: "res://scenes/main.tscn",
      relative: "scenes/main.tscn",
    });
  });

  it("accepts a bare project-relative path and canonicalizes it", () => {
    expect(containResPath("scenes/main.tscn")).toEqual({
      resPath: "res://scenes/main.tscn",
      relative: "scenes/main.tscn",
    });
  });

  it("normalizes redundant separators, backslashes, and '.' segments", () => {
    expect(containResPath("res://a\\\\b/./c.tscn")).toEqual({
      resPath: "res://a/b/c.tscn",
      relative: "a/b/c.tscn",
    });
  });

  it("collapses an interior '..' that stays inside the project", () => {
    expect(containResPath("res://a/b/../c.tscn")).toEqual({
      resPath: "res://a/c.tscn",
      relative: "a/c.tscn",
    });
  });

  it("rejects a '..' that escapes the project root", () => {
    expect(() => containResPath("res://../evil.tscn")).toThrow(PathContainmentError);
    expect(() => containResPath("../../etc/passwd")).toThrow(PathContainmentError);
  });

  it("rejects a filesystem-absolute path (posix and windows)", () => {
    expect(() => containResPath("/etc/passwd")).toThrow(PathContainmentError);
    expect(() => containResPath("C:\\\\Windows\\\\system32")).toThrow(PathContainmentError);
  });

  it("rejects a foreign scheme", () => {
    expect(() => containResPath("user://save.tscn")).toThrow(PathContainmentError);
    expect(() => containResPath("file:///etc/passwd")).toThrow(PathContainmentError);
  });

  it("rejects an empty or root-only path", () => {
    expect(() => containResPath("res://")).toThrow(PathContainmentError);
    expect(() => containResPath("   ")).toThrow(PathContainmentError);
  });
});
