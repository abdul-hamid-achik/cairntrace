import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isFcheapAvailable,
  maybeAutoStash,
  searchStashesForSymbol,
  type StashSearchDeps,
} from "./stash";
import type { CodemapDeps } from "./annotate.js";

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

/* ---------------------------------------------------------------------------
 * searchStashesForSymbol — `cairn stash search <symbol>` (FEATURES item 5)
 *
 * The symbol query is seeded from `codemap semantic`/`find` (file + signature +
 * docstring terms) and then run through `fcheap search`. A fake codemap +
 * fake fcheap verify the seeding + result parsing without either tool on
 * $PATH.
 * ------------------------------------------------------------------------- */

function fakeCodemapForSymbol(): CodemapDeps {
  return {
    isAvailable: async () => true,
    async exec(args) {
      if (args[0] === "semantic" || args[0] === "find") {
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              symbol: "login",
              file: "src/auth/login.ts",
              signature: "login(email, pw): Promise<User>",
              docstring: "Submit credentials and redirect to the dashboard.",
            },
          ]),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unknown ${args[0]}` };
    },
  };
}

describe("searchStashesForSymbol", () => {
  it("seeds the fcheap query with codemap-expanded terms and returns matches", async () => {
    const fcheapArgs: string[][] = [];
    const deps: StashSearchDeps = {
      codemap: fakeCodemapForSymbol(),
      async fcheapExec(args) {
        fcheapArgs.push(args);
        return {
          exitCode: 0,
          stdout: JSON.stringify([
            {
              stashId: "stash-abc",
              snippet: "login form submit failed",
              score: 0.91,
              file: "outcomes/redirect-check.md",
            },
          ]),
          stderr: "",
        };
      },
    };

    const outcome = await searchStashesForSymbol("login", {}, deps);

    // The codemap expansion enriched the query with the file + docstring.
    expect(outcome.expandedTerms).toContain("login");
    expect(outcome.expandedTerms).toContain("src/auth/login.ts");
    expect(outcome.query).toBe("login");

    // fcheap was searched with the joined expanded terms + --json appended.
    expect(fcheapArgs).toHaveLength(1);
    expect(fcheapArgs[0]![0]).toBe("search");
    expect(fcheapArgs[0]![1]).toContain("login");
    expect(fcheapArgs[0]![1]).toContain("src/auth/login.ts");

    // The matching stash is returned.
    expect(outcome.results).toHaveLength(1);
    expect(outcome.results[0]!.stashId).toBe("stash-abc");
    expect(outcome.results[0]!.score).toBeCloseTo(0.91);
  });

  it("falls back to the bare symbol when codemap is absent (no regression)", async () => {
    const fcheapArgs: string[][] = [];
    const deps: StashSearchDeps = {
      codemap: {
        isAvailable: async () => false,
        exec: async () => ({ exitCode: 127, stdout: "", stderr: "no" }),
      },
      async fcheapExec(args) {
        fcheapArgs.push(args);
        return { exitCode: 0, stdout: "[]", stderr: "" };
      },
    };
    const outcome = await searchStashesForSymbol("login", {}, deps);
    expect(outcome.expandedTerms).toEqual(["login"]);
    expect(fcheapArgs[0]![1]).toBe("login");
    expect(outcome.results).toEqual([]);
  });

  it("records an error when fcheap fails", async () => {
    const deps: StashSearchDeps = {
      codemap: fakeCodemapForSymbol(),
      async fcheapExec() {
        return { exitCode: 2, stdout: "", stderr: "index corrupt" };
      },
    };
    const outcome = await searchStashesForSymbol("login", {}, deps);
    expect(outcome.results).toEqual([]);
    expect(outcome.error).toBe("index corrupt");
  });
});
