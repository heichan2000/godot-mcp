import { describe, expect, it } from "vitest";
import { SERVER_VERSION, buildToolInventory } from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/**
 * REQ-M-01 sweep (#76), server layer in isolation: every path-taking tool
 * param rejects every escape shape BEFORE any frame crosses the bridge. The
 * recording bridge below stands in for an addon that would execute anything -
 * an empty `requests` array after the call IS the "addon bypassed, server
 * alone catches it" proof. A completeness guard fails this suite when a new
 * path-like param is neither swept nor explicitly exempted.
 */
const ESCAPING_PAYLOADS = [
  "../../etc/passwd", // the PRD §11 smoke, verbatim
  "a/b/../../../escape.tscn", // interior climb past the root
  "/etc/passwd", // POSIX absolute
  "C:\\Windows\\System32\\evil.tscn", // Windows absolute, backslashes
  "C:/Windows/evil.tscn", // Windows absolute, forward slashes
  "..\\..\\escape.tscn", // backslash traversal
  "res://../escape.tscn", // res-relative climb
  "user://escape.tscn", // foreign scheme
  "file:///etc/passwd", // foreign scheme
];

/** tool.param -> how to build a call where only that param escapes. */
const SWEEP: Array<{
  tool: string;
  param: string;
  baseArgs?: Record<string, unknown>;
  /** import_assets takes string[]; wrap the payload. */
  asArray?: boolean;
}> = [
  { tool: "create_scene", param: "scene_path" },
  { tool: "open_scene", param: "scene_path" },
  { tool: "save_scene", param: "scene_path" },
  { tool: "save_scene", param: "new_path" },
  { tool: "close_scene", param: "scene_path" },
  { tool: "export_mesh_library", param: "scene_path", baseArgs: { output_path: "res://ok.res" } },
  { tool: "export_mesh_library", param: "output_path", baseArgs: { scene_path: "res://ok.tscn" } },
  { tool: "run_project", param: "scene_path" }, // scene_path alone implies mode "custom"
  { tool: "get_uid", param: "file_path" },
  { tool: "get_script_errors", param: "script_path" },
  { tool: "list_resources", param: "directory" },
  { tool: "import_assets", param: "paths", asArray: true },
];

/**
 * Path-like params that are deliberately NOT contained. Every entry needs a
 * reason - an unexplained exemption is a review reject.
 */
const EXEMPT = new Set([
  "add_node.parent_path", // scene-tree node path, not a filesystem path
  "remove_node.node_path", // scene-tree node path
  "duplicate_node.node_path", // scene-tree node path
  "move_node.node_path", // scene-tree node path
  "move_node.new_parent_path", // scene-tree node path
  "rename_node.node_path", // scene-tree node path
  "read_node_properties.node_path", // scene-tree node path
  "set_node_properties.node_path", // scene-tree node path
  "create_project.project_path", // the containment root being created (host-level, REQ-B-01)
  "install_addon.project_path", // host-level install target; validated by its own checks
  "list_projects.directory", // host-level workspace root to scan (bounded listing, REQ-B-02)
]);

// The guard only conscripts params matching this - name any new filesystem
// param to end in path/paths/directory or it will not be swept.
const PATH_LIKE = /(^|_)(path|paths|directory)$/;

function recordingBridge(): { bridge: BridgePort; requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    bridge: {
      status: () => ({
        state: "disconnected",
        serverVersion: SERVER_VERSION,
        protocolVersion: 1,
        pendingRequests: 0,
        reconnectAttempts: 0,
      }),
      request: async (method) => {
        requests.push(method);
        throw new Error(`sweep: "${method}" crossed the bridge with an escaping path`);
      },
      traffic: () => [],
    },
  };
}

describe("containment sweep (REQ-M-01, server layer in isolation)", () => {
  it("completeness guard: every path-like param is swept or explicitly exempt", () => {
    const { bridge } = recordingBridge();
    for (const tool of buildToolInventory({ bridge })) {
      for (const key of Object.keys(tool.inputSchema)) {
        if (!PATH_LIKE.test(key)) continue;
        const id = `${tool.name}.${key}`;
        const swept = SWEEP.some((entry) => entry.tool === tool.name && entry.param === key);
        expect(
          swept || EXEMPT.has(id),
          `unswept path-like param: ${id} - add it to SWEEP, or to EXEMPT with a reason`,
        ).toBe(true);
      }
    }
  });

  it("no sweep entry is stale (tool + param still exist)", () => {
    const { bridge } = recordingBridge();
    const inventory = buildToolInventory({ bridge });
    for (const entry of SWEEP) {
      const tool = inventory.find((candidate) => candidate.name === entry.tool);
      expect(tool, `SWEEP names a missing tool: ${entry.tool}`).toBeDefined();
      expect(
        Object.keys(tool!.inputSchema),
        `SWEEP names a missing param: ${entry.tool}.${entry.param}`,
      ).toContain(entry.param);
    }
  });

  for (const entry of SWEEP) {
    describe(`${entry.tool}.${entry.param}`, () => {
      for (const payload of ESCAPING_PAYLOADS) {
        it(`rejects ${JSON.stringify(payload)} with zero bridge frames`, async () => {
          const { bridge, requests } = recordingBridge();
          const tool = buildToolInventory({ bridge }).find(
            (candidate) => candidate.name === entry.tool,
          )!;
          const value = entry.asArray ? [payload] : payload;
          const result = (await tool.handler(
            { ...entry.baseArgs, [entry.param]: value } as never,
            {} as never,
          )) as ToolResult;
          expect(result.isError, `${entry.tool} accepted ${payload}`).toBe(true);
          const message = (result.structuredContent as { message?: string })?.message ?? "";
          // Containment messages always name res:// / the project root -
          // this also catches a wrong-error pass (e.g. "editor not connected").
          expect(message, `${entry.tool}: not a containment rejection: ${message}`).toMatch(
            /res:\/\//,
          );
          expect(
            (result.structuredContent as { possibleSolutions?: string[] })?.possibleSolutions
              ?.length,
          ).toBeGreaterThan(0);
          expect(requests, `${entry.tool} sent frames for ${payload}`).toEqual([]);
        });
      }
    });
  }
});
