import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { type CodemapDeps, defaultCodemapDeps } from "../annotate.js";
import { resolveCodemapSymbolForScaffold } from "../codemap.js";

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
  const outPath = join(outDir, `${name}.yml`);

  await mkdir(outDir, { recursive: true });

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

  const spec = {
    version: 1,
    name,
    intent: opts.intent.trim(),
    // `coversSymbol` binds this spec to the code symbol it exercises, so
    // codemap's blast-radius / cover-the-risk queries can find it. Pre-filled
    // from `codemap semantic` + `codemap orphans` via --from-codemap. NOTE:
    // requires a matching `coversSymbol` field on SpecSchema (spec.v1.ts) for
    // `cairn spec verify` to accept it; the scaffolded stub is a TODO template.
    ...(coversSymbol ? { coversSymbol } : {}),
    outcomes: [
      {
        id: "placeholder",
        description:
          "TODO — replace this with a real behavioral outcome before running.",
        verify: {
          text: { contains: "TODO_replace_me" },
        },
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
    "#     2. session: { resume: <checkpoint-name> }  # from `cairn checkpoint capture-from-session`",
    "#     3. preconditions: { commands: [{ run: 'pnpm db:seed ...' }] }",
    "#",
    "# Outcomes are the contract. Steps are repairable hints.",
    "# Run `cairn spec verify <file> --stamp` after editing to lock the contractHash.",
    "#",
    ...(symbolNotes.length > 0
      ? [
          "# Bound to an untested entrypoint via `--from-codemap` (FEATURES item 6):",
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
  process.stdout.write(`${outPath}\n`);
}
