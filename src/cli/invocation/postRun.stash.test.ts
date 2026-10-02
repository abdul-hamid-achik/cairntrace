import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EvidenceTransferError } from "../../core/artifacts/retention";
import type { RunResult } from "../../core/schema/run.v1";
import { makeArchiveRun, runPostRunIntegrations } from "./postRun";

/** Post-run stash automation against a fake fcheap (never the real one). */

let previousBinary: string | undefined;
let log: string;
beforeEach(async () => {
  previousBinary = process.env.FCHEAP_BIN;
  const dir = await mkdtemp(join(tmpdir(), "cairntrace-postrun-fake-"));
  log = join(dir, "args.log");
  const bin = join(dir, "fcheap");
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${log}'
if [ "$1" = "save" ] && [ "$2" != "--help" ]; then
  case "$*" in *retention-archived*) echo "vault locked" >&2; exit 4 ;; esac
  printf '%s\\n' '{"id":"post-run-1","status":"saved"}'
  exit 0
fi
exit 2
`,
  );
  await chmod(bin, 0o755);
  process.env.FCHEAP_BIN = bin;
});
afterEach(() => {
  if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
  else process.env.FCHEAP_BIN = previousBinary;
});

const saves = async (): Promise<string[]> =>
  (await readFile(log, "utf8").catch(() => ""))
    .split("\n")
    .filter((line) => line.startsWith("save ") && !line.includes("--help"));

async function result(status: string): Promise<RunResult> {
  const runDir = await mkdtemp(join(tmpdir(), "cairntrace-postrun-run-"));
  await writeFile(join(runDir, "run.json"), JSON.stringify({ status }));
  return {
    runId: "2026-10-02T13-00-00-000Z_checkout_abcdef",
    runDir,
    status,
    spec: { name: "checkout", path: join(runDir, "missing-spec.yml") },
    environment: "local",
    backend: "mock",
  } as unknown as RunResult;
}

const sinks = { log: { warn: () => undefined }, narrate: () => undefined };

describe("post-run stash automation", () => {
  it("cairn run --stash stashes a passed run", async () => {
    const passed = await result("passed");
    await runPostRunIntegrations(
      passed,
      passed.spec.path,
      { stash: true },
      sinks,
    );
    const [save] = await saves();
    expect(save).toContain("--tag checkout");
    expect(save).toContain("--ttl 7d");
    expect(
      JSON.parse(
        await readFile(join(passed.runDir, "stash-receipt.json"), "utf8"),
      ),
    ).toMatchObject({ action: "auto-stash", stashId: "post-run-1" });
  });

  it("never stashes a refused run", async () => {
    const refused = await result("refused");
    await runPostRunIntegrations(
      refused,
      refused.spec.path,
      { stash: true, stashOnFailure: true },
      sinks,
    );
    expect(await saves()).toHaveLength(0);
  });

  it("auto-investigate stashes a failed run through the evidence gate", async () => {
    const project = await mkdtemp(join(tmpdir(), "cairntrace-postrun-inv-"));
    const config = join(project, "cairntrace.config.yml");
    await writeFile(
      config,
      [
        "version: 1",
        "environments:",
        "  local:",
        "    baseUrl: http://127.0.0.1:9",
        "investigate:",
        "  autoInvestigate: on-failure",
        "  codebaseDir: .",
        "",
      ].join("\n"),
    );
    const specPath = join(project, "checkout.yml");
    await writeFile(
      specPath,
      [
        "version: 1",
        "name: checkout",
        "intent: checkout works",
        "environment: local",
        "outcomes:",
        "  - id: ok",
        "    verify:",
        "      url:",
        "        endsWith: /done",
        "steps:",
        "  - open: /",
        "",
      ].join("\n"),
    );
    const failed = await result("failed");
    await mkdir(join(failed.runDir, "traces"), { recursive: true });
    await writeFile(
      join(failed.runDir, "traces", "playwright-trace.zip"),
      "raw trace",
    );
    const warnings: string[] = [];
    await runPostRunIntegrations(
      failed,
      specPath,
      { config },
      { ...sinks, log: { warn: (message) => warnings.push(message) } },
    );
    // One gated save (a staged copy named after the run, traces left out);
    // investigate reuses it instead of saving the whole run directory.
    const all = await saves();
    expect(all).toHaveLength(1);
    expect(all[0]).not.toContain(`save ${failed.runDir} `);
    expect(all[0]).toContain(`--name ${basename(failed.runDir)}`);
    expect(
      JSON.parse(
        await readFile(join(failed.runDir, "stash-receipt.json"), "utf8"),
      ),
    ).toMatchObject({
      action: "auto-stash",
      stashId: "post-run-1",
      excluded: ["traces/"],
    });
  });

  it("says once that a gated archive drops excluded categories with the run", async () => {
    const warnings: string[] = [];
    const archive = makeArchiveRun((message) => warnings.push(message));
    for (const name of ["old-1", "old-2"]) {
      const runDir = await mkdtemp(join(tmpdir(), "cairntrace-archive-gate-"));
      await mkdir(join(runDir, "videos"), { recursive: true });
      await writeFile(join(runDir, "run.json"), "{}");
      await writeFile(join(runDir, "videos", "v.webm"), "webm");
      await expect(archive(runDir, name, ["kept"])).resolves.toMatchObject({
        stashId: "post-run-1",
        excluded: ["videos/"],
      });
    }
    expect(warnings).toEqual([
      expect.stringContaining("the archive of old-1 left out videos/"),
    ]);
  });

  it("a failed retention archive throws a reason code and warns once", async () => {
    const warnings: string[] = [];
    const archive = makeArchiveRun((message) => warnings.push(message));
    const runDir = await mkdtemp(join(tmpdir(), "cairntrace-archive-run-"));
    await mkdir(join(runDir, "videos"), { recursive: true });
    await writeFile(join(runDir, "run.json"), "{}");
    await writeFile(join(runDir, "videos", "v.webm"), "webm");
    const failure = await archive(runDir, "old-run", ["retention-archived"], {
      ttl: "14d",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(EvidenceTransferError);
    expect((failure as EvidenceTransferError).reason).toBe("save-failed");
    expect(warnings).toEqual([
      expect.stringMatching(
        /^retention: archiving old-run failed \(save-failed\)/,
      ),
    ]);
    const [save] = await saves();
    expect(save).toContain("--ttl 14d");
    // Archives never write a receipt into the (about to be pruned) run.
    await expect(
      readFile(join(runDir, "stash-receipt.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
