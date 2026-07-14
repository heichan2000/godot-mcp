# Design: #77 — M1 release slice (2.0.0-alpha on `next`, tool reference, exit demo)

**Issue:** #77 · **Parent:** #63 (M1 PRD) · **Covers:** REQ-A-07 (CI half — already done), PRD §6.6 parity checklist, §10 packaging/docs, §11 verification · **Date:** 2026-07-13

## Context

#77 is the M1 closing slice. Most of its acceptance criteria were delivered by
earlier issues and only need to be *demonstrated* here:

- **CI matrix (REQ-A-07)** — done in #71/#96: unit on ubuntu + windows,
  integration on ubuntu × Godot 4.6/4.7 under xvfb, editor logs on failure.
- **README v2 + per-client setup + headless→1.x pointer + config reference** —
  PR #100 (merges before this work starts).
- **Progressive-disclosure strategy doc** — exists as `docs/tool-naming.md`.
- **Version** — `package.json` is already `2.0.0-alpha.0`; the lockstep test
  pairs it with the addon version.

What this design actually builds: npm packaging of the addon + a startup
payload check, a generated tool reference with a drift gate, the scripted
exit demo (smoke loop + 19-row parity walk), and a documented manual release
process.

## Decisions (locked with the scope owner)

1. **Exit demo = integration test file**, not a standalone script. It runs in
   the existing CI matrix on both Godot minors forever.
2. **Parity walk = narrative + row ledger** inside that one test file — each
   §6.6 row is demonstrated by a real tool call inside the §11 story; an
   in-code ledger fails the demo if any row wasn't walked.
3. **Publish is manual** — `npm publish --tag next` from the maintainer's
   machine, gated by the existing `prepublishOnly` chain; a release checklist
   doc replaces automation. No npm token in CI.
4. **Tool reference = generated `docs/tools.md` + CI drift gate.** README's
   hand-curated overview stays and links to it.
5. **Sequencing** — PR #100 merges first; #77 work happens on a fresh branch
   off main, shipping one clean release-slice PR.
6. **Tool names** — PRD §6.6's M1 column has stale names (`run_scene`,
   `stop_running`, `get_node_properties`, `addon_install`). The walk pins to
   the **shipped registry names** (`run_project`, `stop_project`,
   `read_node_properties`, `install_addon`); §6.6 row numbers remain the
   traceability key.
7. **Sample project stays as-is** — `examples/sample-project/project.godot`
   already enables the plugin and tests copy the addon in via
   `installAddon()`, the same path the quickstart's `install_addon` tool
   takes. No second committed copy of the addon to drift.

## Component 1 — Packaging & startup payload verification (§10)

- `package.json` `files` becomes `["dist", "addon", "README.md", "LICENSE"]`.
  `resolveBundledAddonDir()` already resolves `<pkg>/addon/godot_mcp`
  relative to `dist/`, so the published layout needs no path changes.
- `main()` verifies the payload **before starting the bridge**: sentinel
  check that `addon/godot_mcp/plugin.cfg` and `addon/godot_mcp/server.gd`
  exist. On failure: a clear stderr error naming the expected path and the
  fix (broken install → reinstall `@cradial/godot-mcp@next`), then exit
  non-zero. Successor of 1.0's `operations.gd` presence check. **Not**
  DEBUG-gated — a corrupt install must be loud.
- Unit tests: the check passes against the repo layout; against a tampered
  temp layout it produces the structured message and non-zero exit, via
  injected exit/log seams (same pattern as `createShutdown`).

## Component 2 — Tool reference generator (§10)

- `scripts/generate-tool-docs.ts`, wired as `npm run docs:tools`. It calls
  the existing `buildToolInventory()` with an inert `BridgeConnection`
  (constructed, never `start()`ed — descriptors need the dep at call time,
  not build time), so the doc derives from the exact descriptor array the
  server registers.
- Output `docs/tools.md`: one table per domain, grouped in registration
  order (matching `src/tools/*.ts`); columns = tool name, description,
  parameters (name / type / required, read from each descriptor's schema —
  the same JSON schema MCP clients see). Generated-file header: "do not
  edit; run `npm run docs:tools`". The script always writes LF.
- **Drift gate:** a step in the CI unit job, **ubuntu leg only** (sidesteps
  CRLF noise on windows): `npm run docs:tools && git diff --exit-code
  docs/tools.md`.
- A unit test asserts the generator runs clean against the current
  inventory, so the ubuntu-only CI step is not the first place it can break.
- README gains one link to `docs/tools.md` (small edit on main after #100
  merges — part of this PR).

## Component 3 — Exit demo (§11 + §6.6)

One new file: `test/integration/exit-demo.integration.test.ts`. One
`describe`, sequential `it()` steps sharing a single editor session (the
integration suite already runs `fileParallelism: false`). Reuses the
`test/integration/support.ts` harness (editor launch/kill/relaunch, addon
install, log capture). No new tools or addon ops — `edit/undo` and the
kill/relaunch harness already exist.

**Narrative (the §11 smoke loop):**

1. `create_project` scaffolds into an empty temp dir → `install_addon` →
   launch editor → `bridge_status` + `get_godot_version` show handshake data
   (rows 1, 2).
2. Orientation reads: `list_projects`, `get_project_info`, `list_resources`
   (rows 4, 5, 19).
3. Drop a PNG → `import_assets` (row 3) → `get_uid` +
   `update_project_uids` (rows 14, 15).
4. `create_scene` (row 9) → `add_node` ×N (row 10) → `set_node_properties`
   with `"Vector2(100, 50)"` and a texture by `res://` path (row 11) →
   `read_node_properties` round-trips both (row 17) → `get_scene_tree`
   shows the structure (row 16).
5. `move_node` / `rename_node` → `remove_node` returns the manifest →
   `edit/undo` bridge op restores the subtree (the "Ctrl+Z" leg) →
   `save_scene` (row 12).
6. `get_script_errors` on a script fixture (row 18) → `run_project` →
   `get_debug_output` tails logs → `stop_project` (rows 6, 7, 8) →
   `export_mesh_library` on a mesh fixture (row 13).
7. `scene_path: ../../etc/passwd` → containment rejection (structured
   error) → kill the editor → structured disconnect error → relaunch →
   auto-reconnect proven by one successful call.

**Row ledger:** a `const PARITY_ROWS` table of the 19 §6.6 rows (row number,
1.0 tool, shipped M1 tool, REQ) at the top of the file. Each step calls
`ledger.walk(rowN)` at the point the row's tool call succeeds; the final
`it()` asserts every row was walked. Adding a §6.6 row without walking it
fails the demo — the checklist cannot rot.

Error-shape assertions on the containment and disconnect legs match the
existing suites (`isError: true`, `possibleSolutions[]`).

## Component 4 — Release process (§10, AD-3)

`docs/releasing.md`, a short checklist replacing publish automation:

1. Preconditions: on `main`, clean tree, CI green on the fresh-clone matrix.
2. Confirm `package.json` version (`2.0.0-alpha.0` first; bump the alpha
   number for subsequent releases — the lockstep test keeps the addon
   version paired).
3. `npm pack --dry-run` — confirm `addon/` is in the tarball.
4. `npm publish --tag next` (`prepublishOnly` runs lint → typecheck →
   format → test → build).
5. Verify: `npm view @cradial/godot-mcp dist-tags` shows
   `next: 2.0.0-alpha.x` with `latest` untouched on 1.x.
6. Smoke the published artifact: `npx -y @cradial/godot-mcp@next` starts and
   passes the payload check — this exercises Component 1 against the real
   tarball, the one place a `files` mistake would show.

## Acceptance criteria → components

| #77 criterion | Covered by |
|---|---|
| `2.0.0-alpha.x` on `next`; `latest` stays 1.x; addon bundled; startup verifies payload | Components 1 + 4 |
| CI green on fresh clone across the matrix | Already done (#71/#96); re-verified at release time (Component 4 step 1) |
| All 19 §6.6 parity rows pass in the scripted walk | Component 3 ledger |
| §11 smoke loop end-to-end incl. undo + kill-editor/reconnect | Component 3 narrative |
| README v2 + per-client setup + generated tool reference + headless→1.x pointer | PR #100 (merged first) + Component 2 |

## Testing summary

- **Unit:** startup payload check (pass + tampered-layout fail via injected
  seams); generator runs clean against the current inventory.
- **CI:** drift gate on the ubuntu unit leg.
- **Integration:** the exit demo is itself a test, on both Godot minors.
- **Release-time:** `npm pack --dry-run` + `npx @next` smoke per
  `docs/releasing.md`.

## Out of scope

- CI matrix changes (done), README/per-client docs (#100), the strategy doc
  (`docs/tool-naming.md` exists), new tools or addon ops, publish
  automation / npm tokens in CI, anything M2+.
