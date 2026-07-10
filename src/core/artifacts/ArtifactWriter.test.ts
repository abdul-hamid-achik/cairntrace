import { createHash } from "node:crypto";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ArtifactManifestSchema } from "../schema/run.v1";
import { ArtifactWriter } from "./ArtifactWriter";
import { createArtifactRedactor } from "./redaction";

async function tempWriter(
  redactor = createArtifactRedactor(undefined, {}),
): Promise<ArtifactWriter> {
  const runDir = await mkdtemp(join(tmpdir(), "cairntrace-artifacts-"));
  return new ArtifactWriter(runDir, redactor);
}

describe("ArtifactWriter", () => {
  it("confines every artifact path to runDir", async () => {
    const writer = await tempWriter();

    expect(() => writer.resolve("../escape.txt")).toThrow(/within runDir/);
    expect(() => writer.resolve("nested/../../escape.txt")).toThrow(
      /within runDir/,
    );
    expect(() => writer.resolve("/tmp/escape.txt")).toThrow(/within runDir/);
    expect(() => writer.resolve("C:\\temp\\escape.txt")).toThrow(
      /within runDir/,
    );
    await expect(writer.writeText("../escape.txt", "nope")).rejects.toThrow(
      /within runDir/,
    );
  });

  it("redacts JSON, text, and append-only events", async () => {
    const writer = await tempWriter(
      createArtifactRedactor({ values: ["secret-value"] }, {}),
    );

    await writer.writeJson("diagnostics/value.json", {
      token: "secret-value",
    });
    await writer.writeText("diagnostics/value.txt", "secret-value\n");
    await writer.appendEvent({
      ts: "2026-01-01T00:00:00.000Z",
      type: "step.started",
      detail: "secret-value",
    });

    expect(
      await readFile(writer.resolve("diagnostics/value.json"), "utf8"),
    ).toContain("[redacted]");
    expect(
      await readFile(writer.resolve("diagnostics/value.txt"), "utf8"),
    ).toBe("[redacted]\n");
    expect(await readFile(writer.resolve("events.ndjson"), "utf8")).toContain(
      "[redacted]",
    );
  });

  it("serializes concurrent append-only event writes", async () => {
    const writer = await tempWriter();
    await Promise.all(
      Array.from({ length: 100 }, (_, sequence) =>
        writer.appendEvent({
          ts: "2026-01-01T00:00:00.000Z",
          type: "step.started",
          sequence,
        }),
      ),
    );

    const events = (await readFile(writer.resolve("events.ndjson"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { sequence: number });
    expect(events.map((event) => event.sequence)).toEqual(
      Array.from({ length: 100 }, (_, sequence) => sequence),
    );
  });

  it("writes a deterministic sorted manifest with exact sizes and checksums", async () => {
    const writer = await tempWriter();
    await writer.writeText("z-last.txt", "last", "text");
    await writer.writeBinary(
      "nested/a-first.bin",
      new Uint8Array([0, 1, 2]),
      "binary",
    );

    const first = await writer.writeManifest();
    const firstBytes = await readFile(
      writer.resolve("artifact-manifest.json"),
      "utf8",
    );
    const second = await writer.writeManifest();
    const secondBytes = await readFile(
      writer.resolve("artifact-manifest.json"),
      "utf8",
    );

    expect(ArtifactManifestSchema.parse(first)).toEqual(second);
    expect(firstBytes).toBe(secondBytes);
    expect(first.artifacts.map((entry) => entry.path)).toEqual([
      "nested/a-first.bin",
      "z-last.txt",
    ]);
    expect(first.artifacts[0]).toEqual({
      path: "nested/a-first.bin",
      kind: "binary",
      bytes: 3,
      sha256: createHash("sha256")
        .update(new Uint8Array([0, 1, 2]))
        .digest("hex"),
    });
  });

  it("streams large ingestion through a byte bound and removes partial overflow", async () => {
    const writer = await tempWriter();
    const chunk = Buffer.alloc(64 * 1024, 0x61);
    const chunks = 128;
    let yielded = 0;
    const source = Readable.from(
      (async function* () {
        for (let index = 0; index < chunks; index++) {
          yielded += 1;
          yield chunk;
        }
      })(),
    );

    const copied = await writer.copyStream("downloads/large.zip", source, {
      maxBytes: chunk.byteLength * chunks,
      kind: "archive",
    });
    expect(copied.bytes).toBe(8 * 1024 * 1024);
    expect(yielded).toBe(chunks);
    expect((await stat(copied.path)).size).toBe(copied.bytes);

    await expect(
      writer.copyStream(
        "downloads/too-large.zip",
        Readable.from([Buffer.alloc(32), Buffer.alloc(32)]),
        { maxBytes: 40, kind: "archive" },
      ),
    ).rejects.toThrow(/exceeds maxBytes/);
    await expect(
      stat(writer.resolve("downloads/too-large.zip")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
