import { existsSync as existsSyncFs, readdirSync as readdirSyncFs } from "node:fs";
import path from "node:path";
import { createErrorResponse, type ErrorResponse } from "../errors.js";

export interface CacheCheckOptions {
  /** Overridable for tests; defaults to the real filesystem. */
  existsSync?: (candidate: string) => boolean;
  readdirSync?: (candidate: string) => string[];
}

/**
 * True when `<projectPath>/.godot/` exists at all - the broad signal that
 * Godot has completed at least one project init pass (editor boot or
 * `--import`) against this project, regardless of whether any asset needed
 * importing. Used only to determine whether `import_project` actually ran
 * to completion; independent of exit code (Godot's `--import` has been
 * observed to exit 0 even when an individual asset fails to import - see
 * runner.ts's `runGodotImport` and tools/project.ts). Not the right check
 * for "is it safe to load a texture" - use `hasImportCache` for that.
 */
export function hasGodotCacheDir(projectPath: string, options: CacheCheckOptions = {}): boolean {
  const exists = options.existsSync ?? existsSyncFs;
  return exists(path.join(projectPath, ".godot"));
}

/**
 * True when the project's Godot import cache is actually built:
 * `.godot/imported/` exists and contains at least one entry. Empirically
 * verified against Godot 4.6.3 (see task-49 report):
 *
 * - Before any import runs, `.godot` does not exist at all.
 * - A plain dispatcher invocation (`create_scene`/`add_node`, via
 *   `--script`) never creates `.godot` either - only
 *   `godot --headless --import` (or opening the project in the editor)
 *   does. So this check never produces a false positive from ordinary
 *   scene-editing calls.
 * - After `--import` runs on a project with at least one importable asset,
 *   `.godot/imported/` contains a `.ctex`/`.md5` pair per imported asset.
 * - On a project with zero importable assets, `.godot/imported/` is
 *   created but stays empty - hence the non-emptiness check here, rather
 *   than existence alone (see `hasGodotCacheDir` for the broader signal
 *   `import_project` itself uses to judge whether the run completed).
 *
 * Asset-dependent ops (e.g. `load_sprite`) call this BEFORE invoking Godot
 * at all, so a cold project fails fast with a guided error instead of
 * paying for a Godot boot only to have `load()` return null ("No loader
 * found for resource").
 */
export function hasImportCache(projectPath: string, options: CacheCheckOptions = {}): boolean {
  const exists = options.existsSync ?? existsSyncFs;
  const readdir = options.readdirSync ?? readdirSyncFs;
  const importedDir = path.join(projectPath, ".godot", "imported");
  if (!exists(importedDir)) return false;
  try {
    return readdir(importedDir).length > 0;
  } catch {
    return false;
  }
}

/**
 * Guided error for any asset-dependent tool called against a project with no
 * built import cache. Headless Godot cannot `load()` an unimported asset
 * (see `hasImportCache`'s doc comment for the empirically-verified marker
 * this checks), and no such tool imports implicitly, so every caller shows
 * this instead of a slow, confusing Godot failure. Shared by
 * `tools/scene.ts`'s `load_sprite` and `tools/uid.ts`'s `get_uid` - both
 * need the project scanned/imported at least once before their underlying
 * Godot call can succeed (`load_sprite` to `load()` a texture,
 * `get_uid` because `ResourceLoader.get_resource_uid` only recognizes a
 * uid:// once a project scan - which `--import` triggers - has read it off
 * disk, whether from a `.uid` sidecar or an embedded `uid=` header).
 */
export function coldImportCacheError(projectPath: string): ErrorResponse {
  return createErrorResponse({
    message:
      `Project at "${projectPath}" has no built Godot import cache yet ` +
      "(.godot/imported/ is missing or empty). Headless Godot cannot load a texture or other " +
      "importable asset, or recognize a resource's UID, until the project has been imported at " +
      "least once.",
    possibleSolutions: [
      "Run import_project with this project_path first to build the cache, then retry.",
      "If you just added or changed asset files, re-run import_project to refresh the cache.",
    ],
  });
}
