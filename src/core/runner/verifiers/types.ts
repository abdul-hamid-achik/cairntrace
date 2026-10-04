import type { BrowserBackend } from "../../../adapters/browserBackend";
import type {
  ArtifactRef,
  ConsoleEntry,
  NetworkEntry,
} from "../../../adapters/browserBackend";
import type { EnvironmentDatasourceSet } from "../../datasources/resolve";
import type { MongoDriverModule } from "../../datasources/mongo";
import type { ProcessMetricsSummary } from "../../monitor/processSampler";
import type { Verifier } from "../../schema/verifier.v1";

/**
 * Common context passed into every verifier evaluator.
 * The Source section of evidence files is built from these fields.
 */
export interface VerifierContext {
  /** Last step id that ran successfully — used for the "last successful step" line in evidence. */
  lastSuccessfulStep?: string;
  /**
   * Id of the step the run stopped at, when a step failed. Outcomes whose
   * verifier references artifacts/responses that step (or a later one) never
   * produced are reported as blocked (`skipped`) instead of failing on a
   * missing file.
   */
  failedStep?: string;
  /** Relative path to the most recent screenshot captured. */
  latestScreenshot?: string;
  /** Relative path to the most recent snapshot captured. */
  latestSnapshot?: string;
  /** Relative path to a trace artifact, if one was captured. */
  trace?: string;
  /** Relative path to a video artifact, if one was captured. */
  video?: string;
  /** Relative path to diagnostics captured after the latest failed step/outcome. */
  latestDiagnostics?: string;
  /** Absolute run directory for resolving relative artifact paths. */
  runDir?: string;
  /** Absolute spec directory for resolving script.file and fixture paths. */
  specDir?: string;
  /** Named artifacts produced by steps, e.g. download.assign. */
  artifacts?: Record<string, ArtifactRef>;
  /** Captured request-step responses, for ${requests.<name>.…} in fixtures. */
  responses?: Record<string, unknown>;
  /** Captured eval-step return values, for ${evals.<name>.…} in fixtures. */
  evals?: Record<string, unknown>;
  /**
   * The exact end-of-steps network snapshot persisted in
   * network/requests.ndjson. Network verdicts reuse it so a request cannot
   * change from pending to complete between artifact capture and evaluation.
   */
  networkEntries?: NetworkEntry[];
  /**
   * Page errors + console.error entries captured once before outcomes.
   * When set (including `[]`), the console verifier must not re-hit the
   * daemon. Absent means unit tests / callers that still go through
   * `backend.getErrors()`.
   */
  consoleErrors?: ConsoleEntry[];
  /**
   * Why the pre-outcome console snapshot was not taken (wedged backend or
   * a failed `getErrors()`). The console verifier fails closed on this
   * instead of treating a missing log as "0 errors".
   */
  consoleUnavailable?: string;
  /** Config-resolved baseUrl for relative browser-side HTTP checks. */
  baseUrl?: string;
  /**
   * Resolved config/CLI vars for the active environment. Exposed to script
   * verifiers as `ctx.vars` (Node) / `vars` (browser) so each var doesn't
   * have to be threaded through per-outcome fixtures maps.
   */
  vars?: Record<string, unknown>;
  /** Environment authorized for Node verifier children; never exposed on ctx. */
  childEnv?: Record<string, string | undefined>;
  /** TinyVault-prefixed keys explicitly selected for target children. */
  selectedTvaultKeys?: Iterable<string>;
  /**
   * Process metrics collected by the `--monitor` run sampler, for the
   * `process` verifier. Absent when the run wasn't monitored.
   */
  processMetrics?: ProcessMetricsSummary;
  /**
   * Config datasources of the active environment (top-level merged with
   * `environments.<env>.datasources`), for the mongo/temporal/http verifiers.
   */
  datasources?: EnvironmentDatasourceSet;
  /** Active environment name (datasource error messages). */
  envName?: string;
  /**
   * Values captured during the run: `capture` steps and verifier `assign`s.
   * Read as `${captures.<name>…}`. Verifiers with `assign` write here, so
   * later outcomes see earlier ones.
   */
  captures?: Record<string, unknown>;
  /** `network.assign` results, read as `${network.<name>.at}` etc. */
  networkAssigns?: Record<string, NetworkAssignment>;
  /** Fixture outputs, read as `${fixtures.<name>.<key>}` (fixtures registry). */
  fixtureOutputs?: Record<string, Record<string, unknown>>;
  /** `run` step outputs, read as `${runs.<assign>…}`. */
  runOutputs?: Record<string, unknown>;
  /** ISO start of the run, read as `${run.startedAt}`. */
  runStartedAt?: string;
  /** `browser.testIdAttribute` for `by: testid` in table/expect/capture. */
  testIdAttribute?: string;
  /**
   * F20: config `browser.appHandle`, for browser script verifiers that use
   * `__cairn` (the page prelude registers them as `__cairn.app.<name>`).
   */
  appHandles?: Readonly<Record<string, string>>;
  /** Test seam: the optional `mongodb` driver module. */
  loadMongoDriver?: () => Promise<MongoDriverModule | undefined>;
  /** Run cancellation: polling stops and in-flight I/O is aborted. */
  signal?: AbortSignal;
}

import type { NetworkAssignment } from "./networkJudge";
export type { NetworkAssignment };

/** One poll sample, as recorded in `outcomes/<id>.raw.json`. */
export interface PollAttemptRecord {
  at: string;
  ok: boolean;
  summary: string;
}

/**
 * Outcome of a single verifier evaluation. Shapes the §13b evidence file —
 * the artifact writer enforces the 80-line / 20-item caps when serializing.
 */
export interface VerifierEvaluation {
  passed: boolean;
  /**
   * True when the outcome was never actually evaluated because a failed step
   * blocked the artifact/response it depends on. Reported as `skipped` in
   * RunResult — the run already fails on the step, and a bogus "missing file"
   * outcome failure would point agents at the wrong culprit.
   */
  skipped?: boolean;
  /** Short, concrete description of what the verifier was looking for. */
  expected: string;
  /** Short description of what was observed. Bullet list as a single string OK. */
  actual: string;
  /**
   * Deep / unstructured data — written to outcomes/<id>.raw.json (script,
   * datasource, value and http verifiers; any verifier evaluated with poll).
   */
  raw?: unknown;
  /** Evaluations performed under `poll` (absent without poll). */
  attempts?: number;
  /** Wall time spent polling, in ms (absent without poll). */
  polledMs?: number;
}

export type VerifierEvaluator = (
  verifier: Verifier,
  backend: BrowserBackend,
  ctx: VerifierContext,
) => Promise<VerifierEvaluation>;
