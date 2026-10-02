import { spawnSync } from "node:child_process";
import {
  closeSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { targetChildEnvWithSelectedTvaultKeys } from "../processEnv";
import type { RunStep } from "../schema/spec.v1";
import { runBoundedCommand } from "./boundedCommand";
import { resolveStepFile, type StepFileScope } from "./stepFiles";

/**
 * The `run:` step (F3a): a host shell command or node script with a hard,
 * process-tree deadline. With `assign`, the last non-empty stdout line is
 * parsed as JSON and later steps splice it as `${runs.<assign>.<path>}`.
 */

const DEFAULT_RUN_STEP_TIMEOUT_MS = 120_000;
const OUTPUT_TAIL_CHARS = 2_000;
const MAX_BUFFER_BYTES = 16 * 1024 * 1024;

interface RunStepSpec {
  shell?: string;
  node?: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  timeoutMs: number;
  assign?: string;
}

/** Normalize the string shorthand and the object form. */
function runStepSpec(step: RunStep): RunStepSpec {
  if (typeof step.run === "string") {
    return {
      shell: step.run,
      args: [],
      env: {},
      timeoutMs: DEFAULT_RUN_STEP_TIMEOUT_MS,
    };
  }
  const run = step.run;
  return {
    ...(run.shell !== undefined ? { shell: run.shell } : {}),
    ...(run.node !== undefined ? { node: run.node } : {}),
    args: (run.args ?? []).map(String),
    ...(run.cwd !== undefined ? { cwd: run.cwd } : {}),
    env: Object.fromEntries(
      Object.entries(run.env ?? {}).map(([k, v]) => [k, String(v)]),
    ),
    timeoutMs: run.timeoutMs ?? DEFAULT_RUN_STEP_TIMEOUT_MS,
    ...(run.assign !== undefined ? { assign: run.assign } : {}),
  };
}

/**
 * Event label of a run step. Never the command text: placeholders are
 * already substituted there and may carry secret values.
 */
export function runStepLabel(step: RunStep): string {
  const spec = runStepSpec(step);
  const what = spec.node ? `node ${basename(spec.node)}` : "shell";
  return spec.assign ? `run ${what} → ${spec.assign}` : `run ${what}`;
}

export interface RunStepInvocation {
  step: RunStep;
  fileScope: StepFileScope;
  /** Already-filtered child environment (no vault controls). */
  childEnv: Record<string, string | undefined>;
  /** CAIRN_* run context (+ CAIRN_RUN_STATUS in teardown). */
  contextEnv: Record<string, string>;
  selectedTvaultKeys?: Iterable<string>;
  /** Kills the process tree (normal steps); teardown passes none. */
  signal?: AbortSignal;
  /** Caps the step's own `timeoutMs` (what is left of a teardown budget). */
  maxTimeoutMs?: number;
}

interface RunStepResult {
  ok: boolean;
  error?: string;
  exitCode?: number;
  timedOut: boolean;
  cancelled: boolean;
  /** Last characters of the combined output (unredacted: callers redact). */
  outputTail: string;
  /** Parsed JSON of the last stdout line when `assign` is set. */
  value?: unknown;
  assign?: string;
  durationMs: number;
}

interface PreparedRun {
  file: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  spec: RunStepSpec;
  label: string;
}

function prepare(invocation: RunStepInvocation): PreparedRun {
  const spec = runStepSpec(invocation.step);
  const scope = invocation.fileScope;
  const cwd = spec.cwd
    ? isAbsolute(spec.cwd)
      ? spec.cwd
      : resolve(scope.declaringDir, spec.cwd)
    : scope.declaringDir;
  const env = targetChildEnvWithSelectedTvaultKeys(
    { ...invocation.childEnv, ...invocation.contextEnv, ...spec.env },
    invocation.selectedTvaultKeys ?? [],
  );
  const timeoutMs = Math.max(
    1,
    Math.min(
      spec.timeoutMs,
      invocation.maxTimeoutMs ?? Number.MAX_SAFE_INTEGER,
    ),
  );
  if (spec.node) {
    const script = resolveStepFile(spec.node, scope, "run.node");
    return {
      file: "node",
      args: [script, ...spec.args],
      cwd,
      env,
      timeoutMs,
      spec,
      label: `node ${basename(script)}`,
    };
  }
  // `sh -c <script> cairn-run <args…>`: args arrive as $1…$n, unquoted
  // by the author and never spliced into the script text.
  return {
    file: "/bin/sh",
    args: ["-c", spec.shell!, "cairn-run", ...spec.args],
    cwd,
    env,
    timeoutMs,
    spec,
    label: "shell",
  };
}

/** Parse the last non-empty stdout line as JSON (the `assign` contract). */
export function parseAssignedJson(
  stdout: string,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const last = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (last === undefined) {
    return {
      ok: false,
      error: "assign: the command printed nothing on stdout",
    };
  }
  try {
    return { ok: true, value: JSON.parse(last) };
  } catch {
    return {
      ok: false,
      error: `assign: the last stdout line is not JSON (${last.slice(0, 120)})`,
    };
  }
}

function tail(text: string): string {
  return text.length <= OUTPUT_TAIL_CHARS
    ? text
    : text.slice(text.length - OUTPUT_TAIL_CHARS);
}

function finish(
  prepared: PreparedRun,
  raw: {
    exitCode: number | undefined;
    stdout: string;
    all: string;
    timedOut: boolean;
    cancelled: boolean;
    spawnError?: string;
    exitSignal?: string;
  },
  startedAt: number,
): RunStepResult {
  const durationMs = Date.now() - startedAt;
  const outputTail = tail(raw.all.trimEnd());
  const base = {
    timedOut: raw.timedOut,
    cancelled: raw.cancelled,
    outputTail,
    durationMs,
    ...(raw.exitCode !== undefined ? { exitCode: raw.exitCode } : {}),
  };
  const lastLines = outputTail.split("\n").slice(-5).join("\n").trim();
  const withOutput = (message: string): string =>
    lastLines ? `${message}: ${lastLines.slice(-500)}` : message;
  if (raw.cancelled) {
    return { ok: false, ...base, error: `run ${prepared.label} was cancelled` };
  }
  if (raw.timedOut) {
    return {
      ok: false,
      ...base,
      error: withOutput(
        `run ${prepared.label} timed out after ${prepared.timeoutMs}ms`,
      ),
    };
  }
  if (raw.spawnError) {
    return {
      ok: false,
      ...base,
      error: `run ${prepared.label}: ${raw.spawnError}`,
    };
  }
  if (raw.exitCode !== 0) {
    const how =
      raw.exitCode === undefined && raw.exitSignal
        ? `killed by ${raw.exitSignal}`
        : `exit ${raw.exitCode}`;
    return {
      ok: false,
      ...base,
      error: withOutput(`run ${prepared.label} failed (${how})`),
    };
  }
  if (prepared.spec.assign) {
    const parsed = parseAssignedJson(raw.stdout);
    if (!parsed.ok) return { ok: false, ...base, error: parsed.error };
    return {
      ok: true,
      ...base,
      value: parsed.value,
      assign: prepared.spec.assign,
    };
  }
  return { ok: true, ...base };
}

/** Run the step; its process group is killed past the deadline or on abort. */
export async function executeRunStep(
  invocation: RunStepInvocation,
): Promise<RunStepResult> {
  const startedAt = Date.now();
  let prepared: PreparedRun;
  try {
    prepared = prepare(invocation);
  } catch (error) {
    return {
      ok: false,
      error: `run: ${(error as Error).message}`,
      timedOut: false,
      cancelled: false,
      outputTail: "",
      durationMs: Date.now() - startedAt,
    };
  }
  if (invocation.signal?.aborted) {
    return finish(
      prepared,
      {
        exitCode: undefined,
        stdout: "",
        all: "",
        timedOut: false,
        cancelled: true,
      },
      startedAt,
    );
  }
  // Its own process group: the deadline and a cancel kill the whole group
  // (background processes included), and a background process that holds
  // stdout open cannot stretch the deadline. The env is complete — nothing
  // of this process's env (publisher/TinyVault credentials) is merged in.
  const result = await runBoundedCommand(prepared.file, prepared.args, {
    cwd: prepared.cwd,
    env: prepared.env,
    timeoutMs: prepared.timeoutMs,
    ownProcessGroup: true,
    maxBufferBytes: MAX_BUFFER_BYTES,
    ...(invocation.signal ? { signal: invocation.signal } : {}),
  });
  return finish(
    prepared,
    {
      exitCode: result.exitCode,
      ...(result.exitSignal ? { exitSignal: result.exitSignal } : {}),
      stdout: result.stdout,
      all: result.all,
      timedOut: result.timedOut,
      cancelled: result.cancelled,
      ...(result.spawnError ? { spawnError: result.spawnError } : {}),
    },
    startedAt,
  );
}

/**
 * Synchronous variant for the SIGINT/SIGTERM handler, where no promise
 * continuation runs before the process exits. Only the direct child is
 * killed at the deadline.
 */
export function executeRunStepSync(
  invocation: Omit<RunStepInvocation, "signal">,
): RunStepResult {
  const startedAt = Date.now();
  let prepared: PreparedRun;
  try {
    prepared = prepare(invocation);
  } catch (error) {
    return {
      ok: false,
      error: `run: ${(error as Error).message}`,
      timedOut: false,
      cancelled: false,
      outputTail: "",
      durationMs: Date.now() - startedAt,
    };
  }
  // Output goes to files, not pipes: spawnSync then returns when the child
  // exits, even if a background process it left keeps writing.
  let outDir: string | undefined;
  let r: ReturnType<typeof spawnSync>;
  let stdout = "";
  let stderr = "";
  try {
    outDir = mkdtempSync(join(tmpdir(), "cairn-run-"));
    const outPath = join(outDir, "stdout");
    const errPath = join(outDir, "stderr");
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    try {
      r = spawnSync(prepared.file, prepared.args, {
        cwd: prepared.cwd,
        env: prepared.env,
        stdio: ["ignore", outFd, errFd],
        timeout: prepared.timeoutMs,
        killSignal: "SIGKILL",
      });
    } finally {
      closeSync(outFd);
      closeSync(errFd);
    }
    stdout = readTail(outPath);
    stderr = readTail(errPath);
  } catch (error) {
    return {
      ok: false,
      error: `run ${prepared.label}: ${(error as Error).message}`,
      timedOut: false,
      cancelled: false,
      outputTail: "",
      durationMs: Date.now() - startedAt,
    };
  } finally {
    if (outDir) rmSync(outDir, { recursive: true, force: true });
  }
  const timedOut =
    (r.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT";
  return finish(
    prepared,
    {
      exitCode: r.status ?? undefined,
      ...(r.signal ? { exitSignal: r.signal } : {}),
      stdout,
      all: `${stdout}${stderr ? `\n${stderr}` : ""}`,
      timedOut,
      cancelled: false,
      ...(r.error && !timedOut ? { spawnError: r.error.message } : {}),
    },
    startedAt,
  );
}

/** The last MAX_BUFFER_BYTES of a file the child wrote (utf8). */
function readTail(path: string): string {
  const text = readFileSync(path, "utf8");
  return text.length <= MAX_BUFFER_BYTES
    ? text
    : text.slice(text.length - MAX_BUFFER_BYTES);
}

/**
 * Splice `${runs.<name>.<path>}` from assigned run-step values. Objects and
 * arrays render as JSON; unknown names or paths render as "".
 */
export function resolveRunPlaceholders(
  input: string,
  runs: Readonly<Record<string, unknown>>,
): string {
  if (!input.includes("${runs.")) return input;
  return input.replace(
    /\$\{runs\.([a-z][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_-]+)*)\}/g,
    (_match, name: string, pathStr: string) => {
      if (!Object.hasOwn(runs, name)) return "";
      let value: unknown = runs[name];
      for (const key of pathStr ? pathStr.slice(1).split(".") : []) {
        if (value !== null && typeof value === "object" && key in value) {
          value = (value as Record<string, unknown>)[key];
        } else {
          return "";
        }
      }
      if (value === undefined || value === null) return "";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    },
  );
}
