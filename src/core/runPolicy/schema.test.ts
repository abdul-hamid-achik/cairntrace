import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveProjectRuntimeContext } from "../config/runtimeContext";
import { ConfigSchema } from "../schema/config.v1";
import { mergeRunPolicy, normalizeTeardown, teardownCommand } from "./schema";

const base = {
  version: 1,
  environments: { local: {} },
} as const;

describe("config run: block", () => {
  it("parses at the top level and per environment", () => {
    const parsed = ConfigSchema.safeParse({
      ...base,
      run: { lock: true, verifyClean: ["browsers"] },
      environments: { local: { run: { lock: false } } },
    });
    expect(parsed.success).toBe(true);
  });

  it("reports an unknown preflight gate at config time, naming the path", () => {
    const parsed = ConfigSchema.safeParse({
      ...base,
      run: { preflight: [{ gate: "nope" }] },
    });
    expect(parsed.success).toBe(false);
    const issue = parsed.error!.issues[0]!;
    expect(issue.path).toEqual(["run", "preflight", 0, "gate"]);
    expect(issue.message).toContain('unknown gate "nope"');
  });

  it("accepts a known gate, also in an environment", () => {
    const gates = { ready: { command: "true" } };
    expect(
      ConfigSchema.safeParse({
        ...base,
        gates,
        run: { preflight: [{ gate: "ready" }] },
        environments: { local: { run: { preflight: [{ gate: "ready" }] } } },
      }).success,
    ).toBe(true);
    const bad = ConfigSchema.safeParse({
      ...base,
      gates,
      environments: { local: { run: { preflight: [{ gate: "ghost" }] } } },
    });
    expect(bad.success).toBe(false);
    expect(bad.error!.issues[0]!.path).toEqual([
      "environments",
      "local",
      "run",
      "preflight",
      0,
      "gate",
    ]);
  });

  it("rejects unknown keys in run:", () => {
    expect(
      ConfigSchema.safeParse({ ...base, run: { retries: 3 } }).success,
    ).toBe(false);
  });

  it("takes object teardown entries in services and environment services", () => {
    expect(
      ConfigSchema.safeParse({
        ...base,
        services: {
          teardown: [
            "docker compose down",
            { run: "x", critical: true, timeout: "30s" },
          ],
        },
        environments: {
          local: {
            services: {
              teardown: [{ run: "y", critical: true, onSignal: "wait" }],
            },
          },
        },
      }).success,
    ).toBe(true);
  });
});

describe("teardown entries and policy merging", () => {
  it("normalizes strings and objects", () => {
    expect(
      normalizeTeardown([
        "plain",
        { run: "belt", critical: true, timeout: "2m", onSignal: "wait" },
        { run: "bounded", timeout: 1500 },
      ]),
    ).toEqual([
      {
        run: "plain",
        critical: false,
        timeoutMs: undefined,
        onSignal: undefined,
      },
      { run: "belt", critical: true, timeoutMs: 120_000, onSignal: "wait" },
      { run: "bounded", critical: false, timeoutMs: 1500, onSignal: undefined },
    ]);
    expect(teardownCommand("plain")).toBe("plain");
    expect(teardownCommand({ run: "belt", critical: true })).toBe("belt");
  });

  it("an environment's keys win over the top-level ones, key by key", () => {
    expect(
      mergeRunPolicy(
        { lock: true, verifyClean: ["browsers"], finally: ["a"] },
        { lock: false, finally: ["b"] },
      ),
    ).toEqual({ lock: false, verifyClean: ["browsers"], finally: ["b"] });
    expect(mergeRunPolicy(undefined, { lock: true })).toEqual({ lock: true });
    expect(mergeRunPolicy({ lock: true }, undefined)).toEqual({ lock: true });
  });
});

describe("effective run policy of an environment", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "cairn-run-policy-ctx-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("merges environments.<n>.run over the top-level run, through extends", async () => {
    const path = join(dir, "cairntrace.config.yml");
    await writeFile(
      path,
      `version: 1
run:
  lock: true
  verifyClean: [browsers]
  finally: ["echo top"]
environments:
  local: {}
  quiet:
    run: { lock: false, finally: ["echo quiet"] }
  quieter:
    extends: quiet
`,
    );
    const at = (env: string) =>
      resolveProjectRuntimeContext({
        configPath: path,
        cwd: dir,
        envOverride: env,
      });
    expect((await at("local")).runPolicy).toEqual({
      lock: true,
      verifyClean: ["browsers"],
      finally: ["echo top"],
    });
    expect((await at("quiet")).runPolicy).toEqual({
      lock: false,
      verifyClean: ["browsers"],
      finally: ["echo quiet"],
    });
    expect((await at("quieter")).runPolicy).toEqual({
      lock: false,
      verifyClean: ["browsers"],
      finally: ["echo quiet"],
    });
  });
});
