import { readdir, stat } from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { globSegmentRegExp, hasGlob } from "../config/compose";
import {
  isDraftPath,
  readProjectFile,
  SKIP_DIRS,
  walkYaml,
  type ParsedSpec,
} from "../catalog/project";
import { suiteRequiredEnvs, type Suite, type SuitesRegistry } from "./schema";

/**
 * Resolve a config `suites:` entry for one environment into the ordered
 * list of spec files to run plus the settings that travel with it. Reads
 * files only (specs are scanned as the catalog scans them: loosely, nothing
 * substituted or executed).
 *
 * A spec reference is, in this order: a glob (`*`, `?`, `**`), an existing
 * path (file or directory, relative to the config directory) or a spec
 * `name`. Directories and globs skip drafts (a `_` folder or file below
 * them); a file named explicitly is always taken.
 */

/** A problem resolving a suite; `exitCode` is the CLI exit code to use. */
export class SuiteError extends Error {
  constructor(
    message: string,
    /** 2 usage, 4 config (unknown suite, unresolvable reference), 7 refused (`requires`). */
    readonly exitCode: 2 | 4 | 7,
  ) {
    super(message);
    this.name = "SuiteError";
  }
}

export interface ResolvedSuite {
  name: string;
  description?: string;
  /** The environment the suite resolved for. */
  env: string;
  /** Absolute spec paths in run order, de-duplicated. */
  specs: string[];
  /** Drafts a directory or glob reference left out. */
  skippedDrafts: string[];
  parallel?: number;
  bail?: boolean;
  /** Suite vars for this environment, as `--var` values. */
  vars: Record<string, string>;
  before: string[];
  after: string[];
  hookTimeoutMs?: number;
  /** `seed.postCommands.skip`: the suite's, then the environment's. */
  seedSkip: string[];
  /** `processEnv` for this environment (the environment's over the suite's). */
  processEnv: Record<string, string>;
  /** `labels` for this environment (the environment's over the suite's). */
  labels: Record<string, string>;
}

/** A record of suite values (strings, numbers, booleans) as strings. */
function asStrings(
  ...records: Array<Readonly<Record<string, unknown>> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const record of records) {
    for (const [key, value] of Object.entries(record ?? {})) {
      out[key] = String(value);
    }
  }
  return out;
}

/** The suite's process env for one environment. */
export function suiteProcessEnvOf(
  suite: Suite,
  envName: string,
): Record<string, string> {
  return asStrings(suite.processEnv, suite.env?.[envName]?.processEnv);
}

/** The suite's labels for one environment. */
export function suiteLabelsOf(
  suite: Suite,
  envName: string,
): Record<string, string> {
  return asStrings(suite.labels, suite.env?.[envName]?.labels);
}

export interface SuiteResolverOptions {
  /** Directory of the config; references resolve against it. */
  configDir: string;
  /** Directories the spec scan must not enter (the artifact root). */
  skipDirs?: readonly string[];
}

export interface ResolveSuiteInput {
  name: string;
  suite: Suite;
  envName: string;
  /** The environment's effective vars (for `requires.vars`). */
  vars?: Readonly<Record<string, unknown>>;
  /**
   * false: leave `requires.vars` for {@link checkSuiteRequiredVars} (the run
   * engine checks it once the vault's secrets are in). Default true.
   */
  checkRequiredVars?: boolean;
}

/**
 * `requires.vars`: each named var must be set (non-empty) by the suite or
 * the environment. Throws a {@link SuiteError} (exit 7).
 */
export function checkSuiteRequiredVars(input: {
  name: string;
  suite: Suite;
  envName: string;
  suiteVars: Readonly<Record<string, string>>;
  vars?: Readonly<Record<string, unknown>>;
}): void {
  for (const key of input.suite.requires?.vars ?? []) {
    const value = input.suiteVars[key] ?? input.vars?.[key];
    if (value === undefined || value === null || value === "") {
      throw new SuiteError(
        `suite "${input.name}" requires var "${key}" to be set in environment "${input.envName}"`,
        7,
      );
    }
  }
}

/** The suites a config defines, for an "unknown suite" message. */
export function knownSuitesText(suites: SuitesRegistry | undefined): string {
  const names = Object.keys(suites ?? {}).toSorted();
  return names.length > 0 ? names.join(", ") : "none";
}

/** The suite named `name`, or a {@link SuiteError} (exit 4) listing the known ones. */
export function selectSuite(
  suites: SuitesRegistry | undefined,
  name: string,
  where: string,
): Suite {
  if (suites && Object.hasOwn(suites, name)) return suites[name]!;
  throw new SuiteError(
    `unknown suite "${name}" (${where} defines: ${knownSuitesText(suites)})`,
    4,
  );
}

const SPEC_FILE = /\.ya?ml$/i;

/** A run directory's resolved copy of a spec: never a spec of the project. */
function isRunCopy(file: string): boolean {
  return basename(file) === "spec.resolved.yml";
}

/** YAML files one suite glob may match before it is an error (never a silent cut). */
const SUITE_GLOB_MAX_FILES = 5_000;
/** Directory depth a suite glob's `**` may descend before it is an error. */
const SUITE_GLOB_MAX_DEPTH = 20;

/** A directory's entries, sorted by name (none when it cannot be read). */
async function entriesOf(dir: string) {
  try {
    return (await readdir(dir, { withFileTypes: true })).toSorted((a, b) =>
      a.name.localeCompare(b.name),
    );
  } catch {
    return [];
  }
}

/**
 * Expand a suite glob (`*` / `?` within a segment, `**` for any number of
 * directories) to the YAML files it matches, sorted. Unlike the config
 * `include:` expander it never stops silently: past
 * {@link SUITE_GLOB_MAX_FILES} matches or {@link SUITE_GLOB_MAX_DEPTH}
 * directories it throws. It does not enter `skip` (the artifact root),
 * hidden directories (unless the pattern names them) or dependency and
 * build folders, and drops run copies (`spec.resolved.yml`).
 */
async function expandSuiteGlob(
  absPattern: string,
  skip: ReadonlySet<string>,
  where: string,
): Promise<string[]> {
  const segments = absPattern.split(sep);
  const first = segments.findIndex((segment) => hasGlob(segment));
  const base = segments.slice(0, first).join(sep) || sep;
  const found = new Set<string>();
  const tooMany = (): SuiteError =>
    new SuiteError(
      `${where}: the glob matches more than ${SUITE_GLOB_MAX_FILES} YAML files; narrow it (or name a directory)`,
      4,
    );
  const enterable = (dir: string, name: string, segment?: string): boolean =>
    !skip.has(join(dir, name)) &&
    !SKIP_DIRS.has(name) &&
    (!name.startsWith(".") || segment?.startsWith(".") === true);
  const add = (file: string): void => {
    if (isRunCopy(file)) return;
    found.add(file);
    if (found.size > SUITE_GLOB_MAX_FILES) throw tooMany();
  };
  const walk = async (
    dir: string,
    rest: readonly string[],
    depth: number,
  ): Promise<void> => {
    if (depth > SUITE_GLOB_MAX_DEPTH) {
      throw new SuiteError(
        `${where}: the glob descends more than ${SUITE_GLOB_MAX_DEPTH} directories below ${base}; narrow it`,
        4,
      );
    }
    const [segment, ...tail] = rest;
    if (segment === undefined) return;
    if (segment === "**") {
      await walk(dir, tail, depth);
      for (const entry of await entriesOf(dir)) {
        if (entry.isDirectory() && enterable(dir, entry.name)) {
          await walk(join(dir, entry.name), rest, depth + 1);
        }
      }
      return;
    }
    if (!hasGlob(segment)) {
      const next = join(dir, segment);
      if (tail.length === 0) {
        if (
          SPEC_FILE.test(segment) &&
          (await stat(next).catch(() => undefined))?.isFile()
        ) {
          add(next);
        }
      } else if (!skip.has(next)) {
        await walk(next, tail, depth + 1);
      }
      return;
    }
    const re = globSegmentRegExp(segment);
    for (const entry of await entriesOf(dir)) {
      if (!re.test(entry.name)) continue;
      if (entry.name.startsWith(".") && !segment.startsWith(".")) continue;
      const next = join(dir, entry.name);
      if (tail.length === 0) {
        if (entry.isFile() && SPEC_FILE.test(entry.name)) add(next);
      } else if (entry.isDirectory() && enterable(dir, entry.name, segment)) {
        await walk(next, tail, depth + 1);
      }
    }
  };
  await walk(base, segments.slice(first), 0);
  return [...found].toSorted();
}

export class SuiteResolver {
  private readonly configDir: string;
  private readonly skip: Set<string>;
  private index: ParsedSpec[] | undefined;

  constructor(opts: SuiteResolverOptions) {
    this.configDir = resolve(opts.configDir);
    this.skip = new Set((opts.skipDirs ?? []).map((dir) => resolve(dir)));
  }

  /** Every non-draft spec under the config directory, sorted by path. */
  private async specIndex(): Promise<ParsedSpec[]> {
    if (this.index) return this.index;
    const walked = await walkYaml([this.configDir], this.skip);
    if (walked.truncated) {
      throw new SuiteError(
        `the spec scan of ${this.configDir} hit its file or directory cap; name the specs by path or glob`,
        4,
      );
    }
    const specs: ParsedSpec[] = [];
    for (const file of walked.files) {
      if (isRunCopy(file)) continue;
      const parsed = await readProjectFile(file, this.configDir);
      if (parsed?.kind === "spec") specs.push(parsed);
    }
    this.index = specs;
    return specs;
  }

  private rel(path: string): string {
    return relative(this.configDir, path).split(sep).join("/") || ".";
  }

  /** Spec files below a directory, drafts below it excluded. */
  private async specsUnder(
    dir: string,
  ): Promise<{ files: string[]; drafts: string[] }> {
    const walked = await walkYaml([dir], this.skip);
    if (walked.truncated) {
      throw new SuiteError(
        `directory "${this.rel(dir)}" holds more files or directories than one suite reference may scan; name a narrower directory or glob`,
        4,
      );
    }
    const files: string[] = [];
    const drafts: string[] = [];
    for (const file of walked.files) {
      if (isRunCopy(file)) continue;
      const parsed = await readProjectFile(file, this.configDir);
      if (parsed?.kind !== "spec") continue;
      if (isDraftPath(file, dir)) drafts.push(file);
      else files.push(file);
    }
    return { files, drafts };
  }

  /** One reference → spec files. */
  private async resolveRef(
    ref: string,
    where: string,
  ): Promise<{ files: string[]; drafts: string[] }> {
    const text = ref.trim();
    // `dir/**` means "everything below dir".
    const asDirectory = /^(.*?)\/\*\*\/?$/.exec(text);
    const pattern = asDirectory ? asDirectory[1]! : text;
    const absolute = isAbsolute(pattern)
      ? pattern
      : resolve(this.configDir, pattern);

    if (hasGlob(pattern)) {
      const matched = await expandSuiteGlob(
        absolute,
        this.skip,
        `${where}: "${ref}"`,
      );
      const files: string[] = [];
      const drafts: string[] = [];
      for (const file of matched) {
        if (isRunCopy(file)) continue;
        const parsed = await readProjectFile(file, this.configDir);
        if (parsed?.kind !== "spec") continue;
        if (isDraftPath(file, this.configDir)) drafts.push(file);
        else files.push(file);
      }
      if (files.length === 0) {
        throw new SuiteError(
          `${where}: "${ref}" matches no spec file${
            drafts.length > 0 ? ` (${drafts.length} draft(s) skipped)` : ""
          }`,
          4,
        );
      }
      return { files, drafts };
    }

    const info = await stat(absolute).catch(() => undefined);
    if (info?.isDirectory()) {
      const found = await this.specsUnder(absolute);
      if (found.files.length === 0) {
        throw new SuiteError(
          `${where}: directory "${ref}" holds no spec file${
            found.drafts.length > 0
              ? ` (${found.drafts.length} draft(s) skipped)`
              : ""
          }`,
          4,
        );
      }
      return found;
    }
    if (info?.isFile()) return { files: [absolute], drafts: [] };

    // A spec name: no path separators, no extension.
    if (!/[\\/]/.test(text) && !SPEC_FILE.test(text)) {
      const named = (await this.specIndex()).filter(
        (spec) => spec.name === text,
      );
      const live = named.filter(
        (spec) => !isDraftPath(spec.path, this.configDir),
      );
      if (live.length === 1) return { files: [live[0]!.path], drafts: [] };
      if (live.length > 1) {
        throw new SuiteError(
          `${where}: spec name "${ref}" is ambiguous (${live
            .map((spec) => this.rel(spec.path))
            .join(", ")}); name one by path`,
          4,
        );
      }
      if (named.length > 0) {
        throw new SuiteError(
          `${where}: "${ref}" is a draft (${this.rel(named[0]!.path)}); name it by path to run it`,
          4,
        );
      }
    }
    throw new SuiteError(
      `${where}: "${ref}" is not a spec file, directory, glob or spec name (paths resolve against ${this.configDir})`,
      4,
    );
  }

  private async resolveRefs(
    refs: readonly string[],
    where: string,
  ): Promise<{ files: string[]; drafts: string[] }> {
    const files: string[] = [];
    const drafts: string[] = [];
    for (const ref of refs) {
      const found = await this.resolveRef(ref, where);
      files.push(...found.files);
      drafts.push(...found.drafts);
    }
    return { files: unique(files), drafts: unique(drafts) };
  }

  private async tagsOf(file: string): Promise<string[] | undefined> {
    const parsed = await readProjectFile(file, this.configDir);
    return parsed?.kind === "spec" ? parsed.tags : undefined;
  }

  async resolve(input: ResolveSuiteInput): Promise<ResolvedSuite> {
    const { name, suite, envName } = input;
    const label = `suite "${name}"`;
    const envBlock = suite.env?.[envName];
    const vars: Record<string, string> = {};
    for (const [key, value] of Object.entries({
      ...suite.vars,
      ...envBlock?.vars,
    })) {
      vars[key] = String(value);
    }
    const required = suiteRequiredEnvs(suite);
    if (required.length > 0 && !required.includes(envName)) {
      throw new SuiteError(
        `${label} requires environment ${required.join(" | ")} (running in "${envName}"): pass --env ${required[0]}`,
        7,
      );
    }
    if (input.checkRequiredVars !== false) {
      checkSuiteRequiredVars({
        name,
        suite,
        envName,
        suiteVars: vars,
        ...(input.vars ? { vars: input.vars } : {}),
      });
    }
    const specRefs = envBlock?.specs ?? suite.specs;
    const where = `${label}${envBlock?.specs ? ` (env ${envName})` : ""}`;
    const drafts: string[] = [];

    let selected: string[];
    if (specRefs) {
      const found = await this.resolveRefs(specRefs, `${where} specs`);
      selected = found.files;
      drafts.push(...found.drafts);
    } else if (suite.tags) {
      selected = (await this.specIndex())
        .map((spec) => spec.path)
        .filter((path) => !isDraftPath(path, this.configDir));
    } else if (suite.order) {
      const found = await this.resolveRefs(suite.order, `${label} order`);
      selected = found.files;
      drafts.push(...found.drafts);
    } else {
      selected = [];
    }

    if (suite.tags) {
      const wanted = suite.tags.map((tag) => tag.toLowerCase());
      const kept: string[] = [];
      for (const file of selected) {
        const tags = (await this.tagsOf(file))?.map((tag) => tag.toLowerCase());
        if (tags && wanted.every((tag) => tags.includes(tag))) kept.push(file);
      }
      selected = kept;
    }

    let ordered = selected;
    if (suite.order && (specRefs || suite.tags)) {
      const first: string[] = [];
      for (const ref of suite.order) {
        const found = await this.resolveRef(ref, `${label} order`);
        for (const file of found.files) {
          if (!selected.includes(file)) {
            throw new SuiteError(
              `${label} order: "${ref}" (${this.rel(file)}) is not in the suite's selection (specs${
                suite.tags ? " + tags" : ""
              }); add it to specs or drop it from order`,
              4,
            );
          }
          first.push(file);
        }
      }
      const head = unique(first);
      ordered = [...head, ...selected.filter((file) => !head.includes(file))];
    }

    if (ordered.length === 0) {
      throw new SuiteError(
        `${where} selects no specs${
          suite.tags ? ` (tags: ${suite.tags.join(", ")})` : ""
        } in environment "${envName}"`,
        4,
      );
    }

    const hookTimeoutMs = envBlock?.hookTimeoutMs ?? suite.hookTimeoutMs;
    const bail = envBlock?.bail ?? suite.bail;
    return {
      name,
      ...(suite.description ? { description: suite.description } : {}),
      env: envName,
      specs: ordered,
      skippedDrafts: unique(drafts),
      ...(suite.parallel !== undefined ? { parallel: suite.parallel } : {}),
      ...(bail !== undefined ? { bail } : {}),
      vars,
      before: [...(suite.before ?? []), ...(envBlock?.before ?? [])],
      after: [...(suite.after ?? []), ...(envBlock?.after ?? [])],
      ...(hookTimeoutMs !== undefined ? { hookTimeoutMs } : {}),
      seedSkip: unique([
        ...(suite.seed?.postCommands?.skip ?? []),
        ...(envBlock?.seed?.postCommands?.skip ?? []),
      ]),
      processEnv: suiteProcessEnvOf(suite, envName),
      labels: suiteLabelsOf(suite, envName),
    };
  }
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}
