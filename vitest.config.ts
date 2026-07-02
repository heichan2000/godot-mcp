import { defineConfig } from "vitest/config";

// Unit tests only (no Godot required). Integration tests live under
// test/integration and run via `npm run test:integration`
// (vitest.integration.config.ts) - they must never be picked up here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
  },
});
