import { z } from "zod";
import type { ToolDescriptor } from "../registry.js";
import type { BridgePort } from "./bridge.js";
import { bridgeErrorToResponse, requestValidated } from "./bridge.js";
import { successResult } from "./result.js";

export interface NodeToolsDeps {
  bridge: BridgePort;
}

const AddNodeSchema = z
  .object({
    node_path: z.string(),
    name: z.string(),
    node_type: z.string(),
    parent_path: z.string(),
  })
  .catchall(z.unknown());

export function createNodeTools(deps: NodeToolsDeps): ToolDescriptor[] {
  const addNode: ToolDescriptor = {
    name: "add_node",
    description:
      "Add a node of a given type under a parent in the current scene; registered with the editor's undo so Ctrl+Z reverts it.",
    inputSchema: {
      node_type: z
        .string()
        .min(1, "node_type must not be empty.")
        .describe('Node class to instantiate, e.g. "Node2D", "Sprite2D", "Control".'),
      parent_path: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Parent node path relative to the scene root (default "." = the root), e.g. "Player".',
        ),
      node_name: z
        .string()
        .min(1)
        .optional()
        .describe("Name for the new node; defaults to its type name."),
    },
    handler: async (args) => {
      const { node_type, parent_path, node_name } = args as {
        node_type: string;
        parent_path?: string;
        node_name?: string;
      };
      const params: Record<string, unknown> = { node_type };
      if (parent_path !== undefined) params.parent_path = parent_path;
      if (node_name !== undefined) params.node_name = node_name;
      try {
        const outcome = await requestValidated(deps.bridge, "node/add", params, AddNodeSchema);
        return successResult("Added node", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  return [addNode];
}
