import { execFile, spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { pickFreePort } from "./support.js";

const execFileAsync = promisify(execFile);
const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/**
 * REQ-A-09: stdout is the MCP protocol channel and must stay parseable even
 * with DEBUG=1 while the bridge is failing/reconnecting. Runs the real built
 * artifact (dist/index.js) with no editor listening.
 */
describe("stdio protocol cleanliness (REQ-A-09)", () => {
  let stdout = "";
  let stderr = "";
  let child: ChildProcess | undefined;

  beforeAll(async () => {
    await execFileAsync("npm", ["run", "build"], {
      cwd: repoRoot,
      shell: true,
      timeout: 120_000,
    });
    expect(existsSync(path.join(repoRoot, "dist", "index.js"))).toBe(true);

    const port = await pickFreePort(); // nothing listens: the bridge retries throughout
    child = spawn(process.execPath, [path.join(repoRoot, "dist", "index.js")], {
      env: { ...process.env, DEBUG: "1", GODOT_MCP_PORT: String(port) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdout!.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const waitForStdout = (predicate: (chunk: string) => boolean, timeoutMs: number) =>
      new Promise<void>((resolve, reject) => {
        if (predicate(stdout)) return resolve();
        const timer = setTimeout(
          () => reject(new Error(`timed out waiting for stdout; got: ${stdout}`)),
          timeoutMs,
        );
        const onData = () => {
          if (predicate(stdout)) {
            clearTimeout(timer);
            child!.stdout!.off("data", onData);
            resolve();
          }
        };
        child!.stdout!.on("data", onData);
      });

    const send = (frame: Record<string, unknown>) =>
      child!.stdin!.write(`${JSON.stringify(frame)}\n`);
    send({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "stdio-clean-test", version: "0.0.0" },
      },
    });
    // Wait for the initialize response before proceeding to the tool call.
    await waitForStdout((chunk) => chunk.includes('"id":1'), 30_000);
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "bridge_status", arguments: {} },
    });
    // Wait for the tools/call response; the predicate only matches once the
    // full "id":2 frame has been written, so the frame is already complete.
    await waitForStdout((chunk) => chunk.includes('"id":2'), 30_000);
    child.kill();
    await new Promise((resolve) => child!.once("exit", resolve));
  }, 240_000);

  afterAll(async () => {
    if (child && child.exitCode === null && child.signalCode === null) {
      child.kill();
      await new Promise((resolve) => child!.once("exit", resolve));
    }
  });

  it("every stdout line parses as JSON-RPC", () => {
    const lines = stdout.split("\n").filter((line) => line.trim().length > 0);
    expect(lines.length).toBeGreaterThanOrEqual(2); // initialize + tools/call responses
    for (const line of lines) {
      const parsed = JSON.parse(line) as { jsonrpc?: string };
      expect(parsed.jsonrpc).toBe("2.0");
    }
  });

  it("DEBUG diagnostics went to stderr, not stdout", () => {
    expect(stderr).toContain("[godot-mcp]");
    expect(stdout).not.toContain("[godot-mcp]");
  });

  it("the disconnected bridge_status answer carries the 1.x pointer (REQ-A-10 over real stdio)", () => {
    expect(stdout).toContain("@cradial/godot-mcp@1.x");
  });
});
