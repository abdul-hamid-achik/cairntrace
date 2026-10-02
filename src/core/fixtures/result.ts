import { z } from "zod";
import {
  FixtureEnsureEventSchema,
  FixtureResetEventSchema,
  FixtureTeardownEventSchema,
  FixtureVerifyEventSchema,
} from "../schema/events.v1";
import {
  FixtureAdapterSchema,
  FixtureEventStatusSchema,
  FixtureScopeSchema,
  FixtureVerbNameSchema,
} from "./schema";

/**
 * Wire schema of `cairn fixtures list|status|ensure|reset|teardown|sweep
 * --format json|yaml` and the MCP `cairn_fixtures_*` tools. Additive only.
 */

export const FIXTURES_RESULT_SCHEMA_ID = "urn:cairntrace.dev:fixtures:v1";

const FixtureEventSchema = z.discriminatedUnion("type", [
  FixtureEnsureEventSchema,
  FixtureResetEventSchema,
  FixtureVerifyEventSchema,
  FixtureTeardownEventSchema,
]);

export const FixtureListRowSchema = z
  .object({
    name: z.string().min(1),
    kind: FixtureAdapterSchema,
    scope: FixtureScopeSchema,
    description: z.string().optional(),
    datasource: z.string().optional(),
    verbs: z.array(FixtureVerbNameSchema),
    needs: z.array(z.string()),
    /** Output keys (`${fixtures.<name>.<key>}`); secret ones are flagged. */
    outputs: z.array(
      z
        .object({ key: z.string().min(1), secret: z.boolean().optional() })
        .strict(),
    ),
    owner: z
      .object({
        exactlyOne: z.boolean().optional(),
        /** Marker field names (values may be templates). */
        marker: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    ttlMs: z.number().int().positive().optional(),
    /** Default parameter names (`with:`). */
    with: z.array(z.string()).optional(),
  })
  .strict();
export type FixtureListRow = z.infer<typeof FixtureListRowSchema>;

export const FixtureStatusRowSchema = z
  .object({
    name: z.string().min(1),
    env: z.string().min(1),
    adapter: FixtureAdapterSchema,
    scope: FixtureScopeSchema,
    /**
     * `live` (ensured, not torn down), `expired` (live past its ttl),
     * `failed` (the last ensure/teardown failed — data may be partial),
     * `torn-down`, `released` (cairn owes no teardown: an adopted record,
     * or nothing recorded to tear it down with), or `never` (no ledger
     * record in this environment). A run-scoped fixture shows its newest
     * live or failed instance.
     */
    state: z.enum([
      "live",
      "expired",
      "failed",
      "torn-down",
      "released",
      "never",
    ]),
    /** Run-scoped: how many instances (runs) are still live or failed. */
    instances: z.number().int().positive().optional(),
    /** The ensure found a record it did not create: never torn down. */
    adopted: z.literal(true).optional(),
    ensuredAt: z.string().optional(),
    expiresAt: z.string().optional(),
    lastVerb: FixtureVerbNameSchema.optional(),
    lastStatus: FixtureEventStatusSchema.optional(),
    lastAt: z.string().optional(),
    lastError: z.string().optional(),
    origin: z.enum(["run", "invocation", "cli", "sweep"]).optional(),
    runId: z.string().optional(),
    outputs: z.record(z.string(), z.unknown()).optional(),
    /** The recorded ensure used another definition or parameters. */
    stale: z.literal(true).optional(),
    /** `--verify`: the verify verb against the recorded outputs. */
    verify: z
      .object({
        ok: z.boolean(),
        skipped: z.literal(true).optional(),
        /** Why it was skipped (a verify script while writes are off). */
        reason: z.string().optional(),
        error: z.string().optional(),
      })
      .strict()
      .optional(),
    /** The fixture is in the ledger but no longer in the config. */
    unknown: z.literal(true).optional(),
  })
  .strict();
export type FixtureStatusRow = z.infer<typeof FixtureStatusRowSchema>;

export const FixtureSweepRowSchema = z
  .object({
    name: z.string().min(1),
    env: z.string().min(1),
    scope: FixtureScopeSchema,
    state: z.enum(["live", "failed"]),
    /** A run-scoped fixture's instance (each run owns one). */
    instance: z.string().optional(),
    ensuredAt: z.string().optional(),
    ageMs: z.number().int().nonnegative().optional(),
    /**
     * `teardown` (would / did run), or why it is left alone:
     * `skipped-adopted` (a record the ensure found, not created) and
     * `skipped-no-outputs` (the teardown needs outputs its failed ensure
     * never recorded; `--apply` releases it from the ledger).
     */
    action: z.enum([
      "teardown",
      "skipped-owner-alive",
      "skipped-no-teardown",
      "skipped-unknown",
      "skipped-young",
      "skipped-seed",
      "skipped-adopted",
      "skipped-no-outputs",
    ]),
    /** With --apply: what the teardown did. */
    result: FixtureEventStatusSchema.optional(),
    error: z.string().optional(),
  })
  .strict();
export type FixtureSweepRow = z.infer<typeof FixtureSweepRowSchema>;

export const FixturesResultSchema = z
  .object({
    $schema: z.literal(FIXTURES_RESULT_SCHEMA_ID),
    version: z.literal("1"),
    action: z.enum(["list", "status", "ensure", "reset", "teardown", "sweep"]),
    ok: z.boolean(),
    /** 0 ok (dry-run included), 1 a verb failed, 2 error, 4 invalid input. */
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]),
    project: z.string().optional(),
    env: z.string().optional(),
    config: z.string().optional(),
    /**
     * Whether mutating verbs write here: `dry-run` on a shared or protected
     * environment without --allow-writes, and always under
     * `policy.mutations: deny`.
     */
    writes: z.enum(["allowed", "dry-run"]).optional(),
    /** Why writes are dry-run. */
    writesReason: z.string().optional(),
    fixtures: z.array(FixtureListRowSchema).optional(),
    status: z.array(FixtureStatusRowSchema).optional(),
    /** The fixture.* events of the verbs that ran (ensure/reset/teardown/sweep). */
    events: z.array(FixtureEventSchema).optional(),
    /** Non-secret outputs after ensure/reset, by fixture. */
    outputs: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
    sweep: z
      .object({
        olderThanMs: z.number().int().nonnegative(),
        applied: z.boolean(),
        candidates: z.array(FixtureSweepRowSchema),
      })
      .strict()
      .optional(),
    ledger: z.string().optional(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict();
export type FixturesResult = z.infer<typeof FixturesResultSchema>;
