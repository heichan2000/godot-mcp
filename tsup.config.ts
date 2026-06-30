import { copyFileSync } from "node:fs";
import { defineConfig } from "tsup";

/**
 * Bundles the server to dist/ and copies the bundled GDScript dispatcher
 * (godot/operations.gd) alongside it. The server resolves operations.gd
 * relative to dist/ at runtime and fails loudly if it is missing.
 */
export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  clean: true,
  sourcemap: true,
  // index.js is the bin entry; add the shebang on the way out.
  banner: { js: "#!/usr/bin/env node" },
  onSuccess: async () => {
    copyFileSync("src/godot/operations.gd", "dist/operations.gd");
  },
});
