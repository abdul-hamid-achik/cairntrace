import { describe, expect, it } from "vitest";
import {
  credentialPathContext,
  isCredentialHeader,
  isIdentifierHeader,
  looksCredentialKey,
  looksSecretName,
  looksSecretPathSegment,
  nameWords,
  redactUrlCredentials,
  tokenAfterCredentialName,
} from "./importCommon";

describe("credential names are whole words, never substrings", () => {
  it("splits separators and camelCase", () => {
    expect(nameWords("X-CSRFToken")).toEqual(["x", "csrf", "token"]);
    expect(nameWords("passwordField")).toEqual(["password", "field"]);
    expect(nameWords("Mot de passe")).toEqual(["mot", "de", "passe"]);
    expect(nameWords("APIKey")).toEqual(["api", "key"]);
  });

  it.each([
    "password",
    "Password",
    "passwordConfirm",
    "#password",
    "selectors.pwd",
    "Mot de passe",
    "pin",
    "PIN code",
    "otp",
    "one-time code",
    "api_key",
    "x-api-key",
    "apiKey",
    "privateKey",
    "client_secret",
    "access_token",
    "id_token",
    "X-CSRFToken",
    "authToken",
    "token",
    "session_id",
    "jwt",
    "credentials",
    "Authorization",
  ])("%s names a credential", (name) => {
    expect(looksSecretName(name)).toBe(true);
  });

  it.each([
    "Compass heading",
    "Passenger count",
    "passengers",
    "#tokenizer",
    "token_count",
    "token_type",
    "max_tokens",
    "secretary",
    "spinner",
    "opinion",
    "author",
    "x-session-locale",
    "signature",
    "bypassCache",
  ])("%s does not", (name) => {
    expect(looksSecretName(name)).toBe(false);
  });

  it("headers: auth / csrf / signature words and a session that names one", () => {
    for (const name of [
      "authorization",
      "cookie",
      "x-auth",
      "x-auth-token",
      "X-CSRFToken",
      "x-xsrf-token",
      "x-hub-signature-256",
      "x-request-sig",
      "x-session",
      "x-session-id",
      "x-api-key",
    ]) {
      expect(isCredentialHeader(name), name).toBe(true);
    }
    for (const name of [
      "x-session-locale",
      "x-request-id",
      "x-token-count",
      "accept-language",
      "x-trace",
    ]) {
      expect(isCredentialHeader(name), name).toBe(false);
    }
  });

  it("body keys: a signature or a locale is not a credential key by name", () => {
    expect(looksCredentialKey("auth")).toBe(true);
    expect(looksCredentialKey("csrf")).toBe(true);
    expect(looksCredentialKey("pin")).toBe(true);
    expect(looksCredentialKey("signature")).toBe(false);
    expect(looksCredentialKey("session_locale")).toBe(false);
    expect(looksCredentialKey("note")).toBe(false);
  });

  it("identifier headers carry ids, not keys", () => {
    for (const name of [
      "x-request-id",
      "X-Correlation-ID",
      "x-amzn-trace-id",
      "traceparent",
      "etag",
    ]) {
      expect(isIdentifierHeader(name), name).toBe(true);
    }
    expect(isIdentifierHeader("x-api-key")).toBe(false);
    expect(isIdentifierHeader("x-client")).toBe(false);
  });
});

describe("path segments", () => {
  // Built at run time: no secret-shaped literal in the file.
  const hex = Array.from({ length: 32 }, (_, i) =>
    "0123456789abcdef".charAt((i * 7) % 16),
  ).join("");
  const sha = `${hex}12345678`;

  it("a hex segment is a credential only after a credential-context segment", () => {
    expect(looksSecretPathSegment(sha)).toBe(false);
    expect(credentialPathContext("commit")).toBe(false);
    expect(credentialPathContext("avatar")).toBe(false);
    expect(credentialPathContext("reset-password")).toBe(true);
    expect(credentialPathContext("reset")).toBe(true);
    expect(credentialPathContext("verify")).toBe(true);
    // a plural REST collection names records
    expect(credentialPathContext("tokens")).toBe(false);
    expect(tokenAfterCredentialName("tokens", "abc12345")).toBe(false);
    expect(tokenAfterCredentialName("reset", hex)).toBe(true);
  });

  it("redactUrlCredentials keeps commit SHAs, digests and collection ids, and still takes reset tokens", () => {
    const seen: string[] = [];
    const sink = (hint: string, value: string): string => {
      seen.push(value);
      return `\${secrets.${hint.toUpperCase().replace(/\W+/g, "_")}}`;
    };
    expect(redactUrlCredentials(`/commit/${sha}`, sink)).toBe(`/commit/${sha}`);
    expect(redactUrlCredentials(`/avatar/${hex}`, sink)).toBe(`/avatar/${hex}`);
    expect(redactUrlCredentials("/api/tokens/abc12345", sink)).toBe(
      "/api/tokens/abc12345",
    );
    expect(seen).toEqual([]);
    expect(redactUrlCredentials(`/reset-password/${hex}`, sink)).toBe(
      "/reset-password/${secrets.RESET_PASSWORD_TOKEN}",
    );
    expect(redactUrlCredentials(`/reset/${hex}`, sink)).toBe(
      "/reset/${secrets.PATH_TOKEN}",
    );
    expect(seen).toEqual([hex, hex]);
  });
});
