import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactWriter } from "../../core/artifacts/ArtifactWriter";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { RunEventSchema } from "../../core/schema/events.v1";
import { StashReceiptSchema } from "../../core/schema/stash.v1";
import {
  autoStashTtl,
  maybeAutoStash,
  pathFreeMessage,
  shouldAutoStash,
  stashDirectory,
  stashRunDirectory,
} from "./stash";

/**
 * The stash evidence gate end to end against a fake fcheap that records its
 * argv and the files it was asked to save. Never the real binary.
 */

let previousBinary: string | undefined;
beforeEach(() => {
  previousBinary = process.env.FCHEAP_BIN;
});
afterEach(() => {
  if (previousBinary === undefined) delete process.env.FCHEAP_BIN;
  else process.env.FCHEAP_BIN = previousBinary;
});

interface Fake {
  calls(): Promise<string[]>;
  files(): Promise<string[]>;
}

async function useFakeFcheap(
  /**
   * Mimic fcheap's `--meta` validation: `reject-all` refuses any pair,
   * `limit-bytes` refuses a value over 256 bytes (Go's `len(value)`).
   */
  opts: {
    meta?: boolean;
    fail?: boolean;
    metaRule?: "reject-all" | "limit-bytes";
  } = {},
): Promise<Fake> {
  const root = await mkdtemp(join(tmpdir(), "cairntrace-fake-fcheap-"));
  const args = join(root, "args.log");
  const files = join(root, "files.log");
  const bin = join(root, "fcheap");
  await writeFile(
    bin,
    `#!/bin/sh
printf '%s\\n' "$*" >> '${args}'
if [ "$1" = "save" ] && [ "$2" = "--help" ]; then
  ${
    opts.meta
      ? "printf '%s\\n' '      --meta stringArray   Metadata key=value'"
      : ":"
  }
  exit 0
fi
if [ "$1" = "save" ]; then
  ${
    opts.metaRule
      ? `prev=""
  for arg in "$@"; do
    if [ "$prev" = "--meta" ]; then
      if [ "${opts.metaRule}" = "reject-all" ] || [ "$(printf '%s' "\${arg#*=}" | wc -c | tr -d ' ')" -gt 256 ]; then
        echo 'invalid_input: metadata value for "spec" exceeds 256 bytes' >&2
        exit 1
      fi
    fi
    prev="$arg"
  done`
      : ""
  }
  ${
    opts.fail
      ? `echo "save failed: stat /Users/someone/private/run: permission denied" >&2; exit 3`
      : ""
  }
  (cd "$2" && find . -type f | sed 's|^\\./||' | sort) > '${files}'
  printf '%s\\n' '{"id":"stash-gate-1","schema_version":"1.0","status":"saved","content_hash":"sha256:abc123","file_count":5,"total_size":321,"expires_at":"2026-10-09T00:00:00Z","custom":{"secrets_found":"2","secrets_rules":"aws-access-key,generic-api-key"}}'
  exit 0
fi
exit 2
`,
  );
  await chmod(bin, 0o755);
  process.env.FCHEAP_BIN = bin;
  return {
    calls: async () =>
      (await readFile(args, "utf8").catch(() => ""))
        .trim()
        .split("\n")
        .filter((line) => line.startsWith("save ") && !line.includes("--help")),
    files: async () =>
      (await readFile(files, "utf8").catch(() => "")).trim().split("\n"),
  };
}

async function failedRun(specName = "checkout"): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cairntrace-gate-run-"));
  const runDir = join(root, "2026-10-02T10-00-00-000Z_checkout_a1b2c3");
  const writer = new ArtifactWriter(runDir, createArtifactRedactor(undefined));
  await writer.writeText(
    "run.json",
    `${JSON.stringify({
      runId: basename(runDir),
      status: "failed",
      environment: "local",
      backend: "playwright",
      spec: { name: specName },
      labels: { round: "r1" },
    })}\n`,
    "run",
  );
  await writer.writeText(
    "spec.resolved.yml",
    "name: checkout\nstash:\n  tags: [payments]\n",
    "resolved-spec",
  );
  await writer.writeText("events.ndjson", "", "event-log");
  for (const [path, kind] of [
    ["screenshots/01.png", "screenshot"],
    ["traces/playwright-trace.zip", "trace"],
    ["videos/playwright-video.webm", "video"],
  ] as const) {
    await writeFile(await writer.preparePath(path, kind), kind);
  }
  await writer.writeManifest();
  return runDir;
}

async function events(runDir: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const event = JSON.parse(line) as Record<string, unknown>;
      expect(RunEventSchema.safeParse(event).success).toBe(true);
      return event;
    });
}

describe("auto-stash decision", () => {
  it("never stashes a refused run, always with --stash, else per config", () => {
    expect(
      shouldAutoStash("refused", { stash: true, stashOnFailure: true }),
    ).toBe(false);
    expect(shouldAutoStash("passed", { stash: true })).toBe(true);
    expect(shouldAutoStash("passed", { stashOnFailure: true })).toBe(false);
    expect(shouldAutoStash("errored", { stashOnFailure: true })).toBe(true);
    const always = { enabled: true, autoStash: "always" };
    const onFailure = { enabled: true, autoStash: "on-failure" };
    expect(shouldAutoStash("passed", { configStash: always })).toBe(true);
    expect(shouldAutoStash("passed", { configStash: onFailure })).toBe(false);
    expect(shouldAutoStash("failed", { configStash: onFailure })).toBe(true);
    expect(
      shouldAutoStash("failed", {
        configStash: { enabled: false, autoStash: "always" },
      }),
    ).toBe(false);
  });

  it("resolves pass/fail TTLs (passes default to 7d, failures to 90d, failTtl never opts out)", () => {
    expect(autoStashTtl("passed", undefined)).toBe("7d");
    expect(autoStashTtl("failed", undefined)).toBe("90d");
    expect(autoStashTtl("errored", {})).toBe("90d");
    expect(autoStashTtl("failed", { failTtl: "never" })).toBeUndefined();
    expect(
      autoStashTtl("failed", { ttl: "30d", failTtl: "never" }),
    ).toBeUndefined();
    // passes are unaffected by failTtl
    expect(autoStashTtl("passed", { failTtl: "never" })).toBe("7d");
    expect(autoStashTtl("failed", { ttl: "30d" })).toBe("30d");
    expect(autoStashTtl("failed", { ttl: "30d", failTtl: "90d" })).toBe("90d");
    expect(autoStashTtl("passed", { ttl: "30d", passTtl: "2d" })).toBe("2d");
  });

  it("keeps messages path-free", () => {
    expect(
      pathFreeMessage(
        "save failed: stat /Users/someone/private/run: denied\nmore",
      ),
    ).toBe("save failed: stat <path>: denied");
  });
});

describe("gated auto-stash", () => {
  it("stashes a staged copy without traces/videos, with tags, TTL, meta and a full receipt", async () => {
    const fake = await useFakeFcheap({ meta: true });
    const runDir = await failedRun();
    const runId = basename(runDir);
    const narrated: string[] = [];
    const result = await maybeAutoStash(runDir, runId, "checkout", {
      status: "failed",
      configStash: {
        enabled: true,
        autoStash: "on-failure",
        tags: ["team-a"],
        failTtl: "30d",
        labelsAsTags: true,
      },
      narrate: (message) => narrated.push(message),
    });
    expect(result).toMatchObject({
      ok: true,
      stashId: "stash-gate-1",
      excluded: ["traces/", "videos/"],
      secretsFound: 2,
    });

    const [call] = await fake.calls();
    expect(call).toContain(
      "--tag checkout --tag team-a --tag payments --tag round=r1",
    );
    expect(call).toContain("--ttl 30d");
    expect(call).toContain(`--name ${runId}`);
    expect(call).toContain(`--source ${runDir}`);
    expect(call).toContain(`--meta run_id=${runId}`);
    expect(call).toContain("--meta status=failed");
    expect(call).toContain("--meta spec=checkout");
    expect(call).toContain("--meta env=local");
    expect(call).toContain("--meta backend=playwright");
    expect(call).toMatch(/--meta cairn_version=\S+/);
    // The saved directory is a staged copy named after the run.
    expect(call!.split(" ")[1]).not.toBe(runDir);
    expect(basename(call!.split(" ")[1]!)).toBe(runId);
    expect(await fake.files()).toEqual([
      "artifact-manifest.json",
      "events.ndjson",
      "run.json",
      "screenshots/01.png",
      "spec.resolved.yml",
    ]);

    const receipt = StashReceiptSchema.parse(
      JSON.parse(await readFile(join(runDir, "stash-receipt.json"), "utf8")),
    );
    expect(receipt).toMatchObject({
      action: "auto-stash",
      stashId: "stash-gate-1",
      contentHash: "sha256:abc123",
      fileCount: 5,
      sizeBytes: 321,
      ttl: "30d",
      expiresAt: "2026-10-09T00:00:00Z",
      excluded: ["traces/", "videos/"],
      secretsFound: 2,
      tags: ["checkout", "team-a", "payments", "round=r1"],
    });
    expect(await events(runDir)).toContainEqual(
      expect.objectContaining({
        type: "artifact.stash",
        action: "auto-stash",
        status: "saved",
        excluded: ["traces/", "videos/"],
        secretsFound: 2,
        ttl: "30d",
      }),
    );
    expect(narrated.join("\n")).toContain("secret scan flagged 2");
    expect(narrated.join("\n")).toContain("aws-access-key");
  });

  it("stashes a passed run with autoStash: always (7d default TTL), not with on-failure", async () => {
    const fake = await useFakeFcheap();
    const runDir = await failedRun();
    await maybeAutoStash(runDir, basename(runDir), "checkout", {
      status: "passed",
      configStash: { enabled: true, autoStash: "on-failure" },
    });
    expect(await fake.calls()).toHaveLength(0);
    await maybeAutoStash(runDir, basename(runDir), "checkout", {
      status: "passed",
      configStash: { enabled: true, autoStash: "always" },
    });
    const calls = await fake.calls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain("--ttl 7d");
    expect(calls[0]).not.toContain("--meta");
  });

  it("never stashes a refused run, even with --stash", async () => {
    const fake = await useFakeFcheap();
    const runDir = await failedRun();
    const result = await maybeAutoStash(runDir, basename(runDir), "checkout", {
      status: "refused",
      stash: true,
      configStash: { enabled: true, autoStash: "always" },
    });
    expect(result).toBeUndefined();
    expect(await fake.calls()).toHaveLength(0);
  });

  it("gives a failed run a 90d TTL unless failTtl is never", async () => {
    const fake = await useFakeFcheap({ meta: true });
    const runDir = await failedRun();
    await maybeAutoStash(runDir, basename(runDir), "checkout", {
      status: "failed",
      configStash: { enabled: true, autoStash: "on-failure" },
    });
    const optOutDir = await failedRun();
    await maybeAutoStash(optOutDir, basename(optOutDir), "checkout", {
      status: "failed",
      configStash: {
        enabled: true,
        autoStash: "on-failure",
        failTtl: "never",
      },
    });
    const [defaulted, optedOut] = await fake.calls();
    expect(defaulted).toContain("--ttl 90d");
    expect(optedOut).not.toContain("--ttl");
  });

  it("records a failed save as an artifact.stash error event with a reason code", async () => {
    await useFakeFcheap({ fail: true });
    const runDir = await failedRun();
    const result = await maybeAutoStash(runDir, basename(runDir), "checkout", {
      stashOnFailure: true,
      narrate: () => undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: "save-failed" });
    const errorEvent = (await events(runDir)).find(
      (event) => event.type === "artifact.stash",
    );
    expect(errorEvent).toMatchObject({
      action: "auto-stash",
      status: "error",
      reason: "save-failed",
      excluded: ["traces/", "videos/"],
    });
    expect(String(errorEvent?.message)).not.toContain("/Users/");
    await expect(
      readFile(join(runDir, "stash-receipt.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a missing fcheap as fcheap-missing", async () => {
    process.env.FCHEAP_BIN = join(tmpdir(), "cairntrace-no-such-fcheap-bin");
    const runDir = await failedRun();
    const result = await maybeAutoStash(runDir, basename(runDir), "checkout", {
      stashOnFailure: true,
      narrate: () => undefined,
    });
    expect(result).toMatchObject({ ok: false, reason: "fcheap-missing" });
    expect(await events(runDir)).toContainEqual(
      expect.objectContaining({ status: "error", reason: "fcheap-missing" }),
    );
  });

  it("byte-truncates a multi-byte spec name so fcheap accepts the --meta value", async () => {
    const fake = await useFakeFcheap({ meta: true, metaRule: "limit-bytes" });
    const spec = "検".repeat(150); // 450 bytes, 150 UTF-16 units
    const runDir = await failedRun(spec);
    const result = await stashRunDirectory(runDir, {
      action: "manual",
      tags: [],
      meta: true,
    });
    expect(result).toMatchObject({ ok: true, stashId: "stash-gate-1" });
    expect(result.metaDropped).toBeUndefined();
    const calls = await fake.calls();
    expect(calls).toHaveLength(1);
    const value = / --meta spec=(\S+)/.exec(calls[0]!)![1]!;
    expect(Buffer.byteLength(value)).toBe(255);
    expect(spec.startsWith(value)).toBe(true);
    expect(await events(runDir)).toContainEqual(
      expect.not.objectContaining({ metaDropped: true }),
    );
  });

  it("retries once without --meta when fcheap refuses it, and records that", async () => {
    const fake = await useFakeFcheap({ meta: true, metaRule: "reject-all" });
    const runDir = await failedRun();
    const result = await stashRunDirectory(runDir, {
      action: "manual",
      tags: ["keep"],
      meta: true,
    });
    expect(result).toMatchObject({
      ok: true,
      stashId: "stash-gate-1",
      metaDropped: true,
    });
    expect(result.warning).toMatch(/run metadata was not saved/);
    expect(result.warning).toContain("exceeds 256 bytes");
    const calls = await fake.calls();
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("--meta ");
    expect(calls[1]).not.toContain("--meta");
    expect(calls[1]).toContain("--tag keep");
    const receipt = StashReceiptSchema.parse(
      JSON.parse(await readFile(join(runDir, "stash-receipt.json"), "utf8")),
    );
    expect(receipt.metaDropped).toBe(true);
    expect(await events(runDir)).toContainEqual(
      expect.objectContaining({
        type: "artifact.stash",
        status: "saved",
        metaDropped: true,
      }),
    );
  });

  it("does not retry a save that fails for another reason", async () => {
    const fake = await useFakeFcheap({ meta: true, fail: true });
    const runDir = await failedRun();
    const result = await stashRunDirectory(runDir, {
      action: "manual",
      tags: [],
      meta: true,
    });
    expect(result).toMatchObject({ ok: false, reason: "save-failed" });
    expect(result.metaDropped).toBeUndefined();
    expect(await fake.calls()).toHaveLength(1);
  });

  it("writes a manual receipt for stash save and saves in place when nothing is excluded", async () => {
    const fake = await useFakeFcheap();
    const runDir = await failedRun();
    const saved = await stashRunDirectory(runDir, {
      action: "manual",
      tags: ["keep"],
      include: ["text", "screenshots", "videos"],
      unsafeIncludeRawTraces: true,
    });
    // traces are secret-bearing (never sanitized here) — kept only because
    // of the explicit unsafe opt-in; videos opted in → nothing excluded…
    expect(saved.excluded).toEqual(["traces/"]);
    const all = await stashRunDirectory(runDir, {
      action: "manual",
      tags: ["keep"],
      include: ["text", "screenshots", "videos", "traces"],
      unsafeIncludeRawTraces: true,
    });
    expect(all.excluded).toEqual([]);
    const calls = await fake.calls();
    // …so the second save is the run directory itself.
    expect(calls.at(-1)!.split(" ")[1]).toBe(runDir);
    expect(calls.at(-1)).not.toContain("--ttl");
    const receipt = JSON.parse(
      await readFile(join(runDir, "stash-receipt.json"), "utf8"),
    );
    expect(receipt).toMatchObject({
      action: "manual",
      tags: ["keep"],
      excluded: [],
    });
  });

  it("gates a run directory handed to the plain stashDirectory helper", async () => {
    // investigate, clip --stash and MCP cairn_clip still call stashDirectory
    // with a run directory: it must not ship traces/videos by default.
    const fake = await useFakeFcheap();
    const runDir = await failedRun();
    const saved = await stashDirectory(runDir, {
      tool: "cairntrace",
      tags: ["vidtrace-clip"],
    });
    expect(saved).toMatchObject({
      ok: true,
      excluded: ["traces/", "videos/"],
    });
    const [call] = await fake.calls();
    expect(call!.split(" ")[1]).not.toBe(runDir);
    expect(call).toContain(`--name ${basename(runDir)}`);
    expect(await fake.files()).not.toContain("traces/playwright-trace.zip");
    expect(await fake.files()).toContain("screenshots/01.png");

    // A directory that is not a run (a clips folder) is saved as it is.
    const clips = await mkdtemp(join(tmpdir(), "cairntrace-clips-"));
    await writeFile(join(clips, "a.webm"), "clip");
    const plain = await stashDirectory(clips, { tags: ["clip"] });
    expect(plain.excluded).toBeUndefined();
    expect((await fake.calls()).at(-1)!.split(" ")[1]).toBe(clips);
  });
});
