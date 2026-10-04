import { displayUrl } from "./redact";

/**
 * The pure wire half of the Node-side HTTP client behind `kind: http`
 * datasources, the `http` verifier and fixtures: URL joining, credentials,
 * request / reply shaping and the redirect policy. No I/O on purpose: the
 * Playwright export embeds this file's source
 * (src/core/exporters/runtimeSources.ts) and drives the same functions over
 * Playwright's `APIRequestContext`, so an exported `http` verifier sends and
 * judges exactly like `cairn run` does.
 */

export interface HttpReply {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, else the (bounded) text. */
  body: unknown;
  json: boolean;
  bytes: number;
  truncated: boolean;
}

export const MAX_BODY_BYTES = 4 * 1024 * 1024;
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
export function datasourceHeaders(ds: {
  headers?: Record<string, string> | undefined;
  auth?: { basic?: string; bearer?: string } | undefined;
}): Record<string, string> {
  const authorization = authorizationHeader(ds.auth);
  return {
    ...ds.headers,
    ...(authorization ? { Authorization: authorization } : {}),
  };
}

/**
 * Datasource credentials only ever go to the datasource's origin: an absolute
 * URL (written or spliced from ${captures.*}) must stay on baseUrl's origin.
 * The refusal message, or undefined when the call may go ahead.
 */
export function datasourceOriginViolation(
  name: string,
  baseUrl: string,
  path: string,
): string | undefined {
  if (!isAbsoluteUrl(path)) return undefined;
  const origin = urlOrigin(baseUrl);
  if (origin !== undefined && urlOrigin(path) === origin) return undefined;
  return `datasource ${name}: refused a call to ${
    urlOrigin(path) ?? "an unparseable URL"
  } — an absolute URL must stay on baseUrl's origin ${
    origin ? displayUrl(origin) : "(unparseable baseUrl)"
  }; use a path relative to baseUrl, or drop source: to call another host without the datasource's credentials`;
}

/** Default `accept`, a string body as is, anything else as JSON. */
export function prepareHttpRequest(
  callHeaders: Record<string, string> | undefined,
  callBody: unknown,
): { headers: Record<string, string>; body: string | undefined } {
  const headers: Record<string, string> = {
    accept: "application/json, text/plain;q=0.9, */*;q=0.8",
    ...callHeaders,
  };
  let body: string | undefined;
  if (callBody !== undefined) {
    if (typeof callBody === "string") {
      body = callBody;
    } else {
      body = JSON.stringify(callBody);
      if (
        !Object.keys(headers).some((h) => h.toLowerCase() === "content-type")
      ) {
        headers["content-type"] = "application/json";
      }
    }
  }
  return { headers, body };
}

/** The bounded, JSON-parsed reply of a response whose body text is `raw`. */
export function buildHttpReply(
  status: number,
  replyHeaders: Record<string, string>,
  raw: string,
): HttpReply {
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
  return {
    status,
    headers: replyHeaders,
    body: parsed,
    json,
    bytes,
    truncated,
  };
}

/** One hop of a request: what `followRedirects` asks `send` to perform. */
export interface RedirectHop {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | undefined;
}

/** What `send` returns for a hop (`location` is the Location header). */
export interface RedirectReply {
  status: number;
  location: string | null;
}

/**
 * Redirects are followed by hand (at most 5 hops) so credentials never leave
 * the origin they were configured for: a same-origin hop keeps every header;
 * a cross-origin hop drops all caller headers (datasource auth, API keys,
 * spec headers) and is only taken when no body would be re-sent there —
 * otherwise the 3xx reply is returned as-is. `send` must not follow
 * redirects itself; `discard` releases a reply that is not returned.
 */
export async function followRedirects<R extends RedirectReply>(
  send: (hop: RedirectHop) => Promise<R>,
  discard: (reply: R) => Promise<void>,
  url: string,
  method: string,
  headers: Record<string, string>,
  body: string | undefined,
): Promise<R> {
  let currentUrl = url;
  let currentMethod = method;
  let currentHeaders = headers;
  let currentBody = body;
  for (let hop = 0; ; hop++) {
    const response = await send({
      url: currentUrl,
      method: currentMethod,
      headers: currentHeaders,
      body: currentBody,
    });
    const location = response.location;
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
    await discard(response);
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
