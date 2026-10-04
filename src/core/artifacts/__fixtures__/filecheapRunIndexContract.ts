import { z } from "zod";

/**
 * Vendored copy of file.cheap's RunIndexV1 console contract, kept as a test
 * fixture so cairntrace's `buildRunIndex` output is validated against the
 * schema the server enforces (a drift would otherwise surface only as a 400
 * at publish time).
 *
 * Source: file.cheap `platform/src/features/runs/index-contract.ts`
 * (`runIndexSchema`), copied 2026-10-04. Re-sync by hand when file.cheap
 * changes that file; only the validation rules are kept (the original also
 * exports the per-part schemas and the inferred type). file.cheap uses zod 4;
 * every rule below behaves identically under this repo's zod 3.
 */

const indexedRunStatusSchema = z.enum([
  "queued",
  "running",
  "passed",
  "failed",
  "errored",
  "cancelled",
  "incomplete",
  "unknown",
]);

const boundedCount = z.number().int().min(0).max(100_000);
const safeIdentifier = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const safeRelativePath = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/u)
  .refine(
    (value) => value.split("/").every((part) => part !== "." && part !== ".."),
    { message: "must be a safe relative path" },
  );

const indexedEvidenceSchema = z
  .object({
    declaredBytes: z
      .number()
      .int()
      .min(0)
      .max(Number.MAX_SAFE_INTEGER)
      .optional(),
    inspectability: z.literal("metadata-only"),
    integrity: z.enum(["verified", "declared", "changed", "unknown"]),
    medium: z.enum([
      "structured-text",
      "text",
      "image",
      "video",
      "archive",
      "binary",
      "unknown",
    ]),
    path: safeRelativePath,
    presence: z.enum([
      "declared",
      "present",
      "empty",
      "missing",
      "partial",
      "unknown",
    ]),
    role: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z][a-z0-9-]*$/u),
    sensitivity: z.enum([
      "metadata-safe",
      "redacted",
      "potentially-sensitive",
      "secret-bearing",
      "unknown",
    ]),
  })
  .strict();

const indexedHealthSchema = z
  .object({
    changed: boundedCount,
    declared: boundedCount,
    empty: boundedCount,
    missing: boundedCount,
    present: boundedCount,
    reasons: z
      .array(
        z.enum([
          "required-member-missing",
          "declared-member-missing",
          "empty-capture",
          "size-mismatch",
          "hash-mismatch",
          "incomplete-run",
          "manifest-unavailable",
          "schema-drift",
        ]),
      )
      .max(16),
    state: z.enum(["ok", "degraded", "incomplete", "unknown"]),
  })
  .strict();

const indexedOutcomeSchema = z
  .object({
    id: safeIdentifier,
    status: z.enum(["passed", "failed", "errored", "skipped", "unknown"]),
  })
  .strict();

const indexedRunSchema = z
  .object({
    backend: z.string().trim().min(1).max(80).optional(),
    durationMs: z
      .number()
      .int()
      .min(0)
      .max(30 * 24 * 60 * 60 * 1_000)
      .optional(),
    endedAt: z.string().datetime().optional(),
    environment: z.string().trim().min(1).max(80).optional(),
    errorKind: safeIdentifier.optional(),
    exitCode: z.number().int().min(-255).max(255).optional(),
    nativeId: safeIdentifier,
    seriesKey: z
      .string()
      .min(16)
      .max(128)
      .regex(/^[A-Za-z0-9_-]+$/u),
    specName: z.string().trim().min(1).max(240).optional(),
    startedAt: z.string().datetime().optional(),
    status: indexedRunStatusSchema,
  })
  .strict()
  .refine(
    (value) =>
      !value.startedAt ||
      !value.endedAt ||
      Date.parse(value.endedAt) >= Date.parse(value.startedAt),
    { message: "endedAt cannot precede startedAt", path: ["endedAt"] },
  );

export const runIndexSchema = z
  .object({
    $schema: z.literal("urn:filecheap.dev:run-index:v1"),
    counts: z
      .object({
        artifacts: boundedCount,
        outcomes: boundedCount,
        steps: boundedCount,
      })
      .strict(),
    detector: z
      .object({
        name: z.enum(["cairntrace-run", "glyphrun-run"]),
        version: z
          .string()
          .min(1)
          .max(32)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/u),
      })
      .strict(),
    evidence: z.array(indexedEvidenceSchema).max(200),
    health: indexedHealthSchema,
    outcomes: z.array(indexedOutcomeSchema).max(100),
    run: indexedRunSchema,
    version: z.literal(1),
  })
  .strict()
  .superRefine((value, context) => {
    const uniquePaths = new Set(value.evidence.map((item) => item.path));
    if (uniquePaths.size !== value.evidence.length) {
      context.addIssue({
        code: "custom",
        message: "evidence paths must be unique",
        path: ["evidence"],
      });
    }
    const uniqueOutcomes = new Set(value.outcomes.map((item) => item.id));
    if (uniqueOutcomes.size !== value.outcomes.length) {
      context.addIssue({
        code: "custom",
        message: "outcome ids must be unique",
        path: ["outcomes"],
      });
    }
    if (
      value.outcomes.length > value.counts.outcomes ||
      value.evidence.length > value.counts.artifacts
    ) {
      context.addIssue({
        code: "custom",
        message: "indexed members cannot exceed declared counts",
        path: ["counts"],
      });
    }
  });
