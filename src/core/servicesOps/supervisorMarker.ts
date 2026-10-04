import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isAlive, processStartedAt } from "./tunnels";

/**
 * While a run supervises the windows of a tmux session (restart policies,
 * `healthcheck.onUnhealthy`), it keeps a marker naming itself in the
 * services state directory. A `cairn services restart` from another process
 * reads it and refuses (exit 4) instead of racing the supervisor over the
 * same panes. A marker whose owner is gone (a crashed run) is ignored.
 */

export interface SupervisorMarker {
  version: 1;
  session: string;
  pid: number;
  /** The owner's start time (`ps -o lstart`), against pid reuse. */
  startedAt?: string;
  windows: string[];
}

export function supervisorMarkerPath(
  stateRoot: string,
  session: string,
): string {
  const segment =
    session.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "") ||
    "session";
  const hash = createHash("sha256").update(session).digest("hex").slice(0, 8);
  return join(stateRoot, `tmux-supervisor.${segment}.${hash}.json`);
}

/** Record this process as the supervisor of `session` (best-effort). */
export function writeSupervisorMarker(
  stateRoot: string,
  session: string,
  windows: readonly string[],
): void {
  const startedAt = processStartedAt(process.pid);
  const marker: SupervisorMarker = {
    version: 1,
    session,
    pid: process.pid,
    ...(startedAt ? { startedAt } : {}),
    windows: [...windows],
  };
  try {
    mkdirSync(stateRoot, { recursive: true });
    writeFileSync(
      supervisorMarkerPath(stateRoot, session),
      JSON.stringify(marker, null, 2),
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Evidence for other processes only; supervision works without it.
  }
}

/** Remove the marker when this process wrote it. */
export function removeSupervisorMarker(
  stateRoot: string,
  session: string,
): void {
  const path = supervisorMarkerPath(stateRoot, session);
  const marker = readMarker(path);
  if (marker && marker.pid !== process.pid) return;
  rmSync(path, { force: true });
}

function readMarker(path: string): SupervisorMarker | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as SupervisorMarker;
    return parsed?.version === 1 && Number.isInteger(parsed.pid)
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/** The live supervisor of `session`, or undefined (none, or its owner is gone). */
export function liveSupervisor(
  stateRoot: string,
  session: string,
): SupervisorMarker | undefined {
  const marker = readMarker(supervisorMarkerPath(stateRoot, session));
  if (!marker || marker.session !== session || !isAlive(marker.pid)) {
    return undefined;
  }
  if (marker.startedAt) {
    const now = processStartedAt(marker.pid);
    if (
      now !== undefined &&
      Math.abs(Date.parse(now) - Date.parse(marker.startedAt)) > 5_000
    ) {
      return undefined;
    }
  }
  return marker;
}
