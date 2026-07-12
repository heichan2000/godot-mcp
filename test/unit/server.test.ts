import { describe, expect, it } from "vitest";
import {
  SERVER_VERSION,
  buildToolInventory,
  createServer,
  createShutdown,
  packageJsonVersion,
} from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";

const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
    reconnectAttempts: 0,
  }),
  request: async () => {
    throw new Error("stub bridge has no editor");
  },
  traffic: () => [],
};

describe("server wiring", () => {
  it("SERVER_VERSION stays in lockstep with package.json", () => {
    expect(SERVER_VERSION).toBe(packageJsonVersion());
  });

  it("builds the walking-skeleton inventory", () => {
    const names = buildToolInventory({ bridge: stubBridge }).map((tool) => tool.name);
    expect(names).toEqual([
      "bridge_status",
      "get_godot_version",
      "get_bridge_log",
      "create_project",
      "install_addon",
      "list_projects",
      "get_project_info",
      "list_resources",
      "import_assets",
      "get_uid",
      "update_project_uids",
      "create_scene",
      "open_scene",
      "get_open_scenes",
      "save_scene",
      "close_scene",
      "get_scene_tree",
      "add_node",
      "remove_node",
      "duplicate_node",
      "move_node",
      "rename_node",
      "read_node_properties",
      "get_script_errors",
      "run_project",
      "stop_project",
      "get_debug_output",
    ]);
  });

  it("createServer registers without touching the bridge", () => {
    expect(() => createServer({ bridge: stubBridge })).not.toThrow();
  });

  it("createShutdown exits even when both closes fail", async () => {
    let exitCode: number | null = null;
    const shutdown = createShutdown({
      stopBridge: () => Promise.reject(new Error("bridge close failed")),
      closeServer: () => Promise.reject(new Error("server close failed")),
      exit: (code) => {
        exitCode = code;
      },
      debugLog: () => undefined,
    });
    shutdown("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(exitCode).toBe(0);
  });
});
