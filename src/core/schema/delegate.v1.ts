import { z } from "zod";
import { InvocationPlannedRunSchema } from "./events.v1";
import { RunInvocationOptionsSchema } from "./runInvocation.v1";
import { DELEGATE_CONTRACT, IsoTimestampSchema } from "./shared";

export { DELEGATE_CONTRACT };

/**
 * The delegated-runner contract, `urn:cairntrace.dev:delegate:v1`.
 *
 * An environment with `runner: { command, cwd?, env?, timeoutMs?,
 * idleTimeoutMs?, cancelGraceMs? }` runs somewhere else. The local `cairn run` (or MCP
 * `cairn_run`) still owns the invocation: it validates the selection and the
 * run policy, writes the invocation journal, spawns `command` with
 *
 *   CAIRN_DELEGATE_REQUEST   path of the request (this schema, JSON, 0600)
 *   CAIRN_DELEGATE_EVENTS    path of the events stream the runner appends to
 *   CAIRN_DELEGATE_CONTRACT  urn:cairntrace.dev:delegate:v1
 *   CAIRN_INVOCATION_ID / CAIRN_INVOCATION_DIR / CAIRN_ARTIFACT_ROOT
 *
 * and relays the stream into the journal while the runner works. The runner:
 *
 *   1. reads the request and runs the invocation elsewhere (`cairnArgs`
 *      plus an environment of its choosing is the remote `cairn` command);
 *   2. appends NDJSON lines to CAIRN_DELEGATE_EVENTS: the remote invocation
 *      journal's events.v1 lines plus `invocation.run.started` /
 *      `invocation.run.finished` / `invocation.summary` (exactly what
 *      `cairn logs --invocation <ref> --follow --relay` prints on the remote
 *      side) and, optionally, its own `delegate.progress` lines;
 *   3. places every run directory under `artifactRootLocal/<runId>/`, with
 *      `run.json` and `artifact-manifest.json` copied last and mtimes kept;
 *      each run.json carries `labels["cairn.delegate"]` = `invocationId`
 *      (the remote `cairn` adds it: `cairnArgs` carry the label);
 *   4. on SIGINT (sent to the runner's pid only; its process group gets
 *      SIGTERM, then SIGKILL, only after `cancelGraceMs`) cancels the remote
 *      invocation, copies what it produced and exits (130);
 *   5. exits with the remote invocation's exit code (0–9, 130, 143).
 *
 * cairn never takes the runner's word for a pass: the exit code is checked
 * against the remote `invocation.summary` / `invocation.finished` (same
 * invocation), every planned run being settled once, and every copied
 * run.json (status, label, freshness). See `delegateVerdict`.
 *
 * Rules for v1 (additive only): new optional fields, new optional event
 * types. A runner must ignore request fields it does not know.
 */

/** The `cairn run` options a runner can carry to the remote invocation (raw, as given). */
export const DelegateRequestOptionsSchema = RunInvocationOptionsSchema.pick({
  var: true,
  label: true,
  tag: true,
  bail: true,
  parallel: true,
  backend: true,
  mock: true,
  headed: true,
  provider: true,
  device: true,
  coldStart: true,
  repeat: true,
  matrix: true,
  stopOnFail: true,
  strictRequires: true,
  allowFixtureWrites: true,
  runToken: true,
  before: true,
  after: true,
  hookTimeoutMs: true,
  stash: true,
  stashOnFailure: true,
  monitor: true,
});
export type DelegateRequestOptions = z.infer<
  typeof DelegateRequestOptionsSchema
>;

export const DelegateRequestSchema = z
  .object({
    $schema: z.literal(DELEGATE_CONTRACT),
    version: z.literal(1),
    /** The local cairn that wrote the request. */
    cairnVersion: z.string().min(1),
    /** The local invocation (its journal is `journalDirLocal`). */
    invocationId: z.string().min(1),
    createdAt: IsoTimestampSchema,
    /** The delegating environment (the alias target when `--env` named an alias). */
    env: z.string().min(1),
    envAlias: z.string().min(1).optional(),
    /** Absolute local paths: the config and its directory. */
    configPath: z.string().min(1),
    configDir: z.string().min(1),
    /** `cairn run --suite <name>`: run the suite by name on the remote side. */
    suite: z.string().min(1).optional(),
    /**
     * The specs to run, relative to the config directory (POSIX separators).
     * A spec the local environment policy refused is never among them.
     */
    specs: z.array(z.string().min(1)),
    /**
     * The runs the runner must settle: the local plan (specs × repeat/matrix
     * iterations), spec paths relative. A locally refused spec's entries are
     * under `refused` instead, so indexes may have gaps.
     */
    planned: z.array(InvocationPlannedRunSchema),
    /**
     * Planned runs the local environment policy refused: they must not run
     * on the remote side (a relayed run of one is a `refused-run` error).
     * Present only when the policy refused something. Additive.
     */
    refused: z
      .array(
        z
          .object({
            index: z.number().int().positive(),
            spec: z.string().min(1),
            reason: z.string().min(1),
          })
          .strict(),
      )
      .optional(),
    /** The run options as the caller gave them (portable; no paths). */
    options: DelegateRequestOptionsSchema,
    /** What the local resolution made of them (suite vars, labels, bail, parallel). */
    resolved: z
      .object({
        vars: z.record(z.string(), z.string()),
        labels: z.record(z.string(), z.string()),
        bail: z.boolean(),
        parallel: z.number().int().positive(),
        tags: z.array(z.string()).optional(),
      })
      .strict(),
    /** `--run-token`, only when the caller pinned one. */
    runToken: z.string().min(1).optional(),
    /**
     * Arguments of the remote `cairn` command, without `--env` (the runner
     * picks the remote environment): `run`, the suite and/or the specs (the
     * explicit spec list, narrowing the suite, whenever the local policy
     * refused a spec), the portable options, and `--label
     * cairn.delegate=<invocationId>` — every copied run.json must carry that
     * label (v1 conformance).
     */
    cairnArgs: z.array(z.string()),
    /** Where run directories go: `<artifactRootLocal>/<runId>/`. */
    artifactRootLocal: z.string().min(1),
    /** The local invocation journal (read-only for the runner). */
    journalDirLocal: z.string().min(1),
    /** Same as CAIRN_DELEGATE_EVENTS. */
    eventsPath: z.string().min(1),
    timeoutMs: z.number().int().positive().optional(),
    /** `runner.idleTimeoutMs`: the longest silence of the events stream. Additive. */
    idleTimeoutMs: z.number().int().positive().optional(),
    cancelGraceMs: z.number().int().nonnegative(),
  })
  .strict();
export type DelegateRequest = z.infer<typeof DelegateRequestSchema>;

/**
 * `--services-dry-run` / `--select-only` on a runner environment: what would
 * be spawned, with secrets masked, and nothing spawned.
 */
export const DelegatePlanSchema = z
  .object({
    contract: z.literal(DELEGATE_CONTRACT),
    env: z.string().min(1),
    /** The runner argv (masked). */
    command: z.array(z.string()),
    cwd: z.string().min(1),
    /** Names of `runner.env` entries (values are never shown). */
    envNames: z.array(z.string()),
    timeoutMs: z.number().int().positive().optional(),
    idleTimeoutMs: z.number().int().positive().optional(),
    cancelGraceMs: z.number().int().nonnegative(),
    /** The request the runner would read (masked; local paths are placeholders). */
    request: z.record(z.string(), z.unknown()),
  })
  .strict();
export type DelegatePlan = z.infer<typeof DelegatePlanSchema>;

/** Environment variables cairn sets for the runner. */
export const DELEGATE_ENV = {
  request: "CAIRN_DELEGATE_REQUEST",
  events: "CAIRN_DELEGATE_EVENTS",
  contract: "CAIRN_DELEGATE_CONTRACT",
  invocationId: "CAIRN_INVOCATION_ID",
  invocationDir: "CAIRN_INVOCATION_DIR",
  artifactRoot: "CAIRN_ARTIFACT_ROOT",
} as const;

/** Default `runner.cancelGraceMs`: time to cancel remotely and copy results back. */
export const DEFAULT_CANCEL_GRACE_MS = 180_000;
/** After SIGTERM, how long before SIGKILL. */
export const CANCEL_TERM_GRACE_MS = 10_000;
/** After SIGKILL, how long cairn still waits for the process to go. */
export const CANCEL_KILL_WAIT_MS = 5_000;
/** A silent events stream is warned about (`idle`) once it is this old. */
export const IDLE_WARN_MS = 300_000;
/** The label every remote run carries (`cairn.delegate=<local invocation id>`). */
export const DELEGATE_LABEL = "cairn.delegate";
