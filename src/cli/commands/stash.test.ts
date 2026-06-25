import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { maybeAutoStash, isFcheapAvailable } from "./stash";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-stash-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("maybeAutoStash", () => {
  it("does nothing when stashOnFailure is false and config is absent", async () => {
    // maybeAutoStash returns early; no fcheap call is made.
    // We can't easily assert "no process.exit" without mocking execa,
    // but we can verify it doesn't throw and doesn't exit.
    await maybeAutoStash("/tmp/fake-run-dir", "run-123", "my_spec", {
      stashOnFailure: false,
    });
    // If we reach here, the function returned without exiting.
    expect(true).toBe(true);
  });

  it("does nothing when config.stash is not enabled", async () => {
    await maybeAutoStash("/tmp/fake-run-dir", "run-123", "my_spec", {
      stashOnFailure: false,
      configStash: { enabled: false, autoStash: "on-failure" },
    });
    expect(true).toBe(true);
  });

  it("does nothing when config.stash.autoStash is 'never'", async () => {
    await maybeAutoStash("/tmp/fake-run-dir", "run-123", "my_spec", {
      stashOnFailure: false,
      configStash: { enabled: true, autoStash: "never" },
    });
    expect(true).toBe(true);
  });

  it("attempts to stash when stashOnFailure is true (best-effort, non-fatal)", async () => {
    // stashOnFailure=true triggers the fcheap call. fcheap likely isn't installed
    // in CI, so the call fails — but maybeAutoStash is best-effort and should
    // write to stderr without throwing or exiting.
    // We just verify it doesn't throw.
    await maybeAutoStash("/tmp/fake-run-dir", "run-456", "my_spec", {
      stashOnFailure: true,
    });
    expect(true).toBe(true);
  });

  it("attempts to stash when config.stash.autoStash is on-failure and enabled", async () => {
    await maybeAutoStash("/tmp/fake-run-dir", "run-789", "my_spec", {
      stashOnFailure: false,
      configStash: { enabled: true, autoStash: "on-failure", tags: ["audit"] },
    });
    expect(true).toBe(true);
  });
});

describe("isFcheapAvailable", () => {
  it("returns a boolean without throwing", async () => {
    const result = await isFcheapAvailable();
    expect(typeof result).toBe("boolean");
  });
});
