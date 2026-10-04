/**
 * E9: what an export map does to the generated project. `exportMap.ts` is the
 * data (schema, loading, selection); this module decides, for every action a
 * spec calls, which of four treatments applies, renders the bits the map
 * binds (fixture destructuring, page-object method calls, storageState
 * set-up) and the generated page-object files for the actions it leaves
 * alone. `playwrightProject.ts` calls into it while it lays out the tree.
 *
 * Errors are `ExportMapError`s that say what to change in the map (or the
 * spec): the export never guesses a binding it cannot check.
 */
import type { LoadedAction } from "../parser/parseSpec";
import type { Step } from "../schema/spec.v1";
import { block, blank, comment, print, raw, type Stmt } from "./codegen";
import {
  camelCase,
  ExportMapError,
  importSpecifier,
  isPlainScalar,
  kebabCase,
  MapWhenUndecidable,
  pascalCase,
  selectMapping,
  type ApiLoginMapping,
  type CallVars,
  type FixtureMapping,
  type LoadedExportMap,
  type MapArg,
  type MethodMapping,
} from "./exportMap";
import { prepareExportAuth, type ExportEnvAuth } from "./requestRuntime";
import { emitPlainValue } from "./playwrightExporter";
import { emitValue, newRefUsage, type RefUsage } from "./templateValue";
import type { EnvAuth } from "../schema/request.v1";

export type MappedTreatment =
  | "fixture"
  | "method"
  | "storageState"
  | "generated";

/** One action's binding, as the report and the README list it. */
export interface MappedActionReport {
  action: string;
  treatment: MappedTreatment;
  /** The host construct or generated file: `memberSession`, `OrdersPage.openOrder`, `.auth/x.json`, `LoginPage.login`. */
  target: string;
  /** Specs whose exported test uses it. */
  specs: string[];
  note?: string;
  /** `fixture`: the fixture's `type` from the map. */
  type?: string;
}

/** What the export's environment looks like to the map. */
export interface ExportMapEnv {
  lang: "ts" | "js";
  /** Absolute export root (relative imports of host modules are re-based from it). */
  outDir?: string;
  /** `.js` on relative host imports (node16 / nodenext, ESM JavaScript). */
  importExt: "" | ".js";
  moduleSystem: "esm" | "cjs";
  /** The host's tsconfig path alias, when one covers the host's own modules. */
  alias?: { prefix: string; dir: string };
  /** Names of the host config's `projects` (a `setupProject` must be one). */
  hostProjects?: readonly string[];
  configDir?: string;
  envAuth?: ExportEnvAuth;
}

/** The call the export is deciding about. */
export interface MapCall {
  action: string;
  loaded: LoadedAction | undefined;
  /** `use: { action, vars }` as written. */
  callVars: Record<string, unknown> | undefined;
  /** The vars that differ from the action's defaults (what the call hands over). */
  passed: Record<string, unknown>;
  specVars: Record<string, unknown>;
  specName: string;
  /** In another action, or inside a `repeat` / `if` / `retry` block. */
  nested: boolean;
  /** `use: { retry }`. */
  retried: boolean;
  /** The step carries a `when:` / `postcondition:`. */
  conditional: boolean;
  /**
   * A top-level call that no real step precedes (only `use:` steps the map
   * hoists before the test body): the only place a login is auto-detected.
   */
  leading?: boolean;
  /** `step.id`, for messages. */
  stepId: string | undefined;
}

/** The effective value of every var the action takes at this call. */
export function effectiveVars(call: MapCall): CallVars {
  const out: CallVars = {};
  const defaults = call.loaded?.actionDefaults ?? {};
  for (const key of Object.keys(defaults)) {
    out[key] = call.callVars?.[key] ?? call.specVars[key] ?? defaults[key];
  }
  for (const [key, value] of Object.entries(call.callVars ?? {})) {
    out[key] = value;
  }
  return out;
}

export type MapDecision =
  /** `use: login` with no mapping and no action file: the environment's built-in login. */
  | { kind: "builtin" }
  | { kind: "fixture"; fixture: FixtureMapping; note?: string }
  | { kind: "method"; method: MethodMapping; note?: string }
  | { kind: "apiLogin"; login: ApiLoginMapping; auto: boolean; note?: string }
  | {
      kind: "generated";
      className: string;
      methodName: string;
      note?: string;
      explicit: boolean;
    };

/** An action named for signing in (auto-detected as an API login when request-only and leading). */
const LOGIN_NAME = /(?:^|_)(?:login|log_in|signin|sign_in|authenticate)(?:_|$)/;
/** Never a login, whatever else the name says (`revoke_token`, `logout`, `refresh_session`). */
const NOT_LOGIN_NAME =
  /(?:^|_)(?:logout|log_out|signout|sign_out|revoke|delete|remove|refresh|expire|invalidate|reset|rotate)(?:_|$)/;

/**
 * An action that signs in through the API alone: every step a plain `request`
 * (no matrix, no `until`, cookies kept), so its cookies can be saved as a
 * storageState. Why not: the reason, or undefined when it is one.
 */
export function apiLoginBlocker(steps: readonly Step[]): string | undefined {
  if (steps.length === 0) return "it has no steps";
  for (const step of steps) {
    if (!("request" in step)) {
      return `step ${stepLabel(step)} is not a request (a login that drives the page cannot be a storageState)`;
    }
    const request = step.request;
    if (step.when !== undefined || step.postcondition !== undefined) {
      return `step ${stepLabel(step)} is conditional`;
    }
    if (request.matrix !== undefined || request.until !== undefined) {
      return `step ${stepLabel(step)} uses request.matrix / until, which a login does not`;
    }
    if (request.credentials === "omit") {
      return `step ${stepLabel(step)} sends credentials: omit, so it keeps no cookies`;
    }
  }
  return undefined;
}

function stepLabel(step: Step): string {
  const id = (step as { id?: string }).id;
  return id ? JSON.stringify(id) : "(unnamed)";
}

export interface SpecMapUse {
  /** The module the test's `test` comes from (host fixtures), when not `@playwright/test`. */
  testImport?: { specifier: string; name: string };
  /** Fixtures the test signature takes. */
  fixtures: Map<
    string,
    { providesPage: boolean; referenced: boolean; type?: string }
  >;
  /** `test.use({ … })` entries: option name → expression. */
  options: Map<string, string>;
  /** Host module imports of page object classes: final specifier → names. */
  imports: Map<string, Set<string>>;
  /** The storageState this test uses. */
  storage?: {
    action: string;
    /** Expression for the state file (`cairnStatePath(…)` or a literal). */
    pathExpr: string;
    /** Written by this export (not by a host setup project). */
    generated: boolean;
    stateName?: string;
    setupProject?: string;
  };
  /** A mapped call that runs before the test body ran (fixtures, storageState) came after a real step. */
  late: Array<{ action: string; stepId?: string }>;
}

export function newSpecMapUse(): SpecMapUse {
  return {
    fixtures: new Map(),
    options: new Map(),
    imports: new Map(),
    late: [],
  };
}

/** One generated state file (an API login written by this export). */
export interface ApiState {
  name: string;
  /** Relative to the export root. */
  file: string;
  /** The `CairnAuth` literal, as source (a function body: secrets read `process.env` when it runs). */
  literal: string;
  /** Env names that must be set (secrets / env without a default). */
  requiredEnv: string[];
}

/** A generated class, with the actions that became its methods. */
interface PageClass {
  className: string;
  file: string;
  methods: Array<{
    action: string;
    methodName: string;
    imports: string[];
    method: Stmt;
  }>;
}

export class ExportMapState {
  readonly reports = new Map<string, MappedActionReport>();
  readonly strictMissing = new Set<string>();
  readonly states = new Map<string, ApiState>();
  readonly requiredEnv = new Set<string>();
  /** Page classes keyed by class name (several actions may share one). */
  private readonly classes = new Map<string, PageClass>();
  /** What the class names are claimed by (`action`), to catch two classes with one name. */
  private readonly claimed = new Map<string, string>();

  constructor(
    readonly loaded: LoadedExportMap,
    readonly env: ExportMapEnv,
  ) {}

  get strict(): boolean {
    return this.loaded.map.strict === true;
  }

  get basePage(): NonNullable<LoadedExportMap["map"]["basePage"]> | undefined {
    return this.loaded.map.basePage;
  }

  get ext(): string {
    return this.env.lang === "js" ? ".js" : ".ts";
  }

  /** The generated base class lives next to the generated pages. */
  generatesBasePage(): boolean {
    return this.basePage === undefined && this.classes.size > 0;
  }

  /**
   * Which treatment a call gets. Pure apart from `strictMissing` (an unmapped
   * action under `strict`); the caller records the outcome with `record`.
   */
  decide(call: MapCall): MapDecision {
    const vars = effectiveVars(call);
    let hit: ReturnType<typeof selectMapping>;
    try {
      hit = selectMapping(this.loaded.map, call.action, vars);
    } catch (e) {
      if (e instanceof MapWhenUndecidable) {
        throw new ExportMapError(
          `export map: action ${call.action} (${where(call)}): ${e.message}`,
        );
      }
      throw e;
    }
    if (!hit) {
      const listed = this.loaded.map.actions?.[call.action] !== undefined;
      if (listed) {
        throw new ExportMapError(
          `export map: action ${call.action} is mapped, but no mapping's \`when\` holds at ${where(call)}; add a mapping without \`when\` to catch the rest`,
        );
      }
      if (!call.loaded) return { kind: "builtin" };
      if (this.strict) {
        this.strictMissing.add(call.action);
      } else if (
        LOGIN_NAME.test(call.action) &&
        !NOT_LOGIN_NAME.test(call.action) &&
        call.leading === true &&
        !call.nested &&
        // A storageState cannot honor a retry or a condition: leave it a page object.
        !call.retried &&
        !call.conditional &&
        apiLoginBlocker(call.loaded.action.steps) === undefined
      ) {
        return { kind: "apiLogin", login: {}, auto: true };
      }
      return this.generatedFor(call.action, {});
    }
    const { mapping } = hit;
    const note = mapping.note;
    if (mapping.fixture) {
      return {
        kind: "fixture",
        fixture: mapping.fixture,
        ...(note ? { note } : {}),
      };
    }
    if (mapping.method) {
      return {
        kind: "method",
        method: mapping.method,
        ...(note ? { note } : {}),
      };
    }
    if (mapping.apiLogin) {
      return {
        kind: "apiLogin",
        login: mapping.apiLogin,
        auto: false,
        ...(note ? { note } : {}),
      };
    }
    return this.generatedFor(call.action, mapping.generate ?? {}, note, true);
  }

  /**
   * Class names a generated page object must not take: the base class it
   * extends (the map's `basePage` or the generated `BasePage`) and every
   * host class a `method` mapping imports (a spec may import both).
   */
  reservedClassNames(): Set<string> {
    const reserved = new Set<string>([this.basePage?.name ?? "BasePage"]);
    for (const entry of Object.values(this.loaded.map.actions ?? {})) {
      for (const mapping of Array.isArray(entry) ? entry : [entry]) {
        if (mapping.method) reserved.add(mapping.method.class);
      }
    }
    return reserved;
  }

  /** Whether every mapping of `action` runs before the test body (fixture / apiLogin). */
  hoistsBeforeBody(action: string): boolean {
    const entry = this.loaded.map.actions?.[action];
    if (entry === undefined) return false;
    return (Array.isArray(entry) ? entry : [entry]).every(
      (mapping) =>
        mapping.fixture !== undefined || mapping.apiLogin !== undefined,
    );
  }

  private generatedFor(
    action: string,
    overrides: { class?: string | undefined; method?: string | undefined },
    note?: string,
    explicit = false,
  ): MapDecision {
    const reserved = this.reservedClassNames();
    let className = overrides.class ?? `${pascalCase(action)}Page`;
    if (reserved.has(className)) {
      if (overrides.class !== undefined) {
        throw new ExportMapError(
          `export map: action ${action}: generate.class ${className} is already a host class the map imports (basePage or a method mapping); pick another name`,
        );
      }
      const base = className;
      for (let n = 2; reserved.has(className); n += 1)
        className = `${base}${n}`;
    }
    return {
      kind: "generated",
      className,
      methodName: overrides.method ?? camelCase(action),
      explicit,
      ...(note ? { note } : {}),
    };
  }

  /** Report a binding (merged per action + target, with every spec that uses it). */
  record(
    entry: Omit<MappedActionReport, "specs">,
    specName: string,
  ): MappedActionReport {
    const key = `${entry.action}\u0000${entry.treatment}\u0000${entry.target}`;
    const existing = this.reports.get(key);
    if (existing) {
      if (!existing.specs.includes(specName)) existing.specs.push(specName);
      return existing;
    }
    const created: MappedActionReport = { ...entry, specs: [specName] };
    this.reports.set(key, created);
    return created;
  }

  /** Final path of the importer's own file, for re-basing a host import. */
  private fromFile(relPath: string): string {
    if (!this.env.outDir) {
      throw new ExportMapError(
        "export map: relative imports of host modules need the export directory (--into / --out-dir)",
      );
    }
    return `${this.env.outDir.replace(/\/+$/, "")}/${relPath}`;
  }

  specifierFor(specifier: string, importerRel: string): string {
    return importSpecifier(specifier, this.loaded, {
      fromFile: this.fromFile(importerRel),
      ext: this.env.importExt,
      ...(this.env.alias ? { alias: this.env.alias } : {}),
    });
  }

  /* ----- fixtures ----- */

  /**
   * A fixture-bound action. The test takes the fixture in its signature; the
   * vars the call passes become `test.use` options or are checked against
   * the constants the map pins.
   */
  useFixture(
    call: MapCall,
    fixture: FixtureMapping,
    spec: SpecMapUse,
    testRel: string,
    usage: RefUsage,
    note: string | undefined,
  ): Stmt[] {
    this.requireTopLevel(call, `fixture ${fixture.name}`);
    const effective = effectiveVars(call);
    const rules = fixture.vars ?? {};
    for (const key of Object.keys(call.passed)) {
      if (!(key in rules)) {
        throw new ExportMapError(
          `export map: action ${call.action} (${where(call)}) passes var ${key}, but fixture ${fixture.name} has no rule for it; add \`vars.${key}: { option: <name> | const: <value> | ignore: true }\` to the mapping`,
        );
      }
    }
    for (const [key, rule] of Object.entries(rules)) {
      if ("const" in rule) {
        const value = effective[key];
        if (value === undefined) continue;
        if (!isPlainScalar(value)) {
          throw new ExportMapError(
            `export map: action ${call.action} (${where(call)}): var ${key} is not a plain value here, so it cannot be checked against the constant ${JSON.stringify(rule.const)} that fixture ${fixture.name} is pinned to`,
          );
        }
        if (String(value) !== String(rule.const)) {
          throw new ExportMapError(
            `export map: action ${call.action} (${where(call)}) sets ${key} to ${JSON.stringify(value)}, but fixture ${fixture.name} is pinned to ${JSON.stringify(rule.const)}; map this call to a different fixture (a \`when\` on ${key}) or change the map`,
          );
        }
      } else if ("option" in rule && effective[key] !== undefined) {
        // the action's default counts too: the host fixture's own default may differ
        const expr = emitValue(effective[key], usage);
        const previous = spec.options.get(rule.option);
        if (previous !== undefined && previous !== expr) {
          throw new ExportMapError(
            `export map: option ${rule.option} is set to two values in spec ${call.specName}; one test has one value per option`,
          );
        }
        spec.options.set(rule.option, expr);
      }
    }
    const testName = fixture.testName ?? this.loaded.map.test?.name ?? "test";
    const importSource = fixture.import ?? this.loaded.map.test?.import;
    if (!importSource) {
      throw new ExportMapError(
        `export map: fixture ${fixture.name} needs the module that exports the host's \`test\`: set \`import\` on the fixture or \`test.import\` on the map`,
      );
    }
    const specifier = this.specifierFor(importSource, testRel);
    if (
      spec.testImport &&
      (spec.testImport.specifier !== specifier ||
        spec.testImport.name !== testName)
    ) {
      throw new ExportMapError(
        `export map: spec ${call.specName} uses fixtures from two different \`test\` objects (${spec.testImport.specifier} and ${specifier}); a test has one`,
      );
    }
    spec.testImport = { specifier, name: testName };
    const providesPage = fixture.providesPage === true;
    if (
      providesPage &&
      [...spec.fixtures].some(
        ([name, entry]) => entry.providesPage && name !== fixture.name,
      )
    ) {
      throw new ExportMapError(
        `export map: spec ${call.specName} has two fixtures that provide the page; a test works in one`,
      );
    }
    spec.fixtures.set(fixture.name, {
      providesPage,
      referenced: spec.fixtures.get(fixture.name)?.referenced ?? false,
      ...(fixture.type ? { type: fixture.type } : {}),
    });
    this.record(
      {
        action: call.action,
        treatment: "fixture",
        target: fixture.name,
        ...(fixture.type ? { type: fixture.type } : {}),
        ...(note ? { note } : {}),
      },
      call.specName,
    );
    return [
      comment(
        `step: ${call.stepId ?? call.action} (action ${call.action}) — provided by the host fixture ${fixture.name}${
          fixture.type ? ` (${fixture.type})` : ""
        }, which runs before the test body`,
      ),
    ];
  }

  /* ----- page-object method calls ----- */

  /**
   * `new SomePage(page).openThing(args)` (or the fixture's instance). Returns
   * the statement and the host imports it needs, re-based for the importing
   * file.
   */
  methodCall(
    call: MapCall,
    method: MethodMapping,
    importerRel: string,
    pageExpr: string,
    usage: RefUsage,
    spec: SpecMapUse | undefined,
    note: string | undefined,
  ): { code: string; imports: Array<{ specifier: string; name: string }> } {
    const effective = effectiveVars(call);
    const consumed = new Set<string>();
    const args = (method.args ?? []).map((arg: MapArg) => {
      if ("const" in arg) return emitValue(arg.const, usage);
      consumed.add(arg.var);
      const value = effective[arg.var] ?? arg.default;
      if (value === undefined) {
        throw new ExportMapError(
          `export map: action ${call.action} (${where(call)}): argument var ${arg.var} has no value here and no \`default\` in the map`,
        );
      }
      return emitValue(value, usage);
    });
    const ignored = new Set(method.ignoreVars ?? []);
    for (const key of Object.keys(call.passed)) {
      if (!consumed.has(key) && !ignored.has(key)) {
        throw new ExportMapError(
          `export map: action ${call.action} (${where(call)}) passes var ${key}, but method ${method.class}.${method.call} takes no argument from it; add it to \`args\` or to \`ignoreVars\``,
        );
      }
    }
    const imports: Array<{ specifier: string; name: string }> = [];
    let target: string;
    if (method.instance) {
      if (!spec) {
        throw new ExportMapError(
          `export map: action ${call.action} is used inside the generated page objects, where a fixture's instance (${method.instance.fixture}) does not exist; map it with \`new\` (no \`instance\`) or call it from the spec's own steps`,
        );
      }
      const entry = spec.fixtures.get(method.instance.fixture);
      spec.fixtures.set(method.instance.fixture, {
        providesPage: entry?.providesPage ?? false,
        referenced: true,
        ...(entry?.type ? { type: entry.type } : {}),
      });
      this.useHostTest(call, spec, importerRel);
      target = method.instance.fixture;
    } else {
      const specifier = this.specifierFor(method.import, importerRel);
      imports.push({ specifier, name: method.class });
      target = `new ${method.class}(${pageExpr})`;
    }
    this.record(
      {
        action: call.action,
        treatment: "method",
        target: `${method.class}.${method.call}`,
        ...(note ? { note } : {}),
      },
      call.specName,
    );
    return {
      code: `await ${target}.${method.call}(${args.join(", ")});`,
      imports,
    };
  }

  /** A fixture instance needs the host's `test` too. */
  private useHostTest(call: MapCall, spec: SpecMapUse, testRel: string): void {
    const test = this.loaded.map.test;
    if (!test) {
      throw new ExportMapError(
        `export map: action ${call.action} uses a fixture instance, which needs \`test.import\` (the module that exports the host's \`test\`) on the map`,
      );
    }
    const specifier = this.specifierFor(test.import, testRel);
    const name = test.name ?? "test";
    if (
      spec.testImport &&
      (spec.testImport.specifier !== specifier || spec.testImport.name !== name)
    ) {
      throw new ExportMapError(
        `export map: spec ${call.specName} uses fixtures from two different \`test\` objects (${spec.testImport.specifier} and ${specifier}); a test has one`,
      );
    }
    spec.testImport = { specifier, name };
  }

  /* ----- API login (storageState) ----- */

  /**
   * An API login: the test runs with a `storageState` and the sign-in is made
   * by `lib/authState` (or by the host's own setup project).
   */
  useApiLogin(
    call: MapCall,
    login: ApiLoginMapping,
    spec: SpecMapUse,
    note: string | undefined,
    auth: { literal: string; requiredEnv: string[] } | undefined,
  ): Stmt[] {
    this.requireTopLevel(call, "an API login (storageState)");
    if (spec.storage && spec.storage.action !== call.action) {
      throw new ExportMapError(
        `export map: spec ${call.specName} uses two API logins (${spec.storage.action} and ${call.action}); a test runs with one storageState`,
      );
    }
    if (login.setupProject !== undefined) {
      const projects = this.env.hostProjects;
      if (
        projects &&
        projects.length > 0 &&
        !projects.includes(login.setupProject)
      ) {
        throw new ExportMapError(
          `export map: action ${call.action}: setupProject ${JSON.stringify(login.setupProject)} is not a project of the host Playwright config (${projects.join(", ")})`,
        );
      }
      spec.storage = {
        action: call.action,
        pathExpr: JSON.stringify(login.storageState),
        generated: false,
        setupProject: login.setupProject,
      };
      this.record(
        {
          action: call.action,
          treatment: "storageState",
          target: `${login.storageState} (host project ${login.setupProject})`,
          ...(note ? { note } : {}),
        },
        call.specName,
      );
      return [
        comment(
          `step: ${call.stepId ?? call.action} (action ${call.action}) — the host's ${login.setupProject} project writes ${login.storageState}; this test starts signed in`,
        ),
      ];
    }
    if (!auth) {
      throw new ExportMapError(
        `export map: action ${call.action} cannot be an API login`,
      );
    }
    const file = stateFile(login.storageState, call.action);
    const name = call.action;
    const existing = this.states.get(name);
    if (existing && existing.literal !== auth.literal) {
      throw new ExportMapError(
        `export map: action ${call.action} signs in differently in two specs (its vars differ); a storageState is written once per action`,
      );
    }
    this.states.set(name, {
      name,
      file,
      literal: auth.literal,
      requiredEnv: auth.requiredEnv,
    });
    for (const env of auth.requiredEnv) this.requiredEnv.add(env);
    spec.storage = {
      action: call.action,
      pathExpr: `cairnStatePath(${JSON.stringify(name)})`,
      generated: true,
      stateName: name,
    };
    this.record(
      {
        action: call.action,
        treatment: "storageState",
        target: file,
        ...(note ? { note } : {}),
      },
      call.specName,
    );
    return [
      comment(
        `step: ${call.stepId ?? call.action} (action ${call.action}) — signed in through the API into ${file} (lib/authState); this test starts with that storageState`,
      ),
    ];
  }

  /** Fixtures and storageState run before the test body; they cannot be a nested call. */
  requireTopLevel(call: MapCall, what: string): void {
    if (call.nested) {
      throw new ExportMapError(
        `export map: action ${call.action} (${where(call)}) maps to ${what}, which runs before the test body; it cannot be called inside another action or a repeat / if / retry block. Map it as a \`method\` or leave it to the generated page object`,
      );
    }
    if (call.retried) {
      throw new ExportMapError(
        `export map: action ${call.action} (${where(call)}) is called with \`retry\`, which ${what} cannot honor; map it as a \`method\``,
      );
    }
    if (call.conditional) {
      throw new ExportMapError(
        `export map: action ${call.action} (${where(call)}) has a \`when\` / \`postcondition\`, which ${what} cannot honor; map it as a \`method\``,
      );
    }
  }

  /* ----- generated page objects ----- */

  /** Add an unmapped action as a method of its class. */
  addPageMethod(
    action: string,
    className: string,
    methodName: string,
    parts: { imports: string[]; method: Stmt },
  ): PageClass {
    const owner = this.claimed.get(className);
    let pageClass = this.classes.get(className);
    if (!pageClass) {
      pageClass = {
        className,
        file: `lib/pages/${kebabCase(className)}${this.ext}`,
        methods: [],
      };
      this.classes.set(className, pageClass);
      this.claimed.set(className, action);
    } else if (owner === undefined) {
      this.claimed.set(className, action);
    }
    if (pageClass.methods.some((m) => m.methodName === methodName)) {
      throw new ExportMapError(
        `export map: two actions become ${className}.${methodName} (${pageClass.methods.find((m) => m.methodName === methodName)!.action} and ${action}); name one with \`generate: { method: … }\``,
      );
    }
    pageClass.methods.push({ action, methodName, ...parts });
    return pageClass;
  }

  /** Relative path of the file that holds `className` (generated). */
  classFile(className: string): string {
    return `lib/pages/${kebabCase(className)}${this.ext}`;
  }

  /** The generated page-object files, the base class included when the map names none. */
  renderPageFiles(): Array<{ relPath: string; source: string }> {
    const files: Array<{ relPath: string; source: string }> = [];
    const ts = this.env.lang === "ts";
    const base = this.basePage;
    const baseName = base?.name ?? "BasePage";
    for (const pageClass of [...this.classes.values()].toSorted((a, b) =>
      a.className.localeCompare(b.className),
    )) {
      const importLines = mergeImports([
        ...pageClass.methods.flatMap((m) => m.imports),
        base
          ? `import { ${base.name} } from ${JSON.stringify(
              this.specifierFor(base.import, pageClass.file),
            )};`
          : `import { ${baseName} } from "./base-page${
              this.env.lang === "js" || this.env.importExt === ".js"
                ? ".js"
                : ""
            }";`,
      ]);
      const stmts: Stmt[] = [
        comment(
          `Generated by \`cairn export playwright\` from the reusable action${
            pageClass.methods.length > 1 ? "s" : ""
          } ${pageClass.methods.map((m) => m.action).join(", ")}.`,
        ),
        comment(`Re-exporting overwrites this file.`),
        blank,
        ...importLines.map((line) => raw(line)),
        blank,
        block(
          `export class ${pageClass.className} extends ${baseName} {`,
          pageClass.methods.flatMap((m, index) =>
            index === 0 ? [m.method] : [blank, m.method],
          ),
        ),
      ];
      files.push({
        relPath: pageClass.file,
        source: `${print(stmts)}\n`,
      });
    }
    if (this.generatesBasePage()) {
      files.push({
        relPath: `lib/pages/base-page${this.ext}`,
        source: renderGeneratedBasePage(ts),
      });
    }
    return files;
  }

  /** Name of the Page property of the base class. */
  pageProperty(): string {
    return this.basePage?.pageProperty ?? "page";
  }

  /* ----- lib/authState ----- */

  renderAuthStateModule(): string | undefined {
    if (this.states.size === 0) return undefined;
    return renderAuthStateModule(this.env.lang, this.env.moduleSystem, [
      ...this.states.values(),
    ]);
  }

  /** The `.gitignore` that keeps written storage states out of version control. */
  authGitignore(): { relPath: string; source: string } | undefined {
    if (this.states.size === 0) return undefined;
    return {
      relPath: ".auth/.gitignore",
      source:
        "# storageState files hold session cookies: never commit them\n*\n!.gitignore\n",
    };
  }

  sortedReports(): MappedActionReport[] {
    return [...this.reports.values()]
      .map((report) => ({ ...report, specs: report.specs.toSorted() }))
      .toSorted(
        (a, b) =>
          a.action.localeCompare(b.action) ||
          a.treatment.localeCompare(b.treatment) ||
          a.target.localeCompare(b.target),
      );
  }

  /** Throw every strict-mode violation at once. */
  assertStrict(): void {
    if (!this.strict || this.strictMissing.size === 0) return;
    throw new ExportMapError(
      `export map is strict and has no mapping for ${[...this.strictMissing]
        .toSorted()
        .map((name) => `action ${name}`)
        .join(", ")} (used by an exported spec); map ${
        this.strictMissing.size === 1 ? "it" : "them"
      } under \`actions:\` (fixture / method / apiLogin / generate) or drop \`strict\``,
    );
  }
}

function where(call: MapCall): string {
  return `spec ${call.specName}${call.stepId ? `, step ${call.stepId}` : ""}`;
}

function stateFile(storageState: string | undefined, action: string): string {
  const file = storageState ?? `.auth/${action}.json`;
  if (
    file.startsWith("/") ||
    file.split("/").includes("..") ||
    /^[A-Za-z]:/.test(file)
  ) {
    throw new ExportMapError(
      `export map: action ${action}: storageState ${JSON.stringify(file)} must stay inside the export (a relative path without ..); to point at a file the host writes, add setupProject`,
    );
  }
  // Session cookies live only where the export's .auth/.gitignore covers them.
  if (!file.startsWith(".auth/") || file === ".auth/.gitignore") {
    throw new ExportMapError(
      `export map: action ${action}: storageState ${JSON.stringify(file)} must live under .auth/ (the export git-ignores that folder; a session file anywhere else could be committed); to point at a file the host writes, add setupProject`,
    );
  }
  return file;
}

/* ----- helpers shared with the project exporter ----- */

const isRelativeKey = (key: string): boolean => /^\.{1,2}\//.test(key);

const IMPORT_LINE = /^import (type )?\{([^}]*)\} from (["'])([^"']+)\3;?$/;

/** Union the named imports of lines that share a module (so no binding is imported twice). */
export function mergeImports(lines: readonly string[]): string[] {
  const bySource = new Map<
    string,
    { values: Set<string>; types: Set<string>; other: string[] }
  >();
  const order: string[] = [];
  for (const line of lines) {
    const match = IMPORT_LINE.exec(line.trim());
    if (!match) {
      const key = `raw:${line}`;
      if (!bySource.has(key)) {
        bySource.set(key, {
          values: new Set(),
          types: new Set(),
          other: [line],
        });
        order.push(key);
      }
      continue;
    }
    const source = match[4]!;
    let entry = bySource.get(source);
    if (!entry) {
      entry = { values: new Set(), types: new Set(), other: [] };
      bySource.set(source, entry);
      order.push(source);
    }
    for (const part of match[2]!.split(",")) {
      const name = part.trim();
      if (!name) continue;
      if (match[1] || name.startsWith("type ")) {
        entry.types.add(name.replace(/^type\s+/, ""));
      } else entry.values.add(name);
    }
  }
  const out: string[] = [];

  // Packages first, then relative paths, each alphabetical.
  for (const key of order.toSorted(
    (a, b) =>
      Number(isRelativeKey(a)) - Number(isRelativeKey(b)) || a.localeCompare(b),
  )) {
    const entry = bySource.get(key)!;
    if (key.startsWith("raw:")) {
      out.push(...entry.other);
      continue;
    }
    const specifiers = [
      ...[...entry.values].toSorted((a, b) => a.localeCompare(b)),
      ...[...entry.types]
        .filter((name) => !entry.values.has(name))
        .toSorted((a, b) => a.localeCompare(b))
        .map((name) => `type ${name}`),
    ];
    out.push(
      `import { ${specifiers.join(", ")} } from ${JSON.stringify(key)};`,
    );
  }
  return out;
}

function renderGeneratedBasePage(ts: boolean): string {
  return [
    `// Generated by \`cairn export playwright\`: the minimal base class of the generated`,
    `// page objects. Name your own with \`basePage\` in the export map to extend it instead.`,
    ...(ts ? [`import type { Page } from "@playwright/test";`] : []),
    ``,
    `export class BasePage {`,
    ...(ts ? [`  protected readonly page: Page;`] : []),
    ``,
    `  constructor(page${ts ? ": Page" : ""}) {`,
    `    this.page = page;`,
    `  }`,
    `}`,
    ``,
  ].join("\n");
}

/**
 * The `CairnAuth` literal of a request-only action (or the environment's own
 * `auth:`): the first request is the login, the rest follow it. Secrets and
 * `${env.X}` become `process.env` reads (late-bound sentinels), never values.
 */
export function apiLoginAuth(input: {
  steps: readonly Step[];
  configDir: string;
  /** `${requests.<assign>…}` of the first request is `login` in the helper. */
}): { literal: string; requiredEnv: string[] } {
  const requests = input.steps.map(
    (step) => (step as Extract<Step, { request: unknown }>).request,
  );
  const first = requests[0]!;
  const rename = first.assign && first.assign !== "login" ? first.assign : "";
  const rewrite = (value: unknown): unknown => {
    if (typeof value === "string" && rename) {
      return value.replaceAll(
        new RegExp(`\\$\\{requests\\.${rename}(?=[.}])`, "g"),
        "${requests.login",
      );
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value !== null && typeof value === "object") {
      return Object.fromEntries(
        Object.entries(value).map(([key, item]) => [key, rewrite(item)]),
      );
    }
    return value;
  };
  const envAuth: ExportEnvAuth = {
    auth: {
      login: first,
      after: input.steps.slice(1).map((step) => ({
        ...(step.id ? { id: step.id } : {}),
        request: rewrite(
          (step as Extract<Step, { request: unknown }>).request,
        ) as typeof first,
      })),
    } as EnvAuth,
    envName: "action",
    vars: {},
    configDir: input.configDir,
  };
  return authLiteral(envAuth);
}

/** The literal of an already-built `ExportEnvAuth` (the environment's login). */
export function authLiteral(
  envAuth: ExportEnvAuth,
  useVars: Record<string, unknown> = {},
): { literal: string; requiredEnv: string[] } {
  if (envAuth.auth.hydrate) {
    throw new ExportMapError(
      `export map: the environment's login hydrates the page (auth.hydrate), which a storageState cannot carry; map it as a fixture or method instead`,
    );
  }
  const usage = newRefUsage();
  const literal = emitPlainValue(prepareExportAuth(envAuth, useVars), usage);
  if (usage.runToken) {
    throw new ExportMapError(
      "export map: an API login cannot use ${run.token}: it is signed in outside the test body, where the per-test run token does not exist",
    );
  }
  return { literal, requiredEnv: [...usage.envNames].toSorted() };
}

/**
 * `lib/authState`: one `CairnAuth` per API login, written to the export's
 * `.auth/` directory through `cairnLoginState` (`request.newContext` +
 * `storageState`). Secrets are read from `process.env` when the sign-in runs.
 */
export function renderAuthStateModule(
  lang: "ts" | "js",
  moduleSystem: "esm" | "cjs",
  states: readonly ApiState[],
): string {
  const ts = lang === "ts";
  const ext = lang === "js" ? ".js" : "";
  const dir =
    moduleSystem === "cjs"
      ? `resolve(__dirname, "..")`
      : `fileURLToPath(new URL("..", import.meta.url))`;
  const lines: string[] = [
    `// Generated by \`cairn export playwright\` for the API login action(s) of the export map.`,
    `// Signs in through the request API (request.newContext) and saves the session as a`,
    `// Playwright storageState under <export>/.auth/ (git-ignored). Credentials are read`,
    `// from process.env when the sign-in runs; nothing secret is written into this file.`,
    ...(moduleSystem === "cjs"
      ? []
      : [`import { fileURLToPath } from "node:url";`]),
    `import { resolve } from "node:path";`,
    `import { cairnLoginState${
      ts ? ", type CairnAuth" : ""
    } } from "./request${ext}";`,
    ``,
  ];
  if (ts) {
    lines.push(
      `interface CairnState {`,
      `  file: string;`,
      `  required: string[];`,
      `  auth: () => CairnAuth;`,
      `}`,
      ``,
    );
  }
  lines.push(
    `const STATES${ts ? ": Record<string, CairnState>" : ""} = {`,
    ...states.flatMap((state) => [
      `  ${JSON.stringify(state.name)}: {`,
      `    file: ${JSON.stringify(state.file)},`,
      `    required: ${JSON.stringify(state.requiredEnv)},`,
      `    auth: ()${ts ? ": CairnAuth" : ""} => (${state.literal}),`,
      `  },`,
    ]),
    `};`,
    ``,
    `const ROOT = ${dir};`,
    ``,
    `/** Absolute path of an API login's storageState file. */`,
    `export function cairnStatePath(name${ts ? ": string" : ""})${
      ts ? ": string" : ""
    } {`,
    `  const state = STATES[name];`,
    `  if (!state) throw new Error("no API login state named " + name);`,
    `  return resolve(ROOT, state.file);`,
    `}`,
    ``,
    `const written = new Map${ts ? "<string, Promise<string>>" : ""}();`,
    ``,
    `/** Sign in (once per process) and save the storageState; resolves to its path. */`,
    `export function cairnEnsureState(name${ts ? ": string" : ""}, baseURL${
      ts ? ": string | undefined" : ""
    })${ts ? ": Promise<string>" : ""} {`,
    `  let pending = written.get(name);`,
    `  if (!pending) {`,
    `    pending = cairnWriteState(name, baseURL);`,
    `    written.set(name, pending);`,
    `  }`,
    `  return pending;`,
    `}`,
    ``,
    `/** Sign in now and save the storageState (global setup calls this once per suite). */`,
    `export async function cairnWriteState(name${
      ts ? ": string" : ""
    }, baseURL${ts ? ": string | undefined" : ""})${
      ts ? ": Promise<string>" : ""
    } {`,
    `  const state = STATES[name];`,
    `  if (!state) throw new Error("no API login state named " + name);`,
    `  for (const variable of state.required) {`,
    `    if (!process.env[variable]) {`,
    `      throw new Error("API login " + name + ": " + variable + " is not set — export it (or add it to the secrets provider) before running the tests");`,
    `    }`,
    `  }`,
    `  const path = cairnStatePath(name);`,
    `  await cairnLoginState(state.auth(), { baseURL: baseURL ?? "", path });`,
    `  return path;`,
    `}`,
    ``,
  );
  return lines.join("\n");
}

/**
 * `test.beforeAll` that signs the API login in before the first test of the
 * file needs its storageState. The project's `baseURL` comes from the running
 * project (`testInfo.project.use`).
 */
export function apiLoginHook(stateName: string): Stmt[] {
  return [
    comment(
      `Playwright needs the empty fixtures pattern to hand a hook its testInfo.`,
    ),
    raw(`// eslint-disable-next-line no-empty-pattern`),
    block(
      `test.beforeAll(async ({}, testInfo) => {`,
      [
        raw(
          `await cairnEnsureState(${JSON.stringify(stateName)}, testInfo.project.use.baseURL);`,
        ),
      ],
      `});`,
    ),
  ];
}
