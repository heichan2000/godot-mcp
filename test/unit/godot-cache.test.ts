import { describe, expect, it, vi } from "vitest";
import { hasGodotCacheDir, hasImportCache } from "../../src/godot/cache.js";

describe("hasImportCache", () => {
  it("returns false when .godot/imported does not exist", () => {
    const existsSync = vi.fn(() => false);
    const readdirSync = vi.fn(() => []);

    expect(hasImportCache("/projects/demo", { existsSync, readdirSync })).toBe(false);
    expect(existsSync).toHaveBeenCalledWith(expect.stringMatching(/\.godot[\\/]imported$/));
    expect(readdirSync).not.toHaveBeenCalled();
  });

  it("returns false when .godot/imported exists but is empty", () => {
    const existsSync = vi.fn(() => true);
    const readdirSync = vi.fn(() => []);

    expect(hasImportCache("/projects/demo", { existsSync, readdirSync })).toBe(false);
  });

  it("returns true when .godot/imported exists and contains at least one entry", () => {
    const existsSync = vi.fn(() => true);
    const readdirSync = vi.fn(() => ["icon.png-abc123.ctex"]);

    expect(hasImportCache("/projects/demo", { existsSync, readdirSync })).toBe(true);
  });

  it("returns false (rather than throwing) when readdirSync throws after existsSync reports true", () => {
    const existsSync = vi.fn(() => true);
    const readdirSync = vi.fn(() => {
      throw new Error("EACCES");
    });

    expect(hasImportCache("/projects/demo", { existsSync, readdirSync })).toBe(false);
  });

  it("defaults to the real filesystem when no options are given", () => {
    // No real project at this path, so this must resolve to false without throwing.
    expect(hasImportCache("/definitely/does/not/exist/anywhere")).toBe(false);
  });
});

describe("hasGodotCacheDir", () => {
  it("returns false when .godot does not exist", () => {
    const existsSync = vi.fn(() => false);
    expect(hasGodotCacheDir("/projects/demo", { existsSync })).toBe(false);
    expect(existsSync).toHaveBeenCalledWith(expect.stringMatching(/\.godot$/));
  });

  it("returns true when .godot exists, regardless of whether imported/ has entries", () => {
    const existsSync = vi.fn(() => true);
    expect(hasGodotCacheDir("/projects/demo", { existsSync })).toBe(true);
  });

  it("defaults to the real filesystem when no options are given", () => {
    expect(hasGodotCacheDir("/definitely/does/not/exist/anywhere")).toBe(false);
  });
});
