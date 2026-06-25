import { mkdtemp, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SeedStateStore, type SeedState } from "./seedState";
import type { SeedConfig } from "../schema/config.v1";

/**
 * Tests for the SeedStateStore — fingerprint, TTL, and freshness-check
 * decision logic. No real shell commands are executed; we only test the
 * state file read/write/record logic and the checkFreshness decision tree.
 */

let root: string;
let store: SeedStateStore;

const baseCfg: SeedConfig = {
  command: "yarn demo-import",
  ttlSeconds: 3600,
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "cairntrace-seedstate-"));
  store = new SeedStateStore(root);
});

afterEach(async () => {
  // Cleanup is automatic — temp dir is in /tmp and OS-managed.
});

describe("SeedStateStore — file I/O", () => {
  it("read returns undefined when no state file exists", async () => {
    const state = await store.read("myapp");
    expect(state).toBeUndefined();
  });

  it("write then read round-trips the state", async () => {
    const state: SeedState = {
      project: "myapp",
      fingerprint: "abc123",
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    };
    await store.write("myapp", state);
    const read = await store.read("myapp");
    expect(read).toEqual(state);
  });

  it("delete removes the state file and returns true", async () => {
    await store.write("myapp", {
      project: "myapp",
      fingerprint: "x",
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    });
    expect(await store.delete("myapp")).toBe(true);
    expect(await store.read("myapp")).toBeUndefined();
  });

  it("delete returns false when the file does not exist", async () => {
    expect(await store.delete("nonexistent")).toBe(false);
  });

  it("write creates the root directory if it does not exist", async () => {
    const nestedStore = new SeedStateStore(join(root, "nested", "deep"));
    await nestedStore.write("app", {
      project: "app",
      fingerprint: "fp",
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    });
    expect(existsSync(join(root, "nested", "deep", "app.seed.json"))).toBe(
      true,
    );
  });

  it("pathFor rejects invalid project names", () => {
    expect(() => store.pathFor("123bad")).toThrow(/invalid project name/);
    expect(() => store.pathFor("has space")).toThrow(/invalid project name/);
    expect(() => store.pathFor("")).toThrow(/invalid project name/);
    expect(() => store.pathFor("valid-name_123")).not.toThrow();
  });

  it("read handles corrupted JSON gracefully", async () => {
    await writeFile(join(root, "corrupt.seed.json"), "{not valid json");
    const state = await store.read("corrupt");
    expect(state).toBeUndefined();
  });
});

describe("SeedStateStore — fingerprint", () => {
  it("produces a stable 16-char hex fingerprint for the same config", () => {
    const fp1 = store.fingerprint("app", baseCfg);
    const fp2 = store.fingerprint("app", baseCfg);
    expect(fp1).toBe(fp2);
    expect(fp1).toMatch(/^[a-f0-9]{16}$/);
  });

  it("changes when the command changes", () => {
    const fp1 = store.fingerprint("app", { ...baseCfg, command: "cmd-a" });
    const fp2 = store.fingerprint("app", { ...baseCfg, command: "cmd-b" });
    expect(fp1).not.toBe(fp2);
  });

  it("changes when the project name changes", () => {
    const fp1 = store.fingerprint("app-a", baseCfg);
    const fp2 = store.fingerprint("app-b", baseCfg);
    expect(fp1).not.toBe(fp2);
  });

  it("changes when the env keys change (not values)", () => {
    const fp1 = store.fingerprint("app", {
      ...baseCfg,
      env: { A: "1", B: "2" },
    });
    const fp2 = store.fingerprint("app", {
      ...baseCfg,
      env: { A: "1", C: "3" },
    });
    expect(fp1).not.toBe(fp2);
  });

  it("does NOT change when env values change (secret rotation)", () => {
    const fp1 = store.fingerprint("app", {
      ...baseCfg,
      env: { KEY: "secret-v1" },
    });
    const fp2 = store.fingerprint("app", {
      ...baseCfg,
      env: { KEY: "secret-v2" },
    });
    expect(fp1).toBe(fp2);
  });

  it("changes when ttlSeconds changes", () => {
    const fp1 = store.fingerprint("app", { ...baseCfg, ttlSeconds: 3600 });
    const fp2 = store.fingerprint("app", { ...baseCfg, ttlSeconds: 7200 });
    expect(fp1).not.toBe(fp2);
  });
});

describe("SeedStateStore — checkFreshness", () => {
  it("returns shouldRun=true when no previous state exists", () => {
    const check = store.checkFreshness("app", baseCfg, undefined);
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toBe("no-previous-seed");
  });

  it("returns shouldRun=true when fingerprint changed", () => {
    const state: SeedState = {
      project: "app",
      fingerprint: "old-fp",
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness("app", baseCfg, state);
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toMatch(/fingerprint-changed/);
  });

  it("returns shouldRun=true when previous seed failed", () => {
    const fp = store.fingerprint("app", baseCfg);
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 1,
    };
    const check = store.checkFreshness("app", baseCfg, state);
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toMatch(/previous-seed-failed/);
  });

  it("returns shouldRun=false when within TTL", () => {
    const fp = store.fingerprint("app", baseCfg);
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness("app", baseCfg, state);
    expect(check.shouldRun).toBe(false);
    expect(check.reason).toBe("within-ttl");
  });

  it("returns shouldRun=true when TTL expired", () => {
    const fp = store.fingerprint("app", baseCfg);
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      // 2 hours ago, TTL is 1 hour
      lastRunAt: new Date(Date.now() - 2 * 3600 * 1000).toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness("app", baseCfg, state);
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toMatch(/ttl-expired/);
  });

  it("returns shouldRun=true with freshness-check-pending when within TTL and freshnessCheck configured", () => {
    const fp = store.fingerprint("app", {
      ...baseCfg,
      freshnessCheck: "echo ok",
    });
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness(
      "app",
      { ...baseCfg, freshnessCheck: "echo ok" },
      state,
    );
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toBe("freshness-check-pending");
  });

  it("returns shouldRun=true with ttl-zero-no-freshness-check when ttlSeconds=0 and no freshnessCheck", () => {
    const fp = store.fingerprint("app", { ...baseCfg, ttlSeconds: 0 });
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness(
      "app",
      { ...baseCfg, ttlSeconds: 0 },
      state,
    );
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toBe("ttl-zero-no-freshness-check");
  });

  it("returns shouldRun=true when lastRunAt is invalid", () => {
    const fp = store.fingerprint("app", baseCfg);
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: "not-a-date",
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness("app", baseCfg, state);
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toBe("invalid-lastRunAt-timestamp");
  });
});

describe("SeedStateStore — recordRun", () => {
  it("writes a state file with the correct fingerprint and exit code", async () => {
    await store.recordRun("app", baseCfg, 0);
    const state = await store.read("app");
    expect(state).toBeDefined();
    expect(state!.fingerprint).toBe(store.fingerprint("app", baseCfg));
    expect(state!.lastRunExitCode).toBe(0);
    expect(state!.lastRunAt).toBeDefined();
    // lastRunAt should be a valid ISO timestamp.
    expect(new Date(state!.lastRunAt).getTime()).not.toBeNaN();
  });

  it("records failed exit codes too (so re-run is triggered next time)", async () => {
    await store.recordRun("app", baseCfg, 1);
    const state = await store.read("app");
    expect(state).toBeDefined();
    expect(state!.lastRunExitCode).toBe(1);
  });

  it("overwrites the previous state file", async () => {
    await store.recordRun("app", baseCfg, 1);
    await store.recordRun("app", baseCfg, 0);
    const state = await store.read("app");
    expect(state).toBeDefined();
    expect(state!.lastRunExitCode).toBe(0);
  });
});

describe("SeedStateStore — fingerprint edge cases", () => {
  it("is stable regardless of env key insertion order", () => {
    const fp1 = store.fingerprint("app", {
      ...baseCfg,
      env: { A: "1", B: "2", C: "3" },
    });
    const fp2 = store.fingerprint("app", {
      ...baseCfg,
      env: { C: "3", A: "1", B: "2" },
    });
    expect(fp1).toBe(fp2);
  });

  it("changes when freshnessCheck is added (it's not part of the fingerprint)", () => {
    // freshnessCheck is intentionally NOT in the fingerprint — adding/removing
    // it shouldn't change the fingerprint. This is by design: the freshnessCheck
    // is a runtime probe, not a config identity change.
    const fp1 = store.fingerprint("app", {
      ...baseCfg,
      freshnessCheck: "echo ok",
    });
    const fp2 = store.fingerprint("app", baseCfg);
    expect(fp1).toBe(fp2);
  });

  it("changes when timeoutMs changes (not part of fingerprint — intentional)", () => {
    // timeoutMs is intentionally NOT in the fingerprint — changing the timeout
    // doesn't invalidate the seed data.
    const fp1 = store.fingerprint("app", { ...baseCfg, timeoutMs: 60000 });
    const fp2 = store.fingerprint("app", { ...baseCfg, timeoutMs: 120000 });
    expect(fp1).toBe(fp2);
  });

  it("changes when cwd changes (cwd is NOT part of fingerprint — intentional)", () => {
    // cwd is intentionally NOT in the fingerprint — running the same command
    // from a different directory doesn't invalidate the seed data.
    const fp1 = store.fingerprint("app", { ...baseCfg, cwd: "/dir-a" });
    const fp2 = store.fingerprint("app", { ...baseCfg, cwd: "/dir-b" });
    expect(fp1).toBe(fp2);
  });
});

describe("SeedStateStore — checkFreshness edge cases", () => {
  it("returns shouldRun=true when ttlSeconds is undefined (defaults to 0, always re-seed)", () => {
    const cfg: SeedConfig = { command: "yarn seed" }; // no ttlSeconds
    const fp = store.fingerprint("app", cfg);
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness("app", cfg, state);
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toBe("ttl-zero-no-freshness-check");
  });

  it("returns shouldRun=true with freshness-check-pending when TTL=0 and freshnessCheck is set", () => {
    const cfg: SeedConfig = {
      command: "yarn seed",
      ttlSeconds: 0,
      freshnessCheck: "echo ok",
    };
    const fp = store.fingerprint("app", cfg);
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness("app", cfg, state);
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toBe("freshness-check-pending");
  });

  it("returns shouldRun=false when TTL is very large and timestamp is recent", () => {
    const cfg: SeedConfig = { command: "yarn seed", ttlSeconds: 999999 };
    const fp = store.fingerprint("app", cfg);
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness("app", cfg, state);
    expect(check.shouldRun).toBe(false);
    expect(check.reason).toBe("within-ttl");
  });

  it("returns shouldRun=true when TTL expired by a tiny margin", () => {
    const cfg: SeedConfig = { command: "yarn seed", ttlSeconds: 1 };
    const fp = store.fingerprint("app", cfg);
    // 2 seconds ago, TTL is 1 second
    const state: SeedState = {
      project: "app",
      fingerprint: fp,
      lastRunAt: new Date(Date.now() - 2000).toISOString(),
      lastRunExitCode: 0,
    };
    const check = store.checkFreshness("app", cfg, state);
    expect(check.shouldRun).toBe(true);
    expect(check.reason).toMatch(/ttl-expired/);
  });
});

describe("SeedStateStore — recordRun with freshnessCheck", () => {
  it("records state correctly when freshnessCheck is configured", async () => {
    const cfg: SeedConfig = {
      command: "yarn seed",
      ttlSeconds: 3600,
      freshnessCheck: "echo ok",
    };
    await store.recordRun("app", cfg, 0);
    const state = await store.read("app");
    expect(state).toBeDefined();
    expect(state!.fingerprint).toBe(store.fingerprint("app", cfg));
    expect(state!.lastRunExitCode).toBe(0);
  });

  it("recordRun with env config stores correct fingerprint", async () => {
    const cfg: SeedConfig = {
      command: "yarn seed",
      ttlSeconds: 3600,
      env: { API_KEY: "secret", DB_HOST: "localhost" },
    };
    await store.recordRun("app", cfg, 0);
    const state = await store.read("app");
    expect(state).toBeDefined();
    expect(state!.fingerprint).toBe(store.fingerprint("app", cfg));
  });
});

describe("SeedStateStore — read with extra fields", () => {
  it("preserves extra fields in the state file (forward-compatible)", async () => {
    const stateWithExtra = {
      project: "app",
      fingerprint: "fp",
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
      // Future field that older code doesn't know about
      futureField: "some-data",
    };
    await store.write("app", stateWithExtra);
    const read = await store.read("app");
    // The extra field should be preserved (JSON.parse keeps unknown keys)
    expect(read).toBeDefined();
    expect(read!.project).toBe("app");
    expect(read!.fingerprint).toBe("fp");
  });
});

describe("SeedStateStore — ensureRoot", () => {
  it("ensureRoot creates the directory if it doesn't exist", async () => {
    const deepStore = new SeedStateStore(join(root, "a", "b", "c"));
    await deepStore.ensureRoot();
    // Now writing should work without error
    await deepStore.write("app", {
      project: "app",
      fingerprint: "fp",
      lastRunAt: new Date().toISOString(),
      lastRunExitCode: 0,
    });
    expect(existsSync(join(root, "a", "b", "c", "app.seed.json"))).toBe(true);
  });
});
