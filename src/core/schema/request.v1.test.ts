import { describe, expect, it } from "vitest";
import { ConfigSchema } from "./config.v1";
import {
  EnvAuthSchema,
  REQUEST_MATRIX_MAX_COMBINATIONS,
  RequestTargetSchema,
} from "./request.v1";
import { StepSchema, isBuiltinLoginUse, type Step } from "./spec.v1";

function issues(input: unknown): string[] {
  const parsed = RequestTargetSchema.safeParse(input);
  return parsed.success ? [] : parsed.error.issues.map((i) => i.message);
}

describe("request v2 schema", () => {
  it("keeps v1 requests valid (method defaults to GET)", () => {
    expect(RequestTargetSchema.parse({ url: "/api/x" })).toEqual({
      method: "GET",
      url: "/api/x",
    });
  });

  it("accepts credentials, until, retry, capture and matrix", () => {
    expect(
      issues({
        url: "/api/tasks",
        credentials: "omit",
        until: {
          status: [200, 204],
          json: { "$.tasks[?(@.title=='x')]": { exists: true } },
          every: 250,
          timeoutMs: 60000,
        },
        capture: { taskId: "$.tasks[?(@.title=='x')].id" },
      }),
    ).toEqual([]);
    expect(
      issues({
        url: "/api/flaky",
        retry: { times: 3, on: ["5xx", "network"], delayMs: 100 },
      }),
    ).toEqual([]);
    expect(
      issues({
        method: "${matrix.route.method}",
        url: "${matrix.route.path}",
        body: "${matrix.route.body}",
        headers: { authorization: "${matrix.auth}" },
        matrix: {
          route: [{ method: "GET", path: "/a" }],
          auth: ["", "Bearer x"],
        },
        expectStatus: [401, 403],
      }),
    ).toEqual([]);
  });

  it("refuses until without a check, and until together with retry", () => {
    expect(issues({ url: "/a", until: { every: 100 } })).toContain(
      "request.until needs status or json",
    );
    expect(
      issues({ url: "/a", until: { status: 200 }, retry: { times: 1 } }),
    ).toContain(
      "request.until already re-sends the request until it holds; drop retry",
    );
  });

  it("refuses until / capture with matrix and oversized matrices", () => {
    const base = { url: "/a/${matrix.k}", matrix: { k: [1, 2] } };
    expect(issues({ ...base, until: { status: 200 } }).join()).toContain(
      "until is not supported",
    );
    expect(issues({ ...base, capture: { id: "$.id" } }).join()).toContain(
      "capture is not supported",
    );
    const big = Array.from({ length: 15 }, (_, i) => i);
    expect(issues({ url: "/a", matrix: { a: big, b: big } }).join()).toContain(
      `expands to 225 requests (at most ${REQUEST_MATRIX_MAX_COMBINATIONS})`,
    );
  });

  it("checks ${matrix.…} references against the matrix", () => {
    expect(issues({ url: "/a/${matrix.k}" })).toContain(
      "${matrix.k} needs a request.matrix",
    );
    expect(
      issues({ url: "/a/${matrix.other}", matrix: { k: [1] } }).join(),
    ).toContain('the matrix has no key "other"');
    expect(issues({ method: "${matrix.k}", url: "/a" }).join()).toContain(
      "${matrix.k} needs a request.matrix",
    );
    expect(issues({ method: "FETCH", url: "/a" }).join()).toContain(
      "or ${matrix.<key>} with matrix",
    );
  });
});

describe("environment auth schema", () => {
  const auth = {
    alreadyAuthenticated: {
      method: "POST",
      url: "/api/check",
      json: { "$.user.email": "${secrets.E2E_EMAIL}" },
    },
    login: {
      url: "/api/login",
      body: {
        email: "${secrets.E2E_EMAIL}",
        password: "${secrets.E2E_PASSWORD}",
      },
      expectStatus: 200,
    },
    after: [
      {
        when: { var: "requests.login.body.user.mfa", equals: "otp" },
        request: {
          method: "PUT",
          url: "/api/otp/verify",
          headers: { authorization: "Bearer ${requests.login.body.token}" },
        },
      },
    ],
    hydrate: { file: "auth/hydrate.js" },
  };

  it("parses a full block (login defaults to POST, the probe to GET)", () => {
    const parsed = EnvAuthSchema.parse(auth);
    expect(parsed.login.method).toBe("POST");
    expect(
      EnvAuthSchema.parse({ ...auth, alreadyAuthenticated: { url: "/c" } }),
    ).toMatchObject({ alreadyAuthenticated: { method: "GET" } });
    expect(
      ConfigSchema.parse({
        version: 1,
        environments: { local: { baseUrl: "http://localhost:3000", auth } },
      }).environments.local?.auth?.login.url,
    ).toBe("/api/login");
  });

  it("refuses an ambiguous when and a hydrate with both eval and file", () => {
    expect(
      EnvAuthSchema.safeParse({
        ...auth,
        after: [
          {
            when: { var: "x", equals: 1, exists: true },
            request: { url: "/a" },
          },
        ],
      }).success,
    ).toBe(false);
    expect(
      EnvAuthSchema.safeParse({ ...auth, hydrate: { eval: "1", file: "x.js" } })
        .success,
    ).toBe(false);
    expect(
      EnvAuthSchema.safeParse({ login: { url: "/l" }, extra: true }).success,
    ).toBe(false);
  });
});

describe("use: login", () => {
  it("is the built-in login only while unexpanded", () => {
    const plain = StepSchema.parse({ use: "login" }) as Step;
    const withVars = StepSchema.parse({
      use: { action: "login", vars: { user: "admin" } },
    }) as Step;
    expect(isBuiltinLoginUse(plain)).toBe(true);
    expect(isBuiltinLoginUse(withVars)).toBe(true);
    expect(isBuiltinLoginUse({ use: "login_admin" } as Step)).toBe(false);
    expect(
      isBuiltinLoginUse({
        use: { action: "login", retry: { times: 1 } },
        steps: [],
      } as unknown as Step),
    ).toBe(false);
  });
});
