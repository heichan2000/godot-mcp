# M1 #95: Harden Deferred-Task Machinery — Scan-Start Race, tick() Outcome Guard, Wall-Clock Cap — Design

**Date:** 2026-07-12
**Issue:** #95 (follow-up from #75 / PR #94 final review). Hardens REQ-A-11 machinery; queue-survival per REQ-A-12; error shape per REQ-A-08.
**Status:** Approved in brainstorming session (four axes user-decided: include the optional dedup as a shared base; cap configured via ProjectSettings with a 5-minute default; cap enforced server-side in `_tick_inflight`; ~10-tick grace on the scan-start gate).

## Goal

PR #94's review identified three latent defects in the deferred-task machinery — none observed in practice (long-ops suite green 8/8 twice on Godot 4.6.3), all filed for hardening:

1. **Scan-start race:** `ScanTask` (`addon/godot_mcp/ops/project_ops.gd`) and `RegisterTask` (`addon/godot_mcp/ops/mesh_library_ops.gd`) kick `EditorFileSystem.scan()` inside the op but first read `is_scanning()` on a later frame. If the editor hasn't flipped the flag by then, the task completes before the scan indexed anything — `import_assets` falsely reports `scan_completed: true`; `RegisterTask`'s exported `.res` in a brand-new directory stays unregistered.
2. **Unguarded outcome cast:** `server.gd` `_tick_inflight` hard-casts `tick()`'s return to `Dictionary`; a future task returning a non-null, non-Dictionary value crashes the queue.
3. **No-escape hang:** a deferred task whose completion condition never turns true occupies the single `_inflight` slot forever, while its heartbeat keeps re-arming the client's timeout — neither side ever fires. The tool call hangs until editor restart or disconnect.

This slice fixes all three, plus the review's optional item 4 (dedup the near-verbatim ScanTask/RegisterTask tick loops), addon-side only. No TypeScript changes, no protocol changes.

## Decisions (user-locked)

1. **Include the dedup (issue item 4):** the race fix must land in both tasks anyway; a shared base writes the gate, grace, and heartbeat once.
2. **Cap configured via ProjectSettings:** `godot_mcp/network/deferred_op_timeout_ms`, default **300 000 ms (5 min)** — generous for huge project scans, still frees a wedged queue same-session. Read leniently, mirroring the existing `godot_mcp/network/port` pattern (`server.gd` `_configured_port`).
3. **Cap enforced server-side** in `_tick_inflight`, not in the task: the cap is the queue's liveness guarantee, so it belongs to the queue owner — every current and future task type is capped by construction, even one that never extends the scan base.
4. **Scan-start gate uses a ~10-tick grace:** small enough that a bare no-op `import_assets` answers ~10 editor frames later than today (imperceptible next to the websocket round trip); if the flag flips later than that, behavior degrades to today's early completion — never a hang (the cap guarantees that independently).

## 1. Shared base: `addon/godot_mcp/ops/deferred_scan_task.gd`

New `RefCounted` class owning everything the two tasks currently duplicate, plus the new gate:

- **Constructor:** server node, request id, `EditorFileSystem`, progress `stage` name (`"scan"` / `"register"`), and the completion payload (the `Dictionary` placed under `result`).
- **Throttle/heartbeat loop** (verbatim from today's copies): while `is_scanning()`, emit `emit_progress(id, {stage, current: percent, total: 100})` on percent change or every ~30 frames.
- **Scan-start gate (fix 1):** two fields, `_scan_observed := false` and `_ticks := 0`, incremented per `tick()`. When `is_scanning()` is true, set `_scan_observed = true`. When false, complete **only if** `_scan_observed` (scan ran and finished) **or** `_ticks >= GRACE_TICKS` (const, 10 — a genuinely instant scan still responds promptly). Otherwise return `null` and keep waiting.

The `ScanTask` and `RegisterTask` classes are deleted; their two construction sites instantiate the base directly — the tasks differ only in stage name and payload, so subclasses would be empty shells. `import_assets`'s payload is `{scan_started: true, scan_completed: true, reimported: []}`; the mesh-library site's is its captured export result. The base's contract: **`tick()` returns `null` while running (possibly emitting progress) or `{result: …}` when verifiably done.**

## 2. Wall-clock cap (`server.gd`, fix 3)

- **Arming:** where `_inflight = {"id": id, "task": …}` is set today (`server.gd:168`), also stamp `"deadline_ms": Time.get_ticks_msec() + _deferred_op_timeout_ms()`.
- **`_deferred_op_timeout_ms()`:** lenient ProjectSettings read of `godot_mcp/network/deferred_op_timeout_ms`; missing → 300 000; non-numeric or < 1 → `push_warning` + 300 000 (exact analogue of `_configured_port`).
- **Enforcement:** `_tick_inflight` checks the deadline **before** ticking the task. On expiry it does not tick again; it sends a structured REQ-A-08 error, clears `_inflight`, and the same `_process` frame's `_drain_queue()` resumes serving:

```json
{
  "id": 7,
  "error": {
    "code": "deferred_op_timeout",
    "message": "Deferred op exceeded the 300000 ms wall-clock cap and was abandoned.",
    "possibleSolutions": [
      "Raise godot_mcp/network/deferred_op_timeout_ms in project settings if this op legitimately needs longer.",
      "Check the editor for a stuck filesystem scan."
    ]
  }
}
```

- **Abandonment semantics:** the task object is simply dropped. Any underlying editor scan continues harmlessly; no late frames can leak (only the armed task can emit progress for that id, and it is gone). Client-side nothing changes — the error arrives as a normal structured failure and cancels the TS per-request timer. Disconnect handling already clears `_inflight` via `_reset_peer` and stays as is.
- **Interplay with the #75 "signs of life" semantics:** progress frames still re-arm the client's full `BRIDGE_TIMEOUT_MS` window — healthy slow ops are unaffected. The cap only bounds how long a _single deferred op_ may hold the queue, closing the one path where re-arming never terminates.

## 3. Outcome guard (`server.gd`, fix 2)

In `_tick_inflight`, replace the hard `var outcome_dict: Dictionary = outcome` with an `outcome is Dictionary` check. A non-null, non-Dictionary return sends:

```json
{
  "id": 7,
  "error": {
    "code": "internal_error",
    "message": "Deferred task returned a malformed outcome (<type name>).",
    "possibleSolutions": ["This is an addon bug - report it with the op name and editor log."]
  }
}
```

then clears the slot and keeps draining (REQ-A-12). Safe today (both tasks return only `null` or a dict); this removes the crash path for future tasks.

## 4. Testing

All verification runs against a real editor via the existing serialized integration harness (no GDScript unit framework exists in this repo); construction-level guarantees cover what can't be forced deterministically:

- **Cap (new integration case, the key test):** write a tiny `godot_mcp/network/deferred_op_timeout_ms` (e.g. 100) into the fixture project's `project.godot` **before** the editor launches (settings persisted on disk pre-launch — no debounced-save race, per the #96 lesson). Call `import_assets`: the ~10-tick grace guarantees the task is still in flight when the cap fires. Assert the structured `deferred_op_timeout` error, then issue a follow-up op and assert it succeeds — the queue drained, no permanent wedge (REQ-A-12 acceptance).
- **Grace path (instant scan):** bare `import_assets` with nothing to import completes promptly with `scan_completed: true` under a normal cap. This is existing long-ops behavior and must stay green; it now exercises the grace-expiry branch.
- **Scan-start race:** not deterministically forcible against a real editor (the editor's flag timing can't be delayed from outside). Covered by construction — the gate makes premature completion impossible whenever the flag flips within grace — plus the existing long-ops suite staying green. The issue's "where feasible" caveat applies.
- **Outcome guard:** not reachable end-to-end (both real tasks return well-formed outcomes); a three-line defensive branch verified by review. No test.
- **Regression:** the full existing long-ops integration suite runs unchanged and must stay green (explicit acceptance criterion).

## Acceptance (from issue #95)

- A deferred task only completes after the scan has verifiably started, or a bounded grace expired — asserted where feasible per §4.
- `_tick_inflight` survives a malformed `tick()` return with a structured error; the queue keeps serving (REQ-A-12).
- A deferred task exceeding the wall-clock cap yields a structured error, frees `_inflight`, and the next queued op is served — no permanent wedge (REQ-A-12).
- Existing long-ops integration suite stays green vs a real editor.
