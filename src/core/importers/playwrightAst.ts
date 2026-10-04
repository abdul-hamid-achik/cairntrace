import { existsSync, readFileSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";
import type * as TS from "typescript";
import type { Locator, Outcome, Spec, Step } from "../schema/spec.v1";
import {
  isIdentifierHeader,
  looksCredentialKey,
  looksSecretName,
  looksSecretValue,
  numberAsSecretNote,
  placeholderKey,
  redactUrlCredentials,
  secretPlaceholder,
  secretShapedSubstrings,
  slug,
  snakeId,
  type ImportItem,
  type ImportItemKind,
  type SecretSink,
} from "./importCommon";
import {
  countOutcome,
  textOutcome,
  visibilityOutcome,
  type OutcomeResult,
  type TextMatcherDraft,
} from "./assertionOutcomes";
import {
  chainToLocator,
  cssForTestId,
  emptyChain,
  parseSourceSelector,
  plainRegexText,
  type LocChain,
  type ResolvedLocator,
} from "./playwrightLocators";

/**
 * The `@playwright/test` importer: a TypeScript AST walk that maps the
 * statically resolvable calls of ONE test (its body, the `beforeEach` hooks
 * around it, `test.step` bodies, page-object methods, helper functions and
 * custom fixtures read from relative imports) to Cairntrace steps, locators
 * and outcomes. Anything it cannot map is an `unmapped` item with a reason,
 * never a silent drop; anything it maps loosely is `approximated` with a note.
 * Nothing is ever executed.
 */

type FnNode =
  | TS.FunctionDeclaration
  | TS.FunctionExpression
  | TS.ArrowFunction
  | TS.MethodDeclaration
  | TS.GetAccessorDeclaration
  | TS.ConstructorDeclaration;

type Val =
  | { k: "lit"; v: string | number | boolean; ph?: "env" | "secret" }
  | { k: "regex"; source: string; flags: string }
  | { k: "page" }
  | { k: "request" }
  | { k: "keyboard" }
  | { k: "ctx" }
  /** The built-in `browser` fixture: only `newContext()` / `newPage()` map. */
  | { k: "browser" }
  | { k: "loc"; chain: LocChain }
  | {
      k: "obj";
      cls: TS.ClassDeclaration;
      file: ParsedFile;
      props: Map<string, Val>;
    }
  | { k: "rec"; props: Map<string, Val> }
  | { k: "arr"; items: Val[] }
  | { k: "fn"; node: FnNode; file: ParsedFile; scope: Scope }
  | {
      k: "derived";
      what: "url" | "text" | "visible" | "count" | "value";
      chain?: LocChain;
    }
  | { k: "fixture"; name: string }
  | { k: "void" }
  /** `undefined`: an argument that was not passed. */
  | { k: "undef" }
  | { k: "unknown"; reason: string; recorded?: boolean };

const VOID: Val = { k: "void" };
const unknown = (reason: string, recorded = false): Val => ({
  k: "unknown",
  reason,
  ...(recorded ? { recorded } : {}),
});

class Scope {
  private readonly vars = new Map<string, Val>();
  constructor(readonly parent?: Scope) {}
  get(name: string): Val | undefined {
    return this.vars.get(name) ?? this.parent?.get(name);
  }
  set(name: string, value: Val): void {
    this.vars.set(name, value);
  }
}

interface ParsedFile {
  path: string | undefined;
  sf: TS.SourceFile;
  scope: Scope;
  classes: Map<string, TS.ClassDeclaration>;
  functions: Map<string, FnNode>;
  consts: Map<string, TS.Expression>;
  /** local name → relative module specifier + exported name. */
  imports: Map<string, { spec: string; imported: string }>;
  /** `export * from` (no names) / `export { A, B as C } from` (exported → imported). */
  reexports: Array<{ spec: string; names?: Map<string, string> }>;
  /** `export { local as exported }` without a module: exported → local. */
  localExports: Map<string, string>;
}

export interface AstImportOptions {
  sourcePath?: string;
  /** Title substring or 1-based index of the test to import (default: the first). */
  test?: string;
}

export interface AstImportResult {
  spec: Spec;
  items: ImportItem[];
  /** TODOs that are not tied to a step position. */
  headerTodos: string[];
  /** Every TODO (unmapped item + header), one line each. */
  todos: string[];
  approximations: string[];
  testTitle: string;
}

const MAX_DEPTH = 8;
const MAX_FILES = 64;
const MAX_ITEMS = 2_000;

export function importPlaywrightAst(
  ts: typeof TS,
  source: string,
  opts: AstImportOptions = {},
): AstImportResult {
  return new AstImporter(ts, source, opts).run();
}

class AstImporter {
  private readonly files = new Map<string, ParsedFile>();
  private readonly steps: Step[] = [];
  private readonly outcomes: Outcome[] = [];
  private readonly items: ImportItem[] = [];
  private readonly headerTodos: string[] = [];
  private readonly todos: string[] = [];
  private readonly approximations: string[] = [];
  private readonly usedStepIds = new Set<string>();
  private readonly fixtureVals = new Map<string, Val>();
  private readonly fixturesRunning = new Set<string>();
  private pendingTitle: string | undefined;
  /** The statement being executed: its full text names a top-level call in TODOs. */
  private topExpr: TS.Node | undefined;
  private topText = "";
  /** Output of `cairn export playwright`: its `.first()` is not authored intent. */
  private readonly exporterOutput: boolean;
  private depth = 0;
  private main!: ParsedFile;
  private readonly testAliases = new Set<string>(["test", "it"]);

  constructor(
    private readonly ts: typeof TS,
    private readonly source: string,
    private readonly opts: AstImportOptions,
  ) {
    this.exporterOutput =
      /Generated by (?:Cairntrace )?.cairn export playwright/.test(source);
  }

  /* ----- driver ----- */

  run(): AstImportResult {
    this.main = this.parseFile(this.opts.sourcePath, this.source);
    for (const [local, imp] of this.main.imports) {
      if (imp.imported === "test") this.testAliases.add(local);
    }
    const found = this.collectTests(this.main);
    const chosen = this.pickTest(found);
    let title = "Imported Playwright test";
    if (chosen) {
      title = chosen.title;
      this.runTest(chosen);
      for (const other of found) {
        if (other === chosen) continue;
        this.headerTodos.push(
          `Skipped test "${other.title}" — only one test() is imported per spec (the first, or --test <title|n>); convert it separately.`,
        );
      }
    } else {
      this.headerTodos.push(
        found.length === 0
          ? "No test(...) found in the file; nothing to import."
          : `No test matches --test ${JSON.stringify(this.opts.test)}.`,
      );
    }

    if (this.outcomes.length === 0) {
      this.headerTodos.push(
        "No Playwright expect() assertion mapped; replace placeholder outcome.",
      );
      this.outcomes.push({
        id: "todo_assertion",
        description:
          "TODO replace with the behavior this Playwright test asserts",
        verify: { text: { contains: "TODO_replace_me" } },
      });
    }

    const spec: Spec = {
      version: 1,
      name: slug(title),
      intent: title,
      mode: "normal",
      outcomes: this.outcomes,
      ...(this.steps.length > 0 ? { steps: this.steps } : {}),
    };
    // Final pass: a literal identified as a credential later in the walk is
    // scrubbed from what was recorded before it was identified.
    const items = this.items.map((item) => ({
      ...item,
      source: this.scrub(item.source),
      ...(item.note !== undefined ? { note: this.scrub(item.note) } : {}),
    }));
    const headerTodos = this.headerTodos.map((t) => this.scrub(t));
    return {
      spec,
      items,
      headerTodos,
      todos: [
        ...items
          .filter((item) => item.kind === "unmapped")
          .map((item) =>
            item.note ? `${item.source} — ${item.note}` : item.source,
          ),
        ...headerTodos,
      ],
      approximations: this.approximations.map((a) => this.scrub(a)),
      testTitle: title,
    };
  }

  /* ----- files ----- */

  private parseFile(path: string | undefined, text: string): ParsedFile {
    const ts = this.ts;
    const name = path ?? "source.spec.ts";
    const kind = name.endsWith(".tsx")
      ? ts.ScriptKind.TSX
      : name.endsWith(".js") || name.endsWith(".mjs") || name.endsWith(".cjs")
        ? ts.ScriptKind.JS
        : ts.ScriptKind.TS;
    const sf = ts.createSourceFile(
      name,
      text,
      ts.ScriptTarget.Latest,
      true,
      kind,
    );
    const file: ParsedFile = {
      path,
      sf,
      scope: new Scope(),
      classes: new Map(),
      functions: new Map(),
      consts: new Map(),
      imports: new Map(),
      reexports: [],
      localExports: new Map(),
    };
    for (const stmt of sf.statements) this.indexStatement(file, stmt);
    return file;
  }

  private indexStatement(file: ParsedFile, stmt: TS.Statement): void {
    const ts = this.ts;
    if (ts.isExportDeclaration(stmt) && !stmt.isTypeOnly) {
      const spec =
        stmt.moduleSpecifier && ts.isStringLiteral(stmt.moduleSpecifier)
          ? stmt.moduleSpecifier.text
          : undefined;
      const clause = stmt.exportClause;
      if (spec !== undefined && !clause) {
        file.reexports.push({ spec });
      } else if (clause && ts.isNamedExports(clause)) {
        const names = new Map<string, string>();
        for (const el of clause.elements) {
          if (el.isTypeOnly) continue;
          names.set(el.name.text, (el.propertyName ?? el.name).text);
        }
        if (spec !== undefined) file.reexports.push({ spec, names });
        else
          for (const [exported, local] of names)
            file.localExports.set(exported, local);
      }
      return;
    }
    if (
      ts.isImportDeclaration(stmt) &&
      ts.isStringLiteral(stmt.moduleSpecifier)
    ) {
      const spec = stmt.moduleSpecifier.text;
      const bindings = stmt.importClause?.namedBindings;
      if (stmt.importClause?.name) {
        file.imports.set(stmt.importClause.name.text, {
          spec,
          imported: "default",
        });
      }
      if (bindings && ts.isNamedImports(bindings)) {
        for (const el of bindings.elements) {
          file.imports.set(el.name.text, {
            spec,
            imported: (el.propertyName ?? el.name).text,
          });
        }
      }
      return;
    }
    if (ts.isClassDeclaration(stmt) && stmt.name) {
      file.classes.set(stmt.name.text, stmt);
      return;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      file.functions.set(stmt.name.text, stmt);
      return;
    }
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const init = decl.initializer;
        if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
          file.functions.set(decl.name.text, init);
        } else {
          file.consts.set(decl.name.text, init);
        }
      }
    }
  }

  /** Load a relative import (page object, helper, fixtures module). */
  private importedFile(from: ParsedFile, spec: string): ParsedFile | undefined {
    if (!spec.startsWith(".") || !from.path) return undefined;
    const base = resolve(dirname(from.path), spec);
    const stripped = base.replace(/\.(js|mjs|cjs)$/, "");
    const candidates = [
      base,
      `${base}.ts`,
      `${base}.tsx`,
      `${stripped}.ts`,
      resolve(base, "index.ts"),
    ];
    for (const candidate of candidates) {
      if (extname(candidate) === "" || !existsSync(candidate)) continue;
      const known = this.files.get(candidate);
      if (known) return known;
      if (this.files.size >= MAX_FILES) return undefined;
      try {
        const parsed = this.parseFile(
          candidate,
          readFileSync(candidate, "utf8"),
        );
        this.files.set(candidate, parsed);
        return parsed;
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  private findClass(
    file: ParsedFile,
    name: string,
  ): { cls: TS.ClassDeclaration; file: ParsedFile } | undefined {
    const local = file.classes.get(name);
    if (local) return { cls: local, file };
    const imp = file.imports.get(name);
    if (!imp) return undefined;
    const other = this.importedFile(file, imp.spec);
    if (!other) return undefined;
    const found = this.exportedFrom(
      other,
      imp.imported === "default" ? name : imp.imported,
      (f, n) => f.classes.get(n),
    );
    return found ? { cls: found.value, file: found.file } : undefined;
  }

  private findFunction(
    file: ParsedFile,
    name: string,
  ): { fn: FnNode; file: ParsedFile } | undefined {
    const local = file.functions.get(name);
    if (local) return { fn: local, file };
    const imp = file.imports.get(name);
    if (!imp) return undefined;
    const other = this.importedFile(file, imp.spec);
    if (!other) return undefined;
    const found = this.exportedFrom(other, imp.imported, (f, n) =>
      f.functions.get(n),
    );
    return found ? { fn: found.value, file: found.file } : undefined;
  }

  /**
   * What `file` exports as `name`, following barrels: `export * from`,
   * `export { A as B } from`, `export { local as B }` and an import that is
   * exported again. Cycles and runaway chains stop (seen set, file cap).
   */
  private exportedFrom<T>(
    file: ParsedFile,
    name: string,
    pick: (f: ParsedFile, n: string) => T | undefined,
    seen = new Set<string>(),
  ): { value: T; file: ParsedFile } | undefined {
    const key = `${file.path ?? "<main>"}#${name}`;
    if (seen.has(key) || seen.size > 64) return undefined;
    seen.add(key);
    const localName = file.localExports.get(name) ?? name;
    const own = pick(file, localName);
    if (own !== undefined) return { value: own, file };
    const imp = file.imports.get(localName);
    if (imp) {
      const other = this.importedFile(file, imp.spec);
      const found = other
        ? this.exportedFrom(other, imp.imported, pick, seen)
        : undefined;
      if (found) return found;
    }
    for (const re of file.reexports) {
      const target = re.names ? re.names.get(name) : name;
      if (target === undefined) continue;
      const other = this.importedFile(file, re.spec);
      const found = other
        ? this.exportedFrom(other, target, pick, seen)
        : undefined;
      if (found) return found;
    }
    return undefined;
  }

  /* ----- test discovery ----- */

  private collectTests(file: ParsedFile): FoundTest[] {
    const ts = this.ts;
    const tests: FoundTest[] = [];
    const hooks: FoundHook[] = [];
    const uses: FoundHook[] = [];
    const visit = (node: TS.Node, stack: TS.CallExpression[]): void => {
      if (ts.isCallExpression(node)) {
        const kind = this.testCallKind(node);
        if (kind?.type === "use") {
          uses.push({ kind: "use", node, stack });
          return;
        }
        if (kind?.type === "describe") {
          const fn = node.arguments.find(
            (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
          );
          if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
            const next = [...stack, node];
            ts.forEachChild(fn.body, (child) => visit(child, next));
            return;
          }
        } else if (kind?.type === "hook") {
          hooks.push({ kind: kind.name, node, stack });
          return;
        } else if (kind?.type === "test") {
          const parsed = this.parseTestCall(node, file);
          if (parsed)
            tests.push({ ...parsed, stack, node, hooks: [], uses: [] });
          return;
        }
      }
      ts.forEachChild(node, (child) => visit(child, stack));
    };
    visit(file.sf, []);
    for (const test of tests) {
      const inScope = (hook: FoundHook): boolean =>
        hook.stack.every((entry, i) => test.stack[i] === entry);
      test.hooks = hooks.filter(inScope);
      test.uses = uses.filter(inScope);
    }
    return tests;
  }

  private testCallKind(
    node: TS.CallExpression,
  ):
    | { type: "describe" }
    | { type: "hook"; name: string }
    | { type: "test" }
    | { type: "use" }
    | undefined {
    const ts = this.ts;
    const callee = node.expression;
    if (ts.isIdentifier(callee) && this.testAliases.has(callee.text)) {
      return { type: "test" };
    }
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    const root = rootIdentifier(ts, callee.expression);
    if (!root || !this.testAliases.has(root)) return undefined;
    const path = chainNames(ts, callee);
    const member = path[1];
    if (member === "describe") return { type: "describe" };
    if (member === "use" && path.length === 2) return { type: "use" };
    if (
      path.length === 2 &&
      ["beforeEach", "beforeAll", "afterEach", "afterAll"].includes(
        member ?? "",
      )
    ) {
      return { type: "hook", name: member! };
    }
    if (
      path.length === 2 &&
      ["skip", "fixme", "only", "fail", "slow"].includes(member ?? "") &&
      node.arguments.length >= 2 &&
      this.titleText(node.arguments[0]!) !== undefined
    ) {
      return { type: "test" };
    }
    return undefined;
  }

  private titleText(node: TS.Expression): string | undefined {
    const ts = this.ts;
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      return node.text;
    }
    if (ts.isTemplateExpression(node)) {
      // A title with interpolations: keep the literal text, ${...} as-is.
      return node.getText().slice(1, -1);
    }
    return undefined;
  }

  private parseTestCall(
    node: TS.CallExpression,
    file: ParsedFile,
  ): { title: string; fn: FnNode | undefined; file: ParsedFile } | undefined {
    const ts = this.ts;
    const [titleArg, ...rest] = node.arguments;
    if (!titleArg) return undefined;
    const title = this.titleText(titleArg);
    if (title === undefined) return undefined;
    const last = rest[rest.length - 1];
    let fn: FnNode | undefined;
    if (last && (ts.isArrowFunction(last) || ts.isFunctionExpression(last))) {
      fn = last;
    } else if (last && ts.isIdentifier(last)) {
      fn = this.findFunction(file, last.text)?.fn;
    }
    return { title, fn, file };
  }

  private pickTest(found: FoundTest[]): FoundTest | undefined {
    const want = this.opts.test?.trim();
    if (!want) return found[0];
    if (/^\d+$/.test(want)) return found[Number(want) - 1];
    const lower = want.toLowerCase();
    return found.find((t) => t.title.toLowerCase().includes(lower));
  }

  private runTest(test: FoundTest): void {
    const ts = this.ts;
    const file = test.file;
    this.applyTestUse(test);
    // Hooks that run around the test: beforeAll/beforeEach first, in order.
    for (const hook of test.hooks) {
      if (hook.kind === "afterAll" || hook.kind === "afterEach") continue;
      const fn = hook.node.arguments.find(
        (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
      );
      if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))
        continue;
      if (isEmptyBody(ts, fn)) continue;
      if (hook.kind === "beforeAll") {
        this.unmapped(
          hook.node,
          `test.beforeAll hook is not imported (it runs once per worker, outside any one test)`,
        );
        continue;
      }
      this.runFunction(fn, file, [], new Scope(file.scope), undefined);
    }
    if (test.fn)
      this.runFunction(test.fn, file, [], new Scope(file.scope), undefined);
    for (const hook of test.hooks) {
      if (hook.kind !== "afterAll" && hook.kind !== "afterEach") continue;
      const fn = hook.node.arguments.find(
        (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
      );
      if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)))
        continue;
      if (isEmptyBody(ts, fn)) continue;
      this.unmapped(
        hook.node,
        `test.${hook.kind} hook is not imported; express cleanup as a spec teardown: or run: step`,
      );
    }
  }

  /**
   * `test.use({ option: value })` in scope: values for the custom option
   * fixtures the test reads; built-in options (viewport, storageState, …)
   * stay TODOs (they belong in the config).
   */
  private applyTestUse(test: FoundTest): void {
    const ts = this.ts;
    const custom = this.customFixtures(test.file);
    for (const use of test.uses) {
      const arg = use.node.arguments[0];
      if (!arg || !ts.isObjectLiteralExpression(arg)) {
        this.unmapped(
          use.node,
          "test.use(...) without a literal options object",
        );
        continue;
      }
      const values = this.evalObject(arg, {
        file: test.file,
        scope: new Scope(test.file.scope),
      });
      if (values.k !== "rec") continue;
      for (const [name, value] of values.props) {
        if (custom.get(name)?.option) {
          this.fixtureVals.set(name, value);
          this.record(
            "mapped",
            `test.use({ ${name} })`,
            `option fixture ${name} set for this test`,
          );
        } else {
          this.unmapped(
            use.node,
            `test.use option ${name} is not imported; set browser options in cairntrace.config.yml`,
          );
        }
      }
    }
  }

  /** Run a test / hook / step function with fixtures bound from its first parameter. */
  private runFunction(
    fn: FnNode,
    file: ParsedFile,
    args: Val[],
    scope: Scope,
    self: Val | undefined,
  ): Val {
    const ts = this.ts;
    const first = fn.parameters[0];
    if (first && ts.isObjectBindingPattern(first.name) && args.length === 0) {
      this.bindFixtures(first.name, file, scope);
    } else {
      this.bindParams(fn, args, file, scope);
    }
    const body = fn.body;
    if (!body) return VOID;
    if (!ts.isBlock(body)) return this.evalExpr(body, { file, scope, self });
    const result = this.execBlock(body.statements, { file, scope, self });
    return result.returned ?? VOID;
  }

  private bindParams(
    fn: FnNode,
    args: Val[],
    file: ParsedFile,
    scope: Scope,
  ): void {
    const ts = this.ts;
    fn.parameters.forEach((param, i) => {
      let value: Val | undefined = args[i];
      if (value === undefined && param.initializer) {
        value = this.evalExpr(param.initializer, { file, scope });
      }
      value ??= { k: "undef" };
      if (ts.isIdentifier(param.name)) {
        scope.set(param.name.text, value);
      } else if (ts.isObjectBindingPattern(param.name)) {
        this.destructure(param.name, value, scope);
      }
    });
  }

  private destructure(
    pattern: TS.ObjectBindingPattern,
    value: Val,
    scope: Scope,
  ): void {
    const ts = this.ts;
    for (const el of pattern.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      const key = (el.propertyName ?? el.name) as TS.Identifier;
      const prop = ts.isIdentifier(key) ? key.text : el.name.text;
      const got =
        value.k === "rec" || value.k === "obj"
          ? value.props.get(prop)
          : undefined;
      scope.set(
        el.name.text,
        got ?? unknown(`property ${prop} is not statically known`),
      );
    }
  }

  /* ----- fixtures ----- */

  private bindFixtures(
    pattern: TS.ObjectBindingPattern,
    file: ParsedFile,
    scope: Scope,
  ): void {
    const ts = this.ts;
    for (const el of pattern.elements) {
      if (!ts.isIdentifier(el.name)) continue;
      const fixtureName = ts.isIdentifier(el.propertyName ?? el.name)
        ? ((el.propertyName as TS.Identifier | undefined)?.text ?? el.name.text)
        : el.name.text;
      scope.set(el.name.text, this.fixtureValue(fixtureName, file));
    }
  }

  private fixtureValue(name: string, file: ParsedFile): Val {
    if (name === "page") return { k: "page" };
    if (name === "request") return { k: "request" };
    if (name === "context") return { k: "ctx" };
    if (this.fixtureVals.has(name)) return this.fixtureVals.get(name)!;
    const custom = this.customFixtures(file).get(name);
    if (custom && !this.fixturesRunning.has(name)) {
      this.fixturesRunning.add(name);
      const value = this.runFixture(custom.node, custom.file, custom.option);
      this.fixturesRunning.delete(name);
      this.fixtureVals.set(name, value);
      return value;
    }
    if (/page$/i.test(name)) return { k: "page" };
    if (name === "browser") return { k: "browser" };
    if (["browserName", "baseURL", "playwright", "headless"].includes(name)) {
      return unknown(`built-in fixture ${name} is not statically known`);
    }
    return { k: "fixture", name };
  }

  /** `export const test = base.extend({ name: async ({...}, use) => ... })` from the test file's imports. */
  private customFixtures(
    file: ParsedFile,
  ): Map<string, { node: TS.Expression; file: ParsedFile; option: boolean }> {
    const ts = this.ts;
    const out = new Map<
      string,
      { node: TS.Expression; file: ParsedFile; option: boolean }
    >();
    const visited = new Set<ParsedFile>();
    const visitFile = (target: ParsedFile, depth: number): void => {
      if (depth > 4 || visited.has(target)) return;
      visited.add(target);
      // a barrel that re-exports the fixtures module
      for (const re of target.reexports) {
        if (re.names && !re.names.has("test")) continue;
        const other = this.importedFile(target, re.spec);
        if (other) visitFile(other, depth + 1);
      }
      for (const init of target.consts.values()) {
        const call = unwrap(ts, init);
        if (
          !ts.isCallExpression(call) ||
          !ts.isPropertyAccessExpression(call.expression) ||
          call.expression.name.text !== "extend"
        ) {
          continue;
        }
        const base = call.expression.expression;
        if (ts.isIdentifier(base)) {
          const imp = target.imports.get(base.text);
          const other = imp ? this.importedFile(target, imp.spec) : undefined;
          if (other) visitFile(other, depth + 1);
        }
        const arg = call.arguments[0];
        if (!arg || !ts.isObjectLiteralExpression(arg)) continue;
        for (const prop of arg.properties) {
          if (!ts.isPropertyAssignment(prop) && !ts.isMethodDeclaration(prop))
            continue;
          const key = prop.name;
          const name =
            ts.isIdentifier(key) || ts.isStringLiteral(key)
              ? key.text
              : undefined;
          if (!name) continue;
          if (ts.isMethodDeclaration(prop)) {
            out.set(name, {
              node: prop as unknown as TS.Expression,
              file: target,
              option: false,
            });
            continue;
          }
          const init2 = prop.initializer;
          if (ts.isArrayLiteralExpression(init2) && init2.elements[0]) {
            const opt = init2.elements[1];
            const isOption = opt
              ? /option\s*:\s*true/.test(opt.getText())
              : false;
            const first = init2.elements[0];
            out.set(name, {
              node: first,
              file: target,
              option:
                isOption ||
                !(ts.isArrowFunction(first) || ts.isFunctionExpression(first)),
            });
          } else {
            out.set(name, { node: init2, file: target, option: false });
          }
        }
      }
    };
    const visitImports = (): void => {
      for (const [local, imp] of file.imports) {
        if (!this.testAliases.has(local) && imp.imported !== "test") continue;
        const other = this.importedFile(file, imp.spec);
        if (other) visitFile(other, 0);
      }
    };
    visitFile(file, 0);
    visitImports();
    return out;
  }

  private runFixture(
    node: TS.Expression,
    file: ParsedFile,
    option: boolean,
  ): Val {
    const ts = this.ts;
    if (option)
      return this.evalExpr(node, { file, scope: new Scope(file.scope) });
    const fnNode = node as unknown as FnNode;
    const fn =
      ts.isArrowFunction(fnNode) ||
      ts.isFunctionExpression(fnNode) ||
      ts.isMethodDeclaration(fnNode)
        ? fnNode
        : undefined;
    if (!fn || !fn.body) return unknown("fixture is not a function");
    const scope = new Scope(file.scope);
    const first = fn.parameters[0];
    if (first && ts.isObjectBindingPattern(first.name)) {
      this.bindFixtures(first.name, file, scope);
    }
    const useName =
      fn.parameters[1] && ts.isIdentifier(fn.parameters[1].name)
        ? fn.parameters[1].name.text
        : "use";
    if (!ts.isBlock(fn.body)) return unknown("fixture has no use() call");
    let provided: Val = unknown("fixture never calls use()");
    const statements = fn.body.statements;
    for (let i = 0; i < statements.length; i += 1) {
      const stmt = statements[i]!;
      const call = ts.isExpressionStatement(stmt)
        ? unwrap(ts, stmt.expression)
        : undefined;
      if (
        call &&
        ts.isCallExpression(call) &&
        ts.isIdentifier(call.expression) &&
        call.expression.text === useName
      ) {
        provided = call.arguments[0]
          ? this.evalExpr(call.arguments[0], { file, scope })
          : VOID;
        if (i < statements.length - 1) {
          this.unmapped(
            statements[i + 1]!,
            "fixture teardown (after use()) is not imported",
          );
        }
        return provided;
      }
      this.execStatement(stmt, { file, scope });
    }
    return provided;
  }

  /* ----- recording ----- */

  private record(kind: ImportItemKind, source: string, note?: string): void {
    if (this.items.length >= MAX_ITEMS) return;
    this.items.push({
      kind,
      source,
      ...(note ? { note } : {}),
      beforeStep: this.steps.length,
    });
  }

  /** Literals replaced by a `${secrets.X}` placeholder: never echoed in a comment. */
  private readonly secretLiterals = new Set<string>();

  private text(node: TS.Node): string {
    const raw = this.scrub(
      (node === this.topExpr ? this.topText : node.getText())
        .replace(/\s+/g, " ")
        .trim(),
    );
    return raw.length > 200 ? `${raw.slice(0, 197)}...` : raw;
  }

  /**
   * Source text goes into TODO / APPROXIMATED comments, so credentials are
   * scrubbed: literals already turned into placeholders, values under
   * credential-named keys, typed values in credential-looking statements and
   * bearer tokens.
   */
  private scrub(text: string): string {
    let out = text;
    const known = [...this.secretLiterals]
      .filter((v) => v.length >= 3)
      .toSorted((a, b) => b.length - a.length);
    for (const secret of known) out = out.split(secret).join("<redacted>");
    for (const shaped of secretShapedSubstrings(out)) {
      out = out.split(shaped).join("<redacted>");
    }
    // user:password in a URL literal
    out = out.replace(
      /\b([a-z][a-z0-9+.-]*:\/\/)[^\s/?#@"'`]+@/gi,
      "$1<redacted>@",
    );
    out = out.replace(
      /\b(pass(?:word|wd|phrase)?|pwd|secret|token|api[-_]?key|authorization|credential)(["'`]?\s*[:=]\s*)(["'`])(?:\\.|(?!\3).)*\3/gi,
      "$1$2$3<redacted>$3",
    );
    out = out.replace(
      /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/g,
      "$1 <redacted>",
    );
    if (looksSecretName(text)) {
      // every string argument of a typing call: `page.fill(sel, value)` too
      out = out.replace(
        /\.(fill|pressSequentially|type)\(([^()]*)\)/g,
        (_m, method: string, argsText: string) =>
          `.${method}(${argsText.replace(
            /(["'`])(?:\\.|(?!\1).)*\1/g,
            "$1<redacted>$1",
          )})`,
      );
    }
    return out;
  }

  /** URL credentials become `${secrets.X}` placeholders, noted in `approx`. */
  private urlSink(approx: string[]): SecretSink {
    return (hint, value, what, scrubElsewhere = true) => {
      if (scrubElsewhere) this.secretLiterals.add(value);
      const ph = secretPlaceholder(hint);
      approx.push(`${what} became ${ph}`);
      return ph;
    };
  }

  private unmapped(node: TS.Node, reason: string): Val {
    this.record("unmapped", this.text(node), reason);
    return unknown(reason, true);
  }

  private addStep(
    step: Step,
    node: TS.Node,
    approx: readonly string[] = [],
  ): Val {
    const id = this.takeId();
    const withId = id && !("id" in step) ? ({ id, ...step } as Step) : step;
    this.steps.push(withId);
    this.noteApprox(node, approx);
    return VOID;
  }

  private noteApprox(node: TS.Node, approx: readonly string[]): void {
    if (approx.length === 0) {
      this.record("mapped", this.text(node));
      return;
    }
    const note = approx.join("; ");
    this.record("approximated", this.text(node), note);
    for (const entry of approx) {
      const line = `${this.text(node)}: ${entry}`;
      if (!this.approximations.includes(line)) this.approximations.push(line);
    }
  }

  private takeId(): string | undefined {
    if (!this.pendingTitle) return undefined;
    const id = snakeId(this.pendingTitle);
    this.pendingTitle = undefined;
    if (!id || this.usedStepIds.has(id)) return undefined;
    this.usedStepIds.add(id);
    return id;
  }

  private addOutcome(
    baseId: string,
    description: string,
    verify: Outcome["verify"],
    node: TS.Node,
    approx: readonly string[] = [],
  ): Val {
    const idx = this.outcomes.length;
    const outcome: Outcome = {
      id: idx === 0 ? baseId : `${baseId}_${idx + 1}`,
      description,
      verify,
    };
    const titled = this.pendingTitle ? slug(this.pendingTitle) : undefined;
    if (
      titled &&
      /^[a-z][a-z0-9_]*$/.test(titled) &&
      !this.outcomes.some((existing) => existing.id === titled)
    ) {
      outcome.id = titled;
    }
    this.pendingTitle = undefined;
    this.outcomes.push(outcome);
    this.noteApprox(node, approx);
    return VOID;
  }

  /* ----- statements ----- */

  private execBlock(
    statements: readonly TS.Statement[],
    ex: Ex,
  ): { returned?: Val } {
    for (const stmt of statements) {
      const r = this.execStatement(stmt, ex);
      if (r.returned) return r;
    }
    return {};
  }

  private execStatement(stmt: TS.Statement, ex: Ex): { returned?: Val } {
    const ts = this.ts;
    if (this.items.length >= MAX_ITEMS) return {};
    if (ts.isBlock(stmt)) return this.execBlock(stmt.statements, ex);
    if (ts.isReturnStatement(stmt)) {
      return {
        returned: stmt.expression ? this.evalExpr(stmt.expression, ex) : VOID,
      };
    }
    if (ts.isEmptyStatement(stmt)) return {};
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) {
      ex.scope.set(stmt.name.text, {
        k: "fn",
        node: stmt,
        file: ex.file,
        scope: ex.scope,
      });
      return {};
    }
    if (
      ts.isClassDeclaration(stmt) ||
      ts.isInterfaceDeclaration(stmt) ||
      ts.isTypeAliasDeclaration(stmt)
    ) {
      return {};
    }
    if (ts.isVariableStatement(stmt)) {
      this.execVariables(stmt, ex);
      return {};
    }
    if (ts.isExpressionStatement(stmt)) {
      if (this.isScaffolding(stmt)) return {};
      this.topExpr = unwrap(ts, stmt.expression);
      this.topText = stmt.getText();
      const value = this.evalExpr(stmt.expression, ex);
      if (value.k === "unknown" && !value.recorded) {
        this.unmapped(stmt, value.reason);
      }
      return {};
    }
    if (
      ts.isForStatement(stmt) &&
      /\bfillAttempt\b/.test(stmt.getText().slice(0, 80))
    ) {
      // The exporter's hydration retry loop around fill / pressSequentially:
      // only the action is behavior; the retry and read-back are plumbing.
      return this.execFillRetryLoop(stmt, ex);
    }
    if (ts.isIfStatement(stmt) && isPlainCondition(ts, stmt.expression)) {
      // A page-object flag passed as a literal (`signIn(email, pw, false)`):
      // the branch is known statically, so only it runs.
      const cond = this.evalExpr(stmt.expression, ex);
      const known =
        cond.k === "undef"
          ? false
          : cond.k === "lit" && cond.ph === undefined
            ? Boolean(cond.v)
            : undefined;
      if (known !== undefined) {
        const branch = known ? stmt.thenStatement : stmt.elseStatement;
        this.noteApprox(stmt.expression, [
          `if condition is ${String(known)} for this call; only that branch was imported`,
        ]);
        return branch ? this.execStatement(branch, ex) : {};
      }
    }
    if (
      ts.isIfStatement(stmt) ||
      ts.isForStatement(stmt) ||
      ts.isForOfStatement(stmt) ||
      ts.isForInStatement(stmt) ||
      ts.isWhileStatement(stmt) ||
      ts.isDoStatement(stmt) ||
      ts.isTryStatement(stmt) ||
      ts.isSwitchStatement(stmt) ||
      ts.isThrowStatement(stmt)
    ) {
      this.unmapped(
        stmt,
        `${ts.SyntaxKind[stmt.kind].replace("Statement", "")} control flow is not imported; express it with if:/repeat: steps or split the test`,
      );
      return {};
    }
    this.unmapped(stmt, "statement shape is not imported");
    return {};
  }

  private execFillRetryLoop(stmt: TS.ForStatement, ex: Ex): { returned?: Val } {
    const ts = this.ts;
    if (!ts.isBlock(stmt.statement)) {
      this.unmapped(stmt, "retry loop is not imported");
      return {};
    }
    for (const inner of stmt.statement.statements) {
      if (!ts.isExpressionStatement(inner)) continue;
      const text = inner.expression.getText();
      if (!/\.(fill|pressSequentially)\(/.test(text)) continue;
      this.execStatement(inner, ex);
      return {};
    }
    this.unmapped(stmt, "retry loop without a fill is not imported");
    return {};
  }

  /** The exporter's evidence plumbing: `const requests = []`, `page.on("response", ...)`. */
  private isScaffolding(stmt: TS.ExpressionStatement): boolean {
    const ts = this.ts;
    const call = stmt.expression;
    if (
      !ts.isCallExpression(call) ||
      !ts.isPropertyAccessExpression(call.expression)
    ) {
      return false;
    }
    if (call.expression.name.text !== "on") return false;
    const event = call.arguments[0];
    if (!event || !ts.isStringLiteralLike(event)) return false;
    if (
      ![
        "response",
        "console",
        "pageerror",
        "request",
        "requestfailed",
      ].includes(event.text)
    ) {
      return false;
    }
    const handler = call.arguments[1]?.getText() ?? "";
    return /\b(requests|consoleErrors)\b/.test(handler);
  }

  private execVariables(stmt: TS.VariableStatement, ex: Ex): void {
    const ts = this.ts;
    for (const decl of stmt.declarationList.declarations) {
      const init = decl.initializer;
      if (ts.isIdentifier(decl.name)) {
        const name = decl.name.text;
        if (!init) {
          ex.scope.set(name, unknown(`${name} is declared without a value`));
          continue;
        }
        if (
          (name === "requests" || name === "consoleErrors") &&
          ts.isArrayLiteralExpression(init) &&
          init.elements.length === 0
        ) {
          ex.scope.set(name, { k: "arr", items: [] });
          continue;
        }
        const value = this.evalExpr(init, ex);
        if (value.k === "unknown" && !value.recorded && isCallLike(ts, init)) {
          this.unmapped(decl, value.reason);
          ex.scope.set(name, { ...value, recorded: true });
        } else if (value.k === "void") {
          ex.scope.set(name, unknown(`${name} holds no value`, true));
        } else {
          ex.scope.set(name, value);
        }
        continue;
      }
      if (ts.isObjectBindingPattern(decl.name) && init) {
        const value = this.evalExpr(init, ex);
        this.destructure(decl.name, value, ex.scope);
        if (value.k === "unknown" && !value.recorded && isCallLike(ts, init)) {
          this.unmapped(decl, value.reason);
        }
        continue;
      }
      if (init) {
        const value = this.evalExpr(init, ex);
        if (value.k === "unknown" && !value.recorded)
          this.unmapped(decl, value.reason);
      }
    }
  }

  /* ----- expressions ----- */

  evalExpr(node: TS.Expression, ex: Ex): Val {
    const ts = this.ts;
    const inner = unwrap(ts, node);
    if (ts.isStringLiteralLike(inner)) return { k: "lit", v: inner.text };
    if (ts.isNumericLiteral(inner)) return { k: "lit", v: Number(inner.text) };
    if (inner.kind === ts.SyntaxKind.TrueKeyword) return { k: "lit", v: true };
    if (inner.kind === ts.SyntaxKind.FalseKeyword)
      return { k: "lit", v: false };
    if (ts.isRegularExpressionLiteral(inner)) {
      const m = /^\/(.*)\/([a-z]*)$/s.exec(inner.text);
      return { k: "regex", source: m?.[1] ?? inner.text, flags: m?.[2] ?? "" };
    }
    if (ts.isTemplateExpression(inner)) return this.evalTemplate(inner, ex);
    if (ts.isIdentifier(inner)) return this.evalIdentifier(inner, ex);
    if (
      ts.isPrefixUnaryExpression(inner) &&
      inner.operator === ts.SyntaxKind.MinusToken
    ) {
      const v = this.evalExpr(inner.operand, ex);
      return v.k === "lit" && typeof v.v === "number"
        ? { k: "lit", v: -v.v }
        : unknown("computed number");
    }
    if (
      ts.isPrefixUnaryExpression(inner) &&
      inner.operator === ts.SyntaxKind.ExclamationToken
    ) {
      const v = this.evalExpr(inner.operand, ex);
      if (v.k === "undef") return { k: "lit", v: true };
      return v.k === "lit" && v.ph === undefined
        ? { k: "lit", v: !v.v }
        : unknown("computed condition");
    }
    if (ts.isObjectLiteralExpression(inner)) return this.evalObject(inner, ex);
    if (ts.isArrayLiteralExpression(inner)) {
      return {
        k: "arr",
        items: inner.elements.map((el) => this.evalExpr(el, ex)),
      };
    }
    if (ts.isArrowFunction(inner) || ts.isFunctionExpression(inner)) {
      return { k: "fn", node: inner, file: ex.file, scope: ex.scope };
    }
    if (ts.isBinaryExpression(inner)) return this.evalBinary(inner, ex);
    if (ts.isConditionalExpression(inner)) {
      const cond = this.evalExpr(inner.condition, ex);
      const truthy =
        cond.k === "lit"
          ? cond.v !== "" && cond.v !== 0 && cond.v !== false
          : cond.k === "undef"
            ? false
            : undefined;
      if (truthy === undefined)
        return unknown("conditional on a value that is not statically known");
      return this.evalExpr(truthy ? inner.whenTrue : inner.whenFalse, ex);
    }
    if (
      ts.isPropertyAccessExpression(inner) ||
      ts.isElementAccessExpression(inner)
    ) {
      return this.evalMember(inner, ex);
    }
    if (ts.isNewExpression(inner)) return this.evalNew(inner, ex);
    if (ts.isCallExpression(inner)) return this.evalCall(inner, ex);
    if (inner.kind === ts.SyntaxKind.ThisKeyword)
      return ex.self ?? unknown("`this` outside a class");
    return unknown(
      `expression ${ts.SyntaxKind[inner.kind]} is not statically known`,
    );
  }

  private evalTemplate(node: TS.TemplateExpression, ex: Ex): Val {
    let out = node.head.text;
    let ph: "env" | "secret" | undefined;
    for (const span of node.templateSpans) {
      const v = this.evalExpr(span.expression, ex);
      if (v.k !== "lit")
        return unknown("template with a value that is not statically known");
      out += String(v.v) + span.literal.text;
      ph ??= v.ph;
    }
    return { k: "lit", v: out, ...(ph ? { ph } : {}) };
  }

  private evalIdentifier(node: TS.Identifier, ex: Ex): Val {
    const name = node.text;
    const local = ex.scope.get(name);
    if (local) return local;
    if (name === "undefined") return { k: "undef" };
    const constant = ex.file.consts.get(name);
    if (constant) {
      return this.evalExpr(constant, {
        file: ex.file,
        scope: new Scope(ex.file.scope),
      });
    }
    const fn = ex.file.functions.get(name);
    if (fn) return { k: "fn", node: fn, file: ex.file, scope: ex.file.scope };
    const imp = ex.file.imports.get(name);
    if (imp) {
      const other = this.importedFile(ex.file, imp.spec);
      const exported = other?.consts.get(imp.imported);
      if (other && exported) {
        return this.evalExpr(exported, {
          file: other,
          scope: new Scope(other.scope),
        });
      }
      const fnImported = other?.functions.get(imp.imported);
      if (other && fnImported)
        return { k: "fn", node: fnImported, file: other, scope: other.scope };
    }
    return unknown(`${name} is not statically known`);
  }

  private evalObject(node: TS.ObjectLiteralExpression, ex: Ex): Val {
    const ts = this.ts;
    const props = new Map<string, Val>();
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const key = propName(ts, prop.name);
        if (key) props.set(key, this.evalExpr(prop.initializer, ex));
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        props.set(prop.name.text, this.evalIdentifier(prop.name, ex));
      } else if (ts.isMethodDeclaration(prop)) {
        const key = propName(ts, prop.name);
        if (key)
          props.set(key, {
            k: "fn",
            node: prop,
            file: ex.file,
            scope: ex.scope,
          });
      } else if (ts.isSpreadAssignment(prop)) {
        const spread = this.evalExpr(prop.expression, ex);
        if (spread.k === "rec")
          for (const [k, v] of spread.props) props.set(k, v);
      }
    }
    return { k: "rec", props };
  }

  private evalBinary(node: TS.BinaryExpression, ex: Ex): Val {
    const ts = this.ts;
    const op = node.operatorToken.kind;
    if (op === ts.SyntaxKind.PlusToken) {
      const l = this.evalExpr(node.left, ex);
      const r = this.evalExpr(node.right, ex);
      if (l.k === "lit" && r.k === "lit") {
        const ph = l.ph ?? r.ph;
        return typeof l.v === "number" && typeof r.v === "number"
          ? { k: "lit", v: l.v + r.v }
          : { k: "lit", v: String(l.v) + String(r.v), ...(ph ? { ph } : {}) };
      }
      return unknown("concatenation with a value that is not statically known");
    }
    if (
      op === ts.SyntaxKind.BarBarToken ||
      op === ts.SyntaxKind.QuestionQuestionToken
    ) {
      const l = this.evalExpr(node.left, ex);
      // `process.env.X || "default"`: the placeholder keeps the default.
      if (l.k === "lit" && l.ph === "env" && typeof l.v === "string") {
        const r = this.evalExpr(node.right, ex);
        if (r.k === "lit") {
          return {
            k: "lit",
            v: l.v.replace(/\}$/, `:-${String(r.v)}}`),
            ph: "env",
          };
        }
      }
      return l.k === "unknown" || l.k === "undef"
        ? this.evalExpr(node.right, ex)
        : l;
    }
    return unknown("operator expression is not statically known");
  }

  private evalMember(
    node: TS.PropertyAccessExpression | TS.ElementAccessExpression,
    ex: Ex,
  ): Val {
    const ts = this.ts;
    // process.env.NAME → ${env.NAME}
    const text = node.getText();
    const env =
      /^process\.env\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(text) ??
      /^process\.env\[\s*["']([A-Za-z_][A-Za-z0-9_]*)["']\s*\]$/.exec(text);
    if (env) {
      return looksSecretName(env[1])
        ? { k: "lit", v: `\${secrets.${env[1]}}`, ph: "secret" }
        : { k: "lit", v: `\${env.${env[1]}}`, ph: "env" };
    }
    const target = this.evalExpr(node.expression, ex);
    const name = ts.isPropertyAccessExpression(node)
      ? node.name.text
      : node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression)
        ? node.argumentExpression.text
        : undefined;
    if (name === undefined) return unknown("computed property access");
    switch (target.k) {
      case "page":
        if (name === "keyboard") return { k: "keyboard" };
        if (name === "request") return { k: "request" };
        return unknown(`page.${name} is not mapped`);
      case "ctx":
        return name === "request"
          ? { k: "request" }
          : unknown(`context.${name} is not mapped`);
      case "rec":
        return (
          target.props.get(name) ??
          unknown(`property ${name} is not statically known`)
        );
      case "obj": {
        const own = target.props.get(name);
        if (own) return own;
        const getter = this.findMember(target.cls, target.file, name, "get");
        if (getter) {
          return this.runFunction(
            getter.node as FnNode,
            getter.file,
            [],
            new Scope(getter.file.scope),
            target,
          );
        }
        return unknown(`page object property ${name} is not statically known`);
      }
      case "arr":
        return name === "length"
          ? { k: "lit", v: target.items.length }
          : unknown("array member is not statically known");
      default:
        return target.k === "unknown"
          ? target
          : unknown(`property ${name} is not statically known`);
    }
  }

  /* ----- classes (page objects) ----- */

  private evalNew(node: TS.NewExpression, ex: Ex): Val {
    const ts = this.ts;
    if (!ts.isIdentifier(node.expression))
      return unknown("constructor is not statically known");
    const name = node.expression.text;
    if (name === "RegExp") {
      const src = node.arguments?.[0]
        ? this.evalExpr(node.arguments[0], ex)
        : undefined;
      const flags = node.arguments?.[1]
        ? this.evalExpr(node.arguments[1], ex)
        : undefined;
      return src?.k === "lit" && typeof src.v === "string"
        ? {
            k: "regex",
            source: src.v,
            flags: flags?.k === "lit" ? String(flags.v) : "",
          }
        : unknown("RegExp with a source that is not statically known");
    }
    const found = this.findClass(ex.file, name);
    if (!found) {
      return unknown(
        `class ${name} is not in this file or a readable relative import`,
      );
    }
    if (this.depth >= MAX_DEPTH)
      return unknown("page object nesting is too deep");
    const args = (node.arguments ?? []).map((a) => this.evalExpr(a, ex));
    const inst: Val & { k: "obj" } = {
      k: "obj",
      cls: found.cls,
      file: found.file,
      props: new Map(),
    };
    this.depth += 1;
    try {
      this.initClass(found.cls, found.file, inst, args);
    } finally {
      this.depth -= 1;
    }
    return inst;
  }

  private initClass(
    cls: TS.ClassDeclaration,
    file: ParsedFile,
    inst: Val & { k: "obj" },
    args: Val[],
  ): void {
    const ts = this.ts;
    const ctor = cls.members.find(ts.isConstructorDeclaration);
    const base = this.baseClass(cls, file);
    const scope = new Scope(file.scope);
    const ex: Ex = { file, scope, self: inst };
    const assignFields = (): void => {
      if (ctor) {
        for (const param of ctor.parameters) {
          if (
            ts.isIdentifier(param.name) &&
            param.modifiers?.some((m) => ts.isModifier(m))
          ) {
            inst.props.set(
              param.name.text,
              scope.get(param.name.text) ?? unknown("constructor argument"),
            );
          }
        }
      }
      for (const member of cls.members) {
        if (
          ts.isPropertyDeclaration(member) &&
          member.initializer &&
          !isStatic(ts, member)
        ) {
          const key = propName(ts, member.name);
          if (key) inst.props.set(key, this.evalExpr(member.initializer, ex));
        }
      }
    };
    if (!ctor) {
      if (base) this.initClass(base.cls, base.file, inst, args);
      assignFields();
      return;
    }
    this.bindParams(ctor, args, file, scope);
    const statements = ctor.body?.statements ?? [];
    let superSeen = !base;
    if (!base) assignFields();
    for (const stmt of statements) {
      const call = ts.isExpressionStatement(stmt)
        ? unwrap(ts, stmt.expression)
        : undefined;
      if (
        call &&
        ts.isCallExpression(call) &&
        call.expression.kind === ts.SyntaxKind.SuperKeyword
      ) {
        const superArgs = call.arguments.map((a) => this.evalExpr(a, ex));
        if (base) this.initClass(base.cls, base.file, inst, superArgs);
        assignFields();
        superSeen = true;
        continue;
      }
      if (!superSeen) continue;
      const assign =
        ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression)
          ? stmt.expression
          : undefined;
      if (
        assign &&
        assign.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
        ts.isPropertyAccessExpression(assign.left) &&
        assign.left.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        inst.props.set(assign.left.name.text, this.evalExpr(assign.right, ex));
        continue;
      }
      this.execStatement(stmt, ex);
    }
    if (!superSeen) assignFields();
  }

  private baseClass(
    cls: TS.ClassDeclaration,
    file: ParsedFile,
  ): { cls: TS.ClassDeclaration; file: ParsedFile } | undefined {
    const ts = this.ts;
    const ext = cls.heritageClauses?.find(
      (h) => h.token === ts.SyntaxKind.ExtendsKeyword,
    );
    const expr = ext?.types[0]?.expression;
    return expr && ts.isIdentifier(expr)
      ? this.findClass(file, expr.text)
      : undefined;
  }

  private findMember(
    cls: TS.ClassDeclaration,
    file: ParsedFile,
    name: string,
    kind: "method" | "get",
  ):
    | {
        node: TS.MethodDeclaration | TS.GetAccessorDeclaration;
        file: ParsedFile;
      }
    | undefined {
    const ts = this.ts;
    for (const member of cls.members) {
      const key = member.name ? propName(ts, member.name) : undefined;
      if (key !== name) continue;
      if (kind === "method" && ts.isMethodDeclaration(member) && member.body) {
        return { node: member, file };
      }
      if (
        kind === "get" &&
        ts.isGetAccessorDeclaration(member) &&
        member.body
      ) {
        return { node: member, file };
      }
    }
    const base = this.baseClass(cls, file);
    return base ? this.findMember(base.cls, base.file, name, kind) : undefined;
  }

  /* ----- calls ----- */

  private evalCall(node: TS.CallExpression, ex: Ex): Val {
    const ts = this.ts;
    const callee = unwrap(ts, node.expression);

    // test.step("title", async () => { ... })
    if (ts.isPropertyAccessExpression(callee)) {
      const root = rootIdentifier(ts, callee.expression);
      if (root && this.testAliases.has(root)) {
        return this.evalTestMember(node, callee, ex);
      }
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "Promise"
      ) {
        return this.evalPromiseCall(node, callee.name.text, ex);
      }
      if (
        ts.isIdentifier(callee.expression) &&
        callee.expression.text === "expect"
      ) {
        return this.unmapped(
          node,
          `expect.${callee.name.text}(...) is not imported`,
        );
      }
    }

    if (ts.isIdentifier(callee)) {
      if (callee.text === "expect")
        return this.unmapped(node, "expect(...) without a matcher");
      if (
        !ex.scope.get(callee.text) &&
        !this.findFunction(ex.file, callee.text) &&
        /^(getBy(Role|Label|Text|TestId|Placeholder|AltText|Title)|locator)$/.test(
          callee.text,
        )
      ) {
        return this.buildLocator(emptyChain(), callee.text, node, ex);
      }
      const helper = this.evalExportHelper(node, callee.text, ex);
      if (helper) return helper;
      const local = ex.scope.get(callee.text);
      if (local?.k === "fn") return this.invoke(local, node, ex);
      if (local?.k === "fixture") {
        return this.unmapped(
          node,
          `fixture ${local.name} is defined outside this file; model it as a use: action or login checkpoint`,
        );
      }
      const found = this.findFunction(ex.file, callee.text);
      if (found) {
        return this.invoke(
          {
            k: "fn",
            node: found.fn,
            file: found.file,
            scope: found.file.scope,
          },
          node,
          ex,
        );
      }
      return unknown(`call to ${callee.text}() is not statically known`);
    }

    if (!ts.isPropertyAccessExpression(callee)) {
      return unknown("call target is not statically known");
    }
    const method = callee.name.text;
    // expect(...).matcher(...)
    const expectCall = this.parseExpectChain(node);
    if (expectCall) return this.mapExpect(expectCall, node, ex);

    const recv = this.evalExpr(callee.expression, ex);
    return this.callMethod(recv, method, node, ex);
  }

  private invoke(
    fnVal: Val & { k: "fn" },
    node: TS.CallExpression,
    ex: Ex,
  ): Val {
    if (this.depth >= MAX_DEPTH) {
      return this.unmapped(node, "helper nesting is too deep to inline");
    }
    const args = node.arguments.map((a) => this.evalExpr(a, ex));
    return this.inline(fnVal.node, fnVal.file, fnVal.scope, args, undefined);
  }

  private inline(
    fn: FnNode,
    file: ParsedFile,
    closure: Scope,
    args: Val[],
    self: Val | undefined,
  ): Val {
    this.depth += 1;
    try {
      const scope = new Scope(closure);
      if (args.length === 0 && fn.parameters.length > 0) {
        const first = fn.parameters[0]!;
        if (this.ts.isObjectBindingPattern(first.name)) {
          return this.runFunction(fn, file, [], scope, self);
        }
      }
      return this.runFunction(fn, file, args.length ? args : [], scope, self);
    } finally {
      this.depth -= 1;
    }
  }

  private evalTestMember(
    node: TS.CallExpression,
    callee: TS.PropertyAccessExpression,
    ex: Ex,
  ): Val {
    const ts = this.ts;
    const path = chainNames(ts, callee);
    const member = path[1];
    if (member === "step") {
      const title = node.arguments[0]
        ? this.titleText(node.arguments[0])
        : undefined;
      const fn = node.arguments.find(
        (a) => ts.isArrowFunction(a) || ts.isFunctionExpression(a),
      );
      if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) {
        return this.unmapped(node, "test.step without an inline callback");
      }
      if (title) this.pendingTitle = title;
      const result = this.inline(fn, ex.file, ex.scope, [], ex.self);
      this.pendingTitle = undefined;
      return result;
    }
    if (member === "setTimeout" || member === "slow" || member === "info")
      return VOID;
    if (member === "use") {
      return this.unmapped(
        node,
        "test.use(...) options are not imported; set them in cairntrace.config.yml (browser block)",
      );
    }
    if (member === "skip" || member === "fixme" || member === "fail") {
      return this.unmapped(
        node,
        `test.${member}(...) condition is not imported`,
      );
    }
    return this.unmapped(node, `test.${member ?? "?"}(...) is not imported`);
  }

  private evalPromiseCall(node: TS.CallExpression, name: string, ex: Ex): Val {
    const ts = this.ts;
    const arg = node.arguments[0];
    if (name === "all" && arg && ts.isArrayLiteralExpression(arg)) {
      // Promise.all([a(), b()]) runs the calls in order; the concurrency is lost.
      for (const el of arg.elements) {
        const v = this.evalExpr(el, ex);
        if (v.k === "unknown" && !v.recorded) this.unmapped(el, v.reason);
      }
      this.record(
        "approximated",
        this.text(node),
        "Promise.all([...]) was run as sequential steps",
      );
      return VOID;
    }
    return this.unmapped(node, `Promise.${name}(...) is not imported`);
  }

  /** Helpers a `--project` export emits (lib/hydration, lib/clickUntil). */
  private evalExportHelper(
    node: TS.CallExpression,
    name: string,
    ex: Ex,
  ): Val | undefined {
    if (
      name !== "verifiedFill" &&
      name !== "verifiedType" &&
      name !== "clickUntil"
    ) {
      return undefined;
    }
    const loc = node.arguments[1]
      ? this.evalExpr(node.arguments[1], ex)
      : undefined;
    if (!loc || loc.k !== "loc") return undefined;
    if (name === "clickUntil")
      return this.actClick(loc.chain, node, undefined, ex);
    const value = node.arguments[2]
      ? this.evalExpr(node.arguments[2], ex)
      : undefined;
    if (name === "verifiedFill")
      return this.actFill(loc.chain, value, node, ex);
    const delay = this.optionNumber(node.arguments[3], "delay", ex);
    return this.actType(loc.chain, value, delay, node, ex);
  }

  private callMethod(
    recv: Val,
    method: string,
    node: TS.CallExpression,
    ex: Ex,
  ): Val {
    const args = node.arguments;
    switch (recv.k) {
      case "page":
        return this.pageMethod(method, node, ex);
      case "loc":
        return this.locMethod(recv.chain, method, node, ex);
      case "keyboard":
        return this.keyboardMethod(method, node, ex);
      case "request":
        return this.requestMethod(method, node, ex);
      case "ctx":
        if (method === "newPage") return { k: "page" };
        return this.unmapped(node, `context.${method}(...) is not imported`);
      case "browser":
        if (method === "newContext" || method === "newPage") {
          // A helper or fixture that builds its own context: Cairntrace runs
          // one browser context per spec, so its page is the spec's page.
          this.noteApprox(node, [
            `browser.${method}() became the spec's own browser context (context options and a second context are not imported)`,
          ]);
          return method === "newPage" ? { k: "page" } : { k: "ctx" };
        }
        return this.unmapped(node, `browser.${method}(...) is not imported`);
      case "obj": {
        const own = recv.props.get(method);
        if (own?.k === "fn") return this.invoke(own, node, ex);
        const found = this.findMember(recv.cls, recv.file, method, "method");
        if (found) {
          if (this.depth >= MAX_DEPTH)
            return this.unmapped(
              node,
              "page object nesting is too deep to inline",
            );
          const argv = args.map((a) => this.evalExpr(a, ex));
          return this.inline(
            found.node as FnNode,
            found.file,
            found.file.scope,
            argv,
            recv,
          );
        }
        return unknown(
          `page object method ${method}() is not in the class or a readable import`,
        );
      }
      case "rec": {
        const own = recv.props.get(method);
        if (own?.k === "fn") return this.invoke(own, node, ex);
        return unknown(`${method}() is not statically known`);
      }
      case "fixture":
        return this.unmapped(
          node,
          `fixture ${recv.name} is defined outside this file; ${method}(...) is not imported`,
        );
      case "arr":
        if (method === "push") return VOID;
        return unknown(`array.${method}() is not statically known`);
      case "unknown":
        return recv;
      default:
        return unknown(`${method}() on a value that is not statically known`);
    }
  }

  /* ----- page ----- */

  private pageMethod(method: string, node: TS.CallExpression, ex: Ex): Val {
    const args = node.arguments;
    switch (method) {
      case "getByRole":
      case "getByLabel":
      case "getByText":
      case "getByTestId":
      case "getByPlaceholder":
      case "getByAltText":
      case "getByTitle":
      case "locator":
        return this.buildLocator(emptyChain(), method, node, ex);
      case "frameLocator":
        return this.unmapped(node, "frames are not imported (frameLocator)");
      case "click":
      case "dblclick":
      case "tap":
      case "fill":
      case "type":
      case "press":
      case "check":
      case "uncheck":
      case "setChecked":
      case "hover":
      case "focus":
      case "selectOption":
      case "setInputFiles":
      case "textContent":
      case "innerText":
      case "inputValue":
      case "isVisible":
        return this.legacyPageAction(method, node, ex);
      case "goto":
        return this.actGoto(node, ex);
      case "waitForSelector": {
        const sel = args[0] ? this.evalExpr(args[0], ex) : undefined;
        if (sel?.k !== "lit" || typeof sel.v !== "string") {
          return this.unmapped(
            node,
            "waitForSelector with a selector that is not statically known",
          );
        }
        const selApprox: string[] = [];
        const parsed = parseSourceSelector(sel.v, selApprox);
        if ("error" in parsed) return this.unmapped(node, parsed.error);
        const chain: LocChain = {
          ...emptyChain(),
          parts: parsed.parts,
          approx: selApprox,
          ...(parsed.nth !== undefined ? { nth: parsed.nth } : {}),
        };
        const state = this.optionString(args[1], "state", ex) ?? "visible";
        return this.actWaitFor(
          chain,
          state,
          this.optionNumber(args[1], "timeout", ex),
          node,
        );
      }
      case "waitForURL":
        return this.actWaitForUrl(node, ex);
      case "waitForLoadState": {
        const v = args[0] ? this.evalExpr(args[0], ex) : undefined;
        const state = v?.k === "lit" ? String(v.v) : "load";
        if (
          state !== "load" &&
          state !== "domcontentloaded" &&
          state !== "networkidle"
        ) {
          return this.unmapped(
            node,
            `waitForLoadState(${JSON.stringify(state)}) is not a wait: load value`,
          );
        }
        const timeout = this.optionNumber(args[1], "timeout", ex);
        return this.addStep(
          { wait: { load: state, ...(timeout ? { timeoutMs: timeout } : {}) } },
          node,
        );
      }
      case "waitForTimeout": {
        const v = args[0] ? this.evalExpr(args[0], ex) : undefined;
        if (
          v?.k === "lit" &&
          typeof v.v === "number" &&
          v.v >= 1 &&
          v.v <= 300_000
        ) {
          return this.addStep({ wait: { ms: Math.round(v.v) } }, node);
        }
        return this.unmapped(
          node,
          "waitForTimeout with a duration that is not a literal in 1..300000ms",
        );
      }
      case "url":
        return { k: "derived", what: "url" };
      case "context":
        return { k: "ctx" };
      case "setViewportSize":
        return this.unmapped(
          node,
          "viewport is a browser setting; set it in cairntrace.config.yml",
        );
      case "on":
      case "once":
        return this.unmapped(node, "page event listeners are not imported");
      case "route":
      case "unroute":
        return this.unmapped(
          node,
          "network mocking (page.route) has no Cairntrace step",
        );
      case "reload":
      case "goBack":
      case "goForward":
        return this.unmapped(
          node,
          `page.${method}() has no Cairntrace step; open the URL again`,
        );
      case "evaluate":
      case "evaluateHandle":
      case "addInitScript":
        return this.unmapped(
          node,
          "page.evaluate has no mapped equivalent; use an eval: step by hand",
        );
      case "screenshot":
        return this.unmapped(
          node,
          "screenshots are captured by the run itself (artifacts)",
        );
      case "title":
        return unknown("page.title() is not statically known");
      case "bringToFront":
      case "close":
        return VOID;
      default:
        return this.unmapped(node, `page.${method}(...) is not imported`);
    }
  }

  /**
   * The legacy selector-first page API (`page.fill(selector, value)`,
   * `page.click(selector)`, …): the selector string becomes the locator and
   * the rest of the call maps like the locator method.
   */
  private legacyPageAction(
    method: string,
    node: TS.CallExpression,
    ex: Ex,
  ): Val {
    const sel = node.arguments[0]
      ? this.evalExpr(node.arguments[0], ex)
      : undefined;
    if (sel?.k !== "lit" || typeof sel.v !== "string") {
      return this.unmapped(
        node,
        `page.${method}(selector, …) with a selector that is not statically known`,
      );
    }
    const approx: string[] = [];
    const parsed = parseSourceSelector(sel.v, approx);
    if ("error" in parsed) return this.unmapped(node, parsed.error);
    const chain: LocChain = {
      ...emptyChain(),
      parts: parsed.parts,
      approx,
      ...(parsed.nth !== undefined ? { nth: parsed.nth } : {}),
    };
    return this.locMethod(chain, method, node, ex, node.arguments.slice(1));
  }

  private actGoto(node: TS.CallExpression, ex: Ex): Val {
    const args = node.arguments;
    const url = args[0] ? this.evalExpr(args[0], ex) : undefined;
    if (url?.k !== "lit" || typeof url.v !== "string") {
      return this.unmapped(
        node,
        "goto with a URL that is not statically known",
      );
    }
    const waitUntil = this.optionString(args[1], "waitUntil", ex);
    const timeout = this.optionNumber(args[1], "timeout", ex);
    const approx: string[] = [];
    if (url.ph === "env")
      approx.push(
        "URL carries an ${env.X} placeholder; define it in the config",
      );
    const target = redactUrlCredentials(url.v, this.urlSink(approx));
    if (
      waitUntil === "networkidle" ||
      waitUntil === "domcontentloaded" ||
      (waitUntil === "load" && timeout)
    ) {
      return this.addStep(
        {
          open: {
            path: target,
            waitUntil,
            ...(timeout ? { timeoutMs: timeout } : {}),
          },
        },
        node,
        approx,
      );
    }
    if (waitUntil === "commit")
      approx.push("waitUntil: commit became the default load wait");
    return this.addStep({ open: target }, node, approx);
  }

  private actWaitForUrl(node: TS.CallExpression, ex: Ex): Val {
    const arg = node.arguments[0]
      ? this.evalExpr(node.arguments[0], ex)
      : undefined;
    const timeout = this.optionNumber(node.arguments[1], "timeout", ex);
    const t = timeout ? { timeoutMs: timeout } : {};
    if (arg?.k === "regex") {
      const approx = arg.flags.includes("i")
        ? ["regex flag i dropped (wait.url.pattern is case-sensitive)"]
        : [];
      return this.addStep(
        { wait: { url: { pattern: arg.source }, ...t } },
        node,
        approx,
      );
    }
    if (arg?.k === "lit" && typeof arg.v === "string") {
      if (!/[*?{]/.test(arg.v)) {
        return this.addStep({ wait: { url: { equals: arg.v }, ...t } }, node);
      }
      return this.addStep(
        { wait: { url: { pattern: globToRegex(arg.v) }, ...t } },
        node,
        [`glob ${JSON.stringify(arg.v)} became a regular expression`],
      );
    }
    return this.unmapped(
      node,
      "waitForURL with a predicate or value that is not statically known",
    );
  }

  /* ----- keyboard / request ----- */

  private keyboardMethod(method: string, node: TS.CallExpression, ex: Ex): Val {
    const v = node.arguments[0]
      ? this.evalExpr(node.arguments[0], ex)
      : undefined;
    if (method === "press" && v?.k === "lit" && typeof v.v === "string") {
      return this.addStep({ press: v.v }, node);
    }
    return this.unmapped(
      node,
      method === "press"
        ? "keyboard.press with a key that is not statically known"
        : `keyboard.${method}(...) has no Cairntrace step; press the keys with press:`,
    );
  }

  private requestMethod(method: string, node: TS.CallExpression, ex: Ex): Val {
    const args = node.arguments;
    const verbs = ["get", "post", "put", "patch", "delete", "head", "fetch"];
    if (!verbs.includes(method)) {
      return this.unmapped(node, `request.${method}(...) is not imported`);
    }
    const url = args[0] ? this.evalExpr(args[0], ex) : undefined;
    if (url?.k !== "lit" || typeof url.v !== "string") {
      return this.unmapped(
        node,
        "request with a URL that is not statically known",
      );
    }
    const opts = args[1] ? this.evalExpr(args[1], ex) : undefined;
    const props = opts?.k === "rec" ? opts.props : new Map<string, Val>();
    const methodName =
      method === "fetch"
        ? String(
            (props.get("method") as { v?: unknown } | undefined)?.v ?? "GET",
          ).toUpperCase()
        : method.toUpperCase();
    if (
      !["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
        methodName,
      )
    ) {
      return this.unmapped(
        node,
        `request method ${methodName} is not supported`,
      );
    }
    const approx: string[] = [];
    const target = redactUrlCredentials(url.v, this.urlSink(approx));
    const body = props.get("data") ?? props.get("form");
    const bodyPlain = body ? this.toPlain(body, approx, "") : undefined;
    const headerProps = props.get("headers");
    const headers: Record<string, string> = {};
    if (headerProps?.k === "rec") {
      for (const [name, value] of headerProps.props) {
        if (value.k !== "lit") {
          approx.push(`header ${name} is not statically known and was dropped`);
          continue;
        }
        if (
          looksCredentialKey(name) ||
          /^(authorization|cookie)$/i.test(name) ||
          (!isIdentifierHeader(name) && looksSecretValue(String(value.v)))
        ) {
          this.secretLiterals.add(String(value.v));
          for (const piece of String(value.v).split(/\s+/))
            this.secretLiterals.add(piece);
          headers[name] = secretPlaceholder(name);
          approx.push(`header ${name} became ${secretPlaceholder(name)}`);
        } else {
          headers[name] = String(value.v);
        }
      }
    }
    for (const key of props.keys()) {
      if (
        ![
          "data",
          "form",
          "headers",
          "method",
          "timeout",
          "failOnStatusCode",
          "ignoreHTTPSErrors",
        ].includes(key)
      ) {
        approx.push(`request option ${key} dropped`);
      }
    }
    if (props.has("form")) approx.push("form body was sent as JSON");
    return this.addStep(
      {
        request: {
          method: methodName as "GET",
          url: target,
          ...(Object.keys(headers).length > 0 ? { headers } : {}),
          ...(bodyPlain !== undefined ? { body: bodyPlain } : {}),
        },
      },
      node,
      approx,
    );
  }

  /**
   * A JSON-able copy of a value: string and number values under a
   * credential-named key (and everything nested under one, the parent's name
   * inherited), and credential-shaped strings under any key, become
   * `${secrets.X}`.
   */
  private toPlain(
    val: Val,
    approx: string[],
    keyHint: string,
    underCredential = false,
  ): unknown {
    const credential = underCredential || looksCredentialKey(keyHint);
    switch (val.k) {
      case "lit":
        if (
          val.ph === undefined &&
          ((credential &&
            (typeof val.v === "string" || typeof val.v === "number") &&
            val.v !== "") ||
            (typeof val.v === "string" && looksSecretValue(val.v)))
        ) {
          const hint = keyHint || "body";
          this.secretLiterals.add(String(val.v));
          approx.push(`value of ${hint} became ${secretPlaceholder(hint)}`);
          if (typeof val.v === "number") approx.push(numberAsSecretNote(hint));
          return secretPlaceholder(hint);
        }
        return val.v;
      case "rec": {
        const out: Record<string, unknown> = {};
        for (const [k, v] of val.props) {
          const plain = this.toPlain(
            v,
            approx,
            credential && keyHint ? `${keyHint}_${k}` : k,
            credential,
          );
          if (plain !== undefined) out[k] = plain;
        }
        return out;
      }
      case "arr":
        return val.items.map((v) =>
          this.toPlain(v, approx, keyHint, credential),
        );
      default:
        approx.push(
          `${keyHint || "value"} is not statically known and was dropped`,
        );
        return undefined;
    }
  }

  /* ----- locators ----- */

  private buildLocator(
    chain: LocChain,
    method: string,
    node: TS.CallExpression,
    ex: Ex,
  ): Val {
    const args = node.arguments;
    const first = args[0] ? this.evalExpr(args[0], ex) : undefined;
    const base: LocChain = {
      parts: [...chain.parts],
      approx: [...chain.approx],
      ...(chain.nth !== undefined ? { nth: chain.nth } : {}),
      ...(chain.hasText !== undefined ? { hasText: chain.hasText } : {}),
    };
    if (chain.nth !== undefined || chain.hasText !== undefined) {
      // A new scope after nth/filter: keep the narrower scope out of the chain.
      base.approx.push(
        "nth/filter on a parent locator was dropped when scoping a child locator",
      );
      delete base.nth;
      delete base.hasText;
    }
    const text = (
      v: Val | undefined,
    ): { value: string; plain: boolean } | undefined => {
      if (v?.k === "lit" && typeof v.v === "string")
        return { value: v.v, plain: true };
      if (v?.k === "regex") {
        const p = plainRegexText(v.source);
        if (p !== undefined) {
          base.approx.push(
            `pattern /${v.source}/${v.flags} was treated as the text "${p}"`,
          );
          return { value: p, plain: false };
        }
      }
      return undefined;
    };
    const exact = this.optionBool(args[1], "exact", ex);
    switch (method) {
      case "getByRole": {
        const role = first?.k === "lit" ? String(first.v) : undefined;
        if (!role)
          return this.unmapped(
            node,
            "getByRole with a role that is not statically known",
          );
        const optsNode = args[1];
        const nameVal = this.optionValue(optsNode, "name", ex);
        const name = nameVal ? text(nameVal) : undefined;
        if (nameVal && !name) {
          base.approx.push(
            "getByRole name is not a plain string and was dropped",
          );
        }
        for (const key of this.optionKeys(optsNode)) {
          if (!["name", "exact"].includes(key)) {
            base.approx.push(`getByRole option ${key} was dropped`);
          }
        }
        base.parts.push({
          kind: "role",
          role,
          ...(name ? { name: name.value } : {}),
          ...(exact ? { exact: true } : {}),
        });
        return { k: "loc", chain: base };
      }
      case "getByLabel": {
        const t = text(first);
        if (!t)
          return this.unmapped(
            node,
            "getByLabel with a pattern or value that is not statically known",
          );
        base.parts.push({
          kind: "label",
          name: t.value,
          ...(exact ? { exact: true } : {}),
        });
        return { k: "loc", chain: base };
      }
      case "getByText": {
        const t = text(first);
        if (!t)
          return this.unmapped(
            node,
            "getByText with a pattern or value that is not statically known",
          );
        base.parts.push({
          kind: "text",
          text: t.value,
          ...(exact ? { exact: true } : {}),
        });
        return { k: "loc", chain: base };
      }
      case "getByTestId": {
        if (first?.k !== "lit") {
          return this.unmapped(
            node,
            "getByTestId with a pattern or value that is not statically known",
          );
        }
        base.parts.push({ kind: "testid", testid: String(first.v) });
        return { k: "loc", chain: base };
      }
      case "getByPlaceholder":
      case "getByAltText":
      case "getByTitle": {
        const t = text(first);
        if (!t)
          return this.unmapped(
            node,
            `${method} with a pattern or value that is not statically known`,
          );
        const attr =
          method === "getByPlaceholder"
            ? "placeholder"
            : method === "getByAltText"
              ? "alt"
              : "title";
        base.parts.push({
          kind: "css",
          selector: `[${attr}="${t.value.replace(/"/g, '\\"')}"]`,
        });
        base.approx.push(
          `${method} became an exact [${attr}] selector (Playwright matches a case-insensitive substring)`,
        );
        return { k: "loc", chain: base };
      }
      case "locator": {
        if (first?.k === "loc") {
          base.parts.push(...first.chain.parts);
          base.approx.push(...first.chain.approx);
          return { k: "loc", chain: base };
        }
        if (first?.k !== "lit" || typeof first.v !== "string") {
          return this.unmapped(
            node,
            "locator() with a selector that is not statically known",
          );
        }
        const parsed = parseSourceSelector(first.v, base.approx);
        if ("error" in parsed) return this.unmapped(node, parsed.error);
        base.parts.push(...parsed.parts);
        if (parsed.nth !== undefined) base.nth = parsed.nth;
        return { k: "loc", chain: base };
      }
      default:
        return unknown(`${method} is not a locator builder`);
    }
  }

  private locMethod(
    chain: LocChain,
    method: string,
    node: TS.CallExpression,
    ex: Ex,
    /** The method's own arguments (a legacy `page.fill(sel, v)` drops the selector). */
    args: readonly TS.Expression[] = node.arguments,
  ): Val {
    switch (method) {
      case "getByRole":
      case "getByLabel":
      case "getByText":
      case "getByTestId":
      case "getByPlaceholder":
      case "getByAltText":
      case "getByTitle":
      case "locator":
        return this.buildLocator(chain, method, node, ex);
      case "first":
        // The exporter appends .first() to mirror first-match semantics; that
        // is the Cairntrace default, so it is not carried back as nth: 0.
        return this.exporterOutput
          ? { k: "loc", chain }
          : { k: "loc", chain: { ...chain, nth: 0 } };
      case "last":
        return {
          k: "loc",
          chain: {
            ...chain,
            approx: [
              ...chain.approx,
              ".last() was dropped; the first match is used",
            ],
          },
        };
      case "nth": {
        const n = args[0] ? this.evalExpr(args[0], ex) : undefined;
        if (n?.k === "lit" && typeof n.v === "number" && n.v >= 0) {
          return { k: "loc", chain: { ...chain, nth: n.v } };
        }
        return this.unmapped(
          node,
          "nth() with an index that is not a non-negative literal",
        );
      }
      case "filter":
        return this.filterLocator(chain, node, ex);
      case "describe":
        return { k: "loc", chain };
      case "and":
      case "or":
        return this.unmapped(
          node,
          `locator.${method}(...) composition has no Cairntrace locator`,
        );
      case "click":
        return this.actClick(chain, node, args[0], ex);
      case "dblclick":
        return this.actClick(chain, node, args[0], ex, "dblclick");
      case "tap":
        return this.actClick(chain, node, args[0], ex, "tap");
      case "hover":
        return this.simpleAction(chain, node, (locator) => ({
          hover: locator,
        }));
      case "focus":
        return this.simpleAction(chain, node, (locator) => ({
          focus: locator,
        }));
      case "scrollIntoViewIfNeeded":
        return this.simpleAction(chain, node, (locator) => ({
          scroll: { to: locator },
        }));
      case "fill": {
        const value = args[0] ? this.evalExpr(args[0], ex) : undefined;
        return this.actFill(chain, value, node, ex);
      }
      case "clear":
        return this.actFill(chain, { k: "lit", v: "" }, node, ex);
      case "pressSequentially":
      case "type": {
        const value = args[0] ? this.evalExpr(args[0], ex) : undefined;
        return this.actType(
          chain,
          value,
          this.optionNumber(args[1], "delay", ex),
          node,
          ex,
        );
      }
      case "press": {
        const key = args[0] ? this.evalExpr(args[0], ex) : undefined;
        if (key?.k !== "lit" || typeof key.v !== "string") {
          return this.unmapped(
            node,
            "press with a key that is not statically known",
          );
        }
        return this.simpleAction(chain, node, (locator) => ({
          press: key.v as string,
          target: locator,
        }));
      }
      case "check":
        return this.simpleAction(chain, node, (locator) => ({
          check: locator,
        }));
      case "uncheck":
        return this.simpleAction(chain, node, (locator) => ({
          uncheck: locator,
        }));
      case "setChecked": {
        const v = args[0] ? this.evalExpr(args[0], ex) : undefined;
        if (v?.k !== "lit" || typeof v.v !== "boolean") {
          return this.unmapped(
            node,
            "setChecked with a value that is not a literal boolean",
          );
        }
        return this.simpleAction(chain, node, (locator) =>
          v.v ? { check: locator } : { uncheck: locator },
        );
      }
      case "selectOption":
        return this.actSelect(chain, node, ex, args[0]);
      case "setInputFiles": {
        const v = args[0] ? this.evalExpr(args[0], ex) : undefined;
        const path =
          v?.k === "lit" && typeof v.v === "string"
            ? v.v
            : v?.k === "arr" && v.items.length === 1 && v.items[0]?.k === "lit"
              ? String(v.items[0].v)
              : undefined;
        if (!path)
          return this.unmapped(
            node,
            "setInputFiles with files that are not one literal path",
          );
        return this.simpleAction(chain, node, (locator) => ({
          upload: { ...locator, path },
        }));
      }
      case "waitFor": {
        const state = this.optionString(args[0], "state", ex) ?? "visible";
        return this.actWaitFor(
          chain,
          state,
          this.optionNumber(args[0], "timeout", ex),
          node,
        );
      }
      case "isVisible":
        return { k: "derived", what: "visible", chain };
      case "count":
        return { k: "derived", what: "count", chain };
      case "textContent":
      case "innerText":
      case "allTextContents":
      case "allInnerTexts":
        return { k: "derived", what: "text", chain };
      case "inputValue":
        return { k: "derived", what: "value", chain };
      case "evaluate":
      case "evaluateAll":
      case "evaluateHandle":
        return this.unmapped(
          node,
          "locator.evaluate has no mapped equivalent; use an eval: step by hand",
        );
      case "dragTo":
      case "dispatchEvent":
      case "blur":
      case "selectText":
      case "screenshot":
      case "highlight":
        return this.unmapped(
          node,
          `locator.${method}(...) has no Cairntrace step`,
        );
      default:
        return this.unmapped(node, `locator.${method}(...) is not imported`);
    }
  }

  private filterLocator(chain: LocChain, node: TS.CallExpression, ex: Ex): Val {
    const ts = this.ts;
    const opts = node.arguments[0];
    const next: LocChain = { ...chain, approx: [...chain.approx] };
    if (!opts || !ts.isObjectLiteralExpression(opts)) {
      return this.unmapped(node, "filter() without a literal options object");
    }
    for (const key of this.optionKeys(opts)) {
      const v = this.optionValue(opts, key, ex);
      if (key === "hasText" && v) {
        if (v.k === "lit" && typeof v.v === "string") {
          if (next.hasText)
            next.approx.push("second hasText filter replaced the first");
          next.hasText = v.v;
        } else if (v.k === "regex" && plainRegexText(v.source) !== undefined) {
          next.hasText = plainRegexText(v.source)!;
          next.approx.push(
            `filter hasText /${v.source}/ was treated as plain text`,
          );
        } else {
          next.approx.push(
            "filter hasText that is not a plain string was dropped",
          );
        }
      } else if (key === "visible") {
        // visible matches are the Cairntrace default
      } else {
        next.approx.push(`filter option ${key} was dropped`);
      }
    }
    return { k: "loc", chain: next };
  }

  /* ----- actions ----- */

  private resolve(chain: LocChain, node: TS.Node): ResolvedLocator | undefined {
    const resolved = chainToLocator(chain);
    if (!resolved.locator) {
      this.unmapped(node, resolved.error ?? "locator cannot be expressed");
      return undefined;
    }
    return resolved;
  }

  private simpleAction(
    chain: LocChain,
    node: TS.Node,
    build: (locator: Locator) => Step,
  ): Val {
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    return this.addStep(build(resolved.locator), node, resolved.approx);
  }

  private actClick(
    chain: LocChain,
    node: TS.Node,
    optsNode: TS.Expression | undefined,
    ex: Ex,
    kind: "click" | "dblclick" | "tap" = "click",
  ): Val {
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    const approx = [...resolved.approx];
    if (kind === "dblclick")
      approx.push("dblclick became a single click (no double-click step)");
    if (kind === "tap") approx.push("tap became a click");
    const extra: { dispatch?: boolean } = {};
    for (const key of this.optionKeys(optsNode)) {
      const v = this.optionValue(optsNode, key, ex);
      if (key === "timeout" || key === "noWaitAfter" || key === "strict")
        continue;
      if (key === "force" && v?.k === "lit" && v.v === true) {
        extra.dispatch = true;
        approx.push("force: true became dispatch: true (a DOM click)");
      } else if (key === "button" && v?.k === "lit" && v.v !== "left") {
        return this.unmapped(
          node,
          `click with button ${String(v.v)} has no Cairntrace step`,
        );
      } else if (key === "trial" && v?.k === "lit" && v.v === true) {
        return this.unmapped(node, "trial click has no Cairntrace step");
      } else if (key === "clickCount" && v?.k === "lit" && v.v === 2) {
        if (!approx.some((a) => a.startsWith("dblclick")))
          approx.push("clickCount: 2 became a single click");
      } else {
        approx.push(`click option ${key} was dropped`);
      }
    }
    return this.addStep(
      { click: { ...resolved.locator, ...extra } } as Step,
      node,
      approx,
    );
  }

  private secretTarget(chain: LocChain): boolean {
    return chain.parts.some((part) => {
      switch (part.kind) {
        case "role":
          return looksSecretName(part.name);
        case "label":
          return looksSecretName(part.name);
        case "text":
          return false;
        case "testid":
          return looksSecretName(part.testid);
        case "css":
          return (
            /\[type=["']?password["']?\]/i.test(part.selector) ||
            looksSecretName(part.selector)
          );
      }
    });
  }

  private secretKeyFor(chain: LocChain): string {
    const part = chain.parts[chain.parts.length - 1];
    const hint =
      part?.kind === "role" || part?.kind === "label"
        ? ((part.kind === "role" ? part.name : part.name) ?? "secret")
        : part?.kind === "testid"
          ? part.testid
          : part?.kind === "css"
            ? /\[type=["']?password["']?\]/i.test(part.selector)
              ? "password"
              : part.selector
            : "secret";
    return placeholderKey(hint, "SECRET");
  }

  /** The text typed into a field; a secret target never keeps a literal. */
  private typedValue(
    chain: LocChain,
    value: Val | undefined,
    node: TS.Node,
  ): { value: string; approx: string[] } | undefined {
    const approx: string[] = [];
    const secret = this.secretTarget(chain);
    if (value?.k === "lit") {
      if (value.ph) return { value: String(value.v), approx };
      if (secret && value.v !== "") {
        this.secretLiterals.add(String(value.v));
        const key = this.secretKeyFor(chain);
        approx.push(
          `literal typed into a credential field became \${secrets.${key}}`,
        );
        return { value: `\${secrets.${key}}`, approx };
      }
      if (typeof value.v === "string" && looksSecretValue(value.v)) {
        this.secretLiterals.add(value.v);
        const key = `${this.secretKeyFor(chain)}_TOKEN`.replace(
          /^SECRET_TOKEN$/,
          "TOKEN",
        );
        approx.push(`a credential-shaped literal became \${secrets.${key}}`);
        return { value: `\${secrets.${key}}`, approx };
      }
      return { value: String(value.v), approx };
    }
    if (secret) {
      const key = this.secretKeyFor(chain);
      approx.push(
        `credential value is not statically known; used \${secrets.${key}}`,
      );
      return { value: `\${secrets.${key}}`, approx };
    }
    this.unmapped(node, "the typed value is not statically known");
    return undefined;
  }

  private actFill(
    chain: LocChain,
    value: Val | undefined,
    node: TS.Node,
    _ex: Ex,
  ): Val {
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    const typed = this.typedValue(chain, value, node);
    if (!typed) return unknown("value is not statically known", true);
    return this.addStep(
      { fill: { ...resolved.locator, value: typed.value } } as Step,
      node,
      [...resolved.approx, ...typed.approx],
    );
  }

  private actType(
    chain: LocChain,
    value: Val | undefined,
    delay: number | undefined,
    node: TS.Node,
    _ex: Ex,
  ): Val {
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    const typed = this.typedValue(chain, value, node);
    if (!typed) return unknown("value is not statically known", true);
    return this.addStep(
      {
        type: {
          ...resolved.locator,
          value: typed.value,
          ...(delay !== undefined ? { delayMs: delay } : {}),
        },
      } as Step,
      node,
      [...resolved.approx, ...typed.approx],
    );
  }

  private actSelect(
    chain: LocChain,
    node: TS.CallExpression,
    ex: Ex,
    argNode: TS.Expression | undefined = node.arguments[0],
  ): Val {
    const arg = argNode ? this.evalExpr(argNode, ex) : undefined;
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    const approx = [...resolved.approx];
    let choice: { value: string } | { label: string } | undefined;
    const single =
      arg?.k === "arr" && arg.items.length === 1 ? arg.items[0] : arg;
    if (single?.k === "lit" && typeof single.v === "string") {
      choice = { value: single.v };
      approx.push(
        "selectOption(string) matches value or label in Playwright; mapped as the option value",
      );
    } else if (single?.k === "rec") {
      const label = single.props.get("label");
      const value = single.props.get("value");
      if (label?.k === "lit") choice = { label: String(label.v) };
      else if (value?.k === "lit") choice = { value: String(value.v) };
    }
    if (!choice) {
      return this.unmapped(
        node,
        "selectOption with an option that is not one literal value or label",
      );
    }
    return this.addStep(
      { select: { ...resolved.locator, ...choice } } as Step,
      node,
      approx,
    );
  }

  private actWaitFor(
    chain: LocChain,
    state: string,
    timeout: number | undefined,
    node: TS.Node,
  ): Val {
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    const l = resolved.locator;
    const approx = [...resolved.approx];
    const t = timeout ? { timeoutMs: timeout } : {};
    if (!["attached", "visible", "hidden", "detached"].includes(state)) {
      return this.unmapped(node, `waitFor state ${state} is not mapped`);
    }
    if (l.by === "selector" || l.by === "testid") {
      const selector =
        l.by === "selector" ? l.selector : cssForTestId(l.testid);
      if (l.by === "testid")
        approx.push("test id assumes the default data-testid attribute");
      if ("nth" in l && l.nth !== undefined)
        approx.push("nth was dropped from the wait");
      return this.addStep(
        {
          wait: {
            selector,
            state: state as "attached" | "visible" | "hidden" | "detached",
            ...("hasText" in l && l.hasText ? { hasText: l.hasText } : {}),
            ...t,
          },
        },
        node,
        approx,
      );
    }
    const text =
      l.by === "text"
        ? l.text
        : l.by === "label"
          ? l.name
          : l.by === "role"
            ? l.name
            : undefined;
    if (!text) {
      return this.unmapped(
        node,
        "waitFor on a role without a name has no Cairntrace wait",
      );
    }
    approx.push(
      `waiting for ${l.by} ${JSON.stringify(text)} became a wait on its text`,
    );
    if (state === "hidden" || state === "detached") {
      return this.addStep({ wait: { notText: text, ...t } }, node, approx);
    }
    return this.addStep({ wait: { text, ...t } }, node, approx);
  }

  /* ----- options objects ----- */

  private optionKeys(node: TS.Expression | undefined): string[] {
    const ts = this.ts;
    if (!node || !ts.isObjectLiteralExpression(node)) return [];
    const out: string[] = [];
    for (const prop of node.properties) {
      if (
        ts.isPropertyAssignment(prop) ||
        ts.isShorthandPropertyAssignment(prop)
      ) {
        const key = propName(ts, prop.name);
        if (key) out.push(key);
      }
    }
    return out;
  }

  private optionValue(
    node: TS.Expression | undefined,
    key: string,
    ex: Ex,
  ): Val | undefined {
    const ts = this.ts;
    if (!node || !ts.isObjectLiteralExpression(node)) return undefined;
    for (const prop of node.properties) {
      if (ts.isPropertyAssignment(prop) && propName(ts, prop.name) === key) {
        return this.evalExpr(prop.initializer, ex);
      }
      if (ts.isShorthandPropertyAssignment(prop) && prop.name.text === key) {
        return this.evalIdentifier(prop.name, ex);
      }
    }
    return undefined;
  }

  private optionString(
    node: TS.Expression | undefined,
    key: string,
    ex: Ex,
  ): string | undefined {
    const v = this.optionValue(node, key, ex);
    return v?.k === "lit" && typeof v.v === "string" ? v.v : undefined;
  }

  private optionNumber(
    node: TS.Expression | undefined,
    key: string,
    ex: Ex,
  ): number | undefined {
    const v = this.optionValue(node, key, ex);
    return v?.k === "lit" && typeof v.v === "number" && v.v > 0
      ? Math.round(v.v)
      : undefined;
  }

  private optionBool(
    node: TS.Expression | undefined,
    key: string,
    ex: Ex,
  ): boolean {
    const v = this.optionValue(node, key, ex);
    return v?.k === "lit" && v.v === true;
  }

  /* ----- expect ----- */

  private parseExpectChain(node: TS.CallExpression): ExpectCall | undefined {
    const ts = this.ts;
    const callee = node.expression;
    if (!ts.isPropertyAccessExpression(callee)) return undefined;
    let isNot = false;
    let cursor: TS.Expression = unwrap(ts, callee.expression);
    // modifiers: .not / .resolves / .rejects
    while (
      ts.isPropertyAccessExpression(cursor) &&
      ["not", "resolves", "rejects"].includes(cursor.name.text)
    ) {
      if (cursor.name.text === "not") isNot = !isNot;
      cursor = unwrap(ts, cursor.expression);
    }
    if (!ts.isCallExpression(cursor)) return undefined;
    const head = unwrap(ts, cursor.expression);
    const isExpect =
      (ts.isIdentifier(head) && head.text === "expect") ||
      (ts.isPropertyAccessExpression(head) &&
        ts.isIdentifier(head.expression) &&
        head.expression.text === "expect" &&
        head.name.text === "soft");
    if (!isExpect) {
      if (
        ts.isPropertyAccessExpression(head) &&
        ts.isIdentifier(head.expression) &&
        head.expression.text === "expect" &&
        head.name.text === "poll"
      ) {
        return {
          poll: true,
          subject: cursor,
          matcher: callee.name.text,
          args: [...node.arguments],
          isNot,
        };
      }
      return undefined;
    }
    const subject = cursor.arguments[0];
    if (!subject) return undefined;
    return {
      subject,
      matcher: callee.name.text,
      args: [...node.arguments],
      isNot,
    };
  }

  private mapExpect(call: ExpectCall, node: TS.CallExpression, ex: Ex): Val {
    if (call.poll) {
      return this.unmapped(
        node,
        "expect.poll(...) is not imported; use a verifier poll: or wait: step",
      );
    }
    // The exporter's console budget: expect(consoleErrors.length).toBeLessThanOrEqual(n)
    const subjectText = call.subject.getText();
    if (
      /^consoleErrors\.length$/.test(subjectText) &&
      call.matcher === "toBeLessThanOrEqual"
    ) {
      const n = call.args[0] ? this.evalExpr(call.args[0], ex) : undefined;
      if (n?.k === "lit" && typeof n.v === "number") {
        return this.addOutcome(
          "console_errors_max",
          "console errors stay within budget",
          { console: { errorsMax: n.v } },
          node,
        );
      }
    }
    const subject = this.evalExpr(call.subject, ex);
    if (
      subject.k === "unknown" &&
      !subject.recorded &&
      !/^consoleErrors|^requests/.test(subjectText)
    ) {
      return this.unmapped(node, `assertion subject: ${subject.reason}`);
    }
    const m = call.matcher;
    const arg0 = call.args[0] ? this.evalExpr(call.args[0], ex) : undefined;

    if (subject.k === "page") {
      if (m === "toHaveURL" && !call.isNot)
        return this.urlOutcome(arg0, node, call.isNot);
      return this.unmapped(
        node,
        `expect(page).${
          call.isNot ? "not." : ""
        }${m}(...) has no mapped outcome`,
      );
    }
    if (subject.k === "derived")
      return this.mapDerived(subject, call, arg0, node, ex);
    if (subject.k === "loc")
      return this.mapLocatorAssertion(subject.chain, call, arg0, node, ex);
    return this.unmapped(
      node,
      subject.k === "unknown"
        ? `assertion subject: ${subject.reason}`
        : `expect(<${subject.k}>).${m}(...) has no mapped outcome`,
    );
  }

  private urlOutcome(arg: Val | undefined, node: TS.Node, isNot: boolean): Val {
    if (isNot)
      return this.unmapped(
        node,
        "negated URL assertions have no mapped outcome",
      );
    if (arg?.k === "regex") {
      const approx = arg.flags.includes("i")
        ? ["regex flag i dropped (url.matches is case-sensitive)"]
        : [];
      return this.addOutcome(
        "url_matches",
        "page URL matches",
        { url: { matches: arg.source } },
        node,
        approx,
      );
    }
    if (arg?.k === "lit" && typeof arg.v === "string") {
      const approx: string[] = [];
      const url = redactUrlCredentials(arg.v, this.urlSink(approx));
      return this.addOutcome(
        "url_matches",
        "page URL matches",
        {
          url: url.startsWith("/") ? { endsWith: url } : { equals: url },
        },
        node,
        approx,
      );
    }
    return this.unmapped(
      node,
      "toHaveURL with a value that is not a string or regular expression",
    );
  }

  private mapDerived(
    subject: Val & { k: "derived" },
    call: ExpectCall,
    arg0: Val | undefined,
    node: TS.Node,
    _ex: Ex,
  ): Val {
    const m = call.matcher;
    if (subject.what === "url") {
      if (call.isNot)
        return this.unmapped(
          node,
          "negated URL assertions have no mapped outcome",
        );
      if ((m === "toBe" || m === "toEqual") && arg0?.k === "lit")
        return this.urlOutcome(arg0, node, false);
      if (m === "toMatch" && arg0?.k === "regex")
        return this.urlOutcome(arg0, node, false);
      if (
        m === "toContain" &&
        arg0?.k === "lit" &&
        typeof arg0.v === "string"
      ) {
        return this.addOutcome(
          "url_matches",
          "page URL matches",
          { url: { matches: escapeRegex(arg0.v) } },
          node,
          ["toContain became a regular-expression url match"],
        );
      }
      return this.unmapped(
        node,
        `expect(page.url()).${m}(...) has no mapped outcome`,
      );
    }
    const chain = subject.chain;
    if (!chain)
      return this.unmapped(
        node,
        "assertion on a value that is not tied to a locator",
      );
    if (subject.what === "visible") {
      const wantVisible =
        (m === "toBe" || m === "toEqual") && arg0?.k === "lit"
          ? (arg0.v === true) !== call.isNot
          : m === "toBeTruthy"
            ? !call.isNot
            : m === "toBeFalsy"
              ? call.isNot
              : undefined;
      if (wantVisible === undefined)
        return this.unmapped(
          node,
          `isVisible() assertion ${m} has no mapped outcome`,
        );
      return this.visibilityOutcome(chain, wantVisible, node);
    }
    if (subject.what === "count") {
      if (
        (m === "toBe" || m === "toEqual") &&
        arg0?.k === "lit" &&
        typeof arg0.v === "number" &&
        !call.isNot
      ) {
        return this.countOutcome(chain, arg0.v, node);
      }
      return this.unmapped(
        node,
        `count() assertion ${m} has no mapped outcome`,
      );
    }
    if (subject.what === "text") {
      if (call.isNot && m === "toContain" && arg0?.k === "lit") {
        return this.textOutcome(
          chain,
          { contains: String(arg0.v) },
          true,
          node,
        );
      }
      if (!call.isNot && m === "toContain" && arg0?.k === "lit") {
        return this.textOutcome(
          chain,
          { contains: String(arg0.v) },
          false,
          node,
        );
      }
      if (
        !call.isNot &&
        (m === "toBe" || m === "toEqual") &&
        arg0?.k === "lit"
      ) {
        return this.textOutcome(chain, { equals: String(arg0.v) }, false, node);
      }
      if (!call.isNot && m === "toMatch" && arg0?.k === "regex") {
        return this.textOutcome(chain, { matches: arg0.source }, false, node);
      }
    }
    return this.unmapped(
      node,
      `assertion ${m} on a read value has no mapped outcome`,
    );
  }

  private mapLocatorAssertion(
    chain: LocChain,
    call: ExpectCall,
    arg0: Val | undefined,
    node: TS.CallExpression,
    ex: Ex,
  ): Val {
    const m = call.matcher;
    switch (m) {
      case "toBeVisible":
      case "toBeAttached":
        return this.visibilityOutcome(chain, !call.isNot, node);
      case "toBeHidden":
        return this.visibilityOutcome(chain, call.isNot, node);
      case "toHaveText":
      case "toContainText": {
        if (arg0?.k === "arr") {
          return this.unmapped(
            node,
            `${m} with an array of texts is not imported`,
          );
        }
        const matcher = this.textMatcher(arg0, m === "toContainText");
        if (!matcher)
          return this.unmapped(
            node,
            `${m} with a value that is not a string or regular expression`,
          );
        // Text matching is case-insensitive by default here, so ignoreCase
        // (and useInnerText) need no equivalent.
        return this.textOutcome(
          chain,
          matcher.matcher,
          call.isNot,
          node,
          matcher.approx,
        );
      }
      case "toHaveCount": {
        if (arg0?.k !== "lit" || typeof arg0.v !== "number" || call.isNot) {
          return this.unmapped(
            node,
            "toHaveCount with a value that is not a literal number",
          );
        }
        return this.countOutcome(chain, arg0.v, node);
      }
      case "toHaveValue": {
        if (arg0?.k !== "lit" || call.isNot) {
          return this.unmapped(
            node,
            "toHaveValue with a value that is not a literal string",
          );
        }
        const resolved = this.resolve(chain, node);
        if (!resolved?.locator)
          return unknown("locator cannot be expressed", true);
        const timeout = this.optionNumber(node.arguments[1], "timeout", ex);
        return this.addStep(
          {
            wait: {
              value: { ...resolved.locator, equals: String(arg0.v) },
              ...(timeout ? { timeoutMs: timeout } : {}),
            },
          } as Step,
          node,
          resolved.approx,
        );
      }
      case "toBeEnabled":
      case "toBeDisabled": {
        const resolved = this.resolve(chain, node);
        if (!resolved?.locator)
          return unknown("locator cannot be expressed", true);
        const enabled = (m === "toBeEnabled") !== call.isNot;
        return this.addStep(
          { expect: { ...resolved.locator, enabled } } as Step,
          node,
          resolved.approx,
        );
      }
      case "toHaveAttribute": {
        const name = arg0?.k === "lit" ? String(arg0.v) : undefined;
        const value = call.args[1]
          ? this.evalExpr(call.args[1], ex)
          : undefined;
        if (!name || call.isNot)
          return this.unmapped(
            node,
            "toHaveAttribute with a name that is not a literal",
          );
        const resolved = this.resolve(chain, node);
        if (!resolved?.locator)
          return unknown("locator cannot be expressed", true);
        const approx = [...resolved.approx];
        let attribute: {
          name: string;
          equals?: string;
          matches?: string;
          exists?: boolean;
        };
        if (value?.k === "lit") attribute = { name, equals: String(value.v) };
        else if (value?.k === "regex") {
          attribute = { name, matches: value.source };
          if (value.flags.includes("i")) approx.push("regex flag i dropped");
        } else if (!value) attribute = { name, exists: true };
        else
          return this.unmapped(
            node,
            "toHaveAttribute with a value that is not a string or regular expression",
          );
        return this.addStep(
          { expect: { ...resolved.locator, attribute } } as Step,
          node,
          approx,
        );
      }
      default:
        return this.unmapped(
          node,
          `${m}(...) has no mapped outcome${
            m === "toBeChecked"
              ? " (no checked assertion; capture the attribute or eval)"
              : ""
          }`,
        );
    }
  }

  private textMatcher(
    arg: Val | undefined,
    contains: boolean,
  ):
    | {
        matcher:
          | { equals: string }
          | { contains: string }
          | { matches: string };
        approx: string[];
      }
    | undefined {
    if (arg?.k === "lit" && typeof arg.v === "string") {
      return {
        matcher: contains ? { contains: arg.v } : { equals: arg.v },
        approx: [],
      };
    }
    if (arg?.k === "regex") {
      return {
        matcher: { matches: arg.source },
        approx: arg.flags.includes("i")
          ? ["regex flag i dropped (text.matches is case-sensitive)"]
          : [],
      };
    }
    return undefined;
  }

  private fromDraft(result: OutcomeResult, node: TS.Node): Val {
    if ("unmapped" in result) return this.unmapped(node, result.unmapped);
    return this.addOutcome(
      result.baseId,
      result.description,
      result.verify,
      node,
      result.approx,
    );
  }

  private textOutcome(
    chain: LocChain,
    matcher: TextMatcherDraft,
    negated: boolean,
    node: TS.Node,
    extraApprox: string[] = [],
  ): Val {
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    return this.fromDraft(
      textOutcome(resolved.locator, matcher, negated, [
        ...resolved.approx,
        ...extraApprox,
      ]),
      node,
    );
  }

  private visibilityOutcome(
    chain: LocChain,
    visible: boolean,
    node: TS.Node,
  ): Val {
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    return this.fromDraft(
      visibilityOutcome(resolved.locator, visible, resolved.approx),
      node,
    );
  }

  private countOutcome(chain: LocChain, n: number, node: TS.Node): Val {
    const resolved = this.resolve(chain, node);
    if (!resolved?.locator) return unknown("locator cannot be expressed", true);
    return this.fromDraft(
      countOutcome(resolved.locator, n, resolved.approx),
      node,
    );
  }
}

/* ----- helpers ----- */

interface Ex {
  file: ParsedFile;
  scope: Scope;
  self?: Val | undefined;
}

interface ExpectCall {
  subject: TS.Expression;
  matcher: string;
  args: TS.Expression[];
  isNot: boolean;
  poll?: true;
}

interface FoundTest {
  title: string;
  fn: FnNode | undefined;
  file: ParsedFile;
  stack: TS.CallExpression[];
  node: TS.CallExpression;
  hooks: FoundHook[];
  /** `test.use({...})` calls in scope (file level or an enclosing describe). */
  uses: FoundHook[];
}

interface FoundHook {
  kind: string;
  node: TS.CallExpression;
  stack: TS.CallExpression[];
}

function unwrap(ts: typeof TS, node: TS.Expression): TS.Expression {
  let cur = node;
  for (;;) {
    if (
      ts.isParenthesizedExpression(cur) ||
      ts.isAwaitExpression(cur) ||
      ts.isAsExpression(cur) ||
      ts.isNonNullExpression(cur) ||
      ts.isSatisfiesExpression(cur) ||
      ts.isTypeAssertionExpression(cur)
    ) {
      cur = cur.expression;
      continue;
    }
    return cur;
  }
}

function rootIdentifier(
  ts: typeof TS,
  node: TS.Expression,
): string | undefined {
  let cur: TS.Expression = node;
  while (ts.isPropertyAccessExpression(cur) || ts.isCallExpression(cur)) {
    cur = cur.expression;
  }
  return ts.isIdentifier(cur) ? cur.text : undefined;
}

/** `test.describe.serial` → ["test", "describe", "serial"]. */
function chainNames(ts: typeof TS, node: TS.Expression): string[] {
  const out: string[] = [];
  let cur: TS.Expression = node;
  while (ts.isPropertyAccessExpression(cur)) {
    out.unshift(cur.name.text);
    cur = cur.expression;
  }
  if (ts.isIdentifier(cur)) out.unshift(cur.text);
  return out;
}

function propName(ts: typeof TS, name: TS.PropertyName): string | undefined {
  if (
    ts.isIdentifier(name) ||
    ts.isStringLiteralLike(name) ||
    ts.isNumericLiteral(name)
  ) {
    return name.text;
  }
  return undefined;
}

function isStatic(ts: typeof TS, member: TS.ClassElement): boolean {
  return ts.canHaveModifiers(member)
    ? (ts.getModifiers(member) ?? []).some(
        (m) => m.kind === ts.SyntaxKind.StaticKeyword,
      )
    : false;
}

function isEmptyBody(
  ts: typeof TS,
  fn: TS.ArrowFunction | TS.FunctionExpression,
): boolean {
  return ts.isBlock(fn.body) && fn.body.statements.length === 0;
}

function isCallLike(ts: typeof TS, node: TS.Expression): boolean {
  const inner = unwrap(ts, node);
  return ts.isCallExpression(inner) || ts.isNewExpression(inner);
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A Playwright URL glob (`**​/home`, `*.html`) as a regular expression source. */
function globToRegex(glob: string): string {
  let out = "";
  for (let i = 0; i < glob.length; i += 1) {
    const ch = glob[i]!;
    if (ch === "*") {
      if (glob[i + 1] === "*") {
        out += ".*";
        i += 1;
      } else {
        out += "[^/]*";
      }
    } else if (ch === "?") {
      out += "[^/]";
    } else {
      out += escapeRegex(ch);
    }
  }
  return `^${out}$`;
}

/** A condition with no calls: names, `!name`, `a.b`, literals (evaluating it has no side effects). */
function isPlainCondition(ts: typeof TS, node: TS.Expression): boolean {
  const n = unwrap(ts, node);
  if (
    ts.isIdentifier(n) ||
    n.kind === ts.SyntaxKind.TrueKeyword ||
    n.kind === ts.SyntaxKind.FalseKeyword ||
    ts.isStringLiteral(n) ||
    ts.isNumericLiteral(n)
  ) {
    return true;
  }
  if (
    ts.isPrefixUnaryExpression(n) &&
    n.operator === ts.SyntaxKind.ExclamationToken
  )
    return isPlainCondition(ts, n.operand);
  if (ts.isPropertyAccessExpression(n))
    return isPlainCondition(ts, n.expression);
  return false;
}
