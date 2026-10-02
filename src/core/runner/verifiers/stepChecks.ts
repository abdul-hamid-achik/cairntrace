import type { ArtifactWriter } from "../../artifacts/ArtifactWriter";
import { isSensitiveName } from "../../catalog/mask";
import type { CaptureStep, ExpectStep } from "../../schema/spec.v1";
import { boundValue } from "./evidence";
import { runCapture, runExpect, type StepCheckDeps } from "./expect";

/**
 * Runner glue for `expect` / `capture` steps: evidence files + events.
 * Kept out of Runner.ts so the step loop only dispatches.
 */

type StepWriter = Pick<ArtifactWriter, "writeJson" | "appendEvent">;

export interface StepCheckOutcome {
  ok: boolean;
  error?: string;
  /** Run-relative evidence files written by the step. */
  artifacts: string[];
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "expect";
}

/** Minimum length of a captured value registered as a secret ("1" is not one). */
const MIN_CAPTURED_SECRET_CHARS = 6;

/** String leaves of a captured value long enough to redact safely. */
function secretStrings(value: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8) return;
    if (typeof node === "string") {
      if (node.trim().length >= MIN_CAPTURED_SECRET_CHARS) out.push(node);
      return;
    }
    if (Array.isArray(node)) node.forEach((child) => walk(child, depth + 1));
    else if (node && typeof node === "object") {
      for (const child of Object.values(node)) walk(child, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

export async function executeExpectStep(input: {
  step: ExpectStep;
  stepId: string;
  /** 1-based step index (evidence file prefix). */
  index: number;
  writer: StepWriter;
  deps: StepCheckDeps;
}): Promise<StepCheckOutcome> {
  const expectId = input.step.expect.id ?? input.stepId;
  const path = `expects/${pad(input.index)}_${slug(expectId)}.json`;
  const result = await runExpect(input.step.expect, input.deps);
  await input.writer.writeJson(
    path,
    {
      version: 1,
      id: expectId,
      stepId: input.stepId,
      status: result.passed ? "passed" : "failed",
      kind: result.kind,
      expected: result.expected,
      actual: result.actual,
      attempts: result.attempts,
      durationMs: result.durationMs,
      ...(result.observed !== undefined ? { observed: result.observed } : {}),
    },
    "expect",
  );
  await input.writer.appendEvent({
    ts: new Date().toISOString(),
    type: result.passed ? "expect.passed" : "expect.failed",
    stepId: input.stepId,
    expectId,
    kind: result.kind || "expect",
    path,
    attempts: result.attempts,
    durationMs: Math.max(0, Math.round(result.durationMs)),
    expected: result.expected,
    actual: result.actual,
  });
  return result.passed
    ? { ok: true, artifacts: [path] }
    : {
        ok: false,
        error: `expect ${expectId}: expected ${result.expected}; got ${result.actual}`,
        artifacts: [path],
      };
}

export async function executeCaptureStep(input: {
  step: CaptureStep;
  writer: StepWriter;
  deps: StepCheckDeps;
  /** `${captures.*}` store; the value lands here on success. */
  captures: Record<string, unknown>;
  /**
   * Called before any evidence is written with the string values of a
   * capture whose `assign` names a credential (`apiToken`, `csrfToken`), so
   * the run's redactor scrubs them from every artifact.
   */
  registerSecrets?: (values: string[]) => void;
}): Promise<StepCheckOutcome> {
  const result = await runCapture(input.step.capture, input.deps);
  if (!result.ok) return { ok: false, error: result.error, artifacts: [] };
  input.captures[result.assign] = result.value;
  if (input.registerSecrets && isSensitiveName(result.assign)) {
    input.registerSecrets(secretStrings(result.value));
  }
  const path = `captures/${slug(result.assign)}.json`;
  await input.writer.writeJson(
    path,
    {
      version: 1,
      assign: result.assign,
      kind: result.kind,
      value: boundValue(result.value, 256 * 1024).value,
    },
    "capture",
  );
  return { ok: true, artifacts: [path] };
}
