import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    environment: "node",
    reporters: ["default"],
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
