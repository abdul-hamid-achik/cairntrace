import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { type CodemapDeps, defaultCodemapDeps } from "../annotate.js";
import {
  codemapReadOrder,
  codemapRisk,
  resolveCodemapSymbolForScaffold,
  type CodemapReadOrderEntry,
} from "../codemap.js";

export interface ScaffoldOptions {
  intent: string;
  out?: string;
  /**
   * `--from-codemap [query]` (FEATURES item 6): consult `codemap semantic` +
   * `codemap orphans` for untested entrypoints and pre-fill the spec's
   * `coversSymbol` binding from the symbol's signature/docstring. `true` uses
   * the spec name as the query; a string overrides it. Best-effort: when
   * codemap is absent, the spec is scaffolded without a binding (no crash).
   */
  fromCodemap?: string | boolean;
  /**
   * `--from-risk` (FEATURES item 9): scaffold N stubs bound to the highest-risk
   * untested entrypoints, ranked by `codemap read-order` + `codemap risk`.
   * Files are named per symbol (the `name` arg is unused for filenames in this mode).
   */
  fromRisk?: boolean;
  /** `--top N` (item 9): how many risky entrypoints to scaffold (default 3). */
  top?: number;
}
/**
 * Write a starter behavioral spec YAML for the given name + intent.
 * The output includes a header comment block explaining the cold-start contract
 * (plan §10.6) and a single placeholder outcome the agent is expected to replace.
 *
 * With `--from-codemap` (FEATURES item 6), the spec is pre-bound to
 * `coversSymbol:` from an untested codemap entrypoint's signature/docstring.
 * Uses `codemap semantic` + `codemap orphans` only — `codemap read-order` is
 * not yet shipped here and is noted as a future enhancement in FEATURES.md.
 */
/** A read-order entrypoint augmented with its `codemap risk` score (item 9). */
export interface RiskyEntrypoint extends CodemapReadOrderEntry {
  riskScore: number;
  riskLevel: string;
  /** Covering test count from `codemap risk` — 0 means untested. */
  coveringTests: number;
}

/**
 * Select the top-N highest-risk UNTTESTED entrypoints for `--from-risk`
 * (FEATURES item 9). Ranks `codemap read-order` entrypoints by `codemap risk`
 * score, keeping only entrypoints with no covering tests. Best-effort: returns
 * `[]` when codemap is absent or the read-order report is empty.
 */
export async function selectRiskyUntestedEntrypoints(
  deps: CodemapDeps,
  topN: number,
): Promise<RiskyEntrypoint[]> {
  if (topN <= 0) return [];
  const { entries } = await codemapReadOrder(deps);
  const entrypoints = entries.filter((e) => e.entrypoint && e.symbol);
  if (entrypoints.length === 0) return [];
  const withRisk = await Promise.all(
    entrypoints.map(async (e) => {
      const r = await codemapRisk(e.symbol!, deps);
      return {
        ...e,
        riskScore: r.score,
        riskLevel: r.level,
        coveringTests: r.coveringTests,
      } as RiskyEntrypoint;
    }),
  );
  // Untested = no covering tests (risk.coveringTests === 0). Sort by risk desc,
  // then read-order rank for stable tie-breaking.
  return withRisk
    .filter((e) => e.coveringTests === 0)
    .toSorted((a, b) => b.riskScore - a.riskScore || a.rank - b.rank)
    .slice(0, topN);
}

/** snake_case slug from a symbol name (for `--from-risk` filenames). */
function symbolSlug(symbol: string): string {
  return symbol
    .replace(/[^A-Za-z0-9_]+/g, "_")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .replace(/^_+|_+$/g, "");
}

/** Write one scaffold stub (shared by the single + `--from-risk` paths). */
async function writeSpecStub(
  outDir: string,
  slug: string,
  intent: string,
  coversSymbol: string | undefined,
  symbolNotes: string[],
  bindSource: string,
): Promise<string> {
  const outPath = join(outDir, `${slug}.yml`);
  const spec = {
    version: 1,
    name: slug,
    intent,
    ...(coversSymbol ? { coversSymbol } : {}),
    outcomes: [
      {
        id: "placeholder",
        description:
          "TODO — replace this with a real behavioral outcome before running.",
        verify: { text: { contains: "TODO_replace_me" } },
      },
    ],
    steps: [],
  };
  const header = [
    "# Cairntrace behavioral spec — see plan §10 (intent + outcomes is the contract)",
    "#",
    "# COLD START CONTRACT (plan §10.6):",
    "#   This spec must be replayable from a fresh browser session.",
    "#   Satisfy via ONE of:",
    "#     1. imports: [actions/login_admin.yml] + steps: [{ use: login_admin }]",
    "#     2. session: { resume: <checkpoint-name> }",
    "#     3. preconditions: { commands: [{ run: 'pnpm db:seed ...' }] }",
    "#",
    "# Outcomes are the contract. Steps are repairable hints.",
    "# Run `cairn spec verify <file> --stamp` after editing to lock the contractHash.",
    "#",
    ...(symbolNotes.length > 0
      ? [
          `# Bound via ${bindSource}:`,
          ...symbolNotes.map((n) => `#   ${n}`),
          "#",
        ]
      : []),
  ].join("\n");
  const yaml = yamlStringify(spec, {
    indent: 2,
    lineWidth: 100,
    defaultStringType: "PLAIN",
    defaultKeyType: "PLAIN",
  });
  await writeFile(outPath, header + "\n" + yaml);
  return outPath;
}

export async function scaffoldCommand(
  name: string,
  opts: ScaffoldOptions,
  deps: CodemapDeps = defaultCodemapDeps,
): Promise<void> {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) {
    process.stderr.write(
      `cairn spec scaffold: name must be snake_case starting with a letter (got "${name}")\n`,
    );
    process.exit(2);
  }
  if (!opts.intent || opts.intent.trim().length === 0) {
    process.stderr.write(
      `cairn spec scaffold: --intent is required and must be non-empty\n`,
    );
    process.exit(2);
  }

  const outDir = opts.out
    ? isAbsolute(opts.out)
      ? opts.out
      : resolve(process.cwd(), opts.out)
    : resolve(process.cwd(), "flows");
  await mkdir(outDir, { recursive: true });

  // `--from-risk [--top N]` (FEATURES item 9): scaffold N stubs bound to the
  // highest-risk untested entrypoints (codemap read-order + codemap risk).
  // Files are named per symbol; the `name` arg is unused for filenames here.
  if (opts.fromRisk) {
    const topN = opts.top && opts.top > 0 ? opts.top : 3;
    const entrypoints = await selectRiskyUntestedEntrypoints(deps, topN);
    if (entrypoints.length === 0) {
      process.stderr.write(
        "cairn spec scaffold --from-risk: no untested entrypoints found (codemap absent or none untested)\n",
      );
      return;
    }
    for (const ep of entrypoints) {
      const slug = symbolSlug(ep.symbol);
      const notes = [
        `coversSymbol: ${ep.symbol} — risk ${ep.riskLevel} (${ep.riskScore.toFixed(2)})`,
        `read-order rank: ${ep.rank}; entrypoint: ${ep.kind ?? "unknown"}`,
        ...(ep.file
          ? [`source: ${ep.file}${ep.startLine ? `:${ep.startLine}` : ""}`]
          : []),
      ];
      const p = await writeSpecStub(
        outDir,
        slug,
        opts.intent.trim(),
        ep.symbol,
        notes,
        "`--from-risk` (FEATURES item 9)",
      );
      process.stdout.write(`${p}\n`);
    }
    return;
  }

  // `--from-codemap [query]`: bind the scaffold to an untested codemap
  // entrypoint's symbol. Best-effort: when codemap is absent or no symbol
  // matches, the spec is scaffolded without a binding. (FEATURES item 6)
  let coversSymbol: string | undefined;
  let symbolNotes: string[] = [];
  if (opts.fromCodemap) {
    const query =
      typeof opts.fromCodemap === "string" && opts.fromCodemap.trim().length > 0
        ? opts.fromCodemap.trim()
        : name;
    const sym = await resolveCodemapSymbolForScaffold(query, deps);
    if (sym) {
      coversSymbol = sym.symbol;
      if (sym.signature)
        symbolNotes.push(`coversSymbol: ${sym.symbol} — ${sym.signature}`);
      else symbolNotes.push(`coversSymbol: ${sym.symbol}`);
      if (sym.docstring) symbolNotes.push(`docstring: ${sym.docstring}`);
      if (sym.file)
        symbolNotes.push(
          `source: ${sym.file}${sym.line ? `:${sym.line}` : ""}`,
        );
    }
  }

  const written = await writeSpecStub(
    outDir,
    name,
    opts.intent.trim(),
    coversSymbol,
    symbolNotes,
    "`--from-codemap` (FEATURES item 6)",
  );
  process.stdout.write(`${written}\n`);
}
