import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
    // GitHub's shared runner cannot reliably execute the browser-heavy suites
    // alongside the runner and CLI suites. One worker keeps per-test timeouts
    // meaningful instead of making the release gate dependent on host load.
    ...(process.env.CI
      ? { poolOptions: { forks: { minForks: 1, maxForks: 1 } } }
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
