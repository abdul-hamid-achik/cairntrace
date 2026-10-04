import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  EXPORT_VERIFY_SCHEMA_ID,
  ExportVerifyReportSchema,
  type ExportVerifyReport,
} from "../../core/schema/exportVerify.v1";
import { verifyToMarkdown } from "./exportVerify";
import { emit } from "../format";

/**
 * Goldens of the verify report in its two renderings. Regenerate after an
 * intentional change with `UPDATE_GOLDENS=1 bun run test
 * src/cli/commands/exportVerify.golden.test.ts` and review the diff.
 */
const GOLDEN_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "core",
  "exporters",
  "goldens",
);

function checkGolden(name: string, text: string): void {
  const path = join(GOLDEN_DIR, name);
  if (process.env["UPDATE_GOLDENS"] === "1" || !existsSync(path)) {
    writeFileSync(path, text);
    return;
  }
  expect(text).toBe(readFileSync(path, "utf8"));
}

const REPORT: ExportVerifyReport = {
  $schema: EXPORT_VERIFY_SCHEMA_ID,
  version: "1",
  status: "failed",
  exitCode: 1,
  exportDir: "/work/e2e/export",
  exporterVersion: "3.1.0",
  manifest: { exporterVersion: "3.1.0", mode: "into", lang: "ts", specs: 3 },
  verifiedAt: "2026-10-03T12:00:00.000Z",
  filesDigest: "sha256:0000",
  gates: [
    {
      id: "sentinels",
      status: "passed",
      summary: "40 files, no late-bound sentinel left",
      durationMs: 3,
    },
    {
      id: "freshness",
      status: "failed",
      summary: "the export no longer matches its sources (re-export it)",
      findings: ["stale: tests/checkout.spec.ts", "spec specs/new.yml: new"],
      durationMs: 800,
    },
    {
      id: "typecheck",
      status: "passed",
      summary:
        "30 TypeScript files compile (../tsconfig.json); 2 error(s) in host files are not the export's",
      durationMs: 5200,
    },
    {
      id: "lint",
      status: "skipped",
      reason: "no eslint config in or above the export directory",
      summary: "no eslint config in or above the export directory",
      durationMs: 1,
    },
    {
      id: "list",
      status: "passed",
      summary:
        "3 of 3 exported specs listed as one test each (1 deliberate test.fixme skip(s), not run)",
      durationMs: 900,
    },
  ],
  differential: {
    status: "failed",
    runTokenPrefix: "vabc123",
    durationRatioThreshold: 3,
    preconditionsMode: "inline",
    order: "cairn-then-export",
    specs: [
      {
        spec: "specs/login.yml",
        testFile: "tests/login.spec.ts",
        status: "match",
        cairn: {
          status: "passed",
          exitCode: 0,
          durationMs: 2100,
          runDir: "run_a",
        },
        export: { status: "passed", durationMs: 1800 },
        compared: { steps: 4, outcomes: 2 },
        unmapped: { cairnSteps: 6, exportSteps: 0 },
        mismatches: [],
        network: [{ outcome: "session_created", cairn: 1, export: 2 }],
        durationRatio: 0.86,
        warnings: [
          "network outcome session_created: request counts differ (cairn run 1, export 2); both matched, so only the count moved",
        ],
      },
      {
        spec: "specs/checkout.yml",
        testFile: "tests/checkout.spec.ts",
        status: "mismatch",
        cairn: {
          status: "passed",
          exitCode: 0,
          durationMs: 9000,
          runDir: "run_b",
        },
        export: { status: "failed", durationMs: 3000 },
        compared: { steps: 3, outcomes: 1 },
        mismatches: [
          {
            kind: "verdict",
            cairn: "passed",
            export: "failed",
            detail: "cairn run passed, the exported test failed",
          },
          {
            kind: "outcome",
            id: "total_shown",
            cairn: "passed",
            export: "failed",
            detail:
              "outcome total_shown: cairn run passed, the exported test failed",
          },
        ],
        durationRatio: 0.33,
        warnings: [],
      },
      {
        spec: "specs/legacy.yml",
        testFile: "tests/legacy.spec.ts",
        status: "skipped",
        reason:
          "the exported test is test.fixme (a hard skip recorded in the export's coverage)",
        cairn: { status: "passed", exitCode: 0, durationMs: 500 },
        export: { status: "skipped" },
        mismatches: [],
        warnings: [],
      },
    ],
    summary: { match: 1, mismatch: 1, inconclusive: 0, skipped: 1, error: 0 },
  },
  mutation: {
    status: "failed",
    scope: "all",
    specs: [
      {
        spec: "specs/login.yml",
        testFile: "tests/login.spec.ts",
        status: "ineffective",
        mutants: [
          {
            outcome: "welcome_visible",
            status: "killed",
            operator: "toContainText -> not.toContainText",
          },
          {
            outcome: "session_created",
            status: "survived",
            operator: "toBe -> not.toBe",
            detail:
              "assertion not effective: the inverted outcome still passed",
          },
          {
            outcome: "profile_loaded",
            status: "not-applicable",
            detail:
              "no expect(...) assertion to invert (the outcome is judged by a helper that throws)",
          },
        ],
      },
    ],
    summary: { killed: 1, survived: 1, invalid: 0, notApplicable: 1 },
  },
  summary: { gates: { passed: 3, failed: 1, skipped: 1 } },
  warnings: [
    "export used --var tenant; pass the same --var values (freshness and the differential's cairn run read them)",
  ],
  reportFile: ".cairn-export-verify.json",
};

describe("export verify report goldens", () => {
  it("the fixture validates against the strict v1 schema", () => {
    expect(() => ExportVerifyReportSchema.parse(REPORT)).not.toThrow();
  });

  it("markdown rendering", () => {
    checkGolden("export-verify.report.md.txt", `${verifyToMarkdown(REPORT)}\n`);
  });

  it("json rendering", () => {
    checkGolden(
      "export-verify.report.json.txt",
      emit("json", REPORT, verifyToMarkdown),
    );
  });

  it("an error report renders just the cause", () => {
    const md = verifyToMarkdown({
      ...REPORT,
      status: "error",
      exitCode: 2,
      error: "no .cairn-export.json in /work/e2e/nowhere",
    });
    expect(md).toBe(
      [
        "# Export verify: error",
        "",
        "Export: `/work/e2e/export`",
        "",
        "Error: no .cairn-export.json in /work/e2e/nowhere",
      ].join("\n"),
    );
  });
});

function projectDir(): { root: string; spec: string } {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "cairn-verify-cli-")));
  mkdirSync(join(root, "specs"));
  const spec = join(root, "specs", "tiny.yml");
  writeFileSync(
    spec,
    [
      "version: 1",
      "name: tiny",
      "intent: tiny",
      "outcomes:",
      "  - id: greeted",
      "    description: d",
      "    verify:",
      "      text:",
      "        contains: Hello",
      "steps:",
      "  - id: open_page",
      "    open: http://127.0.0.1:9/",
      "",
    ].join("\n"),
  );
  return { root, spec };
}

describe("cairn export playwright --verify (the real binary)", () => {
  const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");

  function cairn(args: string[], cwd?: string) {
    return spawnSync("bun", [BIN, "export", "playwright", ...args], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
      timeout: 120_000,
    });
  }

  it("verifies an export directory: stdout is one JSON report, inconclusive (exit 3) while no toolchain gate ran, exit 1 under --verify-strict", () => {
    const { root, spec } = projectDir();
    try {
      const out = join(root, "export");
      const exported = cairn([
        spec,
        "--project",
        "--out-dir",
        out,
        "--format",
        "json",
      ]);
      expect(exported.status).toBe(0);
      // no node_modules: typecheck / list are skipped, the rest pass — which
      // proves nothing about the generated code: inconclusive, never a pass
      const verified = cairn(["--verify", out, "--format", "json"]);
      expect(verified.status).toBe(3);
      const report = ExportVerifyReportSchema.parse(
        JSON.parse(verified.stdout),
      );
      expect(report.status).toBe("inconclusive");
      expect(report.exitCode).toBe(3);
      expect(report.warnings.join("\n")).toContain(
        "neither the typecheck nor the playwright --list gate ran",
      );
      expect(
        Object.fromEntries(report.gates.map((g) => [g.id, g.status])),
      ).toMatchObject({
        sentinels: "passed",
        freshness: "passed",
        typecheck: "skipped",
        lint: "skipped",
        list: "skipped",
      });
      const strict = cairn([
        "--verify",
        out,
        "--verify-strict",
        "--format",
        "json",
      ]);
      expect(strict.status).toBe(1);
      expect(JSON.parse(strict.stdout).status).toBe("failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("verifies the export it just wrote, sending the export report to stderr", () => {
    const { root, spec } = projectDir();
    try {
      const out = join(root, "export2");
      const run = cairn([
        spec,
        "--project",
        "--out-dir",
        out,
        "--verify",
        "--format",
        "json",
      ]);
      // no local tsc / Playwright next to it: inconclusive (exit 3)
      expect(run.status).toBe(3);
      expect(JSON.parse(run.stdout).$schema).toBe(EXPORT_VERIFY_SCHEMA_ID);
      expect(JSON.parse(run.stderr).status).toBe("written");
      expect(existsSync(join(out, ".cairn-export-verify.json"))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);

  it("is exit 2 for usage errors: no target, a bad mode, --check together, a missing manifest", () => {
    const { root } = projectDir();
    try {
      const none = cairn(["--verify"], root);
      expect(none.status).toBe(2);
      expect(none.stderr).toContain("--verify needs an export directory");
      const badMutate = cairn(["--verify", root, "--mutate", "sideways"]);
      expect(badMutate.status).toBe(2);
      expect(badMutate.stderr).toContain("--mutate must be one|all");
      const both = cairn(["--verify", root, "--check", root]);
      expect(both.status).toBe(2);
      const missing = cairn(["--verify", root, "--format", "json"]);
      expect(missing.status).toBe(2);
      expect(JSON.parse(missing.stdout)).toMatchObject({
        status: "error",
        exitCode: 2,
      });
      const ratio = cairn([
        "--verify",
        root,
        "--differential",
        "--duration-ratio",
        "1",
      ]);
      expect(ratio.status).toBe(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 180_000);
});
