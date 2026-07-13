import { execFile, spawn, type ChildProcess } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
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
 * When GODOT_MCP_TEST_LOG_DIR is set (CI does), every launched editor's
 * stdout/stderr is appended to its own file there, so a failed run leaves
 * evidence of what the editor session actually did (#96) - assertion
 * cascades in the vitest output hide the editor-side fault otherwise.
 * Returns undefined when unset (local default: no files).
 */
function editorLogPath(projectDir: string): string | undefined {
  const logDir = process.env.GODOT_MCP_TEST_LOG_DIR?.trim();
  if (!logDir) return undefined;
  mkdirSync(logDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(logDir, `editor-${stamp}-${path.basename(projectDir)}.log`);
}

/**
 * Boots a real Godot EDITOR on the project. CI wraps the whole test run in
 * xvfb-run (see .github/workflows/ci.yml); locally this opens a visible
 * editor window unless GODOT_MCP_TEST_HEADLESS=1 adds --headless.
 */
export function launchEditor(projectDir: string, options: { lspPort?: number } = {}): EditorHandle {
  const args = ["--editor", "--path", projectDir];
  if (options.lspPort !== undefined) {
    // Godot >= 4.3: overrides the network/language_server/remote_port editor
    // setting for THIS instance, so a developer's own open editor (already
    // holding the default 6005) can never serve this test's diagnostics.
    args.push("--lsp-port", String(options.lspPort));
  }
  if (process.env.GODOT_MCP_TEST_HEADLESS === "1") {
    args.unshift("--headless");
  }
  const logPath = editorLogPath(projectDir);
  const logLine = (stream: "stdout" | "stderr", chunk: Buffer): void => {
    const text = chunk.toString().trimEnd();
    if (process.env.DEBUG) console.error(`[editor ${stream}] ${text}`);
    if (logPath) appendFileSync(logPath, `[${new Date().toISOString()}] [${stream}] ${text}\n`);
  };
  if (logPath) {
    appendFileSync(
      logPath,
      `[${new Date().toISOString()}] [launch] ${godotPath} ${args.join(" ")}\n`,
    );
  }
  const child = spawn(godotPath!, args, { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout?.on("data", (chunk: Buffer) => logLine("stdout", chunk));
  child.stderr?.on("data", (chunk: Buffer) => logLine("stderr", chunk));
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
        // Windows has no process-group SIGKILL propagation: terminating the
        // editor's own handle leaves any scene it is playing (spawned via
        // play_main_scene()/play_custom_scene()/etc.) running as an orphan,
        // still holding file locks in the temp project dir and the shared
        // debugger port - discovered by #72's editor-kill-mid-run test.
        // `taskkill /T` reaps the whole tree; fall back to the plain signal
        // (also POSIX's path, where the child does die with its parent).
        if (process.platform === "win32" && child.pid !== undefined) {
          execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {
            child.kill("SIGKILL");
          });
        } else {
          child.kill("SIGKILL");
        }
      }),
  };
}

/** Probes `godot --version` (test-infra only) for handshake cross-checks. */
export async function probeGodotVersionString(): Promise<string> {
  const { stdout } = await execFileAsync(godotPath!, ["--version"], { timeout: 60_000 });
  return stdout.trim();
}

/**
 * Runs a headless import pass and returns combined stdout+stderr so a test can
 * assert the scaffold imports without ERROR/WARNING lines (REQ-B-01). Test
 * infra may exec Godot; the product never does (REQ-A-01).
 */
export async function importProjectCaptured(projectDir: string): Promise<string> {
  const { stdout, stderr } = await execFileAsync(
    godotPath!,
    ["--headless", "--import", "--path", projectDir],
    { timeout: 120_000 },
  );
  return `${stdout}\n${stderr}`;
}

/**
 * Appends the [editor_plugins] enable entry to project.godot - the one manual
 * "enable step" the onboarding flow documents (normally done via the editor's
 * Plugins UI). No-op if the section already exists.
 */
export function enablePlugin(projectDir: string): void {
  const projectFile = path.join(projectDir, "project.godot");
  if (readFileSync(projectFile, "utf8").includes("[editor_plugins]")) return;
  appendFileSync(
    projectFile,
    `\n[editor_plugins]\n\nenabled=PackedStringArray("res://addons/godot_mcp/plugin.cfg")\n`,
  );
}

/** "4.5.1.stable.official.abc" -> "4.5" (config/features minor tag). */
export function godotMinorTag(versionString: string): string {
  const [major, minor] = versionString.split(".");
  return `${major}.${minor}`;
}
