/**
 * Godot process execution + single-process run manager + bounded ring buffer.
 *
 * - No shell: execFile/spawn with argument arrays only. GDScript params travel
 *   as JSON data (never interpolated) → no injection.
 * - Single active process: a new run replaces the old one.
 * - Output: stdout/stderr appended to a bounded ring buffer
 *   (OUTPUT_BUFFER_LINES). stop_project kills and returns the tail.
 *
 * TODO(M1): implement runOperation() (execFile dispatcher invocation) and the
 * run manager (start/replace/stop). TODO(M2): enforce the ring-buffer cap.
 */

/** Fixed-capacity FIFO line buffer (oldest lines drop when full). */
export class RingBuffer {
  private readonly lines: string[] = [];

  constructor(private readonly capacity: number) {}

  push(line: string): void {
    this.lines.push(line);
    while (this.lines.length > this.capacity) this.lines.shift();
  }

  tail(n = this.capacity): string[] {
    return this.lines.slice(-n);
  }

  clear(): void {
    this.lines.length = 0;
  }
}

export interface OperationInvocation {
  godotPath: string;
  projectPath: string;
  /** Absolute path to the bundled operations.gd dispatcher. */
  opsScriptPath: string;
  operation: string;
  params: Record<string, unknown>;
}

/**
 * Invoke the GDScript dispatcher headlessly for a one-shot operation:
 *   execFile(godotPath, ['--headless','--path',project,'--script',ops,op,JSON])
 *
 * TODO(M1): implement with execFile (no shell) and JSON-encoded params.
 */
export async function runOperation(
  _invocation: OperationInvocation,
): Promise<{ stdout: string; stderr: string }> {
  throw new Error("runOperation not yet implemented (M1)");
}
