import { spawnSync } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { targetChildEnv } from "../processEnv";
import type { ServicesConfig } from "../schema/config.v1";
import type { VerifyCleanEntry, VerifyCleanKind } from "./schema";
import { BROWSER_COMMAND_RE, survivorsOf } from "./orphans";
import { isRunSessionName, ledgerWrittenAt, listLedger } from "./sessionLedger";
import type { ProcessProbe } from "./processProbe";
import { tmuxSessionTarget } from "../runner/tmuxTarget";
import { systemProcessProbe } from "./processProbe";

/**
 * `run.verifyClean`: assert that nothing of this project is left running,
 * before the run (a dirty machine refuses it, exit 4) and after it (exit 9,
 * reporting what survived). Only resources that are cairn's own or this
 * project's are ever considered:
 *
 *  - `browsers`: browser sessions the ledger names (any invocation of this
 *    project's config directory, while each pid is still the process cairn
 *    learnt), and agent-browser daemons of cairn *run* sessions (their
 *    `<session>.pid` file in agent-browser's state directory) working inside
 *    the project. Another project's browser, a discovery or user session and
 *    any process that merely mentions agent-browser are never flagged; cairn
 *    itself and its whole ancestor chain are ignored.
 *  - `tmux`: the services tmux session of this config (or the named one).
 *  - `docker-project`: containers of the compose project (or the named one).
 */

export interface CleanlinessFinding {
  kind: VerifyCleanKind;
  /** The tmux session or compose project, when the check had one. */
  name?: string;
  clean: boolean;
  /** One redacted line per survivor. */
  survivors: string[];
  /**
   * Why a check counted as clean without looking (the Docker daemon is not
   * reachable, so no container can be running), redacted.
   */
  warnings?: string[];
}

/** A command seam for tmux / docker, so tests never touch real ones. */
export type CommandRunner = (
  file: string,
  args: readonly string[],
  env: Record<string, string | undefined>,
) => { status: number | null; stdout: string; stderr: string; error?: string };

export const systemCommandRunner: CommandRunner = (file, args, env) => {
  const result = spawnSync(file, [...args], {
    encoding: "utf8",
    timeout: 20_000,
    env: targetChildEnv(env as NodeJS.ProcessEnv),
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    ...(result.error ? { error: (result.error as Error).message } : {}),
  };
};

export interface CleanlinessContext {
  /** The config directory: the project root `browsers` scopes to. */
  projectDir: string;
  /** The effective services block of the environment. */
  services?: ServicesConfig | undefined;
  env: Record<string, string | undefined>;
  /** Pids that are cairn itself (never survivors): this process and its parents. */
  ignorePids?: readonly number[];
  redact: (text: string) => string;
  probe?: ProcessProbe;
  run?: CommandRunner;
  ledgerRoot?: string;
  /** agent-browser's state directory (default `~/.agent-browser`). */
  agentBrowserStateDir?: string;
  now?: number;
}

/** What `verifyClean` entries mean for an environment. */
export interface CleanlinessTarget {
  kind: VerifyCleanKind;
  name?: string;
}

/** The compose project a docker command starts: `-p x`, env, else the cwd's name. */
export function deriveComposeProject(
  services: ServicesConfig | undefined,
  configDir: string,
  env: Record<string, string | undefined>,
): string | undefined {
  const docker = services?.docker;
  if (!docker) return env.COMPOSE_PROJECT_NAME || undefined;
  const flag =
    /(?:^|\s)(?:-p|--project-name)(?:\s+|=)([A-Za-z0-9][\w.-]*)/.exec(
      docker.command,
    );
  if (flag) return flag[1];
  const named = docker.env?.COMPOSE_PROJECT_NAME ?? env.COMPOSE_PROJECT_NAME;
  if (named) return named;
  // Compose's default: the working directory's name, lowercased, with
  // anything outside [a-z0-9_-] dropped.
  const dir = basename(resolve(configDir, docker.cwd ?? "."));
  const sanitized = dir.toLowerCase().replace(/[^a-z0-9_-]/g, "");
  return sanitized || undefined;
}

/**
 * Resolve the entries against the environment. A kind whose name cannot be
 * derived (`tmux` with no `services.tmux`) is an error message, not a
 * silently-clean check.
 */
export function resolveCleanlinessTargets(
  entries: readonly VerifyCleanEntry[],
  ctx: Pick<CleanlinessContext, "services" | "projectDir" | "env">,
): { targets: CleanlinessTarget[]; problems: string[] } {
  const targets: CleanlinessTarget[] = [];
  const problems: string[] = [];
  for (const entry of entries) {
    const kind: VerifyCleanKind =
      typeof entry === "string"
        ? entry
        : entry.tmux !== undefined
          ? "tmux"
          : entry["docker-project"] !== undefined
            ? "docker-project"
            : "browsers";
    const explicit =
      typeof entry === "string"
        ? undefined
        : (entry.tmux ?? entry["docker-project"]);
    if (kind === "browsers") {
      targets.push({ kind });
    } else if (kind === "tmux") {
      const name = explicit ?? ctx.services?.tmux?.session;
      if (!name) {
        problems.push(
          "verifyClean: tmux needs a session: this environment has no services.tmux (write { tmux: <session> })",
        );
      } else targets.push({ kind, name });
    } else {
      const name =
        explicit ?? deriveComposeProject(ctx.services, ctx.projectDir, ctx.env);
      if (!name) {
        problems.push(
          "verifyClean: docker-project needs a compose project name (write { docker-project: <name> })",
        );
      } else targets.push({ kind, name });
    }
  }
  return { targets, problems };
}

function canonical(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function inside(dir: string, root: string): boolean {
  const d = canonical(dir);
  const r = canonical(root);
  return d === r || d.startsWith(r.endsWith(sep) ? r : `${r}${sep}`);
}

/** The given pids plus every ancestor of theirs the process table shows. */
function withAncestors(
  pids: readonly number[],
  rows: readonly { pid: number; ppid: number }[],
): Set<number> {
  const parent = new Map(rows.map((row) => [row.pid, row.ppid]));
  const out = new Set<number>();
  for (const start of pids) {
    let pid: number | undefined = start;
    for (let hops = 0; pid !== undefined && pid > 1 && hops < 64; hops++) {
      if (out.has(pid) && pid !== start) break;
      out.add(pid);
      pid = parent.get(pid);
    }
  }
  return out;
}

/** `<session>.pid` files of cairn run sessions in agent-browser's state dir. */
function runSessionDaemons(
  stateDirs: readonly string[],
): Array<{ session: string; pid: number }> {
  const out: Array<{ session: string; pid: number }> = [];
  for (const dir of new Set(stateDirs)) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.endsWith(".pid")) continue;
      const session = name.slice(0, -".pid".length);
      if (!isRunSessionName(session)) continue;
      try {
        const pid = Number(readFileSync(join(dir, name), "utf8").trim());
        if (Number.isInteger(pid) && pid > 1) out.push({ session, pid });
      } catch {
        // gone meanwhile
      }
    }
  }
  return out;
}

function line(
  pid: number,
  command: string,
  redact: (t: string) => string,
): string {
  const shown = command.length > 160 ? `${command.slice(0, 157)}...` : command;
  return redact(`pid ${pid} ${shown}`);
}

function checkBrowsers(ctx: CleanlinessContext): CleanlinessFinding {
  const probe = ctx.probe ?? systemProcessProbe;
  const rows = probe.list();
  // cairn itself and everything above it (the shell, a wrapper, an MCP
  // client) are never survivors.
  const ignore = withAncestors(ctx.ignorePids ?? [], rows);
  const found = new Map<number, string>();
  const stateDirs = [
    ctx.agentBrowserStateDir ?? join(homedir(), ".agent-browser"),
  ];
  // 1. Sessions the ledger names for this project.
  for (const { path, entry } of listLedger(ctx.ledgerRoot)) {
    if (entry.stateDir) stateDirs.push(entry.stateDir);
    if (
      entry.projectDir === undefined ||
      !inside(entry.projectDir, ctx.projectDir)
    ) {
      continue;
    }
    // Any live browser of this project counts: before a run it means the
    // machine is busy (another run, or a leftover); after one, a survivor.
    for (const p of survivorsOf(entry, probe, rows, {
      writtenAtMs: ledgerWrittenAt(path),
    })) {
      if (!ignore.has(p.pid)) found.set(p.pid, p.command);
    }
  }
  // 2. agent-browser daemons of cairn run sessions working inside this
  //    project whose ledger entry is gone (a crashed run). Discovery and
  //    user sessions have other names and are never counted.
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  for (const { pid } of runSessionDaemons(stateDirs).slice(0, 60)) {
    if (found.has(pid) || ignore.has(pid) || !probe.isAlive(pid)) continue;
    const command = byPid.get(pid)?.command ?? probe.command(pid);
    if (!command || !BROWSER_COMMAND_RE.test(command)) continue;
    const cwd = probe.cwd(pid);
    if (!cwd || !inside(cwd, ctx.projectDir)) continue;
    found.set(pid, command);
    for (const row of rows) {
      if (row.ppid === pid && !ignore.has(row.pid)) {
        found.set(row.pid, row.command);
      }
    }
  }
  const survivors = [...found.entries()]
    .toSorted((a, b) => a[0] - b[0])
    .map(([pid, command]) => line(pid, command, ctx.redact));
  return { kind: "browsers", clean: survivors.length === 0, survivors };
}

function checkTmux(name: string, ctx: CleanlinessContext): CleanlinessFinding {
  const run = ctx.run ?? systemCommandRunner;
  // `=name`: this exact session, never a prefix match such as `name-wt`.
  const result = run(
    "tmux",
    ["has-session", "-t", tmuxSessionTarget(name)],
    ctx.env,
  );
  // tmux absent (spawn error) or no such session: nothing of ours is there.
  const present = !result.error && result.status === 0;
  return {
    kind: "tmux",
    name,
    clean: !present,
    survivors: present ? [`tmux session "${name}" exists`] : [],
  };
}

function checkDockerProject(
  name: string,
  ctx: CleanlinessContext,
): CleanlinessFinding {
  const run = ctx.run ?? systemCommandRunner;
  const result = run(
    "docker",
    ["ps", "-q", "--filter", `label=com.docker.compose.project=${name}`],
    ctx.env,
  );
  if (result.error || result.status !== 0) {
    const why = ctx.redact(
      (result.error ?? result.stderr).trim().split("\n")[0] ?? "docker failed",
    );
    // No docker CLI, or a daemon that is down: no container of the project
    // can be running, so the machine is clean of it (a warning says why).
    // Anything else (permission denied, a bad context) cannot be verified.
    if (dockerUnreachable(result)) {
      return {
        kind: "docker-project",
        name,
        clean: true,
        survivors: [],
        warnings: [
          `docker-project "${name}": the Docker daemon is not reachable (${why}); counted as clean`,
        ],
      };
    }
    return {
      kind: "docker-project",
      name,
      clean: false,
      survivors: [`could not verify compose project "${name}": ${why}`],
    };
  }
  const ids = result.stdout
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    kind: "docker-project",
    name,
    clean: ids.length === 0,
    survivors: ids.map(
      (id) => `container ${id.slice(0, 12)} of compose project "${name}"`,
    ),
  };
}

/** The docker CLI is missing or its daemon is down (not a verification failure). */
function dockerUnreachable(result: ReturnType<CommandRunner>): boolean {
  if (result.error) return /ENOENT|not found/i.test(result.error);
  return /cannot connect to the docker daemon|is the docker daemon running|error during connect|docker daemon is not running|failed to connect to the docker api/i.test(
    result.stderr,
  );
}

/** Check every target; the results keep the order of `targets`. */
export function verifyClean(
  targets: readonly CleanlinessTarget[],
  ctx: CleanlinessContext,
): CleanlinessFinding[] {
  return targets.map((target) => {
    switch (target.kind) {
      case "browsers":
        return checkBrowsers(ctx);
      case "tmux":
        return checkTmux(target.name!, ctx);
      case "docker-project":
        return checkDockerProject(target.name!, ctx);
    }
  });
}
