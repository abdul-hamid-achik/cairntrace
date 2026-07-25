import { describe, expect, it } from "vitest";
import {
  FcheapContractError,
  parseFcheapConnectOutput,
  parseFcheapInfoOutput,
  parseFcheapListOutput,
  parseFcheapRestoreOutput,
  parseFcheapSaveOutput,
  parseFcheapSearchOutput,
  parseFcheapPublishOutput,
} from "./fcheapContract";

describe("file.cheap v0.31 contract adapter", () => {
  it("accepts only a server-verified private Cairntrace archive receipt", () => {
    const sha256 = "a".repeat(64);
    const result = parseFcheapPublishOutput(
      JSON.stringify({
        version: "filecheap-publish/1",
        sha256,
        size_bytes: 42,
        verification: "server-sha256",
        published_at: "2026-07-24T00:00:00Z",
        artifact_ref: {
          $schema: "urn:filecheap.dev:artifact-ref:v1",
          version: 1,
          provider: "fcheap-cloud",
          uri: "fcheap://cloud/vaults/private/artifacts/art-123",
          artifact_id: "art-123",
          kind: "cairntrace.run",
          producer: {
            tool: "cairntrace",
            version: "2.0.0",
            native_schema: "urn:cairntrace.dev:run:v1",
            native_id: "run-123",
            entrypoint: "run.json",
          },
        },
      }),
    );
    expect(result.sha256).toBe(sha256);
    expect(result.sizeBytes).toBe(42);
    expect(result.verification).toBe("server-sha256");
  });

  it.each([
    {
      label: "non-final verification",
      patch: { verification: "pending" },
    },
    {
      label: "prefixed digest",
      patch: { sha256: `sha256:${"a".repeat(64)}` },
    },
    {
      label: "unknown receipt field",
      patch: { signed_url: "https://storage.example.test/signed?token=secret" },
    },
  ])("rejects $label in a publication receipt", ({ patch }) => {
    expect(() =>
      parseFcheapPublishOutput(
        JSON.stringify({
          version: "filecheap-publish/1",
          sha256: "a".repeat(64),
          size_bytes: 42,
          verification: "server-sha256",
          published_at: "2026-07-24T00:00:00Z",
          artifact_ref: {
            $schema: "urn:filecheap.dev:artifact-ref:v1",
            version: 1,
            provider: "fcheap-cloud",
            uri: "fcheap://cloud/vaults/private/artifacts/art-123",
            artifact_id: "art-123",
            kind: "cairntrace.run",
            producer: {
              tool: "cairntrace",
              version: "2.0.0",
              native_schema: "urn:cairntrace.dev:run:v1",
              native_id: "run-123",
              entrypoint: "run.json",
            },
          },
          ...patch,
        }),
      ),
    ).toThrow(/Invalid fcheap publish JSON/);
  });

  it("rejects a non-private, signed, or mismatched artifact reference", () => {
    const receipt = {
      version: "filecheap-publish/1",
      sha256: "a".repeat(64),
      size_bytes: 42,
      verification: "server-sha256",
      published_at: "2026-07-24T00:00:00Z",
      artifact_ref: {
        $schema: "urn:filecheap.dev:artifact-ref:v1",
        version: 1,
        provider: "fcheap-cloud",
        uri: "fcheap://cloud/vaults/team/artifacts/art-123",
        artifact_id: "art-123",
        kind: "cairntrace.run",
        producer: {
          tool: "cairntrace",
          version: "2.0.0",
          native_schema: "urn:cairntrace.dev:run:v1",
          native_id: "run-123",
          entrypoint: "run.json",
        },
      },
    };
    expect(() => parseFcheapPublishOutput(JSON.stringify(receipt))).toThrow(
      /Invalid fcheap publish JSON/,
    );
    expect(() =>
      parseFcheapPublishOutput(
        JSON.stringify({
          ...receipt,
          artifact_ref: {
            ...receipt.artifact_ref,
            uri: "fcheap://cloud/vaults/private/artifacts/art-123",
            web_url: "https://file.cheap/artifacts/art-123?token=secret",
          },
        }),
      ),
    ).toThrow(/Invalid fcheap publish JSON/);
    expect(() =>
      parseFcheapPublishOutput(
        JSON.stringify({
          ...receipt,
          artifact_ref: {
            ...receipt.artifact_ref,
            uri: "fcheap://cloud/vaults/private/artifacts/art-other",
            artifact_id: "run-123",
            kind: "cairntrace.run",
          },
        }),
      ),
    ).toThrow(/Invalid fcheap publish JSON/);
  });
  describe("save", () => {
    it("prefers the canonical id and normalizes manifest metadata", () => {
      const result = parseFcheapSaveOutput(
        JSON.stringify({
          schema_version: "1.0",
          id: "stash-canonical",
          stashId: "stash-legacy",
          path: "stash-oldest",
          name: "checkout run",
          created_at: "2026-07-24T03:01:59Z",
          source_path: "/tmp/cairn/runs/checkout",
          tool: "cairntrace",
          tags: ["checkout", "failed"],
          file_count: 3,
          total_size: 4096,
          content_hash: "sha256:content",
          compression: "zstd",
          compressed_size: 1024,
          bundle_type: "cairntrace-run",
          expires_at: "2026-08-24T03:01:59Z",
          files: [
            {
              path: "run.json",
              size: 128,
              hash: "sha256:run",
            },
          ],
          custom: {
            source: "specs/checkout.yml",
          },
          status: "saved",
          index_requested: true,
          indexed: true,
          auto_compression_requested: true,
          auto_compressed: true,
          failed: [],
        }),
      );

      expect(result).toMatchObject({
        stashId: "stash-canonical",
        schemaVersion: "1.0",
        status: "saved",
        createdAt: "2026-07-24T03:01:59Z",
        sourcePath: "/tmp/cairn/runs/checkout",
        fileCount: 3,
        sizeBytes: 4096,
        compressedSizeBytes: 1024,
        bundleType: "cairntrace-run",
        indexRequested: true,
        indexed: true,
        autoCompressionRequested: true,
        autoCompressed: true,
        files: [
          {
            path: "run.json",
            size: 128,
            hash: "sha256:run",
          },
        ],
      });
    });

    it.each([
      [{ stashId: "stash-legacy" }, "stash-legacy"],
      [{ path: "stash-oldest" }, "stash-oldest"],
      [{ id: " ", stashId: " stash-fallback " }, "stash-fallback"],
    ])("accepts a legacy identifier fallback from %o", (output, expected) => {
      expect(parseFcheapSaveOutput(JSON.stringify(output)).stashId).toBe(
        expected,
      );
    });

    it("rejects output without a usable identifier", () => {
      expect(() =>
        parseFcheapSaveOutput(
          JSON.stringify({ id: " ", stashId: "", path: "\t" }),
        ),
      ).toThrow(/expected a non-empty id, stashId, or path/);
    });
  });

  describe("list and info", () => {
    it("normalizes list snake_case metadata", () => {
      const result = parseFcheapListOutput(
        JSON.stringify([
          {
            id: "stash-list",
            name: "checkout run",
            tool: "cairntrace",
            tags: ["checkout"],
            file_count: 4,
            total_size: 8192,
            compression: "zstd",
            expires_at: "2026-08-24T03:01:59Z",
            created_at: "2026-07-24T03:01:59Z",
            custom: {
              source: "specs/checkout.yml",
            },
          },
        ]),
      );

      expect(result).toEqual([
        {
          id: "stash-list",
          name: "checkout run",
          tool: "cairntrace",
          tags: ["checkout"],
          fileCount: 4,
          sizeBytes: 8192,
          compression: "zstd",
          expiresAt: "2026-08-24T03:01:59Z",
          createdAt: "2026-07-24T03:01:59Z",
          custom: {
            source: "specs/checkout.yml",
          },
        },
      ]);
    });

    it("normalizes the full info manifest and provenance", () => {
      const result = parseFcheapInfoOutput(
        JSON.stringify({
          schema_version: "1.0",
          id: "stash-info",
          name: "checkout run",
          created_at: "2026-07-24T03:01:59Z",
          source_path: "/tmp/cairn/runs/checkout",
          tool: "cairntrace",
          tags: ["checkout"],
          file_count: 1,
          total_size: 128,
          content_hash: "sha256:content",
          bundle_type: "cairntrace-run",
          files: [
            {
              path: "run.json",
              size: 128,
              hash: "sha256:run",
            },
          ],
          custom: {
            source: "specs/checkout.yml",
          },
        }),
      );

      expect(result).toMatchObject({
        schemaVersion: "1.0",
        id: "stash-info",
        createdAt: "2026-07-24T03:01:59Z",
        sourcePath: "/tmp/cairn/runs/checkout",
        source: "specs/checkout.yml",
        fileCount: 1,
        sizeBytes: 128,
        contentHash: "sha256:content",
        bundleType: "cairntrace-run",
      });
    });

    it("normalizes omitted tags to an empty list for untagged manifests", () => {
      expect(
        parseFcheapInfoOutput(
          JSON.stringify({
            schema_version: "1.0",
            id: "stash-untagged",
            created_at: "2026-07-24T03:01:59Z",
            file_count: 0,
            total_size: 0,
            content_hash: "sha256:empty",
          }),
        ).tags,
      ).toEqual([]);
    });

    it.each([
      [
        parseFcheapListOutput,
        [{ file_count: 0, total_size: 0, created_at: "now" }],
      ],
      [
        parseFcheapInfoOutput,
        {
          schema_version: "1.0",
          created_at: "now",
          tags: [],
          file_count: 0,
          total_size: 0,
          content_hash: "sha256:empty",
        },
      ],
    ])("rejects %s output without an id", (parse, output) => {
      expect(() => parse(JSON.stringify(output))).toThrow(/id/);
    });
  });

  describe("search", () => {
    it("normalizes stash_id and text from search matches", () => {
      expect(
        parseFcheapSearchOutput(
          JSON.stringify([
            {
              stash_id: "stash-search",
              score: 0.91,
              text: "checkout redirect failed",
              file: "outcomes/redirect.md",
              line: 17,
              source: "hybrid",
            },
          ]),
        ),
      ).toEqual([
        {
          stashId: "stash-search",
          snippet: "checkout redirect failed",
          score: 0.91,
          file: "outcomes/redirect.md",
          line: 17,
          source: "hybrid",
        },
      ]);
    });

    it("rejects a search match without stash_id", () => {
      expect(() =>
        parseFcheapSearchOutput(
          JSON.stringify([{ score: 0.9, text: "missing id" }]),
        ),
      ).toThrow(/stash_id/);
    });
  });

  describe("connect", () => {
    it("normalizes the v0.30 connect envelope and match text", () => {
      expect(
        parseFcheapConnectOutput(
          JSON.stringify({
            stash_id: "stash-connect",
            codebase: "/workspace/app",
            query: "checkout redirect failed",
            index_status: "indexed",
            matches: [
              {
                stash_id: "stash-connect",
                score: 0.87,
                text: "handleCheckoutRedirect",
                file: "src/checkout/redirect.ts",
                line: 42,
                source: "hybrid",
              },
            ],
          }),
        ),
      ).toEqual({
        stashId: "stash-connect",
        codebase: "/workspace/app",
        query: "checkout redirect failed",
        indexStatus: "indexed",
        matches: [
          {
            stashId: "stash-connect",
            snippet: "handleCheckoutRedirect",
            score: 0.87,
            file: "src/checkout/redirect.ts",
            line: 42,
            source: "hybrid",
          },
        ],
      });
    });

    it("accepts the legacy bare match array", () => {
      expect(
        parseFcheapConnectOutput(
          JSON.stringify([
            {
              stash_id: "stash-connect",
              score: 0.5,
              text: "legacy match",
              file: "src/legacy.ts",
            },
          ]),
        ).matches,
      ).toEqual([
        {
          stashId: "stash-connect",
          snippet: "legacy match",
          score: 0.5,
          file: "src/legacy.ts",
        },
      ]);
    });

    it("rejects a connect match without a codebase file", () => {
      expect(() =>
        parseFcheapConnectOutput(
          JSON.stringify({
            stash_id: "stash-connect",
            codebase: "/workspace/app",
            query: "checkout redirect failed",
            matches: [
              {
                stash_id: "stash-connect",
                score: 0.87,
                text: "missing file",
              },
            ],
          }),
        ),
      ).toThrow(/Invalid fcheap connect JSON/);
    });
  });

  describe("restore", () => {
    it("normalizes target, status, and verification details", () => {
      expect(
        parseFcheapRestoreOutput(
          JSON.stringify({
            stash_id: "stash-restore",
            target: "/tmp/restored-run",
            file_count: 3,
            verified: true,
            mismatches: [],
            status: "restored",
          }),
        ),
      ).toEqual({
        stashId: "stash-restore",
        restoredTo: "/tmp/restored-run",
        fileCount: 3,
        verified: true,
        mismatches: [],
        status: "restored",
      });
    });

    it.each([
      [
        {
          target: "/tmp/restored-run",
          file_count: 0,
          verified: true,
          mismatches: [],
          status: "restored",
        },
        "stash_id",
      ],
      [
        {
          stash_id: "stash-restore",
          file_count: 0,
          verified: true,
          mismatches: [],
          status: "restored",
        },
        "target",
      ],
    ])("rejects missing required restore data", (output, field) => {
      expect(() => parseFcheapRestoreOutput(JSON.stringify(output))).toThrow(
        new RegExp(field),
      );
    });
  });

  it.each([
    ["save", parseFcheapSaveOutput],
    ["list", parseFcheapListOutput],
    ["info", parseFcheapInfoOutput],
    ["search", parseFcheapSearchOutput],
    ["connect", parseFcheapConnectOutput],
    ["restore", parseFcheapRestoreOutput],
  ] as const)("rejects malformed %s JSON", (command, parse) => {
    expect(() => parse("{not-json")).toThrow(FcheapContractError);
    expect(() => parse("{not-json")).toThrow(
      `Invalid fcheap ${command} JSON: malformed JSON`,
    );
  });
});
