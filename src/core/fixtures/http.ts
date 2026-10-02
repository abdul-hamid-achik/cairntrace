import { httpCall, joinBaseUrl, type HttpReply } from "../datasources/http";
import { scrubDatasourceText } from "../datasources/redact";
import { statusMatches } from "../gates/probes";
import type { HttpStatusMatch } from "../gates/schema";
import {
  matchPaths,
  readPath,
  show,
  summarizeReport,
} from "../runner/verifiers/matchers";
import {
  HTTP_READ_METHODS,
  type HttpFixture,
  type HttpFixtureRequest,
  type HttpVerb,
} from "./schema";
import {
  FixtureVerbError,
  remainingMs,
  type FixtureVerbContext,
  type FixtureVerbOutcome,
} from "./types";

/**
 * `kind: http` fixtures: find-or-create by natural key against an `http`
 * datasource (base URL, headers, auth) or a base URL (default: the
 * environment's), with an optional login helper whose token is sent on
 * every later request. Outputs are read from the verb result by JSONPath:
 * `$.item…` (the found or created item), `$.created`, `$.owned` (created,
 * or found carrying the owner marker), `$.<as>…` (a named response body)
 * and `$.last…`. With an owner marker, `find` prefers the items that carry
 * it. A `verify` only sends GET/HEAD (the login helper aside).
 */

type Caller = (request: {
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: unknown;
}) => Promise<HttpReply>;

const DEFAULT_STATUS: HttpStatusMatch = "2xx";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function caller(ctx: FixtureVerbContext, fixture: HttpFixture): Caller {
  const signalOpts = ctx.signal ? { signal: ctx.signal } : {};
  if (fixture.datasource !== undefined) {
    const source = (() => {
      try {
        return ctx.datasources.http(fixture.datasource!);
      } catch (error) {
        throw new FixtureVerbError((error as Error).message);
      }
    })();
    for (const secret of source.secrets) ctx.secrets.add(secret);
    return (request) =>
      source.call(
        {
          path: request.path,
          method: request.method,
          headers: request.headers,
          ...(request.body !== undefined ? { body: request.body } : {}),
        },
        { deadline: ctx.deadline, ...signalOpts },
      );
  }
  const base = fixture.baseUrl ?? ctx.baseUrl;
  if (!base) {
    throw new FixtureVerbError(
      `http fixture ${ctx.name} has no base URL: set datasource or baseUrl, or give the environment a baseUrl`,
    );
  }
  return (request) =>
    httpCall(
      {
        url: joinBaseUrl(base, request.path),
        method: request.method,
        headers: request.headers,
        ...(request.body !== undefined ? { body: request.body } : {}),
        deadline: ctx.deadline,
        ...signalOpts,
      },
      [...ctx.secrets],
    );
}

function describeBody(body: unknown): string {
  return show(body, 160);
}

async function send(
  call: Caller,
  ctx: FixtureVerbContext,
  label: string,
  request: {
    method?: string;
    path: string;
    headers?: Record<string, string>;
    body?: unknown;
    status?: HttpStatusMatch;
  },
  headers: Record<string, string>,
): Promise<HttpReply> {
  const method = (request.method ?? "GET").toUpperCase();
  if (
    ctx.verb === "verify" &&
    label !== "login" &&
    !HTTP_READ_METHODS.includes(method)
  ) {
    throw new FixtureVerbError(
      `verify is read-only: refused ${label} ${method} ${request.path} (${HTTP_READ_METHODS.join(" or ")} only)`,
    );
  }
  let reply: HttpReply;
  try {
    reply = await call({
      method,
      path: request.path,
      headers: { ...headers, ...request.headers },
      ...(request.body !== undefined ? { body: request.body } : {}),
    });
  } catch (error) {
    throw new FixtureVerbError(
      scrubDatasourceText(`${label}: ${(error as Error).message}`, [
        ...ctx.secrets,
      ]),
      remainingMs(ctx.deadline) <= 0,
    );
  }
  const accepted = request.status ?? DEFAULT_STATUS;
  if (!statusMatches(reply.status, accepted)) {
    throw new FixtureVerbError(
      scrubDatasourceText(
        `${label}: ${method} ${request.path} → ${reply.status} (want ${
          Array.isArray(accepted) ? accepted.join("|") : accepted
        }): ${describeBody(reply.body)}`,
        [...ctx.secrets],
      ),
    );
  }
  return reply;
}

async function login(
  call: Caller,
  ctx: FixtureVerbContext,
  fixture: HttpFixture,
  headers: Record<string, string>,
): Promise<Record<string, string>> {
  const spec = fixture.login;
  if (!spec) return headers;
  const reply = await send(
    call,
    ctx,
    "login",
    { ...spec, method: spec.method ?? "POST" },
    headers,
  );
  const tokenPath = spec.token ?? "$.token";
  const hit = readPath(reply.body, tokenPath);
  if (!hit.exists || typeof hit.value !== "string" || hit.value === "") {
    throw new FixtureVerbError(
      `login: no token at ${tokenPath} in the login response (status ${reply.status})`,
    );
  }
  ctx.secrets.add(hit.value);
  const scheme = spec.scheme ?? "Bearer";
  return {
    ...headers,
    [spec.header ?? "Authorization"]: scheme
      ? `${scheme} ${hit.value}`
      : hit.value,
  };
}

function candidates(
  body: unknown,
  itemsPath: string | undefined,
): unknown[] | undefined {
  if (itemsPath === undefined) return Array.isArray(body) ? body : [body];
  const hit = readPath(body, itemsPath);
  return hit.exists && Array.isArray(hit.value) ? hit.value : undefined;
}

/** The item carries every marker field (top level, deep-equal). */
function carriesMarker(
  item: unknown,
  marker: Record<string, unknown> | undefined,
): boolean {
  if (!marker || !isPlainObject(item)) return false;
  return Object.entries(marker).every(
    ([key, value]) => JSON.stringify(item[key]) === JSON.stringify(value),
  );
}

function withMarker(
  body: unknown,
  marker: Record<string, unknown> | undefined,
) {
  if (!marker || !isPlainObject(body)) return body;
  return { ...body, ...marker };
}

function verbObject(verb: HttpVerb): Exclude<HttpVerb, HttpFixtureRequest[]> {
  return Array.isArray(verb) ? { requests: verb } : verb;
}

export async function runHttpVerb(
  ctx: FixtureVerbContext,
): Promise<FixtureVerbOutcome> {
  const fixture = ctx.fixture as HttpFixture;
  const verb = verbObject(ctx.verbDef as HttpVerb);
  const bounded: FixtureVerbContext =
    verb.timeoutMs !== undefined
      ? {
          ...ctx,
          deadline: Math.min(ctx.deadline, Date.now() + verb.timeoutMs),
        }
      : ctx;
  if (ctx.verb === "verify" && verb.create !== undefined) {
    throw new FixtureVerbError("verify is read-only: refused create");
  }
  const call = caller(bounded, fixture);
  let headers: Record<string, string> = { ...fixture.headers };
  headers = await login(call, bounded, fixture, headers);
  const result: Record<string, unknown> = {};
  const details: string[] = [];
  if (verb.find) {
    const find = verb.find;
    const lookup = async (): Promise<unknown[]> => {
      const reply = await send(call, bounded, "find", find, headers);
      const list = candidates(reply.body, find.items);
      if (!list) {
        throw new FixtureVerbError(
          `find: ${find.items ?? "the body"} is not a list in the response of ${find.path}`,
        );
      }
      const hits = list.filter((item) => matchPaths(item, find.where).passed);
      // Records this fixture created (they carry the marker) come first.
      const marker = ctx.marker as Record<string, unknown> | undefined;
      return marker
        ? [
            ...hits.filter((item) => carriesMarker(item, marker)),
            ...hits.filter((item) => !carriesMarker(item, marker)),
          ]
        : hits;
    };
    let matches = await lookup();
    if (matches.length > 1 && ctx.exactlyOne) {
      throw new FixtureVerbError(
        `find: owner.exactlyOne — ${matches.length} items match ${describeWhere(find.where)}`,
      );
    }
    result["found"] = matches.length;
    if (matches.length > 0) {
      result["item"] = matches[0];
      result["created"] = false;
      // Found, not created: it is ours only when it carries the marker.
      result["owned"] = carriesMarker(
        matches[0],
        ctx.marker as Record<string, unknown> | undefined,
      );
      details.push("found existing");
    } else if (verb.create) {
      const create = verb.create;
      const reply = await send(
        call,
        bounded,
        "create",
        {
          ...create,
          method: create.method ?? "POST",
          ...(create.body !== undefined
            ? {
                body: withMarker(
                  create.body,
                  ctx.marker as Record<string, unknown>,
                ),
              }
            : {}),
        },
        headers,
      );
      if (create.as) result[create.as] = reply.body;
      const created = readPath(reply.body, create.item ?? "$");
      result["item"] = created.exists ? created.value : reply.body;
      result["created"] = true;
      result["owned"] = true;
      details.push("created");
      if (verb.refind) {
        matches = await lookup();
        if (matches.length > 1 && ctx.exactlyOne) {
          throw new FixtureVerbError(
            `find (after create): owner.exactlyOne — ${matches.length} items match ${describeWhere(find.where)}`,
          );
        }
        if (matches.length === 0) {
          throw new FixtureVerbError(
            `find (after create): the created item does not match ${describeWhere(find.where)}`,
          );
        }
        result["item"] = matches[0];
      }
    } else {
      throw new FixtureVerbError(
        `find: nothing matches ${describeWhere(find.where)} at ${find.path}`,
      );
    }
  }
  for (const [index, request] of (verb.requests ?? []).entries()) {
    const label = request.as ?? `request ${index + 1}`;
    const reply = await send(call, bounded, label, request, headers);
    if (request.expect) {
      const report = matchPaths(reply.body, request.expect);
      if (!report.passed) {
        const summary = summarizeReport(report);
        throw new FixtureVerbError(
          scrubDatasourceText(
            `${label}: expected ${summary.expected}; actual ${summary.actual}`,
            [...ctx.secrets],
          ),
        );
      }
    }
    if (request.as) result[request.as] = reply.body;
    result["last"] = reply.body;
    details.push(
      `${(request.method ?? "GET").toUpperCase()} ${request.path} → ${reply.status}`,
    );
  }
  return { result, detail: details.join("; ") };
}

function describeWhere(where: Record<string, unknown>): string {
  return Object.entries(where)
    .map(([path, matcher]) => `${path}=${show(matcher, 60)}`)
    .join(", ");
}
