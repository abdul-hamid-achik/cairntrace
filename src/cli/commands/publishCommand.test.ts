import { chmod, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ArtifactWriter } from "../../core/artifacts/ArtifactWriter";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { RunEventSchema } from "../../core/schema/events.v1";
import { ArtifactManifestSchema } from "../../core/schema/run.v1";
import { PublishReceiptSchema } from "../../core/schema/stash.v1";
import { isStableHttpsUrl } from "./fcheapContract";
import { publishRunRef } from "./publishCommand";

/**
 * `cairn publish` against a fake fcheap (a bun script): it hashes the exact
 * archive it receives, keeps a copy of the --run-index sidecar, and answers
 * with a server-style receipt. Never the real binary or network.
 */

const RUN_ID = "2026-10-02T11-00-00-000Z_checkout_d4e5f6";
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {
    FCHEAP_BIN: process.env.FCHEAP_BIN,
    FILECHEAP_ARTIFACT_SERVICE_URL: process.env.FILECHEAP_ARTIFACT_SERVICE_URL,
    FILECHEAP_INGEST_TOKEN: process.env.FILECHEAP_INGEST_TOKEN,
  };
  process.env.FILECHEAP_ARTIFACT_SERVICE_URL = "https://artifacts.example.test";
  process.env.FILECHEAP_INGEST_TOKEN = "test-ingest-token";
});
afterEach(() => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

async function fakePublisher(mode: "ok" | "auth-fail" | "server-times") {
  const root = await mkdtemp(join(tmpdir(), "cairntrace-fake-publish-"));
  const log = join(root, "args.log");
  const indexCopy = join(root, "run-index.json");
  const bin = join(root, "fcheap");
  await writeFile(
    bin,
    `#!/usr/bin/env bun
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(log)}, args.join(" ") + "\\n");
const value = (flag) => args[args.indexOf(flag) + 1];
if (args[0] === "publish" && args.includes("--help")) {
  console.log("      --run-index string   Metadata-only RunIndexV1 JSON sidecar");
  process.exit(0);
}
if (args[0] !== "publish") process.exit(2);
${
  mode === "auth-fail"
    ? `console.error("401 Unauthorized: FILECHEAP_INGEST_TOKEN=test-ingest-token rejected");
process.exit(1);`
    : ""
}
if (args.includes("--run-index")) {
  writeFileSync(${JSON.stringify(indexCopy)}, readFileSync(value("--run-index")));
}
const bytes = readFileSync(args[1]);
console.log(JSON.stringify({
  version: "filecheap-publish/1",
  artifact_ref: {
    $schema: "urn:filecheap.dev:artifact-ref:v1",
    version: 1,
    provider: "fcheap-cloud",
    uri: "fcheap://cloud/vaults/private/artifacts/art-42",
    artifact_id: "art-42",
    kind: "cairntrace.run",
    producer: {
      tool: "cairntrace",
      version: value("--producer-version"),
      native_schema: "urn:cairntrace.dev:run:v1",
      native_id: value("--native-id"),
      entrypoint: "run.json",
    },
    web_url: "https://file.cheap/console/artifacts/art-42",
  },
  sha256: createHash("sha256").update(bytes).digest("hex"),
  size_bytes: bytes.length,
  verification: "server-sha256",
  published_at: "2026-10-02T12:00:00Z",
${
  mode === "server-times"
    ? `  committed_at: "2026-10-02T12:00:01.250Z",
  expires_at: "2026-10-04T08:30:00Z",
`
    : ""
}}));
`,
  );
  await chmod(bin, 0o755);
  process.env.FCHEAP_BIN = bin;
  return {
    calls: async () =>
      (await readFile(log, "utf8"))
        .trim()
        .split("\n")
        .filter((line) => !line.includes("--help")),
    index: async () => JSON.parse(await readFile(indexCopy, "utf8")) as unknown,
  };
}

async function runsRootWithRun(): Promise<{ root: string; runDir: string }> {
  const root = await mkdtemp(join(tmpdir(), "cairntrace-publish-cmd-"));
  const runDir = join(root, RUN_ID);
  const writer = new ArtifactWriter(runDir, createArtifactRedactor(undefined));
  await writer.writeText(
    "run.json",
    `${JSON.stringify({ runId: RUN_ID, status: "failed", spec: { name: "checkout" }, outcomes: [], steps: [] })}\n`,
    "run",
  );
  await writer.writeText("events.ndjson", "", "event-log");
  await writeFile(
    await writer.preparePath("traces/playwright-trace.zip", "trace"),
    "raw trace",
  );
  await writeFile(
    await writer.preparePath("screenshots/01.png", "screenshot"),
    "png",
  );
  await writer.writeManifest();
  return { root, runDir };
}

async function runEvents(runDir: string) {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => RunEventSchema.parse(JSON.parse(line)));
}

describe("cairn publish", { timeout: 30_000 }, () => {
  it("publishes the gated run with a run index and records publish-receipt.json", async () => {
    const fake = await fakePublisher("ok");
    const { root, runDir } = await runsRootWithRun();
    const outcome = await publishRunRef("latest", {
      artifactRoot: root,
      retentionDays: 3,
    });
    expect(outcome).toMatchObject({
      status: "published",
      runId: RUN_ID,
      retentionDays: 3,
      runIndex: true,
      excluded: ["traces/"],
      webUrl: "https://file.cheap/console/artifacts/art-42",
      expiresAt: "2026-10-05T12:00:00.000Z",
      receipt: "publish-receipt.json",
    });
    const [call] = await fake.calls();
    expect(call).toContain("--expires-in 72h");
    expect(call).toContain("--run-index ");
    expect(call).toContain(`--native-id ${RUN_ID}`);
    expect(await fake.index()).toMatchObject({
      $schema: "urn:filecheap.dev:run-index:v1",
      run: { nativeId: RUN_ID, status: "failed" },
    });

    const receipt = PublishReceiptSchema.parse(
      JSON.parse(await readFile(join(runDir, "publish-receipt.json"), "utf8")),
    );
    expect(receipt).toMatchObject({
      version: 1,
      sha256: outcome.sha256,
      sizeBytes: outcome.sizeBytes,
      publishedAt: "2026-10-02T12:00:00Z",
      webUrl: "https://file.cheap/console/artifacts/art-42",
      excluded: ["traces/"],
    });
    expect(JSON.stringify(receipt)).not.toContain("test-ingest-token");
    expect(await runEvents(runDir)).toContainEqual(
      expect.objectContaining({
        type: "artifact.publish",
        status: "published",
        receipt: "publish-receipt.json",
      }),
    );
    const manifest = ArtifactManifestSchema.parse(
      JSON.parse(
        await readFile(join(runDir, "artifact-manifest.json"), "utf8"),
      ),
    );
    expect(manifest.artifacts.map((a) => a.path)).toContain(
      "publish-receipt.json",
    );
  });

  it("prefers the server expires_at and records committed_at from a 0.37 receipt", async () => {
    await fakePublisher("server-times");
    const { root, runDir } = await runsRootWithRun();
    const outcome = await publishRunRef("latest", {
      artifactRoot: root,
      retentionDays: 3,
    });
    expect(outcome).toMatchObject({
      status: "published",
      committedAt: "2026-10-02T12:00:01.250Z",
      expiresAt: "2026-10-04T08:30:00Z",
      webUrl: "https://file.cheap/console/artifacts/art-42",
    });
    const receipt = PublishReceiptSchema.parse(
      JSON.parse(await readFile(join(runDir, "publish-receipt.json"), "utf8")),
    );
    expect(receipt).toMatchObject({
      publishedAt: "2026-10-02T12:00:00Z",
      committedAt: "2026-10-02T12:00:01.250Z",
      expiresAt: "2026-10-04T08:30:00Z",
      webUrl: "https://file.cheap/console/artifacts/art-42",
    });
  });

  it("records an auth failure without surfacing publisher stderr", async () => {
    await fakePublisher("auth-fail");
    const { root, runDir } = await runsRootWithRun();
    const outcome = await publishRunRef(RUN_ID, { artifactRoot: root });
    expect(outcome).toMatchObject({ status: "error", reason: "auth" });
    expect(JSON.stringify(outcome)).not.toContain("test-ingest-token");
    const failure = (await runEvents(runDir)).find(
      (event) => event.type === "artifact.publish",
    );
    expect(failure).toMatchObject({ status: "error", reason: "auth" });
    await expect(
      readFile(join(runDir, "publish-receipt.json"), "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("accepts only stable https console links", () => {
    expect(isStableHttpsUrl("https://file.cheap/console/artifacts/a-1")).toBe(
      true,
    );
    expect(isStableHttpsUrl("http://file.cheap/console")).toBe(false);
    expect(isStableHttpsUrl("https://file.cheap/x?sig=abc")).toBe(false);
    expect(isStableHttpsUrl("https://user:pw@file.cheap/x")).toBe(false);
    expect(isStableHttpsUrl("https://file.cheap/x#frag")).toBe(false);
  });
});
