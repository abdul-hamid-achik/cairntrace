import type {
  BackendRequest,
  BrowserBackend,
  NetworkEntry,
} from "../../adapters/browserBackend";
import { safeExcerpt } from "../artifacts/excerpt";
import { MIN_DERIVED_SECRET_CHARS } from "../artifacts/redaction";
import { isSensitiveName } from "../catalog/mask";
import {
  DEFAULT_REQUEST_RETRY_DELAY_MS,
  DEFAULT_REQUEST_UNTIL_EVERY_MS,
  DEFAULT_REQUEST_UNTIL_TIMEOUT_MS,
  MATRIX_REF_RE,
  type RequestCapture,
  type RequestCredentials,
  type RequestMatrix,
  type RequestRetry,
  type RequestStatusList,
  type RequestUntil,
} from "../schema/request.v1";
import type { RequestStep } from "../schema/spec.v1";
import { isRelativeUrl, joinUrl, resolveUrl } from "./url";
import {
  isMultiValuePath,
  matchPaths,
  readPath,
  summarizeReport,
} from "./verifiers/matchers";

/**
 * The typed `request` step: one call through the backend's out-of-page
 * request primitive (or the bounded page-fetch fallback), plus the v2 layer
 * — `credentials`, `retry`, `until` polling, `capture` and `matrix`. Kept
 * out of Runner.ts so the step loop only dispatches; the environment
 * `auth:` executor (envAuth.ts) sends its requests through here too.
 */

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

/** The captured envelope a request step produces (`requests/<name>.json`). */
export interface RequestResponse {
  url: string;
  method: string;
  status: number;
  ok: boolean;
  headers: Record<string, string>;
  body: unknown;
  id?: string;
  /** v2 `capture`: `${requests.<name>.captures.<key>}`. */
  captures?: Record<string, unknown>;
  /** v2 `retry` / `until`: how many requests were sent (when more than one). */
  attempts?: number;
  /**
   * v2 `matrix`: one entry per combination. `status` / `ok` of the envelope
   * then summarize: the last combination's status, and whether every
   * combination matched `expectStatus`.
   */
  matrix?: MatrixResult[];
}

export interface MatrixResult {
  /** The combination's values, by matrix key. */
  values: Record<string, unknown>;
  method: string;
  url: string;
  status: number;
  /** False when the status is not in `expectStatus` or the call failed. */
  matched: boolean;
  error?: string;
}

export type RequestStepResult =
  | { ok: true; assign: string; response: RequestResponse }
  | {
      ok: false;
      error: string;
      /** Evidence worth keeping although the step failed (matrix, until). */
      assign?: string;
      response?: RequestResponse;
    };

export interface RequestRunOptions {
  step: RequestStep;
  backend: BrowserBackend;
  /** 1-based step number: an unassigned response is `request_<n>`. */
  requestIndex: number;
  /**
   * The name of an unassigned response (default `request_<requestIndex>`):
   * a request nested in a control-flow block gets one derived from its
   * place, so iterations and siblings never share a file or a binding.
   */
  defaultAssign?: string;
  baseUrl?: string;
  /** A cancel stops polling, retries and the matrix between requests. */
  signal?: AbortSignal;
  /**
   * Values that must never reach artifacts: sensitive header values sent,
   * response fields under credential-like keys, sensitive captures.
   */
  registerSecrets?: (values: string[]) => void;
  /** Injectable for tests. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

type Request = RequestStep["request"];

/** One concrete call (templates spliced, URL absolute). */
interface Call {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  credentials: RequestCredentials;
}

type SendResult =
  | { kind: "response"; response: RequestResponse }
  | { kind: "transport"; error: string };

/**
 * Execute a `request` step through the backend's out-of-page request
 * primitive when available, falling back to a bounded page-context fetch.
 */
export async function runRequestStep(
  opts: RequestRunOptions,
): Promise<RequestStepResult> {
  const req = opts.step.request;
  const assign =
    req.assign ?? opts.defaultAssign ?? `request_${opts.requestIndex}`;
  if (req.matrix) return runMatrix(opts, req, req.matrix, assign);

  const resolved = await resolveRequestUrl(req.url, opts);
  if (!resolved.ok) return resolved;
  const call: Call = {
    method: req.method,
    url: resolved.url,
    ...(req.headers ? { headers: req.headers } : {}),
    ...(req.body !== undefined ? { body: req.body } : {}),
    timeoutMs: req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    credentials: req.credentials ?? "include",
  };
  registerHeaderSecrets(call.headers, opts.registerSecrets);

  let response: RequestResponse;
  let attempts: number;
  if (req.until) {
    const polled = await pollUntil(opts, call, req.until);
    if (!polled.ok) {
      return {
        ok: false,
        error: polled.error,
        ...(polled.last
          ? {
              assign,
              response: {
                ...polled.last,
                ...(polled.attempts > 1 ? { attempts: polled.attempts } : {}),
              },
            }
          : {}),
      };
    }
    response = polled.response;
    attempts = polled.attempts;
  } else {
    const sent = await sendWithRetry(opts, call, req.retry);
    if (sent.result.kind === "transport") {
      return {
        ok: false,
        error: `request failed: ${sent.result.error} (${call.method} ${call.url})${attemptsSuffix(sent.attempts)}`,
      };
    }
    response = sent.result.response;
    attempts = sent.attempts;
  }
  registerResponseSecrets(response.body, opts.registerSecrets);
  if (attempts > 1) response = { ...response, attempts };

  if (req.capture) {
    const captured = captureValues(response.body, req.capture);
    if (!captured.ok) {
      return {
        ok: false,
        error: `${captured.error} (${call.method} ${call.url})`,
      };
    }
    registerCaptureSecrets(captured.values, opts.registerSecrets);
    response = { ...response, captures: captured.values };
  }

  if (
    req.expectStatus !== undefined &&
    !statusIn(response.status, req.expectStatus)
  ) {
    // Masked and never cut inside a string: a token straddling the cut would
    // otherwise leave its prefix in the step error (and every artifact).
    const bodyExcerpt = safeExcerpt(response.body, 300);
    return {
      ok: false,
      error: `request status ${response.status} not in expectStatus [${statusList(req.expectStatus).join(", ")}] (${call.method} ${call.url})${attemptsSuffix(attempts)} body: ${bodyExcerpt}`,
    };
  }
  return { ok: true, assign, response };
}

/* ----- one call ----- */

async function sendOnce(
  opts: RequestRunOptions,
  call: Call,
): Promise<SendResult> {
  const backend = opts.backend;
  if (typeof backend.request === "function") {
    const request: BackendRequest = {
      method: call.method,
      url: call.url,
      ...(call.headers ? { headers: call.headers } : {}),
      ...(call.body !== undefined ? { body: call.body } : {}),
      timeoutMs: call.timeoutMs,
      ...(call.credentials === "omit" ? { credentials: "omit" as const } : {}),
    };
    const answered = await backend.request(request);
    if (!answered.ok) {
      return { kind: "transport", error: answered.error ?? "unknown error" };
    }
    return {
      kind: "response",
      response: {
        url: call.url,
        method: call.method,
        status: answered.status,
        ok: answered.status >= 200 && answered.status < 400,
        headers: answered.headers,
        body: answered.body,
      },
    };
  }

  const origin = await ensureRequestOrigin(backend, call.url);
  if (!origin.ok) return { kind: "transport", error: origin.error };
  // The script carries the headers and body (a bearer, a password): it must
  // not travel in a process argv where other local users can read it.
  const result = await backend.evaluate(buildRequestScript(call), {
    timeoutMs: call.timeoutMs,
    sensitive: true,
  });
  if (!result.ok) {
    return {
      kind: "transport",
      error: `eval failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    };
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {
      kind: "transport",
      error: `non-JSON eval output: ${result.stdout.slice(0, 200)}`,
    };
  }
  if (parsed && typeof parsed["requestError"] === "string") {
    return { kind: "transport", error: parsed["requestError"] };
  }
  return {
    kind: "response",
    response: {
      url: call.url,
      method: call.method,
      status: typeof parsed["status"] === "number" ? parsed["status"] : 0,
      ok: Boolean(parsed["ok"]),
      headers:
        parsed["headers"] && typeof parsed["headers"] === "object"
          ? (parsed["headers"] as Record<string, string>)
          : {},
      body: parsed["body"],
    },
  };
}

/* ----- retry ----- */

async function sendWithRetry(
  opts: RequestRunOptions,
  call: Call,
  retry: RequestRetry | undefined,
): Promise<{ result: SendResult; attempts: number }> {
  const on = new Set(retry?.on ?? ["5xx", "network"]);
  const maxAttempts = 1 + (retry?.times ?? 0);
  const sleep = opts.sleep ?? abortableSleep;
  let attempts = 0;
  for (;;) {
    attempts++;
    const result = await sendOnce(opts, call);
    const retryable =
      result.kind === "transport"
        ? on.has("network")
        : on.has("5xx") && result.response.status >= 500;
    if (!retryable || attempts >= maxAttempts || opts.signal?.aborted) {
      return { result, attempts };
    }
    await sleep(retry?.delayMs ?? DEFAULT_REQUEST_RETRY_DELAY_MS, opts.signal);
    if (opts.signal?.aborted) return { result, attempts };
  }
}

/* ----- until ----- */

async function pollUntil(
  opts: RequestRunOptions,
  call: Call,
  until: RequestUntil,
): Promise<
  | { ok: true; response: RequestResponse; attempts: number }
  | {
      ok: false;
      error: string;
      attempts: number;
      last?: RequestResponse;
    }
> {
  const now = opts.now ?? Date.now;
  const sleep = opts.sleep ?? abortableSleep;
  const budgetMs = until.timeoutMs ?? DEFAULT_REQUEST_UNTIL_TIMEOUT_MS;
  const everyMs = until.every ?? DEFAULT_REQUEST_UNTIL_EVERY_MS;
  const started = now();
  const deadline = started + budgetMs;
  let attempts = 0;
  let last: RequestResponse | undefined;
  let why = "no attempt finished";
  for (;;) {
    if (attempts > 0 && opts.signal?.aborted) {
      return {
        ok: false,
        error: "request cancelled",
        attempts,
        ...(last ? { last } : {}),
      };
    }
    attempts++;
    const remaining = Math.max(1, deadline - now());
    const result = await sendOnce(opts, {
      ...call,
      timeoutMs: Math.min(call.timeoutMs, remaining),
    });
    if (result.kind === "transport") {
      why = `request failed: ${result.error}`;
    } else {
      // Every answer may be persisted (the last one when the poll runs out):
      // its credential-like fields are scrubbed whether or not it passes.
      registerResponseSecrets(result.response.body, opts.registerSecrets);
      last = result.response;
      const verdict = untilHolds(result.response, until);
      if (verdict.holds) {
        return { ok: true, response: result.response, attempts };
      }
      why = verdict.why;
    }
    if (now() + everyMs >= deadline) {
      return {
        ok: false,
        error: `request until not satisfied after ${attempts} attempt(s) in ${now() - started}ms (${call.method} ${call.url}): ${why}`,
        attempts,
        ...(last ? { last } : {}),
      };
    }
    await sleep(everyMs, opts.signal);
  }
}

/** Whether a response satisfies `until` (status and every json matcher). */
export function untilHolds(
  response: Pick<RequestResponse, "status" | "body">,
  until: Pick<RequestUntil, "status" | "json">,
): { holds: true } | { holds: false; why: string } {
  if (until.status !== undefined && !statusIn(response.status, until.status)) {
    return {
      holds: false,
      why: `status ${response.status} not in [${statusList(until.status).join(", ")}]`,
    };
  }
  if (until.json) {
    let report;
    try {
      report = matchPaths(response.body, until.json);
    } catch (e) {
      return { holds: false, why: (e as Error).message };
    }
    if (!report.passed) {
      const summary = summarizeReport(report);
      // What the answer held, as a credential-safe excerpt (it reaches the
      // step error): a credential-named leaf is masked, long or token-shaped
      // strings are shown by length, and nothing is cut inside a string.
      const got = report.results
        .filter((result) => !result.passed)
        .map((result) => {
          let read: { exists: boolean; value: unknown };
          try {
            read = readPath(response.body, result.path);
          } catch {
            read = { exists: false, value: undefined };
          }
          const leaf =
            result.path
              .split(/[.[\]'"]/)
              .filter(Boolean)
              .at(-1) ?? "";
          const shown = !read.exists
            ? "missing"
            : isSensitiveName(leaf)
              ? "[redacted]"
              : safeExcerpt(read.value, 160);
          return `${result.path || "$"}=${shown}`;
        })
        .join("; ");
      return {
        holds: false,
        why: `expected ${summary.expected}; got ${got}`,
      };
    }
  }
  return { holds: true };
}

/* ----- capture ----- */

/**
 * Read `capture` paths from a response body. A wildcard or filter path
 * captures its first match; a path that matches nothing is an error.
 */
export function captureValues(
  body: unknown,
  capture: RequestCapture,
):
  | { ok: true; values: Record<string, unknown> }
  | { ok: false; error: string } {
  const values: Record<string, unknown> = {};
  for (const [key, path] of Object.entries(capture)) {
    let read;
    let multi;
    try {
      read = readPath(body, path);
      multi = isMultiValuePath(path);
    } catch (e) {
      return { ok: false, error: `capture ${key}: ${(e as Error).message}` };
    }
    const value =
      multi && Array.isArray(read.value) ? read.value[0] : read.value;
    if (!read.exists || value === undefined) {
      return {
        ok: false,
        error: `capture ${key}: ${path} matched nothing in the response body (${safeExcerpt(body, 160)})`,
      };
    }
    values[key] = value;
  }
  return { ok: true, values };
}

/* ----- matrix ----- */

async function runMatrix(
  opts: RequestRunOptions,
  req: Request,
  matrix: RequestMatrix,
  assign: string,
): Promise<RequestStepResult> {
  const combinations = matrixCombinations(matrix);
  const results: MatrixResult[] = [];
  let lastStatus = 0;
  for (const values of combinations) {
    if (opts.signal?.aborted) {
      return { ok: false, error: "request cancelled" };
    }
    const splice = (value: unknown): unknown => spliceMatrix(value, values);
    const method = String(splice(req.method)).toUpperCase();
    const rawUrl = String(splice(req.url));
    const resolved = await resolveRequestUrl(rawUrl, opts);
    if (!resolved.ok) return resolved;
    const headers = req.headers
      ? (splice(req.headers) as Record<string, string>)
      : undefined;
    // A whole `${matrix.route.body}` the combination does not set sends none.
    const body = req.body !== undefined ? splice(req.body) : undefined;
    const call: Call = {
      method,
      url: resolved.url,
      ...(headers ? { headers: stringRecord(headers) } : {}),
      ...(body !== undefined ? { body } : {}),
      timeoutMs: req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
      credentials: req.credentials ?? "include",
    };
    registerHeaderSecrets(call.headers, opts.registerSecrets);
    const sent = await sendWithRetry(opts, call, req.retry);
    if (sent.result.kind === "transport") {
      results.push({
        values,
        method,
        url: call.url,
        status: 0,
        matched: false,
        error: sent.result.error,
      });
      continue;
    }
    const status = sent.result.response.status;
    lastStatus = status;
    registerResponseSecrets(sent.result.response.body, opts.registerSecrets);
    results.push({
      values,
      method,
      url: call.url,
      status,
      matched:
        req.expectStatus === undefined || statusIn(status, req.expectStatus),
    });
  }
  const mismatches = results.filter((result) => !result.matched);
  const response: RequestResponse = {
    url: req.url,
    method: req.method,
    status: lastStatus,
    ok: mismatches.length === 0,
    headers: {},
    body: null,
    matrix: results,
  };
  if (mismatches.length === 0) return { ok: true, assign, response };
  const shown = mismatches
    .slice(0, 10)
    .map(
      (result) =>
        `${describeCombination(result.values)} → ${
          result.error ? `failed: ${result.error}` : result.status
        }`,
    );
  const more =
    mismatches.length > shown.length
      ? `; … ${mismatches.length - shown.length} more in requests/${assign}.json`
      : "";
  const expected =
    req.expectStatus === undefined
      ? "a response"
      : `expectStatus [${statusList(req.expectStatus).join(", ")}]`;
  return {
    ok: false,
    error: `request matrix: ${mismatches.length}/${results.length} combination(s) did not match ${expected}: ${shown.join("; ")}${more}`,
    assign,
    response,
  };
}

/** The cartesian product of a matrix, keys in authored order. */
export function matrixCombinations(
  matrix: RequestMatrix,
): Array<Record<string, unknown>> {
  let out: Array<Record<string, unknown>> = [{}];
  for (const [key, values] of Object.entries(matrix)) {
    out = out.flatMap((partial) =>
      values.map((value) => ({ ...partial, [key]: value })),
    );
  }
  return out;
}

/**
 * Splice `${matrix.<key>[.path]}` into every string of a value. A string
 * that is exactly one reference keeps the referenced value's type.
 */
export function spliceMatrix(
  value: unknown,
  values: Record<string, unknown>,
): unknown {
  if (typeof value === "string") {
    const whole =
      /^\$\{matrix\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\}$/.exec(
        value,
      );
    if (whole) return matrixValue(values, whole[1]!, whole[2] ?? "");
    return value.replace(MATRIX_REF_RE, (_match, key: string, path: string) => {
      const found = matrixValue(values, key, path);
      if (found === undefined || found === null) return "";
      return typeof found === "object" ? JSON.stringify(found) : String(found);
    });
  }
  if (Array.isArray(value))
    return value.map((item) => spliceMatrix(item, values));
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = spliceMatrix(item, values);
    }
    return out;
  }
  return value;
}

function matrixValue(
  values: Record<string, unknown>,
  key: string,
  path: string,
): unknown {
  const root = values[key];
  if (!path) return root;
  const read = readPath(root, path.slice(1));
  return read.exists ? read.value : undefined;
}

function describeCombination(values: Record<string, unknown>): string {
  return Object.entries(values)
    .map(
      ([key, value]) =>
        `${key}=${
          isSensitiveName(key) ? "[redacted]" : safeExcerpt(value, 80)
        }`,
    )
    .join(", ");
}

function stringRecord(value: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined || item === null) continue;
    out[key] = typeof item === "string" ? item : JSON.stringify(item);
  }
  return out;
}

/* ----- status helpers ----- */

function statusList(expected: RequestStatusList): number[] {
  return Array.isArray(expected) ? expected : [expected];
}

function statusIn(status: number, expected: RequestStatusList): boolean {
  return statusList(expected).includes(status);
}

function attemptsSuffix(attempts: number): string {
  return attempts > 1 ? ` after ${attempts} attempts` : "";
}

/* ----- secrets ----- */

function register(
  values: string[],
  sink: RequestRunOptions["registerSecrets"],
): void {
  // Shorter values are not registered on their own ("1" is not a secret);
  // key-based masking still covers them in structured evidence.
  const kept = values.filter(
    (value) => value.trim().length >= MIN_DERIVED_SECRET_CHARS,
  );
  if (sink && kept.length > 0) sink(kept);
}

/**
 * A sensitive header (`Authorization`, `Cookie`, `X-Api-Key`, …) carries a
 * credential: its value — and the token after a `Bearer ` / `Basic `
 * scheme — is scrubbed from every later artifact.
 */
function registerHeaderSecrets(
  headers: Record<string, string> | undefined,
  sink: RequestRunOptions["registerSecrets"],
): void {
  if (!headers || !sink) return;
  const values: string[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (!isSensitiveName(name)) continue;
    values.push(value);
    const scheme = /^[A-Za-z][\w-]*\s+(\S.*)$/.exec(value);
    if (scheme) values.push(scheme[1]!);
  }
  register(values, sink);
}

/** String leaves under credential-like keys of a response body. */
function registerResponseSecrets(
  body: unknown,
  sink: RequestRunOptions["registerSecrets"],
): void {
  if (!sink) return;
  const values: string[] = [];
  const walk = (node: unknown, sensitive: boolean, depth: number): void => {
    if (depth > 8) return;
    if (typeof node === "string") {
      if (sensitive) values.push(node);
      return;
    }
    if (Array.isArray(node)) {
      for (const item of node) walk(item, sensitive, depth + 1);
      return;
    }
    if (node !== null && typeof node === "object") {
      for (const [key, item] of Object.entries(node)) {
        walk(item, sensitive || isSensitiveName(key), depth + 1);
      }
    }
  };
  walk(body, false, 0);
  register(values, sink);
}

function registerCaptureSecrets(
  captures: Record<string, unknown>,
  sink: RequestRunOptions["registerSecrets"],
): void {
  if (!sink) return;
  const values: string[] = [];
  for (const [key, value] of Object.entries(captures)) {
    if (isSensitiveName(key) && typeof value === "string") values.push(value);
  }
  register(values, sink);
}

/* ----- URL + origin + fallback script ----- */

export async function resolveRequestUrl(
  url: string,
  opts: { baseUrl?: string; backend: BrowserBackend },
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!isRelativeUrl(url)) return { ok: true, url };
  if (opts.baseUrl) return { ok: true, url: joinUrl(opts.baseUrl, url) };

  const currentUrl = await opts.backend.getUrl().catch(() => "about:blank");
  if (currentUrl === "about:blank" || currentUrl.startsWith("about:blank")) {
    return {
      ok: false,
      error: `request: relative URL "${url}" needs a baseUrl (config environments.<env>.baseUrl) or a prior open`,
    };
  }
  return { ok: true, url: resolveUrl(currentUrl, url) };
}

async function ensureRequestOrigin(
  backend: BrowserBackend,
  requestUrl: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const currentUrl = await backend.getUrl().catch(() => "about:blank");
  if (!(currentUrl === "about:blank" || currentUrl.startsWith("about:blank"))) {
    return { ok: true };
  }
  if (!/^https?:\/\//i.test(requestUrl)) return { ok: true };

  let origin: string;
  try {
    origin = new URL(requestUrl).origin;
  } catch {
    return { ok: true };
  }

  const opened = await backend.runStep({ open: origin });
  if (!opened.ok) {
    return {
      ok: false,
      error: `could not establish app origin ${origin} before fetch: ${
        opened.stderr.trim() ||
        opened.stdout.trim() ||
        `exit ${opened.exitCode}`
      }`,
    };
  }
  return { ok: true };
}

/** The bounded in-page fetch backends without a native request run. */
function buildRequestScript(call: Call): string {
  const headers: Record<string, string> = { ...call.headers };
  let bodyExpr: string | undefined;
  if (call.body !== undefined) {
    if (typeof call.body === "string") {
      bodyExpr = JSON.stringify(call.body);
    } else {
      bodyExpr = JSON.stringify(JSON.stringify(call.body));
      const hasContentType = Object.keys(headers).some(
        (h) => h.toLowerCase() === "content-type",
      );
      if (!hasContentType) headers["content-type"] = "application/json";
    }
  }
  return [
    `(async () => {`,
    `  try {`,
    `    const res = await fetch(${JSON.stringify(call.url)}, {`,
    `      method: ${JSON.stringify(call.method)},`,
    `      credentials: ${JSON.stringify(call.credentials)},`,
    `      headers: ${JSON.stringify(headers)},`,
    ...(bodyExpr !== undefined ? [`      body: ${bodyExpr},`] : []),
    `      signal: AbortSignal.timeout(${call.timeoutMs}),`,
    `    });`,
    `    const text = await res.text();`,
    `    let body = null;`,
    `    try { body = JSON.parse(text); } catch (_) { body = text; }`,
    `    const headers = {};`,
    `    res.headers.forEach((v, k) => { headers[k] = v; });`,
    `    return { status: res.status, ok: res.ok, headers, body };`,
    `  } catch (e) {`,
    `    return { requestError: String((e && e.message) || e) };`,
    `  }`,
    `})()`,
  ].join("\n");
}

/** A network-postcondition match as a request envelope (`assign`). */
export function networkMatchToResponse(entry: NetworkEntry): RequestResponse {
  let body: unknown;
  if (entry.postData) {
    try {
      body = JSON.parse(entry.postData);
    } catch {
      body = entry.postData;
    }
  }
  const status = entry.status ?? 0;
  return {
    url: entry.url,
    method: entry.method,
    status,
    ok: status >= 200 && status < 400,
    headers: {},
    body: body ?? null,
    ...(entry.id ? { id: entry.id } : {}),
  };
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolveSleep) => {
    if (signal?.aborted) {
      resolveSleep();
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      resolveSleep();
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
