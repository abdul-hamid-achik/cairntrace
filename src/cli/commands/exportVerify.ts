/**
 * `cairn export playwright --verify` (E5): prove an export is faithful.
 *
 *  1. Static gates, no browser: no leaked sentinels, TypeScript with the
 *     target's own tsconfig, the host's eslint, `playwright test --list`
 *     count == exported specs, manifest freshness (the `--check` engine).
 *  2. `--differential` (needs the app up): `cairn run --backend playwright`
 *     and the exported test with the SAME `CAIRN_RUN_TOKEN`, sequentially;
 *     per-step / per-outcome verdicts, network evidence and duration compared.
 *  3. `--mutate`: invert one assertion of one outcome in a temp copy of each
 *     exported test; the test must fail at that outcome.
 *
 * Exit codes: 0 everything requested passed, 1 a gate / differential /
 * mutant failed, 2 usage or environment error (no manifest, app
 * unreachable, no Playwright binary for a differential), 3 inconclusive:
 * what was requested proved nothing (neither tsc nor `playwright --list`
 * ran, no differential spec matched, no mutant was killed or survived).
 */
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath } from "node:url";
import { targetChildEnv } from "../../core/processEnv";
import { readHostProfile } from "../../core/exporters/hostProfile";
import {
  annotateLocatorMode,
  compareSides,
  DEFAULT_DURATION_RATIO,
  summarizeDifferential,
} from "../../core/exporters/exportVerifyDifferential";
import {
  exportFilesDigest,
  EXPORT_MANIFEST_FILE,
  readExportManifest,
  realpathNearest,
  recordManifestVerify,
  varsDigest,
  type ExportManifestV1,
} from "../../core/exporters/exportManifest";
import {
  findBin,
  findUp,
  freshnessGate,
  lintGate,
  listContext,
  listGate,
  PLAYWRIGHT_CONFIGS,
  sentinelsGate,
  typecheckGate,
  type ExportTarget,
  type RequestedProject,
} from "../../core/exporters/exportVerifyGates";
import {
  findOutcomeBlocks,
  findStepCalls,
  MUTANT_FILE_MARKER,
  mutantFileName,
  mutateOutcome,
  OUTCOMES_MARKER,
  outcomeStepIds,
} from "../../core/exporters/exportVerifyMutate";
import { loadTypescript } from "../../core/importers/typescriptLoader";
import type * as TS from "typescript";
import { parse as parseYaml } from "yaml";
import {
  cairnNetworkCounts,
  networkOutcomesOfRun,
  runCairnSide,
  runExportSide,
  type ExportSide,
} from "../../core/exporters/exportVerifyRun";
import {
  EXPORT_VERIFY_SCHEMA_ID,
  type ExportVerifyDifferential,
  type ExportVerifyDifferentialSpec,
  type ExportVerifyGate,
  type ExportVerifyMutation,
  type ExportVerifyMutationSpec,
  type ExportVerifyReport,
} from "../../core/schema/exportVerify.v1";
import { emit, resolveFormat } from "../format";
import { CAIRN_VERSION } from "../version";
import { checkPlaywrightExport, type ExportPlaywrightOptions } from "./export";
import { parseVarFlags } from "./run";

export const EXPORT_VERIFY_JSON = ".cairn-export-verify.json";
export const EXPORT_VERIFY_MD = ".cairn-export-verify.md";
/** Exit code when a gate, the differential or a mutant failed. */
export const EXPORT_VERIFY_FAILED_EXIT = 1;
/** Exit code for usage / environment errors (no manifest, app unreachable, …). */
export const EXPORT_VERIFY_ERROR_EXIT = 2;
/** Exit code when the requested verification proved nothing (never a pass). */
export const EXPORT_VERIFY_INCONCLUSIVE_EXIT = 3;

/**
 * Merge two `cairn export playwright` exit codes by severity: an error (2)
 * outranks a failure (1), which outranks an inconclusive verify (3), which
 * outranks success (0).
 */
export function mergeExportExitCodes(a: number, b: number): number {
  return exitSeverity(a) >= exitSeverity(b) ? a : b;
}

function exitSeverity(code: number): number {
  return code === 2 ? 4 : code === 1 ? 3 : code === 3 ? 2 : code === 0 ? 0 : 5;
}

/** Gates that run the target's own toolchain over the generated code. */
const TOOLCHAIN_GATES = new Set(["typecheck", "list"]);
const DEFAULT_SPEC_TIMEOUT_MS = 600_000;

export interface ExportVerifyOptions {
  exportDir: string;
  differential?: boolean;
  /** `one` flips the first invertible outcome per spec, `all` every one. */
  mutate?: "one" | "all";
  /** Skipped gates and inconclusive results fail the verify. */
  strict?: boolean;
  /** Warn above this slower/faster ratio (default 3). */
  durationRatio?: number;
  /**
   * Only run the differential / mutation for specs whose path or test file
   * contains one of these (the static gates always cover the whole export).
   */
  only?: string[];
  /** Bound of each side's run per spec (default 10 minutes). */
  specTimeoutMs?: number;
  /** The `cairn` launcher for the differential (default: this installation's). */
  cairnBin?: string;
  /** Re-supplied like for `--check`: `--config`, `--env`, `--var`. */
  runtime?: Pick<ExportPlaywrightOptions, "config" | "env" | "var">;
  /** Write the report into the export dir and the manifest (default true). */
  write?: boolean;
  /**
   * The Playwright project to list, run and mutate under on a multi-project
   * host (`--verify-project`); default: the manifest's `verifyProject`, else
   * one discovering project chosen automatically (Chromium first).
   */
  project?: string;
}

const CAIRN_BINARY = fileURLToPath(
  new URL("../../../bin/cairn", import.meta.url),
);

function errorReport(
  exportDir: string,
  message: string,
  extra: Partial<ExportVerifyReport> = {},
): { report: ExportVerifyReport; exitCode: number } {
  return {
    report: {
      $schema: EXPORT_VERIFY_SCHEMA_ID,
      version: "1",
      status: "error",
      exportDir,
      exporterVersion: CAIRN_VERSION,
      exitCode: EXPORT_VERIFY_ERROR_EXIT,
      verifiedAt: new Date().toISOString(),
      gates: [],
      summary: { gates: { passed: 0, failed: 0, skipped: 0 } },
      warnings: [],
      error: message,
      ...extra,
    },
    exitCode: EXPORT_VERIFY_ERROR_EXIT,
  };
}

/**
 * Outcome ids of an exported test, in order. With the TypeScript API the
 * steps come from the syntax tree (a host's prettier — single quotes, a call
 * broken over lines — changes nothing) and, given the source spec's outcome
 * ids, a step is an outcome when its title is one; otherwise the steps after
 * the contract marker.
 */
export function outcomeIdsOfTest(
  source: string,
  opts: { ts?: typeof TS; specOutcomeIds?: readonly string[] } = {},
): string[] {
  if (opts.ts) {
    return outcomeStepIds(
      findStepCalls(opts.ts, source),
      source,
      opts.specOutcomeIds,
    );
  }
  const marker = source.indexOf(OUTCOMES_MARKER);
  if (marker < 0) return [];
  const ids: string[] = [];
  const pattern = /await test\.step\(("(?:[^"\\]|\\.)*"), async \(\) => \{/g;
  pattern.lastIndex = marker;
  for (let match = pattern.exec(source); match; match = pattern.exec(source)) {
    try {
      const id = JSON.parse(match[1]!) as string;
      if (!id.startsWith("teardown: ")) ids.push(id);
    } catch {
      // not a plain id
    }
  }
  return ids;
}

/**
 * The `baseURL` of a generated Playwright config as it resolves now: a
 * literal, or the late-bound forms the exporter writes for a config
 * `baseUrl` that reads the environment (`(process.env.X || "default")`,
 * `` `…${process.env.X ?? ""}…` ``). Anything else is not evaluated.
 */
export function baseUrlOfConfig(configText: string): string | undefined {
  const expr = /^\s*baseURL:\s*(.+?),\s*$/m.exec(configText)?.[1];
  return expr === undefined ? undefined : envExprValue(expr);
}

function envExprValue(expr: string, depth = 0): string | undefined {
  const text = expr.trim();
  if (depth > 8) return undefined;
  if (text.startsWith('"')) {
    try {
      const value: unknown = JSON.parse(text);
      return typeof value === "string" ? value : undefined;
    } catch {
      return undefined;
    }
  }
  const withDefault =
    /^\(process\.env\.([A-Za-z_][A-Za-z0-9_]*) \|\| ([\s\S]+)\)$/.exec(text);
  if (withDefault) {
    const value = process.env[withDefault[1]!];
    return value ? value : envExprValue(withDefault[2]!, depth + 1);
  }
  const plain = /^process\.env\.([A-Za-z_][A-Za-z0-9_]*) \?\? ""$/.exec(text);
  if (plain) return process.env[plain[1]!] ?? "";
  if (text.length >= 2 && text.startsWith("`") && text.endsWith("`")) {
    let out = "";
    let i = 1;
    const end = text.length - 1;
    while (i < end) {
      const ch = text[i]!;
      if (ch === "\\") {
        out += text[i + 1] ?? "";
        i += 2;
      } else if (ch === "$" && text[i + 1] === "{") {
        let depthBraces = 1;
        let j = i + 2;
        while (j < end && depthBraces > 0) {
          if (text[j] === "{") depthBraces += 1;
          else if (text[j] === "}") depthBraces -= 1;
          if (depthBraces > 0) j += 1;
        }
        const part = envExprValue(text.slice(i + 2, j), depth + 1);
        if (part === undefined) return undefined;
        out += part;
        i = j + 1;
      } else {
        out += ch;
        i += 1;
      }
    }
    return out;
  }
  return undefined;
}

async function appReachable(url: string): Promise<boolean> {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "manual" });
    return true;
  } catch {
    return false;
  }
}

/** The baseURL a host config resolves to now: an env var it reads, else its literal fallback. */
async function hostBaseUrl(
  configFile: string,
  exportDir: string,
): Promise<string | undefined> {
  try {
    const profile = await readHostProfile({
      configPath: configFile,
      into: exportDir,
    });
    const fromEnv = profile.baseURL?.env
      .map((name) => process.env[name])
      .find((value) => value !== undefined && value !== "");
    return fromEnv ?? profile.baseURL?.literal;
  } catch {
    return undefined;
  }
}

function playwrightConfigPath(configDir: string): string | undefined {
  return PLAYWRIGHT_CONFIGS.map((name) => join(configDir, name)).find((path) =>
    existsSync(path),
  );
}

/** The TypeScript API (the export's own, else cairntrace's), or undefined. */
function typescriptFor(dir: string): typeof TS | undefined {
  try {
    return loadTypescript(dir);
  } catch {
    return undefined;
  }
}

/** The outcome ids the source spec declares (undefined when it cannot be read). */
function specOutcomeIds(dir: string, spec: string): string[] | undefined {
  try {
    const doc = parseYaml(readFileSync(resolve(dir, spec), "utf8")) as {
      outcomes?: Array<{ id?: unknown }>;
    } | null;
    const ids = (doc?.outcomes ?? [])
      .map((outcome) => outcome?.id)
      .filter((id): id is string => typeof id === "string");
    return ids.length > 0 ? ids : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove mutant copies (an inverted assertion) a killed earlier `--mutate`
 * may have left in the tree; returns the ones it removed. Every verify does
 * this first, so a leftover mutant is never listed, typechecked or run as
 * part of the suite.
 */
async function sweepMutants(target: ExportTarget): Promise<string[]> {
  const dirs = new Set(
    target.manifest.specs.map((spec) =>
      dirname(join(target.dir, spec.testFile)),
    ),
  );
  const removed: string[] = [];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    for (const name of await readdir(dir)) {
      if (name.includes(MUTANT_FILE_MARKER)) {
        const file = join(dir, name);
        await unlink(file).then(
          () => removed.push(relative(target.dir, file).split(sep).join("/")),
          () => undefined,
        );
      }
    }
  }
  return removed;
}

interface RunContext {
  target: ExportTarget;
  /** Finds test.step blocks on the syntax tree (formatting-proof). */
  ts?: typeof TS;
  playwrightBin: string;
  configDir: string;
  /** The host Playwright config the export was adapted to (E8). */
  configFile?: string;
  /** `--project` of every Playwright run on a multi-project host. */
  project?: string;
  cairnBin: string;
  workDir: string;
  tokenPrefix: string;
  timeoutMs: number;
  durationRatio: number;
  runtime: ExportVerifyOptions["runtime"];
}

/**
 * A spec as the report names it: relative to the source project root when it
 * lives there (`flows/login.yml`), else the manifest's export-relative path.
 */
function specLabel(ctx: RunContext, spec: string): string {
  const root = ctx.target.manifest.source.projectRoot;
  if (root === undefined) return spec;
  const rel = relative(
    resolve(ctx.target.dir, root),
    resolve(ctx.target.dir, spec),
  )
    .split(sep)
    .join("/");
  return rel === "" || rel.startsWith("..") ? spec : rel;
}

function exportEnv(ctx: RunContext, token: string): Record<string, string> {
  const root = ctx.target.manifest.source.projectRoot;
  return {
    ...targetChildEnv(),
    // Exported global-setup calls the cairn CLI and finds the sources here.
    ...(process.env["CAIRN_BIN"] ? {} : { CAIRN_BIN: ctx.cairnBin }),
    ...(process.env["CAIRN_PROJECT_ROOT"] || root === undefined
      ? {}
      : { CAIRN_PROJECT_ROOT: resolve(ctx.target.dir, root) }),
    CAIRN_RUN_TOKEN: token,
  };
}

async function runDifferentialSpec(
  ctx: RunContext,
  index: number,
  spec: ExportManifestV1["specs"][number],
  exportSide: { current?: ExportSide },
): Promise<ExportVerifyDifferentialSpec> {
  const token = `${ctx.tokenPrefix}-${index}`;
  const testAbs = join(ctx.target.dir, spec.testFile);
  const specAbs = resolve(ctx.target.dir, spec.spec);
  // Cairn first, then the export: both sequential, one browser at a time.
  const cairn = await runCairnSide({
    cairnBin: ctx.cairnBin,
    specPath: specAbs,
    artifactRoot: join(ctx.workDir, "runs"),
    runToken: token,
    cwd: ctx.target.dir,
    ...(ctx.runtime?.config ? { config: ctx.runtime.config } : {}),
    ...(ctx.runtime?.env ? { env: ctx.runtime.env } : {}),
    ...(ctx.runtime?.var ? { vars: ctx.runtime.var } : {}),
    timeoutMs: ctx.timeoutMs,
  });
  if (cairn.runDir && !cairn.error) {
    cairn.network = await cairnNetworkCounts(
      cairn.runDir,
      networkOutcomesOfRun(cairn.runDir),
    );
  }
  const exp = await runExportSide({
    playwrightBin: ctx.playwrightBin,
    configDir: ctx.configDir,
    ...(ctx.configFile ? { configFile: ctx.configFile } : {}),
    ...(ctx.project !== undefined ? { project: ctx.project } : {}),
    testFile: testAbs,
    reportFile: join(ctx.workDir, "reports", `export-${index}.json`),
    env: exportEnv(ctx, token),
    timeoutMs: ctx.timeoutMs,
  });
  exportSide.current = exp;
  const source = existsSync(testAbs) ? readFileSync(testAbs, "utf8") : "";
  const ids = specOutcomeIds(ctx.target.dir, spec.spec);
  const compared = compareSides({
    spec: specLabel(ctx, spec.spec),
    testFile: spec.testFile,
    cairn,
    export: exp,
    outcomeIds: outcomeIdsOfTest(source, {
      ...(ctx.ts ? { ts: ctx.ts } : {}),
      ...(ids ? { specOutcomeIds: ids } : {}),
    }),
    threshold: ctx.durationRatio,
  });
  // The run directory lives in the temp work dir: name it relative to it.
  if (compared.cairn?.runDir) {
    compared.cairn.runDir = relative(
      join(ctx.workDir, "runs"),
      compared.cairn.runDir,
    );
  }
  return compared;
}

async function runMutationSpec(
  ctx: RunContext,
  index: number,
  spec: ExportManifestV1["specs"][number],
  scope: "one" | "all",
  baseline: ExportSide,
): Promise<ExportVerifyMutationSpec> {
  const base = { spec: specLabel(ctx, spec.spec), testFile: spec.testFile };
  if (baseline.status !== "passed") {
    return {
      ...base,
      status: baseline.status === "skipped" ? "skipped" : "inconclusive",
      reason:
        baseline.status === "skipped"
          ? "the exported test is skipped (test.fixme / gated): nothing to mutate"
          : `the unmodified exported test does not pass (${baseline.error ?? baseline.status}): a mutant that fails proves nothing`,
      mutants: [],
    };
  }
  const testAbs = join(ctx.target.dir, spec.testFile);
  const source = readFileSync(testAbs, "utf8");
  const declared = specOutcomeIds(ctx.target.dir, spec.spec);
  const ids = outcomeIdsOfTest(source, {
    ...(ctx.ts ? { ts: ctx.ts } : {}),
    ...(declared ? { specOutcomeIds: declared } : {}),
  });
  const blocks = findOutcomeBlocks(source, ids, ctx.ts);
  if (ids.length === 0) {
    return {
      ...base,
      status: "skipped",
      reason: ctx.ts
        ? "no outcome step (test.step titled with an outcome id) was found in the exported test"
        : "no outcome step was found, and no TypeScript API was available to read a reformatted test",
      mutants: [],
    };
  }
  const mutants: ExportVerifyMutationSpec["mutants"] = [];
  let attempted = 0;
  for (const id of ids) {
    if (scope === "one" && attempted >= 1) break;
    const block = blocks.find((b) => b.id === id);
    if (!block) {
      mutants.push({
        outcome: id,
        status: "not-applicable",
        detail: "the outcome's test.step block was not found in the source",
      });
      continue;
    }
    const mutated = mutateOutcome(source, block);
    if (!mutated.applicable) {
      mutants.push({
        outcome: id,
        status: "not-applicable",
        detail: mutated.reason,
      });
      continue;
    }
    attempted += 1;
    const mutantAbs = join(dirname(testAbs), mutantFileName(basename(testAbs)));
    await writeFile(mutantAbs, mutated.source);
    let side: ExportSide;
    try {
      side = await runExportSide({
        playwrightBin: ctx.playwrightBin,
        configDir: ctx.configDir,
        ...(ctx.configFile ? { configFile: ctx.configFile } : {}),
        ...(ctx.project !== undefined ? { project: ctx.project } : {}),
        testFile: mutantAbs,
        reportFile: join(
          ctx.workDir,
          "reports",
          `mutant-${index}-${attempted}.json`,
        ),
        env: exportEnv(ctx, `${ctx.tokenPrefix}-${index}m${attempted}`),
        timeoutMs: ctx.timeoutMs,
      });
    } finally {
      await unlink(mutantAbs).catch(() => undefined);
    }
    const failedSteps = side.steps
      .filter((s) => s.status === "failed")
      .map((s) => s.id);
    if (side.status === "passed") {
      mutants.push({
        outcome: id,
        status: "survived",
        operator: mutated.operator,
        detail: "assertion not effective: the inverted outcome still passed",
      });
    } else if (side.status === "error" || side.status === "skipped") {
      mutants.push({
        outcome: id,
        status: "invalid",
        operator: mutated.operator,
        detail: side.error ?? `the mutant ended ${side.status}`,
      });
    } else if (failedSteps.includes(id)) {
      mutants.push({
        outcome: id,
        status: "killed",
        operator: mutated.operator,
      });
    } else {
      mutants.push({
        outcome: id,
        status: "invalid",
        operator: mutated.operator,
        detail: `the mutant failed ${
          failedSteps.length > 0
            ? `at ${failedSteps.join(", ")}`
            : "outside any step"
        } rather than at the flipped outcome`,
      });
    }
  }
  if (attempted === 0) {
    return {
      ...base,
      status: "skipped",
      reason: "no outcome has an assertion that can be inverted",
      mutants,
    };
  }
  const survived = mutants.some((m) => m.status === "survived");
  const killed = mutants.some((m) => m.status === "killed");
  return {
    ...base,
    status: survived ? "ineffective" : killed ? "effective" : "inconclusive",
    mutants,
  };
}

function summarizeMutation(
  specs: ExportVerifyMutationSpec[],
  scope: "one" | "all",
): ExportVerifyMutation {
  const summary = { killed: 0, survived: 0, invalid: 0, notApplicable: 0 };
  for (const spec of specs) {
    for (const mutant of spec.mutants) {
      if (mutant.status === "not-applicable") summary.notApplicable += 1;
      else summary[mutant.status] += 1;
    }
  }
  return {
    status:
      summary.survived > 0
        ? "failed"
        : summary.killed > 0
          ? "passed"
          : "inconclusive",
    scope,
    specs,
    summary,
  };
}

/** Everything `--verify` does; never throws for an expected problem. */
export async function verifyPlaywrightExport(
  opts: ExportVerifyOptions,
): Promise<{ report: ExportVerifyReport; exitCode: number }> {
  const dir = realpathNearest(
    isAbsolute(opts.exportDir)
      ? opts.exportDir
      : resolve(process.cwd(), opts.exportDir),
  );
  let manifest: ExportManifestV1;
  try {
    manifest = readExportManifest(dir);
  } catch (error) {
    return errorReport(dir, (error as Error).message);
  }
  const target: ExportTarget = { dir, manifest };
  const warnings: string[] = [];
  const suppliedDigest = varsDigest(parseVarFlags(opts.runtime?.var));
  if (suppliedDigest !== manifest.source.varsDigest) {
    warnings.push(
      manifest.source.varKeys.length > 0
        ? `export used --var ${manifest.source.varKeys.join(", ")}; pass the same --var values (freshness and the differential's cairn run read them)`
        : "--var overrides differ from the export (which used none)",
    );
  }
  // What the export was written against; the runner side uses the same.
  const runtime: ExportVerifyOptions["runtime"] = {
    ...(opts.runtime?.config !== undefined
      ? { config: opts.runtime.config }
      : manifest.source.config
        ? { config: resolve(dir, manifest.source.config) }
        : {}),
    ...(opts.runtime?.env !== undefined
      ? { env: opts.runtime.env }
      : manifest.source.env
        ? { env: manifest.source.env }
        : {}),
    ...(opts.runtime?.var ? { var: opts.runtime.var } : {}),
  };
  const wantsRuns = Boolean(opts.differential || opts.mutate);

  // Usage / environment problems that make the runs impossible fail early
  // (exit 2), before any gate spends time.
  let ctxBase:
    | Omit<
        RunContext,
        "workDir" | "tokenPrefix" | "timeoutMs" | "durationRatio"
      >
    | undefined;
  if (wantsRuns) {
    if (manifest.mode === "files") {
      return errorReport(
        dir,
        "--differential / --mutate need a --project or --into export: a standalone --out-dir export does not name its steps (test.step) or carry a Playwright config",
      );
    }
    // E8: an export adapted to a host config runs under that config.
    const hostConfigRel = manifest.source.hostConfig;
    const hostConfigFile =
      hostConfigRel && existsSync(resolve(dir, hostConfigRel))
        ? resolve(dir, hostConfigRel)
        : undefined;
    const configDir = hostConfigFile
      ? dirname(hostConfigFile)
      : findUp(dir, PLAYWRIGHT_CONFIGS);
    const playwrightBin = configDir
      ? (findBin(configDir, "playwright") ?? findBin(dir, "playwright"))
      : undefined;
    if (!configDir || !playwrightBin) {
      return errorReport(
        dir,
        !configDir
          ? "no playwright.config in or above the export directory"
          : "no local Playwright binary (node_modules/.bin/playwright) in or above the export directory; verify never installs one",
      );
    }
    const configPath = hostConfigFile ?? playwrightConfigPath(configDir);
    const baseUrl = hostConfigFile
      ? await hostBaseUrl(hostConfigFile, dir)
      : configPath
        ? baseUrlOfConfig(readFileSync(configPath, "utf8"))
        : undefined;
    if (baseUrl && !(await appReachable(baseUrl))) {
      return errorReport(
        dir,
        `the app at ${baseUrl} (the export's baseURL) is not reachable: start it before --differential / --mutate (both run the tests against it)`,
      );
    }
    ctxBase = {
      target,
      playwrightBin,
      configDir,
      ...(hostConfigFile ? { configFile: hostConfigFile } : {}),
      cairnBin: opts.cairnBin ?? process.env["CAIRN_BIN"] ?? CAIRN_BINARY,
      runtime,
    };
  }

  // A mutant an interrupted --mutate left behind would be listed and run as
  // part of the suite (an inverted assertion): remove it before any gate.
  const leftovers = await sweepMutants(target);
  // One unfiltered `playwright test --list`: which projects discover the
  // exported tests, and the one the list gate, the differential and the
  // mutants run under on a multi-project host.
  const requested: RequestedProject | undefined =
    opts.project !== undefined && opts.project !== ""
      ? { name: opts.project, source: "flag" }
      : manifest.source.verifyProject
        ? { name: manifest.source.verifyProject, source: "manifest" }
        : undefined;
  const listing = await listContext(target, requested);
  if (listing.error) return errorReport(dir, listing.error);
  if (ctxBase && listing.project) ctxBase.project = listing.project.name;
  if (leftovers.length > 0) {
    warnings.push(
      `removed ${leftovers.length} leftover mutant file(s) of an interrupted --mutate: ${leftovers.join(", ")}`,
    );
  }
  const gates: ExportVerifyGate[] = [];
  gates.push(await sentinelsGate(target));
  {
    const startedAt = Date.now();
    const { report } = await checkPlaywrightExport(dir, undefined, {
      ...opts.runtime,
    });
    gates.push(freshnessGate(report, startedAt));
  }
  gates.push(await typecheckGate(target));
  gates.push(await lintGate(target));
  gates.push(await listGate(target, listing));

  let differential: ExportVerifyDifferential | undefined;
  let mutation: ExportVerifyMutation | undefined;
  if (wantsRuns && ctxBase) {
    const workDir = await mkdtemp(join(tmpdir(), "cairn-export-verify-"));
    const ts = typescriptFor(dir);
    const ctx: RunContext = {
      ...ctxBase,
      ...(ts ? { ts } : {}),
      workDir,
      tokenPrefix: `v${Date.now().toString(36)}`,
      timeoutMs: opts.specTimeoutMs ?? DEFAULT_SPEC_TIMEOUT_MS,
      durationRatio: opts.durationRatio ?? DEFAULT_DURATION_RATIO,
    };
    if (
      opts.differential &&
      (manifest.source.preconditions === "skip" ||
        manifest.source.preconditions === "manifest")
    ) {
      warnings.push(
        `the export was written with --preconditions ${manifest.source.preconditions}: the exported test runs none, only the cairn run side's own preconditions prepare the app`,
      );
    }
    try {
      await sweepMutants(target);
      const only = (opts.only ?? []).filter((item) => item.length > 0);
      const specs =
        only.length === 0
          ? manifest.specs
          : manifest.specs.filter((spec) =>
              only.some(
                (item) =>
                  spec.spec.includes(item) || spec.testFile.includes(item),
              ),
            );
      if (specs.length === 0) {
        warnings.push(`--verify-only matched no spec of the export`);
      }
      const sides: ExportSide[] = [];
      if (opts.differential) {
        const results: ExportVerifyDifferentialSpec[] = [];
        for (const [index, spec] of specs.entries()) {
          const holder: { current?: ExportSide } = {};
          results.push(await runDifferentialSpec(ctx, index, spec, holder));
          sides[index] = holder.current ?? {
            status: "error",
            fixme: false,
            durationMs: undefined,
            steps: [],
            network: {},
            extraTests: 0,
          };
        }
        annotateLocatorMode(results, manifest.source.strictLocators === true);
        const { summary, status } = summarizeDifferential(results);
        differential = {
          status,
          runTokenPrefix: ctx.tokenPrefix,
          durationRatioThreshold: ctx.durationRatio,
          preconditionsMode: manifest.source.preconditions ?? "default",
          ...(manifest.source.strictLocators === true
            ? { strictLocators: true as const }
            : {}),
          order: "cairn-then-export",
          specs: results,
          summary,
        };
      }
      if (opts.mutate) {
        const results: ExportVerifyMutationSpec[] = [];
        for (const [index, spec] of specs.entries()) {
          let baseline = sides[index];
          if (!baseline) {
            baseline = await runExportSide({
              playwrightBin: ctx.playwrightBin,
              configDir: ctx.configDir,
              ...(ctx.configFile ? { configFile: ctx.configFile } : {}),
              ...(ctx.project !== undefined ? { project: ctx.project } : {}),
              testFile: join(dir, spec.testFile),
              reportFile: join(workDir, "reports", `baseline-${index}.json`),
              env: exportEnv(ctx, `${ctx.tokenPrefix}-${index}b`),
              timeoutMs: ctx.timeoutMs,
            });
          }
          results.push(
            await runMutationSpec(ctx, index, spec, opts.mutate, baseline),
          );
        }
        mutation = summarizeMutation(results, opts.mutate);
      }
    } finally {
      await sweepMutants(target);
      // A disagreement is easier to chase with both sides' evidence: keep it.
      const keep =
        differential !== undefined &&
        (differential.summary.mismatch > 0 || differential.summary.error > 0);
      if (keep) {
        warnings.push(
          `kept the run artifacts (cairn run directories under runs/, Playwright JSON reports under reports/) in ${workDir}; the differential's cairn.runDir is relative to its runs/; delete it when done`,
        );
      } else {
        await rm(workDir, { recursive: true, force: true });
      }
    }
  }

  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const gate of gates) counts[gate.status] += 1;
  const differentialErrors = differential?.summary.error ?? 0;
  const failed =
    counts.failed > 0 ||
    differential?.status === "failed" ||
    mutation?.status === "failed";
  // --verify-strict: nothing short of a pass will do (a skipped gate, an
  // inconclusive or skipped differential spec, an unproven mutation).
  const strictFailure =
    opts.strict === true &&
    (counts.skipped > 0 ||
      (differential !== undefined &&
        (differential.status !== "passed" ||
          differential.summary.inconclusive > 0 ||
          differential.summary.skipped > 0)) ||
      (mutation !== undefined && mutation.status !== "passed"));
  // Nothing proven is never a pass: no toolchain gate (tsc, playwright
  // --list) ran over the generated code, or the requested differential /
  // mutation proved nothing either way.
  const staticProvedNothing = !gates.some(
    (gate) => TOOLCHAIN_GATES.has(gate.id) && gate.status !== "skipped",
  );
  const inconclusive =
    staticProvedNothing ||
    differential?.status === "inconclusive" ||
    mutation?.status === "inconclusive";
  const status: ExportVerifyReport["status"] =
    failed || strictFailure
      ? "failed"
      : differentialErrors > 0
        ? "error"
        : inconclusive
          ? "inconclusive"
          : "passed";
  if (status === "inconclusive") {
    warnings.push(
      [
        staticProvedNothing
          ? "neither the typecheck nor the playwright --list gate ran (no local tsc / Playwright, or a JavaScript export without Playwright)"
          : undefined,
        differential?.status === "inconclusive"
          ? "the differential matched no spec (failed baselines, skipped tests)"
          : undefined,
        mutation?.status === "inconclusive"
          ? "no mutant was killed or survived"
          : undefined,
      ]
        .filter((part) => part !== undefined)
        .join("; ")
        .concat(": inconclusive, which is not a pass (exit 3)"),
    );
  }
  if (differentialErrors > 0 && status === "error") {
    warnings.push(
      `${differentialErrors} spec(s) could not be run on one side; see their reason`,
    );
  }
  if (opts.strict && strictFailure && !failed) {
    warnings.push(
      "--verify-strict: a skipped or inconclusive result counts as a failure",
    );
  }
  const exitCode =
    status === "passed"
      ? 0
      : status === "failed"
        ? EXPORT_VERIFY_FAILED_EXIT
        : status === "inconclusive"
          ? EXPORT_VERIFY_INCONCLUSIVE_EXIT
          : EXPORT_VERIFY_ERROR_EXIT;
  const report: ExportVerifyReport = {
    $schema: EXPORT_VERIFY_SCHEMA_ID,
    version: "1",
    status,
    exitCode,
    exportDir: dir,
    exporterVersion: CAIRN_VERSION,
    manifest: {
      exporterVersion: manifest.exporterVersion,
      mode: manifest.mode,
      lang: manifest.lang,
      specs: manifest.specs.length,
    },
    verifiedAt: new Date().toISOString(),
    filesDigest: exportFilesDigest(manifest.files),
    ...(listing.project ? { playwrightProject: listing.project } : {}),
    gates,
    ...(differential ? { differential } : {}),
    ...(mutation ? { mutation } : {}),
    summary: { gates: counts },
    warnings,
    ...(opts.write !== false ? { reportFile: EXPORT_VERIFY_JSON } : {}),
  };
  if (opts.write !== false) await writeVerifyReport(dir, report);
  return { report, exitCode };
}

async function writeVerifyReport(
  dir: string,
  report: ExportVerifyReport,
): Promise<void> {
  await writeFile(
    join(dir, EXPORT_VERIFY_JSON),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(join(dir, EXPORT_VERIFY_MD), `${verifyToMarkdown(report)}\n`);
  if (report.filesDigest) {
    await recordManifestVerify(dir, {
      verifiedAt: report.verifiedAt,
      exporterVersion: report.exporterVersion,
      status: report.status,
      filesDigest: report.filesDigest,
      gates: Object.fromEntries(report.gates.map((g) => [g.id, g.status])),
      ...(report.differential
        ? { differential: report.differential.status }
        : {}),
      ...(report.mutation ? { mutation: report.mutation.status } : {}),
      report: EXPORT_VERIFY_JSON,
    });
  }
}

export function verifyToMarkdown(report: ExportVerifyReport): string {
  const lines = [
    `# Export verify: ${report.status}`,
    "",
    `Export: \`${report.exportDir}\``,
  ];
  if (report.error) {
    lines.push("", `Error: ${report.error}`);
    return lines.join("\n");
  }
  if (report.manifest) {
    lines.push(
      `Generated by cairntrace ${report.manifest.exporterVersion} (${report.manifest.mode}, ${report.manifest.lang}, ${report.manifest.specs} spec(s)); verified by ${report.exporterVersion}`,
    );
  }
  if (report.playwrightProject) {
    const p = report.playwrightProject;
    lines.push(`Playwright project: \`${p.name}\` (${p.source}) — ${p.reason}`);
  }
  const g = report.summary.gates;
  lines.push(
    "",
    `## Static gates: ${g.passed} passed, ${g.failed} failed, ${g.skipped} skipped`,
    "",
  );
  for (const gate of report.gates) {
    lines.push(`- **${gate.id}**: ${gate.status} — ${gate.summary}`);
    for (const finding of gate.findings ?? []) lines.push(`  - ${finding}`);
  }
  if (g.skipped > 0) {
    lines.push("", "A skipped gate proves nothing: it is not a pass.");
  }
  if (report.differential) {
    const d = report.differential;
    lines.push(
      "",
      `## Differential: ${d.status}`,
      "",
      `Both sides ran sequentially (cairn run, then the exported test) with CAIRN_RUN_TOKEN \`${d.runTokenPrefix}-<n>\`; export preconditions mode: ${d.preconditionsMode}. Specs that are not idempotent need a reset (preconditions / teardown) between the two runs.`,
      "",
      `match ${d.summary.match}, mismatch ${d.summary.mismatch}, inconclusive ${d.summary.inconclusive}, skipped ${d.summary.skipped}, error ${d.summary.error}`,
      "",
    );
    for (const spec of d.specs) {
      lines.push(
        `- **${spec.spec}**: ${spec.status}${
          spec.reason ? ` — ${spec.reason}` : ""
        }${
          spec.compared
            ? ` (${spec.compared.steps} step(s), ${spec.compared.outcomes} outcome(s) compared)`
            : ""
        }`,
      );
      for (const mismatch of spec.mismatches) {
        lines.push(`  - mismatch [${mismatch.kind}]: ${mismatch.detail}`);
      }
      for (const evidence of spec.network ?? []) {
        lines.push(
          `  - network ${evidence.outcome}: cairn ${evidence.cairn}, export ${evidence.export}`,
        );
      }
      if (spec.durationRatio !== undefined) {
        lines.push(
          `  - duration ratio (export / cairn): ${spec.durationRatio}`,
        );
      }
      for (const warning of spec.warnings)
        lines.push(`  - warning: ${warning}`);
    }
  }
  if (report.mutation) {
    const m = report.mutation;
    lines.push(
      "",
      `## Mutation (${m.scope}): ${m.status}`,
      "",
      `killed ${m.summary.killed}, survived ${m.summary.survived}, invalid ${m.summary.invalid}, not applicable ${m.summary.notApplicable}`,
      "",
    );
    for (const spec of m.specs) {
      lines.push(
        `- **${spec.spec}**: ${spec.status}${
          spec.reason ? ` — ${spec.reason}` : ""
        }`,
      );
      for (const mutant of spec.mutants) {
        lines.push(
          `  - ${mutant.outcome}: ${mutant.status}${
            mutant.operator ? ` (${mutant.operator})` : ""
          }${mutant.detail ? ` — ${mutant.detail}` : ""}`,
        );
      }
    }
  }
  if (report.warnings.length > 0) {
    lines.push("", "## Warnings", ...report.warnings.map((w) => `- ${w}`));
  }
  if (report.reportFile) {
    lines.push(
      "",
      `Report: \`${report.reportFile}\` (summary in ${EXPORT_MANIFEST_FILE})`,
    );
  }
  return lines.join("\n");
}

/** CLI entry: run the verify and print the report in the requested format. */
export async function exportVerifyCommand(
  opts: ExportVerifyOptions,
  format: ReturnType<typeof resolveFormat>,
): Promise<void> {
  const { report, exitCode } = await verifyPlaywrightExport(opts);
  process.stdout.write(emit(format, report, verifyToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  // exitCode (not process.exit) so a piped JSON report is fully flushed. An
  // exit code the export already set (a spec refused by --max-eval-ratio)
  // is not lowered by a passing or inconclusive verify.
  process.exitCode = mergeExportExitCodes(
    exitCode,
    typeof process.exitCode === "number" ? process.exitCode : 0,
  );
}
