import { describe, expect, it } from "vitest";
import { z } from "zod";
import { renderToolDocs } from "../../src/docs/tool-docs.js";
import {
  SERVER_VERSION,
  buildToolGroups,
  buildToolInventory,
  type ToolGroup,
} from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";

const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
    reconnectAttempts: 0,
  }),
  request: async () => {
    throw new Error("stub bridge - docs render never calls tools");
  },
  traffic: () => [],
};

const noopHandler = (() => ({ content: [] })) as unknown as ToolCallback<z.ZodRawShape>;

describe("buildToolGroups", () => {
  it("flattens to exactly the registered inventory, in order", () => {
    const groupedNames = buildToolGroups({ bridge: stubBridge }).flatMap((group) =>
      group.tools.map((tool) => tool.name),
    );
    const inventoryNames = buildToolInventory({ bridge: stubBridge }).map((tool) => tool.name);
    expect(groupedNames).toEqual(inventoryNames);
  });
});

describe("renderToolDocs", () => {
  it("emits a per-domain table with the tool name and description", () => {
    const md = renderToolDocs(buildToolGroups({ bridge: stubBridge }));
    expect(md).toContain("## Bridge & versions");
    expect(md).toContain("| Tool | Description | Parameters |");
    expect(md).toContain("`bridge_status`");
  });

  it("renders each parameter with type and required-ness", () => {
    const md = renderToolDocs(buildToolGroups({ bridge: stubBridge }));
    expect(md).toContain("`directory` string, required");
    expect(md).toContain("`recursive` boolean, optional");
  });

  it("renders _none_ for a parameterless tool", () => {
    const group: ToolGroup = {
      title: "Demo",
      tools: [
        {
          name: "demo_ping_nothing",
          description: "Ping with no parameters.",
          inputSchema: {},
          handler: noopHandler,
        },
      ],
    };
    expect(renderToolDocs([group])).toContain(
      "| `demo_ping_nothing` | Ping with no parameters. | _none_ |",
    );
  });

  it("escapes pipes in descriptions and enum members so table cells stay valid", () => {
    const group: ToolGroup = {
      title: "Demo",
      tools: [
        {
          name: "demo_pick_mode",
          description: "Pick a|b mode.",
          inputSchema: { mode: z.enum(["x", "y"]).optional() },
          handler: noopHandler,
        },
      ],
    };
    const md = renderToolDocs([group]);
    expect(md).toContain("Pick a\\|b mode.");
    expect(md).toContain("enum(x \\| y)");
  });
});
