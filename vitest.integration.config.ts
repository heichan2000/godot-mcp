import { defineConfig } from "vitest/config";

// Integration tests drive a real headless Godot binary against
// examples/sample-project. Run via `npm run test:integration`; skipped
// loudly (not silently) when GODOT_PATH is unset - see
// test/integration/support.ts's warnSkippedCoverage. Separate from the
// default `npm test` config so unit tests never require Godot.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
