import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CheckpointStore } from "./CheckpointStore";
import { buildCheckpointMeta, parseTtlMs, urlOrigin } from "./meta";

let dir: string;
let store: CheckpointStore;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-cp-test-"));
  store = new CheckpointStore(dir);
});

describe("CheckpointStore", () => {
  it("rejects unsafe names", () => {
    expect(() => store.pathFor("../escape")).toThrow();
    expect(() => store.pathFor("")).toThrow();
    expect(() => store.pathFor("1starts-with-digit")).toThrow();
    // valid:
    expect(store.pathFor("billing-ready")).toContain("billing-ready.json");
    expect(store.pathFor("login_admin")).toContain("login_admin.json");
  });

  it("resolveResume passes through absolute paths and path-like values", () => {
    expect(store.resolveResume("/absolute/path.json")).toBe(
      "/absolute/path.json",
    );
    expect(store.resolveResume("rel/path.json")).toBe("rel/path.json");
    // Plain name → resolved via store
    expect(store.resolveResume("billing")).toBe(join(dir, "billing.json"));
  });

  it("list / show / delete cycle", async () => {
    await store.ensureRoot();
    const path = store.pathFor("alpha");
    await writeFile(path, '{"cookies":[],"origins":[]}');
    expect(await store.exists("alpha")).toBe(true);

    const list = await store.list();
    expect(list.map((c) => c.name)).toContain("alpha");

    const summary = await store.show("alpha");
    expect(summary?.name).toBe("alpha");
    expect(summary?.preview).toContain("cookies");

    expect(await store.delete("alpha")).toBe(true);
    expect(await store.exists("alpha")).toBe(false);
  });
});

describe("checkpoint scope metadata (A10)", () => {
  it("parses ttls and builds expiring metadata", () => {
    expect(parseTtlMs("30m")).toBe(1_800_000);
    expect(parseTtlMs("12h")).toBe(43_200_000);
    expect(parseTtlMs("7d")).toBe(604_800_000);
    expect(parseTtlMs("2w")).toBe(1_209_600_000);
    expect(() => parseTtlMs("soon")).toThrow(/invalid ttl/);
    expect(() => parseTtlMs("0h")).toThrow(/invalid ttl/);
    const now = new Date("2026-01-01T00:00:00.000Z");
    expect(
      buildCheckpointMeta({
        name: "admin",
        baseUrl: "https://app.example.test",
        env: "local",
        ttl: "12h",
        capturedBy: "login",
        now,
      }),
    ).toEqual({
      version: 1,
      name: "admin",
      baseUrl: "https://app.example.test",
      env: "local",
      createdAt: "2026-01-01T00:00:00.000Z",
      ttl: "12h",
      expiresAt: "2026-01-01T12:00:00.000Z",
      capturedBy: "login",
    });
    expect(urlOrigin("https://app.example.test:8443/login?next=/")).toBe(
      "https://app.example.test:8443",
    );
    expect(urlOrigin("not a url")).toBeUndefined();
  });

  it("writes the sidecar, reports health in list/show and hides it from list", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-cp-meta-"));
    const scoped = new CheckpointStore(root);
    await scoped.ensureRoot();
    const now = new Date("2026-01-01T00:00:00.000Z");
    for (const name of ["fresh", "stale", "legacy"]) {
      await writeFile(scoped.pathFor(name), '{"cookies":[],"origins":[]}');
    }
    await scoped.writeMeta(
      scoped.pathFor("fresh"),
      buildCheckpointMeta({ name: "fresh", ttl: "1d", now }),
    );
    await scoped.writeMeta(
      scoped.pathFor("stale"),
      buildCheckpointMeta({
        name: "stale",
        ttl: "1h",
        now: new Date("2025-12-31T00:00:00.000Z"),
      }),
    );
    expect(scoped.metaPathFor(scoped.pathFor("fresh"))).toBe(
      join(root, "fresh.meta.json"),
    );
    const list = await scoped.list(now);
    expect(Object.fromEntries(list.map((c) => [c.name, c.health]))).toEqual({
      fresh: "ok",
      stale: "expired",
      legacy: "unscoped",
    });
    expect((await scoped.show("fresh", now))?.meta?.ttl).toBe("1d");
    expect(await scoped.delete("fresh")).toBe(true);
    expect(existsSync(join(root, "fresh.meta.json"))).toBe(false);
  });

  it("refuses missing, expired and other-origin checkpoints on resume", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-cp-resume-"));
    const scoped = new CheckpointStore(root);
    await scoped.ensureRoot();
    const now = new Date("2026-01-01T00:00:00.000Z");
    await writeFile(scoped.pathFor("admin"), "{}");
    await scoped.writeMeta(
      scoped.pathFor("admin"),
      buildCheckpointMeta({
        name: "admin",
        baseUrl: "https://app.example.test",
        env: "local",
        ttl: "1h",
        now,
      }),
    );
    await writeFile(scoped.pathFor("legacy"), "{}");

    expect((await scoped.checkResume("nope", { now })).problem?.code).toBe(
      "missing",
    );
    const ok = await scoped.checkResume("admin", {
      baseUrl: "https://app.example.test/base",
      now,
    });
    expect(ok.problem).toBeUndefined();
    expect(ok.path).toBe(scoped.pathFor("admin"));
    expect(ok.health).toBe("ok");
    const otherOrigin = await scoped.checkResume("admin", {
      baseUrl: "https://staging.example.test",
      now,
    });
    expect(otherOrigin.problem?.code).toBe("base-url-mismatch");
    expect(otherOrigin.problem?.message).toContain(
      "https://staging.example.test",
    );
    const expired = await scoped.checkResume("admin", {
      baseUrl: "https://app.example.test",
      now: new Date("2026-01-01T02:00:00.000Z"),
    });
    expect(expired.problem?.code).toBe("expired");
    // A checkpoint without metadata (captured before scoping) still resumes.
    const legacy = await scoped.checkResume("legacy", {
      baseUrl: "https://anything.example.test",
      now,
    });
    expect(legacy).toMatchObject({ health: "unscoped" });
    expect(legacy.problem).toBeUndefined();
  });

  it("binds the sidecar to the state file and ignores it once the state is rewritten", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-cp-bound-"));
    const scoped = new CheckpointStore(root);
    await scoped.ensureRoot();
    const path = scoped.pathFor("admin");
    const now = new Date("2026-01-01T00:00:00.000Z");
    // A state captured for dev with a 1h ttl (expired at `later`).
    await writeFile(path, '{"cookies":[{"name":"old"}],"origins":[]}');
    await scoped.writeMeta(
      path,
      buildCheckpointMeta({
        name: "admin",
        baseUrl: "https://dev.example.test",
        env: "dev",
        ttl: "1h",
        now,
      }),
    );
    const sidecar = JSON.parse(
      await readFile(scoped.metaPathFor(path), "utf8"),
    ) as { stateSha256?: string };
    expect(sidecar.stateSha256).toMatch(/^[0-9a-f]{64}$/);
    const later = new Date("2026-01-01T05:00:00.000Z");
    expect(
      (
        await scoped.checkResume("admin", {
          baseUrl: "http://127.0.0.1:3000",
          now: later,
        })
      ).problem?.code,
    ).toBe("expired");

    // Another tool (MCP capture, `agent-browser state save`, a precondition)
    // rewrites the state but not the sidecar: the old scope no longer
    // describes it and is ignored instead of refusing the fresh state.
    await writeFile(path, '{"cookies":[{"name":"fresh"}],"origins":[]}');
    const fresh = await scoped.checkResume("admin", {
      baseUrl: "http://127.0.0.1:3000",
      now: later,
    });
    expect(fresh.problem).toBeUndefined();
    expect(fresh).toMatchObject({ health: "unscoped", staleMeta: true });
    expect(fresh.meta).toBeUndefined();
    expect(await scoped.readMeta(path)).toBeUndefined();
    const [row] = await scoped.list(later);
    expect(row).toMatchObject({ health: "unscoped", staleMeta: true });
    expect((await scoped.show("admin", later))?.staleMeta).toBe(true);

    // A sidecar without a state binding (written before binding) is stale too.
    await writeFile(
      scoped.metaPathFor(path),
      JSON.stringify(buildCheckpointMeta({ name: "admin", ttl: "1h", now })),
    );
    expect(await scoped.checkResume("admin", { now: later })).toMatchObject({
      health: "unscoped",
      staleMeta: true,
    });

    // Re-scoping binds the sidecar to the current state again.
    await scoped.writeMeta(
      path,
      buildCheckpointMeta({ name: "admin", baseUrl: "http://127.0.0.1:3000" }),
    );
    const rescoped = await scoped.checkResume("admin", {
      baseUrl: "http://127.0.0.1:3000",
    });
    expect(rescoped).toMatchObject({ health: "ok" });
    expect(rescoped.staleMeta).toBeUndefined();
  });

  it("refuses to scope a state file that does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-cp-nostate-"));
    const scoped = new CheckpointStore(root);
    await scoped.ensureRoot();
    await expect(
      scoped.writeMeta(scoped.pathFor("ghost"), buildCheckpointMeta({})),
    ).rejects.toThrow(/not readable/);
  });
});
