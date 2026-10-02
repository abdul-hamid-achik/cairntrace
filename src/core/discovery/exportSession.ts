import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  authoringConfigOf,
  draftsDirFor,
  isDraftSpec,
  isInside,
  relativePosix,
} from "../authoring/config";
import {
  applyConventions,
  guardSecrets,
  SecretLiteralError,
  type ConventionReport,
  type RecordedEntry,
} from "../authoring/conventions";
import {
  entriesFromJournal,
  entriesFromSteps,
  loadActionTemplates,
} from "../authoring/exportContext";
import { knownSecrets } from "../authoring/secrets";
import { toSnake } from "../authoring/stepIds";
import { coldStartLint } from "../coldStart";
import {
  resolveProjectRuntimeContext,
  resolveSpecRuntimeContext,
} from "../config/runtimeContext";
import { parseSpec } from "../parser/parseSpec";
import type { Config, ConfigVarValue } from "../schema/config.v1";
import type { DiscoveryExportInput } from "../schema/discovery.v1";
import { SpecSchema } from "../schema/spec.v1";
import type { ArtifactRedactor } from "../artifacts/ArtifactWriter";
import {
  draftYaml,
  getExportableSteps,
  journalRefusal,
  recordExport,
  setupExportOf,
  type DiscoverySessionHandle,
} from "./DiscoverySession";
import {
  DRAFT_FILE,
  journalSteps,
  openElsewhere,
  readSessionJournal,
  SessionJournal,
} from "./sessionJournal";
import { rebaseImport, type SetupExport } from "./setup";
import type { SecretPlaceholder } from "./stepRecorder";
import { buildSpecYaml, deriveSpecName } from "./specExporter";

/**
 * Write a discovery session as a spec — from a live session or from its
 * journal alone (after the browser expired or closed, or in another
 * process). Shared by MCP `cairn_discover_export` and
 * `cairn discover export --from-session`.
 */

/** What an export needs from a session (live or journaled). */
export interface DiscoveryExportSource {
  sessionId?: string;
  /** Exportable steps (recorded, succeeded, not removed), in order. */
  steps: Record<string, unknown>[];
  /** Failed actions left out. */
  skippedFailed: number;
  setup?: SetupExport;
  /**
   * Absolute action files the recorded `use:` steps need beyond the
   * setup's (written to `imports:` with the setup's).
   */
  imports?: readonly string[];
  /** Checkpoint the session resumed (unless the setup export carries it). */
  resume?: string;
  runtimeInputs: {
    config?: string;
    env?: string;
    vars?: Record<string, ConfigVarValue>;
  };
  journal?: SessionJournal;
  /** Known secret literals → placeholders (a live session's own list). */
  secrets?: readonly SecretPlaceholder[];
  /**
   * Recorded steps with their journal facts (URLs, mutations) for a
   * convention export; read from the journal when absent.
   */
  entries?: () => Promise<RecordedEntry[] | undefined>;
  /** Warnings about the source itself (returned with the export's). */
  warnings?: readonly string[];
}

export interface DiscoveryExportOptions {
  /**
   * Output path as given (relative to `cwd`). Optional with `into` or
   * `conventions` (the file is then named after `name` or the intent).
   */
  path?: string;
  intent: string;
  outcomes: DiscoveryExportInput["outcomes"];
  /**
   * Replace an existing file. Without it a spec with a stamped
   * contractHash is never replaced, and a convention export refuses any
   * existing file.
   */
  overwrite?: boolean;
  /** Checkpoint to resume (wins over the session's). */
  resume?: string;
  cwd?: string;
  /**
   * Convention export target, relative to the config directory: a folder
   * (the spec is `<name>.yml` inside it) or a `.yml` file. Default: the
   * drafts dir (`authoring.draftsDir`, default `flows/_drafts`).
   */
  into?: string;
  /** Spec name (snake_case) for a convention export's file. */
  name?: string;
  /**
   * Apply the project conventions (reuse actions, lift vars, ids, waits,
   * postconditions, template). On when `into` is given or `path` is not.
   */
  conventions?: boolean;
  reuseActions?: boolean;
  liftVars?: boolean;
  refuseSecrets?: boolean;
  /** `requires:` for the spec (wins over the setup's and the template's). */
  requires?: unknown;
  /** Extra `metadata.tags`. */
  tags?: string[];
}

export interface DiscoveryExportResult {
  path: string;
  /** The spec `name:` written. */
  name: string;
  verifyOk: boolean;
  verifyErrors?: string[];
  warnings?: string[];
  stepCount: number;
  skippedFailed: number;
  sessionId?: string;
  /** Absolute path written. */
  writtenTo: string;
  /** The file is a draft (inside the drafts dir or a `_` folder). */
  draft?: boolean;
  /** What the convention pass did (convention exports). */
  report?: ConventionReport;
  /** What to do next (convention exports). */
  nextActions?: string[];
}

/** The export was refused before anything was written. */
export class DiscoveryExportRefusedError extends Error {
  override name = "DiscoveryExportRefusedError";
}

/** Where a convention export writes, and what the project says about it. */
interface ExportTarget {
  absPath: string;
  name: string;
  conventions: boolean;
  configDir: string;
  draftsDir: string;
}

function isYamlFile(path: string): boolean {
  return /\.ya?ml$/i.test(path);
}

/** A snake_case spec name from free text (first words of the intent). */
function nameFromText(text: string): string {
  const words = toSnake(text).split("_").filter(Boolean).slice(0, 6);
  const name = words.join("_").slice(0, 48).replace(/_+$/, "");
  if (!name) return "discovered_spec";
  return /^[a-z]/.test(name) ? name : `spec_${name}`;
}

async function exportTarget(
  opts: DiscoveryExportOptions,
  project: { configDir: string; config?: unknown },
): Promise<ExportTarget> {
  const cwd = opts.cwd ?? process.cwd();
  const draftsDir = draftsDirFor(project.configDir, project.config);
  const conventions =
    opts.conventions ?? (opts.into !== undefined || opts.path === undefined);
  if (opts.name !== undefined && !/^[a-z][a-z0-9_]*$/.test(opts.name)) {
    throw new DiscoveryExportRefusedError(
      `name "${opts.name}" must be snake_case starting with a letter`,
    );
  }
  const common = { conventions, configDir: project.configDir, draftsDir };
  // `path` alone: as given, relative to the cwd.
  if (opts.into === undefined && opts.path !== undefined) {
    return {
      ...common,
      absPath: resolve(cwd, opts.path),
      name: opts.name ?? deriveSpecName(opts.path),
    };
  }
  // `into` (relative to the config dir), else the drafts dir.
  const base = opts.into ?? draftsDir;
  const target = isAbsolute(base) ? base : resolve(project.configDir, base);
  if (isYamlFile(target)) {
    return {
      ...common,
      absPath: target,
      name: opts.name ?? deriveSpecName(target),
    };
  }
  const name =
    opts.name ??
    (opts.path !== undefined
      ? deriveSpecName(opts.path)
      : nameFromText(opts.intent));
  return { ...common, absPath: join(target, `${name}.yml`), name };
}

/** The config/env a session's export resolves against (lenient). */
async function exportProject(
  source: DiscoveryExportSource,
  cwd: string,
): Promise<{
  configDir: string;
  configPath?: string;
  config?: Config;
  baseUrl?: string;
  vars: Record<string, ConfigVarValue>;
}> {
  const inputs = source.runtimeInputs;
  try {
    const runtime = await resolveProjectRuntimeContext({
      cwd,
      ...(inputs.config !== undefined ? { configPath: inputs.config } : {}),
      ...(inputs.env !== undefined ? { envOverride: inputs.env } : {}),
    });
    return {
      configDir: runtime.configDir,
      ...(runtime.configPath ? { configPath: runtime.configPath } : {}),
      ...(runtime.config ? { config: runtime.config } : {}),
      ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
      vars: runtime.vars,
    };
  } catch {
    // The parse step below reports config problems; the target still
    // resolves next to the config file.
    const configDir = inputs.config
      ? dirname(resolve(cwd, inputs.config))
      : cwd;
    return { configDir, vars: {} };
  }
}

/** Known secrets of a journal-only export: config secret names + env. */
function secretsFor(
  source: DiscoveryExportSource,
  config: Config | undefined,
  env: string | undefined,
): readonly SecretPlaceholder[] {
  if (source.secrets) return source.secrets;
  const block =
    (env !== undefined ? config?.environments[env]?.secrets : undefined) ??
    config?.secrets;
  return knownSecrets(process.env as Record<string, string | undefined>, [
    ...(block?.required ?? []),
    ...(block?.keys ?? []),
  ]);
}

export async function exportDiscoverySpec(
  source: DiscoveryExportSource,
  opts: DiscoveryExportOptions,
): Promise<DiscoveryExportResult> {
  const cwd = opts.cwd ?? process.cwd();
  const project = await exportProject(source, cwd);
  const target = await exportTarget(opts, project);
  const absPath = target.absPath;
  const shownPath =
    opts.path !== undefined && !target.conventions
      ? opts.path
      : isInside(absPath, cwd)
        ? relative(cwd, absPath)
        : absPath;

  if (!opts.overwrite) {
    if (target.conventions) {
      if (await fileExists(absPath)) {
        throw new DiscoveryExportRefusedError(
          `${shownPath} already exists; pass overwrite:true (--overwrite) to replace it, or a different name/into`,
        );
      }
    } else {
      // Guard an existing stamped spec: its contractHash means its
      // intent/outcomes are locked, so refuse to clobber it unless the
      // caller explicitly opts in (mirrors `cairn spec verify --stamp`).
      const existingHash = await readContractHash(absPath);
      if (existingHash) {
        throw new DiscoveryExportRefusedError(
          `${shownPath} already exists with a stamped contractHash (${existingHash}); pass overwrite:true (--overwrite) to replace it`,
        );
      }
    }
  }

  const setup = source.setup;
  const resume = opts.resume ?? setup?.resume ?? source.resume;
  const envName =
    source.runtimeInputs.env ?? project.config?.defaultEnvironment;
  const secrets = secretsFor(source, project.config, envName);
  const draft = isDraftSpec(absPath, {
    draftsDir: target.draftsDir,
    root: target.configDir,
  });

  let setupSteps = setup?.steps ?? [];
  let steps = source.steps;
  let imports = [
    ...new Set([...(setup?.imports ?? []), ...(source.imports ?? [])]),
  ];
  let requires: unknown = setup?.requires;
  let metadata: { tags: string[] } | undefined;
  let report: ConventionReport | undefined;
  const notes: string[] = [];
  try {
    if (target.conventions) {
      const authoring = authoringConfigOf(project.config);
      const templateImports = (authoring.template?.imports ?? []).map((file) =>
        isAbsolute(file) ? file : resolve(target.configDir, file),
      );
      const loaded =
        opts.reuseActions === false
          ? { actions: [], warnings: [] }
          : await loadActionTemplates({
              configDir: target.configDir,
              ...(project.configPath ? { configPath: project.configPath } : {}),
              templateImports,
            });
      const entries =
        (await source.entries?.()) ??
        (source.journal
          ? await entriesFromJournal(source.journal.dir)
          : undefined) ??
        source.steps.map((step) => ({ step }));
      const configVars = await configEnvVars(project);
      const result = applyConventions({
        entries,
        setupSteps,
        setupImports: imports,
        ...(setup?.requires !== undefined
          ? { setupRequires: setup.requires }
          : {}),
        ctx: {
          ...(project.baseUrl ? { baseUrl: project.baseUrl } : {}),
          configVars,
          actions: loaded.actions,
          secrets,
          ...(authoring.template ? { template: authoring.template } : {}),
          displayPath: (file) => relativePosix(target.configDir, file),
        },
        options: {
          ...(opts.reuseActions !== undefined
            ? { reuseActions: opts.reuseActions }
            : {}),
          ...(opts.liftVars !== undefined ? { liftVars: opts.liftVars } : {}),
          ...(opts.refuseSecrets !== undefined
            ? { refuseSecrets: opts.refuseSecrets }
            : {}),
          ...(opts.requires !== undefined ? { requires: opts.requires } : {}),
          ...(opts.tags ? { tags: opts.tags } : {}),
        },
      });
      result.report.warnings.unshift(...loaded.warnings);
      setupSteps = result.setupSteps;
      steps = result.steps;
      imports = result.imports;
      requires = result.requires;
      metadata = result.metadata;
      report = result.report;
      const reused = report.reusedActions.filter((r) => r.applied);
      if (reused.length > 0) {
        notes.push(
          `Reuses: ${reused.map((r) => r.action).join(", ")}; lifted ${report.liftedVars.length} literal(s) to config vars.`,
        );
      }
    } else {
      // Secrets are never written, whatever the export mode; the recorded
      // shape (no ids, waits, reuse) is otherwise kept.
      const guarded = guardSecrets({
        steps,
        setupSteps,
        secrets,
        ...(opts.refuseSecrets !== undefined
          ? { refuseSecrets: opts.refuseSecrets }
          : {}),
      });
      steps = guarded.steps;
      setupSteps = guarded.setupSteps;
      if (guarded.replaced.length > 0 || guarded.warnings.length > 0) {
        report = {
          liftedVars: [],
          reusedActions: [],
          secretsPlaceholdered: guarded.replaced,
          warnings: guarded.warnings,
        };
      }
    }
  } catch (e) {
    if (e instanceof SecretLiteralError) {
      throw new DiscoveryExportRefusedError(e.message);
    }
    throw e;
  }
  if (draft) {
    notes.push(
      "DRAFT: `cairn run <dir>` skips it. Finish it with `cairn spec finish <file>`",
      "(lint, cold-start run, stamp when green), then `cairn spec promote <file>`.",
    );
  }

  const { yaml, stepCount } = buildSpecYaml({
    name: target.name,
    intent: opts.intent,
    outcomes: opts.outcomes,
    steps,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    setupSteps,
    imports: imports.map((file) => rebaseImport(file, absPath)),
    ...(setup?.vars ? { vars: setup.vars } : {}),
    ...(requires !== undefined ? { requires } : {}),
    ...(setup?.coldStart ? { coldStart: setup.coldStart } : {}),
    ...(metadata ? { metadata } : {}),
    ...(notes.length > 0 ? { notes } : {}),
    ...(resume ? { resume } : {}),
  });

  // Validate in-memory BEFORE writing so an invalid spec (e.g. a bad derived
  // name or a malformed recorded step) never lands on disk.
  const precheck = SpecSchema.safeParse(parseYaml(yaml));
  if (!precheck.success) {
    const issues = precheck.error.issues
      .map((i) => `${i.path.join(".") || "spec"}: ${i.message}`)
      .join("; ");
    throw new DiscoveryExportRefusedError(`invalid spec: ${issues}`);
  }

  await mkdir(dirname(absPath), { recursive: true });
  await writeFile(absPath, yaml, "utf8");

  // Verify the spec — parseSpec validates via SpecSchema internally, then
  // surface the same cold-start + contractHash warnings `cairn spec verify`
  // reports. A parseable spec is not necessarily stamped or cold-start
  // replayable, so the agent must see those gaps explicitly.
  let verifyOk = true;
  let verifyErrors: string[] | undefined;
  const warnings: string[] = [...(source.warnings ?? [])];
  try {
    // Recorded steps keep the caller's placeholders (`${vars.X}`,
    // `${secrets.X}`, relative paths), so parse with the config/env/var
    // inputs the session was opened with — the same resolution a run uses.
    const inputs = source.runtimeInputs;
    const runtime = await resolveSpecRuntimeContext(absPath, {
      ...(inputs.config !== undefined ? { configPath: inputs.config } : {}),
      ...(inputs.env !== undefined ? { envOverride: inputs.env } : {}),
      ...(inputs.vars !== undefined ? { vars: inputs.vars } : {}),
    });
    const parsed = await parseSpec(absPath, {
      vars: runtime.vars,
      configDir: runtime.configDir,
      ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
    });
    if (inputs.vars !== undefined && yaml.includes("${vars.")) {
      warnings.push(
        `exported steps keep \${vars.X} placeholders; the session's var inputs (${Object.keys(
          inputs.vars,
        ).join(
          ", ",
        )}) are not written to the spec — pass them with --var when running it`,
      );
    }
    if (!parsed.spec.contractHash) {
      warnings.push(
        target.conventions
          ? "spec has no contractHash yet; `cairn spec finish` stamps it when it runs green"
          : "spec has no contractHash; run `cairn spec verify <file> --stamp` to lock it",
      );
    }
    const coldStartWarning = coldStartLint(parsed.spec);
    if (coldStartWarning) warnings.push(coldStartWarning);
  } catch (e) {
    verifyOk = false;
    verifyErrors = [(e as Error).message];
  }

  const journal = source.journal;
  if (journal) {
    journal.append({
      ts: new Date().toISOString(),
      type: "export.written",
      path: absPath,
      verify: {
        status: !verifyOk ? "failed" : warnings.length > 0 ? "warnings" : "ok",
        findings: verifyErrors ?? warnings,
      },
    });
    const exportedTo = new Set(journal.snapshot.exportedTo ?? []);
    exportedTo.add(absPath);
    const status = journal.snapshot.status;
    journal.update({
      exportedTo: [...exportedTo],
      intent: opts.intent,
      outcomes: opts.outcomes as Array<Record<string, unknown>>,
      lastActivityAt: new Date().toISOString(),
      // A live session stays open; one that already ended is now exported.
      ...(status !== "open" ? { status: "exported" as const } : {}),
    });
  }

  const nextActions = target.conventions
    ? [
        `cairn spec finish ${shownPath}${
          envName ? ` --env ${envName}` : ""
        } --json  (MCP cairn_spec_finish) — lint, cold-start run, stamp when green`,
        ...(draft
          ? [
              `after a green finish and the human's review: cairn spec promote ${shownPath} --json  (MCP cairn_spec_promote)`,
            ]
          : []),
      ]
    : undefined;
  return {
    path: shownPath,
    name: target.name,
    verifyOk,
    ...(verifyErrors ? { verifyErrors } : {}),
    ...(warnings.length > 0 ? { warnings } : {}),
    stepCount,
    skippedFailed: source.skippedFailed,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
    writtenTo: absPath,
    ...(draft ? { draft: true } : {}),
    ...(report ? { report } : {}),
    ...(nextActions ? { nextActions } : {}),
  };
}

/** Config environment vars only (no runtime --var), as strings/scalars. */
async function configEnvVars(project: {
  config?: Config;
  vars: Record<string, ConfigVarValue>;
}): Promise<Record<string, string | number | boolean>> {
  return Object.fromEntries(
    Object.entries(project.vars).filter(
      ([, value]) =>
        typeof value === "string" ||
        typeof value === "number" ||
        typeof value === "boolean",
    ),
  ) as Record<string, string | number | boolean>;
}

async function fileExists(path: string): Promise<boolean> {
  return access(path).then(
    () => true,
    () => false,
  );
}

/**
 * Read the `contractHash` field from a spec file without full validation.
 * Returns undefined when the file is missing, unreadable, or unstamped — so
 * the discovery-export guard only refuses to clobber an *established*
 * (stamped) spec, and freely re-exports over a prior unstamped export.
 */
async function readContractHash(path: string): Promise<string | undefined> {
  try {
    const raw = parseYaml(await readFile(path, "utf8"));
    const hash =
      raw && typeof raw === "object"
        ? (raw as Record<string, unknown>)["contractHash"]
        : undefined;
    return typeof hash === "string" && hash.length > 0 ? hash : undefined;
  } catch {
    return undefined;
  }
}

/* ----- sources ----- */

/** The export source of a live session. */
export function exportSourceFromHandle(
  handle: DiscoverySessionHandle,
): DiscoveryExportSource {
  const { steps, skippedFailed } = getExportableSteps(handle);
  const journalDir = handle.journal?.dir;
  return {
    sessionId: handle.session.id,
    steps,
    skippedFailed,
    ...(handle.setupExport ? { setup: handle.setupExport } : {}),
    ...(handle.useImports.length > 0 ? { imports: handle.useImports } : {}),
    ...(handle.resume ? { resume: handle.resume } : {}),
    runtimeInputs: handle.runtimeInputs ?? {},
    ...(handle.journal ? { journal: handle.journal } : {}),
    secrets: handle.secrets,
    // Journal facts (URLs, late requests) when the session keeps one; the
    // in-memory record otherwise.
    entries: async () => {
      const recorded = handle.session.steps
        .filter((step) => step.ok && !step.removed)
        .map((step) => ({
          step: step.step,
          ...(step.index !== undefined ? { index: step.index } : {}),
        }));
      return (
        (journalDir
          ? await entriesFromJournal(journalDir, recorded)
          : undefined) ?? entriesFromSteps(recorded, handle.network.entries)
      );
    },
  };
}

/** Export a live session; its draft follows the new intent/outcomes. */
export async function exportLiveSession(
  handle: DiscoverySessionHandle,
  opts: DiscoveryExportOptions,
): Promise<DiscoveryExportResult> {
  const result = await exportDiscoverySpec(
    exportSourceFromHandle(handle),
    opts,
  );
  recordExport(handle, {
    path: result.writtenTo,
    name: result.name,
    intent: opts.intent,
    outcomes: opts.outcomes,
  });
  return result;
}

/**
 * Export a session from its journal alone (no browser): recorded steps from
 * `events.ndjson`, setup and inputs from `session.json`.
 */
export async function exportJournalSession(
  dir: string,
  opts: DiscoveryExportOptions & {
    /** Directory of the session's config (fromSpec setups re-resolve). */
    configDir?: string;
    config?: unknown;
    redactor?: ArtifactRedactor;
  },
): Promise<DiscoveryExportResult> {
  const read = await readSessionJournal(dir);
  if (!read) throw new Error(`no readable session journal in ${dir}`);
  if (read.session.kind !== "discovery") {
    throw new DiscoveryExportRefusedError(
      `session ${read.session.sessionId} is an ${read.session.kind} session; only discovery sessions export as specs (its draft is ${read.dir}/draft.spec.yml)`,
    );
  }
  const session = read.session;
  if (read.unreadableSteps) {
    throw new DiscoveryExportRefusedError(
      journalRefusal(read, { live: false }) ??
        `session ${session.sessionId}: recorded steps cannot be read`,
    );
  }
  const sourceWarnings: string[] = [];
  const redacted = journalRefusal(read, { live: false });
  if (redacted) {
    sourceWarnings.push(
      `${redacted}; the spec was written with them and will not run as is`,
    );
  }
  const pid = openElsewhere(session);
  if (pid !== undefined) {
    sourceWarnings.push(
      `session ${session.sessionId} is still open in process ${pid}: this export covers the steps recorded so far, and that session's next action rewrites draft.spec.yml`,
    );
  }
  const { steps, failedActions } = journalSteps(read.events);
  const configDir =
    opts.configDir ??
    (session.configPath ? dirname(session.configPath) : process.cwd());
  const setup = await setupExportOf(session, {
    configDir,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
  });
  const journal = SessionJournal.attach(dir, session, opts.redactor);
  const result = await exportDiscoverySpec(
    {
      sessionId: session.sessionId,
      steps: steps.map((entry) => entry.step),
      skippedFailed: failedActions,
      ...(setup ? { setup } : {}),
      ...(session.imports ? { imports: session.imports } : {}),
      ...(session.resume ? { resume: session.resume } : {}),
      runtimeInputs: {
        ...(session.configPath ? { config: session.configPath } : {}),
        ...(session.env ? { env: session.env } : {}),
        ...(session.vars ? { vars: session.vars } : {}),
      },
      journal,
      ...(sourceWarnings.length > 0 ? { warnings: sourceWarnings } : {}),
    },
    opts,
  );
  const name = result.name;
  const { yaml, stepCount } = draftYaml(
    {
      session: { id: session.sessionId } as DiscoverySessionHandle["session"],
      ...(setup ? { setupExport: setup } : {}),
      ...(session.imports ? { useImports: session.imports } : {}),
      ...(session.resume ? { resume: session.resume } : {}),
      draft: { name, intent: opts.intent, outcomes: opts.outcomes },
    },
    result.writtenTo,
    steps.map((entry) => entry.step),
    (value) => journal.redactValue(value),
  );
  if (journal.writeText(DRAFT_FILE, yaml, { preRedacted: true })) {
    journal.append({
      ts: new Date().toISOString(),
      type: "draft.updated",
      path: DRAFT_FILE,
      steps: stepCount,
    });
  }
  return result;
}
