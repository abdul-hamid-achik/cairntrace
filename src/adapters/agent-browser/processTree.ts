import { spawnSync } from "node:child_process";
import { targetChildEnv } from "../../core/processEnv";

export interface ProcessTreeWatchdog {
  readonly timedOut: boolean;
  cancel(): void;
}

/** All descendant pids of `rootPid` (BFS via pgrep). Best-effort, darwin/linux. */
export function descendantPidsSync(rootPid: number): number[] {
  const descendants: number[] = [];
  const pending = [rootPid];
  const seen = new Set<number>(pending);

  while (pending.length > 0) {
    const parentPid = pending.shift()!;
    for (const childPid of directChildPidsSync(parentPid)) {
      if (seen.has(childPid)) continue;
      seen.add(childPid);
      descendants.push(childPid);
      pending.push(childPid);
    }
  }

  return descendants;
}

/**
 * Hard-kill one command process and every descendant captured before its
 * parent can exit and orphan them. Descendants are killed deepest-first so a
 * Node/npm shim cannot leave its native CLI child holding stdout/stderr open.
 */
export function killProcessTreeSync(rootPid: number | undefined): number[] {
  if (!rootPid || !Number.isInteger(rootPid) || rootPid <= 1) return [];
  const tree = [rootPid, ...descendantPidsSync(rootPid)];
  for (const pid of tree.toReversed()) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Best effort: a process may have exited between discovery and signal.
    }
  }
  return tree;
}

/**
 * Arm Cairn's authoritative hard deadline for an agent-browser CLI command.
 * The callback is for killing the independent session daemon after the client
 * tree is gone. `execa` keeps a slightly-later timeout as a fallback.
 */
export function createProcessTreeWatchdog(
  rootPid: number | undefined,
  timeoutMs: number,
  onTimeout?: () => void,
): ProcessTreeWatchdog {
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTreeSync(rootPid);
    onTimeout?.();
  }, timeoutMs);
  timer.unref?.();

  return {
    get timedOut() {
      return timedOut;
    },
    cancel() {
      clearTimeout(timer);
    },
  };
}

function directChildPidsSync(pid: number): number[] {
  try {
    const result = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
      env: targetChildEnv(process.env),
    });
    if (typeof result.stdout !== "string") return [];
    return result.stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((childPid) => Number.isInteger(childPid) && childPid > 1);
  } catch {
    return [];
  }
}
