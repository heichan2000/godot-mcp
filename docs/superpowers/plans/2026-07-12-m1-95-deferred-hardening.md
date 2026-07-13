# M1 #95: Deferred-Task Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close three latent defects in the addon's deferred-task machinery — the scan-start race, the unguarded `tick()` outcome cast, and the no-escape queue hang — per the approved spec `docs/superpowers/specs/2026-07-12-m1-95-deferred-hardening-design.md` (issue #95).

**Architecture:** A new shared `DeferredScanTask` (RefCounted, GDScript) replaces the near-identical `ScanTask`/`RegisterTask` classes and adds a scan-start gate (complete only after `is_scanning()` was observed true once, or a 10-tick grace expires). `server.gd` gains a server-owned wall-clock cap on the `_inflight` slot (ProjectSettings `godot_mcp/network/deferred_op_timeout_ms`, default 300 000 ms) and an `outcome is Dictionary` guard in `_tick_inflight`. Addon-side only: no TypeScript `src/` changes, no protocol change, no `PROTOCOL_VERSION` bump.

**Tech Stack:** Godot 4.6 editor GDScript (addon), vitest integration tests driving a real editor (TypeScript, `test/` only).

## Global Constraints

- GDScript files use **tab indentation** and `@tool` at the top (match every existing `addon/godot_mcp/ops/*.gd`).
- Error payload shape is exactly `{code, message, possibleSolutions}` (REQ-A-08) — the same shape `op_base.gd`'s `_err()` builds.
- Exact values from the spec: `GRACE_TICKS := 10`; heartbeat every 30 frames (`_frames_since_emit >= 30`); setting `godot_mcp/network/deferred_op_timeout_ms`; default `300_000` ms; error codes `deferred_op_timeout` and `internal_error`; test cap `1` ms.
- Integration tests require the `GODOT_PATH` env var pointing at a Godot 4.x **editor** binary. `describe.runIf(hasGodot)` **skips silently (with a `[coverage] SKIPPED` warning) when it is unset** — a run that reports "0 passed" or "skipped" is NOT a pass. If you see that, stop and report; do not proceed.
- Integration suites run serialized (`vitest.integration.config.ts` sets `fileParallelism: false`) — never change that.
- Before any commit containing `.ts` or `.md` files, run `npx prettier --write <files>` (CI has a `prettier --check .` gate). GDScript is not prettier-scoped.
- Commit messages follow the repo style you can see in `git log --oneline`: `type: summary (#95, REQ-…)`, ending with the `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` trailer.
- Work on a feature branch, e.g. `m1/95-deferred-hardening` (the execution skill's worktree setup handles this).

---

### Task 1: Shared `DeferredScanTask` with the scan-start gate (spec §1, fixes race + dedup)

**Files:**

- Create: `addon/godot_mcp/ops/deferred_scan_task.gd`
- Modify: `addon/godot_mcp/ops/project_ops.gd` (import op + delete `ScanTask`, lines ~113–170)
- Modify: `addon/godot_mcp/ops/mesh_library_ops.gd` (export op + delete `RegisterTask`, lines ~14–15, ~100–111, ~123–155)
- Test: `test/integration/long-ops.integration.test.ts` (existing suite — regression gate, no edits)

**Interfaces:**

- Consumes: `server.emit_progress(id: Variant, payload: Dictionary) -> void` (exists on `server.gd`); `EditorFileSystem.is_scanning()/get_scanning_progress()`.
- Produces: `DeferredScanTask.new(srv: Node, id: Variant, fs: EditorFileSystem, stage: String, result: Dictionary)` with `tick() -> Variant` returning `null` while waiting or `{"result": <the result Dictionary>}` when done. Task 2's `_tick_inflight` rewrite calls `tick()` via the same duck-typed `task.call("tick")` as today — no signature change.

**TDD note:** No failing-test-first here — the scan-start race cannot be forced deterministically against a real editor (spec §4: covered by construction). The test cycle for this task is the existing 8-test long-ops suite, which exercises both construction sites (bare `import_assets` = grace path; brand-new-directory MeshLibrary export = observed-scan path).

- [ ] **Step 1: Create the shared task class**

Create `addon/godot_mcp/ops/deferred_scan_task.gd` with exactly this content (tabs, not spaces):

```gdscript
@tool
extends RefCounted

## Shared deferred-task body (#95) for ops that kick EditorFileSystem.scan()
## and must not reply until it finishes (REQ-A-11): project_ops' bare
## import_assets (stage "scan") and mesh_library_ops' brand-new-directory
## export registration (stage "register"). server._tick_inflight calls tick()
## once per editor frame: null = still waiting (throttled progress may have
## been emitted); a {result} dict = done, reply with the payload captured at
## construction.
##
## Scan-start gate: scan() is kicked before this task is armed, but the editor
## may not flip is_scanning() until a later frame - trusting an early false
## reading would complete before the scan indexed anything. A false reading is
## trusted only after the scan was observed running, or once GRACE_TICKS
## expire (a genuinely instant scan still answers promptly). If the flag flips
## later than the grace, behavior degrades to the pre-#95 early completion -
## never a hang; the server-side wall-clock cap bounds the worst case.

const GRACE_TICKS := 10

var _server: Node
var _id: Variant
var _fs: EditorFileSystem
var _stage: String
var _result: Dictionary
var _scan_observed := false
var _ticks := 0
var _last_percent := -1
var _frames_since_emit := 0


func _init(srv: Node, id: Variant, fs: EditorFileSystem, stage: String, result: Dictionary) -> void:
	_server = srv
	_id = id
	_fs = fs
	_stage = stage
	_result = result


func tick() -> Variant:
	_ticks += 1
	if _fs.is_scanning():
		_scan_observed = true
		var percent := int(_fs.get_scanning_progress() * 100.0)
		_frames_since_emit += 1
		# Throttle: emit on change, or every 30 frames as a heartbeat.
		if percent != _last_percent or _frames_since_emit >= 30:
			_server.emit_progress(_id, {"stage": _stage, "current": percent, "total": 100})
			_last_percent = percent
			_frames_since_emit = 0
		return null
	if _scan_observed or _ticks >= GRACE_TICKS:
		return {"result": _result}
	return null
```

- [ ] **Step 2: Rewire `project_ops.gd` and delete `ScanTask`**

In `addon/godot_mcp/ops/project_ops.gd`:

2a. Directly below the `extends "op_base.gd"` line (and its file docblock), add:

```gdscript
const DeferredScanTask := preload("deferred_scan_task.gd")
```

2b. In the `_op_import_assets` docblock, change the sentence fragment `defer the response via ScanTask` to `defer the response via DeferredScanTask`.

2c. Replace the deferred branch inside `_op_import_assets`:

```gdscript
	if paths.is_empty():
		fs.scan()
		return {"task": ScanTask.new(server, id, fs)}
```

with:

```gdscript
	if paths.is_empty():
		fs.scan()
		return {"task": DeferredScanTask.new(server, id, fs, "scan", {
			"scan_started": true, "scan_completed": true, "reimported": [],
		})}
```

2d. Delete the entire `class ScanTask:` block **and** its `## Deferred whole-project scan (REQ-A-11): …` docblock above it (currently lines 143–170 — everything between `_op_import_assets`'s final `return` and the `## Resource UID lookup (REQ-B-08)` docblock).

- [ ] **Step 3: Rewire `mesh_library_ops.gd` and delete `RegisterTask`**

In `addon/godot_mcp/ops/mesh_library_ops.gd`:

3a. Directly below the `extends "op_base.gd"` line and the file docblock, add:

```gdscript
const DeferredScanTask := preload("deferred_scan_task.gd")
```

3b. In the file docblock (lines ~14–15), change `the op kicks off a full scan() and defers the response via RegisterTask until it completes.` to `the op kicks off a full scan() and defers the response via DeferredScanTask until it completes.`

3c. In the comment block above the deferred branch (line ~103), change `Otherwise defer to RegisterTask, which kicks off a` to `Otherwise defer to DeferredScanTask, which kicks off a`.

3d. Replace:

```gdscript
	fs.scan()
	return {"task": RegisterTask.new(server, id, fs, result)}
```

with:

```gdscript
	fs.scan()
	return {"task": DeferredScanTask.new(server, id, fs, "register", result)}
```

3e. Delete the entire `class RegisterTask:` block **and** its `## Deferred registration for an export into a brand-new directory (REQ-A-11): …` docblock (currently lines 123–155, through the end of the file).

- [ ] **Step 4: Run the long-ops integration suite (regression gate)**

Run: `npm run test:integration -- test/integration/long-ops.integration.test.ts`

Expected: `Tests  8 passed (8)` — the bare-import test now exercises the grace-expiry branch; the MeshLibrary brand-new-directory test exercises the observed-scan branch. If the output instead shows a `[coverage] SKIPPED` warning and 0 tests, `GODOT_PATH` is unset — stop and report.

- [ ] **Step 5: Commit**

```bash
git add addon/godot_mcp/ops/deferred_scan_task.gd addon/godot_mcp/ops/project_ops.gd addon/godot_mcp/ops/mesh_library_ops.gd
git commit -m "refactor: shared DeferredScanTask with a scan-start gate - dedup ScanTask/RegisterTask (#95, REQ-A-11)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

### Task 2: Wall-clock cap + `tick()` outcome guard in `server.gd` (spec §2–§4, fixes hang + crash path)

**Files:**

- Modify: `test/integration/support.ts` (new helper, after `setBridgePort` at line ~56)
- Create: `test/integration/deferred-cap.integration.test.ts`
- Modify: `addon/godot_mcp/server.gd` (consts ~line 12, new helper after `_configured_port` ~line 75, `_drain_queue` arming ~line 166, `_tick_inflight` ~line 188)

**Interfaces:**

- Consumes: `DeferredScanTask` from Task 1 only indirectly — `_tick_inflight` still calls `task.call("tick")` and treats `null` / `{result}` / `{error}` outcomes exactly as today. Test helpers `freshSampleProject`, `installAddon`, `pickFreePort`, `setBridgePort`, `importPass`, `launchEditor`, `hasGodot`, `type EditorHandle` from `test/integration/support.ts`; `BridgeConnection` from `src/bridge/connection.js`; `SERVER_VERSION` from `src/server.js`; `createProjectTools` from `src/tools/project.js`.
- Produces: `setDeferredOpTimeout(projectDir: string, ms: number): void` in `support.ts`; ProjectSettings key `godot_mcp/network/deferred_op_timeout_ms`; bridge error codes `deferred_op_timeout` and `internal_error` (REQ-A-08 shape). Nothing downstream consumes these yet.

- [ ] **Step 1: Add the `setDeferredOpTimeout` helper to `test/integration/support.ts`**

Insert directly after the `setBridgePort` function (line ~63):

```ts
/**
 * Appends godot_mcp/network/deferred_op_timeout_ms to project.godot (#95).
 * Must run after setBridgePort: the [godot_mcp] section must already exist,
 * and the appended key lands inside it because that section is the file's
 * tail (setBridgePort appends it last).
 */
export function setDeferredOpTimeout(projectDir: string, ms: number): void {
  const projectFile = path.join(projectDir, "project.godot");
  const current = readFileSync(projectFile, "utf8");
  if (!current.includes("[godot_mcp]")) {
    throw new Error("call setBridgePort first: the [godot_mcp] section must exist");
  }
  appendFileSync(projectFile, `network/deferred_op_timeout_ms=${ms}\n`);
}
```

(`path`, `readFileSync`, `appendFileSync` are already imported in this file.)

- [ ] **Step 2: Write the failing cap suite**

Create `test/integration/deferred-cap.integration.test.ts` with exactly this content:

```ts
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createProjectTools } from "../../src/tools/project.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  setBridgePort,
  setDeferredOpTimeout,
  type EditorHandle,
} from "./support.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

async function callProjectTool(
  bridge: BridgeConnection,
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tools = createProjectTools({ bridge });
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

// A 1 ms cap: the deadline check runs before the task's first tick, and that
// tick arrives no earlier than the next editor frame (> 1 ms after arming),
// so expiry fires deterministically - even an instantly-finishing scan cannot
// complete first (completion needs at least two ticks via the observed path,
// or ten via the grace). See the #95 design spec, §4.
describe.runIf(hasGodot)("deferred-op wall-clock cap vs a real editor (#95, REQ-A-12)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
    const port = await pickFreePort();
    setBridgePort(projectDir, port);
    setDeferredOpTimeout(projectDir, 1);
    await importPass(projectDir);
    editor = launchEditor(projectDir);
    bridge = new BridgeConnection({
      url: `ws://127.0.0.1:${port}`,
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 30_000,
      reconnectDelayMs: 500,
      log: (message) => {
        if (process.env.DEBUG) console.error(message);
      },
    });
    bridge.start();
    await bridge.waitForState("connected", 150_000);
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  it("a deferred op exceeding the cap fails with a structured deferred_op_timeout", async () => {
    const result = await callProjectTool(bridge, "import_assets", {});
    expect(result.isError).toBe(true);
    const text = JSON.stringify(result.content);
    expect(text).toContain("deferred_op_timeout");
    expect(text).toContain("wall-clock cap");
    expect(text).toContain("deferred_op_timeout_ms");
  }, 120_000);

  it("the queue drains after the timeout - the next op is served (REQ-A-12)", async () => {
    const listing = (await bridge.request("project/list_resources", {})) as {
      resources: Array<{ path: string }>;
      count: number;
    };
    expect(listing.count).toBeGreaterThan(0);
  }, 60_000);
});
```

- [ ] **Step 3: Run the new suite to verify it fails for the right reason**

Run: `npm run test:integration -- test/integration/deferred-cap.integration.test.ts`

Expected: `Tests  1 failed | 1 passed (2)` — the first test fails with `expected false to be true` (or `expected undefined to be true`): the addon has no cap yet, so bare `import_assets` succeeds. The second test passes (nothing is wedged). If instead 0 tests ran, `GODOT_PATH` is unset — stop and report.

- [ ] **Step 4: Implement the cap and the outcome guard in `server.gd`**

4a. Below `const PORT_SETTING := "godot_mcp/network/port"` (line 12), add:

```gdscript
const DEFERRED_TIMEOUT_SETTING := "godot_mcp/network/deferred_op_timeout_ms"
const DEFAULT_DEFERRED_TIMEOUT_MS := 300_000
```

4b. Directly after the `_configured_port()` function (line ~75), add:

```gdscript
## Reads godot_mcp/network/deferred_op_timeout_ms - the wall-clock cap (#95)
## on how long one deferred op may hold the queue - falling back to the
## default on non-numeric or non-positive values (mirrors _configured_port).
func _deferred_op_timeout_ms() -> int:
	if not ProjectSettings.has_setting(DEFERRED_TIMEOUT_SETTING):
		return DEFAULT_DEFERRED_TIMEOUT_MS
	var raw: Variant = ProjectSettings.get_setting(DEFERRED_TIMEOUT_SETTING)
	var timeout_ms := int(raw)
	if timeout_ms < 1:
		push_warning("[godot-mcp] Ignoring invalid %s value %s; using default %d ms." % [DEFERRED_TIMEOUT_SETTING, str(raw), DEFAULT_DEFERRED_TIMEOUT_MS])
		return DEFAULT_DEFERRED_TIMEOUT_MS
	return timeout_ms
```

4c. In `_drain_queue` (line ~166), replace:

```gdscript
	if outcome.has("task"):
		# Deferred op (REQ-A-11): hold the queue and tick it each frame.
		_inflight = {"id": id, "task": outcome["task"]}
```

with:

```gdscript
	if outcome.has("task"):
		# Deferred op (REQ-A-11): hold the queue and tick it each frame. The
		# wall-clock cap (#95) is stamped now so _tick_inflight can always
		# free the slot - progress re-arms the CLIENT's deadline, so without
		# this cap a task that never completes would wedge the bridge forever.
		var cap_ms := _deferred_op_timeout_ms()
		_inflight = {
			"id": id,
			"task": outcome["task"],
			"cap_ms": cap_ms,
			"deadline_ms": Time.get_ticks_msec() + cap_ms,
		}
```

4d. Replace the whole `_tick_inflight` function (lines ~186–201, including its docblock) with:

```gdscript
## Ticks the in-flight deferred op, if any. tick() returns null while still
## running (it may have emitted progress) or a {result}/{error} outcome dict.
## The wall-clock cap (#95) is checked BEFORE ticking: on expiry the task is
## abandoned (dropped - any underlying editor scan continues harmlessly, and
## no late frames can leak since only the armed task emits progress for its
## id), a structured error is sent, and the queue resumes draining this same
## frame (REQ-A-12). The outcome guard keeps a future task's malformed tick()
## return from crashing the queue.
func _tick_inflight() -> void:
	if _inflight.is_empty():
		return
	var id: Variant = _inflight["id"]
	if Time.get_ticks_msec() >= int(_inflight["deadline_ms"]):
		var cap_ms := int(_inflight["cap_ms"])
		_inflight = {}
		_send_json({"id": id, "error": {
			"code": "deferred_op_timeout",
			"message": "Deferred op exceeded the %d ms wall-clock cap and was abandoned." % cap_ms,
			"possibleSolutions": [
				"Raise godot_mcp/network/deferred_op_timeout_ms in project settings if this op legitimately needs longer.",
				"Check the editor for a stuck filesystem scan.",
			],
		}})
		return
	var task: RefCounted = _inflight["task"]
	var outcome: Variant = task.call("tick")
	if outcome == null:
		return
	_inflight = {}
	if not (outcome is Dictionary):
		_send_json({"id": id, "error": {
			"code": "internal_error",
			"message": "Deferred task returned a malformed outcome (%s)." % type_string(typeof(outcome)),
			"possibleSolutions": [
				"This is an addon bug - report it with the op name and editor log.",
			],
		}})
		return
	var outcome_dict: Dictionary = outcome
	if outcome_dict.has("error"):
		_send_json({"id": id, "error": outcome_dict["error"]})
	else:
		_send_json({"id": id, "result": outcome_dict.get("result")})
```

- [ ] **Step 5: Run the cap suite to verify it passes**

Run: `npm run test:integration -- test/integration/deferred-cap.integration.test.ts`

Expected: `Tests  2 passed (2)`.

- [ ] **Step 6: Run the long-ops suite (default-cap regression)**

Run: `npm run test:integration -- test/integration/long-ops.integration.test.ts`

Expected: `Tests  8 passed (8)` — under the default 300 000 ms cap nothing times out; the spec's "existing long-ops suite stays green" acceptance criterion.

- [ ] **Step 7: TS gates on the changed test files**

```bash
npx prettier --write test/integration/support.ts test/integration/deferred-cap.integration.test.ts
npm run lint
npm run typecheck
npm test
```

Expected: prettier rewrites (or leaves unchanged) the two files; eslint, tsc, and the unit suite all pass (no `src/` changes, so failures here mean a typo in the test files).

- [ ] **Step 8: Commit**

```bash
git add addon/godot_mcp/server.gd test/integration/support.ts test/integration/deferred-cap.integration.test.ts
git commit -m "fix: wall-clock cap + tick() outcome guard on deferred ops - the queue always frees (#95, REQ-A-12)

Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>"
```

---

## Acceptance checklist (from issue #95 / spec)

- Scan-start gate: completion requires an observed `is_scanning() == true` or 10-tick grace expiry — Task 1, asserted via the long-ops suite where feasible (spec §4).
- `_tick_inflight` survives a malformed `tick()` return with a structured `internal_error`; queue keeps serving — Task 2 Step 4d (verified by review; not reachable end-to-end).
- A deferred task exceeding the cap yields structured `deferred_op_timeout`, frees `_inflight`, next op served — Task 2, asserted by `deferred-cap.integration.test.ts`.
- Existing long-ops integration suite stays green — Task 1 Step 4 and Task 2 Step 6.
