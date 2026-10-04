import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { isSensitiveEnvKey } from "../artifacts/redaction";
import {
  checkGateOnce,
  GateReferenceError,
  type GateContext,
} from "../gates/evaluate";
import { durationMs, type GateNode } from "../gates/schema";
import { runBoundedCommand } from "../runner/boundedCommand";
import {
  evaluateExpression,
  expressionPaths,
  formatPath,
  parseExpression,
  readExpressionPath,
} from "./expression";
import type { RunPreflightCheck } from "./schema";

/**
 * `run.preflight`: checks evaluated after config + secrets resolve and
 * before any service, hook or browser starts. The first failing check stops
 * the run (exit 4) and names itself; later checks do not run, so a missing
 * secret never costs a billable boot.
 */

export type PreflightKind = "json" | "secret" | "command" | "gate";

export interface PreflightContext {
  /** Relative `json` paths and the `command` working directory resolve here. */
  configDir: string;
  /** The scoped environment (secrets included): `secret` and `command` read it. */
  env: Record<string, string | undefined>;
  /** The config's `gates:` registry. */
  gates?: Readonly<Record<string, GateNode>>;
  /** Redacts free text (the invocation redactor). */
  redact: (text: string) => string;
  signal?: AbortSignal;
}

export interface PreflightCheckResult {
  /** 1-based position in `run.preflight`. */
  index: number;
  kind: PreflightKind;
  name?: string;
  ok: boolean;
  durationMs: number;
  /** The redacted reason a failed check failed (never a secret value). */
  reason?: string;
}

const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;
const OUTPUT_TAIL_CHARS = 400;

export function preflightKind(check: RunPreflightCheck): PreflightKind {
  if (check.json !== undefined) return "json";
  if (check.secret !== undefined) return "secret";
  if (check.command !== undefined) return "command";
  return "gate";
}

/** `json app.json`, `secret MONGO_URI`, … : what a message calls the check. */
export function describePreflightCheck(check: RunPreflightCheck): string {
  if (check.name) return `"${check.name}"`;
  switch (preflightKind(check)) {
    case "json":
      return `json ${check.json} assert ${JSON.stringify(check.assert)}`;
    case "secret":
      return `secret ${check.secret}`;
    case "command":
      return `command ${truncate(check.command!, 80)}`;
    case "gate":
      return `gate ${check.gate}`;
  }
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** A value for a failure message: credential-like keys and long text are masked. */
function showValue(
  path: ReadonlyArray<string | number>,
  value: unknown,
): string {
  const last = path.toReversed().find((s) => typeof s === "string") as
    | string
    | undefined;
  if (last !== undefined && isSensitiveEnvKey(last)) return "[redacted]";
  if (typeof value === "string") {
    return value.length > 80
      ? `string(${value.length} chars)`
      : JSON.stringify(value);
  }
  const json = JSON.stringify(value);
  return json === undefined || json.length > 120 ? typeof value : json;
}

async function checkJson(
  check: RunPreflightCheck,
  ctx: PreflightContext,
): Promise<string | undefined> {
  const file = isAbsolute(check.json!)
    ? check.json!
    : resolve(ctx.configDir, check.json!);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    return `cannot read ${check.json}: ${(error as NodeJS.ErrnoException).code ?? (error as Error).message}`;
  }
  let document: unknown;
  try {
    document = JSON.parse(text);
  } catch (error) {
    return `${check.json} is not valid JSON: ${(error as Error).message}`;
  }
  const expression = parseExpression(check.assert!);
  if (evaluateExpression(expression, document)) return undefined;
  const seen = new Set<string>();
  const observed: string[] = [];
  for (const path of expressionPaths(expression)) {
    const label = formatPath(path);
    if (seen.has(label)) continue;
    seen.add(label);
    const read = readExpressionPath(document, path);
    observed.push(
      `${label} = ${read.found ? showValue(path, read.value) : "(missing)"}`,
    );
  }
  return (
    `assert ${JSON.stringify(check.assert)} is false for ${check.json}` +
    (observed.length > 0 ? ` (${observed.join("; ")})` : "")
  );
}

function checkSecret(
  check: RunPreflightCheck,
  ctx: PreflightContext,
): string | undefined {
  const value = ctx.env[check.secret!];
  if (value === undefined || value === "") {
    return `secret ${check.secret} is not set (or empty) in the run's environment`;
  }
  return undefined;
}

async function checkCommand(
  check: RunPreflightCheck,
  ctx: PreflightContext,
): Promise<string | undefined> {
  const expect = check.expectExit ?? 0;
  const timeoutMs = durationMs(check.timeout) ?? DEFAULT_COMMAND_TIMEOUT_MS;
  const result = await runBoundedCommand("/bin/sh", ["-c", check.command!], {
    cwd: ctx.configDir,
    env: ctx.env as NodeJS.ProcessEnv,
    timeoutMs: Math.max(1, timeoutMs),
    ownProcessGroup: true,
    killLeftovers: true,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (result.spawnError)
    return `could not start the command: ${result.spawnError}`;
  if (result.cancelled) return "cancelled";
  if (result.timedOut) return `timed out after ${timeoutMs}ms`;
  if (result.exitCode === expect) return undefined;
  const tail = ctx.redact(result.all.trim()).slice(-OUTPUT_TAIL_CHARS).trim();
  const got =
    result.exitCode === undefined
      ? `ended by ${result.exitSignal ?? "a signal"}`
      : `exited ${result.exitCode}`;
  return `expected exit ${expect}, ${got}${tail ? `: ${tail}` : ""}`;
}

async function checkGate(
  check: RunPreflightCheck,
  ctx: PreflightContext,
): Promise<string | undefined> {
  const gateCtx: GateContext = {
    registry: ctx.gates ?? {},
    env: ctx.env,
    cwd: ctx.configDir,
    registryCwd: ctx.configDir,
    scope: "preflight",
    redact: ctx.redact,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
  try {
    const outcome = await checkGateOnce(check.gate!, gateCtx);
    return outcome.ok
      ? undefined
      : `gate "${outcome.name}" is not ready: ${outcome.detail}`;
  } catch (error) {
    if (error instanceof GateReferenceError) return error.message;
    throw error;
  }
}

/** Run one check. Never throws: a crash is a failed check. */
export async function runPreflightCheck(
  check: RunPreflightCheck,
  index: number,
  ctx: PreflightContext,
): Promise<PreflightCheckResult> {
  const kind = preflightKind(check);
  const startedAt = Date.now();
  let reason: string | undefined;
  try {
    reason =
      kind === "json"
        ? await checkJson(check, ctx)
        : kind === "secret"
          ? checkSecret(check, ctx)
          : kind === "command"
            ? await checkCommand(check, ctx)
            : await checkGate(check, ctx);
  } catch (error) {
    reason = `check crashed: ${(error as Error).message}`;
  }
  return {
    index,
    kind,
    ...(check.name ? { name: check.name } : {}),
    ok: reason === undefined,
    durationMs: Date.now() - startedAt,
    ...(reason !== undefined ? { reason: ctx.redact(reason) } : {}),
  };
}

function asList(value: string | string[] | undefined): string[] | undefined {
  if (value === undefined) return undefined;
  return Array.isArray(value) ? value : [value];
}

/**
 * Does a preflight check run for this suite and environment? Without
 * `when` it always does; with it every key that is set must match (a
 * `suite` condition never matches a run without a suite). `reason` says
 * why a check does not run.
 */
export function preflightApplies(
  check: Pick<RunPreflightCheck, "when">,
  current: { suite?: string | undefined; env?: string | undefined },
): { applies: boolean; reason?: string } {
  if (!check.when) return { applies: true };
  const suites = asList(check.when.suite);
  if (
    suites &&
    (current.suite === undefined || !suites.includes(current.suite))
  ) {
    return {
      applies: false,
      reason: `when.suite ${suites.join("|")} (this run: ${current.suite ?? "no suite"})`,
    };
  }
  const envs = asList(check.when.env);
  if (envs && (current.env === undefined || !envs.includes(current.env))) {
    return {
      applies: false,
      reason: `when.env ${envs.join("|")} (this run: ${current.env ?? "unknown"})`,
    };
  }
  return { applies: true };
}

/** The checks of `run.preflight` that run (1-based index kept) and those skipped. */
export function selectPreflightChecks(
  checks: readonly RunPreflightCheck[],
  current: { suite?: string | undefined; env?: string | undefined },
): {
  run: Array<{ check: RunPreflightCheck; index: number }>;
  skipped: Array<{ check: RunPreflightCheck; index: number; reason: string }>;
} {
  const run: Array<{ check: RunPreflightCheck; index: number }> = [];
  const skipped: Array<{
    check: RunPreflightCheck;
    index: number;
    reason: string;
  }> = [];
  for (const [i, check] of checks.entries()) {
    const applies = preflightApplies(check, current);
    if (applies.applies) run.push({ check, index: i + 1 });
    else
      skipped.push({ check, index: i + 1, reason: applies.reason ?? "when" });
  }
  return { run, skipped };
}

/**
 * Run the checks in order, stopping at the first failure. `onResult` sees
 * every result as it settles (the journal events). A check is
 * `{ check, index }` (its 1-based position in `run.preflight`, kept when
 * `when` left earlier checks out) or a bare check (numbered in order).
 */
export async function runPreflight(
  checks: ReadonlyArray<
    RunPreflightCheck | { check: RunPreflightCheck; index: number }
  >,
  ctx: PreflightContext,
  onResult?: (result: PreflightCheckResult) => void,
): Promise<{ ok: boolean; results: PreflightCheckResult[]; message?: string }> {
  const results: PreflightCheckResult[] = [];
  for (const [position, entry] of checks.entries()) {
    const { check, index } =
      "check" in entry && "index" in entry
        ? entry
        : { check: entry, index: position + 1 };
    const result = await runPreflightCheck(check, index, ctx);
    results.push(result);
    onResult?.(result);
    if (!result.ok) {
      return {
        ok: false,
        results,
        message: ctx.redact(
          `preflight[${index}] ${describePreflightCheck(check)} failed: ${result.reason ?? "failed"}`,
        ),
      };
    }
  }
  return { ok: true, results };
}
