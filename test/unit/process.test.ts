import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  createLineAccumulator,
  createRingBuffer,
  createSpawnDetached,
  GodotProcessManager,
  type ManagedChildProcess,
  type NodeSpawnFn,
  type SpawnFn,
} from "../../src/godot/process.js";

describe("createRingBuffer", () => {
  it("returns pushed lines in order", () => {
    const buffer = createRingBuffer(5);
    buffer.push("a");
    buffer.push("b");
    buffer.push("c");

    expect(buffer.toArray()).toEqual(["a", "b", "c"]);
  });

  it("caps at maxLines, evicting the oldest lines first", () => {
    const buffer = createRingBuffer(3);
    for (const line of ["1", "2", "3", "4", "5"]) {
      buffer.push(line);
    }

    expect(buffer.toArray()).toEqual(["3", "4", "5"]);
  });

  it("stays capped at maxLines even under many more pushes than the cap (memory stays flat)", () => {
    const buffer = createRingBuffer(1000);
    for (let i = 0; i < 50_000; i++) {
      buffer.push(`line-${i}`);
    }

    const result = buffer.toArray();
    expect(result).toHaveLength(1000);
    expect(result[0]).toBe("line-49000");
    expect(result[999]).toBe("line-49999");
  });

  it("throws for a non-positive or non-integer maxLines", () => {
    expect(() => createRingBuffer(0)).toThrow();
    expect(() => createRingBuffer(-1)).toThrow();
    expect(() => createRingBuffer(1.5)).toThrow();
  });

  it("toArray returns an independent snapshot (mutating it does not affect the buffer)", () => {
    const buffer = createRingBuffer(5);
    buffer.push("a");
    const snapshot = buffer.toArray();
    snapshot.push("mutated");

    expect(buffer.toArray()).toEqual(["a"]);
  });
});

describe("createLineAccumulator", () => {
  it("emits a complete line once a newline is seen", () => {
    const onLine = vi.fn();
    const acc = createLineAccumulator(onLine);

    acc.write("hello world\n");

    expect(onLine).toHaveBeenCalledWith("hello world");
  });

  it("holds back a trailing partial line across chunk boundaries", () => {
    const onLine = vi.fn();
    const acc = createLineAccumulator(onLine);

    acc.write("hel");
    expect(onLine).not.toHaveBeenCalled();

    acc.write("lo\nworld");
    expect(onLine).toHaveBeenCalledTimes(1);
    expect(onLine).toHaveBeenCalledWith("hello");
  });

  it("handles \\r\\n line endings", () => {
    const onLine = vi.fn();
    const acc = createLineAccumulator(onLine);

    acc.write("one\r\ntwo\r\n");

    expect(onLine).toHaveBeenNthCalledWith(1, "one");
    expect(onLine).toHaveBeenNthCalledWith(2, "two");
  });

  it("emits multiple complete lines from a single chunk", () => {
    const onLine = vi.fn();
    const acc = createLineAccumulator(onLine);

    acc.write("a\nb\nc\n");

    expect(onLine).toHaveBeenNthCalledWith(1, "a");
    expect(onLine).toHaveBeenNthCalledWith(2, "b");
    expect(onLine).toHaveBeenNthCalledWith(3, "c");
  });

  it("flush() emits a held-back trailing partial line", () => {
    const onLine = vi.fn();
    const acc = createLineAccumulator(onLine);

    acc.write("no newline yet");
    expect(onLine).not.toHaveBeenCalled();

    acc.flush();
    expect(onLine).toHaveBeenCalledWith("no newline yet");
  });

  it("flush() is a no-op when there is no pending partial line", () => {
    const onLine = vi.fn();
    const acc = createLineAccumulator(onLine);

    acc.write("complete\n");
    onLine.mockClear();
    acc.flush();

    expect(onLine).not.toHaveBeenCalled();
  });
});

/** A fake child process (EventEmitter-based) standing in for node's ChildProcess in tests. */
function makeFakeChild(): ManagedChildProcess & {
  stdout: EventEmitter;
  stderr: EventEmitter;
  emitClose: (code?: number | null) => void;
  killSpy: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
} {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const emitter = new EventEmitter();
  const killSpy = vi.fn(() => true);

  const child = Object.assign(emitter, {
    pid: 4242,
    stdout,
    stderr,
    kill: killSpy,
    emitClose: (code: number | null = 0) => emitter.emit("close", code, null),
    killSpy,
  }) as unknown as ManagedChildProcess & {
    stdout: EventEmitter;
    stderr: EventEmitter;
    emitClose: (code?: number | null) => void;
    killSpy: ReturnType<typeof vi.fn>;
    emit: (event: string, ...args: unknown[]) => boolean;
  };

  return child;
}

describe("GodotProcessManager", () => {
  function makeManagerAndChildren() {
    const children: ReturnType<typeof makeFakeChild>[] = [];
    const spawn: SpawnFn = vi.fn(() => {
      const child = makeFakeChild();
      children.push(child);
      return child;
    });
    const manager = new GodotProcessManager({ spawn });
    return { manager, children, spawn };
  }

  const baseRequest = {
    godotPath: "/opt/godot/godot",
    projectPath: "/projects/demo",
    headless: true,
    outputBufferLines: 1000,
  };

  it("has no output before any run has started", () => {
    const { manager } = makeManagerAndChildren();
    expect(manager.getOutput()).toBeUndefined();
  });

  it("spawns with --headless -d --path <project> when headless: true", () => {
    const { manager, spawn } = makeManagerAndChildren();

    manager.run({ ...baseRequest, headless: true });

    expect(spawn).toHaveBeenCalledWith("/opt/godot/godot", [
      "--headless",
      "-d",
      "--path",
      "/projects/demo",
    ]);
  });

  it("spawns windowed (-d --path <project>, no --headless) when headless is false", () => {
    const { manager, spawn } = makeManagerAndChildren();

    manager.run({ ...baseRequest, headless: false });

    expect(spawn).toHaveBeenCalledWith("/opt/godot/godot", ["-d", "--path", "/projects/demo"]);
  });

  it("appends the scene arg when scene is given", () => {
    const { manager, spawn } = makeManagerAndChildren();

    manager.run({ ...baseRequest, scene: "res://scenes/hero.tscn" });

    expect(spawn).toHaveBeenCalledWith("/opt/godot/godot", [
      "--headless",
      "-d",
      "--path",
      "/projects/demo",
      "res://scenes/hero.tscn",
    ]);
  });

  it("captures stdout lines into output and stderr lines into errors, separately", () => {
    const { manager, children } = makeManagerAndChildren();
    manager.run(baseRequest);
    const child = children[0]!;

    child.stdout.emit("data", Buffer.from("hello from stdout\n"));
    child.stderr.emit("data", Buffer.from("uh oh stderr\n"));

    expect(manager.getOutput()).toEqual({
      output: ["hello from stdout"],
      errors: ["uh oh stderr"],
    });
  });

  it("flushes a trailing partial line once the process closes", () => {
    const { manager, children } = makeManagerAndChildren();
    manager.run(baseRequest);
    const child = children[0]!;

    child.stdout.emit("data", Buffer.from("no trailing newline"));
    expect(manager.getOutput()!.output).toEqual([]);

    child.emitClose(0);
    expect(manager.getOutput()!.output).toEqual(["no trailing newline"]);
  });

  it("caps captured output at the requested outputBufferLines", () => {
    const { manager, children } = makeManagerAndChildren();
    manager.run({ ...baseRequest, outputBufferLines: 3 });
    const child = children[0]!;

    child.stdout.emit("data", Buffer.from("1\n2\n3\n4\n5\n"));

    expect(manager.getOutput()!.output).toEqual(["3", "4", "5"]);
  });

  it("a second run() kills the previous child and starts a fresh buffer (old output is gone)", () => {
    const { manager, children } = makeManagerAndChildren();
    manager.run(baseRequest);
    const first = children[0]!;
    first.stdout.emit("data", Buffer.from("first run output\n"));

    const outcome = manager.run(baseRequest);
    const second = children[1]!;

    expect(first.killSpy).toHaveBeenCalled();
    expect(outcome.replacedActive).toBe(true);
    expect(manager.getOutput()!.output).toEqual([]);

    second.stdout.emit("data", Buffer.from("second run output\n"));
    expect(manager.getOutput()!.output).toEqual(["second run output"]);
  });

  it("reports replacedActive: false for the first run", () => {
    const { manager } = makeManagerAndChildren();
    const outcome = manager.run(baseRequest);
    expect(outcome.replacedActive).toBe(false);
    expect(outcome.pid).toBe(4242);
  });

  it("stop() returns not-running when nothing has been started", () => {
    const { manager } = makeManagerAndChildren();
    expect(manager.stop()).toEqual({ kind: "not-running" });
  });

  it("stop() kills the active child, returns the captured tail, and clears state", () => {
    const { manager, children } = makeManagerAndChildren();
    manager.run(baseRequest);
    const child = children[0]!;
    child.stdout.emit("data", Buffer.from("captured before stop\n"));

    const outcome = manager.stop();

    expect(child.killSpy).toHaveBeenCalled();
    expect(outcome).toEqual({
      kind: "stopped",
      output: ["captured before stop"],
      errors: [],
    });
    expect(manager.getOutput()).toBeUndefined();
    expect(manager.stop()).toEqual({ kind: "not-running" });
  });

  it("getOutput() does not disturb the run (repeated polling returns a stable snapshot, no kill)", () => {
    const { manager, children } = makeManagerAndChildren();
    manager.run(baseRequest);
    const child = children[0]!;
    child.stdout.emit("data", Buffer.from("polled output\n"));

    manager.getOutput();
    manager.getOutput();
    const result = manager.getOutput();

    expect(child.killSpy).not.toHaveBeenCalled();
    expect(result).toEqual({ output: ["polled output"], errors: [] });
  });

  it("records a process error event into the errors buffer instead of throwing", () => {
    const { manager, children } = makeManagerAndChildren();
    manager.run(baseRequest);
    const child = children[0]!;

    child.emit("error", new Error("spawn ENOENT"));

    expect(manager.getOutput()!.errors.join(" ")).toContain("ENOENT");
  });
});

describe("createSpawnDetached", () => {
  it("spawns detached with ignored stdio and unrefs the child so it outlives the caller", () => {
    const fakeChild = { pid: 4321, unref: vi.fn() };
    const spawnImpl = vi.fn(() => fakeChild) as unknown as NodeSpawnFn;
    const spawnDetached = createSpawnDetached(spawnImpl);

    const handle = spawnDetached("/opt/godot/godot", ["-e", "--path", "/projects/demo"]);

    expect(spawnImpl).toHaveBeenCalledWith("/opt/godot/godot", ["-e", "--path", "/projects/demo"], {
      detached: true,
      stdio: "ignore",
    });
    expect(fakeChild.unref).toHaveBeenCalled();
    expect(handle.pid).toBe(4321);
  });
});
