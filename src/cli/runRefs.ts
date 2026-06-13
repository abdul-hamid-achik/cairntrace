import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { loadConfig, type LoadedConfig } from "../core/config/loader";

export interface ArtifactRootOptions {
  artifactRoot?: string;
  config?: string;
  cwd?: string;
}

export async function resolveArtifactRoot(
  opts: ArtifactRootOptions = {},
): Promise<string> {
  if (opts.artifactRoot) return opts.artifactRoot;
  return (await resolveArtifactRootContext(opts)).artifactRoot;
}

export async function resolveArtifactRootContext(
  opts: ArtifactRootOptions = {},
): Promise<{ artifactRoot: string; loaded?: LoadedConfig }> {
  const cwd = opts.cwd ?? process.cwd();
  const loaded = await loadConfig(
    resolve(cwd, "cairn-artifact-root-probe"),
    opts.config,
  );
  return {
    artifactRoot:
      opts.artifactRoot ??
      loaded?.config.artifactRoot ??
      join(homedir(), ".cairntrace", "runs"),
    ...(loaded ? { loaded } : {}),
  };
}

export async function resolveRunRef(
  ref: string,
  runsRoot: string,
): Promise<string> {
  if (ref === "latest" || ref === "previous") {
    const slot = ref === "latest" ? 0 : 1;
    const runId = await findRunBySlot(runsRoot, slot);
    if (!runId) throw new Error(`no run available at slot ${ref}`);
    return join(runsRoot, runId);
  }
  if (isAbsolute(ref)) return ref;
  return join(runsRoot, ref);
}

export async function findRunBySlot(
  runsRoot: string,
  slot: number,
): Promise<string | undefined> {
  const entries = await readdir(runsRoot).catch(() => [] as string[]);
  const stats = await Promise.all(
    entries.map(async (name) => {
      try {
        const s = await stat(join(runsRoot, name));
        return { name, mtime: s.mtimeMs, isDir: s.isDirectory() };
      } catch {
        return { name, mtime: 0, isDir: false };
      }
    }),
  );
  return stats.filter((s) => s.isDir).toSorted((a, b) => b.mtime - a.mtime)[
    slot
  ]?.name;
}
