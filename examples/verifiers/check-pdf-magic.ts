import { readFile, stat } from "node:fs/promises";

export default async function verify(ctx: {
  fixtures: { pdfPath: string; pdfRelativePath: string };
  runDir: string;
}) {
  const bytes = await readFile(ctx.fixtures.pdfPath);
  const file = await stat(ctx.fixtures.pdfPath);
  const magic = bytes.subarray(0, 5).toString("latin1");

  return {
    ok:
      file.isFile() &&
      file.size > 0 &&
      magic === "%PDF-" &&
      ctx.fixtures.pdfRelativePath === "downloads/sample-invoice.pdf",
    evidence: {
      pdfPath: ctx.fixtures.pdfPath,
      pdfRelativePath: ctx.fixtures.pdfRelativePath,
      runDir: ctx.runDir,
      size: file.size,
      magic,
    },
  };
}
