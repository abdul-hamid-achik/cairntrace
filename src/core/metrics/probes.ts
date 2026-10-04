import {
  asNumber,
  isMultiValuePath,
  readPath,
} from "../runner/verifiers/matchers";
import { runBoundedCommand } from "../runner/boundedCommand";
import { httpCall, HttpCallError } from "../datasources/http";
import { authorizationHeader } from "../datasources/httpWire";
import { scrubDatasourceText } from "../datasources/redact";
import { lookupVar, renderVarValue } from "../config/varValue";
import type { MetricReducer, NormalizedProbe } from "./schema";

/**
 * One sample of one metric probe: run the command (or GET the URL), read
 * one number out of the answer. Everything is bounded by the probe's
 * timeout and by the caller's abort signal; a failure comes back as an
 * `error` string (redacted, never a raw value or output) — it never throws.
 */

export interface ProbeEnvironment {
  /** `${env.X}` / `${secrets.X}` source: the run's scoped environment. */
  placeholderEnv: Readonly<Record<string, string | undefined>>;
  /** `${vars.X}` source: the environment's effective vars. */
  vars: Readonly<Record<string, unknown>>;
  /** The complete child environment of a command probe. */
  childEnv: NodeJS.ProcessEnv;
  /** Working directory of a command probe (the config directory). */
  cwd: string;
  /** Redacts free text (registered secrets, credential-shaped values). */
  redact: (text: string) => string;
}

export interface ProbeOutcome {
  value?: number;
  error?: string;
  durationMs: number;
}

/** Longest error message kept. */
const MAX_ERROR_CHARS = 240;
const MAX_STDOUT_BYTES = 1024 * 1024;

class ProbeError extends Error {}

const PLACEHOLDER =
  /\$\{(secrets|env|vars)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)(?::-([^}]*))?\}/g;

/**
 * Resolve `${secrets.X}`, `${env.X[:-default]}` and `${vars.X[.path]}` in
 * one string. An unset reference without a default is an error: probing
 * "" instead of the intended server would be worse than failing. Secret
 * and env values are collected so error text can be scrubbed.
 */
export function resolveProbeText(
  text: string,
  env: Pick<ProbeEnvironment, "placeholderEnv" | "vars">,
  secrets: string[],
): string {
  return text.replace(
    PLACEHOLDER,
    (match, ns: string, key: string, fallback: string | undefined) => {
      if (ns === "vars") {
        const hit = lookupVar(env.vars, key);
        if (hit.found) return renderVarValue(hit.value);
        if (fallback !== undefined) return fallback;
        throw new ProbeError(`\${vars.${key}} is not defined`);
      }
      if (key.includes(".")) return match;
      const value = env.placeholderEnv[key];
      if (value === undefined || value === "") {
        if (fallback !== undefined) return fallback;
        throw new ProbeError(`\${${ns}.${key}} is not set`);
      }
      // An env value is scrubbed like a secret (it may be a token, a tenant
      // or a path the config chose not to write down) unless it is too short
      // to scrub without mangling the message.
      if (ns === "secrets" || value.length >= 4) secrets.push(value);
      return value;
    },
  );
}

/** Flatten nested arrays (a wildcard over a wildcard) into one list. */
function flatten(value: unknown): unknown[] {
  return Array.isArray(value) ? value.flatMap(flatten) : [value];
}

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

/** Combine matched values with `reduce` (or take the one value). */
export function readJsonNumber(
  document: unknown,
  path: string,
  reduce: MetricReducer | undefined,
): number {
  const found = readPath(document, path);
  if (!found.exists) throw new ProbeError(`json path ${path} matched nothing`);
  const multi = isMultiValuePath(path);
  const values = multi ? flatten(found.value) : [found.value];
  if (reduce === "count") return values.length;
  if (reduce === undefined) {
    if (multi) {
      throw new ProbeError(
        `json path ${path} selects ${values.length} value(s): set reduce (sum, max, min or count)`,
      );
    }
    const single = asNumber(values[0]);
    if (single === undefined) {
      throw new ProbeError(
        `json path ${path} is not a number (got ${typeOf(values[0])})`,
      );
    }
    return single;
  }
  const numbers: number[] = [];
  for (const value of values) {
    const n = asNumber(value);
    if (n === undefined) {
      throw new ProbeError(
        `json path ${path} holds a non-number (got ${typeOf(value)}); reduce ${reduce} needs numbers`,
      );
    }
    numbers.push(n);
  }
  if (reduce === "sum") return numbers.reduce((a, b) => a + b, 0);
  if (numbers.length === 0) {
    throw new ProbeError(
      `json path ${path} matched no values to reduce (${reduce})`,
    );
  }
  return reduce === "max" ? Math.max(...numbers) : Math.min(...numbers);
}

/** The number a `{ regex }` parse captures from `text`. */
export function readRegexNumber(
  text: string,
  pattern: string,
  group: number | undefined,
): number {
  const match = new RegExp(pattern, "m").exec(text);
  if (!match) {
    throw new ProbeError(
      `regex did not match the output (${Buffer.byteLength(text, "utf8")} bytes)`,
    );
  }
  const index = group ?? (match.length > 1 ? 1 : 0);
  const captured = match[index];
  if (captured === undefined) {
    throw new ProbeError(`regex has no capture group ${index}`);
  }
  const n = asNumber(captured.trim());
  if (n === undefined)
    throw new ProbeError("the captured text is not a number");
  return n;
}

function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text.trim());
  } catch {
    throw new ProbeError("the command output is not JSON");
  }
}

/**
 * The URL without query, fragment and userinfo, for evidence. A template
 * (`${vars.base}/stats?token=${secrets.T}`) is shown as written, cut the
 * same way: it holds placeholders, never their values.
 */
export function displayTarget(url: string): string {
  // A template keeps its placeholders readable (URL() would encode them).
  if (!url.includes("${")) {
    try {
      const parsed = new URL(url);
      return `${parsed.origin}${parsed.pathname}`;
    } catch {
      // not a URL: cut it the same way below
    }
  }
  return url.replace(/[?#].*$/s, "").replace(/\/\/[^/@]*@/, "//");
}

export interface RunProbeOptions {
  /** Extra `CAIRN_*` values for a command probe (run dir, run id…). */
  extraEnv?: Readonly<Record<string, string>>;
  /** Aborts the sample (cancel, end of an `every` scope). */
  signal?: AbortSignal;
}

/** Take one sample of `normalized`. Never throws. */
export async function runProbe(
  normalized: NormalizedProbe,
  env: ProbeEnvironment,
  options: RunProbeOptions = {},
): Promise<ProbeOutcome> {
  const startedAt = Date.now();
  const { probe, timeoutMs } = normalized;
  const secrets: string[] = [];
  const clean = (text: string): string => {
    const scrubbed = env.redact(scrubDatasourceText(text, secrets));
    return scrubbed.length > MAX_ERROR_CHARS
      ? `${scrubbed.slice(0, MAX_ERROR_CHARS)}…`
      : scrubbed;
  };
  try {
    if (options.signal?.aborted) throw new ProbeError("cancelled");
    let value: number;
    if (probe.command !== undefined) {
      const parse = probe.parse!;
      const run = await runBoundedCommand("/bin/sh", ["-c", probe.command], {
        cwd: env.cwd,
        env: { ...env.childEnv, ...options.extraEnv },
        timeoutMs,
        ...(options.signal ? { signal: options.signal } : {}),
        ownProcessGroup: true,
        killLeftovers: true,
        maxBufferBytes: MAX_STDOUT_BYTES,
      });
      if (run.cancelled) throw new ProbeError("cancelled");
      if (run.spawnError)
        throw new ProbeError(`could not start: ${run.spawnError}`);
      if (run.timedOut) throw new ProbeError(`timed out after ${timeoutMs}ms`);
      if (run.exitCode !== 0) {
        const tail = run.stderr.trim().split("\n").pop() ?? "";
        throw new ProbeError(
          `command exited ${run.exitCode ?? run.exitSignal ?? "abnormally"}${
            tail ? `: ${tail.slice(-160)}` : ""
          }`,
        );
      }
      value =
        "json" in parse
          ? readJsonNumber(parseJsonText(run.stdout), parse.json, parse.reduce)
          : readRegexNumber(run.stdout, parse.regex, parse.group);
    } else {
      const http = probe.http!;
      const url = resolveProbeText(http.url, env, secrets);
      const headers: Record<string, string> = {};
      for (const [name, text] of Object.entries(http.headers ?? {})) {
        const resolved = resolveProbeText(text, env, secrets);
        headers[name] = resolved;
        if (resolved.length >= 4) secrets.push(resolved);
      }
      if (http.auth) {
        const auth = {
          ...(http.auth.bearer
            ? { bearer: resolveProbeText(http.auth.bearer, env, secrets) }
            : {}),
          ...(http.auth.basic
            ? { basic: resolveProbeText(http.auth.basic, env, secrets) }
            : {}),
        };
        const header = authorizationHeader(auth);
        if (header) {
          headers["Authorization"] = header;
          secrets.push(auth.bearer ?? auth.basic ?? "");
          secrets.push(header);
        }
      }
      const reply = await httpCall(
        {
          url,
          headers,
          deadline: Date.now() + timeoutMs,
          ...(options.signal ? { signal: options.signal } : {}),
        },
        secrets.filter((s) => s.length >= 4),
      );
      if (reply.status < 200 || reply.status > 299) {
        // The template (placeholders, not their values) names the source.
        throw new ProbeError(
          `${displayTarget(http.url)} answered HTTP ${reply.status}`,
        );
      }
      if (!reply.json) throw new ProbeError("the response is not JSON");
      value = readJsonNumber(reply.body, http.json.path, http.json.reduce);
    }
    if (!Number.isFinite(value))
      throw new ProbeError("the value is not finite");
    return { value, durationMs: Date.now() - startedAt };
  } catch (error) {
    const known = error instanceof ProbeError || error instanceof HttpCallError;
    return {
      error: clean(
        known
          ? (error as Error).message
          : `probe failed: ${(error as Error).message}`,
      ),
      durationMs: Date.now() - startedAt,
    };
  }
}
