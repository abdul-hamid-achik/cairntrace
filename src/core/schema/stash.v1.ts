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
 * Post-finalization receipt written only after an automatic file.cheap save
 * produced a durable stash ID. It intentionally excludes source/target paths,
 * tags, stderr, and failure messages: those values are not needed to resolve
 * the stash and can contain local paths or secrets.
 */
export const StashReceiptSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:stash-receipt:v1"),
    version: z.literal("1"),
    stashId: SafeStashIdSchema,
    status: z.enum(["saved", "saved_with_failures"]),
    postSaveFailureCount: z.number().int().nonnegative(),
    recordedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type StashReceipt = z.infer<typeof StashReceiptSchema>;
