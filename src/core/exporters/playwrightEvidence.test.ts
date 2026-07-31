import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { Spec } from "../schema/spec.v1";
import {
  exportPlaywright,
  renderNodeVerifierEvidenceRuntime,
} from "./playwrightExporter";

describe("exported node verifier evidence", () => {
  it("emits a runDir and persists exact PATCH evidence without a floor fallback", () => {
    const spec = nodeVerifierSpec({
      redaction: {
        queryParams: ["session"],
        storageKeys: ["privateNote"],
        values: ["literal-secret"],
      },
      steps: [
        {
          request: {
            method: "PATCH",
            url: "/api/answers?session=literal-secret",
            body: { answer: "expected-value", password: "must-not-leak" },
            expectStatus: 200,
            assign: "mutation",
          },
        },
      ],
    });

    const source = exportPlaywright(spec, {
      sourcePath: "/tmp/flows/exact_patch.yml",
      outPath: "/tmp/export/tests/exact_patch.spec.ts",
    }).source;

    expect(source).toContain(`async ({ page }, testInfo) => {`);
    expect(source).toContain(
      `const cairnRunDir = testInfo.outputPath("cairn-run");`,
    );
    expect(source).toContain(
      `cairnNetworkEvidence.recordApiRequest({ url: mutation.url(), method: "PATCH", status: mutation.status(), timestamp: mutationCairnRequestTimestamp, body: { "answer": "expected-value", "password": "must-not-leak" }, contentType: "application/json" });`,
    );
    expect(source).toContain(
      `await cairnNetworkEvidence.persist(cairnRunDir);`,
    );
    expect(source).toContain(`runDir: cairnRunDir,`);
    expect(source).not.toContain("CAIRN_RUN_START_FLOOR_MS");
    expect(source.indexOf("persist(cairnRunDir)")).toBeLessThan(
      source.indexOf("const mod = await import"),
    );
  });

  it("keeps ordinary exact values while recursively scrubbing secrets", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cairn-export-evidence-"));
    const ambientKey = "EXPORT_TEST_CREDENTIAL";
    const shortAmbientKey = "EXPORT_TEST_SHORT_CREDENTIAL";
    const previousAmbient = process.env[ambientKey];
    const previousShortAmbient = process.env[shortAmbientKey];
    process.env[ambientKey] = "ambient-secret";
    process.env[shortAmbientKey] = "q7!";
    try {
      const modulePath = join(directory, "evidence.mjs");
      await writeFile(modulePath, renderNodeVerifierEvidenceRuntime("js"));
      const evidenceModule = (await import(
        `${pathToFileURL(modulePath).href}?t=${Date.now()}`
      )) as {
        createCairnNetworkEvidence(
          page: FakePage,
          redaction?: {
            headers?: string[];
            queryParams?: string[];
            storageKeys?: string[];
            values?: string[];
            responseTimeoutMs?: number;
          },
        ): {
          recordApiRequest(input: {
            url: string;
            method: string;
            status?: number;
            body?: unknown;
          }): void;
          persist(runDir: string): Promise<void>;
        };
      };
      const page = new FakePage();
      const evidence = evidenceModule.createCairnNetworkEvidence(page, {
        headers: ["X-Custom-Auth"],
        queryParams: ["session"],
        storageKeys: ["privateNote"],
        values: ["literal-secret", "q"],
      });
      const request = fakeRequest({
        url: "/api/answers?sess%69on=url-secret&email=literal%2Dsecret&safe=visible",
        method: "PATCH",
        body: JSON.stringify({
          answer: "expected-exact-value",
          password: "body-password",
          code_verifier: "pkce-secret",
          privateNote: "configured-secret",
          ordinaryAmbient: "ambient-secret",
          ordinaryShortAmbient: "q7!",
          ordinaryLiteral: "literal-secret",
          ordinaryShortSecret: "q",
          headerPair: { name: "X-Custom-Auth", value: "header-shape-secret" },
          queryPair: { name: "session", value: "query-shape-secret" },
          storagePair: { name: "privateNote", value: "storage-shape-secret" },
        }),
      });
      page.emit("request", request);
      page.emit("response", {
        request: () => request,
        status: () => 200,
      });
      page.emit("requestfinished", request);
      evidence.recordApiRequest({
        url: "https://example.test/api/answers",
        method: "PATCH",
        status: 204,
        body: { answer: "second-exact-value", otp: "123456" },
      });
      evidence.recordApiRequest({
        url: "http://example.test:99999/api?email=literal%2Dsecret",
        method: "GET",
        status: 200,
      });
      const failedRequest = fakeRequest({
        url: "https://example.test/api/answers",
        method: "PATCH",
        body: JSON.stringify({ answer: "failed-value" }),
      });
      page.emit("request", failedRequest);
      page.emit("response", {
        request: () => failedRequest,
        status: () => 202,
      });

      const runDir = join(directory, "run");
      const persistPromise = evidence.persist(runDir);
      const earlyResult = await Promise.race([
        persistPromise.then(() => "persisted"),
        new Promise<string>((resolve) =>
          setTimeout(() => resolve("waiting-for-terminal-event"), 10),
        ),
      ]);
      expect(earlyResult).toBe("waiting-for-terminal-event");
      page.emit("requestfailed", failedRequest);
      await persistPromise;
      const raw = await readFile(
        join(runDir, "network", "requests.ndjson"),
        "utf8",
      );
      const entries = raw
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(entries).toHaveLength(4);
      expect(entries[0]).toMatchObject({
        method: "PATCH",
        status: 200,
        responseTimestamp: expect.any(Number),
        durationMs: expect.any(Number),
      });
      expect(entries[0]?.timestamp).toEqual(expect.any(Number));
      expect(Number(entries[0]?.responseTimestamp)).toBeGreaterThanOrEqual(
        Number(entries[0]?.timestamp),
      );
      expect(entries[0]?.url).toContain("safe=visible");
      expect(entries[0]?.url).not.toContain("url-secret");
      expect(entries[0]?.url).not.toMatch(/literal(?:-|%2D)secret/i);
      expect(JSON.parse(String(entries[0]?.postData))).toEqual({
        answer: "expected-exact-value",
        password: "[redacted]",
        code_verifier: "[redacted]",
        privateNote: "[redacted]",
        ordinaryAmbient: "[redacted]",
        ordinaryShortAmbient: "[redacted]",
        ordinaryLiteral: "[redacted]",
        ordinaryShortSecret: "[redacted]",
        headerPair: { name: "X-Custom-Auth", value: "[redacted]" },
        queryPair: { name: "session", value: "[redacted]" },
        storagePair: { name: "privateNote", value: "[redacted]" },
      });
      expect(JSON.parse(String(entries[1]?.postData))).toEqual({
        answer: "second-exact-value",
        otp: "[redacted]",
      });
      expect(entries[1]).toMatchObject({
        status: 204,
        responseTimestamp: expect.any(Number),
        durationMs: expect.any(Number),
      });
      expect(entries[2]).toMatchObject({
        url: "[redacted]",
        method: "GET",
        status: 200,
      });
      expect(entries[3]).toMatchObject({
        method: "PATCH",
        status: 202,
        error: "request failed",
        responseTimestamp: expect.any(Number),
        durationMs: expect.any(Number),
      });
      expect(raw).not.toMatch(
        /url-secret|body-password|pkce-secret|configured-secret|ambient-secret|q7!|literal(?:-|%2D)secret|header-shape-secret|query-shape-secret|storage-shape-secret|123456/i,
      );

      const unresolvedPage = new FakePage();
      const unresolved = evidenceModule.createCairnNetworkEvidence(
        unresolvedPage,
        { responseTimeoutMs: 5 },
      );
      unresolvedPage.emit(
        "request",
        fakeRequest({
          url: "https://example.test/api/answers",
          method: "PATCH",
          body: JSON.stringify({ answer: "never-finished" }),
        }),
      );
      await expect(
        unresolved.persist(join(directory, "unresolved")),
      ).rejects.toThrow(
        "Timed out waiting for captured PATCH response evidence.",
      );

      await expect(
        evidence.persist(join(directory, "not-a-directory")),
      ).resolves.toBeUndefined();
      await expect(
        writeFile(join(directory, "blocked"), "file").then(() =>
          evidence.persist(join(directory, "blocked")),
        ),
      ).rejects.toThrow();
    } finally {
      if (previousAmbient === undefined) delete process.env[ambientKey];
      else process.env[ambientKey] = previousAmbient;
      if (previousShortAmbient === undefined)
        delete process.env[shortAmbientKey];
      else process.env[shortAmbientKey] = previousShortAmbient;
      await rm(directory, { recursive: true, force: true });
    }
  });
});

class FakePage {
  private readonly listeners = new Map<string, Array<(value: never) => void>>();

  on(event: string, listener: (value: never) => void): void {
    const listeners = this.listeners.get(event) ?? [];
    listeners.push(listener);
    this.listeners.set(event, listeners);
  }

  emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(value as never);
    }
  }
}

function fakeRequest(input: { url: string; method: string; body: string }) {
  return {
    url: () => input.url,
    method: () => input.method,
    postData: () => input.body,
    headers: () => ({ "content-type": "application/json" }),
  };
}

function nodeVerifierSpec(overrides: Partial<Spec>): Spec {
  return {
    version: 1,
    name: "exact_patch_export",
    intent: "preserve exact mutation evidence for exported node verifiers",
    mode: "normal",
    steps: [],
    outcomes: [
      {
        id: "durable",
        description: "mutation completed durably",
        verify: {
          script: {
            runtime: "node",
            file: "../verifiers/check.ts",
            fixtures: { expectedValue: "expected-value" },
          },
        },
      },
    ],
    ...overrides,
  } as Spec;
}
