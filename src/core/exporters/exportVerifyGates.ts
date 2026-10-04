/**
 * Static gates of `cairn export playwright --verify` (E5): checks that need
 * no browser and no running app. Each gate reports passed / failed /
 * skipped(reason); a skipped gate proves nothing and is never a pass.
 *
 * Tools (tsc, eslint, playwright) are the target's own local binaries found
 * by walking up from the export directory. They are never installed and
 * never fetched: no binary means a skipped gate that says so.
 */
import { existsSync, realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { targetChildEnv } from "../processEnv";
import { runBoundedCommand } from "../runner/boundedCommand";
import type {
  ExportVerifyGate,
  ExportVerifyGateId,
} from "../schema/exportVerify.v1";
import type { ExportManifestV1 } from "./exportManifest";
import { EXPORT_MANIFEST_FILE } from "./exportManifest";
import { hostBoundary, readHostProfile } from "./hostProfile";
import { isVendoredExportFile } from "./hostPostprocess";

/** The sentinels the exporter late-binds; one left in a file is an exporter defect. */
export const SENTINEL_PATTERN = /__CAIRN_[A-Z_]+__/i;

const MAX_FINDINGS = 25;
const OUTPUT_TAIL_CHARS = 2000;
const LEVELS_UP = 8;
const TSC_TIMEOUT_MS = 300_000;
const ESLINT_TIMEOUT_MS = 300_000;
const LIST_TIMEOUT_MS = 120_000;

/** The export a verify run looks at. */
export interface ExportTarget {
  /** Real path of the export root (where `.cairn-export.json` lives). */
  dir: string;
  manifest: ExportManifestV1;
}

/** Manifest files that exist on disk, relative POSIX paths. */
export function exportFileList(target: ExportTarget): string[] {
  return target.manifest.files
    .map((file) => file.path)
    .filter((path) => existsSync(join(target.dir, path)))
    .toSorted();
}

const posix = (path: string): string => path.split(sep).join("/");

/** Real path of the nearest existing ancestor + the rest (for not-yet-existing paths). */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The directory (start or an ancestor up to the host boundary: the nearest
 * `.git`, else the outermost package root below the home directory) that
 * contains one of `names`. A config or binary above the host is never used.
 */
export function findUp(start: string, names: string[]): string | undefined {
  let current = real(start);
  const boundary = hostBoundary(current);
  for (let level = 0; level <= LEVELS_UP; level += 1) {
    for (const name of names) {
      if (existsSync(join(current, name))) return current;
    }
    if (current === boundary) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

/** `node_modules/.bin/<name>` of the export dir or its nearest ancestor that has one. */
export function findBin(start: string, name: string): string | undefined {
  const dir = findUp(start, [join("node_modules", ".bin", name)]);
  return dir ? join(dir, "node_modules", ".bin", name) : undefined;
}

function relTo(from: string, to: string): string {
  return posix(relative(real(from), real(to))) || ".";
}

function tail(text: string): string {
  const trimmed = text.trim();
  return trimmed.length > OUTPUT_TAIL_CHARS
    ? `…${trimmed.slice(trimmed.length - OUTPUT_TAIL_CHARS)}`
    : trimmed;
}

function cap(findings: string[]): string[] {
  return findings.length > MAX_FINDINGS
    ? [
        ...findings.slice(0, MAX_FINDINGS),
        `…and ${findings.length - MAX_FINDINGS} more`,
      ]
    : findings;
}

function gate(
  id: ExportVerifyGateId,
  startedAt: number,
  fields: Omit<ExportVerifyGate, "id" | "durationMs">,
): ExportVerifyGate {
  const { findings, ...rest } = fields;
  return {
    id,
    ...rest,
    ...(findings && findings.length > 0 ? { findings: cap(findings) } : {}),
    durationMs: Date.now() - startedAt,
  };
}

function skipped(
  id: ExportVerifyGateId,
  startedAt: number,
  reason: string,
  findings?: string[],
): ExportVerifyGate {
  return gate(id, startedAt, {
    status: "skipped",
    reason,
    summary: reason,
    ...(findings && findings.length > 0 ? { findings } : {}),
  });
}

/* ----- sentinels ----- */

export async function sentinelsGate(
  target: ExportTarget,
): Promise<ExportVerifyGate> {
  const startedAt = Date.now();
  const files = [...exportFileList(target), EXPORT_MANIFEST_FILE];
  const findings: string[] = [];
  let scanned = 0;
  for (const file of files) {
    const abs = join(target.dir, file);
    if (!existsSync(abs)) continue;
    scanned += 1;
    // latin1: every byte maps to one char, so a binary fixture can neither
    // throw nor hide an ASCII sentinel.
    const text = (await readFile(abs)).toString("latin1");
    const hit = SENTINEL_PATTERN.exec(text);
    if (hit) {
      const line = text.slice(0, hit.index).split("\n").length;
      findings.push(`${file}:${line}: ${hit[0]}`);
    }
  }
  return gate("sentinels", startedAt, {
    status: findings.length === 0 ? "passed" : "failed",
    summary:
      findings.length === 0
        ? `${scanned} files, no late-bound sentinel left`
        : `${findings.length} file(s) carry a late-bound sentinel (an exporter defect)`,
    findings,
  });
}

/* ----- freshness (the --check engine) ----- */

export interface FreshnessInput {
  status: "fresh" | "stale" | "error";
  files: { stale: string[]; missing: string[]; orphaned: string[] };
  specs: Array<{ spec: string; status: string }>;
  preconditionsStale?: boolean;
  error?: string;
}

export function freshnessGate(
  report: FreshnessInput,
  startedAt: number,
): ExportVerifyGate {
  if (report.status === "error") {
    return skipped(
      "freshness",
      startedAt,
      `cannot regenerate the export to compare (${report.error ?? "unknown error"})`,
    );
  }
  if (report.status === "fresh") {
    return gate("freshness", startedAt, {
      status: "passed",
      summary: "regenerating from the current sources reproduces every file",
    });
  }
  return gate("freshness", startedAt, {
    status: "failed",
    summary: "the export no longer matches its sources (re-export it)",
    findings: [
      ...report.files.stale.map((file) => `stale: ${file}`),
      ...report.files.missing.map((file) => `missing: ${file}`),
      ...report.files.orphaned.map((file) => `orphaned: ${file}`),
      ...report.specs
        .filter((spec) => spec.status !== "fresh")
        .map((spec) => `spec ${spec.spec}: ${spec.status}`),
      ...(report.preconditionsStale ? ["preconditions: changed"] : []),
    ],
  });
}

/* ----- typecheck ----- */

interface TscDiagnostic {
  file: string;
  line: number;
  code: string;
  message: string;
}

/** `path(line,col): error TS1234: message` (tsc --pretty false). */
function parseTscDiagnostics(output: string): TscDiagnostic[] {
  const out: TscDiagnostic[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?)\((\d+),\d+\): error (TS\d+): (.*)$/.exec(line.trim());
    if (match) {
      out.push({
        file: match[1]!,
        line: Number(match[2]),
        code: match[3]!,
        message: match[4]!,
      });
    }
  }
  return out;
}

/**
 * Option / config errors (`TS5xxx`, and `TS6046`, a bad option value): tsc
 * reports them and then skips the semantic check, so "no errors in the
 * export's files" would be a false pass.
 */
function optionErrorsOf(output: string): string[] {
  const out: string[] = [];
  for (const line of output.split("\n")) {
    const match = /(?:^|\s)error (TS5\d{3}|TS6046): (.*)$/.exec(line.trim());
    if (match) out.push(`${match[1]}: ${match[2]}`);
  }
  return out;
}

const FALLBACK_TSC_OPTIONS = [
  "--noEmit",
  "--pretty",
  "false",
  "--strict",
  "--noUnusedLocals",
  "--target",
  "ES2023",
  "--module",
  "ESNext",
  "--moduleResolution",
  "Bundler",
  "--lib",
  "ES2023,DOM,DOM.Iterable",
  "--types",
  "node",
  "--skipLibCheck",
  "--allowImportingTsExtensions",
  "--resolveJsonModule",
];

async function runTool(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  extraEnv: Record<string, string> = {},
) {
  return runBoundedCommand(bin, args, {
    cwd,
    env: { ...targetChildEnv(), ...extraEnv },
    timeoutMs,
    ownProcessGroup: true,
    killLeftovers: true,
  });
}

/** The tsconfig the manifest's host profile resolves to, when it has one. */
async function hostTsconfigOf(
  target: ExportTarget,
): Promise<string | undefined> {
  const hostConfig = target.manifest.source.hostConfig;
  if (!hostConfig) return undefined;
  try {
    const profile = await readHostProfile({
      configPath: resolve(target.dir, hostConfig),
      into: target.dir,
    });
    return profile.tsconfig?.path;
  } catch {
    return undefined;
  }
}

export async function typecheckGate(
  target: ExportTarget,
): Promise<ExportVerifyGate> {
  const startedAt = Date.now();
  if (target.manifest.lang === "js") {
    return skipped(
      "typecheck",
      startedAt,
      "JavaScript export: there is nothing to typecheck",
    );
  }
  const sources = exportFileList(target).filter(
    (file) => /\.(?:ts|tsx|mts|cts)$/.test(file) && !file.endsWith(".d.ts"),
  );
  if (sources.length === 0) {
    return skipped(
      "typecheck",
      startedAt,
      "the export has no TypeScript files",
    );
  }
  const tsc = findBin(target.dir, "tsc");
  if (!tsc) {
    return skipped(
      "typecheck",
      startedAt,
      "no TypeScript compiler (node_modules/.bin/tsc) in or above the export directory; verify never installs one",
    );
  }
  // The host profile (E8) names the tsconfig Playwright uses for the tree
  // (its `tsconfig:` option, else the nearest one); without one, the nearest.
  const hostTsconfig = await hostTsconfigOf(target);
  const tsconfigFile =
    hostTsconfig ??
    (() => {
      const dir = findUp(target.dir, ["tsconfig.json"]);
      return dir ? join(dir, "tsconfig.json") : undefined;
    })();
  const tsconfigDir = tsconfigFile ? dirname(tsconfigFile) : undefined;
  const findings: string[] = [];
  let mode: string;
  let hostIgnored = 0;
  const exportAbs = new Map(
    sources.map((file) => [real(join(target.dir, file)), file]),
  );
  const collect = (
    output: string,
    cwd: string,
  ): { errors: number; ours: number } => {
    const diagnostics = parseTscDiagnostics(output);
    let ours = 0;
    for (const diagnostic of diagnostics) {
      const file = exportAbs.get(real(resolve(cwd, diagnostic.file)));
      if (file) {
        ours += 1;
        findings.push(
          `${file}:${diagnostic.line}: ${diagnostic.code} ${diagnostic.message}`,
        );
      } else {
        hostIgnored += 1;
      }
    }
    return { errors: diagnostics.length, ours };
  };

  if (tsconfigDir) {
    const own = tsconfigDir === target.dir;
    // The exporter's own generated project is held to the strict bar CI uses;
    // a host tsconfig is the host's bar and is used as is.
    const args = [
      "--noEmit",
      "--pretty",
      "false",
      "--listFiles",
      "-p",
      tsconfigFile!,
      ...(target.manifest.mode === "project" && own
        ? ["--noUnusedLocals"]
        : []),
    ];
    mode = `${relTo(target.dir, tsconfigFile!)}${
      target.manifest.mode === "project" && own ? " + noUnusedLocals" : ""
    }`;
    const result = await runTool(tsc, args, tsconfigDir, TSC_TIMEOUT_MS);
    if (result.spawnError || result.timedOut || result.cancelled) {
      return skipped(
        "typecheck",
        startedAt,
        result.timedOut
          ? `tsc did not finish within ${TSC_TIMEOUT_MS / 1000}s`
          : `tsc could not run: ${result.spawnError ?? "cancelled"}`,
      );
    }
    const optionErrors = optionErrorsOf(result.stdout);
    if (optionErrors.length > 0) {
      return skipped(
        "typecheck",
        startedAt,
        `this tsc rejects the tsconfig (${relTo(target.dir, tsconfigFile!)}: ${optionErrors[0]}), so it did not type-check the files; use the host's own compiler version`,
      );
    }
    const main = collect(result.stdout, tsconfigDir);
    const crashed = exitedWithoutDiagnostics(result, main.errors);
    if (crashed) return skipped("typecheck", startedAt, crashed);
    const covered = new Set(
      result.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(
          (line) =>
            (line.startsWith("/") || /^[A-Za-z]:[\\/]/.test(line)) &&
            !line.includes("): error "),
        )
        .map((line) => real(line)),
    );
    const uncovered = [...exportAbs.entries()].filter(
      ([abs]) => !covered.has(abs),
    );
    if (uncovered.length > 0) {
      // The host tsconfig does not include these files: compile them with
      // the strict fallback so an unchecked file is never a silent pass.
      const second = await runTool(
        tsc,
        [...FALLBACK_TSC_OPTIONS, ...uncovered.map(([, file]) => file)],
        target.dir,
        TSC_TIMEOUT_MS,
      );
      const unchecked = toolDidNotCheck(second, "the strict fallback tsc");
      if (unchecked) return skipped("typecheck", startedAt, unchecked);
      const fallback = collect(second.stdout, target.dir);
      const fallbackCrashed = exitedWithoutDiagnostics(second, fallback.errors);
      if (fallbackCrashed) {
        return skipped("typecheck", startedAt, fallbackCrashed);
      }
      mode += ` + strict fallback for ${uncovered.length} file(s) outside its include`;
    }
  } else {
    mode = "no tsconfig found: strict + noUnusedLocals fallback";
    const result = await runTool(
      tsc,
      [...FALLBACK_TSC_OPTIONS, ...sources],
      target.dir,
      TSC_TIMEOUT_MS,
    );
    const unchecked = toolDidNotCheck(result, "tsc");
    if (unchecked) return skipped("typecheck", startedAt, unchecked);
    const { errors } = collect(result.stdout, target.dir);
    const crashed = exitedWithoutDiagnostics(result, errors);
    if (crashed) return skipped("typecheck", startedAt, crashed);
  }
  return gate("typecheck", startedAt, {
    status: findings.length === 0 ? "passed" : "failed",
    summary:
      findings.length === 0
        ? `${sources.length} TypeScript files compile (${mode})${
            hostIgnored > 0
              ? `; ${hostIgnored} error(s) in host files are not the export's`
              : ""
          }`
        : `${findings.length} type error(s) in export files (${mode})`,
    findings,
  });
}

/**
 * The warning eslint reports INSTEAD of linting a file: a matching ignore
 * pattern, or no configuration entry for it (flat config).
 */
function isNotLintedMessage(message: {
  ruleId: string | null;
  severity: number;
  message: string;
}): boolean {
  return (
    message.ruleId === null &&
    message.severity <= 1 &&
    /file ignored|no matching configuration|outside of base path/i.test(
      message.message,
    )
  );
}

/**
 * Why a tsc run checked nothing (it could not start, timed out, was
 * cancelled, or rejected its options), or undefined when it ran.
 */
function toolDidNotCheck(
  result: Awaited<ReturnType<typeof runTool>>,
  what: string,
): string | undefined {
  if (result.spawnError || result.timedOut || result.cancelled) {
    return result.timedOut
      ? `${what} did not finish within ${TSC_TIMEOUT_MS / 1000}s`
      : `${what} could not run: ${result.spawnError ?? "cancelled"}`;
  }
  const optionErrors = optionErrorsOf(result.stdout);
  if (optionErrors.length > 0) {
    return `${what} rejected its options (${optionErrors[0]}), so it did not type-check the files`;
  }
  return undefined;
}

/**
 * A tsc that exits non-zero without a single diagnostic crashed (out of
 * memory, a broken install): nothing was checked, which is never a pass.
 */
function exitedWithoutDiagnostics(
  result: Awaited<ReturnType<typeof runTool>>,
  diagnostics: number,
): string | undefined {
  if (diagnostics > 0 || result.exitCode === 0) return undefined;
  return `tsc exited ${result.exitCode ?? result.exitSignal ?? "?"} without a diagnostic (a crash, not a check): ${tail(
    result.stderr || result.stdout,
  )
    .split("\n")
    .slice(-3)
    .join(" | ")}`;
}

/* ----- lint (the host's eslint) ----- */

const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

interface EslintFileResult {
  filePath: string;
  errorCount: number;
  warningCount: number;
  messages: Array<{
    ruleId: string | null;
    severity: number;
    message: string;
    line?: number;
    fatal?: boolean;
  }>;
}

export async function lintGate(
  target: ExportTarget,
): Promise<ExportVerifyGate> {
  const startedAt = Date.now();
  const configDir = findUp(target.dir, ESLINT_CONFIGS);
  if (!configDir) {
    return skipped(
      "lint",
      startedAt,
      "no eslint config in or above the export directory",
    );
  }
  const eslint = findBin(configDir, "eslint") ?? findBin(target.dir, "eslint");
  if (!eslint) {
    return skipped(
      "lint",
      startedAt,
      "an eslint config exists but no local eslint binary (node_modules/.bin/eslint); verify never installs one",
    );
  }
  // Vendored runtime files (lib/ except lib/pages/, the command runner,
  // the global setup) are copies of the runner's own modules carrying an
  // eslint-disable banner: not code written for the host's rules, and a
  // host config that does not cover .js (lib/runtime/workbook.js) would
  // otherwise leave the gate skipped forever. Tests, actions and page
  // objects are linted.
  const code = exportFileList(target).filter((file) =>
    /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file),
  );
  const vendored = code.filter((file) => isVendoredExportFile(file));
  const files = code.filter((file) => !isVendoredExportFile(file));
  if (files.length === 0) {
    return skipped(
      "lint",
      startedAt,
      vendored.length > 0
        ? `the export has no lintable files (${vendored.length} vendored runtime file(s) are not linted)`
        : "the export has no lintable files",
    );
  }
  const vendoredNote =
    vendored.length > 0
      ? `; ${vendored.length} vendored runtime file(s) not linted (copies of the runner's modules)`
      : "";
  const args = [
    "--format",
    "json",
    ...files.map((file) => relTo(configDir, join(target.dir, file))),
  ];
  const result = await runTool(eslint, args, configDir, ESLINT_TIMEOUT_MS);
  if (result.spawnError || result.timedOut || result.cancelled) {
    return skipped(
      "lint",
      startedAt,
      result.timedOut
        ? `eslint did not finish within ${ESLINT_TIMEOUT_MS / 1000}s`
        : `eslint could not run: ${result.spawnError ?? "cancelled"}`,
    );
  }
  let results: EslintFileResult[];
  try {
    results = JSON.parse(result.stdout) as EslintFileResult[];
    if (!Array.isArray(results)) throw new Error("not an array");
  } catch {
    return skipped(
      "lint",
      startedAt,
      `eslint produced no JSON report (exit ${result.exitCode ?? result.exitSignal ?? "?"}): ${tail(
        result.stderr || result.stdout,
      )
        .split("\n")
        .slice(-3)
        .join(" | ")}`,
    );
  }
  const findings: string[] = [];
  const ignored: string[] = [];
  let warnings = 0;
  for (const file of results) {
    const name = posix(relative(real(target.dir), real(file.filePath)));
    // eslint answers a file its config ignores (or no config entry
    // matches) with one rule-less warning instead of linting it.
    if (file.messages.some(isNotLintedMessage)) {
      ignored.push(name);
      continue;
    }
    warnings += file.warningCount;
    for (const message of file.messages) {
      if (message.severity >= 2 || message.fatal) {
        findings.push(
          `${name}:${message.line ?? 0}: ${message.ruleId ?? "error"} ${message.message}`,
        );
      }
    }
  }
  // A file eslint did not report on at all was not linted either.
  const reported = new Set(
    results.map((file) =>
      posix(relative(real(target.dir), real(file.filePath))),
    ),
  );
  for (const file of files) {
    if (!reported.has(posix(file))) ignored.push(posix(file));
  }
  const linted = files.length - ignored.length;
  if (findings.length === 0 && ignored.length > 0) {
    // A file eslint did not lint proved nothing: never a clean pass.
    return skipped(
      "lint",
      startedAt,
      `the eslint config (in ${relTo(target.dir, configDir)}) ignores ${
        linted === 0 ? "every" : `${ignored.length} of ${files.length}`
      } export file(s), so ${
        linted === 0 ? "nothing was" : "they were not"
      } linted: ${ignored.slice(0, 5).join(", ")}${
        ignored.length > 5 ? ", …" : ""
      }`,
      ignored.map(
        (name) => `${name}: not linted (ignored by the eslint config)`,
      ),
    );
  }
  const errors = findings.length;
  if (ignored.length > 0) {
    findings.push(
      ...ignored.map(
        (name) => `${name}: not linted (ignored by the eslint config)`,
      ),
    );
  }
  return gate("lint", startedAt, {
    status: errors === 0 ? "passed" : "failed",
    summary:
      errors === 0
        ? `${linted} files lint clean with ${relTo(target.dir, configDir)}'s eslint config${
            warnings > 0 ? ` (${warnings} warning(s))` : ""
          }${vendoredNote}`
        : `${errors} eslint error(s)${
            warnings > 0 ? `, ${warnings} warning(s)` : ""
          }${
            ignored.length > 0
              ? `; ${ignored.length} file(s) not linted (ignored)`
              : ""
          }`,
    findings,
  });
}

/* ----- playwright --list ----- */

export interface ListedTest {
  /** Absolute path of the test file. */
  file: string;
  title: string;
  fixme: boolean;
  /** `skipped` expected status (fixme / skip). */
  skip: boolean;
  /** The Playwright project that lists the test (one entry per project). */
  projectId?: string;
  projectName?: string;
}

interface JsonSuite {
  file?: string;
  specs?: Array<{
    title: string;
    file?: string;
    tests?: Array<{
      expectedStatus?: string;
      annotations?: Array<{ type: string }>;
      projectId?: string;
      projectName?: string;
    }>;
  }>;
  suites?: JsonSuite[];
}

/** `playwright test --list --reporter=json` (and a run's JSON report). */
export interface PlaywrightListJson {
  config?: {
    rootDir?: string;
    projects?: Array<{ id?: string; name?: string }>;
  };
  suites?: JsonSuite[];
  errors?: Array<{ message?: string }>;
}

/** Flatten a Playwright JSON report (`--list` or a run) into its tests. */
export function listedTestsFromJson(json: PlaywrightListJson): ListedTest[] {
  const root = json.config?.rootDir ?? "";
  const out: ListedTest[] = [];
  const visit = (suite: JsonSuite): void => {
    for (const spec of suite.specs ?? []) {
      const file = spec.file ?? suite.file ?? "";
      for (const test of spec.tests ?? []) {
        out.push({
          file: resolve(root, file),
          title: spec.title,
          fixme: (test.annotations ?? []).some((a) => a.type === "fixme"),
          skip: test.expectedStatus === "skipped",
          ...(test.projectId !== undefined
            ? { projectId: test.projectId }
            : {}),
          ...(test.projectName !== undefined
            ? { projectName: test.projectName }
            : {}),
        });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of json.suites ?? []) visit(suite);
  return out;
}

/**
 * A JSON document on stdout that the host's own code may have written lines
 * before (a dotenv banner, a config `console.log`): the document is the
 * last top-level `{` that parses to the end of the output.
 */
function parseJsonReport<T>(stdout: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch (firstError) {
    const starts = [...stdout.matchAll(/^\{/gm)].map((m) => m.index!);
    for (const start of starts) {
      try {
        return JSON.parse(stdout.slice(start)) as T;
      } catch {
        // try the next candidate
      }
    }
    throw firstError;
  }
}

export const PLAYWRIGHT_CONFIGS = [
  "playwright.config.ts",
  "playwright.config.js",
  "playwright.config.mjs",
  "playwright.config.cjs",
  "playwright.config.mts",
  "playwright.config.cts",
];

/** Where `playwright test` runs for an export. */
export interface PlaywrightLocation {
  /** Directory of the config (the cwd of every Playwright run). */
  configDir: string;
  /** The host config the manifest names (passed as `--config`). */
  configFile?: string;
  /** The config file Playwright loads (`configFile`, else the one found by name). */
  configPath?: string;
  playwright: string;
}

/** The config + local binary an export is listed and run with, or why there is none. */
export function playwrightLocation(
  target: ExportTarget,
): PlaywrightLocation | { skip: string } {
  if (target.manifest.mode === "files") {
    return {
      skip: "standalone (--out-dir) export has no Playwright config to list its tests with; use --project or --into",
    };
  }
  // E8: the host config the tree was adapted to is the one that lists it.
  const hostConfig = target.manifest.source.hostConfig
    ? resolve(target.dir, target.manifest.source.hostConfig)
    : undefined;
  const configFile =
    hostConfig && existsSync(hostConfig) ? hostConfig : undefined;
  const configDir = configFile
    ? dirname(configFile)
    : findUp(target.dir, PLAYWRIGHT_CONFIGS);
  if (!configDir) {
    return { skip: "no playwright.config in or above the export directory" };
  }
  const playwright =
    findBin(configDir, "playwright") ?? findBin(target.dir, "playwright");
  if (!playwright) {
    return {
      skip: "no local Playwright binary (node_modules/.bin/playwright); verify never installs one",
    };
  }
  const configPath =
    configFile ??
    PLAYWRIGHT_CONFIGS.map((name) => join(configDir, name)).find((path) =>
      existsSync(path),
    );
  return {
    configDir,
    ...(configFile ? { configFile } : {}),
    ...(configPath ? { configPath } : {}),
    playwright,
  };
}

/** `playwright test --list --reporter=json [--project <p>]`: the JSON, or why there is none. */
async function runList(
  location: PlaywrightLocation,
  project?: string,
): Promise<{ json: PlaywrightListJson } | { skip: string }> {
  const label = `playwright test --list${
    project ? ` --project ${project}` : ""
  }`;
  const result = await runTool(
    location.playwright,
    [
      "test",
      "--list",
      "--reporter=json",
      ...(location.configFile ? ["--config", location.configFile] : []),
      ...(project !== undefined ? ["--project", project] : []),
    ],
    location.configDir,
    LIST_TIMEOUT_MS,
  );
  if (result.spawnError || result.timedOut || result.cancelled) {
    return {
      skip: result.timedOut
        ? `${label} did not finish within ${LIST_TIMEOUT_MS / 1000}s`
        : `playwright could not run: ${result.spawnError ?? "cancelled"}`,
    };
  }
  try {
    return { json: parseJsonReport<PlaywrightListJson>(result.stdout) };
  } catch {
    return {
      skip: `${label} produced no JSON (exit ${result.exitCode ?? "?"}): ${tail(
        result.stderr || result.stdout,
      )
        .split("\n")
        .slice(-3)
        .join(" | ")}`,
    };
  }
}

/**
 * The Playwright project `--verify` lists, runs (differential) and mutates
 * the exported tests under, on a host config with several projects. A
 * multi-project host lists each test once per project that discovers it,
 * and an unfiltered run would run every browser: one project is chosen and
 * passed as `--project` (Playwright still runs its `dependencies`, a setup
 * project included).
 */
export interface VerifyProject {
  name: string;
  /** `flag`: --verify-project / MCP verifyProject; `manifest`: recorded at export time (flag or `export.targets.<n>.verifyProject`); `auto`: chosen. */
  source: "flag" | "manifest" | "auto";
  reason: string;
  /** Every project of the config, in config order. */
  projects: string[];
  /** The projects that discover at least one exported test. */
  discovering: string[];
}

/** What the list gate and the runs share: where Playwright runs, its unfiltered listing, the project. */
export interface ListContext {
  location?: PlaywrightLocation;
  /** The unfiltered `--list` (absent when it could not run: `skip` says why). */
  listing?: PlaywrightListJson;
  skip?: string;
  project?: VerifyProject;
  /** A requested project the config does not have (a usage error, exit 2). */
  error?: string;
}

export interface RequestedProject {
  name: string;
  source: "flag" | "manifest";
}

const CHROMIUM_NAME = /chrom|chrome|edge/i;

/**
 * Choose the project from Playwright's own unfiltered listing. A requested
 * one must exist; otherwise, with more than one project: among the named
 * projects that discover the most exported tests, the first (config order)
 * that runs Chromium (`browsers`, read statically from the config), else
 * the first whose name says Chromium, else the first. A single project (or
 * none that can be named) needs no filter: undefined.
 */
export function chooseVerifyProject(
  listing: PlaywrightListJson,
  exportedFiles: readonly string[],
  browsers: ReadonlyMap<string, string | undefined>,
  requested?: RequestedProject,
): { project?: VerifyProject; error?: string } {
  const projects = (listing.config?.projects ?? []).map((p) => p.name ?? "");
  const exported = new Set(exportedFiles.map((file) => real(file)));
  const perProject = new Map<string, Set<string>>();
  for (const test of listedTestsFromJson(listing)) {
    const file = real(test.file);
    if (!exported.has(file)) continue;
    const name = test.projectName ?? "";
    perProject.set(name, (perProject.get(name) ?? new Set()).add(file));
  }
  const discovering = projects.filter(
    (name, i) => perProject.has(name) && projects.indexOf(name) === i,
  );
  if (requested) {
    if (!projects.includes(requested.name)) {
      return {
        error: `${
          requested.source === "flag"
            ? "--verify-project"
            : "the export's verifyProject (.cairn-export.json)"
        } ${JSON.stringify(requested.name)}: the Playwright config has no such project (${
          projects.filter((name) => name !== "").join(", ") ||
          "no named projects"
        })`,
      };
    }
    return {
      project: {
        name: requested.name,
        source: requested.source,
        reason:
          requested.source === "flag"
            ? "chosen with --verify-project"
            : "recorded in .cairn-export.json at export time (--verify-project or export.targets.<name>.verifyProject)",
        projects,
        discovering,
      },
    };
  }
  if (projects.length <= 1) return {};
  const candidates = discovering.filter((name) => name !== "");
  if (candidates.length === 0) return {};
  const most = Math.max(...candidates.map((n) => perProject.get(n)!.size));
  const best = candidates.filter((n) => perProject.get(n)!.size === most);
  const byBrowser = best.find((name) => browsers.get(name) === "chromium");
  const byName = best.find((name) => CHROMIUM_NAME.test(name));
  const name = byBrowser ?? byName ?? best[0]!;
  const why = byBrowser
    ? "it runs Chromium"
    : byName
      ? "its name says Chromium"
      : "it comes first in the config";
  return {
    project: {
      name,
      source: "auto",
      reason: `the config has ${projects.length} projects and ${discovering.length} discover the exported tests (${discovering.join(", ")}); ${name} was chosen because ${why} (Chromium first, then config order; --verify-project or export.targets.<name>.verifyProject picks another)`,
      projects,
      discovering,
    },
  };
}

/** The browser each project runs, read statically from the config (unknown = absent). */
async function projectBrowsers(
  target: ExportTarget,
  configPath: string | undefined,
): Promise<Map<string, string | undefined>> {
  const out = new Map<string, string | undefined>();
  if (!configPath) return out;
  try {
    const profile = await readHostProfile({ configPath, into: target.dir });
    for (const project of profile.projectOptions) {
      const browser = project.browserName;
      if (!out.has(project.name)) {
        out.set(
          project.name,
          typeof browser === "string" ? browser : undefined,
        );
      }
    }
  } catch {
    // not statically readable: the name decides
  }
  return out;
}

/**
 * The unfiltered listing and the project the verify runs under. Runs
 * `playwright test --list` once; an `error` is a requested project the
 * config does not have.
 */
export async function listContext(
  target: ExportTarget,
  requested?: RequestedProject,
): Promise<ListContext> {
  const location = playwrightLocation(target);
  if ("skip" in location) {
    return {
      skip: location.skip,
      ...(requested
        ? {
            project: {
              name: requested.name,
              source: requested.source,
              reason: "not checked: Playwright could not list the export",
              projects: [],
              discovering: [],
            },
          }
        : {}),
    };
  }
  const listed = await runList(location);
  if ("skip" in listed) {
    return {
      location,
      skip: listed.skip,
      ...(requested
        ? {
            project: {
              name: requested.name,
              source: requested.source,
              reason: "not checked: Playwright could not list the export",
              projects: [],
              discovering: [],
            },
          }
        : {}),
    };
  }
  const projectCount = listed.json.config?.projects?.length ?? 0;
  const browsers =
    projectCount > 1 && !requested
      ? await projectBrowsers(target, location.configPath)
      : new Map<string, string | undefined>();
  const chosen = chooseVerifyProject(
    listed.json,
    target.manifest.specs.map((spec) => join(target.dir, spec.testFile)),
    browsers,
    requested,
  );
  return {
    location,
    listing: listed.json,
    ...(chosen.project ? { project: chosen.project } : {}),
    ...(chosen.error ? { error: chosen.error } : {}),
  };
}

/**
 * `playwright test --list` lists every exported spec as exactly one test.
 * On a multi-project host the listing is `--project <the verify project>`
 * (dependencies, such as a setup project, are listed too and ignored unless
 * they also list an exported file: it would then run more than once).
 */
export async function listGate(
  target: ExportTarget,
  context?: ListContext,
): Promise<ExportVerifyGate> {
  const startedAt = Date.now();
  const ctx = context ?? (await listContext(target));
  if (ctx.error) {
    return gate("list", startedAt, {
      status: "failed",
      summary: ctx.error,
      findings: [ctx.error],
    });
  }
  if (!ctx.location || !ctx.listing) {
    return skipped(
      "list",
      startedAt,
      ctx.skip ?? "playwright test --list did not run",
    );
  }
  const project = ctx.project?.name;
  let json = ctx.listing;
  if (project !== undefined) {
    const filtered = await runList(ctx.location, project);
    if ("skip" in filtered) return skipped("list", startedAt, filtered.skip);
    json = filtered.json;
  }
  const listed = listedTestsFromJson(json);
  const findings: string[] = [];
  for (const error of json.errors ?? []) {
    // Paths in a load error are machine-local: name them from the export root.
    const first = (error.message ?? "").split("\n")[0] ?? "";
    findings.push(
      `load error: ${first.split(`${real(target.dir)}${sep}`).join("")}`,
    );
  }
  const perFile = new Map<string, ListedTest[]>();
  for (const test of listed) {
    const key = real(test.file);
    perFile.set(key, [...(perFile.get(key) ?? []), test]);
  }
  const listCommand = `playwright test --list${
    project !== undefined ? ` --project ${project}` : ""
  }`;
  let found = 0;
  let fixme = 0;
  for (const spec of target.manifest.specs) {
    const tests = perFile.get(real(join(target.dir, spec.testFile))) ?? [];
    if (project !== undefined) {
      const mine = tests.filter((t) => t.projectName === project);
      const others = [
        ...new Set(
          tests
            .filter((t) => t.projectName !== project)
            .map((t) => t.projectName || "(unnamed)"),
        ),
      ];
      if (mine.length === 0) {
        findings.push(`${spec.testFile}: not listed by ${listCommand}`);
      } else if (mine.length > 1) {
        findings.push(
          `${spec.testFile}: ${mine.length} tests listed in project ${project}, expected 1`,
        );
      } else if (others.length > 0) {
        findings.push(
          `${spec.testFile}: also listed by project(s) ${others.join(", ")} that ${listCommand} runs as dependencies; it would run more than once`,
        );
      } else {
        found += 1;
        if (mine[0]!.fixme) fixme += 1;
      }
      continue;
    }
    // One project (or none that can be named): one test per project.
    const byProject = new Map<string, ListedTest[]>();
    for (const test of tests) {
      const key = test.projectId ?? test.projectName ?? "";
      byProject.set(key, [...(byProject.get(key) ?? []), test]);
    }
    const crowded = [...byProject.values()].find((group) => group.length > 1);
    if (tests.length === 0) {
      findings.push(`${spec.testFile}: not listed by ${listCommand}`);
    } else if (crowded) {
      findings.push(
        `${spec.testFile}: ${crowded.length} tests listed${
          byProject.size > 1
            ? ` in project ${crowded[0]!.projectName || "(unnamed)"}`
            : ""
        }, expected 1`,
      );
    } else {
      found += 1;
      if (tests[0]!.fixme) fixme += 1;
    }
  }
  const expected = target.manifest.specs.length;
  const inProject =
    project !== undefined ? ` in project ${project} (--project)` : "";
  return gate("list", startedAt, {
    status: findings.length === 0 ? "passed" : "failed",
    summary:
      findings.length === 0
        ? `${found} of ${expected} exported specs listed as one test each${inProject}${
            fixme > 0
              ? ` (${fixme} deliberate test.fixme skip(s), not run)`
              : ""
          }`
        : `${findings.length} problem(s): ${found} of ${expected} exported specs listed correctly${inProject}`,
    findings,
  });
}
