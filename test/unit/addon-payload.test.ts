import { existsSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveBundledAddonDir, verifyAddonPayload } from "../../src/server.js";

describe("verifyAddonPayload (successor of 1.0's operations.gd presence check)", () => {
  it("passes against the real bundled addon layout and never reports missing", () => {
    const onMissing = vi.fn();
    const ok = verifyAddonPayload(resolveBundledAddonDir(), {
      exists: existsSync,
      onMissing,
    });
    expect(ok).toBe(true);
    expect(onMissing).not.toHaveBeenCalled();
  });

  it("fails loudly, naming the missing file, path, and reinstall step, when server.gd is absent", () => {
    const addonDir = "/pkg/addon/godot_mcp";
    const onMissing = vi.fn();
    const exists = (p: string) => p === path.join(addonDir, "plugin.cfg"); // server.gd missing
    const ok = verifyAddonPayload(addonDir, { exists, onMissing });
    expect(ok).toBe(false);
    expect(onMissing).toHaveBeenCalledTimes(1);
    const message = onMissing.mock.calls[0]![0] as string;
    expect(message).toContain(addonDir);
    expect(message).toContain("server.gd");
    expect(message).toContain("@cradial/godot-mcp@next");
  });
});
