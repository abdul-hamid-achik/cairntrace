/**
 * The exported `http` verifier (Playwright's APIRequestContext) against the
 * runner's Node-side one, over real local servers: credentials, header
 * precedence, redirect policy (same origin keeps headers, cross origin drops
 * them), bodies and their content types, non-JSON replies, size, timeouts,
 * refused connections and secret scrubbing must all agree.
 */
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { resolveEnvironmentDatasources } from "../datasources/resolve";
import { DatasourcesConfigSchema } from "../datasources/schema";
import { OutcomeSchema } from "../schema/spec.v1";
import { evaluateOutcomes } from "../runner/OutcomeEvaluator";
import type { VerifierContext } from "../runner/verifiers/types";
import {
  dataRuntimeModules,
  renderDataPieceModule,
  type DataPiece,
} from "./playwrightRuntimeData";
import { renderRuntimeModule } from "./runtimeSources";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

let rt: Record<string, (...args: never[]) => unknown>;
const directories: string[] = [];
const servers: Server[] = [];

async function listen(
  handler: (
    req: IncomingMessage,
    body: string,
    origin: string,
  ) => Response | Promise<Response>,
): Promise<string> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const self = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      void Promise.resolve(
        handler(req, Buffer.concat(chunks).toString("utf8"), self),
      ).then(async (response) => {
        const headers: Record<string, string> = {};
        response.headers.forEach((value, key) => {
          headers[key] = value;
        });
        res.writeHead(response.status, headers);
        res.end(Buffer.from(await response.arrayBuffer()));
      });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

let origin: string;
let other: string;

function echo(req: IncomingMessage, body: string): Response {
  const headers: Record<string, string> = {};
  for (const name of [
    "authorization",
    "x-custom",
    "x-ds",
    "content-type",
    "accept",
  ]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  return Response.json({ method: req.method, url: req.url, headers, body });
}

async function loadHttpRuntime(): Promise<Record<string, unknown>> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-http-rt-"));
  directories.push(dir);
  await symlink(join(repoRoot, "node_modules"), join(dir, "node_modules"));
  await writeFile(join(dir, "package.json"), '{"type":"module"}\n');
  const pieces: DataPiece[] = ["dataHttp", "dataValue"];
  await mkdir(join(dir, "runtime"), { recursive: true });
  for (const name of dataRuntimeModules(pieces)) {
    await writeFile(
      join(dir, "runtime", `${name}.js`),
      renderRuntimeModule(name, "js"),
    );
  }
  const merged: Record<string, unknown> = {};
  for (const piece of pieces) {
    await writeFile(
      join(dir, `${piece}.js`),
      renderDataPieceModule(piece, "js"),
    );
    Object.assign(
      merged,
      (await import(
        `${pathToFileURL(join(dir, `${piece}.js`)).href}?t=${Date.now()}`
      )) as object,
    );
  }
  return merged;
}

beforeAll(async () => {
  other = await listen((req, body) => echo(req, body));
  origin = await listen((req, body, self) => {
    const url = req.url ?? "/";
    if (url.startsWith("/json")) {
      return Response.json({ ok: true, items: [{ n: 1 }, { n: 2 }] });
    }
    if (url.startsWith("/text")) {
      return new Response("plain words", {
        headers: { "content-type": "text/plain" },
      });
    }
    if (url.startsWith("/status/404")) {
      return Response.json({ error: "nope" }, { status: 404 });
    }
    if (url.startsWith("/redirect-same")) {
      return new Response(null, {
        status: 302,
        headers: { location: "/echo" },
      });
    }
    if (url.startsWith("/redirect-cross")) {
      return new Response(null, {
        status: 302,
        headers: { location: `${other}/echo` },
      });
    }
    if (url.startsWith("/redirect-307-cross")) {
      return new Response(null, {
        status: 307,
        headers: { location: `${other}/echo` },
      });
    }
    if (url.startsWith("/redirect-loop")) {
      return new Response(null, {
        status: 302,
        headers: { location: `${self}/redirect-loop` },
      });
    }
    if (url.startsWith("/slow")) {
      return new Promise((done) =>
        setTimeout(() => done(Response.json({ slow: true })), 1500),
      );
    }
    if (url.startsWith("/big")) {
      return new Response("x".repeat(4 * 1024 * 1024 + 10), {
        headers: { "content-type": "text/plain" },
      });
    }
    return echo(req, body);
  });
  rt = (await loadHttpRuntime()) as typeof rt;
});

afterAll(async () => {
  for (const server of servers) server.close();
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

interface Case {
  name: string;
  /** The spec's `http:` block (relative / absolute URL, source, …). */
  http: Record<string, unknown>;
  /** The datasources config of the environment (config shape). */
  datasources?: Record<string, unknown>;
  env?: Record<string, string>;
  /** The export's literal datasource (what `cairnDatasourceEnv` would give). */
  source?: Record<string, unknown>;
  baseUrl?: string;
}

async function runnerVerdict(c: Case) {
  const set = c.datasources
    ? resolveEnvironmentDatasources(
        DatasourcesConfigSchema.parse(c.datasources),
        undefined,
      )
    : undefined;
  const ctx: VerifierContext = {
    ...(set ? { datasources: set } : {}),
    ...(c.env ? { childEnv: c.env } : {}),
    ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
  };
  const [result] = await evaluateOutcomes(
    [
      OutcomeSchema.parse({
        id: "check",
        description: "check",
        verify: { http: c.http },
      }),
    ],
    new MockBrowserBackend(),
    ctx,
  );
  const { passed, expected, actual } = result!.evaluation;
  return { passed, expected, actual };
}

async function exportVerdict(c: Case) {
  const h = c.http as {
    method?: string;
    url: string;
    headers?: Record<string, string>;
    body?: unknown;
    requestTimeoutMs?: number;
    expect?: { status?: unknown; json?: unknown };
  };
  try {
    await (rt["cairnHttpVerify"] as (...args: unknown[]) => Promise<unknown>)(
      {
        method: (h.method ?? "GET").toUpperCase(),
        url: h.url,
        ...(h.headers ? { headers: h.headers } : {}),
        ...(h.body !== undefined ? { body: h.body } : {}),
        timeoutMs: h.requestTimeoutMs ?? 15000,
        ...(c.source ? { source: c.source } : {}),
        ...(c.baseUrl ? { baseUrl: c.baseUrl } : {}),
      },
      h.expect ?? {},
    );
    return { passed: true, message: "" };
  } catch (error) {
    return { passed: false, message: (error as Error).message };
  }
}

async function parity(c: Case, messageNeedle?: RegExp) {
  const real = await runnerVerdict(c);
  const exported = await exportVerdict(c);
  expect(
    exported.passed,
    `${c.name}: runner ${real.actual} / export ${exported.message}`,
  ).toBe(real.passed);
  if (!real.passed) {
    if (messageNeedle) {
      expect(real.actual).toMatch(messageNeedle);
      expect(exported.message).toMatch(messageNeedle);
    } else {
      expect(exported.message).toContain(real.actual);
    }
  }
}

// Secret-shaped test values are assembled at run time (never literals).
const TOKEN = ["tok", "en", "-A1b2C3"].join("");
const BASIC = ["us", "er:", "pw", "-9z8y"].join("");

describe("http verifier: export vs runner over real servers", () => {
  it("inline absolute URL: status and JSON path matchers", async () => {
    await parity({
      name: "ok",
      http: {
        url: `${origin}/json`,
        expect: { json: { ok: true, "items[1].n": 2, "items.length": 2 } },
      },
    });
    await parity({
      name: "bad path",
      http: { url: `${origin}/json`, expect: { json: { "items[0].n": 9 } } },
    });
    await parity({
      name: "default 2xx",
      http: { url: `${origin}/status/404` },
    });
    await parity({
      name: "status number",
      http: { url: `${origin}/status/404`, expect: { status: 404 } },
    });
    await parity({
      name: "status matcher",
      http: {
        url: `${origin}/status/404`,
        expect: { status: { in: [404, 410] } },
      },
    });
    await parity({
      name: "status matcher fails",
      http: { url: `${origin}/json`, expect: { status: { atLeast: 400 } } },
    });
  });

  it("non-JSON replies and JSON expectations", async () => {
    await parity({
      name: "text ok",
      http: { url: `${origin}/text`, expect: { status: 200 } },
    });
    await parity(
      {
        name: "text vs json",
        http: { url: `${origin}/text`, expect: { json: { a: 1 } } },
      },
      /non-JSON body: plain words/,
    );
  });

  it("a relative URL needs a base URL, like the runner", async () => {
    await parity({
      name: "relative + base",
      http: { url: "/json", expect: { json: { ok: true } } },
      baseUrl: origin,
    });
    const c: Case = { name: "relative, no base", http: { url: "/json" } };
    const real = await runnerVerdict(c);
    const exported = await exportVerdict(c);
    expect(real.passed).toBe(false);
    expect(exported.passed).toBe(false);
    expect(real.actual).toContain("needs source");
    expect(exported.message).toContain("needs source");
  });

  it("datasource credentials and header precedence", async () => {
    const datasources = {
      api: {
        kind: "http",
        baseUrl: origin,
        headers: { "x-ds": "from-ds", "x-custom": "ds" },
        auth: { bearer: "${secrets.API_TOKEN}" },
      },
      basic: {
        kind: "http",
        baseUrl: origin,
        auth: { basic: "${secrets.API_BASIC}" },
      },
    };
    const env = { API_TOKEN: TOKEN, API_BASIC: BASIC };
    await parity({
      name: "bearer + headers, call header wins",
      http: {
        source: "api",
        url: "/echo",
        headers: { "x-custom": "call" },
        expect: {
          json: {
            "headers.authorization": `Bearer ${TOKEN}`,
            "headers.x-ds": "from-ds",
            "headers.x-custom": "call",
          },
        },
      },
      datasources,
      env,
      source: {
        name: "api",
        baseUrl: origin,
        headers: { "x-ds": "from-ds", "x-custom": "ds" },
        bearer: TOKEN,
      },
    });
    await parity({
      name: "basic encodes user:password",
      http: {
        source: "basic",
        url: "/echo",
        expect: {
          json: {
            "headers.authorization": `Basic ${Buffer.from(BASIC).toString("base64")}`,
          },
        },
      },
      datasources,
      env,
      source: { name: "basic", baseUrl: origin, basic: BASIC },
    });
  });

  it("refuses an absolute URL on another origin before sending credentials", async () => {
    await parity(
      {
        name: "other origin",
        http: { source: "api", url: `${other}/echo` },
        datasources: {
          api: {
            kind: "http",
            baseUrl: origin,
            auth: { bearer: "${secrets.API_TOKEN}" },
          },
        },
        env: { API_TOKEN: TOKEN },
        source: { name: "api", baseUrl: origin, bearer: TOKEN },
      },
      /refused a call to/,
    );
  });

  it("redirects: same origin keeps headers; cross origin drops them; a cross-origin body stays on the 3xx", async () => {
    const headers = { "x-custom": "keep-me", authorization: `Bearer ${TOKEN}` };
    await parity({
      name: "same origin keeps headers",
      http: {
        url: `${origin}/redirect-same`,
        headers,
        expect: {
          json: {
            url: "/echo",
            "headers.x-custom": "keep-me",
            "headers.authorization": `Bearer ${TOKEN}`,
          },
        },
      },
    });
    await parity({
      name: "cross origin drops headers",
      http: {
        url: `${origin}/redirect-cross`,
        headers,
        expect: {
          json: {
            "headers.x-custom": { exists: false },
            "headers.authorization": { exists: false },
            "headers.accept": { exists: true },
          },
        },
      },
    });
    await parity({
      name: "cross origin POST with body is returned as 307",
      http: {
        method: "POST",
        url: `${origin}/redirect-307-cross`,
        body: { a: 1 },
        expect: { status: 307 },
      },
    });
    await parity({
      name: "a redirect loop ends on the last 302",
      http: { url: `${origin}/redirect-loop`, expect: { status: 302 } },
    });
  });

  it("request bodies: JSON objects and strings, with the content type fetch would send", async () => {
    await parity({
      name: "json body",
      http: {
        method: "POST",
        url: `${origin}/echo`,
        body: { sku: "S", n: 2 },
        expect: {
          json: {
            method: "POST",
            "headers.content-type": "application/json",
            body: '{"sku":"S","n":2}',
          },
        },
      },
    });
    await parity({
      name: "string body",
      http: {
        method: "POST",
        url: `${origin}/echo`,
        body: "hello there",
        expect: {
          json: {
            body: "hello there",
            "headers.content-type": "text/plain;charset=UTF-8",
          },
        },
      },
    });
    await parity({
      name: "string body with its own content type",
      http: {
        method: "PUT",
        url: `${origin}/echo`,
        headers: { "Content-Type": "application/x-custom" },
        body: "raw",
        expect: {
          json: {
            method: "PUT",
            "headers.content-type": "application/x-custom",
          },
        },
      },
    });
    await parity({
      name: "default accept",
      http: {
        url: `${origin}/echo`,
        expect: {
          json: {
            "headers.accept": "application/json, text/plain;q=0.9, */*;q=0.8",
          },
        },
      },
    });
  });

  it("an oversized body is not parsed", async () => {
    await parity({
      name: "big text, status only",
      http: { url: `${origin}/big`, expect: { status: 200 } },
    });
    await parity(
      {
        name: "big text with json paths",
        http: { url: `${origin}/big`, expect: { json: { a: 1 } } },
      },
      /body over the parse limit \(\d+ bytes\)/,
    );
  });

  it("transport failures: timeout and refused connection", async () => {
    await parity(
      {
        name: "timeout",
        http: { url: `${origin}/slow`, requestTimeoutMs: 250 },
      },
      /timed out after \d+ms/,
    );
    await parity(
      {
        name: "refused",
        http: { url: "http://127.0.0.1:1/x", requestTimeoutMs: 2000 },
      },
      /GET http:\/\/127\.0\.0\.1:1\/x failed: \S+/,
    );
  });

  it("never prints a datasource secret in an error", async () => {
    const secret = ["sek", "ret-", "value-77"].join("");
    const c: Case = {
      name: "scrubbed",
      http: { source: "dead", url: `/${secret}/path`, requestTimeoutMs: 2000 },
      datasources: {
        dead: {
          kind: "http",
          baseUrl: "http://127.0.0.1:1",
          headers: { "x-key": secret },
        },
      },
      source: {
        name: "dead",
        baseUrl: "http://127.0.0.1:1",
        headers: { "x-key": secret },
      },
    };
    const real = await runnerVerdict(c);
    const exported = await exportVerdict(c);
    expect(real.passed).toBe(false);
    expect(exported.passed).toBe(false);
    expect(real.actual).not.toContain(secret);
    expect(exported.message).not.toContain(secret);
  });

  it("cairnDatasourceEnv reads the environment when the test runs and fails like the runner when unset", () => {
    const read = rt["cairnDatasourceEnv"] as unknown as (
      ...args: string[]
    ) => string;
    const name = "CAIRN_TEST_DS_ENV_X";
    delete process.env[name];
    expect(() => read("api", `secrets.${name}`, name)).toThrow(
      `datasource api: \${secrets.${name}} is not set`,
    );
    expect(read("api", `env.${name}`, name, "fallback")).toBe("fallback");
    process.env[name] = "";
    expect(read("api", `env.${name}`, name, "fallback")).toBe("fallback");
    process.env[name] = "set-value";
    expect(read("api", `secrets.${name}`, name)).toBe("set-value");
    delete process.env[name];
  });
});
