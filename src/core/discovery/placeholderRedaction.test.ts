import { parseDocument } from "yaml";
import { describe, expect, it } from "vitest";
import { createArtifactRedactor } from "../artifacts/redaction";
import {
  holdsRedacted,
  isTemplateOnly,
  placeholderSafeRedactor,
  redactYamlDocument,
} from "./placeholderRedaction";

const SECRET = "literal-secret-value-789";
const base = createArtifactRedactor(undefined, {}, [SECRET]);
const safe = placeholderSafeRedactor(base);

describe("isTemplateOnly", () => {
  it("accepts placeholders, joined by punctuation, after a scheme word", () => {
    for (const value of [
      "${secrets.CB_TOKEN}",
      "Bearer ${env.API_TOKEN}",
      "${env.USER}:${env.PASS}",
      "${evals.csrf.value}",
    ]) {
      expect(isTemplateOnly(value), value).toBe(true);
    }
  });

  it("rejects literals, defaults and mixed values", () => {
    for (const value of [
      "abc123",
      "Bearer abc123",
      "abc${env.X}",
      "${vars.token:-literal}",
      "Bearer ${env.X} extra",
    ]) {
      expect(isTemplateOnly(value), value).toBe(false);
    }
  });
});

describe("placeholderSafeRedactor", () => {
  it("keeps placeholder-only query and header values", () => {
    const step = {
      request: {
        url: "https://app.test/cb?token=${secrets.CB_TOKEN}&page=2",
        headers: {
          Authorization: "Bearer ${env.API_TOKEN}",
          Cookie: "${secrets.SESSION}",
        },
      },
    };
    expect(safe.value(step)).toEqual(step);
    expect(safe.text("GET https://app.test/cb?token=${secrets.X}")).toBe(
      "GET https://app.test/cb?token=${secrets.X}",
    );
  });

  it("still redacts literal values exactly as the wrapped redactor", () => {
    const step = {
      open: `https://app.test/cb?token=abc123&x=${SECRET}`,
      request: {
        headers: { Authorization: "Bearer abc123" },
        body: { password: "${vars.pw:-hunter2}" },
      },
    };
    const redacted = safe.value(step);
    expect(redacted).toEqual(base.value(step));
    expect(holdsRedacted(redacted)).toBe(true);
    expect(JSON.stringify(redacted)).not.toContain(SECRET);
    expect(JSON.stringify(redacted)).not.toContain("hunter2");
  });
});

describe("redactYamlDocument", () => {
  it("replaces only the scalars that change; placeholders and comments stay", () => {
    const doc = parseDocument(`# keep me
steps:
  - request:
      url: "https://app.test/me?token=\${vars.t}"
      headers:
        Authorization: "Bearer \${env.API_TOKEN}"
  - fill: { by: label, name: Note, value: "${SECRET}" }
`);
    const text = String(redactYamlDocument(doc, (value) => safe.value(value)));
    expect(text).toContain("# keep me");
    expect(text).toContain('url: "https://app.test/me?token=${vars.t}"');
    expect(text).toContain('Authorization: "Bearer ${env.API_TOKEN}"');
    expect(text).not.toContain(SECRET);
    expect(parseDocument(text).errors).toEqual([]);
  });
});
