# M1 Security Conformance (#76) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make M1's safety rails demonstrable and CI-enforced: dual-layer path containment proven per layer, a standing code-exec inventory audit, no-telemetry verification, and the real-editor serialization proof (REQ-M-01, REQ-M-03, REQ-M-07, REQ-A-12).

**Architecture:** Four standing test gates plus the containment gaps they expose. Unit gates (sweep, code-exec audit, telemetry audit) run against the exported `buildToolInventory` and the addon source text with no Godot installed. Integration gates drive a real editor: one suite speaks raw WebSocket frames to the addon bridge (bypassing the TS server entirely — the addon-layer isolation proof), one fires a concurrent mutating burst through the normal server path.

**Tech Stack:** TypeScript + vitest (unit and integration configs), `ws` for the raw client, GDScript addon ops, existing integration harness in `test/integration/support.ts`.

**Spec:** `docs/superpowers/specs/2026-07-13-m1-76-security-conformance-design.md`

**Branch:** create `m1/76-security-conformance` off `main` before Task 1.

## Global Constraints

- Conventional commits with issue/REQ tags, e.g. `test: containment sweep across every path-taking tool (#76, REQ-M-01)`.
- All new/changed files must pass `npm run lint`, `npm run format` (prettier — also formats markdown docs), and `npm run typecheck`.
- Unit tests must run with no Godot installed: `npm test` (vitest unit config). Integration tests need `GODOT_PATH` pointing at a Godot 4.x editor binary: `npm run test:integration`. Integration suites run serially (`fileParallelism: false`) — never assume another editor isn't using a hardcoded port; always `pickFreePort()`.
- Locally on Windows, set `GODOT_MCP_TEST_HEADLESS=1` to keep editor windows from opening during integration runs (optional; CI uses xvfb).
- Tool error shape: `isError: true`, `content[0].text` starts with the message and lists `Possible solutions:`, `structuredContent: { message, possibleSolutions }` (see `src/errors.ts`). Addon op errors: `{"error": {"code", "message", "possibleSolutions"}}` frames.
- Never weaken an existing test to make a new gate pass. If a gate exposes a production gap, the fix belongs in this plan's tasks (Tasks 3 and 5 contain the known ones).

---

### Task 1: Code-exec audit — standing REQ-M-03 gate

The audit is a pure function over inventory names, run in the unit CI job on every PR. It walks **both** inventories: the TS tool descriptor array (via the exported `buildToolInventory`) and the addon op table (regex-parsed from `server.gd`'s match arms, same style as `test/unit/addon-lockstep.test.ts`).

**Files:**

- Create: `test/support/code-exec-audit.ts`
- Create: `test/unit/code-exec-audit.test.ts`

**Interfaces:**

- Consumes: `buildToolInventory(deps: ServerDeps): ToolDescriptor[]` and `SERVER_VERSION` from `src/server.ts`; `BridgePort` from `src/tools/bridge.ts`.
- Produces: `auditCodeExec(entries: readonly string[]): string[]` and `parseAddonOpTable(source: string): string[]` in `test/support/code-exec-audit.ts` (no later task consumes them; they are this gate's public seam).

- [ ] **Step 1: Write the helper**

Create `test/support/code-exec-audit.ts`:

```ts
/**
 * REQ-M-03 code-exec audit (#76): flags inventory entries whose name contains
 * an eval/exec-shaped token. Token-based (split on `_`, `/`, and camelCase
 * boundaries), so run_project and get_script_errors stay clean while
 * execute_expression or run_code_snippet are flagged.
 */
const DENY_TOKENS = new Set([
  "eval",
  "exec",
  "execute",
  "expr",
  "expression",
  "shell",
  "cmd",
  "command",
  "code",
  "interpret",
  "interpreter",
  "compile",
  "inject",
]);

export function auditCodeExec(entries: readonly string[]): string[] {
  return entries.filter((entry) =>
    entry
      .split(/[_/]|(?<=[a-z0-9])(?=[A-Z])/)
      .some((token) => DENY_TOKENS.has(token.toLowerCase())),
  );
}

/**
 * Extracts the addon's named-op dispatch table from server.gd's match arms
 * (`"domain/verb":`). Same source-text parsing style as addon-lockstep.test.ts.
 */
export function parseAddonOpTable(serverGdSource: string): string[] {
  return [...serverGdSource.matchAll(/^\s*"([a-z0-9_]+\/[a-z0-9_]+)":/gm)].map(
    (match) => match[1]!,
  );
}
```

- [ ] **Step 2: Verify the current op count (pins the parse-rot floor)**

Run: `grep -cE '^\s*"[a-z0-9_]+/[a-z0-9_]+":' addon/godot_mcp/server.gd`
Expected: `26` (if it differs, use the actual number as `OP_TABLE_FLOOR` in Step 3 — it is the count of match arms in `_dispatch` at implementation time).

- [ ] **Step 3: Write the failing test**

Create `test/unit/code-exec-audit.test.ts`:

```ts
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, buildToolInventory } from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";
import { auditCodeExec, parseAddonOpTable } from "../support/code-exec-audit.js";

const serverGdPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "addon",
  "godot_mcp",
  "server.gd",
);

/** Op-table size when this gate was written - a shrinking parse means regex rot, not fewer ops. */
const OP_TABLE_FLOOR = 26;

const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
    reconnectAttempts: 0,
  }),
  request: async () => {
    throw new Error("stub bridge - the audit never calls tools");
  },
  traffic: () => [],
};

/**
 * REQ-M-03 (#76): no eval/exec-style capability may exist in either inventory
 * - the TS tool descriptor array or the addon op table. A standing gate in the
 * unit CI job, with in-test decoys proving the audit actually fires.
 */
describe("code-exec audit (REQ-M-03)", () => {
  const toolNames = buildToolInventory({ bridge: stubBridge }).map((tool) => tool.name);
  const opNames = parseAddonOpTable(readFileSync(serverGdPath, "utf8"));

  it("parses a non-rotted op table from server.gd", () => {
    expect(opNames.length).toBeGreaterThanOrEqual(OP_TABLE_FLOOR);
    expect(opNames).toContain("system/status"); // sanity: a known arm parsed
  });

  it("flags no tool descriptor as code-exec-shaped", () => {
    expect(auditCodeExec(toolNames)).toEqual([]);
  });

  it("flags no addon op as code-exec-shaped", () => {
    expect(auditCodeExec(opNames)).toEqual([]);
  });

  it("decoy proof: the audit fires on code-exec-shaped entries (spec decoys)", () => {
    expect(auditCodeExec([...opNames, "script/execute_expression"])).toEqual([
      "script/execute_expression",
    ]);
    expect(auditCodeExec([...toolNames, "run_code_snippet"])).toEqual(["run_code_snippet"]);
  });

  it("token matching has no substring false positives", () => {
    expect(auditCodeExec(["run_project", "get_script_errors", "update_project_uids"])).toEqual([]);
    expect(auditCodeExec(["evaluate_thing"])).toEqual([]); // "evaluate" is not the "eval" token
  });
});
```

- [ ] **Step 4: Run the test**

Run: `npx vitest run test/unit/code-exec-audit.test.ts`
Expected: PASS (the real inventories are clean — the "failing first" part of this gate is the decoy assertions, which fail if the audit function is broken; temporarily change `DENY_TOKENS` to an empty set and confirm the decoy test FAILS, then restore it).

- [ ] **Step 5: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck && npm run format
git add test/support/code-exec-audit.ts test/unit/code-exec-audit.test.ts
git commit -m "test: standing code-exec audit over tool + op inventories (#76, REQ-M-03)"
```

---

### Task 2: No-telemetry static audit — REQ-M-07 gate

Static source audits proving: the addon's only network API is the one loopback bridge; the server never opens non-loopback network paths. (Server logging discipline is already enforced by `test/integration/stdio-clean.integration.test.ts` — do not duplicate it.)

**Files:**

- Create: `test/unit/no-telemetry-audit.test.ts`

**Interfaces:**

- Consumes: nothing from other tasks (reads `addon/**/*.gd` and `src/**/*.ts` as text).
- Produces: nothing consumed later.

- [ ] **Step 1: Write the test**

Create `test/unit/no-telemetry-audit.test.ts`:

```ts
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const addonDir = path.join(repoRoot, "addon", "godot_mcp");
const srcDir = path.join(repoRoot, "src");

/** Recursively lists files under dir with the given extension. */
function walk(dir: string, ext: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full, ext));
    else if (entry.name.endsWith(ext)) out.push(full);
  }
  return out;
}

function rel(file: string): string {
  return path.relative(repoRoot, file).replace(/\\/g, "/");
}

/**
 * REQ-M-07 (#76): zero telemetry. The only network endpoint in the whole
 * system is the addon's loopback bridge; the server's only sockets are the
 * bridge WebSocket and the LSP client, both pinned to 127.0.0.1. Static
 * source audit - a PR that adds a network API fails here, at review time.
 */
describe("no-telemetry audit (REQ-M-07)", () => {
  const gdFiles = walk(addonDir, ".gd");
  const tsFiles = walk(srcDir, ".ts");

  it("found the sources it audits", () => {
    expect(gdFiles.length).toBeGreaterThan(5);
    expect(tsFiles.length).toBeGreaterThan(10);
  });

  it("the addon uses no network API beyond the bridge's TCPServer + WebSocketPeer", () => {
    const deny = [
      "HTTPRequest",
      "HTTPClient",
      "StreamPeerTCP",
      "PacketPeerUDP",
      "UDPServer",
      "ENetMultiplayerPeer",
      "WebSocketMultiplayerPeer",
      "shell_open",
    ];
    for (const file of gdFiles) {
      const source = readFileSync(file, "utf8");
      for (const api of deny) {
        expect(source.includes(api), `${rel(file)} uses denied network API ${api}`).toBe(false);
      }
      if (rel(file) !== "addon/godot_mcp/server.gd") {
        expect(source.includes("TCPServer"), `${rel(file)}: TCPServer outside server.gd`).toBe(
          false,
        );
        expect(
          source.includes("WebSocketPeer"),
          `${rel(file)}: WebSocketPeer outside server.gd`,
        ).toBe(false);
      }
    }
  });

  it("the bridge listens on the loopback literal", () => {
    const serverGd = readFileSync(path.join(addonDir, "server.gd"), "utf8");
    expect(serverGd).toMatch(/\.listen\(port, "127\.0\.0\.1"\)/);
  });

  it("the server imports no HTTP/UDP/TLS module and never calls fetch", () => {
    for (const file of tsFiles) {
      const source = readFileSync(file, "utf8");
      for (const mod of ["node:http", "node:https", "node:dgram", "node:tls"]) {
        expect(source.includes(`"${mod}"`), `${rel(file)} imports ${mod}`).toBe(false);
      }
      expect(/(?<![A-Za-z0-9_])fetch\(/.test(source), `${rel(file)} calls fetch()`).toBe(false);
    }
  });

  it("node:net appears only in the LSP client, which connects to 127.0.0.1", () => {
    for (const file of tsFiles) {
      if (rel(file) === "src/lsp/client.ts") continue;
      expect(
        readFileSync(file, "utf8").includes('"node:net"'),
        `${rel(file)} imports node:net`,
      ).toBe(false);
    }
    const lsp = readFileSync(path.join(srcDir, "lsp", "client.ts"), "utf8");
    expect(lsp).toMatch(/createConnection\(\{ host: "127\.0\.0\.1"/);
  });

  it("every ws:// URL in src is loopback", () => {
    for (const file of tsFiles) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(/ws:\/\/[^\s`"']*/g)) {
        expect(
          match[0].startsWith("ws://127.0.0.1"),
          `${rel(file)}: non-loopback ${match[0]}`,
        ).toBe(true);
      }
    }
  });
});
```

- [ ] **Step 2: Run the test**

Run: `npx vitest run test/unit/no-telemetry-audit.test.ts`
Expected: PASS (all rules hold today — verified during planning: the addon's only sockets are `server.gd`'s `TCPServer`/`WebSocketPeer` bound to `"127.0.0.1"`; `node:net` exists only in `src/lsp/client.ts` connecting to `127.0.0.1`). If any assertion fails, that is a real REQ-M-07 finding — investigate before touching the test.

- [ ] **Step 3: Sanity-check the gate fires**

Temporarily add `var _x := HTTPRequest.new()` to `addon/godot_mcp/runtime/log_capture.gd`, re-run, confirm FAIL naming that file and API, then revert the edit. (Nothing to commit from this step.)

- [ ] **Step 4: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck && npm run format
git add test/unit/no-telemetry-audit.test.ts
git commit -m "test: static no-telemetry audit - loopback-only network, no HTTP APIs (#76, REQ-M-07)"
```

---

### Task 3: Server-layer containment sweep + the two server-side gaps

A unit sweep across **every path-taking tool param**, proving the server layer rejects escapes before anything crosses the bridge (the fake "addon" would execute anything — zero frames reach it). A completeness guard conscripts future tools automatically. The sweep exposes two known server-side gaps — `list_resources.directory` and `import_assets.paths` forward raw caller paths — fixed here TDD-style.

**Files:**

- Create: `test/unit/containment-sweep.test.ts`
- Modify: `src/tools/project.ts` (list_resources handler ~line 208, import_assets handler ~line 239)
- Modify: `test/unit/project-tools.test.ts` (add canonicalization tests)

**Interfaces:**

- Consumes: `buildToolInventory`, `SERVER_VERSION` (src/server.ts); `BridgePort`, `resolveProjectPath` (src/tools/bridge.ts); `ErrorResponse` shape (src/errors.ts).
- Produces: `list_resources` forwards `params.directory` as a canonical `res://` path; `import_assets` forwards `params.paths` as canonical `res://` paths (Task 5's addon re-checks assume canonical or rejected input, same as scene ops today).

- [ ] **Step 1: Write the sweep test**

Create `test/unit/containment-sweep.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { SERVER_VERSION, buildToolInventory } from "../../src/server.js";
import type { BridgePort } from "../../src/tools/bridge.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

/**
 * REQ-M-01 sweep (#76), server layer in isolation: every path-taking tool
 * param rejects every escape shape BEFORE any frame crosses the bridge. The
 * recording bridge below stands in for an addon that would execute anything -
 * an empty `requests` array after the call IS the "addon bypassed, server
 * alone catches it" proof. A completeness guard fails this suite when a new
 * path-like param is neither swept nor explicitly exempted.
 */
const ESCAPING_PAYLOADS = [
  "../../etc/passwd", // the PRD §11 smoke, verbatim
  "a/b/../../../escape.tscn", // interior climb past the root
  "/etc/passwd", // POSIX absolute
  "C:\\Windows\\System32\\evil.tscn", // Windows absolute, backslashes
  "C:/Windows/evil.tscn", // Windows absolute, forward slashes
  "..\\..\\escape.tscn", // backslash traversal
  "res://../escape.tscn", // res-relative climb
  "user://escape.tscn", // foreign scheme
  "file:///etc/passwd", // foreign scheme
];

/** tool.param -> how to build a call where only that param escapes. */
const SWEEP: Array<{
  tool: string;
  param: string;
  baseArgs?: Record<string, unknown>;
  /** import_assets takes string[]; wrap the payload. */
  asArray?: boolean;
}> = [
  { tool: "create_scene", param: "scene_path" },
  { tool: "open_scene", param: "scene_path" },
  { tool: "save_scene", param: "scene_path" },
  { tool: "save_scene", param: "new_path" },
  { tool: "close_scene", param: "scene_path" },
  { tool: "export_mesh_library", param: "scene_path", baseArgs: { output_path: "res://ok.res" } },
  { tool: "export_mesh_library", param: "output_path", baseArgs: { scene_path: "res://ok.tscn" } },
  { tool: "run_project", param: "scene_path" }, // scene_path alone implies mode "custom"
  { tool: "get_uid", param: "file_path" },
  { tool: "get_script_errors", param: "script_path" },
  { tool: "list_resources", param: "directory" },
  { tool: "import_assets", param: "paths", asArray: true },
];

/**
 * Path-like params that are deliberately NOT contained. Every entry needs a
 * reason - an unexplained exemption is a review reject.
 */
const EXEMPT = new Set([
  "add_node.parent_path", // scene-tree node path, not a filesystem path
  "remove_node.node_path", // scene-tree node path
  "duplicate_node.node_path", // scene-tree node path
  "move_node.node_path", // scene-tree node path
  "move_node.new_parent_path", // scene-tree node path
  "rename_node.node_path", // scene-tree node path
  "read_node_properties.node_path", // scene-tree node path
  "set_node_properties.node_path", // scene-tree node path
  "create_project.project_path", // the containment root being created (host-level, REQ-B-01)
  "install_addon.project_path", // host-level install target; validated by its own checks
  "list_projects.directory", // host-level workspace root to scan (bounded listing, REQ-B-02)
]);

const PATH_LIKE = /(^|_)(path|paths|directory)$/;

function recordingBridge(): { bridge: BridgePort; requests: string[] } {
  const requests: string[] = [];
  return {
    requests,
    bridge: {
      status: () => ({
        state: "disconnected",
        serverVersion: SERVER_VERSION,
        protocolVersion: 1,
        pendingRequests: 0,
        reconnectAttempts: 0,
      }),
      request: async (method) => {
        requests.push(method);
        throw new Error(`sweep: "${method}" crossed the bridge with an escaping path`);
      },
      traffic: () => [],
    },
  };
}

describe("containment sweep (REQ-M-01, server layer in isolation)", () => {
  it("completeness guard: every path-like param is swept or explicitly exempt", () => {
    const { bridge } = recordingBridge();
    for (const tool of buildToolInventory({ bridge })) {
      for (const key of Object.keys(tool.inputSchema)) {
        if (!PATH_LIKE.test(key)) continue;
        const id = `${tool.name}.${key}`;
        const swept = SWEEP.some((entry) => entry.tool === tool.name && entry.param === key);
        expect(
          swept || EXEMPT.has(id),
          `unswept path-like param: ${id} - add it to SWEEP, or to EXEMPT with a reason`,
        ).toBe(true);
      }
    }
  });

  it("no sweep entry is stale (tool + param still exist)", () => {
    const { bridge } = recordingBridge();
    const inventory = buildToolInventory({ bridge });
    for (const entry of SWEEP) {
      const tool = inventory.find((candidate) => candidate.name === entry.tool);
      expect(tool, `SWEEP names a missing tool: ${entry.tool}`).toBeDefined();
      expect(
        Object.keys(tool!.inputSchema),
        `SWEEP names a missing param: ${entry.tool}.${entry.param}`,
      ).toContain(entry.param);
    }
  });

  for (const entry of SWEEP) {
    describe(`${entry.tool}.${entry.param}`, () => {
      for (const payload of ESCAPING_PAYLOADS) {
        it(`rejects ${JSON.stringify(payload)} with zero bridge frames`, async () => {
          const { bridge, requests } = recordingBridge();
          const tool = buildToolInventory({ bridge }).find(
            (candidate) => candidate.name === entry.tool,
          )!;
          const value = entry.asArray ? [payload] : payload;
          const result = (await tool.handler(
            { ...entry.baseArgs, [entry.param]: value } as never,
            {} as never,
          )) as ToolResult;
          expect(result.isError, `${entry.tool} accepted ${payload}`).toBe(true);
          const message = (result.structuredContent as { message?: string })?.message ?? "";
          // Containment messages always name res:// / the project root -
          // this also catches a wrong-error pass (e.g. "editor not connected").
          expect(message, `${entry.tool}: not a containment rejection: ${message}`).toMatch(
            /res:\/\//,
          );
          expect(
            (result.structuredContent as { possibleSolutions?: string[] })?.possibleSolutions
              ?.length,
          ).toBeGreaterThan(0);
          expect(requests, `${entry.tool} sent frames for ${payload}`).toEqual([]);
        });
      }
    });
  }
});
```

- [ ] **Step 2: Run it — expect exactly the two known gaps to fail**

Run: `npx vitest run test/unit/containment-sweep.test.ts`
Expected: FAIL only in `list_resources.directory` and `import_assets.paths` cases (their handlers forward raw values today). Every other sweep case and both guards PASS. If anything else fails, stop and investigate before changing production code — that is a new finding.

- [ ] **Step 3: Fix `list_resources` and `import_assets` in `src/tools/project.ts`**

Add `resolveProjectPath` to the existing import from `./bridge.js`, then in the `list_resources` handler replace:

```ts
if (directory !== undefined) params.directory = directory;
```

with:

```ts
if (directory !== undefined) {
  const contained = resolveProjectPath(deps.bridge, directory);
  if ("error" in contained) return contained.error;
  params.directory = contained.resPath;
}
```

and in the `import_assets` handler replace:

```ts
if (paths !== undefined) params.paths = paths;
```

with:

```ts
if (paths !== undefined) {
  const containedPaths: string[] = [];
  for (const rawPath of paths) {
    const contained = resolveProjectPath(deps.bridge, rawPath);
    if ("error" in contained) return contained.error;
    containedPaths.push(contained.resPath);
  }
  params.paths = containedPaths;
}
```

- [ ] **Step 4: Run the sweep again**

Run: `npx vitest run test/unit/containment-sweep.test.ts`
Expected: PASS (all entries × all payloads, both guards).

- [ ] **Step 5: Add positive-path canonicalization tests**

In `test/unit/project-tools.test.ts`, add two tests following that file's existing bridge-stub pattern (match its local helpers for building a bridge whose `request` records params and returns a valid payload):

```ts
it("list_resources canonicalizes directory to a res:// path before forwarding (REQ-M-01)", async () => {
  // bridge stub: request records (method, params) and returns
  // { resources: [], count: 0 } for "project/list_resources".
  const result = await callTool("list_resources", { directory: "scenes" });
  expect(result.isError).toBeUndefined();
  expect(recordedParams.directory).toBe("res://scenes");
});

it("import_assets canonicalizes each path before forwarding (REQ-M-01)", async () => {
  // bridge stub returns { scan_started: false, reimported: [] } for "assets/import".
  const result = await callTool("import_assets", { paths: ["art/a.png", "res://art/b.png"] });
  expect(result.isError).toBeUndefined();
  expect(recordedParams.paths).toEqual(["res://art/a.png", "res://art/b.png"]);
});
```

(Adapt `callTool` / `recordedParams` to the file's existing test scaffolding — do not invent a second stub style; extend whatever `project-tools.test.ts` already uses.)

- [ ] **Step 6: Run the full unit suite**

Run: `npm test`
Expected: PASS — including the existing `project-tools.test.ts` cases (if any existing test fed a bare `directory`/`paths` value and asserted verbatim forwarding, update its expectation to the canonical `res://` form; that behavior change is this task's point).

- [ ] **Step 7: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck && npm run format
git add test/unit/containment-sweep.test.ts src/tools/project.ts test/unit/project-tools.test.ts
git commit -m "fix: contain list_resources/import_assets paths + sweep every path-taking tool (#76, REQ-M-01)"
```

---

### Task 4: Raw bridge client + addon-layer containment suite (currently-guarded ops)

The addon-layer isolation proof: a raw WebSocket client speaks the bridge protocol directly to a live editor — no TS server code in the loop — and every escaping path still comes back as a structured error. This task covers the ops whose re-check exists today, plus the runtime loopback assert; Task 5 extends it to the three gap ops and fixes them.

**Files:**

- Create: `test/integration/raw-client.ts`
- Create: `test/integration/addon-containment.integration.test.ts`

**Interfaces:**

- Consumes: `PROTOCOL_VERSION` from `src/bridge/protocol.ts`; harness helpers from `test/integration/support.ts` (`freshSampleProject`, `installAddon`, `setBridgePort`, `importPass`, `launchEditor`, `pickFreePort`, `hasGodot`, `warnSkippedCoverage`, `EditorHandle`).
- Produces: `connectRawClient(port: number, timeoutMs?: number): Promise<RawBridgeClient>` with `RawBridgeClient = { hello: Record<string, unknown>; request(method, params?): Promise<RawReply>; close(): void }` and `RawReply = { result?: unknown; error?: { code: string; message: string; possibleSolutions: string[] } }` — Task 5 reuses both.

- [ ] **Step 1: Write the raw client helper**

Create `test/integration/raw-client.ts`:

```ts
import { setTimeout as delay } from "node:timers/promises";
import WebSocket from "ws";
import { PROTOCOL_VERSION } from "../../src/bridge/protocol.js";

export interface RawReply {
  result?: unknown;
  error?: { code: string; message: string; possibleSolutions: string[] };
}

export interface RawBridgeClient {
  hello: Record<string, unknown>;
  request(method: string, params?: Record<string, unknown>): Promise<RawReply>;
  close(): void;
}

/**
 * Test-only bridge client that bypasses ALL server-side code (#76, REQ-M-01):
 * it speaks raw {id, method, params} frames straight at the addon, so
 * whatever safety the reply shows is the addon's own. Ignores progress
 * frames; single in-flight request at a time is all the suite needs.
 * Retries the connect until the editor's bridge is up (editor boot is slow).
 */
export async function connectRawClient(
  port: number,
  timeoutMs = 150_000,
): Promise<RawBridgeClient> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await attemptConnect(port);
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await delay(1_000);
    }
  }
}

async function attemptConnect(port: number): Promise<RawBridgeClient> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}`);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });

  const frames: Array<Record<string, unknown>> = [];
  let notify: (() => void) | undefined;
  socket.on("message", (data) => {
    frames.push(JSON.parse(String(data)) as Record<string, unknown>);
    notify?.();
  });

  async function nextFrame(timeoutMs: number): Promise<Record<string, unknown>> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const frame = frames.shift();
      if (frame !== undefined) return frame;
      if (Date.now() >= deadline) throw new Error("raw client: timed out waiting for a frame");
      await new Promise<void>((resolve) => {
        notify = resolve;
        setTimeout(resolve, 100);
      });
    }
  }

  const hello = await nextFrame(30_000);
  if (hello.type !== "hello" || hello.protocol_version !== PROTOCOL_VERSION) {
    socket.terminate();
    throw new Error(
      `raw client: expected hello v${PROTOCOL_VERSION}, got ${JSON.stringify(hello)}`,
    );
  }

  let nextId = 1;
  return {
    hello,
    async request(method, params = {}) {
      const id = nextId++;
      socket.send(JSON.stringify({ id, method, params }));
      for (;;) {
        const frame = await nextFrame(30_000);
        if (frame.id !== id) continue; // stray frame from a previous request
        if ("progress" in frame) continue; // REQ-A-11 progress - not the reply
        return frame as RawReply;
      }
    },
    close() {
      socket.terminate();
    },
  };
}
```

- [ ] **Step 2: Write the suite for currently-guarded ops**

Create `test/integration/addon-containment.integration.test.ts`:

```ts
import { existsSync, rmSync } from "node:fs";
import { connect as netConnect } from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { connectRawClient, type RawBridgeClient } from "./raw-client.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  setBridgePort,
  warnSkippedCoverage,
  type EditorHandle,
} from "./support.js";

/**
 * REQ-M-01 addon layer in isolation (#76): a raw WebSocket client - zero TS
 * server code - sends escaping paths straight to the live editor's bridge.
 * Every op must answer with a structured error, and nothing may appear on
 * disk outside the project. Also hosts the REQ-M-07 runtime loopback assert.
 */
const RAW_ESCAPES = [
  "res://../../escaped_by_test.tscn",
  "../../escaped_by_test.tscn",
  "/etc/passwd",
];

describe.runIf(hasGodot)("addon-layer containment via raw bridge client (REQ-M-01)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let client: RawBridgeClient;
  let port: number;

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
    port = await pickFreePort();
    setBridgePort(projectDir, port);
    await importPass(projectDir);
    editor = launchEditor(projectDir);
    client = await connectRawClient(port);
  }, 240_000);

  afterAll(async () => {
    client?.close();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  function assertNoEscapeArtifacts(): void {
    // Both relative escapes resolve two levels above the project dir.
    expect(existsSync(path.resolve(projectDir, "../../escaped_by_test.tscn"))).toBe(false);
    expect(existsSync(path.resolve(projectDir, "../escaped_by_test.tscn"))).toBe(false);
  }

  // Ops whose addon re-check exists today: expect the addon's own path_escape.
  const GUARDED: Array<{ op: string; params: (escape: string) => Record<string, unknown> }> = [
    { op: "scene/create", params: (escape) => ({ scene_path: escape, root_node_type: "Node2D" }) },
    { op: "scene/open", params: (escape) => ({ scene_path: escape }) },
    { op: "run/play", params: (escape) => ({ mode: "custom", scene_path: escape }) },
    {
      op: "scene/export_mesh_library",
      params: (escape) => ({ scene_path: escape, output_path: "res://out.res" }),
    },
    {
      op: "scene/export_mesh_library",
      params: (escape) => ({ scene_path: "res://ignored.tscn", output_path: escape }),
    },
  ];

  for (const { op, params } of GUARDED) {
    it(`${op} rejects every escape shape with path_escape`, async () => {
      for (const escape of RAW_ESCAPES) {
        const reply = await client.request(op, params(escape));
        expect(reply.result, `${op} accepted ${escape}`).toBeUndefined();
        expect(reply.error?.code, `${op} on ${escape}`).toBe("path_escape");
        expect(reply.error?.possibleSolutions?.length).toBeGreaterThan(0);
      }
      assertNoEscapeArtifacts();
    }, 60_000);
  }

  // scene/save and scene/close reject escapes structurally: an escaping path
  // can never name an open scene. Pin that this stays an error, never a write.
  for (const op of ["scene/save", "scene/close"]) {
    it(`${op} answers an escaping scene_path with a structured error`, async () => {
      for (const escape of RAW_ESCAPES) {
        const reply = await client.request(op, { scene_path: escape });
        expect(reply.result, `${op} accepted ${escape}`).toBeUndefined();
        expect(reply.error?.code).toBeTruthy();
        expect(reply.error?.possibleSolutions?.length).toBeGreaterThan(0);
      }
      assertNoEscapeArtifacts();
    }, 60_000);
  }

  it("the bridge port refuses non-loopback connections (REQ-M-07)", async () => {
    const external = Object.values(os.networkInterfaces())
      .flat()
      .find((iface) => iface && !iface.internal && iface.family === "IPv4");
    if (!external) {
      warnSkippedCoverage("non-loopback bind refusal", "runner has no non-loopback IPv4 interface");
      return;
    }
    await expect(
      new Promise<void>((resolve, reject) => {
        const probe = netConnect({ host: external.address, port, timeout: 3_000 });
        probe.once("connect", () => {
          probe.destroy();
          resolve(); // connecting via a non-loopback address = the bug
        });
        probe.once("error", () => reject(new Error("refused")));
        probe.once("timeout", () => {
          probe.destroy();
          reject(new Error("refused (timeout)"));
        });
      }),
    ).rejects.toThrow("refused");
  }, 30_000);
});
```

- [ ] **Step 3: Run the suite**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/addon-containment.integration.test.ts`
(Requires `GODOT_PATH`; on Windows add `GODOT_MCP_TEST_HEADLESS=1` to avoid an editor window.)
Expected: PASS — these ops' re-checks exist today. A failure here is a real addon-layer finding: investigate the op, don't loosen the test.

- [ ] **Step 4: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck && npm run format
git add test/integration/raw-client.ts test/integration/addon-containment.integration.test.ts
git commit -m "test: addon-layer containment proven via raw bridge client + loopback bind assert (#76, REQ-M-01, REQ-M-07)"
```

---

### Task 5: Close the three addon-layer gaps (uid/get, assets/import, project/list_resources)

Spec §1b's known gap plus the two siblings found in planning: these ops consume caller paths with no `_scene_res_path` re-check. `uid/get` is the sharpest — `FileAccess.file_exists("/etc/passwd")` probes the host filesystem (existence leak). TDD: extend the raw-client suite (red), add the re-checks (green).

**Files:**

- Modify: `test/integration/addon-containment.integration.test.ts` (extend `GUARDED`)
- Modify: `addon/godot_mcp/ops/project_ops.gd` (`_op_get_uid` ~line 151, `_op_import_assets` ~line 122, `_op_list_resources` ~line 81)

**Interfaces:**

- Consumes: `RawBridgeClient` from Task 4; `_scene_res_path(raw: String) -> String` and `_err(code, message, solutions) -> Dictionary` from `addon/godot_mcp/ops/op_base.gd` (project_ops.gd already extends op_base.gd).
- Produces: `uid/get`, `assets/import`, and `project/list_resources` reject non-`res://` / `..` paths with `path_escape` before touching `FileAccess`/the editor filesystem.

- [ ] **Step 1: Extend the suite — write the failing tests**

In `test/integration/addon-containment.integration.test.ts`, append to the `GUARDED` array:

```ts
    // The three ops hardened in #76 - no addon re-check existed before.
    { op: "uid/get", params: (escape) => ({ path: escape }) },
    { op: "assets/import", params: (escape) => ({ paths: [escape] }) },
    { op: "project/list_resources", params: (escape) => ({ directory: escape }) },
```

- [ ] **Step 2: Run — verify the new cases fail**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/addon-containment.integration.test.ts`
Expected: FAIL on exactly the three new ops (e.g. `uid/get` answers `file_not_found`/`no_uid` instead of `path_escape`; on Linux, `/etc/passwd` exists — the leak made visible). The Task 4 ops stay green.

- [ ] **Step 3: Add the re-checks in `addon/godot_mcp/ops/project_ops.gd`**

`_op_get_uid` — replace the opening lines:

```gdscript
func _op_get_uid(params: Dictionary) -> Dictionary:
	var res_path := str(params.get("path", ""))
	if not FileAccess.file_exists(res_path):
```

with:

```gdscript
func _op_get_uid(params: Dictionary) -> Dictionary:
	# Addon-side containment (REQ-M-01, #76): reject before ANY FileAccess call -
	# an uncontained absolute path would probe the host filesystem's existence.
	var res_path := _scene_res_path(str(params.get("path", "")))
	if res_path == "":
		return _err("path_escape", "path is not a valid in-project res:// path.", [
			"Pass a res:// path inside the project, with no .. segments.",
		])
	if not FileAccess.file_exists(res_path):
```

`_op_import_assets` — replace the path-collection loop:

```gdscript
	if raw is Array:
		for entry in raw:
			paths.append(str(entry))
```

with:

```gdscript
	if raw is Array:
		for entry in raw:
			# Addon-side containment (REQ-M-01, #76): reject the whole batch on
			# the first escaping entry - never partially import.
			var res_path := _scene_res_path(str(entry))
			if res_path == "":
				return _err("path_escape", "paths must be res:// paths inside the project.", [
					"Pass res:// paths inside the project, with no .. segments.",
				])
			paths.append(res_path)
```

`_op_list_resources` — replace the filter read:

```gdscript
	var filter_dir := str(params.get("directory", ""))
```

with:

```gdscript
	var filter_dir := str(params.get("directory", ""))
	if filter_dir != "":
		# Addon-side containment (REQ-M-01, #76): the filter is a res:// prefix.
		filter_dir = _scene_res_path(filter_dir)
		if filter_dir == "":
			return _err("path_escape", "directory is not a valid in-project res:// path.", [
				"Pass a res:// directory inside the project, with no .. segments.",
			])
```

- [ ] **Step 4: Run the suite — green**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/addon-containment.integration.test.ts`
Expected: PASS, all ops.

- [ ] **Step 5: Regression check — existing suites still pass**

Run: `npm test` then `npm run test:integration`
Expected: PASS. Watch `uid-tools.integration.test.ts` and `project-reads.integration.test.ts` in particular: the TS server always canonicalizes to `res://` before these ops (get_uid via `resolveProjectPath`, list_resources/import_assets since Task 3), so the new addon re-checks must not change any served-path behavior. A failure means a caller sends a non-`res://` form — fix the caller's canonicalization, not the addon check.

- [ ] **Step 6: Lint, format, commit**

```bash
npm run lint && npm run typecheck && npm run format
git add test/integration/addon-containment.integration.test.ts addon/godot_mcp/ops/project_ops.gd
git commit -m "fix: addon-side path re-checks for uid/get, assets/import, list_resources (#76, REQ-M-01)"
```

---

### Task 6: Real-op serialization burst (REQ-A-12)

#65's fake-peer arrival-order proof (`test/unit/bridge-connection.test.ts:170`) repeated against the live editor with real mutating ops: a 10-call concurrent burst whose calls 2–5 only succeed if execution is serial in arrival order, run twice on fresh scenes to observe "same scene every run" directly.

**Files:**

- Create: `test/integration/serialization.integration.test.ts`

**Interfaces:**

- Consumes: harness helpers from `test/integration/support.ts`; `BridgeConnection` (src/bridge/connection.ts); `createSceneTools`, `SceneTreeNode` (src/tools/scene.ts); `createNodeTools` (src/tools/node.ts); `createPropertyTools` (src/tools/properties.ts); `SERVER_VERSION` (src/server.ts).
- Produces: nothing consumed later.

- [ ] **Step 1: Write the suite**

Create `test/integration/serialization.integration.test.ts`:

```ts
import { rmSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BridgeConnection } from "../../src/bridge/connection.js";
import type { ToolDescriptor } from "../../src/registry.js";
import { SERVER_VERSION } from "../../src/server.js";
import { createNodeTools } from "../../src/tools/node.js";
import { createPropertyTools } from "../../src/tools/properties.js";
import { createSceneTools, type SceneTreeNode } from "../../src/tools/scene.js";
import {
  freshSampleProject,
  hasGodot,
  importPass,
  installAddon,
  launchEditor,
  pickFreePort,
  setBridgePort,
  type EditorHandle,
} from "./support.js";

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

async function callTool(
  tools: ToolDescriptor[],
  name: string,
  args: Record<string, unknown> = {},
): Promise<ToolResult> {
  const tool = tools.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`tool not registered: ${name}`);
  return (await tool.handler(args as never, {} as never)) as ToolResult;
}

/**
 * REQ-A-12 real-op half (#76): a Promise.all burst of 10 mutating tool calls
 * against the live editor executes serially in arrival order. Calls 2-5 are
 * order-DEPENDENT (rename A->B, then add/set/duplicate under B): any
 * reordering makes them fail on a missing node, so 10 successes + one exact
 * final tree IS the serialization proof. Two rounds on fresh scenes pin
 * "the same scene every run".
 */
describe.runIf(hasGodot)("real-op serialization burst (REQ-A-12)", () => {
  let projectDir: string;
  let editor: EditorHandle;
  let bridge: BridgeConnection;
  let tools: ToolDescriptor[];

  beforeAll(async () => {
    projectDir = freshSampleProject();
    installAddon(projectDir);
    const port = await pickFreePort();
    setBridgePort(projectDir, port);
    await importPass(projectDir);
    editor = launchEditor(projectDir);
    bridge = new BridgeConnection({
      url: `ws://127.0.0.1:${port}`,
      serverVersion: SERVER_VERSION,
      requestTimeoutMs: 60_000,
      reconnectDelayMs: 500,
      log: (message) => {
        if (process.env.DEBUG) console.error(message);
      },
    });
    bridge.start();
    await bridge.waitForState("connected", 150_000);
    tools = [
      ...createSceneTools({ bridge }),
      ...createNodeTools({ bridge }),
      ...createPropertyTools({ bridge }),
    ];
  }, 240_000);

  afterAll(async () => {
    await bridge?.stop();
    await editor?.kill();
    if (projectDir) rmSync(projectDir, { recursive: true, force: true });
  });

  /** Fires the 10-call burst on a fresh scene; returns the final tree + C's position. */
  async function burstRound(scenePath: string): Promise<{ tree: SceneTreeNode; cPos: string }> {
    const created = await callTool(tools, "create_scene", {
      scene_path: scenePath,
      root_node_type: "Node2D",
    });
    expect(created.isError).toBeFalsy();

    const calls: Array<{ name: string; args: Record<string, unknown> }> = [
      { name: "add_node", args: { node_type: "Node2D", node_name: "A" } },
      { name: "rename_node", args: { node_path: "A", new_name: "B" } },
      { name: "add_node", args: { node_type: "Node2D", parent_path: "B", node_name: "C" } },
      {
        name: "set_node_properties",
        args: { node_path: "B/C", properties: { position: "Vector2(3, 4)" } },
      },
      { name: "duplicate_node", args: { node_path: "B/C", new_name: "C2" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P1" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P2" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P3" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P4" } },
      { name: "add_node", args: { node_type: "Node2D", node_name: "P5" } },
    ];

    // The burst: all 10 in flight at once, completion order recorded.
    const completionOrder: number[] = [];
    const results = await Promise.all(
      calls.map((call, index) =>
        callTool(tools, call.name, call.args).then((result) => {
          completionOrder.push(index);
          return result;
        }),
      ),
    );

    results.forEach((result, index) => {
      expect(
        result.isError,
        `burst call ${index} (${calls[index]!.name}) failed: ${result.content?.[0]?.text}`,
      ).toBeFalsy();
    });
    // FIFO end-to-end: replies land in send order.
    expect(completionOrder).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);

    const treeResult = await callTool(tools, "get_scene_tree");
    expect(treeResult.isError).toBeUndefined();
    const tree = (treeResult.structuredContent as { tree: SceneTreeNode }).tree;

    const propsResult = await callTool(tools, "read_node_properties", {
      node_path: "B/C",
      properties: ["position"],
    });
    expect(propsResult.isError).toBeUndefined();
    const cPos = String(
      (propsResult.structuredContent as { properties: Record<string, unknown> }).properties
        .position,
    );
    return { tree, cPos };
  }

  it("a 10-call concurrent mutating burst lands serially in arrival order, twice, identically", async () => {
    const first = await burstRound("res://mcp_test/burst_a.tscn");
    const second = await burstRound("res://mcp_test/burst_b.tscn");

    for (const round of [first, second]) {
      expect(round.tree.children.map((child) => child.name)).toEqual([
        "B",
        "P1",
        "P2",
        "P3",
        "P4",
        "P5",
      ]);
      const b = round.tree.children.find((child) => child.name === "B")!;
      expect(b.children.map((child) => child.name)).toEqual(["C", "C2"]);
      expect(round.cPos).toBe("Vector2(3, 4)");
    }
    // Same scene every run: the rounds are structurally identical below the
    // (scene-named) roots.
    expect(JSON.stringify(first.tree.children)).toBe(JSON.stringify(second.tree.children));
  }, 300_000);
});
```

- [ ] **Step 2: Run the suite**

Run: `npx vitest run --config vitest.integration.config.ts test/integration/serialization.integration.test.ts`
Expected: PASS. Two adaptation points if reality disagrees (adjust the assertion, keep the proof):

- `read_node_properties`'s exact args/return shape — mirror how `test/integration/node-properties.integration.test.ts` reads a property back and reuse that call shape verbatim.
- If `duplicate_node` places `C2` elsewhere than right after `C` under `B`, pin whatever deterministic placement the editor produces (the cross-round `JSON.stringify` equality is the load-bearing determinism assert; the exact-shape asserts document it).

- [ ] **Step 3: Sanity-check the proof bites**

Temporarily reverse the `completionOrder` expectation (e.g. `.toEqual([9, ...])`), re-run, confirm FAIL; restore. This guards against a suite that would pass vacuously.

- [ ] **Step 4: Lint, typecheck, commit**

```bash
npm run lint && npm run typecheck && npm run format
git add test/integration/serialization.integration.test.ts
git commit -m "test: 10-call real-op burst executes serially in arrival order, deterministic scene (#76, REQ-A-12)"
```

---

### Task 7: Full verification + wrap-up

- [ ] **Step 1: Full unit leg**

Run: `npm run lint && npm run format && npm run typecheck && npm run test:coverage && npm run build`
Expected: all green (mirrors CI's unit job, including the coverage gate on the pure layers — the new tests only add coverage).

- [ ] **Step 2: Full integration leg**

Run: `npm run test:integration` (with `GODOT_PATH` set)
Expected: all suites green, including the two new ones, serially.

- [ ] **Step 3: Cross-check the issue's acceptance criteria**

- Escaping paths rejected by each layer in isolation, every path-taking tool, Windows cases → Tasks 3–5 (`containment-sweep.test.ts` runs on the Windows CI leg).
- CI audit over descriptor array + op table, decoy-proven → Task 1.
- No telemetry (static + runtime loopback + existing stdio-clean) → Task 2 + Task 4's bind assert.
- Concurrent real-op burst serial in arrival order, deterministic scene → Task 6.

- [ ] **Step 4: Finish the branch**

Use superpowers:finishing-a-development-branch — push `m1/76-security-conformance`, open a PR closing #76, and note in the PR body that the sweep exposed and fixed four containment gaps (`list_resources.directory`, `import_assets.paths` server-side; `uid/get`, `assets/import`, `project/list_resources` addon-side).
