# M1 #75: Long Ops — Progress Frames + Per-Op Timeouts, Proven on MeshLibrary Export — Design

**Date:** 2026-07-12
**Issue:** #75 (parent PRD #63). Covers REQ-A-11, REQ-G-01; containment per REQ-M-01; serialization per REQ-A-12.
**Status:** Approved in brainstorming session (three axes user-decided: internal-only progress; scan waits with progress; hybrid addon execution model).

## Goal

Today `connection.ts` arms a flat `BRIDGE_TIMEOUT_MS` (default 30s) timer per request and rejects with `BridgeTimeoutError` — a legitimately slow op (big import, large export) dies at 30s, indistinguishable from a genuinely stalled one. This slice adds the missing half of REQ-A-11: **progress frames keyed by request id that extend the deadline**, proven on the two real ops that need it in M1 — MeshLibrary export (REQ-G-01, new tool) and #68's editor-native asset import (retrofit). Blockers #67 and #68 are merged.

## Decisions (user-locked)

1. **Progress is internal to the bridge** — extends the timeout, visible in the traffic log / DEBUG stderr. No MCP `notifications/progress` forwarding in this issue (layerable later without protocol changes).
2. **Bare `import_assets` (full scan) waits for scan completion with progress** instead of fire-and-forget — this is what forces a deferred (multi-frame) op slot in the addon queue.
3. **Hybrid addon execution model:** blocking ops stay synchronous and emit progress at natural checkpoints via `emit_progress()` (send + poll to flush mid-op); only editor-async work (`fs.scan()`) uses a single-slot deferred task ticked once per `_process` frame. The queue stays strictly serialized (REQ-A-12).

## Key technical constraints

- `WebSocketPeer` buffers outgoing frames until `poll()` — mid-op progress must `send_text()` **then** `poll()`, or every frame arrives after the op finishes and the deadline extension never happens.
- Editor APIs (EditorFileSystem, scene load/save) are main-thread-only in the editor — background threads are off the table.

## 1. Protocol (additive, no version bump)

New addon→server frame, keyed by request id:

```json
{ "id": 7, "progress": { "stage": "reimport", "current": 2, "total": 5, "message": "res://textures/a.png" } }
```

- `src/bridge/protocol.ts`: add `ProgressFrameSchema` (`id` int required; `progress` object with optional `stage`/`current`/`total`/`message`, catchall) and a new `AddonFrame` kind `"progress"` in `parseAddonFrame` — checked before the response shape; a frame with a `progress` key and no `result`/`error` is progress.
- No `PROTOCOL_VERSION` bump: additive. An old server logs a progress frame as invalid and ignores it (acceptable in alpha).

## 2. Bridge client (`src/bridge/connection.ts`)

- On a progress frame for a pending id: `clearTimeout` and re-arm the full `requestTimeoutMs`. Each frame = signs of life = fresh deadline. Progress for an unknown id → log + ignore (mirrors the existing late-response path).
- Progress frames are observable via the traffic log (all received frames are already recorded before classification) — that is how the demo and tests watch them arrive.
- `BridgeTimeoutError` message updated: "did not answer **or report progress** within {timeoutMs}ms". The structured mapping in `src/tools/bridge.ts` (`bridgeErrorToResponse`) already exists and its `possibleSolutions` stay valid.
- Queue survival is already client-side correct (timeout deletes the pending entry; a late response is ignored as unknown-id) — this slice adds explicit test coverage for "timed-out op, then next call succeeds".

## 3. Addon queue (`addon/godot_mcp/server.gd`)

- `emit_progress(id: Variant, payload: Dictionary)`: sends `{id, progress: payload}` then calls `_peer.poll()` so the frame hits the wire mid-op. `_drain_queue` passes the request id into `_dispatch(method, params, id)`; ops that don't emit progress ignore it.
- **Single-slot deferred task:** `_dispatch` may return `{"task": <RefCounted>}` instead of `result`/`error`. The server stores `_inflight = {id, task}`; each `_process` frame ticks the task **before** draining the queue. `tick()` returns `null` (still running — may have emitted progress) or an outcome dict (`{result}` / `{error}`) → respond, clear the slot, resume draining. Nothing else executes while a task is in flight (REQ-A-12 preserved).
- `_reset_peer()` also drops `_inflight` — a dead client's task must not answer a new client.

## 4. Import retrofit (`addon/godot_mcp/ops/project_ops.gd`; REQ-A-11 on REQ-J-01)

- **Targeted paths** (`assets/import` with `paths`): reimport one file at a time — `emit_progress(id, {stage: "reimport", current, total, message: path})` before each `fs.reimport_files([path])`. Result shape unchanged: `{scan_started: false, reimported: [...]}`.
- **Bare scan:** `fs.scan()` then return a deferred `ScanTask`: each tick, while `fs.is_scanning()`, emit `{stage: "scan", current: <percent>}` (throttled — only when `get_scanning_progress()` changes, or every ~30 frames); when scanning ends, respond `{scan_started: true, scan_completed: true, reimported: []}`. A scan that finishes instantly (nothing changed) responds on its first tick.
- `scan_completed` is additive — `ImportResultSchema` in `src/tools/project.ts` gains `scan_completed: z.boolean().optional()`.

## 5. MeshLibrary export (REQ-G-01, REQ-M-01) — 1.0 parity

1.0 reference: `git show 5a0ee64:src/godot/operations.gd` (`op_export_mesh_library`). Parity behavior, now with structured error codes and progress.

**New addon op `scene/export_mesh_library`** in a new focused file `addon/godot_mcp/ops/mesh_library_ops.gd` (extends `op_base.gd`, wired in `server.gd`):

- Params: `scene_path` (res://, must exist), `output_path` (containment-checked res://, no `..` — same `op_base.gd`-style check; parent dirs created; **overwrite allowed** — a MeshLibrary is a derived build artifact, unlike hand-authored scenes), `mesh_item_names?` (array of strings).
- Load the `PackedScene` from disk (not the edited scene), instantiate, recursively collect `MeshInstance3D` nodes with a non-null mesh (root included). None → error `no_meshes`.
- Non-empty `mesh_item_names` filters by node name; zero matches → error `mesh_item_names_unmatched`, message listing the available item names (1.0 parity).
- Build the `MeshLibrary`: sequential item ids, item name = node name, item mesh = the node's mesh; save via `ResourceSaver` (failure → `save_failed`). Free the instantiated root on every path.
- Result: `{scene_path, output_path, item_names}`.
- Progress: `{stage: "load"}` before scene load; `{stage: "collect", current, total}` every ~25 items; `{stage: "save"}` before `ResourceSaver.save`.
- No UndoRedo — this writes a resource file, not editor scene state (matches 1.0).

**New TS tool `export_mesh_library`** in `src/tools/scene.ts` (PRD §6.3 groups it with scene authoring): zod input schema `{scene_path, output_path, mesh_item_names?}`, TS-side containment via the existing `containResPath` helper on both paths, result validated with a zod schema, errors via `bridgeErrorToResponse`.

## Errors (REQ-A-08 shape throughout)

| Code | When | Guidance |
| --- | --- | --- |
| `scene_not_found` | no file at `scene_path` | check with list_resources |
| `no_meshes` | scene has no MeshInstance3D with an assigned mesh | assign meshes / pick another scene |
| `mesh_item_names_unmatched` | filter matches nothing | message lists available item names |
| `save_failed` | ResourceSaver error | check output path/permissions |
| containment reject | `output_path`/`scene_path` escapes res:// | use a res:// project path |
| bridge timeout | no answer **and no progress** within `BRIDGE_TIMEOUT_MS` | retry; raise BRIDGE_TIMEOUT_MS for legitimately longer ops |

## 6. Fake peer (`test/support/fake-addon-peer.ts`)

- Handlers gain an optional second arg: a context `{ progress(payload: object): void }` that sends `{id, progress: payload}` immediately (before the handler resolves).
- Stall staging: a handler that resolves only **after** the client's timeout models the real recovery story — the client times out, the late response is ignored (unknown id), and the next op (queued behind it in the serial chain, exactly like the real addon's queue) then succeeds.

## 7. Testing

**Unit (fake peer / no Godot):**

- `parseAddonFrame` classifies progress frames (valid / unknown-key / missing-id cases).
- Timeout fires: op with no progress past `requestTimeoutMs` → `BridgeTimeoutError`; a subsequent request on the same connection succeeds; the stalled op's late response is ignored.
- Deadline extension: with a short timeout (~200ms), a handler emitting progress every ~100ms for ~500ms then resolving → completes successfully, past the base deadline.
- Progress frame for an unknown/timed-out id → ignored, connection healthy.

**Integration (real editor, `GODOT_PATH`-gated, per `test/integration/support.ts` pattern):**

- MeshLibrary export from `examples/sample-project/scenes/meshes.tscn` (Box + Sphere fixture): full export → both item names; `mesh_item_names: ["Box"]` → filtered; unmatched name → structured error listing `["Box", "Sphere"]`; the saved `.res` loads back as a `MeshLibrary` with the expected items; a `../`-escaping `output_path` → containment error (both TS and addon layers).
- Import retrofit: copy a new texture into the project, `import_assets` with its path → success + at least one `{stage: "reimport"}` progress frame observed in `connection.traffic()`; bare `import_assets` → responds only after the scan, with `scan_completed: true`.

**Verification commands:** `npm test` (unit) · `GODOT_PATH=... npm run test:integration` · `npm run lint` · `npm run build`.

## Files touched

| File | Change |
| --- | --- |
| `src/bridge/protocol.ts` | `ProgressFrameSchema`, `AddonFrame` kind `"progress"` |
| `src/bridge/connection.ts` | deadline re-arm on progress; timeout message |
| `src/tools/project.ts` | `ImportResultSchema` + `scan_completed` |
| `src/tools/scene.ts` | new `export_mesh_library` tool |
| `addon/godot_mcp/server.gd` | `emit_progress`, `_inflight` deferred slot, dispatch wiring |
| `addon/godot_mcp/ops/project_ops.gd` | per-file reimport progress; `ScanTask` deferred scan |
| `addon/godot_mcp/ops/mesh_library_ops.gd` | new — export op |
| `test/support/fake-addon-peer.ts` | progress context + stall staging |
| `test/unit/*`, `test/integration/*` | coverage above |
