# @heichan2000/godot-mcp

> An [MCP](https://modelcontextprotocol.io) server that bridges AI agents to the **Godot 4** engine over stdio — with a real **write → verify** feedback loop.

A clean-room rebuild of the popular [`Coding-Solo/godot-mcp`](https://github.com/Coding-Solo/godot-mcp) concept, rearchitected around a **registry + zod** tool model, hardened path handling, and read-back tools so agents can actually observe the scenes they mutate.

> **Status:** 🚧 Pre-1.0, under active development. See the [milestones](#milestones) and open issues.

## Why

The original is architecturally sound but write-heavy and read-light, with weak path validation, an unbounded output buffer, a silent Godot-path fallback, and no tests/CI. This rebuild keeps the one genuinely good idea — a single bundled GDScript dispatcher — and fixes the rest:

- **Registry + zod** — every tool defined once; MCP `list` and `dispatch` are auto-derived.
- **Clean-slate `snake_case` API** — no camelCase dual-support boilerplate.
- **Read-back tools** — `get_scene_tree`, `read_node_properties`, `get_script_errors`, `list_resources`.
- **Security hardening** — path containment (TS + GDScript), node-type allow-listing, strict Godot resolution, no shell, bounded buffers.
- **Layered tests + CI** — unit (no Godot) plus integration against real headless Godot.

## Quickstart

> Requires **Node ≥ 20** and **Godot 4.x** on your machine.

```jsonc
// Claude Desktop / Cursor / Cline — register as "godot"
{
  "mcpServers": {
    "godot": {
      "command": "npx",
      "args": ["-y", "@heichan2000/godot-mcp"]
    }
  }
}
```

Or with the Claude Code CLI:

```sh
claude mcp add godot -- npx -y @heichan2000/godot-mcp
```

## Configuration

| Env var | Type | Default | Purpose |
|---|---|---|---|
| `GODOT_PATH` | path | autodetect | Explicit Godot binary (strict resolution). |
| `DEBUG` | bool | `false` | Verbose stderr logging. |
| `OUTPUT_BUFFER_LINES` | int | `1000` | Ring-buffer cap for run output. |
| `STRICT_PATHS` | bool | `true` | Path containment enforcement. |

See [`docs/`](./docs) for the full config and tool reference.

## Tools

Parity tools: `launch_editor`, `run_project`, `get_debug_output`, `stop_project`, `get_godot_version`, `list_projects`, `get_project_info`, `create_scene`, `add_node`, `load_sprite`, `export_mesh_library`, `save_scene`, `get_uid`*, `update_project_uids`*.

Read-back tools: `get_scene_tree`, `read_node_properties`, `get_script_errors`, `list_resources`.

<sub>* UID tools require Godot ≥ 4.4 and return a clear error on older runtimes.</sub>

## Development

```sh
npm install
npm run build          # tsup → dist/ (incl. operations.gd)
npm test               # unit (no Godot required)
npm run test:integration   # requires headless Godot 4.x
```

## Milestones

- **M1 — Parity:** registry+zod, GDScript dispatcher, single-process model, all 14 parity tools, strict Godot resolution, build skeleton, unit tests.
- **M2 — Hardening + Read-back → 1.0:** path containment everywhere, node allow-list, bounded buffer, 4 read-back tools, typed config, integration CI, docs + sample project, npm publish.
- **M3 — Expanded scene API** (post-1.0).
- **M4 — Concurrency + streaming** (post-1.0).

## License

[MIT](./LICENSE) © heichan2000
