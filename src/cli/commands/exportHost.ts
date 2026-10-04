/**
 * `cairn export playwright` — export targets, host profiles and the eval-ratio
 * gate (E8 / E12), kept apart from the writer in `export.ts`.
 */
import { statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { findConfigFile, loadConfig } from "../../core/config/loader";
import {
  evalStepRatio,
  exceedsEvalRatio,
  evalRatioRefusal,
  pageEvalSites,
  parseMaxEvalRatio,
  type EvalRatio,
} from "../../core/exporters/evalRatio";
import { realpathNearest } from "../../core/exporters/exportManifest";
import {
  HostProfileError,
  readHostProfile,
  resolveHostEmit,
  type HostEmit,
  type HostProfile,
} from "../../core/exporters/hostProfile";
import type { ParseResult } from "../../core/parser/parseSpec";
import type { ExportPlaywrightOptions } from "./export";

/* ----- eval-ratio refusals ----- */

/** A spec the export refused (E12), reported next to the specs it did write. */
export interface ExportRefusal {
  /** Absolute source spec path. */
  source: string;
  name: string;
  evalSteps: number;
  totalSteps: number;
  ratio: number;
  limit: number;
  message: string;
}

/** Every spec of the export was refused: nothing is written. Exit 1. */
export class ExportRefusedError extends Error {
  constructor(readonly refusals: ExportRefusal[]) {
    super(refusals.map((refusal) => refusal.message).join("; "));
  }
}

/** The refusal for one parsed spec, or undefined when it is within `limit`. */
export function evalRatioRefusalOf(
  parsed: ParseResult,
  limit: number | undefined,
): ExportRefusal | undefined {
  if (limit === undefined) return undefined;
  const ratio: EvalRatio = evalStepRatio(parsed.resolved);
  if (!exceedsEvalRatio(ratio, limit)) return undefined;
  return {
    source: parsed.path,
    name: parsed.spec.name,
    evalSteps: ratio.evalSteps,
    totalSteps: ratio.totalSteps,
    ratio: ratio.ratio,
    limit,
    message: evalRatioRefusal(parsed.spec.name, ratio, limit),
  };
}

export function limitOf(opts: Pick<ExportPlaywrightOptions, "maxEvalRatio">) {
  return parseMaxEvalRatio(opts.maxEvalRatio);
}

/* ----- export targets (profiles) ----- */

export interface AppliedTarget {
  name: string;
  /** Absolute path of the config that defines the profile. */
  configPath: string;
  mapFile?: string;
}

const abs = (path: string, base: string): string =>
  isAbsolute(path) ? path : resolve(base, path);

/**
 * Merge `export.targets.<name>` under the command line: a flag the user gave
 * wins over the profile field. Paths in a profile are relative to the config
 * file's directory. The config comes from `--config`, else the nearest
 * `cairntrace.config.yml` above the input path (or the working directory
 * when none is given).
 */
export async function applyExportTarget<O extends ExportPlaywrightOptions>(
  opts: O,
  inputPath: string | undefined,
  cwd: string = process.cwd(),
): Promise<{ opts: O; inputPath: string | undefined; target?: AppliedTarget }> {
  if (opts.target === undefined) return { opts, inputPath };
  const name = opts.target;
  let startDir = cwd;
  if (inputPath !== undefined) {
    const abspath = abs(inputPath, cwd);
    try {
      startDir = statSync(abspath).isDirectory() ? abspath : dirname(abspath);
    } catch {
      startDir = dirname(abspath);
    }
  }
  const configPath = opts.config
    ? abs(opts.config, cwd)
    : await findConfigFile(startDir);
  if (!configPath) {
    throw new Error(
      `--target ${name}: no cairntrace.config.yml found above ${startDir}; pass --config <path>`,
    );
  }
  const loaded = await loadConfig(join(startDir, "_"), configPath, {
    skipRequires: true,
  });
  const targets = loaded?.config.export?.targets ?? {};
  const profile = targets[name];
  if (!profile) {
    const known = Object.keys(targets).toSorted();
    throw new Error(
      `--target ${name}: unknown export target (${
        known.length > 0
          ? `defined in ${configPath}: ${known.join(", ")}`
          : `${configPath} defines no export.targets`
      })`,
    );
  }
  const configDir = dirname(configPath);
  const merged = { ...opts } as O;
  const set = <K extends keyof ExportPlaywrightOptions>(
    key: K,
    value: ExportPlaywrightOptions[K] | undefined,
  ): void => {
    if (merged[key] === undefined && value !== undefined) {
      (merged as ExportPlaywrightOptions)[key] = value;
    }
  };
  fromProfile(profile, configDir, set);
  if (merged.config === undefined) merged.config = configPath;
  const input =
    inputPath ??
    (profile.input !== undefined ? abs(profile.input, configDir) : undefined);
  return {
    opts: merged,
    inputPath: input,
    target: {
      name,
      configPath,
      ...(merged.mapFile !== undefined ? { mapFile: merged.mapFile } : {}),
    },
  };
}

function fromProfile(
  profile: import("../../core/schema/config.v1").ExportTarget,
  configDir: string,
  set: <K extends keyof ExportPlaywrightOptions>(
    key: K,
    value: ExportPlaywrightOptions[K] | undefined,
  ) => void,
): void {
  set("into", profile.into && abs(profile.into, configDir));
  set("hostConfig", profile.hostConfig && abs(profile.hostConfig, configDir));
  set("mapFile", profile.mapFile && abs(profile.mapFile, configDir));
  set("preconditions", profile.preconditions);
  set("verifiers", profile.verifiers);
  set("gateEnv", profile.gateEnv ? [...profile.gateEnv] : undefined);
  set("lang", profile.lang);
  set("env", profile.env);
  set("maxEvalRatio", profile.maxEvalRatio);
  set("allowEvalWithoutBypass", profile.allowEvalWithoutBypass);
  set("strictLocators", profile.strictLocators);
  set("verifyProject", profile.verifyProject);
}

/* ----- host profiles ----- */

export interface PreparedHost {
  profile: HostProfile;
  emit: HostEmit;
}

/** `--host-config` adapts an `--into` tree and nothing else. */
export function assertHostFlags(
  opts: Pick<
    ExportPlaywrightOptions,
    "hostConfig" | "into" | "project" | "stdout" | "outDir"
  >,
): void {
  if (opts.hostConfig === undefined) return;
  if (!opts.into) {
    throw new Error(
      "--host-config adapts the generated code to an existing Playwright tree: use it with --into <dir> (--project writes its own config, standalone files have no tree)",
    );
  }
}

/** `--map` binds actions inside a structured export (`--project` / `--into`) and nowhere else. */
export function assertMapFlags(
  opts: Pick<ExportPlaywrightOptions, "mapFile" | "into" | "project">,
): void {
  if (opts.mapFile === undefined) return;
  if (!opts.into && !opts.project) {
    throw new Error(
      "--map binds actions to the host's fixtures and page objects in a structured export: use it with --into <dir> or --project --out-dir <dir> (standalone spec files have no actions/ to bind)",
    );
  }
}

/**
 * Read the host's Playwright config (statically) and decide how the tree is
 * adapted. Errors name the problem; none of them executes host code.
 */
export async function prepareHost(
  opts: Pick<ExportPlaywrightOptions, "hostConfig" | "into">,
  lang: "ts" | "js",
  outDir: string,
): Promise<PreparedHost | undefined> {
  if (opts.hostConfig === undefined) return undefined;
  try {
    const profile = await readHostProfile({
      configPath: opts.hostConfig,
      into: outDir,
    });
    const emit = resolveHostEmit(profile, { into: outDir, lang });
    return { profile, emit };
  } catch (e) {
    if (e instanceof HostProfileError) {
      throw new Error(`--host-config ${opts.hostConfig}: ${e.message}`, {
        cause: e,
      });
    }
    throw e;
  }
}

/**
 * Page evals (`eval` steps, browser `script` outcomes) need the host to set
 * `bypassCSP: true`; a strict CSP blocks them otherwise and the exported tests
 * would fail at run time. Refused up front unless the user opts in.
 */
export function assertBypassCsp(
  specs: readonly ParseResult[],
  host: PreparedHost,
  allow: boolean | undefined,
): void {
  if (host.emit.bypassCsp || allow) return;
  const sites = specs.flatMap((parsed) =>
    pageEvalSites(parsed.resolved).map(
      (site) => `${parsed.spec.name}: ${site}`,
    ),
  );
  if (sites.length === 0) return;
  const shown = sites.slice(0, 5).join("; ");
  throw new Error(
    `the export contains ${sites.length} page eval(s) (${shown}${
      sites.length > 5 ? "; …" : ""
    }) but the host Playwright config does not set \`use.bypassCSP: true\`${
      host.emit.bypassCspDynamic
        ? " (it is set by an expression that cannot be read statically)"
        : ""
    }; an app with a strict CSP blocks string evaluation, so those tests would fail. Set bypassCSP: true on the host project that runs them, or pass --allow-eval-without-bypass (profile: allowEvalWithoutBypass) to export anyway`,
  );
}

/** The host decisions as the report carries them (no absolute paths). */
export interface ExportHostReport {
  /** The host Playwright config, relative to the export directory. */
  config: string;
  moduleSystem: "cjs" | "esm";
  moduleReason: string;
  /** Absent: not statically readable (or the projects disagree); each test sets its own budget. */
  testTimeoutMs?: number;
  /** Absent: not statically readable (or the projects disagree); testid locators are explicit attribute selectors. */
  testIdAttribute?: string;
  /** Host projects that discover the generated tests ("" = the config without projects). */
  projects?: string[];
  /** Host options that exist but could not be read statically. */
  unread: string[];
  /** Where the generated tests live, relative to the export directory ("." = in it). */
  testsDir: string;
  testSuffix: string;
  bypassCsp: boolean;
  alias?: string;
  /** Files the host's prettier rewrote / left as generated. */
  formatted: number;
  formatSkipped: Array<{ file: string; reason: string }>;
  baseUrl?: { literal?: string; env: string[] };
  notes: string[];
}

export function hostReport(
  prepared: PreparedHost,
  outDir: string,
  format: {
    formatted: number;
    skipped: Array<{ relPath: string; reason: string }>;
  },
): ExportHostReport {
  const rel = (path: string): string =>
    relative(realpathNearest(outDir), realpathNearest(path))
      .split(sep)
      .join("/") || ".";
  const { profile, emit } = prepared;
  return {
    config: rel(profile.configPath),
    moduleSystem: emit.moduleSystem,
    moduleReason: profile.moduleReason,
    // 0: the host disables the test timeout.
    ...(emit.testTimeoutMs !== undefined
      ? {
          testTimeoutMs:
            emit.testTimeoutMs === Number.MAX_SAFE_INTEGER
              ? 0
              : emit.testTimeoutMs,
        }
      : {}),
    ...(emit.testIdAttribute !== undefined
      ? { testIdAttribute: emit.testIdAttribute }
      : {}),
    ...(emit.projects ? { projects: emit.projects } : {}),
    unread: [...profile.dynamic],
    testsDir: emit.testsDir === "" ? "." : emit.testsDir,
    testSuffix: emit.testSuffix,
    bypassCsp: emit.bypassCsp,
    ...(emit.alias ? { alias: emit.alias.prefix } : {}),
    formatted: format.formatted,
    formatSkipped: format.skipped.map((entry) => ({
      file: entry.relPath,
      reason: entry.reason,
    })),
    ...(profile.baseURL ? { baseUrl: profile.baseURL } : {}),
    notes: emit.notes,
  };
}
