import { describe, expect, it, vi } from "vitest";
import type { Config } from "../../src/config.js";
import type { GodotPathResolution } from "../../src/godot/paths.js";
import {
  compareGodotVersions,
  createGodotVersionGate,
  parseGodotVersion,
  type GodotVersionProbeDeps,
} from "../../src/godot/version-gate.js";

function makeDeps(overrides: {
  resolution?: GodotPathResolution;
  execFile?: GodotVersionProbeDeps["execFile"];
}): GodotVersionProbeDeps {
  const resolution: GodotPathResolution = overrides.resolution ?? {
    found: true,
    path: "/opt/godot/godot",
    source: "configured",
  };
  return {
    loadConfig: (): Config => ({ godotPath: undefined, debug: false, outputBufferLines: 1000 }),
    detectGodotPath: vi.fn(() => resolution),
    execFile:
      overrides.execFile ??
      vi.fn(async () => ({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" })),
  };
}

describe("parseGodotVersion", () => {
  it("parses major.minor.patch from a full --version string", () => {
    expect(parseGodotVersion("4.6.3.stable.official.abcd1234")).toEqual({
      major: 4,
      minor: 6,
      patch: 3,
    });
  });

  it("defaults patch to 0 when omitted (Godot's own convention, e.g. 4.4.stable...)", () => {
    expect(parseGodotVersion("4.4.stable.official.xxxx")).toEqual({
      major: 4,
      minor: 4,
      patch: 0,
    });
  });

  it("parses a bare 'major.minor' literal like a minGodotVersion value", () => {
    expect(parseGodotVersion("4.4")).toEqual({ major: 4, minor: 4, patch: 0 });
  });

  it("returns null for a string that does not start with major.minor", () => {
    expect(parseGodotVersion("not a version")).toBeNull();
    expect(parseGodotVersion("")).toBeNull();
    expect(parseGodotVersion("v4.4")).toBeNull();
  });
});

describe("compareGodotVersions", () => {
  it("orders by major, then minor, then patch", () => {
    expect(
      compareGodotVersions({ major: 4, minor: 3, patch: 0 }, { major: 4, minor: 4, patch: 0 }),
    ).toBe(-1);
    expect(
      compareGodotVersions({ major: 4, minor: 4, patch: 0 }, { major: 4, minor: 3, patch: 0 }),
    ).toBe(1);
    expect(
      compareGodotVersions({ major: 4, minor: 4, patch: 0 }, { major: 4, minor: 4, patch: 0 }),
    ).toBe(0);
    expect(
      compareGodotVersions({ major: 4, minor: 6, patch: 3 }, { major: 4, minor: 6, patch: 0 }),
    ).toBe(1);
    expect(
      compareGodotVersions({ major: 3, minor: 9, patch: 9 }, { major: 4, minor: 0, patch: 0 }),
    ).toBe(-1);
  });
});

describe("createGodotVersionGate", () => {
  it("does not probe until the first checkMinVersion call (no startup probe)", () => {
    const deps = makeDeps({});
    createGodotVersionGate(deps);
    expect(deps.detectGodotPath).not.toHaveBeenCalled();
    expect(deps.execFile).not.toHaveBeenCalled();
  });

  it("passes when the resolved version satisfies minGodotVersion", async () => {
    const deps = makeDeps({
      execFile: vi.fn(async () => ({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" })),
    });
    const gate = createGodotVersionGate(deps);

    const result = await gate.checkMinVersion("4.4");

    expect(result).toEqual({ kind: "pass" });
  });

  it("passes when the resolved version exactly equals minGodotVersion", async () => {
    const deps = makeDeps({
      execFile: vi.fn(async () => ({ stdout: "4.4.stable.official.abcd1234\n", stderr: "" })),
    });
    const gate = createGodotVersionGate(deps);

    expect(await gate.checkMinVersion("4.4")).toEqual({ kind: "pass" });
  });

  it("blocks with a structured 'requires Godot >= X' error when the resolved version is older", async () => {
    const deps = makeDeps({
      execFile: vi.fn(async () => ({ stdout: "4.3.0.stable.official.abcd1234\n", stderr: "" })),
    });
    const gate = createGodotVersionGate(deps);

    const result = await gate.checkMinVersion("4.4");

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("expected blocked");
    expect(result.error.isError).toBe(true);
    expect(result.error.structuredContent.message).toContain("4.4");
    expect(result.error.structuredContent.message).toContain("4.3.0.stable.official.abcd1234");
    expect(result.error.structuredContent.possibleSolutions.length).toBeGreaterThan(0);
  });

  it("blocks with the standard godotNotFoundError when Godot cannot be resolved, without crashing", async () => {
    const deps = makeDeps({ resolution: { found: false, candidates: ["/usr/bin/godot"] } });
    const gate = createGodotVersionGate(deps);

    const result = await gate.checkMinVersion("4.4");

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("expected blocked");
    expect(result.error.structuredContent.possibleSolutions.join(" ")).toContain("GODOT_PATH");
    expect(deps.execFile).not.toHaveBeenCalled();
  });

  it("blocks with a structured error (not a throw) when the version probe itself fails to execute", async () => {
    const deps = makeDeps({
      execFile: vi.fn(async () => {
        throw new Error("ENOENT");
      }),
    });
    const gate = createGodotVersionGate(deps);

    const result = await gate.checkMinVersion("4.4");

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("expected blocked");
    expect(result.error.structuredContent.message).toContain("ENOENT");
  });

  it("blocks with a structured error when the resolved version string cannot be parsed", async () => {
    const deps = makeDeps({
      execFile: vi.fn(async () => ({ stdout: "garbled nonsense\n", stderr: "" })),
    });
    const gate = createGodotVersionGate(deps);

    const result = await gate.checkMinVersion("4.4");

    expect(result.kind).toBe("blocked");
    if (result.kind !== "blocked") throw new Error("expected blocked");
    expect(result.error.structuredContent.message).toContain("garbled nonsense");
  });

  it("caches a successful probe: N checkMinVersion calls (even with different minGodotVersion) issue exactly 1 probe", async () => {
    const deps = makeDeps({
      execFile: vi.fn(async () => ({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" })),
    });
    const gate = createGodotVersionGate(deps);

    await gate.checkMinVersion("4.4");
    await gate.checkMinVersion("4.4");
    await gate.checkMinVersion("4.0");

    expect(deps.execFile).toHaveBeenCalledTimes(1);
    expect(deps.detectGodotPath).toHaveBeenCalledTimes(1);
  });

  it("dedupes concurrent calls made before the first probe settles into a single probe", async () => {
    let resolveExec: (value: { stdout: string; stderr: string }) => void = () => {};
    const execFile = vi.fn(
      () =>
        new Promise<{ stdout: string; stderr: string }>((resolve) => {
          resolveExec = resolve;
        }),
    );
    const deps = makeDeps({ execFile });
    const gate = createGodotVersionGate(deps);

    const first = gate.checkMinVersion("4.4");
    const second = gate.checkMinVersion("4.4");

    resolveExec({ stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" });
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult).toEqual({ kind: "pass" });
    expect(secondResult).toEqual({ kind: "pass" });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it("does not cache a failed probe: a later call retries and can then succeed", async () => {
    let callCount = 0;
    const execFile = vi.fn(async () => {
      callCount += 1;
      if (callCount === 1) throw new Error("boom");
      return { stdout: "4.6.3.stable.official.abcd1234\n", stderr: "" };
    });
    const deps = makeDeps({ execFile });
    const gate = createGodotVersionGate(deps);

    const first = await gate.checkMinVersion("4.4");
    expect(first.kind).toBe("blocked");

    const second = await gate.checkMinVersion("4.4");
    expect(second).toEqual({ kind: "pass" });
    expect(execFile).toHaveBeenCalledTimes(2);
  });
});
