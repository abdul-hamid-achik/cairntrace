import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { ArtifactRef } from "../../../adapters/browserBackend";
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
  /** Named video clips produced by vidtrace from the run video. */
  clips?: Record<string, string>;
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
  /** Config-resolved baseUrl for relative browser-side HTTP checks. */
  baseUrl?: string;
  /**
   * Resolved config/CLI vars for the active environment. Exposed to script
   * verifiers as `ctx.vars` (Node) / `vars` (browser) so each var doesn't
   * have to be threaded through per-outcome fixtures maps.
   */
  vars?: Record<string, string | number | boolean>;
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
  /** Deep / unstructured data — written to outcomes/<id>.raw.json (script verifier only). */
  raw?: unknown;
}

export type VerifierEvaluator = (
  verifier: Verifier,
  backend: BrowserBackend,
  ctx: VerifierContext,
) => Promise<VerifierEvaluation>;
