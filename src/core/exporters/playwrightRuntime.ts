import { preludeInstallExpression, type AppHandles } from "../prelude/prelude";
import { widgetScriptParts, type PreparedWidgets } from "../widgets/runtime";
import type { DataPiece } from "./playwrightRuntimeData";
import { RUNTIME_MODULES, type RuntimeModuleName } from "./runtimeSources";

/**
 * Shared helpers emitted into `--project` as `lib/*.ts`. Single-file export
 * keeps the equivalent logic inlined so a piped `.spec.ts` stays standalone.
 */
type ExportLang = "ts" | "js";

export type PlaywrightLibModule =
  | "networkEvidence"
  | "hydration"
  | "clickUntil"
  | "verifier"
  | "splice"
  | "fixtures"
  | "widgets"
  | "request"
  | "auth"
  | "prelude"
  | "probe"
  | "poll"
  | "fixtureOutputs"
  // Test-time data glue and the runner modules it judges with (the `lib/`
  // files of the `value` / `http` / `network` / `file` / `xlsx` coverage).
  | DataPiece
  | RuntimeModuleName
  | "workbook";

/** The exported widget helpers a unit references. */
export type WidgetHelperName = "cairnWidget" | "cairnWidgetForm";

/**
 * F15 `cairnWidget` / `cairnWidgetForm`: the same in-page widget runtime and
 * drivers `cairn run` uses (the script text is embedded), with the project's
 * `browser.fieldRoot` / `browser.widgets` config baked in. Each call is one
 * `page.evaluate`; a field that does not read back what was written throws.
 * TS output types `page` as `Page` (the caller imports the type).
 */
export function renderWidgetHelperLines(
  lang: ExportLang,
  prepared: PreparedWidgets,
  opts: { form: boolean; exported?: boolean },
): string[] {
  const ts = lang === "ts";
  const exp = opts.exported ? "export " : "";
  const parts = widgetScriptParts(prepared);
  const lines: string[] = [
    `// Cairntrace widget runtime (set / check / choose / form): the in-page drivers`,
    `// \`cairn run\` uses, with the project's browser.fieldRoot / browser.widgets.`,
    `const CAIRN_WIDGETS_PREFIX = ${JSON.stringify(parts.prefix)};`,
    `const CAIRN_WIDGETS_SUFFIX = ${JSON.stringify(parts.suffix)};`,
    `const CAIRN_WIDGETS_CONFIG = ${JSON.stringify(prepared.config)};`,
    `// Like \`cairn run\`: a password control or a credential-named field never puts its values in an error.`,
    `const CAIRN_WIDGETS_SENSITIVE = /pass(?:word|wd|code|phrase)|pwd|secret|token|credential|otp|cookie|authorization|api[_-]?key|jwt|bearer/i;`,
    ``,
  ];
  if (ts) {
    lines.push(
      `${exp}interface CairnWidgetResult {`,
      `  ok: boolean;`,
      `  status: string;`,
      `  driver?: string;`,
      `  error?: string;`,
      `  sensitive?: boolean;`,
      `  actual?: unknown;`,
      `  label?: unknown;`,
      `  matches?: boolean;`,
      `  results?: CairnWidgetResult[];`,
      `  unanswered?: unknown[];`,
      `}`,
      ``,
    );
  }
  lines.push(
    `/** Run one widget op in the page; throws when it did not commit. */`,
    `${exp}async function cairnWidget(page${ts ? ": Page" : ""}, input${
      ts ? ": Record<string, unknown>" : ""
    })${ts ? ": Promise<CairnWidgetResult>" : ""} {`,
    `  const script = CAIRN_WIDGETS_PREFIX + JSON.stringify({ timeoutMs: 10000, readBackMs: 2000, ...input, config: CAIRN_WIDGETS_CONFIG }) + CAIRN_WIDGETS_SUFFIX;`,
    `  const result = (await page.evaluate(script))${
      ts ? " as CairnWidgetResult" : ""
    };`,
    `  if (!result || !result.ok) {`,
    `    const hidden = (result && result.sensitive === true) || CAIRN_WIDGETS_SENSITIVE.test(JSON.stringify(input.target ?? ""));`,
    `    throw new Error("cairn widget " + String(input.op) + " failed: " + (hidden ? "values hidden (sensitive field)" + (result && result.driver ? " — " + result.driver : "") : result && result.error ? result.error : "no result"));`,
    `  }`,
    `  return result;`,
    `}`,
    ``,
  );
  if (opts.form) {
    if (ts) {
      lines.push(
        `${exp}interface CairnFormField {`,
        `  key: string;`,
        `  value: unknown;`,
        `  optional?: boolean;`,
        `  dependsOn?: string[];`,
        `  driver?: string;`,
        `  timeoutMs?: number;`,
        `}`,
        ``,
      );
    }
    lines.push(
      `/** Cairntrace form: ordered fields, dependsOn mount waits, a final re-read of every field. */`,
      `${exp}async function cairnWidgetForm(page${ts ? ": Page" : ""}, fields${
        ts ? ": CairnFormField[]" : ""
      }, options${
        ts
          ? ": { verify: boolean; dumpUnanswered: boolean; timeoutMs: number }"
          : ""
      })${ts ? ": Promise<void>" : ""} {`,
      `  const skipped = new Set${ts ? "<string>" : ""}();`,
      `  const written${
        ts
          ? ": Array<{ target: { field: string }; value: unknown; label?: unknown; driver?: string }>"
          : ""
      } = [];`,
      `  try {`,
      `    for (const field of fields) {`,
      `      const dependsOn = field.dependsOn ?? [];`,
      `      if (dependsOn.some((dep) => skipped.has(dep))) {`,
      `        skipped.add(field.key);`,
      `        continue;`,
      `      }`,
      `      const budget = field.timeoutMs ?? options.timeoutMs;`,
      `      const result = await cairnWidget(page, {`,
      `        op: "set",`,
      `        target: { field: field.key },`,
      `        value: field.value,`,
      `        timeoutMs: budget,`,
      `        mountMs: field.optional && dependsOn.length === 0 ? Math.min(budget, 750) : budget,`,
      `        verify: options.verify,`,
      `        ...(field.optional ? { optional: true } : {}),`,
      `        ...(field.driver ? { driver: field.driver } : {}),`,
      `      });`,
      `      if (result.status === "skipped") {`,
      `        skipped.add(field.key);`,
      `        continue;`,
      `      }`,
      `      written.push({ target: { field: field.key }, value: field.value, label: result.label, driver: result.driver });`,
      `    }`,
      `    if (options.verify && written.length > 0) {`,
      `      const reread = await cairnWidget(page, { op: "readMany", timeoutMs: 5000, targets: written });`,
      `      (reread.results ?? []).forEach((entry, index) => {`,
      `        if (!entry.ok || entry.status === "absent" || entry.matches === false) {`,
      `          const key = written[index]${ts ? "!" : ""}.target.field;`,
      `          const shows = entry.sensitive === true || CAIRN_WIDGETS_SENSITIVE.test(key) ? "[redacted]" : JSON.stringify(entry.actual);`,
      `          throw new Error("form field " + JSON.stringify(key) + " lost its value after later fields were set (shows " + shows + ")");`,
      `        }`,
      `      });`,
      `    }`,
      `  } catch (error) {`,
      `    if (!options.dumpUnanswered) throw error;`,
      `    const dump = await cairnWidget(page, { op: "dump", timeoutMs: 5000, limit: 50 }).catch(() => undefined);`,
      `    throw new Error((error instanceof Error ? error.message : String(error)) + "; unanswered fields: " + JSON.stringify(dump?.unanswered ?? []), { cause: error });`,
      `  }`,
      `}`,
      ``,
    );
  }
  return lines;
}

export function renderWidgetsRuntime(
  lang: ExportLang,
  prepared: PreparedWidgets,
): string {
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    ...(lang === "ts" ? [`import type { Page } from "@playwright/test";`] : []),
    ``,
    ...renderWidgetHelperLines(lang, prepared, { form: true, exported: true }),
  ].join("\n");
}

/**
 * `cairnSplice` / `cairnUnresolvedSplice` (+ the action binding shape) as
 * source lines. Splices render exactly like the runner's
 * resolveResponsePlaceholders / resolveEvalPlaceholders: objects and arrays
 * as JSON, missing names or paths as "".
 */
export function renderSpliceHelperLines(
  lang: ExportLang,
  opts: {
    splice: boolean;
    unresolved: boolean;
    bindings?: boolean;
    exported?: boolean;
  },
): string[] {
  const ts = lang === "ts";
  const exp = opts.exported ? "export " : "";
  const lines: string[] = [];
  if (opts.bindings && ts) {
    lines.push(
      `/** Values an exported action captured (request/eval/download/run/capture \`assign:\`). */`,
      `${exp}interface CairnActionBindings {`,
      `  requests: Record<string, unknown>;`,
      `  evals: Record<string, unknown>;`,
      `  artifacts: Record<string, unknown>;`,
      `  runs: Record<string, unknown>;`,
      `  captures: Record<string, unknown>;`,
      `}`,
      ``,
    );
  }
  if (opts.splice) {
    lines.push(
      `/** Render a captured value like Cairntrace's runtime \${requests|evals|artifacts.…} splice. */`,
      `${exp}function cairnSplice(root${ts ? ": unknown" : ""}, path${
        ts ? ": string[]" : ""
      })${ts ? ": string" : ""} {`,
      `  let value = root;`,
      `  if (value === undefined) return "";`,
      `  for (const key of path) {`,
      `    if (value !== null && typeof value === "object" && key in value) {`,
      `      value = (value${ts ? " as Record<string, unknown>" : ""})[key];`,
      `    } else {`,
      `      return "";`,
      `    }`,
      `  }`,
      `  if (value === undefined || value === null) return "";`,
      `  return typeof value === "object" ? JSON.stringify(value) : String(value);`,
      `}`,
      ``,
    );
  }
  if (opts.unresolved) {
    lines.push(
      `/** A splice whose producing step is not available in this scope; the test is test.fixme. */`,
      `${exp}function cairnUnresolvedSplice(ref${ts ? ": string" : ""})${
        ts ? ": never" : ""
      } {`,
      `  throw new Error(`,
      `    "Cairntrace export could not bind the runtime splice " + ref +`,
      `      " (its producing step was not exported or runs in another scope); keep this flow in cairn run.",`,
      `  );`,
      `}`,
      ``,
    );
  }
  return lines;
}

export function renderSpliceRuntime(lang: ExportLang): string {
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    `// Runtime splices for \${requests|evals|artifacts|runs|captures.<name>…}.`,
    ``,
    ...renderSpliceHelperLines(lang, {
      splice: true,
      unresolved: true,
      bindings: true,
      exported: true,
    }),
  ].join("\n");
}

/**
 * How a generated module finds its own directory: ES modules read
 * `import.meta.url`; a CommonJS host (Playwright loads its files as CommonJS
 * unless package.json says \`"type": "module"\`) has `__dirname` and no
 * `import.meta`.
 */
export type ExportModuleSystem = "esm" | "cjs";

export function renderFixturesRuntime(
  lang: ExportLang,
  moduleSystem: ExportModuleSystem = "esm",
): string {
  const ts = lang === "ts";
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    `// Upload fixtures are copied into <export>/fixtures/ so the suite is relocatable.`,
    ...(moduleSystem === "cjs"
      ? [`import { resolve } from "node:path";`]
      : [`import { fileURLToPath } from "node:url";`]),
    ``,
    `export function cairnFixturePath(name${ts ? ": string" : ""})${
      ts ? ": string" : ""
    } {`,
    moduleSystem === "cjs"
      ? `  return resolve(__dirname, "..", "fixtures", encodeURIComponent(name));`
      : `  return fileURLToPath(new URL("../fixtures/" + encodeURIComponent(name), import.meta.url));`,
    `}`,
    ``,
  ].join("\n");
}

/**
 * `lib/projectRoot` — resolves the Cairntrace SOURCE project (precondition
 * cwd, node verifier specDir) relative to the export root, never as a baked
 * absolute path. `relFromExportRoot` is computed from real paths at export
 * time; CAIRN_PROJECT_ROOT overrides it after a relocation. cairnProjectRoot()
 * validates existence and fails fast with guidance instead of letting a
 * precondition spawn in a missing cwd (`spawn /bin/bash ENOENT`).
 */
export function renderProjectRootRuntime(
  lang: ExportLang,
  relFromExportRoot: string | undefined,
  moduleSystem: ExportModuleSystem = "esm",
): string {
  const ts = lang === "ts";
  const rel = JSON.stringify(
    relFromExportRoot === "" ? "." : (relFromExportRoot ?? "."),
  );
  const base =
    relFromExportRoot === undefined
      ? `process.cwd()`
      : moduleSystem === "cjs"
        ? `resolve(__dirname, "..", ${rel})`
        : `resolve(fileURLToPath(new URL("..", import.meta.url)), ${rel})`;
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    `// Resolves the Cairntrace source project relative to this export's root.`,
    `// Override with CAIRN_PROJECT_ROOT when the export is relocated.`,
    `import { existsSync } from "node:fs";`,
    `import { join, resolve } from "node:path";`,
    ...(relFromExportRoot === undefined || moduleSystem === "cjs"
      ? []
      : [`import { fileURLToPath } from "node:url";`]),
    ``,
    `/** Candidate path inside the source project (not validated). */`,
    `export function cairnProjectPath(...segments${ts ? ": string[]" : ""})${
      ts ? ": string" : ""
    } {`,
    `  const override = process.env.CAIRN_PROJECT_ROOT;`,
    `  const root = override ? resolve(override) : ${base};`,
    `  return join(root, ...segments);`,
    `}`,
    ``,
    `/** Validated source project root; throws with guidance when it is missing. */`,
    `export function cairnProjectRoot()${ts ? ": string" : ""} {`,
    `  const root = cairnProjectPath();`,
    `  if (!existsSync(root)) {`,
    `    throw new Error(`,
    `      "Cairntrace project root not found at " + root + ". " +`,
    `        (process.env.CAIRN_PROJECT_ROOT`,
    `          ? "CAIRN_PROJECT_ROOT points at a missing directory. "`,
    `          : "This export was moved away from its source project. ") +`,
    `        "Set CAIRN_PROJECT_ROOT to the directory that holds the Cairntrace specs before running tests with preconditions.",`,
    `    );`,
    `  }`,
    `  return root;`,
    `}`,
    ``,
  ].join("\n");
}

/** The runner's own modules live in `lib/runtime/`, apart from the generated helpers (an `--into` tree keeps its own `lib/url`, `lib/refs`, …). */
export const RUNTIME_LIB_DIR = "lib/runtime";

export function playwrightLibRelPath(
  name: PlaywrightLibModule,
  lang: ExportLang,
): string {
  const dir = (RUNTIME_MODULES as readonly string[]).includes(name)
    ? RUNTIME_LIB_DIR
    : "lib";
  return `${dir}/${name}${lang === "js" ? ".js" : ".ts"}`;
}

export function renderHydrationRuntime(lang: ExportLang): string {
  const ts = lang === "ts";
  const lines = [
    `// Generated by \`cairn export playwright --project\`.`,
    `// Fill/type retry when a hydration cycle wipes the authored value.`,
    `import { expect${
      ts ? ", type Locator, type Page" : ""
    } } from "@playwright/test";`,
    ``,
    `export async function verifiedFill(page${ts ? ": Page" : ""}, target${
      ts ? ": Locator" : ""
    }, value${ts ? ": string" : ""})${ts ? ": Promise<void>" : ""} {`,
    `  for (let fillAttempt = 0; ; fillAttempt++) {`,
    `    await target.fill(value);`,
    `    await page.waitForTimeout(500);`,
    `    try {`,
    `      await expect(target).toHaveValue(value, { timeout: 500 });`,
    `      break;`,
    `    } catch (err) {`,
    `      if (fillAttempt >= 3) throw new Error("hydration wiped value after 4 attempts", { cause: err });`,
    `    }`,
    `  }`,
    `}`,
    ``,
    `export async function verifiedType(page${ts ? ": Page" : ""}, target${
      ts ? ": Locator" : ""
    }, value${ts ? ": string" : ""}, typeOptions${
      ts ? "?: { delay?: number }" : ""
    })${ts ? ": Promise<void>" : ""} {`,
    `  for (let fillAttempt = 0; ; fillAttempt++) {`,
    `    if (fillAttempt > 0) await target.fill("");`,
    `    await target.pressSequentially(value, typeOptions);`,
    `    await page.waitForTimeout(500);`,
    `    try {`,
    `      await expect(target).toHaveValue(value, { timeout: 500 });`,
    `      break;`,
    `    } catch (err) {`,
    `      if (fillAttempt >= 3) throw new Error("hydration wiped value after 4 attempts", { cause: err });`,
    `    }`,
    `  }`,
    `}`,
    ``,
  ];
  return lines.join("\n");
}

export function renderClickUntilRuntime(lang: ExportLang): string {
  const ts = lang === "ts";
  const lines = [
    `// Generated by \`cairn export playwright --project\`.`,
    `// Bounded click retries matching Cairntrace click.until (4 attempts).`,
    `import { expect${
      ts ? ", type Locator, type Page" : ""
    } } from "@playwright/test";`,
    ``,
    ...(ts
      ? [
          `export interface ClickUntilOptions {`,
          `  timeoutMs: number;`,
          `  settleMs?: number;`,
          `  selectorGone?: string;`,
          `  selector?: string;`,
          `  urlEquals?: string;`,
          `  urlIncludes?: string;`,
          `  urlPattern?: string;`,
          `  text?: string;`,
          `  notText?: string;`,
          `}`,
          ``,
        ]
      : []),
    `function escapeRegExpLiteral(value${ts ? ": string" : ""})${
      ts ? ": string" : ""
    } {`,
    `  return value.replace(/[.*+?^\${}()|[\\]\\\\]/g, "\\\\$&");`,
    `}`,
    ``,
    `export async function clickUntil(page${ts ? ": Page" : ""}, clickTarget${
      ts ? ": Locator" : ""
    }, options${ts ? ": ClickUntilOptions" : ""})${
      ts ? ": Promise<void>" : ""
    } {`,
    `  const clickUntilDeadline = Date.now() + options.timeoutMs;`,
    `  for (let clickAttempt = 0; ; clickAttempt++) {`,
    `    await clickTarget.click();`,
    `    if (options.settleMs !== undefined && options.settleMs > 0) {`,
    `      await page.waitForLoadState("networkidle", { timeout: options.settleMs });`,
    `    }`,
    `    const clickUntilRemaining = Math.max(1, clickUntilDeadline - Date.now());`,
    `    const clickUntilAttemptTimeout = clickAttempt >= 3 ? clickUntilRemaining : Math.min(clickUntilRemaining, 250 * (2 ** clickAttempt));`,
    `    try {`,
    `      if (options.selectorGone !== undefined) {`,
    `        await expect(page.locator(options.selectorGone)).toHaveCount(0, { timeout: clickUntilAttemptTimeout });`,
    `      } else if (options.selector !== undefined) {`,
    `        await expect(page.locator(options.selector)).not.toHaveCount(0, { timeout: clickUntilAttemptTimeout });`,
    `      } else if (options.urlEquals !== undefined) {`,
    `        await expect(page).toHaveURL(options.urlEquals, { timeout: clickUntilAttemptTimeout });`,
    `      } else if (options.urlIncludes !== undefined) {`,
    `        await expect(page).toHaveURL(new RegExp(escapeRegExpLiteral(options.urlIncludes)), { timeout: clickUntilAttemptTimeout });`,
    `      } else if (options.urlPattern !== undefined) {`,
    `        await expect(page).toHaveURL(new RegExp(options.urlPattern), { timeout: clickUntilAttemptTimeout });`,
    `      } else if (options.text !== undefined) {`,
    `        await expect(page.locator("body")).toContainText(options.text, { ignoreCase: true, useInnerText: true, timeout: clickUntilAttemptTimeout });`,
    `      } else if (options.notText !== undefined) {`,
    `        await expect(page.locator("body")).not.toContainText(options.notText, { ignoreCase: true, useInnerText: true, timeout: clickUntilAttemptTimeout });`,
    `      } else {`,
    `        throw new Error("click.until is missing a condition");`,
    `      }`,
    `      break;`,
    `    } catch (err) {`,
    `      if (clickAttempt >= 3 || Date.now() >= clickUntilDeadline) {`,
    `        throw new Error("click.until condition was not satisfied after 4 attempts", { cause: err });`,
    `      }`,
    `    }`,
    `  }`,
    `}`,
    ``,
  ];
  return lines.join("\n");
}

export function renderVerifierRuntime(lang: ExportLang): string {
  const ts = lang === "ts";
  const lines = [
    `// Generated by \`cairn export playwright --project\`.`,
    `// ESM/CJS interop for node file verifiers (Playwright transpiles TS to CJS).`,
    ``,
    ...(ts
      ? [
          `export interface CairnVerifierContext {`,
          `  fixtures: Record<string, unknown>;`,
          `  artifacts: Record<string, unknown>;`,
          `  vars: Record<string, unknown>;`,
          `  runDir: string;`,
          `  specDir: string;`,
          `}`,
          ``,
          `export type CairnVerifier = (`,
          `  ctx: CairnVerifierContext,`,
          `) => Promise<{ ok?: boolean; evidence?: unknown }>;`,
          ``,
        ]
      : []),
    `export async function loadCairnVerifier(importedVerifier${
      ts ? ": unknown" : ""
    })${ts ? ": Promise<CairnVerifier>" : ""} {`,
    `  const verifierNamespace = importedVerifier${
      ts ? " as { verify?: unknown; default?: unknown }" : ""
    };`,
    `  const verifierDefault = verifierNamespace.default;`,
    `  const verifierDefaultNamespace = verifierDefault && typeof verifierDefault === "object"`,
    `    ? verifierDefault${
      ts ? " as { verify?: unknown; default?: unknown }" : ""
    }`,
    `    : undefined;`,
    `  const verify =`,
    `    verifierNamespace.verify ??`,
    `    (typeof verifierDefault === "function"`,
    `      ? verifierDefault`,
    `      : (verifierDefaultNamespace?.verify ?? verifierDefaultNamespace?.default));`,
    `  if (typeof verify !== "function") {`,
    `    throw new Error("verifier module must export a verify() function");`,
    `  }`,
    `  return verify${ts ? " as CairnVerifier" : ""};`,
    `}`,
    ``,
  ];
  return lines.join("\n");
}

/** F20 prelude helpers a unit references. */
export type PreludeHelperName = "CAIRN_PRELUDE" | "cairnAppCheck";

/**
 * F20: `CAIRN_PRELUDE` (the `window.__cairn` installer, with the config's
 * `browser.appHandle` getters) and `cairnAppCheck` (one `wait: { app }`
 * probe). Exported evals that mention `__cairn` run `CAIRN_PRELUDE` first,
 * like `cairn run` does.
 */
export function renderPreludeHelperLines(
  lang: ExportLang,
  appHandles: AppHandles | undefined,
  opts: { appCheck: boolean; exported?: boolean },
): string[] {
  const ts = lang === "ts";
  const exp = opts.exported ? "export " : "";
  const lines = [
    `// Cairntrace page prelude: window.__cairn helpers and browser.appHandle accessors,`,
    `// installed before page JavaScript that uses __cairn (as \`cairn run\` does).`,
    `${exp}const CAIRN_PRELUDE = ${JSON.stringify(`${preludeInstallExpression(appHandles)};\n`)};`,
  ];
  if (opts.appCheck) {
    lines.push(
      ``,
      `/** wait: { app } — true once the handle value at \`path\` passes \`check\`. */`,
      `${exp}async function cairnAppCheck(page${ts ? ": Page" : ""}, path${
        ts ? ": string" : ""
      }, check${ts ? ": Record<string, unknown>" : ""})${
        ts ? ": Promise<boolean>" : ""
      } {`,
      `  return page`,
      `    .evaluate(`,
      `      async ({ source, path, check }) => {`,
      `        const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor${
        ts
          ? " as new (...parameters: string[]) => (...values: unknown[]) => Promise<unknown>"
          : ""
      };`,
      `        const answer = (await new AsyncFunction("path", "check", source + "return __cairn.__appCheck(path, check);")(path, check))${
        ts ? " as { ok?: boolean }" : ""
      };`,
      `        return answer.ok === true;`,
      `      },`,
      `      { source: CAIRN_PRELUDE, path, check },`,
      `    )`,
      `    .catch((error${ts ? ": unknown" : ""}) => {`,
      `      // A strict CSP blocks the string evaluation: say so instead of polling to a timeout.`,
      `      const message = String((error${
        ts ? " as { message?: unknown } | undefined" : ""
      })?.message ?? error);`,
      `      if (/EvalError|unsafe-eval|Content Security Policy/i.test(message)) {`,
      `        throw new Error("wait: { app } cannot run: the page's Content Security Policy blocks string evaluation (" + message.split("\\n")[0] + "); set use.bypassCSP: true in the Playwright config");`,
      `      }`,
      `      return false;`,
      `    });`,
      `}`,
    );
  }
  return lines;
}

/** `lib/prelude` for `--project`. */
export function renderPreludeRuntime(
  lang: ExportLang,
  appHandles: AppHandles | undefined,
): string {
  return [
    `// Generated by \`cairn export playwright --project\`.`,
    ...(lang === "ts" ? [`import type { Page } from "@playwright/test";`] : []),
    ``,
    ...renderPreludeHelperLines(lang, appHandles, {
      appCheck: true,
      exported: true,
    }),
    ``,
  ].join("\n");
}
