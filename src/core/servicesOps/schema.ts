import { z } from "zod";
import { DurationSchema, GateRefListSchema } from "../gates/schema";
import { rangeProblem } from "../semverRange";

/**
 * Service operations (F10 rest), seed transaction (F12) and engine pin (F19)
 * schema pieces. Every field is optional and additive: a config that uses
 * none of them validates and runs exactly as before.
 */

const NAME_RE = /^[A-Za-z][A-Za-z0-9_.-]*$/;
const nameField = z
  .string()
  .min(1)
  .max(100)
  .regex(NAME_RE, "use letters, digits, `.`, `_` or `-` (start with a letter)");

/* ----- restart policy + supervision ----- */

/**
 * Pause before a restart: a fixed duration, or `{ initial, max?, factor? }`
 * (exponential: `initial`, then ×`factor` each failed restart, capped at
 * `max`). Defaults: initial 1s, factor 2, max 30s.
 */
export const BackoffSchema = z.union([
  DurationSchema,
  z
    .object({
      initial: DurationSchema,
      max: DurationSchema.optional(),
      factor: z.number().min(1).max(10).optional(),
    })
    .strict(),
]);
export type Backoff = z.infer<typeof BackoffSchema>;

/**
 * What cairn does when a tmux window's process exits while a run is active:
 * `on-exit` restarts it (after `backoff`, at most `max` times in a row),
 * `never` (the default) leaves it. Supervision belongs to a live `cairn run`;
 * `cairn services up` starts the stack and exits, so nothing supervises it.
 */
export const WindowRestartSchema = z
  .object({
    policy: z.enum(["on-exit", "never"]),
    backoff: BackoffSchema.optional(),
    /** Restarts in a row before cairn gives up on the window (default 5). */
    max: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/* ----- tunnels ----- */

/**
 * A supervised helper process (an SSH or cloud tunnel) that outlives no
 * run: started in its own process group, pid and state under
 * `~/.cairntrace/services`, stopped on every exit path (normal end, failed
 * boot, SIGINT/SIGTERM, `cairn services down`).
 */
export const TunnelSchema = z
  .object({
    name: nameField,
    command: z.string().min(1),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    /**
     * `always`: while a run is active, a tunnel that exits is started again
     * (after `backoff`) until `giveUpAfter` consecutive failures. `never`
     * (default): an exit is reported and left.
     */
    restart: z.enum(["always", "never"]).optional(),
    /** Consecutive failed restarts before cairn gives up (default 5). */
    giveUpAfter: z.number().int().min(1).max(100).optional(),
    backoff: BackoffSchema.optional(),
    /** Gate(s) that must pass before the next phase starts (a port, a URL). */
    ready: GateRefListSchema.optional(),
    /** Budget of the `ready` wait when a gate sets no timeout (default 60s). */
    readyTimeout: DurationSchema.optional(),
  })
  .strict();
export type TunnelConfig = z.infer<typeof TunnelSchema>;

/* ----- provisioner ----- */

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;
/** Names an export may not set: they change how every later process loads code. */
export function reservedExportName(name: string): boolean {
  return (
    name === "PATH" ||
    name === "HOME" ||
    name === "SHELL" ||
    name === "NODE_OPTIONS" ||
    name.startsWith("LD_") ||
    name.startsWith("DYLD_")
  );
}

const commandWithTimeout = z.union([
  z.string().min(1),
  z
    .object({
      run: z.string().min(1),
      timeout: DurationSchema.optional(),
    })
    .strict(),
]);

/**
 * `down` of a provisioner: the teardown-entry shape, with the critical
 * defaults a billable resource needs (`critical: true`, `onSignal: wait`).
 */
export const ProvisionerDownSchema = z.union(
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
        "provisioner.down: expected a shell command string or { run, critical?: boolean, timeout?: duration, onSignal?: wait }",
    }),
  },
);

/**
 * A resource cairn creates for the run (a cloud machine, a database, a sandbox)
 * and must always destroy. `up` runs before every other phase; `exports`
 * (`NAME: <command printing one value>`) become env vars of every later
 * phase, hook, spec and verifier. `down` is mandatory and runs on every
 * exit path, a failed boot and SIGINT/SIGTERM included; a failed `down` is
 * exit 8.
 */
const ProvisionerShape = z
  .object({
    up: commandWithTimeout,
    down: ProvisionerDownSchema,
    exports: z
      .record(
        z
          .string()
          .regex(ENV_NAME_RE, "an export name is an environment variable name"),
        commandWithTimeout,
      )
      .optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    /** Budget of `up` (default 10m). 0 = wait indefinitely. */
    timeout: DurationSchema.optional(),
  })
  .strict();

function checkExports(
  cfg: { exports?: Record<string, unknown> | undefined },
  ctx: z.RefinementCtx,
): void {
  for (const name of Object.keys(cfg.exports ?? {})) {
    if (reservedExportName(name)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exports", name],
        message: `"${name}" cannot be exported (it changes how every later process starts)`,
      });
    }
  }
}

export const ProvisionerSchema = ProvisionerShape.superRefine(checkExports);
export type ProvisionerConfig = z.infer<typeof ProvisionerSchema>;

/**
 * `environments.<n>.services.provisioner`: any keys, merged over the
 * top-level provisioner (the merged result must still have `up` and `down`).
 */
export const ProvisionerPatchSchema = ProvisionerShape.partial()
  .strict()
  .superRefine(checkExports);

/* ----- files ----- */

/**
 * A file cairn writes atomically (temp file + rename) before the tmux
 * phase: `json` deep-merges an object into the file (a `null` value removes
 * the key; an existing file that is not a JSON object is never overwritten),
 * `text` replaces the content. String values may use `${exports.NAME}` (a
 * value the provisioner exported; late-bound: an unknown name fails the
 * write) and `${env.NAME}` (which the config loader fills from the process
 * env first). `restart` names windows that restart when the content changed.
 * The journal records before/after fingerprints, never content.
 */
export const ServiceFileSchema = z
  .object({
    path: z.string().min(1),
    json: z.record(z.unknown()).optional(),
    text: z.string().optional(),
    restart: z.array(z.string().min(1)).min(1).optional(),
    /**
     * Octal file mode (`"644"`, `"0640"`). Default: an existing file keeps
     * its mode, a new one is `600` (its content may hold exports or
     * secrets); set it for a file other users or a container must read.
     */
    mode: z
      .string()
      .regex(/^0?[0-7]{3}$/, 'an octal mode such as "644" or "0600"')
      .optional(),
  })
  .strict()
  .superRefine((file, ctx) => {
    const kinds = (["json", "text"] as const).filter(
      (key) => file[key] !== undefined,
    );
    if (kinds.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a services.files entry needs exactly one of json or text",
      });
    }
  });
export type ServiceFile = z.infer<typeof ServiceFileSchema>;

/* ----- seed transaction ----- */

/** A regex source that compiles, for `expectOutput.notMatches`. */
const patternField = z
  .string()
  .min(1)
  .superRefine((pattern, ctx) => {
    try {
      // Compiling is the check.
      void new RegExp(pattern);
    } catch (error) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `not a valid regular expression: ${(error as Error).message}`,
      });
    }
  });

/**
 * A seed (or post-command) that exits 0 but prints an error still fails:
 * the combined output must match none of `notMatches`. Patterns are regular
 * expressions and case-sensitive; write a character class (`[Ee]rror`) to
 * match both cases.
 */
export const ExpectOutputSchema = z
  .object({
    notMatches: z.array(patternField).min(1),
  })
  .strict();
export type ExpectOutput = z.infer<typeof ExpectOutputSchema>;

const stringOrList = z.union([
  z.string().min(1),
  z.array(z.string().min(1)).min(1),
]);

/**
 * A post-command object. `when` limits it to suites and/or environments (a
 * command whose `when` does not match is skipped, with an event);
 * `continueOnError` records a failure without stopping the rest; `name` is
 * what `suites.<n>.seed.postCommands.skip` matches.
 */
export const SeedPostCommandObjectSchema = z
  .object({
    name: nameField,
    run: z.string().min(1),
    when: z
      .object({
        suite: stringOrList.optional(),
        env: stringOrList.optional(),
      })
      .strict()
      .optional(),
    continueOnError: z.boolean().optional(),
    timeout: DurationSchema.optional(),
    expectOutput: ExpectOutputSchema.optional(),
  })
  .strict();

export const SeedPostCommandSchema = z.union(
  [z.string().min(1), SeedPostCommandObjectSchema],
  {
    errorMap: () => ({
      message:
        "postCommands entry: expected a shell command string or { name, run, when?, continueOnError?, timeout?, expectOutput? }",
    }),
  },
);
export type SeedPostCommand = z.infer<typeof SeedPostCommandSchema>;

/** The shell text of a post-command entry. */
export function postCommandRun(entry: SeedPostCommand): string {
  return typeof entry === "string" ? entry : entry.run;
}

/** The label of a post-command: its name, else its command text. */
export function postCommandLabel(entry: SeedPostCommand): string {
  return typeof entry === "string" ? entry : entry.name;
}

/** `skipIf` of a phase: a shell probe (exit 0 = skip), `{command}` or `{gate}`. */
export const SeedSkipIfSchema = z.union([
  z.string().min(1),
  z.object({ command: z.string().min(1) }).strict(),
  z.object({ gate: GateRefListSchema }).strict(),
]);

/**
 * One step of a seed transaction. A phase runs when `always` is set, or when
 * neither its `skipIf` passes nor a recorded success of the same command is
 * still within the seed's `ttlSeconds`. Each phase's outcome is persisted
 * per project + environment + target, so a re-run resumes after the last
 * phase that succeeded.
 */
export const SeedPhaseSchema = z
  .object({
    name: nameField,
    command: z.string().min(1).optional(),
    run: z.string().min(1).optional(),
    cwd: z.string().optional(),
    env: z.record(z.string()).optional(),
    skipIf: SeedSkipIfSchema.optional(),
    always: z.boolean().optional(),
    timeout: DurationSchema.optional(),
    expectOutput: ExpectOutputSchema.optional(),
  })
  .strict()
  .superRefine((phase, ctx) => {
    if ((phase.command === undefined) === (phase.run === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a seed phase needs exactly one of command or run",
      });
    }
  });
export type SeedPhase = z.infer<typeof SeedPhaseSchema>;

/** The shell text of a phase. */
export function phaseRun(phase: SeedPhase): string {
  return (phase.command ?? phase.run)!;
}

/* ----- engine pin ----- */

export const RequiresSchema = z
  .object({
    /** Semver range the running cairn must satisfy (`>=3.0`, `^3.1`). */
    cairntrace: z
      .string()
      .min(1)
      .superRefine((range, ctx) => {
        const problem = rangeProblem(range);
        if (problem) {
          ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
        }
      })
      .optional(),
  })
  .strict();

export const RuntimesSchema = z
  .object({
    node: z
      .object({
        /** The node binary node scripts run with (a path, or a name on PATH). */
        path: z.string().min(1).optional(),
        /**
         * Semver range the node binary must satisfy. Without `path`, cairn
         * takes the first `node` on PATH that satisfies it, then looks in the
         * usual version-manager directories.
         */
        version: z
          .string()
          .min(1)
          .superRefine((range, ctx) => {
            const problem = rangeProblem(range);
            if (problem) {
              ctx.addIssue({ code: z.ZodIssueCode.custom, message: problem });
            }
          })
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict();
