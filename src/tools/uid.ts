import { z } from "zod";
import type { ToolDescriptor } from "../registry.js";
import type { BridgePort } from "./bridge.js";
import { bridgeErrorToResponse, requestValidated, resolveProjectPath } from "./bridge.js";
import { successResult } from "./result.js";

/**
 * Both UID tools require Godot >= 4.4 - resource UIDs only cover every
 * resource type as of that version (1.0's floor, carried forward). Enforced
 * centrally by the registry's version gate against the handshake-reported
 * engine version (REQ-A-07); never hand-coded in a handler here.
 */
export const MIN_UID_GODOT_VERSION = "4.4";

export interface UidToolsDeps {
  bridge: BridgePort;
}

const UidLookupSchema = z.object({ path: z.string(), uid: z.string() }).catchall(z.unknown());

const UpdateUidsSchema = z
  .object({
    touched: z.array(z.string()),
    already_had_uid: z.array(z.string()),
    failed: z.array(z.object({ path: z.string(), reason: z.string() })),
  })
  .catchall(z.unknown());

/** The UID tools at 1.0 parity (REQ-B-08/B-09), reimplemented as bridge ops (#71). */
export function createUidTools(deps: UidToolsDeps): ToolDescriptor[] {
  const getUid: ToolDescriptor = {
    name: "get_uid",
    description:
      "Return the uid:// UID for a res:// resource path (Godot >= 4.4); if the resource has no UID yet, run update_project_uids first.",
    inputSchema: {
      file_path: z
        .string()
        .min(1, "file_path must not be empty.")
        .describe('Resource path, e.g. "res://scenes/main.tscn" (project-relative also accepted).'),
    },
    minGodotVersion: MIN_UID_GODOT_VERSION,
    handler: async (args) => {
      const { file_path } = args as { file_path: string };
      const contained = resolveProjectPath(deps.bridge, file_path);
      if ("error" in contained) return contained.error;
      try {
        const lookup = await requestValidated(
          deps.bridge,
          "uid/get",
          { path: contained.resPath },
          UidLookupSchema,
        );
        return successResult("Resource UID", { ...lookup });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  const updateProjectUids: ToolDescriptor = {
    name: "update_project_uids",
    description:
      "Resave every .tscn/.tres lacking a UID inside the editor so all resources carry uid:// IDs (Godot >= 4.4); reports touched, already-had, and failed paths.",
    inputSchema: {},
    minGodotVersion: MIN_UID_GODOT_VERSION,
    handler: async () => {
      try {
        const outcome = await requestValidated(
          deps.bridge,
          "uid/update_project",
          {},
          UpdateUidsSchema,
        );
        return successResult("Updated project UIDs", { ...outcome });
      } catch (error) {
        return bridgeErrorToResponse(error);
      }
    },
  };

  return [getUid, updateProjectUids];
}
