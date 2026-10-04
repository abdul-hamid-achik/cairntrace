import { createHash } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigSchema, ServicesConfigSchema } from "../schema/config.v1";
import {
  assertEngineRequirement,
  EngineRequirementError,
  engineRequirementProblem,
} from "../engineRequirements";
import {
  clearNodeVersionCache,
  nodeCommand,
  NodeRuntimeError,
  resolveNodeRuntime,
} from "../runtimes";
import {
  compareVersions,
  parseVersion,
  rangeProblem,
  satisfiesRange,
} from "../semverRange";
import { backoffDelayMs, resolveBackoff } from "./backoff";
import { applyServiceFile, mergeJson, ServiceFileError } from "./files";
import {
  generationMarker,
  generationMarkerCommand,
  newGenerationId,
  sliceAfterGeneration,
} from "./generation";
import { captureLines, viewCapture, waitForPattern } from "./logs";
import {
  expectOutputViolation,
  phaseFingerprint,
  phaseStateDecision,
  postCommandApplies,
  seedTargetHash,
  SeedPhaseStore,
  emptyScopedState,
} from "./seedTransaction";
import { SeedPhaseSchema, ServiceFileSchema } from "./schema";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "cairn-ops-unit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  clearNodeVersionCache();
});

describe("semverRange", () => {
  it.each([
    ["3.0.1", ">=3.0", true],
    ["3.0.1", ">=3.1", false],
    ["3.1.4", "^3.1.0", true],
    ["4.0.0", "^3.1.0", false],
    ["0.2.5", "^0.2.1", true],
    ["0.3.0", "^0.2.1", false],
    ["3.2.0", "~3.2.0", true],
    ["3.3.0", "~3.2.0", false],
    ["3.9.9", "3.x", true],
    ["4.0.0", "3.x", false],
    ["3.0.1", ">=3.0 <4", true],
    ["4.0.0", ">=3.0 <4", false],
    ["2.9.0", "<3 || >=4", true],
    ["3.5.0", "<3 || >=4", false],
    ["3.5.0", "3.0.0 - 3.9.9", true],
    ["3.1.0-rc.1", ">=3.0", false],
    ["3.1.0-rc.1", ">=3.1.0-rc.0", true],
    ["20.11.1", ">= 20", true],
    ["18.0.0", "*", true],
    // npm drops a `>=0.0.0` bound, so a 0.0.0 pre-release can match.
    ["0.0.0-0", "0.x.x - 0.0.0-rc.2", true],
    ["0.0.0-rc.3", "0.x.x - 0.0.0-rc.2", false],
    // A pre-release next to an x is dropped (npm: >=1.2.0 <1.3.0-0).
    ["1.2.0-rc.2", "1.2.x-rc.1", false],
    ["1.2.5", "1.2.x-rc.1", true],
    // A caret / tilde / hyphen end reads a number after an x as x.
    ["1.9.0", "^1.x.3", true],
    ["2.0.0", "~1.x.3", false],
    ["2.5.0", "1.x.3 - 2", true],
    ["1.2.3", "^v1.2.3", true],
    ["1.2.3", "1.2.3+build.01", true],
  ])("%s satisfies %s: %s", (version, range, expected) => {
    expect(satisfiesRange(version, range)).toBe(expected);
  });

  it.each([
    // What npm's semver rejects is invalid here too.
    ["x.1.2", false],
    ["3.x.1", false],
    [">=1.x.3", false],
    ["*-3", false],
    ["x-rc.1", false],
    ["1.2-rc.1", false],
    ["03.0.1", false],
    ["^3.0.01", false],
    ["~03.0.1", false],
    ["1.2.3 - 03.0.0", false],
    ["1.0.0-rc.01", false],
    ["1.0.0-rc..1", false],
    ["1.2.3.4", false],
    ["1 - 2 - 3", false],
    [">=3.0.0-", false],
    // and what it accepts stays valid.
    ["^1.x.3", true],
    ["~x.1", true],
    ["1.2.x-rc.1", true],
    ["1.2.3-0a", true],
    ["1.2+b", true],
    ["0.0.0", true],
    ["^0.0.0", true],
  ])("range %s is valid: %s", (range, valid) => {
    expect(rangeProblem(range) === undefined).toBe(valid);
  });

  it("parses only versions npm accepts", () => {
    expect(parseVersion("03.0.1")).toBeUndefined();
    expect(parseVersion("3.0.01")).toBeUndefined();
    expect(parseVersion("3.0.1-rc.01")).toBeUndefined();
    expect(parseVersion("v3.0.1+b.01")).toMatchObject({ major: 3, patch: 1 });
    expect(satisfiesRange("03.0.1", ">=3")).toBe(false);
  });

  it("orders pre-releases below releases and rejects garbage", () => {
    expect(
      compareVersions(parseVersion("3.1.0-rc.1")!, parseVersion("3.1.0")!),
    ).toBeLessThan(0);
    expect(rangeProblem(">=banana")).toMatch(/not a valid semver range/);
    expect(rangeProblem("")).toMatch(/empty/);
    expect(satisfiesRange("banana", ">=1")).toBe(false);
  });
});

describe("engine requirement", () => {
  it("passes, fails and names both versions", () => {
    expect(engineRequirementProblem({}, "3.0.1")).toBeUndefined();
    expect(
      engineRequirementProblem({ requires: { cairntrace: ">=3.0" } }, "3.0.1"),
    ).toBeUndefined();
    const problem = engineRequirementProblem(
      { requires: { cairntrace: ">=3.2" } },
      "3.0.1",
      "/p/cairntrace.config.yml",
    );
    expect(problem).toContain(">=3.2");
    expect(problem).toContain("3.0.1");
    expect(problem).toContain("/p/cairntrace.config.yml");
    expect(() =>
      assertEngineRequirement(
        { requires: { cairntrace: ">=9" } },
        undefined,
        "3.0.1",
      ),
    ).toThrow(EngineRequirementError);
    expect(new EngineRequirementError("x").exitCode).toBe(4);
  });

  it("validates the range in the config schema", () => {
    const base = { version: 1, environments: { local: {} } };
    expect(
      ConfigSchema.safeParse({ ...base, requires: { cairntrace: ">=3.0" } })
        .success,
    ).toBe(true);
    const bad = ConfigSchema.safeParse({
      ...base,
      requires: { cairntrace: ">=banana" },
    });
    expect(bad.success).toBe(false);
  });
});

/** A stand-in node binary that only answers `--version`. */
function fakeNode(path: string, version: string): void {
  writeFileSync(path, `#!/bin/sh\necho v${version}\n`);
  chmodSync(path, 0o755);
}

describe("runtimes.node", () => {
  it("CAIRN_NODE wins, then runtimes.node.path (relative to the config dir)", () => {
    const pinned = join(dir, "node-pinned");
    fakeNode(pinned, "22.4.0");
    expect(nodeCommand({ CAIRN_NODE: pinned })).toBe(pinned);
    expect(nodeCommand({})).toBe("node");
    expect(nodeCommand({ CAIRN_NODE: "  " })).toBe("node");
    const fromEnv = resolveNodeRuntime(undefined, {
      configDir: dir,
      env: { ...process.env, CAIRN_NODE: pinned },
    });
    expect(fromEnv).toMatchObject({
      command: pinned,
      version: "22.4.0",
      source: "CAIRN_NODE",
    });
    const fromPath = resolveNodeRuntime(
      { node: { path: "./node-pinned", version: ">=22" } },
      { configDir: dir, env: { ...process.env, CAIRN_NODE: "" } },
    );
    expect(fromPath).toMatchObject({
      command: join(dir, "node-pinned"),
      source: "runtimes.node.path",
    });
  });

  it("refuses a pinned node that is out of range or broken (exit 4)", () => {
    const old = join(dir, "node-old");
    fakeNode(old, "18.1.0");
    expect(() =>
      resolveNodeRuntime(
        { node: { path: old, version: ">=22" } },
        { configDir: dir, env: { ...process.env, CAIRN_NODE: "" } },
      ),
    ).toThrow(/does not satisfy runtimes.node.version >=22/);
    expect(() =>
      resolveNodeRuntime(
        { node: { path: join(dir, "missing") } },
        { configDir: dir, env: { ...process.env, CAIRN_NODE: "" } },
      ),
    ).toThrow(NodeRuntimeError);
  });

  it("finds a version-manager install that satisfies the range", () => {
    const home = join(dir, "home");
    const bin = join(home, ".nvm", "versions", "node", "v20.5.1", "bin");
    mkdirSync(bin, { recursive: true });
    fakeNode(join(bin, "node"), "20.5.1");
    const lower = join(home, ".nvm", "versions", "node", "v20.1.0", "bin");
    mkdirSync(lower, { recursive: true });
    fakeNode(join(lower, "node"), "20.1.0");
    // PATH has only a stub that is too old.
    const stub = join(dir, "pathbin");
    mkdirSync(stub);
    fakeNode(join(stub, "node"), "16.0.0");
    const found = resolveNodeRuntime(
      { node: { version: ">=20 <21" } },
      {
        configDir: dir,
        home,
        env: { PATH: `${stub}:/usr/bin:/bin`, CAIRN_NODE: "" },
      },
    );
    expect(found.source).toBe("runtimes.node.version (version manager)");
    expect(found.version).toBe("20.5.1");
    expect(found.command).toBe(join(bin, "node"));
  });
});

describe("generation markers", () => {
  it("slices after the last marker and ignores earlier output", () => {
    const a = newGenerationId();
    const b = newGenerationId();
    const text = [
      "old line",
      generationMarker(a),
      "mid",
      generationMarker(b),
      "new line",
      "ready",
    ].join("\n");
    expect(sliceAfterGeneration(text)).toMatchObject({
      found: true,
      generation: b,
      text: "new line\nready",
    });
    expect(sliceAfterGeneration(text, a).text).toContain("mid");
    expect(sliceAfterGeneration("no marker here")).toMatchObject({
      found: false,
      text: "no marker here",
    });
    expect(generationMarkerCommand(a)).toBe(`echo '${generationMarker(a)}'`);
  });

  it("never mistakes the typed command line for the marker", () => {
    const id = newGenerationId();
    const typed = `$ ${generationMarkerCommand(id)}`;
    expect(sliceAfterGeneration(typed).found).toBe(false);
  });
});

describe("backoff", () => {
  it("defaults to 1s doubling up to 30s, and honors fixed and exponential forms", () => {
    const plan = resolveBackoff(undefined);
    expect([1, 2, 3, 6].map((n) => backoffDelayMs(plan, n))).toEqual([
      1000, 2000, 4000, 30000,
    ]);
    expect(backoffDelayMs(resolveBackoff("2s"), 5)).toBe(2000);
    expect(
      backoffDelayMs(resolveBackoff({ initial: 100, max: 250, factor: 3 }), 3),
    ).toBe(250);
  });
});

describe("seed transaction helpers", () => {
  const phase = SeedPhaseSchema.parse({ name: "import", command: "echo hi" });

  it("decides a phase from its recorded state and TTL", () => {
    const fingerprint = phaseFingerprint(phase);
    const record = {
      fingerprint,
      ranAt: new Date(Date.now() - 10_000).toISOString(),
      exitCode: 0,
      durationMs: 1,
    };
    expect(phaseStateDecision(phase, undefined, 60)).toMatchObject({
      run: true,
      reason: "no-previous-run",
    });
    expect(phaseStateDecision(phase, record, 60)).toMatchObject({
      run: false,
      reason: "within-ttl",
    });
    expect(phaseStateDecision(phase, record, 5)).toMatchObject({ run: true });
    expect(phaseStateDecision(phase, record, 0)).toMatchObject({
      run: true,
      reason: "no-ttl",
    });
    expect(phaseStateDecision(phase, { ...record, exitCode: 3 }, 60).run).toBe(
      true,
    );
    expect(
      phaseStateDecision(phase, { ...record, fingerprint: "other" }, 60),
    ).toMatchObject({ reason: "command-changed" });
  });

  it("hashes the target without the env values leaking into the key", () => {
    const a = seedTargetHash({
      target: "db-a",
      cwd: "/x",
      env: { TOKEN_VALUE: "one" },
    });
    const b = seedTargetHash({
      target: "db-b",
      cwd: "/x",
      env: { TOKEN_VALUE: "one" },
    });
    const c = seedTargetHash({
      target: "db-a",
      cwd: "/x",
      env: { TOKEN_VALUE: "two" },
    });
    expect(new Set([a, b, c]).size).toBe(3);
    expect(a).toMatch(/^[0-9a-f]{12}$/);
  });

  it("persists per project + env + target and writes atomically", async () => {
    const store = new SeedPhaseStore(dir);
    const state = emptyScopedState("demo", "local", "abc123");
    state.phases.import = {
      fingerprint: "f",
      ranAt: new Date().toISOString(),
      exitCode: 0,
      durationMs: 5,
    };
    await store.write(state);
    expect(await store.read("demo", "local", "abc123")).toMatchObject({
      phases: { import: { exitCode: 0 } },
    });
    expect(await store.read("demo", "staging", "abc123")).toBeUndefined();
    expect(await store.read("demo", "local", "other")).toBeUndefined();
    expect(store.pathFor("demo", "we/ird env", "abc")).toContain("we-ird-env");
  });

  it("flags output that matches a forbidden pattern and quotes the line", () => {
    const hit = expectOutputViolation("ok\nCOLLECTION ERROR: users\nok", {
      notMatches: ["COLLECTION ERROR", "[Ff]atal"],
    });
    expect(hit).toContain("COLLECTION ERROR");
    expect(hit).toContain("COLLECTION ERROR: users");
    expect(
      expectOutputViolation("all good", { notMatches: ["ERROR"] }),
    ).toBeUndefined();
    expect(expectOutputViolation("anything", undefined)).toBeUndefined();
  });

  it("applies post-command when: to the suite and environment", () => {
    expect(postCommandApplies("echo x", {})).toEqual({ applies: true });
    const entry = {
      name: "extra",
      run: "echo x",
      when: { suite: ["smoke", "full"], env: "local" },
    };
    expect(
      postCommandApplies(entry, { suite: "smoke", env: "local" }).applies,
    ).toBe(true);
    expect(
      postCommandApplies(entry, { suite: "other", env: "local" }).applies,
    ).toBe(false);
    expect(postCommandApplies(entry, { env: "local" }).applies).toBe(false);
    expect(
      postCommandApplies(entry, { suite: "smoke", env: "staging" }).reason,
    ).toMatch(/when.env/);
  });
});

describe("services.files", () => {
  it("merges JSON atomically, keeps mode and indentation, and skips an identical write", async () => {
    const path = join(dir, "cfg", "app.json");
    mkdirSync(join(dir, "cfg"));
    writeFileSync(
      path,
      '{\n    "a": 1,\n    "nested": { "keep": true, "drop": 1 }\n}\n',
    );
    chmodSync(path, 0o600);
    const env = { DB_HOST: "10.0.0.5" };
    const exports = { REMOTE_PORT: "5432" };
    const first = await applyServiceFile(
      {
        path: "cfg/app.json",
        json: {
          nested: {
            drop: null,
            host: "${env.DB_HOST}",
            port: "${exports.REMOTE_PORT}",
          },
          b: [1, 2],
        },
      },
      { configDir: dir, env, exports },
    );
    expect(first.changed).toBe(true);
    expect(first.before?.sha).toMatch(/^hmac-sha256:[0-9a-f]{16}$/);
    expect(first.after.sha).not.toBe(first.before?.sha);
    const text = readFileSync(path, "utf8");
    expect(text.startsWith('{\n    "a": 1')).toBe(true);
    expect(JSON.parse(text)).toEqual({
      a: 1,
      nested: { keep: true, host: "10.0.0.5", port: "5432" },
      b: [1, 2],
    });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const second = await applyServiceFile(
      {
        path: "cfg/app.json",
        json: {
          nested: { host: "${env.DB_HOST}", port: "${exports.REMOTE_PORT}" },
        },
        restart: ["web"],
      },
      { configDir: dir, env, exports },
    );
    expect(second.changed).toBe(false);
    expect(second.after.sha).toBe(second.before?.sha);
    expect(second.restart).toEqual(["web"]);
  });

  it("creates missing files, writes text, and never clobbers a file it cannot parse", async () => {
    const created = await applyServiceFile(
      { path: "new/dir/x.json", json: { a: 1 } },
      { configDir: dir, env: {} },
    );
    expect(created).toMatchObject({ changed: true, existed: false });
    expect(created.before).toBeUndefined();
    const text = await applyServiceFile(
      { path: "plain.txt", text: "host=${env.H}\n" },
      { configDir: dir, env: { H: "x" } },
    );
    expect(readFileSync(join(dir, "plain.txt"), "utf8")).toBe("host=x\n");
    expect(text.changed).toBe(true);
    writeFileSync(join(dir, "broken.json"), "{ not json");
    await expect(
      applyServiceFile(
        { path: "broken.json", json: { a: 1 } },
        { configDir: dir, env: {} },
      ),
    ).rejects.toThrow(/not valid JSON.*not overwritten/);
    expect(readFileSync(join(dir, "broken.json"), "utf8")).toBe("{ not json");
    writeFileSync(join(dir, "array.json"), "[1]");
    await expect(
      applyServiceFile(
        { path: "array.json", json: { a: 1 } },
        { configDir: dir, env: {} },
      ),
    ).rejects.toBeInstanceOf(ServiceFileError);
  });

  it("writes through a symlink to its target and refuses a dangling one", async () => {
    mkdirSync(join(dir, "real"));
    writeFileSync(join(dir, "real", "app.json"), '{ "a": 1 }\n');
    symlinkSync(join(dir, "real", "app.json"), join(dir, "linked.json"));
    await applyServiceFile(
      { path: "linked.json", json: { b: 2 } },
      { configDir: dir, env: {} },
    );
    expect(lstatSync(join(dir, "linked.json")).isSymbolicLink()).toBe(true);
    expect(
      JSON.parse(readFileSync(join(dir, "real", "app.json"), "utf8")),
    ).toEqual({ a: 1, b: 2 });
    symlinkSync(join(dir, "real", "gone.json"), join(dir, "dangling.json"));
    await expect(
      applyServiceFile(
        { path: "dangling.json", json: { b: 2 } },
        { configDir: dir, env: {} },
      ),
    ).rejects.toThrow(/symlink whose target cannot be resolved.*not written/);
    expect(lstatSync(join(dir, "dangling.json")).isSymbolicLink()).toBe(true);
  });

  it("creates new files private (0600) unless mode says otherwise; fingerprints are keyed", async () => {
    const secret = ["s3cr", "et", String(process.pid)].join("");
    const made = await applyServiceFile(
      { path: "fresh/creds.env", text: "TOKEN=${exports.TOKEN}\n" },
      { configDir: dir, env: {}, exports: { TOKEN: secret } },
    );
    expect(statSync(join(dir, "fresh", "creds.env")).mode & 0o777).toBe(0o600);
    await applyServiceFile(
      { path: "fresh/public.json", json: { a: 1 }, mode: "644" },
      { configDir: dir, env: {} },
    );
    expect(statSync(join(dir, "fresh", "public.json")).mode & 0o777).toBe(
      0o644,
    );
    // Not the plain digest of the content: a short secret cannot be guessed.
    const plain = createHash("sha256")
      .update(`TOKEN=${secret}\n`)
      .digest("hex")
      .slice(0, 16);
    expect(made.after.sha).not.toContain(plain);
    expect(
      ServiceFileSchema.safeParse({ path: "x", text: "", mode: "999" }).success,
    ).toBe(false);
  });

  it("fails on an unset ${env.X} without touching the file", async () => {
    writeFileSync(join(dir, "keep.txt"), "before");
    await expect(
      applyServiceFile(
        { path: "keep.txt", text: "${env.MISSING_NAME}" },
        { configDir: dir, env: {} },
      ),
    ).rejects.toThrow(/\$\{env\.MISSING_NAME\} is not set/);
    expect(readFileSync(join(dir, "keep.txt"), "utf8")).toBe("before");
  });

  it("fails on an unknown ${exports.X}", async () => {
    await expect(
      applyServiceFile(
        { path: "x.txt", text: "${exports.NOPE}" },
        { configDir: dir, env: {}, exports: {} },
      ),
    ).rejects.toThrow(
      /\$\{exports\.NOPE\} is not set \(the provisioner exports no such name\)/,
    );
  });

  it("mergeJson: null removes, arrays replace, objects merge", () => {
    expect(
      mergeJson(
        { a: { b: 1, c: 2 }, l: [1] },
        { a: { b: null, d: 3 }, l: [2, 3] },
      ),
    ).toEqual({
      a: { c: 2, d: 3 },
      l: [2, 3],
    });
  });
});

describe("services logs view", () => {
  it("joins capture lines and slices since the restart marker", () => {
    const marker = generationMarker("deadbeef");
    const text = `before\n${marker}\nafter 1\nafter 2\n\n\n`;
    expect(captureLines(text)).toEqual([
      "before",
      marker,
      "after 1",
      "after 2",
    ]);
    expect(viewCapture(text, { sinceRestart: true })).toMatchObject({
      restartFound: true,
      generation: "deadbeef",
      lines: ["after 1", "after 2"],
    });
    expect(viewCapture("only\nold", { sinceRestart: true })).toMatchObject({
      restartFound: false,
      lines: ["only", "old"],
    });
  });

  it("waits for a pattern, times out, and stops when the window is gone", async () => {
    let now = 0;
    const sleep = async (ms: number): Promise<void> => {
      now += ms;
    };
    const frames = [
      "starting",
      "starting\nstill booting",
      "starting\nlistening on 3000",
    ];
    let i = 0;
    const matched = await waitForPattern(
      async () => frames[Math.min(i++, frames.length - 1)],
      {
        pattern: /listening on \d+/,
        timeoutMs: 10_000,
        sinceRestart: false,
        sleep,
        now: () => now,
      },
    );
    expect(matched).toMatchObject({
      matched: true,
      line: "listening on 3000",
      timedOut: false,
    });
    now = 0;
    const timedOut = await waitForPattern(async () => "never", {
      pattern: /ready/,
      timeoutMs: 2_000,
      sinceRestart: false,
      sleep,
      now: () => now,
    });
    expect(timedOut).toMatchObject({ matched: false, timedOut: true });
    const gone = await waitForPattern(async () => undefined, {
      pattern: /x/,
      timeoutMs: 2_000,
      sinceRestart: false,
      sleep,
      now: () => now,
    });
    expect(gone).toMatchObject({ matched: false, timedOut: false });
  });

  it("does not match the stale text above the marker", async () => {
    const stale = `listening on 3000\n${generationMarker("aaaa1111")}\nbooting`;
    const result = await waitForPattern(async () => stale, {
      pattern: /listening/,
      timeoutMs: 100,
      sinceRestart: true,
      sleep: async () => undefined,
      now: (() => {
        let t = 0;
        return () => (t += 60);
      })(),
    });
    expect(result.matched).toBe(false);
  });
});

const parse = (services: unknown) => ServicesConfigSchema.safeParse(services);

describe("services config schema (F10, F12)", () => {
  it("keeps a config that uses none of it valid", () => {
    expect(
      parse({
        seed: { command: "x", postCommands: ["a", "b"] },
        tmux: { session: "s", windows: [{ name: "w", command: "c" }] },
      }).success,
    ).toBe(true);
  });

  it("accepts the new blocks", () => {
    const result = parse({
      provisioner: {
        up: "make up",
        down: {
          run: "make down",
          critical: true,
          timeout: "5m",
          onSignal: "wait",
        },
        exports: { REMOTE_HOST: "make host" },
      },
      tunnels: [
        {
          name: "db",
          command: "ssh -N x",
          restart: "always",
          giveUpAfter: 3,
          ready: "tcp://127.0.0.1:5432",
        },
      ],
      files: [{ path: "a.json", json: { a: 1 }, restart: ["web"] }],
      seed: {
        phases: [
          {
            name: "import",
            run: "x",
            skipIf: { command: "true" },
            always: false,
          },
        ],
        commit: "afterPostCommands",
        postCommands: [
          {
            name: "n",
            run: "y",
            when: { suite: "s" },
            continueOnError: true,
            timeout: "30s",
          },
        ],
        expectOutput: { notMatches: ["ERROR"] },
      },
      tmux: {
        session: "s",
        columns: 200,
        windows: [
          {
            name: "web",
            command: "c",
            restart: { policy: "on-exit", backoff: "2s", max: 3 },
            healthcheck: { command: "true", onUnhealthy: "restart" },
          },
        ],
      },
    });
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });

  it("rejects a provisioner without down, reserved exports, and bad cross references", () => {
    expect(parse({ provisioner: { up: "x" } }).success).toBe(false);
    expect(
      parse({ provisioner: { up: "x", down: "y", exports: { PATH: "echo" } } })
        .success,
    ).toBe(false);
    expect(
      parse({
        tunnels: [
          { name: "a", command: "x" },
          { name: "a", command: "y" },
        ],
      }).success,
    ).toBe(false);
    expect(
      parse({
        files: [{ path: "a", text: "x", restart: ["ghost"] }],
        tmux: { session: "s", windows: [{ name: "web", command: "c" }] },
      }).success,
    ).toBe(false);
    expect(parse({ files: [{ path: "a", text: "x", json: {} }] }).success).toBe(
      false,
    );
    expect(parse({ seed: {} }).success).toBe(false);
    expect(
      parse({ seed: { command: "x", phases: [{ name: "p", run: "y" }] } })
        .success,
    ).toBe(false);
    expect(
      parse({
        seed: {
          phases: [
            { name: "p", run: "y" },
            { name: "p", run: "z" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      parse({
        seed: {
          command: "x",
          postCommands: [
            { name: "a", run: "1" },
            { name: "a", run: "2" },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      parse({ seed: { command: "x", expectOutput: { notMatches: ["("] } } })
        .success,
    ).toBe(false);
    expect(
      parse({
        docker: {
          command: "x",
          healthcheck: { command: "true", onUnhealthy: "restart" },
        },
      }).success,
    ).toBe(false);
  });

  it("an environment may drop docker with docker: false", () => {
    const result = ConfigSchema.safeParse({
      version: 1,
      environments: { remote: { services: { docker: false } } },
    });
    expect(result.error?.issues).toBeUndefined();
    expect(result.success).toBe(true);
  });
});
