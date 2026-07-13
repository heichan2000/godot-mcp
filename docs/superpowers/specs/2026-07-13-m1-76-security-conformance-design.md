# M1 security conformance — design (#76)

**Issue:** #76 · **Parent PRD:** #63 · **Covers:** REQ-M-01, REQ-M-03, REQ-M-07, real-op half of REQ-A-12
**Date:** 2026-07-13 · **Status:** approved

## Summary

The conformance slice that #64/#65 deferred their real-op proofs to. Nothing new for
agents to call: four standing CI gates that make M1's safety rails demonstrable.
Production code changes are limited to gaps the sweeps expose; one is already
known (see §1b: `uid/get` skips the addon-side re-check) and fixing it is in
scope here.

Existing pieces this slice builds on (verified, not re-implemented):

- Server containment: `assertInsideRoot` (realpath of deepest existing ancestor) and
  `containResPath` (`res://` structural check) in `src/godot/paths.ts`, unit-tested
  down to Windows/UNC/symlink cases in `test/unit/path-containment.test.ts`.
- Addon re-check: `op_base.gd::_scene_res_path` rejects non-`res://` and `..` segments.
- Fake-peer serialization proof: `test/unit/bridge-connection.test.ts:170` (#65).
- Logging discipline: `stdio-clean.integration.test.ts` proves stdout stays protocol-clean
  and stderr is `DEBUG`-gated against the real built artifact.
- The addon bridge listens via one `TCPServer` on `"127.0.0.1"` (`server.gd`), greets
  with a `hello` frame, and dispatches through a named-op `match` table.

## 1. Dual-layer containment (REQ-M-01)

Two new suites, each proving one layer with the other layer bypassed.

### 1a. Server layer alone — `test/unit/containment-sweep.test.ts`

- Enumerates the real descriptor array (the same array `createServer` registers).
- **Path-param discovery:** a parameter is path-like when its name is `path` or ends
  in `_path`. Every path-like param must appear either in the sweep table or in an
  explicit, commented exemption list (params that are intentionally not contained,
  e.g. `project_path` itself — it _is_ the containment root — and host-level config
  roots like the projects listing root). A path-like param in neither place **fails
  the test** — future tools are conscripted automatically.
- **Payload matrix** fed to every swept param (via the tool handler, wired to the
  existing fake addon peer):
  - `../../etc/passwd` (the PRD §11 smoke, verbatim)
  - `a/b/../../../escape.tscn` (nested interior climb)
  - `/etc/passwd` (POSIX absolute)
  - `C:\Windows\System32\evil.tscn` and `C:/Windows/evil.tscn` (Windows absolute)
  - `..\\..\\escape.tscn` (backslash traversal)
  - `res://../escape.tscn` (res-relative climb)
  - `user://escape.tscn`, `file:///etc/passwd` (foreign schemes)
- **Asserts, per tool × payload:** the guided error shape (`isError: true` with
  `possibleSolutions`) **and zero frames sent to the fake peer**. The peer would
  execute anything — proving rejection happened entirely server-side is the
  "addon bypassed" half of the dual-layer proof.
- Runs on both CI OSes; the Windows leg exercises the Windows-shaped payloads on a
  real Windows path implementation (REQ-M-01 acceptance: "Windows path cases
  unit-tested").

### 1b. Addon layer alone — `test/integration/addon-containment.integration.test.ts`

- Spawns the real editor with the fixture project (existing integration harness),
  but **never starts the TS server**. Instead the test connects a **raw WebSocket
  client** built on the shared protocol constants (`PROTOCOL_VERSION`, frame shapes
  from `src/bridge/protocol.ts`), consumes the `hello`, then speaks raw JSON ops.
  The bridge is single-client (close 1013 on a second) — with no TS server running,
  the raw client is the sole client.
- Sends escaping paths that the server layer would normally have rejected —
  `res://../../etc/passwd`, `../../etc/passwd`, `/etc/passwd` — to every
  path-taking op in the dispatch table:
  - `scene/create`, `scene/open`, `run/play` (scene mode), and
    `scene/export_mesh_library` (both `scene_path` and `output_path`) — all
    re-check via `_scene_res_path` today; expected rejection: `path_escape`.
  - `scene/save` and `scene/close` (`scene_path` targets an open scene) —
    an escaping path can never match an open scene; expected rejection: their
    structured not-open error. The suite pins that this stays an error, never
    a write.
  - `uid/get` (`path`) — **known gap found while writing this spec:**
    `project_ops.gd::_op_get_uid` feeds the raw param straight to
    `FileAccess.file_exists` with no `_scene_res_path` re-check, so an absolute
    path probes the host filesystem (an existence-leak, read-only). In-scope
    fix: add the `_scene_res_path` re-check and reject with `path_escape`
    before any `FileAccess` call; the suite proves the fix.
  - `assets/import` (`paths[]`) and `project/list_resources` (`directory`) —
    **two sibling gaps found while planning:** neither runs `_scene_res_path`
    on its caller-supplied paths. Same in-scope fix as `uid/get`: reject with
    `path_escape` before touching the editor filesystem. Their server-side
    tools (`import_assets`, `list_resources`) also forward these params with
    no `resolveProjectPath` call — the §1a sweep exposes that, and adding
    server-side containment there is in scope too.
- **Asserts, per op × payload:** a structured error frame (the addon's `_err`
  shape) — never a result — **and** that the would-be escape target does not
  exist on disk afterwards (checked at the resolved location next to the fixture
  project).
- Also carries the runtime loopback assert from §3.

## 2. Code-exec CI audit (REQ-M-03)

- **`auditCodeExec(entries: string[]): string[]`** in `test/support/code-exec-audit.ts`:
  tokenizes each entry on `_`, `/`, and case boundaries; returns entries containing
  any deny token. Deny tokens (exact set):
  `eval`, `exec`, `execute`, `expr`, `expression`, `shell`, `cmd`, `command`,
  `code`, `interpret`, `interpreter`, `compile`, `inject`.
  Token-based matching keeps `run_project` and `get_script_errors` clean.
- **`test/unit/code-exec-audit.test.ts`** — the standing gate, running in the
  existing unit CI job on every PR:
  1. Audits the imported TS descriptor array (tool names) → must be empty.
  2. Regex-parses the addon op table from `server.gd` match arms
     (`/^\s*"([a-z_]+\/[a-z_]+)":/m`, same file-parsing style as
     `addon-lockstep.test.ts`), audits the op names → must be empty.
  3. **Parse-rot guard:** asserts the parsed op table has at least as many entries
     as a pinned floor (the count at implementation time), so a regex that silently
     stops matching fails loudly.
  4. **Decoy proof:** audits the real inventory plus `script/execute_expression`
     and `run_code_snippet`; asserts exactly those two are flagged. The gate
     demonstrably fires — this is #76's "code-exec-shaped decoy fails CI" demo,
     expressed as an always-running assertion instead of a throwaway branch.

## 3. No telemetry (REQ-M-07)

- **`test/unit/no-telemetry-audit.test.ts`** (static audits over source text):
  - **Addon:** across all `addon/godot_mcp/**/*.gd`, deny-scan for network APIs —
    `HTTPRequest`, `HTTPClient`, `StreamPeerTCP`, `PacketPeerUDP`, `UDPServer`,
    `ENetMultiplayerPeer`, `WebSocketMultiplayerPeer`, `OS.shell_open`. Allowed:
    exactly one `TCPServer` and its `WebSocketPeer` usage, in `server.gd`, and the
    `listen` call must bind the literal `"127.0.0.1"`.
  - **Server:** no file under `src/` imports `node:http`, `node:https`, `node:net`,
    `node:dgram`, `node:tls`, or calls `fetch(`; the bridge connection URL is
    built from a loopback host constant (asserted on the source of
    `src/bridge/connection.ts`).
- **Runtime bind assert** (inside §1b's integration suite): enumerate
  `os.networkInterfaces()`, pick a non-internal IPv4 address; a TCP connect to
  `<that address>:<bridge port>` must be refused while `127.0.0.1:<port>` accepts.
  Skipped (with a logged note) when the runner exposes no non-loopback interface.
- Server-side logging discipline (stdout protocol-clean, stderr `DEBUG`-gated) is
  already enforced by `stdio-clean.integration.test.ts`; addon logging runs through
  `print`/`push_error` only, which the static audit's API deny-list keeps true by
  construction (no file-logger or network-logger APIs available to it).

## 4. Real-op serialization (REQ-A-12)

- **`test/integration/serialization.integration.test.ts`** — real editor **and**
  real MCP server (normal harness), fresh scene per round.
- One round = a `Promise.all` burst of 10 concurrent mutating tool calls with
  deliberate intra-burst dependencies that only succeed in arrival order:
  1. create node `A` under root
  2. rename `A` → `B`
  3. add child `C` under `B`
  4. set a property on `C`
  5. duplicate `C` → `C2`
     6–10. independent node creates (`P1`…`P5`) padding the burst so the queue is
     genuinely contended.
- **Asserts:** every call succeeds (out-of-order execution would make the
  dependent ops 2–5 fail); responses complete in send order (FIFO observable
  end-to-end); the final scene tree read-back matches one exact expected shape.
- **Determinism across runs:** the test runs **two rounds** on fresh scenes and
  asserts both final trees are identical to each other and to the expected shape —
  the "same scene every run" demo, observed within one CI run and re-observed on
  every PR.
- Joins the serialized integration suite order (`fileParallelism: false` — one
  editor at a time, per #96).

## Error handling

All rejections reuse existing shapes: the server's guided `createErrorResponse`
(`possibleSolutions[]`) and the addon's `_err` structured op error. This slice adds
no new error formats.

## Acceptance mapping (issue #76)

| Criterion                                                                                             | Where proven                                                       |
| ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Escaping paths rejected by server AND addon, each in isolation, every path-taking tool, Windows cases | §1a sweep (+ completeness guard) and §1b raw-WS suite              |
| CI audit walks descriptor array + op table, fails on code-exec-shaped entries, decoy-proven           | §2 unit gate with in-test decoys                                   |
| No telemetry: stderr-only DEBUG-gated server logs, addon → Output panel only, loopback-only network   | §3 static audits + runtime bind assert + existing stdio-clean test |
| Concurrent burst of real mutating ops executes serially in arrival order, deterministic final scene   | §4 two-round burst with order-dependent ops                        |

## Out of scope

- New tools, protocol changes, or addon features.
- Runtime network capture (strace/lsof) in CI — rejected as flaky and
  platform-specific; the static audits + bind assert cover the claim.
- GDScript-side unit tests (GUT) — the raw-WS integration suite proves the addon
  layer without introducing a second test framework.
