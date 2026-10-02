import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { isScalar, parseDocument, Scalar, type Document } from "yaml";
import { isInside } from "./config";

/**
 * Promotion of a draft spec (A8): where it goes, the relative paths that
 * must follow it, and the receipt `cairn spec finish` leaves when a draft
 * ran green — promotion is allowed only for the exact content that ran.
 */

/* ----- finish receipts ----- */

/** Under the artifact root; never matches the run-dir pattern. */
export const FINISH_DIR = "_finish";

export interface FinishReceipt {
  version: 1;
  /** Absolute spec path. */
  path: string;
  status: "green" | "red" | "lint-failed" | "errored" | "refused";
  /** sha256 of the file content after the finish (stamp included). */
  contentHash: string;
  contractHash?: string;
  env?: string;
  /**
   * Backend the run used. A `mock` run never touches the app, so promote
   * refuses a mock finish without --force.
   */
  backend?: string;
  runId?: string;
  runDir?: string;
  finishedAt: string;
}

/** A green finish on this backend proves nothing about the app. */
export function isSyntheticBackend(backend: string | undefined): boolean {
  return backend === "mock";
}

export function contentHash(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** The spec's real path (symlinks resolved) when it exists. */
function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

export function receiptPath(artifactRoot: string, specPath: string): string {
  const key = createHash("sha256")
    .update(canonicalPath(specPath))
    .digest("hex");
  return join(artifactRoot, FINISH_DIR, `${key.slice(0, 24)}.json`);
}

/** Write a receipt atomically (best-effort: returns undefined on failure). */
export function writeFinishReceipt(
  artifactRoot: string,
  receipt: FinishReceipt,
): string | undefined {
  const path = receiptPath(artifactRoot, receipt.path);
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(temporary, `${JSON.stringify(receipt, null, 2)}\n`, {
      mode: 0o600,
    });
    renameSync(temporary, path);
    // Keep `_finish/` out of "newest directory" orderings of the artifact
    // root (like `_sessions/` and `_invocations/`).
    try {
      utimesSync(dirname(path), new Date(0), new Date(0));
    } catch {
      // Best-effort.
    }
    return path;
  } catch {
    rmSync(temporary, { force: true });
    return undefined;
  }
}

export function readFinishReceipt(
  artifactRoot: string,
  specPath: string,
): FinishReceipt | undefined {
  try {
    const parsed = JSON.parse(
      readFileSync(receiptPath(artifactRoot, specPath), "utf8"),
    ) as FinishReceipt;
    return parsed &&
      parsed.version === 1 &&
      typeof parsed.contentHash === "string"
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

export function removeFinishReceipt(
  artifactRoot: string,
  specPath: string,
): void {
  rmSync(receiptPath(artifactRoot, specPath), { force: true });
}

/* ----- target ----- */

/**
 * Where a draft goes by default: out of the drafts dir into its parent
 * (`flows/_drafts/a/x.yml` → `flows/a/x.yml`); a draft marked by a `_`
 * folder or file name elsewhere loses the leading underscores.
 */
export function defaultPromoteTarget(
  draft: string,
  opts: { draftsDir: string; root: string },
): string {
  const abs = resolve(draft);
  if (isInside(abs, opts.draftsDir) && abs !== resolve(opts.draftsDir)) {
    const rel = relative(opts.draftsDir, abs);
    return join(dirname(resolve(opts.draftsDir)), stripUnderscores(rel));
  }
  const rel = relative(opts.root, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) {
    return join(dirname(abs), basename(abs).replace(/^_+/, ""));
  }
  return join(opts.root, stripUnderscores(rel));
}

function stripUnderscores(rel: string): string {
  return rel
    .split(sep)
    .map((segment) => segment.replace(/^_+/, "") || segment)
    .join(sep);
}

/* ----- rebasing relative paths ----- */

export interface RebasedPath {
  /** Where in the spec, e.g. `imports[0]`, `steps[3].upload.path`. */
  where: string;
  from: string;
  to: string;
}

/**
 * How the runner resolves a path field: `file` and `dir` against the spec's
 * folder; `host` (eval `args.filePath` / `args.fixtureFiles`) against the cwd
 * first and the spec's folder second, so only a host path that exists next
 * to the spec is rebased.
 */
type PathKind = "file" | "dir" | "host";

/** Fields holding a path relative to the spec file. */
function relativePathFields(
  doc: Document,
): Array<{ where: string; node: Scalar; kind: PathKind }> {
  const out: Array<{ where: string; node: Scalar; kind: PathKind }> = [];
  const take = (
    where: string,
    node: unknown,
    kind: PathKind = "file",
  ): void => {
    if (isScalar(node) && typeof node.value === "string") {
      out.push({ where, node, kind });
    }
  };
  const js = doc.toJS() as Record<string, unknown> | null;
  if (!js || typeof js !== "object") return out;
  const imports = Array.isArray(js["imports"]) ? js["imports"] : [];
  imports.forEach((_v, i) =>
    take(`imports[${i}]`, doc.getIn(["imports", i], true)),
  );
  for (const [i, command] of preconditionCommands(js).entries()) {
    if (typeof command["cwd"] === "string") {
      take(
        `preconditions.commands[${i}].cwd`,
        doc.getIn(["preconditions", "commands", i, "cwd"], true),
        "dir",
      );
    }
  }
  const steps = Array.isArray(js["steps"]) ? js["steps"] : [];
  steps.forEach((step, i) => {
    if (!step || typeof step !== "object") return;
    const s = step as Record<string, unknown>;
    for (const [kind, field] of [
      ["eval", "file"],
      ["transform", "file"],
      ["transform", "input"],
      ["upload", "path"],
    ] as const) {
      if (s[kind] && typeof s[kind] === "object") {
        take(
          `steps[${i}].${kind}.${field}`,
          doc.getIn(["steps", i, kind, field], true),
        );
      }
    }
    const args =
      s["eval"] && typeof s["eval"] === "object"
        ? (s["eval"] as Record<string, unknown>)["args"]
        : undefined;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      const a = args as Record<string, unknown>;
      take(
        `steps[${i}].eval.args.filePath`,
        doc.getIn(["steps", i, "eval", "args", "filePath"], true),
        "host",
      );
      const fixtures = a["fixtureFiles"];
      if (
        fixtures &&
        typeof fixtures === "object" &&
        !Array.isArray(fixtures)
      ) {
        for (const name of Object.keys(fixtures)) {
          take(
            `steps[${i}].eval.args.fixtureFiles.${name}`,
            doc.getIn(["steps", i, "eval", "args", "fixtureFiles", name], true),
            "host",
          );
        }
      }
    }
  });
  const outcomes = Array.isArray(js["outcomes"]) ? js["outcomes"] : [];
  outcomes.forEach((_o, i) =>
    take(
      `outcomes[${i}].verify.script.file`,
      doc.getIn(["outcomes", i, "verify", "script", "file"], true),
    ),
  );
  return out;
}

function preconditionCommands(
  js: Record<string, unknown>,
): Array<Record<string, unknown>> {
  const pre = js["preconditions"];
  if (!pre || typeof pre !== "object") return [];
  const commands = (pre as Record<string, unknown>)["commands"];
  return Array.isArray(commands)
    ? commands.filter(
        (c): c is Record<string, unknown> =>
          !!c && typeof c === "object" && !Array.isArray(c),
      )
    : [];
}

function quoteLike(node: Scalar, value: string): string {
  if (node.type === Scalar.QUOTE_SINGLE) {
    return `'${value.replace(/'/g, "''")}'`;
  }
  if (node.type === Scalar.QUOTE_DOUBLE || !/^[\w./@-]+$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/**
 * Rewrite every relative path the spec declares (imports, eval/transform
 * files, eval host files, upload paths, script verifier files, precondition
 * `cwd`s) so it still points at the same file from `toDir`. Text-level
 * edits: comments and quoting elsewhere stay byte-identical. Paths with a
 * `${…}` placeholder or absolute paths are left alone; `${file.dir}` /
 * `${project.root}` uses and precondition commands that run in the spec's
 * folder (no `cwd`) are reported.
 */
export function rebaseRelativePaths(
  text: string,
  fromDir: string,
  toDir: string,
): { text: string; rebased: RebasedPath[]; warnings: string[] } {
  const warnings: string[] = [];
  if (/\$\{(?:file\.dir|project\.root)\}/.test(text)) {
    warnings.push(
      "the spec uses ${file.dir} / ${project.root}, which now resolves to the promoted file's folder; check those paths",
    );
  }
  if (resolve(fromDir) === resolve(toDir)) {
    return { text, rebased: [], warnings };
  }
  const doc = parseDocument(text);
  if (doc.errors.length > 0) return { text, rebased: [], warnings };
  const js = doc.toJS() as Record<string, unknown> | null;
  if (js && typeof js === "object") {
    for (const [i, command] of preconditionCommands(js).entries()) {
      if (command["cwd"] === undefined) {
        const label =
          typeof command["name"] === "string" ? ` (${command["name"]})` : "";
        warnings.push(
          `preconditions.commands[${i}]${label} has no cwd, so it runs in the spec's folder, which is now ${toDir} instead of ${fromDir}; set cwd if it reads relative files`,
        );
      }
    }
  }
  const edits: Array<{ start: number; end: number; insert: string }> = [];
  const rebased: RebasedPath[] = [];
  for (const { where, node, kind } of relativePathFields(doc)) {
    const value = node.value as string;
    if (
      !value ||
      value.includes("${") ||
      isAbsolute(value) ||
      value.startsWith("~")
    ) {
      continue;
    }
    const target = resolve(fromDir, value);
    // A host path the draft's folder does not hold resolves against the
    // cwd at run time: moving the spec does not change it.
    if (kind === "host" && !existsSync(target)) continue;
    let next = relative(toDir, target).split(sep).join("/");
    if (next === "") next = ".";
    // Keep the author's `./` style.
    if (value.startsWith("./") && !next.startsWith(".")) next = `./${next}`;
    if (next === value || !node.range) continue;
    edits.push({
      start: node.range[0],
      end: node.range[1],
      insert: quoteLike(node, next),
    });
    rebased.push({ where, from: value, to: next });
  }
  let out = text;
  for (const edit of edits.toSorted((a, b) => b.start - a.start)) {
    out = out.slice(0, edit.start) + edit.insert + out.slice(edit.end);
  }
  return { text: out, rebased, warnings };
}
