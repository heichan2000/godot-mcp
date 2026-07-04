import { defineConfig } from "vitest/config";

/**
 * Coverage gate scope (godot-prd.md §9 "Coverage gate on the pure layers"):
 * only the deterministic, no-process/no-Godot modules - the ones unit tests
 * can (and do) exercise exhaustively without a real subprocess or headless
 * Godot binary. Deliberately excludes everything under `tools/*.ts` and
 * `godot/{runner,cache,discovery,process,script-errors,version-gate}.ts` -
 * those are process/Godot-dependent and covered by the separate integration
 * suite (`npm run test:integration`), not this gate; folding them in here
 * would either demand mocking their way to a number or silently under-count
 * real coverage that only exists in the integration run.
 *
 * `godot/paths.ts` and `registry.ts` DO touch the filesystem/an injectable
 * version gate respectively, but both are fully deterministic given their
 * injected seams (realpathSync, fileExists, a fake GodotVersionGate) and are
 * exhaustively unit-tested that way (see test/unit/path-containment.test.ts,
 * test/unit/registry.test.ts) - PRD §9 names both explicitly as in-scope.
 */
const COVERAGE_INCLUDE = [
  "src/schemas.ts",
  "src/godot/paths.ts",
  "src/godot/values.ts",
  "src/config.ts",
  "src/registry.ts",
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
