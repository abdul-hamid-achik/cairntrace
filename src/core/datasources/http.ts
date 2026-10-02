import { DatasourceError } from "./mongo";
import { scrubDatasourceText } from "./redact";
import { datasourceSecretValues } from "./resolve";
import type { HttpDatasource } from "./schema";

/**
 * Node-side HTTP for `kind: http` / `kind: temporal` datasources and the
 * `http` verifier. No browser cookies: this is for service APIs, not for
 * the signed-in app session (that is `httpJson` / the `request` step).
 */

export interface HttpCall {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  /** Epoch ms after which the request is aborted. */
  deadline: number;
  signal?: AbortSignal;
}

export interface HttpReply {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, else the (bounded) text. */
  body: unknown;
  json: boolean;
  bytes: number;
  truncated: boolean;
}

/**
 * An HTTP failure: `status` is set for a response, absent for transport
 * errors. `permanent` (auth / bad request) stops a poll loop at once.
 */
export class HttpCallError extends DatasourceError {
  constructor(
    message: string,
    readonly status?: number,
    readonly transient = status === undefined || status >= 500,
    permanent = false,
  ) {
    super(message, { permanent });
    this.name = "HttpCallError";
  }
}

const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_REDIRECTS = 5;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export function authorizationHeader(
  auth: { basic?: string; bearer?: string } | undefined,
): string | undefined {
  if (!auth) return undefined;
  if (auth.bearer) return `Bearer ${auth.bearer}`;
  if (auth.basic) {
    // `user:password` is encoded; a value without ":" is taken as already
    // base64-encoded credentials.
    return `Basic ${
      auth.basic.includes(":")
        ? Buffer.from(auth.basic, "utf8").toString("base64")
        : auth.basic
    }`;
  }
  return undefined;
}

const ABSOLUTE_URL = /^[a-z][a-z0-9+.-]*:\/\//i;

export function isAbsoluteUrl(url: string): boolean {
  return ABSOLUTE_URL.test(url);
}

/** `base` + `path` with exactly one slash between them; absolute URLs win. */
export function joinBaseUrl(base: string, path: string): string {
  if (isAbsoluteUrl(path)) return path;
  return `${base.replace(/\/+$/, "")}/${path.replace(/^\/+/, "")}`;
}

/** `scheme://host:port` of a URL, or undefined when it does not parse. */
export function urlOrigin(url: string): string | undefined {
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** Headers an `http` datasource adds to every call. */
export function datasourceHeaders(ds: HttpDatasource): Record<string, string> {
  const authorization = authorizationHeader(ds.auth);
  return {
    ...ds.headers,
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

export function httpDatasourceSecrets(ds: HttpDatasource): string[] {
  const values = datasourceSecretValues(ds);
  const authorization = authorizationHeader(ds.auth);
  if (authorization) values.push(authorization.replace(/^\w+ /, ""));
  return values;
}

export async function httpCall(
  call: HttpCall,
  secrets: readonly string[] = [],
): Promise<HttpReply> {
  const remaining = call.deadline - Date.now();
  const scrub = (text: string): string => scrubDatasourceText(text, secrets);
  if (remaining <= 0) {
    throw new HttpCallError(
      scrub(`deadline exhausted before ${call.method ?? "GET"} ${call.url}`),
    );
  }
  const signals = [AbortSignal.timeout(remaining)];
  if (call.signal) signals.push(call.signal);
  const headers: Record<string, string> = {
    accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    ...call.headers,
  };
  let body: string | undefined;
  if (call.body !== undefined) {
    if (typeof call.body === "string") {
      body = call.body;
    } else {
      body = JSON.stringify(call.body);
      if (
        !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")
      ) {
        headers["content-type"] = "application/json";
      }
    }
  }
  let response: Response;
  try {
    response = await fetchFollowingRedirects(
      call.url,
      call.method ?? "GET",
      headers,
      body,
      AbortSignal.any(signals),
    );
  } catch (error) {
    const reason =
      (error as Error).name === "TimeoutError"
        ? `timed out after ${remaining}ms`
        : (error as Error).name === "AbortError"
          ? "cancelled"
          : ((error as { cause?: { code?: string } }).cause?.code ??
            (error as Error).message);
    throw new HttpCallError(
      scrub(`${call.method ?? "GET"} ${call.url} failed: ${reason}`),
    );
  }
  const raw = await response.text().catch(() => "");
  const bytes = Buffer.byteLength(raw, "utf8");
  const truncated = bytes > MAX_BODY_BYTES;
  const text = truncated ? raw.slice(0, MAX_BODY_BYTES) : raw;
  let parsed: unknown = text;
  let json = false;
  if (!truncated && text.trim().length > 0) {
    try {
      parsed = JSON.parse(text);
      json = true;
    } catch {
      parsed = text;
    }
  }
  const replyHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    replyHeaders[key] = value;
  });
  return {
    status: response.status,
    headers: replyHeaders,
    body: parsed,
    json,
    bytes,
    truncated,
  };
}

/**
 * Redirects are followed by hand (at most 5 hops) so credentials never leave
 * the origin they were configured for: a same-origin hop keeps every header;
 * a cross-origin hop drops all caller headers (datasource auth, API keys,
 * spec headers) and is only taken when no body would be re-sent there —
 * otherwise the 3xx reply is returned as-is.
 */
async function fetchFollowingRedirects(
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
  signal: AbortSignal,
): Promise<Response> {
  let currentUrl = url;
  let currentMethod = method;
  let currentHeaders = headers;
  let currentBody = body;
  for (let hop = 0; ; hop++) {
    const response = await fetch(currentUrl, {
      method: currentMethod,
      headers: currentHeaders,
      ...(currentBody !== undefined ? { body: currentBody } : {}),
      signal,
      redirect: "manual",
    });
    const location = response.headers.get("location");
    if (
      !REDIRECT_STATUSES.has(response.status) ||
      !location ||
      hop >= MAX_REDIRECTS
    ) {
      return response;
    }
    let next: URL;
    try {
      next = new URL(location, currentUrl);
    } catch {
      return response;
    }
    if (next.protocol !== "http:" && next.protocol !== "https:") {
      return response;
    }
    const keepsMethod = response.status === 307 || response.status === 308;
    const nextMethod =
      keepsMethod || currentMethod === "GET" || currentMethod === "HEAD"
        ? currentMethod
        : "GET";
    const nextBody = keepsMethod ? currentBody : undefined;
    const crossOrigin = next.origin !== new URL(currentUrl).origin;
    if (crossOrigin && nextBody !== undefined) return response;
    await response.body?.cancel().catch(() => undefined);
    let nextHeaders = currentHeaders;
    if (crossOrigin) {
      nextHeaders = {};
      for (const [key, value] of Object.entries(currentHeaders)) {
        if (key.toLowerCase() === "accept") nextHeaders[key] = value;
      }
    } else if (nextBody === undefined && currentBody !== undefined) {
      nextHeaders = Object.fromEntries(
        Object.entries(currentHeaders).filter(
          ([key]) => key.toLowerCase() !== "content-type",
        ),
      );
    }
    currentUrl = next.href;
    currentMethod = nextMethod;
    currentHeaders = nextHeaders;
    currentBody = nextBody;
  }
}

/**
 * Retry transport failures and 5xx replies (bounded by the deadline);
 * everything else — including 404 — is returned to the caller.
 */
export async function httpCallWithRetry(
  call: HttpCall,
  secrets: readonly string[] = [],
  attempts = 3,
): Promise<HttpReply> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const reply = await httpCall(call, secrets);
      if (reply.status < 500 || attempt === attempts) return reply;
      lastError = new HttpCallError(
        scrubDatasourceText(
          `${call.method ?? "GET"} ${call.url} → ${reply.status}`,
          secrets,
        ),
        reply.status,
      );
    } catch (error) {
      if (!(error instanceof HttpCallError) || !error.transient) throw error;
      if (call.signal?.aborted) throw error;
      lastError = error;
    }
    const backoff = 250 * attempt;
    if (call.deadline - Date.now() <= backoff) break;
    await new Promise((resolve) => setTimeout(resolve, backoff));
  }
  throw lastError;
}
