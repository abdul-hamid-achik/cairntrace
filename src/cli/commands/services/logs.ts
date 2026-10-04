import {
  readServicesLock,
  describeServicesLock,
} from "../../../core/runner/services";
import { tmuxSessionExists } from "../../../core/runner/services";
import {
  tmuxCapture,
  viewCapture,
  waitForPattern,
  type CaptureWindow,
} from "../../../core/servicesOps/logs";
import type { ServicesLogsResult } from "../../../core/schema/services.v1";
import { emit, resolveFormat } from "../../format";
import {
  noServicesMessage,
  resolveServicesTarget,
  ServicesCommandError,
  type ServicesTarget,
} from "./target";
import { parseDurationFlag } from "./restart";

/**
 * `cairn services logs <window>`: the captured text of a service window
 * (redacted, wrapped lines joined). `--since-restart` keeps only the current
 * restart generation, `--wait <regex> --timeout <d>` waits for a line, and
 * `--follow` streams new lines until interrupted (text output only).
 */

export interface ServicesLogsOptions {
  config?: string;
  env?: string;
  cwd?: string;
  window: string;
  sinceRestart?: boolean;
  /** Last N lines (default 200). */
  lines?: number;
  wait?: string;
  /** Duration of `--wait` (default 30s). */
  timeout?: string;
  /** Test seam: replaces the tmux capture. */
  capture?: CaptureWindow;
}

export interface ServicesLogsCommandOptions {
  config?: string;
  env?: string;
  sinceRestart?: boolean;
  lines?: string;
  wait?: string;
  timeout?: string;
  follow?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

const SCHEMA = "urn:cairntrace.dev:services-logs:v1" as const;
const DEFAULT_LINES = 200;
const DEFAULT_WAIT_MS = 30_000;

/** Read the window's logs. Never throws. */
export async function servicesLogs(
  opts: ServicesLogsOptions,
): Promise<ServicesLogsResult> {
  const startedAtMs = Date.now();
  const sinceRestart = opts.sinceRestart === true;
  const result = ({
    ok,
    exitCode,
    ...fields
  }: Partial<ServicesLogsResult> &
    Pick<ServicesLogsResult, "ok" | "exitCode">): ServicesLogsResult => ({
    $schema: SCHEMA,
    version: "1",
    ok,
    exitCode,
    ...fields,
    lines: fields.lines ?? [],
    totalLines: fields.totalLines ?? 0,
    sinceRestart: fields.sinceRestart ?? {
      requested: sinceRestart,
      found: false,
    },
    warnings: fields.warnings ?? [],
    durationMs: Math.max(0, Date.now() - startedAtMs),
  });

  let timeoutMs = DEFAULT_WAIT_MS;
  let pattern: RegExp | undefined;
  try {
    timeoutMs = parseDurationFlag("--timeout", opts.timeout) ?? DEFAULT_WAIT_MS;
    if (opts.wait !== undefined) {
      try {
        pattern = new RegExp(opts.wait);
      } catch (error) {
        throw new ServicesCommandError(
          `--wait ${opts.wait}: not a valid regular expression (${(error as Error).message})`,
          2,
        );
      }
    }
  } catch (e) {
    return result({
      ok: false,
      exitCode: e instanceof ServicesCommandError ? e.exitCode : 2,
      error: (e as Error).message,
    });
  }
  let target: ServicesTarget;
  try {
    target = await resolveServicesTarget(opts, "best-effort");
  } catch (e) {
    return result({
      ok: false,
      exitCode: e instanceof ServicesCommandError ? e.exitCode : 2,
      error: (e as Error).message,
    });
  }
  const identity = {
    project: target.project,
    env: target.envName,
    configPath: target.configPath,
  };
  const warnings = [...target.warnings];
  const tmux = target.services?.tmux;
  if (!target.services || !tmux) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      warnings,
      error: target.services
        ? `no tmux session is configured for env "${target.envName}" in ${target.configPath}`
        : noServicesMessage(target),
    });
  }
  if (!tmux.windows.some((w) => w.name === opts.window)) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      session: tmux.session,
      warnings,
      error: `"${opts.window}" is not a window of the configured tmux session "${tmux.session}" (configured: ${tmux.windows
        .map((w) => w.name)
        .join(", ")})`,
    });
  }
  const lock = await readServicesLock(target.configPath);
  if (lock.state === "held" && lock.lock.env !== target.envName) {
    warnings.push(
      `services of this config are up for env "${lock.lock.env}" (${describeServicesLock(lock.lock)}); showing the session of env "${target.envName}"`,
    );
  }
  const capture = opts.capture ?? tmuxCapture(tmux.session, opts.window);
  if (!opts.capture && !(await tmuxSessionExists(tmux.session))) {
    return result({
      ...identity,
      ok: false,
      exitCode: 4,
      session: tmux.session,
      window: opts.window,
      warnings,
      error: `tmux session "${tmux.session}" is not running; start the services first (cairn services up)`,
    });
  }
  const redact = (text: string): string => target.redactor.text(text);
  const wanted = Math.max(1, opts.lines ?? DEFAULT_LINES);

  let view;
  let wait: ServicesLogsResult["wait"];
  let exitCode: ServicesLogsResult["exitCode"] = 0;
  if (pattern) {
    const waited = await waitForPattern(capture, {
      pattern,
      timeoutMs,
      sinceRestart,
    });
    view = waited.view;
    wait = {
      pattern: opts.wait!,
      matched: waited.matched,
      ...(waited.line !== undefined ? { line: redact(waited.line) } : {}),
      timedOut: waited.timedOut,
      elapsedMs: waited.elapsedMs,
    };
    if (!waited.matched) exitCode = waited.timedOut ? 1 : 4;
  } else {
    const text = await capture();
    if (text === undefined) {
      return result({
        ...identity,
        ok: false,
        exitCode: 4,
        session: tmux.session,
        window: opts.window,
        warnings,
        error: `window "${opts.window}" could not be captured from session "${tmux.session}"`,
      });
    }
    view = viewCapture(text, { sinceRestart });
  }
  const shown = view.lines.slice(-wanted).map(redact);
  return result({
    ...identity,
    ok: exitCode === 0,
    exitCode,
    session: tmux.session,
    window: opts.window,
    lines: shown,
    totalLines: view.lines.length,
    sinceRestart: {
      requested: sinceRestart,
      found: view.restartFound,
      ...(view.generation ? { generation: view.generation } : {}),
    },
    ...(wait ? { wait } : {}),
    warnings,
    ...(exitCode === 1
      ? { error: `no line matched /${opts.wait}/ within ${timeoutMs}ms` }
      : exitCode === 4
        ? { error: `window "${opts.window}" disappeared while waiting` }
        : {}),
  });
}

/** `cairn services logs` — CLI wrapper. */
export async function servicesLogsCommand(
  window: string,
  opts: ServicesLogsCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  if (opts.follow && format !== "md") {
    process.stderr.write(
      "error: --follow streams text; use the default format (not --json/--yaml)\n",
    );
    process.exitCode = 2;
    return;
  }
  const base: ServicesLogsOptions = {
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    window,
    ...(opts.sinceRestart ? { sinceRestart: true } : {}),
    ...(opts.lines !== undefined ? { lines: Number(opts.lines) } : {}),
    ...(opts.wait !== undefined ? { wait: opts.wait } : {}),
    ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
  };
  if (opts.lines !== undefined && !(Number(opts.lines) > 0)) {
    process.stderr.write("error: --lines must be a positive number\n");
    process.exitCode = 2;
    return;
  }
  const result = await servicesLogs(base);
  if (!opts.follow || !result.ok) {
    process.stdout.write(emit(format, result, renderServicesLogsMarkdown));
    if (format === "md") process.stdout.write("\n");
    if (!result.ok && format !== "md" && result.error) {
      process.stderr.write(`error: ${result.error}\n`);
    }
    process.exitCode = result.exitCode;
    return;
  }
  // --follow: print what is there, then new lines until interrupted.
  await followWindow(base, result);
}

async function followWindow(
  base: ServicesLogsOptions,
  first: ServicesLogsResult,
): Promise<void> {
  let printed = first.lines;
  for (const line of printed) process.stdout.write(`${line}\n`);
  const interrupted = { value: false };
  process.once("SIGINT", () => {
    interrupted.value = true;
  });
  while (!interrupted.value) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const next = await servicesLogs({ ...base, lines: 5000 });
    if (!next.ok) {
      process.stderr.write(`error: ${next.error ?? "window disappeared"}\n`);
      process.exitCode = next.exitCode;
      return;
    }
    // New lines: whatever follows the longest suffix of `printed` that is a
    // prefix-anchored overlap with the new view.
    const fresh = newLines(printed, next.lines);
    for (const line of fresh) process.stdout.write(`${line}\n`);
    printed = next.lines;
  }
}

/** The lines of `next` that come after what `previous` already showed. */
export function newLines(previous: string[], next: string[]): string[] {
  if (previous.length === 0) return next;
  // The longest tail of what was shown (up to 3 lines) that ends somewhere in
  // the new view; a tail that scrolled out shrinks until one matches.
  for (let size = Math.min(3, previous.length); size >= 1; size--) {
    const tail = previous.slice(-size);
    for (let end = next.length; end >= size; end--) {
      if (tail.every((line, i) => next[end - size + i] === line)) {
        return next.slice(end);
      }
    }
  }
  // Nothing in common: the window was cleared (a restart), all of it is new.
  return next;
}

export function renderServicesLogsMarkdown(r: ServicesLogsResult): string {
  if (!r.ok && r.lines.length === 0) {
    return r.error ? `error: ${r.error}` : "failed";
  }
  const out = [...r.lines];
  if (r.wait) {
    out.push(
      "",
      r.wait.matched
        ? `matched /${r.wait.pattern}/ after ${r.wait.elapsedMs}ms: ${r.wait.line ?? ""}`
        : `no match for /${r.wait.pattern}/ (${
            r.wait.timedOut ? "timed out" : "window gone"
          })`,
    );
  }
  if (r.sinceRestart.requested && !r.sinceRestart.found) {
    out.push("", "(no restart marker in this pane: showing everything)");
  }
  for (const warning of r.warnings) out.push(`warning: ${warning}`);
  return out.join("\n");
}
