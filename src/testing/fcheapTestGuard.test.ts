import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { guardScript } from "./fcheapTestGuard";

interface ShimResult {
  status: number;
  stdout: string;
  stderr: string;
}

/** The guard shim itself, with a stand-in "real" fcheap that echoes. */
function shim(): {
  dir: string;
  run(...args: string[]): number;
  exec(args: string[], env?: Record<string, string>): ShimResult;
  log(): string;
} {
  const dir = mkdtempSync(join(tmpdir(), "cairn-guard-test-"));
  const real = join(dir, "real-fcheap");
  writeFileSync(
    real,
    [
      "#!/bin/sh",
      'echo "REAL $*"',
      "for name in XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME FCHEAP_STASH_DIR FCHEAP_VECGREP_PATH FILECHEAP_ARTIFACT_SERVICE_URL FILECHEAP_INGEST_TOKEN; do",
      '  eval "value=\\${$name-<unset>}"',
      '  echo "$name=$value"',
      "done",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );
  writeFileSync(join(dir, "violations.log"), "");
  const script = join(dir, "fcheap");
  writeFileSync(script, guardScript(real, dir), { mode: 0o755 });
  const exec = (
    args: string[],
    env: Record<string, string> = {},
  ): ShimResult => {
    const result = spawnSync(script, args, {
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin", ...env },
    });
    return {
      status: result.status ?? -1,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  };
  return {
    dir,
    exec,
    run: (...args) => exec(args).status,
    log: () => readFileSync(join(dir, "violations.log"), "utf8"),
  };
}

describe("fcheap test guard", () => {
  it("passes only read-only commands to the real binary", () => {
    const guard = shim();
    expect(guard.run("--version")).toBe(0);
    expect(guard.run("list", "--tag", "x", "--json")).toBe(0);
    expect(guard.run("--json", "info", "abc")).toBe(0);
    expect(guard.run("save", "--help")).toBe(0);
    expect(guard.run("--stash-dir", "/somewhere", "list")).toBe(0);
    expect(guard.log()).toBe("");
  });

  it("answers `auth status` itself instead of reaching the real binary", () => {
    const guard = shim();
    for (const args of [
      ["auth", "status"],
      ["auth", "status", "--json"],
      ["--json", "auth", "status"],
      ["--no-color", "auth", "status", "--stash-dir", "/tmp/vault"],
    ]) {
      const result = guard.exec(args);
      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("not logged in; run fcheap auth login\n");
    }
    // The other auth subcommands stay refused; help is documentation only.
    expect(guard.run("auth", "refresh")).toBe(86);
    expect(guard.run("auth", "logout")).toBe(86);
    expect(guard.exec(["auth", "status", "--help"]).stdout).toContain("REAL");
  });

  it("pins fcheap's config, data and vault locations inside the guard dir", () => {
    const guard = shim();
    const result = guard.exec(["list"], {
      XDG_CONFIG_HOME: "/real/config",
      XDG_DATA_HOME: "/real/data",
      XDG_STATE_HOME: "/real/state",
      XDG_CACHE_HOME: "/real/cache",
      FCHEAP_STASH_DIR: "/real/vault",
      FCHEAP_VECGREP_PATH: "/real/bin/vecgrep",
      FILECHEAP_ARTIFACT_SERVICE_URL: "https://example.invalid",
      FILECHEAP_INGEST_TOKEN: ["not", "a", "token"].join("-"),
    });
    expect(result.status).toBe(0);
    const seen = Object.fromEntries(
      result.stdout
        .split("\n")
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [
          line.slice(0, line.indexOf("=")),
          line.slice(line.indexOf("=") + 1),
        ]),
    );
    expect(seen).toEqual({
      XDG_CONFIG_HOME: join(guard.dir, "xdg", "config"),
      XDG_DATA_HOME: join(guard.dir, "xdg", "data"),
      XDG_STATE_HOME: join(guard.dir, "xdg", "state"),
      XDG_CACHE_HOME: join(guard.dir, "xdg", "cache"),
      FCHEAP_STASH_DIR: join(guard.dir, "xdg", "data", "fcheap"),
      FCHEAP_VECGREP_PATH: "<unset>",
      FILECHEAP_ARTIFACT_SERVICE_URL: "<unset>",
      FILECHEAP_INGEST_TOKEN: "<unset>",
    });
    // An explicit temp --stash-dir write is passed through under the same pins.
    const write = guard.exec(
      ["save", "/tmp/run", "--stash-dir", "/tmp/vault"],
      {
        XDG_CONFIG_HOME: "/real/config",
      },
    );
    expect(write.stdout).toContain(
      `XDG_CONFIG_HOME=${join(guard.dir, "xdg", "config")}`,
    );
    expect(write.stdout).toContain("--stash-dir /tmp/vault");
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
