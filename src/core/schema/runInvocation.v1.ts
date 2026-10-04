import { z } from "zod";
import { InvocationDelegateSchema, InvocationSummarySchema } from "./events.v1";
import { IsoTimestampSchema } from "./shared";

/**
 * Every `cairn run` option as ONE transport-neutral shape. The CLI maps its
 * commander flags here in a single function, MCP `cairn_run` builds its input
 * schema from the same shape, and the run engine (`executeRunInvocation`)
 * reads nothing else, so the two entry points cannot drift.
 *
 * Keys are the camelCase of the long flag (`--no-web-server` → `noWebServer`,
 * `--since-codemap` → `sinceCodemap`). Presentation flags (`--format` and its
 * `--json`/`--yaml`/`--md` shorthands, `--progress`, the global logging and
 * color flags) only change how a result is rendered and are not run options.
 */
export const RunInvocationOptionsShape = {
  env: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Environment override; when a config exists, an environment it does not define is a config error (exit 4) before any secret, service, hook or spec starts",
    ),
  config: z
    .string()
    .min(1)
    .optional()
    .describe("Explicit cairntrace.config.yml (overrides auto-discovery)"),
  var: z
    .array(z.string())
    .optional()
    .describe(
      "Runtime var overrides as key=value (repeatable); win over config environment vars",
    ),
  coldStart: z
    .boolean()
    .optional()
    .describe(
      "Force a fresh browser profile (default: on when CI is set); also makes services/webServer boot fresh",
    ),
  headed: z.boolean().optional().describe("Show the browser window"),
  mock: z
    .boolean()
    .optional()
    .describe("Use the in-memory mock backend (fast smoke; no real browser)"),
  backend: z
    .enum(["agent-browser", "playwright", "mock"])
    .optional()
    .describe(
      "Browser backend (default agent-browser; playwright enables native traces/video/HAR)",
    ),
  provider: z
    .string()
    .min(1)
    .optional()
    .describe(
      "agent-browser provider: ios | browserbase | kernel | … (wins over config browser.provider)",
    ),
  device: z
    .string()
    .min(1)
    .optional()
    .describe(
      'iOS device name, e.g. "iPhone 15 Pro" (with provider ios; wins over config browser.device)',
    ),
  parallel: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe(
      "Run N specs concurrently, each in its own browser session (default 1)",
    ),
  artifactRoot: z
    .string()
    .min(1)
    .optional()
    .describe("Override the run artifact root directory"),
  junit: z
    .string()
    .min(1)
    .optional()
    .describe("Write a JUnit XML report to this file"),
  stampIfGreen: z
    .boolean()
    .optional()
    .describe(
      "Write fresh contractHash values only after every requested spec passes",
    ),
  noWebServer: z
    .boolean()
    .optional()
    .describe(
      "Skip the config webServer lifecycle (manage the server yourself)",
    ),
  noServices: z
    .boolean()
    .optional()
    .describe("Skip the config services lifecycle (docker/seed/tmux)"),
  servicesDryRun: z
    .boolean()
    .optional()
    .describe(
      "Resolve and return the services lifecycle plan without running services, hooks or specs",
    ),
  reuseServices: z
    .boolean()
    .optional()
    .describe(
      "Run against the services `cairn services up` owns for this config + env: one quick readiness check (a stale lock is exit 4), no start, no teardown, and a cold browser. Without it a run refuses (exit 4) while that lock exists, and so does a run of another env of the config",
    ),
  stashOnFailure: z
    .boolean()
    .optional()
    .describe(
      "Auto-stash failed run directories to file.cheap (non-fatal if fcheap is missing)",
    ),
  stash: z
    .boolean()
    .optional()
    .describe(
      "Stash every run to file.cheap regardless of status (config stash.include/ttl apply; refused runs are never stashed)",
    ),
  autoAnnotate: z
    .enum(["on-run", "never"])
    .optional()
    .describe(
      "Auto-annotate runs into codemap (wins over config annotate.autoAnnotate)",
    ),
  monitor: z
    .boolean()
    .optional()
    .describe(
      "Sample the browser process tree (CPU/RSS) via the monitor CLI; writes diagnostics/process.{md,json}",
    ),
  sinceCodemap: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Run only specs whose coversSymbol intersects `codemap review --since <ref>` blast radius (degrades to run-all when codemap is absent)",
    ),
  selectOnly: z
    .boolean()
    .optional()
    .describe(
      "Resolve which specs WOULD run (SelectionResult v1) without launching a browser",
    ),
  suite: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Run the config `suites:` entry of this name instead of explicit spec paths: its specs (paths, directories, globs, spec names, tags) in its order, the environment's vars, once-per-run before/after hooks, parallel and bail. Spec paths next to it narrow it to those of its own specs (its hooks, vars and labels still apply; a path that is not one of them is a usage error, exit 2); --tag still narrows it",
    ),
  tag: z
    .array(z.string())
    .optional()
    .describe(
      "Run only specs whose metadata.tags include every tag (AND, case-insensitive)",
    ),
  label: z
    .array(z.string())
    .optional()
    .describe(
      "Cohort labels as key=value stamped onto each run.json (repeatable); used by cairn stats --group-by",
    ),
  before: z
    .array(z.string())
    .optional()
    .describe(
      "Shell commands run after services/secrets and before the first spec of each run; failures abort. MCP: needs `cairn mcp --allow-hooks`",
    ),
  after: z
    .array(z.string())
    .optional()
    .describe(
      "Shell commands run after EACH spec (pass or fail) with CAIRN_RUN_DIR set; failures are logged, non-fatal. MCP: needs `cairn mcp --allow-hooks`",
    ),
  hookTimeoutMs: z
    .number()
    .int()
    .min(1)
    .max(7_200_000)
    .optional()
    .describe(
      "Maximum duration of each before/after hook in ms (default 600000)",
    ),
  repeat: z
    .number()
    .int()
    .min(1)
    .max(1000)
    .optional()
    .describe(
      "Run the spec set N times sequentially, stamping label repeat=<i>",
    ),
  matrix: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Cartesian product key=a,b[;key2=x,y]: each combination exports CAIRN_MATRIX_<KEY> and key=value labels",
    ),
  stopOnFail: z
    .boolean()
    .optional()
    .describe("With repeat/matrix: stop at the first run that does not pass"),
  bail: z
    .boolean()
    .optional()
    .describe(
      "Stop scheduling the remaining specs after the first failed or errored one: they are reported as skipped (reason bailed), running specs finish, teardown runs as usual, and the exit code is that of the first failure. false (CLI --no-bail) runs every spec even when the suite's bail says otherwise; omitted, the suite's bail applies",
    ),
  strictRequires: z
    .boolean()
    .optional()
    .describe(
      "Fail a batch (exit 7) when the environment policy refuses any spec; without it refused specs are reported but do not fail the batch",
    ),
  allowFixtureWrites: z
    .boolean()
    .optional()
    .describe(
      "Let fixture ensure/reset/teardown write on an environment whose policy trait is shared or protected (otherwise they are dry-run there unless the spec's fixture reference says write: true); policy.mutations: deny keeps them dry-run regardless",
    ),
  runToken: z
    .string()
    .regex(/^[A-Za-z0-9_.-]{1,64}$/)
    .optional()
    .describe(
      "Pin the per-run uniqueness token (${run.token} / CAIRN_RUN_TOKEN) instead of minting a random one: the same value an exported Playwright test reads from CAIRN_RUN_TOKEN, so both sides write the same unique values (cairn export playwright --verify=differential). Letters, digits, `_`, `.`, `-`; at most 64 characters",
    ),
} as const;

export const RunInvocationOptionsSchema = z
  .object(RunInvocationOptionsShape)
  .strict();
export type RunInvocationOptions = z.infer<typeof RunInvocationOptionsSchema>;

/** Where an invocation was started from (stamped into invocation.json). */
export const RunInvocationOriginSchema = z.enum(["cli", "mcp"]);
export type RunInvocationOrigin = z.infer<typeof RunInvocationOriginSchema>;

/**
 * What an engine invocation produced: one RunResult (`single`), a
 * BatchRunResult (`batch`, also every --repeat/--matrix invocation), a
 * SelectionResult (`selection`), nothing to run (`skipped`, --since-codemap
 * matched no spec), a services plan (`services-dry-run`), or an invocation
 * that stopped before/around its specs (`errored`).
 */
export const RunInvocationKindSchema = z.enum([
  "single",
  "batch",
  "selection",
  "skipped",
  "services-dry-run",
  "errored",
]);
export type RunInvocationKind = z.infer<typeof RunInvocationKindSchema>;

/** Live or settled state of one invocation (MCP status/cancel/start). */
export const RunInvocationStateSchema = z.enum([
  "running",
  "cancelling",
  "passed",
  "failed",
  "errored",
  "aborted",
]);
export type RunInvocationState = z.infer<typeof RunInvocationStateSchema>;

const InvocationRunRowSchema = z
  .object({
    index: z.number().int().positive(),
    spec: z.string().min(1),
    runId: z.string().min(1),
    runDir: z.string().min(1),
    status: z.enum(["running", "passed", "failed", "errored"]).optional(),
    /** No run directory was ever written (`runId`/`runDir` are placeholders). */
    synthetic: z.literal(true).optional(),
  })
  .strict();

/**
 * `cairn_run {wait:false}`, `cairn_run_status` and `cairn_run_cancel`
 * structured output: the invocation as this server tracks it, merged with
 * its on-disk journal (`<artifactRoot>/_invocations/<id>/invocation.json`).
 */
export const RunInvocationStatusResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:run-invocation:v1"),
    version: z.literal("1"),
    invocationId: z.string().min(1),
    status: RunInvocationStateSchema,
    /** True when this MCP server started (and can cancel) the invocation. */
    owned: z.boolean(),
    origin: RunInvocationOriginSchema.optional(),
    client: z.string().min(1).optional(),
    artifactRoot: z.string().min(1).optional(),
    /** Journal directory relative to artifactRoot (`_invocations/<id>`). */
    journalDir: z.string().min(1).optional(),
    journalDirAbsolute: z.string().min(1).optional(),
    startedAt: IsoTimestampSchema.optional(),
    endedAt: IsoTimestampSchema.optional(),
    /** Planned spec runs (specs × repeat/matrix iterations). */
    planned: z.number().int().nonnegative().optional(),
    current: z
      .object({
        index: z.number().int().positive(),
        spec: z.string().min(1),
        runId: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    runs: z.array(InvocationRunRowSchema),
    summary: InvocationSummarySchema.optional(),
    cancelRequested: z.boolean().optional(),
    /** Settled invocations only. */
    kind: RunInvocationKindSchema.optional(),
    exitCode: z.number().int().optional(),
    error: z.string().optional(),
    /** The settled document (RunResult / BatchRunResult / SelectionResult …). */
    document: z.record(z.string(), z.unknown()).optional(),
    /** The journal's `delegate` block: the invocation runs on a delegated runner. Additive. */
    delegate: InvocationDelegateSchema.optional(),
  })
  .strict();
export type RunInvocationStatusResult = z.infer<
  typeof RunInvocationStatusResultSchema
>;

/** Per-file byte positions of a log selection (`{ "<file>": bytes }`). */
export const RunLogsCursorSchema = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

/**
 * `cairn_logs`: one incremental slice of a run or invocation log. Every file
 * of the selection is read from its own position; multi-file selections
 * (precondition, outcome, services, hook) prefix each file's new bytes with
 * `==> <file> <==`.
 */
export const RunLogsResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:run-logs:v1"),
    version: z.literal("1"),
    target: z.enum(["run", "invocation"]),
    /** Run id or invocation id. */
    id: z.string().min(1),
    /** Absolute run directory or journal directory. */
    dir: z.string().min(1),
    /** The selection: events | run | precondition | outcome | narration | services | hook | <file>. */
    log: z.string().min(1),
    /** Files read, relative to `dir`, in read order. */
    files: z.array(z.string()),
    text: z.string(),
    /** Bytes already read before this slice (summed over the files). */
    offset: z.number().int().nonnegative(),
    /**
     * Bytes read after this slice (summed over the files). A single-file
     * selection may pass it back as `offset`; multi-file ones need nextCursor.
     */
    nextOffset: z.number().int().nonnegative(),
    /** Pass back as `cursor` to continue (works for every selection). */
    nextCursor: RunLogsCursorSchema,
    /** Bytes currently in the selection (summed over the files). */
    size: z.number().int().nonnegative(),
    /** True when every file was read to its current end. */
    eof: z.boolean(),
    /** True once the run/invocation settled (or its writer died): no more bytes will come. */
    settled: z.boolean(),
    state: z.enum(["running", "settled", "dead"]),
  })
  .strict();
export type RunLogsResult = z.infer<typeof RunLogsResultSchema>;
