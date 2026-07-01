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
| MCP SDK | **`@modelcontextprotocol/sdk` v1.x stable** (v2 is alpha — migration is post-1.0); zod pinned to the SDK's peer range |
| Godot support | **4.x**; UID tools **always listed**, version-checked **at call time** (cached `--version`); return structured "requires ≥ 4.4" error on older runtimes |
| Tool architecture | **Thin descriptor array + `McpServer.registerTool`** — one plain descriptor object per tool (`{name, description, inputSchema, handler, minGodotVersion?}`); registration is a loop over `server.registerTool()`. **No custom list/dispatch** — the SDK already derives the JSON schema from zod and routes calls |
| API naming | **Clean-slate `snake_case`** tool + param names; **no** camelCase dual-support |
| GDScript bridge | **Single versioned dispatcher** (`godot_operations.gd`, `match` on op, JSON params as argv) |
| FS boundary | **Confine every path to the call's `project_path`**. Check = realpath the **deepest existing ancestor** (target may not exist yet), then `path.relative(root, candidate)` must be non-empty, non-absolute, and not start with `..`. **No naive `startsWith`** — it breaks on Windows (case-insensitivity, 8.3 short names, UNC). Centralized helper; optional allow-list post-1.0 |
| Value encoding | **`var_to_str`/`str_to_var` strings** for non-JSON Godot types in *both* directions (e.g. `"Vector2(100, 50)"`); JSON primitives stay native. One symmetric codec, matches `.tscn` syntax |
| Asset imports | **Detect + guided error + `import_project` tool (M1)**: asset-dependent ops check for the `.godot` import cache; if missing, return a structured error pointing at `import_project` (runs `godot --headless --import`, may be slow). Never auto-import inside another op |
| `add_node` type gate | **ClassDB-derived check in `operations.gd`** (`class_exists` && `is_parent_class(type, "Node")` && `can_instantiate`) — covers all built-ins per running version, blocks script-class/`res://` injection, zero list maintenance. No curated list |
| Godot resolution | **Strict + guided setup**: `config → GODOT_PATH → autodetect`; on failure, structured error w/ candidates + fix steps (no silent fallback) |
| Process model | **Single active process + polling `get_debug_output` + bounded ring buffer** |
| 1.0 read-back tools | `get_scene_tree`, `read_node_properties`, `get_script_errors`, `list_resources` |
| Testing | **Layered**: unit (no Godot) + integration (CI installs headless Godot) |
| License | **MIT** |
| 1.0 extras pulled in | **Docs/examples**, **typed config reference**, **sample smoke-test project** |
| Error format | Structured errors with `possibleSolutions[]` — carried **inside** `content` text / `structuredContent` (MCP results have no custom top-level fields), plus `isError: true` |
| Logging | **stderr only**, gated by `DEBUG` env (stdout reserved for stdio transport) |
| Telemetry | **None** |
| Build | `tsup` (bundle) + copy `godot_operations.gd` into `dist/` |

---

## 4. Milestones

Each milestone is independently shippable. **1.0 = end of M2.**

- **M1 — Parity (clean architecture):** descriptor array + `registerTool`, GDScript dispatcher, single-process model, the 14 parity tools **+ `import_project`**, strict Godot resolution, stderr logging, build/packaging skeleton, unit tests for pure layers.
- **M2 — Hardening + Read-back → release 1.0:** path containment everywhere (TS + `.gd`), ClassDB node-type gate, bounded output buffer, the 4 read-back tools, typed config surface, integration tests in CI, docs/examples + sample project, npm publish.
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
│   StdioServerTransport · MCP SDK v1.x        │
│   McpServer.registerTool() per descriptor    │
├─────────────────────────────────────────────┤
│ Descriptors (registry.ts)                    │
│   ToolDescriptor {name, description,         │
│     inputSchema(zod), handler,               │
│     minGodotVersion?} · registerAll() loop   │
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
├── server.ts                 # MCP wiring only (McpServer, transport, SIGINT)
├── registry.ts               # ToolDescriptor type + registerAll(server, descriptors)
├── config.ts                 # typed, zod-validated config (env + defaults)
├── errors.ts                 # createErrorResponse({message, possibleSolutions})
├── schemas.ts                # shared zod fragments (project_path, scene_path, ...)
├── tools/
│   ├── editor.ts             # launch_editor, get_godot_version
│   ├── run.ts                # run_project, get_debug_output, stop_project
│   ├── project.ts            # list_projects, get_project_info, import_project
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
- **Tool descriptor:** `{ name, description, inputSchema: ZodObject, handler: (args, ctx) => result, minGodotVersion? }` — a plain object, unit-testable without a server. `registerAll()` loops the array calling `server.registerTool()`; the **SDK** derives the JSON schema from zod and routes calls. Adding a tool = one descriptor in one file. No hand-rolled list/dispatch.
- **GDScript invocation (no shell):**
  `execFileAsync(godotPath, ['--headless','--path',project_path,'--script',opsScriptPath, operation, JSON.stringify(params)])`. Params travel as **data**, never interpolated → no injection.
- **`operations.gd` dispatcher:** version header; `match operation: ...`; `JSON.parse_string(argv)`; each op a small named function; **path containment re-checked inside `.gd`** (defense in depth).
- **Single-process runner:** one `activeProcess`; new run replaces old; stdout/stderr appended to a **bounded ring buffer** (`OUTPUT_BUFFER_LINES`, default e.g. 1000); `stop_project` kills + returns the tail.

---

## 6. Tool Specifications

All names/params `snake_case`. `project_path` is required wherever a project is operated on and anchors path containment. Every file/dir param is validated to resolve **inside `project_path`** (reject absolute, `../`, symlink escape).

**Value encoding (all tools, both directions):** JSON primitives (`bool`/`int`/`float`/`string`) travel natively; every other Godot type travels as its `var_to_str` text form (e.g. `"Vector2(100, 50)"`, `"Color(1, 0, 0, 1)"`), parsed with `str_to_var` on the way in. One symmetric codec; identical to the syntax agents already read in `.tscn` files.

### 6.1 Parity tools (M1)

| Tool | Inputs | Behavior |
|---|---|---|
| `launch_editor` | `project_path` | Open Godot editor GUI for the project. |
| `run_project` | `project_path`, `scene?`, `headless?` | Run the project (or a specific scene) **windowed by default** (`godot -d`, parity with the original); `headless: true` for log-only runs (CI/agents). Output captured into the ring buffer either way; replaces any active process. |
| `get_debug_output` | — | Return current `{ output[], errors[] }` from the ring buffer. |
| `stop_project` | — | Kill the active process; return captured tail; clear `activeProcess`. |
| `get_godot_version` | — | Return detected Godot version string. |
| `list_projects` | `directory`, `recursive?`, `max_depth?` | Find `project.godot` files under `directory` (the call's boundary for this tool). **Depth-capped** (default 3, hard max), skips hidden/system dirs (`.git`, `node_modules`, AppData, …), caps result count — no accidental whole-disk walks. |
| `get_project_info` | `project_path` | Return name, Godot version, and file/asset counts. |
| `import_project` | `project_path` | Run `godot --headless --import` to (re)build the asset import cache. May be slow on large projects — asset-dependent ops **never** run it implicitly; they return a guided error pointing here when the cache is missing. |
| `create_scene` | `project_path`, `scene_path`, `root_node_type?` | Create a `.tscn` with the given root node (default `Node2D`/configurable). |
| `add_node` | `project_path`, `scene_path`, `node_type`, `node_name`, `parent_node_path?`, `properties?` | Add a node under parent; `node_type` gated by the **ClassDB check** (§7.2); `properties` values use the shared encoding. |
| `load_sprite` | `project_path`, `scene_path`, `node_path`, `texture_path` | Assign a texture to a Sprite2D/3D node. Requires the import cache (else guided error → `import_project`). |
| `export_mesh_library` | `project_path`, `scene_path`, `output_path`, `mesh_item_names?` | Export scene meshes as a `MeshLibrary` `.res`. |
| `save_scene` | `project_path`, `scene_path`, `new_path?` | Save the scene (optionally as a new path / "save as"). |
| `get_uid` | `project_path`, `file_path` | **(≥4.4)** Return the resource UID for a file. |
| `update_project_uids` | `project_path` | **(≥4.4)** Resave resources to refresh UID references. |

UID tools are **always listed** (descriptions state "Requires Godot ≥ 4.4"); the version check happens **at call time** against the cached `--version` result, returning a structured "requires Godot ≥ 4.4" error on older runtimes. No startup probe, no dynamic tool list — startup must succeed even with no Godot installed (guided-error flow).

### 6.2 Read-back tools (M2 / 1.0)

| Tool | Inputs | Output |
|---|---|---|
| `get_scene_tree` | `project_path`, `scene_path` | Nested tree of `{ name, type, path, children[] }`. Verify structure / discover node paths. |
| `read_node_properties` | `project_path`, `scene_path`, `node_path`, `properties?` | Default: only properties **stored in the scene** (the node's non-default state — compact, mirrors the `.tscn`). Optional `properties: string[]` fetches specific named properties regardless of default-ness ("confirm `position` is `(0,0)`"). Values in the shared encoding. |
| `get_script_errors` | `project_path`, `scene_path?` \| `script_path?` | `{ errors: [{file, line, message}], raw: string }`. Structured entries are **best-effort regex parses** of `--check-only` stderr (Godot exposes no error API); `raw` is always included so a missed parse loses nothing. Regexes are pinned by integration tests per Godot version in the CI matrix, so format drift fails CI instead of silently returning `[]`. |
| `list_resources` | `project_path`, `type?` | `[{ path (res://), type, uid? }]`. Discover available assets before referencing. |

### 6.3 Tool descriptor checklist (applies to every tool)
- zod input schema in `schemas.ts`/tool file; description written for the agent.
- Path params run through `assertInsideRoot`.
- Errors returned via `createErrorResponse` with `possibleSolutions`.
- Unit test for schema + containment; integration test for real effect (M2).

---

## 7. Security & Hardening (M2)

1. **Path containment** — `assertInsideRoot(project_path, candidate)`: realpath the **deepest existing ancestor** of the candidate (the target itself may not exist yet, e.g. `create_scene`), then require `path.relative(root, candidate)` to be non-empty, non-absolute, and not starting with `..`. **Never** a naive `startsWith` prefix check — it breaks on Windows (case-insensitive paths, 8.3 short names like `C:\PROGRA~1`, UNC paths). Unit tests include explicit Windows cases. Enforced in **both** TS and `operations.gd`.
2. **Node-type gate (ClassDB-derived)** — `add_node` accepts `node_type` only if, in `operations.gd`: `ClassDB.class_exists(type)` **and** `ClassDB.is_parent_class(type, "Node")` **and** `ClassDB.can_instantiate(type)`. Covers every built-in node in the running Godot version with zero list maintenance; blocks script classes, `res://` injection, and abstract/editor-only classes. Never `load()` arbitrary values from properties (`str_to_var` only — it cannot construct Resources or run code).
2a. **Bounded `list_projects`** — depth cap (default 3, hard max), skip hidden/system directories, cap result count.
3. **Strict Godot resolution** — no silent hardcoded fallback; structured guided error on failure (candidate paths + how to set `GODOT_PATH`).
4. **No shell** — `execFile`/`spawn` with argument arrays only; params to GDScript are JSON data, never interpolated.
5. **Bounded buffers** — capped output to prevent memory exhaustion from noisy runs.
6. **Current MCP SDK** — pin `@modelcontextprotocol/sdk` **v1.x stable** (v2 is alpha; migrate post-1.0), zod within the SDK's peer range; enable `npm audit` / Dependabot; no unused deps (drop `axios`).
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

- **Unit (always, no Godot):** zod schema validation; `assertInsideRoot` (traversal/absolute/symlink cases **+ Windows cases: drive-letter casing, 8.3 short names, UNC, `\` separators**); descriptor registration (every descriptor registers cleanly, names unique); value-codec round-trips; config parsing; error formatting.
- **Integration (CI installs headless Godot 4.x):** run each tool against `examples/sample-project` — e.g. `create_scene` actually writes a valid `.tscn`, `add_node` appears in `get_scene_tree`, `run_project` (headless) captures output, `get_script_errors` flags a deliberately broken script (pinning the stderr-parse regexes per Godot version), asset-dependent op on a cold project returns the guided import error and succeeds after `import_project`, UID tools gated correctly by version.
- **`.github/workflows/ci.yml`:** job A = lint+typecheck+unit on **ubuntu-latest + windows-latest** (path containment gets real Windows semantics); job B = download Godot, run integration on **ubuntu × two Godot 4.x versions** (incl. one ≥4.4 for UID) **plus one windows-latest × latest-Godot smoke job**.
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
   - `create_scene` → `get_scene_tree` shows the root → `add_node` (with a `"Vector2(...)"` property) → `get_scene_tree` shows the new node → `read_node_properties` returns the same encoded value.
   - On a cold clone: `load_sprite` returns the guided import error → `import_project` → `load_sprite` succeeds.
   - `run_project` opens a window (then `headless: true` doesn't); `get_debug_output` shows logs; `stop_project` returns the tail.
   - Feed a `scene_path` of `../../etc/passwd` → rejected with a containment error.
   - Unset `GODOT_PATH` with no Godot installed → strict guided error with candidates.
5. CI green on a fresh clone (both jobs).

---

## 12. Open items / assumptions for `/to-issues`
- ~~Exact npm scope/package name~~ **RESOLVED:** `@heichan2000/godot-mcp` (verified available 2026-06-30). Remaining action: `npm login` + claim the `heichan2000` npm scope before first publish.
- ~~Initial `add_node` allow-list set~~ **RESOLVED (2026-07-01):** ClassDB-derived check, no curated list (§7.2).
- Default `root_node_type` to be finalized during M1.
- Which specific Godot 4.x versions to matrix-test (recommend latest 4.x + one ≥4.4).
- `tsup` vs `tsc`+copy is a recommendation, not a hard requirement.
- MCP SDK v2 (`@modelcontextprotocol/server`) migration — revisit post-1.0 once it's stable.

### Second grilling pass (2026-07-01, Fable)
Resolutions folded into the sections above: descriptor-array-over-`registerTool` (not a custom registry) · `import_project` tool + detect-and-guide for cold asset caches · `get_script_errors` best-effort-parse-plus-raw contract · `var_to_str` value encoding both directions · `read_node_properties` stored-plus-filter scope · Windows-correct path containment (no `startsWith`) · bounded `list_projects` · call-time UID version gate (no dynamic tool list) · ClassDB node-type gate · `run_project` windowed default with `headless?` flag · CI on Windows + Ubuntu · `possibleSolutions` carried inside MCP `content`/`structuredContent`.

_(End PRD)_
