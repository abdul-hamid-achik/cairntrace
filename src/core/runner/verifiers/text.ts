import type { BrowserBackend } from "../../../adapters/browserBackend";
import {
  textVerifierRegion,
  type TextMatcher,
  type TextVerifier,
} from "../../schema/verifier.v1";
import type { VerifierEvaluation } from "./types";

export async function evaluateText(
  verifier: TextVerifier,
  backend: BrowserBackend,
): Promise<VerifierEvaluation> {
  const region = textVerifierRegion(verifier);
  const haystack = await backend.getText(region);
  const { expected, passed } = matchText(haystack, verifier.text);
  return {
    passed,
    expected: `text ${expected} in region ${JSON.stringify(region)}`,
    actual: passed
      ? `match found in region ${JSON.stringify(region)}`
      : `not found. region text was: ${truncate(haystack, 200)}`,
  };
}

/** Shared between text and notText. */
export function matchText(
  haystack: string,
  m: TextMatcher,
): { passed: boolean; expected: string } {
  if (m.equals !== undefined) {
    return {
      passed: haystack === m.equals,
      expected: `equals ${JSON.stringify(m.equals)}`,
    };
  }
  if (m.contains !== undefined) {
    return {
      passed: haystack.includes(m.contains),
      expected: `contains ${JSON.stringify(m.contains)}`,
    };
  }
  if (m.matches !== undefined) {
    const re = new RegExp(m.matches);
    return {
      passed: re.test(haystack),
      expected: `matches /${m.matches}/`,
    };
  }
  // Unreachable: zod refine guarantees exactly one matcher key.
  return { passed: false, expected: "<invalid matcher>" };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return JSON.stringify(s);
  return `${JSON.stringify(s.slice(0, max))}… (${s.length - max} more chars)`;
}
