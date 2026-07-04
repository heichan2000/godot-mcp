import { z } from "zod";

/**
 * Absolute path to a Godot project directory (the one containing
 * `project.godot`). Required by every tool that operates on a project;
 * anchors path containment (`assertInsideRoot`) for every other path
 * parameter accepted in the same tool call.
 */
export const projectPathSchema = z
  .string()
  .min(1, "project_path must not be empty.")
  .describe("Absolute path to the Godot project directory (containing project.godot).");

/**
 * Base fragment for any filesystem path a tool accepts relative to a call's
 * `project_path`. Always checked for containment via `assertInsideRoot`
 * before use, so the target may not exist on disk yet (e.g. a resource
 * about to be created). Prefer a more specific export (like
 * `scenePathSchema`) where one exists; derive one-off params from this via
 * `.describe(...)` rather than duplicating the validation.
 */
export const relativePathSchema = z
  .string()
  .min(1, "Path must not be empty.")
  .describe(
    "Path relative to project_path. Must resolve inside the project directory - " +
      'no absolute paths and no ".." segments.',
  );

/**
 * Path to a `.tscn` scene file, relative to `project_path`. May point at a
 * scene that does not exist yet (e.g. `create_scene`).
 */
export const scenePathSchema = relativePathSchema.describe(
  "Path to a .tscn scene file, relative to project_path. May not exist yet " +
    "when creating a new scene.",
);

/**
 * Absolute path to a directory to search for Godot projects under
 * (`list_projects`). Unlike `projectPathSchema`, this directory is not
 * required to itself contain a `project.godot` - it is just the search
 * boundary the bounded walk starts from.
 */
export const directoryPathSchema = z
  .string()
  .min(1, "directory must not be empty.")
  .describe("Absolute path to a directory to search for Godot projects (project.godot files).");
