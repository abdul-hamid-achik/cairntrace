import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  describePreflightCheck,
  preflightApplies,
  runPreflight,
  selectPreflightChecks,
  type PreflightContext,
} from "./preflight";
import { RunPolicyConfigSchema, type RunPreflightCheck } from "./schema";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-preflight-"));
  await writeFile(
    join(dir, "posture.json"),
    JSON.stringify({
      engine: { mode: "durable", workers: 2, dryRun: true },
      auth: { apiToken: "tok-live-1234567890" },
    }),
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function ctx(over: Partial<PreflightContext> = {}): PreflightContext {
  return {
    configDir: dir,
    env: { PATH: process.env.PATH, PRESENT: "value" },
    redact: (text) => text.replace("hunter2", "[redacted]"),
    ...over,
  };
}

const run = (
  checks: RunPreflightCheck[],
  over: Partial<PreflightContext> = {},
) => runPreflight(checks, ctx(over));

/** A command check with an optional `when`. */
const whenCheck = (when: RunPreflightCheck["when"]): RunPreflightCheck => ({
  command: "true",
  ...(when ? { when } : {}),
});

describe("preflight when", () => {
  it("matches suites and environments like seed post-commands", () => {
    const check = whenCheck;
    expect(preflightApplies(check(undefined), {})).toEqual({ applies: true });
    expect(
      preflightApplies(check({ suite: ["a", "b"] }), { suite: "b" }).applies,
    ).toBe(true);
    expect(preflightApplies(check({ suite: "a" }), {})).toEqual({
      applies: false,
      reason: "when.suite a (this run: no suite)",
    });
    expect(
      preflightApplies(check({ suite: "a", env: "staging" }), {
        suite: "a",
        env: "local",
      }),
    ).toEqual({
      applies: false,
      reason: "when.env staging (this run: local)",
    });
    const picked = selectPreflightChecks(
      [check({ suite: "x" }), check(undefined), check({ env: "local" })],
      { env: "local" },
    );
    expect(picked.run.map((entry) => entry.index)).toEqual([2, 3]);
    expect(picked.skipped.map((entry) => entry.index)).toEqual([1]);
  });

  it("is a strict part of a check, and runPreflight keeps the original index", async () => {
    expect(
      RunPolicyConfigSchema.safeParse({
        preflight: [{ command: "true", when: { suite: "a", nope: 1 } }],
      }).success,
    ).toBe(false);
    const outcome = await runPreflight(
      [{ check: { command: "exit 2", name: "third" }, index: 3 }],
      ctx(),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toMatch(/^preflight\[3\] "third" failed/);
    expect(outcome.results[0]?.index).toBe(3);
  });
});

describe("preflight json checks", () => {
  it("passes an assertion that holds", async () => {
    const result = await run([
      {
        json: "posture.json",
        assert:
          '.engine.mode == "durable" and .engine.workers == 2 and .engine.dryRun',
      },
    ]);
    expect(result.ok).toBe(true);
    expect(result.results).toHaveLength(1);
  });

  it("fails naming the check, the assertion and the observed values", async () => {
    const result = await run([
      { json: "posture.json", assert: ".engine.workers >= 4" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("preflight[1]");
    expect(result.message).toContain(
      'json posture.json assert ".engine.workers >= 4"',
    );
    expect(result.message).toContain(".engine.workers = 2");
  });

  it("masks credential-like values in the observed list", async () => {
    const result = await run([
      { json: "posture.json", assert: '.auth.apiToken == "other"' },
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain(".auth.apiToken = [redacted]");
    expect(result.message).not.toContain("tok-live-1234567890");
  });

  it("reports a missing path as (missing)", async () => {
    const result = await run([
      { json: "posture.json", assert: ".engine.nope exists" },
    ]);
    expect(result.message).toContain(".engine.nope = (missing)");
  });

  it("fails on a missing or invalid file", async () => {
    const missing = await run([{ json: "gone.json", assert: ".a" }]);
    expect(missing.ok).toBe(false);
    expect(missing.message).toMatch(/cannot read gone\.json: ENOENT/);
    await writeFile(join(dir, "bad.json"), "{nope");
    const bad = await run([{ json: "bad.json", assert: ".a" }]);
    expect(bad.message).toMatch(/is not valid JSON/);
  });

  it("uses the check's name in the message", async () => {
    const result = await run([
      {
        name: "engine posture",
        json: "posture.json",
        assert: ".engine.workers == 9",
      },
    ]);
    expect(result.message).toContain('preflight[1] "engine posture" failed');
  });
});

describe("preflight secret checks", () => {
  it("passes a set secret and fails an unset or empty one without echoing values", async () => {
    expect((await run([{ secret: "PRESENT" }])).ok).toBe(true);
    const unset = await run([{ secret: "ABSENT" }]);
    expect(unset.ok).toBe(false);
    expect(unset.message).toContain("secret ABSENT is not set");
    const empty = await run([{ secret: "EMPTY" }], {
      env: { PATH: process.env.PATH, EMPTY: "" },
    });
    expect(empty.ok).toBe(false);
  });
});

describe("preflight command checks", () => {
  it("passes on the expected exit code (default 0) and runs in the config directory", async () => {
    await writeFile(join(dir, "marker.txt"), "x");
    expect((await run([{ command: "test -f marker.txt" }])).ok).toBe(true);
    expect((await run([{ command: "exit 3", expectExit: 3 }])).ok).toBe(true);
  });

  it("fails with the exit code and a redacted output tail", async () => {
    const result = await run([
      { command: "echo password=hunter2 >&2; exit 5" },
    ]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("expected exit 0, exited 5");
    expect(result.message).toContain("password=[redacted]");
    expect(result.message).not.toContain("hunter2");
  });

  it("sees the scoped environment, not the parent's", async () => {
    process.env.CAIRN_PREFLIGHT_PARENT_ONLY = "1";
    try {
      const result = await run([
        {
          command:
            'test "$PRESENT" = value && test -z "$CAIRN_PREFLIGHT_PARENT_ONLY"',
        },
      ]);
      expect(result.ok).toBe(true);
    } finally {
      delete process.env.CAIRN_PREFLIGHT_PARENT_ONLY;
    }
  });

  it("enforces the timeout", async () => {
    const started = Date.now();
    const result = await run([{ command: "sleep 30", timeout: "300ms" }]);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("timed out after 300ms");
    expect(Date.now() - started).toBeLessThan(10_000);
  });
});

describe("preflight gate checks", () => {
  const gates = {
    ready: { command: { run: "exit 0" } },
    broken: { command: { run: "echo not-up; exit 1" } },
  } as const;

  it("looks once at a named gate", async () => {
    expect((await run([{ gate: "ready" }], { gates })).ok).toBe(true);
    const down = await run([{ gate: "broken" }], { gates });
    expect(down.ok).toBe(false);
    expect(down.message).toContain('gate "broken" is not ready');
  });

  it("fails on an unknown gate", async () => {
    const result = await run([{ gate: "nope" }], { gates });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('unknown gate "nope"');
  });
});

describe("preflight ordering", () => {
  it("stops at the first failure and never runs later checks", async () => {
    const seen: number[] = [];
    const result = await runPreflight(
      [
        { secret: "PRESENT" },
        { secret: "ABSENT" },
        { command: `touch ${join(dir, "should-not-exist")}` },
      ],
      ctx(),
      (r) => seen.push(r.index),
    );
    expect(result.ok).toBe(false);
    expect(seen).toEqual([1, 2]);
    expect(
      (await run([{ command: `test ! -e ${join(dir, "should-not-exist")}` }]))
        .ok,
    ).toBe(true);
  });
});

const parse = (value: unknown) => RunPolicyConfigSchema.safeParse(value);

describe("preflight schema", () => {
  it("needs exactly one check kind and rejects misplaced fields", () => {
    expect(parse({ preflight: [{}] }).success).toBe(false);
    expect(
      parse({ preflight: [{ secret: "A", command: "true" }] }).success,
    ).toBe(false);
    expect(parse({ preflight: [{ json: "a.json" }] }).success).toBe(false);
    expect(parse({ preflight: [{ secret: "A", assert: ".a" }] }).success).toBe(
      false,
    );
    expect(parse({ preflight: [{ secret: "A", expectExit: 1 }] }).success).toBe(
      false,
    );
  });

  it("validates the assertion at config time", () => {
    const bad = parse({ preflight: [{ json: "a.json", assert: ".a ==" }] });
    expect(bad.success).toBe(false);
    expect(JSON.stringify(bad.error?.issues)).toContain("invalid assertion");
  });

  it("accepts the documented forms", () => {
    expect(
      parse({
        lock: { scope: "project", staleAfterPidDead: true },
        preflight: [
          { json: "a.json", assert: ".a == 1" },
          { secret: "TOKEN" },
          { command: "true", expectExit: 0, timeout: "5s" },
          { gate: "ready" },
        ],
        verifyClean: ["browsers", "tmux", { "docker-project": "demo" }],
        finally: ["echo done", { run: "echo done", timeout: "10s" }],
      }).success,
    ).toBe(true);
    expect(parse({ lock: true }).success).toBe(true);
    expect(parse({ lock: false }).success).toBe(true);
    expect(parse({ verifyClean: ["volumes"] }).success).toBe(false);
    expect(parse({ unknownKey: 1 }).success).toBe(false);
  });

  it("describes a check for messages", () => {
    expect(describePreflightCheck({ secret: "TOKEN" })).toBe("secret TOKEN");
    expect(describePreflightCheck({ gate: "ready" })).toBe("gate ready");
  });
});
