import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { compareVersions, parseVersion, satisfiesRange } from "./semverRange";

/**
 * F19: which `node` cairn spawns for node scripts, verifiers and transforms.
 * Order: `CAIRN_NODE` (environment) → config `runtimes.node.path` →
 * config `runtimes.node.version` (PATH, then the usual version-manager
 * directories) → `node` on PATH.
 */

export interface NodeRuntimeConfig {
  path?: string | undefined;
  version?: string | undefined;
}

export interface NodeResolution {
  /** The binary to spawn (absolute, or `node` for PATH lookup). */
  command: string;
  version: string;
  source:
    | "CAIRN_NODE"
    | "runtimes.node.path"
    | "runtimes.node.version (PATH)"
    | "runtimes.node.version (version manager)"
    | "PATH";
}

export class NodeRuntimeError extends Error {
  override name = "NodeRuntimeError";
  readonly exitCode = 4 as const;
}

/** The node command of a child env: `CAIRN_NODE`, else `node` from PATH. */
export function nodeCommand(
  env: Record<string, string | undefined> | undefined,
): string {
  const configured = (env ?? process.env).CAIRN_NODE;
  return configured !== undefined && configured.trim() !== ""
    ? configured
    : "node";
}

const versionCache = new Map<string, string | undefined>();

/** `node --version` of a binary (cached per binary; undefined when it fails). */
export function probeNodeVersion(
  command: string,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const key = `${command}\u0000${env.PATH ?? ""}`;
  if (versionCache.has(key)) return versionCache.get(key);
  let version: string | undefined;
  try {
    const out = execFileSync(command, ["--version"], {
      encoding: "utf8",
      timeout: 5_000,
      env: env as NodeJS.ProcessEnv,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    version = parseVersion(out) ? out.replace(/^v/, "") : undefined;
  } catch {
    version = undefined;
  }
  versionCache.set(key, version);
  return version;
}

/** Candidate node installs of the usual version managers, with their versions. */
function managedNodes(home: string, env: Record<string, string | undefined>) {
  const roots: Array<{ glob: string; sub: string }> = [];
  const nvm = env.NVM_DIR ?? join(home, ".nvm");
  roots.push({ glob: join(nvm, "versions", "node"), sub: "bin/node" });
  const fnm = [
    env.FNM_DIR,
    join(home, ".local", "share", "fnm"),
    join(home, "Library", "Application Support", "fnm"),
  ].filter((value): value is string => !!value);
  for (const dir of fnm) {
    roots.push({
      glob: join(dir, "node-versions"),
      sub: "installation/bin/node",
    });
  }
  roots.push({
    glob: join(home, ".volta", "tools", "image", "node"),
    sub: "bin/node",
  });
  roots.push({
    glob: join(env.ASDF_DATA_DIR ?? join(home, ".asdf"), "installs", "nodejs"),
    sub: "bin/node",
  });
  roots.push({
    glob: join(home, ".local", "share", "mise", "installs", "node"),
    sub: "bin/node",
  });
  const found: Array<{ command: string; version: string }> = [];
  for (const { glob, sub } of roots) {
    let names: string[];
    try {
      names = readdirSync(glob);
    } catch {
      continue;
    }
    for (const name of names) {
      const version = parseVersion(name.replace(/^v/, ""));
      if (!version) continue;
      const command = join(glob, name, sub);
      if (!existsSync(command)) continue;
      found.push({
        command,
        version: `${version.major}.${version.minor}.${version.patch}`,
      });
    }
  }
  return found;
}

/** Homebrew's versioned formulae (`node@22`). */
function brewNodes(): Array<{ command: string; version?: string }> {
  const out: Array<{ command: string; version?: string }> = [];
  for (const prefix of ["/opt/homebrew/opt", "/usr/local/opt"]) {
    let names: string[];
    try {
      names = readdirSync(prefix);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!/^node(@\d+)?$/.test(name)) continue;
      const command = join(prefix, name, "bin", "node");
      if (existsSync(command)) out.push({ command });
    }
  }
  return out;
}

/**
 * Pick the node binary. Throws {@link NodeRuntimeError} (exit 4) when the
 * environment or config names a node that is missing or out of range.
 */
export function resolveNodeRuntime(
  runtimes: { node?: NodeRuntimeConfig | undefined } | undefined,
  input: {
    configDir: string;
    env?: Record<string, string | undefined>;
    home?: string;
  },
): NodeResolution {
  const env = input.env ?? process.env;
  const wanted = runtimes?.node;
  const explicit = env.CAIRN_NODE;
  if (explicit !== undefined && explicit.trim() !== "") {
    const version = probeNodeVersion(explicit, env);
    if (!version) {
      throw new NodeRuntimeError(
        `CAIRN_NODE=${explicit} cannot run (\`${explicit} --version\` failed)`,
      );
    }
    if (wanted?.version && !satisfiesRange(version, wanted.version)) {
      throw new NodeRuntimeError(
        `CAIRN_NODE=${explicit} is node ${version}, which does not satisfy runtimes.node.version ${wanted.version}`,
      );
    }
    return { command: explicit, version, source: "CAIRN_NODE" };
  }
  if (wanted?.path) {
    const command =
      isAbsolute(wanted.path) || !/[\\/]/.test(wanted.path)
        ? wanted.path
        : resolve(input.configDir, wanted.path);
    const version = probeNodeVersion(command, env);
    if (!version) {
      throw new NodeRuntimeError(
        `runtimes.node.path ${wanted.path} cannot run (\`${command} --version\` failed)`,
      );
    }
    if (wanted.version && !satisfiesRange(version, wanted.version)) {
      throw new NodeRuntimeError(
        `runtimes.node.path ${wanted.path} is node ${version}, which does not satisfy runtimes.node.version ${wanted.version}`,
      );
    }
    return { command, version, source: "runtimes.node.path" };
  }
  const pathVersion = probeNodeVersion("node", env);
  if (!wanted?.version) {
    if (!pathVersion) {
      throw new NodeRuntimeError(
        "no `node` on PATH: node scripts and verifiers need one (set CAIRN_NODE or runtimes.node.path)",
      );
    }
    return { command: "node", version: pathVersion, source: "PATH" };
  }
  if (pathVersion && satisfiesRange(pathVersion, wanted.version)) {
    return {
      command: "node",
      version: pathVersion,
      source: "runtimes.node.version (PATH)",
    };
  }
  // Version managers: the highest install that satisfies the range.
  const candidates = [
    ...managedNodes(input.home ?? homedir(), env),
    ...brewNodes().flatMap((entry) => {
      const version = probeNodeVersion(entry.command, env);
      return version ? [{ command: entry.command, version }] : [];
    }),
  ]
    .filter((entry) => satisfiesRange(entry.version, wanted.version!))
    .toSorted((a, b) =>
      compareVersions(parseVersion(b.version)!, parseVersion(a.version)!),
    );
  const best = candidates[0];
  if (best) {
    return {
      command: best.command,
      version: best.version,
      source: "runtimes.node.version (version manager)",
    };
  }
  throw new NodeRuntimeError(
    `runtimes.node.version ${wanted.version} is not met: ${
      pathVersion ? `node on PATH is ${pathVersion}` : "no node on PATH"
    } and no matching install was found under nvm, fnm, volta, asdf, mise or Homebrew. ` +
      `Install one, or point runtimes.node.path / CAIRN_NODE at it.`,
  );
}

/** Test seam: forget probed versions. */
export function clearNodeVersionCache(): void {
  versionCache.clear();
}
