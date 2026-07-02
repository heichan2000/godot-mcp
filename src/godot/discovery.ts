import {
  existsSync as existsSyncFs,
  readdirSync as readdirSyncFs,
  readFileSync as readFileSyncFs,
} from "node:fs";
import path from "node:path";

/**
 * Minimal shape `listProjectDirs`/`countProjectFiles` need from a directory
 * entry - matches `fs.Dirent` but is deliberately narrow so tests can inject
 * plain object literals instead of real `Dirent`s.
 *
 * Note on symlinks: a symlinked entry reports `false` for BOTH
 * `isDirectory()` and `isFile()` (`fs.Dirent` describes the link itself,
 * never its target), so symlinks are intentionally invisible to both
 * walkers in this module - a deliberate choice that prevents symlink
 * cycles from defeating the depth bounds and keeps results scoped to a
 * directory's real contents.
 */
export interface DirEntryLike {
  name: string;
  isDirectory(): boolean;
  isFile(): boolean;
}

/** Default depth `list_projects` walks when `max_depth` is omitted (godot-prd.md §6.1/§7.2a). */
export const DEFAULT_LIST_PROJECTS_MAX_DEPTH = 3;

/**
 * Hard ceiling on `max_depth` regardless of what a caller requests. Never a
 * validation error - a requested depth above this is silently clamped, so an
 * overly large `max_depth` degrades to "as deep as we allow" rather than
 * failing the call outright. `list_projects` is a filesystem-search tool an
 * agent controls directly (unlike an internal config default), so bounding
 * it defensively still matters even though its own home directory is not
 * unusually deep - this exists to rule out an accidental multi-terabyte or
 * symlink-cycle-adjacent walk from a mistyped `directory`.
 */
export const HARD_MAX_LIST_PROJECTS_DEPTH = 10;

/**
 * Caps the number of `project.godot` hits `list_projects` returns, however
 * many exist under `directory`. Guards against a huge/misdirected walk (e.g.
 * accidentally pointed at a home or drive root) returning an enormous
 * payload; `truncated: true` on the result tells the caller more may exist.
 */
export const MAX_LIST_PROJECTS_RESULTS = 200;

/**
 * Directory names always skipped during a walk, regardless of the hidden
 * (dot-prefixed) check below - dependency/VCS/OS-managed directories that
 * are never themselves a Godot project and can be huge (godot-prd.md §7.2a).
 * Godot's own `.godot/` cache directory is included so re-scanning a project
 * that has already been imported doesn't walk into its cache.
 */
const SKIPPED_DIR_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  ".godot",
  ".import",
  "node_modules",
  "appdata",
  "$recycle.bin",
  "system volume information",
  "__pycache__",
]);

function isHiddenOrSystemDir(name: string): boolean {
  if (name.startsWith(".")) return true;
  return SKIPPED_DIR_NAMES.has(name.toLowerCase());
}

function isSkippableFsError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "EACCES" || code === "EPERM" || code === "ENOENT" || code === "ENOTDIR";
}

export interface FsWalkDeps {
  /** Overridable for tests; defaults to the real filesystem. */
  readdirSync?: (dir: string) => DirEntryLike[];
}

function defaultReaddir(dir: string): DirEntryLike[] {
  return readdirSyncFs(dir, { withFileTypes: true });
}

export interface ListProjectsOptions {
  /**
   * Whether to search subdirectories at all. Defaults to `true`. When
   * `false`, only `directory` itself is checked for `project.godot` - no
   * subdirectories are read.
   */
  recursive?: boolean;
  /**
   * Maximum subdirectory depth to descend (0 = `directory` itself only).
   * Defaults to `DEFAULT_LIST_PROJECTS_MAX_DEPTH`; always clamped to
   * `HARD_MAX_LIST_PROJECTS_DEPTH` regardless of what is requested.
   */
  maxDepth?: number;
}

export interface ListProjectsResult {
  /** Absolute paths of directories directly containing a project.godot. */
  projects: string[];
  /** True when the walk stopped early because MAX_LIST_PROJECTS_RESULTS was hit. */
  truncated: boolean;
}

/**
 * Bounded, depth-capped search for `project.godot` files under `directory`
 * (godot-prd.md §6.1 `list_projects`, §7.2a). Deliberately never a whole-disk
 * walk: depth is capped (default `DEFAULT_LIST_PROJECTS_MAX_DEPTH`, hard
 * ceiling `HARD_MAX_LIST_PROJECTS_DEPTH`), hidden and known system/dependency
 * directories are skipped, and the result count is capped at
 * `MAX_LIST_PROJECTS_RESULTS`.
 *
 * A directory containing `project.godot` is still recursed into (nested
 * Godot projects, e.g. addons vendored as separate projects, are found too)
 * as long as the depth cap allows it.
 *
 * Read errors on `directory` itself (the top-level call) propagate - a
 * caller passing a nonexistent or inaccessible search root gets a real
 * error, not a silently empty result. Read errors on any *subdirectory*
 * encountered while walking (e.g. `EACCES`/`EPERM` on a locked-down folder)
 * are swallowed and that subtree is simply skipped, so one unreadable folder
 * never aborts discovery of everything else under `directory`.
 */
export function listProjectDirs(
  directory: string,
  options: ListProjectsOptions = {},
  deps: FsWalkDeps = {},
): ListProjectsResult {
  const readdir = deps.readdirSync ?? defaultReaddir;
  const recursive = options.recursive ?? true;
  const requestedDepth = options.maxDepth ?? DEFAULT_LIST_PROJECTS_MAX_DEPTH;
  const maxDepth = recursive
    ? Math.min(Math.max(requestedDepth, 0), HARD_MAX_LIST_PROJECTS_DEPTH)
    : 0;

  const projects: string[] = [];
  let truncated = false;

  function visit(dir: string, depth: number): void {
    if (projects.length >= MAX_LIST_PROJECTS_RESULTS) {
      truncated = true;
      return;
    }

    let entries: DirEntryLike[];
    if (depth === 0) {
      // Top-level search root: let a read failure propagate so the caller
      // sees a real error instead of a confusing empty result.
      entries = readdir(dir);
    } else {
      try {
        entries = readdir(dir);
      } catch (error) {
        if (isSkippableFsError(error)) return;
        throw error;
      }
    }

    if (entries.some((entry) => entry.isFile() && entry.name === "project.godot")) {
      projects.push(dir);
      if (projects.length >= MAX_LIST_PROJECTS_RESULTS) {
        truncated = true;
        return;
      }
    }

    if (depth >= maxDepth) return;

    for (const entry of entries) {
      // Symlinked entries fail isDirectory() and are skipped - intentional,
      // see the DirEntryLike doc comment.
      if (!entry.isDirectory() || isHiddenOrSystemDir(entry.name)) continue;
      visit(path.join(dir, entry.name), depth + 1);
      if (projects.length >= MAX_LIST_PROJECTS_RESULTS) {
        truncated = true;
        return;
      }
    }
  }

  visit(directory, 0);
  return { projects, truncated };
}

/** Recognized asset file extensions counted separately by `countProjectFiles`. */
const ASSET_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".bmp",
  ".webp",
  ".svg",
  ".hdr",
  ".exr",
  ".ogg",
  ".wav",
  ".mp3",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".obj",
  ".fbx",
  ".gltf",
  ".glb",
  ".dae",
  ".gdshader",
  ".shader",
]);

/**
 * Hard ceiling on how deep `countProjectFiles`' walk descends below the
 * project root. Same defensive rationale as `HARD_MAX_LIST_PROJECTS_DEPTH`:
 * a `project.godot` sitting at the root of an enormous tree must not turn
 * `get_project_info` into an unbounded synchronous walk. Real Godot projects
 * comfortably fit within 10 levels; anything cut off is reported via the
 * result's `truncated` flag rather than silently.
 */
export const MAX_PROJECT_FILE_WALK_DEPTH = 10;

/**
 * Hard ceiling on how many files `countProjectFiles` counts before stopping.
 * When hit, `fileCount` is exactly this value, `assetCount` covers only the
 * files seen up to that point, and `truncated` is `true` - counts become
 * lower bounds ("at least this many"), never an aborted call.
 */
export const MAX_PROJECT_FILE_COUNT = 10_000;

export interface ProjectFileCounts {
  /** Total regular files under the project, excluding hidden/system/cache directories. */
  fileCount: number;
  /** Subset of fileCount recognized as importable asset files (images/audio/fonts/models/shaders). */
  assetCount: number;
  /**
   * True when the walk stopped early (depth past MAX_PROJECT_FILE_WALK_DEPTH
   * or MAX_PROJECT_FILE_COUNT files reached), making both counts lower
   * bounds rather than exact totals.
   */
  truncated: boolean;
}

/**
 * Recursively counts files under `projectPath` for `get_project_info`,
 * skipping the same hidden/system/cache directories `listProjectDirs` does
 * (notably `.godot/`, so a project's own import cache never inflates the
 * count). `assetCount` is a subset of `fileCount`: files whose extension is
 * a recognized importable asset type (textures, audio, fonts, 3D models,
 * shaders) - scripts (`.gd`), scenes (`.tscn`), and `project.godot` itself
 * count toward `fileCount` but not `assetCount`.
 *
 * Bounded like `listProjectDirs` (godot-prd.md §7.2a's discipline applies to
 * every discovery walk, not just list_projects): descends at most
 * `MAX_PROJECT_FILE_WALK_DEPTH` levels and counts at most
 * `MAX_PROJECT_FILE_COUNT` files, setting `truncated` when either bound
 * cuts the walk short - so a project.godot at the root of a huge tree can
 * never trigger an unbounded synchronous walk.
 */
export function countProjectFiles(projectPath: string, deps: FsWalkDeps = {}): ProjectFileCounts {
  const readdir = deps.readdirSync ?? defaultReaddir;
  let fileCount = 0;
  let assetCount = 0;
  let truncated = false;

  function visit(dir: string, depth: number): void {
    let entries: DirEntryLike[];
    try {
      entries = readdir(dir);
    } catch (error) {
      if (isSkippableFsError(error)) return;
      throw error;
    }

    for (const entry of entries) {
      if (fileCount >= MAX_PROJECT_FILE_COUNT) {
        truncated = true;
        return;
      }
      // Symlinked entries fail both isDirectory() and isFile() and are
      // skipped - intentional, see the DirEntryLike doc comment.
      if (entry.isDirectory()) {
        if (isHiddenOrSystemDir(entry.name)) continue;
        if (depth >= MAX_PROJECT_FILE_WALK_DEPTH) {
          truncated = true;
          continue;
        }
        visit(path.join(dir, entry.name), depth + 1);
        continue;
      }
      if (!entry.isFile()) continue;
      fileCount += 1;
      if (ASSET_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        assetCount += 1;
      }
    }
  }

  visit(projectPath, 0);
  return { fileCount, assetCount, truncated };
}

export interface ProjectGodotInfo {
  name: string | undefined;
  godotVersion: string | undefined;
  configVersion: number | undefined;
}

/**
 * Parses the handful of `project.godot` fields `get_project_info` needs.
 * `project.godot` is a Godot-flavored INI file - this is a deliberately
 * narrow line-based extraction (not a general INI parser) for exactly the
 * three fields consumed here: `config/name`, the first version-looking
 * entry in `config/features`'s `PackedStringArray(...)` literal (Godot
 * writes the engine's major.minor as the first feature tag, e.g. `"4.3"`),
 * and `config_version`.
 */
export function parseProjectGodot(contents: string): ProjectGodotInfo {
  const nameMatch = /^config\/name="((?:[^"\\]|\\.)*)"/m.exec(contents);
  const name = nameMatch ? nameMatch[1]!.replace(/\\"/g, '"') : undefined;

  const configVersionMatch = /^config_version=(\d+)/m.exec(contents);
  const configVersion = configVersionMatch ? Number(configVersionMatch[1]) : undefined;

  const featuresMatch = /^config\/features=PackedStringArray\(([^)]*)\)/m.exec(contents);
  let godotVersion: string | undefined;
  if (featuresMatch) {
    const items = featuresMatch[1]!.split(",").map((item) => item.trim().replace(/^"|"$/g, ""));
    godotVersion = items.find((item) => /^\d+(\.\d+)*$/.test(item));
  }

  return { name, godotVersion, configVersion };
}

export interface ProjectInfo extends ProjectGodotInfo, ProjectFileCounts {}

export interface ReadProjectInfoDeps {
  /** Overridable for tests; defaults to the real filesystem. */
  existsSync?: (candidate: string) => boolean;
  readFileSync?: (candidate: string) => string;
  readdirSync?: FsWalkDeps["readdirSync"];
}

/**
 * Backs `get_project_info`: returns `null` when `projectPath` has no
 * `project.godot` (the caller turns that into a guided structured error),
 * otherwise the parsed name/version plus file/asset counts.
 */
export function readProjectInfo(
  projectPath: string,
  deps: ReadProjectInfoDeps = {},
): ProjectInfo | null {
  const existsSync = deps.existsSync ?? existsSyncFs;
  const readFileSync =
    deps.readFileSync ?? ((candidate: string) => readFileSyncFs(candidate, "utf8"));

  const projectGodotPath = path.join(projectPath, "project.godot");
  if (!existsSync(projectGodotPath)) return null;

  const parsed = parseProjectGodot(readFileSync(projectGodotPath));
  const counts = countProjectFiles(projectPath, { readdirSync: deps.readdirSync });

  return { ...parsed, ...counts };
}
