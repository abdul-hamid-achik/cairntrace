import { readFile, readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

export interface ContextOptions {
  path?: boolean;
}

/**
 * Print or locate the agent_context.md for a run.
 * Resolves "latest" by mtime in ~/.cairntrace/runs/.
 */
export async function contextCommand(
  ref: string,
  opts: ContextOptions,
): Promise<void> {
  const runsDir = join(homedir(), ".cairntrace", "runs");
  const runId = ref === "latest" ? await findLatest(runsDir) : ref;

  if (!runId) {
    process.stderr.write(`cairn context: no runs found in ${runsDir}\n`);
    process.exit(2);
  }

  const contextPath = join(runsDir, runId, "agent_context.md");

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

async function findLatest(runsDir: string): Promise<string | undefined> {
  let entries: string[];
  try {
    entries = await readdir(runsDir);
  } catch {
    return undefined;
  }
  if (entries.length === 0) return undefined;

  const stats = await Promise.all(
    entries.map(async (name) => {
      try {
        const s = await stat(join(runsDir, name));
        return { name, mtime: s.mtimeMs, isDir: s.isDirectory() };
      } catch {
        return { name, mtime: 0, isDir: false };
      }
    }),
  );
  const dirs = stats
    .filter((s) => s.isDir)
    .toSorted((a, b) => b.mtime - a.mtime);
  return dirs[0]?.name;
}
