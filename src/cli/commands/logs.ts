import { createReadStream, existsSync } from "node:fs";
import { open, readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative } from "node:path";
import {
  INVOCATIONS_DIR,
  INVOCATION_ID_PATTERN,
  invocationIdPid,
  isPidAlive,
  listInvocationIds,
  readInvocationJournal,
} from "../../core/artifacts/invocationJournal";
import type { InvocationJournalFile } from "../../core/schema/events.v1";
import { emit, resolveFormat } from "../format";
// resolveRunRef's latest/previous only see run directories, never the
// invocation journal folder (`_invocations/`) beside them.
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
  /**
   * Keep streaming (events.ndjson, or the `--log` files) until the run or
   * invocation settles. Exit 0 once it settled; 2 when its process died
   * without settling or the target does not exist.
   */
  follow?: boolean;
  /**
   * A live log instead of events.ndjson. Runs: `run` (run.log),
   * `precondition`, `outcome`, or a file name under logs/. Invocations:
   * `narration`, `services`, `hook`, or a file name under logs/.
   */
  log?: string;
  /** An invocation journal id, `latest` or `previous` instead of a run. */
  invocation?: string;
  /** Invocation summary format (no --follow): json | yaml | md. */
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  /** Internal: follow poll interval (default 500ms). */
  pollMs?: number;
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
 *   cairn logs latest --services  list run-local service artifacts
 *   cairn logs latest --service web-api
 *                                 replay one run-local tmux pane log
 *   cairn logs latest --follow    tail events.ndjson until the run settles
 *                                 (the newest live invocation's current
 *                                 run; one still booting is waited on)
 *   cairn logs latest --follow --log precondition
 *                                 tail the live precondition logs instead
 *   cairn logs --invocation latest [--follow] [--log narration]
 *                                 the invocation journal (_invocations/<id>);
 *                                 follows services and --before hooks too
 *
 * `--format`/`--json` shape the invocation summary only; on a run
 * reference they are refused (exit 2) rather than ignored.
 *
 * `ref` accepts a run directory name, an absolute path, `latest`, or
 * `previous` (same grammar as stash/investigate). Service lookups default to
 * `latest`, then fall back to the legacy ~/.cairntrace/services pane logs when
 * that run has no matching run-local artifact.
 */
export async function logsCommand(
  ref: string | undefined,
  opts: LogsCommandOptions,
): Promise<void> {
  const servicesRoot =
    process.env.CAIRN_SERVICES_LOG_ROOT ??
    join(homedir(), ".cairntrace", "services");
  const runsRoot = await resolveArtifactRoot({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });

  if (opts.invocation !== undefined) {
    process.exitCode = await invocationLogs(runsRoot, opts.invocation, opts);
    return;
  }

  // Run references print a text listing or stream raw files; a structured
  // format would be silently ignored, so an agent asking for JSON is told.
  if (opts.json || opts.yaml || (opts.format && opts.format !== "md")) {
    process.stderr.write(
      "cairn logs: --format/--json apply to invocation summaries " +
        "(--invocation <id|latest|previous>); a run reference prints a text " +
        "listing — use --events for its NDJSON event stream\n",
    );
    process.exitCode = 2;
    return;
  }

  if (opts.service || opts.services) {
    const runDir = await resolveRunRef(ref ?? "latest", runsRoot).catch(
      () => undefined,
    );
    if (runDir) {
      if (opts.service) {
        const localResult = await streamRunServicePaneLog(runDir, opts.service);
        if (localResult !== undefined) {
          process.exitCode = localResult;
          return;
        }
      } else {
        const localResult = await listRunServiceArtifacts(runDir);
        if (localResult !== undefined) {
          process.exitCode = localResult;
          return;
        }
      }
    }

    // Compatibility for runs created before service artifacts lived inside
    // the run pack. This fallback can be removed after old pane logs age out.
    process.exitCode = opts.service
      ? await streamServicePaneLog(servicesRoot, opts.service)
      : await listServicePaneLogs(servicesRoot);
    return;
  }

  if (!ref) {
    process.exitCode = await listRuns(runsRoot);
    return;
  }

  let runDir: string;
  try {
    const live =
      ref === "latest" && opts.follow
        ? await liveInvocationRun(runsRoot, opts.pollMs ?? 500)
        : undefined;
    if (live && "stopped" in live) {
      process.stderr.write(`cairn logs: ${live.stopped}\n`);
      process.exitCode = 2;
      return;
    }
    runDir = live?.runDir ?? (await resolveRunRef(ref, runsRoot));
  } catch (e) {
    process.stderr.write(`cairn logs: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  if (opts.follow || opts.log !== undefined) {
    process.exitCode = await runLogs(runDir, opts);
    return;
  }
  if (opts.events) {
    process.exitCode = await streamFile(
      join(runDir, "events.ndjson"),
      `no events.ndjson in ${runDir}`,
    );
    return;
  }
  process.exitCode = await showRun(runDir);
}

/**
 * List a run's self-contained service artifacts. `undefined` means the run has
 * no local service pack, so callers may fall back to the legacy global logs.
 */
async function listRunServiceArtifacts(
  runDir: string,
): Promise<number | undefined> {
  const servicesDir = join(runDir, "services");
  const files = await collectRegularFiles(servicesDir);
  if (files.length === 0) return undefined;

  files.sort((a, b) => {
    const aManifest = a.relative === "manifest.json" ? 0 : 1;
    const bManifest = b.relative === "manifest.json" ? 0 : 1;
    return aManifest - bManifest || a.relative.localeCompare(b.relative);
  });

  process.stdout.write(`service artifacts: ${servicesDir}\n`);
  for (const file of files) {
    process.stdout.write(
      `  ${`services/${file.relative}`.padEnd(44)} ${formatBytes(file.bytes)}\n`,
    );
  }
  process.stdout.write(
    `\nreplay one: cairn logs ${runDir.split("/").pop()} --service <window>\n`,
  );
  return 0;
}

async function collectRegularFiles(
  root: string,
): Promise<Array<{ relative: string; bytes: number }>> {
  const files: Array<{ relative: string; bytes: number }> = [];
  const visit = async (directory: string): Promise<void> => {
    const entries = await readdir(directory, { withFileTypes: true }).catch(
      () => [],
    );
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(path);
      } else if (entry.isFile()) {
        const size = (await stat(path).catch(() => undefined))?.size;
        if (size !== undefined) {
          files.push({
            relative: relative(root, path).replaceAll("\\", "/"),
            bytes: size,
          });
        }
      }
    }
  };
  await visit(root);
  return files;
}

/**
 * Stream `services/tmux/<sanitized-window>.log` when present. `undefined`
 * signals absence so the legacy global pane-log fallback remains available.
 */
async function streamRunServicePaneLog(
  runDir: string,
  window: string,
): Promise<number | undefined> {
  const safeWindow = sanitizeServiceWindow(window);
  if (!safeWindow) return undefined;
  const path = join(runDir, "services", "tmux", `${safeWindow}.log`);
  const file = await stat(path).catch(() => undefined);
  if (!file?.isFile()) return undefined;
  return streamFile(path, `run-local pane log disappeared: ${safeWindow}.log`);
}

function sanitizeServiceWindow(window: string): string | undefined {
  const safe = window
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "");
  return safe && safe !== "." && safe !== ".." ? safe : undefined;
}

async function listRuns(runsRoot: string): Promise<number> {
  const entries = await readdir(runsRoot).catch(() => [] as string[]);
  const dirs = (
    await Promise.all(
      entries.map(async (name) => {
        // Invocation journals live beside the runs; they are not runs.
        if (name === INVOCATIONS_DIR) return undefined;
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
  process.stdout.write(
    `follow live:   cairn logs ${runDir.split("/").pop()} --follow [--log run|precondition|outcome]\n`,
  );
  return 0;
}

/* ----- --follow / --log / --invocation ----- */

type SettleState = "running" | "settled" | "dead";

/**
 * The run `cairn logs latest --follow` should follow while a `cairn run` is
 * still going: the current run of the newest invocation whose process is
 * alive. The newest run folder alone is wrong there — while the invocation
 * boots (services, `--before` hooks) no folder exists yet, and the newest
 * one belongs to the previous, finished run, which would "settle" at once.
 * Such an invocation is waited on until its first run starts. Undefined when
 * no invocation is live (plain `latest` applies); `stopped` when the
 * invocation ended before it started any run.
 */
async function liveInvocationRun(
  runsRoot: string,
  pollMs: number,
): Promise<{ runDir: string } | { stopped: string } | undefined> {
  const id = (await listInvocationIds(runsRoot)).at(-1);
  if (!id) return undefined;
  const dir = join(runsRoot, INVOCATIONS_DIR, id);
  let waited = false;
  for (;;) {
    const journal = await readInvocationJournal(dir);
    const live = journal?.status === "running" && isPidAlive(journal.pid);
    const runId = journal?.current?.runId;
    if (runId && (live || waited)) {
      const entry = journal?.runs.find((run) => run.runId === runId);
      return { runDir: entry?.runDir ?? join(runsRoot, runId) };
    }
    if (!live) {
      return waited
        ? {
            stopped: `invocation ${id} ended (${journal?.status ?? "unreadable"}) before it started a run; see cairn logs --invocation ${id}`,
          }
        : undefined;
    }
    if (!waited) {
      process.stderr.write(
        `cairn logs: invocation ${id} has not started a run yet (services or --before hooks); waiting for it — cairn logs --invocation latest --follow shows that phase\n`,
      );
      waited = true;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, pollMs));
  }
}

/** One run: events.ndjson or the chosen live log, optionally followed. */
async function runLogs(
  runDir: string,
  opts: LogsCommandOptions,
): Promise<number> {
  if (!(await stat(runDir).catch(() => undefined))?.isDirectory()) {
    process.stderr.write(`cairn logs: no run at ${runDir}\n`);
    return 2;
  }
  const selection = opts.log ?? "events";
  const files = runLogFiles(runDir, selection);
  if (!opts.follow) {
    const paths = await files();
    if (paths.length === 0) {
      process.stderr.write(`cairn logs: no ${selection} log in ${runDir}\n`);
      return 2;
    }
    return followFiles({
      files: async () => paths,
      state: async () => "settled",
      pollMs: 0,
      headers: paths.length > 1,
      root: runDir,
    });
  }
  return followFiles({
    files,
    state: () => runSettleState(runDir),
    pollMs: opts.pollMs ?? 500,
    headers: selection === "precondition" || selection === "outcome",
    root: runDir,
    deadMessage: `run ${runDir.split("/").pop()} stopped without finishing (interrupted)`,
  });
}

function runLogFiles(
  runDir: string,
  selection: string,
): () => Promise<string[]> {
  switch (selection) {
    case "events":
      return async () => [join(runDir, "events.ndjson")];
    case "run":
      return async () => [join(runDir, "run.log")];
    case "precondition":
    case "outcome":
      return () => listLogFiles(join(runDir, "logs"), `${selection}-`);
    default:
      return async () => [namedLogFile(runDir, selection)];
  }
}

/** The invocation journal: summary, events, or a live log, optionally followed. */
async function invocationLogs(
  runsRoot: string,
  ref: string,
  opts: LogsCommandOptions,
): Promise<number> {
  const dir = await resolveInvocationRef(runsRoot, ref);
  if (!dir) {
    process.stderr.write(
      `cairn logs: no invocation "${ref}" under ${runsRoot}\n`,
    );
    return 2;
  }
  if (!opts.follow && opts.log === undefined && !opts.events) {
    const journal = await readInvocationJournal(dir);
    if (!journal) {
      process.stderr.write(
        `cairn logs: unreadable invocation.json in ${dir}\n`,
      );
      return 2;
    }
    const format = resolveFormat(opts, "md");
    process.stdout.write(
      emit(format, journal, (value) => renderInvocation(value, dir)),
    );
    if (format === "md") process.stdout.write("\n");
    return 0;
  }
  const selection = opts.log ?? "events";
  const files = invocationLogFiles(dir, selection);
  if (!opts.follow) {
    const paths = await files();
    if (paths.length === 0) {
      process.stderr.write(`cairn logs: no ${selection} log in ${dir}\n`);
      return 2;
    }
    return followFiles({
      files: async () => paths,
      state: async () => "settled",
      pollMs: 0,
      headers: paths.length > 1,
      root: dir,
    });
  }
  return followFiles({
    files,
    state: () => invocationSettleState(dir),
    pollMs: opts.pollMs ?? 500,
    headers: selection === "services" || selection === "hook",
    root: dir,
    deadMessage: `invocation ${dir.split("/").pop()} stopped without finishing (interrupted)`,
  });
}

function invocationLogFiles(
  dir: string,
  selection: string,
): () => Promise<string[]> {
  switch (selection) {
    case "events":
      return async () => [join(dir, "events.ndjson")];
    case "narration":
      return async () => [join(dir, "logs", "narration.log")];
    case "services":
    case "hook":
      return () => listLogFiles(join(dir, "logs"), `${selection}-`);
    default:
      return async () => [namedLogFile(dir, selection)];
  }
}

/** `latest` / `previous` (by id, i.e. start time), an id, or a path. */
async function resolveInvocationRef(
  runsRoot: string,
  ref: string,
): Promise<string | undefined> {
  let dir: string;
  if (ref === "latest" || ref === "previous") {
    const ids = await listInvocationIds(runsRoot);
    const id = ids.at(ref === "latest" ? -1 : -2);
    if (!id) return undefined;
    dir = join(runsRoot, INVOCATIONS_DIR, id);
  } else if (isAbsolute(ref)) {
    dir = ref;
  } else if (INVOCATION_ID_PATTERN.test(ref)) {
    dir = join(runsRoot, INVOCATIONS_DIR, ref);
  } else {
    return undefined;
  }
  return (await stat(dir).catch(() => undefined))?.isDirectory()
    ? dir
    : undefined;
}

/** `logs/<name>` (with or without `.log`), confined to the logs directory. */
function namedLogFile(root: string, name: string): string {
  const safe = name
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[.-]+/, "");
  const file = safe.endsWith(".log") ? safe : `${safe}.log`;
  return join(root, "logs", file);
}

async function listLogFiles(dir: string, prefix: string): Promise<string[]> {
  const names = await readdir(dir).catch(() => [] as string[]);
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(".log"))
    .toSorted()
    .map((name) => join(dir, name));
}

/**
 * A run is settled once its artifact manifest exists: the runner writes it
 * last, after the final run.* event and after closing run.log. A run whose
 * invocation ended (or whose writer process is gone) without a manifest was
 * interrupted.
 */
async function runSettleState(runDir: string): Promise<SettleState> {
  if (existsSync(join(runDir, "artifact-manifest.json"))) return "settled";
  const owner = await runOwner(runDir);
  if (owner.invocationDir) {
    const journal = await readInvocationJournal(owner.invocationDir);
    if (journal && journal.status !== "running") {
      // The invocation already settled; give the manifest one more check.
      return existsSync(join(runDir, "artifact-manifest.json"))
        ? "settled"
        : "dead";
    }
    if (journal && !isPidAlive(journal.pid)) return "dead";
  }
  if (owner.pid !== undefined && !isPidAlive(owner.pid)) return "dead";
  if (owner.pid === undefined && !owner.invocationDir) {
    // No writer identity (a run from an older cairn, or killed before its
    // first heartbeat): a live run appends at least every 15s, so a log that
    // stayed silent this long belongs to a run that is gone.
    const modified = (
      await stat(join(runDir, "events.ndjson")).catch(() => undefined)
    )?.mtimeMs;
    if (modified !== undefined && Date.now() - modified > STALE_RUN_MS) {
      return "dead";
    }
  }
  return "running";
}

/** Silence after which a run without writer identity counts as gone. */
const STALE_RUN_MS = 120_000;

/** Writer pid (latest heartbeat) and invocation journal of a run, if known. */
async function runOwner(
  runDir: string,
): Promise<{ pid?: number; invocationDir?: string }> {
  const text = await readFile(join(runDir, "events.ndjson"), "utf8").catch(
    () => "",
  );
  let pid: number | undefined;
  let invocationDir: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"run.started"') && !line.includes('"run.heartbeat"')) {
      continue;
    }
    try {
      const event = JSON.parse(line) as {
        type?: string;
        pid?: number;
        invocation?: { dir?: string };
      };
      if (event.type === "run.heartbeat" && typeof event.pid === "number") {
        pid = event.pid;
      }
      if (
        event.type === "run.started" &&
        typeof event.invocation?.dir === "string"
      ) {
        invocationDir = join(runDir, "..", event.invocation.dir);
      }
    } catch {
      // A torn last line while the run is writing; skip it.
    }
  }
  return {
    ...(pid !== undefined ? { pid } : {}),
    ...(invocationDir ? { invocationDir } : {}),
  };
}

async function invocationSettleState(dir: string): Promise<SettleState> {
  const journal = await readInvocationJournal(dir);
  if (journal) {
    if (journal.status !== "running") return "settled";
    return isPidAlive(journal.pid) ? "running" : "dead";
  }
  // invocation.json is unreadable (missing, or from a newer cairn): the final
  // event, the writer pid in the id, and heartbeat silence still tell.
  const eventsPath = join(dir, "events.ndjson");
  const events = await readFile(eventsPath, "utf8").catch(() => "");
  if (events.includes('"invocation.finished"')) return "settled";
  const pid = invocationIdPid(basename(dir));
  if (pid !== undefined) return isPidAlive(pid) ? "running" : "dead";
  const modified = (await stat(eventsPath).catch(() => undefined))?.mtimeMs;
  return modified === undefined || Date.now() - modified > STALE_RUN_MS
    ? "dead"
    : "running";
}

/**
 * Stream files from their current offsets until `state()` reports settled
 * (one final drain after it) or dead. New files that match the selection are
 * picked up as they appear. With `headers`, a `==> path <==` line marks each
 * switch between files (tail -f style).
 */
async function followFiles(input: {
  files: () => Promise<string[]>;
  state: () => Promise<SettleState>;
  pollMs: number;
  headers: boolean;
  root: string;
  deadMessage?: string;
}): Promise<number> {
  const offsets = new Map<string, number>();
  let lastFile: string | undefined;
  const drain = async (final: boolean): Promise<void> => {
    for (const file of await input.files()) {
      const offset = offsets.get(file) ?? 0;
      const chunk = await readFrom(file, offset, final);
      if (chunk.bytes === 0) continue;
      offsets.set(file, offset + chunk.bytes);
      if (input.headers && lastFile !== file) {
        process.stdout.write(`==> ${relative(input.root, file)} <==\n`);
      }
      lastFile = file;
      process.stdout.write(chunk.text);
    }
  };
  for (;;) {
    // Read the state BEFORE draining: whatever was written before the run
    // settled is then guaranteed to be in this (final) drain.
    const state = await input.state();
    await drain(state !== "running");
    if (state === "settled") return 0;
    if (state === "dead") {
      if (input.deadMessage) {
        process.stderr.write(`cairn logs: ${input.deadMessage}\n`);
      }
      return 2;
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, input.pollMs));
  }
}

/**
 * Bytes appended to `file` since `offset`: whole lines only while the
 * writer may still be mid-line, everything on the `final` read.
 */
async function readFrom(
  file: string,
  offset: number,
  final: boolean,
): Promise<{ text: string; bytes: number }> {
  const handle = await open(file, "r").catch(() => undefined);
  if (!handle) return { text: "", bytes: 0 };
  try {
    const size = (await handle.stat()).size;
    if (size <= offset) return { text: "", bytes: 0 };
    const buffer = Buffer.alloc(size - offset);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
    if (final) {
      const text = buffer.subarray(0, bytesRead).toString("utf8");
      return {
        text: text.endsWith("\n") || text.length === 0 ? text : `${text}\n`,
        bytes: bytesRead,
      };
    }
    // Hold back a torn last line until its newline lands.
    const lastNewline = buffer.subarray(0, bytesRead).lastIndexOf(0x0a);
    if (lastNewline < 0) return { text: "", bytes: 0 };
    return {
      text: buffer.subarray(0, lastNewline + 1).toString("utf8"),
      bytes: lastNewline + 1,
    };
  } finally {
    await handle.close();
  }
}

function renderInvocation(journal: InvocationJournalFile, dir: string): string {
  const lines = [
    `${dir}`,
    `  ${journal.status}${
      journal.signal ? ` (${journal.signal})` : ""
    } · pid ${journal.pid} · started ${journal.startedAt}${
      journal.endedAt ? ` · ended ${journal.endedAt}` : ""
    }`,
    `  planned ${journal.planned.length} run(s), parallel ${journal.parallel}${
      journal.env ? `, env ${journal.env}` : ""
    }`,
  ];
  if (journal.current && journal.status === "running") {
    lines.push(
      `  current: [${journal.current.index}/${journal.planned.length}] ${journal.current.spec}`,
    );
  }
  for (const run of journal.runs) {
    lines.push(
      `  [${run.index}/${journal.planned.length}] ${(run.status ?? "unknown").padEnd(8)} ${run.runId}`,
    );
  }
  if (journal.summary) {
    const summary = journal.summary;
    lines.push(
      `  summary: ${summary.passed}/${summary.total} passed, ${summary.failed} failed, ${summary.errored} errored in ${formatDurationMs(summary.durationMs)} (exit ${summary.exitCode})${
        summary.error ? ` — ${summary.error}` : ""
      }`,
    );
  }
  lines.push(
    "",
    `follow live: cairn logs --invocation ${journal.invocationId} --follow [--log narration|services|hook]`,
  );
  return lines.join("\n");
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
