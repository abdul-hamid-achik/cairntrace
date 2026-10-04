/**
 * The two sides of the differential (E5): `cairn run` on a spec and
 * `playwright test` on its export, each reduced to the same small shape.
 * Verdicts, step ids and counts only: error text and request bodies stay in
 * the tools' own output (they can carry secret values).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { targetChildEnv } from "../processEnv";
import { runBoundedCommand } from "../runner/boundedCommand";
import {
  filterNetworkEntries,
  type NetworkJudgeEntry,
} from "../runner/verifiers/networkJudge";
import { listedTestsFromJson } from "./exportVerifyGates";

export type Verdict = "passed" | "failed" | "skipped";

export interface StepVerdict {
  id: string;
  status: Verdict;
}

/** A network / noFailedRequests outcome as the spec states it. */
export interface NetworkOutcomeSpec {
  id: string;
  method?: string;
  urlContains: string;
}

export interface CairnSide {
  status: string;
  exitCode: number | undefined;
  durationMs: number | undefined;
  runDir: string | undefined;
  steps: StepVerdict[];
  outcomes: StepVerdict[];
  /** Requests matching each network outcome's method + URL in the runner's log. */
  network: Record<string, number>;
  /** The side could not produce a verdict. */
  error?: string;
}

export interface ExportSide {
  /** passed | failed | timedOut | skipped | interrupted | error */
  status: string;
  fixme: boolean;
  durationMs: number | undefined;
  steps: StepVerdict[];
  /** `cairn:network` annotations: outcome id → requests matched. */
  network: Record<string, number>;
  /** More than the one expected test ran (the file filter was loose). */
  extraTests: number;
  error?: string;
}

const OUTPUT_TAIL = 400;

function tailOf(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL
    ? `…${trimmed.slice(trimmed.length - OUTPUT_TAIL)}`
    : trimmed;
}

/* ----- cairn run ----- */

export interface CairnRunInput {
  /** The `cairn` launcher (default: this installation's bin/cairn). */
  cairnBin: string;
  specPath: string;
  artifactRoot: string;
  runToken: string;
  cwd: string;
  config?: string;
  env?: string;
  vars?: string[];
  timeoutMs: number;
}

export async function runCairnSide(input: CairnRunInput): Promise<CairnSide> {
  const args = [
    "run",
    input.specPath,
    "--backend",
    "playwright",
    "--json",
    // Both sides run against the app that is already up: cairn must not
    // start (or tear down) a web server or services of its own.
    "--no-web-server",
    "--no-services",
    "--artifact-root",
    input.artifactRoot,
    "--run-token",
    input.runToken,
    ...(input.config ? ["--config", input.config] : []),
    ...(input.env ? ["--env", input.env] : []),
    ...(input.vars ?? []).flatMap((value) => ["--var", value]),
  ];
  const result = await runBoundedCommand(input.cairnBin, args, {
    cwd: input.cwd,
    env: { ...targetChildEnv(), CAIRN_LOG_LEVEL: "silent", NO_COLOR: "1" },
    timeoutMs: input.timeoutMs,
    ownProcessGroup: true,
    killLeftovers: true,
  });
  const failed = (error: string): CairnSide => ({
    status: "error",
    exitCode: result.exitCode,
    durationMs: undefined,
    runDir: undefined,
    steps: [],
    outcomes: [],
    network: {},
    error,
  });
  if (result.spawnError)
    return failed(`could not start cairn: ${result.spawnError}`);
  if (result.timedOut) {
    return failed(`cairn run did not finish within ${input.timeoutMs / 1000}s`);
  }
  let doc: {
    status?: string;
    exitCode?: number;
    durationMs?: number;
    runDir?: string;
    failure?: { phase?: string };
    steps?: Array<{ id: string; status: Verdict }>;
    outcomes?: Array<{ id: string; status: Verdict }>;
  };
  try {
    doc = JSON.parse(result.stdout);
  } catch {
    return failed(
      `cairn run printed no JSON document (exit ${result.exitCode ?? "?"}): ${tailOf(result.stderr || result.stdout)}`,
    );
  }
  if (typeof doc.status !== "string" || !doc.runDir) {
    return failed("cairn run printed a document without a status / runDir");
  }
  if (doc.status === "errored") {
    return {
      ...failed(
        `cairn run errored${
          doc.failure?.phase ? ` in ${doc.failure.phase}` : ""
        } before the spec could be judged`,
      ),
      runDir: doc.runDir,
    };
  }
  return {
    status: doc.status,
    exitCode: doc.exitCode ?? result.exitCode,
    durationMs: doc.durationMs,
    runDir: doc.runDir,
    steps: (doc.steps ?? []).map((s) => ({ id: s.id, status: s.status })),
    outcomes: (doc.outcomes ?? []).map((o) => ({ id: o.id, status: o.status })),
    network: {},
  };
}

/** The network / noFailedRequests outcomes of the resolved spec a run saved. */
export function networkOutcomesOfRun(runDir: string): NetworkOutcomeSpec[] {
  const file = join(runDir, "spec.resolved.yml");
  if (!existsSync(file)) return [];
  try {
    const spec = parseYaml(readFileSync(file, "utf8")) as {
      outcomes?: Array<{
        id?: string;
        verify?: {
          network?: { method?: string; urlContains?: string };
          noFailedRequests?: { method?: string; urlContains?: string };
        };
      }>;
    };
    const out: NetworkOutcomeSpec[] = [];
    for (const outcome of spec.outcomes ?? []) {
      const n = outcome.verify?.network ?? outcome.verify?.noFailedRequests;
      if (outcome.id && n && typeof n.urlContains === "string") {
        out.push({
          id: outcome.id,
          ...(n.method ? { method: n.method } : {}),
          urlContains: n.urlContains,
        });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Requests matching each network outcome in the run's own request log. */
export async function cairnNetworkCounts(
  runDir: string,
  outcomes: NetworkOutcomeSpec[],
): Promise<Record<string, number>> {
  const file = join(runDir, "network", "requests.ndjson");
  if (outcomes.length === 0 || !existsSync(file)) return {};
  const entries: NetworkJudgeEntry[] = [];
  for (const line of (await readFile(file, "utf8")).split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as NetworkJudgeEntry;
      if (typeof entry.url === "string" && typeof entry.method === "string") {
        entries.push(entry);
      }
    } catch {
      // a torn line: not evidence
    }
  }
  return Object.fromEntries(
    outcomes.map((outcome) => [
      outcome.id,
      filterNetworkEntries(entries, outcome.method, outcome.urlContains).length,
    ]),
  );
}

/* ----- playwright test ----- */

export interface PlaywrightRunInput {
  playwrightBin: string;
  /** Directory of the Playwright config (cwd of the run). */
  configDir: string;
  /** The host's config file (`--config`), when it is not the one found by name. */
  configFile?: string;
  /** Absolute path of the test file to run. */
  testFile: string;
  /**
   * `--project` on a multi-project host (see `VerifyProject`): only that
   * project runs the test; Playwright still runs its dependencies.
   */
  project?: string;
  /** Where the JSON report goes. */
  reportFile: string;
  env: Record<string, string>;
  timeoutMs: number;
}

interface JsonStep {
  title: string;
  error?: unknown;
  steps?: JsonStep[];
}

interface JsonResult {
  status?: string;
  duration?: number;
  steps?: JsonStep[];
  annotations?: Array<{ type: string; description?: string }>;
}

interface JsonRunReport {
  config?: { rootDir?: string };
  suites?: unknown[];
  errors?: Array<{ message?: string }>;
}

function flattenSteps(steps: JsonStep[] | undefined, out: StepVerdict[]): void {
  for (const step of steps ?? []) {
    out.push({ id: step.title, status: step.error ? "failed" : "passed" });
    flattenSteps(step.steps, out);
  }
}

interface RawTest {
  file: string;
  title: string;
  tests: Array<{
    annotations?: Array<{ type: string; description?: string }>;
    results?: JsonResult[];
    projectName?: string;
  }>;
}

function collectRawTests(
  suites: unknown[] | undefined,
  rootDir: string,
  out: RawTest[],
): void {
  for (const raw of suites ?? []) {
    const suite = raw as {
      file?: string;
      specs?: Array<{
        file?: string;
        title?: string;
        tests?: RawTest["tests"];
      }>;
      suites?: unknown[];
    };
    for (const spec of suite.specs ?? []) {
      out.push({
        file: resolve(rootDir, spec.file ?? suite.file ?? ""),
        title: spec.title ?? "",
        tests: spec.tests ?? [],
      });
    }
    collectRawTests(suite.suites, rootDir, out);
  }
}

/**
 * Reduce a Playwright JSON run report to the one test of `testFile` (in
 * `project` when given). Tests of other projects are its dependencies (a
 * setup project): not extra tests, but a failed one is why the test never ran.
 */
export function exportSideFromReport(
  report: JsonRunReport,
  testFile: string,
  project?: string,
): ExportSide {
  const rootDir = report.config?.rootDir ?? "";
  const raw: RawTest[] = [];
  collectRawTests(report.suites, rootDir, raw);
  const inProject = (test: RawTest["tests"][number]): boolean =>
    project === undefined || test.projectName === project;
  const mine = raw.filter((entry) => sameFile(entry.file, testFile));
  const tests = mine.flatMap((entry) => entry.tests).filter(inProject);
  const all = listedTestsFromJson(report as never).filter(
    (test) => project === undefined || test.projectName === project,
  );
  const extraTests = Math.max(0, all.length - tests.length);
  const failedDependencies = raw.flatMap((entry) =>
    entry.tests
      .filter((test) => !inProject(test))
      .filter((test) => {
        const status = test.results?.[test.results.length - 1]?.status;
        return (
          status === "failed" ||
          status === "timedOut" ||
          status === "interrupted"
        );
      })
      .map(
        (test) =>
          `${test.projectName || "(unnamed)"}: ${entry.title || basename(entry.file)}`,
      ),
  );
  const test = tests[0];
  const ranNothing =
    test === undefined ||
    (test.results ?? []).length === 0 ||
    test.results?.[test.results.length - 1]?.status === "skipped";
  if (failedDependencies.length > 0 && ranNothing) {
    return {
      status: "error",
      fixme: false,
      durationMs: undefined,
      steps: [],
      network: {},
      extraTests,
      error: `a dependency project's test failed (${failedDependencies.join(", ")}), so the exported test never ran${
        project !== undefined ? ` in project ${project}` : ""
      }`,
    };
  }
  if (!test) {
    const message = (report.errors ?? [])
      .map((e) => (e.message ?? "").split("\n")[0])
      .filter(Boolean)
      .join(" | ");
    return {
      status: "error",
      fixme: false,
      durationMs: undefined,
      steps: [],
      network: {},
      extraTests,
      error: `the test file was not found in the Playwright report${
        message ? `: ${message}` : ""
      }`,
    };
  }
  const results = test.results ?? [];
  const last = results[results.length - 1];
  const annotations = [
    ...(test.annotations ?? []),
    ...(last?.annotations ?? []),
  ];
  const steps: StepVerdict[] = [];
  flattenSteps(last?.steps, steps);
  const network: Record<string, number> = {};
  for (const annotation of annotations) {
    if (annotation.type !== "cairn:network" || !annotation.description)
      continue;
    try {
      const value = JSON.parse(annotation.description) as {
        outcome?: string;
        matched?: number;
      };
      if (
        typeof value.outcome === "string" &&
        typeof value.matched === "number"
      ) {
        network[value.outcome] = value.matched;
      }
    } catch {
      // not ours
    }
  }
  return {
    status: last?.status ?? "skipped",
    fixme: annotations.some((a) => a.type === "fixme"),
    durationMs: last?.duration,
    steps,
    network,
    extraTests,
  };
}

function sameFile(a: string, b: string): boolean {
  return resolve(a) === resolve(b);
}

function exportSideError(error: string): ExportSide {
  return {
    status: "error",
    fixme: false,
    durationMs: undefined,
    steps: [],
    network: {},
    extraTests: 0,
    error,
  };
}

export async function runExportSide(
  input: PlaywrightRunInput,
): Promise<ExportSide> {
  await mkdir(dirname(input.reportFile), { recursive: true });
  const rel = relative(input.configDir, input.testFile).split(sep).join("/");
  const filter = `${rel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const result = await runBoundedCommand(
    input.playwrightBin,
    [
      "test",
      filter,
      "--reporter=json",
      "--workers=1",
      "--retries=0",
      ...(input.configFile ? ["--config", input.configFile] : []),
      ...(input.project !== undefined ? ["--project", input.project] : []),
    ],
    {
      cwd: input.configDir,
      env: {
        ...input.env,
        PLAYWRIGHT_JSON_OUTPUT_NAME: input.reportFile,
      },
      timeoutMs: input.timeoutMs,
      ownProcessGroup: true,
      killLeftovers: true,
    },
  );
  if (result.spawnError)
    return exportSideError(`could not start playwright: ${result.spawnError}`);
  if (result.timedOut) {
    return exportSideError(
      `playwright test did not finish within ${input.timeoutMs / 1000}s`,
    );
  }
  if (!existsSync(input.reportFile)) {
    return exportSideError(
      `playwright wrote no JSON report (exit ${result.exitCode ?? "?"}): ${tailOf(result.stderr || result.stdout)}`,
    );
  }
  let report: JsonRunReport;
  try {
    report = JSON.parse(readFileSync(input.reportFile, "utf8"));
  } catch {
    return exportSideError("playwright's JSON report is not valid JSON");
  }
  return exportSideFromReport(report, input.testFile, input.project);
}
