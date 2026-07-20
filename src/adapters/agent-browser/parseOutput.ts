import type { AgentBrowserOptions } from "./types";

/**
 * Pure parsers + arg-builders for the agent-browser adapter. Extracted so
 * the logic can be unit-tested without spawning a real subprocess.
 */

/**
 * agent-browser wraps JSON results in `{ success, data: { <key>: [...] }, error }`.
 * Pull the inner array out by key.
 *
 * Throws on anything that isn't a well-formed envelope. A successful `--json`
 * command always emits the envelope with its key present — an empty result is
 * `{"data":{"messages":[]}}`, never blank stdout — so unreadable output means
 * the read did not happen. Every caller feeds a verdict, and the verdicts are
 * absence-shaped: `console.errorsMax` and `noFailedRequests` both read an empty
 * set as a PASS, so returning [] here would certify a page nobody read as
 * healthy. Crashing the verifier is the point: the Runner and OutcomeEvaluator
 * turn a throw into a failed step/outcome with this message attached.
 */
export function parseEnvelope<T>(stdout: string, key: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(
      `expected a JSON envelope containing ${JSON.stringify(key)}, got empty output`,
    );
  }
  let parsed: { success?: boolean; data?: Record<string, unknown> };
  try {
    parsed = JSON.parse(trimmed) as {
      success?: boolean;
      data?: Record<string, unknown>;
    };
  } catch (e) {
    throw new Error(
      `could not parse the JSON envelope for ${JSON.stringify(key)}: ${
        (e as Error).message
      } (output: ${JSON.stringify(trimmed.slice(0, 120))})`,
      { cause: e },
    );
  }
  const inner = parsed?.data?.[key];
  if (!Array.isArray(inner)) {
    throw new Error(
      `the JSON envelope has no ${JSON.stringify(key)} array (got ${JSON.stringify(
        inner === undefined ? "nothing" : inner,
      ).slice(0, 80)})`,
    );
  }
  return inner as T[];
}

/**
 * Generic "the stdout is just a JSON array" parser. Used for commands that
 * don't wrap their output in the {success, data} envelope.
 */
export function parseJsonArray<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

export interface ElementBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Parse `get box @ref --json` output: `{ success, data: { x, y, width, height }, error }`. */
export function parseBoxEnvelope(stdout: string): ElementBox | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as {
      success?: boolean;
      data?: Partial<Record<keyof ElementBox, unknown>>;
    };
    const d = parsed?.data;
    if (
      d &&
      typeof d.x === "number" &&
      typeof d.y === "number" &&
      typeof d.width === "number" &&
      typeof d.height === "number"
    ) {
      return { x: d.x, y: d.y, width: d.width, height: d.height };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export interface ViewportMetrics {
  scrollX: number;
  scrollY: number;
  innerWidth: number;
  innerHeight: number;
}

/**
 * Parse `eval <js> --json` output for a JS object result:
 * `{ success, data: { origin, result: { scrollX, scrollY, innerWidth, innerHeight } }, error }`.
 */
export function parseViewportMetrics(
  stdout: string,
): ViewportMetrics | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as {
      success?: boolean;
      data?: { result?: Partial<Record<keyof ViewportMetrics, unknown>> };
    };
    const r = parsed?.data?.result;
    if (
      r &&
      typeof r.scrollX === "number" &&
      typeof r.scrollY === "number" &&
      typeof r.innerWidth === "number" &&
      typeof r.innerHeight === "number"
    ) {
      return {
        scrollX: r.scrollX,
        scrollY: r.scrollY,
        innerWidth: r.innerWidth,
        innerHeight: r.innerHeight,
      };
    }
    return undefined;
  } catch {
    return undefined;
  }
}

/** Build the agent-browser global-flag argv from the adapter options. */
export function buildGlobalArgs(opts: AgentBrowserOptions): string[] {
  const a: string[] = [];
  if (opts.headed) a.push("--headed");
  if (opts.profile) a.push("--profile", opts.profile);
  if (opts.initialStatePath) a.push("--state", opts.initialStatePath);
  if (opts.screenshotDir) a.push("--screenshot-dir", opts.screenshotDir);
  if (opts.maxOutput !== undefined)
    a.push("--max-output", String(opts.maxOutput));
  if (opts.debug) a.push("--debug");
  if (opts.provider) a.push("-p", opts.provider);
  if (opts.device) a.push("--device", opts.device);
  if (opts.extraGlobalArgs) a.push(...opts.extraGlobalArgs);
  return a;
}

/**
 * `agent-browser batch` takes positional command strings which it parses
 * with its own shell-like splitter. Args containing whitespace, quotes, or
 * backslashes need quoting + escaping to survive that pass.
 */
export function quoteIfNeeded(s: string): string {
  if (!/[\s"\\]/.test(s)) return s;
  return `"${s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}
