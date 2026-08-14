import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactWriter } from "./ArtifactWriter";
import { createArtifactRedactor } from "./redaction";

let runDir: string | undefined;

afterEach(async () => {
  if (runDir) await rm(runDir, { recursive: true, force: true });
  runDir = undefined;
});

describe("ArtifactWriter network redaction", () => {
  it("redacts sensitive keys inside JSON postData before NDJSON persistence", async () => {
    runDir = await mkdtemp(join(tmpdir(), "cairntrace-network-redaction-"));
    const writer = new ArtifactWriter(
      runDir,
      createArtifactRedactor(undefined, {}),
    );
    await writer.writeNdjson("network/requests.ndjson", [
      {
        url: "https://example.test/api/answers",
        method: "PATCH",
        timestamp: 1_785_326_400_000,
        postData: JSON.stringify({
          product_name: "cairn.example",
          password: "raw-password",
          code: "public-result-code",
          nested: {
            accessToken: "raw-access-token",
            code_verifier: "raw-code-verifier",
            otp: "123456",
            passcode: "raw-passcode",
            credential: "raw-credential",
            assertion: "raw-assertion",
          },
        }),
      },
    ]);

    const raw = await readFile(
      writer.resolve("network/requests.ndjson"),
      "utf8",
    );
    expect(raw).not.toContain("raw-password");
    expect(raw).not.toContain("raw-access-token");
    expect(raw).not.toContain("raw-code-verifier");
    expect(raw).not.toContain("raw-passcode");
    expect(raw).not.toContain("raw-credential");
    expect(raw).not.toContain("raw-assertion");
    const persisted = JSON.parse(raw);
    expect(persisted.timestamp).toBe(1_785_326_400_000);
    expect(JSON.parse(persisted.postData)).toEqual({
      product_name: "cairn.example",
      password: "[redacted]",
      code: "public-result-code",
      nested: {
        accessToken: "[redacted]",
        code_verifier: "[redacted]",
        otp: "[redacted]",
        passcode: "[redacted]",
        credential: "[redacted]",
        assertion: "[redacted]",
      },
    });
  });
});
