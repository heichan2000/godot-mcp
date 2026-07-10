import { readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createErrorResponse } from "../errors.js";
import { checkScriptsViaLsp, LspError, type ScriptToCheck } from "../lsp/client.js";
import type { ToolDescriptor } from "../registry.js";
import type { BridgePort } from "./bridge.js";
import {
  bridgeErrorToResponse,
  EDITOR_NOT_CONNECTED_SOLUTIONS,
  requestValidated,
  resolveProjectPath,
} from "./bridge.js";
import { successResult } from "./result.js";

export interface DiagnosticsToolsDeps {
  bridge: BridgePort;
  /** GDScript language-server port (config.lspPort; default 6005). */
  lspPort: number;
  /** Injectable for unit tests; defaults to the real LSP client. */
  checkScripts?: typeof checkScriptsViaLsp;
  /** Injectable for unit tests; defaults to a UTF-8 file read. */
  readFile?: (absPath: string) => string;
}

/** Per-script wait for the language server's publishDiagnostics push. */
const LSP_TIMEOUT_MS = 10_000;

/** Only the fields whole-project enumeration needs from project/list_resources. */
const GdScriptListSchema = z
  .object({ resources: z.array(z.object({ path: z.string() }).catchall(z.unknown())) })
  .catchall(z.unknown());

/**
 * get_script_errors (REQ-D-01): structured parse/compile diagnostics for one
 * script or every GDScript in the project. Diagnostics come from the editor's
 * built-in GDScript language server (see src/lsp/client.ts for why) — NOT a
 * bridge op — but the tool still requires a connected editor: the project
 * root comes from the bridge handshake, and whole-project enumeration reuses
 * the project/list_resources bridge op so the editor's own filesystem view
 * (not a TS directory crawl) decides what counts as a project script.
 */
export function createDiagnosticsTools(deps: DiagnosticsToolsDeps): ToolDescriptor[] {
  const checkScripts = deps.checkScripts ?? checkScriptsViaLsp;
  const readFile = deps.readFile ?? ((absPath: string) => readFileSync(absPath, "utf8"));

  const getScriptErrors: ToolDescriptor = {
    name: "get_script_errors",
    description:
      "Parse/compile diagnostics for one GDScript or every .gd in the project, as structured file/line/message/severity records from the editor's language server.",
    inputSchema: {
      script_path: z
        .string()
        .min(1)
        .optional()
        .describe(
          'Project path of a single .gd script to check, e.g. "res://scripts/player.gd" or ' +
            '"scripts/player.gd". Omit to check every GDScript in the project.',
        ),
    },
    handler: async (args) => {
      const { script_path } = args as { script_path?: string };

      // Containment gate FIRST — a rejected path never reaches bridge, LSP,
      // or filesystem (REQ-M-01; proven by the dead-bridge unit test).
      let single: { resPath: string; relative: string } | undefined;
      if (script_path !== undefined) {
        const contained = resolveProjectPath(deps.bridge, script_path);
        if ("error" in contained) return contained.error;
        single = contained;
      }

      const projectRoot = deps.bridge.status().hello?.project_path;
      if (!projectRoot) {
        return createErrorResponse({
          message: "No editor is connected - script diagnostics need the running editor's language server.",
          possibleSolutions: EDITOR_NOT_CONNECTED_SOLUTIONS,
        });
      }

      let targets: Array<{ resPath: string; relative: string }>;
      if (single) {
        targets = [single];
      } else {
        try {
          const listing = await requestValidated(
            deps.bridge,
            "project/list_resources",
            { type: "GDScript" },
            GdScriptListSchema,
          );
          targets = listing.resources.map((resource) => ({
            resPath: resource.path,
            relative: resource.path.replace(/^res:\/\//, ""),
          }));
        } catch (error) {
          return bridgeErrorToResponse(error);
        }
      }

      const scripts: ScriptToCheck[] = [];
      for (const target of targets) {
        const absPath = path.join(projectRoot, target.relative);
        let text: string;
        try {
          text = readFile(absPath);
        } catch {
          return createErrorResponse({
            message: `Script does not exist at ${target.resPath}.`,
            possibleSolutions: [
              "Check that script_path points at an existing .gd file inside the project.",
              'Call list_resources with type "GDScript" to see the project\'s scripts.',
            ],
          });
        }
        scripts.push({ resPath: target.resPath, absPath, text });
      }

      try {
        const errors = await checkScripts({
          port: deps.lspPort,
          projectRoot,
          scripts,
          timeoutMs: LSP_TIMEOUT_MS,
        });
        return successResult("Script errors", {
          errors,
          count: errors.length,
          scripts_checked: scripts.length,
        });
      } catch (error) {
        if (error instanceof LspError) {
          return createErrorResponse({
            message: error.message,
            possibleSolutions: error.possibleSolutions,
          });
        }
        throw error;
      }
    },
  };

  return [getScriptErrors];
}
