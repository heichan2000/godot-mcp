import { spawn as nodeSpawn } from "node:child_process";

/**
 * A fixed-capacity FIFO of text lines. Used to cap `run_project`'s captured
 * stdout/stderr (`OUTPUT_BUFFER_LINES`, config.ts) so a long, noisy run keeps
 * memory flat instead of growing unboundedly - the original godot-mcp's
 * known weakness (godot-prd.md §1/§5).
 */
export interface RingBuffer {
  push(line: string): void;
  /** Independent snapshot; mutating the returned array never affects the buffer. */
  toArray(): string[];
}

export function createRingBuffer(maxLines: number): RingBuffer {
  if (!Number.isInteger(maxLines) || maxLines <= 0) {
    throw new Error(`createRingBuffer: maxLines must be a positive integer, got ${maxLines}`);
  }

  const lines: string[] = [];
  return {
    push(line: string) {
      lines.push(line);
      if (lines.length > maxLines) {
        lines.splice(0, lines.length - maxLines);
      }
    },
    toArray() {
      return lines.slice();
    },
  };
}

/**
 * Accumulates raw stream chunks (which may split a line across two `data`
 * events, or bundle several lines into one) into complete lines, holding
 * back a trailing partial line until either a newline arrives or `flush()`
 * is called (e.g. when the process closes). Handles both `\n` and `\r\n`.
 */
export function createLineAccumulator(onLine: (line: string) => void): {
  write(chunk: string): void;
  flush(): void;
} {
  let carry = "";
  return {
    write(chunk: string) {
      carry += chunk;
      const parts = carry.split(/\r\n|\n/);
      carry = parts.pop() ?? "";
      for (const part of parts) onLine(part);
    },
    flush() {
      if (carry.length > 0) {
        onLine(carry);
        carry = "";
      }
    },
  };
}

/**
 * The minimal shape this module needs from a child process, so tests can
 * fake one with a plain EventEmitter instead of spawning a real process.
 * Matches node's `ChildProcess` structurally.
 */
export interface ManagedChildProcess {
  readonly pid?: number;
  readonly stdout: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  readonly stderr: {
    on(event: "data", listener: (chunk: Buffer | string) => void): unknown;
  } | null;
  on(
    event: "close",
    listener: (code: number | null, signal: NodeJS.Signals | null) => void,
  ): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  kill(): boolean;
}

export type SpawnFn = (file: string, args: string[]) => ManagedChildProcess;

const defaultSpawn: SpawnFn = (file, args) =>
  nodeSpawn(file, args, { stdio: ["ignore", "pipe", "pipe"] }) as unknown as ManagedChildProcess;

/** Best-effort kill: the process may already have exited (e.g. it quit on its own). */
function killChild(child: ManagedChildProcess): void {
  try {
    child.kill();
  } catch {
    // Nothing more we can do - already gone.
  }
}

export interface RunProjectRequest {
  godotPath: string;
  projectPath: string;
  /** Resource-path form (e.g. "res://scenes/hero.tscn"); caller converts the relative input param. */
  scene?: string;
  headless: boolean;
  /** Ring-buffer cap for this run's captured output (config.ts's OUTPUT_BUFFER_LINES). */
  outputBufferLines: number;
}

export interface RunProjectOutcome {
  pid: number | undefined;
  /** True if this call terminated a previously active run to make room for this one. */
  replacedActive: boolean;
}

export interface DebugOutput {
  output: string[];
  errors: string[];
}

export type StopOutcome =
  { kind: "stopped"; output: string[]; errors: string[] } | { kind: "not-running" };

/**
 * Builds the Godot CLI argv for `run_project` (godot-prd.md §6.1): windowed
 * by default (`-d` alone opens a visible window while still streaming
 * stdout/stderr, matching the original godot-mcp); `--headless` is
 * prepended for log-only runs. `scene` (already in res:// form) is appended
 * as the positional scene-to-run argument when given, otherwise Godot runs
 * the project's own main scene.
 */
function buildRunArgs(
  request: Pick<RunProjectRequest, "projectPath" | "scene" | "headless">,
): string[] {
  const args: string[] = [];
  if (request.headless) args.push("--headless");
  args.push("-d", "--path", request.projectPath);
  if (request.scene) args.push(request.scene);
  return args;
}

/**
 * Owns the single active Godot run started by `run_project`, and the bounded
 * ring buffers (stdout/stderr, captured separately) backing `get_debug_output`
 * / `stop_project`. Only one run is ever tracked at a time (godot-prd.md
 * §3/§5) - starting a new one kills and discards whatever was active.
 *
 * `getOutput()` is deliberately read-only: polling it never touches the
 * process or the buffers besides taking a snapshot. Output remains readable
 * after the process exits on its own (it is not cleared until a new `run()`
 * replaces it, or `stop()` is called) so a caller that only calls
 * `get_debug_output` after a naturally-finished run still sees its output.
 */
export class GodotProcessManager {
  #spawn: SpawnFn;
  #active?: { child: ManagedChildProcess; output: RingBuffer; errors: RingBuffer };

  constructor(options: { spawn?: SpawnFn } = {}) {
    this.#spawn = options.spawn ?? defaultSpawn;
  }

  run(request: RunProjectRequest): RunProjectOutcome {
    const replacedActive = this.#active !== undefined;
    if (this.#active) {
      killChild(this.#active.child);
    }

    const child = this.#spawn(request.godotPath, buildRunArgs(request));

    const output = createRingBuffer(request.outputBufferLines);
    const errors = createRingBuffer(request.outputBufferLines);
    const outAcc = createLineAccumulator((line) => output.push(line));
    const errAcc = createLineAccumulator((line) => errors.push(line));

    child.stdout?.on("data", (chunk) => outAcc.write(chunk.toString()));
    child.stderr?.on("data", (chunk) => errAcc.write(chunk.toString()));
    child.on("error", (error) => errAcc.write(`[process error] ${error.message}\n`));
    // "close" (not "exit") fires once stdio streams have finished draining,
    // so any trailing partial line is guaranteed to have already arrived.
    child.on("close", () => {
      outAcc.flush();
      errAcc.flush();
    });

    this.#active = { child, output, errors };
    return { pid: child.pid, replacedActive };
  }

  getOutput(): DebugOutput | undefined {
    if (!this.#active) return undefined;
    return { output: this.#active.output.toArray(), errors: this.#active.errors.toArray() };
  }

  stop(): StopOutcome {
    if (!this.#active) return { kind: "not-running" };
    const { child, output, errors } = this.#active;
    killChild(child);
    this.#active = undefined;
    return { kind: "stopped", output: output.toArray(), errors: errors.toArray() };
  }
}

/** Minimal slice of node's `child_process.spawn` this module depends on, for test injection. */
export type NodeSpawnFn = typeof nodeSpawn;

export interface DetachedProcessHandle {
  pid?: number;
}

export type SpawnDetachedFn = (file: string, args: string[]) => DetachedProcessHandle;

/**
 * Builds a `SpawnDetachedFn` for fire-and-forget child processes (currently
 * just `launch_editor`) that must outlive this server: `detached: true` puts
 * the child in its own process group instead of the server's, `stdio:
 * "ignore"` means the server holds no pipe the child could block on, and
 * `unref()` removes the child from Node's own event-loop reference count so
 * the server's process can exit immediately without waiting for (or
 * killing) it.
 */
export function createSpawnDetached(spawnImpl: NodeSpawnFn = nodeSpawn): SpawnDetachedFn {
  return (file, args) => {
    const child = spawnImpl(file, args, { detached: true, stdio: "ignore" });
    child.unref();
    return child;
  };
}
