import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RunResult } from "../../core/schema/run.v1";
import type { BatchRunResult } from "../../core/schema/runBatch.v1";
import { executeRunInvocation } from "./executeRunInvocation";

/**
 * Config that replaces a wrapper around `cairn run`, through the engine with
 * the mock backend: environment-only `services:` (a provisioner a config
 * declares per environment boots like a top-level one), the precedence of
 * `--var` over suite vars in the hooks' `CAIRN_SUITE_VAR_*`, suite
 * `processEnv` / `labels`, per-environment `bail` and seed skips,
 * `--no-bail`, preflight `when`, and `CAIRN_RUN_LOCK` for the run's
 * children. Every command is a stub that appends to a log in a temp dir.
 */

let dir: string;
let log: string;

const PASS = `version: 1
name: pass_spec
intent: A mock run that passes.
coldStart: guest
preconditions:
  commands:
    - run: printf 'spec var=%s env=%s sh=%s\\n' "\${vars.mode}" "\${env.WAVE_MODE}" "$WAVE_MODE" >> LOG
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

const FAIL = `version: 1
name: fail_spec
intent: A mock run that fails its outcome.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: elsewhere
    description: never true
    verify: { url: { matches: "/nowhere" } }
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-suite-env-"));
  log = join(dir, "calls.log");
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(join(dir, "flows", "a-pass.yml"), PASS.replace("LOG", log));
  await writeFile(join(dir, "flows", "0-fail.yml"), FAIL);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function lines(): Promise<string[]> {
  const text = await readFile(log, "utf8").catch(() => "");
  return text.trim() === "" ? [] : text.trim().split("\n");
}

async function run(
  name: string,
  config: string,
  options: Record<string, unknown>,
  callerEnv: Record<string, string | undefined> = {},
) {
  await rm(log, { force: true });
  const configPath = join(dir, `${name}.config.yml`);
  await writeFile(configPath, config);
  return executeRunInvocation(
    {
      specs: [],
      options: {
        mock: true,
        config: configPath,
        artifactRoot: join(dir, `runs-${name}`),
        noWebServer: true,
        ...options,
      },
      cwd: dir,
      callerEnv: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...callerEnv,
      },
    },
    { origin: "cli", allowServicesBoot: true } as never,
  );
}

async function runJson(runDir: string): Promise<RunResult> {
  return JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
}

describe("environment-only services", () => {
  it("boots a provisioner and seed declared only per environment, and skips per-environment seed post-commands", async () => {
    const result = await run(
      "env-only",
      `version: 1
project: suite-env
defaultEnvironment: local
vars: { mode: "-" }
environments:
  local:
    baseUrl: https://demo.example.test
  remote:
    baseUrl: https://demo.example.test
    services:
      provisioner:
        up: echo "up $WAVE_MODE" >> ${log}
        down: echo "down" >> ${log}
      seed:
        command: echo "seed $WAVE_MODE" >> ${log}
        postCommands:
          - { name: keep, run: echo keep >> ${log} }
          - { name: remote-only, run: echo remote-only >> ${log} }
suites:
  s:
    specs: [flows/a-pass.yml]
    processEnv: { WAVE_MODE: "\${env.WAVE_IN:-durable}" }
    env:
      remote:
        seed: { postCommands: { skip: [remote-only] } }
`,
      { suite: "s", env: "remote" },
    );
    expect(result.exitCode, result.error).toBe(0);
    expect(await lines()).toEqual([
      "up durable",
      "seed durable",
      "keep",
      "spec var=- env=durable sh=durable",
      "down",
    ]);
  });
});

describe("suite hooks, process env and labels", () => {
  it("gives hooks the --var value over the suite's (CAIRN_SUITE_VAR_*), exports processEnv everywhere, and stamps labels", async () => {
    const result = await run(
      "hooks",
      `version: 1
project: suite-env
defaultEnvironment: local
vars: { mode: "-" }
environments:
  local:
    baseUrl: https://demo.example.test
run:
  lock: true
  preflight:
    - command: echo "preflight $WAVE_MODE $SUITE_TOKEN" >> ${log}
suites:
  s:
    specs: [flows/a-pass.yml]
    vars: { mode: "\${env.MODE_IN:-a}" }
    processEnv:
      WAVE_MODE: suite
      UNSET_ONE: "\${env.NOT_SET_ANYWHERE}"
    labels: { cohort: "\${env.MODE_IN:-a}", round: r1 }
    env:
      local:
        processEnv: { WAVE_MODE: local, SUITE_TOKEN: t0 }
        labels: { round: r2 }
    before:
      - echo "hook mode=$CAIRN_SUITE_VAR_MODE wave=$WAVE_MODE unset=\${UNSET_ONE-none} lock=$CAIRN_RUN_LOCK" >> ${log}
`,
      { suite: "s", var: ["mode=b"], label: ["round=cli"] },
    );
    expect(result.exitCode, result.error).toBe(0);
    const calls = await lines();
    expect(calls[0]).toBe("preflight local t0");
    expect(calls[1]).toMatch(
      /^hook mode=b wave=local unset=none lock=.+\.run\.lock\.json$/,
    );
    expect(calls[2]).toBe("spec var=b env=local sh=local");
    const runDoc = await runJson(result.runDirs[0]!);
    // Suite labels, then suite=<name>, then the caller's --label (wins).
    expect(runDoc.labels).toEqual({ cohort: "a", round: "cli", suite: "s" });
  });
});

/** Two specs (the first fails) under a suite that bails; `envBail` fills env.staging. */
const bailConfig = (envBail: string) => `version: 1
project: suite-env
defaultEnvironment: local
vars: { mode: "-" }
environments:
  local:
    baseUrl: https://demo.example.test
  staging:
    baseUrl: https://demo.example.test
suites:
  s:
    specs: [flows/0-fail.yml, flows/a-pass.yml]
    bail: true
    env:
      staging: { ${envBail} }
`;

describe("bail per environment and --no-bail", () => {
  it("the suite's bail skips the rest", async () => {
    const result = await run("bail-on", bailConfig(""), { suite: "s" });
    expect(result.exitCode).toBe(1);
    const batch = result.document as BatchRunResult;
    expect(batch.results).toHaveLength(1);
    expect(batch.skipped?.map((entry) => entry.reason)).toEqual(["bailed"]);
  });

  it("env.<n>.bail: false replaces it there", async () => {
    const result = await run("bail-env", bailConfig("bail: false"), {
      suite: "s",
      env: "staging",
    });
    expect(result.exitCode).toBe(1);
    const batch = result.document as BatchRunResult;
    expect(batch.results).toHaveLength(2);
    expect(batch.skipped ?? []).toEqual([]);
  });

  it("--no-bail (bail: false) overrides the suite", async () => {
    const result = await run("bail-off", bailConfig(""), {
      suite: "s",
      bail: false,
    });
    const batch = result.document as BatchRunResult;
    expect(batch.results).toHaveLength(2);
    expect(batch.skipped ?? []).toEqual([]);
  });
});

describe("preflight when", () => {
  // A function: `log` is set in beforeAll, after collection.
  const config = () => `version: 1
project: suite-env
defaultEnvironment: local
vars: { mode: "-" }
environments:
  local:
    baseUrl: https://demo.example.test
run:
  preflight:
    - name: other suite only
      command: "exit 3"
      when: { suite: other }
    - name: this suite
      command: echo "preflight ran" >> ${log}
      when: { suite: [s, t], env: local }
    - name: no suite only
      command: "exit 5"
      when: { suite: t }
suites:
  s: { specs: [flows/a-pass.yml] }
  t: { specs: [flows/a-pass.yml] }
`;

  it("runs only the checks whose when matches the suite", async () => {
    const result = await run("when-s", config(), { suite: "s" });
    expect(result.exitCode, result.error).toBe(0);
    expect((await lines())[0]).toBe("preflight ran");
  });

  it("refuses with the check's own index when a matching check fails", async () => {
    const result = await run("when-t", config(), { suite: "t" });
    expect(result.exitCode).toBe(4);
    expect(result.error).toContain('preflight[3] "no suite only" failed');
  });
});

describe("--services-dry-run", () => {
  it("lists the whole plan: provisioner, tunnels, files, seed post-commands and the suite's skips", async () => {
    const result = await run(
      "dry-run",
      `version: 1
project: suite-env
defaultEnvironment: local
vars: { mode: "-" }
environments:
  local:
    baseUrl: https://demo.example.test
  remote:
    baseUrl: https://demo.example.test
    services:
      provisioner:
        up: ./tools/up.sh
        down: { run: ./tools/down.sh, timeout: 10m }
        exports: { REMOTE_HOST: ./tools/host.sh }
      tunnels:
        - { name: db, command: "ssh -N -L 27017:db:27017 box", ready: db-port }
      files:
        - { path: app.json, json: { host: "\${exports.REMOTE_HOST}" } }
      seed:
        command: ./tools/seed.sh
        postCommands:
          - { name: keep, run: ./tools/keep.sh }
          - { name: remote-only, run: ./tools/remote-only.sh }
          - { name: other-suite, run: ./tools/other.sh, when: { suite: other } }
      teardown:
        - { run: ./tools/collect.sh }
        - { run: ./tools/destroy.sh, critical: true }
gates:
  db-port: { tcp: "127.0.0.1:27017" }
suites:
  s:
    specs: [flows/a-pass.yml]
    processEnv: { WAVE_MODE: durable }
    env:
      remote:
        seed: { postCommands: { skip: [remote-only] } }
`,
      { suite: "s", env: "remote", servicesDryRun: true },
    );
    expect(result.exitCode, result.error).toBe(0);
    const plan = (result.document as { plan: string[] }).plan;
    expect(plan).toEqual([
      "services dry-run plan:",
      "  project: suite-env",
      "  env: remote",
      "  cold-start: false",
      "  suite: s",
      "  suite processEnv: WAVE_MODE (names only)",
      "  provisioner up: ./tools/up.sh",
      "  provisioner down: ./tools/down.sh (critical: true; runs on every exit path, signals included)",
      "  provisioner exports: REMOTE_HOST (names only)",
      "  tunnel db: ssh -N -L 27017:db:27017 box (ready: db-port)",
      "  docker: (not configured)",
      "  file: app.json (json merge)",
      "  seed: ./tools/seed.sh (ttlSeconds: 0)",
      "  seed postCommands: 1 run",
      "  seed postCommands skipped by suite s: remote-only",
      "  seed postCommands not for this run: other-suite (when.suite other (this run: s))",
      "  tmux: (not configured)",
      "  teardown: 2 command(s) (1 critical: a failure is exit 8)",
    ]);
    // Nothing ran.
    expect(await lines()).toEqual([]);
  });

  it("resolves secret names only: a fake tvault is never called, a real run does call it", async () => {
    const bin = join(dir, "fake-bin");
    const calls = join(dir, "tvault-calls.log");
    await mkdir(bin, { recursive: true });
    await writeFile(
      join(bin, "tvault"),
      [
        "#!/bin/sh",
        `echo "$@" >> ${calls}`,
        'if [ "$1" = "--version" ]; then echo tvault-test; exit 0; fi',
        "echo '{}'",
        "",
      ].join("\n"),
      { mode: 0o755 },
    );
    await rm(calls, { force: true });
    const config = `version: 1
project: suite-env
defaultEnvironment: local
secrets:
  provider: tvault
  tvault: { project: dry-project }
  keys: [DRY_RUN_KEY_A, DRY_RUN_KEY_B]
environments:
  local:
    baseUrl: https://demo.example.test
    services:
      seed: { command: echo seed >> ${log} }
suites:
  s: { specs: [flows/a-pass.yml] }
`;
    // The vault binary is looked up on the PATH of THIS process.
    const originalPath = process.env.PATH;
    process.env.PATH = `${bin}:${originalPath}`;
    const callerEnv = { PATH: process.env.PATH };
    try {
      const dry = await run(
        "dry-run-vault",
        config,
        { suite: "s", servicesDryRun: true },
        callerEnv,
      );
      expect(dry.exitCode, dry.error).toBe(0);
      const plan = (dry.document as { plan: string[] }).plan;
      expect(plan).toContain(
        '  secrets: tvault "dry-project" would inject 3 name(s): DRY_RUN_KEY_A, DRY_RUN_KEY_B, WAVE_MODE (names only; the vault is not read in a dry run)',
      );
      // The names are the config keys plus the ${env.X} the spec reads. Not
      // even a --version probe reached the vault.
      expect(await readFile(calls, "utf8").catch(() => "")).toBe("");

      // Control: the same fake is on PATH for a real run and IS called.
      await run("dry-run-vault", config, { suite: "s" }, callerEnv);
      expect((await readFile(calls, "utf8").catch(() => "")).trim()).not.toBe(
        "",
      );
    } finally {
      process.env.PATH = originalPath;
    }
  });

  it("says so when the environment has no services", async () => {
    const result = await run(
      "dry-run-none",
      `version: 1
project: suite-env
defaultEnvironment: local
vars: { mode: "-" }
environments:
  local:
    baseUrl: https://demo.example.test
suites:
  s: { specs: [flows/a-pass.yml] }
`,
      { suite: "s", servicesDryRun: true },
    );
    expect(result.exitCode).toBe(0);
    expect((result.document as { plan: string[] }).plan).toEqual([]);
  });
});
