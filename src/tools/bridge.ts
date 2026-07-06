import { z } from "zod";
import { createErrorResponse } from "../errors.js";
import type { ToolDescriptor } from "../registry.js";
import type { BridgeStatus } from "../bridge/connection.js";
import { BridgeOpError, BridgeTimeoutError, BridgeUnavailableError } from "../bridge/connection.js";
import type { TrafficEntry } from "../bridge/traffic-log.js";
import { TRAFFIC_LOG_CAPACITY } from "../bridge/traffic-log.js";
import { SystemStatusSchema, type SystemStatus } from "../bridge/protocol.js";

/** The narrow slice of BridgeConnection tools depend on (fake-able in tests). */
export interface BridgePort {
  status(): BridgeStatus;
  request(method: string, params?: Record<string, unknown>): Promise<unknown>;
  traffic(limit: number): TrafficEntry[];
}

export interface BridgeToolsDeps {
  bridge: BridgePort;
  serverVersion: string;
}

/**
 * Standard guidance for "no editor is connected" (REQ-A-10). Reused verbatim
 * by every tool slice; the final wording (incl. addon_install, which arrives
 * in #66) is refined by #65/#66 without changing the 1.x pointer.
 */
export const EDITOR_NOT_CONNECTED_SOLUTIONS: string[] = [
  "Open the project in the Godot editor and keep it running - v2 tools execute inside a live editor.",
  "Install the bridge addon by copying addon/godot_mcp into the project's addons/ folder, then enable 'Godot MCP' under Project > Project Settings > Plugins.",
  "Check bridge_status for the connection state and last disconnect reason the server sees.",
  "Need headless (no-editor) workflows? Use @cradial/godot-mcp@1.x - the 1.x line keeps the CLI-based tools.",
];

/**
 * Maps a typed bridge failure onto the structured error shape (REQ-A-08).
 * Anything unrecognized is re-thrown - a genuine bug should crash loudly in
 * dev rather than masquerade as a guided tool error.
 */
export function bridgeErrorToResponse(error: unknown) {
  if (error instanceof BridgeUnavailableError) {
    return createErrorResponse({
      message: error.message,
      possibleSolutions: error.mismatch
        ? [
            "Update the addon copy inside the project to the version bundled with this server.",
            "Or update @cradial/godot-mcp so the server matches the project's addon.",
            "Restart the Godot editor after updating, then retry.",
          ]
        : EDITOR_NOT_CONNECTED_SOLUTIONS,
    });
  }
  if (error instanceof BridgeTimeoutError) {
    return createErrorResponse({
      message: error.message,
      possibleSolutions: [
        "Check whether the editor is busy (importing assets, showing a modal dialog) and retry.",
        "Raise BRIDGE_TIMEOUT_MS if this project legitimately needs longer operations.",
      ],
    });
  }
  if (error instanceof BridgeOpError) {
    return createErrorResponse({
      message: error.message,
      possibleSolutions: error.possibleSolutions,
    });
  }
  throw error;
}

function successResult(label: string, payload: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: `${label}: ${JSON.stringify(payload)}` }],
    structuredContent: payload,
  };
}

/**
 * Runs system/status and validates the payload (REQ-A-08: a stale addon's
 * malformed reply becomes a guided error, not undefined tool output).
 */
async function fetchSystemStatus(bridge: BridgePort): Promise<SystemStatus> {
  const raw = await bridge.request("system/status");
  const parsed = SystemStatusSchema.safeParse(raw);
  if (!parsed.success) {
    throw new BridgeOpError(
      "The addon returned a malformed system/status payload.",
      "malformed_payload",
      [
        "Update the Godot MCP addon in this project to the version bundled with this server.",
        "Compare addon_version and server_version via bridge_status, then restart the editor.",
      ],
    );
  }
  return parsed.data;
}

/**
 * The two walking-skeleton tools (#64). Both round-trip a real bridge op
 * (`system/status`) when connected - REQ-A-01's "no headless process" proof
 * runs through these in integration.
 */
export function createBridgeTools(deps: BridgeToolsDeps): ToolDescriptor[] {
  const getGodotVersion: ToolDescriptor = {
    name: "get_godot_version",
    description:
      "Report the connected editor's Godot version plus the bridge addon and MCP server versions.",
    inputSchema: {},
    handler: async () => {
      try {
        const live = await fetchSystemStatus(deps.bridge);
        return successResult("Godot version", {
          godot_version: live.godot_version,
          godot_version_string: live.godot_version_string,
          features: live.features,
          addon_version: live.addon_version,
          server_version: deps.serverVersion,
          protocol_version: live.protocol_version,
        });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const bridgeStatus: ToolDescriptor = {
    name: "bridge_status",
    description:
      "Report the editor bridge state: connection, handshake data (Godot/addon versions, project path), and op queue depth.",
    inputSchema: {},
    handler: async () => {
      const status = deps.bridge.status();
      if (status.state !== "connected") {
        return successResult("Bridge status", {
          state: status.state,
          server_version: deps.serverVersion,
          protocol_version: status.protocolVersion,
          pending_requests: status.pendingRequests,
          reconnect_attempts: status.reconnectAttempts,
          last_disconnect_reason: status.lastDisconnectReason ?? null,
          addon_protocol_version:
            status.mismatch?.addonProtocolVersion ?? status.hello?.protocol_version ?? null,
          guidance: EDITOR_NOT_CONNECTED_SOLUTIONS,
        });
      }
      try {
        const live = await fetchSystemStatus(deps.bridge);
        return successResult("Bridge status", {
          state: "connected",
          server_version: deps.serverVersion,
          protocol_version: status.protocolVersion,
          addon_version: live.addon_version,
          godot_version: live.godot_version,
          godot_version_string: live.godot_version_string,
          features: live.features,
          project_path: live.project_path,
          uptime_ms: live.uptime_ms,
          queue_depth: live.queue_depth,
          pending_requests: status.pendingRequests,
        });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const getBridgeLog: ToolDescriptor = {
    name: "get_bridge_log",
    description:
      "Return recent bridge traffic (frames and connection events) for diagnosing editor-bridge issues.",
    inputSchema: {
      lines: z
        .number()
        .int()
        .min(1)
        .max(TRAFFIC_LOG_CAPACITY)
        .optional()
        .describe(`How many recent entries to return (default 50, max ${TRAFFIC_LOG_CAPACITY}).`),
    },
    handler: async (args) => {
      const lines = (args as { lines?: number }).lines;
      const entries = deps.bridge.traffic(lines ?? 50);
      return successResult("Bridge log", { entries, count: entries.length });
    },
  };

  return [bridgeStatus, getGodotVersion, getBridgeLog];
}
