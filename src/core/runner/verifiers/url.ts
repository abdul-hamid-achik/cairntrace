import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { UrlVerifier } from "../../schema/verifier.v1";
import type { VerifierEvaluation } from "./types";

export async function evaluateUrl(
  verifier: UrlVerifier,
  backend: BrowserBackend,
): Promise<VerifierEvaluation> {
  const url = await backend.getUrl();
  const m = verifier.url;
  let expected = "";
  let passed = false;

  if (m.equals !== undefined) {
    expected = `equals ${JSON.stringify(m.equals)}`;
    passed = url === m.equals;
  } else if (m.startsWith !== undefined) {
    expected = `startsWith ${JSON.stringify(m.startsWith)}`;
    passed = url.startsWith(m.startsWith);
  } else if (m.endsWith !== undefined) {
    expected = `endsWith ${JSON.stringify(m.endsWith)}`;
    passed = url.endsWith(m.endsWith);
  } else if (m.matches !== undefined) {
    expected = `matches /${m.matches}/`;
    passed = new RegExp(m.matches).test(url);
  }

  return {
    passed,
    expected: `URL ${expected}`,
    actual: `URL was ${JSON.stringify(url)}`,
  };
}
