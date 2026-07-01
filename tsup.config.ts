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
});
