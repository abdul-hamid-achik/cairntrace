import { afterEach, describe, expect, it } from "vitest";
import {
  clearRegisteredSecretValues,
  createArtifactRedactor,
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

  it("clearRegisteredSecretValues resets the registry", () => {
    registerSecretValues(["another-leaky-value"]);
    clearRegisteredSecretValues();
    const redactor = createArtifactRedactor(undefined, {});
    expect(redactor.text("see another-leaky-value")).toBe(
      "see another-leaky-value",
    );
  });
});
