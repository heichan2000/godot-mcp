# @cradial/godot-mcp

An MCP (Model Context Protocol) server that connects AI agents to the [Godot 4](https://godotengine.org/) **editor**. A small bridge addon runs inside the editor you already have open; the server talks to it over a loopback WebSocket and exposes 29 tools to scaffold projects, author scenes node-by-node, read everything back, run the game, and tail its output — all inside the live editor, with the editor's own undo history (Ctrl+Z reverts agent edits like any other edit).

- **stdio-only** MCP transport, MIT-licensed, published as an `npx`-runnable package.
- Requires **Node.js >= 20** and the **Godot 4.x editor** (this package does not bundle Godot itself).
- **You launch Godot yourself, from anywhere.** The server never starts, locates, or manages the Godot executable — it only connects to the editor you opened. A bare `Godot_v4.x-stable_win64.exe` in your Downloads folder works exactly as well as a system install.
- No telemetry. The only network endpoint in the whole system is the addon's bridge, bound to `127.0.0.1` — nothing leaves your machine (enforced by standing CI audits, not just policy).

> **Version note:** this branch is **v2 (addon-first), in alpha**. The npm `latest` tag is still the 1.x line — a different, headless architecture that spawns Godot per call. The 2.0 alpha ships on the `next` dist-tag. **Need headless/CI usage without an open editor? Stay on `@cradial/godot-mcp@1.x`.**

## Table of contents

- [How it works](#how-it-works)
- [Quickstart](#quickstart)
- [Per-client setup](#per-client-setup)
- [The sample project](#the-sample-project)
- [Tool overview](#tool-overview)
- [Value encoding](#value-encoding)
- [Error shape](#error-shape)
- [Configuration reference](#configuration-reference)
- [Security & least privilege](#security--least-privilege)
- [License](#license)

## How it works

Two pieces, connected over loopback:

1. **The MCP server** (this package, Node.js) — registered with your MCP client, speaks MCP over stdio on one side and the bridge protocol on the other.
2. **The bridge addon** (`addons/godot_mcp`, bundled inside this package) — an editor plugin that listens on `127.0.0.1:6510` and executes operations inside the editor: real `EditorInterface` scene edits, real undo history, real play sessions.

The server installs the addon into your project for you (the `install_addon` tool copies the bundled files — no separate download). When the editor with the enabled plugin is open, the bridge connects automatically and reconnects automatically if either side restarts. When no editor is open, every editor tool returns a structured error telling you exactly how to get connected — nothing hangs.

Because the _editor_ does the work, the server never needs to know where your Godot executable is. There is no `GODOT_PATH` to configure.

## Quickstart

Until the 2.0 alpha is published on npm, run the server from a clone:

```bash
git clone https://github.com/heichan2000/godot-mcp.git
cd godot-mcp
npm install
npm run build
```

Register it (this example uses the Claude Code CLI; see [per-client setup](#per-client-setup) for other clients):

```bash
claude mcp add godot -- node /absolute/path/to/godot-mcp/dist/index.js
```

Then, from the agent:

1. **`create_project`** with a path to a new/empty folder — scaffolds a valid Godot 4 project with the addon already installed. (Have an existing project instead? Call **`install_addon`** on it.)
2. Open the project in the Godot editor (double-click your Godot executable, wherever it lives, and import/open the folder).
3. Enable **"Godot MCP"** under **Project → Project Settings → Plugins**. The bridge starts immediately.
4. **`bridge_status`** — should report the connection, the editor's Godot version, and the project path. You're live.
5. Try the loop: `create_scene` → `add_node` (e.g. `properties: {"position": "Vector2(100, 50)"}`) → `get_scene_tree` → `read_node_properties` — the position reads back as the same string you wrote. Press Ctrl+Z in the editor and the node is gone.

Once the alpha is on npm, step one becomes `npx @cradial/godot-mcp@next` with no clone needed — watch the releases.

## Per-client setup

Every client launches the same command. No environment variables are required.

### Claude Desktop

Edit your `claude_desktop_config.json` ([location varies by OS](https://modelcontextprotocol.io/quickstart/user)) and add an entry under `mcpServers`:

```json
{
  "mcpServers": {
    "godot": {
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/dist/index.js"]
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
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/dist/index.js"]
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
      "command": "node",
      "args": ["/absolute/path/to/godot-mcp/dist/index.js"],
      "disabled": false,
      "autoApprove": []
    }
  }
}
```

Once the 2.0 alpha is published, replace `"command": "node", "args": [".../dist/index.js"]` with `"command": "npx", "args": ["-y", "@cradial/godot-mcp@next"]` in any of the blocks above.

## The sample project

[`examples/sample-project`](examples/sample-project) is a tiny Godot 4 project checked into this repo with the addon pre-enabled, used both by the integration test suite and as a safe, disposable playground: open it in the editor and every tool works on it immediately.

## Tool overview

All tool and parameter names are `snake_case`. Editor tools operate on **the project open in the connected editor**; file paths are `res://`-relative and are containment-checked at **both** layers (server and addon, independently) before touching anything — absolute paths, `..` traversal, and symlink escapes are rejected with a structured error, never silently normalized.

_A generated per-tool reference (parameters and result shapes) ships with the 2.0 release; until then, tool descriptions are always available live via your MCP client's tool listing._

**Bridge & versions** — `bridge_status` (connection state, handshake info, op queue depth), `get_godot_version` (editor + addon + server versions), `get_bridge_log` (recent bridge traffic for diagnosing connection issues).

**Onboarding** — `create_project` (scaffold a new Godot 4 project into an empty/new folder, addon included), `install_addon` (install/update the bundled bridge addon into an existing project and report the enable steps). These two are the bootstrap exceptions: they work with no editor connected, by writing files only.

**Project** — `list_projects` (find `project.godot` folders under a directory; bounded, depth-capped walk), `get_project_info` (name, engine version, main scene, autoloads, file counts), `list_resources` (every `res://` resource with path/type/uid, filterable), `import_assets` (import new/changed assets, or rescan the whole project).

**Scenes** — `create_scene`, `open_scene`, `get_open_scenes` (tabs + dirty flags), `save_scene` (in place, save-as, or all), `close_scene` (dirty-guarded), `get_scene_tree` (the live node tree, unsaved state included), `export_mesh_library` (scene meshes → `MeshLibrary` for GridMap).

**Nodes** — `add_node`, `remove_node` (returns a manifest of everything removed), `duplicate_node`, `move_node` (reparent/reorder), `rename_node`. Every mutation is registered with the editor's undo system — Ctrl+Z in the editor reverts it.

**Properties** — `read_node_properties` (stored non-default state by default, or specific named properties), `set_node_properties` (batch set; one undo step).

**Diagnostics** — `get_script_errors` (parse/compile diagnostics for one script or the whole project, from the editor's GDScript language server).

**Run & debug** — `run_project` (play the main scene, current scene, or a named scene from the editor), `stop_project`, `get_debug_output` (cursor-based tail of the captured game output ring buffer).

**Resource UIDs (Godot >= 4.4)** — `get_uid`, `update_project_uids`. Version-gated at call time against the connected editor's version: on an older editor they return a structured "requires Godot >= 4.4" error rather than disappearing.

## Value encoding

Every tool parameter and read-back result that carries a Godot value (`add_node`/`set_node_properties`' `properties`, `read_node_properties`' results, ...) uses one symmetric encoding, in both directions:

- **JSON primitives** (`bool`, `int`/`float`, `string`) travel natively — a JSON `true`, `42`, or `"hello"` stays exactly that.
- **Every other Godot type** (`Vector2`, `Color`, `NodePath`, `Rect2`, arrays, dictionaries, ...) travels as the text form Godot's own `var_to_str` produces and `str_to_var` parses back — e.g. `"Vector2(100, 50)"`, `"Color(1, 0, 0, 1)"`. This is exactly the syntax used inside `.tscn` files, so an agent that has read a scene already knows the encoding. A `res://` path assigned to a resource-typed property loads that resource.

One caveat this trade-off accepts: a string value that happens to look like another Godot literal (e.g. the literal string `"true"` or `"123"`) decodes as that literal, not as a plain string. To send a literal string that would otherwise be ambiguous, quote it `var_to_str`-style (`"\"42\""` decodes to the string `"42"`), or prefer real JSON primitives for booleans/numbers in the first place.

## Error shape

Every tool failure — editor not connected, a path containment violation, an unknown node type, a version-gated call, a timeout — returns the same structured shape: an MCP `CallToolResult` with `isError: true`, human-readable text in `content` describing what went wrong plus a "Possible solutions" list, and the same data machine-readable in `structuredContent`:

```json
{
  "isError": true,
  "content": [
    {
      "type": "text",
      "text": "Path \"../../etc/passwd\" resolves outside the project root \"...\".\n\nPossible solutions:\n- Remove any \"..\" segments so the resolved path stays inside the project.\n- Pass a res:// path inside the project."
    }
  ],
  "structuredContent": {
    "message": "Path \"../../etc/passwd\" resolves outside the project root \"...\".",
    "possibleSolutions": [
      "Remove any \"..\" segments so the resolved path stays inside the project.",
      "Pass a res:// path inside the project."
    ]
  }
}
```

`possibleSolutions` is always tailored to the specific failure (no editor connected points at `install_addon` and the Plugins checkbox; a bad node type points at the ClassDB rule; a stale connection points at `bridge_status`), never a generic "something went wrong."

## Configuration reference

All configuration is via environment variables, read once at server startup. **None are required** — defaults work out of the box.

| Key                   | Type | Default | Purpose                                                                                                                                                                                                                             |
| --------------------- | ---- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GODOT_MCP_PORT`      | int  | `6510`  | Loopback port the server dials to reach the editor bridge. Must match the addon's `godot_mcp/network/port` project setting if you change either side. Only needed when 6510 collides with something else on your machine.           |
| `BRIDGE_TIMEOUT_MS`   | int  | `30000` | Per-operation bridge timeout. Long-running operations (imports, project-wide UID updates) extend it via progress frames, so the default is rarely worth touching.                                                                   |
| `GODOT_MCP_LSP_PORT`  | int  | `6005`  | The editor's GDScript language-server port (`get_script_errors`' diagnostics source). Matches Godot's default; change it only if you changed it in Editor Settings → Network → Language Server.                                     |
| `DEBUG`               | bool | `false` | Enables verbose diagnostic logging to **stderr only** (stdout is reserved for the MCP stdio protocol and is never touched by this flag). Accepts `1`, `true`, `yes`, or `on` (case-insensitive); anything else is treated as false. |
| `OUTPUT_BUFFER_LINES` | int  | `1000`  | Maximum number of lines retained per stream (stdout and stderr, tracked separately) in the game-output ring buffer read back via `get_debug_output`. Older lines are dropped once the cap is hit rather than growing memory.        |

> **No `GODOT_PATH`.** The v2 server never launches or locates the Godot executable — you open the editor yourself, from wherever your Godot lives. (The 1.x headless line is the version that needs `GODOT_PATH`.)

## Security & least privilege

- **The product never executes Godot.** Not headless, not shelled, not spawned — the server's only reach into the engine is the bridge to the editor _you_ opened, and `create_project`/`install_addon` write files only. There is no code path from a tool call to launching a process.
- **No code-execution tool, by design and by CI.** There is no eval, no expression runner, no script executor. Operations dispatch through a fixed named-op table, and a standing CI audit fails any PR that adds a code-exec-shaped tool or op to either inventory.
- **Path containment is mandatory at two independent layers.** Every path parameter is canonicalized and containment-checked in the TypeScript layer (realpath-based — robust against Windows case/8.3/UNC quirks and symlink escapes) before anything crosses the bridge, and the addon re-checks every path again before touching the editor filesystem. A bug in one layer doesn't remove the other; both layers are proven in isolation by standing test suites.
- **Loopback-only, no telemetry — CI-enforced.** The addon's bridge binds `127.0.0.1` and refuses non-loopback connections (asserted at runtime in the integration suite); a static audit fails any PR that introduces an HTTP/UDP client, `fetch`, or a non-loopback socket anywhere in the addon or server.
- **Node-type allow-listing without a maintained list.** `add_node`'s `node_type` is validated against Godot's own `ClassDB` at call time (must exist, extend `Node`, and be directly instantiable) — never a script class or a `res://` path. Property values decode via `str_to_var` (value types only — it cannot execute code), plus explicit resource loading for resource-typed properties.
- **Bounded everything.** Directory walks are depth- and result-capped; the run-output capture is a bounded ring buffer; bridge operations execute strictly serially in arrival order, so concurrent agent calls cannot interleave into a corrupted scene.
- **Run it as yourself, not as admin/root.** This server operates on projects you already trust the agent to modify — it is not a sandbox against a malicious project file. An agent with these tools has write access scoped to the connected project; treat it accordingly.

## License

MIT — see [LICENSE](LICENSE).
