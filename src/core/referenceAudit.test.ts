import { describe, expect, it } from "vitest";
import {
  auditPlaceholderReferences,
  type ReferenceFinding,
} from "./referenceAudit";

const spec = (body: string) => ({ path: "flows/demo.yml", text: body });

describe("auditPlaceholderReferences", () => {
  it("flags ${env.X} without a default when nothing supplies it", () => {
    const findings = auditPlaceholderReferences(
      [spec('open: "${env.UNDEFINED_VAR}/page"')],
      { env: {} },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      file: "flows/demo.yml",
      token: "${env.UNDEFINED_VAR}",
    });
    expect(findings[0]!.message).toContain("empty string");
  });

  it("accepts ${env.X} with a :-default", () => {
    const findings = auditPlaceholderReferences(
      [spec('open: "${env.CAIRN_TVAULT_ENV:-local}/page"')],
      { env: {} },
    );
    expect(findings).toEqual([]);
  });

  it("accepts ${env.X} present in the ambient env", () => {
    const findings = auditPlaceholderReferences(
      [spec('open: "${env.MY_TOKEN}/page"')],
      { env: { MY_TOKEN: "set" } },
    );
    expect(findings).toEqual([]);
  });

  it("accepts ${env.X} declared in config secrets.required", () => {
    const findings = auditPlaceholderReferences(
      [spec('open: "${env.GRAPHITE_E2E_EMAIL}"')],
      { env: {}, secretsRequired: ["GRAPHITE_E2E_EMAIL"] },
    );
    expect(findings).toEqual([]);
  });

  it("accepts the CAIRN_* framework namespace without a default", () => {
    const findings = auditPlaceholderReferences(
      [spec('open: "${env.CAIRN_ANSWER_CHANGE_ROUTE}"')],
      { env: {} },
    );
    expect(findings).toEqual([]);
  });

  it("flags ${secrets.X} not in config secrets.required", () => {
    const findings = auditPlaceholderReferences(
      [spec('open: "${secrets.MONGO_URI}"')],
      { secretsRequired: ["GRAPHITE_E2E_EMAIL"] },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.token).toBe("${secrets.MONGO_URI}");
    expect(findings[0]!.message).toContain("secrets.required");
  });

  it("accepts ${secrets.X} declared in config secrets.required", () => {
    const findings = auditPlaceholderReferences(
      [spec('open: "${secrets.DEMO_IMPORT_MONGO_LOCAL_URI}"')],
      { secretsRequired: ["DEMO_IMPORT_MONGO_LOCAL_URI"] },
    );
    expect(findings).toEqual([]);
  });

  it("ignores doc examples inside full-line YAML comments", () => {
    const findings = auditPlaceholderReferences(
      [
        spec(
          [
            "# Example: ${env.SOME_VAR} without a default is not real usage.",
            'open: "/page"',
          ].join("\n"),
        ),
      ],
      { env: {} },
    );
    expect(findings).toEqual([]);
  });

  it("audits imported action files too", () => {
    const findings = auditPlaceholderReferences(
      [
        { path: "flows/demo.yml", text: "steps: [{ use: login }]" },
        { path: "actions/login.yml", text: 'open: "${env.NOT_SUPPLIED}"' },
      ],
      { env: {} },
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]!.file).toBe("actions/login.yml");
  });

  it("does not flag nested default expressions as missing", () => {
    const findings = auditPlaceholderReferences(
      [spec('open: "${env.NODE_ENV:-development}"')],
      { env: {} },
    );
    expect(findings).toEqual([]);
  });

  it("collects multiple findings across tokens and files", () => {
    const findings = auditPlaceholderReferences(
      [
        spec('open: "${env.A}/x"\nnext: "${secrets.B}"'),
        { path: "actions/other.yml", text: 'run: "${env.C}"' },
      ],
      { env: {} },
    );
    const tokens = findings.map((f: ReferenceFinding) => f.token).sort();
    expect(tokens).toEqual(["${env.A}", "${env.C}", "${secrets.B}"]);
  });
});
