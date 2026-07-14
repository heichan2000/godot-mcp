# Releasing `@cradial/godot-mcp`

v2 alphas publish to the **`next`** dist-tag. `latest` stays on the 1.x
(headless) line until v2 is stable, so existing `npm install @cradial/godot-mcp`
users are never moved onto the editor-required major by accident (AD-3).

Publishing is **manual** — there is no npm token in CI. The `prepublishOnly`
script (`lint → typecheck → format → test → build`) gates every publish.

## Preconditions

1. You are on `main` with a clean working tree (`git status` shows nothing).
2. CI is green on `main` across the full matrix: unit on ubuntu + windows,
   integration on ubuntu × Godot 4.6-stable and 4.7-stable.
3. `package.json` `version` is the alpha you intend to ship. The first release
   is `2.0.0-alpha.0`; bump the alpha number for each subsequent one
   (`2.0.0-alpha.1`, …). `SERVER_VERSION` in `src/server.ts` is kept in lockstep
   and asserted by `test/unit/server.test.ts`, so bump both together.

## Publish

1. Confirm the addon is in the tarball:

   ```bash
   npm pack --dry-run 2>&1 | grep addon/godot_mcp
   ```

   You should see `addon/godot_mcp/plugin.cfg`, `.../server.gd`, and the
   `ops/` and `runtime/` scripts. If they are absent, the `files` set in
   `package.json` is wrong — fix it before publishing.

2. Publish to the `next` tag:

   ```bash
   npm publish --tag next
   ```

   `prepublishOnly` runs the full gate first; a failure aborts the publish.

## Verify

1. The dist-tags are correct — `next` moved, `latest` untouched:

   ```bash
   npm view @cradial/godot-mcp dist-tags
   ```

   Expected: `next: 2.0.0-alpha.x` and `latest` still on a `1.x` version.

2. The published artifact starts and passes its own addon payload check:

   ```bash
   npx -y @cradial/godot-mcp@next
   ```

   It should start the stdio server without the
   `Bundled Godot addon payload is missing` error (Ctrl+C to exit). This is
   the one check that exercises the real published tarball end to end — if the
   addon failed to ship, this is where it surfaces.
