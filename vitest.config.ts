import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    // Hermetic HOME per worker so tests never touch the real ~/.cairntrace.
    setupFiles: ["./vitest.setup.ts"],
    // GitHub's shared runner cannot reliably execute the browser-heavy suites
    // alongside the runner and CLI suites. One worker keeps per-test timeouts
    // meaningful instead of making the release gate dependent on host load.
    ...(process.env.CI
      ? { poolOptions: { forks: { minForks: 1, maxForks: 1 } } }
      : {}),
    // Local cap for shared machines (e.g. agents running the suite while the
    // developer works): CAIRN_TEST_MAX_WORKERS=3 bun run verify.
    ...(!process.env.CI && process.env.CAIRN_TEST_MAX_WORKERS
      ? {
          minWorkers: 1,
          maxWorkers: Math.max(
            1,
            Number.parseInt(process.env.CAIRN_TEST_MAX_WORKERS, 10) || 1,
          ),
        }
      : {}),
    coverage: {
      provider: "v8",
      include: [
        "src/core/runner/services.ts",
        "src/core/runner/seedState.ts",
        "src/cli/cleanup.ts",
        "src/cli/commands/config/validate.ts",
        "src/cli/commands/services/status.ts",
      ],
      thresholds: {
        statements: 80,
        branches: 80,
        functions: 80,
        lines: 80,
      },
    },
  },
});
