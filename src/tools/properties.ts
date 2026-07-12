import { z } from "zod";
import type { ToolDescriptor } from "../registry.js";
import type { BridgePort } from "./bridge.js";
import { bridgeErrorToResponse, requestValidated } from "./bridge.js";
import { successResult } from "./result.js";

export interface PropertyToolsDeps {
  bridge: BridgePort;
}

const GetPropertiesSchema = z
  .object({
    node_path: z.string(),
    node_type: z.string(),
    properties: z.record(z.string(), z.unknown()),
  })
  .catchall(z.unknown());

/**
 * The node-property tools (#74, REQ-C-06): symmetric get/set through the
 * shared value codec (src/godot/values.ts documents the wire contract).
 * Values cross the bridge as opaque JSON - only the addon knows declared
 * property types, so all value semantics live addon-side
 * (addon/godot_mcp/ops/property_ops.gd). Task 2 of the plan appends
 * set_node_properties here.
 */
export function createPropertyTools(deps: PropertyToolsDeps): ToolDescriptor[] {
  const readNodeProperties: ToolDescriptor = {
    name: "read_node_properties",
    description:
      "Read a node's properties in the current scene: by default its non-default (stored) state, or pass properties to fetch specific values. Non-primitive values use Godot text forms.",
    inputSchema: {
      node_path: z
        .string()
        .min(1, "node_path must not be empty.")
        .describe('Node to read, as a path relative to the scene root, e.g. "Player/Sprite".'),
      properties: z
        .array(z.string().min(1))
        .min(1)
        .optional()
        .describe(
          "Specific property names to fetch (stored or not). Omit for the node's non-default state.",
        ),
    },
    handler: async (args) => {
      const { node_path, properties } = args as { node_path: string; properties?: string[] };
      const params: Record<string, unknown> = { node_path };
      if (properties !== undefined) params.properties = properties;
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "node/get_properties",
          params,
          GetPropertiesSchema,
        );
        const count = Object.keys(outcome.properties).length;
        return successResult(`${count} propert${count === 1 ? "y" : "ies"}`, { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  return [readNodeProperties];
}
