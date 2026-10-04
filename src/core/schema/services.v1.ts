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
    phase: z.enum([
      "docker",
      "seed",
      "tmux",
      "teardown",
      "stash",
      "restart",
      "tunnel",
      "provisioner",
      "files",
    ]),
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

/**
 * The config `run: { lock }` as `services up | down | restart` met it: `held`
 * (taken for the command's duration, released when it ends), `reclaimed`
 * (taken over from an owner that is gone: `owner`), `nested` (the command
 * was started by the lock's live owner, `CAIRN_RUN_LOCK`, and ran under its
 * lock) or `refused` (a live run holds it, or the lock is stale with
 * `staleAfterPidDead: false` or unreadable: exit 4, nothing touched).
 * Absent when the config declares no run lock.
 */
export const ServicesRunLockSchema = z
  .object({
    path: z.string().min(1),
    scope: z.enum(["project", "config"]),
    state: z.enum(["held", "reclaimed", "nested", "refused"]),
    /** Why a refused lock refused. */
    reason: z.enum(["held", "stale", "unreadable"]).optional(),
    owner: z
      .object({
        pid: z.number().int().positive(),
        startedAt: z.string().min(1),
        ageSeconds: z.number().int().nonnegative(),
        alive: z.boolean(),
        invocationId: z.string().min(1).optional(),
        origin: z.enum(["cli", "mcp"]).optional(),
        env: z.string().min(1).optional(),
        /** What holds it when it is not a run (`services down`, …). */
        command: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
export type ServicesRunLock = z.infer<typeof ServicesRunLockSchema>;

/** One teardown command `services down` ran (command text redacted). */
export const ServicesTeardownStepSchema = z
  .object({
    command: z.string(),
    ok: z.boolean(),
    exitCode: z.number().int().optional(),
    error: z.string().optional(),
    /** A critical entry (or the provisioner's `down`): a failure is exit 8. */
    critical: z.boolean().optional(),
    /** The step is the provisioner's `down`. */
    provisioner: z.boolean().optional(),
    timedOut: z.boolean().optional(),
  })
  .strict();

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
    /** The config's run lock during the boot (absent without `run.lock`). */
    runLock: ServicesRunLockSchema.optional(),
    /** What each configured phase did, derived from the lifecycle events. */
    phases: z
      .object({
        docker: z.enum(["started", "reused"]).optional(),
        seed: z.enum(["ran", "skipped"]).optional(),
        tmux: z.enum(["created", "recreated", "reused"]).optional(),
        /** The provisioner's `up` ran (its `down` runs in `services down`). */
        provisioner: z.literal("up").optional(),
        /** Tunnels that are up (left running, unsupervised). */
        tunnels: z.array(z.string()).optional(),
        /** `services.files` entries that were written. */
        files: z.number().int().positive().optional(),
      })
      .strict(),
    /** Redacted lifecycle events of the boot (a failed boot's too). */
    events: z.array(ServicesLifecycleEventSchema),
    /**
     * A failed boot: the critical teardown entries (the provisioner's `down`
     * included) its failure cleanup could not complete. Present → exit 8.
     */
    teardown: z.array(ServicesTeardownStepSchema).optional(),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict();
export type ServicesUpResult = z.infer<typeof ServicesUpResultSchema>;

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
    /** The config's run lock during the teardown (absent without `run.lock`). */
    runLock: ServicesRunLockSchema.optional(),
    /** Every configured teardown command, in order (no reuse skipping). */
    teardown: z.array(ServicesTeardownStepSchema),
    tmuxSession: z.string().optional(),
    /** True when `down` killed a still-running tmux session itself. */
    tmuxKilled: z.boolean(),
    /** Tunnels a state file named: `stopped`, `gone` (not running) or `skipped` (another process). */
    tunnels: z
      .array(
        z
          .object({
            name: z.string(),
            result: z.enum(["stopped", "gone", "skipped"]),
          })
          .strict(),
      )
      .optional(),
    events: z.array(ServicesLifecycleEventSchema),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict();
export type ServicesDownResult = z.infer<typeof ServicesDownResultSchema>;

/* ----- restart / logs (F10) ----- */

/** One window of `cairn services restart`. */
export const ServicesRestartWindowSchema = z
  .object({
    window: z.string(),
    ok: z.boolean(),
    /** The pane was already at an idle shell: nothing had to be stopped. */
    alreadyStopped: z.boolean(),
    /** Id of the restart marker printed into the pane. */
    generation: z.string().optional(),
    durationMs: z.number().int().nonnegative(),
    error: z.string().optional(),
    /** Not attempted: an earlier window failed. */
    skipped: z.boolean().optional(),
  })
  .strict();

/**
 * `cairn services restart <window...> --json`: Ctrl-C, wait for the pane's
 * process to exit, clear the history, resend the command, wait for `readyOn`
 * of the new generation. Exit 4: refused (session not running, window not
 * owned by the configured session); 2: a window did not restart.
 */
export const ServicesRestartResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:services-restart:v1"),
    version: z.literal("1"),
    ok: z.boolean(),
    exitCode: ExitCodeSchema,
    project: z.string().optional(),
    env: z.string().optional(),
    configPath: z.string().optional(),
    session: z.string().optional(),
    /** The config's run lock during the restart (absent without `run.lock`). */
    runLock: ServicesRunLockSchema.optional(),
    windows: z.array(ServicesRestartWindowSchema),
    events: z.array(ServicesLifecycleEventSchema),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict();
export type ServicesRestartResult = z.infer<typeof ServicesRestartResultSchema>;

/**
 * `cairn services logs <window> --json`: the window's captured text
 * (redacted, wrapped lines joined). Exit 4: unknown window or no session;
 * 1: `--wait` timed out.
 */
export const ServicesLogsResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:services-logs:v1"),
    version: z.literal("1"),
    ok: z.boolean(),
    exitCode: ExitCodeSchema,
    project: z.string().optional(),
    env: z.string().optional(),
    configPath: z.string().optional(),
    session: z.string().optional(),
    window: z.string().optional(),
    /** The last `--lines` lines of the view (oldest first). */
    lines: z.array(z.string()),
    /** Lines in the whole view before `--lines` cut it. */
    totalLines: z.number().int().nonnegative(),
    sinceRestart: z
      .object({
        requested: z.boolean(),
        /** A restart marker was found; false: the whole pane is shown. */
        found: z.boolean(),
        generation: z.string().optional(),
      })
      .strict(),
    wait: z
      .object({
        pattern: z.string(),
        matched: z.boolean(),
        line: z.string().optional(),
        timedOut: z.boolean(),
        elapsedMs: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    durationMs: z.number().int().nonnegative(),
    warnings: z.array(z.string()),
    error: z.string().optional(),
  })
  .strict();
export type ServicesLogsResult = z.infer<typeof ServicesLogsResultSchema>;
