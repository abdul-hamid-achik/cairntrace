import { connect } from "node:net";
import { isAbsolute, resolve } from "node:path";
import { runBoundedCommand } from "../runner/boundedCommand";
import {
  DEFAULT_READY_STATUS,
  type CommandProbe,
  type GateAuth,
  type HttpProbe,
  type HttpStatusMatch,
  type JsonValueMatcher,
  type TcpProbe,
} from "./schema";

/** One attempt of one probe: a verdict plus a short, credential-free line. */
export interface ProbeOutcome {
  ok: boolean;
  detail: string;
  /** HTTP status of the answer, when there was one. */
  status?: number;
}

export interface ProbeContext {
  /** Environment for command probes and `${env.X}` / `${secrets.X}` refs. */
  env?: Record<string, string | undefined>;
  /** Base directory for command probes (config dir, or the spec's dir). */
  cwd?: string;
  signal?: AbortSignal;
}

const DEFAULT_TCP_TIMEOUT_MS = 2_000;
const DEFAULT_HTTP_TIMEOUT_MS = 5_000;
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;
const MAX_BODY_BYTES = 256 * 1024;
const MAX_DETAIL_CHARS = 300;

/* ----- tcp ----- */

function tcpTarget(probe: TcpProbe): { host: string; port: number } {
  if (typeof probe !== "string") return { host: probe.host, port: probe.port };
  const idx = probe.lastIndexOf(":");
  const host = probe.slice(0, idx).replace(/^\[(.*)\]$/, "$1");
  return { host, port: Number(probe.slice(idx + 1)) };
}

export async function probeTcp(
  probe: TcpProbe,
  budgetMs: number,
  signal?: AbortSignal,
): Promise<ProbeOutcome> {
  const { host, port } = tcpTarget(probe);
  const label = `tcp ${host.includes(":") ? `[${host}]` : host}:${port}`;
  if (port < 1 || port > 65_535) {
    return { ok: false, detail: `${label}: invalid port` };
  }
  const timeoutMs = Math.max(
    50,
    Math.min(
      typeof probe === "string"
        ? DEFAULT_TCP_TIMEOUT_MS
        : (probe.timeoutMs ?? DEFAULT_TCP_TIMEOUT_MS),
      budgetMs,
    ),
  );
  return new Promise<ProbeOutcome>((resolveProbe) => {
    let settled = false;
    const socket = connect({ host, port });
    const finish = (outcome: ProbeOutcome): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolveProbe(outcome);
    };
    const onAbort = (): void =>
      finish({ ok: false, detail: `${label}: cancelled` });
    const timer = setTimeout(
      () =>
        finish({ ok: false, detail: `${label}: no answer in ${timeoutMs}ms` }),
      timeoutMs,
    );
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    socket.once("connect", () => finish({ ok: true, detail: `${label} open` }));
    socket.once("error", (error: NodeJS.ErrnoException) =>
      finish({
        ok: false,
        detail: `${label}: ${error.code ?? error.message}`,
      }),
    );
  });
}

/* ----- http ----- */

/** `scheme://host[:port]/path` — userinfo, query and fragment removed. */
export function displayUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return raw.replace(/\/\/[^/@]*@/, "//").replace(/[?#].*$/, "");
  }
}

function statusTokenMatches(token: number | string, status: number): boolean {
  if (typeof token === "number") return status === token;
  if (/^[1-5]xx$/.test(token)) {
    return Math.floor(status / 100) === Number(token[0]);
  }
  const [low, high] = token.split("-").map(Number);
  return high === undefined ? status === low : status >= low! && status <= high;
}

/** Does `status` satisfy the matcher (default 2xx/3xx)? */
export function statusMatches(
  status: number,
  match: HttpStatusMatch = DEFAULT_READY_STATUS,
): boolean {
  const tokens = Array.isArray(match) ? match : [match];
  return tokens.some((token) => statusTokenMatches(token, status));
}

function describeStatusMatch(
  match: HttpStatusMatch = DEFAULT_READY_STATUS,
): string {
  return (Array.isArray(match) ? match : [match]).join("|");
}

/**
 * Resolve `${env.X}` / `${secrets.X}` (and `${env.X:-default}`) from the
 * probe environment. Returns the names that were not set.
 */
export function resolveSecretRefs(
  value: string,
  env: Record<string, string | undefined> = {},
): { value: string; missing: string[] } {
  const missing: string[] = [];
  const resolved = value.replace(
    /\$\{(?:env|secrets)\.([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
    (_match, name: string, fallback: string | undefined) => {
      const found = env[name];
      if (found !== undefined && found !== "") return found;
      if (fallback !== undefined) return fallback;
      missing.push(name);
      return "";
    },
  );
  return { value: resolved, missing };
}

/**
 * Why a 401/403 may be the config's fault: `${env.X}` is substituted when
 * the config LOADS (an unset variable becomes ""), so an empty credential
 * usually means a variable that was not exported. Never names a value.
 */
const EMPTY_CREDENTIAL_HINT =
  'an unset ${env.X} becomes "" when the config loads — use ${secrets.X}, which resolves when the gate runs';

function authHeader(
  auth: GateAuth,
  env: Record<string, string | undefined> | undefined,
): { header?: string; missing: string[]; empty?: string } {
  if (auth.bearer !== undefined) {
    const token = resolveSecretRefs(auth.bearer, env);
    return {
      header: `Bearer ${token.value}`,
      missing: token.missing,
      ...(token.value === "" ? { empty: "the bearer token is empty" } : {}),
    };
  }
  const basic = auth.basic!;
  let user: { value: string; missing: string[] };
  let pass: { value: string; missing: string[] };
  if (typeof basic === "string") {
    const pair = resolveSecretRefs(basic, env);
    const colon = pair.value.indexOf(":");
    user = {
      value: colon < 0 ? pair.value : pair.value.slice(0, colon),
      missing: pair.missing,
    };
    pass = { value: colon < 0 ? "" : pair.value.slice(colon + 1), missing: [] };
  } else {
    user = resolveSecretRefs(basic.username, env);
    pass = resolveSecretRefs(basic.password, env);
  }
  const empty =
    user.value === ""
      ? "the basic-auth username is empty"
      : pass.value === ""
        ? "the basic-auth password is empty"
        : undefined;
  return {
    header: `Basic ${Buffer.from(`${user.value}:${pass.value}`, "utf8").toString("base64")}`,
    missing: [...user.missing, ...pass.missing],
    ...(empty ? { empty } : {}),
  };
}

async function readBoundedBody(res: Response): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      chunks.push(value);
      total += value.byteLength;
      if (total >= MAX_BODY_BYTES) break;
    }
  } finally {
    void reader.cancel().catch(() => undefined);
  }
  return Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES).toString("utf8");
}

/** Read a dotted path (`a.b.0.c`, `items.length`; optional `$.` prefix). */
export function readJsonPath(
  value: unknown,
  path: string,
): {
  found: boolean;
  value?: unknown;
} {
  const keys = path
    .replace(/^\$\.?/, "")
    .split(".")
    .filter(Boolean);
  let current: unknown = value;
  for (const key of keys) {
    if (
      key === "length" &&
      (Array.isArray(current) || typeof current === "string")
    ) {
      current = current.length;
      continue;
    }
    if (current !== null && typeof current === "object" && key in current) {
      current = (current as Record<string, unknown>)[key];
      continue;
    }
    return { found: false };
  }
  return { found: true, value: current };
}

function sameScalar(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // YAML authors write `status: 200` against a JSON "200" and vice versa.
  return (
    (typeof a === "number" || typeof a === "string") &&
    (typeof b === "number" || typeof b === "string") &&
    String(a) === String(b)
  );
}

/** Why `actual` fails the matcher, or undefined when it matches. */
export function jsonMismatch(
  matcher: JsonValueMatcher,
  lookup: { found: boolean; value?: unknown },
): string | undefined {
  const shown = (v: unknown): string =>
    v === undefined ? "missing" : truncate(JSON.stringify(v), 60);
  if (matcher === null || typeof matcher !== "object") {
    if (!lookup.found) return "missing";
    return sameScalar(lookup.value, matcher)
      ? undefined
      : `got ${shown(lookup.value)} (want ${JSON.stringify(matcher)})`;
  }
  if (matcher.exists !== undefined) {
    if (matcher.exists !== lookup.found) {
      return matcher.exists ? "missing" : `present (${shown(lookup.value)})`;
    }
    if (!lookup.found) return undefined;
  }
  if (!lookup.found) return "missing";
  const actual = lookup.value;
  if (matcher.equals !== undefined && !sameScalar(actual, matcher.equals)) {
    return `got ${shown(actual)} (want ${JSON.stringify(matcher.equals)})`;
  }
  if (matcher.in && !matcher.in.some((option) => sameScalar(actual, option))) {
    return `got ${shown(actual)} (want one of ${matcher.in.map((v) => JSON.stringify(v)).join(", ")})`;
  }
  if (matcher.contains !== undefined) {
    const contained = Array.isArray(actual)
      ? actual.some((item) => sameScalar(item, matcher.contains))
      : typeof actual === "string" && actual.includes(String(matcher.contains));
    if (!contained) {
      return `got ${shown(actual)} (want it to contain ${JSON.stringify(matcher.contains)})`;
    }
  }
  if (matcher.matches !== undefined) {
    let re: RegExp;
    try {
      re = new RegExp(matcher.matches);
    } catch {
      return `invalid regex ${JSON.stringify(matcher.matches)}`;
    }
    if (typeof actual !== "string" || !re.test(actual)) {
      return `got ${shown(actual)} (want /${matcher.matches}/)`;
    }
  }
  const numeric: Array<
    [keyof typeof matcher, (a: number, b: number) => boolean, string]
  > = [
    ["gt", (a, b) => a > b, ">"],
    ["gte", (a, b) => a >= b, ">="],
    ["lt", (a, b) => a < b, "<"],
    ["lte", (a, b) => a <= b, "<="],
  ];
  for (const [key, test, symbol] of numeric) {
    const bound = matcher[key];
    if (typeof bound !== "number") continue;
    const n = typeof actual === "number" ? actual : Number(actual);
    if (!Number.isFinite(n) || !test(n, bound)) {
      return `got ${shown(actual)} (want ${symbol} ${bound})`;
    }
  }
  return undefined;
}

export async function probeHttp(
  probe: HttpProbe,
  budgetMs: number,
  /** Status rule for the string form (default 2xx/3xx). */
  /** Accept any HTTP answer (legacy readiness). */
  ctx: ProbeContext & {
    defaultStatus?: HttpStatusMatch;
    anyResponse?: boolean;
  } = {},
): Promise<ProbeOutcome> {
  const spec = typeof probe === "string" ? { url: probe } : probe;
  const method = spec.method ?? "GET";
  const label = `${method} ${displayUrl(spec.url)}`;
  const statusRule = spec.status ?? ctx.defaultStatus ?? DEFAULT_READY_STATUS;
  const timeoutMs = Math.max(
    50,
    Math.min(spec.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS, budgetMs),
  );
  // A fresh connection per attempt: readiness means a NEW client gets in,
  // and a pooled keep-alive socket can stall the next probe for 100s of ms.
  const headers: Record<string, string> = { connection: "close" };
  const missing: string[] = [];
  for (const [name, raw] of Object.entries(spec.headers ?? {})) {
    const resolved = resolveSecretRefs(raw, ctx.env);
    headers[name] = resolved.value;
    missing.push(...resolved.missing);
  }
  let emptyCredential: string | undefined;
  if (spec.auth) {
    const auth = authHeader(spec.auth, ctx.env);
    if (auth.header) headers["authorization"] = auth.header;
    missing.push(...auth.missing);
    emptyCredential = auth.empty;
  }
  if (missing.length > 0) {
    return {
      ok: false,
      detail: `${label}: ${[...new Set(missing)].join(", ")} not set`,
    };
  }
  const signals = [AbortSignal.timeout(timeoutMs)];
  if (ctx.signal) signals.push(ctx.signal);
  let res: Response;
  try {
    res = await fetch(spec.url, {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    if (ctx.signal?.aborted)
      return { ok: false, detail: `${label}: cancelled` };
    const cause = (error as { cause?: { code?: string } }).cause;
    const reason =
      (error as Error).name === "TimeoutError"
        ? `no answer in ${timeoutMs}ms`
        : (cause?.code ?? (error as Error).message);
    return { ok: false, detail: `${label}: ${truncate(reason, 120)}` };
  }
  const status = res.status;
  const needsBody = spec.json !== undefined || spec.text !== undefined;
  const body = needsBody
    ? await readBoundedBody(res).catch(() => "")
    : (void res.body?.cancel().catch(() => undefined), "");
  if (!ctx.anyResponse && !statusMatches(status, statusRule)) {
    const hint =
      emptyCredential && (status === 401 || status === 403)
        ? `; ${emptyCredential} (${EMPTY_CREDENTIAL_HINT})`
        : "";
    return {
      ok: false,
      status,
      detail: `${label} → ${status} (want ${describeStatusMatch(statusRule)})${hint}`,
    };
  }
  if (spec.text !== undefined && !body.includes(spec.text)) {
    return {
      ok: false,
      status,
      detail: `${label} → ${status}, body lacks ${JSON.stringify(truncate(spec.text, 40))}`,
    };
  }
  if (spec.json) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return {
        ok: false,
        status,
        detail: `${label} → ${status}, body is not JSON`,
      };
    }
    for (const [path, matcher] of Object.entries(spec.json)) {
      const why = jsonMismatch(matcher, readJsonPath(parsed, path));
      if (why) {
        return {
          ok: false,
          status,
          detail: `${label} → ${status}, ${path}: ${why}`,
        };
      }
    }
  }
  return { ok: true, status, detail: `${label} → ${status}` };
}

/* ----- command ----- */

export async function probeCommand(
  probe: CommandProbe,
  budgetMs: number,
  ctx: ProbeContext = {},
): Promise<ProbeOutcome> {
  const spec = typeof probe === "string" ? { run: probe } : probe;
  const label = `command ${JSON.stringify(truncate(spec.run, 60))}`;
  const timeoutMs = Math.max(
    50,
    Math.min(spec.timeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS, budgetMs),
  );
  const base = ctx.cwd ?? process.cwd();
  const cwd = spec.cwd
    ? isAbsolute(spec.cwd)
      ? spec.cwd
      : resolve(base, spec.cwd)
    : base;
  if (ctx.signal?.aborted) return { ok: false, detail: `${label}: cancelled` };
  // Its own process group, killed at the deadline, on cancel and once the
  // shell exits: a probe never leaves processes behind, and a background
  // process holding stdout cannot stretch the attempt. The caller's env is
  // the complete (already filtered) child environment.
  const result = await runBoundedCommand("/bin/sh", ["-c", spec.run], {
    cwd,
    env: { ...(ctx.env ?? process.env), ...spec.env },
    timeoutMs,
    ownProcessGroup: true,
    killLeftovers: true,
    maxBufferBytes: 1024 * 1024,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  if (result.cancelled) return { ok: false, detail: `${label}: cancelled` };
  if (result.timedOut) {
    return { ok: false, detail: `${label}: timed out after ${timeoutMs}ms` };
  }
  if (result.spawnError) {
    return {
      ok: false,
      detail: `${label}: ${truncate(result.spawnError, 160)}`,
    };
  }
  const output = result.all;
  const lastLine =
    output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) ?? "";
  const exitCode = result.exitCode ?? -1;
  if (result.exitCode === undefined && result.exitSignal) {
    return {
      ok: false,
      detail: `${label} killed by ${result.exitSignal}${
        lastLine ? `: ${truncate(lastLine, 160)}` : ""
      }`,
    };
  }
  const accepted =
    spec.exitCode === undefined
      ? [0]
      : Array.isArray(spec.exitCode)
        ? spec.exitCode
        : [spec.exitCode];
  const tail = lastLine ? `: ${truncate(lastLine, 160)}` : "";
  if (!accepted.includes(exitCode)) {
    return { ok: false, detail: `${label} exit ${exitCode}${tail}` };
  }
  if (spec.stdout !== undefined && !output.includes(spec.stdout)) {
    return {
      ok: false,
      detail: `${label} exit ${exitCode}, output lacks ${JSON.stringify(truncate(spec.stdout, 40))}`,
    };
  }
  return { ok: true, detail: `${label} exit ${exitCode}` };
}

export function truncate(text: string, max = MAX_DETAIL_CHARS): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}
