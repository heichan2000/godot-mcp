import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import { createErrorResponse } from "../errors.js";
import type { ToolDescriptor } from "../registry.js";
import type { BridgePort } from "./bridge.js";
import { successResult } from "./result.js";

export interface ProjectToolsDeps {
  /** The live editor bridge. Unused by list_projects (server-side); Tasks 3–5 add bridge ops. */
  bridge: BridgePort;
}

/** Default recursion cap for list_projects — bounded traversal (REQ-B-02 acceptance). */
export const DEFAULT_MAX_DEPTH = 5;

/** Directory names never descended into during discovery (VCS/build/import caches). */
const SKIP_DIRS = new Set([".git", ".godot", "node_modules", ".import"]);

interface FoundProject {
  path: string;
  name: string;
  godot_version: string | null;
}

/**
 * Reads config/name and the first config/features tag out of a project.godot
 * with light regex parsing (server-side, no Godot). Returns empty/null on an
 * unreadable or malformed file rather than throwing — discovery is best-effort.
 */
function parseProjectGodot(projectGodotPath: string): {
  name: string;
  godot_version: string | null;
} {
  let text = "";
  try {
    text = readFileSync(projectGodotPath, "utf8");
  } catch {
    return { name: "", godot_version: null };
  }
  const nameMatch = /config\/name\s*=\s*"([^"]*)"/.exec(text);
  const featMatch = /config\/features\s*=\s*PackedStringArray\(\s*"([^"]*)"/.exec(text);
  return { name: nameMatch?.[1] ?? "", godot_version: featMatch?.[1] ?? null };
}

/**
 * Depth-first walk collecting directories that directly contain project.godot.
 * A found project is recorded and NOT descended into (its own subfolders are
 * not separate projects). Hidden dirs (dot-prefixed) and SKIP_DIRS are ignored;
 * an unreadable directory is skipped rather than aborting the whole walk.
 */
function walkForProjects(root: string, recursive: boolean, maxDepth: number): FoundProject[] {
  const found: FoundProject[] = [];
  const visit = (dir: string, depth: number): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    if (entries.includes("project.godot")) {
      const meta = parseProjectGodot(path.join(dir, "project.godot"));
      found.push({ path: dir, name: meta.name, godot_version: meta.godot_version });
      return;
    }
    if (!recursive || depth >= maxDepth) return;
    for (const entry of entries) {
      if (entry.startsWith(".") || SKIP_DIRS.has(entry)) continue;
      const child = path.join(dir, entry);
      let isDir = false;
      try {
        isDir = statSync(child).isDirectory();
      } catch {
        continue;
      }
      if (isDir) visit(child, depth + 1);
    }
  };
  visit(root, 0);
  return found;
}

export function createProjectTools(deps: ProjectToolsDeps): ToolDescriptor[] {
  void deps; // list_projects needs no bridge; Tasks 3–5 use deps.bridge.

  const listProjects: ToolDescriptor = {
    name: "list_projects",
    description:
      "Find Godot projects (folders with project.godot) under a directory; depth-capped, skips hidden and system folders.",
    inputSchema: {
      directory: z
        .string()
        .min(1, "directory must not be empty.")
        .describe("Absolute path to the directory to search for Godot projects."),
      recursive: z.boolean().optional().describe("Recurse into subdirectories (default true)."),
      max_depth: z
        .number()
        .int()
        .min(0)
        .optional()
        .describe(`Maximum recursion depth (default ${DEFAULT_MAX_DEPTH}).`),
    },
    handler: async (args) => {
      const { directory, recursive, max_depth } = args as {
        directory: string;
        recursive?: boolean;
        max_depth?: number;
      };

      if (!path.isAbsolute(directory)) {
        return createErrorResponse({
          message: `directory "${directory}" must be an absolute path.`,
          possibleSolutions: ["Pass the absolute path to the folder to search for Godot projects."],
        });
      }

      const searchRoot = path.resolve(directory);
      let isDir = false;
      try {
        isDir = statSync(searchRoot).isDirectory();
      } catch {
        isDir = false;
      }
      if (!existsSync(searchRoot) || !isDir) {
        return createErrorResponse({
          message: `directory "${searchRoot}" does not exist or is not a readable directory.`,
          possibleSolutions: [
            "Pass a path to an existing, readable directory.",
            "Check the path for typos or permissions.",
          ],
        });
      }

      const projects = walkForProjects(
        searchRoot,
        recursive ?? true,
        max_depth ?? DEFAULT_MAX_DEPTH,
      );
      return successResult("Projects", { directory: searchRoot, projects, count: projects.length });
    },
  };

  return [listProjects];
}
