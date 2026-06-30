/**
 * Shared zod fragments reused across tool input schemas.
 *
 * Note: these validate *shape*. Actual on-disk path containment
 * (assertInsideRoot) is enforced in the tool handlers and re-checked
 * inside operations.gd — see godot/paths.ts.
 */
import { z } from "zod";

/** Absolute path to a Godot project directory (anchors path containment). */
export const projectPath = z
  .string()
  .min(1)
  .describe("Absolute path to the Godot project directory.");

/** A project-relative path to a scene file, e.g. "scenes/main.tscn". */
export const scenePath = z
  .string()
  .min(1)
  .describe("Project-relative path to a .tscn scene file.");

/** A project-relative path to any resource/file under the project. */
export const relativePath = z
  .string()
  .min(1)
  .describe("Project-relative path; must resolve inside project_path.");

/** A node path within a scene tree, e.g. "Root/Player/Sprite". */
export const nodePath = z
  .string()
  .min(1)
  .describe("Path to a node within the scene tree.");
