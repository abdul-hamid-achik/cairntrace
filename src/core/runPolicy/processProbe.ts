import { spawnSync } from "node:child_process";
import { isPidAlive } from "../artifacts/invocationJournal";
import { targetChildEnv } from "../processEnv";

/** One row of the process table. */
export interface ProcessRow {
  pid: number;
  ppid: number;
  command: string;
}

/**
 * What the run policy needs to know about the machine's processes, behind
 * one seam so tests drive it with fake processes (never the real table).
 */
export interface ProcessProbe {
  list(): ProcessRow[];
  /** Working directory of a process, when it can be read. */
  cwd(pid: number): string | undefined;
  /** Seconds the process has been running, when it can be read. */
  elapsedSeconds(pid: number): number | undefined;
  isAlive(pid: number): boolean;
  /** The command line of one process, when it still exists. */
  command(pid: number): string | undefined;
  /**
   * When the process started (`ps -o lstart=`, as text), when it can be
   * read: with the command, the identity that tells a recycled pid apart.
   */
  startTime?(pid: number): string | undefined;
}

function ps(args: string[]): string | undefined {
  const result = spawnSync("ps", args, {
    encoding: "utf8",
    timeout: 5_000,
    // `lstart` is locale-formatted: keep it parseable.
    env: { ...targetChildEnv(process.env), LC_ALL: "C", LANG: "C" },
  });
  if (result.error || result.status !== 0) return undefined;
  return result.stdout;
}

/** `ps` `etime` (`[[dd-]hh:]mm:ss`) to seconds. */
export function parseEtime(text: string): number | undefined {
  const match = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/.exec(text.trim());
  if (!match) return undefined;
  const [, d, h, m, s] = match;
  return (
    Number(d ?? 0) * 86_400 +
    Number(h ?? 0) * 3_600 +
    Number(m) * 60 +
    Number(s)
  );
}

export const systemProcessProbe: ProcessProbe = {
  list() {
    const out = ps(["-axo", "pid=,ppid=,command="]);
    if (out === undefined) return [];
    const rows: ProcessRow[] = [];
    for (const line of out.split("\n")) {
      const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
      if (match) {
        rows.push({
          pid: Number(match[1]),
          ppid: Number(match[2]),
          command: match[3]!,
        });
      }
    }
    return rows;
  },
  cwd(pid) {
    const result = spawnSync(
      "lsof",
      ["-a", "-p", String(pid), "-d", "cwd", "-Fn"],
      {
        encoding: "utf8",
        timeout: 5_000,
        env: targetChildEnv(process.env),
      },
    );
    if (result.error || result.status !== 0) return undefined;
    const line = result.stdout.split("\n").find((l) => l.startsWith("n"));
    return line ? line.slice(1) : undefined;
  },
  elapsedSeconds(pid) {
    const out = ps(["-o", "etime=", "-p", String(pid)]);
    return out === undefined ? undefined : parseEtime(out);
  },
  isAlive(pid) {
    if (!isPidAlive(pid)) return false;
    // A zombie has exited; it is only waiting to be reaped.
    const stat = ps(["-o", "stat=", "-p", String(pid)])?.trim();
    return !stat?.startsWith("Z");
  },
  command(pid) {
    const out = ps(["-o", "command=", "-p", String(pid)]);
    const text = out?.trim();
    return text ? text : undefined;
  },
  startTime(pid) {
    const out = ps(["-o", "lstart=", "-p", String(pid)]);
    const text = out?.trim().replace(/\s+/g, " ");
    return text ? text : undefined;
  },
};
