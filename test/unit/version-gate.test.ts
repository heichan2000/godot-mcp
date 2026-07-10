import { describe, expect, it } from "vitest";
import type { GodotVersion } from "../../src/bridge/protocol.js";
import { meetsMinVersion, parseMinGodotVersion, versionGateError } from "../../src/version-gate.js";

const engine = (major: number, minor: number, patch = 0): GodotVersion => ({
  major,
  minor,
  patch,
  status: "stable",
});

describe("parseMinGodotVersion", () => {
  it('parses "4.4" into { major: 4, minor: 4 }', () => {
    expect(parseMinGodotVersion("4.4")).toEqual({ major: 4, minor: 4 });
  });

  it("tolerates surrounding whitespace", () => {
    expect(parseMinGodotVersion(" 4.7 ")).toEqual({ major: 4, minor: 7 });
  });

  it.each(["4", "4.4.1", "v4.4", "4.x", "", "four.four"])(
    "throws on malformed literal %j (descriptors are static - fail fast)",
    (spec) => {
      expect(() => parseMinGodotVersion(spec)).toThrow(/Invalid minGodotVersion/);
    },
  );
});

describe("meetsMinVersion", () => {
  const min = parseMinGodotVersion("4.4");

  it("passes an equal minor", () => {
    expect(meetsMinVersion(min, engine(4, 4))).toBe(true);
  });

  it("passes a newer minor and a newer major", () => {
    expect(meetsMinVersion(min, engine(4, 7))).toBe(true);
    expect(meetsMinVersion(min, engine(5, 0))).toBe(true);
  });

  it("rejects an older minor and an older major", () => {
    expect(meetsMinVersion(min, engine(4, 3))).toBe(false);
    expect(meetsMinVersion(min, engine(3, 6))).toBe(false);
  });

  it("ignores patch: 4.4.9 does not satisfy a 4.5 floor", () => {
    expect(meetsMinVersion(parseMinGodotVersion("4.5"), engine(4, 4, 9))).toBe(false);
  });
});

describe("versionGateError", () => {
  it('returns the structured "requires >= x.y" error naming tool, floor, and reported engine', () => {
    const error = versionGateError("get_uid", "4.4", engine(4, 3, 2));
    expect(error.isError).toBe(true);
    expect(error.structuredContent.message).toContain("get_uid requires Godot >= 4.4");
    expect(error.structuredContent.message).toContain("4.3.2.stable");
    expect(error.structuredContent.possibleSolutions.length).toBeGreaterThan(0);
    expect(error.content[0]!.text).toContain("requires Godot >= 4.4");
  });
});
