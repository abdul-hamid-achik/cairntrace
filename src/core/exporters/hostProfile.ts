/**
 * E8: host profiles. `cairn export playwright --into <dir> --host-config
 * <playwright.config.ts>` adapts the generated code to an existing Playwright
 * tree: the module system, timeouts, test id attribute, `bypassCSP`, test
 * discovery (`testDir` / `testMatch`), tsconfig path aliases and prettier.
 *
 * The host's config is READ, never executed: the file is parsed to a TypeScript
 * syntax tree and only literal-shaped values are evaluated (strings, numbers,
 * booleans, regexes, objects, arrays, constants, relative imports of other
 * config modules, `__dirname` / `import.meta.dirname`, `path.join` /
 * `path.resolve` / `path.dirname`, templates, arithmetic, `defineConfig(...)`
 * merging, `process.env.X || "fallback"` and `a ?? b` / `a || b` with
 * JavaScript truthiness). Options resolve the way Playwright resolves them: a
 * project's value wins over the top level (`use` is merged key by key), and
 * only the projects that discover the generated tests count. Anything else is
 * NOT READABLE: the profile names the option and its expression (report
 * `host.notes`) and the exporter takes the conservative path for it (explicit
 * attribute selectors for an unread `testIdAttribute`, the spec's own budget
 * for an unread `timeout`, page evals refused for an unread `bypassCSP`, a
 * refusal for an unread `testDir` / `testMatch` / `testIgnore` / `projects`).
 * The `typescript` package is the host's own when it has the JavaScript API,
 * else cairntrace's.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
  sep,
} from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type * as TS from "typescript";
import { loadTypescript as loadTypescriptApi } from "../importers/typescriptLoader";
import { realpathNearest } from "./exportManifest";

/** Pinned default of Playwright's `timeout` when the host does not set one. */
export const PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS = 30_000;
/** Playwright's own default for `use.testIdAttribute`. */
export const PLAYWRIGHT_DEFAULT_TEST_ID_ATTRIBUTE = "data-testid";

/** How far up lookups go at most (they also stop at the host boundary). */
const LEVELS_UP = 12;

/* ----- the static value model ----- */

type Value =
  | { k: "str"; v: string }
  | { k: "num"; v: number }
  | { k: "bool"; v: boolean }
  | { k: "re"; v: string }
  /** `open`: an unreadable spread / argument may add (or override) keys. */
  | { k: "obj"; v: Map<string, Value>; open?: string }
  | { k: "arr"; v: Value[]; open?: string }
  | { k: "env"; names: string[]; fallback?: Value }
  | { k: "nullish" }
  | { k: "dyn"; text: string };

type ObjValue = Extract<Value, { k: "obj" }>;

const dyn = (text: string): Value => ({
  k: "dyn",
  text: text.replace(/\s+/g, " ").trim().slice(0, 80),
});

/** One parsed module: the config itself or a config module it imports. */
interface ModuleScope {
  path: string;
  dir: string;
  top: Map<string, TS.Expression>;
  /** local name → module + imported name (`default`, `*` or the export name). */
  imports: Map<string, { spec: string; imported: string }>;
  /** export name (`default` for the default export) → expression. */
  exports: Map<string, TS.Expression>;
}

interface EvalScope {
  ts: typeof TS;
  mod: ModuleScope;
  seen: Set<string>;
  loader: ModuleLoader;
}

const MAX_MODULES = 16;
const PATH_FUNCTIONS = new Set(["join", "resolve", "dirname", "normalize"]);

function isPathModule(spec: string): boolean {
  return /^(?:node:)?path(?:\/posix)?$/.test(spec);
}

function isUrlModule(spec: string): boolean {
  return /^(?:node:)?url$/.test(spec);
}

function isPlaywrightModule(spec: string): boolean {
  return /^(?:@playwright\/test|playwright(?:\/test)?)$/.test(spec);
}

/** `require("x")`'s module specifier, if `node` is one. */
function requireSpec(ts: typeof TS, node: TS.Expression): string | undefined {
  return ts.isCallExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "require" &&
    node.arguments.length === 1 &&
    ts.isStringLiteralLike(node.arguments[0]!)
    ? node.arguments[0].text
    : undefined;
}

function hasExportModifier(ts: typeof TS, node: TS.Node): boolean {
  return (
    ts.canHaveModifiers(node) &&
    (ts.getModifiers(node) ?? []).some(
      (m) => m.kind === ts.SyntaxKind.ExportKeyword,
    )
  );
}

class ModuleLoader {
  private readonly cache = new Map<string, ModuleScope | null>();
  constructor(readonly ts: typeof TS) {}

  parse(path: string, text: string): ModuleScope {
    const ts = this.ts;
    const sf = ts.createSourceFile(
      path,
      text,
      ts.ScriptTarget.Latest,
      true,
      scriptKind(ts, path),
    );
    const mod: ModuleScope = {
      path,
      dir: dirname(path),
      top: new Map(),
      imports: new Map(),
      exports: new Map(),
    };
    for (const statement of sf.statements) {
      if (
        ts.isImportDeclaration(statement) &&
        ts.isStringLiteral(statement.moduleSpecifier) &&
        !statement.importClause?.isTypeOnly
      ) {
        const spec = statement.moduleSpecifier.text;
        const clause = statement.importClause;
        if (clause?.name)
          mod.imports.set(clause.name.text, { spec, imported: "default" });
        const bindings = clause?.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) {
          mod.imports.set(bindings.name.text, { spec, imported: "*" });
        } else if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) {
            mod.imports.set(el.name.text, {
              spec,
              imported: (el.propertyName ?? el.name).text,
            });
          }
        }
      } else if (ts.isVariableStatement(statement)) {
        const exported = hasExportModifier(ts, statement);
        for (const decl of statement.declarationList.declarations) {
          if (!decl.initializer) continue;
          const spec = requireSpec(ts, decl.initializer);
          if (ts.isIdentifier(decl.name)) {
            if (spec !== undefined) {
              mod.imports.set(decl.name.text, { spec, imported: "default" });
            } else {
              mod.top.set(decl.name.text, decl.initializer);
              if (exported) mod.exports.set(decl.name.text, decl.initializer);
            }
          } else if (
            ts.isObjectBindingPattern(decl.name) &&
            spec !== undefined
          ) {
            for (const el of decl.name.elements) {
              if (!ts.isIdentifier(el.name)) continue;
              const key = el.propertyName ?? el.name;
              if (!ts.isIdentifier(key)) continue;
              mod.imports.set(el.name.text, { spec, imported: key.text });
            }
          }
        }
      } else if (ts.isExportAssignment(statement)) {
        mod.exports.set("default", statement.expression);
      } else if (
        ts.isExportDeclaration(statement) &&
        !statement.moduleSpecifier &&
        statement.exportClause &&
        ts.isNamedExports(statement.exportClause)
      ) {
        for (const el of statement.exportClause.elements) {
          mod.exports.set(el.name.text, el.propertyName ?? el.name);
        }
      } else if (
        ts.isExpressionStatement(statement) &&
        ts.isBinaryExpression(statement.expression) &&
        statement.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ) {
        const left = statement.expression.left.getText(sf);
        const right = statement.expression.right;
        if (
          left === "module.exports" ||
          left === "exports.default" ||
          left === "module.exports.default"
        ) {
          mod.exports.set("default", right);
        } else {
          const named = /^(?:module\.)?exports\.([A-Za-z_$][\w$]*)$/.exec(left);
          if (named) mod.exports.set(named[1]!, right);
        }
      }
    }
    return mod;
  }

  /** A relative import of `from`, parsed once; undefined when not readable. */
  load(from: ModuleScope, spec: string): ModuleScope | undefined {
    if (!spec.startsWith(".")) return undefined;
    const base = resolve(from.dir, spec);
    const stem = base.replace(/\.(?:c|m)?[jt]s$/, "");
    const candidates = [
      base,
      ...[".ts", ".mts", ".cts", ".js", ".mjs", ".cjs"].map((e) => stem + e),
      join(base, "index.ts"),
      join(base, "index.js"),
    ];
    for (const candidate of candidates) {
      let isFile = false;
      try {
        isFile = statSync(candidate).isFile();
      } catch {
        isFile = false;
      }
      if (!isFile) continue;
      if (this.cache.has(candidate))
        return this.cache.get(candidate) ?? undefined;
      if (this.cache.size >= MAX_MODULES) return undefined;
      try {
        const parsed = this.parse(candidate, readFileSync(candidate, "utf8"));
        this.cache.set(candidate, parsed);
        return parsed;
      } catch {
        this.cache.set(candidate, null);
        return undefined;
      }
    }
    return undefined;
  }
}

function propName(
  ts: typeof TS,
  name: TS.PropertyName | undefined,
): string | undefined {
  if (!name) return undefined;
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteral(name) ||
    ts.isNumericLiteral(name) ||
    ts.isNoSubstitutionTemplateLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function isProcessEnv(ts: typeof TS, node: TS.Expression): boolean {
  return (
    ts.isPropertyAccessExpression(node) &&
    ts.isIdentifier(node.expression) &&
    node.expression.text === "process" &&
    node.name.text === "env"
  );
}

/** Readable text for a value (notes name what could not be read). */
function describeValue(value: Value): string {
  switch (value.k) {
    case "dyn":
      return value.text;
    case "env":
      return `process.env.${value.names.join(" || process.env.")}`;
    case "str":
      return JSON.stringify(value.v);
    case "num":
    case "bool":
      return String(value.v);
    case "re":
      return value.v;
    case "nullish":
      return "undefined";
    case "obj":
      return value.open ? `{ ...${value.open} }` : "{…}";
    case "arr":
      return value.open ? `[ ...${value.open} ]` : "[…]";
  }
}

/**
 * `{ ...a, ...b }` (JavaScript spread semantics, shallow): keys of `b` win;
 * when `b` may hold unreadable keys, every key set before it may be
 * overridden, so it becomes unreadable too.
 */
function spreadInto(
  out: Map<string, Value>,
  from: Value,
  text: string,
): string | undefined {
  if (from.k === "obj") {
    if (from.open) {
      for (const key of out.keys()) {
        if (!from.v.has(key))
          out.set(key, dyn(`${key} (may be overridden by ...${from.open})`));
      }
    }
    for (const [key, value] of from.v) out.set(key, value);
    return from.open;
  }
  if (from.k === "nullish") return undefined;
  for (const key of out.keys()) {
    out.set(key, dyn(`${key} (may be overridden by ...${text})`));
  }
  return text;
}

function objOf(map: Map<string, Value>, open: string | undefined): ObjValue {
  return { k: "obj", v: map, ...(open ? { open } : {}) };
}

/** `{ ...a, ...b }` of two optional values (an absent side is `{}`). */
function shallowMerge(a: Value | undefined, b: Value | undefined): ObjValue {
  const out = new Map<string, Value>();
  let open: string | undefined;
  for (const side of [a, b]) {
    if (side === undefined) continue;
    open = spreadInto(out, side, describeValue(side)) ?? open;
  }
  return objOf(out, open);
}

/**
 * Playwright's `defineConfig(a, b, …)`: later configs win key by key, with
 * `use` / `expect` / `build` merged one level and `projects` merged by name
 * (a project's `use` merged too).
 */
function defineConfigValue(values: Value[]): Value {
  let result: Value = values[0] ?? objOf(new Map(), undefined);
  for (const next of values.slice(1)) {
    const prev = result;
    const top = shallowMerge(prev, next);
    for (const key of ["expect", "use", "build"]) {
      const merged = shallowMerge(getPath(prev, [key]), getPath(next, [key]));
      if (merged.v.size > 0 || merged.open) top.v.set(key, merged);
    }
    const prevProjects = getPath(prev, ["projects"]);
    const nextProjects = getPath(next, ["projects"]);
    if (prevProjects !== undefined || nextProjects !== undefined) {
      top.v.set("projects", mergeProjects(prevProjects, nextProjects));
    }
    result = top;
  }
  return result;
}

function mergeProjects(a: Value | undefined, b: Value | undefined): Value {
  for (const side of [a, b]) {
    if (side !== undefined && side.k !== "arr" && side.k !== "nullish")
      return dyn(`projects (${describeValue(side)})`);
  }
  const prev = a?.k === "arr" ? a.v : [];
  const overrides = b?.k === "arr" ? [...b.v] : [];
  const open =
    (a?.k === "arr" && a.open) || (b?.k === "arr" && b.open) || undefined;
  const nameOf = (p: Value): string | undefined => {
    const n = getPath(p, ["name"]);
    return n?.k === "str" ? n.v : undefined;
  };
  const out: Value[] = [];
  for (const project of prev) {
    const name = nameOf(project);
    const at =
      name === undefined ? -1 : overrides.findIndex((o) => nameOf(o) === name);
    if (at < 0) {
      out.push(project);
      continue;
    }
    const override = overrides.splice(at, 1)[0]!;
    const merged = shallowMerge(project, override);
    merged.v.set(
      "use",
      shallowMerge(getPath(project, ["use"]), getPath(override, ["use"])),
    );
    out.push(merged);
  }
  out.push(...overrides);
  return { k: "arr", v: out, ...(open ? { open } : {}) };
}

/**
 * `devices["Desktop Chrome"]` (spread or bare): Playwright's device
 * descriptors set none of the options read here (testIdAttribute, bypassCSP,
 * storageState, baseURL, timeouts), so the value is a closed object holding
 * only the descriptor's `defaultBrowserType` (from the host's own
 * playwright-core when it can be read, else from the device name; not
 * readable when the device name is not static). Undefined when `node` is
 * not such an access.
 */
function devicesValue(
  scope: EvalScope,
  node: TS.Expression,
): Value | undefined {
  const { ts } = scope;
  let root: TS.Expression = node;
  let key: TS.Expression | string | undefined;
  while (
    ts.isElementAccessExpression(root) ||
    ts.isPropertyAccessExpression(root)
  ) {
    key = ts.isElementAccessExpression(root)
      ? root.argumentExpression
      : root.name.text;
    root = root.expression;
  }
  if (!ts.isIdentifier(root) || root === node || key === undefined)
    return undefined;
  const imp = scope.mod.imports.get(root.text);
  if (
    imp === undefined ||
    imp.imported !== "devices" ||
    !isPlaywrightModule(imp.spec)
  )
    return undefined;
  const name =
    typeof key === "string"
      ? { k: "str" as const, v: key }
      : evaluate(scope, key);
  const out = new Map<string, Value>();
  if (name.k === "str") {
    const browser = deviceBrowser(scope.mod.dir, name.v);
    out.set(
      "defaultBrowserType",
      browser
        ? { k: "str", v: browser }
        : dyn(`devices[${JSON.stringify(name.v)}]`),
    );
  } else {
    out.set("defaultBrowserType", dyn(node.getText()));
  }
  return objOf(out, undefined);
}

const deviceTables = new Map<
  string,
  Record<string, { defaultBrowserType?: string }> | null
>();

/** The browser a Playwright device descriptor runs in. */
function deviceBrowser(fromDir: string, device: string): string | undefined {
  let table = deviceTables.get(fromDir);
  if (table === undefined) {
    table = null;
    try {
      const req = createRequire(join(fromDir, "_"));
      const core = dirname(req.resolve("playwright-core/package.json"));
      table = JSON.parse(
        readFileSync(
          join(core, "lib", "server", "deviceDescriptorsSource.json"),
          "utf8",
        ),
      ) as Record<string, { defaultBrowserType?: string }>;
    } catch {
      table = null;
    }
    deviceTables.set(fromDir, table);
  }
  const known = table?.[device]?.defaultBrowserType;
  if (known === "chromium" || known === "firefox" || known === "webkit")
    return known;
  if (table && table[device] === undefined && Object.keys(table).length > 0) {
    // not a device this Playwright knows: no browser to read
    return undefined;
  }
  if (/firefox/i.test(device)) return "firefox";
  if (/safari|iphone|ipad|webkit/i.test(device)) return "webkit";
  if (/chrome|edge|pixel|galaxy|nexus/i.test(device)) return "chromium";
  return undefined;
}

/** `path.join` / `join` / `resolvePath` … from node's path module (or url's fileURLToPath). */
function pathFunction(
  scope: EvalScope,
  callee: TS.Expression,
): string | undefined {
  const { ts, mod } = scope;
  if (ts.isIdentifier(callee)) {
    const imp = mod.imports.get(callee.text);
    if (!imp) return undefined;
    if (isPathModule(imp.spec) && PATH_FUNCTIONS.has(imp.imported))
      return imp.imported;
    if (isUrlModule(imp.spec) && imp.imported === "fileURLToPath")
      return "fileURLToPath";
    return undefined;
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    ts.isIdentifier(callee.expression)
  ) {
    const imp = mod.imports.get(callee.expression.text);
    const name = callee.name.text;
    if (
      imp &&
      isPathModule(imp.spec) &&
      (imp.imported === "default" || imp.imported === "*") &&
      PATH_FUNCTIONS.has(name)
    )
      return name;
    if (
      imp &&
      isUrlModule(imp.spec) &&
      (imp.imported === "default" || imp.imported === "*") &&
      name === "fileURLToPath"
    )
      return "fileURLToPath";
  }
  return undefined;
}

function callPath(fn: string, args: Value[], text: string): Value {
  if (!args.every((a) => a.k === "str")) return dyn(text);
  const strs = args.map((a) => (a as { v: string }).v);
  switch (fn) {
    case "join":
      return { k: "str", v: join(...strs) };
    case "normalize":
      return strs[0] !== undefined
        ? { k: "str", v: normalize(strs[0]) }
        : dyn(text);
    case "dirname":
      return strs[0] !== undefined
        ? { k: "str", v: dirname(strs[0]) }
        : dyn(text);
    case "resolve":
      // relative to the process cwd unless an absolute part anchors it
      return strs.some((s) => isAbsolute(s))
        ? { k: "str", v: resolve(...strs) }
        : dyn(text);
    case "fileURLToPath":
      try {
        return strs[0]?.startsWith("file:")
          ? { k: "str", v: fileURLToPath(strs[0]) }
          : dyn(text);
      } catch {
        return dyn(text);
      }
    default:
      return dyn(text);
  }
}

/** What `local` (an import of the current module) evaluates to. */
function importedValue(scope: EvalScope, local: string, text: string): Value {
  const imp = scope.mod.imports.get(local);
  if (!imp) return dyn(text);
  const other = scope.loader.load(scope.mod, imp.spec);
  if (!other) return dyn(`${local} (from "${imp.spec}")`);
  if (imp.imported === "*") {
    const out = new Map<string, Value>();
    for (const name of other.exports.keys()) {
      out.set(name, exportedValue(scope, other, name));
    }
    return objOf(out, undefined);
  }
  if (imp.imported === "default" && !other.exports.has("default")) {
    // `require()` of a module with named exports only, or a namespace-ish default
    const out = new Map<string, Value>();
    for (const name of other.exports.keys())
      out.set(name, exportedValue(scope, other, name));
    return out.size > 0
      ? objOf(out, undefined)
      : dyn(`${local} (from "${imp.spec}")`);
  }
  return exportedValue(scope, other, imp.imported);
}

function exportedValue(
  scope: EvalScope,
  other: ModuleScope,
  name: string,
): Value {
  const expr = other.exports.get(name);
  if (!expr) return dyn(`${name} (not exported by ${basename(other.path)})`);
  const key = `${other.path}#${name}`;
  if (scope.seen.has(key)) return dyn(name);
  scope.seen.add(key);
  try {
    return evaluate({ ...scope, mod: other }, expr);
  } finally {
    scope.seen.delete(key);
  }
}

function truthy(value: Value): boolean | undefined {
  switch (value.k) {
    case "str":
      return value.v !== "";
    case "num":
      return value.v !== 0 && !Number.isNaN(value.v);
    case "bool":
      return value.v;
    case "nullish":
      return false;
    case "obj":
    case "arr":
    case "re":
      return true;
    default:
      return undefined;
  }
}

function plainEqual(a: Value, b: Value): boolean {
  return JSON.stringify(plain(a)) === JSON.stringify(plain(b));
}

function evaluate(scope: EvalScope, node: TS.Expression): Value {
  const { ts, mod } = scope;
  if (
    ts.isParenthesizedExpression(node) ||
    ts.isAsExpression(node) ||
    ts.isSatisfiesExpression(node) ||
    ts.isNonNullExpression(node) ||
    ts.isTypeAssertionExpression(node)
  ) {
    return evaluate(scope, node.expression);
  }
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
    return { k: "str", v: node.text };
  }
  if (ts.isNumericLiteral(node)) return { k: "num", v: Number(node.text) };
  if (node.kind === ts.SyntaxKind.TrueKeyword) return { k: "bool", v: true };
  if (node.kind === ts.SyntaxKind.FalseKeyword) return { k: "bool", v: false };
  if (node.kind === ts.SyntaxKind.NullKeyword) return { k: "nullish" };
  if (ts.isRegularExpressionLiteral(node)) return { k: "re", v: node.text };
  if (ts.isTemplateExpression(node)) {
    let out = node.head.text;
    for (const span of node.templateSpans) {
      const part = evaluate(scope, span.expression);
      if (part.k !== "str" && part.k !== "num") return dyn(node.getText());
      out += String(part.v) + span.literal.text;
    }
    return { k: "str", v: out };
  }
  if (ts.isPrefixUnaryExpression(node)) {
    const operand = evaluate(scope, node.operand);
    if (operand.k === "num" && node.operator === ts.SyntaxKind.MinusToken) {
      return { k: "num", v: -operand.v };
    }
    if (node.operator === ts.SyntaxKind.ExclamationToken) {
      const t = truthy(operand);
      return t === undefined ? dyn(node.getText()) : { k: "bool", v: !t };
    }
    return dyn(node.getText());
  }
  if (ts.isObjectLiteralExpression(node)) {
    const out = new Map<string, Value>();
    let open: string | undefined;
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = propName(ts, prop.name);
        if (name !== undefined) {
          out.set(name, evaluate(scope, prop.initializer));
        } else {
          // `[key]: value` may set any option
          open = prop.name.getText();
        }
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        out.set(prop.name.text, evaluate(scope, prop.name));
      } else if (ts.isSpreadAssignment(prop)) {
        const spread = evaluate(scope, prop.expression);
        open = spreadInto(out, spread, prop.expression.getText()) ?? open;
      }
    }
    return objOf(out, open);
  }
  if (ts.isArrayLiteralExpression(node)) {
    const items: Value[] = [];
    let open: string | undefined;
    for (const element of node.elements) {
      if (ts.isSpreadElement(element)) {
        const spread = evaluate(scope, element.expression);
        if (spread.k === "arr") {
          items.push(...spread.v);
          open = spread.open ?? open;
        } else open = element.expression.getText();
      } else {
        items.push(evaluate(scope, element));
      }
    }
    return { k: "arr", v: items, ...(open ? { open } : {}) };
  }
  if (ts.isIdentifier(node)) {
    if (node.text === "undefined") return { k: "nullish" };
    if (node.text === "__dirname") return { k: "str", v: mod.dir };
    if (node.text === "__filename") return { k: "str", v: mod.path };
    const initializer = mod.top.get(node.text);
    const key = `${mod.path}:${node.text}`;
    if (initializer && !scope.seen.has(key)) {
      scope.seen.add(key);
      try {
        return evaluate(scope, initializer);
      } finally {
        scope.seen.delete(key);
      }
    }
    if (mod.imports.has(node.text))
      return importedValue(scope, node.text, node.text);
    return dyn(node.text);
  }
  const device = devicesValue(scope, node);
  if (device) return device;
  if (ts.isPropertyAccessExpression(node)) {
    if (isProcessEnv(ts, node.expression)) {
      return { k: "env", names: [node.name.text] };
    }
    if (ts.isMetaProperty(node.expression)) {
      if (node.name.text === "dirname") return { k: "str", v: mod.dir };
      if (node.name.text === "filename") return { k: "str", v: mod.path };
      if (node.name.text === "url")
        return { k: "str", v: pathToFileURL(mod.path).href };
      return dyn(node.getText());
    }
    const target = evaluate(scope, node.expression);
    if (target.k === "obj") {
      return (
        target.v.get(node.name.text) ??
        (target.open ? dyn(node.getText()) : { k: "nullish" })
      );
    }
    return dyn(node.getText());
  }
  if (ts.isElementAccessExpression(node)) {
    if (
      isProcessEnv(ts, node.expression) &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      return { k: "env", names: [node.argumentExpression.text] };
    }
    const target = evaluate(scope, node.expression);
    const index = evaluate(scope, node.argumentExpression);
    if (target.k === "obj" && index.k === "str") {
      return (
        target.v.get(index.v) ??
        (target.open ? dyn(node.getText()) : { k: "nullish" })
      );
    }
    if (target.k === "arr" && index.k === "num" && !target.open) {
      return target.v[index.v] ?? { k: "nullish" };
    }
    return dyn(node.getText());
  }
  if (ts.isCallExpression(node)) {
    const fn = pathFunction(scope, node.expression);
    if (fn) {
      return callPath(
        fn,
        node.arguments.map((a) => evaluate(scope, a)),
        node.getText(),
      );
    }
    if (/(^|\.)defineConfig$/.test(node.expression.getText())) {
      return defineConfigValue(node.arguments.map((a) => evaluate(scope, a)));
    }
    if (
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.getText() === "require.resolve" &&
      node.arguments[0] &&
      ts.isStringLiteralLike(node.arguments[0]) &&
      node.arguments[0].text.startsWith(".")
    ) {
      return { k: "str", v: resolve(mod.dir, node.arguments[0].text) };
    }
    return dyn(node.getText());
  }
  if (ts.isConditionalExpression(node)) {
    // both branches the same: the condition does not matter
    const whenTrue = evaluate(scope, node.whenTrue);
    const whenFalse = evaluate(scope, node.whenFalse);
    if (whenTrue.k !== "dyn" && plainEqual(whenTrue, whenFalse))
      return whenTrue;
    const cond = truthy(evaluate(scope, node.condition));
    if (cond !== undefined) return cond ? whenTrue : whenFalse;
    return dyn(node.getText());
  }
  if (ts.isBinaryExpression(node)) {
    const op = node.operatorToken.kind;
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const left = evaluate(scope, node.left);
      if (left.k === "env") {
        const right = evaluate(scope, node.right);
        if (right.k === "env") {
          return {
            k: "env",
            names: [...left.names, ...right.names],
            ...(right.fallback ? { fallback: right.fallback } : {}),
          };
        }
        return { k: "env", names: left.names, fallback: right };
      }
      if (left.k === "nullish") return evaluate(scope, node.right);
      if (left.k === "dyn") return dyn(node.getText());
      // a literal on the left: JavaScript truthiness decides (`0 || 90000` → 90000)
      if (op === ts.SyntaxKind.QuestionQuestionToken) return left;
      return truthy(left) === false ? evaluate(scope, node.right) : left;
    }
    const left = evaluate(scope, node.left);
    const right = evaluate(scope, node.right);
    if (left.k === "num" && right.k === "num") {
      if (op === ts.SyntaxKind.AsteriskToken) {
        return { k: "num", v: left.v * right.v };
      }
      if (op === ts.SyntaxKind.PlusToken) {
        return { k: "num", v: left.v + right.v };
      }
      if (op === ts.SyntaxKind.MinusToken) {
        return { k: "num", v: left.v - right.v };
      }
      if (op === ts.SyntaxKind.SlashToken && right.v !== 0) {
        return { k: "num", v: left.v / right.v };
      }
    }
    if (
      op === ts.SyntaxKind.PlusToken &&
      (left.k === "str" || left.k === "num") &&
      (right.k === "str" || right.k === "num") &&
      (left.k === "str" || right.k === "str")
    ) {
      return { k: "str", v: String(left.v) + String(right.v) };
    }
    return dyn(node.getText());
  }
  return dyn(node.getText());
}

/* ----- the config file ----- */

/** A `testMatch` / `testIgnore` entry: a glob or a regular expression. */
export interface HostPattern {
  kind: "glob" | "regex";
  source: string;
}

export interface HostBaseUrl {
  /** The static value, or the literal fallback behind env vars. */
  literal?: string;
  /** Env vars the config reads for it (`process.env.X || "…"`). */
  env: string[];
}

export interface HostTsconfig {
  path: string;
  module?: string;
  /**
   * The module resolution in effect: the explicit option, else the one
   * TypeScript implies from `module` (nodenext → nodenext, …).
   */
  moduleResolution?: string;
  /** Alias patterns → absolute target directories (wildcard `X/*` entries only). */
  aliases: Array<{ pattern: string; prefix: string; dir: string }>;
  allowImportingTsExtensions: boolean;
}

/** An option that exists but is not statically readable: its expression. */
export interface HostUnread {
  unread: string;
}

export function isUnread(value: unknown): value is HostUnread {
  return (
    typeof value === "object" &&
    value !== null &&
    "unread" in value &&
    typeof (value as HostUnread).unread === "string"
  );
}

/**
 * One project's options as Playwright resolves them (its own value, else the
 * top level's, else Playwright's default). A config without `projects` has
 * one implicit project: the top level.
 */
export interface HostProjectOptions {
  /** `""` for the implicit project or an unnamed one. */
  name: string;
  testDir: string | HostUnread;
  testMatch: HostPattern[] | HostUnread;
  testIgnore: HostPattern[] | HostUnread;
  timeout?: number | HostUnread;
  expectTimeout?: number | HostUnread;
  actionTimeout?: number | HostUnread;
  navigationTimeout?: number | HostUnread;
  testIdAttribute?: string | HostUnread;
  bypassCSP?: boolean | HostUnread;
  baseURL?: HostBaseUrl | HostUnread;
  /** `use.storageState`: a file path (absolute), an inline state, or unread. */
  storageState?: string | HostUnread;
  /**
   * The browser the project runs: `use.browserName`, else the device
   * descriptor's `defaultBrowserType`, else Playwright's default chromium.
   * Only `cairn export playwright --verify` reads it (to prefer a Chromium
   * project); an unread value is never a refusal.
   */
  browserName?: "chromium" | "firefox" | "webkit" | HostUnread;
}

export interface HostProfile {
  /** Absolute path of the playwright config. */
  configPath: string;
  root: string;
  /** Config option paths that exist but are not statically readable. */
  dynamic: string[];
  /** Agreed by every project (or set at the top level when there are none). */
  testDir?: string;
  testMatch?: HostPattern[];
  testIgnore?: HostPattern[];
  /** Top-level `timeout` / `expect.timeout` / `use.actionTimeout` / `use.navigationTimeout`, as every project resolves them. */
  timeout?: number;
  expectTimeout?: number;
  actionTimeout?: number;
  navigationTimeout?: number;
  testIdAttribute?: string;
  baseURL?: HostBaseUrl;
  bypassCSP?: boolean;
  workers?: number | string;
  fullyParallel?: boolean;
  /** `tsconfig:` option of the Playwright config (absolute). */
  tsconfigOption?: string;
  /** Names of `projects`. */
  projects: string[];
  /** Every project's options, resolved the way Playwright resolves them. */
  projectOptions: HostProjectOptions[];
  /** `projects` itself is not statically readable: its expression. */
  projectsUnread?: string;
  moduleSystem: "cjs" | "esm";
  moduleReason: string;
  packageJson?: string;
  tsconfig?: HostTsconfig;
  prettier?: { config: string; bin?: string };
  eslintConfig?: string;
  /** Plain-language observations the report carries. */
  notes: string[];
}

export class HostProfileError extends Error {}

/** `typescript` with the JavaScript API: the host's own (preferred), else cairntrace's. */
function loadTypescript(startDir: string): typeof TS {
  try {
    return loadTypescriptApi(startDir);
  } catch (e) {
    throw new HostProfileError(
      `cannot read the host's Playwright config statically: ${(e as Error).message}`,
    );
  }
}

/**
 * Where lookups for configs and local binaries stop: the nearest directory
 * holding `.git`, else the outermost directory (below the home directory)
 * that holds a package.json, node_modules or tsconfig.json. A stray
 * `~/.prettierrc` or a binary above the host is never picked up.
 */
export function hostBoundary(start: string): string {
  const home = realPath(homedir());
  let current = realPath(start);
  let outermost: string | undefined;
  for (let level = 0; level <= LEVELS_UP; level += 1) {
    if (current === home) break;
    if (existsSync(join(current, ".git"))) return current;
    if (
      existsSync(join(current, "package.json")) ||
      existsSync(join(current, "node_modules")) ||
      existsSync(join(current, "tsconfig.json"))
    ) {
      outermost = current;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return outermost ?? realPath(start);
}

/** The first of `names` in `start` or an ancestor up to `boundary` (inclusive). */
function findUpFile(
  start: string,
  names: string[],
  boundary: string,
): string | undefined {
  let current = realPath(start);
  for (let level = 0; level <= LEVELS_UP; level += 1) {
    for (const name of names) {
      const candidate = join(current, name);
      if (existsSync(candidate)) return candidate;
    }
    if (current === boundary) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function scriptKind(ts: typeof TS, path: string): TS.ScriptKind {
  if (path.endsWith(".tsx")) return ts.ScriptKind.TSX;
  if (/\.[cm]?ts$/.test(path)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** The value the config's default export (`export default` / `module.exports =`) resolves to. */
function configValue(loader: ModuleLoader, mod: ModuleScope): Value {
  const exported = mod.exports.get("default");
  if (!exported) {
    throw new HostProfileError(
      "no default export found (expected `export default defineConfig({...})`, `export default config` or `module.exports = ...`)",
    );
  }
  return evaluate({ ts: loader.ts, mod, seen: new Set(), loader }, exported);
}

function getPath(root: Value | undefined, path: string[]): Value | undefined {
  let current: Value | undefined = root;
  for (const key of path) {
    if (current === undefined) return undefined;
    if (current.k === "dyn") return current;
    if (current.k !== "obj") return undefined;
    const next: Value | undefined = current.v.get(key);
    if (next === undefined) {
      return current.open
        ? dyn(`${key} (behind ...${current.open})`)
        : undefined;
    }
    current = next;
  }
  return current;
}

/** Unset (absent, `undefined`, `null`) in Playwright's `takeFirst` sense. */
function unset(value: Value | undefined): boolean {
  return value === undefined || value.k === "nullish";
}

/**
 * One option for one project, the way Playwright's FullProjectInternal
 * resolves it: `takeFirst(project.X, config.X)`, `use` merged key by key,
 * `expect` taken whole from the project when it has one.
 */
function projectValue(
  project: Value,
  top: Value,
  path: string[],
): Value | undefined {
  if (path[0] === "expect") {
    const own = getPath(project, ["expect"]);
    const expect = unset(own) ? getPath(top, ["expect"]) : own;
    return unset(expect) ? undefined : getPath(expect, path.slice(1));
  }
  const own = getPath(project, path);
  if (!unset(own)) return own;
  const fallback = project === top ? undefined : getPath(top, path);
  return unset(fallback) ? undefined : fallback;
}

function plain(value: Value): unknown {
  switch (value.k) {
    case "str":
    case "num":
    case "bool":
    case "re":
      return value.v;
    case "arr":
      return { arr: value.v.map(plain), open: value.open };
    case "obj":
      return {
        obj: Object.fromEntries([...value.v].map(([k, v]) => [k, plain(v)])),
        open: value.open,
      };
    case "env":
      return {
        env: value.names,
        fallback: value.fallback && plain(value.fallback),
      };
    case "nullish":
      return null;
    case "dyn":
      return { dyn: value.text };
  }
}

function patternsOf(value: Value): HostPattern[] | HostUnread {
  if (value.k === "arr" && value.open) return { unread: describeValue(value) };
  const items = value.k === "arr" ? value.v : [value];
  const out: HostPattern[] = [];
  for (const item of items) {
    if (item.k === "str") out.push({ kind: "glob", source: item.v });
    else if (item.k === "re") out.push({ kind: "regex", source: item.v });
    else return { unread: describeValue(item) };
  }
  return out;
}

/* ----- tsconfig / package.json / prettier ----- */

/** TypeScript's implied resolution for a `module` setting (when the API cannot say). */
function impliedResolution(moduleName: string | undefined): string | undefined {
  switch (moduleName) {
    case "node16":
    case "node18":
    case "node20":
      return "node16";
    case "nodenext":
      return "nodenext";
    case "preserve":
      return "bundler";
    case "commonjs":
      return "node10";
    default:
      return undefined;
  }
}

function readTsconfig(
  ts: typeof TS,
  path: string,
): HostTsconfig | { error: string } {
  const read = ts.readConfigFile(path, ts.sys.readFile);
  if (read.error) {
    return {
      error: ts.flattenDiagnosticMessageText(read.error.messageText, "\n"),
    };
  }
  const parsed = ts.parseJsonConfigFileContent(
    read.config,
    ts.sys,
    dirname(path),
    undefined,
    path,
  );
  const options = parsed.options;
  const base =
    (options as { pathsBasePath?: string }).pathsBasePath ??
    options.baseUrl ??
    dirname(path);
  const aliases: HostTsconfig["aliases"] = [];
  for (const [pattern, targets] of Object.entries(options.paths ?? {})) {
    if (!pattern.endsWith("/*") || targets.length === 0) continue;
    const target = targets[0]!;
    if (!target.endsWith("/*")) continue;
    aliases.push({
      pattern,
      prefix: pattern.slice(0, -1),
      dir: resolve(base, target.slice(0, -2)),
    });
  }
  const moduleName =
    options.module !== undefined
      ? ts.ModuleKind[options.module]?.toLowerCase()
      : undefined;
  // The resolution in effect, implied by `module` when not set (M1).
  const effective = (
    ts as unknown as {
      getEmitModuleResolutionKind?: (o: TS.CompilerOptions) => number;
    }
  ).getEmitModuleResolutionKind;
  let resolutionName: string | undefined;
  if (options.moduleResolution !== undefined) {
    resolutionName = ts.ModuleResolutionKind[options.moduleResolution];
  } else if (typeof effective === "function") {
    try {
      resolutionName = ts.ModuleResolutionKind[effective(options)];
    } catch {
      resolutionName = impliedResolution(moduleName);
    }
  } else {
    resolutionName = impliedResolution(moduleName);
  }
  return {
    path,
    ...(moduleName ? { module: moduleName } : {}),
    ...(resolutionName
      ? { moduleResolution: resolutionName.toLowerCase() }
      : {}),
    aliases,
    allowImportingTsExtensions: options.allowImportingTsExtensions === true,
  };
}

const PRETTIER_CONFIGS = [
  ".prettierrc",
  ".prettierrc.json",
  ".prettierrc.yaml",
  ".prettierrc.yml",
  ".prettierrc.json5",
  ".prettierrc.js",
  ".prettierrc.cjs",
  ".prettierrc.mjs",
  ".prettierrc.ts",
  ".prettierrc.cts",
  ".prettierrc.mts",
  ".prettierrc.toml",
  "prettier.config.js",
  "prettier.config.cjs",
  "prettier.config.mjs",
  "prettier.config.ts",
  "prettier.config.cts",
  "prettier.config.mts",
];

const ESLINT_CONFIGS = [
  "eslint.config.js",
  "eslint.config.mjs",
  "eslint.config.cjs",
  "eslint.config.ts",
  "eslint.config.mts",
  "eslint.config.cts",
  ".eslintrc",
  ".eslintrc.js",
  ".eslintrc.cjs",
  ".eslintrc.json",
  ".eslintrc.yaml",
  ".eslintrc.yml",
];

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The prettier config in effect for `dir` (up to the host boundary): a config file or a package.json key. */
function findPrettierConfig(dir: string, boundary: string): string | undefined {
  let current = realPath(dir);
  for (let level = 0; level <= LEVELS_UP; level += 1) {
    for (const name of PRETTIER_CONFIGS) {
      if (existsSync(join(current, name))) return join(current, name);
    }
    const pkg = join(current, "package.json");
    if (existsSync(pkg)) {
      try {
        const json = JSON.parse(readFileSync(pkg, "utf8")) as {
          prettier?: unknown;
        };
        if (json.prettier !== undefined) return pkg;
      } catch {
        // an unreadable package.json is not a prettier config
      }
    }
    if (current === boundary) return undefined;
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
  return undefined;
}

function findLocalBin(
  start: string,
  name: string,
  boundary: string,
): string | undefined {
  return findUpFile(start, [join("node_modules", ".bin", name)], boundary);
}

/* ----- reading a profile ----- */

export interface ReadHostProfileOptions {
  /** The playwright config (absolute or relative to `cwd`). */
  configPath: string;
  /** The export directory the profile adapts (tsconfig / package.json / prettier lookups start here). */
  into?: string;
  cwd?: string;
}

/** Option paths read per project, by the label notes and `dynamic` use. */
const PROJECT_OPTIONS = {
  testDir: ["testDir"],
  testMatch: ["testMatch"],
  testIgnore: ["testIgnore"],
  timeout: ["timeout"],
  expectTimeout: ["expect", "timeout"],
  actionTimeout: ["use", "actionTimeout"],
  navigationTimeout: ["use", "navigationTimeout"],
  testIdAttribute: ["use", "testIdAttribute"],
  bypassCSP: ["use", "bypassCSP"],
  baseURL: ["use", "baseURL"],
  storageState: ["use", "storageState"],
} as const;

type ProjectOptionKey = keyof typeof PROJECT_OPTIONS;

function labelOf(key: ProjectOptionKey): string {
  return PROJECT_OPTIONS[key].join(".");
}

function projectLabel(name: string): string {
  return name === "" ? "" : ` (project ${name})`;
}

/** One project's typed options from its resolved values. */
function projectOptions(
  root: string,
  name: string,
  resolveValue: (path: readonly string[]) => Value | undefined,
  notes: string[],
): HostProjectOptions {
  const unread = (value: Value): HostUnread => ({
    unread: describeValue(value),
  });
  const num = (key: ProjectOptionKey): number | HostUnread | undefined => {
    const v = resolveValue(PROJECT_OPTIONS[key]);
    if (unset(v)) return undefined;
    return v!.k === "num" ? v!.v : unread(v!);
  };
  const testDirValue = resolveValue(PROJECT_OPTIONS.testDir);
  const out: HostProjectOptions = {
    name,
    testDir: unset(testDirValue)
      ? root
      : testDirValue!.k === "str"
        ? resolve(root, testDirValue!.v)
        : unread(testDirValue!),
    testMatch: DEFAULT_TEST_MATCH,
    testIgnore: [],
  };
  for (const key of ["testMatch", "testIgnore"] as const) {
    const v = resolveValue(PROJECT_OPTIONS[key]);
    if (!unset(v)) out[key] = patternsOf(v!);
  }
  for (const key of [
    "timeout",
    "expectTimeout",
    "actionTimeout",
    "navigationTimeout",
  ] as const) {
    const v = num(key);
    if (v !== undefined) out[key] = v;
  }
  const testId = resolveValue(PROJECT_OPTIONS.testIdAttribute);
  if (!unset(testId)) {
    if (testId!.k === "str") out.testIdAttribute = testId!.v;
    else if (testId!.k === "env" && testId!.fallback?.k === "str") {
      // `process.env.X ?? "data-qa"`: the literal fallback, said out loud
      out.testIdAttribute = testId!.fallback.v;
      notes.push(
        `use.testIdAttribute${projectLabel(name)} reads ${describeValue(testId!)}; the export assumes its fallback "${testId!.fallback.v}"`,
      );
    } else out.testIdAttribute = unread(testId!);
  }
  const bypass = resolveValue(PROJECT_OPTIONS.bypassCSP);
  if (!unset(bypass)) {
    out.bypassCSP = bypass!.k === "bool" ? bypass!.v : unread(bypass!);
  }
  const baseUrl = resolveValue(PROJECT_OPTIONS.baseURL);
  if (!unset(baseUrl)) {
    if (baseUrl!.k === "str") out.baseURL = { literal: baseUrl!.v, env: [] };
    else if (baseUrl!.k === "env") {
      out.baseURL = {
        ...(baseUrl!.fallback?.k === "str"
          ? { literal: baseUrl!.fallback.v }
          : {}),
        env: [...new Set(baseUrl!.names)].toSorted(),
      };
    } else out.baseURL = unread(baseUrl!);
  }
  const browser = [
    ["use", "browserName"],
    ["use", "defaultBrowserType"],
  ]
    .map((path) => resolveValue(path))
    .find((v) => !unset(v));
  out.browserName =
    browser === undefined
      ? "chromium"
      : browser.k === "str" &&
          (browser.v === "chromium" ||
            browser.v === "firefox" ||
            browser.v === "webkit")
        ? browser.v
        : unread(browser);
  const state = resolveValue(PROJECT_OPTIONS.storageState);
  if (!unset(state)) {
    out.storageState =
      state!.k === "str"
        ? resolve(root, state!.v)
        : state!.k === "obj" && !state!.open
          ? "(inline storage state)"
          : unread(state!);
  }
  return out;
}

/**
 * Read a host's Playwright config statically, plus its tsconfig, nearest
 * package.json and prettier setup. Throws a `HostProfileError` naming the
 * problem (missing file, unparseable config, no `typescript` package).
 */
export async function readHostProfile(
  options: ReadHostProfileOptions,
): Promise<HostProfile> {
  const cwd = options.cwd ?? process.cwd();
  const configPath = realPath(
    isAbsolute(options.configPath)
      ? options.configPath
      : resolve(cwd, options.configPath),
  );
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new HostProfileError(
      `host Playwright config not found: ${configPath}`,
    );
  }
  const root = dirname(configPath);
  // `into` may not exist yet: its real path is the nearest existing ancestor's.
  const lookupStart = options.into
    ? realpathNearest(resolve(cwd, options.into))
    : root;
  const boundary = hostBoundary(
    isInside(root, lookupStart) || isInside(lookupStart, root)
      ? lookupStart
      : root,
  );
  const ts = loadTypescript(root);
  const loader = new ModuleLoader(ts);
  let value: Value;
  try {
    value = configValue(
      loader,
      loader.parse(configPath, readFileSync(configPath, "utf8")),
    );
  } catch (e) {
    throw new HostProfileError(
      `cannot read ${basename(configPath)} statically: ${(e as Error).message}`,
    );
  }
  if (value.k !== "obj") {
    throw new HostProfileError(
      `cannot read ${basename(configPath)} statically: the exported config is not an object literal (it is computed: ${describeValue(value)})`,
    );
  }
  const config = value;
  const notes: string[] = [];
  const dynamic: string[] = [];
  const markDynamic = (label: string, expression: string, project = "") => {
    if (!dynamic.includes(label)) dynamic.push(label);
    const note = `\`${label}\`${projectLabel(project)} is not statically readable (${expression})`;
    if (!notes.includes(note)) notes.push(note);
  };
  if (config.open) {
    notes.push(
      `the config spreads or merges something that cannot be read statically (${config.open}); options it may set are treated as not readable`,
    );
  }

  // Projects: Playwright runs the top level as one project when there are none.
  const projectsValue = getPath(config, ["projects"]);
  let projectValues: Value[];
  let projectsUnread: string | undefined;
  if (unset(projectsValue)) {
    projectValues = [config];
  } else if (projectsValue!.k === "arr") {
    projectValues = projectsValue!.v;
    if (projectsValue!.open) projectsUnread = `...${projectsValue!.open}`;
    for (const p of projectValues) {
      if (p.k !== "obj") projectsUnread ??= describeValue(p);
    }
  } else {
    projectValues = [];
    projectsUnread = describeValue(projectsValue!);
  }
  if (projectsUnread) markDynamic("projects", projectsUnread);
  const projectObjs = projectValues.filter((p): p is ObjValue => p.k === "obj");
  const projectNames = projectObjs
    .map((project) => getPath(project, ["name"]))
    .map((name) => (name?.k === "str" ? name.v : ""));
  const named = projectNames.filter((n) => n !== "");
  if (projectObjs.length > 1) {
    notes.push(
      `the host has ${projectObjs.length} projects (${named.join(", ") || "unnamed"}); each project's own options win over the top level, and only the projects that discover the generated tests count`,
    );
  }
  const perProject = projectObjs.map((project, i) =>
    projectOptions(
      root,
      project === config ? "" : (projectNames[i] ?? ""),
      (path) => projectValue(project, config, [...path]),
      notes,
    ),
  );
  for (const p of perProject) {
    for (const key of Object.keys(PROJECT_OPTIONS) as ProjectOptionKey[]) {
      const v = p[key];
      if (isUnread(v)) markDynamic(labelOf(key), v.unread, p.name);
    }
  }

  const profile: HostProfile = {
    configPath,
    root,
    dynamic,
    projects: named,
    projectOptions: perProject,
    ...(projectsUnread ? { projectsUnread } : {}),
    moduleSystem: "cjs",
    moduleReason: "",
    notes,
  };

  // What every project agrees on (the report and older callers read these).
  const agreed = <K extends ProjectOptionKey>(
    key: K,
  ): HostProjectOptions[K] | undefined => {
    if (perProject.length === 0 || projectsUnread) return undefined;
    const first = perProject[0]![key];
    if (isUnread(first)) return undefined;
    for (const p of perProject.slice(1)) {
      if (isUnread(p[key])) return undefined;
      // projects that disagree: resolveHostEmit decides from the ones that run the tests
      if (JSON.stringify(p[key]) !== JSON.stringify(first)) return undefined;
    }
    return first;
  };
  const testDir = agreed("testDir");
  if (typeof testDir === "string") profile.testDir = testDir;
  const testMatchValue = getPath(config, ["testMatch"]);
  const testMatch = agreed("testMatch");
  if (
    Array.isArray(testMatch) &&
    (!unset(testMatchValue) ||
      perProject.some((p) => p.testMatch !== DEFAULT_TEST_MATCH))
  )
    profile.testMatch = testMatch;
  const testIgnore = agreed("testIgnore");
  if (Array.isArray(testIgnore) && testIgnore.length > 0)
    profile.testIgnore = testIgnore;
  for (const key of [
    "timeout",
    "expectTimeout",
    "actionTimeout",
    "navigationTimeout",
  ] as const) {
    const v = agreed(key);
    if (typeof v === "number") profile[key] = v;
  }
  const testId = agreed("testIdAttribute");
  if (typeof testId === "string") profile.testIdAttribute = testId;
  const bypass = agreed("bypassCSP");
  if (typeof bypass === "boolean") profile.bypassCSP = bypass;
  const baseUrl = agreed("baseURL");
  if (baseUrl && !isUnread(baseUrl)) profile.baseURL = baseUrl;

  const tsconfigValue = getPath(config, ["tsconfig"]);
  if (!unset(tsconfigValue)) {
    if (tsconfigValue!.k === "str") {
      profile.tsconfigOption = resolve(root, tsconfigValue!.v);
    } else markDynamic("tsconfig", describeValue(tsconfigValue!));
  }
  const workers = getPath(config, ["workers"]);
  if (workers?.k === "num" || workers?.k === "str") profile.workers = workers.v;
  const fullyParallel = getPath(config, ["fullyParallel"]);
  if (fullyParallel?.k === "bool") profile.fullyParallel = fullyParallel.v;

  // package.json type decides how Playwright loads .ts/.js (ESM only when "module").
  const packageJson = findUpFile(lookupStart, ["package.json"], boundary);
  let packageType: string | undefined;
  if (packageJson) {
    profile.packageJson = packageJson;
    try {
      const json = JSON.parse(readFileSync(packageJson, "utf8")) as {
        type?: string;
      };
      packageType = json.type;
    } catch {
      notes.push(
        `${basename(packageJson)} is not valid JSON; treated as CommonJS`,
      );
    }
  }

  const tsconfigPath =
    profile.tsconfigOption ??
    findUpFile(lookupStart, ["tsconfig.json"], boundary);
  if (tsconfigPath) {
    const read = readTsconfig(ts, tsconfigPath);
    if ("error" in read) {
      notes.push(
        `could not read ${basename(tsconfigPath)}: ${read.error.split("\n")[0]}`,
      );
    } else {
      profile.tsconfig = read;
    }
  }

  if (packageType === "module") {
    profile.moduleSystem = "esm";
    profile.moduleReason = `${relativeLabel(root, packageJson!)} has "type": "module"`;
    if (profile.tsconfig?.module === "commonjs") {
      notes.push(
        `package.json is "type": "module" but tsconfig module is commonjs; generated code follows package.json (what Playwright loads)`,
      );
    }
  } else {
    profile.moduleSystem = "cjs";
    profile.moduleReason = packageJson
      ? `${relativeLabel(root, packageJson)} has no "type": "module"${
          profile.tsconfig?.module
            ? ` (tsconfig module ${profile.tsconfig.module})`
            : ""
        }`
      : "no package.json found; Playwright loads TypeScript as CommonJS";
    const tsModule = profile.tsconfig?.module;
    if (
      tsModule &&
      /^(es|node)|preserve/.test(tsModule) &&
      tsModule !== "commonjs"
    ) {
      notes.push(
        `tsconfig module is ${tsModule} but package.json is not "type": "module": Playwright loads these files as CommonJS, so the generated code uses __dirname`,
      );
    }
  }

  const prettierConfig = findPrettierConfig(lookupStart, boundary);
  if (prettierConfig) {
    const bin = findLocalBin(lookupStart, "prettier", boundary);
    profile.prettier = {
      config: prettierConfig,
      ...(bin ? { bin } : {}),
    };
  }
  const eslintConfig = findUpFile(lookupStart, ESLINT_CONFIGS, boundary);
  if (eslintConfig) profile.eslintConfig = eslintConfig;
  return profile;
}

function relativeLabel(root: string, path: string): string {
  const rel = relative(root, path).split(sep).join("/");
  return rel === "" ? basename(path) : rel;
}

/* ----- what the exporter takes from a profile ----- */

/** The decisions the exporter makes from a host profile. */
export interface HostEmit {
  moduleSystem: "cjs" | "esm";
  /** Why (package.json type, tsconfig module). */
  moduleReason: string;
  /** Extension appended to relative imports of generated modules (TypeScript). */
  importExt: "" | ".js";
  /** The host's tsconfig allows `import "./x.ts"`; otherwise `.ts` specifiers are rewritten. */
  tsExtensions: boolean;
  /**
   * The per-test timeout of the projects that run the generated tests
   * (Playwright's default 30s when unset). Undefined when it is not
   * statically readable or those projects disagree: every test then sets its
   * own derived budget.
   */
  testTimeoutMs?: number;
  /**
   * The test id attribute `getByTestId` reads in the host. Undefined when not
   * statically readable or the projects disagree: `testid` locators are then
   * explicit attribute selectors.
   */
  testIdAttribute?: string;
  /** Subfolder of the export root that holds the generated tests ("" = the root itself). */
  testsDir: string;
  /** Test file suffix before the extension (`.spec`, `.test`). */
  testSuffix: string;
  /** Projects that discover the generated tests (`""` = the implicit one). */
  projects?: string[];
  /** A tsconfig path alias that covers the export root. */
  alias?: { prefix: string; dir: string };
  /** Every project that runs the generated tests sets `use.bypassCSP: true`. */
  bypassCsp: boolean;
  /** `bypassCSP` could not be read statically or the projects disagree (not simply absent). */
  bypassCspDynamic: boolean;
  /**
   * Those projects start signed in (`use.storageState`): a `coldStart: guest`
   * spec resets it to an empty state. The path, `"(inline storage state)"`,
   * or `"(not statically readable)"`.
   */
  storageState?: string;
  /** Vendored runtime files carry an eslint-disable header (the host lints). */
  lintDisableVendored: boolean;
  /** Format generated files with this local prettier (config found + binary found). */
  prettier?: { bin: string; config: string };
  /** What was decided and why (the report's `host.notes`). */
  notes: string[];
}

/** Glob → regular expression (fallback when Playwright's own minimatch cannot be loaded). */
export function globToRegExp(glob: string): RegExp {
  let out = "";
  const closers: string[] = [];
  for (let i = 0; i < glob.length; i += 1) {
    const c = glob[i]!;
    const next = glob[i + 1];
    if (c === "*" && next === "*") {
      const after = glob[i + 2];
      if (after === "/") {
        out += "(?:.*/)?";
        i += 2;
      } else {
        out += ".*";
        i += 1;
      }
    } else if (c === "*" && next === "(") {
      out += "(?:";
      closers.push(")*");
      i += 1;
    } else if (
      (c === "@" || c === "?" || c === "+" || c === "!") &&
      next === "("
    ) {
      out += "(?:";
      closers.push(c === "@" ? ")" : c === "?" ? ")?" : c === "+" ? ")+" : ")");
      i += 1;
    } else if (c === "*") {
      out += "[^/]*";
    } else if (c === "?") {
      out += "[^/]";
    } else if (c === "{") {
      out += "(?:";
      closers.push(")");
    } else if (c === "}" && closers.length > 0) {
      out += closers.pop();
    } else if (c === ")" && closers.length > 0) {
      out += closers.pop();
    } else if (c === "," && closers.length > 0) {
      out += "|";
    } else if (c === "|" && closers.length > 0) {
      out += "|";
    } else if (c === "[") {
      const end = glob.indexOf("]", i + 1);
      if (end > i) {
        out += glob.slice(i, end + 1);
        i = end;
      } else out += "\\[";
    } else if (/[.+^$|()\\\]]/.test(c)) {
      out += `\\${c}`;
    } else {
      out += c;
    }
  }
  return new RegExp(`^${out}$`, "i");
}

type Minimatch = (
  path: string,
  pattern: string,
  options: { nocase: boolean; dot: boolean },
) => boolean;

/** Playwright's own minimatch (the host's playwright-core, else cairntrace's). */
function loadMinimatch(root: string): Minimatch | undefined {
  for (const from of [join(root, "noop.js"), fileURLToPath(import.meta.url)]) {
    try {
      const bundle = createRequire(from)("playwright-core/lib/utilsBundle") as {
        minimatch?: Minimatch;
      };
      if (typeof bundle.minimatch === "function") return bundle.minimatch;
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/**
 * Playwright's `createFileMatcher`: a regex is tested against the absolute
 * file path; a glob not starting with `**​/` gets that prefix and is matched
 * against the absolute path (case-insensitive, dotfiles included).
 */
function fileMatcher(
  patterns: readonly HostPattern[],
  minimatch: Minimatch | undefined,
): (absPath: string) => boolean {
  return (absPath) => {
    const unix = absPath.split(sep).join("/");
    for (const pattern of patterns) {
      if (pattern.kind === "regex") {
        const match = /^\/(.*)\/([a-z]*)$/s.exec(pattern.source);
        try {
          const re = match
            ? new RegExp(match[1]!, match[2])
            : new RegExp(pattern.source);
          if (re.test(absPath) || (sep === "\\" && re.test(unix))) return true;
        } catch {
          // an invalid regex matches nothing
        }
        continue;
      }
      const glob = pattern.source.startsWith("**/")
        ? pattern.source
        : `**/${pattern.source}`;
      if (minimatch) {
        if (minimatch(absPath, glob, { nocase: true, dot: true })) return true;
      } else if (globToRegExp(glob).test(unix)) {
        return true;
      }
    }
    return false;
  };
}

/** Playwright's default `testMatch`. */
const DEFAULT_TEST_MATCH: HostPattern[] = [
  { kind: "glob", source: "**/*.@(spec|test).?(c|m)[jt]s?(x)" },
];

function listProjects(list: readonly HostProjectOptions[]): string {
  return list.map((p) => p.name || "(unnamed)").join(", ");
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface ResolveHostEmitOptions {
  /** Absolute export root (`--into`). */
  into: string;
  lang: "ts" | "js";
}

/** One option across the projects that run the generated tests. */
function across<T>(
  running: readonly HostProjectOptions[],
  pick: (p: HostProjectOptions) => T | HostUnread | undefined,
):
  | { kind: "value"; value: T | undefined }
  | { kind: "unread"; expression: string }
  | { kind: "differs"; detail: string } {
  const values = running.map(pick);
  const unreadOne = values.find(isUnread);
  if (unreadOne) return { kind: "unread", expression: unreadOne.unread };
  const first = JSON.stringify(values[0]);
  if (values.every((v) => JSON.stringify(v) === first)) {
    return { kind: "value", value: values[0] as T | undefined };
  }
  return {
    kind: "differs",
    detail: running
      .map(
        (p, i) =>
          `${p.name || "default"}: ${JSON.stringify(values[i]) ?? "unset"}`,
      )
      .join(", "),
  };
}

/**
 * Turn a profile into the exporter's decisions for one `--into` tree. Throws a
 * `HostProfileError` when generated tests would not be discovered by the
 * host (`testDir` / `testMatch` / `testIgnore`), or when discovery cannot be
 * read statically.
 */
export function resolveHostEmit(
  profile: HostProfile,
  options: ResolveHostEmitOptions,
): HostEmit {
  const into = realpathNearest(resolve(options.into));
  const notes: string[] = [...profile.notes];
  const fixHint =
    'make it readable without running the config (literals, constants, relative imports cairn can parse, path.join / path.resolve(__dirname, "…")), or export without --host-config';
  if (profile.projectsUnread) {
    throw new HostProfileError(
      `the host's \`projects\` is not statically readable (${profile.projectsUnread}), so cairn cannot tell which projects run the generated tests or with which options; ${fixHint}`,
    );
  }
  const projects = profile.projectOptions;
  if (projects.length === 0) {
    throw new HostProfileError(
      "the host config declares an empty `projects` list; Playwright would run nothing",
    );
  }
  for (const p of projects) {
    for (const key of ["testDir", "testMatch", "testIgnore"] as const) {
      const v = p[key];
      if (isUnread(v)) {
        throw new HostProfileError(
          `the host's \`${key}\`${projectLabel(p.name)} is not statically readable (${v.unread}), so cairn cannot check that Playwright discovers the generated tests; ${fixHint}`,
        );
      }
    }
  }
  const dirs = projects.map((p) => p.testDir as string);

  let testsDir: string | undefined;
  if (dirs.some((dir) => isInside(dir, into))) {
    testsDir = "";
  } else {
    const inner = dirs.find((dir) => isInside(into, dir));
    if (inner) testsDir = relative(into, inner).split(sep).join("/");
  }
  if (testsDir === undefined) {
    throw new HostProfileError(
      `the host's testDir (${dirs
        .map((dir) => relativeLabel(profile.root, dir))
        .filter((d, i, all) => all.indexOf(d) === i)
        .join(
          ", ",
        )}) neither contains nor sits inside the export directory (${relativeLabel(profile.root, into)}), so Playwright would never discover the generated tests; point --into at a folder under testDir`,
    );
  }

  const minimatch = loadMinimatch(profile.root);
  const sample = (suffix: string) =>
    join(into, testsDir!, `sample${suffix}.ts`);
  const discovers = (p: HostProjectOptions, file: string): boolean =>
    isInside(p.testDir as string, file) &&
    fileMatcher(p.testMatch as HostPattern[], minimatch)(file) &&
    !fileMatcher(p.testIgnore as HostPattern[], minimatch)(file);
  let suffix: string | undefined;
  let running: HostProjectOptions[] = [];
  for (const candidate of [".spec", ".test", ".e2e"]) {
    const file = sample(candidate);
    running = projects.filter((p) => discovers(p, file));
    if (running.length > 0) {
      suffix = candidate;
      break;
    }
  }
  if (!suffix) {
    const ignores = projects.some(
      (p) => (p.testIgnore as HostPattern[]).length > 0,
    );
    throw new HostProfileError(
      `none of the usual test file names (*.spec.ts, *.test.ts, *.e2e.ts) under ${relativeLabel(profile.root, join(into, testsDir)) || "."} match the host's testMatch${
        ignores ? " / testIgnore" : ""
      }; Playwright would not run the generated tests`,
    );
  }
  if (suffix !== ".spec") {
    notes.push(`tests are named *${suffix}.ts to match the host's testMatch`);
  }
  if (running.length < projects.length) {
    notes.push(
      `the generated tests run in project(s) ${listProjects(running)}; ${listProjects(
        projects.filter((p) => !running.includes(p)),
      )} do not discover them, so their options do not count`,
    );
  }

  const tsconfig = profile.tsconfig;
  let importExt: "" | ".js" = "";
  if (
    options.lang === "ts" &&
    tsconfig &&
    (tsconfig.moduleResolution === "node16" ||
      tsconfig.moduleResolution === "nodenext") &&
    profile.moduleSystem === "esm"
  ) {
    importExt = ".js";
    notes.push(
      `relative imports end in .js (tsconfig moduleResolution ${tsconfig.moduleResolution} in an ESM package)`,
    );
  }

  let alias: HostEmit["alias"];
  if (options.lang === "ts" && tsconfig) {
    const covering = tsconfig.aliases
      .filter((entry) => isInside(entry.dir, into))
      .toSorted((a, b) => b.dir.length - a.dir.length)[0];
    if (covering) {
      alias = { prefix: covering.prefix, dir: covering.dir };
      notes.push(
        `generated modules import each other through the tsconfig alias ${covering.pattern}`,
      );
    }
  }

  // Timeout: what the running projects agree on; unread / differing → each
  // test sets its own derived budget (never a guessed host value).
  let testTimeoutMs: number | undefined;
  const timeout = across(running, (p) => p.timeout);
  if (timeout.kind === "value") {
    const v = timeout.value as number | undefined;
    if (v === 0) {
      testTimeoutMs = Number.MAX_SAFE_INTEGER;
      notes.push("the host disables the test timeout (timeout: 0)");
    } else {
      testTimeoutMs =
        v !== undefined && v > 0 ? v : PLAYWRIGHT_DEFAULT_TEST_TIMEOUT_MS;
    }
  } else {
    notes.push(
      timeout.kind === "unread"
        ? `the host's test timeout is not statically readable (${timeout.expression}); every generated test sets its own derived budget with test.setTimeout`
        : `the test timeout differs between the projects that run the generated tests (${timeout.detail}); every generated test sets its own derived budget with test.setTimeout`,
    );
  }

  let testIdAttribute: string | undefined;
  const testId = across(running, (p) => p.testIdAttribute);
  if (testId.kind === "value") {
    testIdAttribute =
      (testId.value as string | undefined) ??
      PLAYWRIGHT_DEFAULT_TEST_ID_ATTRIBUTE;
  } else {
    notes.push(
      testId.kind === "unread"
        ? `use.testIdAttribute is not statically readable (${testId.expression}); testid locators are emitted as explicit attribute selectors`
        : `use.testIdAttribute differs between the projects that run the generated tests (${testId.detail}); testid locators are emitted as explicit attribute selectors`,
    );
  }

  const bypass = across(running, (p) => p.bypassCSP);
  const bypassCsp = bypass.kind === "value" && bypass.value === true;
  const bypassCspDynamic = bypass.kind !== "value";
  if (bypass.kind === "differs") {
    notes.push(
      `use.bypassCSP differs between the projects that run the generated tests (${bypass.detail}); page evals count as not bypassed`,
    );
  } else if (bypass.kind === "unread") {
    notes.push(
      `use.bypassCSP is not statically readable (${bypass.expression}); page evals count as not bypassed`,
    );
  }

  const states = running
    .map((p) => p.storageState)
    .filter((s) => s !== undefined);
  const storageState =
    states.length === 0
      ? undefined
      : states.some(isUnread)
        ? "(not statically readable)"
        : (states[0] as string);
  if (storageState) {
    notes.push(
      `the projects that run the generated tests start signed in (use.storageState ${
        storageState.startsWith("(")
          ? storageState
          : relativeLabel(profile.root, storageState)
      }); coldStart: guest specs reset it with test.use({ storageState: { cookies: [], origins: [] } })`,
    );
  }

  const prettier = profile.prettier?.bin
    ? { bin: profile.prettier.bin, config: profile.prettier.config }
    : undefined;
  if (profile.prettier && !profile.prettier.bin) {
    notes.push(
      `a prettier config exists (${relativeLabel(profile.root, profile.prettier.config)}) but no local node_modules/.bin/prettier; generated files are not formatted (cairn never installs one)`,
    );
  }

  return {
    moduleSystem: profile.moduleSystem,
    moduleReason: profile.moduleReason,
    importExt,
    tsExtensions: tsconfig?.allowImportingTsExtensions === true,
    ...(testTimeoutMs !== undefined ? { testTimeoutMs } : {}),
    ...(testIdAttribute !== undefined ? { testIdAttribute } : {}),
    testsDir,
    testSuffix: suffix,
    projects: running.map((p) => p.name),
    ...(alias ? { alias } : {}),
    bypassCsp,
    bypassCspDynamic,
    ...(storageState ? { storageState } : {}),
    lintDisableVendored: profile.eslintConfig !== undefined,
    ...(prettier ? { prettier } : {}),
    notes,
  };
}
