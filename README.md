# @cradial/godot-mcp

An MCP (Model Context Protocol) server that bridges AI agents to the [Godot 4](https://godotengine.org/) game engine over stdio. Point an MCP-capable client (Claude Desktop, Claude Code, Cursor, Cline, ...) at it and the agent gets 19 tools to open, edit, run, and inspect a Godot 4 project — including a real write-then-read-back verify loop, so it can confirm a change actually landed instead of guessing.

- **stdio-only** transport, MIT-licensed, published as an `npx`-runnable package.
- Requires **Node.js >= 20** and a **Godot 4.x** executable installed separately (this package does not bundle Godot itself).
- No telemetry. Nothing leaves your machine except what you point it at.

## Table of contents

- [Quickstart](#quickstart)
- [Per-client setup](#per-client-setup)
  - [Claude Desktop](#claude-desktop)
  - [Cursor](#cursor)
  - [Cline](#cline)
  - [Local development (no npm registry)](#local-development-no-npm-registry)
- [The sample project](#the-sample-project)
- [Tool reference](#tool-reference)
  - [Editor & version](#editor--version)
  - [Project management](#project-management)
  - [Running & debugging](#running--debugging)
  - [Scene authoring](#scene-authoring)
  - [Resource UIDs (Godot >= 4.4)](#resource-uids-godot--44)
  - [Read-back / verification](#read-back--verification)
- [Value encoding](#value-encoding)
- [Error shape](#error-shape)
- [Configuration reference](#configuration-reference)
- [Security & least privilege](#security--least-privilege)
- [License](#license)

## Quickstart

You need a Godot 4.x executable on the machine already ([download](https://godotengine.org/download)). The server finds it via, in order: an explicit `GODOT_PATH`, then a short list of common per-OS install locations. If it can't find one, every tool call that needs Godot returns a structured error telling you what it checked and how to fix it — it never silently falls back to a wrong binary.

Register the server with a single command (this example uses the Claude Code CLI; see [per-client setup](#per-client-setup) for other clients):

```bash
claude mcp add godot -- npx @cradial/godot-mcp
```

Then, from the agent, call `get_godot_version` with no arguments — it should return a `4.x.y` version string. That confirms the server is running and Godot resolution works.

From there, [`examples/sample-project`](examples/sample-project) is a minimal Godot 4 project you can point tools at right away to try the rest of the toolset, for example:

1. `get_godot_version` — confirm Godot resolves.
2. `create_scene` with `project_path` set to your checkout's `examples/sample-project` and a new `scene_path` like `scenes/demo.tscn`.
3. `get_scene_tree` on that same scene — see the root node you just created.
4. `add_node` to attach a child node (try a `properties` value like `{"position": "Vector2(100, 50)"}`).
5. `get_scene_tree` again, then `read_node_properties` on the new node — confirm the position round-trips as the same string.

## Per-client setup

Every client below launches the same command: `npx @cradial/godot-mcp`. Set `GODOT_PATH` in the server's env if autodetection won't find your Godot install (see [configuration reference](#configuration-reference)).

### Claude Desktop

Edit your `claude_desktop_config.json` ([location varies by OS](https://modelcontextprotocol.io/quickstart/user)) and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@cradial/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/your/godot"
      }
    }
  }
}
```

Restart Claude Desktop after saving.

### Cursor

Add to `.cursor/mcp.json` (project-local) or Cursor's global MCP settings:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@cradial/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/your/godot"
      }
    }
  }
}
```

### Cline

In Cline's MCP settings (VS Code: `cline_mcp_settings.json`, reachable from Cline's "MCP Servers" panel), add:

```json
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@cradial/godot-mcp"],
      "env": {
        "GODOT_PATH": "/path/to/your/godot"
      },
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

### Local development (no npm registry)

Working from a clone instead of the published package:

```bash
git clone https://github.com/heichan2000/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

Then point any client's `command`/`args` at the built entrypoint directly instead of `npx`:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/dist/index.js"],
      "env": {
        "GODOT_PATH": "/path/to/your/godot"
      }
    }
  }
}
```

Or with the Claude Code CLI: `claude mcp add godot -- node /absolute/path/to/godot-mcp/dist/index.js`.

## The sample project

[`examples/sample-project`](examples/sample-project) is a tiny Godot 4 project checked into this repo, used both by the integration test suite and as a safe, disposable playground for the quickstart above: a `project.godot`, a couple of scenes, a script, and one texture — enough to exercise every tool without risking a real project.

## Tool reference

All tool and parameter names are `snake_case`. `project_path` is an **absolute** path to the directory directly containing `project.godot`; every other path parameter is **relative to `project_path`** and is checked for containment before touching disk (see [Security & least privilege](#security--least-privilege)) — absolute paths, `..` segments, and symlink/junction escapes are all rejected with a structured error, not silently normalized.

### Editor & version

| Tool                | Parameters     | Behavior                                                                                                                                                                                 |
| ------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_godot_version` | _(none)_       | Returns the version string reported by the resolved Godot 4.x executable (`--version`), re-probed fresh on every call.                                                                   |
| `launch_editor`     | `project_path` | Opens the Godot editor GUI for the project, detached from this server's own process — the editor keeps running after the server exits. Returns immediately once the process has started. |

### Project management

| Tool               | Parameters                              | Behavior                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------ | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `import_project`   | `project_path`                          | Runs `godot --headless --import` to (re)build the project's asset import cache. Required before any asset-dependent tool (e.g. `load_sprite`) can load a texture — those tools check for the cache first and point back here with a guided error rather than importing implicitly. Can be slow on large projects.                                                                                            |
| `list_projects`    | `directory`, `recursive?`, `max_depth?` | Finds directories directly containing `project.godot` under `directory`. A bounded, depth-capped filesystem walk (default depth 3, hard ceiling regardless of what's requested) that always skips hidden/system directories (`.git`, `node_modules`, `AppData`, the OS recycle bin, ...) and caps the number of results returned — never a whole-disk search. Pure filesystem search; does not invoke Godot. |
| `get_project_info` | `project_path`                          | Returns the project's name, engine version (from `project.godot`), and file/asset counts (bounded walk; large projects report a lower bound and flag it). Pure filesystem read; does not invoke Godot.                                                                                                                                                                                                       |

### Running & debugging

Godot runs are single-process: starting a new `run_project` replaces (and stops) whatever was already active, and its output buffer resets with it.

| Tool               | Parameters                            | Behavior                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `run_project`      | `project_path`, `scene?`, `headless?` | Runs the project (or a specific `.tscn` scene). **Windowed by default** (a visible Godot window opens); pass `headless: true` for a log-only run with no window (CI/agent use). Output is captured into a bounded ring buffer either way. Returns immediately once the process has started. |
| `get_debug_output` | _(none)_                              | Returns `{ output: string[], errors: string[] }` (stdout/stderr, captured separately) from the active or most recently finished run, without disturbing it. Structured error if `run_project` hasn't been called yet, or its buffer was already cleared.                                    |
| `stop_project`     | _(none)_                              | Kills the active run and returns its captured output tail as `{ output, errors }`, then clears the tracked process. Structured error if nothing is running.                                                                                                                                 |

### Scene authoring

| Tool                  | Parameters                                                                                 | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------- | ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `create_scene`        | `project_path`, `scene_path`, `root_node_type?`                                            | Creates a new `.tscn` scene with a single root node (default `Node2D`). `scene_path` must not already exist.                                                                                                                                                                                                                                                                                                                                                                                             |
| `add_node`            | `project_path`, `scene_path`, `node_type`, `node_name`, `parent_node_path?`, `properties?` | Adds a node under `parent_node_path` (the scene root when omitted) and saves the scene in place. `node_type` is validated against Godot's own ClassDB at call time (must exist, extend/be `Node`, and be directly instantiable) — no curated allow-list, but script classes, `res://` paths, and abstract/editor-only classes are rejected. `properties` sets values via `set()` using the [shared value encoding](#value-encoding); an unknown property name is a structured error, not a silent no-op. |
| `load_sprite`         | `project_path`, `scene_path`, `node_path?`, `texture_path`                                 | Assigns a texture to a `Sprite2D`/`Sprite3D` node (the scene root when `node_path` is omitted) and saves the scene. Requires the project's import cache to already exist — returns a guided error naming `import_project` otherwise.                                                                                                                                                                                                                                                                     |
| `save_scene`          | `project_path`, `scene_path`, `new_path?`                                                  | Re-saves `scene_path` in place, or performs a "save as" to `new_path` (which must not already exist) leaving the original untouched.                                                                                                                                                                                                                                                                                                                                                                     |
| `export_mesh_library` | `project_path`, `scene_path`, `output_path`, `mesh_item_names?`                            | Exports every `MeshInstance3D` in the scene with an assigned mesh as one item in a new `MeshLibrary` resource at `output_path` (always overwritten). `mesh_item_names` optionally restricts the export to a named subset.                                                                                                                                                                                                                                                                                |

### Resource UIDs (Godot >= 4.4)

These two tools are always listed, but every call is version-gated at request time against the resolved Godot's `--version` output — calling either on Godot < 4.4 returns a structured "requires Godot >= 4.4" error rather than the tool simply being hidden. This is distinct from `list_resources`' `uid` field below, which reflects a different, older mechanism for imported assets.

| Tool                  | Parameters                  | Behavior                                                                                                                                                                                                                                                                                                        |
| --------------------- | --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `get_uid`             | `project_path`, `file_path` | Returns the `uid://...` already assigned to `file_path`. Requires the import cache to exist (like `load_sprite`). A resource authored before 4.4 (or never resaved since) may have no UID yet — run `update_project_uids` first if so.                                                                          |
| `update_project_uids` | `project_path`              | Ensures every `.tscn`/`.tres` resource under the project has a `uid://` embedded in its header, generating one for any that lack it (existing UIDs are left untouched), then re-runs the import cache so the change is immediately visible. Returns which resources were touched, already had a UID, or failed. |

### Read-back / verification

The read-back tools close the write -> verify loop: after mutating a scene, an agent can confirm the change actually landed instead of trusting its own write call.

| Tool                   | Parameters                                               | Behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ---------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get_scene_tree`       | `project_path`, `scene_path`                             | Returns the scene's full node tree as nested `{ name, type, path, children[] }`. `path` is root-relative (`"."` for the root itself, e.g. `"Body/Hero"` for a nested node) and is directly reusable as `node_path`/`parent_node_path` input to other tools.                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `read_node_properties` | `project_path`, `scene_path`, `node_path`, `properties?` | Without `properties`: returns only the properties actually stored in the `.tscn` for that node (its non-default state) — never the engine's ~40+ default properties. With `properties` (a list of names): fetches those specific named properties from the live node via `get()`, returned even if they still hold the class default. Values use the [shared encoding](#value-encoding), so a value `add_node` wrote as `"Vector2(100, 50)"` reads back as that identical string.                                                                                                                                                                                                                                              |
| `get_script_errors`    | `project_path`, `scene_path?` \| `script_path?`          | Best-effort GDScript error read-back via `godot --check-only` (exactly one of `scene_path`/`script_path` required). Returns `{ errors: [{file, line, message}], raw }` — `errors` is a best-effort regex parse of Godot's stderr (Godot exposes no structured error API); `raw` always carries the full untouched stderr so a missed parse never loses information.                                                                                                                                                                                                                                                                                                                                                            |
| `list_resources`       | `project_path`, `type?`                                  | Returns `{ resources: [{ path, type, uid? }] }` for every resource under the project (`res://`), for discovery before referencing one elsewhere. `type` optionally narrows to a class or any of its subclasses (e.g. `"Texture2D"` also matches an imported PNG's actual class `CompressedTexture2D`). `uid` is included only when Godot recognizes one for that resource: **imported assets (textures, etc.) have had resource UIDs since Godot 4.0** as long as the project has been imported at least once; scripts and scenes only get a UID through the `.uid`-sidecar mechanism added in **Godot 4.4** (`get_uid`/`update_project_uids`). Either way it's simply omitted, never an error, when no UID is recognized yet. |

## Value encoding

Every non-trivial tool parameter and read-back result that carries a Godot value (`add_node`'s `properties`, `read_node_properties`'s results, ...) uses one symmetric encoding, in both directions:

- **JSON primitives** (`bool`, `int`/`float`, `string`) travel natively — a JSON `true`, `42`, or `"hello"` stays exactly that.
- **Every other Godot type** (`Vector2`, `Color`, `NodePath`, `Rect2`, arrays, dictionaries, ...) travels as the text form Godot's own `var_to_str` produces and `str_to_var` parses back — e.g. `"Vector2(100, 50)"`, `"Color(1, 0, 0, 1)"`, `'NodePath("../Foo")'`. This is exactly the syntax already used inside `.tscn` files, so an agent that has read a scene already knows the encoding.

One caveat this trade-off accepts: a string value that happens to look like another Godot literal (e.g. the literal string `"true"` or `"123"`) decodes as that literal, not as a plain string, because decoding always tries `str_to_var` first. To send a literal string that would otherwise be ambiguous, quote it `var_to_str`-style (`"\"42\""` decodes to the string `"42"`), or prefer sending real JSON primitives for booleans/numbers in the first place.

## Error shape

Every tool failure — a path containment violation, a missing Godot executable, an unrecognized node type, a dispatcher-reported operation error, a timeout — returns the same structured shape: an MCP `CallToolResult` with `isError: true`, human-readable text in `content` describing what went wrong plus a "Possible solutions" list, and the same data machine-readable in `structuredContent`:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Path \"../../etc/passwd\" resolves outside the project root \"...\".\n\nPossible solutions:\n- Remove any \"..\" segments so the resolved path stays inside project_path.\n- If the path passes through a symlink or junction, make sure the link target is inside project_path."
    }
  ],
  "structuredContent": {
    "message": "Path \"../../etc/passwd\" resolves outside the project root \"...\".",
    "possibleSolutions": [
      "Remove any \"..\" segments so the resolved path stays inside project_path.",
      "If the path passes through a symlink or junction, make sure the link target is inside project_path."
    ]
  }
}
```

`possibleSolutions` is always tailored to the specific failure (a stale import cache gets pointed at `import_project`; a bad node type gets pointed at the ClassDB rule; a hung process gets pointed at `DEBUG=1`), never a generic "something went wrong."

## Configuration reference

All configuration is via environment variables, read once at server startup.

| Key                   | Type | Default        | Purpose                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------- | ---- | -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GODOT_PATH`          | path | _(autodetect)_ | Explicit path to the Godot 4.x executable. When set, this is the **only** path tried — an invalid `GODOT_PATH` fails with a guided error rather than silently falling back to autodetection. When unset, the server searches a short list of common per-OS install locations (Program Files / Steam on Windows, `/Applications` and Homebrew on macOS, `/usr/bin`, snap, and Flatpak on Linux). |
| `DEBUG`               | bool | `false`        | Enables verbose diagnostic logging to **stderr only** (stdout is reserved for the MCP stdio protocol and is never touched by this flag). Accepts `1`, `true`, `yes`, or `on` (case-insensitive); anything else is treated as false.                                                                                                                                                             |
| `OUTPUT_BUFFER_LINES` | int  | `1000`         | Maximum number of lines retained per stream (stdout and stderr, tracked separately) in `run_project`'s ring buffer, read back via `get_debug_output`. Older lines are dropped once the cap is hit rather than growing memory unbounded. Falls back to the default for anything unset, unparseable, non-integer, or non-positive.                                                                |

> **No `STRICT_PATHS` toggle.** Early designs sketched a `STRICT_PATHS` env var to relax path containment for local development. It was deliberately not implemented: containment is always on, with no off switch (see [Security & least privilege](#security--least-privilege)). Setting `STRICT_PATHS` to anything has no effect.

## Security & least privilege

- **Path containment is mandatory, not opt-in.** Every path parameter other than `project_path` itself is resolved relative to `project_path` and checked with a realpath-based containment algorithm before it ever touches the filesystem: the deepest _existing_ ancestor of the target is realpath'd (so a not-yet-created file, like a scene about to be created, is still handled), then the result must land strictly inside the project root. This is **not** a naive string-prefix (`startsWith`) check — those break under Windows case-insensitivity, 8.3 short names (`C:\PROGRA~1`), and UNC paths, and would also wrongly accept a sibling directory that merely shares a name prefix (`project` vs. `project-evil-twin`). An absolute path, a `..` traversal, or a symlink/junction that escapes the root is rejected with a structured error every time.
- **Defense in depth at two layers.** The same containment rule is enforced both in the TypeScript tool layer _and_ independently inside the bundled `operations.gd` GDScript dispatcher before it touches any file — a bug or bypass in one layer doesn't remove the other.
- **No shell, no injection.** Godot is always invoked via `execFile`/`spawn` with argument arrays; parameters cross into GDScript as JSON data on argv, never interpolated into a shell command string.
- **Node-type allow-listing without a maintained list.** `add_node`'s `node_type` is validated against Godot's own `ClassDB` at call time (must exist, extend `Node`, and be directly instantiable) — it can never be a script class name or a `res://` resource path, and abstract/editor-only classes are rejected. Property values are decoded with `str_to_var` only, which can construct value types (vectors, colors, arrays, ...) but can never load a `Resource` or execute code.
- **Bounded everything.** `list_projects`' filesystem walk is depth-capped and result-capped; `run_project`'s output capture is a bounded ring buffer. Neither a huge disk nor a noisy process run can exhaust memory or turn into an unbounded scan.
- **Strict Godot resolution, no silent fallback.** An explicitly configured `GODOT_PATH` that doesn't resolve is a hard, guided failure — the server never quietly substitutes a different Godot binary than the one you asked for.
- **Run this scoped to a projects directory, never as admin/root.** This server was designed to operate on Godot projects you already trust the agent to modify — it is not a sandbox against a malicious project. Run it as an unprivileged user, point `project_path` at a specific working directory (not `/` or `C:\`), and treat an agent with this tool available the same way you'd treat one with local filesystem write access, because that's what it has, scoped to whatever `project_path` you give it per call.

## License

MIT — see [LICENSE](LICENSE).
