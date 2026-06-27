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
      { values: ["super-secret-xyz"] },
      {},
    );
    expect(redactor.text("the password is super-secret-xyz")).toBe(
      "the password is [redacted]",
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
