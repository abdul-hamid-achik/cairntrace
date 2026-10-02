import { readdir, readFile, stat } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute as isAbsolutePath,
  relative,
  resolve,
} from "node:path";
import { parse as parseYaml } from "yaml";
import type {
  SelectedSpec,
  SelectionResult,
  SkippedSpec,
} from "../../core/schema/selection.v1";
import { defaultCodemapDeps, type CodemapDeps } from "../commands/annotate";
import { codemapReview, codemapSemantic } from "../commands/codemap";

/**
 * Spec selection for a run invocation: directory expansion, `--tag`
 * metadata filtering, `--since-codemap` blast-radius scoping and the
 * `--select-only` SelectionResult. Pure reads; no browser, no services.
 */

/**
 * Compact form of the opening "starting: ..." line: a count plus (when the
 * specs share a directory) that directory relative to `cwd`, e.g.
 * `starting 6 specs (flows/checkout)`. Falls back to just the count
 * when there's no useful shared directory (single spec with nothing to add,
 * or specs scattered with only the filesystem root in common). The full
 * absolute path list is still logged separately at debug level.
 */
export function summarizeStartingSpecs(specs: string[], cwd: string): string {
  const count = specs.length;
  const noun = count === 1 ? "spec" : "specs";
  const common = commonParentDirRelative(specs, cwd);
  return common
    ? `starting ${count} ${noun} (${common})`
    : `starting ${count} ${noun}`;
}

/**
 * The deepest directory common to every spec path's parent, expressed
 * relative to `cwd`. Returns undefined when there's nothing to show: no
 * specs, the common directory IS `cwd`, or the only shared ancestor is `/`.
 */
function commonParentDirRelative(
  specs: string[],
  cwd: string,
): string | undefined {
  if (specs.length === 0) return undefined;
  const segLists = specs.map((p) => {
    const abs = isAbsolutePath(p) ? p : resolve(cwd, p);
    return dirname(abs)
      .split("/")
      .filter((s) => s.length > 0);
  });
  let common = segLists[0]!;
  for (const segs of segLists.slice(1)) {
    let i = 0;
    while (i < common.length && i < segs.length && common[i] === segs[i]) i++;
    common = common.slice(0, i);
    if (common.length === 0) break;
  }
  if (common.length === 0) return undefined;
  const rel = relative(cwd, `/${common.join("/")}`);
  return rel === "" ? undefined : rel;
}

export async function expandSpecArgs(
  args: string[],
  cwd = process.cwd(),
): Promise<string[]> {
  return (await expandSpecArgsWithDrafts(args, cwd)).specs;
}

/** Why directory expansion left a draft out (SelectionResult `skipped`). */
export const DRAFT_SKIP_REASON =
  "draft: starts with _ (cairn run <dir> skips _ folders and files; name it to run it)";

/**
 * {@link expandSpecArgs} plus the drafts it left out: each `_` folder below
 * a directory argument that holds spec files, and each `_` spec file.
 */
export async function expandSpecArgsWithDrafts(
  args: string[],
  cwd = process.cwd(),
): Promise<{ specs: string[]; drafts: string[] }> {
  const specs: string[] = [];
  const drafts: string[] = [];
  for (const arg of args) {
    const abs = isAbsolutePath(arg) ? arg : resolve(cwd, arg);
    const s = await stat(abs).catch(() => undefined);
    if (!s) {
      specs.push(arg);
      continue;
    }
    if (!s.isDirectory()) {
      specs.push(arg);
      continue;
    }
    specs.push(...(await collectSpecFiles(abs, drafts)));
  }
  return { specs, drafts };
}

/**
 * Spec files under `dir`, sorted. Skipped: `actions/` folders, and drafts —
 * any file or folder below `dir` whose name starts with `_` (the default
 * `flows/_drafts/`, `_sessions`, `_wip.yml`), collected into `drafts` when
 * they hold specs. A path the caller names explicitly is always taken, so
 * `cairn run flows/_drafts` still runs them.
 */
async function collectSpecFiles(
  dir: string,
  drafts: string[] = [],
): Promise<string[]> {
  const entries = (await readdir(dir, { withFileTypes: true })).toSorted(
    (a, b) => a.name.localeCompare(b.name),
  );
  const out: string[] = [];
  for (const entry of entries) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "actions") continue;
      if (entry.name.startsWith("_")) {
        if ((await collectSpecFiles(path)).length > 0) drafts.push(path);
        continue;
      }
      out.push(...(await collectSpecFiles(path, drafts)));
      continue;
    }
    if (entry.isFile() && /\.ya?ml$/i.test(entry.name)) {
      if (basename(entry.name).startsWith("_")) drafts.push(path);
      else out.push(path);
    }
  }
  return out;
}

/**
 * Read a spec's `coversSymbol` binding from disk via a loose YAML parse (no
 * zod validation, no contractHash check) — selection only needs the symbol
 * name. Returns undefined when the field is absent or the file can't be parsed.
 */
async function readCoversSymbol(specPath: string): Promise<string | undefined> {
  try {
    const raw = await readFile(specPath, "utf8");
    const doc = parseYaml(raw) as Record<string, unknown> | null;
    const sym = doc?.coversSymbol;
    return typeof sym === "string" && sym.length > 0 ? sym : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read `metadata.tags` from a spec via a loose YAML parse (selection only).
 * Returns [] when absent or unreadable.
 */
export async function readSpecTags(specPath: string): Promise<string[]> {
  try {
    const raw = await readFile(specPath, "utf8");
    const doc = parseYaml(raw) as {
      metadata?: { tags?: unknown };
    } | null;
    const tags = doc?.metadata?.tags;
    if (!Array.isArray(tags)) return [];
    return tags.filter(
      (t): t is string => typeof t === "string" && t.trim().length > 0,
    );
  } catch {
    return [];
  }
}

/** Trim empty entries from repeatable `--tag` flags. */
export function normalizeTagFilters(tags: string[] | undefined): string[] {
  return (tags ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
}

/**
 * True when `specTags` includes every entry in `required` (case-insensitive).
 * Empty `required` always matches.
 */
export function specMatchesTags(
  specTags: string[],
  required: string[],
): boolean {
  if (required.length === 0) return true;
  const have = new Set(specTags.map((t) => t.toLowerCase()));
  return required.every((r) => have.has(r.toLowerCase()));
}

/**
 * Filter expanded specs by `metadata.tags`. AND semantics: every required tag
 * must be present. Returns selected paths and skip reasons for the rest.
 */
export async function selectSpecsByTags(
  specs: string[],
  requiredTags: string[],
): Promise<{
  selected: string[];
  skipped: { path: string; reason: string }[];
}> {
  const required = normalizeTagFilters(requiredTags);
  if (required.length === 0) {
    return { selected: [...specs], skipped: [] };
  }
  const selected: string[] = [];
  const skipped: { path: string; reason: string }[] = [];
  const need = required.map((t) => t.toLowerCase());
  for (const p of specs) {
    const tags = await readSpecTags(p);
    const have = new Set(tags.map((t) => t.toLowerCase()));
    const missing = need.filter((t) => !have.has(t));
    if (missing.length === 0) {
      selected.push(p);
    } else {
      skipped.push({
        path: p,
        reason:
          tags.length === 0
            ? `no metadata.tags (need: ${required.join(", ")})`
            : `missing tag(s): ${missing.join(", ")} (have: ${tags.join(", ")})`,
      });
    }
  }
  return { selected, skipped };
}

/**
 * `--since-codemap <ref>` (FEATURES item 1): intersect `codemap review --since
 * <ref>` blast-radius file paths against each spec's `coversSymbol` code-match
 * provenance and return only the minimal set a change can actually hit.
 *
 * A spec is selected when EITHER its `coversSymbol` is directly named in the
 * blast-radius symbol set, OR resolving that symbol to a file via
 * `codemap semantic` yields a path in the blast-radius file set.
 *
 * Degrades to the full input list (run-all) when codemap is absent, when
 * `since` is blank, or when codemap failed to produce a positive review —
 * best-effort, never fails the run. An indexed review with an empty blast
 * radius (e.g. a one-line CSS edit touching no symbols) selects no specs.
 */
export async function selectSpecsByBlastRadius(
  specs: string[],
  since: string,
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<string[]> {
  if (specs.length === 0 || !since) return specs;
  if (!(await deps.isAvailable())) return specs;
  const review = await codemapReview(since, deps);
  // codemap failed / returned nothing → run-all so a broken codemap never
  // silently skips a run.
  if (!review.indexed && review.blastRadiusFiles.length === 0) return specs;
  // Indexed but empty radius → genuinely nothing impacted (CSS edit case).
  if (
    review.blastRadiusFiles.length === 0 &&
    review.blastRadiusSymbols.length === 0
  )
    return [];
  const blastFiles = new Set(review.blastRadiusFiles);
  const blastSymbols = new Set(review.blastRadiusSymbols);
  const selected: string[] = [];
  for (const specPath of specs) {
    const sym = await readCoversSymbol(specPath);
    if (!sym) continue; // uncovered spec — not selected by blast radius
    if (blastSymbols.has(sym)) {
      selected.push(specPath);
      continue;
    }
    // Resolve the symbol to its file(s) via codemap semantic and intersect.
    const files = (await codemapSemantic(sym, deps))
      .map((s) => s.file)
      .filter((f): f is string => !!f);
    if (files.some((f) => blastFiles.has(f))) selected.push(specPath);
  }
  return selected;
}

/** Spec name from a path: the basename minus .yml/.yaml. */
function specNameFromPath(specPath: string): string {
  return (
    specPath
      .split("/")
      .pop()
      ?.replace(/\.ya?ml$/, "") ?? specPath
  );
}

/**
 * `--select-only`: resolve which specs WOULD run and return a SelectionResult
 * v1 envelope, WITHOUT launching a browser.
 *
 * Filters (applied in order):
 * 1. `--tag` AND-filter on `metadata.tags` (case-insensitive)
 * 2. `--since-codemap` blast-radius (when provided)
 *
 * - No `since` / no tags: all expanded specs selected; codemapAvailable=false.
 * - Tags only: non-matching skipped with reason; codemapAvailable=false.
 * - `since` + codemap absent: degrade to run-all on the tag-filtered set.
 * - `since` + codemap present + empty radius: all remaining skipped.
 * - `since` + non-empty radius: blast-radius intersection.
 */
export async function buildSelectionResult(
  specs: string[],
  since: string | undefined,
  deps: CodemapDeps = defaultCodemapDeps,
  requiredTags: string[] = [],
  cwd: string = process.cwd(),
): Promise<SelectionResult> {
  const selected: SelectedSpec[] = [];
  const skipped: SkippedSpec[] = [];
  const tagsFilter = normalizeTagFilters(requiredTags);
  const absolutify = (p: string): string =>
    isAbsolutePath(p) ? p : resolve(cwd, p);
  const enter = async (
    p: string,
  ): Promise<{ name: string; path: string; tags?: string[] }> => {
    const tags = await readSpecTags(p);
    return {
      name: specNameFromPath(p),
      path: absolutify(p),
      ...(tags.length > 0 ? { tags } : {}),
    };
  };
  const base = {
    $schema: "urn:cairntrace.dev:selection:v1" as const,
    version: "1" as const,
    ...(tagsFilter.length > 0 ? { tags: tagsFilter } : {}),
  };

  // 1) Tag filter first — skipped specs stay skipped even if codemap would
  // have selected them.
  let candidates = specs;
  if (tagsFilter.length > 0) {
    const tagSel = await selectSpecsByTags(specs, tagsFilter);
    candidates = tagSel.selected;
    for (const s of tagSel.skipped) {
      skipped.push({
        name: specNameFromPath(s.path),
        path: absolutify(s.path),
        reason: s.reason,
      });
    }
  }

  const pushSelected = async (p: string, coversSymbol?: string) => {
    const e = await enter(p);
    selected.push({
      ...e,
      ...(coversSymbol ? { coversSymbol } : {}),
    });
  };

  if (!since) {
    for (const p of candidates) {
      const sym = await readCoversSymbol(p);
      await pushSelected(p, sym);
    }
    return {
      ...base,
      codemapAvailable: false,
      selected,
      skipped,
    };
  }

  if (!(await deps.isAvailable())) {
    for (const p of candidates) {
      const sym = await readCoversSymbol(p);
      await pushSelected(p, sym);
    }
    return { ...base, since, codemapAvailable: false, selected, skipped };
  }

  const review = await codemapReview(since, deps);
  // codemap failed / returned nothing → run-all so a broken codemap never
  // silently skips a run.
  if (!review.indexed && review.blastRadiusFiles.length === 0) {
    for (const p of candidates) {
      const sym = await readCoversSymbol(p);
      await pushSelected(p, sym);
    }
    return { ...base, since, codemapAvailable: false, selected, skipped };
  }

  const blastFiles = new Set(review.blastRadiusFiles);
  const blastSymbols = new Set(review.blastRadiusSymbols);
  const emptyRadius =
    review.blastRadiusFiles.length === 0 &&
    review.blastRadiusSymbols.length === 0;
  // Indexed but empty radius → genuinely nothing impacted (CSS-edit case).
  if (emptyRadius) {
    for (const p of candidates) {
      skipped.push({
        ...(await enter(p)),
        reason: `blast radius of '${since}' matched no symbols`,
      });
    }
    return { ...base, since, codemapAvailable: true, selected, skipped };
  }

  for (const p of candidates) {
    const sym = await readCoversSymbol(p);
    if (!sym) {
      skipped.push({
        ...(await enter(p)),
        reason: "no coversSymbol binding",
      });
      continue;
    }
    if (blastSymbols.has(sym)) {
      await pushSelected(p, sym);
      continue;
    }
    const files = (await codemapSemantic(sym, deps))
      .map((s) => s.file)
      .filter((f): f is string => !!f);
    if (files.some((f) => blastFiles.has(f))) {
      await pushSelected(p, sym);
    } else {
      skipped.push({
        ...(await enter(p)),
        reason: `coversSymbol '${sym}' outside blast radius of '${since}'`,
      });
    }
  }
  return { ...base, since, codemapAvailable: true, selected, skipped };
}
