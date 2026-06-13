import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { resolveArtifactRoot, resolveRunRef } from "../runRefs";

export interface ContextOptions {
  path?: boolean;
  artifactRoot?: string;
  config?: string;
}

/**
 * Print or locate the agent_context.md for a run.
 * Resolves "latest" by mtime in the configured artifact root.
 */
export async function contextCommand(
  ref: string,
  opts: ContextOptions,
): Promise<void> {
  let runsDir: string;
  let runDir: string;
  try {
    runsDir = await resolveArtifactRoot(opts);
    runDir = await resolveRunRef(ref, runsDir);
  } catch (e) {
    process.stderr.write(`cairn context: ${(e as Error).message}\n`);
    process.exit(2);
  }

  const contextPath = join(runDir, "agent_context.md");

  if (opts.path) {
    process.stdout.write(contextPath + "\n");
    return;
  }

  try {
    const content = await readFile(contextPath, "utf8");
    process.stdout.write(content);
  } catch (e) {
    process.stderr.write(`cairn context: ${(e as Error).message}\n`);
    process.exit(2);
  }
}
