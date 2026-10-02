import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardScript } from "./fcheapTestGuard";

/** The guard shim itself, with a stand-in "real" fcheap that echoes. */
function shim(): { run(...args: string[]): number; log(): string } {
  const dir = mkdtempSync(join(tmpdir(), "cairn-guard-test-"));
  const real = join(dir, "real-fcheap");
  writeFileSync(real, '#!/bin/sh\necho "REAL $*"\n', { mode: 0o755 });
  writeFileSync(join(dir, "violations.log"), "");
  const script = join(dir, "fcheap");
  writeFileSync(script, guardScript(real, dir), { mode: 0o755 });
  return {
    run: (...args) =>
      spawnSync(script, args, {
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      }).status ?? -1,
    log: () => readFileSync(join(dir, "violations.log"), "utf8"),
  };
}

describe("fcheap test guard", () => {
  it("passes only read-only commands to the real binary", () => {
    const guard = shim();
    expect(guard.run("--version")).toBe(0);
    expect(guard.run("list", "--tag", "x", "--json")).toBe(0);
    expect(guard.run("--json", "info", "abc")).toBe(0);
    expect(guard.run("auth", "status", "--json")).toBe(0);
    expect(guard.run("save", "--help")).toBe(0);
    expect(guard.run("--stash-dir", "/somewhere", "list")).toBe(0);
    expect(guard.log()).toBe("");
  });

  it("refuses writes, even behind global flags, and mutating auth/config/pull/restore", () => {
    const guard = shim();
    for (const args of [
      ["save", "/tmp/run"],
      ["--json", "save", "/tmp/run"],
      ["auth", "login"],
      ["config", "set", "x", "y"],
      ["pull", "artifact-1"],
      ["restore", "stash-1"],
      ["artifact-ref", "stash-1"],
      ["publish", "/tmp/a.tar.gz", "--stash-dir", "/tmp/vault"],
      ["save", "/tmp/run", "--stash-dir", "/Users/someone/.fcheap"],
    ]) {
      expect(guard.run(...args)).toBe(86);
    }
    expect(guard.log().trim().split("\n")).toHaveLength(9);
  });

  it("lets a write through with a temp --stash-dir", () => {
    const guard = shim();
    expect(guard.run("save", "/tmp/run", "--stash-dir", "/tmp/vault")).toBe(0);
    expect(guard.run("--stash-dir=/private/tmp/vault", "drop", "x")).toBe(0);
    expect(guard.log()).toBe("");
  });
});
