import { basename } from "node:path";
import { z } from "zod";

/**
 * file.cheap stash IDs are single filesystem components. Keeping that
 * constraint at the receipt boundary prevents a legacy `path` save response
 * from turning a local filesystem path into durable run metadata.
 */
export const SafeStashIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(255)
  .refine(
    (value) =>
      value !== "." &&
      value !== ".." &&
      value === basename(value) &&
      !value.includes("/") &&
      !value.includes("\\") &&
      ![...value].some((character) => {
        const codePoint = character.codePointAt(0);
        return (
          codePoint !== undefined && (codePoint <= 31 || codePoint === 127)
        );
      }),
    "stash id must be a safe single path component",
  );

/**
 * Post-finalization receipt written only after a file.cheap save of the run
 * (auto-stash, `cairn stash save`, `pin --stash`, investigate, `clip
 * --stash`) produced a durable stash ID. It carries the tags, TTL and the
 * gate's `excluded` list, and intentionally excludes source/target paths,
 * stderr, and failure messages: those values are not needed to resolve the
 * stash and can contain local paths or secrets.
 */
export const StashReceiptSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:stash-receipt:v1"),
    version: z.literal("1"),
    stashId: SafeStashIdSchema,
    status: z.enum(["saved", "saved_with_failures"]),
    postSaveFailureCount: z.number().int().nonnegative(),
    recordedAt: z.string().datetime({ offset: true }),
    /**
     * auto-stash (cairn run) or manual (cairn stash save / cairn pin --stash /
     * cairn investigate / cairn audit --connect / cairn clip --stash).
     */
    action: z.enum(["auto-stash", "manual"]).optional(),
    /** file.cheap content hash of the saved copy. */
    contentHash: z.string().min(1).max(200).optional(),
    fileCount: z.number().int().nonnegative().optional(),
    sizeBytes: z.number().int().nonnegative().optional(),
    ttl: z.string().optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    tags: z.array(z.string()).optional(),
    /** Relative paths/dirs the evidence gate left out (`traces/`). */
    excluded: z.array(z.string()).optional(),
    /** Secret-scanner findings file.cheap reported (custom.secrets_found). */
    secretsFound: z.number().int().nonnegative().optional(),
    /** fcheap rejected the run-identity `--meta`; the stash has none. */
    metaDropped: z.literal(true).optional(),
  })
  .strict();

export type StashReceipt = z.infer<typeof StashReceiptSchema>;

/**
 * `publish-receipt.json`: the verified remote copy of a run. Written by
 * `cairn publish` (and MCP `cairn_publish`); it never contains signed URLs,
 * credentials or local paths.
 */
export const PublishReceiptSchema = z
  .object({
    version: z.literal(1),
    artifactRef: z.record(z.string(), z.unknown()),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    sizeBytes: z.number().int().nonnegative(),
    publishedAt: z.string().datetime({ offset: true }),
    /** Server commit time, when the fcheap receipt carries it (0.37+). */
    committedAt: z.string().datetime({ offset: true }).optional(),
    expiresAt: z.string().datetime({ offset: true }).optional(),
    webUrl: z.string().url().optional(),
    /** Relative paths/dirs the evidence gate left out of the package. */
    excluded: z.array(z.string()).optional(),
    /** Why no RunIndexV1 sidecar was sent (absent when it was). */
    runIndexSkipped: z
      .enum(["unsupported", "too-large", "build-failed"])
      .optional(),
  })
  .strict();

export type PublishReceipt = z.infer<typeof PublishReceiptSchema>;
