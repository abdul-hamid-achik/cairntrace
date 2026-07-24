import { describe, expect, it } from "vitest";
import { AuditResultSchema } from "./audit.v1";
import { CodeMatchSchema, InvestigateResultSchema } from "./investigate.v1";

const codeMatch = {
  file: "src/auth/login.ts",
  line: 42,
  score: 0.89,
  symbol: "handleSubmit",
  codemapScore: 0.75,
  riskScore: 0.4,
  riskLevel: "medium" as const,
};

describe("investigate and audit v1 result contracts", () => {
  it("adds the investigate v1 schema id and accepts the documented result", () => {
    expect(
      InvestigateResultSchema.parse({
        version: "1",
        runId: "run-123",
        runDir: "/tmp/runs/run-123",
        stashId: "stash-123",
        codeMatches: [codeMatch],
        mode: "hybrid",
        pathAnnotations: 2,
      }),
    ).toEqual({
      $schema: "urn:cairntrace.dev:investigate:v1",
      version: "1",
      runId: "run-123",
      runDir: "/tmp/runs/run-123",
      stashId: "stash-123",
      codeMatches: [codeMatch],
      mode: "hybrid",
      pathAnnotations: 2,
    });
  });

  it("adds the audit v1 schema id and accepts setup-error results", () => {
    expect(
      AuditResultSchema.parse({
        version: "1",
        specPath: "flows/login.yml",
        codeMatches: [],
        error: "spec could not be loaded",
      }),
    ).toEqual({
      $schema: "urn:cairntrace.dev:audit:v1",
      version: "1",
      specPath: "flows/login.yml",
      codeMatches: [],
      error: "spec could not be loaded",
    });
  });

  it("rejects malformed fields instead of coercing wire data", () => {
    expect(
      CodeMatchSchema.safeParse({
        ...codeMatch,
        line: "42",
      }).success,
    ).toBe(false);
    expect(
      AuditResultSchema.safeParse({
        version: "1",
        specPath: "flows/login.yml",
        codeMatches: [],
        exitCode: 200,
      }).success,
    ).toBe(false);
  });

  it("rejects version and additive shape drift", () => {
    expect(
      InvestigateResultSchema.safeParse({
        version: "2",
        runId: "run-123",
        runDir: "/tmp/runs/run-123",
        codeMatches: [],
      }).success,
    ).toBe(false);
    expect(
      AuditResultSchema.safeParse({
        version: "1",
        specPath: "flows/login.yml",
        codeMatches: [],
        unversionedField: true,
      }).success,
    ).toBe(false);
  });
});
