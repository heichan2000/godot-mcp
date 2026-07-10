import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkScriptsViaLsp, LspError } from "../../src/lsp/client.js";
import { FakeLspServer } from "../support/fake-lsp-server.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length > 0) await cleanups.pop()!();
});

async function fakeLsp(options: Parameters<typeof FakeLspServer.start>[0] = {}) {
  const server = await FakeLspServer.start(options);
  cleanups.push(() => server.close());
  return server;
}

const ROOT = path.resolve("/tmp/proj");
const script = (name: string) => ({
  resPath: `res://scripts/${name}`,
  absPath: path.join(ROOT, "scripts", name),
  text: "extends Node\n",
});

describe("checkScriptsViaLsp", () => {
  it("maps LSP diagnostics to res:// records with 1-based lines and severities", async () => {
    const server = await fakeLsp({
      diagnostics: {
        "broken.gd": [
          {
            range: { start: { line: 3, character: 5 } },
            severity: 1,
            message: "Expected expression",
          },
          { range: { start: { line: 0, character: 0 } }, severity: 2, message: "Unused variable" },
          { range: { start: { line: 9, character: 0 } }, severity: 3, message: "hint - dropped" },
        ],
      },
    });
    const result = await checkScriptsViaLsp({
      port: server.port,
      projectRoot: ROOT,
      scripts: [script("broken.gd")],
      timeoutMs: 2_000,
    });
    expect(result).toEqual([
      {
        file: "res://scripts/broken.gd",
        line: 4,
        message: "Expected expression",
        severity: "error",
      },
      { file: "res://scripts/broken.gd", line: 1, message: "Unused variable", severity: "warning" },
    ]);
  });

  it("returns [] for a clean script", async () => {
    const server = await fakeLsp();
    const result = await checkScriptsViaLsp({
      port: server.port,
      projectRoot: ROOT,
      scripts: [script("clean.gd")],
      timeoutMs: 2_000,
    });
    expect(result).toEqual([]);
  });

  it("collects diagnostics across multiple scripts in order", async () => {
    const server = await fakeLsp({
      diagnostics: {
        "a.gd": [{ range: { start: { line: 0, character: 0 } }, severity: 1, message: "A" }],
        "b.gd": [{ range: { start: { line: 1, character: 0 } }, severity: 1, message: "B" }],
      },
    });
    const result = await checkScriptsViaLsp({
      port: server.port,
      projectRoot: ROOT,
      scripts: [script("a.gd"), script("b.gd")],
      timeoutMs: 2_000,
    });
    expect(result.map((d) => d.message)).toEqual(["A", "B"]);
  });

  it("survives frames split across socket writes", async () => {
    const server = await fakeLsp({
      splitWrites: true,
      diagnostics: {
        "broken.gd": [
          { range: { start: { line: 3, character: 0 } }, severity: 1, message: "split" },
        ],
      },
    });
    const result = await checkScriptsViaLsp({
      port: server.port,
      projectRoot: ROOT,
      scripts: [script("broken.gd")],
      timeoutMs: 2_000,
    });
    expect(result[0]).toMatchObject({ message: "split", line: 4 });
  });

  it("throws a guided LspError when the port refuses connections", async () => {
    await expect(
      checkScriptsViaLsp({ port: 1, projectRoot: ROOT, scripts: [script("a.gd")], timeoutMs: 500 }),
    ).rejects.toThrowError(LspError);
  });

  it("throws a guided LspError naming the script when diagnostics never arrive", async () => {
    const server = await fakeLsp({ silentOnDidOpen: true });
    await expect(
      checkScriptsViaLsp({
        port: server.port,
        projectRoot: ROOT,
        scripts: [script("slow.gd")],
        timeoutMs: 300,
      }),
    ).rejects.toThrowError(/slow\.gd/);
  });
});
