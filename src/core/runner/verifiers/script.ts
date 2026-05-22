import { readFile } from "node:fs/promises";
import { extname, isAbsolute, resolve } from "node:path";
import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { ScriptVerifier } from "../../schema/verifier.v1";
import type { VerifierContext, VerifierEvaluation } from "./types";

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
  ctx: VerifierContext = {},
): Promise<VerifierEvaluation> {
  const source = await loadScriptSource(verifier, ctx);
  const result = await backend.evaluate(buildScript(verifier, source, ctx));
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

async function loadScriptSource(
  verifier: ScriptVerifier,
  ctx: VerifierContext,
): Promise<string> {
  if (verifier.script.run !== undefined) return verifier.script.run;

  const file = verifier.script.file;
  if (!file) {
    throw new Error("script verifier must define either run or file");
  }
  const abs = isAbsolute(file)
    ? file
    : resolve(ctx.specDir ?? process.cwd(), file);
  const source = await readFile(abs, "utf8");
  if (extname(abs) !== ".ts") return source;

  const bun = (
    globalThis as typeof globalThis & {
      Bun?: {
        Transpiler?: new (opts: {
          loader: "ts";
        }) => {
          transformSync(source: string): string;
        };
      };
    }
  ).Bun;
  if (!bun?.Transpiler) {
    throw new Error(
      `script.file uses TypeScript but Bun.Transpiler is unavailable: ${file}`,
    );
  }
  return new bun.Transpiler({ loader: "ts" }).transformSync(source);
}

function buildScript(
  verifier: ScriptVerifier,
  source: string,
  ctx: VerifierContext,
): string {
  const fixtures = JSON.stringify(resolveRuntimeFixtures(verifier, ctx));
  const artifacts = JSON.stringify(ctx.artifacts ?? {});
  // The user's `run` body should `return { ok, evidence }`. We wrap it in a
  // function call so the body can use `return` statements; agent-browser's
  // `eval` then auto-stringifies the returned object as JSON.
  return [
    `(function(){`,
    `  const fixtures = ${fixtures};`,
    `  const artifacts = ${artifacts};`,
    `  return (function(){`,
    source,
    `  })();`,
    `})()`,
  ].join("\n");
}

function resolveRuntimeFixtures(
  verifier: ScriptVerifier,
  ctx: VerifierContext,
): Record<string, string> {
  const input = verifier.script.fixtures ?? {};
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input)) {
    output[key] = value
      .replace(
        /\$\{artifacts\.([a-z][a-z0-9_]*)\.path\}/g,
        (_match, name: string) => ctx.artifacts?.[name]?.path ?? "",
      )
      .replace(
        /\$\{artifacts\.([a-z][a-z0-9_]*)\.relativePath\}/g,
        (_match, name: string) => ctx.artifacts?.[name]?.relativePath ?? "",
      );
  }
  return output;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}…`;
}
