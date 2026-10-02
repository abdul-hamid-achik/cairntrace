import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ArtifactWriter } from "./ArtifactWriter";
import {
  evidenceCategoryOf,
  inferArtifactSensitivity,
  inferUnredactedSensitivity,
  selectRunEvidence,
  stageRunEvidence,
} from "./evidenceSelection";
import {
  checkStoppedTrace,
  sanitizeKeptTrace,
  tracePathForBackend,
} from "./traceCapture";
import { createArtifactRedactor } from "./redaction";

async function runWithEvidence(
  traceSensitivity?: "sanitized" | "secret-bearing",
) {
  const runDir = await mkdtemp(join(tmpdir(), "cairntrace-evidence-"));
  const writer = new ArtifactWriter(runDir, createArtifactRedactor(undefined));
  await writer.writeText("run.json", '{"status":"failed"}\n', "run");
  await writer.writeText("events.ndjson", "{}\n", "event-log");
  await writer.writeText("outcomes/ok.md", "# ok\n", "outcome");
  for (const [path, kind] of [
    ["screenshots/01_open.png", "screenshot"],
    ["traces/playwright-trace.zip", "trace"],
    ["videos/playwright-video.webm", "video"],
    ["downloads/report.xlsx", "download"],
  ] as const) {
    await writeFile(await writer.preparePath(path, kind), `${kind} bytes`);
  }
  if (traceSensitivity) {
    writer.markSensitivity("traces/playwright-trace.zip", traceSensitivity);
  }
  await writer.writeManifest();
  return runDir;
}

describe("evidence gate", () => {
  it("categorizes run files and infers their sensitivity", () => {
    expect(evidenceCategoryOf("traces/agent-browser-trace.json")).toBe(
      "traces",
    );
    expect(evidenceCategoryOf("videos/clips/a.webm")).toBe("videos");
    expect(evidenceCategoryOf("transforms/out.xlsx")).toBe("downloads");
    expect(evidenceCategoryOf("diagnostics/step-01.png")).toBe("screenshots");
    expect(evidenceCategoryOf("network/requests.ndjson")).toBe("text");
    expect(inferArtifactSensitivity("traces/x.zip")).toBe("secret-bearing");
    expect(inferArtifactSensitivity("screenshots/1.png")).toBe("safe");
    expect(inferArtifactSensitivity("run.json")).toBe("redacted");
    expect(inferArtifactSensitivity("monitor/001_profile.profile")).toBe(
      "secret-bearing",
    );
    expect(inferUnredactedSensitivity("diagnostics/report.json")).toBe(
      "secret-bearing",
    );
    expect(inferUnredactedSensitivity("screenshots/1.png")).toBe("safe");
  });

  it("never lets a producer-owned text file leave as redacted", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "cairntrace-evidence-raw-"));
    const writer = new ArtifactWriter(
      runDir,
      createArtifactRedactor(undefined),
    );
    await writer.writeText("run.json", "{}\n", "run");
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.monitor",
      stepId: "s1",
      action: "profile:heap",
      path: "monitor/001_profile.json",
    });
    // `monitor profile --output` writes the CDP heap snapshot itself.
    await mkdir(join(runDir, "monitor"), { recursive: true });
    await writeFile(
      join(runDir, "monitor", "001_profile.profile"),
      '{"strings":["DATABASE_URL=postgres://u:p@db/x"]}',
    );
    writer.registerExisting("monitor/001_profile.profile", "monitor");
    await writer.writeJson("monitor/001_profile.json", { type: "heap" });
    const manifest = await writer.writeManifest();
    const sensitivity = (path: string) =>
      manifest.artifacts.find((a) => a.path === path)?.sensitivity;
    expect(sensitivity("monitor/001_profile.profile")).toBe("secret-bearing");
    expect(sensitivity("monitor/001_profile.json")).toBe("redacted");
    expect(sensitivity("events.ndjson")).toBe("redacted");

    // An `--after` collector writes after the manifest: unlisted text.
    await mkdir(join(runDir, "diagnostics"), { recursive: true });
    await writeFile(join(runDir, "diagnostics", "report.json"), "{}");

    for (const purpose of ["stash", "publish"] as const) {
      const selection = await selectRunEvidence(runDir, { purpose });
      expect(selection.files).toEqual([
        "artifact-manifest.json",
        "events.ndjson",
        "monitor/001_profile.json",
        "run.json",
      ]);
      expect(selection.secretBearing).toEqual([
        "diagnostics/report.json",
        "monitor/001_profile.profile",
      ]);
    }
    const unsafe = await selectRunEvidence(runDir, {
      purpose: "stash",
      unsafeIncludeRawTraces: true,
    });
    expect(unsafe.files).toContain("monitor/001_profile.profile");
  });

  it("keeps path inference for a run whose manifest predates sensitivity", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "cairntrace-evidence-old-"));
    await mkdir(join(runDir, "monitor"), { recursive: true });
    await writeFile(join(runDir, "run.json"), "{}");
    await writeFile(join(runDir, "monitor", "001_profile.profile"), "{}");
    await writeFile(join(runDir, "notes.txt"), "x");
    const selection = await selectRunEvidence(runDir, { purpose: "stash" });
    expect(selection.files).toEqual(["notes.txt", "run.json"]);
    expect(selection.secretBearing).toEqual(["monitor/001_profile.profile"]);
  });

  it("keeps text + screenshots by default and reports excluded dirs", async () => {
    const runDir = await runWithEvidence("sanitized");
    const selection = await selectRunEvidence(runDir, { purpose: "stash" });
    expect(selection.files).toContain("run.json");
    expect(selection.files).toContain("screenshots/01_open.png");
    expect(selection.files).toContain("artifact-manifest.json");
    expect(selection.files.some((f) => f.startsWith("traces/"))).toBe(false);
    expect(selection.excluded).toEqual(["downloads/", "traces/", "videos/"]);
    expect(selection.complete).toBe(false);
  });

  it("stashes a sanitized trace when opted in, never publishes it", async () => {
    const sanitized = await runWithEvidence("sanitized");
    expect(
      (
        await selectRunEvidence(sanitized, {
          purpose: "stash",
          include: ["text", "traces"],
        })
      ).files,
    ).toContain("traces/playwright-trace.zip");
    const publishSanitized = await selectRunEvidence(sanitized, {
      purpose: "publish",
      include: ["text", "traces"],
    });
    expect(publishSanitized.files).not.toContain("traces/playwright-trace.zip");
    expect(publishSanitized.withheld).toEqual(["traces/playwright-trace.zip"]);
    expect(publishSanitized.secretBearing).toEqual([]);

    const raw = await runWithEvidence("secret-bearing");
    const published = await selectRunEvidence(raw, {
      purpose: "publish",
      include: ["text", "traces"],
    });
    expect(published.files).not.toContain("traces/playwright-trace.zip");
    expect(published.secretBearing).toEqual(["traces/playwright-trace.zip"]);
    expect(published.excluded).toContain("traces/");

    // Stash only with the explicit unsafe opt-in; publish never.
    const unsafeStash = await selectRunEvidence(raw, {
      purpose: "stash",
      include: ["text", "traces"],
      unsafeIncludeRawTraces: true,
    });
    expect(unsafeStash.files).toContain("traces/playwright-trace.zip");
    const unsafePublish = await selectRunEvidence(raw, {
      purpose: "publish",
      include: ["text", "traces"],
      unsafeIncludeRawTraces: true,
    });
    expect(unsafePublish.files).not.toContain("traces/playwright-trace.zip");
  });

  it("treats a pre-manifest (legacy) trace as secret-bearing", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "cairntrace-evidence-legacy-"));
    await mkdir(join(runDir, "traces"), { recursive: true });
    await writeFile(join(runDir, "run.json"), "{}");
    await writeFile(join(runDir, "traces", "agent-browser-trace.zip"), "{}");
    const selection = await selectRunEvidence(runDir, {
      purpose: "stash",
      include: ["text", "traces"],
    });
    expect(selection.files).toEqual(["run.json"]);
    expect(selection.secretBearing).toEqual(["traces/agent-browser-trace.zip"]);
  });

  it("stages only the selected files under a directory named after the run", async () => {
    const runDir = await runWithEvidence("sanitized");
    const selection = await selectRunEvidence(runDir, { purpose: "stash" });
    const staged = await stageRunEvidence(runDir, selection, "run-xyz");
    try {
      expect(staged.dir.endsWith("/run-xyz")).toBe(true);
      expect((await readdir(staged.dir)).toSorted()).toEqual([
        "artifact-manifest.json",
        "events.ndjson",
        "outcomes",
        "run.json",
        "screenshots",
      ]);
      expect(await readFile(join(staged.dir, "run.json"), "utf8")).toContain(
        "failed",
      );
    } finally {
      await staged.cleanup();
    }
  });
});

async function writerIn(): Promise<ArtifactWriter> {
  return new ArtifactWriter(
    await mkdtemp(join(tmpdir(), "cairntrace-trace-capture-")),
    createArtifactRedactor(undefined),
  );
}

async function events(
  writer: ArtifactWriter,
): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(writer.runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("trace capture checks", () => {
  it("names agent-browser traces .json and Playwright traces .zip", () => {
    expect(tracePathForBackend("agent-browser")).toEqual({
      path: "traces/agent-browser-trace.json",
      format: "chrome-trace-json",
    });
    expect(tracePathForBackend("playwright").path).toBe(
      "traces/playwright-trace.zip",
    );
  });

  it("drops an empty trace with an artifact.trace error event", async () => {
    const writer = await writerIn();
    const path = await writer.preparePath(
      "traces/agent-browser-trace.json",
      "trace",
    );
    await writeFile(path, "");
    const kept = await checkStoppedTrace({
      writer,
      relativePath: "traces/agent-browser-trace.json",
      format: "chrome-trace-json",
      stopped: { ok: true },
      maxBytes: 1024,
    });
    expect(kept).toBeUndefined();
    expect(await events(writer)).toEqual([
      expect.objectContaining({
        type: "artifact.trace",
        action: "error",
        reason: "empty",
      }),
    ]);
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("drops a trace over traceMaxBytes and reports a failed stop", async () => {
    const writer = await writerIn();
    const path = await writer.preparePath(
      "traces/agent-browser-trace.json",
      "trace",
    );
    await writeFile(path, "x".repeat(2048));
    expect(
      await checkStoppedTrace({
        writer,
        relativePath: "traces/agent-browser-trace.json",
        format: "chrome-trace-json",
        stopped: { ok: true },
        maxBytes: 1024,
      }),
    ).toBeUndefined();
    expect(
      await checkStoppedTrace({
        writer,
        relativePath: "traces/agent-browser-trace.json",
        format: "chrome-trace-json",
        stopped: undefined,
        maxBytes: 1024,
      }),
    ).toBeUndefined();
    expect(await events(writer)).toEqual([
      expect.objectContaining({
        action: "dropped",
        reason: "too-large",
        bytes: 2048,
        maxBytes: 1024,
      }),
      expect.objectContaining({ action: "error", reason: "stop-failed" }),
    ]);
  });

  it("sanitizes a kept trace and marks the manifest", async () => {
    const writer = await writerIn();
    const rel = "traces/agent-browser-trace.json";
    await writeFile(
      await writer.preparePath(rel, "trace"),
      JSON.stringify({
        traceEvents: [{ args: { authorization: "Bearer t" } }],
      }),
    );
    expect(
      await checkStoppedTrace({
        writer,
        relativePath: rel,
        format: "chrome-trace-json",
        stopped: { ok: true },
        maxBytes: 1024 * 1024,
      }),
    ).toBe(rel);
    await sanitizeKeptTrace({
      writer,
      relativePath: rel,
      format: "chrome-trace-json",
      redactor: createArtifactRedactor(undefined),
    });
    const manifest = await writer.writeManifest();
    expect(manifest.artifacts.find((a) => a.path === rel)?.sensitivity).toBe(
      "sanitized",
    );
    expect(await readFile(join(writer.runDir, rel), "utf8")).not.toContain(
      "Bearer t",
    );
    expect(await events(writer)).toEqual([
      expect.objectContaining({
        action: "saved",
        format: "chrome-trace-json",
        sensitivity: "sanitized",
      }),
    ]);
  });

  it("marks a trace it cannot rewrite as secret-bearing", async () => {
    const writer = await writerIn();
    const rel = "traces/playwright-trace.zip";
    await writeFile(
      await writer.preparePath(rel, "trace"),
      "PK\u0003\u0004garbage",
    );
    await sanitizeKeptTrace({
      writer,
      relativePath: rel,
      format: "playwright-zip",
      redactor: createArtifactRedactor(undefined),
    });
    const manifest = await writer.writeManifest();
    expect(manifest.artifacts.find((a) => a.path === rel)?.sensitivity).toBe(
      "secret-bearing",
    );
    expect(await events(writer)).toEqual([
      expect.objectContaining({
        action: "saved",
        reason: "sanitize-failed",
        sensitivity: "secret-bearing",
      }),
    ]);
  });
});
