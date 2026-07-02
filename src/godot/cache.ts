import { existsSync as existsSyncFs, readdirSync as readdirSyncFs } from "node:fs";
import path from "node:path";

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
