import { z } from "zod";
import { ExitCodeSchema, IsoTimestampSchema } from "./shared";

/**
 * `cairn services up` / `down` / `status` contracts (and their MCP tools).
 *
 * `services up` starts the config services (docker → seed → tmux) through the
 * same code path as `cairn run`, leaves them running and writes the owner
 * lock of the config file (one per config, whatever the environment) at
 * `~/.cairntrace/services/<config dir>.<sha256(config path)[0:16]>.lock.json`.
 * While it exists, `cairn run` for the locked environment refuses (exit 4)
 * unless it passes `--reuse-services`, and the config's other environments
 * (which share its compose project and tmux session) refuse;
 * `services down` tears the stack down and removes the lock.
 */

/**
 * The owner lock file `cairn services up` writes (atomically). `configPath`
 * is canonical (symlinks and case resolved) and keys the file. Readers strip
 * unknown keys, so a newer cairn may add fields without bumping `version`.
 */
export const ServicesOwnerLockSchema = z
  .object({
    version: z.literal(1),
    owner: z.literal("services-up"),
    project: z.string().min(1),
    env: z.string().min(1),
    configPath: z.string().min(1),
    startedAt: IsoTimestampSchema,
    /** pid of the `services up` process; informational (it exits after boot). */
    pid: z.number().int().nonnegative(),
    by: z.enum(["cli", "mcp"]),
  })
  .strict();
export type ServicesOwnerLock = z.infer<typeof ServicesOwnerLockSchema>;

/** One services lifecycle event (`services.<phase>.<event>` in events.v1). */
export const ServicesLifecycleEventSchema = z
  .object({
    phase: z.enum(["docker", "seed", "tmux", "teardown", "stash"]),
    event: z.string().min(1),
    message: z.string(),
    timestamp: IsoTimestampSchema,
    data: z.record(z.string(), z.unknown()).optional(),
  })
  .strict();

/** What a lock file says right now (status/up/down outputs). */
export const ServicesLockReportSchema = z
  .object({
    state: z.enum(["absent", "held", "unreadable"]),
    path: z.string().min(1),
    lock: ServicesOwnerLockSchema.optional(),
    /** Seconds since `lock.startedAt` (held locks). */
    ageSeconds: z.number().int().nonnegative().optional(),
    /** Why an unreadable lock could not be parsed. */
    reason: z.string().optional(),
    /**
     * Status only, a lock held for the status environment: true when the
     * services the lock owns are not actually up (tmux session gone,
     * readiness check failing, …). Absent for a lock another environment of
     * the config holds (`lock.env` names it).
     */
    stale: z.boolean().optional(),
    /** The liveness problems behind `stale: true`. */
    problems: z.array(z.string()).optional(),
    /**
     * Phases the liveness look could not check and trusted (a docker
     * command whose compose project `docker compose ps` cannot see).
     */
    unchecked: z.array(z.string()).optional(),
  })
  .strict();
export type ServicesLockReport = z.infer<typeof ServicesLockReportSchema>;

/** `cairn services up --format json` / MCP `cairn_services_up`. */
export const ServicesUpResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:services-up:v1"),
    version: z.literal("1"),
    ok: z.boolean(),
    exitCode: ExitCodeSchema,
    project: z.string().optional(),
    env: z.string().optional(),
    configPath: z.string().optional(),
    lockPath: z.string().optional(),
    /** The lock this command wrote (present when ok). */
    lock: ServicesOwnerLockSchema.optional(),
    /** A lock that already existed and was refreshed by this `up`. */
    replacedLock: ServicesOwnerLockSchema.optional(),
    /** What each configured phase did, derived from the lifecycle events. */
    phases: z
      .object({
        docker: z.enum(["started", "reused"]).optional(),
        seed: z.enum(["ran", "skipped"]).optional(),
        tmux: z.enum(["created", "recreated", "reused"]).optional(),
      })
      .strict(),
    /** Redacted lifecycle events of the boot. */
    events: z.array(ServicesLifecycleEventSchema),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict();
export type ServicesUpResult = z.infer<typeof ServicesUpResultSchema>;

/** One teardown command `services down` ran (command text redacted). */
export const ServicesTeardownStepSchema = z
  .object({
    command: z.string(),
    ok: z.boolean(),
    exitCode: z.number().int().optional(),
    error: z.string().optional(),
  })
  .strict();

/** `cairn services down --format json` / MCP `cairn_services_down`. */
export const ServicesDownResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:services-down:v1"),
    version: z.literal("1"),
    ok: z.boolean(),
    exitCode: ExitCodeSchema,
    project: z.string().optional(),
    env: z.string().optional(),
    configPath: z.string().optional(),
    lockPath: z.string().optional(),
    /** The lock state before `down` ran. */
    lockState: z.enum(["absent", "held", "unreadable"]).optional(),
    /** The lock `down` removed (held locks). */
    removedLock: ServicesOwnerLockSchema.optional(),
    /** Every configured teardown command, in order (no reuse skipping). */
    teardown: z.array(ServicesTeardownStepSchema),
    tmuxSession: z.string().optional(),
    /** True when `down` killed a still-running tmux session itself. */
    tmuxKilled: z.boolean(),
    events: z.array(ServicesLifecycleEventSchema),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict();
export type ServicesDownResult = z.infer<typeof ServicesDownResultSchema>;
