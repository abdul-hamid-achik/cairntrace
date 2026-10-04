import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type {
  BackendRequest,
  BackendResponse,
  BrowserBackend,
} from "../../adapters/browserBackend";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { RunEventSchema } from "../schema/events.v1";
import { runSpec } from "./Runner";

/**
 * F18 request v2 + environment auth against a real local HTTP server: a
 * login that sets a session cookie and returns a bearer, an OTP-like
 * follow-up that needs the bearer, an eventually-consistent task list
 * (polling + filter captures), a flaky endpoint (retry), and protected
 * routes (anonymous matrix). The backend sends real HTTP with a small
 * cookie jar, like a browser context would; nothing here starts a browser.
 */

// Credentials and tokens are built at run time: no secret-shaped literal
// lives in the repository.
const EMAIL = `qa-${randomUUID().slice(0, 8)}@example.test`;
const PASSWORD = ["pw", randomUUID()].join("-");
const OTP = randomUUID().slice(0, 6).toUpperCase();

interface Session {
  email: string;
  token: string;
  otpVerified: boolean;
}

interface ServerState {
  sessions: Map<string, Session>;
  logins: number;
  taskPolls: number;
  flakyCalls: number;
}

let server: Server;
let baseUrl: string;
let state: ServerState;
let workDir: string;
let artifactRoot: string;

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolveBody) => {
    let text = "";
    req.on("data", (chunk) => {
      text += String(chunk);
    });
    req.on("end", () => {
      try {
        resolveBody(text ? JSON.parse(text) : undefined);
      } catch {
        resolveBody(text);
      }
    });
  });
}

function sessionOf(req: IncomingMessage): Session | undefined {
  const cookie = req.headers.cookie ?? "";
  const sid = /(?:^|;\s*)sid=([^;]+)/.exec(cookie)?.[1];
  return sid ? state.sessions.get(sid) : undefined;
}

beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "cairntrace-request-v2-"));
  artifactRoot = join(workDir, ".cairntrace", "runs");
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const body = await readBody(req);
    const send = (
      status: number,
      payload: unknown,
      headers: Record<string, string> = {},
    ): void => {
      res.writeHead(status, { "content-type": "application/json", ...headers });
      res.end(JSON.stringify(payload));
    };
    const session = sessionOf(req);
    const bearer = /^Bearer (.+)$/.exec(req.headers.authorization ?? "")?.[1];
    switch (`${req.method} ${url.pathname}`) {
      case "POST /api/login": {
        const creds = body as { email?: string; password?: string };
        if (creds?.email !== EMAIL || creds?.password !== PASSWORD) {
          return send(401, { error: "bad credentials" });
        }
        state.logins++;
        const sid = randomUUID();
        const token = `tk.${randomUUID()}`;
        state.sessions.set(sid, { email: EMAIL, token, otpVerified: false });
        return send(
          200,
          { token, user: { email: EMAIL, mfa: "otp" } },
          { "set-cookie": `sid=${sid}; Path=/; HttpOnly` },
        );
      }
      case "POST /api/check":
        return session?.otpVerified
          ? send(200, { authenticated: true, user: { email: session.email } })
          : send(200, { authenticated: false });
      case `PUT /api/otp/${OTP}`: {
        const owner = [...state.sessions.values()].find(
          (candidate) => candidate.token === bearer,
        );
        if (!owner) return send(401, { error: "bearer required" });
        owner.otpVerified = true;
        return send(200, { verified: true });
      }
      case "GET /api/me":
        return session?.otpVerified
          ? send(200, { email: session.email })
          : send(401, { error: "sign in" });
      case "GET /api/tasks": {
        state.taskPolls++;
        const tasks = [{ id: "t-1", title: "Intro" }];
        if (state.taskPolls >= 3) tasks.push({ id: "t-42", title: "Report" });
        return send(200, { tasks });
      }
      case "GET /api/tasks/t-42":
        return send(200, { id: "t-42", title: "Report" });
      case "GET /api/flaky":
        state.flakyCalls++;
        return state.flakyCalls <= 2
          ? send(503, { error: "warming up" })
          : send(200, { ok: true });
      case "GET /api/health":
        return send(200, { ok: true });
      default:
        if (url.pathname.startsWith("/api/admin/")) {
          return session?.otpVerified && !req.headers.authorization
            ? send(200, { ok: true })
            : send(401, { error: "denied" });
        }
        return send(404, { error: "not found" });
    }
  });
  await new Promise<void>((resolveListen) =>
    server.listen(0, "127.0.0.1", () => resolveListen()),
  );
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
});

beforeEach(() => {
  state = { sessions: new Map(), logins: 0, taskPolls: 0, flakyCalls: 0 };
});

/**
 * Real HTTP with a cookie jar: `include` sends the jar and keeps
 * `Set-Cookie`; `omit` does neither — what a browser context does.
 */
class HttpBackend extends MockBrowserBackend {
  cookie = "";
  override async request(req: BackendRequest): Promise<BackendResponse> {
    this.requestLog.push(req);
    const headers = new Headers(req.headers ?? {});
    if (req.credentials !== "omit" && this.cookie && !headers.has("cookie")) {
      headers.set("cookie", this.cookie);
    }
    let body: string | undefined;
    if (req.body !== undefined) {
      if (typeof req.body === "string") body = req.body;
      else {
        body = JSON.stringify(req.body);
        if (!headers.has("content-type")) {
          headers.set("content-type", "application/json");
        }
      }
    }
    try {
      const res = await fetch(req.url, {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        signal: AbortSignal.timeout(req.timeoutMs ?? 30_000),
      });
      const text = await res.text();
      if (req.credentials !== "omit") {
        const set = res.headers.getSetCookie();
        if (set.length > 0) {
          this.cookie = set.map((line) => line.split(";")[0]).join("; ");
        }
      }
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        // plain text body
      }
      const out: Record<string, string> = {};
      res.headers.forEach((value, key) => {
        out[key] = value;
      });
      return { ok: true, status: res.status, headers: out, body: parsed };
    } catch (e) {
      return {
        ok: false,
        status: 0,
        headers: {},
        body: null,
        error: (e as Error).message,
      };
    }
  }
}

async function project(
  name: string,
  spec: string,
  auth?: string,
): Promise<string> {
  const dir = await mkdtemp(join(workDir, `${name}-`));
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    [
      "version: 1",
      "defaultEnvironment: local",
      "environments:",
      "  local:",
      `    baseUrl: ${baseUrl}`,
      ...(auth
        ? ["    auth:", ...auth.split("\n").map((l) => `      ${l}`)]
        : []),
      "",
    ].join("\n"),
  );
  const specPath = join(dir, `${name}.yml`);
  await writeFile(specPath, spec);
  return specPath;
}

const AUTH = `alreadyAuthenticated:
  method: POST
  url: /api/check
  json:
    "$.authenticated": true
    "$.user.email": "\${secrets.E2E_EMAIL}"
login:
  url: /api/login
  body: { email: "\${secrets.E2E_EMAIL}", password: "\${secrets.E2E_PASSWORD}" }
  expectStatus: 200
after:
  - id: otp
    when: { var: requests.login.body.user.mfa, equals: otp }
    request:
      method: PUT
      url: /api/otp/\${secrets.E2E_OTP}
      headers: { authorization: "Bearer \${requests.login.body.token}" }
      expectStatus: 200`;

const SECRET_ENV = {
  E2E_EMAIL: EMAIL,
  E2E_PASSWORD: PASSWORD,
  E2E_OTP: OTP,
};

/** Every artifact file's text (the run directory, recursively). */
async function artifactText(runDir: string): Promise<string> {
  const entries = await readdir(runDir, {
    recursive: true,
    withFileTypes: true,
  });
  const texts = await Promise.all(
    entries
      .filter(
        (entry) => entry.isFile() && !/\.(png|webm|zip)$/.test(entry.name),
      )
      .map((entry) => readFile(join(entry.parentPath, entry.name), "utf8")),
  );
  return texts.join("\n");
}

function tokensIssued(): string[] {
  return [...state.sessions.values()].map((session) => session.token);
}

describe("environment auth (use: login)", () => {
  it("logs in, runs the OTP follow-up with the captured bearer, and never writes a credential", async () => {
    const specPath = await project(
      "env_login",
      `version: 1
name: env_login
intent: sign in through the environment auth and read the profile
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - use: login
  - id: me
    request: { url: /api/me, expectStatus: 200, assign: me }
`,
      AUTH,
    );
    const backend = new HttpBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot,
      env: { PATH: process.env.PATH, ...SECRET_ENV },
    });

    expect(result.status).toBe("passed");
    expect(state.logins).toBe(1);
    expect(result.steps[0]).toMatchObject({
      status: "passed",
      detail: expect.stringContaining("logged in (POST /api/login → 200)"),
    });
    expect(result.steps[0]!.detail).toContain("1 follow-up(s)");
    expect(result.artifacts.requests).toMatchObject({
      login_check: "requests/login_check.json",
      login: "requests/login.json",
      login_after_1: "requests/login_after_1.json",
      me: "requests/me.json",
    });
    const text = await artifactText(result.runDir);
    for (const secret of [EMAIL, PASSWORD, OTP, ...tokensIssued()]) {
      expect(text).not.toContain(secret);
    }
    // The OTP path segment is a secret too: the follow-up URL is scrubbed.
    const after = JSON.parse(
      await readFile(
        join(result.runDir, "requests/login_after_1.json"),
        "utf8",
      ),
    );
    expect(after.url).toContain("/api/otp/[redacted]");
    const events = (
      await readFile(join(result.runDir, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => RunEventSchema.parse(JSON.parse(line)));
    expect(
      events.filter((event) => event.type === "artifact.request"),
    ).toHaveLength(4);
  });

  it("skips the login when alreadyAuthenticated holds", async () => {
    const specPath = await project(
      "env_login_again",
      `version: 1
name: env_login_again
intent: a second login in the same session is a no-op
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: first
    use: login
  - id: second
    use: login
`,
      AUTH,
    );
    const result = await runSpec({
      specPath,
      backend: new HttpBackend(),
      artifactRoot,
      env: { PATH: process.env.PATH, ...SECRET_ENV },
    });

    expect(result.status).toBe("passed");
    expect(state.logins).toBe(1);
    expect(result.steps[1]!.detail).toMatch(
      /^already authenticated \(POST \/api\/check → 200\); login skipped$/,
    );
  });

  it("fails clearly without an auth block, and on a missing secret", async () => {
    const noAuth = await project(
      "env_login_none",
      `version: 1
name: env_login_none
intent: login needs config
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - use: login
`,
    );
    const first = await runSpec({
      specPath: noAuth,
      backend: new HttpBackend(),
      artifactRoot,
      env: { PATH: process.env.PATH },
    });
    expect(first.steps[0]!.error).toContain(
      'use: login: environment "local" has no auth: block',
    );

    const missing = await project(
      "env_login_missing",
      `version: 1
name: env_login_missing
intent: login needs its secrets
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - use: login
`,
      AUTH,
    );
    const second = await runSpec({
      specPath: missing,
      backend: new HttpBackend(),
      artifactRoot,
      env: { PATH: process.env.PATH, E2E_EMAIL: EMAIL },
    });
    expect(second.steps[0]!.error).toContain(
      "${secrets.E2E_PASSWORD} is not set",
    );
    expect(state.logins).toBe(0);
  });
});

describe("request v2", () => {
  it("sends a captured bearer, polls until a filtered task exists, captures it and splices the capture", async () => {
    const specPath = await project(
      "request_v2_flow",
      `version: 1
name: request_v2_flow
intent: bearer header, until polling, filter captures
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: sign_in
    request:
      method: POST
      url: /api/login
      body: { email: "\${secrets.E2E_EMAIL}", password: "\${secrets.E2E_PASSWORD}" }
      expectStatus: 200
      capture: { bearer: "$.token" }
      assign: auth
  - id: verify_otp
    request:
      method: PUT
      url: /api/otp/\${secrets.E2E_OTP}
      headers: { Authorization: "Bearer \${requests.auth.captures.bearer}" }
      expectStatus: 200
  - id: wait_task
    request:
      url: /api/tasks
      until:
        json: { "$.tasks[?(@.title == 'Report')]": { exists: true } }
        every: 50
        timeoutMs: 5000
      capture: { taskId: "$.tasks[?(@.title == 'Report')].id" }
      assign: tasks
  - id: open_task
    request: { url: "/api/tasks/\${requests.tasks.captures.taskId}", expectStatus: 200, assign: task }
`,
    );
    const result = await runSpec({
      specPath,
      backend: new HttpBackend(),
      artifactRoot,
      env: { PATH: process.env.PATH, ...SECRET_ENV },
    });

    expect(result.status).toBe("passed");
    expect(state.taskPolls).toBe(3);
    const tasks = JSON.parse(
      await readFile(join(result.runDir, "requests/tasks.json"), "utf8"),
    );
    expect(tasks).toMatchObject({
      status: 200,
      attempts: 3,
      captures: { taskId: "t-42" },
    });
    const task = JSON.parse(
      await readFile(join(result.runDir, "requests/task.json"), "utf8"),
    );
    expect(task.body).toEqual({ id: "t-42", title: "Report" });
    const text = await artifactText(result.runDir);
    for (const secret of [PASSWORD, ...tokensIssued()]) {
      expect(text).not.toContain(secret);
    }
  });

  it("fails an until that never holds with the last answer as evidence", async () => {
    const specPath = await project(
      "request_until_timeout",
      `version: 1
name: request_until_timeout
intent: a poll that never holds
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: wait_missing
    request:
      url: /api/tasks
      until: { json: { "$.tasks[?(@.title == 'Never')].id": { exists: true } }, every: 50, timeoutMs: 400 }
      assign: never
`,
    );
    const result = await runSpec({
      specPath,
      backend: new HttpBackend(),
      artifactRoot,
    });

    expect(result.status).toBe("failed");
    expect(result.steps[0]!.error).toMatch(
      /request until not satisfied after \d+ attempt\(s\)/,
    );
    const evidence = JSON.parse(
      await readFile(join(result.runDir, "requests/never.json"), "utf8"),
    );
    expect(evidence.attempts).toBeGreaterThan(1);
    expect(result.artifacts.requests ?? {}).not.toHaveProperty("never");
  });

  it("retries a 5xx answer, and reports the attempts when retries run out", async () => {
    const specPath = await project(
      "request_retry",
      `version: 1
name: request_retry
intent: retry a warming endpoint
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: flaky
    request:
      url: /api/flaky
      retry: { times: 3, on: [5xx], delayMs: 10 }
      expectStatus: 200
      assign: flaky
`,
    );
    const result = await runSpec({
      specPath,
      backend: new HttpBackend(),
      artifactRoot,
    });
    expect(result.status).toBe("passed");
    expect(state.flakyCalls).toBe(3);
    const flaky = JSON.parse(
      await readFile(join(result.runDir, "requests/flaky.json"), "utf8"),
    );
    expect(flaky).toMatchObject({ status: 200, attempts: 3 });

    state.flakyCalls = 0;
    const short = await project(
      "request_retry_short",
      `version: 1
name: request_retry_short
intent: not enough retries
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: flaky
    request: { url: /api/flaky, retry: { times: 1, delayMs: 10 }, expectStatus: 200 }
`,
    );
    const failed = await runSpec({
      specPath: short,
      backend: new HttpBackend(),
      artifactRoot,
    });
    expect(failed.status).toBe("failed");
    expect(failed.steps[0]!.error).toContain(
      "request status 503 not in expectStatus [200]",
    );
    expect(failed.steps[0]!.error).toContain("after 2 attempts");
  });

  it("runs an anonymous matrix and lists each mismatched combination", async () => {
    const specPath = await project(
      "request_matrix",
      `version: 1
name: request_matrix
intent: protected routes deny anonymous and invalid-bearer callers
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - use: login
  - id: denied
    request:
      method: \${matrix.route.method}
      url: \${matrix.route.path}
      body: \${matrix.route.body}
      headers: { authorization: "\${matrix.auth}" }
      credentials: omit
      matrix:
        route:
          - { method: GET, path: /api/admin/list }
          - { method: POST, path: /api/admin/create, body: { name: denied } }
          - { method: DELETE, path: /api/admin/remove }
          - { method: GET, path: /api/health }
        auth: ["", "Bearer invalid-value"]
      expectStatus: 401
      assign: denied
`,
      AUTH,
    );
    const result = await runSpec({
      specPath,
      backend: new HttpBackend(),
      artifactRoot,
      env: { PATH: process.env.PATH, ...SECRET_ENV },
    });

    expect(result.status).toBe("failed");
    const error = result.steps[1]!.error!;
    expect(error).toContain(
      "request matrix: 2/8 combination(s) did not match expectStatus [401]",
    );
    expect(error).toContain('path":"/api/health"');
    const evidence = JSON.parse(
      await readFile(join(result.runDir, "requests/denied.json"), "utf8"),
    );
    expect(evidence.matrix).toHaveLength(8);
    expect(
      evidence.matrix.filter((r: { matched: boolean }) => !r.matched),
    ).toHaveLength(2);
    expect(evidence.matrix[2]).toMatchObject({
      method: "POST",
      status: 401,
      matched: true,
    });
    const events = (
      await readFile(join(result.runDir, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(
      events.find(
        (event) =>
          event.type === "artifact.request" && event.assign === "denied",
      ),
    ).toMatchObject({ combinations: 8, mismatches: 2 });
  });
});

function withoutNativeRequest(backend: MockBrowserBackend): BrowserBackend {
  return new Proxy(backend, {
    get(target, prop) {
      if (prop === "request") return undefined;
      const value = Reflect.get(target, prop);
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as BrowserBackend;
}

describe("request v2 in-page fallback", () => {
  it("sends credentials: omit and retries a 5xx through bounded page fetches", async () => {
    const specPath = await project(
      "request_fallback_v2",
      `version: 1
name: request_fallback_v2
intent: the page-fetch fallback honors credentials and retry
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: anon
    request:
      url: /api/me
      credentials: omit
      retry: { times: 2, delayMs: 1 }
      expectStatus: 401
      capture: { reason: "$.error" }
      assign: anon
`,
    );
    const backend = new MockBrowserBackend();
    backend.enqueueEvalResult({
      status: 502,
      ok: false,
      headers: {},
      body: {},
    });
    backend.enqueueEvalResult({
      status: 401,
      ok: false,
      headers: {},
      body: { error: "sign in" },
    });
    const result = await runSpec({
      specPath,
      backend: withoutNativeRequest(backend),
      artifactRoot,
    });

    expect(result.status).toBe("passed");
    expect(backend.lastEvaluatedScript).toContain('credentials: "omit"');
    expect(backend.lastEvaluatedScript).toContain(`fetch("${baseUrl}/api/me"`);
    const anon = JSON.parse(
      await readFile(join(result.runDir, "requests/anon.json"), "utf8"),
    );
    expect(anon).toMatchObject({
      status: 401,
      attempts: 2,
      captures: { reason: "sign in" },
    });
  });
});
