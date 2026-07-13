import { defineConfig } from "vitest/config";

// Integration tests drive a real Godot EDITOR (wrapped in xvfb on CI)
// against examples/sample-project. Run via `npm run test:integration`;
// skipped loudly (not silently) when GODOT_PATH is unset - see
// test/integration/support.ts's warnSkippedCoverage. Separate from the
// default `npm test` config so unit tests never require Godot.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/integration/**/*.test.ts"],
    // One suite (= one live editor) at a time. Each file boots a full Godot
    // editor; running them in parallel oversubscribes CI's 4 vCPUs (bridge
    // requests hit their 60s timeout, first game-boots exceed the 90s tail
    // window) and shares the fixed editor ports (LSP 6005, DAP 6006, game
    // debug 6007) between editors - the #96 flake.
    fileParallelism: false,
    testTimeout: 180_000,
    hookTimeout: 240_000,
  },
});
