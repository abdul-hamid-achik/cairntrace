import { probeScriptParts } from "../runner/verifiers/domProbe";
import { inlineRuntimeModule } from "./runtimeSources";

/**
 * Runtime helpers of the export-v2 coverage: the page probe behind `capture`
 * steps, the polled-outcome helper, and the fixture outputs a global setup
 * hands to the tests. Single-file exports inline only what they call (a
 * leftover helper fails `noUnusedLocals`); `--project` writes them to
 * `lib/probe.ts`, `lib/poll.ts` and `lib/fixtureOutputs.ts`.
 */
type ExportLang = "ts" | "js";

function annotate(lang: ExportLang): (annotation: string) => string {
  return (annotation) => (lang === "ts" ? annotation : "");
}

/**
 * `cairnCapture`: the in-page probe `cairn run` reads `capture` targets with
 * (the script text is embedded; the locator travels as a run-time JSON
 * literal), the same single-target rule, and `capture.table` shaping.
 */
export function renderProbeHelperLines(
  lang: ExportLang,
  opts: { exported?: boolean; capture?: boolean; table?: boolean } = {},
): string[] {
  const t = annotate(lang);
  const exp = opts.exported ? "export " : "";
  // A standalone file inlines only what it calls (noUnusedLocals); the
  // `lib/probe` module exports everything.
  const capture = opts.capture === true || opts.exported === true;
  const table = opts.table === true || opts.exported === true;
  const parts = probeScriptParts();
  const lines: string[] = [
    `// Cairntrace page probe (capture / table): the same in-page resolver \`cairn run\` uses.`,
    `const CAIRN_PROBE_PREFIX = ${JSON.stringify(parts.prefix)};`,
    `const CAIRN_PROBE_SUFFIX = ${JSON.stringify(parts.suffix)};`,
    ``,
  ];
  if (lang === "ts") {
    lines.push(
      `interface CairnProbeMatch {`,
      `  visible: boolean;`,
      `  text: string;`,
      `  value: string | null;`,
      `  attribute: string | null;`,
      `  tag: string;`,
      `}`,
      ``,
      `${exp}interface CairnTable {`,
      `  headers: string[];`,
      `  rows: string[][];`,
      `  rowCount: number;`,
      `}`,
      ``,
      `interface CairnProbeResult {`,
      `  poolCount: number;`,
      `  matches: CairnProbeMatch[];`,
      `  nthMatch?: CairnProbeMatch | null;`,
      `  table?: CairnTable | null;`,
      `  error?: string;`,
      `}`,
      ``,
      `${exp}interface CairnCaptureOptions {`,
      `  timeoutMs: number;`,
      `  includeHidden: boolean;`,
      `  attribute?: string;`,
      `  testIdAttribute?: string;`,
      `}`,
      ``,
    );
  }
  lines.push(
    `function cairnDescribeLocator(locator${t(": Record<string, unknown>")})${t(": string")} {`,
    `  const by = String(locator.by);`,
    `  const base = by === "role" ? "role=" + String(locator.role) + (locator.name !== undefined ? " " + JSON.stringify(locator.name) : "") : by === "label" ? "label " + JSON.stringify(locator.name) : by === "text" ? "text " + JSON.stringify(locator.text) : by === "selector" ? String(locator.selector) : "testid " + String(locator.testid);`,
    `  const extra = [`,
    `    typeof locator.nth === "number" ? "nth " + locator.nth : "",`,
    `    locator.near ? "near " + JSON.stringify(locator.near) : "",`,
    `    locator.hasText ? "hasText " + JSON.stringify(locator.hasText) : "",`,
    `  ].filter(Boolean);`,
    `  return extra.length > 0 ? base + " (" + extra.join(", ") + ")" : base;`,
    `}`,
    ``,
    `async function cairnProbe(`,
    `  page${t(": Page")},`,
    `  locator${t(": Record<string, unknown>")},`,
    `  options${t(": CairnCaptureOptions")},`,
    `  table${t(": boolean")},`,
    `)${t(": Promise<CairnProbeResult>")} {`,
    `  const config = {`,
    `    locator,`,
    `    testIdAttribute: options.testIdAttribute ?? "data-testid",`,
    `    attribute: options.attribute ?? null,`,
    `    table,`,
    `    includeHidden: options.includeHidden,`,
    `  };`,
    `  const probe = (await page.evaluate(CAIRN_PROBE_PREFIX + JSON.stringify(config) + CAIRN_PROBE_SUFFIX))${t(" as CairnProbeResult")};`,
    `  if (probe && typeof probe.error === "string") throw new Error(probe.error);`,
    `  return probe;`,
    `}`,
    ``,
  );
  if (capture) {
    lines.push(
      `/** The single target of a locator: pool[nth], or the only (visible) match. */`,
      `function cairnSingleTarget(`,
      `  probe${t(": CairnProbeResult")},`,
      `  locator${t(": Record<string, unknown>")},`,
      `)${t(": { match?: CairnProbeMatch; error?: string }")} {`,
      `  const described = cairnDescribeLocator(locator);`,
      `  if (typeof locator.nth === "number") {`,
      `    return probe.nthMatch ? { match: probe.nthMatch } : { error: "nth " + locator.nth + " is out of range: " + probe.poolCount + " match(es) for " + described };`,
      `  }`,
      `  if (probe.poolCount === 0) return { error: "no element matches " + described };`,
      `  if (probe.poolCount === 1) return { match: probe.matches[0]${t("!")} };`,
      `  const visible = probe.matches.filter((match) => match.visible);`,
      `  if (visible.length === 1 && probe.poolCount <= probe.matches.length) return { match: visible[0]${t("!")} };`,
      `  return { error: probe.poolCount + " elements match " + described + "; add nth (0-based) or a more specific locator" };`,
      `}`,
      ``,
      `/** capture.table: \`{ headers, rows: [{ header: cell }], cells, rowCount }\`. */`,
      `function cairnTableCapture(table${t(": CairnTable")})${t(": Record<string, unknown>")} {`,
      `  const headers = table.headers.map((header, index) => (header.length > 0 ? header : "column" + (index + 1)));`,
      `  const rows = table.rows.map((cells) => {`,
      `    const row${t(": Record<string, string>")} = {};`,
      `    cells.forEach((cell, index) => {`,
      `      row[headers[index] ?? "column" + (index + 1)] = cell;`,
      `    });`,
      `    return row;`,
      `  });`,
      `  return { headers: table.headers, rows, cells: table.rows, rowCount: table.rowCount };`,
      `}`,
      ``,
      `/** A capture step: retry every 250ms until the target resolves or the budget is spent. */`,
      `${exp}async function cairnCapture(`,
      `  page${t(": Page")},`,
      `  kind${t(': "text" | "value" | "attribute" | "table"')},`,
      `  locator${t(": Record<string, unknown>")},`,
      `  options${t(": CairnCaptureOptions")},`,
      `)${t(": Promise<unknown>")} {`,
      `  const started = Date.now();`,
      `  let last = "no attempt";`,
      `  for (;;) {`,
      `    try {`,
      `      const probe = await cairnProbe(page, locator, options, kind === "table");`,
      `      if (kind === "table") {`,
      `        if (probe.table) return cairnTableCapture(probe.table);`,
      `        last = "no element matches " + cairnDescribeLocator(locator);`,
      `      } else {`,
      `        const target = cairnSingleTarget(probe, locator);`,
      `        if (!target.match) {`,
      `          last = target.error ?? "no target";`,
      `        } else {`,
      `          const value = kind === "text" ? target.match.text : kind === "value" ? target.match.value : target.match.attribute;`,
      `          if (kind === "value" && value === null) last = cairnDescribeLocator(locator) + " is not a form control (" + target.match.tag + ")";`,
      `          else return value;`,
      `        }`,
      `      }`,
      `    } catch (error) {`,
      `      last = error instanceof Error ? error.message : String(error);`,
      `    }`,
      `    const elapsed = Date.now() - started;`,
      `    if (elapsed >= options.timeoutMs) throw new Error("capture " + kind + ": " + last);`,
      `    await page.waitForTimeout(Math.min(250, options.timeoutMs - elapsed));`,
      `  }`,
      `}`,
      ``,
    );
  }
  if (table) {
    if (lang === "ts") {
      lines.push(
        `${exp}interface CairnTableSpec {`,
        `  rows?: { equals?: number; atLeast?: number; atMost?: number; noBlank?: boolean; ignoreCells?: string[] };`,
        `  headers?: { includes: string[]; inOrder?: boolean };`,
        `  contains?: Array<string | Record<string, string>>;`,
        `}`,
        ``,
      );
    }
    lines.push(
      `/** The \`table\` verifier's read: wait (every 250ms) for the rendered table, then return it. */`,
      `${exp}async function cairnReadTable(`,
      `  page${t(": Page")},`,
      `  locator${t(": Record<string, unknown>")},`,
      `  options${t(": CairnCaptureOptions")},`,
      `)${t(": Promise<CairnTable>")} {`,
      `  const started = Date.now();`,
      `  for (;;) {`,
      `    const probe = await cairnProbe(page, locator, options, true);`,
      `    if (probe.table) return probe.table;`,
      `    if (Date.now() - started >= options.timeoutMs) {`,
      `      throw new Error("no table found within " + options.timeoutMs + "ms at " + cairnDescribeLocator(locator));`,
      `    }`,
      `    await page.waitForTimeout(Math.min(250, options.timeoutMs));`,
      `  }`,
      `}`,
      ``,
      // The checks are Cairntrace's own table judge — the module `cairn run`
      // runs, vendored here (drift-tested in runtimeSources), not a
      // re-implementation. Dependencies first, as the data glue inlines them.
      ...[
        inlineRuntimeModule("textMatching", lang),
        inlineRuntimeModule("tableJudge", lang),
      ].map((source) => `${source}\n`),
      `/** The \`table\` verifier's checks against the probe's table: the failures, [] when it holds. */`,
      `${exp}function cairnJudgeTable(table${t(": CairnTable")}, spec${t(": CairnTableSpec")})${t(": string[]")} {`,
      `  const verdict = judgeTable(spec, table, "table");`,
      `  return verdict.passed ? [] : [verdict.actual];`,
      `}`,
      ``,
    );
  }
  return lines;
}

export function renderProbeRuntime(lang: ExportLang): string {
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    ...(lang === "ts" ? [`import type { Page } from "@playwright/test";`] : []),
    ``,
    ...renderProbeHelperLines(lang, { exported: true }),
  ].join("\n");
}

/**
 * `cairnPoll`: a verifier `poll` with `stableMs`. Re-run `attempt` every
 * `everyMs` until it holds or `timeoutMs`; green must HOLD for `stableMs`
 * (at least two green samples spanning it; a red sample restarts the window).
 * An attempt that throws is a red sample. Without `stableMs` the export uses
 * Playwright's own `expect(...).toPass({ timeout, intervals })`.
 */
export function renderPollHelperLines(
  lang: ExportLang,
  opts: { exported?: boolean } = {},
): string[] {
  const t = annotate(lang);
  const exp = opts.exported ? "export " : "";
  return [
    `/** Polled outcome with a stability window (verifier \`poll.stableMs\`). */`,
    `${exp}async function cairnPoll(`,
    `  attempt${t(": () => Promise<void>")},`,
    `  options${t(": { timeoutMs: number; everyMs: number; stableMs: number }")},`,
    `)${t(": Promise<void>")} {`,
    `  const deadline = Date.now() + options.timeoutMs;`,
    `  let greenSince${t(": number | undefined")};`,
    `  let greenSamples = 0;`,
    `  let lastError${t(": unknown")};`,
    `  for (;;) {`,
    `    try {`,
    `      await attempt();`,
    `      const now = Date.now();`,
    `      greenSince ??= now;`,
    `      greenSamples += 1;`,
    `      lastError = undefined;`,
    `      if (now - greenSince >= options.stableMs && greenSamples >= 2) return;`,
    `    } catch (error) {`,
    `      greenSince = undefined;`,
    `      greenSamples = 0;`,
    `      lastError = error;`,
    `    }`,
    `    const remaining = deadline - Date.now();`,
    `    if (remaining <= 0) break;`,
    `    const untilStable = greenSince !== undefined ? Math.max(50, greenSince + options.stableMs - Date.now()) : options.everyMs;`,
    `    await new Promise((resolve) => setTimeout(resolve, Math.min(options.everyMs, untilStable, remaining)));`,
    `  }`,
    `  if (lastError !== undefined) throw lastError;`,
    `  throw new Error("polled outcome was green for only " + (greenSince === undefined ? 0 : Date.now() - greenSince) + "ms of the required " + options.stableMs + "ms before the " + options.timeoutMs + "ms deadline");`,
    `}`,
    ``,
  ];
}

export function renderPollRuntime(lang: ExportLang): string {
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    ``,
    ...renderPollHelperLines(lang, { exported: true }),
  ].join("\n");
}

/**
 * `cairnFixtureOutputs`: what the generated global setup recorded for one
 * fixture (`cairn fixtures ensure <name> --json`). It reads the JSON file
 * named by `CAIRN_FIXTURES_FILE` and throws when the fixture or a key the
 * test splices is missing — `cairn run` errors the run the same way, so an
 * output is never silently empty. Secret outputs are never in the file.
 */
export function renderFixtureOutputsHelperLines(
  lang: ExportLang,
  opts: { exported?: boolean } = {},
): string[] {
  const t = annotate(lang);
  const exp = opts.exported ? "export " : "";
  return [
    `/** Outputs of a config fixture the global setup ensured (non-secret keys only). */`,
    `${exp}function cairnFixtureOutputs(name${t(": string")}, keys${t(
      ": string[]",
    )})${t(": Record<string, unknown>")} {`,
    `  const file = process.env.CAIRN_FIXTURES_FILE;`,
    `  if (!file) {`,
    `    throw new Error("fixture " + name + ": CAIRN_FIXTURES_FILE is not set; run through the generated global-setup (export with --preconditions global) or write the outputs of \`cairn fixtures ensure " + name + " --json\` to a file and set CAIRN_FIXTURES_FILE.");`,
    `  }`,
    `  const all = JSON.parse(readFileSync(file, "utf8"))${t(" as Record<string, Record<string, unknown>>")};`,
    `  const outputs = all[name];`,
    `  if (!outputs) throw new Error("fixture " + name + " is not in " + file + " (is it listed in the spec's fixtures:?)");`,
    `  for (const key of keys) {`,
    `    if (!(key in outputs)) throw new Error("fixture " + name + " has no output " + key + " (secret outputs are not exported; available: " + Object.keys(outputs).join(", ") + ")");`,
    `  }`,
    `  return outputs;`,
    `}`,
    ``,
  ];
}

export function renderFixtureOutputsRuntime(lang: ExportLang): string {
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    `import { readFileSync } from "node:fs";`,
    ``,
    ...renderFixtureOutputsHelperLines(lang, { exported: true }),
  ].join("\n");
}
