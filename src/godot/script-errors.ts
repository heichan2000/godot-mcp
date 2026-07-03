/**
 * Best-effort parsing for `get_script_errors` (see tools/readback.ts and
 * godot-prd.md §6.2). Godot exposes no error API for `--check-only`; the
 * only signal available is its human-readable stderr text, which these
 * regexes match against real, locally-captured Godot 4.x output (see
 * task-10-report.md for the exact repro). A stderr format change in a future
 * Godot release will make these silently return fewer/no structured
 * entries - by design, `raw` (the caller's responsibility, not this module's)
 * always carries the untouched stderr text so nothing is lost, and the
 * integration tests pin this exact shape so drift fails CI instead of
 * passing quietly.
 */

export interface ScriptErrorEntry {
  file: string;
  line: number;
  message: string;
}

/**
 * A GDScript parse/compile failure under `--check-only` prints as a pair of
 * lines:
 *   SCRIPT ERROR: <message>
 *      at: GDScript::reload (res://path/to/script.gd:<line>)
 * A single broken script can produce more than one such pair (e.g. a typed
 * assignment mismatch reports both the assignment-site and the
 * declaration-site error) - both are kept as separate entries, not deduped,
 * since they can carry distinct messages/lines.
 */
const SCRIPT_ERROR_LINE = /^SCRIPT ERROR: (.+)$/;
const RELOAD_LOCATION_LINE = /^\s*at: GDScript::reload \((.+):(\d+)\)$/;

/**
 * Extracts every `{file, line, message}` triple this shape can be found in
 * `stderr`. Never throws - an unrecognized or absent shape (a Godot stderr
 * format change, or stderr from an unrelated failure like a missing script
 * file) simply yields fewer or zero entries.
 */
export function parseCheckOnlyStderr(stderr: string): ScriptErrorEntry[] {
  const lines = stderr.split(/\r?\n/);
  const entries: ScriptErrorEntry[] = [];

  for (let i = 0; i < lines.length - 1; i++) {
    const currentLine = lines[i];
    const nextLine = lines[i + 1];
    if (currentLine === undefined || nextLine === undefined) continue;

    const errorMatch = SCRIPT_ERROR_LINE.exec(currentLine);
    if (!errorMatch) continue;
    const locationMatch = RELOAD_LOCATION_LINE.exec(nextLine);
    if (!locationMatch) continue;

    const message = errorMatch[1];
    const file = locationMatch[1];
    const lineNumberText = locationMatch[2];
    if (message === undefined || file === undefined || lineNumberText === undefined) continue;

    entries.push({ message, file, line: Number(lineNumberText) });
  }

  return entries;
}

/** Matches one `.tscn` `[ext_resource ...]` header line, capturing its attribute text. */
const EXT_RESOURCE_LINE = /^\[ext_resource\b([^\]]*)\]/;
const TYPE_ATTR = /\btype="([^"]*)"/;
const PATH_ATTR = /\bpath="([^"]*)"/;

/**
 * Extracts the `res://` path of every `[ext_resource type="Script" ...]`
 * entry in a `.tscn` file's text - i.e. every external script the scene
 * assigns to one of its nodes. Attribute order within the bracket
 * (`type="Script" path="..."` vs `path="..." type="Script"`) does not
 * matter; each attribute is matched independently. Scripts embedded inline
 * as a `sub_resource` (rather than referencing an external `.gd` file) are
 * not covered - `--check-only` operates on a script *file*, so only
 * external, file-backed scripts can be checked this way.
 */
export function extractSceneScriptPaths(sceneText: string): string[] {
  const paths: string[] = [];

  for (const rawLine of sceneText.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = EXT_RESOURCE_LINE.exec(line);
    if (!match) continue;

    const attrs = match[1];
    if (attrs === undefined) continue;

    const typeMatch = TYPE_ATTR.exec(attrs);
    if (!typeMatch || typeMatch[1] !== "Script") continue;

    const pathMatch = PATH_ATTR.exec(attrs);
    const scriptPath = pathMatch?.[1];
    if (scriptPath === undefined) continue;

    paths.push(scriptPath);
  }

  return paths;
}
