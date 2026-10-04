import { DatasourceError } from "./mongo";
import {
  buildHttpReply,
  authorizationHeader,
  followRedirects,
  prepareHttpRequest,
  type HttpReply,
} from "./httpWire";
import { scrubDatasourceText } from "./redact";
import { datasourceSecretValues } from "./resolve";
import type { HttpDatasource } from "./schema";

/**
 * Node-side HTTP for `kind: http` / `kind: temporal` datasources and the
 * `http` verifier. No browser cookies: this is for service APIs, not for
 * the signed-in app session (that is `httpJson` / the `request` step).
 * URL joining, request / reply shaping and the redirect policy live in
 * ./httpWire (shared with the Playwright export).
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
  const { headers, body } = prepareHttpRequest(call.headers, call.body);
  const signal = AbortSignal.any(signals);
  let response: Response;
  try {
    const followed = await followRedirects(
      async (hop) => {
        const res = await fetch(hop.url, {
          method: hop.method,
          headers: hop.headers,
          ...(hop.body !== undefined ? { body: hop.body } : {}),
          signal,
          redirect: "manual",
        });
        return {
          response: res,
          status: res.status,
          location: res.headers.get("location"),
        };
      },
      async (hopReply) => {
        await hopReply.response.body?.cancel().catch(() => undefined);
      },
      call.url,
      call.method ?? "GET",
      headers,
      body,
    );
    response = followed.response;
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
  const replyHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    replyHeaders[key] = value;
  });
  return buildHttpReply(response.status, replyHeaders, raw);
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
