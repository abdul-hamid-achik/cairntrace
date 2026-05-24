import { readFile, stat } from "node:fs/promises";

export default async function verify(ctx: {
  fixtures: { templatePath: string; templateRelativePath: string };
  runDir: string;
}) {
  const bytes = await readFile(ctx.fixtures.templatePath);
  const file = await stat(ctx.fixtures.templatePath);
  const hasZipHeader = bytes[0] === 0x50 && bytes[1] === 0x4b;

  return {
    ok:
      file.isFile() &&
      file.size > 0 &&
      hasZipHeader &&
      ctx.fixtures.templateRelativePath === "downloads/template.xlsx",
    evidence: {
      templatePath: ctx.fixtures.templatePath,
      templateRelativePath: ctx.fixtures.templateRelativePath,
      runDir: ctx.runDir,
      size: file.size,
      hasZipHeader,
    },
  };
}
