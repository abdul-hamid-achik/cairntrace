import { appendFile, copyFile } from "node:fs/promises";

export default async function transform(ctx: {
  input: string;
  output: { path: string; relativePath: string };
}) {
  await copyFile(ctx.input, ctx.output.path);
  await appendFile(
    ctx.output.path,
    "\nCAIRNTRACE_INVALID_EMAIL=duplicate@example.com\n",
  );

  return {
    ok: true,
    evidence: {
      input: ctx.input,
      output: ctx.output.relativePath,
      invalidEmail: "duplicate@example.com",
    },
  };
}
