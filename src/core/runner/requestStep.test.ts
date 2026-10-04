import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { safeExcerpt } from "../artifacts/excerpt";
import { createArtifactRedactor } from "../artifacts/redaction";
import { coldStartLint } from "../coldStart";
import { resolveActionFiles } from "../discovery/setup";
import { parseSpec } from "../parser/parseSpec";
import { EnvAuthSchema } from "../schema/request.v1";
import { isBuiltinLoginUse, type RequestStep } from "../schema/spec.v1";
import { checkHolds, resolveAuthTemplates } from "./envAuth";
import {
  captureValues,
  matrixCombinations,
  runRequestStep,
  spliceMatrix,
  untilHolds,
} from "./requestStep";
import {
  isMultiValuePath,
  PathSyntaxError,
  readPath,
} from "./verifiers/matchers";

describe("JSON path filters", () => {
  const body = {
    tasks: [
      { id: 1, title: "Intro", n: 2 },
      { id: 2, title: "Report", n: 5, owner: null },
    ],
  };

  it("filters by comparison, presence and boolean operators", () => {
    expect(readPath(body, '$.tasks[?(@.title == "Report")].id')).toEqual({
      exists: true,
      value: [2],
    });
    expect(readPath(body, "$.tasks[?(@.n < 3 || @.owner)].id").value).toEqual([
      1, 2,
    ]);
    expect(
      readPath(body, "$.tasks[?(!(@.owner) && @.n != 5)].id").value,
    ).toEqual([1]);
  });

  it("selects nothing when no item matches (exists: false)", () => {
    expect(readPath(body, "$.tasks[?(@.title == 'none')]")).toEqual({
      exists: false,
      value: undefined,
    });
  });

  it("reports a malformed filter with the whole path", () => {
    expect(() => readPath(body, "$.tasks[?(@.n >)]")).toThrow(PathSyntaxError);
    expect(() => readPath(body, "$.tasks[?(@.n >)]")).toThrow(
      'invalid path "$.tasks[?(@.n >)]"',
    );
  });

  it("knows which paths may select several values", () => {
    expect(isMultiValuePath("$.tasks[*].id")).toBe(true);
    expect(isMultiValuePath("$.tasks[?(@.n > 1)].id")).toBe(true);
    expect(isMultiValuePath("$.tasks[0].id")).toBe(false);
  });
});

describe("request v2 helpers", () => {
  it("captures the first match of a filter and fails on no match", () => {
    const body = {
      tasks: [
        { id: "a", t: "x" },
        { id: "b", t: "x" },
      ],
    };
    expect(captureValues(body, { id: "$.tasks[?(@.t == 'x')].id" })).toEqual({
      ok: true,
      values: { id: "a" },
    });
    expect(captureValues(body, { all: "$.tasks" })).toEqual({
      ok: true,
      values: { all: body.tasks },
    });
    const missed = captureValues(body, { id: "$.tasks[?(@.t == 'y')].id" });
    expect(missed.ok).toBe(false);
    expect(!missed.ok && missed.error).toContain(
      "capture id: $.tasks[?(@.t == 'y')].id matched nothing",
    );
  });

  it("checks until status and json matchers", () => {
    expect(untilHolds({ status: 202, body: {} }, { status: [200] })).toEqual({
      holds: false,
      why: "status 202 not in [200]",
    });
    expect(
      untilHolds(
        { status: 200, body: { state: "done" } },
        { status: 200, json: { "$.state": "done" } },
      ),
    ).toEqual({ holds: true });
    const pending = untilHolds(
      { status: 200, body: { state: "running" } },
      { json: { "$.state": "done" } },
    );
    expect(!pending.holds && pending.why).toContain('$.state="running"');
    // A credential-named leaf or a token-shaped value never shows in the reason.
    const token = fakeToken("tk", 44);
    const secretWhy = untilHolds(
      { status: 200, body: { session: { token }, id: token } },
      { json: { "$.session.token": { exists: false }, "$.id": "x" } },
    );
    expect(!secretWhy.holds && secretWhy.why).toContain(
      "$.session.token=[redacted]",
    );
    expect(!secretWhy.holds && secretWhy.why).toContain('$.id="<44 chars>"');
    expect(leaksPrefix(JSON.stringify(secretWhy), token)).toBe(false);
  });

  it("expands a matrix and splices typed whole references", () => {
    const combos = matrixCombinations({ a: [1, 2], b: ["x", "y"] });
    expect(combos).toEqual([
      { a: 1, b: "x" },
      { a: 1, b: "y" },
      { a: 2, b: "x" },
      { a: 2, b: "y" },
    ]);
    const values = { route: { path: "/p", body: { n: 1 } }, auth: "" };
    expect(
      spliceMatrix(
        {
          url: "/api${matrix.route.path}?a=${matrix.auth}",
          body: "${matrix.route.body}",
          missing: "${matrix.route.nothing}",
        },
        values,
      ),
    ).toEqual({ url: "/api/p?a=", body: { n: 1 }, missing: undefined });
  });

  it("sends credentials: omit to a native request and registers sensitive values", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 200,
      headers: {},
      body: { accessToken: "tok-registered-1", user: { name: "visible" } },
    });
    const registered: string[] = [];
    const step: RequestStep = {
      request: {
        method: "GET",
        url: "http://app.test/api/me",
        credentials: "omit",
        headers: { Authorization: "Bearer bearer-value-1", accept: "x" },
        capture: { sessionToken: "$.accessToken", who: "$.user.name" },
      },
    };
    const result = await runRequestStep({
      step,
      backend,
      requestIndex: 3,
      registerSecrets: (values) => registered.push(...values),
    });
    expect(result).toMatchObject({
      ok: true,
      assign: "request_3",
      response: {
        captures: { sessionToken: "tok-registered-1", who: "visible" },
      },
    });
    expect(backend.lastRequest).toMatchObject({ credentials: "omit" });
    expect(registered).toEqual(
      expect.arrayContaining([
        "Bearer bearer-value-1",
        "bearer-value-1",
        "tok-registered-1",
      ]),
    );
    expect(registered).not.toContain("visible");
  });

  it("retries network failures and stops a poll on cancel", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({ requestError: "connection refused" });
    backend.enqueueEvalResult({ status: 200, headers: {}, body: { ok: true } });
    const retried = await runRequestStep({
      step: {
        request: {
          method: "GET",
          url: "http://app.test/a",
          retry: { times: 1, on: ["network"], delayMs: 0 },
        },
      },
      backend,
      requestIndex: 1,
    });
    expect(retried).toMatchObject({ ok: true, response: { attempts: 2 } });

    const controller = new AbortController();
    const polling = new MockBrowserBackend();
    const result = await runRequestStep({
      step: {
        request: {
          method: "GET",
          url: "http://app.test/a",
          until: { status: 201, every: 50, timeoutMs: 10_000 },
        },
      },
      backend: polling,
      requestIndex: 1,
      signal: controller.signal,
      sleep: async () => {
        controller.abort();
      },
    });
    expect(result).toMatchObject({ ok: false, error: "request cancelled" });
    expect(polling.requestLog).toHaveLength(1);
  });
});

describe("environment auth helpers", () => {
  const auth = EnvAuthSchema.parse({
    login: {
      url: "/api/login",
      body: { email: "${secrets.QA_USER}", password: "${secrets.QA_PASS}" },
      headers: { "x-tenant": "${vars.tenant}" },
    },
    after: [
      {
        request: {
          url: "/api/next",
          headers: { authorization: "Bearer ${requests.login.body.token}" },
        },
      },
    ],
  });

  it("resolves secrets and vars, keeps runtime refs, and registers the secrets", () => {
    const registered: string[] = [];
    const resolved = resolveAuthTemplates(auth, {
      env: { QA_USER: "user-a", QA_PASS: "pass-value-b" },
      vars: { tenant: "t1" },
      envName: "local",
      registerSecrets: (values) => registered.push(...values),
    });
    expect(resolved.login.body).toEqual({
      email: "user-a",
      password: "pass-value-b",
    });
    expect(resolved.login.headers).toEqual({ "x-tenant": "t1" });
    expect(resolved.after?.[0]?.request.headers?.authorization).toBe(
      "Bearer ${requests.login.body.token}",
    );
    expect(registered).toEqual(["user-a", "pass-value-b"]);
  });

  it("fails on an unset secret instead of signing in with an empty value", () => {
    expect(() =>
      resolveAuthTemplates(auth, {
        env: { QA_USER: "user-a" },
        vars: { tenant: "t1" },
        envName: "dev",
        registerSecrets: () => {},
      }),
    ).toThrow("${secrets.QA_PASS} is not set");
  });

  it("checks the alreadyAuthenticated probe (default any 2xx)", () => {
    expect(checkHolds({ status: 204, body: null }, {})).toBe(true);
    expect(checkHolds({ status: 401, body: null }, {})).toBe(false);
    expect(
      checkHolds(
        { status: 200, body: { user: { email: "a@b" } } },
        { json: { "$.user.email": "a@b" } },
      ),
    ).toBe(true);
    expect(checkHolds({ status: 401, body: {} }, { status: [401] })).toBe(true);
  });
});

describe("use: login authoring", () => {
  it("parses as a kept step unless an imported action named login exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-login-parse-"));
    const specPath = join(dir, "flow.yml");
    await writeFile(
      specPath,
      `version: 1
name: flow
intent: login then open
outcomes:
  - id: ok
    description: ok
    verify: { text: { contains: x } }
steps:
  - use: login
  - use: { action: login, vars: { user: admin } }
  - open: /home
`,
    );
    const parsed = await parseSpec(specPath, {
      env: { QA_SECRET: "v" },
      baseUrl: "http://app.test",
    });
    expect(parsed.resolved.steps).toHaveLength(3);
    expect(isBuiltinLoginUse(parsed.resolved.steps![0]!)).toBe(true);
    expect(isBuiltinLoginUse(parsed.resolved.steps![1]!)).toBe(true);
    expect(parsed.origins).toHaveLength(3);

    await mkdir(join(dir, "actions"));
    await writeFile(
      join(dir, "actions", "login.yml"),
      `version: 1
name: login
steps:
  - open: /signin
  - fill: { by: label, name: Password, value: "\${secrets.QA_SECRET}" }
`,
    );
    const importing = join(dir, "importing.yml");
    await writeFile(
      importing,
      `version: 1
name: importing
intent: an imported login action wins
imports: [actions/login.yml]
outcomes:
  - id: ok
    description: ok
    verify: { text: { contains: x } }
steps:
  - use: login
`,
    );
    const withAction = await parseSpec(importing, {
      env: { QA_SECRET: "secret-value" },
      baseUrl: "http://app.test",
    });
    expect(withAction.resolved.steps).toHaveLength(2);
    expect(withAction.resolved.steps![0]).toEqual({
      open: "http://app.test/signin",
    });
    // Every ${secrets.X} value is reported for redaction.
    expect(withAction.secretValues).toEqual(["secret-value"]);
  });

  it("satisfies the cold-start contract", () => {
    expect(
      coldStartLint({
        version: 1,
        name: "x",
        intent: "x",
        outcomes: [],
        steps: [{ use: "login" }],
      } as never),
    ).toBeUndefined();
    expect(
      coldStartLint({
        version: 1,
        name: "x",
        intent: "x",
        outcomes: [],
        steps: [{ open: "/x" }],
      } as never),
    ).toContain("no use: login");
  });

  it("is a valid discovery setup without an action file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-login-setup-"));
    await expect(
      resolveActionFiles(["login"], { configDir: dir, cwd: dir }),
    ).resolves.toEqual([]);
    await expect(
      resolveActionFiles(["login_admin"], { configDir: dir, cwd: dir }),
    ).rejects.toThrow('action "login_admin" not found');
  });
});

/**
 * Token-shaped test values are built at runtime (no secret-shaped literal in
 * the repository): `prefix` + letters, `length` characters long.
 */
function fakeToken(prefix: string, length: number): string {
  let out = prefix;
  for (let i = 0; out.length < length; i++) {
    out += String.fromCharCode(65 + (i % 26)) + String(i % 10);
  }
  return out.slice(0, length);
}

/** No 8-character window of `secret` survives in `text`. */
function leaksPrefix(text: string, secret: string): boolean {
  for (let i = 0; i + 8 <= secret.length; i++) {
    if (text.includes(secret.slice(i, i + 8))) return true;
  }
  return false;
}

function redact(text: string, known: string[]): string {
  return createArtifactRedactor(undefined, {}, known).text(text);
}

describe("request errors never carry a cut credential", () => {
  it("masks the body excerpt of an expectStatus failure, whatever the cut", async () => {
    const token = fakeToken("tk", 50);
    // Shift the token across the 300-character cut of the old excerpt.
    for (const pad of [200, 240, 260, 280]) {
      const backend = new MockBrowserBackend();
      backend.enqueueEvalResult({
        status: 200,
        headers: {},
        body: {
          note: "n".repeat(40),
          filler: "f".repeat(pad),
          accessToken: token,
        },
      });
      const registered: string[] = [];
      const result = await runRequestStep({
        step: {
          request: {
            method: "POST",
            url: "http://app.test/api/login",
            expectStatus: 201,
          },
        },
        backend,
        requestIndex: 1,
        registerSecrets: (values) => registered.push(...values),
      });
      expect(result.ok).toBe(false);
      const error = (result as { error: string }).error;
      expect(error).toContain('"accessToken":"[redacted]"');
      expect(leaksPrefix(redact(error, registered), token)).toBe(false);
    }
  });

  it("masks the body of a capture miss and the values of matrix mismatches", async () => {
    const token = fakeToken("tk", 50);
    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 200,
      headers: {},
      body: { padding: "p".repeat(150), session: { value: token } },
    });
    const missed = await runRequestStep({
      step: {
        request: {
          method: "GET",
          url: "http://app.test/api/me",
          capture: { id: "$.missing" },
        },
      },
      backend,
      requestIndex: 1,
    });
    expect(missed.ok).toBe(false);
    expect(leaksPrefix((missed as { error: string }).error, token)).toBe(false);

    const password = fakeToken("pw", 24);
    const matrix = new MockBrowserBackend();
    matrix.enqueueEvalResult({ status: 403, headers: {}, body: {} });
    matrix.enqueueEvalResult({ status: 403, headers: {}, body: {} });
    const mismatched = await runRequestStep({
      step: {
        request: {
          method: "POST",
          url: "http://app.test/api/login",
          body: "${matrix.user}",
          matrix: {
            user: [{ name: "ada", password }],
            password: [password],
          },
          expectStatus: 200,
        },
      },
      backend: matrix,
      requestIndex: 1,
    });
    expect(mismatched.ok).toBe(false);
    const error = (mismatched as { error: string }).error;
    expect(error).toContain('user={"name":"ada","password":"[redacted]"}');
    expect(error).toContain("password=[redacted]");
    expect(leaksPrefix(error, password)).toBe(false);
  });

  it("registers the credentials of every polled answer, the persisted last one included", async () => {
    const jwt = `eyJ${fakeToken("h", 20)}.${fakeToken("p", 30)}.${fakeToken("s", 20)}`;
    const bearer = fakeToken("br", 40);
    const backend = new MockBrowserBackend();
    for (let i = 0; i < 5; i++) {
      backend.enqueueEvalResult({
        status: 202,
        headers: {},
        body: { state: "pending", session: { jwt, bearer } },
      });
    }
    let clock = 0;
    const registered: string[] = [];
    const result = await runRequestStep({
      step: {
        request: {
          method: "GET",
          url: "http://app.test/api/job",
          until: { status: 200, every: 100, timeoutMs: 250 },
        },
      },
      backend,
      requestIndex: 1,
      registerSecrets: (values) => registered.push(...values),
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    });
    expect(result).toMatchObject({ ok: false, assign: "request_1" });
    expect(registered).toEqual(expect.arrayContaining([jwt, bearer]));
    // The persisted envelope is scrubbed by key too (jwt / bearer are credential keys).
    const persisted = JSON.stringify(
      createArtifactRedactor(undefined, {}, []).value(
        (result as { response: unknown }).response,
      ),
    );
    expect(persisted).not.toContain(jwt);
    expect(persisted).not.toContain(bearer);
  });

  it("names a nested unassigned request after its place", async () => {
    const backend = new MockBrowserBackend();
    const result = await runRequestStep({
      step: { request: { method: "GET", url: "http://app.test/a" } },
      backend,
      requestIndex: 3,
      defaultAssign: "request_3_2_i2",
    });
    expect(result).toMatchObject({ ok: true, assign: "request_3_2_i2" });
  });
});

describe("safeExcerpt", () => {
  it("masks credential keys, shows long or token-shaped strings by length, and never cuts a string", () => {
    const token = fakeToken("tk", 48);
    expect(safeExcerpt({ password: "short1", user: "ada" })).toBe(
      '{"password":"[redacted]","user":"ada"}',
    );
    expect(safeExcerpt({ id: token })).toBe('{"id":"<string, 48 chars>"}');
    const cut = safeExcerpt(
      { a: "x".repeat(60), b: "y".repeat(60), c: "z".repeat(60) },
      100,
    );
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toMatch(/"[xyz]+…$/);
    expect(safeExcerpt(`unauthorized: token ${token} expired`)).toBe(
      '"unauthorized: token <48 chars> expired"',
    );
    expect(safeExcerpt(undefined)).toBe("missing");
  });
});
