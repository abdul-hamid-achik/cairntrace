import { z } from "zod";
import { DurationSchema, durationMs } from "../gates/schema";
import { expressionProblem } from "./expression";

/**
 * The config `run:` block (F8, "Taskfile as policy"): what a wrapper script
 * used to do around `cairn run` — one run at a time per config, refuse to
 * start on a bad machine, prove nothing of ours survives, belt cleanup that
 * always runs — declared once and enforced by the run engine, so a bare
 * `cairn run` (CLI or MCP) is as safe as the wrapper was.
 *
 * Every field is optional; a config without `run:` behaves as before.
 * Top-level `run:` applies to every environment; `environments.<n>.run`
 * merges over it key by key (lists replace; `lock: false` turns the lock
 * off for that environment).
 */

/* ----- lock ----- */

export const RUN_LOCK_SCOPES = ["project", "config"] as const;

export const RunLockObjectSchema = z
  .object({
    /**
     * What one lock covers. `config` (default): this config file, whatever
     * the environment. `project`: every config that names the same
     * `project:` (two checkouts of one project exclude each other).
     */
    scope: z.enum(RUN_LOCK_SCOPES).optional(),
    /**
     * Reclaim a lock whose owner process is gone (default true), with a
     * warning. false: a dead owner's lock still refuses until it is removed
     * by hand.
     */
    staleAfterPidDead: z.boolean().optional(),
  })
  .strict();

/** `lock: true` = defaults, `lock: false` = off, or the object form. */
export const RunLockSchema = z.union([z.boolean(), RunLockObjectSchema], {
  errorMap: () => ({
    message:
      "lock: expected true, false or { scope: config | project, staleAfterPidDead? }",
  }),
});

/* ----- preflight ----- */

const checkName = z
  .string()
  .min(1)
  .describe("Label used in the failure message and the journal event")
  .optional();

const stringOrList = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

/**
 * `when` of a preflight check (as on seed post-commands): the check runs
 * only for these suites and/or environments; every key that is set must
 * match (a `suite` condition never matches a run without `--suite`).
 */
export const RunPreflightWhenSchema = z
  .object({
    suite: stringOrList.optional(),
    env: stringOrList.optional(),
  })
  .strict();

/**
 * One preflight check; exactly one of `json`, `secret`, `command`, `gate`.
 * Evaluated after config + secrets resolve and before any service, hook or
 * browser starts; a failure refuses the run (exit 4) naming the check.
 */
export const RunPreflightCheckSchema = z
  .object({
    /** A JSON file (relative to the config directory) asserted with `assert`. */
    json: z.string().min(1).optional(),
    /** The assertion language: paths, == != < <= > >=, in [..], exists, and/or/not. */
    assert: z.string().min(1).optional(),
    /** A secret name that must resolve to a non-empty value. */
    secret: z.string().min(1).optional(),
    /** A shell command run in the config directory with the scoped env. */
    command: z.string().min(1).optional(),
    /** Exit code the command must return (default 0). */
    expectExit: z.number().int().min(0).max(255).optional(),
    /** Command budget (default 60s). */
    timeout: DurationSchema.optional(),
    /** A named config `gates:` entry (looked at once, never waited on). */
    gate: z.string().min(1).optional(),
    name: checkName,
    /** Run the check only for these suites / environments. */
    when: RunPreflightWhenSchema.optional(),
  })
  .strict()
  .superRefine((check, ctx) => {
    const kinds = (["json", "secret", "command", "gate"] as const).filter(
      (key) => check[key] !== undefined,
    );
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          kinds.length === 0
            ? "a preflight check needs exactly one of json, secret, command or gate"
            : `a preflight check takes exactly one of json, secret, command or gate (got ${kinds.join(" + ")})`,
      });
      return;
    }
    const kind = kinds[0]!;
    if (kind === "json" && check.assert === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assert"],
        message: "a json preflight check needs `assert`",
      });
    }
    if (kind !== "json" && check.assert !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["assert"],
        message: "`assert` belongs to a json preflight check",
      });
    }
    if (kind !== "command") {
      for (const key of ["expectExit", "timeout"] as const) {
        if (check[key] !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `\`${key}\` belongs to a command preflight check`,
          });
        }
      }
    }
    if (check.assert !== undefined) {
      const problem = expressionProblem(check.assert);
      if (problem) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["assert"],
          message: `invalid assertion: ${problem}`,
        });
      }
    }
  });
export type RunPreflightCheck = z.infer<typeof RunPreflightCheckSchema>;

/* ----- verifyClean ----- */

export const VERIFY_CLEAN_KINDS = [
  "browsers",
  "tmux",
  "docker-project",
] as const;
export type VerifyCleanKind = (typeof VERIFY_CLEAN_KINDS)[number];

/**
 * `verifyClean` entry: a kind name (`browsers`, `tmux`, `docker-project`; the
 * tmux session and compose project come from `services` when they are not
 * named) or `{ tmux: <session> }` / `{ docker-project: <name> }` /
 * `{ browsers: true }`.
 */
export const VerifyCleanEntrySchema = z.union(
  [
    z.enum(VERIFY_CLEAN_KINDS),
    z
      .object({
        browsers: z.literal(true).optional(),
        tmux: z.string().min(1).optional(),
        "docker-project": z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (entry) =>
          [entry.browsers, entry.tmux, entry["docker-project"]].filter(
            (v) => v !== undefined,
          ).length === 1,
        { message: "name exactly one of browsers, tmux or docker-project" },
      ),
  ],
  {
    errorMap: () => ({
      message:
        "verifyClean entry: expected browsers, tmux, docker-project, { tmux: <session> }, { docker-project: <name> } or { browsers: true }",
    }),
  },
);
export type VerifyCleanEntry = z.infer<typeof VerifyCleanEntrySchema>;

/* ----- finally ----- */

export const RunFinallyEntrySchema = z.union(
  [
    z.string().min(1),
    z
      .object({
        run: z.string().min(1),
        /** Budget of this command (default 60s). */
        timeout: DurationSchema.optional(),
      })
      .strict(),
  ],
  {
    errorMap: () => ({
      message:
        "finally entry: expected a shell command string or { run, timeout? }",
    }),
  },
);
export type RunFinallyEntry = z.infer<typeof RunFinallyEntrySchema>;

/* ----- the block ----- */

export const RunPolicyConfigSchema = z
  .object({
    lock: RunLockSchema.optional(),
    preflight: z.array(RunPreflightCheckSchema).optional(),
    verifyClean: z.array(VerifyCleanEntrySchema).optional(),
    /**
     * Commands run after the services/webServer teardown with
     * CAIRN_EXIT_CODE and CAIRN_INVOCATION_DIR set. Non-fatal: a failure is
     * logged to the journal and never changes the exit code.
     */
    finally: z.array(RunFinallyEntrySchema).optional(),
  })
  .strict();
export type RunPolicyConfig = z.infer<typeof RunPolicyConfigSchema>;

/* ----- services.teardown entries ----- */

/**
 * A `services.teardown` entry: a shell command (best-effort, as ever) or an
 * object. `critical: true` makes a failed or timed-out command fail the run
 * with exit 8, ranked above every verdict (a billable resource that did not
 * stop is worse than a red test). `timeout` bounds the command; `onSignal:
 * wait` makes the SIGINT/SIGTERM path wait for it up to that timeout instead
 * of the short signal cap.
 */
export const TeardownEntrySchema = z.union(
  [
    z.string().min(1),
    z
      .object({
        run: z.string().min(1),
        critical: z.boolean().optional(),
        timeout: DurationSchema.optional(),
        onSignal: z.enum(["wait"]).optional(),
      })
      .strict(),
  ],
  {
    errorMap: () => ({
      message:
        "teardown entry: expected a shell command string or { run, critical?: boolean, timeout?: duration, onSignal?: wait }",
    }),
  },
);
export type TeardownEntry = z.infer<typeof TeardownEntrySchema>;

/** A teardown entry with its policy spelled out. */
export interface NormalizedTeardown {
  run: string;
  critical: boolean;
  timeoutMs: number | undefined;
  onSignal: "wait" | undefined;
}

export function normalizeTeardown(
  entries: readonly TeardownEntry[] | undefined,
): NormalizedTeardown[] {
  return (entries ?? []).map((entry) =>
    typeof entry === "string"
      ? {
          run: entry,
          critical: false,
          timeoutMs: undefined,
          onSignal: undefined,
        }
      : {
          run: entry.run,
          critical: entry.critical === true,
          timeoutMs: durationMs(entry.timeout),
          onSignal: entry.onSignal,
        },
  );
}

/** The shell command of a teardown entry. */
export function teardownCommand(entry: TeardownEntry): string {
  return typeof entry === "string" ? entry : entry.run;
}

/** The effective policy of an environment: its keys over the top-level ones. */
export function mergeRunPolicy(
  base: RunPolicyConfig | undefined,
  override: RunPolicyConfig | undefined,
): RunPolicyConfig | undefined {
  if (!base) return override;
  if (!override) return base;
  return { ...base, ...override };
}
