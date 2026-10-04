import { z } from "zod";

/**
 * `cairn doctor --orphans --json`: cairn-owned browser sessions whose
 * invocation is gone but whose processes survive (found through the owned
 * browser-session ledger — never by pattern-matching the process table).
 */
export const OrphanProcessSchema = z
  .object({
    pid: z.number().int().positive(),
    /** The command line, redacted and truncated. */
    command: z.string(),
  })
  .strict();

export const OrphanSessionResultSchema = z
  .object({
    session: z.string().min(1),
    backend: z.enum(["agent-browser", "playwright"]),
    invocationId: z.string().min(1),
    /** The cairn process that owned the session (gone). */
    ownerPid: z.number().int().positive(),
    startedAt: z.string().min(1),
    projectDir: z.string().min(1).optional(),
    processes: z.array(OrphanProcessSchema),
    /** `--kill` ended every process of the session. Present only with `--kill`. */
    killed: z.boolean().optional(),
  })
  .strict();

export const OrphansResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:doctor-orphans:v1"),
    version: z.literal("1"),
    /** No orphan remains (none found, or `--kill` ended them all). */
    ok: z.boolean(),
    /** 0 clean, 1 orphans listed (or some survived `--kill`), 2 error or a refused `--kill`. */
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2)]),
    orphans: z.array(OrphanSessionResultSchema),
    /** Ledger entries whose owner is gone and whose processes are gone too (removed). */
    staleEntriesRemoved: z.number().int().nonnegative(),
    /** Ledger entries whose invocation is still running (never touched). */
    liveSessions: z.number().int().nonnegative(),
    killRequested: z.boolean(),
    /** Processes ended by `--kill`. */
    killed: z.number().int().nonnegative(),
    /** Pids still alive after `--kill`. */
    remaining: z.array(z.number().int().positive()),
    error: z.string().optional(),
  })
  .strict();
export type OrphansResult = z.infer<typeof OrphansResultSchema>;
