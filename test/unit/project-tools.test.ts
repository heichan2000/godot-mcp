import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createProjectTools } from "../../src/tools/project.js";
import type { BridgePort } from "../../src/tools/bridge.js";

const SERVER_VERSION = "2.0.0-alpha.0";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()!();
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-project-unit-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A bridge stub that fails loudly if list_projects ever touches it (it must not). */
const stubBridge: BridgePort = {
  status: () => ({
    state: "disconnected",
    serverVersion: SERVER_VERSION,
    protocolVersion: 1,
    pendingRequests: 0,
    reconnectAttempts: 0,
  }),
  request: async () => {
    throw new Error("list_projects must not touch the bridge");
  },
  traffic: () => [],
};

type ToolResult = {
  isError?: boolean;
  content: Array<{ type: string; text: string }>;
  structuredContent?: Record<string, unknown>;
};

function tool(name: string) {
  const tools = createProjectTools({ bridge: stubBridge });
  const found = tools.find((candidate) => candidate.name === name);
  if (!found) throw new Error(`tool not registered: ${name}`);
  return found;
}

async function callList(args: Record<string, unknown>): Promise<ToolResult> {
  return (await tool("list_projects").handler(args, {} as never)) as ToolResult;
}

/** Writes a minimal project.godot with a name + features tag. */
function writeProject(dir: string, name: string, version: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path.join(dir, "project.godot"),
    `config_version=5\n\n[application]\n\nconfig/name="${name}"\nconfig/features=PackedStringArray("${version}", "Forward Plus")\n`,
    "utf8",
  );
}

describe("list_projects", () => {
  it("finds nested projects with their name and version, skipping hidden/system dirs", async () => {
    const root = tempDir();
    writeProject(path.join(root, "game-a"), "Game A", "4.3");
    writeProject(path.join(root, "nested", "game-b"), "Game B", "4.5");
    // A project's own subfolders are not separate projects:
    mkdirSync(path.join(root, "game-a", "scenes"), { recursive: true });
    // Hidden + system dirs are skipped even if they contain a project.godot:
    writeProject(path.join(root, ".hidden", "ghost"), "Ghost", "4.4");
    writeProject(path.join(root, "node_modules", "dep"), "Dep", "4.4");

    const result = await callList({ directory: root });
    expect(result.isError).toBeUndefined();
    const projects = (
      result.structuredContent as {
        projects: Array<{ name: string; godot_version: string }>;
      }
    ).projects;
    const names = projects.map((p) => p.name).sort();
    expect(names).toEqual(["Game A", "Game B"]);
    expect(result.structuredContent).toMatchObject({ directory: root, count: 2 });
    const gameA = projects.find((p) => p.name === "Game A")!;
    expect(gameA.godot_version).toBe("4.3");
  });

  it("honors max_depth to bound traversal", async () => {
    const root = tempDir();
    writeProject(path.join(root, "a", "b", "c", "deep"), "Deep", "4.4");
    const shallow = await callList({ directory: root, max_depth: 1 });
    expect((shallow.structuredContent as { count: number }).count).toBe(0);
    const deep = await callList({ directory: root, max_depth: 10 });
    expect((deep.structuredContent as { count: number }).count).toBe(1);
  });

  it("does not recurse when recursive is false", async () => {
    const root = tempDir();
    writeProject(path.join(root, "child"), "Child", "4.4");
    const result = await callList({ directory: root, recursive: false });
    expect((result.structuredContent as { count: number }).count).toBe(0);
  });

  it("returns a structured error for a missing directory", async () => {
    const result = await callList({ directory: path.join(tempDir(), "does-not-exist") });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("does not exist");
  });

  it("rejects a relative directory", async () => {
    const result = await callList({ directory: "relative/dir" });
    expect(result.isError).toBe(true);
    expect(result.content[0]!.text.toLowerCase()).toContain("absolute");
  });
});
