import { copyFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: { index: "src/index.ts" },
  format: ["esm"],
  target: "node20",
  platform: "node",
  outDir: "dist",
  sourcemap: true,
  clean: true,
  splitting: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
  // The bundled GDScript dispatcher isn't TS/JS, so tsup won't pick it up on
  // its own - copy it next to dist/index.js so runner.ts's "resolve next to
  // this module's own file" strategy (see resolveOperationsScriptPath)
  // finds it in the built output, same as it does from src/godot in dev.
  onSuccess: async () => {
    mkdirSync("dist", { recursive: true });
    copyFileSync(path.join("src", "godot", "operations.gd"), path.join("dist", "operations.gd"));
  },
});
