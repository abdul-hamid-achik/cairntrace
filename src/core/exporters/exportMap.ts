/**
 * E9: the export map (`export.map.yml`). It binds Cairntrace actions to the
 * host Playwright tree's own constructs, so an exported test uses the host's
 * login fixture and page objects instead of inlining the action's steps:
 *
 *  - `fixture`: the action is a host Playwright fixture. The test takes it in
 *    its signature (`async ({ page, memberSession }) => …`) and the action's
 *    steps are not emitted; the vars the spec passes map to fixture options
 *    (`test.use({ option })`) or are checked against constants;
 *  - `method`: the action is a page-object method call
 *    (`new SomePage(page).openThing(arg)`, or a fixture-provided instance),
 *    with arguments mapped from the action's vars;
 *  - `apiLogin`: a request-based login signs in through the API and is
 *    written as a `storageState` file (never through `page.evaluate`);
 *  - `generate`: names the generated page object of an unmapped action.
 *
 * An unmapped action is emitted as a generated page-object method (over the
 * host's `basePage` when the map names one). `strict` makes an unmapped
 * action that an exported spec uses an error.
 *
 * Everything here is data: the map is parsed and validated, never executed.
 * Imports are module specifiers (a package or alias, used as written) or a
 * relative path (`./pom/base-page`), which is relative to the map file.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

export const EXPORT_MAP_VERSION = 1;

const IdentSchema = z
  .string()
  .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/, "a JavaScript identifier");
const VarKeySchema = z
  .string()
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "an action var name");
const ActionNameSchema = z.string().regex(/^[a-z][a-z0-9_]*$/);
const ImportSchema = z
  .string()
  .min(1)
  .refine((spec) => !/\s/.test(spec), "no whitespace in a module specifier");
const ScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Pick a mapping by what the call passes: `when: { var: role, equals: admin }`
 * (or `in: [a, b]`). The var is the action's own (its default applies when the
 * call does not set it).
 */
export const MapWhenSchema = z
  .object({
    var: VarKeySchema,
    equals: ScalarSchema.optional(),
    in: z.array(ScalarSchema).nonempty().optional(),
  })
  .strict()
  .refine((when) => (when.equals === undefined) !== (when.in === undefined), {
    message: "when needs exactly one of equals / in",
  });
export type MapWhen = z.infer<typeof MapWhenSchema>;

/** How an action var meets the fixture. */
export const FixtureVarRuleSchema = z.union([
  z.object({ option: IdentSchema }).strict(),
  z.object({ const: ScalarSchema }).strict(),
  z.object({ ignore: z.literal(true) }).strict(),
]);

export const FixtureMappingSchema = z
  .object({
    /** The fixture's name in the host's `test.extend({ … })`. */
    name: IdentSchema,
    /** Module that exports the host's extended `test` (default: the map's `test.import`). */
    import: ImportSchema.optional(),
    /** Export name of that `test` (default `test`). */
    testName: IdentSchema.optional(),
    /** The fixture's type, for the report and a comment (the host's own types do the checking). */
    type: z.string().min(1).optional(),
    /** The fixture hands out the page the test works in (`{ adminPage: page }`). */
    providesPage: z.boolean().optional(),
    /** One rule per action var the spec may pass. */
    vars: z.record(VarKeySchema, FixtureVarRuleSchema).optional(),
  })
  .strict();
export type FixtureMapping = z.infer<typeof FixtureMappingSchema>;

export const MapArgSchema = z.union([
  z.object({ var: VarKeySchema, default: ScalarSchema.optional() }).strict(),
  z
    .object({
      const: z.union([z.string(), z.number(), z.boolean(), z.null()]),
    })
    .strict(),
]);
export type MapArg = z.infer<typeof MapArgSchema>;

export const MethodMappingSchema = z
  .object({
    /** Module that exports the page object class. */
    import: ImportSchema,
    class: IdentSchema,
    /** The method to call. */
    call: IdentSchema,
    /** Positional arguments, from action vars or constants. */
    args: z.array(MapArgSchema).optional(),
    /** Use a host fixture's instance instead of `new Class(page)`. */
    instance: z.object({ fixture: IdentSchema }).strict().optional(),
    /** Action vars the call may pass that the method has no argument for (dropped on purpose). */
    ignoreVars: z.array(VarKeySchema).optional(),
  })
  .strict();
export type MethodMapping = z.infer<typeof MethodMappingSchema>;

export const ApiLoginMappingSchema = z
  .object({
    /**
     * The storageState file, relative to the export (default
     * `.auth/<action>.json`). With `setupProject`, a path the host's setup
     * project writes (used as written: nothing is generated).
     */
    storageState: z.string().min(1).optional(),
    /** The host's existing setup project that writes the state. */
    setupProject: z.string().min(1).optional(),
  })
  .strict()
  .refine((login) => login.setupProject === undefined || login.storageState, {
    message: "setupProject needs the storageState path it writes",
  });
export type ApiLoginMapping = z.infer<typeof ApiLoginMappingSchema>;

export const GenerateMappingSchema = z
  .object({
    class: IdentSchema.optional(),
    method: IdentSchema.optional(),
  })
  .strict();

export const ActionMappingSchema = z
  .object({
    when: MapWhenSchema.optional(),
    /** Why this binding; kept in the report. */
    note: z.string().min(1).optional(),
    fixture: FixtureMappingSchema.optional(),
    method: MethodMappingSchema.optional(),
    apiLogin: ApiLoginMappingSchema.optional(),
    generate: GenerateMappingSchema.optional(),
  })
  .strict()
  .refine(
    (mapping) =>
      [
        mapping.fixture,
        mapping.method,
        mapping.apiLogin,
        mapping.generate,
      ].filter((entry) => entry !== undefined).length === 1,
    {
      message:
        "a mapping needs exactly one of fixture / method / apiLogin / generate",
    },
  );
export type ActionMapping = z.infer<typeof ActionMappingSchema>;

export const ExportMapSchema = z
  .object({
    version: z.literal(EXPORT_MAP_VERSION),
    /** An unmapped action that an exported spec uses is an error. */
    strict: z.boolean().optional(),
    /** The host's extended `test` (fixtures live on it). Used by every exported test. */
    test: z
      .object({ import: ImportSchema, name: IdentSchema.optional() })
      .strict()
      .optional(),
    /** The host base class generated page objects extend. */
    basePage: z
      .object({
        import: ImportSchema,
        name: IdentSchema,
        /** The base class's property holding the Page (default `page`). */
        pageProperty: IdentSchema.optional(),
      })
      .strict()
      .optional(),
    actions: z
      .record(
        ActionNameSchema,
        z.union([ActionMappingSchema, z.array(ActionMappingSchema).min(1)]),
      )
      .optional(),
  })
  .strict()
  .superRefine((map, ctx) => {
    for (const [name, entry] of Object.entries(map.actions ?? {})) {
      if (!Array.isArray(entry)) continue;
      entry.forEach((mapping, index) => {
        if (mapping.when === undefined && index < entry.length - 1) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["actions", name, index],
            message:
              "a mapping without `when` matches every call: it must be the last one of the list",
          });
        }
      });
    }
  });
export type ExportMap = z.infer<typeof ExportMapSchema>;

/** A parsed, validated export map and where it came from. */
export interface LoadedExportMap {
  map: ExportMap;
  /** Absolute path of the map file. */
  path: string;
  /** Imports written `./…` resolve against this directory. */
  dir: string;
  /** sha256 of the canonical (key-sorted) parsed map: comment and layout changes do not move it. */
  digest: string;
}

export class ExportMapError extends Error {}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}

/** Stable digest of a parsed map (the manifest records it). */
export function exportMapDigest(map: ExportMap): string {
  return `sha256:${createHash("sha256")
    .update(JSON.stringify(sortKeys(map)))
    .digest("hex")}`;
}

/** Parse map text; errors name the field (`actions.login.fixture.name: …`). */
export function parseExportMap(text: string, source: string): ExportMap {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (e) {
    throw new ExportMapError(
      `${source}: not valid YAML: ${(e as Error).message}`,
    );
  }
  // A union hides which mapping is wrong: check each one on its own first.
  const actions = (raw as { actions?: unknown } | null)?.actions;
  if (actions !== null && typeof actions === "object") {
    for (const [name, entry] of Object.entries(actions)) {
      const list = Array.isArray(entry) ? entry : [entry];
      for (const [index, mapping] of list.entries()) {
        const one = ActionMappingSchema.safeParse(mapping);
        if (one.success) continue;
        const issue = one.error.issues[0]!;
        const at = [
          "actions",
          name,
          ...(Array.isArray(entry) ? [`[${index}]`] : []),
          ...issue.path,
        ].join(".");
        throw new ExportMapError(`${source}: ${at}: ${issue.message}`);
      }
    }
  }
  const parsed = ExportMapSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .slice(0, 6)
      .map(
        (issue) =>
          `${
            issue.path.length > 0 ? issue.path.join(".") : "(map)"
          }: ${issue.message}`,
      );
    throw new ExportMapError(`${source}: ${issues.join("; ")}`);
  }
  return parsed.data;
}

export function loadExportMap(path: string): LoadedExportMap {
  const abs = isAbsolute(path) ? path : resolve(process.cwd(), path);
  if (!existsSync(abs) || !statSync(abs).isFile()) {
    throw new ExportMapError(`export map ${abs} does not exist`);
  }
  const map = parseExportMap(readFileSync(abs, "utf8"), abs);
  return { map, path: abs, dir: dirname(abs), digest: exportMapDigest(map) };
}

/** Candidate files a relative module import may name (TypeScript / JavaScript). */
const MODULE_SUFFIXES = [
  "",
  ".ts",
  ".tsx",
  ".mts",
  ".cts",
  ".js",
  ".mjs",
  ".cjs",
  "/index.ts",
  "/index.tsx",
  "/index.js",
];

const isRelativeSpecifier = (specifier: string): boolean =>
  specifier.startsWith("./") || specifier.startsWith("../");

/** The file a relative import names, when it exists (undefined for a package / alias). */
export function resolveMapModule(
  specifier: string,
  loaded: Pick<LoadedExportMap, "dir">,
): { file?: string; relative: boolean } {
  if (!isRelativeSpecifier(specifier)) return { relative: false };
  const base = resolve(loaded.dir, specifier.replace(/\.(?:[cm]?js)$/, ""));
  for (const suffix of MODULE_SUFFIXES) {
    const candidate = `${base}${suffix}`;
    if (existsSync(candidate) && statSync(candidate).isFile()) {
      return { file: candidate, relative: true };
    }
  }
  const exact = resolve(loaded.dir, specifier);
  if (existsSync(exact) && statSync(exact).isFile()) {
    return { file: exact, relative: true };
  }
  return { relative: true };
}

/** Every import a map names, with the field it came from. */
export function mapImports(
  map: ExportMap,
): Array<{ at: string; specifier: string }> {
  const out: Array<{ at: string; specifier: string }> = [];
  if (map.test) out.push({ at: "test.import", specifier: map.test.import });
  if (map.basePage) {
    out.push({ at: "basePage.import", specifier: map.basePage.import });
  }
  for (const [name, entry] of Object.entries(map.actions ?? {})) {
    const list = Array.isArray(entry) ? entry : [entry];
    list.forEach((mapping, index) => {
      const at = `actions.${name}${Array.isArray(entry) ? `[${index}]` : ""}`;
      if (mapping.fixture?.import) {
        out.push({
          at: `${at}.fixture.import`,
          specifier: mapping.fixture.import,
        });
      }
      if (mapping.method) {
        out.push({
          at: `${at}.method.import`,
          specifier: mapping.method.import,
        });
      }
    });
  }
  return out;
}

/**
 * Problems a map has on its own (relative imports that name no file). The
 * specs it is used with decide the rest (strict mode, vars).
 */
export function exportMapProblems(loaded: LoadedExportMap): string[] {
  const problems: string[] = [];
  for (const { at, specifier } of mapImports(loaded.map)) {
    const hit = resolveMapModule(specifier, loaded);
    if (hit.relative && !hit.file) {
      problems.push(
        `${at}: ${specifier} does not name a file (relative imports resolve from the map's directory)`,
      );
    }
  }
  return problems;
}

/* ----- resolving a mapping for a call ----- */

/** What an action call looks like to a mapping: the effective value of each var. */
export type CallVars = Record<string, unknown>;

/** A value `when` can compare: plain data, not a template. */
export function isPlainScalar(
  value: unknown,
): value is string | number | boolean {
  if (typeof value === "string") {
    return !value.includes("${") && !value.includes("__CAIRN_");
  }
  return typeof value === "number" || typeof value === "boolean";
}

export class MapWhenUndecidable extends Error {}

function whenHolds(when: MapWhen, vars: CallVars): boolean {
  const value = vars[when.var];
  if (value === undefined) return false;
  if (!isPlainScalar(value)) {
    throw new MapWhenUndecidable(
      `when.var ${when.var} is not a plain value at this call (a template or a runtime reference), so the mapping cannot be chosen at export time`,
    );
  }
  const text = String(value);
  return when.equals !== undefined
    ? text === String(when.equals)
    : (when.in ?? []).map(String).includes(text);
}

/** The first mapping of `action` whose `when` holds for `vars` (none when unmapped). */
export function selectMapping(
  map: ExportMap,
  action: string,
  vars: CallVars,
): { mapping: ActionMapping; index: number } | undefined {
  const entry = map.actions?.[action];
  if (!entry) return undefined;
  const list = Array.isArray(entry) ? entry : [entry];
  for (const [index, mapping] of list.entries()) {
    if (mapping.when === undefined || whenHolds(mapping.when, vars)) {
      return { mapping, index };
    }
  }
  return undefined;
}

/* ----- module specifiers ----- */

export interface ImportSpecifierOptions {
  /** Absolute path of the generated file that imports. */
  fromFile: string;
  /** `.js` is appended to a relative host import (node16 / nodenext, ESM JavaScript). */
  ext: "" | ".js";
  /** The host's tsconfig path alias: a target under its directory is imported through it. */
  alias?: { prefix: string; dir: string };
}

/**
 * The specifier a generated file writes for a map import: a package or alias
 * as written, a `./…` path re-based from the map's directory to the file that
 * imports it.
 */
export function importSpecifier(
  specifier: string,
  loaded: Pick<LoadedExportMap, "dir">,
  options: ImportSpecifierOptions,
): string {
  if (!isRelativeSpecifier(specifier)) return specifier;
  const hit = resolveMapModule(specifier, loaded);
  // ESM with explicit extensions (node16 / nodenext) names the file Node
  // loads: a barrel stays `…/index.js` (a directory import does not resolve),
  // `.mts` / `.cts` become `.mjs` / `.cjs`. Elsewhere the extensionless,
  // index-less specifier the host's resolver already accepts.
  let ext: string = options.ext;
  let target: string;
  if (hit.file && options.ext === ".js") {
    const flavor = /\.([cm]?)[jt]sx?$/.exec(hit.file)?.[1] ?? "";
    ext = flavor === "m" ? ".mjs" : flavor === "c" ? ".cjs" : ".js";
    target = hit.file.replace(/\.(?:[cm]?[jt]sx?)$/, "");
  } else {
    target = hit.file
      ? hit.file
          .replace(/\/index\.(?:[cm]?[jt]sx?)$/, "")
          .replace(/\.(?:[cm]?[jt]sx?)$/, "")
      : resolve(loaded.dir, specifier).replace(/\.(?:[cm]?[jt]sx?)$/, "");
  }
  if (options.alias) {
    const aliasRel = relative(options.alias.dir, target).split(sep).join("/");
    if (!aliasRel.startsWith("..") && aliasRel !== "") {
      return `${options.alias.prefix}${aliasRel}${ext}`;
    }
  }
  let rel = relative(dirname(options.fromFile), target).split(sep).join("/");
  if (!rel.startsWith(".")) rel = `./${rel}`;
  return options.ext === ".js" ? `${rel}${ext}` : rel;
}

/** Kebab-case file stem of a class name (`LoginPage` → `login-page`). */
export function kebabCase(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll(/([A-Z])([A-Z][a-z])/g, "$1-$2")
    .replaceAll(/[^A-Za-z0-9]+/g, "-")
    .replaceAll(/^-+|-+$/g, "")
    .toLowerCase();
}

/** `login_demo_app` → `LoginDemoApp`. */
export function pascalCase(name: string): string {
  return name
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
}

/** `login_demo_app` → `loginDemoApp`. */
export function camelCase(name: string): string {
  const pascal = pascalCase(name);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}
