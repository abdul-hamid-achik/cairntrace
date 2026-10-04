import { join, resolve } from "node:path";
import { resolveProjectRuntimeContext } from "../../core/config/runtimeContext";
import type { InvocationJournal } from "../../core/artifacts/invocationJournal";
import { HOOK_OUTPUT_TAIL_CHARS } from "../../core/schema/events.v1";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import { runBoundedCommand } from "../../core/runner/boundedCommand";
import {
  runShellCommandSync,
  signalTimeout,
  type SignalBudget,
} from "../../core/runPolicy/finally";
import {
  checkSuiteRequiredVars,
  type ResolvedSuite,
  selectSuite,
  SuiteError,
  suiteLabelsOf,
  suiteProcessEnvOf,
  SuiteResolver,
} from "../../core/suites/resolve";
import type { Suite } from "../../core/suites/schema";
import { suiteVarCollisions } from "../../core/suites/schema";
import { configErrorExitCode } from "./lifecycle";
import { parseVarFlags } from "./options";

/**
 * The run engine's side of config `suites:` (F9): turn `--suite <name>` into
 * the spec list and option defaults of an ordinary invocation, and run the
 * suite's once-per-invocation before/after hooks with journal events.
 */

export interface AppliedSuite {
  resolved: ResolvedSuite;
  /** The invocation's options with the suite's vars, parallel and bail applied. */
  options: RunInvocationOptions;
  /** Directory of the config the suite came from (hooks run there). */
  configDir: string;
  /** Non-fatal resolution warnings (an undefined default environment). */
  warnings: string[];
  /** How the suite was found, for {@link refreshSuiteVars}. */
  source: {
    cwd: string;
    config?: string;
    env?: string;
    /** The caller's own `--var` entries (they win over the suite's). */
    userVars: string[];
    /** The caller's own `--label` entries (they win over the suite's). */
    userLabels: string[];
  };
}

type ProjectLoad = Parameters<typeof resolveProjectRuntimeContext>[0];

/** The suite's vars for one environment, as strings. */
function suiteVarsOf(suite: Suite, envName: string): Record<string, string> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries({
    ...suite.vars,
    ...suite.env?.[envName]?.vars,
  })) {
    vars[key] = String(value);
  }
  return vars;
}

/** Suite entries whose `${env.X}` is unset, per kind. */
interface UnsetSuiteEntries {
  vars: Set<string>;
  processEnv: Set<string>;
  labels: Set<string>;
}

const UNSET_ENV_REF = /\$\{env\.[A-Za-z_]\w*\}/;

/**
 * Suite vars (and `processEnv` / `labels` entries) whose `${env.X}` has
 * no value in `load.env` (and no `:-default`): read from a late-bound
 * load, where such a reference stays as written. Such an entry is never
 * emitted — as an empty `--var` it would blank the config var of the same
 * name, as an empty env var it would hide the caller's own. Best-effort: a
 * config that does not load late-bound reports nothing here.
 */
async function unsetEnvSuiteEntries(
  load: ProjectLoad,
  name: string,
  envName: string,
): Promise<UnsetSuiteEntries> {
  const late = await resolveProjectRuntimeContext({
    ...load,
    envRef: (envVar) => `\${env.${envVar}}`,
  }).catch(() => undefined);
  const suite = late?.config?.suites?.[name];
  const out: UnsetSuiteEntries = {
    vars: new Set(),
    processEnv: new Set(),
    labels: new Set(),
  };
  if (!suite) return out;
  const collect = (
    into: Set<string>,
    record: Readonly<Record<string, string>>,
  ): void => {
    for (const [key, value] of Object.entries(record)) {
      if (UNSET_ENV_REF.test(value)) into.add(key);
    }
  };
  collect(out.vars, suiteVarsOf(suite, envName));
  collect(out.processEnv, suiteProcessEnvOf(suite, envName));
  collect(out.labels, suiteLabelsOf(suite, envName));
  return out;
}

/**
 * The vars hooks see as `CAIRN_SUITE_VAR_<NAME>`: the suite's, with the
 * caller's own `--var` winning for every name the suite defines (the same
 * precedence the specs get), a suite var left unset by its `${env.X}`
 * included.
 */
function hookVarsOf(
  suiteVars: Readonly<Record<string, string>>,
  definedKeys: Iterable<string>,
  userVars: readonly string[],
): Record<string, string> {
  const user = parseVarFlags([...userVars]);
  const out = { ...suiteVars };
  for (const key of definedKeys) {
    if (Object.hasOwn(user, key)) out[key] = user[key]!;
  }
  return out;
}

/**
 * The `--label` list of a suite run: the suite's `labels` (an unset
 * `${env.X}` one dropped), then `suite=<name>`, then the caller's own
 * (later entries win).
 */
function suiteLabelFlags(
  name: string,
  labels: Readonly<Record<string, string>>,
  userLabels: readonly string[],
): string[] {
  return [
    ...Object.entries(labels).map(([key, value]) => `${key}=${value}`),
    `suite=${name}`,
    ...userLabels,
  ];
}

/** `--var` entries: the suite's first, so the caller's own win. */
function suiteVarFlags(
  vars: Readonly<Record<string, string>>,
  userVars: readonly string[],
): string[] {
  return [
    ...Object.entries(vars).map(([key, value]) => `${key}=${value}`),
    ...userVars,
  ];
}

/** Drop `keys` from `vars`. */
function without(
  vars: Readonly<Record<string, string>>,
  keys: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(vars).filter(([key]) => !keys.has(key)),
  );
}

/**
 * The suite's specs narrowed to `given` (paths relative to `cwd` or to the
 * config directory, or absolute), in the suite's order, and the given paths
 * that are none of its specs.
 */
export function narrowSuiteSpecs(
  suiteSpecs: readonly string[],
  given: readonly string[],
  cwd: string,
  configDir: string,
): { specs: string[]; unknown: string[] } {
  const members = new Set(suiteSpecs.map((spec) => resolve(spec)));
  const wanted = new Set<string>();
  const unknown: string[] = [];
  for (const path of given) {
    const match = [resolve(cwd, path), resolve(configDir, path)].find(
      (candidate) => members.has(candidate),
    );
    if (match) wanted.add(match);
    else unknown.push(path);
  }
  return {
    specs: suiteSpecs.filter((spec) => wanted.has(resolve(spec))),
    unknown,
  };
}

/**
 * Resolve `options.suite` against the config discovered from `cwd` (or
 * `options.config`). Throws {@link SuiteError} (exit 2 usage, 4 config, 7
 * refused by `requires`). CLI flags win over the suite: `--parallel`, and
 * `--var` over the suite's vars; `--bail` adds to the suite's `bail`. Runs get
 * the label `suite=<name>`. Spec paths next to `--suite` narrow it to those
 * of its specs (its hooks, vars and labels still apply); a path that is not
 * one of them is a usage error (exit 2).
 */
export async function applySuite(request: {
  specs: readonly string[];
  options: RunInvocationOptions;
  cwd: string;
  callerEnv: Record<string, string | undefined>;
}): Promise<AppliedSuite> {
  const { options, cwd } = request;
  const name = options.suite;
  if (name === undefined) throw new SuiteError("no suite requested", 2);
  let ctx: Awaited<ReturnType<typeof resolveProjectRuntimeContext>>;
  const load: ProjectLoad = {
    cwd,
    env: request.callerEnv,
    vars: parseVarFlags(options.var),
    ...(options.config !== undefined ? { configPath: options.config } : {}),
    ...(options.env !== undefined ? { envOverride: options.env } : {}),
  };
  try {
    ctx = await resolveProjectRuntimeContext(load);
  } catch (error) {
    throw new SuiteError((error as Error).message, configErrorExitCode(error));
  }
  const { config, configPath } = ctx;
  if (!config || !configPath) {
    throw new SuiteError(
      `--suite ${name} needs a cairntrace.config.yml that defines suites: (none found from ${cwd}; pass --config <path>)`,
      4,
    );
  }
  const suite = selectSuite(config.suites, name, configPath);
  // The artifact root may sit inside the project: its run directories hold
  // resolved spec copies the scan must not mistake for specs.
  const artifactRoot = options.artifactRoot ?? config.artifactRoot;
  const resolver = new SuiteResolver({
    configDir: ctx.configDir,
    skipDirs: artifactRoot ? [resolve(ctx.configDir, artifactRoot)] : [],
  });
  // `requires.vars` waits for the vault (refreshSuiteVars): a var the
  // vault provides is not set yet.
  let found = await resolver.resolve({
    name,
    suite,
    envName: ctx.envName,
    vars: ctx.vars,
    checkRequiredVars: false,
  });
  if (request.specs.length > 0) {
    const narrowed = narrowSuiteSpecs(
      found.specs,
      request.specs,
      cwd,
      ctx.configDir,
    );
    if (narrowed.unknown.length > 0) {
      throw new SuiteError(
        `--suite ${name} narrows to the suite's own specs, and ${narrowed.unknown
          .slice(0, 3)
          .join(", ")}${narrowed.unknown.length > 3 ? ", …" : ""} ${
          narrowed.unknown.length === 1 ? "is" : "are"
        } not among them: run the paths without --suite, or add them to the suite`,
        2,
      );
    }
    found = { ...found, specs: narrowed.specs };
  }
  const unset = await unsetEnvSuiteEntries(load, name, ctx.envName);
  const userVars = options.var ?? [];
  const userLabels = options.label ?? [];
  const suiteVarsSet = without(found.vars, unset.vars);
  const resolved: ResolvedSuite = {
    ...found,
    vars: hookVarsOf(suiteVarsSet, Object.keys(found.vars), userVars),
    processEnv: without(found.processEnv, unset.processEnv),
    labels: without(found.labels, unset.labels),
  };
  const suiteVars = suiteVarFlags(suiteVarsSet, userVars);
  const next: RunInvocationOptions = {
    ...options,
    ...(suiteVars.length > userVars.length ? { var: suiteVars } : {}),
    ...(options.parallel === undefined && resolved.parallel !== undefined
      ? { parallel: resolved.parallel }
      : {}),
    // `--bail` / `--no-bail` (MCP `bail: true|false`) win; unset, the
    // suite's (or its environment's) `bail` applies.
    ...(options.bail === undefined && resolved.bail !== undefined
      ? { bail: resolved.bail }
      : {}),
    // Every run is labelled with its suite (`cairn stats --group-by suite`)
    // and the suite's `labels`; a --label of the caller comes later and wins.
    label: suiteLabelFlags(name, resolved.labels, userLabels),
  };
  return {
    resolved,
    options: next,
    configDir: ctx.configDir,
    warnings: [
      ...ctx.warnings,
      ...collisionWarnings(name, Object.keys(found.vars)),
    ],
    source: {
      cwd,
      ...(options.config !== undefined ? { config: options.config } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
      userVars: [...userVars],
      userLabels: [...userLabels],
    },
  };
}

function collisionWarnings(name: string, keys: readonly string[]): string[] {
  return suiteVarCollisions(keys).map(
    (collision) =>
      `suite ${name}: vars ${collision.keys.join(" and ")} both reach hooks as ${collision.envName}; hooks see only one of them`,
  );
}

/**
 * Re-resolve the suite's vars, `processEnv` and `labels` against the
 * invocation's scoped environment — the vault's secrets included — once they
 * are known, and check `requires.vars` then. A suite entry whose `${env.X}`
 * is still unset is not emitted. Returns the `--var` and `--label` lists to
 * run with (the caller's own entries still last) and the process env to
 * export, and updates `applied.resolved` (`vars` → `CAIRN_SUITE_VAR_*`, with
 * the caller's `--var` winning by name). Throws a {@link SuiteError} (exit 4
 * / 7).
 */
export async function refreshSuiteVars(
  applied: AppliedSuite,
  env: Record<string, string | undefined>,
  /** `checkRequiredVars: false`: a dry run never read the vault, so `requires.vars` cannot be judged. */
  options: { checkRequiredVars?: boolean } = {},
): Promise<{
  var: string[];
  label: string[];
  processEnv: Record<string, string>;
  dropped: string[];
  droppedProcessEnv: string[];
}> {
  const { source } = applied;
  const name = applied.resolved.name;
  const load: ProjectLoad = {
    cwd: source.cwd,
    env,
    vars: parseVarFlags(source.userVars),
    ...(source.config !== undefined ? { configPath: source.config } : {}),
    ...(source.env !== undefined ? { envOverride: source.env } : {}),
  };
  let ctx: Awaited<ReturnType<typeof resolveProjectRuntimeContext>>;
  try {
    ctx = await resolveProjectRuntimeContext(load);
  } catch (error) {
    throw new SuiteError((error as Error).message, configErrorExitCode(error));
  }
  if (!ctx.config || !ctx.configPath) {
    throw new SuiteError(`--suite ${name}: the config is gone`, 4);
  }
  const suite = selectSuite(ctx.config.suites, name, ctx.configPath);
  const all = suiteVarsOf(suite, ctx.envName);
  const unset = await unsetEnvSuiteEntries(load, name, ctx.envName);
  const vars = without(all, unset.vars);
  const hookVars = hookVarsOf(vars, Object.keys(all), source.userVars);
  if (options.checkRequiredVars !== false) {
    checkSuiteRequiredVars({
      name,
      suite,
      envName: ctx.envName,
      suiteVars: hookVars,
      vars: ctx.vars,
    });
  }
  const processEnv = without(
    suiteProcessEnvOf(suite, ctx.envName),
    unset.processEnv,
  );
  const labels = without(suiteLabelsOf(suite, ctx.envName), unset.labels);
  applied.resolved.vars = hookVars;
  applied.resolved.processEnv = processEnv;
  applied.resolved.labels = labels;
  return {
    var: suiteVarFlags(vars, source.userVars),
    label: suiteLabelFlags(name, labels, source.userLabels),
    processEnv,
    dropped: [...unset.vars].toSorted(),
    droppedProcessEnv: [...unset.processEnv].toSorted(),
  };
}

export interface SuiteHookRun {
  suite: string;
  phase: "before" | "after";
  commands: readonly string[];
  timeoutMs: number;
  cwd: string;
  env: NodeJS.ProcessEnv;
  journal: InvocationJournal | undefined;
  redact: (text: string) => string;
  /** Cancels the running hook (not given to `after` hooks: cleanup must run). */
  signal?: AbortSignal;
  /** Stop at the first failure (`before`) or run them all (`after`). */
  fatal: boolean;
  note: (kind: "info" | "warn", message: string) => void;
  /** Called after each command finished (1-based index). */
  onDone?: (index: number) => void;
}

export interface SuiteHooksOutcome {
  failed: number;
  /** The first failure, redacted. */
  firstFailure?: string;
  cancelled?: boolean;
}

const logIndex = (index: number): string => String(index).padStart(2, "0");

/** Run one phase of suite hooks, journaling `suite.hook.started|finished`. */
export async function runSuiteHooks(
  run: SuiteHookRun,
): Promise<SuiteHooksOutcome> {
  const commands = run.commands.map((c) => c.trim()).filter(Boolean);
  const outcome: SuiteHooksOutcome = { failed: 0 };
  const { journal } = run;
  for (const [i, command] of commands.entries()) {
    const index = i + 1;
    if (run.signal?.aborted) {
      run.note(
        "info",
        `suite ${run.phase} hooks skipped: invocation cancelled (${commands.length - i} not run)`,
      );
      return { ...outcome, cancelled: true };
    }
    const shown = run.redact(command);
    run.note("info", `suite ${run.suite} ${run.phase} #${index}: ${shown}`);
    const startedAt = Date.now();
    const file = `hook-suite-${run.phase}-${logIndex(index)}.log`;
    const live = journal?.openLog(file, "hook", `suite ${run.phase}#${index}`);
    live?.writeLine(`--- ${new Date(startedAt).toISOString()} ---`);
    live?.writeLine(`$ ${command}`);
    journal?.appendEvent({
      ts: new Date(startedAt).toISOString(),
      type: "suite.hook.started",
      name: run.suite,
      hook: run.phase,
      index,
      total: commands.length,
      command: shown,
      timeoutMs: run.timeoutMs,
      logPath: `logs/${file}`,
    });
    let exitCode: number | undefined;
    let timedOut = false;
    let cancelled = false;
    let output = "";
    let ok = false;
    try {
      const result = await runBoundedCommand("/bin/sh", ["-c", command], {
        cwd: run.cwd,
        env: run.env,
        timeoutMs: run.timeoutMs,
        ...(run.signal ? { signal: run.signal } : {}),
        ownProcessGroup: true,
        killLeftovers: false,
        onOutput: (chunk) => live?.write(chunk),
      });
      exitCode = result.exitCode;
      timedOut = result.timedOut;
      cancelled = result.cancelled;
      output = result.spawnError
        ? `could not start: ${result.spawnError}`
        : result.all;
      ok =
        result.exitCode === 0 && !timedOut && !cancelled && !result.spawnError;
    } catch (error) {
      output = (error as Error).message;
    }
    const durationMs = Date.now() - startedAt;
    live?.writeLine(
      `[${
        cancelled
          ? "cancelled"
          : timedOut
            ? "timed out"
            : `exit ${exitCode ?? "unknown"}`
      } after ${durationMs}ms]`,
    );
    live?.flush();
    const redacted = run.redact(output).trimEnd();
    const outputTail =
      redacted.length > HOOK_OUTPUT_TAIL_CHARS
        ? redacted.slice(redacted.length - HOOK_OUTPUT_TAIL_CHARS)
        : redacted;
    journal?.appendEvent({
      ts: new Date().toISOString(),
      type: "suite.hook.finished",
      name: run.suite,
      hook: run.phase,
      index,
      ok,
      ...(exitCode !== undefined ? { exitCode } : {}),
      durationMs,
      ...(timedOut ? { timedOut: true } : {}),
      ...(outputTail ? { outputTail } : {}),
    });
    if (cancelled) return { ...outcome, cancelled: true };
    run.onDone?.(index);
    if (!ok) {
      outcome.failed += 1;
      const why = timedOut
        ? `timed out after ${run.timeoutMs}ms and its process group was killed`
        : `failed (exit ${exitCode ?? "unknown"})`;
      const message = `suite ${run.suite} ${run.phase} hook #${index} ${why}: ${shown}${
        outputTail ? `\n${outputTail.slice(-500)}` : ""
      }`;
      outcome.firstFailure ??= message;
      if (run.fatal) return outcome;
      run.note("warn", message);
    }
  }
  return outcome;
}

/**
 * The signal path: run the suite's `after` hooks from command `from`
 * (1-based; the ones the async path finished are skipped, one it was
 * running runs again) synchronously within the signal budget. Services are
 * still up (the services teardown runs after this). Events as usual; output
 * in `logs/hook-suite-after-signal-NN.log`.
 */
export function runSuiteAfterHooksSync(
  run: Omit<SuiteHookRun, "signal" | "fatal" | "onDone" | "phase"> & {
    from: number;
    budget: SignalBudget;
  },
): number {
  const commands = run.commands.map((c) => c.trim()).filter(Boolean);
  let failed = 0;
  const journalDir = run.journal?.dir;
  for (let i = Math.max(1, run.from); i <= commands.length; i += 1) {
    const command = commands[i - 1]!;
    const shown = run.redact(command);
    const timeoutMs = signalTimeout(run.budget, run.timeoutMs);
    if (timeoutMs <= 0) {
      run.note(
        "warn",
        `suite ${run.suite} after hooks: ${commands.length - i + 1} not run, the signal-path budget is spent (CAIRN_SIGNAL_HOOK_TIMEOUT_MS)`,
      );
      return failed + commands.length - i + 1;
    }
    run.note(
      "info",
      `suite ${run.suite} after #${i} (up to ${timeoutMs}ms): ${shown}`,
    );
    const file = `hook-suite-after-signal-${logIndex(i)}.log`;
    const startedAt = Date.now();
    run.journal?.appendEvent({
      ts: new Date(startedAt).toISOString(),
      type: "suite.hook.started",
      name: run.suite,
      hook: "after",
      index: i,
      total: commands.length,
      command: shown,
      timeoutMs,
      logPath: `logs/${file}`,
    });
    const result = runShellCommandSync(command, {
      cwd: run.cwd,
      env: run.env,
      timeoutMs,
      ...(journalDir ? { outputFile: join(journalDir, "logs", file) } : {}),
    });
    const ok = result.exitCode === 0 && !result.timedOut && !result.spawnError;
    const tail = result.outputTail ? run.redact(result.outputTail) : undefined;
    run.journal?.appendEvent({
      ts: new Date().toISOString(),
      type: "suite.hook.finished",
      name: run.suite,
      hook: "after",
      index: i,
      ok,
      ...(result.exitCode !== undefined ? { exitCode: result.exitCode } : {}),
      durationMs: result.durationMs,
      ...(result.timedOut ? { timedOut: true } : {}),
      ...(tail ? { outputTail: tail.slice(-HOOK_OUTPUT_TAIL_CHARS) } : {}),
    });
    if (!ok) {
      failed += 1;
      run.note(
        "warn",
        `suite ${run.suite} after hook #${i} ${
          result.timedOut
            ? "timed out"
            : `failed (${result.spawnError ?? `exit ${result.exitCode ?? "?"}`})`
        }: ${shown}`,
      );
    }
  }
  return failed;
}
