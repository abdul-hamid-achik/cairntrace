import { z } from "zod";
import { AbsolutePathSchema } from "./shared";

/**
 * Wire schema for `cairn run --select-only --json` (and friends): resolve
 * which specs WOULD run without launching a browser. v1 wire contract.
 *
 * Selection can be scoped by:
 * - `--tag <tag>` (repeatable AND): `metadata.tags` must include every tag
 * - `--since-codemap <ref>`: `coversSymbol` intersects codemap blast radius
 *
 * `selected` / `skipped` always cover the full expanded input set when a
 * filter is applied. Exit 0 for `--select-only` in both cases.
 */

export const SelectedSpecSchema = z
  .object({
    name: z.string().min(1),
    path: AbsolutePathSchema,
    /** coversSymbol binding read from the spec, if present. */
    coversSymbol: z.string().min(1).optional(),
    /** Spec `metadata.tags` when present (for display / tooling). */
    tags: z.array(z.string().min(1)).optional(),
  })
  .strict();
export type SelectedSpec = z.infer<typeof SelectedSpecSchema>;

export const SkippedSpecSchema = z
  .object({
    name: z.string().min(1),
    path: AbsolutePathSchema,
    reason: z.string().min(1),
  })
  .strict();
export type SkippedSpec = z.infer<typeof SkippedSpecSchema>;

export const SelectionResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:selection:v1")
      .default("urn:cairntrace.dev:selection:v1"),
    version: z.literal("1"),

    /** The `--since-codemap <ref>` value when selection was blast-radius scoped; absent when --select-only ran without a ref (all expanded specs selected). */
    since: z.string().min(1).optional(),
    /**
     * Tag filter applied (`--tag`, AND semantics). Absent when no tag filter
     * was requested.
     */
    tags: z.array(z.string().min(1)).min(1).optional(),
    /** Codemap availability — false means selection degraded to run-all (codemap absent or no ref given). */
    codemapAvailable: z.boolean(),
    selected: z.array(SelectedSpecSchema),
    skipped: z.array(SkippedSpecSchema),
  })
  .strict();
export type SelectionResult = z.infer<typeof SelectionResultSchema>;
