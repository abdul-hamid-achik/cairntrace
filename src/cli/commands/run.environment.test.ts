import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { UnknownEnvironmentError } from "../../core/config/runtimeContext";
import { InvocationJournalSchema } from "../../core/schema/events.v1";
import { RunResultSchema } from "../../core/schema/run.v1";
import { BatchRunResultSchema } from "../../core/schema/runBatch.v1";
import { preflightEnvironments, synthesizeErroredResult } from "./run";

const CAIRN = join(process.cwd(), "bin", "cairn");
/** Each test spawns bin/cairn; vitest's 5s default is too tight under load. */
const E2E_TIMEOUT_MS = 30_000;

const SPEC = (name: string, environment?: string) => `version: 1
name: ${name}
intent: A mock run that passes.
coldStart: guest
${environment ? `environment: ${environment}\n` : ""}steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

const CONFIG = `version: 1
environments:
  local: {}
  staging: {}
`;

async function project(): Promise<{
  dir: string;
  artifactRoot: string;
  a: string;
  b: string;
}> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-run-env-"));
  await writeFile(join(dir, "cairntrace.config.yml"), CONFIG);
  const a = join(dir, "a.yml");
  const b = join(dir, "b.yml");
  await writeFile(a, SPEC("env_a"));
  await writeFile(b, SPEC("env_b"));
  return { dir, artifactRoot: join(dir, "runs"), a, b };
}

function cairn(args: string[], cwd: string) {
  return execa(CAIRN, args, {
    cwd,
    reject: false,
    timeout: 25_000,
    env: { CAIRN_LOG_LEVEL: "warn", NO_COLOR: "1" },
  });
}

describe("cairn run with an unknown --env", () => {
  it(
    "exits 4 with a schema-valid errored RunResult on stdout, before hooks or runs",
    async () => {
      const { dir, artifactRoot, a } = await project();
      const marker = join(dir, "before-ran");
      const result = await cairn(
        [
          "run",
          a,
          "--mock",
          "--env",
          "nope",
          "--artifact-root",
          artifactRoot,
          "--before",
          `touch ${JSON.stringify(marker)}`,
          "--format",
          "json",
        ],
        dir,
      );
      expect(result.exitCode, result.stderr).toBe(4);
      const doc = RunResultSchema.parse(JSON.parse(result.stdout));
      expect(doc.status).toBe("errored");
      expect(doc.exitCode).toBe(4);
      expect(doc.environment).toBe("nope");
      expect(doc.failure?.message).toContain('unknown environment "nope"');
      expect(doc.failure?.message).toContain("local, staging");
      expect(result.stderr).toContain('unknown environment "nope"');
      // Nothing ran: no hook, no run directory, no invocation journal.
      expect(existsSync(marker)).toBe(false);
      expect(existsSync(artifactRoot)).toBe(false);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "emits a batch document (exit 4) for several specs",
    async () => {
      const { dir, artifactRoot, a, b } = await project();
      const result = await cairn(
        [
          "run",
          a,
          b,
          "--mock",
          "--env",
          "nope",
          "--artifact-root",
          artifactRoot,
          "--json",
        ],
        dir,
      );
      expect(result.exitCode, result.stderr).toBe(4);
      const batch = BatchRunResultSchema.parse(JSON.parse(result.stdout));
      expect(batch.exitCode).toBe(4);
      expect(batch.summary).toEqual({
        total: 2,
        passed: 0,
        failed: 0,
        errored: 2,
      });
      expect(batch.results.map((r) => r.exitCode)).toEqual([4, 4]);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "exits 4 under --format md with the error on stderr and nothing on stdout",
    async () => {
      const { dir, artifactRoot, a } = await project();
      const result = await cairn(
        ["run", a, "--mock", "--env", "nope", "--artifact-root", artifactRoot],
        dir,
      );
      expect(result.exitCode).toBe(4);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain('unknown environment "nope"');
    },
    E2E_TIMEOUT_MS,
  );
});

describe("cairn run environment warnings", () => {
  it(
    "prints an undefined spec environment warning once per invocation (stderr)",
    async () => {
      const { dir, artifactRoot, a, b } = await project();
      await writeFile(a, SPEC("env_a", "qa"));
      await writeFile(b, SPEC("env_b", "qa"));
      const result = await cairn(
        ["run", a, b, "--mock", "--artifact-root", artifactRoot, "--json"],
        dir,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const warnings = result.stderr
        .split("\n")
        .filter((line) => line.includes(`environment "qa" is not defined`));
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("known: local, staging");
      // The runs still happened (a default environment is not a request).
      expect(
        (await readdir(artifactRoot)).filter((d) => !d.startsWith("_")),
      ).toHaveLength(2);
    },
    E2E_TIMEOUT_MS,
  );
});

describe("preflightEnvironments / synthesizeErroredResult", () => {
  it("dedupes warnings and returns the unknown --env error", async () => {
    const { a, b } = await project();
    await writeFile(a, SPEC("env_a", "qa"));
    await writeFile(b, SPEC("env_b", "qa"));
    const warnings: string[] = [];
    const ok = await preflightEnvironments(
      [a, b],
      {},
      (m) => warnings.push(m),
      {},
    );
    expect(ok).toBeUndefined();
    expect(warnings).toHaveLength(1);

    const err = await preflightEnvironments([a], { env: "nope" }, () => {}, {});
    expect(err).toBeInstanceOf(UnknownEnvironmentError);
    expect(err?.knownEnvironments).toEqual(["local", "staging"]);
  });

  it("warns once when an exported CAIRN_TVAULT_ENV names another environment", async () => {
    const { a, b } = await project();
    await writeFile(a, SPEC("env_a", "local"));
    await writeFile(b, SPEC("env_b", "local"));
    const warnings: string[] = [];
    await preflightEnvironments([a, b], {}, (m) => warnings.push(m), {
      CAIRN_TVAULT_ENV: "staging",
    });
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(
      'CAIRN_TVAULT_ENV is "staging" but this run resolves environment "local"',
    );
    expect(warnings[0]).toContain("pass --env staging");

    // The same name, or nothing exported, is silent.
    const quiet: string[] = [];
    await preflightEnvironments([a], { env: "staging" }, (m) => quiet.push(m), {
      CAIRN_TVAULT_ENV: "staging",
    });
    await preflightEnvironments([a], {}, (m) => quiet.push(m), {});
    expect(quiet).toEqual([]);
  });

  it("maps UnknownEnvironmentError to exit 4", () => {
    const result = synthesizeErroredResult(
      "/specs/a.yml",
      new UnknownEnvironmentError("nope", "override", ["local"], "/c.yml"),
    );
    expect(result.exitCode).toBe(4);
    expect(result.environment).toBe("nope");
    expect(
      synthesizeErroredResult("/specs/a.yml", new Error("boom")).exitCode,
    ).toBe(2);
  });
});

describe("cairn run --env <alias>", () => {
  const ALIAS_CONFIG = `version: 1
environments:
  local: {}
  staging: {}
  remote: { alias: staging }
`;

  it(
    "canonicalizes to the target: policy, run.json and the journal see staging",
    async () => {
      const { dir, artifactRoot, a } = await project();
      await writeFile(join(dir, "cairntrace.config.yml"), ALIAS_CONFIG);
      // requires.env lists the TARGET; the alias must still be admitted.
      await writeFile(
        a,
        SPEC("env_a").replace(
          "coldStart: guest\n",
          "coldStart: guest\nrequires:\n  env: [staging]\n",
        ),
      );
      const result = await cairn(
        [
          "run",
          a,
          "--mock",
          "--env",
          "remote",
          "--artifact-root",
          artifactRoot,
          "--json",
        ],
        dir,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const doc = RunResultSchema.parse(JSON.parse(result.stdout));
      expect(doc.status).toBe("passed");
      expect(doc.environment).toBe("staging");
      expect(doc.envAlias).toBe("remote");
      const onDisk = RunResultSchema.parse(
        JSON.parse(await readFile(join(doc.runDir, "run.json"), "utf8")),
      );
      expect(onDisk.environment).toBe("staging");
      expect(onDisk.envAlias).toBe("remote");
      const journals = await readdir(join(artifactRoot, "_invocations"));
      expect(journals).toHaveLength(1);
      const journal = InvocationJournalSchema.parse(
        JSON.parse(
          await readFile(
            join(artifactRoot, "_invocations", journals[0]!, "invocation.json"),
            "utf8",
          ),
        ),
      );
      expect(journal.env).toBe("staging");
      expect(journal.envAlias).toBe("remote");
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "leaves envAlias off a run that used the real name",
    async () => {
      const { dir, artifactRoot, a } = await project();
      await writeFile(join(dir, "cairntrace.config.yml"), ALIAS_CONFIG);
      const result = await cairn(
        [
          "run",
          a,
          "--mock",
          "--env",
          "staging",
          "--artifact-root",
          artifactRoot,
          "--json",
        ],
        dir,
      );
      expect(result.exitCode, result.stderr).toBe(0);
      const doc = RunResultSchema.parse(JSON.parse(result.stdout));
      expect(doc.environment).toBe("staging");
      expect(doc.envAlias).toBeUndefined();
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "a suite that requires the target runs under --env <alias>",
    async () => {
      const { dir } = await project();
      await writeFile(
        join(dir, "cairntrace.config.yml"),
        `${ALIAS_CONFIG}suites:
  smoke:
    specs: [a.yml]
    requires: { env: staging }
`,
      );
      const viaAlias = await cairn(
        [
          "run",
          "--suite",
          "smoke",
          "--env",
          "remote",
          "--select-only",
          "--json",
        ],
        dir,
      );
      expect(viaAlias.exitCode, viaAlias.stderr).toBe(0);
      expect(JSON.parse(viaAlias.stdout).selected).toHaveLength(1);
      const wrong = await cairn(
        [
          "run",
          "--suite",
          "smoke",
          "--env",
          "local",
          "--select-only",
          "--json",
        ],
        dir,
      );
      expect(wrong.exitCode).not.toBe(0);
    },
    E2E_TIMEOUT_MS,
  );

  it("does not warn about a CAIRN_TVAULT_ENV that names the alias", async () => {
    const { dir, a } = await project();
    await writeFile(join(dir, "cairntrace.config.yml"), ALIAS_CONFIG);
    const warnings: string[] = [];
    await preflightEnvironments(
      [a],
      { env: "remote" },
      (m) => warnings.push(m),
      { CAIRN_TVAULT_ENV: "remote" },
    );
    expect(warnings).toEqual([]);
  });
});
