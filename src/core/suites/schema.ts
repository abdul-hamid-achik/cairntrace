import { z } from "zod";
import { reservedExportName } from "../servicesOps/schema";

/**
 * Config `suites:` registry (F9, "replace the Taskfile's suite switch"): a
 * named, ordered set of specs with the settings a wrapper script used to
 * carry per suite and per environment — which specs, in which order, how
 * parallel, whether to bail, which vars, which commands to run before and
 * after, which seed post-commands to skip.
 *
 * ```yaml
 * suites:
 *   checkout:
 *     description: Checkout flows
 *     specs: [flows/checkout/**, flows/smoke/login.yml]
 *     tags: [critical]            # AND-filter on metadata.tags
 *     order: [login-flow]         # run these first, in this order
 *     parallel: 2
 *     bail: true
 *     requires: { env: [local, staging] }
 *     env:
 *       staging:
 *         vars: { region: eu }
 *         before: ["./tools/warm-cache.sh"]
 *         after: ["./tools/collect.sh"]
 *         hookTimeoutMs: 120000
 *         specs: [flows/checkout/smoke/**]      # replaces `specs` here
 *     seed: { postCommands: { skip: ["./tools/seed-extra.sh"] } }
 * ```
 *
 * `cairn run --suite checkout --env staging` resolves it; the pure
 * resolution lives in `resolve.ts`.
 */

export const SUITE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const SuiteNameSchema = z
  .string()
  .regex(
    SUITE_NAME_PATTERN,
    "suite names start with a letter or digit (letters, digits, . _ -)",
  );

/** A spec reference: a path, a directory, a glob or a spec `name`. */
const SpecRefSchema = z.string().min(1);
const SpecRefListSchema = z.array(SpecRefSchema).min(1);

const SuiteVarValueSchema = z.union([z.string(), z.number(), z.boolean()]);

const CommandListSchema = z.array(z.string().min(1));

const HookTimeoutSchema = z.number().int().min(1).max(7_200_000);

/**
 * Process env names a suite may not set: what changes how every process
 * starts (`PATH`, `HOME`, `SHELL`, `NODE_OPTIONS`, `LD_*`, `DYLD_*`),
 * the vault client's own controls (`TVAULT_*`) and the context cairn itself
 * gives hooks and commands (`CAIRN_SUITE`, `CAIRN_SUITE_VAR_*`,
 * `CAIRN_EXIT_CODE`, …).
 */
const CAIRN_CONTEXT_ENV = new Set([
  "CAIRN_SUITE",
  "CAIRN_EXIT_CODE",
  "CAIRN_INVOCATION_DIR",
  "CAIRN_RUN_DIR",
  "CAIRN_RUN_LOCK",
  "CAIRN_RUN_TOKEN",
  "CAIRN_ENV",
  "CAIRN_BASE_URL",
  "CAIRN_CONFIG_DIR",
]);
export function reservedSuiteEnvName(name: string): boolean {
  return (
    reservedExportName(name) ||
    name.startsWith("TVAULT_") ||
    name.startsWith("CAIRN_SUITE_VAR_") ||
    name.startsWith("CAIRN_MATRIX_") ||
    CAIRN_CONTEXT_ENV.has(name)
  );
}

/**
 * `processEnv`: environment variables exported to every process of a run of
 * the suite — preflight commands, the services phases (provisioner, tunnels,
 * docker, seed), hooks, specs and their commands and verifiers. Values may
 * use `${env.X}` / `${vars.X}`; an entry whose `${env.X}` is unset (no
 * `:-default`) is not exported. Names only ever reach the journal.
 */
export const SuiteProcessEnvSchema = z
  .record(
    z
      .string()
      .regex(
        /^[A-Za-z_][A-Za-z0-9_]*$/,
        "a process env name is letters, digits and _ (not starting with a digit)",
      ),
    SuiteVarValueSchema,
  )
  .superRefine((env, ctx) => {
    for (const name of Object.keys(env)) {
      if (reservedSuiteEnvName(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: `"${name}" cannot be set by a suite (it changes how every process starts, or cairn sets it itself)`,
        });
      }
    }
  });

/** `labels`: `key: value` pairs stamped on every run of the suite (`--label` wins). */
export const SuiteLabelsSchema = z.record(
  z
    .string()
    .min(1)
    .regex(/^[^=\s]+$/, "a label key has no '=' and no whitespace"),
  SuiteVarValueSchema,
);

/** `seed.postCommands.skip` (suite level and per environment). */
const SuiteSeedSchema = z
  .object({
    postCommands: z
      .object({
        /**
         * Seed post-commands this suite does not run: an entry matches a
         * named post-command (the object form) by its `name`, and a plain
         * string post-command by its exact command text.
         */
        skip: z.array(z.string().min(1)).min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** What one environment changes about a suite. */
export const SuiteEnvSchema = z
  .object({
    /** Vars for this environment, over the suite's `vars` (`--var` wins). */
    vars: z.record(z.string(), SuiteVarValueSchema).optional(),
    /** Commands run once before the first spec (after services boot); a failure stops the run. */
    before: CommandListSchema.optional(),
    /** Commands run once after the last spec, on every exit path; non-fatal. */
    after: CommandListSchema.optional(),
    /** Budget of each suite hook of this environment (default: `--hook-timeout-ms`). */
    hookTimeoutMs: HookTimeoutSchema.optional(),
    /** Replaces the suite's `specs` in this environment. */
    specs: SpecRefListSchema.optional(),
    /** Replaces the suite's `bail` in this environment (`--bail` / `--no-bail` win). */
    bail: z.boolean().optional(),
    /** Process env of this environment, over the suite's `processEnv` by name. */
    processEnv: SuiteProcessEnvSchema.optional(),
    /** Labels of this environment, over the suite's `labels` by key. */
    labels: SuiteLabelsSchema.optional(),
    /** Seed post-commands skipped in this environment, on top of the suite's. */
    seed: SuiteSeedSchema.optional(),
  })
  .strict();

export const SuiteRequiresSchema = z
  .object({
    /** The suite only runs in these environments (a name or a list). */
    env: z
      .union([z.string().min(1), z.array(z.string().min(1)).min(1)])
      .optional(),
    /** Vars that must resolve to a non-empty value in the environment. */
    vars: z.array(z.string().min(1)).min(1).optional(),
  })
  .strict();

export const SuiteSchema = z
  .object({
    description: z.string().optional(),
    /** Spec paths, directories, globs (relative to the config) or spec names. */
    specs: SpecRefListSchema.optional(),
    /** Keep only specs whose `metadata.tags` include every tag (AND, case-insensitive). */
    tags: z.array(z.string().min(1)).min(1).optional(),
    /**
     * The run order: these specs run first, in this order; the rest of the
     * selection follows in resolved order. Without `specs` and `tags` the
     * list is also the selection.
     */
    order: SpecRefListSchema.optional(),
    /** Concurrent specs (`--parallel` wins). */
    parallel: z.number().int().min(1).optional(),
    /**
     * Stop scheduling after the first failed or errored spec (`--bail` adds
     * to it, `--no-bail` turns it off; `env.<n>.bail` replaces it).
     */
    bail: z.boolean().optional(),
    requires: SuiteRequiresSchema.optional(),
    /** Vars for every environment (an `env.<n>.vars` entry wins by name). */
    vars: z.record(z.string(), SuiteVarValueSchema).optional(),
    before: CommandListSchema.optional(),
    after: CommandListSchema.optional(),
    hookTimeoutMs: HookTimeoutSchema.optional(),
    env: z.record(z.string(), SuiteEnvSchema).optional(),
    seed: SuiteSeedSchema.optional(),
    /** Process env of every run of the suite (see {@link SuiteProcessEnvSchema}). */
    processEnv: SuiteProcessEnvSchema.optional(),
    /** Labels stamped on every run of the suite, under `--label`. */
    labels: SuiteLabelsSchema.optional(),
  })
  .strict()
  .superRefine((suite, ctx) => {
    const envSpecs = Object.values(suite.env ?? {}).some(
      (entry) => entry.specs !== undefined,
    );
    if (
      suite.specs === undefined &&
      suite.tags === undefined &&
      suite.order === undefined &&
      !envSpecs
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a suite needs `specs`, `tags` or `order` to select specs",
      });
    }
  });
export type Suite = z.infer<typeof SuiteSchema>;

export const SuitesRegistrySchema = z.record(SuiteNameSchema, SuiteSchema);
export type SuitesRegistry = z.infer<typeof SuitesRegistrySchema>;

/** `requires.env` as a list. */
export function suiteRequiredEnvs(suite: Suite): string[] {
  const env = suite.requires?.env;
  if (env === undefined) return [];
  return typeof env === "string" ? [env] : env;
}

/** Every environment name a suite mentions (for config validation). */
export function suiteEnvironmentRefs(
  suite: Suite,
): Array<{ path: string; env: string }> {
  return [
    ...Object.keys(suite.env ?? {}).map((env) => ({
      path: `env.${env}`,
      env,
    })),
    ...suiteRequiredEnvs(suite).map((env) => ({
      path: "requires.env",
      env,
    })),
  ];
}

/** The environment variable a suite var reaches hooks as: `CAIRN_SUITE_VAR_<NAME>`. */
export function suiteVarEnvName(key: string): string {
  return `CAIRN_SUITE_VAR_${key.replace(/[^A-Za-z0-9]/g, "_").toUpperCase()}`;
}

/**
 * Suite var names that reach hooks as the same `CAIRN_SUITE_VAR_<NAME>`
 * (`a-b` and `a_b`, `region` and `Region`): one would silently shadow the
 * other. Each entry lists the colliding names and the shared variable.
 */
export function suiteVarCollisions(
  keys: readonly string[],
): Array<{ envName: string; keys: string[] }> {
  const byName = new Map<string, string[]>();
  for (const key of keys) {
    const envName = suiteVarEnvName(key);
    byName.set(envName, [...(byName.get(envName) ?? []), key]);
  }
  return [...byName.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([envName, list]) => ({ envName, keys: list.toSorted() }));
}
