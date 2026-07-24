import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  isFcheapAvailable,
  maybeAutoStash,
  searchStashesForSymbol,
  stashDirectory,
  writeAutoStashReceipt,
  type StashSearchDeps,
} from "./stash";
import type { CodemapDeps } from "./annotate.js";
import { ArtifactManifestSchema } from "../../core/schema/run.v1.js";
import { StashReceiptSchema } from "../../core/schema/stash.v1.js";

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

  it("adds a safe receipt and event without changing finalized run.json", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-auto-stash-receipt-"),
    );
    const runDir = join(fixtureRoot, "run");
    const fakeFcheap = join(fixtureRoot, "fcheap");
    const stashId = "checkout_stash_20260724_deadbeef";
    const finalizedRun = '{"status":"failed","summary":"finalized"}\n';
    await mkdir(runDir, { recursive: true });
    await writeFile(join(runDir, "run.json"), finalizedRun);
    await writeFile(
      join(runDir, "events.ndjson"),
      '{"ts":"2026-07-24T00:00:00.000Z","type":"run.failed"}\n',
    );
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"${stashId}","status":"saved"}'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    const previousBinary = process.env.FCHEAP_BIN;
    process.env.FCHEAP_BIN = fakeFcheap;
    try {
      const result = await maybeAutoStash(runDir, "run-finalized", "checkout", {
        stashOnFailure: true,
      });
      expect(result).toMatchObject({ ok: true, stashId });
      expect(await readFile(join(runDir, "run.json"), "utf8")).toBe(
        finalizedRun,
      );

      const receiptText = await readFile(
        join(runDir, "stash-receipt.json"),
        "utf8",
      );
      const receipt = StashReceiptSchema.parse(JSON.parse(receiptText));
      expect(receipt).toMatchObject({
        stashId,
        status: "saved",
        postSaveFailureCount: 0,
      });

      const events = await readFile(join(runDir, "events.ndjson"), "utf8");
      expect(events).toContain(stashId);
      expect(events).toContain('"type":"artifact.stash"');
      expect(events).toContain('"receipt":"stash-receipt.json"');

      const manifest = ArtifactManifestSchema.parse(
        JSON.parse(
          await readFile(join(runDir, "artifact-manifest.json"), "utf8"),
        ),
      );
      expect(manifest.artifacts.map((artifact) => artifact.path)).toEqual(
        expect.arrayContaining([
          "events.ndjson",
          "run.json",
          "stash-receipt.json",
        ]),
      );
    } finally {
      if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
      else process.env.FCHEAP_BIN = previousBinary;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("writes neither a receipt nor event when redaction would destroy the stash id", async () => {
    const runDir = await mkdtemp(
      join(tmpdir(), "cairntrace-redacted-stash-receipt-"),
    );
    const secretStashId = "secret_stash_20260724_deadbeef";
    const originalEvents =
      '{"ts":"2026-07-24T00:00:00.000Z","type":"run.failed"}\n';
    await writeFile(join(runDir, "events.ndjson"), originalEvents);

    const previousSecret = process.env.CAIRN_RECEIPT_TEST_API_TOKEN;
    process.env.CAIRN_RECEIPT_TEST_API_TOKEN = secretStashId;
    try {
      await expect(
        writeAutoStashReceipt(runDir, {
          ok: true,
          stashId: secretStashId,
          status: "saved",
        }),
      ).rejects.toThrow(/recovery receipt was not written/i);
      await expect(
        readFile(join(runDir, "stash-receipt.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
      expect(await readFile(join(runDir, "events.ndjson"), "utf8")).toBe(
        originalEvents,
      );
    } finally {
      if (previousSecret === undefined)
        delete process.env.CAIRN_RECEIPT_TEST_API_TOKEN;
      else process.env.CAIRN_RECEIPT_TEST_API_TOKEN = previousSecret;
      await rm(runDir, { recursive: true, force: true });
    }
  });

  it("refuses to persist a legacy path as a stash identifier", async () => {
    const runDir = await mkdtemp(
      join(tmpdir(), "cairntrace-unsafe-stash-receipt-"),
    );
    try {
      await expect(
        writeAutoStashReceipt(runDir, {
          ok: true,
          stashId: "/private/tmp/stash",
          status: "saved",
        }),
      ).rejects.toThrow(/safe single path component/i);
      await expect(
        readFile(join(runDir, "stash-receipt.json"), "utf8"),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});

describe("isFcheapAvailable", () => {
  it("returns a boolean without throwing", async () => {
    const result = await isFcheapAvailable();
    expect(typeof result).toBe("boolean");
  });
});

describe("file.cheap save contract", () => {
  it("accepts canonical fcheap save --json output through the real CLI boundary", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-fcheap-contract-"),
    );
    const runsRoot = join(fixtureRoot, "runs");
    const runId = "checkout-2026-07-23T120000Z";
    const runDir = join(runsRoot, runId);
    const fakeBin = join(fixtureRoot, "bin");
    await mkdir(runDir, { recursive: true });
    await mkdir(fakeBin, { recursive: true });

    const fakeFcheap = join(fakeBin, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"checkout-stash-20260723","schema_version":"1.0","status":"saved"}'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    try {
      const result = await execa(
        join(process.cwd(), "bin", "cairn"),
        ["stash", "save", "latest", "--artifact-root", runsRoot, "--json"],
        {
          reject: false,
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        runId,
        stashId: "checkout-stash-20260723",
        path: runDir,
        tool: "cairntrace",
      });
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("fails closed when save exits successfully without a receipt id", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-fcheap-invalid-receipt-"),
    );
    const fakeBin = join(fixtureRoot, "bin");
    const sourceDir = join(fixtureRoot, "run");
    await mkdir(fakeBin, { recursive: true });
    await mkdir(sourceDir, { recursive: true });
    const fakeFcheap = join(fakeBin, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"status":"saved"}'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}:${originalPath ?? ""}`;
    try {
      const result = await stashDirectory(sourceDir);
      expect(result.ok).toBe(false);
      expect(result.stashId).toBeUndefined();
      expect(result.error).toMatch(/expected a non-empty id/i);
    } finally {
      process.env.PATH = originalPath;
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });

  it("preserves a saved_with_failures receipt and returns a non-zero CLI result", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-fcheap-partial-save-"),
    );
    const runsRoot = join(fixtureRoot, "runs");
    const runId = "audit-2026-07-24T010203Z";
    const runDir = join(runsRoot, runId);
    const fakeFcheap = join(fixtureRoot, "fcheap");
    await mkdir(runDir, { recursive: true });
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"stash-partial","status":"saved_with_failures","failed":[{"id":"stash-partial","stage":"index","error":"vecgrep unavailable"}]}'
  printf '%s\\n' 'stash saved with 1 failed post-save operation' >&2
  exit 2
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    try {
      const result = await execa(
        join(process.cwd(), "bin", "cairn"),
        ["stash", "save", "latest", "--artifact-root", runsRoot, "--json"],
        {
          reject: false,
          env: { ...process.env, FCHEAP_BIN: fakeFcheap },
        },
      );

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toMatchObject({
        runId,
        stashId: "stash-partial",
        status: "saved_with_failures",
        failures: [
          {
            id: "stash-partial",
            stage: "index",
            error: "vecgrep unavailable",
          },
        ],
      });
      expect(result.stderr).toContain("failed post-save operation");

      const previousBinary = process.env.FCHEAP_BIN;
      process.env.FCHEAP_BIN = fakeFcheap;
      try {
        await expect(stashDirectory(runDir)).resolves.toMatchObject({
          ok: true,
          stashId: "stash-partial",
          status: "saved_with_failures",
          warning: expect.stringContaining("failed post-save operation"),
        });
      } finally {
        if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
        else process.env.FCHEAP_BIN = previousBinary;
      }
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
  });
});

describe("file.cheap restore contract", () => {
  it("preserves the structured receipt when restored files fail verification", async () => {
    const fixtureRoot = await mkdtemp(
      join(tmpdir(), "cairntrace-fcheap-restore-mismatch-"),
    );
    const fakeBin = join(fixtureRoot, "bin");
    await mkdir(fakeBin, { recursive: true });
    const fakeFcheap = join(fakeBin, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "restore" ]; then
  printf '%s\\n' '{"stash_id":"stash-restore","target":"/tmp/restored-run","file_count":2,"verified":false,"mismatches":["report.json"],"status":"restored_with_mismatches"}'
  printf '%s\\n' 'restore verification failed' >&2
  exit 2
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);

    try {
      const result = await execa(
        join(process.cwd(), "bin", "cairn"),
        ["stash", "restore", "stash-restore", "--json"],
        {
          reject: false,
          timeout: 10_000,
          env: {
            ...process.env,
            PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
          },
        },
      );

      expect(result.exitCode).toBe(2);
      expect(JSON.parse(result.stdout)).toEqual({
        stashId: "stash-restore",
        restoredTo: "/tmp/restored-run",
        fileCount: 2,
        verified: false,
        mismatches: ["report.json"],
        status: "restored_with_mismatches",
      });
      expect(result.stderr).toContain("restore verification failed");
    } finally {
      await rm(fixtureRoot, { recursive: true, force: true });
    }
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
              stash_id: "stash-abc",
              text: "login form submit failed",
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

  it("records an error when fcheap returns invalid search JSON", async () => {
    const deps: StashSearchDeps = {
      codemap: fakeCodemapForSymbol(),
      async fcheapExec() {
        return {
          exitCode: 0,
          stdout: JSON.stringify([{ score: 0.91, text: "missing stash id" }]),
          stderr: "",
        };
      },
    };

    const outcome = await searchStashesForSymbol("login", {}, deps);
    expect(outcome.results).toEqual([]);
    expect(outcome.error).toMatch(/Invalid fcheap search JSON/);
  });
});
