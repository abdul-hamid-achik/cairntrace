/**
 * Evidence actions (lib/evidence.js): `cairn publish` / `cairn pin` /
 * `cairn unpin` argv, the publish receipt reader (https-only web URLs), and
 * run.json's `pinned` block.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const evidence = require("../lib/evidence");
const { cleanup, tempDir, write } = require("./helpers");

after(cleanup);

describe("evidence: argv", () => {
  it("publishes, pins and unpins a run by its absolute directory", () => {
    assert.deepEqual(evidence.buildPublishArgv("/tmp/runs/r1"), [
      "publish",
      "/tmp/runs/r1",
      "--json",
    ]);
    assert.deepEqual(evidence.buildPinArgv("/tmp/runs/r1"), [
      "pin",
      "/tmp/runs/r1",
      "--json",
    ]);
    assert.deepEqual(evidence.buildUnpinArgv("/tmp/runs/r1/"), [
      "unpin",
      "/tmp/runs/r1",
      "--json",
    ]);
    for (const bad of ["", "relative/run", "--all", null])
      assert.throws(
        () => evidence.buildPublishArgv(/** @type {any} */ (bad)),
        /absolute/,
      );
  });

  it("joins the pin reason to its flag so it is never read as an option", () => {
    assert.deepEqual(
      evidence.buildPinArgv("/tmp/runs/r1", { reason: "--include-pinned" }),
      ["pin", "/tmp/runs/r1", "--reason=--include-pinned", "--json"],
    );
    assert.deepEqual(
      evidence.buildPinArgv("/tmp/runs/r1", {
        reason: "  evidence for\nbug\t42 \u0007 ",
      }),
      ["pin", "/tmp/runs/r1", "--reason=evidence for bug 42", "--json"],
    );
    assert.deepEqual(evidence.buildPinArgv("/tmp/runs/r1", { reason: "   " }), [
      "pin",
      "/tmp/runs/r1",
      "--json",
    ]);
    assert.throws(
      () =>
        evidence.buildPinArgv("/tmp/runs/r1", {
          reason: "x".repeat(evidence.MAX_PIN_REASON + 1),
        }),
      /longer than/,
    );
    assert.throws(
      () =>
        evidence.buildPinArgv("/tmp/runs/r1", {
          reason: /** @type {any} */ (42),
        }),
      /text/,
    );
  });
});

describe("evidence: web URLs", () => {
  it("opens only https URLs with a host and no credentials", () => {
    assert.equal(
      evidence.safeWebUrl("https://file.cheap/a/abc123"),
      "https://file.cheap/a/abc123",
    );
    // the CLI's receipt rule (isStableHttpsUrl): never a signed URL
    for (const bad of [
      "http://file.cheap/a/abc123",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "https://user:pass@file.cheap/a",
      "fcheap://cloud/vaults/private/artifacts/abc",
      "not a url",
      "",
      null,
      42,
      `https://file.cheap/${"a".repeat(3000)}`,
      "https://file.cheap/a/abc123?sig=secret",
      "https://file.cheap/a/abc123#frag",
      "https://file.cheap/a/abc123?",
      "https://file.cheap/a/abc123#",
    ])
      assert.equal(evidence.safeWebUrl(bad), null, String(bad).slice(0, 40));
  });
});

describe("evidence: retention uploads", () => {
  it("names what cairn clean uploads for every pruned run", () => {
    assert.deepEqual(evidence.retentionUploads(null), {
      archive: false,
      publish: false,
      days: 7,
      any: false,
    });
    assert.equal(
      evidence.retentionUploadText(evidence.retentionUploads({})),
      null,
    );
    const both = evidence.retentionUploads({
      archiveToStash: true,
      publish: { enabled: true, retentionDays: 3 },
    });
    assert.equal(both.any, true);
    assert.match(
      String(evidence.retentionUploadText(both)),
      /archives it to your file\.cheap stash and publishes it to file\.cheap, kept 3 days/,
    );
    assert.match(
      String(
        evidence.retentionUploadText(
          evidence.retentionUploads({ publish: { enabled: true } }),
        ),
      ),
      /publishes it to file\.cheap, kept 7 days \(retention\.publish\.enabled/,
    );
  });
});

describe("evidence: receipts and pins", () => {
  it("reads publish-receipt.json and drops a web URL that is not https", () => {
    const runDir = tempDir("cairn-evidence-");
    assert.equal(evidence.readPublishReceipt(runDir), null);
    write(
      runDir,
      "publish-receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: {
          uri: "fcheap://cloud/vaults/private/artifacts/abc123",
          artifact_id: "abc123",
        },
        sha256: "f".repeat(64),
        sizeBytes: 2048,
        publishedAt: "2026-10-02T10:00:00.000Z",
        expiresAt: "2026-10-09T10:00:00.000Z",
        webUrl: "https://file.cheap/a/abc123",
        excluded: ["traces/", 42],
      }),
    );
    assert.deepEqual(evidence.readPublishReceipt(runDir), {
      ok: true,
      status: "published",
      artifactRef: "fcheap://cloud/vaults/private/artifacts/abc123",
      sha256: "f".repeat(64),
      sizeBytes: 2048,
      publishedAt: "2026-10-02T10:00:00.000Z",
      expiresAt: "2026-10-09T10:00:00.000Z",
      webUrl: "https://file.cheap/a/abc123",
      excluded: ["traces/"],
      runIndexSkipped: null,
    });
    // why the console does not list it; unknown codes are dropped
    write(
      runDir,
      "publish-receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: "ref-1",
        runIndexSkipped: "too-large",
      }),
    );
    assert.equal(
      evidence.readPublishReceipt(runDir)?.runIndexSkipped,
      "too-large",
    );
    write(
      runDir,
      "publish-receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: "ref-1",
        runIndexSkipped: "<script>",
      }),
    );
    assert.equal(evidence.readPublishReceipt(runDir)?.runIndexSkipped, null);
    write(
      runDir,
      "publish-receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: "ref-1",
        webUrl: "http://file.cheap/a/abc123",
      }),
    );
    const plain = evidence.readPublishReceipt(runDir);
    assert.equal(plain?.artifactRef, "ref-1");
    assert.equal(plain?.webUrl, null);
    assert.equal(plain?.expiresAt, null);
    write(runDir, "publish-receipt.json", JSON.stringify({ version: 1 }));
    assert.equal(evidence.readPublishReceipt(runDir), null);
    write(runDir, "publish-receipt.json", "{torn");
    assert.equal(evidence.readPublishReceipt(path.join(runDir)), null);
  });

  it("normalizes run.json pinned blocks", () => {
    assert.deepEqual(
      evidence.normalizePinned({
        at: "2026-10-02T10:00:00.000Z",
        reason: "bug 42",
      }),
      { at: "2026-10-02T10:00:00.000Z", reason: "bug 42" },
    );
    assert.deepEqual(
      evidence.normalizePinned({ at: "2026-10-02T10:00:00.000Z" }),
      {
        at: "2026-10-02T10:00:00.000Z",
        reason: null,
      },
    );
    assert.deepEqual(evidence.normalizePinned(true), {
      at: null,
      reason: null,
    });
    assert.equal(evidence.normalizePinned(undefined), null);
    assert.equal(evidence.normalizePinned(false), null);
    assert.equal(evidence.normalizePinned("yes"), null);
  });

  it("tells the publish dialog the configured remote retention", () => {
    assert.equal(evidence.publishRetentionDays(null), 7);
    assert.equal(
      evidence.publishRetentionDays({ publish: { retentionDays: 14 } }),
      14,
    );
    for (const days of [0, 32, 2.5, "10"])
      assert.equal(
        evidence.publishRetentionDays({ publish: { retentionDays: days } }),
        7,
      );
  });
});
