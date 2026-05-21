import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { CheckpointStore } from "./CheckpointStore";

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
