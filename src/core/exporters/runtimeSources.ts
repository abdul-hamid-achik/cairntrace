import { readFileSync } from "node:fs";
import { RUNTIME_SOURCES } from "./runtimeSources.generated";

/**
 * Verifier / matcher logic the Playwright export runs at TEST time (the
 * `value`, `http`, `network` body / count, `file`, `xlsx` verifiers and
 * `expect.request`). It is never re-implemented for the export: each module's
 * source is the real runner module, and `runtimeSources.generated.ts` holds a
 * checked-in copy (a TypeScript form for `--lang ts`, a type-stripped form
 * for `--lang js`) so an installed package can emit it without a TypeScript
 * toolchain. `runtimeSources.test.ts` rebuilds both forms from the live
 * sources and FAILS when they differ — change a module, then regenerate with
 * `CAIRN_UPDATE_GENERATED=1 bun run test src/core/exporters/runtimeSources.test.ts`.
 *
 * Modules import each other by file name (`./matchers`), so a project export
 * writes them as `lib/<name>.ts|js` side by side; a single-file export
 * inlines them in dependency order.
 */

export const RUNTIME_MODULES = [
  "matchers",
  "refs",
  "evidence",
  "redact",
  "networkJudge",
  "responseJudge",
  "httpJsonMatch",
  "fileWait",
  "url",
  "httpWire",
  "xlsxJudge",
] as const;
export type RuntimeModuleName = (typeof RUNTIME_MODULES)[number];

/** Where each module's real source lives, relative to `src/core/`. */
export const RUNTIME_SOURCE_FILES: Record<RuntimeModuleName, string> = {
  matchers: "runner/verifiers/matchers.ts",
  refs: "runner/verifiers/refs.ts",
  evidence: "runner/verifiers/evidence.ts",
  redact: "datasources/redact.ts",
  networkJudge: "runner/verifiers/networkJudge.ts",
  responseJudge: "runner/verifiers/responseJudge.ts",
  httpJsonMatch: "runner/verifiers/httpJsonMatch.ts",
  fileWait: "runner/verifiers/fileWait.ts",
  url: "runner/url.ts",
  httpWire: "datasources/httpWire.ts",
  xlsxJudge: "runner/verifiers/xlsxJudge.ts",
};

/** The `lib/` import specifier of the workbook reader (`xlsxJudge` needs it). */
export const WORKBOOK_MODULE = "workbook";

export type ExportLang = "ts" | "js";

const SCHEMA_FILE = "schema/verifier.v1.ts";

/** The xlsx checks as plain types (the schema type is a zod inference). */
const XLSX_PRELUDE = `import type { ValueMatcher } from "./matchers";

// The schema's xlsx checks as plain data: the judge reads them by field. A
// field the judge starts reading that is missing here fails the strict
// compile in runtimeSources.test.ts.
type XlsxSheetSelector = number | string | { match: string };
interface XlsxCount {
  count?: number;
  atLeast?: number;
  atMost?: number;
}
interface XlsxHeaderSpecShape {
  labelRow?: number;
  keyRow?: number;
  strip?: string;
  caseSensitive?: boolean;
  present?: Array<string | { matches: string }>;
  absent?: Array<string | { matches: string }>;
  labels?: Record<string, string>;
  withinListInOrder?: unknown;
  includesInOrder?: unknown;
}
type XlsxVerifier = {
  xlsx: {
    path: string;
    sheet?: XlsxSheetSelector;
    contains?: string[];
    sheets?: Array<{ name: string; contains?: string[] }>;
    headers?: XlsxHeaderSpecShape;
    rows?: {
      afterKeyRow?: XlsxCount;
      match?: Array<{ column: string; matcher: ValueMatcher }>;
    };
    cells?: Array<{
      ref: string;
      sheet?: XlsxSheetSelector;
      equals?: string | number | boolean;
      matches?: string;
      numFmt?: string | number;
    }>;
    validations?: Array<{
      sheet?: XlsxSheetSelector;
      column: string;
      type?: string;
      formulaMatches?: string | string[];
    }>;
  };
};
`;

type ReadText = (relPath: string) => string;

/** Reads a file under `src/core/` of the running package. */
export const readCoreSource: ReadText = (relPath) =>
  readFileSync(new URL(`../${relPath}`, import.meta.url), "utf8");

function required(match: RegExpExecArray | null, what: string): string {
  if (!match) {
    throw new Error(`runtime source: could not find ${what}`);
  }
  return match[0];
}

/**
 * The matcher vocabulary types, taken from the schema file itself
 * (`ValueMatcherObject`, `ValueMatcher`, `PathMatchers`).
 */
function matcherTypes(read: ReadText): string {
  const schema = read(SCHEMA_FILE);
  const matcher = required(
    /export interface ValueMatcherObject \{[\s\S]*?\n\}\nexport type ValueMatcher =[\s\S]*?;\n/.exec(
      schema,
    ),
    "ValueMatcherObject / ValueMatcher in the verifier schema",
  );
  const paths = required(
    /export type PathMatchers = [^;]+;\n/.exec(schema),
    "PathMatchers in the verifier schema",
  );
  return `${matcher}${paths}`;
}

/** `import type { … } from "../../schema/verifier.v1";` (any one statement). */
const SCHEMA_IMPORT =
  /import type \{([^}]*)\} from "\.\.\/\.\.\/schema\/verifier\.v1";\n/;

const MATCHER_TYPE_NAMES = new Set([
  "ValueMatcher",
  "ValueMatcherObject",
  "PathMatchers",
]);

/**
 * `matchers.ts` carries the matcher types in; every other module takes them
 * from `./matchers`. A schema type outside that vocabulary is an error: the
 * runtime module would not compile standalone.
 */
function rerouteSchemaTypes(source: string, name: string): string {
  const found = SCHEMA_IMPORT.exec(source);
  if (!found) return source;
  const names = found[1]!
    .split(",")
    .map((part) => part.trim().replace(/^type\s+/, ""))
    .filter((part) => part.length > 0);
  const unknown = names.filter((part) => !MATCHER_TYPE_NAMES.has(part));
  if (unknown.length > 0) {
    throw new Error(
      `runtime source ${name}: imports schema type(s) ${unknown.join(", ")}, which a standalone module cannot have`,
    );
  }
  return source.replace(
    SCHEMA_IMPORT,
    `import type { ${names.join(", ")} } from "./matchers";\n`,
  );
}

/** The TypeScript form of one runtime module, from the live sources. */
export function buildRuntimeSourceTs(
  name: RuntimeModuleName,
  read: ReadText = readCoreSource,
): string {
  let source = read(RUNTIME_SOURCE_FILES[name]);
  switch (name) {
    case "matchers":
      source = source.replace(
        /import type \{[^}]*\} from "\.\.\/\.\.\/schema\/verifier\.v1";\n/,
        matcherTypes(read),
      );
      break;
    case "refs": {
      // `RefScope` is a Pick of the runner's VerifierContext; the runtime
      // module has no context type, so the same keys are declared directly.
      source = source.replace(
        'import type { VerifierContext } from "./types";\n',
        "",
      );
      const pick = required(
        /export type RefScope = Pick<[\s\S]*?>;\n/.exec(source),
        "RefScope in refs.ts",
      );
      const keys = [...pick.matchAll(/"(\w+)"/g)].map((m) => m[1]!);
      if (keys.length === 0)
        throw new Error("runtime source: RefScope has no keys");
      source = source.replace(
        pick,
        `export interface RefScope {\n${keys
          // Values are looked up by path at run time; the scope's own types
          // are the producer's business.
          .map((key) => `  ${key}?: any;`)
          .join("\n")}\n}\n`,
      );
      break;
    }
    case "xlsxJudge":
      source = source
        .replace(
          /import type \{[^}]*\} from "\.\.\/\.\.\/schema\/verifier\.v1";\n/,
          XLSX_PRELUDE,
        )
        .replace(
          '} from "../../../sdk/workbook.js";',
          `} from "./${WORKBOOK_MODULE}.js";`,
        );
      break;
    default:
      source = rerouteSchemaTypes(source, name);
  }
  const leftover = /from "\.\.\//.exec(source);
  if (leftover) {
    throw new Error(
      `runtime source ${name}: an import still reaches outside the runtime modules (${leftover.input.slice(Math.max(0, leftover.index - 60), leftover.index + 40)})`,
    );
  }
  return source;
}

/** Relative imports of a runtime module that are other runtime modules. */
export function runtimeModuleImports(
  tsSource: string,
): Array<RuntimeModuleName | typeof WORKBOOK_MODULE> {
  const names = new Set<RuntimeModuleName | typeof WORKBOOK_MODULE>();
  for (const m of tsSource.matchAll(/from "\.\/([A-Za-z]+)(?:\.js)?";/g)) {
    const name = m[1]!;
    if (name === WORKBOOK_MODULE) names.add(WORKBOOK_MODULE);
    else if ((RUNTIME_MODULES as readonly string[]).includes(name)) {
      names.add(name as RuntimeModuleName);
    }
  }
  return [...names];
}

/** The runtime modules `name` needs, dependencies first, `name` last. */
export function runtimeModuleClosure(
  names: Iterable<RuntimeModuleName>,
): RuntimeModuleName[] {
  const out: RuntimeModuleName[] = [];
  const visit = (name: RuntimeModuleName): void => {
    if (out.includes(name)) return;
    for (const dep of runtimeModuleImports(RUNTIME_SOURCES[name].ts)) {
      if (dep !== WORKBOOK_MODULE) visit(dep);
    }
    out.push(name);
  };
  for (const name of names) visit(name);
  return out;
}

/** A runtime module as the text of a `lib/<name>` file. */
export function renderRuntimeModule(
  name: RuntimeModuleName,
  lang: ExportLang,
): string {
  const source = RUNTIME_SOURCES[name][lang];
  return [
    `// Generated by \`cairn export playwright --project\` from Cairntrace's own`,
    `// ${RUNTIME_SOURCE_FILES[name]} (the module \`cairn run\` runs), not re-implemented.`,
    `// Re-exporting overwrites this file.`,
    source,
  ].join("\n");
}

/**
 * A runtime module inlined into a single-file export: its own `import`s
 * removed (the callers inline the dependencies first and add the node
 * built-ins it needs), exports kept so nothing trips `noUnusedLocals`.
 */
export function inlineRuntimeModule(
  name: RuntimeModuleName,
  lang: ExportLang,
): string {
  const source = RUNTIME_SOURCES[name][lang];
  return source
    .replace(/^import [^;]*?from "[^"]+";\n/gm, "")
    .replace(/^import "[^"]+";\n/gm, "")
    .trim();
}

/** The `node:` imports a module needs (single-file exports add them). */
export function runtimeModuleNodeImports(
  name: RuntimeModuleName,
  lang: ExportLang,
): Array<{ from: string; names: string[] }> {
  const out: Array<{ from: string; names: string[] }> = [];
  for (const m of RUNTIME_SOURCES[name][lang].matchAll(
    /^import \{([^}]*)\} from "(node:[^"]+)";$/gm,
  )) {
    out.push({
      from: m[2]!,
      names: m[1]!
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    });
  }
  return out;
}
