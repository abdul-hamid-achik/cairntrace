import { readFileSync } from "node:fs";
import { Script } from "node:vm";

/**
 * F20 — the `window.__cairn` page prelude (cairnPrelude.page.js) and the
 * config `browser.appHandle` accessors it registers.
 *
 * The prelude is prepended to page JavaScript that mentions `__cairn` (an
 * eval step, a browser script verifier, an environment-login hydrate
 * script) and to every `wait: { app: … }` probe; sources that do not
 * mention it are sent unchanged. App handle expressions are project code
 * (like eval files): each becomes a getter `function () { return (<expr>); }`
 * written into the page source — never compiled in the page with
 * `new Function`, so a strict CSP does not block it.
 */

/** Config `browser.appHandle`: `{ <name>: <page expression> }`. */
export type AppHandles = Readonly<Record<string, string>>;

/** Source that references the prelude namespace. */
const PRELUDE_REFERENCE = /\b__cairn\b/;

let preludeText: string | undefined;

/** The page function source (comments and indentation dropped). */
export function preludeSource(): string {
  if (preludeText === undefined) {
    const text = readFileSync(
      new URL("./cairnPrelude.page.js", import.meta.url),
      "utf8",
    );
    preludeText = text
      .slice(text.indexOf("function cairnPreludeInstall"))
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//"))
      .join("\n");
  }
  return preludeText;
}

/** True when page JavaScript uses `__cairn` (and so needs the prelude). */
export function usesCairnPrelude(source: string): boolean {
  return PRELUDE_REFERENCE.test(source);
}

/** `{ "store": function () { return (<expr>\n); }, … }` for the installer. */
export function appHandleDefsSource(
  appHandles: AppHandles | undefined,
): string {
  const entries = Object.entries(appHandles ?? {}).map(
    ([name, expression]) =>
      `${JSON.stringify(name)}: function () { return (${expression}\n); }`,
  );
  return `{${entries.join(", ")}}`;
}

/** An expression that installs (or refreshes) `window.__cairn`. */
export function preludeInstallExpression(
  appHandles: AppHandles | undefined,
): string {
  return `(${preludeSource()})(${appHandleDefsSource(appHandles)})`;
}

/**
 * `source` with the prelude installed first when it mentions `__cairn`;
 * unchanged otherwise. The result is still a statement list (a function
 * body), so callers keep their own wrapper.
 */
export function withCairnPrelude(
  source: string,
  appHandles: AppHandles | undefined,
): string {
  if (!usesCairnPrelude(source)) return source;
  return `${preludeInstallExpression(appHandles)};\n${source}`;
}

/**
 * The syntax error of an app handle expression, or undefined when it parses
 * as one expression. Compiled on the host only (never run there).
 */
export function appHandleSyntaxError(expression: string): string | undefined {
  try {
    // Compiled, never run, in the same wrapper the page getter uses.
    // oxlint-disable-next-line no-new
    new Script(`(function () { return (${expression}\n); })`);
    return undefined;
  } catch (error) {
    return (error as Error).message;
  }
}

/** What `wait: { app }` compares the value at `path` with. */
export type AppCheck =
  | { equals: unknown }
  | { in: unknown[] }
  | { exists: boolean };

/** Page answer of an app check. */
export interface AppCheckResult {
  ok: boolean;
  found: boolean;
  /** Bounded JSON preview of the value (never the live object). */
  preview?: string;
  /** Why the handle could not be read (unknown name, getter threw). */
  error?: string;
}

/**
 * Expression that installs the prelude and evaluates one app check:
 * `<handle>.<path…>` against `equals` / `in` / `exists`. Returns an
 * AppCheckResult object.
 */
export function appCheckExpression(
  path: string,
  check: AppCheck,
  appHandles: AppHandles | undefined,
): string {
  return `(${preludeInstallExpression(appHandles)}).__appCheck(${JSON.stringify(path)}, ${JSON.stringify(check)})`;
}

/** The handle name a `wait.app.path` starts with (`store` in `store.user`). */
export function appHandleName(path: string): string {
  return path.replace(/\[\d+\]/g, "").split(".")[0] ?? "";
}

/** Parse an evaluate stdout (raw JSON, or an agent-browser envelope). */
export function parseAppCheckResult(stdout: string): AppCheckResult {
  const parsed = JSON.parse(stdout.trim()) as unknown;
  const value =
    parsed !== null &&
    typeof parsed === "object" &&
    "data" in parsed &&
    (parsed as { data?: { result?: unknown } }).data?.result !== undefined
      ? (parsed as { data: { result: unknown } }).data.result
      : parsed;
  if (value === null || typeof value !== "object" || !("ok" in value)) {
    throw new Error(`unexpected app check result: ${stdout.slice(0, 200)}`);
  }
  return value as AppCheckResult;
}
