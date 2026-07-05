import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdtempSync } from "node:fs";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { appendFileSync, readFileSync } from "node:fs";
import { promisify } from "node:util";
import { resolveBundledAddonDir } from "../../src/server.js";

const execFileAsync = promisify(execFile);

/** Loud, greppable skip warning - never silently green with zero tests run. */
export function warnSkippedCoverage(caseName: string, reason: string): void {
  console.warn(`[coverage] SKIPPED mandated case "${caseName}": ${reason}`);
}

export const SAMPLE_PROJECT_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "examples",
  "sample-project",
);

export const godotPath = process.env.GODOT_PATH?.trim();
export const hasGodot = Boolean(godotPath && existsSync(godotPath));

if (!hasGodot) {
  warnSkippedCoverage(
    "all test/integration/* cases",
    "GODOT_PATH is unset or does not point at an existing file - v2 integration tests drive a " +
      "real Godot 4.x EDITOR. Set GODOT_PATH to a Godot editor binary and re-run " +
      "`npm run test:integration`.",
  );
}

/** Copies the committed sample project into a disposable temp dir. */
export function freshSampleProject(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "godot-mcp-sample-project-"));
  cpSync(SAMPLE_PROJECT_DIR, dir, { recursive: true });
  return dir;
}

/** Installs the repo's addon source into the project (what addon_install will do in #66). */
export function installAddon(projectDir: string): void {
  cpSync(resolveBundledAddonDir(), path.join(projectDir, "addons", "godot_mcp"), {
    recursive: true,
  });
}

/**
 * Points the addon at a test-chosen port by appending the godot_mcp section
 * to project.godot (ProjectSettings reads custom sections verbatim).
 */
export function setBridgePort(projectDir: string, port: number): void {
  const projectFile = path.join(projectDir, "project.godot");
  const current = readFileSync(projectFile, "utf8");
  if (current.includes("[godot_mcp]")) {
    throw new Error("sample project already has a [godot_mcp] section; refusing to double-append");
  }
  appendFileSync(projectFile, `\n[godot_mcp]\n\nnetwork/port=${port}\n`);
}

/** Asks the OS for a free loopback port, then releases it for the editor to claim. */
export async function pickFreePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const probe = createNetServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (address === null || typeof address === "string") {
        probe.close(() => reject(new Error("could not determine free port")));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

/**
 * One-shot import pass so the editor boots with a warm .godot cache. Test
 * infrastructure may exec Godot directly - the PRODUCT no longer does
 * (REQ-A-01); this is exactly the split issue #64 prescribes.
 */
export async function importPass(projectDir: string): Promise<void> {
  await execFileAsync(godotPath!, ["--headless", "--import", "--path", projectDir], {
    timeout: 120_000,
  });
}

export interface EditorHandle {
  child: ChildProcess;
  /** SIGKILL + wait for exit - used by the disconnect test and afterAll. */
  kill(): Promise<void>;
}

/**
 * Boots a real Godot EDITOR on the project. CI wraps the whole test run in
 * xvfb-run (see .github/workflows/ci.yml); locally this opens a visible
 * editor window unless GODOT_MCP_TEST_HEADLESS=1 adds --headless.
 */
export function launchEditor(projectDir: string): EditorHandle {
  const args = ["--editor", "--path", projectDir];
  if (process.env.GODOT_MCP_TEST_HEADLESS === "1") {
    args.unshift("--headless");
  }
  const child = spawn(godotPath!, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => {
    if (process.env.DEBUG) console.error(`[editor stdout] ${chunk.toString().trimEnd()}`);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    if (process.env.DEBUG) console.error(`[editor stderr] ${chunk.toString().trimEnd()}`);
  });
  return {
    child,
    kill: () =>
      new Promise<void>((resolve) => {
        // exitCode stays null when the process died from a signal (SIGKILL) -
        // signalCode is set instead; either means it already exited.
        if (child.exitCode !== null || child.signalCode !== null) {
          resolve();
          return;
        }
        child.once("exit", () => resolve());
        child.kill("SIGKILL");
      }),
  };
}

/** Probes `godot --version` (test-infra only) for handshake cross-checks. */
export async function probeGodotVersionString(): Promise<string> {
  const { stdout } = await execFileAsync(godotPath!, ["--version"], { timeout: 60_000 });
  return stdout.trim();
}
