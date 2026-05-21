import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { ConsoleVerifier } from "../../schema/verifier.v1";
import type { VerifierEvaluation } from "./types";

export async function evaluateConsole(
  verifier: ConsoleVerifier,
  backend: BrowserBackend,
): Promise<VerifierEvaluation> {
  const errors = await backend.getErrors();
  const max = verifier.console.errorsMax;
  const passed = errors.length <= max;

  const sample = errors.slice(0, 5);
  const sampleLines = sample
    .map(
      (e) =>
        `- [${e.type}] ${e.text}${
          e.location ? ` (${e.location.url}:${e.location.line ?? "?"})` : ""
        }`,
    )
    .join("\n");

  return {
    passed,
    expected: `at most ${max} console error${max === 1 ? "" : "s"}`,
    actual:
      errors.length === 0
        ? "0 errors logged"
        : `${errors.length} error${
            errors.length === 1 ? "" : "s"
          } logged:\n${sampleLines}${
            errors.length > sample.length
              ? `\n…${errors.length - sample.length} more in console/errors.ndjson`
              : ""
          }`,
  };
}
