import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("defaults godotPath to undefined and debug to false when env is empty", () => {
    const config = loadConfig({});

    expect(config.godotPath).toBeUndefined();
    expect(config.debug).toBe(false);
  });

  it("reads GODOT_PATH from env verbatim", () => {
    const config = loadConfig({ GODOT_PATH: "C:\\Godot\\Godot.exe" });

    expect(config.godotPath).toBe("C:\\Godot\\Godot.exe");
  });

  it("treats an empty-string GODOT_PATH as unset", () => {
    const config = loadConfig({ GODOT_PATH: "   " });

    expect(config.godotPath).toBeUndefined();
  });

  it.each(["true", "TRUE", "1", "yes", "on"])("parses DEBUG=%s as debug: true", (value) => {
    const config = loadConfig({ DEBUG: value });

    expect(config.debug).toBe(true);
  });

  it.each(["false", "0", "", undefined, "nope"])("parses DEBUG=%s as debug: false", (value) => {
    const config = loadConfig({ DEBUG: value });

    expect(config.debug).toBe(false);
  });

  it("defaults outputBufferLines to 1000 when OUTPUT_BUFFER_LINES is unset", () => {
    const config = loadConfig({});

    expect(config.outputBufferLines).toBe(1000);
  });

  it("reads a valid positive integer OUTPUT_BUFFER_LINES from env", () => {
    const config = loadConfig({ OUTPUT_BUFFER_LINES: "2500" });

    expect(config.outputBufferLines).toBe(2500);
  });

  it.each(["", "   ", "0", "-5", "not-a-number", "12.5"])(
    "falls back to the default 1000 for an invalid OUTPUT_BUFFER_LINES=%s",
    (value) => {
      const config = loadConfig({ OUTPUT_BUFFER_LINES: value });

      expect(config.outputBufferLines).toBe(1000);
    },
  );

  it("defaults bridgePort to 6510 and honors GODOT_MCP_PORT", () => {
    expect(loadConfig({}).bridgePort).toBe(6510);
    expect(loadConfig({ GODOT_MCP_PORT: "7000" }).bridgePort).toBe(7000);
    expect(loadConfig({ GODOT_MCP_PORT: "0" }).bridgePort).toBe(6510);
    expect(loadConfig({ GODOT_MCP_PORT: "not-a-port" }).bridgePort).toBe(6510);
  });

  it("defaults bridgeTimeoutMs to 30000 and honors BRIDGE_TIMEOUT_MS", () => {
    expect(loadConfig({}).bridgeTimeoutMs).toBe(30_000);
    expect(loadConfig({ BRIDGE_TIMEOUT_MS: "5000" }).bridgeTimeoutMs).toBe(5_000);
    expect(loadConfig({ BRIDGE_TIMEOUT_MS: "-1" }).bridgeTimeoutMs).toBe(30_000);
  });
});
