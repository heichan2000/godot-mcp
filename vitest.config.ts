import { defineConfig } from "vitest/config";

/**
 * Coverage gate scope (PRD #63 §9 "Coverage gate on the pure layers"): only
 * the deterministic modules unit tests can exercise exhaustively without a
 * live editor or real socket. `src/bridge/connection.ts` is deliberately
 * excluded - it is socket/timer-driven; it IS unit-tested (see
 * test/unit/bridge-connection.test.ts) but not gate-scoped, since folding it
 * in would either demand mocking its way to a number or silently under-count
 * behavior that only a real WebSocket run exercises.
 *
 * `godot/paths.ts` and `registry.ts` DO touch the filesystem/the MCP SDK
 * respectively, but both are fully deterministic given their injected seams
 * and are exhaustively unit-tested that way (see
 * test/unit/path-containment.test.ts, test/unit/registry.test.ts).
 */
const COVERAGE_INCLUDE = [
  "src/schemas.ts",
  "src/godot/paths.ts",
  "src/godot/values.ts",
  "src/config.ts",
  "src/registry.ts",
  "src/bridge/protocol.ts",
  "src/bridge/traffic-log.ts",
];

// Unit tests only (no Godot required). Integration tests live under
// test/integration and run via `npm run test:integration`
// (vitest.integration.config.ts) - they must never be picked up here.
export default defineConfig({
  test: {
    environment: "node",
    include: ["test/unit/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: COVERAGE_INCLUDE,
      reporter: ["text", "html"],
      thresholds: {
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
