/** One recorded bridge frame or lifecycle event (REQ-A-09 diagnostics). */
export interface TrafficEntry {
  /** ISO-8601 timestamp of when the entry was recorded. */
  at: string;
  /** "sent" = server -> addon frame; "received" = addon -> server frame; "event" = lifecycle note. */
  direction: "sent" | "received" | "event";
  /** Frame text or event description, truncated to TRAFFIC_ENTRY_MAX_CHARS. */
  text: string;
}

/** How many entries the bridge retains - bounded so a chatty session cannot grow memory (REQ-A-09). */
export const TRAFFIC_LOG_CAPACITY = 200;
/** Per-entry text cap; huge frames (big scene payloads later) are truncated, not dropped. */
export const TRAFFIC_ENTRY_MAX_CHARS = 400;

/**
 * Bounded ring buffer of recent bridge traffic. Pure and synchronous so it
 * sits in the coverage-gated layer; BridgeConnection records into it and
 * get_bridge_log reads from it.
 */
export class TrafficLog {
  private readonly entries: TrafficEntry[] = [];

  constructor(
    private readonly capacity: number = TRAFFIC_LOG_CAPACITY,
    private readonly now: () => Date = () => new Date(),
  ) {}

  record(direction: TrafficEntry["direction"], text: string): void {
    const truncated =
      text.length > TRAFFIC_ENTRY_MAX_CHARS
        ? `${text.slice(0, TRAFFIC_ENTRY_MAX_CHARS)}… (+${text.length - TRAFFIC_ENTRY_MAX_CHARS} chars)`
        : text;
    this.entries.push({ at: this.now().toISOString(), direction, text: truncated });
    if (this.entries.length > this.capacity) {
      this.entries.splice(0, this.entries.length - this.capacity);
    }
  }

  /** The most recent `limit` entries, oldest-first. Non-positive limits return []. */
  tail(limit: number): TrafficEntry[] {
    if (limit <= 0) return [];
    return this.entries.slice(-limit);
  }
}
