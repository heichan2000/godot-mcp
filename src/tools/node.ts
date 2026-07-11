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

const RemovedEntrySchema = z
  .object({ path: z.string(), name: z.string(), type: z.string() })
  .catchall(z.unknown());

const RemoveNodeSchema = z
  .object({
    node_path: z.string(),
    removed_subtree: z.array(RemovedEntrySchema),
    removed_count: z.number().int(),
  })
  .catchall(z.unknown());

const DuplicateNodeSchema = z
  .object({ node_path: z.string(), name: z.string(), source_path: z.string() })
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

  const removeNode: ToolDescriptor = {
    name: "remove_node",
    description:
      "Remove a node and its whole subtree from the current scene; the response manifests everything removed (names, types, paths), and the editor's Ctrl+Z restores it.",
    inputSchema: {
      node_path: z
        .string()
        .min(1, "node_path must not be empty.")
        .describe('Node to remove, as a path relative to the scene root, e.g. "Player/Sword".'),
    },
    handler: async (args) => {
      const { node_path } = args as { node_path: string };
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "node/remove",
          { node_path },
          RemoveNodeSchema,
        );
        return successResult(`Removed ${outcome.removed_count} node(s)`, { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const duplicateNode: ToolDescriptor = {
    name: "duplicate_node",
    description:
      "Duplicate a node and its subtree in place as a sibling copy with a unique name, optionally renamed; the editor's Ctrl+Z removes the copy.",
    inputSchema: {
      node_path: z
        .string()
        .min(1, "node_path must not be empty.")
        .describe('Node to duplicate, as a path relative to the scene root, e.g. "Enemies".'),
      new_name: z
        .string()
        .min(1)
        .optional()
        .describe("Name for the copy; defaults to the source name plus a unique suffix."),
    },
    handler: async (args) => {
      const { node_path, new_name } = args as { node_path: string; new_name?: string };
      const params: Record<string, unknown> = { node_path };
      if (new_name !== undefined) params.new_name = new_name;
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "node/duplicate",
          params,
          DuplicateNodeSchema,
        );
        return successResult("Duplicated node", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  return [addNode, removeNode, duplicateNode];
}
