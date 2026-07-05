# Tool naming & progressive disclosure (REQ-A-05)

v2 ships large per-domain tool suites (AD-8). What keeps that usable is a
context-discipline strategy enforced by a standing lint
(`test/unit/naming-lint.test.ts`, run on every CI leg):

## Rules (lint-enforced)

1. **Names**: `snake_case`, at least two segments, `domain_verb_noun` style —
   the segments an agent scans first carry the domain and the action
   (`bridge_status`, `get_godot_version`, `create_scene`, `add_node`).
   Prefer the established Godot term over an invented one.
2. **Descriptions**: single line, ≤ 200 characters, starting with the verb
   phrase ("Report…", "Create…"). No usage essays — parameter docs belong on
   the zod schemas, error guidance belongs in `possibleSolutions`.
3. **Params**: `snake_case` keys, validated by zod schemas
   (`src/schemas.ts` fragments where shared).
4. **Uniqueness**: duplicate names fail registration (`registerAll`) _and_
   the lint.

## Strategy (human judgment, reviewed at PR time)

- **Domain grouping**: tools live in per-domain files under `src/tools/`;
  registration order groups domains together so clients that list tools see
  a coherent catalogue.
- **Deferred discovery**: lean names + lean descriptions are what make
  deferred/searchable tool loading work in capable clients; write for the
  agent that greps a 150-tool list, not for a README reader.
- **Router meta-tools** (REQ-A-06) arrive in M3 for clients without deferred
  loading; nothing in M1/M2 may depend on their existence.
- **Renames are breaking**: after the first `2.0.0-alpha` publish, renaming a
  tool requires a changelog entry and a deprecation note in the description
  of any transitional alias.
