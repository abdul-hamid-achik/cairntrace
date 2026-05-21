import { writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { exportPlaywright } from "../../core/exporters/playwrightExporter";
import { parseSpec } from "../../core/parser/parseSpec";

export interface ExportOptions {
  out?: string;
  /** Print to stdout instead of writing a file. */
  stdout?: boolean;
}

/**
 * `cairn export playwright <spec> [--out <file>]`
 *
 * Reads a spec (with `use:` imports expanded), generates a `@playwright/test`
 * .spec.ts file, and writes it (or pipes to stdout with `--stdout`).
 *
 * The generated file lives in your Playwright project — Cairntrace just
 * produces text; running the test requires `@playwright/test` separately.
 */
export async function exportPlaywrightCommand(
  specPath: string,
  opts: ExportOptions,
): Promise<void> {
  let parsed;
  try {
    parsed = await parseSpec(specPath);
  } catch (e) {
    process.stderr.write(`cairn export: ${(e as Error).message}\n`);
    process.exit(4);
  }

  const source = exportPlaywright(parsed.resolved, {
    sourcePath: parsed.path,
  });

  if (opts.stdout) {
    process.stdout.write(source);
    return;
  }

  const outPath = opts.out
    ? isAbsolute(opts.out)
      ? opts.out
      : resolve(process.cwd(), opts.out)
    : join(dirname(parsed.path), `${parsed.spec.name}.spec.ts`);

  await writeFile(outPath, source);
  process.stdout.write(`${outPath}\n`);
}
