import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
  isMap,
  isScalar,
  isSeq,
  LineCounter,
  parseDocument,
  visit,
  type Document,
  type Pair,
  type YAMLMap,
} from "yaml";
import { ZodError, type ZodIssue, type ZodTypeAny } from "zod";
import { analyzeVerifierSource } from "../catalog/verifierContract";
import { isSensitiveName, looksLikeSecretValue } from "../catalog/mask";
import { coldStartLint, usesLogin } from "../coldStart";
import {
  resolveSpecRuntimeContext,
  UnknownEnvironmentError,
} from "../config/runtimeContext";
import { auditFileReferences } from "../fileReferenceAudit";
import {
  evalStepRatio,
  exceedsEvalRatio,
  formatEvalRatio,
} from "../exporters/evalRatio";
import {
  ContractHashMismatchError,
  MissingTemplateVariableError,
  parseSpec,
  UnresolvedActionError,
  type ParseResult,
} from "../parser/parseSpec";
import { auditPlaceholderReferences } from "../referenceAudit";
import type { ConfigVarValue } from "../schema/config.v1";
import {
  BatchStepSchema,
  CheckStepSchema,
  ChooseStepSchema,
  ClickStepSchema,
  DownloadStepSchema,
  EvalStepSchema,
  FillStepSchema,
  FocusStepSchema,
  FormStepSchema,
  HoverStepSchema,
  IfStepSchema,
  MonitorStepSchema,
  OpenStepSchema,
  PressStepSchema,
  RepeatStepSchema,
  RequestStepSchema,
  ReusableActionSchema,
  ScrollStepSchema,
  SelectStepSchema,
  SetStepSchema,
  SnapshotStepSchema,
  SpecSchema,
  StepSchema,
  TransformStepSchema,
  TypeStepSchema,
  UncheckStepSchema,
  UploadStepSchema,
  UseStepSchema,
  WaitStepSchema,
} from "../schema/spec.v1";
import {
  isPlaceholder,
  knownSecrets,
  looksLikePasswordField,
  typedValueOf,
} from "./secrets";
import { assignStepIds, stepKindOf } from "./stepIds";

/**
 * `cairn spec lint` (A7): friendly, fix-it findings for a spec (or a
 * reusable action) before it ever runs — the mistakes agents make most:
 * an unquoted `#` selector (YAML reads it as a comment), files that do not
 * exist, a cold start that only echoes, fixture keys a script verifier
 * never reads, literal secrets, evals that a typed step does better,
 * host-specific absolute paths, placeholders that would reach a shell
 * literally, missing step ids, and vars that do not resolve in an
 * environment. `--fix` applies only edits that cannot change behavior.
 */

export type LintSeverity = "error" | "warning";

export type LintRule =
  | "yaml-syntax"
  | "unquoted-hash"
  | "schema"
  | "unknown-env"
  | "unresolved-var"
  | "unresolved-action"
  | "contract-hash-mismatch"
  | "unresolved-reference"
  | "missing-file"
  | "absolute-path"
  | "deprecated-path"
  | "cold-start-missing"
  | "cold-start-echo-only"
  | "unknown-fixture-key"
  | "missing-fixture-key"
  | "literal-secret"
  | "eval-typed-equivalent"
  | "eval-ratio"
  | "residual-placeholder"
  | "missing-step-id"
  | "duplicate-step-id"
  | "shell-arg-unset"
  | "config";

export interface LintFix {
  description: string;
  /** Applied by `--fix` (cannot change what the spec does). */
  safe: boolean;
  applied?: boolean;
}

export interface LintFinding {
  rule: LintRule;
  severity: LintSeverity;
  message: string;
  /** 1-based line in the file. */
  line?: number;
  /** Location in the document, e.g. `steps[3].click.selector`. */
  where?: string;
  /** Environment the finding is about (per-env resolution). */
  env?: string;
  /** File the finding is about when not the linted one (an imported action). */
  file?: string;
  fix?: LintFix;
}

export interface FileLintResult {
  path: string;
  kind: "spec" | "action" | "unknown";
  status: "ok" | "warnings" | "errors";
  findings: LintFinding[];
  /** Safe fixes written by `--fix`. */
  fixed: number;
  /** Environments each var/file resolution was checked in. */
  envs: string[];
}

export interface LintResult {
  $schema: "urn:cairntrace.dev:spec-lint:v1";
  version: "1";
  files: FileLintResult[];
  summary: { files: number; errors: number; warnings: number; fixed: number };
}

export interface LintOptions {
  /** Environments to resolve vars/files in (default: the spec's default). */
  envs?: readonly string[];
  config?: string;
  vars?: Record<string, ConfigVarValue>;
  /** Apply safe fixes in place. */
  fix?: boolean;
  cwd?: string;
  /** Process env for secret values and env refs (default process.env). */
  env?: Record<string, string | undefined>;
}

/** Keys whose value is a CSS selector when written as a string. */
const SELECTOR_KEYS =
  "selector|target|click|hover|focus|within|root|region|scope|css|near";
const HASH_RE = new RegExp(
  `(^|[\\s{,])((?:${SELECTOR_KEYS})\\s*:[ \\t]+)(#[^\\s#'"][^\\n]*)$`,
);

export async function lintSpecs(
  paths: readonly string[],
  opts: LintOptions = {},
): Promise<LintResult> {
  const files: FileLintResult[] = [];
  for (const path of paths) files.push(await lintFile(path, opts));
  const count = (severity: LintSeverity): number =>
    files.reduce(
      (n, f) => n + f.findings.filter((x) => x.severity === severity).length,
      0,
    );
  return {
    $schema: "urn:cairntrace.dev:spec-lint:v1",
    version: "1",
    files,
    summary: {
      files: files.length,
      errors: count("error"),
      warnings: count("warning"),
      fixed: files.reduce((n, f) => n + f.fixed, 0),
    },
  };
}

/** Exit code of a lint result: 4 when any finding is an error. */
export function lintExitCode(result: LintResult): 0 | 4 {
  return result.summary.errors > 0 ? 4 : 0;
}

async function lintFile(
  specPath: string,
  opts: LintOptions,
): Promise<FileLintResult> {
  const cwd = opts.cwd ?? process.cwd();
  const absPath = isAbsolute(specPath) ? specPath : resolve(cwd, specPath);
  const findings: LintFinding[] = [];
  const out: FileLintResult = {
    path: specPath,
    kind: "unknown",
    status: "ok",
    findings,
    fixed: 0,
    envs: [],
  };
  let text: string;
  try {
    text = await readFile(absPath, "utf8");
  } catch (e) {
    findings.push({
      rule: "missing-file",
      severity: "error",
      message: `cannot read ${specPath}: ${(e as Error).message}`,
    });
    return finish(out);
  }

  // 1. Unquoted `#` selectors (YAML turns them into comments → null).
  const hashes = findUnquotedHashes(text);
  let hashesFixed = false;
  if (opts.fix && hashes.length > 0) {
    // Written only when the quoted file parses and differs in nothing else.
    const quoted = quoteHashes(text, hashes);
    if (quoted !== undefined) {
      text = quoted;
      await writeFile(absPath, text);
      out.fixed += hashes.length;
      hashesFixed = true;
    }
  }
  for (const hash of hashes) {
    findings.push({
      rule: "unquoted-hash",
      severity: hashesFixed ? "warning" : "error",
      line: hash.line,
      message: `line ${hash.line}: \`${hash.key.trim()} ${hash.value}\` — YAML reads an unquoted # as the start of a comment, so this value is empty`,
      fix: {
        description: `quote it: ${hash.key.trim()} "${hash.value}"${
          opts.fix && !hashesFixed
            ? " (not applied: the quoted file would not parse the same; quote it by hand)"
            : ""
        }`,
        safe: true,
        applied: hashesFixed,
      },
    });
  }

  // 2. YAML syntax.
  let lineCounter = new LineCounter();
  let doc = parseDocument(text, { lineCounter, uniqueKeys: false });
  if (doc.errors.length > 0) {
    for (const error of doc.errors.slice(0, 5)) {
      const line = error.linePos?.[0]?.line;
      // A flow-map comment swallows the closing brace: the parser fails a
      // line or two later. The # finding already explains it.
      if (
        line !== undefined &&
        hashes.some((h) => line >= h.line && line <= h.line + 2)
      ) {
        continue;
      }
      findings.push({
        rule: "yaml-syntax",
        severity: "error",
        ...(line !== undefined ? { line } : {}),
        message: `YAML: ${error.message.split("\n")[0]}`,
      });
    }
    return finish(out);
  }
  const raw = doc.toJS() as unknown;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    findings.push({
      rule: "schema",
      severity: "error",
      message:
        "not a spec: expected a mapping with version, name, intent, outcomes",
    });
    return finish(out);
  }
  const record = raw as Record<string, unknown>;
  const isAction = !("outcomes" in record) && Array.isArray(record["steps"]);
  out.kind = isAction ? "action" : "spec";
  const lineOf = (path: Array<string | number>): number | undefined =>
    nodeLine(doc, lineCounter, path);

  // 3. Missing step ids (specs only; fixable).
  if (!isAction) {
    const missing = missingIds(record);
    const applied = new Set<number>();
    if (missing.length > 0 && opts.fix) {
      const fixed = addStepIds(text, doc, record);
      if (fixed) {
        text = fixed.text;
        await writeFile(absPath, text);
        out.fixed += fixed.added;
        for (const index of fixed.indices) applied.add(index);
        lineCounter = new LineCounter();
        doc = parseDocument(text, { lineCounter, uniqueKeys: false });
      }
    }
    for (const index of missing) {
      findings.push({
        rule: "missing-step-id",
        severity: "warning",
        where: `steps[${index}]`,
        ...withLine(lineOf(["steps", index])),
        message: `steps[${index}] (${stepKindOf(
          (record["steps"] as Array<Record<string, unknown>>)[index] ?? {},
        )}) has no id; ids let runs, heal and fromSpec setups name the step`,
        fix: {
          description: `add a snake_case id derived from the step${
            opts.fix && !applied.has(index)
              ? " (not applied: the steps use YAML anchors/aliases or a flow/alias form --fix cannot edit safely; add it by hand)"
              : ""
          }`,
          safe: true,
          applied: applied.has(index),
        },
      });
    }
  }

  // 3b. Authored step ids must be unique across the whole step tree
  //     (control-flow blocks included): results, events and evidence files
  //     are keyed by id.
  findings.push(...duplicateIdFindings(record, lineOf));

  // 4. Schema, explained per step.
  const schemaFindings = isAction
    ? schemaIssues(ReusableActionSchema, record, true)
    : schemaIssues(SpecSchema, record, false);
  for (const finding of schemaFindings) {
    findings.push({
      ...finding,
      ...withLine(finding.where ? lineOf(pathOf(finding.where)) : undefined),
    });
  }

  // 5. Static rules on the document as written.
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  findings.push(...evalFindings(record, absPath, lineOf));
  findings.push(...absolutePathFindings(record, lineOf));
  findings.push(...shellArgFindings(record, lineOf));
  if (!isAction) {
    findings.push(...coldStartFindings(record, lineOf));
  }

  if (schemaFindings.length > 0 || isAction) {
    // Secrets need only the document; var resolution needs a valid spec.
    findings.push(...secretFindings(record, env, [], lineOf));
    return finish(out);
  }

  // 6. Per-environment resolution: vars, actions, files, residual
  //    placeholders, verifier fixtures.
  const envList: Array<string | undefined> =
    opts.envs && opts.envs.length > 0 ? [...opts.envs] : [undefined];
  let secretNames: string[] = [];
  let firstParsed: ParseResult | undefined;
  let projectRoot = dirname(absPath);
  for (const envName of envList) {
    try {
      const runtime = await resolveSpecRuntimeContext(absPath, {
        cwd,
        ...(envName !== undefined ? { envOverride: envName } : {}),
        ...(opts.config !== undefined ? { configPath: opts.config } : {}),
        ...(opts.vars && Object.keys(opts.vars).length > 0
          ? { vars: opts.vars }
          : {}),
        env,
      });
      out.envs.push(runtime.envName);
      secretNames = [
        ...(runtime.secrets?.required ?? []),
        ...(runtime.secrets?.keys ?? []),
      ];
      const parsed = await parseSpec(absPath, {
        vars: runtime.vars,
        configDir: runtime.configDir,
        env,
        ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
      });
      if (!firstParsed) {
        firstParsed = parsed;
        projectRoot = runtime.configPath
          ? dirname(runtime.configPath)
          : dirname(parsed.path);
        // E12: the share of page evals, against the export targets' limits.
        const evalRatio = evalStepRatio(parsed.resolved);
        for (const [targetName, target] of Object.entries(
          runtime.config?.export?.targets ?? {},
        )) {
          if (
            target.maxEvalRatio === undefined ||
            !exceedsEvalRatio(evalRatio, target.maxEvalRatio)
          ) {
            continue;
          }
          findings.push({
            rule: "eval-ratio",
            severity: "warning",
            message: `${formatEvalRatio(evalRatio)} are page eval, over export target "${targetName}" maxEvalRatio ${target.maxEvalRatio} (${Math.round(target.maxEvalRatio * 100)}%): \`cairn export playwright --target ${targetName}\` refuses this spec; typed steps replay, heal and export, an eval does not`,
          });
        }
        const auditFiles: Array<{ path: string; text: string }> = [
          { path: specPath, text },
        ];
        for (const action of parsed.actionsByName.values()) {
          auditFiles.push({ path: action.path, text: action.rawSource });
        }
        for (const ref of auditPlaceholderReferences(auditFiles, {
          ...(runtime.secrets?.required
            ? { secretsRequired: runtime.secrets.required }
            : {}),
          env,
        })) {
          findings.push({
            rule: "unresolved-reference",
            severity: "error",
            ...(ref.file !== specPath ? { file: ref.file } : {}),
            message: `${ref.token}: ${ref.message}`,
          });
        }
      }
      findings.push(
        ...residualPlaceholderFindings(parsed, runtime.envName, lineOf),
      );
    } catch (e) {
      findings.push(...substitutedSchemaFindings(e, envName, lineOf));
      if (!(e instanceof ZodError))
        findings.push(resolutionFinding(e, envName));
    }
  }
  // Findings repeated across envs (same rule + message) are reported once.
  dedupe(findings);

  if (firstParsed) {
    for (const f of auditFileReferences(firstParsed, { projectRoot })) {
      findings.push({
        rule: f.kind,
        severity: f.severity,
        where: f.where,
        ...(f.file !== absPath ? { file: f.file } : {}),
        message: f.message,
        ...(f.kind === "absolute-path"
          ? {
              fix: {
                description:
                  "use a path relative to the file, or ${config.dir}/… for shared fixtures",
                safe: false,
              },
            }
          : {}),
      });
    }
    findings.push(...preconditionCwdFindings(firstParsed, absPath, lineOf));
    findings.push(...(await fixtureFindings(firstParsed, absPath, lineOf)));
  }
  findings.push(...secretFindings(record, env, secretNames, lineOf));
  dedupe(findings);
  return finish(out);
}

function finish(out: FileLintResult): FileLintResult {
  const errors = out.findings.some((f) => f.severity === "error");
  const warnings = out.findings.some((f) => f.severity === "warning");
  out.status = errors ? "errors" : warnings ? "warnings" : "ok";
  return out;
}

function withLine(line: number | undefined): { line?: number } {
  return line !== undefined ? { line } : {};
}

function dedupe(findings: LintFinding[]): void {
  const seen = new Set<string>();
  for (let i = 0; i < findings.length; i++) {
    const f = findings[i]!;
    const key = `${f.rule}\u0000${f.where ?? ""}\u0000${f.message}`;
    if (seen.has(key)) {
      findings.splice(i, 1);
      i--;
    } else {
      seen.add(key);
    }
  }
}

/* ----- YAML positions ----- */

/** `steps[3].click.selector` → ["steps", 3, "click", "selector"]. */
function pathOf(where: string): Array<string | number> {
  const out: Array<string | number> = [];
  for (const part of where.split(".")) {
    const m = /^([^[]*)((?:\[\d+\])*)$/.exec(part);
    if (!m) {
      out.push(part);
      continue;
    }
    if (m[1]) out.push(m[1]);
    for (const index of m[2]!.matchAll(/\[(\d+)\]/g))
      out.push(Number(index[1]));
  }
  return out;
}

function nodeLine(
  doc: Document,
  counter: LineCounter,
  path: Array<string | number>,
): number | undefined {
  for (let n = path.length; n > 0; n--) {
    const node = doc.getIn(path.slice(0, n), true) as
      | { range?: [number, number, number] }
      | undefined;
    if (node && typeof node === "object" && node.range) {
      return counter.linePos(node.range[0]).line;
    }
  }
  return undefined;
}

/* ----- unquoted # ----- */

interface HashHit {
  line: number;
  /** Offset of the value in the file. */
  offset: number;
  key: string;
  value: string;
  /** Inside a flow map (`{ … }`), where the comment swallows the `}`. */
  flow?: boolean;
  /** Column (0-based) where the key starts on its line. */
  column?: number;
}

/** `selector:  ` → `selector`. */
function keyName(key: string): string {
  return key.replace(/\s*:\s*$/, "").trim();
}

/** Pairs of a document by the 1-based line their key starts on. */
function pairsByLine(doc: Document, counter: LineCounter): Map<number, Pair[]> {
  const out = new Map<number, Pair[]>();
  visit(doc, {
    Pair(_key, pair) {
      const key = pair.key;
      if (!isScalar(key) || !key.range) return;
      const line = counter.linePos(key.range[0]).line;
      out.set(line, [...(out.get(line) ?? []), pair as Pair]);
    },
  });
  return out;
}

function isEmptyValue(value: unknown): boolean {
  return (
    value === null ||
    value === undefined ||
    (isScalar(value) && value.value === null)
  );
}

/**
 * `selector: #save` — YAML reads ` #…` as a comment, so the value is null
 * (and in a flow map the comment also swallows the closing `}`). A `#…`
 * comment after a key whose value is a nested block (`click:  # primary`
 * followed by an indented map) is a real comment and not reported.
 */
export function findUnquotedHashes(text: string): HashHit[] {
  const candidates: HashHit[] = [];
  let offset = 0;
  const lines = text.split("\n");
  let inBlockScalar: number | undefined;
  for (const [i, line] of lines.entries()) {
    const lineStart = offset;
    offset += line.length + 1;
    const indent = line.length - line.trimStart().length;
    if (inBlockScalar !== undefined) {
      if (line.trim() === "" || indent > inBlockScalar) continue;
      inBlockScalar = undefined;
    }
    if (/:\s*[|>][-+0-9]*\s*$/.test(line)) {
      inBlockScalar = indent;
      continue;
    }
    if (line.trimStart().startsWith("#")) continue;
    const m = HASH_RE.exec(line);
    if (!m) continue;
    const keyStart = m.index + m[1]!.length;
    const valueStart = keyStart + m[2]!.length;
    let value = m[3]!;
    const before = line.slice(0, valueStart);
    const inFlow =
      (before.match(/\{/g)?.length ?? 0) > (before.match(/\}/g)?.length ?? 0);
    if (inFlow) {
      const end = /\s*(?:,\s*[\w-]+\s*:|\s*\}\s*,?\s*$|\s*\})/.exec(value);
      if (end) value = value.slice(0, end.index);
    } else {
      const comment = /\s{2,}#/.exec(value);
      if (comment) value = value.slice(0, comment.index);
    }
    value = value.trimEnd();
    if (!value) continue;
    candidates.push({
      line: i + 1,
      offset: lineStart + valueStart,
      key: m[2]!,
      value,
      ...(inFlow ? { flow: true } : {}),
      column: keyStart,
    });
  }
  if (candidates.length === 0) return candidates;

  // Keep only the keys whose value really is empty.
  const counter = new LineCounter();
  const doc = parseDocument(text, { lineCounter: counter, uniqueKeys: false });
  if (doc.errors.length === 0) {
    const pairs = pairsByLine(doc, counter);
    return candidates.filter((hit) =>
      (pairs.get(hit.line) ?? []).some(
        (pair) =>
          isScalar(pair.key) &&
          String(pair.key.value) === keyName(hit.key) &&
          isEmptyValue(pair.value),
      ),
    );
  }
  // The document does not parse (a flow-map comment swallowed a `}`): a
  // block-style key followed by a deeper-indented line holds a nested value.
  return candidates.filter(
    (hit) => hit.flow || !nestedBelow(lines, hit.line - 1, hit.column ?? 0),
  );
}

/** True when the next content line below `index` is indented past `column`. */
function nestedBelow(
  lines: readonly string[],
  index: number,
  column: number,
): boolean {
  for (const line of lines.slice(index + 1)) {
    const trimmed = line.trimStart();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    return line.length - trimmed.length > column;
  }
  return false;
}

/**
 * Quote each hit's value. Returns undefined (nothing to write) unless the
 * result parses and differs from the original only in those values.
 */
export function quoteHashes(
  text: string,
  hits: readonly HashHit[],
): string | undefined {
  let out = text;
  for (const hit of [...hits].toSorted((a, b) => b.offset - a.offset)) {
    out =
      out.slice(0, hit.offset) +
      JSON.stringify(hit.value) +
      out.slice(hit.offset + hit.value.length);
  }
  const counter = new LineCounter();
  const after = parseDocument(out, { lineCounter: counter, uniqueKeys: false });
  if (after.errors.length > 0) return undefined;
  // Every quoted value landed where its key is, as that string.
  const pairs = pairsByLine(after, counter);
  const quoted: Pair[] = [];
  for (const hit of hits) {
    const pair = (pairs.get(hit.line) ?? []).find(
      (p) =>
        isScalar(p.key) &&
        String(p.key.value) === keyName(hit.key) &&
        isScalar(p.value) &&
        p.value.value === hit.value,
    );
    if (!pair) return undefined;
    quoted.push(pair);
  }
  // Clearing those values again must give the original document.
  const original = parseDocument(text, { uniqueKeys: false });
  if (original.errors.length === 0) {
    for (const pair of quoted) pair.value = null;
    if (!isDeepStrictEqual(after.toJS(), original.toJS())) return undefined;
  }
  return out;
}

/* ----- step ids ----- */

function missingIds(record: Record<string, unknown>): number[] {
  const steps = record["steps"];
  if (!Array.isArray(steps)) return [];
  return steps
    .map((step, i) =>
      step && typeof step === "object" && !("id" in step) ? i : -1,
    )
    .filter((i) => i >= 0);
}

/** True when the document uses YAML anchors or aliases anywhere. */
function usesAnchors(doc: Document): boolean {
  let found = false;
  const check = (node: { anchor?: string | undefined }): symbol | undefined => {
    if (node.anchor) {
      found = true;
      return visit.BREAK;
    }
    return undefined;
  };
  visit(doc, {
    Alias() {
      found = true;
      return visit.BREAK;
    },
    Map: (_key, node) => check(node),
    Seq: (_key, node) => check(node),
    Scalar: (_key, node) => check(node),
  });
  return found;
}

/**
 * Insert generated ids into the source text (comments and quoting stay
 * byte-identical elsewhere). Returns undefined when the result would differ
 * from the original in anything but the added ids, when the ids would not
 * be unique, or when the document uses anchors/aliases (one insertion into
 * an anchored step would give every alias of it the same id).
 */
export function addStepIds(
  text: string,
  doc: Document,
  record: Record<string, unknown>,
): { text: string; added: number; indices: number[] } | undefined {
  const stepsNode = doc.get("steps", true);
  if (!isSeq(stepsNode) || usesAnchors(doc)) return undefined;
  const steps = record["steps"] as Array<Record<string, unknown>>;
  const withIds = assignStepIds(steps).steps;
  const counter = new LineCounter();
  parseDocument(text, { lineCounter: counter });
  const edits: Array<{ offset: number; insert: string }> = [];
  const indices: number[] = [];
  for (const [i, item] of stepsNode.items.entries()) {
    const step = steps[i];
    if (!step || "id" in step || !isMap(item) || !item.range) continue;
    const id = withIds[i]!["id"] as string;
    const map = item as YAMLMap;
    if (map.flow) {
      edits.push({ offset: map.range![0] + 1, insert: ` id: ${id},` });
    } else {
      const column = counter.linePos(map.range![0]).col - 1;
      edits.push({
        offset: map.range![0],
        insert: `id: ${id}\n${" ".repeat(column)}`,
      });
    }
    indices.push(i);
  }
  if (edits.length === 0) return undefined;
  let out = text;
  for (const edit of edits.toSorted((a, b) => b.offset - a.offset)) {
    out = out.slice(0, edit.offset) + edit.insert + out.slice(edit.offset);
  }
  // Safety: the only difference must be the ids.
  const after = parseDocument(out);
  if (after.errors.length > 0) return undefined;
  const js = after.toJS() as Record<string, unknown>;
  const stripped = {
    ...js,
    steps: (js["steps"] as Array<Record<string, unknown>>).map((step, i) => {
      if ("id" in (steps[i] ?? {})) return step;
      const { id: _id, ...rest } = step;
      return rest;
    }),
  };
  if (!isDeepStrictEqual(stripped, record)) return undefined;
  const ids = (js["steps"] as Array<Record<string, unknown>>)
    .map((step) => step?.["id"])
    .filter((id) => id !== undefined);
  if (new Set(ids).size !== ids.length) return undefined;
  return { text: out, added: edits.length, indices };
}

/* ----- schema ----- */

const STEP_SCHEMAS: Record<string, ZodTypeAny> = {
  open: OpenStepSchema,
  click: ClickStepSchema,
  hover: HoverStepSchema,
  focus: FocusStepSchema,
  fill: FillStepSchema,
  type: TypeStepSchema,
  select: SelectStepSchema,
  upload: UploadStepSchema,
  download: DownloadStepSchema,
  transform: TransformStepSchema,
  wait: WaitStepSchema,
  request: RequestStepSchema,
  press: PressStepSchema,
  scroll: ScrollStepSchema,
  snapshot: SnapshotStepSchema,
  use: UseStepSchema,
  batch: BatchStepSchema,
  eval: EvalStepSchema,
  monitor: MonitorStepSchema,
  repeat: RepeatStepSchema,
  if: IfStepSchema,
  // F15 widget kit.
  set: SetStepSchema,
  check: CheckStepSchema,
  uncheck: UncheckStepSchema,
  choose: ChooseStepSchema,
  form: FormStepSchema,
};

function issuePath(
  prefix: string,
  path: ReadonlyArray<string | number>,
): string {
  let out = prefix;
  for (const part of path) {
    out += typeof part === "number" ? `[${part}]` : out ? `.${part}` : part;
  }
  return out;
}

/**
 * Replace each union failure by the issues of the branch the value was
 * meant for: branches rejected only on their discriminating literal
 * (`by: role` vs `by: label`) are dropped, then the branch with the fewest
 * issues wins.
 */
function expandUnionIssues(issues: readonly ZodIssue[], depth = 0): ZodIssue[] {
  const out: ZodIssue[] = [];
  for (const issue of issues) {
    if (issue.code !== "invalid_union" || depth > 6) {
      out.push(issue);
      continue;
    }
    const branches = issue.unionErrors
      .map((error) => error.issues)
      .filter((branch) => !branch.some((i) => i.code === "invalid_literal"));
    const pool =
      branches.length > 0
        ? branches
        : issue.unionErrors.map((error) => error.issues);
    const best = pool.toSorted((a, b) => a.length - b.length)[0];
    if (!best || best.length === 0) {
      out.push(issue);
      continue;
    }
    out.push(...expandUnionIssues(best, depth + 1));
  }
  return out;
}

function issueText(issue: ZodIssue): string {
  if (issue.code === "unrecognized_keys") {
    return `unknown key(s) ${issue.keys.map((k) => `"${k}"`).join(", ")}`;
  }
  if (issue.code === "invalid_type" && issue.received === "null") {
    return "is empty (null) — an unquoted # starts a YAML comment; quote the value";
  }
  return issue.message;
}

/**
 * Schema problems as a few readable findings: each failing step is checked
 * against the schema of its own kind (instead of a dump of every union
 * branch), other issues are listed by path.
 */
function schemaIssues(
  schema: ZodTypeAny,
  record: Record<string, unknown>,
  isAction: boolean,
): LintFinding[] {
  const parsed = schema.safeParse(record);
  if (parsed.success) return [];
  const out: LintFinding[] = [];
  const steps = Array.isArray(record["steps"]) ? record["steps"] : [];
  const badSteps = new Set<number>();
  for (const [i, step] of steps.entries()) {
    if (StepSchema.safeParse(step).success) continue;
    badSteps.add(i);
    const where = `steps[${i}]`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      out.push(schemaFinding(where, "must be a mapping like { click: … }"));
      continue;
    }
    const kind = stepKindOf(step as Record<string, unknown>);
    const kindSchema = STEP_SCHEMAS[kind];
    if (!kindSchema) {
      out.push(
        schemaFinding(
          where,
          `unknown step kind "${kind}" (steps: ${Object.keys(STEP_SCHEMAS).join(", ")})`,
        ),
      );
      continue;
    }
    const own = kindSchema.safeParse(step);
    const issues = own.success
      ? // The kind parses alone but the union refinement failed.
        (StepSchema.safeParse(step).error?.issues ?? []).filter(
          (issue) => issue.code === "custom",
        )
      : expandUnionIssues(own.error.issues);
    for (const issue of issues.slice(0, 3)) {
      out.push(
        schemaFinding(
          issuePath(where, issue.path),
          `${kind} step: ${issueText(issue)}`,
        ),
      );
    }
  }
  for (const issue of expandUnionIssues(parsed.error.issues)) {
    const top = issue.path[0];
    if (top === "steps" && typeof issue.path[1] === "number") {
      if (badSteps.has(issue.path[1])) continue;
    }
    if (out.length >= 12) break;
    out.push(
      schemaFinding(
        issuePath("", issue.path) || (isAction ? "action" : "spec"),
        issueText(issue),
      ),
    );
  }
  return out;
}

function schemaFinding(where: string, message: string): LintFinding {
  return {
    rule: "schema",
    severity: "error",
    where,
    message: `${where}: ${message}`,
  };
}

/* ----- resolution failures ----- */

/**
 * The spec validated as written but not after ${…} substitution: usually a
 * plain whole-value placeholder that took its value's type (a number into a
 * string field), or an action whose vars break its steps.
 */
function substitutedSchemaFindings(
  e: unknown,
  envName: string | undefined,
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  if (!(e instanceof ZodError)) return [];
  const at = envName !== undefined ? ` in env ${envName}` : "";
  return expandUnionIssues(e.issues)
    .slice(0, 5)
    .map((issue) => {
      const where = issuePath("", issue.path) || "spec";
      const typed =
        issue.code === "invalid_type" &&
        (issue.received === "number" || issue.received === "boolean");
      return {
        rule: "schema" as const,
        severity: "error" as const,
        ...(envName !== undefined ? { env: envName } : {}),
        where,
        ...withLine(lineOf(issue.path as Array<string | number>)),
        message: `${where}: ${issueText(issue)} after placeholder substitution${at}${
          typed
            ? ' — an unquoted whole-value placeholder takes its value\'s type; quote it ("${vars.name}")'
            : ""
        }`,
      };
    });
}

function resolutionFinding(
  e: unknown,
  envName: string | undefined,
): LintFinding {
  const env = envName !== undefined ? { env: envName } : {};
  const at = envName !== undefined ? ` (env ${envName})` : "";
  if (e instanceof MissingTemplateVariableError) {
    return {
      rule: "unresolved-var",
      severity: "error",
      ...env,
      message: `\${vars.${e.variable}} is not defined${at}: add it to the config's top-level vars: or environments.<env>.vars, the spec's vars:, or the action's vars:, or pass --var ${e.variable}=…`,
    };
  }
  if (e instanceof UnknownEnvironmentError) {
    return {
      rule: "unknown-env",
      severity: "error",
      ...env,
      message: e.message,
    };
  }
  if (e instanceof UnresolvedActionError) {
    return {
      rule: "unresolved-action",
      severity: "error",
      ...env,
      message: `${e.message} — add the action file to imports:`,
    };
  }
  if (e instanceof ContractHashMismatchError) {
    return {
      rule: "contract-hash-mismatch",
      severity: "error",
      ...env,
      message: `${e.message} — intent/outcomes changed; show the diff and re-stamp with cairn spec verify --stamp`,
    };
  }
  return {
    rule: "config",
    severity: "error",
    ...env,
    message: `${(e as Error).message}${at}`,
  };
}

/* ----- residual placeholders ----- */

/** `${ns.x}` survives substitution only for runtime namespaces or typos. */
const CAIRN_PLACEHOLDER = /\$\{[A-Za-z_][A-Za-z0-9_]*\.[^}]*\}/g;

function residualPlaceholderFindings(
  parsed: ParseResult,
  envName: string,
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  const out: LintFinding[] = [];
  const commands = parsed.resolved.preconditions?.commands ?? [];
  for (const [i, command] of commands.entries()) {
    for (const field of ["run", "cwd"] as const) {
      const value = command[field];
      if (typeof value !== "string") continue;
      for (const m of value.matchAll(CAIRN_PLACEHOLDER)) {
        out.push({
          rule: "residual-placeholder",
          severity: "error",
          env: envName,
          where: `preconditions.commands[${i}].${field}`,
          ...withLine(lineOf(["preconditions", "commands", i, field])),
          message: `preconditions.commands[${i}].${field}: ${m[0]} is still a placeholder after substitution and would reach the shell literally (preconditions run before any step, so \${requests.*}/\${evals.*} do not exist yet; check the namespace spelling)`,
        });
      }
    }
  }
  const envBlock = parsed.resolved.preconditions?.env ?? {};
  for (const [key, value] of Object.entries(envBlock)) {
    if (typeof value !== "string") continue;
    for (const m of value.matchAll(CAIRN_PLACEHOLDER)) {
      out.push({
        rule: "residual-placeholder",
        severity: "error",
        env: envName,
        where: `preconditions.env.${key}`,
        message: `preconditions.env.${key}: ${m[0]} would reach the commands' environment literally`,
      });
    }
  }
  return out;
}

/* ----- cold start ----- */

const ECHO_ONLY = /^\s*(?:echo|printf|true|:)(?:\s|$)/;

function coldStartFindings(
  record: Record<string, unknown>,
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  const parsed = SpecSchema.safeParse(record);
  if (!parsed.success) return [];
  const spec = parsed.data;
  if (spec.coldStart === "guest") return [];
  const commands = spec.preconditions?.commands ?? [];
  const hasImports = (spec.imports?.length ?? 0) > 0;
  const hasResume = !!spec.session?.resume;
  if (
    !hasImports &&
    !hasResume &&
    !usesLogin(spec) &&
    commands.length > 0 &&
    commands.every((c) => ECHO_ONLY.test(c.run))
  ) {
    return [
      {
        rule: "cold-start-echo-only",
        // The cold-start run decides whether the flow really needs a
        // session; lint says the contract is satisfied in name only.
        severity: "warning",
        where: "preconditions.commands",
        ...withLine(lineOf(["preconditions", "commands"])),
        message:
          "the cold-start contract is satisfied only by preconditions that echo — they set nothing up. A public flow says so with coldStart: guest; a flow that needs a session or data must set it up",
        fix: {
          description:
            "use: the project's login action (imports + use:), session.resume <checkpoint>, a real setup command, or coldStart: guest for a public flow",
          safe: false,
        },
      },
    ];
  }
  const warning = coldStartLint(spec);
  return warning
    ? [
        {
          rule: "cold-start-missing",
          severity: "warning",
          message: warning,
          fix: {
            description:
              "imports + use: <login action>, use: login (environments.<env>.auth), session.resume, preconditions.commands, or coldStart: guest",
            safe: false,
          },
        },
      ]
    : [];
}

/* ----- evals with typed equivalents ----- */

interface EvalPattern {
  test: (source: string) => boolean;
  typed: string;
  suggestion: string;
}

const EVAL_PATTERNS: EvalPattern[] = [
  {
    test: (s) =>
      /\blocation\.(?:assign|replace)\s*\(|\blocation(?:\.href)?\s*=(?!=)/.test(
        s,
      ),
    typed: "open",
    suggestion: "an open: step (open: { path, waitUntil: networkidle })",
  },
  {
    test: (s) =>
      /\bfetch\s*\([^)]*(?:login|log-in|signin|sign-in|auth|session|token)/i.test(
        s,
      ),
    typed: "request",
    suggestion:
      "use: login (config environments.<env>.auth: login, alreadyAuthenticated, after with the captured bearer, hydrate) or the project's login action, or a request: step (assign: + ${requests.<name>.body.X})",
  },
  {
    test: (s) => /\bfetch\s*\(|XMLHttpRequest/.test(s),
    typed: "request",
    suggestion:
      "a request: step (method, url, body, expectStatus, assign; credentials: omit, until polling, retry, capture, matrix)",
  },
  {
    test: (s) => /\.click\s*\(\s*\)/.test(s),
    typed: "click",
    suggestion:
      "a click: step with a role/label/text/testid locator (click.until when the click must take effect, optional: true when the control may be absent, fallback: dispatch or dispatch: true when an overlay swallows the pointer), or choose/check for a radio or checkbox",
  },
  {
    test: (s) =>
      /\.value\s*=(?!=)|nativeInputValueSetter|getOwnPropertyDescriptor\([^)]*(?:HTMLInputElement|HTMLTextAreaElement)/.test(
        s,
      ),
    typed: "fill",
    suggestion:
      "a fill: step (it re-reads the value and retries when hydration wipes it; mode: set writes through the native setter without focus or keys), or set/form for a custom control (picker, calendar, autocomplete, pills)",
  },
  {
    test: (s) =>
      /\bsetInterval\s*\(/.test(s) ||
      (/\b(?:while|for)\s*\(/.test(s) &&
        /setTimeout|new Promise|sleep\s*\(/.test(s)),
    typed: "wait",
    suggestion:
      "a wait: step (text | notText | selector | url | value | app, any/all, optional), click.until, repeat with until, or request.until for an API poll — bounded and diagnosable",
  },
  {
    test: (s) =>
      /\blocation\.(?:pathname|href)\b\s*(?:===|==|!==|\.includes|\.startsWith)/.test(
        s,
      ),
    typed: "wait",
    suggestion: "wait: { url: { includes | equals | pattern } }",
  },
];

function evalFindings(
  record: Record<string, unknown>,
  specPath: string,
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  const out: LintFinding[] = [];
  for (const { step, path } of rawStepTree(record["steps"], ["steps"])) {
    const body = step["eval"];
    if (!body || typeof body !== "object") continue;
    const at = issuePath("", path);
    const e = body as Record<string, unknown>;
    let source = typeof e["js"] === "string" ? e["js"] : undefined;
    let from = "eval.js";
    if (source === undefined && typeof e["file"] === "string") {
      const file = e["file"];
      if (!file.includes("${")) {
        const abs = isAbsolute(file) ? file : resolve(dirname(specPath), file);
        if (existsSync(abs)) {
          try {
            // Bounded read; eval files are small scripts.
            source = readFileSync(abs, "utf8").slice(0, 200_000);
            from = `eval.file ${file}`;
          } catch {
            source = undefined;
          }
        }
      }
    }
    if (source === undefined) continue;
    const seen = new Set<string>();
    for (const pattern of EVAL_PATTERNS) {
      if (seen.has(pattern.typed) || !pattern.test(source)) continue;
      seen.add(pattern.typed);
      out.push({
        rule: "eval-typed-equivalent",
        severity: "warning",
        where: `${at}.eval`,
        ...withLine(lineOf([...path, "eval"])),
        message: `${at} ${from} does what a typed ${pattern.typed} step does; use ${pattern.suggestion} — typed steps replay, heal and export to Playwright, an eval string does not`,
        fix: { description: `replace with ${pattern.suggestion}`, safe: false },
      });
    }
  }
  return out;
}

/* ----- absolute host paths ----- */

const HOST_PATH =
  /(?:^|[\s"'=:(])((?:\/Users|\/home)\/[^/\s"']+\/[^\s"']*|[A-Za-z]:\\Users\\[^\s"']+|~\/[^\s"']+)/;

function absolutePathFindings(
  record: Record<string, unknown>,
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  const out: LintFinding[] = [];
  walkStrings(record, [], (value, path) => {
    const key = path.at(-1);
    if (key === "contractHash" || key === "intent" || key === "description") {
      return;
    }
    const m = HOST_PATH.exec(value);
    if (!m) return;
    const where = issuePath("", path);
    out.push({
      rule: "absolute-path",
      severity: "warning",
      where,
      ...withLine(lineOf(path)),
      message: `${where}: ${m[1]} is a path on one machine; the spec breaks for anyone else (and in CI)`,
      fix: {
        description:
          "a path relative to the file, ${config.dir}/… (config directory), or an env placeholder",
        safe: false,
      },
    });
  });
  return out;
}

/**
 * A `run:` shell command that reads `$1…$9` the step never passes: the
 * string form has no `args`, and an object form may pass fewer than it
 * reads, so the command sees an empty string (`delete "$1"` deletes "").
 */
function shellArgFindings(
  record: Record<string, unknown>,
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  const out: LintFinding[] = [];
  const check = (item: unknown, path: Array<string | number>): void => {
    if (!item || typeof item !== "object") return;
    const run = (item as Record<string, unknown>)["run"];
    let shell: string | undefined;
    let argCount = 0;
    if (typeof run === "string") {
      shell = run;
    } else if (run && typeof run === "object") {
      const object = run as Record<string, unknown>;
      if (typeof object["shell"] !== "string") return;
      shell = object["shell"];
      argCount = Array.isArray(object["args"]) ? object["args"].length : 0;
    }
    if (shell === undefined) return;
    const used = [...shell.matchAll(/\$\{?([1-9])\b/g)].map((m) =>
      Number(m[1]),
    );
    const highest = Math.max(0, ...used);
    if (highest <= argCount) return;
    const where = issuePath("", [...path, "run"]);
    out.push({
      rule: "shell-arg-unset",
      severity: "warning",
      where,
      ...withLine(lineOf([...path, "run"])),
      message: `${where}: the command reads $${highest} but the step passes ${
        argCount === 0
          ? "no args"
          : `${argCount} arg${argCount === 1 ? "" : "s"}`
      }, so it is an empty string`,
      fix: {
        description:
          'use the object form `run: { shell: \'…"$1"…\', args: ["${…}"] }`, or splice the value into the command',
        safe: false,
      },
    });
  };
  const list = (value: unknown, path: Array<string | number>): void => {
    for (const entry of rawStepTree(value, path)) check(entry.step, entry.path);
  };
  list(record["steps"], ["steps"]);
  const teardown = record["teardown"];
  if (Array.isArray(teardown)) list(teardown, ["teardown"]);
  else if (teardown && typeof teardown === "object") {
    list((teardown as Record<string, unknown>)["steps"], ["teardown", "steps"]);
  }
  return out;
}

/* ----- secrets ----- */

function secretFindings(
  record: Record<string, unknown>,
  env: Record<string, string | undefined>,
  secretNames: readonly string[],
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  const out: LintFinding[] = [];
  const secrets = knownSecrets(env, secretNames);
  walkStrings(record, [], (value, path) => {
    const where = issuePath("", path);
    const key = String(path.at(-1) ?? "");
    for (const secret of secrets) {
      if (value.includes(secret.value)) {
        out.push({
          rule: "literal-secret",
          severity: "error",
          where,
          ...withLine(lineOf(path)),
          message: `${where} holds the value of a secret literally; write ${secret.placeholder}`,
          fix: {
            description: `replace the literal with ${secret.placeholder}`,
            safe: false,
          },
        });
        return;
      }
    }
    if (isPlaceholder(value) || key === "contractHash" || key === "id") return;
    const parentKey = String(path.at(-2) ?? "");
    if (
      (parentKey === "vars" ||
        parentKey === "fixtures" ||
        parentKey === "env") &&
      isSensitiveName(key) &&
      value.length > 0
    ) {
      out.push({
        rule: "literal-secret",
        // A fixture key can name a credential without holding one.
        severity: parentKey === "fixtures" ? "warning" : "error",
        where,
        ...withLine(lineOf(path)),
        message: `${where}: a credential ("${key}") written as a literal; use \${secrets.${key}} (config secrets) or \${env.NAME}`,
        fix: {
          description: "replace the literal with a placeholder",
          safe: false,
        },
      });
      return;
    }
    if (looksLikeSecretValue(value)) {
      out.push({
        rule: "literal-secret",
        severity: "warning",
        where,
        ...withLine(lineOf(path)),
        message: `${where} looks like a token or key; if it is a credential, write it as \${secrets.NAME} or \${env.NAME}`,
      });
    }
  });
  for (const { step, path } of rawStepTree(record["steps"], ["steps"])) {
    const typed = typedValueOf(step);
    if (
      typed &&
      typed.value.length > 0 &&
      !isPlaceholder(typed.value) &&
      looksLikePasswordField(typed.locator) &&
      !secrets.some((s) => typed.value.includes(s.value))
    ) {
      // A guess from the field's name (the input type is not in the spec):
      // a warning. A known secret's value above is the error.
      out.push({
        rule: "literal-secret",
        severity: "warning",
        where: `${issuePath("", path)}.${typed.kind}.value`,
        ...withLine(lineOf([...path, typed.kind, "value"])),
        message: `${issuePath("", path)} types a literal into what looks like a password-type field; if it is a credential, write \${secrets.NAME} (config secrets) or \${env.NAME}`,
        fix: {
          description:
            "a credential: ${secrets.NAME} or ${env.NAME}; ordinary test data: keep it, or move it to ${vars.X}",
          safe: false,
        },
      });
    }
  }
  return out;
}

/**
 * Every step of a raw (as written) step list with its document path,
 * control-flow blocks included: `repeat.steps`, `if.then`, `if.else`.
 */
function rawStepTree(
  list: unknown,
  base: Array<string | number>,
): Array<{ step: Record<string, unknown>; path: Array<string | number> }> {
  const out: Array<{
    step: Record<string, unknown>;
    path: Array<string | number>;
  }> = [];
  if (!Array.isArray(list)) return out;
  list.forEach((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return;
    const step = item as Record<string, unknown>;
    const path = [...base, index];
    out.push({ step, path });
    const repeat = step["repeat"];
    if (repeat && typeof repeat === "object") {
      out.push(
        ...rawStepTree((repeat as Record<string, unknown>)["steps"], [
          ...path,
          "repeat",
          "steps",
        ]),
      );
    }
    const branch = step["if"];
    if (branch && typeof branch === "object") {
      for (const key of ["then", "else"] as const) {
        out.push(
          ...rawStepTree((branch as Record<string, unknown>)[key], [
            ...path,
            "if",
            key,
          ]),
        );
      }
    }
  });
  return out;
}

/**
 * An authored id used by more than one step. Inside control-flow blocks it
 * is an error (two nested loops reusing an id write the same evidence file
 * stems, and run results / Studio rows become ambiguous); between top-level
 * steps only, a warning (earlier specs may already do it).
 */
function duplicateIdFindings(
  record: Record<string, unknown>,
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  const byId = new Map<string, Array<Array<string | number>>>();
  for (const { step, path } of rawStepTree(record["steps"], ["steps"])) {
    const id = step["id"];
    if (typeof id !== "string" || id === "") continue;
    const paths = byId.get(id) ?? [];
    paths.push(path);
    byId.set(id, paths);
  }
  const out: LintFinding[] = [];
  for (const [id, paths] of byId) {
    if (paths.length < 2) continue;
    const nested = paths.some((path) => path.length > 2);
    const where = paths.map((path) => issuePath("", path));
    out.push({
      rule: "duplicate-step-id",
      severity: nested ? "error" : "warning",
      where: where[1]!,
      ...withLine(lineOf([...paths[1]!, "id"])),
      message: `step id ${JSON.stringify(id)} is used by ${where.join(", ")}; ids key step results, events and evidence files — give each step its own id`,
      fix: { description: "rename all but one of these ids", safe: false },
    });
  }
  return out;
}

function walkStrings(
  node: unknown,
  path: Array<string | number>,
  onString: (value: string, path: Array<string | number>) => void,
): void {
  if (typeof node === "string") {
    onString(node, path);
    return;
  }
  if (Array.isArray(node)) {
    node.forEach((item, i) => walkStrings(item, [...path, i], onString));
    return;
  }
  if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      walkStrings(value, [...path, key], onString);
    }
  }
}

/* ----- precondition folders ----- */

/** `preconditions.commands[].cwd` resolves against the spec's folder. */
function preconditionCwdFindings(
  parsed: ParseResult,
  specPath: string,
  lineOf: (path: Array<string | number>) => number | undefined,
): LintFinding[] {
  const out: LintFinding[] = [];
  const commands = parsed.resolved.preconditions?.commands ?? [];
  for (const [i, command] of commands.entries()) {
    const cwd = command.cwd;
    if (!cwd || cwd.includes("${")) continue;
    const dir = resolve(dirname(specPath), cwd);
    if (existsSync(dir)) continue;
    const where = `preconditions.commands[${i}].cwd`;
    out.push({
      rule: "missing-file",
      severity: "error",
      where,
      ...withLine(lineOf(["preconditions", "commands", i, "cwd"])),
      message: `${where}: ${cwd} resolves to ${dir} (against the spec's folder), which does not exist; precondition "${
        command.name ?? `precondition[${i}]`
      }" would fail before the browser starts`,
      fix: {
        description: "a folder relative to the spec file, or ${config.dir}/…",
        safe: false,
      },
    });
  }
  return out;
}

/* ----- script verifier fixtures ----- */

async function fixtureFindings(
  parsed: ParseResult,
  specPath: string,
  lineOf: (path: Array<string | number>) => number | undefined,
): Promise<LintFinding[]> {
  const out: LintFinding[] = [];
  const outcomes = parsed.resolved.outcomes;
  for (const [i, outcome] of outcomes.entries()) {
    const verify = outcome.verify as Record<string, unknown>;
    const script = verify["script"] as
      | { file?: string; fixtures?: Record<string, string> }
      | undefined;
    if (!script?.file) continue;
    const file = isAbsolute(script.file)
      ? script.file
      : resolve(dirname(specPath), script.file);
    let source: string;
    try {
      source = await readFile(file, "utf8");
    } catch {
      continue; // missing-file reports it.
    }
    const contract = analyzeVerifierSource(source);
    if (contract.source === "none") continue;
    // An SDK verifier (defineVerifier) validates its fixtures at runtime, so
    // a mismatch its schema declares is a certain failure: an error. Header
    // comments and code reads are best-effort: warnings.
    const sdk = contract.keys.some((k) => k.source === "sdk");
    if (contract.dynamic && !sdk) continue;
    const known = new Set(contract.keys.map((k) => k.name));
    const passed = Object.keys(script.fixtures ?? {});
    const where = `outcomes[${i}].verify.script.fixtures`;
    const line = lineOf(["outcomes", i, "verify", "script", "fixtures"]);
    const unknown = contract.dynamic ? [] : passed.filter((k) => !known.has(k));
    for (const key of unknown) {
      out.push({
        rule: "unknown-fixture-key",
        severity: contract.strict ? "error" : "warning",
        where: `${where}.${key}`,
        ...withLine(line),
        message: `outcome ${outcome.id}: fixture "${key}" is not in ${script.file}'s contract (${
          [...known].join(", ") || "no keys"
        }) — ${
          contract.strict
            ? "the verifier rejects unknown keys"
            : "a typo, or a key the verifier never reads"
        }`,
      });
    }
    for (const key of contract.keys) {
      if (contract.dynamic && key.source !== "sdk") continue;
      if (key.required && !passed.includes(key.name)) {
        out.push({
          rule: "missing-fixture-key",
          severity: key.source === "sdk" ? "error" : "warning",
          where,
          ...withLine(line),
          message: `outcome ${outcome.id}: ${script.file} requires fixture "${key.name}"${
            key.type ? ` (${key.type})` : ""
          }`,
        });
      }
    }
  }
  return out;
}
