import { describe, expect, it } from "vitest";
import { SERVER_VERSION, buildToolInventory } from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";

/**
 * REQ-A-05: every tool ships with a snake_case multi-segment name
 * (domain_verb_noun style), a lean single-line description, and snake_case
 * params. This suite runs in `npm test` on every CI leg - adding a tool that
 * violates the strategy fails the build, which is the enforcement REQ-A-05
 * demands. The human-facing strategy lives in docs/tool-naming.md.
 */
const NAME_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)+$/;
const PARAM_PATTERN = /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/;
const DESCRIPTION_BUDGET = 200;

const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
    reconnectAttempts: 0,
  }),
  request: async () => {
    throw new Error("stub bridge - lint never calls tools");
  },
  traffic: () => [],
};

const inventory = buildToolInventory({ bridge: stubBridge });

describe("REQ-A-05 naming lint", () => {
  it("has at least the walking-skeleton tools", () => {
    expect(inventory.length).toBeGreaterThanOrEqual(2);
  });

  it("every tool name is snake_case with >= 2 segments", () => {
    for (const tool of inventory) {
      expect(tool.name, `tool name violates naming pattern: ${tool.name}`).toMatch(NAME_PATTERN);
    }
  });

  it("tool names are unique", () => {
    const names = inventory.map((tool) => tool.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it(`every description is single-line and <= ${DESCRIPTION_BUDGET} chars`, () => {
    for (const tool of inventory) {
      expect(tool.description.length, `${tool.name}: empty description`).toBeGreaterThan(0);
      expect(
        tool.description.length,
        `${tool.name}: description over budget (${tool.description.length})`,
      ).toBeLessThanOrEqual(DESCRIPTION_BUDGET);
      expect(tool.description, `${tool.name}: description must be single-line`).not.toContain("\n");
      expect(tool.description, `${tool.name}: description must not contain CR`).not.toContain("\r");
    }
  });

  it("every param key is snake_case", () => {
    for (const tool of inventory) {
      for (const key of Object.keys(tool.inputSchema)) {
        expect(key, `${tool.name}: param violates snake_case: ${key}`).toMatch(PARAM_PATTERN);
      }
    }
  });
});
