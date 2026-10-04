import { existsSync } from "node:fs";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { RunEventSchema, type RunEvent } from "../../core/schema/events.v1";
import {
  executeRunInvocation,
  type RunInvocationResult,
} from "./executeRunInvocation";

/**
 * `cairn run --suite`: spec resolution (paths, globs, names, tags, order,
 * per-environment override), suite vars / parallel / bail, the
 * once-per-invocation before/after hooks (bounded, journaled, after-hooks on
 * every exit path), `requires`, usage errors and `seed.postCommands.skip` —
 * against the mock backend, stub shell commands and a temp dir.
 */

let dir: string;
/** Run artifacts live outside the project (as a real artifact root does). */
let runsRoot: string;
let counter = 0;

const spec = (name: string, extra = ""): string => `version: 1
name: ${name}
intent: A mock run that passes.
coldStart: guest
${extra}steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;
const failing = (name: string): string =>
  spec(name).replace('matches: "/home"', 'matches: "/never"');

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-suite-"));
  runsRoot = await mkdtemp(join(tmpdir(), "cairn-suite-runs-"));
  await mkdir(join(dir, "flows", "smoke"), { recursive: true });
  await mkdir(join(dir, "flows", "deep", "_wip"), { recursive: true });
  await writeFile(join(dir, "flows", "alpha.yml"), spec("alpha"));
  await writeFile(
    join(dir, "flows", "bravo.yml"),
    spec("bravo", "metadata:\n  tags: [smoke, Critical]\n"),
  );
  await writeFile(
    join(dir, "flows", "smoke", "charlie.yml"),
    spec("charlie", "metadata:\n  tags: [smoke]\n"),
  );
  await writeFile(join(dir, "flows", "smoke", "delta.yml"), spec("delta"));
  await writeFile(join(dir, "flows", "broken.yml"), failing("broken"));
  await writeFile(join(dir, "flows", "deep", "echo.yml"), spec("echo"));
  await writeFile(join(dir, "flows", "deep", "_wip", "draft.yml"), spec("wip"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(runsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  counter += 1;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

async function config(body: string, name = `cfg-${counter}`): Promise<string> {
  const path = join(dir, `${name}.config.yml`);
  await writeFile(
    path,
    `version: 1
project: suite-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
  staging:
    baseUrl: https://staging.example.test
${body}`,
  );
  return path;
}

async function run(
  configPath: string,
  options: Record<string, unknown> = {},
  specs: string[] = [],
): Promise<RunInvocationResult> {
  return executeRunInvocation(
    {
      specs: specs.map((s) => join(dir, s)),
      options: {
        mock: true,
        config: configPath,
        artifactRoot: join(runsRoot, `runs-${counter}`),
        noWebServer: true,
        noServices: true,
        ...options,
      },
      cwd: dir,
    },
    { origin: "cli" },
  );
}

async function events(result: RunInvocationResult): Promise<RunEvent[]> {
  const text = await readFile(
    join(result.journalDir!, "events.ndjson"),
    "utf8",
  );
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
}

const types = (all: RunEvent[]): string[] => all.map((event) => event.type);

function ranSpecs(result: RunInvocationResult): string[] {
  const document = result.document as {
    results?: Array<{ spec: { name: string } }>;
    spec?: { name: string };
  };
  return document.results
    ? document.results.map((r) => r.spec.name)
    : [document.spec!.name];
}

async function lines(path: string): Promise<string[]> {
  return existsSync(path)
    ? (await readFile(path, "utf8")).split("\n").filter(Boolean)
    : [];
}

describe("--suite resolution", () => {
  it("runs a suite's specs in `order`, then the rest of the selection", async () => {
    const cfg = await config(`suites:
  mixed:
    description: ordered selection
    specs: [flows/alpha.yml, flows/smoke, bravo]
    order: [delta, bravo]
`);
    const result = await run(cfg, { suite: "mixed" });
    expect(result.exitCode).toBe(0);
    expect(ranSpecs(result)).toEqual(["delta", "bravo", "alpha", "charlie"]);
    // Every run carries its suite as a cohort label (stats --group-by suite).
    const labels = (
      result.document as { results: Array<{ labels?: Record<string, string> }> }
    ).results.map((r) => r.labels?.suite);
    expect(labels).toEqual(["mixed", "mixed", "mixed", "mixed"]);
    const all = await events(result);
    for (const event of all) {
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    }
    expect(types(all).filter((t) => t.startsWith("suite."))).toEqual([
      "suite.started",
      "suite.finished",
    ]);
    const started = all.find((e) => e.type === "suite.started")!;
    expect(started).toMatchObject({ name: "mixed", env: "local", specs: 4 });
    const journal = JSON.parse(
      await readFile(join(result.journalDir!, "invocation.json"), "utf8"),
    ) as { suite?: string; argv: string[] };
    expect(journal.suite).toBe("mixed");
    // The journal's argv names the suite, not the specs it resolved to.
    expect(journal.argv.slice(0, 1)).toEqual(["run"]);
    expect(journal.argv).toEqual(
      expect.arrayContaining(["--suite", "mixed", "--config", cfg]),
    );
    expect(journal.argv.filter((arg) => arg.includes("flows"))).toEqual([]);
  });

  it("takes globs (no drafts), directories and tag filters", async () => {
    const cfg = await config(`suites:
  globbed:
    specs: ["flows/**/*.yml"]
    tags: [smoke]
  everything:
    specs: [flows/deep/**]
  by-tag:
    tags: [critical]
`);
    expect(ranSpecs(await run(cfg, { suite: "globbed" }))).toEqual([
      "bravo",
      "charlie",
    ]);
    // `dir/**` is "everything below dir"; the _wip draft is left out.
    expect(ranSpecs(await run(cfg, { suite: "everything" }))).toEqual(["echo"]);
    // Tags only: every non-draft spec in the project, tag match is
    // case-insensitive.
    expect(ranSpecs(await run(cfg, { suite: "by-tag" }))).toEqual(["bravo"]);
  });

  it("lets an environment replace `specs` and apply its own vars", async () => {
    const cfg = await config(`suites:
  per-env:
    specs: [flows/alpha.yml]
    vars: { region: eu, tier: base }
    env:
      staging:
        specs: [flows/bravo.yml, flows/alpha.yml]
        vars: { tier: staging }
`);
    expect(
      ranSpecs(await run(cfg, { suite: "per-env", env: "staging" })),
    ).toEqual(["bravo", "alpha"]);
    expect(ranSpecs(await run(cfg, { suite: "per-env" }))).toEqual(["alpha"]);
  });

  it("narrows to the spec paths next to it, which must be its own (else exit 2, nothing runs)", async () => {
    const cfg = await config(
      "suites:\n  s: { specs: [flows/alpha.yml, flows/bravo.yml], labels: { lane: narrow } }\n",
    );
    const narrowed = await run(cfg, { suite: "s" }, ["flows/bravo.yml"]);
    expect(narrowed.exitCode).toBe(0);
    expect(ranSpecs(narrowed)).toEqual(["bravo"]);
    expect(
      (narrowed.document as { labels?: Record<string, string> }).labels,
    ).toMatchObject({ suite: "s", lane: "narrow" });
    const outside = await config(
      "suites:\n  t: { specs: [flows/alpha.yml] }\n",
    );
    const result = await run(outside, { suite: "t" }, ["flows/bravo.yml"]);
    expect(result).toMatchObject({ kind: "errored", exitCode: 2, fatal: true });
    expect(result.error).toContain("flows/bravo.yml is not among them");
    expect(result.runDirs).toEqual([]);
  });

  it("names the known suites for an unknown one (exit 4)", async () => {
    const cfg = await config("suites:\n  s: { specs: [flows/alpha.yml] }\n");
    const result = await run(cfg, { suite: "nope" });
    expect(result).toMatchObject({ kind: "errored", exitCode: 4 });
    expect(result.error).toContain('unknown suite "nope"');
    expect(result.error).toContain("defines: s");
  });

  it("fails on an unresolvable reference, an ambiguous name and an empty selection (exit 4)", async () => {
    await writeFile(join(dir, "flows", "dup1.yml"), spec("twin"));
    await writeFile(join(dir, "flows", "smoke", "dup2.yml"), spec("twin"));
    const cfg = await config(`suites:
  missing: { specs: [flows/nope.yml] }
  twins: { specs: [twin] }
  nothing: { specs: [flows/alpha.yml], tags: [no-such-tag] }
  stray-order: { specs: [flows/alpha.yml], order: [flows/bravo.yml] }
`);
    for (const [suite, text] of [
      ["missing", "is not a spec file, directory, glob or spec name"],
      ["twins", "is ambiguous"],
      ["nothing", "selects no specs"],
      ["stray-order", "is not in the suite's selection"],
    ] as const) {
      const result = await run(cfg, { suite });
      expect(result, suite).toMatchObject({ kind: "errored", exitCode: 4 });
      expect(result.error, suite).toContain(text);
    }
    await rm(join(dir, "flows", "dup1.yml"));
    await rm(join(dir, "flows", "smoke", "dup2.yml"));
  });

  it("refuses (exit 7) an environment or var `requires` rules out", async () => {
    const cfg = await config(`suites:
  guarded:
    specs: [flows/alpha.yml]
    requires: { env: staging, vars: [region] }
`);
    const wrongEnv = await run(cfg, { suite: "guarded" });
    expect(wrongEnv).toMatchObject({ kind: "errored", exitCode: 7 });
    expect(wrongEnv.error).toContain("requires environment staging");
    const noVar = await run(cfg, { suite: "guarded", env: "staging" });
    expect(noVar).toMatchObject({ exitCode: 7 });
    expect(noVar.error).toContain('requires var "region"');
    const ok = await run(cfg, {
      suite: "guarded",
      env: "staging",
      var: ["region=eu"],
    });
    expect(ok.exitCode).toBe(0);
  });

  it("composes through include: and honors --select-only", async () => {
    await writeFile(
      join(dir, `included-${counter}.yml`),
      "suites:\n  from-include:\n    specs: [flows/charlie.yml, flows/smoke/charlie.yml]\n",
    );
    // A bare name that is also a path-less spec resolves by name.
    await writeFile(
      join(dir, `included-${counter}.yml`),
      "suites:\n  from-include:\n    specs: [charlie, delta]\n",
    );
    const cfg = await config(`include: [included-${counter}.yml]\n`);
    const result = await run(cfg, { suite: "from-include", selectOnly: true });
    expect(result).toMatchObject({ kind: "selection", exitCode: 0 });
    const selected = (
      result.document as { selected: Array<{ name: string }> }
    ).selected.map((s) => s.name);
    expect(selected).toEqual(["charlie", "delta"]);
  });
});

describe("suite settings", () => {
  it("applies the suite's vars (--var wins) and parallel (--parallel wins)", async () => {
    const cfg = await config(`suites:
  vars:
    specs: [flows/alpha.yml, flows/bravo.yml]
    parallel: 2
    vars: { who: suite }
`);
    const result = await run(cfg, { suite: "vars" });
    expect((result.document as { parallel: number }).parallel).toBe(2);
    const wide = await run(cfg, { suite: "vars", parallel: 1 });
    expect((wide.document as { parallel: number }).parallel).toBe(1);
  });

  it("bails after the first failure and reports the rest as skipped", async () => {
    const cfg = await config(`suites:
  stops:
    bail: true
    specs: [flows/alpha.yml, flows/broken.yml, flows/bravo.yml]
`);
    const result = await run(cfg, { suite: "stops" });
    expect(result.exitCode).toBe(1);
    expect(ranSpecs(result)).toEqual(["alpha", "broken"]);
    const batch = result.document as {
      skipped?: Array<{ reason: string }>;
    };
    expect(batch.skipped).toHaveLength(1);
    expect(batch.skipped![0]!.reason).toBe("bailed");
    expect(types(await events(result))).toContain("invocation.bailed");
  });
});

/** A config whose suite takes a var from the vault. */
const vaultConfig = (marks: string) => `secrets:
  provider: tvault
  tvault: { project: suite-vault }
  keys: [SUITE_REGION]
vars:
  region: from-config
  other: config-other
suites:
  vaulted:
    specs: [flows/alpha.yml]
    requires: { vars: [region] }
    vars:
      region: "\${env.SUITE_REGION}"
      other: "\${env.SUITE_NEVER_SET_ANYWHERE}"
    before:
      - 'echo "region=$CAIRN_SUITE_VAR_REGION other=\${CAIRN_SUITE_VAR_OTHER-unset}" >> "${marks}"'
`;

describe("suite vars and the vault", () => {
  /** A stub `tvault` that provides SUITE_REGION (built at runtime). */
  async function fakeVault(value: string): Promise<string> {
    const bin = join(dir, `bin-${counter}`);
    await mkdir(bin, { recursive: true });
    const script = [
      "#!/bin/sh",
      'if [ "$1" = "--version" ]; then echo "tvault 0.18.0"; exit 0; fi',
      'if [ "$1" = "run" ]; then',
      '  shift; only=""',
      '  while [ "$1" != "--" ]; do if [ "$1" = "--only" ]; then shift; only="$1"; fi; shift; done',
      "  shift",
      `  case ",$only," in *,SUITE_REGION,*) export SUITE_REGION='${value}';; esac`,
      '  exec "$@"',
      "fi",
      "exit 1",
    ].join("\n");
    await writeFile(join(bin, "tvault"), `${script}\n`);
    await chmod(join(bin, "tvault"), 0o755);
    return bin;
  }

  it("resolves a suite var's ${env.X} after the vault (requires.vars sees it) and never passes an unset one", async () => {
    const value = `eu-${String(Date.now()).slice(-4)}`;
    const bin = await fakeVault(value);
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("SUITE_REGION", undefined);
    vi.stubEnv("SUITE_NEVER_SET_ANYWHERE", undefined);
    const marks = join(dir, `marks-vault-${counter}.txt`);
    const cfg = await config(vaultConfig(marks));
    const result = await run(cfg, { suite: "vaulted" });
    expect(result.error).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(await lines(marks)).toEqual([`region=${value} other=unset`]);
  });

  it("refuses requires.vars (exit 7) only when the vault does not provide it either", async () => {
    const bin = await fakeVault("");
    vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
    vi.stubEnv("SUITE_REGION", undefined);
    const marks = join(dir, `marks-vault-${counter}.txt`);
    const cfg = await config(
      vaultConfig(marks).replace("  region: from-config\n", ""),
    );
    const result = await run(cfg, { suite: "vaulted" });
    expect(result.exitCode).toBe(7);
    expect(result.error).toContain('requires var "region"');
    expect(existsSync(marks)).toBe(false);
  });
});

describe("suite hooks", () => {
  it("runs before once, after once, in the config dir, with the suite's env, journaled", async () => {
    const marks = join(dir, `marks-${counter}.txt`);
    const cfg = await config(`suites:
  hooks:
    specs: [flows/alpha.yml, flows/bravo.yml]
    before: ['echo "base-before $CAIRN_SUITE $CAIRN_ENV" >> "${marks}"']
    vars: { who: me }
    env:
      staging:
        before: ['echo "env-before $CAIRN_SUITE_VAR_WHO $PWD" >> "${marks}"']
        after: ['echo "after exit=$CAIRN_EXIT_CODE $CAIRN_SUITE" >> "${marks}"']
        hookTimeoutMs: 20000
`);
    const result = await run(cfg, { suite: "hooks", env: "staging" });
    expect(result.exitCode).toBe(0);
    const written = await lines(marks);
    expect(written).toHaveLength(3);
    expect(written[0]).toBe("base-before hooks staging");
    expect(written[1]).toMatch(/^env-before me .*cairn-suite-/);
    expect(written[2]).toBe("after exit=0 hooks");
    const all = await events(result);
    for (const event of all) {
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    }
    const hookTypes = types(all).filter((t) => t.startsWith("suite."));
    expect(hookTypes).toEqual([
      "suite.started",
      "suite.hook.started",
      "suite.hook.finished",
      "suite.hook.started",
      "suite.hook.finished",
      "suite.hook.started",
      "suite.hook.finished",
      "suite.finished",
    ]);
    const finished = all.filter((e) => e.type === "suite.hook.finished");
    expect(finished.map((e) => (e as { ok: boolean }).ok)).toEqual([
      true,
      true,
      true,
    ]);
    // Live logs sit next to the other hook logs.
    expect(
      existsSync(join(result.journalDir!, "logs", "hook-suite-before-01.log")),
    ).toBe(true);
    // Spec runs happen between the before and the after hooks.
    const order = types(all).filter(
      (t) => t === "suite.hook.started" || t === "invocation.finished",
    );
    expect(order.at(-1)).toBe("invocation.finished");
  });

  it("stops the run (exit 2) when a before hook fails, and still runs the after hooks", async () => {
    const marks = join(dir, `marks-fail-${counter}.txt`);
    const cfg = await config(`suites:
  broken-before:
    specs: [flows/alpha.yml]
    before: ['echo started >> "${marks}"', "exit 3"]
    after: ['echo after-ran exit=$CAIRN_EXIT_CODE >> "${marks}"']
`);
    const result = await run(cfg, { suite: "broken-before" });
    expect(result.exitCode).toBe(2);
    expect(result.error).toContain(
      "suite broken-before before hook #2 failed (exit 3)",
    );
    expect(result.runDirs).toEqual([]);
    expect(await lines(marks)).toEqual(["started", "after-ran exit=2"]);
    const all = await events(result);
    expect(all.at(-2)).toMatchObject({ type: "suite.finished", exitCode: 2 });
  });

  it("bounds a hook with hookTimeoutMs, kills its process group and goes on", async () => {
    const cfg = await config(`suites:
  slow:
    specs: [flows/alpha.yml]
    after: ["sleep 30"]
    hookTimeoutMs: 400
`);
    const started = Date.now();
    const result = await run(cfg, { suite: "slow" });
    expect(Date.now() - started).toBeLessThan(15_000);
    // An after hook never changes the exit code.
    expect(result.exitCode).toBe(0);
    const all = await events(result);
    const finished = all.find((e) => e.type === "suite.hook.finished")!;
    expect(finished).toMatchObject({ ok: false, timedOut: true });
    expect(all.find((e) => e.type === "suite.finished")).toMatchObject({
      hooksFailed: 1,
    });
  });

  it("runs the after hooks when the specs fail, with that exit code", async () => {
    const marks = join(dir, `marks-red-${counter}.txt`);
    const cfg = await config(`suites:
  red:
    specs: [flows/broken.yml]
    after: ['echo exit=$CAIRN_EXIT_CODE >> "${marks}"']
`);
    const result = await run(cfg, { suite: "red" });
    expect(result.exitCode).toBe(1);
    expect(await lines(marks)).toEqual(["exit=1"]);
  });

  it("runs the after hooks when the invocation is cancelled", async () => {
    const marks = join(dir, `marks-cancel-${counter}.txt`);
    const cfg = await config(`suites:
  cancelled:
    specs: [flows/alpha.yml, flows/bravo.yml]
    before: ['echo before >> "${marks}"']
    after: ['echo after >> "${marks}"']
`);
    const controller = new AbortController();
    const running = executeRunInvocation(
      {
        specs: [],
        options: {
          mock: true,
          config: cfg,
          suite: "cancelled",
          artifactRoot: join(runsRoot, `runs-${counter}`),
          noWebServer: true,
          noServices: true,
        },
        cwd: dir,
      },
      {
        origin: "cli",
        signal: controller.signal,
        progressListener: () => ({
          onRunStart: () => controller.abort(),
        }),
      },
    );
    await running;
    expect(await lines(marks)).toEqual(["before", "after"]);
  });
});

describe("seed.postCommands.skip", () => {
  it("does not run the named seed post-commands, and says so", async () => {
    const marks = join(dir, `seed-marks-${counter}.txt`);
    const keep = `echo keep-me >> "${marks}"`;
    const skip = `echo skip-me >> "${marks}"`;
    const cfg = await config(`services:
  seed:
    command: "true"
    postCommands:
      - '${keep}'
      - '${skip}'
suites:
  lean:
    specs: [flows/alpha.yml]
    seed: { postCommands: { skip: ['${skip}', "echo never-existed"] } }
  full:
    specs: [flows/alpha.yml]
`);
    const notes: string[] = [];
    const result = await executeRunInvocation(
      {
        specs: [],
        options: {
          mock: true,
          config: cfg,
          suite: "lean",
          artifactRoot: join(runsRoot, `runs-${counter}`),
          noWebServer: true,
        },
        cwd: dir,
      },
      {
        origin: "cli",
        narration: { note: (_kind, message) => void notes.push(message) },
      },
    );
    expect(result.exitCode).toBe(0);
    expect(await lines(marks)).toEqual(["keep-me"]);
    expect(notes.join("\n")).toContain("skipping 1 seed postCommand(s)");
    expect(notes.join("\n")).toContain(
      "seed.postCommands.skip entry matches no seed postCommand: echo never-existed",
    );
    // Without the suite's skip both run.
    await rm(marks);
    const full = await run(cfg, { suite: "full", noServices: false });
    expect(full.exitCode).toBe(0);
    expect(await lines(marks)).toEqual(["keep-me", "skip-me"]);
  });

  it("matches a named post-command by name (and a plain one by its text), and when.suite limits one to a suite", async () => {
    const marks = join(dir, `seed-named-${counter}.txt`);
    const echo = (word: string): string => `echo ${word} >> "${marks}"`;
    const cfg = await config(`services:
  seed:
    command: "true"
    postCommands:
      - { name: warm-cache, run: '${echo("warm")}' }
      - { name: lean-only, run: '${echo("lean-only")}', when: { suite: lean } }
      - { name: full-only, run: '${echo("full-only")}', when: { suite: full } }
      - '${echo("plain")}'
      - '${echo("plain-kept")}'
suites:
  lean:
    specs: [flows/alpha.yml]
    seed: { postCommands: { skip: [warm-cache, '${echo("plain")}', 'echo warm >> x', full-only] } }
  full:
    specs: [flows/alpha.yml]
`);
    const notes: string[] = [];
    const result = await executeRunInvocation(
      {
        specs: [],
        options: {
          mock: true,
          config: cfg,
          suite: "lean",
          artifactRoot: join(runsRoot, `runs-${counter}`),
          noWebServer: true,
        },
        cwd: dir,
      },
      {
        origin: "cli",
        narration: { note: (_kind, message) => void notes.push(message) },
      },
    );
    expect(result.exitCode).toBe(0);
    // warm-cache and the plain command were skipped; lean-only matched the
    // suite; full-only was skipped by name (and would not match this suite).
    expect(await lines(marks)).toEqual(["lean-only", "plain-kept"]);
    expect(notes.join("\n")).toContain("skipping 3 seed postCommand(s)");
    expect(notes.join("\n")).toContain(
      "seed.postCommands.skip entry matches no seed postCommand: echo warm >> x",
    );
    // The full suite: warm-cache, full-only, plain, plain-kept (lean-only does not match).
    await rm(marks);
    const full = await run(cfg, { suite: "full", noServices: false });
    expect(full.exitCode).toBe(0);
    expect(await lines(marks)).toEqual([
      "warm",
      "full-only",
      "plain",
      "plain-kept",
    ]);
  });
});
