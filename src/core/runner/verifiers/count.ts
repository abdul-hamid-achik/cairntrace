import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { CountVerifier } from "../../schema/verifier.v1";
import type { VerifierEvaluation } from "./types";

/**
 * Counts elements matching role/selector/text in an optional in_region.
 *
 * v0 simplification: `role` is translated to a CSS attribute selector
 * (`[role=row]`), and `in_region` is prepended as an ancestor selector.
 * `text` is not supported in v0 — agents needing text-based count should use
 * the `script` escape hatch until a real implementation lands.
 */
export async function evaluateCount(
  verifier: CountVerifier,
  backend: BrowserBackend,
): Promise<VerifierEvaluation> {
  const c = verifier.count;
  const selector = buildSelector(c);
  const count = await backend.getCount(selector);

  let expected: string;
  let passed: boolean;

  if (c.equals !== undefined) {
    expected = `exactly ${c.equals} element(s) matching ${JSON.stringify(selector)}`;
    passed = count === c.equals;
  } else if (c.atLeast !== undefined) {
    expected = `at least ${c.atLeast} element(s) matching ${JSON.stringify(selector)}`;
    passed = count >= c.atLeast;
  } else if (c.atMost !== undefined) {
    expected = `at most ${c.atMost} element(s) matching ${JSON.stringify(selector)}`;
    passed = count <= c.atMost;
  } else if (c.between !== undefined) {
    const [lo, hi] = c.between;
    expected = `between ${lo} and ${hi} element(s) matching ${JSON.stringify(selector)}`;
    passed = count >= lo && count <= hi;
  } else {
    expected = "<invalid count matcher>";
    passed = false;
  }

  return {
    passed,
    expected,
    actual: `observed ${count} element(s)`,
  };
}

function buildSelector(c: CountVerifier["count"]): string {
  const parts: string[] = [];
  if (c.in_region) parts.push(c.in_region);
  if (c.selector) {
    parts.push(c.selector);
  } else if (c.role) {
    parts.push(`[role=${cssEscape(c.role)}]`);
  } else if (c.text) {
    // v0: text-based count isn't a real CSS query. Use a sentinel the backend
    // can opt to interpret; otherwise treat as "match nothing" and let evidence say so.
    parts.push(`*:not(*)`);
  }
  return parts.length > 0 ? parts.join(" ") : "*:not(*)";
}

function cssEscape(s: string): string {
  // Minimal CSS attribute-value escape (no quotes; simple alphanumerics common for role names).
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}
