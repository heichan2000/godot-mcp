# PRD: `@heichan2000/godot-mcp` (clean-room rebuild + improvements)

> **Package name (locked):** `@heichan2000/godot-mcp` — verified available on npm (2026-06-30). MCP client registration name stays plain `godot`.

> Status: Draft for `/to-issues`. This PRD is the single source of truth for breaking work into issues.
> Scope owner: cradial2000@gmail.com · Created 2026-06-30

---

## 1. Context

The existing [`Coding-Solo/godot-mcp`](https://github.com/Coding-Solo/godot-mcp) is a popular (~4.5k★, MIT) MCP server that bridges AI agents to the Godot 4 engine over stdio. A prior audit found it **architecturally sound but limited**:

- Tools are duplicated across a `ListTools` array **and** a `switch` (edit two places per tool).
- A hand-maintained camelCase↔snake_case `parameterMappings` table — boilerplate that scales poorly.
- **Write-heavy, read-light:** the agent can mutate scenes but barely observe them (weak verify loop).
- **Weak path validation** (`includes('..')` only — misses absolute paths, symlinks, encoding).
- **Single global process** with an unbounded output buffer (memory growth).
- **Silent fallback** to a hardcoded Godot path that masks misconfiguration.
- No tests, no CI.

**Goal:** rebuild it from scratch as a serious, published TS/Node MCP server that reaches **feature parity first**, then layers in the high-value improvements — keeping the original's one genuinely good idea (a single bundled GDScript dispatcher) and fixing everything else.

**Intended outcome:** a clean, well-tested, hardened, well-documented MCP server that AI agents use to drive Godot 4 with a real write→verify feedback loop, distributed via `npx`.

---

## 2. Goals / Non-Goals

### Goals
- Published, maintained npm package (`npx`-runnable), MIT-licensed.
- Clean **registry + zod** architecture (define each tool once).
- Feature parity with the original's 14 tools (clean-slate, consistent `snake_case` API).
- A real **observation/read-back** tool set so agents can verify their writes.
- **Security hardening:** path containment, node-type allow-listing, strict Godot resolution.
- **Layered tests + CI** (unit always; integration against real headless Godot).
- First-class **docs** (per-client setup + examples), a **typed config surface**, and a bundled **sample Godot project**.

### Non-Goals (post-1.0 roadmap)
- HTTP/SSE transport, auth, remote/multi-tenant use (stdio-only for 1.0).
- Concurrent/multi-process runs and streaming log notifications (polling for 1.0).
- Expanded scene API beyond parity (set arbitrary properties, signals, sub-scene instancing, `.tres` editing) — **M3**.
- Godot 3.x support.
- Drop-in name compatibility with the original (we deliberately rename for consistency).

---

## 3. Locked Decisions (from grilling)

| Decision | Choice |
|---|---|
| Purpose | Serious **published** tool (full rigor: tests, CI, docs, semver) |
| Strategy | **Parity first**, then improve (milestoned) |
| Language/runtime | **TypeScript / Node ≥ 20 LTS**, ESM |
| Transport | **stdio only** |
| Godot support | **4.x**; UID tools **feature-gated to ≥ 4.4** (detect via `--version`) |
| Tool architecture | **Registry + zod** from M1 (one descriptor per tool; list + dispatch auto-derived) |
| API naming | **Clean-slate `snake_case`** tool + param names; **no** camelCase dual-support |
| GDScript bridge | **Single versioned dispatcher** (`godot_operations.gd`, `match` on op, JSON params as argv) |
| FS boundary | **Confine every path to the call's `project_path`** (reject absolute/`../`/symlink escape); centralized helper so an optional allow-list can be added post-1.0 |
| Godot resolution | **Strict + guided setup**: `config → GODOT_PATH → autodetect`; on failure, structured error w/ candidates + fix steps (no silent fallback) |
| Process model | **Single active process + polling `get_debug_output` + bounded ring buffer** |
| 1.0 read-back tools | `get_scene_tree`, `read_node_properties`, `get_script_errors`, `list_resources` |
| Testing | **Layered**: unit (no Godot) + integration (CI installs headless Godot) |
| License | **MIT** |
| 1.0 extras pulled in | **Docs/examples**, **typed config reference**, **sample smoke-test project** |
| Error format | Structured `{ content, isError, possibleSolutions[] }` (kept from original) |
| Logging | **stderr only**, gated by `DEBUG` env (stdout reserved for stdio transport) |
| Telemetry | **None** |
| Build | `tsup` (bundle) + copy `godot_operations.gd` into `dist/` |

---

## 4. Milestones

Each milestone is independently shippable. **1.0 = end of M2.**

- **M1 — Parity (clean architecture):** registry+zod, GDScript dispatcher, single-process model, all 14 parity tools, strict Godot resolution, stderr logging, build/packaging skeleton, unit tests for pure layers.
- **M2 — Hardening + Read-back → release 1.0:** path containment everywhere (TS + `.gd`), node-type allow-list, bounded output buffer, the 4 read-back tools, typed config surface, integration tests in CI, docs/examples + sample project, npm publish.
- **M3 — Expanded scene API (post-1.0):** set/get arbitrary node properties, connect signals, instance sub-scenes, create/edit resources.
- **M4 — Concurrency + streaming (post-1.0):** `Map<id, process>` named runs, streamed output via MCP notifications, optional startup allow-list (upgrade FS boundary to defense-in-depth).

---

## 5. Architecture

```
Agent (Claude Desktop / Cursor / Cline)
        │  MCP / JSON-RPC over stdio
        ▼
┌─────────────────────────────────────────────┐
│ Server (server.ts)                           │
│   StdioServerTransport · MCP SDK (current)   │
│   registers Registry.list() / dispatch()     │
├─────────────────────────────────────────────┤
│ Registry (registry.ts)                       │
│   defineTool({name, description, input(zod), │
│                handler}) → list + dispatch    │
├─────────────────────────────────────────────┤
│ Tools (tools/*.ts) — one file group per area │
│   validate (zod) → call godot layer          │
├─────────────────────────────────────────────┤
│ Godot layer (godot/)                         │
│   paths.ts   resolution + containment        │
│   runner.ts  execFile (NO shell) + buffer    │
│   operations.gd  single versioned dispatcher │
├─────────────────────────────────────────────┤
│ config.ts (typed/validated) · errors.ts      │
└─────────────────────────────────────────────┘
```

### Proposed source layout
```
src/
├── server.ts                 # MCP wiring only (transport, registry hookup, SIGINT)
├── registry.ts               # defineTool + register + auto list/dispatch
├── config.ts                 # typed, zod-validated config (env + defaults)
├── errors.ts                 # createErrorResponse({message, possibleSolutions})
├── schemas.ts                # shared zod fragments (project_path, scene_path, ...)
├── tools/
│   ├── editor.ts             # launch_editor, get_godot_version
│   ├── run.ts                # run_project, get_debug_output, stop_project
│   ├── project.ts            # list_projects, get_project_info
│   ├── scene.ts              # create_scene, add_node, load_sprite, save_scene, export_mesh_library
│   ├── uid.ts                # get_uid, update_project_uids   (gated ≥4.4)
│   └── readback.ts           # get_scene_tree, read_node_properties, get_script_errors, list_resources
├── godot/
│   ├── paths.ts              # detectGodotPath(), assertInsideRoot(root, path)
│   ├── runner.ts             # execFileAsync wrapper, single-process mgr, ring buffer
│   └── operations.gd         # the bundled dispatcher (copied to dist/)
examples/
└── sample-project/           # tiny Godot 4 project (CI + quickstart)
test/
├── unit/                     # schemas, path containment, registry, config
└── integration/              # real headless Godot against examples/sample-project
.github/workflows/ci.yml      # unit job + integration job (installs Godot)
docs/                         # per-client setup, tool reference, examples
package.json · tsconfig.json · tsup.config.ts · README.md · LICENSE (MIT)
```

### Key patterns
- **`defineTool` descriptor:** `{ name, description, input: ZodObject, handler: (args, ctx) => result }`. Registry derives the MCP `inputSchema` from zod and routes `CallTool` by name. Adding a tool = one file, registered once.
- **GDScript invocation (no shell):**
  `execFileAsync(godotPath, ['--headless','--path',project_path,'--script',opsScriptPath, operation, JSON.stringify(params)])`. Params travel as **data**, never interpolated → no injection.
- **`operations.gd` dispatcher:** version header; `match operation: ...`; `JSON.parse_string(argv)`; each op a small named function; **path containment re-checked inside `.gd`** (defense in depth).
- **Single-process runner:** one `activeProcess`; new run replaces old; stdout/stderr appended to a **bounded ring buffer** (`OUTPUT_BUFFER_LINES`, default e.g. 1000); `stop_project` kills + returns the tail.

---

## 6. Tool Specifications

All names/params `snake_case`. `project_path` is required wherever a project is operated on and anchors path containment. Every file/dir param is validated to resolve **inside `project_path`** (reject absolute, `../`, symlink escape).

### 6.1 Parity tools (M1)

| Tool | Inputs | Behavior |
|---|---|---|
| `launch_editor` | `project_path` | Open Godot editor GUI for the project. |
| `run_project` | `project_path`, `scene?` | Run headless (or a specific scene); start capturing output into the ring buffer; replaces any active process. |
| `get_debug_output` | — | Return current `{ output[], errors[] }` from the ring buffer. |
| `stop_project` | — | Kill the active process; return captured tail; clear `activeProcess`. |
| `get_godot_version` | — | Return detected Godot version string. |
| `list_projects` | `directory`, `recursive?` | Find `project.godot` files under `directory` (the call's boundary for this tool). |
| `get_project_info` | `project_path` | Return name, Godot version, and file/asset counts. |
| `create_scene` | `project_path`, `scene_path`, `root_node_type?` | Create a `.tscn` with the given root node (default `Node2D`/configurable). |
| `add_node` | `project_path`, `scene_path`, `node_type`, `node_name`, `parent_node_path?`, `properties?` | Add a node (type **allow-listed**) under parent; apply simple properties. |
| `load_sprite` | `project_path`, `scene_path`, `node_path`, `texture_path` | Assign a texture to a Sprite2D/3D node. |
| `export_mesh_library` | `project_path`, `scene_path`, `output_path`, `mesh_item_names?` | Export scene meshes as a `MeshLibrary` `.res`. |
| `save_scene` | `project_path`, `scene_path`, `new_path?` | Save the scene (optionally as a new path / "save as"). |
| `get_uid` | `project_path`, `file_path` | **(≥4.4)** Return the resource UID for a file. |
| `update_project_uids` | `project_path` | **(≥4.4)** Resave resources to refresh UID references. |

UID tools are hidden/disabled and return a clear "requires Godot ≥ 4.4" error on older runtimes.

### 6.2 Read-back tools (M2 / 1.0)

| Tool | Inputs | Output |
|---|---|---|
| `get_scene_tree` | `project_path`, `scene_path` | Nested tree of `{ name, type, path, children[] }`. Verify structure / discover node paths. |
| `read_node_properties` | `project_path`, `scene_path`, `node_path` | `{ property: value, ... }` for the node. Verify set-property / texture ops took effect. |
| `get_script_errors` | `project_path`, `scene_path?` \| `script_path?` | `[{ file, line, message }]` parsed from headless parse/compile. Verify generated GDScript is valid. |
| `list_resources` | `project_path`, `type?` | `[{ path (res://), type, uid? }]`. Discover available assets before referencing. |

### 6.3 Tool descriptor checklist (applies to every tool)
- zod input schema in `schemas.ts`/tool file; description written for the agent.
- Path params run through `assertInsideRoot`.
- Errors returned via `createErrorResponse` with `possibleSolutions`.
- Unit test for schema + containment; integration test for real effect (M2).

---

## 7. Security & Hardening (M2)

1. **Path containment** — `assertInsideRoot(project_path, candidate)`: `path.resolve` then assert `startsWith(root + sep)`; reject absolute inputs, `..`, and symlinks that escape (`realpath` check). Enforced in **both** TS and `operations.gd`.
2. **Node/class allow-list** — `add_node` restricts `node_type` to a vetted set of Godot built-ins; reject `res://`/script-class injection; never `load()` arbitrary values from properties.
3. **Strict Godot resolution** — no silent hardcoded fallback; structured guided error on failure (candidate paths + how to set `GODOT_PATH`).
4. **No shell** — `execFile`/`spawn` with argument arrays only; params to GDScript are JSON data, never interpolated.
5. **Bounded buffers** — capped output to prevent memory exhaustion from noisy runs.
6. **Current MCP SDK** — pin to a current, maintained version (not the original's 0.6.0); enable `npm audit` / Dependabot; no unused deps (drop `axios`).
7. **Least-privilege guidance** in docs (run scoped to a projects dir; never as admin/root).

---

## 8. Configuration (typed, M2)

Validated `config.ts` (zod), documented in `docs/`:

| Key | Type | Default | Purpose |
|---|---|---|---|
| `GODOT_PATH` | path | autodetect | Explicit Godot binary; strict resolution. |
| `DEBUG` | bool | false | Verbose stderr logging. |
| `OUTPUT_BUFFER_LINES` | int | 1000 | Ring-buffer cap for run output. |
| `STRICT_PATHS` | bool | true | Toggle for relaxed local dev (documented, default on). |
| `GODOT_ALLOWED_ROOTS` | path[] | — | **(reserved, M4)** optional startup allow-list. |

---

## 9. Testing & CI

- **Unit (always, no Godot):** zod schema validation; `assertInsideRoot` (traversal/absolute/symlink cases); registry list+dispatch; config parsing; error formatting.
- **Integration (CI installs headless Godot 4.x):** run each tool against `examples/sample-project` — e.g. `create_scene` actually writes a valid `.tscn`, `add_node` appears in `get_scene_tree`, `run_project` captures output, `get_script_errors` flags a deliberately broken script, UID tools gated correctly by version.
- **`.github/workflows/ci.yml`:** job A = lint+typecheck+unit; job B = download Godot, run integration. Matrix across a couple of Godot 4.x versions (incl. one ≥4.4 for UID).
- Coverage gate on the pure layers (schemas, paths, registry, config).

---

## 10. Packaging & Docs

- **npm:** package `@heichan2000/godot-mcp` (scoped, public), `bin` → `dist/index.js`, `prepare`/`build` via `tsup`, ship `dist/operations.gd`; verify presence at startup (clear error if missing).
  - **Publish prerequisite:** `npm login` then confirm `npm whoami` = `heichan2000` (or create org `npm org create heichan2000`). First publish uses `--access public` for the scoped package. GitHub and npm scopes are independent — the npm scope must be claimed separately.
- **Docs:** README quickstart; per-client setup for **Claude Desktop, Cursor, Cline** (`npx` config snippets); full **tool reference**; **config reference**; worked **examples**; security/least-privilege notes.
- **Sample project:** `examples/sample-project/` — minimal Godot 4 project used by integration tests **and** as a user quickstart.

---

## 11. Verification (end-to-end)

1. `npm install && npm run build` → produces `dist/` incl. `operations.gd`.
2. `npm test` → unit green; `npm run test:integration` (with Godot installed) → integration green.
3. Register locally: `claude mcp add godot -- npx @heichan2000/godot-mcp` (or Cursor `.cursor/mcp.json`).
4. Manual smoke loop against `examples/sample-project`:
   - `get_godot_version` returns a 4.x version.
   - `create_scene` → `get_scene_tree` shows the root → `add_node` → `get_scene_tree` shows the new node → `read_node_properties` confirms a set property.
   - `run_project` then `get_debug_output` shows logs; `stop_project` returns the tail.
   - Feed a `scene_path` of `../../etc/passwd` → rejected with a containment error.
   - Unset `GODOT_PATH` with no Godot installed → strict guided error with candidates.
5. CI green on a fresh clone (both jobs).

---

## 12. Open items / assumptions for `/to-issues`
- ~~Exact npm scope/package name~~ **RESOLVED:** `@heichan2000/godot-mcp` (verified available 2026-06-30). Remaining action: `npm login` + claim the `heichan2000` npm scope before first publish.
- Default `root_node_type` and the initial `add_node` allow-list set to be finalized during M1.
- Which specific Godot 4.x versions to matrix-test (recommend latest 4.x + one ≥4.4).
- `tsup` vs `tsc`+copy is a recommendation, not a hard requirement.

_(End PRD)_
