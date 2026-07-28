import { createReadStream } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { resolveArtifactRoot, resolveRunRef } from "../runRefs";

export interface LogsCommandOptions {
  artifactRoot?: string;
  config?: string;
  /** Stream the run's events.ndjson to stdout. */
  events?: boolean;
  /** List captured service pane logs. */
  services?: boolean;
  /** Stream one service window's pane log to stdout. */
  service?: string;
}

/**
 * `cairn logs [ref]` — discovery and replay for the files of record a run
 * leaves behind. The terminal narration is a view; these files are the
 * evidence, and this command's whole job is finding and concatenating them
 * (grep/tail still work directly on the paths it prints).
 *
 *   cairn logs                    recent runs, newest first
 *   cairn logs latest             one run: status, phases, files with sizes
 *   cairn logs latest --events    replay events.ndjson to stdout (tee-able)
 *   cairn logs --services         list captured tmux pane logs
 *   cairn logs --service web-api  replay one window's pane log
 *
 * `ref` accepts a run directory name, an absolute path, `latest`, or
 * `previous` (same grammar as stash/investigate).
 */
export async function logsCommand(
  ref: string | undefined,
  opts: LogsCommandOptions,
): Promise<void> {
  const servicesRoot =
    process.env.CAIRN_SERVICES_LOG_ROOT ??
    join(homedir(), ".cairntrace", "services");
  if (opts.service) {
    process.exitCode = await streamServicePaneLog(servicesRoot, opts.service);
    return;
  }
  if (opts.services) {
    process.exitCode = await listServicePaneLogs(servicesRoot);
    return;
  }

  const runsRoot = await resolveArtifactRoot({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });

  if (!ref) {
    process.exitCode = await listRuns(runsRoot);
    return;
  }

  const runDir = await resolveRunRef(ref, runsRoot);
  if (opts.events) {
    process.exitCode = await streamFile(
      join(runDir, "events.ndjson"),
      `no events.ndjson in ${runDir}`,
    );
    return;
  }
  process.exitCode = await showRun(runDir);
}

async function listRuns(runsRoot: string): Promise<number> {
  const entries = await readdir(runsRoot).catch(() => [] as string[]);
  const dirs = (
    await Promise.all(
      entries.map(async (name) => {
        try {
          const s = await stat(join(runsRoot, name));
          return s.isDirectory() ? { name, mtime: s.mtimeMs } : undefined;
        } catch {
          return undefined;
        }
      }),
    )
  )
    .filter((d): d is { name: string; mtime: number } => d !== undefined)
    .toSorted((a, b) => b.mtime - a.mtime)
    .slice(0, 15);
  if (dirs.length === 0) {
    process.stdout.write(`no runs under ${runsRoot}\n`);
    return 0;
  }
  for (const dir of dirs) {
    const summary = await readRunSummary(join(runsRoot, dir.name));
    process.stdout.write(`${summary.padEnd(28)} ${dir.name}\n`);
  }
  process.stdout.write(
    `\nreplay one: cairn logs <name> [--events]  (also: latest, previous)\n`,
  );
  return 0;
}

/** "passed 5/5 in 28m 4s" from run.json, or "in progress / interrupted". */
async function readRunSummary(runDir: string): Promise<string> {
  try {
    const parsed = JSON.parse(
      await readFile(join(runDir, "run.json"), "utf8"),
    ) as {
      status?: string;
      durationMs?: number;
      outcomes?: Array<{ status?: string }>;
    };
    const outcomes = parsed.outcomes ?? [];
    const passed = outcomes.filter((o) => o.status === "passed").length;
    const duration =
      typeof parsed.durationMs === "number"
        ? ` in ${formatDurationMs(parsed.durationMs)}`
        : "";
    return `${parsed.status ?? "unknown"} ${passed}/${outcomes.length}${duration}`;
  } catch {
    // run.json is written last; its absence means the run is still going or
    // was killed before it could conclude.
    return "in progress / interrupted";
  }
}

async function showRun(runDir: string): Promise<number> {
  try {
    await stat(runDir);
  } catch {
    process.stderr.write(`cairn logs: no run at ${runDir}\n`);
    return 2;
  }
  process.stdout.write(`${runDir}\n`);
  process.stdout.write(`  ${await readRunSummary(runDir)}\n\n`);

  const entries = await readdir(runDir).catch(() => [] as string[]);
  for (const name of entries.toSorted()) {
    const path = join(runDir, name);
    try {
      const s = await stat(path);
      if (s.isDirectory()) {
        const children = await readdir(path).catch(() => [] as string[]);
        process.stdout.write(
          `  ${`${name}/`.padEnd(24)} ${children.length} file${
            children.length === 1 ? "" : "s"
          }\n`,
        );
      } else {
        process.stdout.write(`  ${name.padEnd(24)} ${formatBytes(s.size)}\n`);
      }
    } catch {
      // Entry vanished mid-listing (live run pruning); skip it.
    }
  }
  process.stdout.write(
    `\nreplay events: cairn logs ${runDir.split("/").pop()} --events\n`,
  );
  return 0;
}

async function listServicePaneLogs(servicesRoot: string): Promise<number> {
  const entries = await readdir(servicesRoot).catch(() => [] as string[]);
  const paneLogs = entries
    .filter((name) => name.endsWith(".pane.log"))
    .toSorted();
  if (paneLogs.length === 0) {
    process.stdout.write(`no pane logs under ${servicesRoot}\n`);
    return 0;
  }
  for (const name of paneLogs) {
    try {
      const s = await stat(join(servicesRoot, name));
      process.stdout.write(`  ${name.padEnd(40)} ${formatBytes(s.size)}\n`);
    } catch {
      // Swept between readdir and stat; skip.
    }
  }
  process.stdout.write(`\nreplay one: cairn logs --service <window>\n`);
  return 0;
}

async function streamServicePaneLog(
  servicesRoot: string,
  window: string,
): Promise<number> {
  const entries = await readdir(servicesRoot).catch(() => [] as string[]);
  // Pane logs are named <project>-<window>.pane.log; match by window so the
  // operator types the tmux window name they know, not the project prefix.
  const matches = entries
    .filter((name) => name.endsWith(`-${window}.pane.log`))
    .toSorted();
  if (matches.length === 0) {
    process.stderr.write(
      `cairn logs: no pane log for window "${window}" under ${servicesRoot}\n`,
    );
    return 2;
  }
  if (matches.length > 1) {
    process.stderr.write(
      `cairn logs: "${window}" matches ${matches.length} pane logs — pick one:\n` +
        matches.map((m) => `  ${m}\n`).join(""),
    );
    return 2;
  }
  return streamFile(
    join(servicesRoot, matches[0]!),
    `pane log disappeared: ${matches[0]!}`,
  );
}

/** Stream a file to stdout without buffering it whole (pane logs get big). */
function streamFile(path: string, missingMessage: string): Promise<number> {
  return new Promise((resolvePromise) => {
    const stream = createReadStream(path);
    stream.on("error", () => {
      process.stderr.write(`cairn logs: ${missingMessage}\n`);
      resolvePromise(2);
    });
    stream.on("end", () => resolvePromise(0));
    stream.pipe(process.stdout, { end: false });
  });
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function formatDurationMs(ms: number): string {
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms - m * 60_000) / 1000);
  return `${m}m ${s}s`;
}
