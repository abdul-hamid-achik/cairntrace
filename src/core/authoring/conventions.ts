import { isSensitiveName, looksLikeSecretValue } from "../catalog/mask";
import type { SecretPlaceholder } from "../discovery/stepRecorder";
import type { AuthoringConfig } from "../schema/config.v1";
import {
  callVars,
  findActionMatches,
  type ActionMatch,
  type ActionTemplate,
} from "./actionMatch";
import {
  isPlaceholder,
  looksLikePasswordField,
  placeholderSecrets,
  typedValueOf,
} from "./secrets";
import { assignStepIds, isIdLike, stepKindOf } from "./stepIds";

/**
 * Convention-aware export (A5): turn the steps a discovery session recorded
 * into a spec that reads like the project's own — existing actions reused as
 * `use:`, literals that equal a config var lifted to `${vars.X}`, secrets as
 * placeholders, relative URLs, snake_case step ids, a wait after each
 * navigation and a `postcondition.network` for each mutation the session
 * observed. Pure: the caller loads actions, vars and journal data.
 */

type Scalar = string | number | boolean;

/** One recorded step with what the journal knows about the action. */
export interface RecordedEntry {
  step: Record<string, unknown>;
  /** Journal action index. */
  index?: number;
  /** Page URL before/after the action (no query string). */
  urlBefore?: string;
  urlAfter?: string;
  /** Mutating requests observed while (or just after) it ran. */
  mutations?: Array<{ method: string; path: string; status?: number }>;
}

export interface ConventionOptions {
  /** Replace runs of steps an existing action performs by `use:` (default true). */
  reuseActions?: boolean;
  /** Literals equal to a config var value become `${vars.X}` (default true). */
  liftVars?: boolean;
  /**
   * A literal typed into a password-type field that matches no known secret
   * fails the export (default true). false writes it with a warning. Known
   * secret values are always written as placeholders.
   */
  refuseSecrets?: boolean;
  /** Explicit `requires:` (wins over the setup's and the template's). */
  requires?: unknown;
  /** Extra `metadata.tags` (merged with the template's). */
  tags?: readonly string[];
}

export interface ConventionContext {
  /** Environment baseUrl: absolute URLs under it become relative. */
  baseUrl?: string;
  /** Config environment vars (resolved; no runtime --var overrides). */
  configVars: Record<string, Scalar>;
  /** Actions to reuse, in priority order (template imports first). */
  actions: readonly ActionTemplate[];
  /** Known secret literals → placeholders. */
  secrets: readonly SecretPlaceholder[];
  /** Environment for `${env.X}` in action defaults (default process.env). */
  env?: Record<string, string | undefined>;
  template?: NonNullable<AuthoringConfig["template"]>;
  /** Shows an action file in the report (relative to the config dir). */
  displayPath?: (file: string) => string;
}

export interface LiftedVar {
  /** Where the literal was, e.g. `steps[2].use.vars.value`. */
  where: string;
  var: string;
  /** The literal (omitted when it looks like a credential). */
  value?: string;
}

export interface ReusedAction {
  action: string;
  file?: string;
  /** `setup`: the session's own setup; `recorded`: matched recorded steps. */
  source: "setup" | "recorded";
  /** 1-based positions of the recorded steps it covers (recorded only). */
  steps?: [number, number];
  vars?: Record<string, string>;
  confidence: number;
  applied: boolean;
  reason?: string;
}

export interface ConventionReport {
  liftedVars: LiftedVar[];
  reusedActions: ReusedAction[];
  secretsPlaceholdered: Array<{ where: string; placeholder: string }>;
  warnings: string[];
}

export interface ConventionResult {
  setupSteps: Record<string, unknown>[];
  steps: Record<string, unknown>[];
  /** Absolute action files the spec must import (setup + reused). */
  imports: string[];
  requires?: unknown;
  metadata?: { tags: string[] };
  report: ConventionReport;
}

/** A password-type field got a literal no known secret explains. */
export class SecretLiteralError extends Error {
  override name = "SecretLiteralError";
}

/** Keys whose string values are structure, never data to lift. */
const STRUCTURAL_KEYS = new Set([
  "id",
  "by",
  "role",
  "waitUntil",
  "method",
  "direction",
  "assign",
  "runtime",
  "load",
  "action",
  "when",
]);
/** Literals shorter than this are too generic to lift. */
const MIN_LIFT_LENGTH = 4;
/**
 * Step kinds whose observed mutation becomes a `postcondition.network`.
 * Requests seen during open/hover/focus/scroll/wait are page noise
 * (telemetry, prefetch) and are not turned into guards.
 */
const POSTCONDITION_ACTIONS = new Set([
  "click",
  "fill",
  "type",
  "select",
  "upload",
  "download",
  "press",
  "batch",
]);
/** Steps whose mutations an export reports instead of guarding. */
const REPORTED_ACTIONS = new Set(["eval", "transform", "monitor"]);
/** Methods a postcondition can name. */
const POSTCONDITION_METHODS = new Set([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
/** Steps after which a URL change is worth a wait. */
const NAVIGATING_ACTIONS = new Set([
  "click",
  "press",
  "select",
  "use",
  "fill",
  "type",
  "batch",
]);

export function applyConventions(input: {
  entries: readonly RecordedEntry[];
  setupSteps: readonly Record<string, unknown>[];
  /** Absolute action files the setup imports. */
  setupImports: readonly string[];
  setupRequires?: unknown;
  ctx: ConventionContext;
  options?: ConventionOptions;
}): ConventionResult {
  const options = input.options ?? {};
  const ctx = input.ctx;
  const report: ConventionReport = {
    liftedVars: [],
    reusedActions: [],
    secretsPlaceholdered: [],
    warnings: [],
  };
  const display = ctx.displayPath ?? ((file: string) => file);
  // Warnings that name a step by its recorded (`orig`) or post-reuse
  // (`post`) index; relocated to the written file's index at the end.
  const located: Array<{ text: string; space?: "orig" | "post" }> = [];

  // 1. Relative URLs; 2. secrets as placeholders (or refused).
  const guarded = guardSecrets({
    steps: input.entries.map((entry) => relativeUrls(entry.step, ctx.baseUrl)),
    setupSteps: input.setupSteps,
    secrets: ctx.secrets,
    // A convention export refuses by default.
    refuseSecrets: options.refuseSecrets !== false,
  });
  located.push(
    ...guarded.warnings.map((text) => ({ text, space: "orig" as const })),
  );
  let entries: RecordedEntry[] = input.entries.map((entry, i) => ({
    ...entry,
    step: guarded.steps[i]!,
  }));
  let setupSteps = guarded.setupSteps;
  /** Recorded index → index after action reuse. */
  let postOf: number[] = entries.map((_entry, i) => i);

  // 3. Reuse existing actions.
  const imports = new Set(input.setupImports);
  for (const step of setupSteps) {
    const name = useName(step);
    if (!name) continue;
    const action = ctx.actions.find((a) => a.name === name);
    const vars = useVars(step);
    report.reusedActions.push({
      action: name,
      ...(action ? { file: display(action.file) } : {}),
      source: "setup",
      ...(vars ? { vars } : {}),
      confidence: 1,
      applied: true,
    });
  }
  if (options.reuseActions !== false && ctx.actions.length > 0) {
    const matches = findActionMatches(
      entries.map((entry) => entry.step),
      ctx.actions,
    );
    const replaced = replaceMatches(
      entries,
      matches,
      ctx,
      report,
      imports,
      display,
    );
    entries = replaced.entries;
    postOf = replaced.postOf;
  }

  // 4. Lift literals equal to config vars.
  if (options.liftVars !== false) {
    const lifter = varLifter(ctx.configVars, report, (text) =>
      located.push({ text, space: "post" }),
    );
    entries = entries.map((entry, i) => ({
      ...entry,
      step: lifter(entry.step, `steps[${i}]`) as Record<string, unknown>,
    }));
    setupSteps = setupSteps.map(
      (step, i) => lifter(step, `setup[${i}]`) as Record<string, unknown>,
    );
  }

  // 5. Waits after navigations; 6. postconditions from observed mutations.
  const steps: Record<string, unknown>[] = [];
  /** Index after reuse → index in `steps`. */
  const positionOf: number[] = [];
  const stepNotes: Array<{ post: number; note: (label: string) => string }> =
    [];
  for (const [i, entry] of entries.entries()) {
    const guardedStep = withPostcondition(entry, (note) =>
      stepNotes.push({ post: i, note }),
    );
    positionOf[i] = steps.length;
    steps.push(withOpenWait(guardedStep));
    const next = entries[i + 1]?.step;
    const wait = navigationWait(entry, next, (message) =>
      stepNotes.push({ post: i, note: (label) => `${label}: ${message}` }),
    );
    if (wait) steps.push(wait);
  }

  // 7. Unique snake_case ids across setup and recorded steps.
  const taken = new Set<string>();
  const setupWithIds = assignStepIds(setupSteps, taken).steps;
  const stepsWithIds = assignStepIds(steps, taken).steps;

  // Report locations as the written file has them: setup steps first,
  // then the recorded ones with their waits (`steps[7]`, `steps[7] (id)`).
  const fileIndex = (post: number): number =>
    setupWithIds.length + (positionOf[post] ?? post);
  const relocate = (where: string, space: "orig" | "post"): string =>
    where.replace(/^(steps|setup)\[(\d+)\]/, (_m, kind: string, n: string) => {
      const index = Number(n);
      if (kind === "setup") return `steps[${index}]`;
      const post = space === "orig" ? (postOf[index] ?? index) : index;
      return `steps[${fileIndex(post)}]`;
    });
  const label = (post: number): string => {
    const id = stepsWithIds[positionOf[post] ?? post]?.["id"];
    return `steps[${fileIndex(post)}]${
      typeof id === "string" ? ` (${id})` : ""
    }`;
  };
  report.secretsPlaceholdered.push(
    ...guarded.replaced.map((r) => ({
      ...r,
      where: relocate(r.where, "orig"),
    })),
  );
  report.liftedVars = report.liftedVars.map((lifted) => ({
    ...lifted,
    where: relocate(lifted.where, "post"),
  }));
  report.warnings.push(
    ...located.map(({ text, space }) => (space ? relocate(text, space) : text)),
    ...stepNotes.map(({ post, note }) => note(label(post))),
  );

  const template = ctx.template;
  const requires =
    options.requires ?? input.setupRequires ?? template?.requires;
  const tags = [
    ...new Set([...(template?.metadata?.tags ?? []), ...(options.tags ?? [])]),
  ];
  return {
    setupSteps: setupWithIds,
    steps: stepsWithIds,
    imports: [...imports],
    ...(requires !== undefined ? { requires } : {}),
    ...(tags.length > 0 ? { metadata: { tags } } : {}),
    report,
  };
}

/* ----- urls ----- */

function relativeTo(url: string, baseUrl: string | undefined): string {
  if (!baseUrl || !/^https?:\/\//i.test(url)) return url;
  const base = baseUrl.replace(/\/+$/, "");
  if (url === base) return "/";
  if (url.startsWith(`${base}/`) || url.startsWith(`${base}?`)) {
    const rest = url.slice(base.length);
    return rest.startsWith("/") ? rest : `/${rest}`;
  }
  return url;
}

function relativeUrls(
  step: Record<string, unknown>,
  baseUrl: string | undefined,
): Record<string, unknown> {
  if (!baseUrl) return step;
  const open = step["open"];
  if (typeof open === "string") {
    return { ...step, open: relativeTo(open, baseUrl) };
  }
  if (open && typeof open === "object") {
    const body = open as Record<string, unknown>;
    if (typeof body["path"] === "string") {
      return {
        ...step,
        open: { ...body, path: relativeTo(body["path"], baseUrl) },
      };
    }
  }
  const request = step["request"];
  if (request && typeof request === "object") {
    const body = request as Record<string, unknown>;
    if (typeof body["url"] === "string") {
      return {
        ...step,
        request: { ...body, url: relativeTo(body["url"], baseUrl) },
      };
    }
  }
  return step;
}

/* ----- secrets ----- */

/**
 * Known secret literals become their placeholders; a literal typed into a
 * password-type field (or passed as a credential var to an action) that no
 * known secret explains throws {@link SecretLiteralError} when
 * `refuseSecrets: true` (a convention export's default), else is kept with
 * a warning (a plain `--path` export: the field guess is a heuristic).
 */
export function guardSecrets(input: {
  steps: readonly Record<string, unknown>[];
  setupSteps: readonly Record<string, unknown>[];
  secrets: readonly SecretPlaceholder[];
  refuseSecrets?: boolean;
}): {
  steps: Record<string, unknown>[];
  setupSteps: Record<string, unknown>[];
  replaced: Array<{ where: string; placeholder: string }>;
  warnings: string[];
} {
  const replaced: Array<{ where: string; placeholder: string }> = [];
  const warnings: string[] = [];
  const steps = input.steps.map((step, i) => {
    const out = placeholderSecrets(step, input.secrets, `steps[${i}]`);
    replaced.push(...out.replaced);
    return out.value;
  });
  const setupSteps = input.setupSteps.map((step, i) => {
    const out = placeholderSecrets(step, input.secrets, `setup[${i}]`);
    replaced.push(...out.replaced);
    return out.value;
  });
  const literals = [
    ...steps.flatMap((step, i) => credentialLiterals(step, `steps[${i}]`)),
    ...setupSteps.flatMap((step, i) => credentialLiterals(step, `setup[${i}]`)),
  ];
  for (const literal of literals) {
    const message = literal.redacted
      ? `${literal.where}: ${literal.what} was redacted in the session journal (the value is gone); write it as \${secrets.NAME} (config secrets) or \${env.NAME} — export the live session, or edit the draft`
      : `${literal.where}: ${literal.what} holds a literal that matches no known secret; a credential belongs in \${secrets.NAME} (config secrets) or \${env.NAME}. If it is ordinary test data, export with --allow-secret-literals (MCP refuseSecrets: false) and keep it or move it to \${vars.X}`;
    if (input.refuseSecrets !== true) warnings.push(message);
    else throw new SecretLiteralError(`refusing to write a secret: ${message}`);
  }
  // Values the journal's redactor replaced (an Authorization header, a
  // token) would be written as the text "[redacted]".
  const flagged = new Set(literals.map((l) => l.where));
  const scan = (node: unknown, where: string): void => {
    if (typeof node === "string") {
      if (node.includes(REDACTED) && !flagged.has(where)) {
        warnings.push(
          `${where} holds "${REDACTED}" (the session journal redacted it); replace it with a placeholder before running`,
        );
      }
    } else if (Array.isArray(node)) {
      node.forEach((item, i) => scan(item, `${where}[${i}]`));
    } else if (node && typeof node === "object") {
      for (const [k, v] of Object.entries(node)) scan(v, `${where}.${k}`);
    }
  };
  steps.forEach((step, i) => scan(step, `steps[${i}]`));
  setupSteps.forEach((step, i) => scan(step, `setup[${i}]`));
  return { steps, setupSteps, replaced, warnings };
}

/** What the artifact redactor writes in place of a value. */
const REDACTED = "[redacted]";

function credentialLiterals(
  step: Record<string, unknown>,
  where: string,
): Array<{ where: string; what: string; redacted?: boolean }> {
  const out: Array<{ where: string; what: string; redacted?: boolean }> = [];
  const typed = typedValueOf(step);
  if (
    typed &&
    typed.value.length > 0 &&
    !isPlaceholder(typed.value) &&
    looksLikePasswordField(typed.locator)
  ) {
    out.push({
      where: `${where}.${typed.kind}.value`,
      what: `a ${typed.kind} into a password-type field (${describeLocator(typed.locator)})`,
      ...(typed.value === REDACTED ? { redacted: true } : {}),
    });
  }
  const vars = useVars(step);
  for (const [name, value] of Object.entries(vars ?? {})) {
    if (isSensitiveName(name) && value.length > 0 && !isPlaceholder(value)) {
      out.push({
        where: `${where}.use.vars.${name}`,
        what: `the credential var "${name}"`,
        ...(value === REDACTED ? { redacted: true } : {}),
      });
    }
  }
  return out;
}

function describeLocator(locator: Record<string, unknown>): string {
  for (const key of ["label", "name", "text", "testid", "selector"]) {
    if (typeof locator[key] === "string") {
      return `${key} "${locator[key] as string}"`;
    }
  }
  return "unnamed field";
}

/* ----- action reuse ----- */

function useName(step: Record<string, unknown>): string | undefined {
  const use = step["use"];
  if (typeof use === "string") return use;
  if (use && typeof use === "object") {
    const action = (use as Record<string, unknown>)["action"];
    if (typeof action === "string") return action;
  }
  return undefined;
}

function useVars(
  step: Record<string, unknown>,
): Record<string, string> | undefined {
  const use = step["use"];
  if (!use || typeof use !== "object") return undefined;
  const vars = (use as Record<string, unknown>)["vars"];
  if (!vars || typeof vars !== "object") return undefined;
  return Object.fromEntries(
    Object.entries(vars as Record<string, unknown>).map(([k, v]) => [
      k,
      String(v),
    ]),
  );
}

/**
 * Resolves `${vars.X}` (config vars), `${env.X}` / `${env.X:-default}` and
 * `${secrets.X}` (known secrets) in an action's `vars:` default, so a call
 * does not pass what the action would read anyway. Undefined when any
 * placeholder stays unresolved.
 */
function defaultResolver(
  ctx: ConventionContext,
): (text: string) => string | undefined {
  const env = ctx.env ?? (process.env as Record<string, string | undefined>);
  return (text) => {
    let unresolved = false;
    const out = text.replace(
      /\$\{(env|vars|secrets)\.([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g,
      (whole, ns: string, name: string, fallback: string | undefined) => {
        if (ns === "vars" && Object.hasOwn(ctx.configVars, name)) {
          return String(ctx.configVars[name]);
        }
        if (ns === "env") {
          const value = env[name];
          if (value !== undefined && value !== "") return value;
          if (fallback !== undefined) return fallback;
        }
        if (ns === "secrets") {
          const secret = ctx.secrets.find((s) => s.placeholder === whole);
          if (secret) return secret.value;
        }
        unresolved = true;
        return whole;
      },
    );
    return unresolved ? undefined : out;
  };
}

function replaceMatches(
  entries: RecordedEntry[],
  matches: readonly ActionMatch[],
  ctx: ConventionContext,
  report: ConventionReport,
  imports: Set<string>,
  display: (file: string) => string,
): { entries: RecordedEntry[]; postOf: number[] } {
  const out: RecordedEntry[] = [];
  const postOf: number[] = [];
  const resolve = defaultResolver(ctx);
  const applied = new Map(
    matches.filter((m) => m.applied).map((m) => [m.start, m]),
  );
  for (const match of matches) {
    const action = ctx.actions.find((a) => a.name === match.action);
    const vars = action ? callVars(match, action, ctx.configVars, resolve) : {};
    report.reusedActions.push({
      action: match.action,
      file: display(match.file),
      source: "recorded",
      steps: [match.start + 1, match.end],
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
      confidence: match.confidence,
      applied: match.applied,
      ...(match.reason ? { reason: match.reason } : {}),
    });
  }
  for (let i = 0; i < entries.length; ) {
    const match = applied.get(i);
    if (!match) {
      postOf[i] = out.length;
      out.push(entries[i]!);
      i++;
      continue;
    }
    const covered = entries.slice(match.start, match.end);
    const action = ctx.actions.find((a) => a.name === match.action)!;
    const vars = callVars(match, action, ctx.configVars, resolve);
    const dropped = covered.flatMap((entry) => entry.mutations ?? []);
    if (dropped.length > 0) {
      report.warnings.push(
        `${match.action} (reused for recorded steps ${match.start + 1}-${match.end}) caused ${dropped
          .map((m) => `${m.method} ${m.path}`)
          .join(
            ", ",
          )}; a postcondition cannot guard a use: step — add one inside the action or a network outcome`,
      );
    }
    imports.add(match.file);
    const first = covered[0]!;
    const last = covered.at(-1)!;
    for (let k = match.start; k < match.end; k++) postOf[k] = out.length;
    out.push({
      step:
        Object.keys(vars).length > 0
          ? { use: { action: match.action, vars } }
          : { use: match.action },
      ...(first.index !== undefined ? { index: first.index } : {}),
      ...(first.urlBefore !== undefined ? { urlBefore: first.urlBefore } : {}),
      ...(last.urlAfter !== undefined ? { urlAfter: last.urlAfter } : {}),
    });
    i = match.end;
  }
  return { entries: out, postOf };
}

/* ----- var lifting ----- */

/** Keys whose values pick an element: never lifted into per-env config. */
const LOCATOR_KEYS = new Set([
  "name",
  "label",
  "text",
  "near",
  "hasText",
  "testid",
  "testId",
  "selector",
  "placeholder",
  "nth",
]);
/** Words too generic to tie a var to a field. */
const GENERIC_WORDS = new Set([
  "value",
  "field",
  "input",
  "text",
  "name",
  "the",
  "and",
  "for",
  "var",
]);

function nameWords(text: string): Set<string> {
  return new Set(
    text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length >= 3 && !GENERIC_WORDS.has(w)),
  );
}

/** Words of what a value is typed into: the sibling label/name/test id. */
function contextWords(node: Record<string, unknown>, key: string): Set<string> {
  const words = nameWords(key);
  for (const k of ["name", "label", "testid", "testId", "placeholder"]) {
    const value = node[k];
    if (typeof value === "string") {
      for (const w of nameWords(value)) words.add(w);
    }
  }
  return words;
}

/**
 * A literal unlikely to equal a config var by coincidence: an URL, an email,
 * a path, or a long string. Short words and numbers ("local", "3000") need
 * the var's name to match the field they are typed into.
 */
function distinctive(text: string): boolean {
  return (text.length >= 6 && /[@/:.]/.test(text)) || text.length >= 16;
}

function varLifter(
  configVars: Record<string, Scalar>,
  report: ConventionReport,
  warn: (message: string) => void,
): (value: unknown, where: string) => unknown {
  const byValue = new Map<string, string[]>();
  for (const [name, value] of Object.entries(configVars)) {
    if (typeof value !== "string") continue; // numbers/booleans: coincidence
    const text = value;
    if (
      text.length < MIN_LIFT_LENGTH ||
      isPlaceholder(text) ||
      /^[-+]?\d+(?:[.,]\d+)?$/.test(text.trim())
    ) {
      continue;
    }
    byValue.set(text, [...(byValue.get(text) ?? []), name]);
  }
  const ambiguous = new Set<string>();
  const lift = (
    node: unknown,
    where: string,
    key: string,
    context: Set<string>,
  ): unknown => {
    if (typeof node === "string") {
      if (
        STRUCTURAL_KEYS.has(key) ||
        LOCATOR_KEYS.has(key) ||
        isPlaceholder(node)
      ) {
        return node;
      }
      const all = byValue.get(node);
      if (!all) return node;
      // A short literal lifts only into a field its var is named after.
      const names = distinctive(node)
        ? all
        : all.filter((name) =>
            [...nameWords(name)].some((w) => context.has(w)),
          );
      if (names.length === 0) return node;
      if (names.length > 1) {
        if (!ambiguous.has(node)) {
          ambiguous.add(node);
          warn(
            `${where}: literal equals several config vars (${names.join(", ")}); kept as written`,
          );
        }
        return node;
      }
      const name = names[0]!;
      const sensitive = isSensitiveName(name) || looksLikeSecretValue(node);
      report.liftedVars.push({
        where,
        var: name,
        ...(sensitive ? {} : { value: node }),
      });
      return `\${vars.${name}}`;
    }
    if (Array.isArray(node)) {
      return node.map((item, i) => lift(item, `${where}[${i}]`, key, context));
    }
    if (node && typeof node === "object") {
      const record = node as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(record).map(([k, v]) => [
          k,
          lift(v, `${where}.${k}`, k, contextWords(record, k)),
        ]),
      );
    }
    return node;
  };
  return (value, where) => lift(value, where, "", new Set());
}

/* ----- waits and postconditions ----- */

/** `open: /x` → `open: { path: /x, waitUntil: networkidle }`. */
function withOpenWait(step: Record<string, unknown>): Record<string, unknown> {
  const open = step["open"];
  if (typeof open !== "string") return step;
  return { ...step, open: { path: open, waitUntil: "networkidle" } };
}

function urlPath(url: string): string {
  const bare = url.replace(/[?#].*$/, "");
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(bare);
  return m ? (m[1] ?? "/") : bare;
}

/**
 * The stable part of a path for `includes`/`urlContains`: everything before
 * the first id-like segment (`/api/answers/42/edit` → `/api/answers/`).
 */
export function stablePath(path: string): string {
  const segments = urlPath(path).split("/");
  const keep: string[] = [];
  for (const segment of segments) {
    if (segment && isIdLike(segment)) {
      keep.push("");
      break;
    }
    keep.push(segment);
  }
  return keep.join("/") || "/";
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A regex class for an id-like path segment (see {@link isIdLike}). */
function idClass(segment: string): string {
  if (/^\d+$/.test(segment)) return "\\d+";
  if (/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(segment)) {
    return "[0-9a-fA-F-]{36}";
  }
  if (/^[0-9a-f]{12,}$/i.test(segment)) return "[0-9a-fA-F]{12,}";
  return "[A-Za-z0-9_-]{16,}";
}

/**
 * A `wait.url.pattern` for exactly the path of `url` (id-like segments as
 * classes): `/products/42/edit` → `/products/\d+/edit/?(?:[?#]|$)`.
 */
export function pathPattern(url: string): string {
  const segments = urlPath(url).replace(/\/+$/, "").split("/");
  const body = segments
    .map((segment) =>
      segment && isIdLike(segment) ? idClass(segment) : escapeRegExp(segment),
    )
    .join("/");
  return `${body || ""}/?(?:[?#]|$)`;
}

/**
 * The wait after a step that changed the page URL. `includes` of the
 * stable path prefix when the URL before the step does not already hold it;
 * otherwise (CRUD flows: `/products/new` → `/products/42`) a pattern for
 * the exact new path, so the wait cannot pass before the navigation. When
 * no matcher tells the two URLs apart, no wait (and a warning).
 */
function navigationWait(
  entry: RecordedEntry,
  next: Record<string, unknown> | undefined,
  warn: (message: string) => void,
): Record<string, unknown> | undefined {
  if (!entry.urlBefore || !entry.urlAfter) return undefined;
  const kind = stepKindOf(entry.step);
  if (!NAVIGATING_ACTIONS.has(kind)) return undefined;
  const before = urlPath(entry.urlBefore);
  const after = urlPath(entry.urlAfter);
  if (before === after || entry.urlAfter.startsWith("about:")) return undefined;
  if (next && ("wait" in next || "open" in next)) return undefined;
  const includes = stablePath(after);
  if (includes === "/") return { wait: { load: "networkidle" } };
  if (!entry.urlBefore.includes(includes)) {
    return { wait: { url: { includes } } };
  }
  const pattern = pathPattern(after);
  const re = new RegExp(pattern);
  if (re.test(entry.urlAfter) && !re.test(entry.urlBefore)) {
    return { wait: { url: { pattern } } };
  }
  warn(
    `${kind} changed the page from ${before} to ${after}, but no URL matcher tells them apart; no wait was added — add one (wait.text, wait.url) if the next step races the navigation`,
  );
  return undefined;
}

function withPostcondition(
  entry: RecordedEntry,
  note: (describe: (label: string) => string) => void,
): Record<string, unknown> {
  const mutations = (entry.mutations ?? []).filter(
    (m) =>
      (m.status === undefined || m.status < 400) &&
      POSTCONDITION_METHODS.has(m.method),
  );
  if (mutations.length === 0) return entry.step;
  const kind = stepKindOf(entry.step);
  if (!POSTCONDITION_ACTIONS.has(kind)) {
    if (REPORTED_ACTIONS.has(kind)) {
      note(
        (label) =>
          `${label} caused ${describeMutations(mutations)}; only a browser action can carry a postcondition — add a network outcome`,
      );
    }
    return entry.step;
  }
  if (entry.step["postcondition"] !== undefined) return entry.step;
  const [first, ...rest] = mutations;
  const urlContains = stablePath(first!.path);
  if (rest.length > 0) {
    note(
      (label) =>
        `${label} also caused ${describeMutations(rest)}; the postcondition guards ${first!.method} ${urlContains} only`,
    );
  }
  return {
    ...entry.step,
    postcondition: {
      network: {
        method: first!.method,
        urlContains,
        ...(first!.status !== undefined ? { status: { below: 400 } } : {}),
      },
    },
  };
}

function describeMutations(
  mutations: ReadonlyArray<{ method: string; path: string; status?: number }>,
): string {
  return mutations
    .map(
      (m) =>
        `${m.method} ${m.path}${m.status !== undefined ? ` ${m.status}` : ""}`,
    )
    .join(", ");
}
