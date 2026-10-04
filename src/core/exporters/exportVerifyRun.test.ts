import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  cairnNetworkCounts,
  exportSideFromReport,
  networkOutcomesOfRun,
} from "./exportVerifyRun";

const dirs: string[] = [];
function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-verify-run-"));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function report(over: {
  status?: string;
  annotations?: Array<{ type: string; description?: string }>;
  steps?: unknown[];
  extra?: boolean;
}) {
  return {
    config: { rootDir: "/proj/tests" },
    suites: [
      {
        file: "a.spec.ts",
        specs: [
          {
            title: "a",
            file: "a.spec.ts",
            tests: [
              {
                annotations: [],
                results: [
                  {
                    status: over.status ?? "passed",
                    duration: 321,
                    steps: over.steps ?? [],
                    annotations: over.annotations ?? [],
                  },
                ],
              },
            ],
          },
          ...(over.extra
            ? [
                {
                  title: "b",
                  file: "b.spec.ts",
                  tests: [{ annotations: [], results: [{ status: "passed" }] }],
                },
              ]
            : []),
        ],
      },
    ],
  };
}

/** A multi-project run report: a setup project + the test in two browsers. */
function multiProject(setupStatus: string, testStatus: string) {
  return {
    config: { rootDir: "/proj/tests" },
    suites: [
      {
        file: "auth.setup.ts",
        specs: [
          {
            title: "authenticate",
            file: "auth.setup.ts",
            tests: [
              {
                projectName: "setup",
                results: [{ status: setupStatus, duration: 5 }],
              },
            ],
          },
        ],
      },
      {
        file: "a.spec.ts",
        specs: [
          {
            title: "a",
            file: "a.spec.ts",
            tests: ["chromium", "firefox"].map((projectName) => ({
              projectName,
              annotations: [],
              results:
                testStatus === "none"
                  ? []
                  : [{ status: testStatus, duration: 40, steps: [] }],
            })),
          },
        ],
      },
    ],
  };
}

describe("exportSideFromReport", () => {
  it("reduces a Playwright JSON report to step verdicts, duration and network evidence", () => {
    const side = exportSideFromReport(
      report({
        status: "failed",
        steps: [
          { title: "open", duration: 1 },
          {
            title: "group",
            steps: [{ title: "inner", error: { message: "boom secret" } }],
          },
          { title: "check", error: { message: "x" } },
        ],
        annotations: [
          {
            type: "cairn:network",
            description: JSON.stringify({ outcome: "pinged", matched: 2 }),
          },
          { type: "cairn:network", description: "not json" },
          { type: "other", description: "x" },
        ],
      }),
      "/proj/tests/a.spec.ts",
    );
    expect(side).toMatchObject({
      status: "failed",
      fixme: false,
      durationMs: 321,
      network: { pinged: 2 },
      extraTests: 0,
    });
    expect(side.steps).toEqual([
      { id: "open", status: "passed" },
      { id: "group", status: "passed" },
      { id: "inner", status: "failed" },
      { id: "check", status: "failed" },
    ]);
    // error text never reaches the reduced shape
    expect(JSON.stringify(side)).not.toContain("secret");
  });

  it("recognizes a fixme test and counts other tests that ran", () => {
    const r = report({ status: "skipped", extra: true });
    (r.suites[0]!.specs[0]!.tests[0]!.annotations as unknown[]).push({
      type: "fixme",
    });
    const side = exportSideFromReport(r, "/proj/tests/a.spec.ts");
    expect(side).toMatchObject({
      status: "skipped",
      fixme: true,
      extraTests: 1,
    });
  });

  it("reduces a multi-project report to the chosen project; its setup dependency is not an extra test", () => {
    const side = exportSideFromReport(
      multiProject("passed", "passed"),
      "/proj/tests/a.spec.ts",
      "chromium",
    );
    expect(side).toMatchObject({
      status: "passed",
      durationMs: 40,
      extraTests: 0,
    });
    expect(side.error).toBeUndefined();
  });

  it("is an error naming the dependency when a setup project failed and the test never ran", () => {
    for (const status of ["skipped", "none"]) {
      const side = exportSideFromReport(
        multiProject("failed", status),
        "/proj/tests/a.spec.ts",
        "chromium",
      );
      expect(side.status).toBe("error");
      expect(side.error).toBe(
        "a dependency project's test failed (setup: authenticate), so the exported test never ran in project chromium",
      );
    }
  });

  it("is an error when the file is not in the report, naming load errors", () => {
    const side = exportSideFromReport(
      { ...report({}), errors: [{ message: "SyntaxError: nope\n  at x" }] },
      "/proj/tests/missing.spec.ts",
    );
    expect(side.status).toBe("error");
    expect(side.error).toContain("SyntaxError: nope");
  });
});

describe("runner side evidence", () => {
  function runDir(): string {
    const dir = tmp();
    mkdirSync(join(dir, "network"), { recursive: true });
    writeFileSync(
      join(dir, "spec.resolved.yml"),
      [
        "version: 1",
        "name: x",
        "outcomes:",
        "  - id: pinged",
        "    description: d",
        "    verify:",
        "      network:",
        "        method: get",
        "        urlContains: /api/ping",
        "        status: { equals: 200 }",
        "  - id: clean",
        "    description: d",
        "    verify:",
        "      noFailedRequests:",
        "        urlContains: /api/",
        "  - id: text",
        "    description: d",
        "    verify:",
        "      text: { contains: hi }",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "network", "requests.ndjson"),
      [
        { url: "http://h/api/ping", method: "GET", status: 200 },
        { url: "http://h/api/ping", method: "POST", status: 200 },
        { url: "http://h/api/other", method: "GET", status: 500 },
        { url: "http://h/", method: "GET", status: 200 },
      ]
        .map((e) => JSON.stringify(e))
        .concat(["{torn"])
        .join("\n"),
    );
    return dir;
  }

  it("reads the network outcomes of the saved resolved spec", () => {
    expect(networkOutcomesOfRun(runDir())).toEqual([
      { id: "pinged", method: "get", urlContains: "/api/ping" },
      { id: "clean", urlContains: "/api/" },
    ]);
    expect(networkOutcomesOfRun(tmp())).toEqual([]);
  });

  it("counts requests per outcome with the runner's own filter (method case-insensitive, torn lines ignored)", async () => {
    const dir = runDir();
    expect(await cairnNetworkCounts(dir, networkOutcomesOfRun(dir))).toEqual({
      pinged: 1,
      clean: 3,
    });
    expect(await cairnNetworkCounts(tmp(), [])).toEqual({});
  });
});
