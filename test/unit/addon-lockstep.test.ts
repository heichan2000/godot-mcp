import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION } from "../../src/bridge/protocol.js";
import { SERVER_VERSION } from "../../src/server.js";

const addonDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "addon",
  "godot_mcp",
);

/**
 * Godot-free lockstep asserts (#65 hardening): version and protocol drift
 * between the TS server and the bundled addon must fail unit CI, not wait
 * for an integration leg.
 */
describe("addon lockstep", () => {
  it("plugin.cfg version equals SERVER_VERSION", () => {
    const cfg = readFileSync(path.join(addonDir, "plugin.cfg"), "utf8");
    expect(/version="([^"]+)"/.exec(cfg)?.[1]).toBe(SERVER_VERSION);
  });

  it("server.gd PROTOCOL_VERSION equals the TS PROTOCOL_VERSION", () => {
    const gd = readFileSync(path.join(addonDir, "server.gd"), "utf8");
    expect(Number(/const PROTOCOL_VERSION := (\d+)/.exec(gd)?.[1])).toBe(PROTOCOL_VERSION);
  });
});
