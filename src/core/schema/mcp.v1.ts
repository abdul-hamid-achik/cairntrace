import { z } from "zod";
import { SafeStashIdSchema } from "./stash.v1";

/**
 * Wire schemas for MCP tool results that don't already have a declared v1
 * schema (SPEC §7.1 verification contracts). These are permissive
 * (`.passthrough()`) by design: the interactive discovery + services surfaces
 * evolve, and the point is to validate the contract STRUCTURE and stop blind
 * `as unknown as Record<string, unknown>` casts — not to strip or reject every
 * extra field. The declared v1 contracts (run/heal/explain/docs/spec/verifier)
 * stay strict in their own schema files.
 */

/** A snapshot element is a rich accessible-node object; validate loosely. */
const SnapshotElementSchema = z.record(z.string(), z.unknown());

/** cairn_discover_snapshot returns the captured snapshot + its URL. */
export const DiscoverySnapshotResultSchema = z
  .object({
    snapshot: z.array(SnapshotElementSchema),
    url: z.string(),
  })
  .passthrough();
export type DiscoverySnapshotResult = z.infer<
  typeof DiscoverySnapshotResultSchema
>;

/** cairn_discover_open: a new session + its initial snapshot + inventory. */
export const DiscoveryOpenResultSchema = z
  .object({
    sessionId: z.string(),
    url: z.string(),
    snapshot: z.array(SnapshotElementSchema),
    inventory: z
      .object({
        roles: z.array(z.unknown()).optional(),
        testids: z.array(z.unknown()).optional(),
      })
      .optional(),
  })
  .passthrough();
export type DiscoveryOpenResult = z.infer<typeof DiscoveryOpenResultSchema>;

/**
 * cairn_discover_interact / cairn_discover_navigate share this result shape.
 * `recordedStep` (the spec-compatible step that was recorded) is kept via
 * passthrough rather than modeled in full — it mirrors the StepSchema union.
 */
export const DiscoveryActionResultSchema = z
  .object({
    ok: z.boolean(),
    url: z.string(),
    snapshot: z.array(SnapshotElementSchema),
    error: z.string().optional(),
  })
  .passthrough();
export type DiscoveryActionResult = z.infer<typeof DiscoveryActionResultSchema>;

/** cairn_discover_inventory: role + testid locator entries. */
export const DiscoveryInventoryResultSchema = z
  .object({
    roles: z.array(z.unknown()).optional(),
    testids: z.array(z.unknown()).optional(),
    total: z.number().int().nonnegative().optional(),
    truncated: z.boolean().optional(),
    limit: z.number().int().positive().optional(),
  })
  .passthrough();
export type DiscoveryInventoryResult = z.infer<
  typeof DiscoveryInventoryResultSchema
>;

/** cairn_discover_suggest: the recorded steps + count. */
export const DiscoverySuggestResultSchema = z
  .object({
    steps: z.array(z.unknown()),
    stepCount: z.number().int().nonnegative(),
    skippedFailed: z.number().int().nonnegative(),
  })
  .passthrough();
export type DiscoverySuggestResult = z.infer<
  typeof DiscoverySuggestResultSchema
>;

/** cairn_discover_export: the written spec path + verification result. */
export const DiscoveryExportResultSchema = z
  .object({
    path: z.string(),
    verifyOk: z.boolean(),
    verifyErrors: z.array(z.string()).optional(),
    warnings: z.array(z.string()).optional(),
    stepCount: z.number().int().nonnegative(),
    skippedFailed: z.number().int().nonnegative(),
  })
  .passthrough();
export type DiscoveryExportResult = z.infer<typeof DiscoveryExportResultSchema>;

/** One entry in cairn_discover_list. */
const DiscoverySessionEntrySchema = z
  .object({
    sessionId: z.string(),
    url: z.string(),
    stepCount: z.number().int().nonnegative(),
    lastActivity: z.string(),
  })
  .passthrough();

/** cairn_discover_list: active discovery sessions. */
export const DiscoveryListResultSchema = z
  .object({
    sessions: z.array(DiscoverySessionEntrySchema),
  })
  .passthrough();
export type DiscoveryListResult = z.infer<typeof DiscoveryListResultSchema>;

/** cairn_config_validate: ok/path/errors + an optional services summary. */
export const ConfigValidateResultSchema = z
  .object({
    ok: z.boolean(),
    path: z.string(),
    errors: z.array(z.string()).optional(),
    keys: z.array(z.string()).optional(),
    services: z
      .object({
        docker: z.boolean().optional(),
        seed: z.boolean().optional(),
        tmux: z.boolean().optional(),
        tmuxWindows: z.number().int().nonnegative().optional(),
        teardown: z.number().int().nonnegative().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();
export type ConfigValidateResult = z.infer<typeof ConfigValidateResultSchema>;

/** cairn_services_status: docker + tmux phase statuses (plus a hasServices flag). */
export const ServicesStatusResultSchema = z
  .object({
    docker: z.object({ running: z.boolean() }).passthrough().optional(),
    tmux: z
      .object({
        session: z.string().optional(),
        windows: z
          .array(
            z
              .object({
                name: z.string().optional(),
                healthy: z.boolean().optional(),
              })
              .passthrough(),
          )
          .optional(),
      })
      .passthrough()
      .optional(),
    hasServices: z.boolean().optional(),
  })
  .passthrough();
export type ServicesStatusResult = z.infer<typeof ServicesStatusResultSchema>;

const StashFileEntrySchema = z
  .object({
    path: z.string().min(1),
    size: z.number().int().nonnegative(),
    hash: z.string().min(1).optional(),
  })
  .strict();

/** `cairn_stash_info`: normalized file.cheap v0.30 manifest metadata. */
export const StashInfoResultSchema = z
  .object({
    schemaVersion: z.string().min(1),
    id: SafeStashIdSchema,
    name: z.string().min(1).optional(),
    createdAt: z.string().min(1),
    sourcePath: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    tool: z.string().min(1).optional(),
    tags: z.array(z.string()),
    fileCount: z.number().int().nonnegative(),
    sizeBytes: z.number().int().nonnegative(),
    contentHash: z.string().min(1),
    compression: z.string().min(1).optional(),
    compressedSizeBytes: z.number().int().nonnegative().optional(),
    bundleType: z.string().min(1).optional(),
    expiresAt: z.string().min(1).optional(),
    files: z.array(StashFileEntrySchema).optional(),
    custom: z.record(z.string()).optional(),
  })
  .strict();
export type StashInfoResult = z.infer<typeof StashInfoResultSchema>;

/** `cairn_stash_restore`: normalized file.cheap v0.30 restore receipt. */
export const StashRestoreResultSchema = z
  .object({
    stashId: SafeStashIdSchema,
    restoredTo: z.string().min(1),
    fileCount: z.number().int().nonnegative(),
    verified: z.boolean(),
    mismatches: z.array(z.string()),
    status: z.enum([
      "restored",
      "restored_unverified",
      "restored_with_mismatches",
    ]),
  })
  .strict();
export type StashRestoreResult = z.infer<typeof StashRestoreResultSchema>;

/**
 * Structured operational errors returned by stash MCP tools. The server does
 * not declare this as a success output schema because MCP skips output-schema
 * validation for `isError` results.
 */
export const StashToolErrorSchema = z
  .object({
    code: z.enum([
      "FCHEAP_UNAVAILABLE",
      "FCHEAP_COMMAND_FAILED",
      "FCHEAP_INVALID_RESPONSE",
      "FCHEAP_RESTORE_UNVERIFIED",
    ]),
    command: z.enum(["info", "restore"]),
    message: z.string().min(1),
    hint: z.string().min(1),
    stashId: z.string().min(1).optional(),
    restore: StashRestoreResultSchema.optional(),
  })
  .strict();
export type StashToolError = z.infer<typeof StashToolErrorSchema>;
