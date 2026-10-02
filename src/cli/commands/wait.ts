import { dirname, isAbsolute, resolve } from "node:path";
import { ZodError } from "zod";
import { findConfigFile } from "../../core/config/loader";
import {
  resolveProjectRuntimeContext,
  UnknownEnvironmentError,
} from "../../core/config/runtimeContext";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import {
  assertGateRefs,
  GateReferenceError,
  waitForGates,
  type GateContext,
} from "../../core/gates/evaluate";
import {
  durationMs,
  HttpStatusMatchSchema,
  isInlineGateString,
  WAIT_RESULT_SCHEMA_ID,
  type GateNode,
  type HttpStatusMatch,
  type WaitResult,
} from "../../core/gates/schema";
import type { GateEvent } from "../../core/schema/events.v1";
import { targetChildEnv } from "../../core/processEnv";
import { emit, resolveFormat } from "../format";
import { log } from "../logger";
import { resolveScopedSecrets } from "./secrets";

/**
 * `cairn wait <gate|url…>` (MCP `cairn_wait`): wait for readiness gates —
 * config `gates:` names, `http(s)://…` URLs (2xx/3xx unless `--status`),
 * `tcp://host:port` — in order, stopping at the first that is not ready.
 * Result `urn:cairntrace.dev:wait:v1`. Exit 0 ready, 1 not ready (failed,
 * timed out or cancelled), 2 error (unreadable config, vault failure), 4
 * invalid input (unknown gate or env, bad --status/--timeout/--every/--stable,
 * invalid config).
 */

interface WaitRequest {
  targets: string[];
  config?: string;
  env?: string;
  /** Accepted statuses for URL targets, e.g. "2xx", "200,401", "200-299". */
  status?: string;
  /** Override every target's budget ("30s", "120000"; 0 = no deadline). */
  timeout?: string | number;
  /** Override the pause between attempts. */
  every?: string | number;
  /** Override the consecutive passes required. */
  stable?: number | string;
  /** Accept any HTTP answer from URL targets. */
  anyResponse?: boolean;
  cwd?: string;
  signal?: AbortSignal;
  /** Live gate.* events (CLI narration, MCP progress). */
  onEvent?: (event: GateEvent) => void;
}

class WaitInputError extends Error {
  constructor(
    message: string,
    readonly exitCode: 2 | 4,
  ) {
    super(message);
  }
}

function parseStatus(raw: string | undefined): HttpStatusMatch | undefined {
  if (raw === undefined || raw.trim() === "") return undefined;
  const tokens = raw
    .split(",")
    .map((token) => token.trim())
    .filter(Boolean)
    .map((token) => (/^\d+$/.test(token) ? Number(token) : token));
  const parsed = HttpStatusMatchSchema.safeParse(tokens);
  if (!parsed.success) {
    throw new WaitInputError(
      `invalid --status "${raw}" (want codes, classes or ranges: 2xx,401,200-299)`,
      4,
    );
  }
  return parsed.data;
}

function parseDuration(
  raw: string | number | undefined,
  flag: string,
): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const value = typeof raw === "number" ? raw : raw.trim();
  try {
    const ms =
      typeof value === "string" && /^\d+$/.test(value)
        ? Number(value)
        : durationMs(value as number | string);
    if (ms === undefined || !Number.isFinite(ms) || ms < 0) throw new Error();
    return ms;
  } catch {
    throw new WaitInputError(
      `invalid ${flag} "${raw}" (milliseconds, or a number with ms|s|m|h)`,
      4,
    );
  }
}

function parseStable(raw: number | string | undefined): number | undefined {
  if (raw === undefined || raw === "") return undefined;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 1_000) {
    throw new WaitInputError(`invalid --stable "${raw}" (1-1000)`, 4);
  }
  return n;
}

interface WaitConfig {
  registry: Readonly<Record<string, GateNode>>;
  configPath?: string;
  configDir?: string;
  env: Record<string, string | undefined>;
  warnings: string[];
}

async function loadWaitConfig(
  req: WaitRequest,
  needsRegistry: boolean,
): Promise<WaitConfig> {
  const cwd = req.cwd ?? process.cwd();
  const baseEnv = targetChildEnv(process.env) as Record<
    string,
    string | undefined
  >;
  // URL and tcp:// targets need nothing from a config: an unrelated (or
  // broken) config above the working directory must not fail a port wait.
  if (!needsRegistry) return { registry: {}, env: baseEnv, warnings: [] };
  const configPath = req.config
    ? isAbsolute(req.config)
      ? req.config
      : resolve(cwd, req.config)
    : await findConfigFile(cwd);
  if (!configPath) {
    throw new WaitInputError(
      `gate names need a cairntrace.config.yml with gates: — none found from ${cwd} upward; pass --config <path> or wait on a URL`,
      4,
    );
  }
  const warnings: string[] = [];
  let env = baseEnv;
  // Gates may reference ${secrets.X}: resolve the env's scoped vault values
  // like a run would; fall back to the plain environment.
  try {
    const scoped = await resolveScopedSecrets(configPath, {
      configPath,
      ...(req.env !== undefined ? { environmentOverride: req.env } : {}),
    });
    env = scoped.childEnv;
  } catch (error) {
    if (error instanceof UnknownEnvironmentError) {
      throw new WaitInputError(error.message, 4);
    }
    warnings.push(
      `scoped secrets unavailable (${(error as Error).message}); gates see the plain environment`,
    );
  }
  try {
    const ctx = await resolveProjectRuntimeContext({
      configPath,
      cwd,
      env,
      ...(req.env !== undefined ? { envOverride: req.env } : {}),
      onWarning: (message) => warnings.push(message),
    });
    return {
      registry: ctx.config?.gates ?? {},
      configPath,
      configDir: dirname(configPath),
      env,
      warnings,
    };
  } catch (error) {
    if (error instanceof UnknownEnvironmentError || error instanceof ZodError) {
      throw new WaitInputError(
        error instanceof ZodError
          ? `invalid config ${configPath}: ${error.issues
              .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
              .join("; ")}`
          : error.message,
        4,
      );
    }
    throw new WaitInputError((error as Error).message, 2);
  }
}

function failed(
  startedAt: number,
  exitCode: 2 | 4,
  error: string,
  config?: string,
): WaitResult {
  return {
    $schema: WAIT_RESULT_SCHEMA_ID,
    version: "1",
    ok: false,
    durationMs: Date.now() - startedAt,
    gates: [],
    exitCode,
    error,
    ...(config ? { config } : {}),
  };
}

/** Wait for the targets; never throws (errors are in the result). */
export async function runWait(req: WaitRequest): Promise<WaitResult> {
  const startedAt = Date.now();
  if (req.targets.length === 0) {
    return failed(
      startedAt,
      4,
      "nothing to wait for: pass a gate name or a URL",
    );
  }
  let overrides: { timeoutMs?: number; everyMs?: number; stable?: number };
  let urlStatus: HttpStatusMatch | undefined;
  try {
    urlStatus = parseStatus(req.status);
    const timeoutMs = parseDuration(req.timeout, "--timeout");
    const everyMs = parseDuration(req.every, "--every");
    const stable = parseStable(req.stable);
    overrides = {
      ...(timeoutMs !== undefined ? { timeoutMs } : {}),
      ...(everyMs !== undefined ? { everyMs } : {}),
      ...(stable !== undefined ? { stable } : {}),
    };
  } catch (error) {
    return failed(
      startedAt,
      (error as WaitInputError).exitCode,
      (error as Error).message,
    );
  }
  const needsRegistry = req.targets.some((t) => !isInlineGateString(t));
  let config: WaitConfig;
  try {
    config = await loadWaitConfig(req, needsRegistry);
  } catch (error) {
    const exitCode = error instanceof WaitInputError ? error.exitCode : 2;
    return failed(startedAt, exitCode, (error as Error).message, req.config);
  }
  const redactor = createArtifactRedactor(undefined, config.env);
  const ctx: GateContext = {
    registry: config.registry,
    env: config.env,
    cwd: req.cwd ?? process.cwd(),
    ...(config.configDir ? { registryCwd: config.configDir } : {}),
    scope: "wait",
    ...(urlStatus ? { urlStatus } : {}),
    ...(req.anyResponse ? { anyResponse: true } : {}),
    ...(req.signal ? { signal: req.signal } : {}),
    redact: (text) => redactor.text(text),
    ...(req.onEvent ? { onEvent: req.onEvent } : {}),
  };
  try {
    assertGateRefs(req.targets, ctx);
  } catch (error) {
    if (error instanceof GateReferenceError) {
      return failed(startedAt, 4, error.message, config.configPath);
    }
    throw error;
  }
  const gates = await waitForGates(req.targets, ctx, overrides);
  const ok =
    gates.length === req.targets.length && gates.every((gate) => gate.ok);
  return {
    $schema: WAIT_RESULT_SCHEMA_ID,
    version: "1",
    ok,
    durationMs: Date.now() - startedAt,
    gates,
    exitCode: ok ? 0 : 1,
    ...(config.configPath ? { config: config.configPath } : {}),
  };
}

function waitMarkdown(result: WaitResult): string {
  const lines = [`# cairn wait — ${result.ok ? "ready" : "not ready"}`, ""];
  if (result.error) lines.push(`error: ${result.error}`, "");
  if (result.gates.length > 0) {
    lines.push(
      "| gate | ok | attempts | duration | last |",
      "|---|---|---|---|---|",
    );
    for (const gate of result.gates) {
      const why = gate.cancelled
        ? " (cancelled)"
        : gate.timedOut
          ? " (timed out)"
          : "";
      lines.push(
        `| ${gate.name} | ${
          gate.ok ? "yes" : `no${why}`
        } | ${gate.attempts} | ${gate.durationMs}ms | ${gate.lastDetail.replace(/\|/g, "\\|")} |`,
      );
    }
    lines.push("");
  }
  lines.push(`exit ${result.exitCode} · ${result.durationMs}ms`);
  return lines.join("\n");
}

interface WaitCommandOptions {
  config?: string;
  env?: string;
  status?: string;
  timeout?: string;
  every?: string;
  stable?: string;
  anyResponse?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function waitCommand(
  targets: string[],
  opts: WaitCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const controller = new AbortController();
  const onSignal = (): void => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  let result: WaitResult;
  try {
    result = await runWait({
      targets,
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.env !== undefined ? { env: opts.env } : {}),
      ...(opts.status !== undefined ? { status: opts.status } : {}),
      ...(opts.timeout !== undefined ? { timeout: opts.timeout } : {}),
      ...(opts.every !== undefined ? { every: opts.every } : {}),
      ...(opts.stable !== undefined ? { stable: opts.stable } : {}),
      ...(opts.anyResponse ? { anyResponse: true } : {}),
      signal: controller.signal,
      // Narrate on stderr (stdout carries only the document).
      onEvent: (event) => {
        if (event.type === "gate.started") {
          log.info(
            `wait: ${event.name} (budget ${
              event.budgetMs > 0 ? `${event.budgetMs}ms` : "none"
            })`,
          );
        } else if (event.type === "gate.attempt" && !event.ok) {
          log.info(
            `wait: ${event.name} attempt ${event.attempt}: ${event.detail}`,
          );
        } else if (event.type === "gate.passed") {
          log.info(
            `wait: ${event.name} ready after ${event.attempts} attempt(s), ${event.durationMs}ms`,
          );
        } else if (event.type === "gate.failed") {
          log.warn(`wait: ${event.name} not ready: ${event.lastDetail}`);
        }
      },
    });
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }
  process.stdout.write(emit(format, result, waitMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  if (result.error) process.stderr.write(`cairn wait: ${result.error}\n`);
  process.exitCode = result.exitCode;
}
