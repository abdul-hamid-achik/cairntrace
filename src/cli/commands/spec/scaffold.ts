import { mkdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { stringify as yamlStringify } from "yaml";

export interface ScaffoldOptions {
  intent: string;
  out?: string;
}

/**
 * Write a starter behavioral spec YAML for the given name + intent.
 * The output includes a header comment block explaining the cold-start contract
 * (plan §10.6) and a single placeholder outcome the agent is expected to replace.
 */
export async function scaffoldCommand(
  name: string,
  opts: ScaffoldOptions,
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

  const spec = {
    version: 1,
    name,
    intent: opts.intent.trim(),
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
