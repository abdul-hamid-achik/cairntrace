import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegisteredSecretValues,
  createArtifactRedactor,
  createLiveArtifactRedactor,
  registerSecretValues,
} from "./redaction";

describe("createArtifactRedactor", () => {
  afterEach(() => {
    clearRegisteredSecretValues();
  });

  it("redacts values for sensitive-looking env keys", () => {
    const redactor = createArtifactRedactor(undefined, {
      API_TOKEN: "tok_abcdef123456",
      HOME: "/Users/me",
    });
    expect(redactor.text("authorization tok_abcdef123456 here")).toBe(
      "authorization [redacted] here",
    );
    // Non-sensitive key value is untouched.
    expect(redactor.text("home is /Users/me")).toBe("home is /Users/me");
  });

  it("redacts spec-declared literal values", () => {
    const redactor = createArtifactRedactor(
      { values: ["super-secret-xyz", "731"] },
      {},
    );
    expect(redactor.text("the password is super-secret-xyz; pin=731")).toBe(
      "the password is [redacted]; pin=[redacted]",
    );
  });

  it("applies configured header, query-param, and storage-key names", () => {
    const redactor = createArtifactRedactor(
      {
        headers: ["X-Cairn-Session", "-private"],
        queryParams: ["preview.key"],
        storageKeys: ["tenant.session"],
      },
      {},
    );

    expect(
      redactor.value({
        headers: {
          "x-cairn-session": "raw-header-secret",
          accept: "application/json",
        },
        localStorage: {
          "TENANT.SESSION": "raw-storage-secret",
          theme: "dark",
        },
        storageState: {
          origins: [
            {
              origin: "https://example.test",
              localStorage: [
                { name: "tenant.session", value: "raw-list-secret" },
                { name: "theme", value: "dark" },
              ],
            },
          ],
        },
        url: "https://example.test/?preview.key=raw-query-secret&view=full",
      }),
    ).toEqual({
      headers: {
        "x-cairn-session": "[redacted]",
        accept: "application/json",
      },
      localStorage: {
        "TENANT.SESSION": "[redacted]",
        theme: "dark",
      },
      storageState: {
        origins: [
          {
            origin: "https://example.test",
            localStorage: [
              { name: "tenant.session", value: "[redacted]" },
              { name: "theme", value: "dark" },
            ],
          },
        ],
      },
      url: "https://example.test/?preview.key=[redacted]&view=full",
    });
    expect(
      redactor.text(
        "X-CAIRN-SESSION: raw-text-header\n-private: punctuation-header-secret\nGET /?PREVIEW.KEY=raw-text-query&view=full",
      ),
    ).toBe(
      "X-CAIRN-SESSION: [redacted]\n-private: [redacted]\nGET /?PREVIEW.KEY=[redacted]&view=full",
    );
    expect(
      redactor.text("GET /?auth%5Bcredential%5D=raw-encoded-secret&view=full"),
    ).toBe("GET /?auth%5Bcredential%5D=raw-encoded-secret&view=full");
  });

  it("redacts configured URL-encoded query parameter names", () => {
    const redactor = createArtifactRedactor(
      { queryParams: ["auth[credential]"] },
      {},
    );
    expect(
      redactor.text("GET /?auth%5Bcredential%5D=raw-encoded-secret&view=full"),
    ).toBe("GET /?auth%5Bcredential%5D=[redacted]&view=full");
  });

  it("redacts browser credential keys without treating generic code as secret", () => {
    const redactor = createArtifactRedactor(undefined, {});

    expect(
      redactor.value({
        code: "public-result-code",
        code_verifier: "raw-code-verifier",
        otp: "123456",
        passcode: "raw-passcode",
        credential: "raw-credential",
        assertion: "raw-assertion",
      }),
    ).toEqual({
      code: "public-result-code",
      code_verifier: "[redacted]",
      otp: "[redacted]",
      passcode: "[redacted]",
      credential: "[redacted]",
      assertion: "[redacted]",
    });
    expect(
      redactor.text(
        "https://example.test/callback?code=public-result-code&code_verifier=raw-code-verifier&otp=123456",
      ),
    ).toBe(
      "https://example.test/callback?code=public-result-code&code_verifier=[redacted]&otp=[redacted]",
    );
  });

  it("keeps a bare placeholder under a sensitive key (it names a value, it is not one)", () => {
    const redactor = createArtifactRedactor(undefined, {});
    expect(
      redactor.value({
        fill: { by: "label", name: "Password", value: "${secrets.APP_PW}" },
        vars: { password: "${env.APP_PW}", token: "${vars.token}" },
        headers: { Authorization: "Bearer ${secrets.API}" },
        other: { password: "${env.APP_PW:-literal-default}" },
        literal: { name: "Password", value: "hunter2" },
      }),
    ).toEqual({
      fill: { by: "label", name: "Password", value: "${secrets.APP_PW}" },
      vars: { password: "${env.APP_PW}", token: "${vars.token}" },
      headers: { Authorization: "[redacted]" },
      other: { password: "[redacted]" },
      literal: { name: "Password", value: "[redacted]" },
    });
  });

  it("redacts registered vault values even when the key name is not sensitive", () => {
    // Regression: a vault secret like MONGO_URI dodges SENSITIVE_KEY_RE, so
    // before the fix its plaintext leaked into artifacts.
    registerSecretValues(["mongodb://user:pw@host/db"]);
    const redactor = createArtifactRedactor(undefined, {
      MONGO_URI: "mongodb://user:pw@host/db",
    });
    expect(redactor.text("connecting to mongodb://user:pw@host/db now")).toBe(
      "connecting to [redacted] now",
    );
    // Object values (e.g. resolved spec fields) are scrubbed too.
    expect(
      redactor.value({ open: { path: "mongodb://user:pw@host/db" } }),
    ).toEqual({ open: { path: "[redacted]" } });
  });

  it("redacts credentials embedded in URL userinfo", () => {
    // Regression: demo-import child output embeds full connection URIs whose
    // userinfo (example staging credentials) is never a registered literal.
    const redactor = createArtifactRedactor(undefined, {});
    expect(
      redactor.text(
        "mongodump --uri mongodb+srv://app_user:app_password@db.example.com/?authSource=admin -d test",
      ),
    ).toBe(
      "mongodump --uri mongodb+srv://[redacted]@db.example.com/?authSource=admin -d test",
    );
    expect(redactor.text("http://user:pass@host/path")).toBe(
      "http://[redacted]@host/path",
    );
    // Empty userinfo is scrubbed too (`redis://:pass@host`).
    expect(redactor.text("redis://:secret@host:6379/0")).toBe(
      "redis://[redacted]@host:6379/0",
    );
    // No userinfo → untouched (an @ later in the path is not authority).
    expect(redactor.text("https://host/path@anchor?q=1")).toBe(
      "https://host/path@anchor?q=1",
    );
    // Nested JSON strings are scrubbed too (resolved spec fields, evidence).
    expect(
      redactor.value({ uri: "postgres://db:pass@localhost:5432/app" }),
    ).toEqual({ uri: "postgres://[redacted]@localhost:5432/app" });
  });

  it("clearRegisteredSecretValues resets the registry", () => {
    registerSecretValues(["another-leaky-value"]);
    clearRegisteredSecretValues();
    const redactor = createArtifactRedactor(undefined, {});
    expect(redactor.text("see another-leaky-value")).toBe(
      "see another-leaky-value",
    );
  });
});

describe("multi-line secrets", () => {
  const PEM = [
    "-----BEGIN DEMO KEY-----",
    "MIIEdemoSECRETbodyLINE1",
    "MIIEdemoSECRETbodyLINE2",
    "abc=",
    "-----END DEMO KEY-----",
  ].join("\r\n");

  it("redacts the whole value, and each substantial line on its own", () => {
    const redactor = createArtifactRedactor(undefined, {
      DEMO_PRIVATE_TOKEN: PEM,
    });
    expect(redactor.text(`key: ${PEM} end`)).toBe("key: [redacted] end");
    // A line-at-a-time sink (live logs) sees one line of it.
    expect(redactor.text("MIIEdemoSECRETbodyLINE2")).toBe("[redacted]");
    expect(redactor.text("-----END DEMO KEY-----")).toBe("[redacted]");
    // Lines shorter than 8 characters are not registered on their own.
    expect(redactor.text("abc=")).toBe("abc=");
  });

  it("applies to spec-declared values too", () => {
    const redactor = createArtifactRedactor(
      { values: ['{\n  "private_key": "demo-pk-0042-xyz"\n}'] },
      {},
    );
    // Lines are registered trimmed; indentation around them stays.
    expect(redactor.text('  "private_key": "demo-pk-0042-xyz"')).toBe(
      "  [redacted]",
    );
    expect(redactor.text("}")).toBe("}");
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

describe("withheld child credentials backstop", () => {
  const saved = process.env.FILECHEAP_INGEST_TOKEN;
  const savedTvault = process.env.TVAULT_TOKEN;
  const savedProject = process.env.TVAULT_PROJECT;
  afterEach(() => {
    const restore = restoreEnv;
    restore("FILECHEAP_INGEST_TOKEN", saved);
    restore("TVAULT_TOKEN", savedTvault);
    restore("TVAULT_PROJECT", savedProject);
  });

  it("scrubs publisher and TinyVault tokens even from a filtered env", () => {
    process.env.FILECHEAP_INGEST_TOKEN = "canary-ingest-1234";
    process.env.TVAULT_TOKEN = "canary-tvault-5678";
    process.env.TVAULT_PROJECT = "demo-project";
    // Callers pass the filtered target env, which no longer has these keys.
    const redactor = createArtifactRedactor(undefined, { HOME: "/home/demo" });
    expect(
      redactor.text("ingest=canary-ingest-1234 tv=canary-tvault-5678"),
    ).toBe("ingest=[redacted] tv=[redacted]");
    // A non-sensitive TinyVault control value is not a secret.
    expect(redactor.text("project demo-project")).toBe("project demo-project");
  });
});

describe("createLiveArtifactRedactor", () => {
  afterEach(() => {
    clearRegisteredSecretValues();
  });

  it("picks up values registered after it was created", () => {
    const redactor = createLiveArtifactRedactor(undefined, {});
    expect(redactor.text("late-literal-0042")).toBe("late-literal-0042");
    registerSecretValues(["late-literal-0042"]);
    expect(redactor.text("late-literal-0042")).toBe("[redacted]");
    expect(redactor.value({ note: "late-literal-0042" })).toEqual({
      note: "[redacted]",
    });
  });

  it("rebuilds only when the registered set changes", () => {
    const env: Record<string, string | undefined> = {};
    const redactor = createLiveArtifactRedactor(undefined, env);
    expect(redactor.text("tok_live_0042")).toBe("tok_live_0042");
    // Cached: a later env mutation alone is not seen...
    env.API_TOKEN = "tok_live_0042";
    expect(redactor.text("tok_live_0042")).toBe("tok_live_0042");
    // ...until a registration bumps the version.
    registerSecretValues(["unrelated-literal-7788"]);
    expect(redactor.text("tok_live_0042")).toBe("[redacted]");
  });

  it("applies its config (spec redaction blocks) from the first call", () => {
    const redactor = createLiveArtifactRedactor(
      { values: ["spec-literal-7788"], headers: ["X-Demo-Key"] },
      {},
    );
    expect(redactor.text("echo spec-literal-7788")).toBe("echo [redacted]");
    expect(redactor.text("X-Demo-Key: abc")).toBe("X-Demo-Key: [redacted]");
  });
});
