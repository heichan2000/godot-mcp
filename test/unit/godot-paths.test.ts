import { describe, expect, it } from "vitest";
import { detectGodotPath, getCandidatePaths, godotNotFoundError } from "../../src/godot/paths.js";

describe("getCandidatePaths", () => {
  it("returns a non-empty, de-duplicated list of platform-specific candidates for win32", () => {
    const candidates = getCandidatePaths("win32");

    expect(candidates.length).toBeGreaterThan(0);
    expect(new Set(candidates).size).toBe(candidates.length);
  });

  it("returns a non-empty list for darwin", () => {
    const candidates = getCandidatePaths("darwin");

    expect(candidates.length).toBeGreaterThan(0);
  });

  it("returns a non-empty list for linux", () => {
    const candidates = getCandidatePaths("linux");

    expect(candidates.length).toBeGreaterThan(0);
  });

  it("returns different candidate sets per platform", () => {
    const win = getCandidatePaths("win32");
    const linux = getCandidatePaths("linux");

    expect(win).not.toEqual(linux);
  });
});

describe("detectGodotPath", () => {
  it("returns the configured path when it exists on disk", () => {
    const result = detectGodotPath({
      configuredPath: "C:\\Games\\Godot\\Godot.exe",
      platform: "win32",
      fileExists: (path) => path === "C:\\Games\\Godot\\Godot.exe",
    });

    expect(result).toEqual({
      found: true,
      path: "C:\\Games\\Godot\\Godot.exe",
      source: "configured",
    });
  });

  it("never falls back to autodetect when the configured path does not exist", () => {
    const result = detectGodotPath({
      configuredPath: "C:\\Games\\Godot\\Godot.exe",
      platform: "win32",
      // Would find plenty of candidates via autodetect if it were consulted.
      fileExists: (path) => path !== "C:\\Games\\Godot\\Godot.exe",
    });

    expect(result).toEqual({
      found: false,
      candidates: ["C:\\Games\\Godot\\Godot.exe"],
    });
  });

  it("autodetects the first existing candidate when no path is configured", () => {
    const candidates = getCandidatePaths("linux");
    const target = candidates[1];

    const result = detectGodotPath({
      platform: "linux",
      fileExists: (path) => path === target,
    });

    expect(result).toEqual({ found: true, path: target, source: "autodetect" });
  });

  it("returns all tried candidates when nothing is configured and none exist", () => {
    const result = detectGodotPath({
      platform: "darwin",
      fileExists: () => false,
    });

    expect(result.found).toBe(false);
    if (!result.found) {
      expect(result.candidates).toEqual(getCandidatePaths("darwin"));
      expect(result.candidates.length).toBeGreaterThan(0);
    }
  });

  it("uses real fs checks by default and reports not-found for a bogus configured path", () => {
    const result = detectGodotPath({
      configuredPath: "C:\\definitely\\not\\a\\real\\godot\\path\\Godot.exe",
    });

    expect(result.found).toBe(false);
  });
});

describe("godotNotFoundError", () => {
  it("produces a guided error result listing every tried candidate", () => {
    const response = godotNotFoundError(["C:\\a\\Godot.exe", "C:\\b\\Godot.exe"]);

    expect(response.isError).toBe(true);
    const text = response.content.map((item) => item.text).join("\n");
    expect(text).toContain("Could not locate a Godot executable.");
    expect(text).toContain("C:\\a\\Godot.exe, C:\\b\\Godot.exe");
    expect(text).toContain("GODOT_PATH");
  });
});
