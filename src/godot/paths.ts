import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface DetectGodotPathOptions {
  /** Explicit path from config/env (see config.ts's GODOT_PATH). */
  configuredPath?: string;
  /** Defaults to the running process's platform; overridable for tests. */
  platform?: NodeJS.Platform;
  /** Defaults to a real filesystem check; overridable for tests. */
  fileExists?: (candidate: string) => boolean;
}

export type GodotPathResolution =
  | { found: true; path: string; source: "configured" | "autodetect" }
  | { found: false; candidates: string[] };

/**
 * Common Godot 4 executable install locations per platform, used only when
 * no explicit path was configured. Not exhaustive - just the well-known spots.
 */
export function getCandidatePaths(platform: NodeJS.Platform): string[] {
  const home = homedir();

  switch (platform) {
    case "win32": {
      const programFiles = process.env.ProgramFiles ?? "C:\\Program Files";
      const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
      const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
      return [
        path.join(programFiles, "Godot", "Godot.exe"),
        path.join(programFilesX86, "Godot", "Godot.exe"),
        path.join(localAppData, "Godot", "Godot.exe"),
        path.join(programFilesX86, "Steam", "steamapps", "common", "Godot Engine", "godot.exe"),
      ];
    }
    case "darwin":
      return [
        "/Applications/Godot.app/Contents/MacOS/Godot",
        path.join(home, "Applications", "Godot.app", "Contents", "MacOS", "Godot"),
        "/opt/homebrew/bin/godot",
        "/usr/local/bin/godot",
      ];
    default:
      return [
        "/usr/bin/godot",
        "/usr/local/bin/godot",
        "/snap/bin/godot",
        path.join(home, ".local", "bin", "godot"),
        "/var/lib/flatpak/exports/bin/org.godotengine.Godot",
      ];
  }
}

/**
 * Resolves the Godot executable using the strict chain: an explicitly
 * configured path (config → GODOT_PATH env, already merged by config.ts),
 * then platform autodetection. Never silently substitutes a hardcoded
 * fallback - an invalid configured path fails with guidance instead of
 * falling through to autodetect.
 */
export function detectGodotPath(options: DetectGodotPathOptions = {}): GodotPathResolution {
  const platform = options.platform ?? process.platform;
  const fileExists = options.fileExists ?? existsSync;

  if (options.configuredPath) {
    const configuredPath = options.configuredPath;
    if (fileExists(configuredPath)) {
      return { found: true, path: configuredPath, source: "configured" };
    }
    return { found: false, candidates: [configuredPath] };
  }

  const candidates = getCandidatePaths(platform);
  for (const candidate of candidates) {
    if (fileExists(candidate)) {
      return { found: true, path: candidate, source: "autodetect" };
    }
  }
  return { found: false, candidates };
}
