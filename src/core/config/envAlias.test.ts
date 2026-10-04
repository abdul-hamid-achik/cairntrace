import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { composeConfigText } from "./compose";
import {
  canonicalEnvironment,
  environmentAliasProblems,
  realEnvironmentNames,
} from "./envAlias";
import { resolveProjectRuntimeContext } from "./runtimeContext";
import { buildConfigVars } from "./varsReport";
import { suiteEnvFallbackFindings } from "../suites/validate";
import { environmentEligibility } from "../envPolicy";

let dir: string;
let counter = 0;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-alias-test-"));
});

async function project(config: string): Promise<string> {
  const root = join(dir, `p${++counter}`);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "cairntrace.config.yml"), config);
  return root;
}

async function compose(config: string) {
  const root = await project(config);
  const configPath = join(root, "cairntrace.config.yml");
  return {
    root,
    result: await composeConfigText(config, { configPath, env: {} }),
  };
}

const BASE = `version: 1
vars: { region: eu }
environments:
  stage:
    baseUrl: https://stage.example.test
    vars: { tier: staging }
    policy: { trait: shared }
  remote: { alias: stage }
`;

describe("canonicalEnvironment", () => {
  const environments = { stage: {}, remote: { alias: "stage" } };
  it("maps an alias to its target and leaves other names alone", () => {
    expect(canonicalEnvironment(environments, "remote")).toEqual({
      name: "stage",
      alias: "remote",
    });
    expect(canonicalEnvironment(environments, "stage")).toEqual({
      name: "stage",
    });
    expect(canonicalEnvironment(environments, "nope")).toEqual({
      name: "nope",
    });
    expect(canonicalEnvironment(undefined, "x")).toEqual({ name: "x" });
  });
  it("lists the real environments only", () => {
    expect(realEnvironmentNames(environments)).toEqual(["stage"]);
  });
});

describe("environments.<name>.alias validation", () => {
  it("accepts an alias to a real environment and keeps it as authored", async () => {
    const { result } = await compose(BASE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.config.environments.remote).toEqual({ alias: "stage" });
    expect(result.config.environments.stage?.vars).toMatchObject({
      region: "eu",
      tier: "staging",
    });
  });

  it("rejects an alias combined with other keys", async () => {
    const { result } = await compose(
      BASE.replace(
        "remote: { alias: stage }",
        "remote: { alias: stage, baseUrl: https://x.example.test }",
      ),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain("takes no other keys");
    expect(result.errors.join("\n")).toContain("baseUrl");
  });

  it("rejects an alias to an unknown environment", async () => {
    const { result } = await compose(
      BASE.replace("alias: stage", "alias: missing"),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.join("\n")).toContain('unknown environment "missing"');
  });

  it("rejects alias chains and cycles", async () => {
    const chain = await compose(`${BASE}  third: { alias: remote }\n`);
    expect(chain.result.ok).toBe(false);
    if (!chain.result.ok) {
      expect(chain.result.errors.join("\n")).toContain("alias chain");
    }
    const cycle = await compose(`version: 1
environments:
  a: { alias: b }
  b: { alias: a }
`);
    expect(cycle.result.ok).toBe(false);
    if (!cycle.result.ok) {
      expect(cycle.result.errors.join("\n")).toContain("alias cycle");
    }
    const self = await compose(`version: 1
environments:
  a: { alias: a }
`);
    expect(self.result.ok).toBe(false);
  });

  it("rejects an extends that names an alias, and a suite that names one", async () => {
    const extending = await compose(`${BASE}  child: { extends: remote }\n`);
    expect(extending.result.ok).toBe(false);
    if (!extending.result.ok) {
      expect(extending.result.errors.join("\n")).toContain(
        'extend "stage" instead',
      );
    }
    const suite = await compose(`${BASE}suites:
  smoke:
    specs: ["a.yml"]
    requires: { env: remote }
`);
    expect(suite.result.ok).toBe(false);
    if (!suite.result.ok) {
      expect(suite.result.errors.join("\n")).toContain(
        'is an alias of "stage"',
      );
    }
  });

  it("environmentAliasProblems reports nothing for a plain config", () => {
    expect(environmentAliasProblems({ a: {}, b: { extends: "a" } })).toEqual(
      [],
    );
  });
});

describe("alias canonicalization", () => {
  it("--env <alias> resolves to the target (name, vars, policy, baseUrl) and records the alias", async () => {
    const root = await project(BASE);
    const ctx = await resolveProjectRuntimeContext({
      cwd: root,
      envOverride: "remote",
    });
    expect(ctx.envName).toBe("stage");
    expect(ctx.envAlias).toBe("remote");
    expect(ctx.baseUrl).toBe("https://stage.example.test");
    expect(ctx.vars).toMatchObject({ region: "eu", tier: "staging" });
    expect(ctx.warnings).toEqual([]);
    const direct = await resolveProjectRuntimeContext({
      cwd: root,
      envOverride: "stage",
    });
    expect(direct.envName).toBe("stage");
    expect(direct.envAlias).toBeUndefined();
  });

  it("canonicalizes defaultEnvironment too", async () => {
    const root = await project(`${BASE}defaultEnvironment: remote\n`);
    const ctx = await resolveProjectRuntimeContext({ cwd: root });
    expect(ctx.envName).toBe("stage");
    expect(ctx.envAlias).toBe("remote");
    expect(ctx.envSource).toBe("config-default");
  });

  it("config vars --env <alias> reports the target", async () => {
    const root = await project(BASE);
    const outcome = await buildConfigVars({ cwd: root, env: "remote" });
    expect(outcome.exitCode).toBe(0);
    expect(outcome.result.environments).toEqual(["stage"]);
    expect(outcome.result.filter).toMatchObject({
      env: "stage",
      envAlias: "remote",
    });
    expect(outcome.result.vars.map((row) => row.name).toSorted()).toEqual([
      "region",
      "tier",
    ]);
    const all = await buildConfigVars({ cwd: root });
    expect(all.result.environments).toEqual(["stage"]);
  });

  it("judges an alias as its target in the eligibility list", async () => {
    const root = await project(BASE);
    const ctx = await resolveProjectRuntimeContext({ cwd: root });
    const rows = environmentEligibility({ env: ["stage"] }, ctx.config, {});
    const remote = rows.find((row) => row.name === "remote");
    expect(remote).toMatchObject({ allowed: true, alias: "stage" });
    const listed = environmentEligibility({ env: ["remote"] }, ctx.config, {});
    expect(listed.find((row) => row.name === "remote")?.allowed).toBe(false);
  });
});

const suiteConfig = (
  suite: string,
): Parameters<typeof suiteEnvFallbackFindings>[0] =>
  ({ suites: { smoke: suite } }) as never;

describe("suite-env-fallback", () => {
  it("names the suite and the admitted environment that falls back", () => {
    const findings = suiteEnvFallbackFindings(
      suiteConfig({
        specs: ["a.yml"],
        requires: { env: ["local", "stage", "prod"] },
        env: { local: { specs: ["b.yml"] } },
      } as never),
    );
    expect(findings.map((f) => f.key)).toEqual([
      "suites.smoke.env.stage",
      "suites.smoke.env.prod",
    ]);
    expect(findings[0]?.message).toContain("suites.smoke");
    expect(findings[0]?.message).toContain('"stage"');
  });

  it("stays quiet when every admitted environment, or none, has a block", () => {
    expect(
      suiteEnvFallbackFindings(
        suiteConfig({
          specs: ["a.yml"],
          requires: { env: ["local", "stage"] },
          env: { local: {}, stage: {} },
        } as never),
      ),
    ).toEqual([]);
    expect(
      suiteEnvFallbackFindings(
        suiteConfig({
          specs: ["a.yml"],
          requires: { env: ["local", "stage"] },
        } as never),
      ),
    ).toEqual([]);
    expect(
      suiteEnvFallbackFindings(
        suiteConfig({
          specs: ["a.yml"],
          requires: { env: "local" },
          env: { local: {} },
        } as never),
      ),
    ).toEqual([]);
  });
});
