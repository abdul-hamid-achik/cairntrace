import { readFile, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  importPlaywright,
  type ImportPlaywrightResult,
} from "../../core/importers/playwrightImporter";
import { emit, resolveFormat } from "../format";

export interface ImportPlaywrightOptions {
  out?: string;
  stdout?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

interface ImportPlaywrightReport {
  status: "written";
  path: string;
  name: string;
  todos: string[];
}

export async function importPlaywrightCommand(
  sourcePath: string,
  opts: ImportPlaywrightOptions,
): Promise<void> {
  let imported: ImportPlaywrightResult;
  try {
    const source = await readFile(sourcePath, "utf8");
    imported = importPlaywright(source, { sourcePath });
  } catch (e) {
    process.stderr.write(`cairn import playwright: ${(e as Error).message}\n`);
    process.exit(2);
  }

  if (opts.stdout) {
    process.stdout.write(imported.yaml);
    return;
  }

  const outPath = opts.out
    ? isAbsolute(opts.out)
      ? opts.out
      : resolve(process.cwd(), opts.out)
    : join(
        dirname(resolve(process.cwd(), sourcePath)),
        `${imported.spec.name}.yml`,
      );

  await writeFile(outPath, imported.yaml);
  const report: ImportPlaywrightReport = {
    status: "written",
    path: outPath,
    name: imported.spec.name,
    todos: imported.todos,
  };

  const format = resolveFormat(opts, "md");
  process.stdout.write(emit(format, report, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function toMarkdown(report: ImportPlaywrightReport): string {
  const lines = [
    `# Import Playwright: ${report.name}`,
    "",
    `Wrote ${report.path}`,
  ];
  if (report.todos.length > 0) {
    lines.push("", "## TODO");
    for (const todo of report.todos.slice(0, 20)) lines.push(`- ${todo}`);
    if (report.todos.length > 20) {
      lines.push(`- ...and ${report.todos.length - 20} more`);
    }
  }
  return lines.join("\n");
}
