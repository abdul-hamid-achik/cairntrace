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
