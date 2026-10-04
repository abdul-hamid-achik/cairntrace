import { createDatasourceSession, type HttpReply } from "../../datasources";
import { httpCall } from "../../datasources/http";
import { joinBaseUrl } from "../../datasources/httpWire";
import type { HttpVerifier } from "../../schema/verifier.v1";
import { isRelativeUrl, joinUrl } from "../url";
import { boundValue, redactHeaders, redactUrl } from "./evidence";
import type { PollRunner } from "./mongo";
import { resolveRefsDeep } from "./refs";
import { judgeHttp } from "./responseJudge";
import type { VerifierContext, VerifierEvaluation } from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

/**
 * `http` verifier: a Node-side request (no browser cookies) against a
 * `kind: http` datasource or a plain URL; asserts status and JSON paths.
 */
export async function evaluateHttp(
  verifier: HttpVerifier,
  ctx: VerifierContext,
  run: PollRunner,
): Promise<VerifierEvaluation> {
  const spec = verifier.http;
  const method = spec.method ?? "GET";
  const refs = resolveRefsDeep(
    {
      url: spec.url,
      ...(spec.headers ? { headers: spec.headers } : {}),
      ...(spec.body !== undefined ? { body: spec.body } : {}),
      // Matcher operands may splice runtime values too.
      ...(spec.expect?.json ? { json: spec.expect.json } : {}),
    },
    ctx,
  );
  const judged: HttpVerifier["http"] =
    spec.expect?.json && refs.value.json
      ? {
          ...spec,
          expect: {
            ...spec.expect,
            json: refs.value.json as NonNullable<
              HttpVerifier["http"]["expect"]
            >["json"],
          },
        }
      : spec;
  const url = String(refs.value.url);
  const headers = refs.value.headers as Record<string, string> | undefined;
  const body = refs.value.body;
  const baseRequest = {
    method,
    ...(headers ? { headers: redactHeaders(headers) } : {}),
    ...(body !== undefined ? { body: boundValue(body).value } : {}),
  };
  if (refs.missing.length > 0) {
    return {
      passed: false,
      expected: `${method} ${spec.url} with resolved references`,
      actual: `unresolved ${refs.missing.join(", ")}`,
      raw: { kind: "http", request: { ...baseRequest, url: spec.url } },
    };
  }

  const session = createDatasourceSession(ctx.datasources, {
    ...(ctx.childEnv ? { env: ctx.childEnv } : {}),
    ...(ctx.vars ? { vars: ctx.vars } : {}),
    ...(ctx.envName ? { envName: ctx.envName } : {}),
  });
  let shownUrl = url;
  let source: Record<string, unknown> | undefined;
  let reply: HttpReply | undefined;
  try {
    const polled = await run(async ({ deadline }) => {
      const callDeadline = Math.min(
        deadline,
        Date.now() + (spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      );
      const signal = ctx.signal ? { signal: ctx.signal } : {};
      if (spec.source) {
        const http = session.http(spec.source);
        source = { ...http.descriptor };
        shownUrl = joinBaseUrl(http.descriptor.baseUrl, url);
        reply = await http.call(
          {
            path: url,
            method,
            ...(headers ? { headers } : {}),
            ...(body !== undefined ? { body } : {}),
          },
          { deadline: callDeadline, ...signal },
        );
      } else {
        const absolute = isRelativeUrl(url)
          ? ctx.baseUrl
            ? joinUrl(ctx.baseUrl, url)
            : undefined
          : url;
        if (!absolute) {
          throw Object.assign(
            new Error(
              `relative URL "${url}" needs source: <http datasource> or an environment baseUrl`,
            ),
            { permanent: true },
          );
        }
        shownUrl = absolute;
        reply = await httpCall({
          url: absolute,
          method,
          ...(headers ? { headers } : {}),
          ...(body !== undefined ? { body } : {}),
          deadline: callDeadline,
          ...signal,
        });
      }
      return judgeHttp(judged.expect, method, shownUrl, reply);
    });
    if (spec.assign && reply) {
      ctx.captures ??= {};
      ctx.captures[spec.assign] = { status: reply.status, body: reply.body };
    }
    const observedBody = reply ? boundValue(reply.body) : undefined;
    return {
      ...polled,
      raw: {
        kind: "http",
        ...(source ? { source } : {}),
        request: { ...baseRequest, url: redactUrl(shownUrl) },
        ...(reply && observedBody
          ? {
              observed: {
                status: reply.status,
                body: observedBody.value,
                bytes: reply.bytes,
                truncated: observedBody.truncated || reply.truncated,
              },
            }
          : {}),
        ...(polled.attemptLog ? { attempts: polled.attemptLog } : {}),
        ...(polled.polledMs !== undefined ? { polledMs: polled.polledMs } : {}),
      },
    };
  } finally {
    await session.close();
  }
}
