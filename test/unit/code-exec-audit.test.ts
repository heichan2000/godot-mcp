import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, buildToolInventory } from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";
import { auditCodeExec, parseAddonOpTable } from "../support/code-exec-audit.js";

const serverGdPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "addon",
  "godot_mcp",
  "server.gd",
);

/** Op-table size when this gate was written - a shrinking parse means regex rot, not fewer ops. */
const OP_TABLE_FLOOR = 26;

const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
    reconnectAttempts: 0,
  }),
  request: async () => {
    throw new Error("stub bridge - the audit never calls tools");
  },
  traffic: () => [],
};

/**
 * REQ-M-03 (#76): no eval/exec-style capability may exist in either inventory
 * - the TS tool descriptor array or the addon op table. A standing gate in the
 * unit CI job, with in-test decoys proving the audit actually fires.
 */
describe("code-exec audit (REQ-M-03)", () => {
  const toolNames = buildToolInventory({ bridge: stubBridge }).map((tool) => tool.name);
  const opNames = parseAddonOpTable(readFileSync(serverGdPath, "utf8"));

  it("parses a non-rotted op table from server.gd", () => {
    expect(opNames.length).toBeGreaterThanOrEqual(OP_TABLE_FLOOR);
    expect(opNames).toContain("system/status"); // sanity: a known arm parsed
  });

  it("flags no tool descriptor as code-exec-shaped", () => {
    expect(auditCodeExec(toolNames)).toEqual([]);
  });

  it("flags no addon op as code-exec-shaped", () => {
    expect(auditCodeExec(opNames)).toEqual([]);
  });

  it("decoy proof: the audit fires on code-exec-shaped entries (spec decoys)", () => {
    expect(auditCodeExec([...opNames, "script/execute_expression"])).toEqual([
      "script/execute_expression",
    ]);
    expect(auditCodeExec([...toolNames, "run_code_snippet"])).toEqual(["run_code_snippet"]);
  });

  it("token matching has no substring false positives", () => {
    expect(auditCodeExec(["run_project", "get_script_errors", "update_project_uids"])).toEqual([]);
    expect(auditCodeExec(["evaluate_thing"])).toEqual([]); // "evaluate" is not the "eval" token
  });
});
