import type { BrowserBackend } from "../../../adapters/browserBackend";
import {
  notTextVerifierRegion,
  type NotTextVerifier,
} from "../../schema/verifier.v1";
import { matchText } from "./text";
import type { VerifierEvaluation } from "./types";

export async function evaluateNotText(
  verifier: NotTextVerifier,
  backend: BrowserBackend,
): Promise<VerifierEvaluation> {
  const region = notTextVerifierRegion(verifier);

  // Absence-over-a-missing-region is a trap: a typo'd/absent region makes
  // getText return "" and the "text is absent" check passes vacuously, masking
  // a broken assertion. When a specific region is targeted (not the whole-page
  // sentinel), confirm it resolves to an element first. ("page" maps to the
  // body and is not a real selector, so it's always present — skip the check.)
  if (region !== "page") {
    const regionCount = await backend.getCount(region);
    if (regionCount === 0) {
      return {
        passed: false,
        expected: `region ${JSON.stringify(region)} to exist before asserting absence`,
        actual: `region ${JSON.stringify(region)} matched no elements — cannot assert text is absent from a region that isn't there`,
      };
    }
  }

  const haystack = await backend.getText(region);
  const { passed: matchFound, expected } = matchText(
    haystack,
    verifier.notText,
  );
  return {
    passed: !matchFound,
    expected: `no text ${expected} in region ${JSON.stringify(region)}`,
    actual: matchFound
      ? `match WAS present. region text contained the disallowed value.`
      : `not present. confirmed absent in region ${JSON.stringify(region)}`,
  };
}
