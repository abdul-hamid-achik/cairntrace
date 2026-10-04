import { readFile, stat } from "node:fs/promises";
import { basename, dirname, extname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { BrowserBackend } from "../../../adapters/browserBackend";
import {
  createSdkDatasourceHost,
  startVerifierChannel,
  type VerifierChannel,
} from "../../../sdk/host";
import { CAIRN_PROGRESS_FILE_ENV } from "../../artifacts/progressChannel";
import type {
  ScriptFixtureValue,
  ScriptVerifier,
} from "../../schema/verifier.v1";
import { runNodeScript, VERIFIER_SDK_SPECIFIER } from "../nodeScripts";
import { resolveFixtureMap } from "../runtimePlaceholders";
import { withCairnPrelude } from "../../prelude/prelude";
import type { VerifierContext, VerifierEvaluation } from "./types";

/** The verifier SDK runtime a node child imports (`@thelacanians/cairntrace/verifier`). */
export const VERIFIER_SDK_ENTRY = fileURLToPath(
  new URL("../../../sdk/verifier.js", import.meta.url),
);

/** SIGTERM → SIGKILL window for a cancelled SDK verifier (ctx.signal aborts first). */
const SDK_CANCEL_GRACE_MS = 1_000;

/**
 * Observability hooks the runner attaches for the outcome in flight. Only
 * node script verifiers use them: they run as child processes.
 */
export interface ScriptRunObserver {
  /** Each complete stdout/stderr line (the result protocol line excluded). */
  onOutputLine?: (stream: "stdout" | "stderr", line: string) => void;
  /** Exported as `CAIRN_PROGRESS_FILE`; `ctx.progress(msg)` appends to it. */
  progressFile?: string;
}

/** Run identity handed to node scripts as `ctx.run`. */
export interface ScriptRunInfo {
  id?: string;
  token?: string;
  startedAt?: string;
  labels?: Record<string, string>;
}

/** Verifier context plus the runner's per-outcome script observer. */
export type ScriptVerifierContext = VerifierContext & {
  scriptRun?: ScriptRunObserver;
  /** Run cancellation: a node script's whole process tree is killed. */
  signal?: AbortSignal;
  /** `ctx.run` id/token/startedAt/labels (else CAIRN_RUN_*, the run dir name, runStartedAt). */
  runInfo?: ScriptRunInfo;
};

/**
 * Escape hatch — evaluate a JS expression in the page and expect `{ ok, evidence }`.
 * The agent writes:
 *   ```js
 *   () => { ... return { ok: <bool>, evidence: <anything> }; }
 *   ```
 *
 * Cairntrace wraps the script and evaluates via backend.evaluate(). The full
 * `evidence` value is written to outcomes/<id>.raw.json; a truncated summary
 * goes into outcomes/<id>.md per §13b.
 */
export async function evaluateScript(
  verifier: ScriptVerifier,
  backend: BrowserBackend,
  ctx: ScriptVerifierContext = {},
): Promise<VerifierEvaluation> {
  if (verifier.script.runtime === "node") {
    return evaluateNodeScript(verifier, ctx);
  }

  const source = await loadScriptSource(verifier, ctx);
  const result = await backend.evaluate(buildScript(verifier, source, ctx));
  if (!result.ok) {
    return {
      passed: false,
      expected: "script returned { ok: true, evidence: ... }",
      actual: `script invocation failed: exitCode=${result.exitCode}, stderr=${truncate(result.stderr, 200)}`,
    };
  }

  let parsed: { ok: unknown; evidence: unknown };
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return {
      passed: false,
      expected: "script returned { ok: true, evidence: ... } as JSON",
      actual: `failed to parse script stdout as JSON: ${(e as Error).message}. stdout=${truncate(result.stdout, 200)}`,
    };
  }

  // Require a real boolean `ok` — matching the node path. A truthy non-boolean
  // (e.g. the string "false", or any object) must NOT count as a pass.
  if (typeof parsed.ok !== "boolean") {
    return {
      passed: false,
      expected: "script ok === true (boolean)",
      actual: `script returned a non-boolean ok: ${JSON.stringify(parsed.ok)}`,
      raw: parsed.evidence,
    };
  }

  return {
    passed: parsed.ok,
    expected: "script ok === true",
    actual: parsed.ok ? "script returned ok=true" : "script returned ok=false",
    raw: parsed.evidence,
  };
}

async function evaluateNodeScript(
  verifier: ScriptVerifier,
  ctx: ScriptVerifierContext,
): Promise<VerifierEvaluation> {
  const file = verifier.script.file
    ? resolveScriptFile(verifier.script.file, ctx)
    : undefined;
  const usesSdk = file ? await importsVerifierSdk(file) : false;
  const progressFile = ctx.scriptRun?.progressFile;
  const env = progressFile
    ? {
        ...(ctx.childEnv ?? process.env),
        [CAIRN_PROGRESS_FILE_ENV]: progressFile,
      }
    : ctx.childEnv;
  const onOutputLine = ctx.scriptRun?.onOutputLine;
  const startedAtMs = Date.now();
  const timeoutMs = verifier.script.timeoutMs;
  // SDK verifiers reach config datasources through a loopback channel; the
  // clients and their credentials stay in this process.
  const host =
    usesSdk && ctx.datasources
      ? createSdkDatasourceHost(ctx.datasources, {
          env: ctx.childEnv ?? process.env,
          ...(ctx.vars ? { vars: ctx.vars } : {}),
          ...(ctx.envName ? { envName: ctx.envName } : {}),
          ...(ctx.loadMongoDriver
            ? { loadMongoDriver: ctx.loadMongoDriver }
            : {}),
          ...(timeoutMs ? { deadline: startedAtMs + timeoutMs } : {}),
        })
      : undefined;
  const datasources = host?.list() ?? [];
  let channel: VerifierChannel | undefined;
  if (host && datasources.length > 0) {
    channel = await startVerifierChannel(host, {
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      onCall: (call) =>
        onOutputLine?.(
          "stderr",
          `[datasource] ${call.name}.${call.method} ${
            call.ok ? "ok" : "failed"
          } ${call.durationMs}ms${
            call.rows !== undefined ? ` (${call.rows} rows)` : ""
          }${call.error ? `: ${call.error}` : ""}`,
        ),
    });
  }
  let result: Awaited<ReturnType<typeof runNodeScript>>;
  try {
    result = await runNodeScript({
      ...(file ? { file } : {}),
      ...(verifier.script.run ? { source: verifier.script.run } : {}),
      ...(timeoutMs ? { timeoutMs } : {}),
      cwd: ctx.specDir,
      entryNames: ["verify"],
      ...(env !== undefined ? { env } : {}),
      ...(onOutputLine ? { onOutputLine } : {}),
      ...(ctx.signal ? { signal: ctx.signal } : {}),
      // Every node child resolves the SDK specifier to the runner's copy (a
      // resolve hook; plain scripts never notice), so a verifier that gets
      // defineVerifier through a helper module runs too.
      sdkEntry: VERIFIER_SDK_ENTRY,
      ...(usesSdk ? { cancelGraceMs: SDK_CANCEL_GRACE_MS } : {}),
      ...(ctx.selectedTvaultKeys !== undefined
        ? { selectedTvaultKeys: ctx.selectedTvaultKeys }
        : {}),
      ctx: {
        fixtures: resolveRuntimeFixtures(verifier, ctx),
        artifacts: ctx.artifacts ?? {},
        vars: ctx.vars ?? {},
        runDir: ctx.runDir,
        specDir: ctx.specDir,
        run: runStateForScripts(ctx),
        evals: ctx.evals ?? {},
        requests: ctx.responses ?? {},
        captures: ctx.captures ?? {},
        runs: ctx.runOutputs ?? {},
        fixturesOutputs: ctx.fixtureOutputs ?? {},
        deadline: timeoutMs ? startedAtMs + timeoutMs : null,
        // Only SDK verifiers read the network snapshot (ctx.network) and the
        // channel metadata; legacy scripts do not pay for them.
        ...(usesSdk
          ? {
              networkEntries: ctx.networkEntries ?? [],
              runtime: {
                protocol: 1,
                startedAtMs,
                ...(timeoutMs ? { timeoutMs } : {}),
                cancelGraceMs: SDK_CANCEL_GRACE_MS,
                ...(channel
                  ? { rpc: { url: channel.url, token: channel.token } }
                  : {}),
                datasources,
              },
            }
          : {}),
      },
    });
  } finally {
    await channel?.close();
    await host?.close();
  }

  if (!result.ok) {
    const stack = result.error?.stack ?? result.stderr;
    return {
      passed: false,
      expected: "node script returned { ok: true, evidence: ... }",
      actual: `node script failed: exitCode=${result.exitCode}, ${truncate(
        result.error?.message ?? result.stderr,
        300,
      )}`,
      raw: {
        error: result.error,
        stack,
        stdout: result.stdout,
        stderr: result.stderr,
      },
    };
  }

  const parsed = result.result as {
    ok?: unknown;
    evidence?: unknown;
    message?: unknown;
    sdk?: unknown;
    attempts?: unknown;
    polledMs?: unknown;
  };
  if (!parsed || typeof parsed !== "object" || typeof parsed.ok !== "boolean") {
    return {
      passed: false,
      expected: "node script returned { ok: boolean, evidence: ... }",
      actual: `node script returned ${typeof result.result}`,
      raw: result.result,
    };
  }

  // An SDK verifier says why in `message`; legacy scripts keep the generic line.
  const message =
    parsed.sdk !== undefined && typeof parsed.message === "string"
      ? truncate(parsed.message, 500)
      : undefined;
  const evaluation: VerifierEvaluation = {
    passed: parsed.ok,
    expected: "script ok === true",
    actual:
      message ??
      (parsed.ok ? "script returned ok=true" : "script returned ok=false"),
    raw: parsed.evidence,
    ...(typeof parsed.attempts === "number"
      ? { attempts: parsed.attempts }
      : {}),
    ...(typeof parsed.polledMs === "number"
      ? { polledMs: parsed.polledMs }
      : {}),
  };
  return evaluation;
}

/** Files read (entry included) when looking for the SDK import. */
const SDK_SCAN_MAX_FILES = 25;
const RELATIVE_IMPORT =
  /(?:\bfrom\s*|\bimport\s*\(?\s*)["'](\.{1,2}\/[^"'\n]+)["']/g;
const IMPORT_EXTENSIONS = [".ts", ".mts", ".js", ".mjs"];

/**
 * Whether a verifier imports the SDK — itself or through the relative
 * modules it imports (a shared support file) — read as text, never
 * executed. Such a verifier gets its network snapshot, the datasource
 * channel, the deadline metadata and a polite cancel.
 */
async function importsVerifierSdk(file: string): Promise<boolean> {
  const seen = new Set<string>();
  const queue = [file];
  while (queue.length > 0 && seen.size < SDK_SCAN_MAX_FILES) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    let text: string;
    try {
      text = await readFile(current, "utf8");
    } catch {
      continue; // The child reports a missing entry file.
    }
    if (text.includes(VERIFIER_SDK_SPECIFIER)) return true;
    for (const match of text.matchAll(RELATIVE_IMPORT)) {
      const target = await existingModule(resolve(dirname(current), match[1]!));
      if (target && !seen.has(target)) queue.push(target);
    }
  }
  return false;
}

async function existingModule(path: string): Promise<string | undefined> {
  const candidates = [
    path,
    ...IMPORT_EXTENSIONS.map((ext) => path + ext),
    ...IMPORT_EXTENSIONS.map((ext) => resolve(path, `index${ext}`)),
  ];
  for (const candidate of candidates) {
    try {
      if ((await stat(candidate)).isFile()) return candidate;
    } catch {
      // Not this one.
    }
  }
  return undefined;
}

async function loadScriptSource(
  verifier: ScriptVerifier,
  ctx: VerifierContext,
): Promise<string> {
  if (verifier.script.run !== undefined) return verifier.script.run;

  const file = verifier.script.file;
  if (!file) {
    throw new Error("script verifier must define either run or file");
  }
  const abs = resolveScriptFile(file, ctx);
  const source = await readFile(abs, "utf8");
  if (extname(abs) !== ".ts") return source;

  const bun = (
    globalThis as typeof globalThis & {
      Bun?: {
        Transpiler?: new (opts: {
          loader: "ts";
        }) => {
          transformSync(source: string): string;
        };
      };
    }
  ).Bun;
  if (!bun?.Transpiler) {
    throw new Error(
      `script.file uses TypeScript but Bun.Transpiler is unavailable: ${file}`,
    );
  }
  return new bun.Transpiler({ loader: "ts" }).transformSync(source);
}

function resolveScriptFile(file: string, ctx: VerifierContext): string {
  return isAbsolute(file) ? file : resolve(ctx.specDir ?? process.cwd(), file);
}

function buildScript(
  verifier: ScriptVerifier,
  source: string,
  ctx: VerifierContext,
): string {
  const fixtures = JSON.stringify(resolveRuntimeFixtures(verifier, ctx));
  const artifacts = JSON.stringify(ctx.artifacts ?? {});
  const vars = JSON.stringify(ctx.vars ?? {});
  const run = JSON.stringify(runStateForScripts(ctx));
  // The user's `run` body should `return { ok, evidence }`. We wrap it in a
  // function call so the body can use `return` statements; agent-browser's
  // `eval` then auto-stringifies the returned object as JSON.
  return [
    `(function(){`,
    `  const fixtures = ${fixtures};`,
    `  const artifacts = ${artifacts};`,
    `  const vars = ${vars};`,
    `  const run = ${run};`,
    `  return (function(){`,
    // F20: a source that mentions `__cairn` gets the page prelude first.
    withCairnPrelude(source, ctx.appHandles),
    `  })();`,
    `})()`,
  ].join("\n");
}

/**
 * The slice of run state scripts may act on. Outcomes always evaluate — that
 * is the contract — but a verifier that polls for a side effect of a step
 * that never ran should be able to fail in milliseconds instead of spending
 * its whole completion budget waiting for an event nothing will ever emit.
 * Identity (id, token, startedAt, labels) lets a verifier scope its queries
 * to this run.
 */
function runStateForScripts(ctx: ScriptVerifierContext): {
  failedStep: string | null;
  lastSuccessfulStep: string | null;
  id?: string;
  token?: string;
  startedAt?: string;
  labels?: Record<string, string>;
} {
  const env = ctx.childEnv ?? {};
  const id =
    ctx.runInfo?.id ??
    env["CAIRN_RUN_ID"] ??
    (ctx.runDir ? basename(ctx.runDir) : undefined);
  const token = ctx.runInfo?.token ?? env["CAIRN_RUN_TOKEN"];
  return {
    failedStep: ctx.failedStep ?? null,
    lastSuccessfulStep: ctx.lastSuccessfulStep ?? null,
    ...(id ? { id } : {}),
    ...(token ? { token } : {}),
    ...((ctx.runInfo?.startedAt ?? ctx.runStartedAt)
      ? { startedAt: ctx.runInfo?.startedAt ?? ctx.runStartedAt }
      : {}),
    ...(ctx.runInfo?.labels ? { labels: ctx.runInfo.labels } : {}),
  };
}

/**
 * Fixture values with `${artifacts|requests|evals.…}` resolved. Scalars stay
 * strings (the legacy contract); arrays and objects keep their structure,
 * every string leaf resolved the same way.
 */
function resolveRuntimeFixtures(
  verifier: ScriptVerifier,
  ctx: VerifierContext,
): Record<string, ScriptFixtureValue> {
  const leaf = (value: string): string =>
    resolveFixtureMap({ v: value }, ctx.artifacts, ctx.responses, ctx.evals)[
      "v"
    ] ?? value;
  const deep = (value: unknown): unknown => {
    if (typeof value === "string") return leaf(value);
    if (Array.isArray(value)) return value.map(deep);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => [k, deep(v)]),
      );
    }
    return value;
  };
  const out: Record<string, ScriptFixtureValue> = {};
  for (const [key, value] of Object.entries(verifier.script.fixtures ?? {})) {
    out[key] = deep(value) as ScriptFixtureValue;
  }
  return out;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
