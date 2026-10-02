import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { ValueVerifier } from "../../schema/verifier.v1";
import { resolveRuntimeFilePath } from "../runtimePlaceholders";
import { boundValue } from "./evidence";
import { matchPaths, summarizeReport } from "./matchers";
import type { PollRunner } from "./mongo";
import { resolveRefsDeep } from "./refs";
import type { VerifierContext, VerifierEvaluation } from "./types";

/**
 * `value` verifier: path matchers over a value the run already holds
 * (`actual`) or a JSON/text file (`file`). Replaces script verifiers that
 * only re-read `evals/*.json` or `requests/*.json` and compare fields.
 */
export async function evaluateValue(
  verifier: ValueVerifier,
  ctx: VerifierContext,
  run: PollRunner,
): Promise<VerifierEvaluation> {
  const spec = verifier.value;
  const source =
    spec.file !== undefined
      ? `file ${spec.file}`
      : typeof spec.actual === "string"
        ? spec.actual
        : "value";
  // Matcher operands may hold runtime references too (`rows[0].SKU:
  // "${fixtures.demo_product.sku}"`); a whole reference keeps its type.
  const expectation = resolveRefsDeep(spec.expect, ctx);
  if (expectation.missing.length > 0) {
    return {
      passed: false,
      expected: `${source}: expectations with resolved references`,
      actual: `unresolved ${expectation.missing.join(", ")}`,
      raw: { kind: "value", request: { expect: spec.expect } },
    };
  }
  let observed: unknown;
  let observedSet = false;
  const polled = await run(async () => {
    let actual: unknown;
    if (spec.file !== undefined) {
      const resolved = resolveRuntimeFilePath(spec.file, {
        ...(ctx.artifacts ? { artifacts: ctx.artifacts } : {}),
        ...(ctx.runDir ? { runDir: ctx.runDir } : {}),
        ...(ctx.specDir ? { specDir: ctx.specDir } : {}),
      });
      const path = isAbsolute(resolved)
        ? resolved
        : resolve(ctx.specDir ?? process.cwd(), resolved);
      const text = await readFile(path, "utf8");
      try {
        actual = JSON.parse(text);
      } catch {
        actual = text;
      }
    } else {
      const resolved = resolveRefsDeep(spec.actual, ctx);
      if (resolved.missing.length > 0) {
        throw Object.assign(
          new Error(`unresolved ${resolved.missing.join(", ")}`),
          { permanent: true },
        );
      }
      actual = resolved.value;
    }
    observed = actual;
    observedSet = true;
    const report = matchPaths(actual, expectation.value);
    const summary = summarizeReport(report);
    return {
      passed: report.passed,
      expected: `${source}: ${summary.expected}`,
      actual: summary.actual,
    };
  });
  const bounded = observedSet ? boundValue(observed) : undefined;
  return {
    ...polled,
    raw: {
      kind: "value",
      request: {
        ...(spec.file !== undefined
          ? { file: spec.file }
          : { actual: spec.actual }),
        expect: spec.expect,
      },
      ...(bounded
        ? { observed: { value: bounded.value, truncated: bounded.truncated } }
        : {}),
      ...(polled.attemptLog ? { attempts: polled.attemptLog } : {}),
      ...(polled.polledMs !== undefined ? { polledMs: polled.polledMs } : {}),
    },
  };
}
