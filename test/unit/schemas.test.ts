import { describe, expect, it } from "vitest";
import { projectPathSchema, relativePathSchema, scenePathSchema } from "../../src/schemas.js";

describe("projectPathSchema", () => {
  it("accepts a non-empty string", () => {
    expect(projectPathSchema.safeParse("C:\\projects\\my-game").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(projectPathSchema.safeParse("").success).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(projectPathSchema.safeParse(42).success).toBe(false);
  });

  it("carries an agent-facing description", () => {
    expect(projectPathSchema.description).toBeTruthy();
    expect(projectPathSchema.description).toContain("project.godot");
  });
});

describe("relativePathSchema", () => {
  it("accepts a relative path", () => {
    expect(relativePathSchema.safeParse("scenes/main.tscn").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(relativePathSchema.safeParse("").success).toBe(false);
  });

  it("carries an agent-facing description mentioning project_path", () => {
    expect(relativePathSchema.description).toBeTruthy();
    expect(relativePathSchema.description).toContain("project_path");
  });
});

describe("scenePathSchema", () => {
  it("accepts a relative .tscn path", () => {
    expect(scenePathSchema.safeParse("scenes/main.tscn").success).toBe(true);
  });

  it("rejects an empty string", () => {
    expect(scenePathSchema.safeParse("").success).toBe(false);
  });

  it("carries its own agent-facing description distinct from the generic fragment", () => {
    expect(scenePathSchema.description).toBeTruthy();
    expect(scenePathSchema.description).not.toBe(relativePathSchema.description);
    expect(scenePathSchema.description).toContain("scene");
  });

  it("does not mutate the shared relativePathSchema fragment", () => {
    expect(relativePathSchema.description).not.toContain("scene");
  });
});
