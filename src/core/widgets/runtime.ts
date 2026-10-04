import { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Script } from "node:vm";
import type { BrowserBackend } from "../../adapters/browserBackend";
import { LOCATOR_RESOLVER_JS } from "../runner/verifiers/domProbe";
import type { BrowserConfig } from "../schema/config.v1";
import type { Locator } from "../schema/spec.v1";

/**
 * Host side of the F15 widget runtime: loads the in-page runtime
 * (`widgetRuntime.page.js`), the project's custom driver modules, and turns
 * one widget operation into a single `backend.evaluate` call. Both backends
 * run the same script, and exported Playwright tests embed the same text
 * (`widgetScriptParts`).
 *
 * Trust model: custom driver modules are project code, like `eval` files —
 * they run in the page with the page's privileges, and their source travels
 * inside the evaluated script.
 */

/** Widget config as the page runtime reads it (`input.config`). */
export interface WidgetPageConfig {
  fieldRoot?: string[];
  testIdAttribute?: string;
  /** Detection order: built-ins by name, custom modules by index. */
  drivers?: Array<{ use: string } | { custom: number; file: string }>;
}

export interface PreparedWidgets {
  config: WidgetPageConfig;
  /** Custom driver modules in config order, as page-ready expressions. */
  customDrivers: Array<{ file: string; expression: string }>;
}

export type WidgetTargetRef = { field: string } | { locator: Locator };

export type WidgetOp =
  | "set"
  | "check"
  | "uncheck"
  | "choose"
  | "read"
  | "readMany"
  | "dump"
  | "click"
  | "probe"
  | "fill";

export interface WidgetOpInput {
  op: WidgetOp;
  target?: WidgetTargetRef;
  value?: unknown;
  option?: string;
  driver?: string;
  optional?: boolean;
  /** How long to wait for the target to mount (0: look once). */
  mountMs?: number;
  /** In-page budget for the whole op. */
  timeoutMs: number;
  readBackMs?: number;
  /** false: write without reading back. */
  verify?: boolean;
  /** click: `hit` (hit-test only) or `dispatch` (DOM click). */
  mode?: "hit" | "dispatch";
  /** fill (mode: set): settle before each re-read, and attempts. */
  settleMs?: number;
  attempts?: number;
  /** dump: most unanswered fields listed. */
  limit?: number;
  /** readMany: the fields to re-read. */
  targets?: Array<{
    target: WidgetTargetRef;
    value: unknown;
    label?: unknown;
    driver?: string;
  }>;
}

export interface WidgetOpResult {
  ok: boolean;
  /** committed | already | written | skipped | failed | present | absent | clicked | dumped | read */
  status: string;
  driver?: string;
  via?: string;
  expected?: unknown;
  actual?: unknown;
  label?: unknown;
  matches?: boolean;
  error?: string;
  reason?: string;
  /** Short description of the resolved root element. */
  root?: string;
  /** The root's visible text (bounded), for evidence. */
  rootText?: string;
  /** The field holds a password control: values are masked in evidence. */
  sensitive?: boolean;
  /** Committed through the driver's chosen label only (a partial-label pick). */
  substituted?: boolean;
  notes?: string[];
  durationMs?: number;
  /** click: the element a pointer at the target's center would hit instead. */
  blockedBy?: string;
  /** dump */
  total?: number;
  unanswered?: Array<{
    key: string;
    driver: string | null;
    required: boolean;
    label: string;
  }>;
  /** readMany */
  results?: WidgetOpResult[];
}

let runtimeSource: string | undefined;

/** The in-page runtime function expression (full-line comments dropped). */
export function widgetRuntimeSource(): string {
  if (runtimeSource === undefined) {
    const text = readFileSync(
      new URL("./widgetRuntime.page.js", import.meta.url),
      "utf8",
    );
    const start = text.indexOf("async function cairnWidgetRuntime");
    // Indentation and full-line comments carry no meaning in the page;
    // dropping them keeps every evaluate payload small.
    runtimeSource = text
      .slice(start)
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("//"))
      .join("\n");
  }
  return runtimeSource;
}

const DEFAULT_PREPARED: PreparedWidgets = { config: {}, customDrivers: [] };

/** Widget config without a project config (built-ins, default fieldRoot). */
export function defaultWidgets(testIdAttribute?: string): PreparedWidgets {
  return testIdAttribute
    ? { config: { testIdAttribute }, customDrivers: [] }
    : DEFAULT_PREPARED;
}

/**
 * Turn a driver module's source into a page expression that evaluates to its
 * exports (`export default { … }` or `module.exports = { … }`), or to
 * `{ __loadError }` when it throws while loading.
 */
export function driverModuleExpression(source: string, file: string): string {
  if (/^\s*import\s[^(]/m.test(source)) {
    throw new Error(
      `${file}: driver modules run in the page and cannot use import statements`,
    );
  }
  const body = source.replace(
    /^(\s*)export\s+default\s+/m,
    "$1module.exports.default = ",
  );
  if (/^\s*export\s/m.test(body)) {
    throw new Error(
      `${file}: export the driver with \`export default { name, match, read, write }\` or \`module.exports = { … }\` (no named exports)`,
    );
  }
  const expression = [
    "(() => {",
    "  try {",
    "    const module = { exports: {} };",
    "    const exports = module.exports;",
    body,
    "    ;",
    "    return module.exports;",
    "  } catch (e) {",
    "    return { __loadError: String((e && e.message) || e) };",
    "  }",
    "})()",
  ].join("\n");
  try {
    // Compile only (syntax check); the module runs in the page, never here.
    // oxlint-disable-next-line no-new
    new Script(`(${expression})`, { filename: file });
  } catch (e) {
    throw new Error(`${file}: ${(e as Error).message}`, { cause: e });
  }
  return expression;
}

/**
 * Resolve config `browser.fieldRoot` / `browser.widgets` (+ testIdAttribute)
 * into what the page runtime needs. Driver files resolve against the config
 * directory (`${config.dir}` already substituted).
 */
export async function prepareWidgets(
  browser: BrowserConfig | undefined,
  configDir: string,
): Promise<PreparedWidgets> {
  const config: WidgetPageConfig = {};
  if (browser?.testIdAttribute)
    config.testIdAttribute = browser.testIdAttribute;
  if (browser?.fieldRoot !== undefined) {
    config.fieldRoot = Array.isArray(browser.fieldRoot)
      ? [...browser.fieldRoot]
      : [browser.fieldRoot];
  }
  const customDrivers: PreparedWidgets["customDrivers"] = [];
  if (browser?.widgets) {
    config.drivers = [];
    for (const [index, entry] of browser.widgets.entries()) {
      if ("use" in entry) {
        config.drivers.push({ use: entry.use });
        continue;
      }
      const path = isAbsolute(entry.file)
        ? entry.file
        : resolve(configDir, entry.file);
      let source: string;
      try {
        source = await readFile(path, "utf8");
      } catch (e) {
        throw new Error(
          `browser.widgets[${index}].file ${JSON.stringify(entry.file)}: ${(e as Error).message}`,
          { cause: e },
        );
      }
      const expression = driverModuleExpression(source, entry.file);
      config.drivers.push({ custom: customDrivers.length, file: entry.file });
      customDrivers.push({ file: entry.file, expression });
    }
  }
  return { config, customDrivers };
}

/**
 * The evaluated script is `prefix + JSON(input) + suffix`: the shared locator
 * resolver, the custom driver modules, then the runtime called with the
 * input. Exported tests use the same parts so CLI and export agree.
 */
export function widgetScriptParts(prepared: PreparedWidgets): {
  prefix: string;
  suffix: string;
} {
  const drivers = prepared.customDrivers.map((d) => d.expression).join(",\n");
  return {
    prefix: `(async () => {\n${LOCATOR_RESOLVER_JS}\nconst __cairnCustomDrivers = [${drivers}];\nreturn await (${widgetRuntimeSource()})(`,
    suffix: `, __cairnCustomDrivers, { resolveLocator, isVisible, norm, lower, textOf });\n})()`,
  };
}

/** Ops that pick a driver; the others (click, probe, fill) never load custom ones. */
const DRIVER_OPS: ReadonlySet<WidgetOp> = new Set([
  "set",
  "check",
  "uncheck",
  "choose",
  "read",
  "readMany",
  "dump",
]);

export function buildWidgetScript(
  prepared: PreparedWidgets,
  input: WidgetOpInput,
): string {
  // A custom driver module is re-evaluated on every op (module-level side
  // effects included): a click / probe / fill op does not pay for it.
  const scoped: PreparedWidgets = DRIVER_OPS.has(input.op)
    ? prepared
    : {
        config: {
          ...prepared.config,
          ...(prepared.config.drivers
            ? {
                drivers: prepared.config.drivers.filter(
                  (driver) => "use" in driver,
                ),
              }
            : {}),
        },
        customDrivers: [],
      };
  const parts = widgetScriptParts(scoped);
  return `${parts.prefix}${JSON.stringify({ ...input, config: scoped.config })}${parts.suffix}`;
}

/** Grace on top of the in-page budget before the backend kills the eval. */
const EVALUATE_GRACE_MS = 5_000;

/** Run one widget operation in the page. Never throws. */
export async function runWidgetOp(
  backend: BrowserBackend,
  prepared: PreparedWidgets,
  input: WidgetOpInput,
): Promise<WidgetOpResult> {
  const script = buildWidgetScript(prepared, input);
  let result;
  try {
    result = await backend.evaluate(script, {
      timeoutMs: Math.max(1, input.timeoutMs) + EVALUATE_GRACE_MS,
      // A value may be a password typed into a field: never in argv.
      ...(input.value !== undefined || input.targets !== undefined
        ? { sensitive: true }
        : {}),
    });
  } catch (e) {
    return {
      ok: false,
      status: "failed",
      error: `widget runtime: ${(e as Error).message}`,
    };
  }
  if (!result.ok) {
    const stderr = result.stderr.trim();
    return {
      ok: false,
      status: "failed",
      error: `widget runtime eval failed: ${
        stderr ? stderr.slice(0, 600) : `exit ${result.exitCode}`
      }`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    return {
      ok: false,
      status: "failed",
      error: `widget runtime returned non-JSON output: ${result.stdout.slice(0, 200)}`,
    };
  }
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    typeof (parsed as { ok?: unknown }).ok !== "boolean"
  ) {
    return {
      ok: false,
      status: "failed",
      error: `widget runtime returned ${result.stdout.slice(0, 200)}`,
    };
  }
  return parsed as WidgetOpResult;
}
