import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { ScriptVerifier } from "../../schema/verifier.v1";
import type { VerifierEvaluation } from "./types";

/**
 * Escape hatch — evaluate a JS expression in the page and expect `{ ok, evidence }`.
 * The agent writes:
 *   ```js
 *   () => { ... return { ok: <bool>, evidence: <anything> }; }
 *   ```
 *
 * Cairntrace wraps the script and evaluates via backend.evaluate(). The full
 * `evidence` value is written to outcomes/<id>.raw.json; a truncated summary
 * goes into outcomes/<id>.md per §13b.
 */
export async function evaluateScript(
  verifier: ScriptVerifier,
  backend: BrowserBackend,
): Promise<VerifierEvaluation> {
  const result = await backend.evaluate(buildScript(verifier));
  if (!result.ok) {
    return {
      passed: false,
      expected: "script returned { ok: true, evidence: ... }",
      actual: `script invocation failed: exitCode=${result.exitCode}, stderr=${truncate(result.stderr, 200)}`,
    };
  }

  let parsed: { ok: boolean; evidence: unknown };
  try {
    parsed = JSON.parse(result.stdout);
  } catch (e) {
    return {
      passed: false,
      expected: "script returned { ok: true, evidence: ... } as JSON",
      actual: `failed to parse script stdout as JSON: ${(e as Error).message}. stdout=${truncate(result.stdout, 200)}`,
    };
  }

  return {
    passed: Boolean(parsed.ok),
    expected: "script ok === true",
    actual: parsed.ok ? "script returned ok=true" : "script returned ok=false",
    raw: parsed.evidence,
  };
}

function buildScript(verifier: ScriptVerifier): string {
  const fixtures = JSON.stringify(verifier.script.fixtures ?? {});
  // The user's `run` body should `return { ok, evidence }`. We wrap it in a
  // function call so the body can use `return` statements; agent-browser's
  // `eval` then auto-stringifies the returned object as JSON.
  return [
    `(function(){`,
    `  const fixtures = ${fixtures};`,
    `  return (function(){`,
    verifier.script.run,
    `  })();`,
    `})()`,
  ].join("\n");
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
