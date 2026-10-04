import { canonicalEnvironment, realEnvironmentNames } from "../config/envAlias";
import { access } from "node:fs/promises";
import { homedir } from "node:os";
import {
  basename,
  dirname,
  extname,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import {
  isAlias,
  isMap,
  isScalar,
  parseDocument,
  type Document,
  type YAMLMap,
} from "yaml";
import { ZodError, type z } from "zod";
import { CheckpointStore } from "../checkpoint/CheckpointStore";
import { urlOrigin } from "../checkpoint/meta";
import { loadConfig, type LoadedConfig } from "../config/loader";
import type { VarDefinition } from "../config/compose";
import {
  resolveEffectiveServices,
  UnknownEnvironmentError,
} from "../config/runtimeContext";
import type { Config } from "../schema/config.v1";
import { fixtureDurationMs } from "../fixtures/schema";
import {
  SuiteError,
  suiteLabelsOf,
  suiteProcessEnvOf,
  SuiteResolver,
} from "../suites/resolve";
import { suiteRequiredEnvs } from "../suites/schema";
import { actionInputProblems } from "../schema/spec.v1";
import {
  CATALOG_KINDS,
  CATALOG_SERVICE_PHASES,
  CatalogActionSchema,
  CatalogCheckpointSchema,
  CatalogEnvSchema,
  CatalogFixtureSchema,
  CatalogFlowSchema,
  CatalogSuiteSchema,
  CatalogVarSchema,
  CatalogVerifierSchema,
  type CatalogAction,
  type CatalogCheckpoint,
  type CatalogEnv,
  type CatalogFixture,
  type CatalogFlow,
  type CatalogKind,
  type CatalogResult,
  type CatalogSuite,
  type CatalogVar,
  type CatalogVerifier,
} from "./catalog.v1";
import { FileCache } from "./fileCache";
import { createMasker, type Masker } from "./mask";
import {
  isDraftPath,
  readProjectFile,
  walkYaml,
  type ParsedAction,
  type ParsedSpec,
} from "./project";
import { queryTokens, rank, type RankField } from "./query";
import { indexRuns, newer, runsFor, type RunIndex, type RunRef } from "./runs";
import {
  analyzeVerifierSource,
  type VerifierAnalysis,
} from "./verifierContract";
import { mapEntries, nodeValue } from "./yamlComments";

export interface CatalogOptions {
  /** Where config discovery starts (default: process.cwd()). */
  cwd?: string;
  /** Explicit cairntrace.config.yml. */
  config?: string;
  /** Environment for vars, last runs and checkpoint origin checks. */
  env?: string;
  /** Without `env`, use the config `defaultEnvironment` (when it is defined). */
  defaultEnv?: boolean;
  /** Keyword query: rank rows and keep the ones that match. */
  query?: string;
  /** Kinds to return (default: all). */
  kinds?: readonly CatalogKind[];
  /** Rows per kind (default 10 with a query, otherwise `unqueriedLimit`). */
  limit?: number;
  /** Rows per kind without `limit` or `query` (default: unlimited). */
  unqueriedLimit?: number;
  /** Override the artifact root scanned for last runs. */
  artifactRoot?: string;
  /** run.json files to read at most (default 500). */
  maxRuns?: number;
  checkpointStore?: CheckpointStore;
  now?: Date;
}

/** The config is missing, invalid, or does not define the requested env (exit 4). */
export class CatalogConfigError extends Error {
  readonly exitCode = 4 as const;
  constructor(message: string) {
    super(message);
    this.name = "CatalogConfigError";
  }
}

const DEFAULT_QUERY_LIMIT = 10;
const MAX_WARNINGS = 25;

const configDocCache = new FileCache<Document>(16);
const verifierCache = new FileCache<VerifierAnalysis>(2_000);

interface Ranked<T> {
  row: T;
  fields: RankField[];
  order: string;
}

/**
 * Build the project catalog: reusable actions, config vars per environment,
 * script verifiers and their fixture contracts, environments and their
 * policy, flows with their last run, and checkpoints. Reads files only —
 * no spec, script, hook or service is executed.
 */
export async function buildCatalog(
  opts: CatalogOptions = {},
): Promise<CatalogResult> {
  const cwd = opts.cwd ?? process.cwd();
  const now = opts.now ?? new Date();
  const kinds = new Set<CatalogKind>(
    opts.kinds?.length ? opts.kinds : CATALOG_KINDS,
  );
  const warnings: string[] = [];
  const warn = (message: string): void => {
    if (warnings.length < MAX_WARNINGS) warnings.push(message);
    else if (warnings.length === MAX_WARNINGS)
      warnings.push("… more warnings omitted");
  };
  const masker = createMasker();

  const loaded = await loadCatalogConfig(cwd, opts.config);
  const config = loaded?.config;
  const root = loaded ? dirname(loaded.path) : resolve(cwd);
  const rel = (path: string): string =>
    relative(root, path).split(sep).join("/") || ".";

  const defaultEnv = config?.defaultEnvironment;
  // `--env <alias>` (environments.<name>: { alias }) stands for its target.
  const canonicalName = (name: string | undefined): string | undefined =>
    name !== undefined && config
      ? canonicalEnvironment(config.environments, name).name
      : name;
  const env = canonicalName(
    opts.env ??
      (opts.defaultEnv &&
      defaultEnv !== undefined &&
      config &&
      Object.hasOwn(config.environments, defaultEnv)
        ? defaultEnv
        : undefined),
  );
  if (opts.env !== undefined && !config) {
    throw new CatalogConfigError(
      `--env "${opts.env}" needs a cairntrace.config.yml that defines it; none was found from ${resolve(cwd)}`,
    );
  }
  if (opts.env !== undefined && loaded && config) {
    const known = Object.keys(config.environments);
    if (!Object.hasOwn(config.environments, opts.env)) {
      throw new CatalogConfigError(
        new UnknownEnvironmentError(
          opts.env,
          "override",
          known.toSorted(),
          loaded.path,
        ).message,
      );
    }
  }
  const envNames = config
    ? realEnvironmentNames(config.environments).filter(
        (name) => env === undefined || name === env,
      )
    : [];

  const artifactRoot = resolve(
    cwd,
    opts.artifactRoot ??
      config?.artifactRoot ??
      join(homedir(), ".cairntrace", "runs"),
  );

  // ---- project files -------------------------------------------------------
  const scanRoots = config?.workflowRoots?.length
    ? [
        ...config.workflowRoots.map((r) => resolve(root, r)),
        ...((await exists(join(root, "actions")))
          ? [join(root, "actions")]
          : []),
      ]
    : [root];
  const walked = await walkYaml(scanRoots, new Set([artifactRoot]));
  if (walked.truncated)
    warn("file scan stopped at its bound; some files were not read");

  const specs: ParsedSpec[] = [];
  const actionsByPath = new Map<string, ParsedAction>();
  const consider = async (path: string): Promise<void> => {
    const parsed = await readProjectFile(path, root);
    if (!parsed) return;
    if (parsed.kind === "spec") specs.push(parsed);
    else if (parsed.kind === "action") actionsByPath.set(parsed.path, parsed);
    else if (parsed.kind === "error") warn(`${rel(path)}: ${parsed.message}`);
  };
  for (const file of walked.files) await consider(file);
  // Actions imported from outside the scan roots.
  const imported = new Set(
    [...specs, ...actionsByPath.values()].flatMap((f) => f.imports),
  );
  for (const path of imported) {
    if (actionsByPath.has(path)) continue;
    const parsed = await readProjectFile(path, root);
    if (parsed?.kind === "action") actionsByPath.set(path, parsed);
    else if (!parsed) warn(`imported action not found: ${rel(path)}`);
  }
  const actions = [...actionsByPath.values()];
  const actionNames = new Map<string, ParsedAction[]>();
  for (const action of actions) {
    const list = actionNames.get(action.name) ?? [];
    list.push(action);
    actionNames.set(action.name, list);
  }
  for (const [name, list] of actionNames) {
    if (list.length > 1) {
      warn(
        `action name "${name}" is defined by ${list.map((a) => rel(a.path)).join(", ")}`,
      );
    }
  }

  // ---- relations -------------------------------------------------------------
  type User = ParsedSpec | ParsedAction;
  const users: User[] = [...specs, ...actions];
  const actionUsers = new Map<string, Set<User>>();
  for (const user of users) {
    const targets = new Set<string>(
      user.imports.filter((p) => actionsByPath.has(p)),
    );
    for (const use of user.uses) {
      const local = user.imports
        .map((p) => actionsByPath.get(p))
        .find((a) => a?.name === use.action);
      const target = local ?? actionNames.get(use.action)?.[0];
      if (target) targets.add(target.path);
    }
    for (const target of targets) {
      if (target === user.path) continue;
      const set = actionUsers.get(target) ?? new Set<User>();
      set.add(user);
      actionUsers.set(target, set);
    }
  }
  const useRow = (user: User) => ({
    kind: user.kind,
    name: user.name,
    file: rel(user.path),
  });
  // F7: `${vars.name.key}` reads inside a typed var — it uses `name`.
  const varUsers = (name: string): User[] =>
    users.filter(
      (u) =>
        u.varRefs.has(name) ||
        [...u.varRefs].some((ref) => ref.startsWith(`${name}.`)),
    );

  // ---- runs ------------------------------------------------------------------
  let runIndex: RunIndex = { byName: new Map(), read: 0 };
  if (kinds.has("actions") || kinds.has("flows")) {
    runIndex = await indexRuns(artifactRoot, {
      ...(opts.maxRuns !== undefined ? { maxRuns: opts.maxRuns } : {}),
      specs: specs.map((s) => ({ name: s.name, path: s.path })),
      ...(env !== undefined ? { env } : {}),
    });
  }
  const configVarEnvs = (name: string): string[] =>
    envNames.filter((envName) =>
      Object.hasOwn(config?.environments[envName]?.vars ?? {}, name),
    );

  // ---- rows --------------------------------------------------------------------
  const tokens = opts.query ? queryTokens(opts.query) : [];
  if (opts.query !== undefined && tokens.length === 0) {
    warn(`query "${opts.query}" has no searchable words; nothing was ranked`);
  }
  const result: CatalogResult = {
    $schema: "urn:cairntrace.dev:catalog:v1",
    version: "1",
    ...(config?.project ? { project: config.project } : {}),
    root,
    ...(loaded ? { configPath: loaded.path } : {}),
    ...(env !== undefined ? { env } : {}),
    ...(opts.query !== undefined ? { query: opts.query } : {}),
    kinds: CATALOG_KINDS.filter((k) => kinds.has(k)),
    totals: {},
    scan: {
      files: walked.files.length,
      specs: specs.length,
      actions: actions.length,
      runs: runIndex.read,
      artifactRoot,
      ...(walked.truncated ? { truncated: true as const } : {}),
    },
    warnings,
  };
  const limit =
    opts.limit ??
    (tokens.length > 0 ? DEFAULT_QUERY_LIMIT : opts.unqueriedLimit);
  if (limit !== undefined) result.limit = limit;

  const finish = <T extends { score?: number; matched?: unknown }>(
    kind: CatalogKind,
    all: Ranked<T>[],
  ): T[] => {
    // Files are read loosely: a row the wire schema rejects (an empty name,
    // id or status somewhere) is left out with a warning instead of failing
    // the whole catalog.
    const rows = all.filter((r) => {
      const check = ROW_SCHEMAS[kind].safeParse(r.row);
      if (!check.success) {
        const issue = check.error.issues[0];
        warn(
          `${kind}: left out ${rowLabel(r.row)} (${
            issue
              ? `${issue.path.join(".") || "(row)"}: ${issue.message}`
              : "invalid"
          })`,
        );
      }
      return check.success;
    });
    let out: Ranked<T>[];
    if (tokens.length > 0) {
      out = rows
        .map((r) => {
          const { score, matched } = rank(tokens, r.fields);
          return { ...r, row: { ...r.row, score, matched } as T, score };
        })
        .filter((r) => r.score > 0)
        .toSorted(
          (a, b) => b.score - a.score || a.order.localeCompare(b.order),
        );
    } else {
      out = rows.toSorted((a, b) => a.order.localeCompare(b.order));
    }
    result.totals[kind] = out.length;
    return (limit !== undefined ? out.slice(0, limit) : out).map((r) => r.row);
  };

  if (kinds.has("actions")) {
    result.actions = finish(
      "actions",
      actions.map((action) => actionRow(action)),
    );
  }

  function actionRow(action: ParsedAction): Ranked<CatalogAction> {
    const names = [
      ...Object.keys(action.inputs),
      ...Object.keys(action.vars),
      ...action.varRefs,
    ];
    const inputs = [...new Set(names)].map((name) => {
      const declared = action.inputs[name];
      const raw = action.vars[name] ?? declared?.default;
      const configEnvs = configVarEnvs(name);
      const required =
        declared?.required === true ||
        (raw === undefined && configEnvs.length === 0);
      return {
        name,
        ...(declared?.description ? { description: declared.description } : {}),
        required,
        ...(raw !== undefined
          ? { default: masker.value(name, raw).value }
          : {}),
        declared: declared !== undefined,
        referenced: action.varRefs.has(name),
        ...(configEnvs.length > 0 ? { configEnvs } : {}),
      };
    });
    const usedBy = [...(actionUsers.get(action.path) ?? [])];
    // Runs matched by the spec's own path win over runs matched by name.
    let lastGreen: { run: RunRef; byName: boolean } | undefined;
    for (const spec of specsReaching(action.path)) {
      const runs = runsFor(runIndex, spec.name, spec.path);
      const passed = runs.latestPassed;
      if (!passed) continue;
      const byName = runs.byName === true;
      if (
        !lastGreen ||
        (lastGreen.byName && !byName) ||
        (lastGreen.byName === byName && newer(passed, lastGreen.run))
      ) {
        lastGreen = { run: passed, byName };
      }
    }
    const problems = actionInputProblems(action).map((p) => p.message);
    const description = action.description ?? action.leading;
    return {
      row: {
        name: action.name,
        file: rel(action.path),
        ...(description
          ? {
              description: masker.text(description),
              descriptionSource: action.description
                ? ("field" as const)
                : ("comment" as const),
            }
          : {}),
        inputs,
        steps: action.steps,
        usedBy: usedBy
          .map(useRow)
          .toSorted((a, b) => a.file.localeCompare(b.file)),
        ...(lastGreen
          ? { lastGreenRun: runRow(lastGreen.run, lastGreen.byName) }
          : {}),
        ...(problems.length > 0 ? { problems } : {}),
      },
      fields: [
        {
          field: "name",
          text: `${action.name} ${basename(action.path, extname(action.path))}`,
        },
        { field: "description", text: description },
        {
          field: "inputs",
          // Names, descriptions and visible defaults (a selector default
          // often names the field the action edits).
          text: inputs
            .map((i) =>
              [
                i.name,
                i.description ?? "",
                typeof i.default === "string" && i.default !== "[redacted]"
                  ? i.default
                  : "",
              ].join(" "),
            )
            .join(" "),
        },
        { field: "comment", text: action.comments },
      ],
      order: action.name,
    };
  }

  function specsReaching(actionPath: string): ParsedSpec[] {
    const out = new Set<ParsedSpec>();
    const seen = new Set<string>();
    const queue = [actionPath];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (seen.has(current)) continue;
      seen.add(current);
      for (const user of actionUsers.get(current) ?? []) {
        if (user.kind === "spec") out.add(user);
        else queue.push(user.path);
      }
    }
    return [...out];
  }

  if (kinds.has("vars") && loaded) {
    const doc = await configDocCache.get(loaded.path, (text) =>
      parseDocument(text, { merge: true }),
    );
    const rows: Ranked<CatalogVar>[] = [];
    const environments =
      doc && isMap(doc.contents)
        ? doc.contents.get("environments", true)
        : undefined;
    if (doc && isMap(environments)) {
      const anchors = new Map<string, string>();
      for (const pair of environments.items) {
        const envName = isScalar(pair.key) ? String(pair.key.value) : undefined;
        const varsNode = isMap(pair.value)
          ? pair.value.get("vars", true)
          : undefined;
        if (envName && isMap(varsNode) && varsNode.anchor)
          anchors.set(varsNode.anchor, envName);
      }
      let envIndex = 0;
      for (const pair of environments.items) {
        const envName = isScalar(pair.key) ? String(pair.key.value) : undefined;
        if (!envName || !envNames.includes(envName)) continue;
        envIndex += 1;
        const varsNode = isMap(pair.value)
          ? pair.value.get("vars", true)
          : undefined;
        // F7: vars the environment gets from the top-level `vars:` (and
        // included files) or its `extends` chain, after its own entries.
        const own = new Set<string>();
        const composedRows = (): void => {
          const composed =
            loaded.composition?.environments[envName]?.vars ?? {};
          let index = own.size;
          for (const [name, entry] of Object.entries(composed)) {
            if (own.has(name)) continue;
            const def = entry.definitions.at(-1);
            if (!def) continue;
            index += 1;
            rows.push(
              composedVarRow(name, envName, def, {
                envIndex,
                index,
                masker,
                rel,
                usedBy: varUsers(name)
                  .map(useRow)
                  .toSorted((a, b) => a.file.localeCompare(b.file)),
              }),
            );
          }
        };
        const varsMap = isAlias(varsNode) ? varsNode.resolve(doc) : varsNode;
        if (!isMap(varsMap)) {
          composedRows();
          continue;
        }
        const aliasOwner = isAlias(varsNode)
          ? (anchors.get(varsNode.source) ?? `&${varsNode.source}`)
          : undefined;
        mapEntries(varsMap as YAMLMap, doc, (anchor) => anchors.get(anchor))
          .map((entry) =>
            aliasOwner && !entry.inheritedFrom
              ? { ...entry, inheritedFrom: aliasOwner }
              : entry,
          )
          .forEach((entry, index) => {
            own.add(entry.key);
            const value = nodeValue(entry.value, doc);
            const masked =
              typeof value === "string" ||
              typeof value === "number" ||
              typeof value === "boolean"
                ? masker.value(entry.key, value)
                : undefined;
            const usedBy = varUsers(entry.key);
            rows.push({
              row: {
                name: entry.key,
                env: envName,
                ...(masked ? { value: masked.value } : {}),
                ...(masked?.masked ? { masked: true as const } : {}),
                ...(entry.comment
                  ? { comment: masker.text(entry.comment) }
                  : {}),
                definedIn: entry.inheritedFrom ? "inherited" : "environment",
                ...(entry.inheritedFrom
                  ? { inheritedFrom: entry.inheritedFrom }
                  : {}),
                usedBy: usedBy
                  .map(useRow)
                  .toSorted((a, b) => a.file.localeCompare(b.file)),
              },
              fields: [
                { field: "name", text: entry.key },
                { field: "comment", text: entry.comment },
                {
                  field: "text",
                  text:
                    masked && !masked.masked ? String(masked.value) : undefined,
                },
              ],
              order: `${String(envIndex).padStart(4, "0")}:${String(index).padStart(6, "0")}`,
            });
          });
        composedRows();
      }
    }
    result.vars = finish("vars", rows);
  } else if (kinds.has("vars")) {
    result.vars = finish("vars", []);
  }

  if (kinds.has("verifiers")) {
    const byFile = new Map<
      string,
      {
        authored: string;
        path?: string;
        uses: Array<{
          spec: ParsedSpec;
          script: ParsedSpec["scripts"][number];
        }>;
      }
    >();
    for (const spec of specs) {
      for (const script of spec.scripts) {
        const key = script.path ?? `${rel(spec.path)}#${script.file}`;
        const entry = byFile.get(key) ?? {
          authored: script.file,
          ...(script.path ? { path: script.path } : {}),
          uses: [],
        };
        entry.uses.push({ spec, script });
        byFile.set(key, entry);
      }
    }
    const rows: Ranked<CatalogVerifier>[] = [];
    for (const entry of byFile.values()) {
      const analysis = entry.path
        ? await verifierCache.get(entry.path, analyzeVerifierSource)
        : undefined;
      const known = new Map((analysis?.keys ?? []).map((k) => [k.name, k]));
      const checkUnknown =
        analysis !== undefined &&
        analysis.source !== "none" &&
        !analysis.dynamic;
      const file = entry.path ? rel(entry.path) : entry.authored;
      const description = analysis?.description
        ? masker.text(analysis.description)
        : undefined;
      rows.push({
        row: {
          file,
          exists: analysis !== undefined,
          ...(description ? { description } : {}),
          fixtures: {
            source: analysis?.source ?? "none",
            ...(analysis?.dynamic ? { dynamic: true } : {}),
            ...(analysis?.strict !== undefined
              ? { strict: analysis.strict }
              : {}),
            keys: analysis?.keys ?? [],
          },
          usedBy: entry.uses
            .map(({ spec, script }) => {
              const unknownKeys = checkUnknown
                ? script.fixtureKeys.filter((k) => !known.has(k))
                : [];
              const missingKeys = [...known.values()]
                .filter(
                  (k) =>
                    k.required === true && !script.fixtureKeys.includes(k.name),
                )
                .map((k) => k.name);
              return {
                spec: spec.name,
                file: rel(spec.path),
                outcome: script.outcome,
                runtime: script.runtime,
                fixtureKeys: script.fixtureKeys,
                ...(unknownKeys.length > 0 ? { unknownKeys } : {}),
                ...(missingKeys.length > 0 ? { missingKeys } : {}),
              };
            })
            .toSorted(
              (a, b) =>
                a.file.localeCompare(b.file) ||
                a.outcome.localeCompare(b.outcome),
            ),
        },
        fields: [
          { field: "name", text: basename(file, extname(file)) },
          { field: "description", text: description },
          {
            field: "inputs",
            text: (analysis?.keys ?? [])
              .map((k) => `${k.name} ${k.description ?? ""}`)
              .join(" "),
          },
          {
            field: "text",
            text: entry.uses
              .map((u) => `${u.spec.name} ${u.script.outcome}`)
              .join(" "),
          },
        ],
        order: file,
      });
    }
    result.verifiers = finish("verifiers", rows);
  }

  if (kinds.has("envs")) {
    result.envs = finish(
      "envs",
      config
        ? envNames.map((name, index) => envRow(name, config, masker, index))
        : [],
    );
  }

  if (kinds.has("flows")) {
    result.flows = finish(
      "flows",
      specs.map((spec): Ranked<CatalogFlow> => {
        const runs = runsFor(runIndex, spec.name, spec.path);
        const latest = runs.latest;
        const used = [...new Set(spec.uses.map((u) => u.action))];
        return {
          row: {
            name: spec.name,
            file: rel(spec.path),
            intent: masker.text(spec.intent),
            ...(spec.tags.length > 0 ? { tags: spec.tags } : {}),
            ...(spec.requires !== undefined ? { requires: spec.requires } : {}),
            ...(spec.environment ? { environment: spec.environment } : {}),
            ...(isDraftPath(spec.path, root) ? { draft: true as const } : {}),
            ...(used.length > 0 ? { actions: used } : {}),
            ...(spec.resume ? { checkpoint: spec.resume } : {}),
            ...(latest
              ? { lastRun: runRow(latest, runs.byName === true) }
              : {}),
          },
          fields: [
            {
              field: "name",
              text: `${spec.name} ${basename(spec.path, extname(spec.path))}`,
            },
            { field: "intent", text: spec.intent },
            { field: "tags", text: spec.tags.join(" ") },
            { field: "comment", text: `${spec.comments}\n${spec.outcomeText}` },
            { field: "text", text: used.join(" ") },
          ],
          order: rel(spec.path),
        };
      }),
    );
  }

  if (kinds.has("checkpoints")) {
    const store = opts.checkpointStore ?? new CheckpointStore();
    const baseUrl =
      env !== undefined ? config?.environments[env]?.baseUrl : undefined;
    const names = new Map<string, ParsedSpec[]>();
    // The store is shared by every project: list a saved checkpoint only
    // when a spec here resumes it or it was captured for an origin one of
    // this project's environments uses; count the rest.
    const origins = new Set(
      Object.values(config?.environments ?? {})
        .map((e) => urlOrigin(e.baseUrl))
        .filter((o): o is string => o !== undefined),
    );
    const resumed = new Set(specs.map((s) => s.resume).filter(Boolean));
    let others = 0;
    for (const info of await store.list(now)) {
      const origin = urlOrigin(info.meta?.baseUrl);
      if (resumed.has(info.name) || (origin && origins.has(origin))) {
        names.set(info.name, []);
      } else {
        others += 1;
      }
    }
    if (others > 0) result.scan.otherCheckpoints = others;
    for (const spec of specs) {
      if (!spec.resume) continue;
      const list = names.get(spec.resume) ?? [];
      list.push(spec);
      names.set(spec.resume, list);
    }
    const rows: Ranked<CatalogCheckpoint>[] = [];
    for (const [name, usedBy] of names) {
      const check = await store.checkResume(name, {
        now,
        cwd: root,
        ...(baseUrl ? { baseUrl } : {}),
      });
      const meta = check.meta;
      const scope = meta
        ? {
            ...(meta.env ? { env: meta.env } : {}),
            ...(meta.baseUrl ? { baseUrl: masker.text(meta.baseUrl) } : {}),
            createdAt: meta.createdAt,
            ...(meta.ttl ? { ttl: meta.ttl } : {}),
            ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
          }
        : undefined;
      rows.push({
        row: {
          name,
          health: check.health,
          ...(scope ? { scope } : {}),
          ...(check.staleMeta ? { staleMeta: true as const } : {}),
          ...(check.problem
            ? {
                problem: {
                  code: check.problem.code,
                  message: masker.text(check.problem.message),
                },
              }
            : {}),
          usedBy: usedBy
            .map(useRow)
            .toSorted((a, b) => a.file.localeCompare(b.file)),
        },
        fields: [
          { field: "name", text: name },
          {
            field: "text",
            text: [meta?.env, meta?.baseUrl, ...usedBy.map((s) => s.name)]
              .filter(Boolean)
              .join(" "),
          },
        ],
        order: name,
      });
    }
    result.checkpoints = finish("checkpoints", rows);
  }

  if (kinds.has("fixtures")) {
    result.fixtures = finish(
      "fixtures",
      Object.entries(config?.fixtures ?? {}).map(
        ([name, def]): Ranked<CatalogFixture> => {
          const usedBy = specs.filter((spec) => spec.fixtures.includes(name));
          const verbs = (
            ["ensure", "reset", "verify", "teardown"] as const
          ).filter((verb) => def[verb] !== undefined);
          const params = Object.keys(def.with ?? {});
          return {
            row: {
              name,
              kind: def.kind,
              scope: def.scope ?? "run",
              ...(def.description
                ? { description: masker.text(def.description) }
                : {}),
              ...(def.kind !== "exec" && def.datasource
                ? { datasource: def.datasource }
                : {}),
              verbs,
              needs: def.needs ?? [],
              outputs: Object.keys(def.outputs ?? {}),
              ...(params.length > 0 ? { params } : {}),
              ...(def.ttl !== undefined
                ? { ttlMs: fixtureDurationMs(def.ttl) }
                : {}),
              usedBy: usedBy.map(useRow),
            },
            fields: [
              { field: "name", text: name },
              { field: "description", text: def.description ?? "" },
              {
                field: "inputs",
                text: [...params, ...Object.keys(def.outputs ?? {})].join(" "),
              },
              {
                field: "text",
                text: [
                  def.kind,
                  ...(def.needs ?? []),
                  ...usedBy.map((s) => s.name),
                ].join(" "),
              },
            ],
            order: name,
          };
        },
      ),
    );
  }

  if (kinds.has("suites")) {
    const resolver = new SuiteResolver({
      configDir: root,
      skipDirs: [artifactRoot],
    });
    const rows: Ranked<CatalogSuite>[] = [];
    // A config without environments still has one to resolve against.
    const suiteEnvs =
      envNames.length > 0
        ? envNames
        : [env ?? config?.defaultEnvironment ?? "local"];
    for (const [name, suite] of Object.entries(config?.suites ?? {})) {
      const envs: CatalogSuite["envs"] = [];
      for (const envName of suiteEnvs) {
        const block = suite.env?.[envName];
        const varNames = Object.keys({ ...suite.vars, ...block?.vars });
        const processEnv = Object.keys(suiteProcessEnvOf(suite, envName));
        const labels = Object.entries(suiteLabelsOf(suite, envName)).map(
          ([key, value]) => `${key}=${masker.text(value)}`,
        );
        const envSkip = block?.seed?.postCommands?.skip;
        const common = {
          env: envName,
          ...(varNames.length > 0 ? { vars: varNames } : {}),
          ...(block?.bail !== undefined ? { bail: block.bail } : {}),
          ...(envSkip
            ? {
                seedSkip: [
                  ...new Set([
                    ...(suite.seed?.postCommands?.skip ?? []),
                    ...envSkip,
                  ]),
                ],
              }
            : {}),
          ...(processEnv.length > 0 ? { processEnv } : {}),
          ...(labels.length > 0 ? { labels } : {}),
        };
        const hookTimeoutMs = block?.hookTimeoutMs ?? suite.hookTimeoutMs;
        try {
          const resolved = await resolver.resolve({
            name,
            suite,
            envName,
            vars: config?.environments[envName]?.vars ?? {},
          });
          envs.push({
            ...common,
            specs: resolved.specs.map(rel),
            before: resolved.before.length,
            after: resolved.after.length,
            ...(hookTimeoutMs !== undefined ? { hookTimeoutMs } : {}),
          });
        } catch (e) {
          if (!(e instanceof SuiteError)) throw e;
          envs.push({
            ...common,
            specs: [],
            problem: masker.text(e.message),
            before: (suite.before?.length ?? 0) + (block?.before?.length ?? 0),
            after: (suite.after?.length ?? 0) + (block?.after?.length ?? 0),
            ...(hookTimeoutMs !== undefined ? { hookTimeoutMs } : {}),
          });
        }
      }
      const requiredEnvs = suiteRequiredEnvs(suite);
      rows.push({
        row: {
          name,
          ...(suite.description
            ? { description: masker.text(suite.description) }
            : {}),
          ...(suite.specs ? { specs: suite.specs } : {}),
          ...(suite.tags ? { tags: suite.tags } : {}),
          ...(suite.order ? { order: suite.order } : {}),
          ...(suite.parallel !== undefined ? { parallel: suite.parallel } : {}),
          ...(suite.bail !== undefined ? { bail: suite.bail } : {}),
          ...(suite.requires
            ? {
                requires: {
                  ...(requiredEnvs.length > 0 ? { env: requiredEnvs } : {}),
                  ...(suite.requires.vars ? { vars: suite.requires.vars } : {}),
                },
              }
            : {}),
          ...(suite.seed?.postCommands?.skip
            ? { seedSkip: suite.seed.postCommands.skip }
            : {}),
          envs,
        },
        fields: [
          { field: "name", text: name },
          { field: "description", text: suite.description ?? "" },
          {
            field: "text",
            text: [
              ...(suite.tags ?? []),
              ...envs.flatMap((e) => e.specs.map((s) => basename(s))),
            ].join(" "),
          },
        ],
        order: name,
      });
    }
    result.suites = finish("suites", rows);
  }

  // Rows were validated one by one above; the document shape is asserted
  // against CatalogResultSchema by the tests.
  return result;
}

const ROW_SCHEMAS: Record<CatalogKind, z.ZodType> = {
  actions: CatalogActionSchema,
  vars: CatalogVarSchema,
  verifiers: CatalogVerifierSchema,
  envs: CatalogEnvSchema,
  flows: CatalogFlowSchema,
  checkpoints: CatalogCheckpointSchema,
  fixtures: CatalogFixtureSchema,
  suites: CatalogSuiteSchema,
};

/** How a warning names a row: its file, else its name (vars: `name [env]`). */
function rowLabel(row: unknown): string {
  const r = row as Record<string, unknown>;
  const name = nonEmptyText(r.name);
  const env = nonEmptyText(r.env);
  if (name && env) return `"${name}" [${env}]`;
  const label = nonEmptyText(r.file) ?? name;
  return label ? `"${label}"` : "an unnamed row";
}

function nonEmptyText(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function envRow(
  name: string,
  config: Config,
  masker: Masker,
  index: number,
): Ranked<CatalogEnv> {
  const env = config.environments[name]!;
  // The environment's effective block: its own merged over the top-level
  // one, or alone when the config has no top-level `services:`.
  // A runner environment runs elsewhere: no local services.
  const effective = resolveEffectiveServices(
    config.services,
    env.runner ? false : env.services,
  );
  const services: CatalogEnv["services"] = effective
    ? {
        enabled: true,
        phases: CATALOG_SERVICE_PHASES.filter(
          (phase) => effective[phase] !== undefined,
        ),
      }
    : { enabled: false, phases: [] };
  const secrets = env.secrets ?? config.secrets;
  const policy = env.policy;
  return {
    row: {
      name,
      default:
        config.defaultEnvironment !== undefined &&
        canonicalEnvironment(config.environments, config.defaultEnvironment)
          .name === name,
      ...(env.baseUrl ? { baseUrl: masker.text(env.baseUrl) } : {}),
      ...(policy && Object.keys(policy).length > 0
        ? {
            policy: {
              ...(policy.trait ? { trait: policy.trait } : {}),
              ...(policy.mutations ? { mutations: policy.mutations } : {}),
              ...(policy.description
                ? { description: masker.text(policy.description) }
                : {}),
            },
          }
        : {}),
      services,
      ...(secrets
        ? {
            secrets: {
              provider: secrets.provider,
              ...(secrets.required?.length
                ? { required: secrets.required }
                : {}),
              ...(secrets.keys?.length ? { keys: secrets.keys } : {}),
            },
          }
        : {}),
      vars: Object.keys(env.vars ?? {}).length,
    },
    fields: [
      { field: "name", text: name },
      { field: "description", text: policy?.description },
      {
        field: "text",
        text: [policy?.trait, env.baseUrl].filter(Boolean).join(" "),
      },
    ],
    order: String(index).padStart(4, "0"),
  };
}

function runRow(run: RunRef, byName: boolean) {
  return {
    runId: run.runId,
    spec: run.spec,
    status: run.status,
    ...(run.environment ? { environment: run.environment } : {}),
    ...(run.durationMs !== undefined ? { durationMs: run.durationMs } : {}),
    ...(run.startedAt ? { startedAt: run.startedAt } : {}),
    ...(byName ? { matchedBy: "name" as const } : {}),
  };
}

async function loadCatalogConfig(
  cwd: string,
  explicit: string | undefined,
): Promise<LoadedConfig | undefined> {
  try {
    return await loadConfig(
      resolve(cwd, "__cairntrace_catalog__.yml"),
      explicit,
    );
  } catch (e) {
    if (e instanceof ZodError) {
      const issue = e.issues[0];
      throw new CatalogConfigError(
        `invalid cairntrace.config.yml: ${
          issue
            ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
            : e.message
        }`,
      );
    }
    throw new CatalogConfigError((e as Error).message);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * F7: a catalog row for a var an environment gets without writing it — from
 * the top-level `vars:` (an included file names its `file`), its `extends`
 * chain, or an aliased vars block (`vars: *anchor`). The value is the
 * authored one (placeholders kept), masked like every catalog value.
 */
function composedVarRow(
  name: string,
  env: string,
  def: VarDefinition,
  ctx: {
    envIndex: number;
    index: number;
    masker: Masker;
    rel: (path: string) => string;
    usedBy: CatalogVar["usedBy"];
  },
): Ranked<CatalogVar> {
  const authored = def.template ?? def.value;
  const masked =
    typeof authored === "string" ||
    typeof authored === "number" ||
    typeof authored === "boolean"
      ? ctx.masker.value(name, authored)
      : undefined;
  const ownScope = `environments.${env}.vars`;
  const parent =
    def.scope.startsWith("environments.") && def.scope !== ownScope
      ? def.scope.slice("environments.".length, -".vars".length)
      : undefined;
  const definedIn: CatalogVar["definedIn"] =
    def.scope === "vars"
      ? "top-level"
      : parent !== undefined
        ? "extends"
        : def.inheritedFrom
          ? "inherited"
          : "environment";
  const inheritedFrom = parent ?? def.inheritedFrom;
  return {
    row: {
      name,
      env,
      ...(masked ? { value: masked.value } : {}),
      ...(masked?.masked ? { masked: true as const } : {}),
      definedIn,
      ...(inheritedFrom ? { inheritedFrom } : {}),
      file:
        def.line !== undefined
          ? `${ctx.rel(def.file)}:${def.line}`
          : ctx.rel(def.file),
      usedBy: ctx.usedBy,
    },
    fields: [
      { field: "name", text: name },
      {
        field: "text",
        text: masked && !masked.masked ? String(masked.value) : undefined,
      },
    ],
    order: `${String(ctx.envIndex).padStart(4, "0")}:${String(ctx.index).padStart(6, "0")}`,
  };
}
