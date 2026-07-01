import { describe, expect, it } from "vitest";
import { createErrorResponse } from "../../src/errors.js";

describe("createErrorResponse", () => {
  it("marks the result as an error", () => {
    const result = createErrorResponse({ message: "Something went wrong" });

    expect(result.isError).toBe(true);
  });

  it("includes the message in the text content", () => {
    const result = createErrorResponse({ message: "Godot executable not found" });

    expect(result.content).toHaveLength(1);
    const [first] = result.content;
    expect(first).toMatchObject({ type: "text" });
    expect(first!.text).toContain("Godot executable not found");
  });

  it("lists possibleSolutions in the text content", () => {
    const result = createErrorResponse({
      message: "Godot executable not found",
      possibleSolutions: ["Set GODOT_PATH", "Install Godot to a standard location"],
    });

    const [first] = result.content;
    expect(first!.text).toContain("Set GODOT_PATH");
    expect(first!.text).toContain("Install Godot to a standard location");
  });

  it("carries message and possibleSolutions inside structuredContent, not as top-level fields", () => {
    const result = createErrorResponse({
      message: "Godot executable not found",
      possibleSolutions: ["Set GODOT_PATH"],
    });

    expect(result.structuredContent).toEqual({
      message: "Godot executable not found",
      possibleSolutions: ["Set GODOT_PATH"],
    });
    expect(Object.keys(result)).toEqual(
      expect.arrayContaining(["isError", "content", "structuredContent"]),
    );
    expect(Object.keys(result)).toHaveLength(3);
  });

  it("defaults possibleSolutions to an empty array when omitted", () => {
    const result = createErrorResponse({ message: "Godot executable not found" });

    expect(result.structuredContent.possibleSolutions).toEqual([]);
  });
});
