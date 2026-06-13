import type { BrowserBackend } from "../../../adapters/browserBackend";
import {
  resolveArtifactPlaceholders,
  resolveResponsePlaceholders,
} from "../runtimePlaceholders";
import { isRelativeUrl, joinUrl, resolveUrl } from "../url";
import type { HttpJsonVerifier } from "../../schema/verifier.v1";
import type { VerifierContext, VerifierEvaluation } from "./types";

export async function evaluateHttpJson(
  verifier: HttpJsonVerifier,
  backend: BrowserBackend,
  ctx: VerifierContext = {},
): Promise<VerifierEvaluation> {
  const spec = verifier.httpJson;
  const url = await resolveHttpUrl(
    resolveRuntimeUrl(spec.url, ctx),
    backend,
    ctx,
  );
  if (!url.ok) {
    return {
      passed: false,
      expected: `GET ${spec.url} as JSON`,
      actual: url.error,
    };
  }

  const fetched = await fetchJson(backend, url.url);
  if (!fetched.ok) return fetched.evaluation;

  const walked = readJsonPath(fetched.body, spec.jsonPath);
  const matched = matchValue(walked.value, walked.exists, spec);

  return {
    passed: matched.passed,
    expected: matched.expected,
    actual: matched.actual,
    raw: {
      url: url.url,
      status: fetched.status,
      jsonPath: spec.jsonPath,
      actual: walked.value,
    },
  };
}

function resolveRuntimeUrl(input: string, ctx: VerifierContext): string {
  return resolveResponsePlaceholders(
    resolveArtifactPlaceholders(input, ctx.artifacts),
    ctx.responses,
  );
}

async function resolveHttpUrl(
  url: string,
  backend: BrowserBackend,
  ctx: VerifierContext,
): Promise<{ ok: true; url: string } | { ok: false; error: string }> {
  if (!isRelativeUrl(url)) return { ok: true, url };
  if (ctx.baseUrl) return { ok: true, url: joinUrl(ctx.baseUrl, url) };
  const currentUrl = await backend.getUrl().catch(() => "about:blank");
  if (currentUrl === "about:blank" || currentUrl.startsWith("about:blank")) {
    return {
      ok: false,
      error: `httpJson: relative URL "${url}" needs a baseUrl (config environments.<env>.baseUrl) or a prior open`,
    };
  }
  return { ok: true, url: resolveUrl(currentUrl, url) };
}

async function fetchJson(
  backend: BrowserBackend,
  url: string,
): Promise<
  | { ok: true; status: number; body: unknown }
  | { ok: false; evaluation: VerifierEvaluation }
> {
  const result = await backend.evaluate(buildFetchScript(url));
  if (!result.ok) {
    return {
      ok: false,
      evaluation: {
        passed: false,
        expected: `GET ${url} as JSON`,
        actual: `httpJson eval failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
      },
    };
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return {
      ok: false,
      evaluation: {
        passed: false,
        expected: `GET ${url} to return JSON`,
        actual: `httpJson returned non-JSON eval output: ${result.stdout.slice(0, 200)}`,
      },
    };
  }

  if (typeof parsed["requestError"] === "string") {
    return {
      ok: false,
      evaluation: {
        passed: false,
        expected: `GET ${url} as JSON`,
        actual: `httpJson request failed: ${parsed["requestError"]}`,
      },
    };
  }

  const status = typeof parsed["status"] === "number" ? parsed["status"] : 0;
  if (status < 200 || status >= 300) {
    return {
      ok: false,
      evaluation: {
        passed: false,
        expected: `GET ${url} to return 2xx JSON`,
        actual: `status ${status}; body ${JSON.stringify(parsed["body"]).slice(0, 300)}`,
        raw: parsed,
      },
    };
  }

  return { ok: true, status, body: parsed["body"] };
}

function buildFetchScript(url: string): string {
  return [
    `(async () => {`,
    `  try {`,
    `    const res = await fetch(${JSON.stringify(url)}, { method: "GET", credentials: "include" });`,
    `    const text = await res.text();`,
    `    let body = null;`,
    `    try { body = JSON.parse(text); } catch (_) { return { status: res.status, ok: res.ok, body: text, parseError: "response was not JSON" }; }`,
    `    return { status: res.status, ok: res.ok, body };`,
    `  } catch (e) {`,
    `    return { requestError: String((e && e.message) || e) };`,
    `  }`,
    `})()`,
  ].join("\n");
}

function readJsonPath(
  value: unknown,
  jsonPath: string,
): { exists: boolean; value: unknown } {
  if (jsonPath === "$") return { exists: true, value };
  const parts = jsonPath.startsWith("$.")
    ? jsonPath.slice(2).split(".")
    : jsonPath.split(".");
  let current = value;
  for (const part of parts) {
    if (part.length === 0) return { exists: false, value: undefined };
    if (current !== null && typeof current === "object" && part in current) {
      current = (current as Record<string, unknown>)[part];
    } else {
      return { exists: false, value: undefined };
    }
  }
  return { exists: true, value: current };
}

function matchValue(
  actual: unknown,
  exists: boolean,
  matcher: HttpJsonVerifier["httpJson"],
): { passed: boolean; expected: string; actual: string } {
  const actualText = JSON.stringify(actual);
  if (matcher.exists !== undefined) {
    return {
      passed: exists === matcher.exists,
      expected: `${matcher.jsonPath} exists to be ${matcher.exists}`,
      actual: exists ? `exists: ${actualText}` : "missing",
    };
  }
  if (!exists) {
    return {
      passed: false,
      expected: `${matcher.jsonPath} to match`,
      actual: "missing",
    };
  }
  if (matcher.equals !== undefined) {
    const expected = matcher.equals;
    return {
      passed: deepEqual(actual, expected),
      expected: `${matcher.jsonPath} equals ${JSON.stringify(expected)}`,
      actual: actualText,
    };
  }
  if (matcher.contains !== undefined) {
    const needle = matcher.contains;
    const passed = Array.isArray(actual)
      ? actual.some((item) => deepEqual(item, needle))
      : String(actual).includes(String(needle));
    return {
      passed,
      expected: `${matcher.jsonPath} contains ${JSON.stringify(needle)}`,
      actual: actualText,
    };
  }
  if (matcher.matches !== undefined) {
    const re = new RegExp(matcher.matches);
    return {
      passed: re.test(String(actual)),
      expected: `${matcher.jsonPath} matches /${matcher.matches}/`,
      actual: actualText,
    };
  }
  if (matcher.atLeast !== undefined) {
    const n = typeof actual === "number" ? actual : Number(actual);
    return {
      passed: Number.isFinite(n) && n >= matcher.atLeast,
      expected: `${matcher.jsonPath} at least ${matcher.atLeast}`,
      actual: actualText,
    };
  }
  const n = typeof actual === "number" ? actual : Number(actual);
  return {
    passed: Number.isFinite(n) && n <= matcher.atMost!,
    expected: `${matcher.jsonPath} at most ${matcher.atMost}`,
    actual: actualText,
  };
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
