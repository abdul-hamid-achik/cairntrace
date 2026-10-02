import { spawnSync } from "node:child_process";
import { basename, isAbsolute, resolve } from "node:path";
import { scrubDatasourceText } from "../datasources/redact";
import { runBoundedCommand } from "../runner/boundedCommand";
import { targetChildEnvWithSelectedTvaultKeys } from "../processEnv";
import type { ExecVerb } from "./schema";
import {
  FixtureVerbError,
  remainingMs,
  type FixtureVerbContext,
  type FixtureVerbOutcome,
} from "./types";

/**
 * `kind: exec` fixtures: each verb is a shell command (`/bin/sh -c`, `args`
 * as `$1…$n`) or a node script resolved against the config directory. The
 * child sees the run context plus `CAIRN_FIXTURE_NAME`, `_VERB`, `_SCOPE`,
 * `_WITH` (JSON parameters), `_OUTPUTS` (JSON outputs so far) and `_MARKER`
 * (JSON owner marker); a `verify` child also gets `CAIRN_FIXTURE_READ_ONLY=1`
 * — it runs where writes are off, so it must only read. The last non-empty
 * stdout line, when it is JSON, is the verb's result; a non-zero exit fails
 * the verb. The process tree is killed past the deadline or on cancel.
 */

const OUTPUT_TAIL_CHARS = 2_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface PreparedExec {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  label: string;
}

function verbObject(verb: ExecVerb): Exclude<ExecVerb, string> {
  return typeof verb === "string" ? { shell: verb } : verb;
}

function prepare(ctx: FixtureVerbContext): PreparedExec {
  const verb = verbObject(ctx.verbDef as ExecVerb);
  const cwd = verb.cwd
    ? isAbsolute(verb.cwd)
      ? verb.cwd
      : resolve(ctx.configDir, verb.cwd)
    : ctx.configDir;
  const fixtureEnv: Record<string, string> = {
    CAIRN_FIXTURE_NAME: ctx.name,
    CAIRN_FIXTURE_VERB: ctx.verb,
    CAIRN_FIXTURE_SCOPE: ctx.scope,
    CAIRN_FIXTURE_WITH: JSON.stringify(ctx.params),
    CAIRN_FIXTURE_OUTPUTS: JSON.stringify(ctx.outputs),
    ...(ctx.marker ? { CAIRN_FIXTURE_MARKER: JSON.stringify(ctx.marker) } : {}),
    ...(ctx.verb === "verify" ? { CAIRN_FIXTURE_READ_ONLY: "1" } : {}),
  };
  const env = targetChildEnvWithSelectedTvaultKeys(
    {
      ...ctx.childEnv,
      ...ctx.contextEnv,
      ...fixtureEnv,
      ...Object.fromEntries(
        Object.entries(verb.env ?? {}).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    },
    ctx.selectedTvaultKeys ?? [],
  );
  const args = (verb.args ?? []).map(String);
  if (verb.node !== undefined) {
    const script = isAbsolute(verb.node)
      ? verb.node
      : resolve(ctx.configDir, verb.node);
    return {
      file: "node",
      args: [script, ...args],
      cwd,
      env,
      label: `node ${basename(script)}`,
    };
  }
  return {
    file: "/bin/sh",
    args: ["-c", verb.shell!, "cairn-fixture", ...args],
    cwd,
    env,
    label: "shell",
  };
}

function verbTimeoutMs(ctx: FixtureVerbContext): number {
  const verb = verbObject(ctx.verbDef as ExecVerb);
  const own = verb.timeoutMs ?? Number.MAX_SAFE_INTEGER;
  const remaining = remainingMs(ctx.deadline);
  // The deadline was set from the same budget a moment ago: report the
  // authored budget, not a value a few milliseconds short of it.
  if (own !== Number.MAX_SAFE_INTEGER && own - remaining < 50) return own;
  return Math.max(1, Math.min(own, remaining));
}

/** The last non-empty stdout line parsed as JSON, when it is JSON. */
export function lastJsonLine(stdout: string): unknown {
  const last = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (last === undefined) return undefined;
  try {
    return JSON.parse(last);
  } catch {
    return undefined;
  }
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_CHARS
    ? text
    : text.slice(text.length - OUTPUT_TAIL_CHARS);
}

function failure(
  ctx: FixtureVerbContext,
  prepared: PreparedExec,
  message: string,
  output: string,
  timedOut = false,
): FixtureVerbError {
  const lines = tail(output.trimEnd()).split("\n").slice(-5).join("\n").trim();
  const text = lines ? `${message}: ${lines.slice(-500)}` : message;
  return new FixtureVerbError(
    scrubDatasourceText(`${ctx.verb} ${prepared.label}: ${text}`, [
      ...ctx.secrets,
    ]),
    timedOut,
  );
}

export async function runExecVerb(
  ctx: FixtureVerbContext,
): Promise<FixtureVerbOutcome> {
  const prepared = prepare(ctx);
  const timeoutMs = verbTimeoutMs(ctx);
  if (ctx.signal?.aborted) {
    throw new FixtureVerbError(`${ctx.verb} ${prepared.label}: cancelled`);
  }
  // Its own process group, like a `run:` step: the deadline and a cancel
  // kill the whole group, and a background process the verb starts (a stub
  // server) cannot hold stdout open past the verb's exit. The env is
  // complete: nothing of this process's env (publisher/TinyVault
  // credentials) is merged back in.
  const result = await runBoundedCommand(prepared.file, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    timeoutMs,
    ownProcessGroup: true,
    maxBufferBytes: MAX_BUFFER_BYTES,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (result.cancelled) throw failure(ctx, prepared, "cancelled", "");
  if (result.timedOut) {
    throw failure(
      ctx,
      prepared,
      `timed out after ${timeoutMs}ms`,
      result.all,
      true,
    );
  }
  if (result.spawnError !== undefined) {
    throw failure(ctx, prepared, result.spawnError || "did not start", "");
  }
  if (result.exitCode !== 0) {
    throw failure(
      ctx,
      prepared,
      result.exitCode === undefined
        ? `killed (${result.exitSignal ?? "signal"})`
        : `failed (exit ${result.exitCode})`,
      result.all,
    );
  }
  return {
    result: lastJsonLine(result.stdout),
    detail: `${prepared.label} exit 0`,
  };
}

/**
 * Synchronous variant for the SIGINT/SIGTERM path: the process is exiting
 * and no promise continuation would run. Only the direct child is killed at
 * the deadline.
 */
export function runExecVerbSync(ctx: FixtureVerbContext): FixtureVerbOutcome {
  const prepared = prepare(ctx);
  const timeoutMs = verbTimeoutMs(ctx);
  const r = spawnSync(prepared.file, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: MAX_BUFFER_BYTES,
  });
  const stdout = r.stdout ?? "";
  const all = `${stdout}${r.stderr ? `\n${r.stderr}` : ""}`;
  const timedOut =
    (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  if (timedOut) {
    throw failure(ctx, prepared, `timed out after ${timeoutMs}ms`, all, true);
  }
  if (r.error) throw failure(ctx, prepared, r.error.message, "");
  if (r.status !== 0) {
    throw failure(ctx, prepared, `failed (exit ${r.status ?? "?"})`, all);
  }
  return { result: lastJsonLine(stdout), detail: `${prepared.label} exit 0` };
}
