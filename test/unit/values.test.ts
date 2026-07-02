import { describe, expect, it } from "vitest";
import { propertiesSchema, propertyValueSchema } from "../../src/godot/values.js";

/**
 * Round-trips a value exactly the way it travels over this server's JSON
 * wire format: `runOperation` does `JSON.stringify(params)`, Godot's
 * `JSON.parse_string` decodes it on the other end. This helper mimics only
 * the TS-side half (stringify/parse), since that is the leg under test.
 */
function roundTripJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

describe("value codec (TS side)", () => {
  describe.each([
    ["Vector2", "Vector2(100, 50)"],
    ["Color", "Color(1, 0, 0, 1)"],
    ["NodePath", 'NodePath("../Foo")'],
    ["plain string (not a var_to_str form)", "hello"],
    ["empty string", ""],
  ])("%s encoded string", (_label, encoded) => {
    it("passes propertyValueSchema unchanged", () => {
      expect(propertyValueSchema.parse(encoded)).toBe(encoded);
    });

    it("survives a JSON round trip byte-for-byte", () => {
      expect(roundTripJson(encoded)).toBe(encoded);
    });
  });

  describe.each([
    ["boolean", true],
    ["integer", 42],
    ["float", 3.5],
  ])("%s primitive", (_label, value) => {
    it("passes propertyValueSchema unchanged", () => {
      expect(propertyValueSchema.parse(value)).toBe(value);
    });

    it("survives a JSON round trip with its native type intact", () => {
      const roundTripped = roundTripJson(value);
      expect(roundTripped).toBe(value);
      expect(typeof roundTripped).toBe(typeof value);
    });
  });

  it("accepts a properties object mixing primitives and var_to_str strings", () => {
    const input = { position: "Vector2(100, 50)", visible: true, z_index: 3 };
    expect(propertiesSchema.parse(input)).toEqual(input);
    expect(roundTripJson(input)).toEqual(input);
  });

  it("rejects a properties object containing a non-primitive value", () => {
    expect(() => propertiesSchema.parse({ position: null })).toThrow();
    expect(() => propertiesSchema.parse({ position: { x: 1 } })).toThrow();
    expect(() => propertiesSchema.parse({ position: [1, 2] })).toThrow();
  });
});
