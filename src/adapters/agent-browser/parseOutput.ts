import type { AgentBrowserOptions } from "./types";

/**
 * Pure parsers + arg-builders for the agent-browser adapter. Extracted so
 * the logic can be unit-tested without spawning a real subprocess.
 */

/**
 * agent-browser wraps JSON results in `{ success, data: { <key>: [...] }, error }`.
 * Pull the inner array out by key. Returns `[]` on any parse failure or
 * mismatch — verifiers should never crash because of an unexpected output shape.
 */
export function parseEnvelope<T>(stdout: string, key: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as {
      success?: boolean;
      data?: Record<string, unknown>;
    };
    const inner = parsed?.data?.[key];
    return Array.isArray(inner) ? (inner as T[]) : [];
  } catch {
    return [];
  }
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
