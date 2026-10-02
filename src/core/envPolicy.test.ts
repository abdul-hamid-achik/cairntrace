import { describe, expect, it } from "vitest";
import {
  environmentEligibility,
  evaluateEnvPolicy,
  isOptInValue,
  refusalDocument,
  requiredEnvNames,
} from "./envPolicy";
import { buildRunNextActions, RunResultSchema } from "./schema/run.v1";
import { ConfigSchema } from "./schema/config.v1";
import { SpecRequiresSchema, SpecSchema } from "./schema/spec.v1";
import { RunEventSchema } from "./schema/events.v1";

describe("evaluateEnvPolicy", () => {
  it("allows any non-protected environment without requires", () => {
    expect(evaluateEnvPolicy({ envName: "dev", env: {} })).toEqual({
      allowed: true,
    });
    expect(
      evaluateEnvPolicy({
        envName: "dev",
        policy: { trait: "shared", mutations: "allow" },
        env: {},
      }).allowed,
    ).toBe(true);
  });

  it("refuses an environment requires.env does not list", () => {
    const verdict = evaluateEnvPolicy({
      requires: { env: ["local", "chalupa"] },
      envName: "dev",
      env: {},
    });
    expect(verdict).toMatchObject({
      allowed: false,
      code: "env-not-listed",
    });
    expect(!verdict.allowed && verdict.reason).toContain('"local", "chalupa"');
    expect(!verdict.allowed && verdict.reason).toContain('"dev"');
  });

  it("needs the opt-in variable at 1/true for an opt-in entry", () => {
    const requires = {
      env: ["local", { dev: { optIn: "CAIRN_ALLOW_DEV_MUTATIONS" } }],
    };
    expect(
      evaluateEnvPolicy({ requires, envName: "dev", env: {} }),
    ).toMatchObject({
      allowed: false,
      code: "opt-in-missing",
      optIn: "CAIRN_ALLOW_DEV_MUTATIONS",
    });
    expect(
      evaluateEnvPolicy({
        requires,
        envName: "dev",
        env: { CAIRN_ALLOW_DEV_MUTATIONS: "yes" },
      }).allowed,
    ).toBe(false);
    for (const value of ["1", "true", "TRUE"]) {
      expect(
        evaluateEnvPolicy({
          requires,
          envName: "dev",
          env: { CAIRN_ALLOW_DEV_MUTATIONS: value },
        }),
      ).toEqual({ allowed: true, optIn: "CAIRN_ALLOW_DEV_MUTATIONS" });
    }
    expect(
      evaluateEnvPolicy({ requires, envName: "local", env: {} }).allowed,
    ).toBe(true);
  });

  it("refuses a mutating spec where mutations are denied", () => {
    expect(
      evaluateEnvPolicy({
        requires: { mutates: true },
        envName: "dev",
        policy: { mutations: "deny", description: "shared QA env" },
        env: {},
      }),
    ).toMatchObject({
      allowed: false,
      code: "mutations-denied",
      reason: expect.stringContaining("shared QA env"),
    });
    // Read-only specs still run there.
    expect(
      evaluateEnvPolicy({
        requires: { mutates: false },
        envName: "dev",
        policy: { mutations: "deny" },
        env: {},
      }).allowed,
    ).toBe(true);
  });

  it("requires a protected environment to be listed explicitly", () => {
    expect(
      evaluateEnvPolicy({
        envName: "prod",
        policy: { trait: "protected" },
        env: {},
      }),
    ).toMatchObject({ allowed: false, code: "protected-env" });
    expect(
      evaluateEnvPolicy({
        requires: { env: ["prod"] },
        envName: "prod",
        policy: { trait: "protected" },
        env: {},
      }).allowed,
    ).toBe(true);
  });

  it("builds the refusal document of the run result", () => {
    const input = {
      requires: { env: ["local"] },
      envName: "dev",
      policy: { trait: "shared" as const },
    };
    const verdict = evaluateEnvPolicy({ ...input, env: {} });
    if (verdict.allowed) throw new Error("expected a refusal");
    expect(refusalDocument(verdict, input)).toEqual({
      reason: verdict.reason,
      env: "dev",
      requires: { env: ["local"] },
      code: "env-not-listed",
      policy: { trait: "shared" },
    });
  });
});

describe("environmentEligibility", () => {
  it("reports every config environment plus undefined required ones", () => {
    const config = ConfigSchema.parse({
      version: 1,
      environments: {
        local: {},
        dev: { policy: { trait: "shared", mutations: "deny" } },
        prod: { policy: { trait: "protected" } },
      },
    });
    const rows = environmentEligibility(
      {
        env: ["local", "dev", { staging: { optIn: "ALLOW_STAGING" } }],
        mutates: true,
      },
      config,
      {},
    );
    expect(rows.map((r) => [r.name, r.allowed, r.code, r.defined])).toEqual([
      ["dev", false, "mutations-denied", true],
      ["local", true, undefined, true],
      ["prod", false, "env-not-listed", true],
      ["staging", false, "opt-in-missing", false],
    ]);
    expect(rows.find((r) => r.name === "dev")).toMatchObject({
      trait: "shared",
      mutations: "deny",
    });
    expect(rows.find((r) => r.name === "staging")?.optIn).toBe("ALLOW_STAGING");
  });

  it("names required environments in authored order", () => {
    expect(
      requiredEnvNames({ env: ["b", { a: { optIn: "X" } }, "c"] }),
    ).toEqual(["b", "a", "c"]);
    expect(requiredEnvNames(undefined)).toEqual([]);
  });

  it("only accepts 1/true as an opt-in", () => {
    expect(isOptInValue("1")).toBe(true);
    expect(isOptInValue(" true ")).toBe(true);
    expect(isOptInValue("0")).toBe(false);
    expect(isOptInValue("")).toBe(false);
    expect(isOptInValue(undefined)).toBe(false);
  });
});

describe("requires / policy schemas", () => {
  it("validates requires.env entries", () => {
    expect(
      SpecRequiresSchema.safeParse({
        env: ["local", { dev: { optIn: "CAIRN_ALLOW_DEV" } }],
        mutates: true,
      }).success,
    ).toBe(true);
    expect(SpecRequiresSchema.safeParse({ env: [] }).success).toBe(false);
    expect(
      SpecRequiresSchema.safeParse({
        env: [{ dev: { optIn: "A" }, prod: { optIn: "B" } }],
      }).success,
    ).toBe(false);
    expect(
      SpecRequiresSchema.safeParse({ env: [{ dev: { optIn: "not a var" } }] })
        .success,
    ).toBe(false);
    expect(SpecRequiresSchema.safeParse({ fixtures: [] }).success).toBe(false);
  });

  it("accepts requires on a spec and policy on an environment", () => {
    expect(
      SpecSchema.safeParse({
        version: 1,
        name: "demo",
        intent: "x",
        requires: { env: ["local"], mutates: true },
        outcomes: [
          { id: "o", description: "d", verify: { url: { matches: "/" } } },
        ],
      }).success,
    ).toBe(true);
    expect(
      ConfigSchema.safeParse({
        version: 1,
        environments: {
          dev: {
            policy: {
              trait: "shared",
              mutations: "deny",
              description: "team QA",
            },
          },
        },
      }).success,
    ).toBe(true);
    expect(
      ConfigSchema.safeParse({
        version: 1,
        environments: { dev: { policy: { trait: "public" } } },
      }).success,
    ).toBe(false);
  });

  it("accepts a refused run document, its event and its next action", () => {
    const refused = {
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId: "refused_1_abc",
      runDir: "/tmp/.cairntrace/refused/refused_1_abc",
      spec: { name: "demo", path: "/tmp/demo.yml" },
      environment: "dev",
      backend: "mock",
      coldStart: false,
      status: "refused",
      refusal: {
        reason:
          'requires.env allows "local"; the resolved environment is "dev"',
        env: "dev",
        requires: { env: ["local"] },
        code: "env-not-listed",
      },
      summary: "refused: …",
      failure: { phase: "policy", message: "refused" },
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      outcomes: [{ id: "o", status: "skipped" }],
      steps: [],
      artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
      exitCode: 7,
    };
    const parsed = RunResultSchema.parse(refused);
    expect(buildRunNextActions(parsed)[0]?.command).toBe(
      "cairn spec verify /tmp/demo.yml --json",
    );
    expect(
      RunEventSchema.safeParse({
        ts: "2026-01-01T00:00:00.000Z",
        type: "run.refused",
        spec: "demo",
        reason: "refused",
        env: "dev",
        code: "env-not-listed",
        index: 1,
        path: "/tmp/demo.yml",
      }).success,
    ).toBe(true);
  });
});
