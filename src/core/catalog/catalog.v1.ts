import { z } from "zod";

/**
 * Wire schema for `cairn catalog --json`, MCP `cairn_catalog` and the
 * `cairn://catalog` resource: what a project already has (actions, config
 * vars, script verifiers, environments, flows, checkpoints) so an agent
 * reuses it instead of re-recording literals. Additive only: new optional
 * fields may appear, existing ones keep their meaning.
 *
 * Paths (`file`) are relative to the catalog `root` (the config directory)
 * with `/` separators. Values that look like credentials are masked.
 */

export const CATALOG_KINDS = [
  "actions",
  "vars",
  "verifiers",
  "envs",
  "flows",
  "checkpoints",
  "fixtures",
  "suites",
] as const;
export const CatalogKindSchema = z.enum(CATALOG_KINDS);
export type CatalogKind = z.infer<typeof CatalogKindSchema>;

const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/** Why a row matched `--query`: one entry per query token that hit. */
const CatalogMatchSchema = z
  .object({
    token: z.string().min(1),
    /** Which field the token hit (name, description, intent, comment, …). */
    field: z.string().min(1),
  })
  .strict();

/** Ranking fields, present only when a query was given. */
const rankFields = {
  score: z.number().nonnegative().optional(),
  matched: z.array(CatalogMatchSchema).optional(),
};

/** A spec or action that references the catalog entry. */
const CatalogUseSchema = z
  .object({
    kind: z.enum(["spec", "action"]),
    name: z.string().min(1),
    file: z.string().min(1),
  })
  .strict();

/** A run picked from the artifact root (newest first, bounded scan). */
const CatalogRunRefSchema = z
  .object({
    runId: z.string().min(1),
    spec: z.string().min(1),
    status: z.string().min(1),
    environment: z.string().optional(),
    durationMs: z.number().int().nonnegative().optional(),
    startedAt: z.string().optional(),
    /**
     * `name`: no run in the scanned window recorded this spec's path, so
     * this is the newest run recorded under its spec name (a moved
     * checkout, or a same-named spec of another project sharing the
     * artifact root). Absent = matched by the spec's own path.
     */
    matchedBy: z.literal("name").optional(),
  })
  .strict();

const CatalogActionInputSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /**
     * The action has no default for it (declared `required: true`, or read
     * with no `vars:` default and no config environment var of that name):
     * the importing spec's `vars:`, a config environment var or `--var`
     * must supply it. Imports are resolved once before any `use:` runs, so
     * a value passed only in `use: { action, vars }` is not enough.
     */
    required: z.boolean(),
    /** The action's `vars:` default (masked when it looks like a secret). */
    default: ScalarSchema.optional(),
    /** Listed under the action's `inputs:`. */
    declared: z.boolean(),
    /** Read somewhere in the action as `${vars.<name>}`. */
    referenced: z.boolean(),
    /** Environments whose config `vars:` define the same name (they win over the default). */
    configEnvs: z.array(z.string()).optional(),
  })
  .strict();

export const CatalogActionSchema = z
  .object({
    name: z.string().min(1),
    file: z.string().min(1),
    description: z.string().optional(),
    /** `field` = the action's `description:`; `comment` = its leading YAML comment block. */
    descriptionSource: z.enum(["field", "comment"]).optional(),
    inputs: z.array(CatalogActionInputSchema),
    steps: z.number().int().nonnegative(),
    usedBy: z.array(CatalogUseSchema),
    /** Newest passed run of a spec that uses this action. */
    lastGreenRun: CatalogRunRefSchema.optional(),
    /** `inputs:` / `vars:` inconsistencies (the schema rejects these at run time). */
    problems: z.array(z.string()).optional(),
    ...rankFields,
  })
  .strict();
export type CatalogAction = z.infer<typeof CatalogActionSchema>;

export const CatalogVarSchema = z
  .object({
    name: z.string().min(1),
    env: z.string().min(1),
    /** Authored value (placeholders kept, never env-resolved). */
    value: ScalarSchema.optional(),
    /** The value looked like a credential and was replaced by `[redacted]`. */
    masked: z.literal(true).optional(),
    /** The YAML comment above (or after) the key. */
    comment: z.string().optional(),
    /**
     * `environment` = written in this environment; `inherited` = via a `<<:`
     * merge key or a `vars: *anchor` alias; F7: `top-level` = the config's
     * (or an included file's) top-level `vars:`; `extends` = an environment
     * this one extends (`inheritedFrom` names it).
     */
    definedIn: z.enum(["environment", "inherited", "top-level", "extends"]),
    /** Where an inherited value comes from: an environment name or `&anchor`. */
    inheritedFrom: z.string().optional(),
    /** F7: `file:line` of the definition when it is not this environment's own entry. */
    file: z.string().optional(),
    usedBy: z.array(CatalogUseSchema),
    ...rankFields,
  })
  .strict();
export type CatalogVar = z.infer<typeof CatalogVarSchema>;

const CatalogFixtureKeySchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    required: z.boolean().optional(),
    /** SDK contracts: the declared type (`string`, `number[]`, `enum`, …). */
    type: z.string().optional(),
    /** `header` (doc comment), `export` (exported fixtures/contract object), `usage` (read in code) or `sdk` (defineVerifier fixtures schema). */
    source: z.enum(["header", "export", "usage", "sdk"]),
  })
  .strict();

const CatalogVerifierUseSchema = z
  .object({
    spec: z.string().min(1),
    file: z.string().min(1),
    outcome: z.string().min(1),
    runtime: z.enum(["browser", "node"]),
    /** Fixture keys this outcome passes. */
    fixtureKeys: z.array(z.string()),
    /** Passed keys the verifier's contract does not list. */
    unknownKeys: z.array(z.string()).optional(),
    /** Contract keys marked required that this outcome does not pass. */
    missingKeys: z.array(z.string()).optional(),
  })
  .strict();

export const CatalogVerifierSchema = z
  .object({
    file: z.string().min(1),
    exists: z.boolean(),
    /** The script's header doc comment. */
    description: z.string().optional(),
    fixtures: z
      .object({
        /** Best source the contract came from; `none` = nothing statically readable. */
        source: z.enum(["header", "export", "usage", "sdk", "none"]),
        /** The script reads fixtures dynamically: unknown keys are not flagged. */
        dynamic: z.boolean().optional(),
        /** SDK contracts: unknown fixture keys fail the verifier at runtime. */
        strict: z.boolean().optional(),
        keys: z.array(CatalogFixtureKeySchema),
      })
      .strict(),
    usedBy: z.array(CatalogVerifierUseSchema),
    ...rankFields,
  })
  .strict();
export type CatalogVerifier = z.infer<typeof CatalogVerifierSchema>;

/** The services phases a catalog environment row lists, in boot order. */
export const CATALOG_SERVICE_PHASES = [
  "provisioner",
  "tunnels",
  "docker",
  "files",
  "seed",
  "tmux",
] as const;

export const CatalogEnvSchema = z
  .object({
    name: z.string().min(1),
    /** `defaultEnvironment` names it. */
    default: z.boolean(),
    baseUrl: z.string().optional(),
    policy: z
      .object({
        trait: z.enum(["owned", "shared", "protected"]).optional(),
        mutations: z.enum(["allow", "deny"]).optional(),
        description: z.string().optional(),
      })
      .strict()
      .optional(),
    services: z
      .object({
        /** `cairn run` boots services for this environment. */
        enabled: z.boolean(),
        /** In boot order (provisioner → tunnels → docker → files → seed → tmux). */
        phases: z.array(z.enum(CATALOG_SERVICE_PHASES)),
      })
      .strict(),
    /** Secrets provider and key NAMES (never values). */
    secrets: z
      .object({
        provider: z.string().min(1),
        required: z.array(z.string()).optional(),
        keys: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    vars: z.number().int().nonnegative(),
    ...rankFields,
  })
  .strict();
export type CatalogEnv = z.infer<typeof CatalogEnvSchema>;

export const CatalogFlowSchema = z
  .object({
    name: z.string().min(1),
    file: z.string().min(1),
    intent: z.string(),
    tags: z.array(z.string()).optional(),
    requires: z.unknown().optional(),
    environment: z.string().optional(),
    /** File or folder name starts with `_` (a draft `cairn run <dir>` skips). */
    draft: z.literal(true).optional(),
    /** Actions it `use:`s. */
    actions: z.array(z.string()).optional(),
    /** `session.resume` checkpoint. */
    checkpoint: z.string().optional(),
    /** Newest run of this spec (in `env` when the catalog was asked for one). */
    lastRun: CatalogRunRefSchema.optional(),
    ...rankFields,
  })
  .strict();
export type CatalogFlow = z.infer<typeof CatalogFlowSchema>;

export const CatalogCheckpointSchema = z
  .object({
    name: z.string().min(1),
    /** ok | expired | unscoped | missing (see `cairn checkpoint list`). */
    health: z.enum(["ok", "expired", "unscoped", "missing"]),
    scope: z
      .object({
        env: z.string().optional(),
        baseUrl: z.string().optional(),
        createdAt: z.string().optional(),
        ttl: z.string().optional(),
        expiresAt: z.string().optional(),
      })
      .strict()
      .optional(),
    staleMeta: z.literal(true).optional(),
    /** Why a resume would refuse it (with `env`: also an origin mismatch). */
    problem: z
      .object({ code: z.string().min(1), message: z.string().min(1) })
      .strict()
      .optional(),
    usedBy: z.array(CatalogUseSchema),
    ...rankFields,
  })
  .strict();
export type CatalogCheckpoint = z.infer<typeof CatalogCheckpointSchema>;

/** A config `fixtures:` entry (F3b) and the specs that reference it. */
export const CatalogFixtureSchema = z
  .object({
    name: z.string().min(1),
    kind: z.enum(["exec", "mongo", "http"]),
    scope: z.enum(["run", "suite", "seed"]),
    description: z.string().optional(),
    datasource: z.string().optional(),
    /** Declared verbs (ensure, reset, verify, teardown). */
    verbs: z.array(z.string().min(1)),
    needs: z.array(z.string()),
    /** Output keys, read as `${fixtures.<name>.<key>}`. */
    outputs: z.array(z.string()),
    /** Default parameter names (`with:`). */
    params: z.array(z.string()).optional(),
    ttlMs: z.number().int().positive().optional(),
    /** Specs listing it under `fixtures:` (directly; not through needs). */
    usedBy: z.array(CatalogUseSchema),
    ...rankFields,
  })
  .strict();
export type CatalogFixture = z.infer<typeof CatalogFixtureSchema>;

/** One environment's view of a suite: the specs it resolves to there. */
const CatalogSuiteEnvSchema = z
  .object({
    env: z.string().min(1),
    /** Resolved spec files, in run order (relative to `root`). Empty when `problem` is set. */
    specs: z.array(z.string().min(1)),
    /** Why the suite does not resolve or may not run here (unknown spec, `requires`, …). */
    problem: z.string().optional(),
    /** Names of the vars the suite sets here (values are never listed). */
    vars: z.array(z.string()).optional(),
    /** Commands of the suite's before / after hooks here (the commands themselves are not listed). */
    before: z.number().int().nonnegative(),
    after: z.number().int().nonnegative(),
    hookTimeoutMs: z.number().int().positive().optional(),
    /** `env.<n>.bail` (present only when the environment sets its own). */
    bail: z.boolean().optional(),
    /** The seed post-commands skipped here, when the environment adds its own skips. */
    seedSkip: z.array(z.string()).optional(),
    /** Names of the `processEnv` variables exported here (values are never listed). */
    processEnv: z.array(z.string()).optional(),
    /** `labels` stamped on every run here, as `key=value` (masked). */
    labels: z.array(z.string()).optional(),
  })
  .strict();

/** A config `suites:` entry (F9) with its resolved spec list per environment. */
export const CatalogSuiteSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    /** The selectors as authored. */
    specs: z.array(z.string()).optional(),
    tags: z.array(z.string()).optional(),
    order: z.array(z.string()).optional(),
    parallel: z.number().int().positive().optional(),
    bail: z.boolean().optional(),
    requires: z
      .object({
        env: z.array(z.string()).optional(),
        vars: z.array(z.string()).optional(),
      })
      .strict()
      .optional(),
    /** Seed post-commands the suite skips. */
    seedSkip: z.array(z.string()).optional(),
    envs: z.array(CatalogSuiteEnvSchema),
    ...rankFields,
  })
  .strict();
export type CatalogSuite = z.infer<typeof CatalogSuiteSchema>;

/** `cairn suites list --json`: the config's suites with their per-environment spec lists. */
export const SuitesListResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:suites:v1"),
    version: z.literal("1"),
    project: z.string().optional(),
    root: z.string().min(1),
    configPath: z.string().optional(),
    /** The `--env` the list was narrowed to. */
    env: z.string().optional(),
    suites: z.array(CatalogSuiteSchema),
    warnings: z.array(z.string()),
  })
  .strict();
export type SuitesListResult = z.infer<typeof SuitesListResultSchema>;

const CatalogCountsSchema = z
  .object({
    actions: z.number().int().nonnegative().optional(),
    vars: z.number().int().nonnegative().optional(),
    verifiers: z.number().int().nonnegative().optional(),
    envs: z.number().int().nonnegative().optional(),
    flows: z.number().int().nonnegative().optional(),
    checkpoints: z.number().int().nonnegative().optional(),
    fixtures: z.number().int().nonnegative().optional(),
    suites: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CatalogResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:catalog:v1"),
    version: z.literal("1"),
    project: z.string().optional(),
    /** Absolute directory every row `file` is relative to: the config directory, else the cwd. */
    root: z.string().min(1),
    configPath: z.string().optional(),
    /** The `--env` the catalog was built for (vars, last runs, checkpoint origin). */
    env: z.string().optional(),
    query: z.string().optional(),
    kinds: z.array(CatalogKindSchema),
    /** Matching rows per kind before `limit` (with a query: rows that matched). */
    totals: CatalogCountsSchema,
    /** Rows returned per kind; absent = unlimited. */
    limit: z.number().int().positive().optional(),
    actions: z.array(CatalogActionSchema).optional(),
    vars: z.array(CatalogVarSchema).optional(),
    verifiers: z.array(CatalogVerifierSchema).optional(),
    envs: z.array(CatalogEnvSchema).optional(),
    flows: z.array(CatalogFlowSchema).optional(),
    checkpoints: z.array(CatalogCheckpointSchema).optional(),
    fixtures: z.array(CatalogFixtureSchema).optional(),
    suites: z.array(CatalogSuiteSchema).optional(),
    scan: z
      .object({
        /** YAML files read under the scan roots. */
        files: z.number().int().nonnegative(),
        specs: z.number().int().nonnegative(),
        actions: z.number().int().nonnegative(),
        /** run.json files read (newest first, bounded). */
        runs: z.number().int().nonnegative(),
        artifactRoot: z.string().optional(),
        /** The file walk stopped at its bound; some files were not read. */
        truncated: z.literal(true).optional(),
        /**
         * Checkpoints in the (shared) checkpoint store left out of
         * `checkpoints`: no spec here resumes them and they were captured
         * for no origin a configured environment uses. `cairn checkpoint
         * list` shows them.
         */
        otherCheckpoints: z.number().int().positive().optional(),
      })
      .strict(),
    warnings: z.array(z.string()),
  })
  .strict();
export type CatalogResult = z.infer<typeof CatalogResultSchema>;
