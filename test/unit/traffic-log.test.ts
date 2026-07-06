import { describe, expect, it } from "vitest";
import {
  TRAFFIC_ENTRY_MAX_CHARS,
  TRAFFIC_LOG_CAPACITY,
  TrafficLog,
} from "../../src/bridge/traffic-log.js";

describe("TrafficLog", () => {
  it("returns the newest entries oldest-first, capped by limit", () => {
    const log = new TrafficLog();
    log.record("sent", "one");
    log.record("received", "two");
    log.record("event", "three");
    expect(log.tail(2).map((entry) => entry.text)).toEqual(["two", "three"]);
    expect(log.tail(2).map((entry) => entry.direction)).toEqual(["received", "event"]);
  });

  it("stamps entries with an ISO timestamp", () => {
    const fixed = new Date("2026-07-05T12:00:00.000Z");
    const log = new TrafficLog(TRAFFIC_LOG_CAPACITY, () => fixed);
    log.record("event", "tick");
    expect(log.tail(1)[0]!.at).toBe("2026-07-05T12:00:00.000Z");
  });

  it("drops the oldest entries beyond capacity", () => {
    const log = new TrafficLog(3);
    for (const text of ["a", "b", "c", "d"]) log.record("sent", text);
    expect(log.tail(10).map((entry) => entry.text)).toEqual(["b", "c", "d"]);
  });

  it("truncates oversized entries and says how much was cut", () => {
    const log = new TrafficLog();
    log.record("received", "x".repeat(TRAFFIC_ENTRY_MAX_CHARS + 25));
    const text = log.tail(1)[0]!.text;
    expect(text.length).toBeLessThan(TRAFFIC_ENTRY_MAX_CHARS + 25);
    expect(text).toContain("(+25 chars)");
  });

  it("tail with a non-positive limit returns an empty array", () => {
    const log = new TrafficLog();
    log.record("sent", "entry");
    expect(log.tail(0)).toEqual([]);
    expect(log.tail(-5)).toEqual([]);
  });
});
