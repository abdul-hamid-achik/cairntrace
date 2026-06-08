import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  parseSnapshot,
  type SnapshotElement,
} from "../../core/healer/snapshotParser";
import type {
  BatchStep,
  DownloadStep,
  Locator,
  Step,
} from "../../core/schema/spec.v1";
import type {
  BrowserBackend,
  ConsoleEntry,
  InvocationResult,
  NetworkEntry,
  NetworkFilter,
  ResolvedElement,
  ScreenshotResult,
  SnapshotResult,
} from "../browserBackend";
import {
  batchSubStepToArgv,
  stepToArgv,
  waitConditionToArgv,
} from "./commandBuilder";
import {
  buildGlobalArgs,
  parseEnvelope,
  parseJsonArray,
  quoteIfNeeded,
} from "./parseOutput";
import type { AgentBrowserOptions } from "./types";

/**
 * Adapter over the `agent-browser` Rust CLI (https://agent-browser.dev).
 *
 * Responsibilities:
 *   - dispatch a behavioral Step to the right agent-browser command
 *   - run via execa with the session pinned for isolation
 *   - parse `--json` output for network/console/state queries
 *   - surface raw invocation results (stdout/stderr/exitCode/durationMs) so the
 *     runner can write events.ndjson without re-shaping per command
 *
 * Lifecycle: agent-browser lazily starts a browser the first time it sees a
 * command for a given --session, so this class has no explicit `start()` —
 * just construct and start sending steps.
 */
export class AgentBrowserAdapter implements BrowserBackend {
  readonly name = "agent-browser" as const;
  private readonly binary: string;
  private readonly globalArgs: string[];
  /** Set when a child had to be killed — close() escalates to a daemon kill. */
  private sawChildTimeout = false;

  constructor(private readonly opts: AgentBrowserOptions) {
    this.binary = opts.binary ?? "agent-browser";
    this.globalArgs = buildGlobalArgs(opts);
  }

  /* ----- step dispatch ----- */

  async runStep(step: Step): Promise<InvocationResult> {
    if ("batch" in step) return this.runBatchStep(step);
    if ("download" in step) return this.runDownloadStep(step);
    if ("click" in step) return this.runInteractiveStep(step.click, "click");
    if ("hover" in step) return this.runInteractiveStep(step.hover, "hover");
    if ("fill" in step) {
      const { value, ...locator } = step.fill;
      return this.runInteractiveStep(locator as Locator, "fill", value);
    }
    if ("upload" in step) {
      const { path, ...locator } = step.upload;
      return this.runInteractiveStep(locator as Locator, "upload", path);
    }
    if ("scroll" in step && "to" in step.scroll) {
      return this.runScrollToStep(step.scroll.to);
    }
    if ("open" in step && typeof step.open !== "string") {
      // Object form: navigate, then wait for the requested load state so the
      // first interaction doesn't race SPA hydration.
      const nav = await this.invoke(["navigate", step.open.path]);
      if (!nav.ok) return nav;
      return this.invoke(
        waitConditionToArgv({
          load: step.open.waitUntil,
          ...(step.open.timeoutMs !== undefined
            ? { timeoutMs: step.open.timeoutMs }
            : {}),
        }),
        { timeoutMs: childDeadline(step.open.timeoutMs) },
      );
    }
    if ("wait" in step) {
      // Cairn enforces the wait deadline itself: the child gets the spec's
      // timeout plus a grace period, so agent-browser's own (richer) timeout
      // error wins when the daemon is healthy, and a wedged daemon gets the
      // child killed instead of hanging the run forever (dogfood P0).
      return this.invoke(stepToArgv(step), {
        timeoutMs: childDeadline(step.wait.timeoutMs),
      });
    }
    return this.invoke(stepToArgv(step));
  }

  /** `scroll: { to: <locator> }` — semantic locators resolve strictly first. */
  private async runScrollToStep(locator: Locator): Promise<InvocationResult> {
    if (locator.by === "selector") {
      return this.invoke(["scrollintoview", locator.selector]);
    }
    const resolved = await this.resolveInteractiveRef(
      locator,
      this.locatorTimeoutMs(),
      "scroll",
    );
    if (!resolved.ok) return resolved.result;
    const r = await this.invoke(["scrollintoview", `@${resolved.element.ref}`]);
    return { ...r, resolvedElement: toResolvedElement(resolved.element) };
  }

  /* ----- artifact capture ----- */

  async snapshot(opts?: { interactive?: boolean }): Promise<SnapshotResult> {
    const argv = ["snapshot"];
    if (opts?.interactive) argv.push("-i");
    const r = await this.invoke(argv);
    return { ok: r.ok, text: r.stdout, durationMs: r.durationMs };
  }

  async screenshot(opts: {
    /** Absolute path or filename inside `screenshotDir`. */
    path: string;
    fullPage?: boolean;
    annotate?: boolean;
    format?: "png" | "jpeg";
    quality?: number;
  }): Promise<ScreenshotResult> {
    const argv: string[] = ["screenshot", opts.path];
    if (opts.fullPage) argv.push("--full");
    if (opts.annotate) argv.push("--annotate");
    if (opts.format) argv.push("--screenshot-format", opts.format);
    if (opts.quality !== undefined)
      argv.push("--screenshot-quality", String(opts.quality));
    const r = await this.invoke(argv);
    return { ok: r.ok, path: opts.path, durationMs: r.durationMs };
  }

  /* ----- page info ----- */

  async getUrl(): Promise<string> {
    const r = await this.invoke(["get", "url"]);
    return r.stdout.trim();
  }

  async getTitle(): Promise<string> {
    const r = await this.invoke(["get", "title"]);
    return r.stdout.trim();
  }

  async getText(selector: string): Promise<string> {
    // The text verifier passes the special token "page" for whole-page text;
    // translate that to a real selector so agent-browser can resolve it.
    const real = selector === "page" ? "body" : selector;
    const r = await this.invoke(["get", "text", real]);
    return r.stdout;
  }

  async getCount(selector: string): Promise<number> {
    const r = await this.invoke(["get", "count", selector]);
    const n = Number(r.stdout.trim());
    return Number.isFinite(n) ? n : 0;
  }

  /* ----- network ----- */

  async getNetworkRequests(filter?: NetworkFilter): Promise<NetworkEntry[]> {
    const argv = ["network", "requests", "--json"];
    if (filter?.method) argv.push("--method", filter.method);
    if (filter?.status) argv.push("--status", filter.status);
    if (filter?.type) argv.push("--type", filter.type);
    if (filter?.filter) argv.push("--filter", filter.filter);
    const r = await this.invoke(argv);
    if (!r.ok) return [];
    return parseEnvelope<NetworkEntry>(r.stdout, "requests");
  }

  /** Stop tracking. Useful between specs to avoid stale entries leaking. */
  async clearNetworkLog(): Promise<void> {
    await this.invoke(["network", "requests", "--clear"]);
  }

  async startHar(): Promise<void> {
    await this.invoke(["network", "har", "start"]);
  }

  async stopHar(outputPath: string): Promise<void> {
    await this.invoke(["network", "har", "stop", outputPath]);
  }

  /* ----- console ----- */

  async getConsole(): Promise<ConsoleEntry[]> {
    const r = await this.invoke(["console", "--json"]);
    if (!r.ok) return [];
    return parseEnvelope<ConsoleEntry>(r.stdout, "messages");
  }

  async clearConsole(): Promise<void> {
    await this.invoke(["console", "--clear"]);
  }

  async getErrors(): Promise<ConsoleEntry[]> {
    // Combine page errors (uncaught exceptions, network errors via `errors`)
    // with `console.error()` calls so both backends agree on what counts as
    // an error for the `console.errorsMax` verifier. Playwright includes both
    // via its `pageerror` + `console` listeners; without this combination,
    // agent-browser would only catch uncaught exceptions.
    const [pageErrorsR, consoleR] = await Promise.all([
      this.invoke(["errors", "--json"]),
      this.invoke(["console", "--json"]),
    ]);
    const pageErrors: ConsoleEntry[] = pageErrorsR.ok
      ? parseEnvelope<ConsoleEntry>(pageErrorsR.stdout, "errors").map((e) => ({
          ...e,
          type: e.type ?? "error",
        }))
      : [];
    const consoleErrors: ConsoleEntry[] = consoleR.ok
      ? parseEnvelope<ConsoleEntry>(consoleR.stdout, "messages").filter(
          (e) => e.type === "error",
        )
      : [];
    return [...pageErrors, ...consoleErrors];
  }

  /* ----- viewport ----- */

  async setViewport(width: number, height: number): Promise<void> {
    await this.invoke(["viewport", String(width), String(height)]);
  }

  /* ----- evaluation (script verifier escape hatch) ----- */

  /**
   * Evaluate JS in the page and return the raw stdout.
   * The script-verifier evaluator parses the JSON-shaped result.
   */
  async evaluate(js: string): Promise<InvocationResult> {
    return this.invoke(["eval", js]);
  }

  /* ----- state / checkpoint support ----- */

  async saveState(path: string): Promise<InvocationResult> {
    return this.invoke(["state", "save", path]);
  }

  async loadState(path: string): Promise<InvocationResult> {
    return this.invoke(["state", "load", path]);
  }

  /* ----- direct wait helpers (used by `cairn login`) ----- */

  async waitForText(
    text: string,
    timeoutMs: number,
  ): Promise<InvocationResult> {
    return this.invoke(
      ["wait", "--text", text, "--timeout", String(timeoutMs)],
      { timeoutMs: childDeadline(timeoutMs) },
    );
  }

  async waitForUrl(
    pattern: string,
    timeoutMs: number,
  ): Promise<InvocationResult> {
    return this.invoke(
      ["wait", "--url", pattern, "--timeout", String(timeoutMs)],
      { timeoutMs: childDeadline(timeoutMs) },
    );
  }

  /* ----- tracing ----- */

  async startTrace(): Promise<void> {
    // agent-browser's `trace start` works without an explicit path; we provide
    // the destination at `stopTrace` time so the runner controls layout.
    await this.invoke(["trace", "start"]);
  }

  async stopTrace(path: string): Promise<{ ok: boolean; path: string }> {
    const r = await this.invoke(["trace", "stop", path]);
    return { ok: r.ok, path };
  }

  /**
   * Wipe cookies + localStorage + sessionStorage. Used by the Runner's
   * --cold-start gate (plan §10.6).
   */
  async clearBrowserState(): Promise<void> {
    await this.invoke(["cookies", "clear"]);
    await this.invoke(["storage", "local", "clear"]);
    // agent-browser's `storage session clear` isn't documented but is the
    // natural counterpart; best-effort and ignore errors.
    await this.invoke(["storage", "session", "clear"]);
  }

  /* ----- batch ----- */

  /**
   * Run multiple steps in a single agent-browser invocation.
   * Each inner array is the argv (without global flags) for one command.
   * Returns the parsed --json output (array of per-command results).
   *
   * Use this when the runner has a contiguous block of steps that don't need
   * per-step artifact capture — significantly faster than per-step `invoke`.
   */
  async batch(
    commands: string[][],
    opts?: { bail?: boolean },
  ): Promise<{ ok: boolean; results: unknown[]; raw: InvocationResult }> {
    const argv: string[] = ["batch", "--json"];
    if (opts?.bail ?? true) argv.push("--bail");
    for (const cmd of commands) {
      // Each command becomes one positional arg, space-joined. Args containing
      // whitespace are quoted to survive a second round of shell splitting that
      // some agent-browser parsers apply.
      argv.push(cmd.map(quoteIfNeeded).join(" "));
    }
    const r = await this.invoke(argv);
    if (!r.ok) return { ok: false, results: [], raw: r };
    const results = parseJsonArray<unknown>(r.stdout);
    return { ok: true, results, raw: r };
  }

  /* ----- lifecycle ----- */

  async close(): Promise<InvocationResult> {
    // After a child timeout the daemon is suspect: its per-session command
    // queue is serial, so a graceful `close` would block behind whatever it
    // is wedged on (verified against agent-browser 0.26–0.27). Kill the session
    // daemon instead — it closes Chrome and removes its own state files.
    if (this.sawChildTimeout && this.terminateDaemon()) {
      return {
        ok: true,
        stdout: "session daemon terminated after child timeout",
        stderr: "",
        exitCode: 0,
        durationMs: 0,
        argv: ["--session", this.opts.session, "close"],
      };
    }
    return this.invoke(["close"]);
  }

  /**
   * Signal-time teardown: kill the owned session daemon (closes Chrome)
   * without queueing behind in-flight commands. Fully synchronous — signal
   * handlers with an in-flight execa child never get an async continuation
   * (signal-exit re-raises the signal once the sync portion returns).
   * No-op when the daemon's pid file is missing (nothing to clean up).
   */
  terminateSync(): void {
    this.terminateDaemon();
  }

  /**
   * Kill the session daemon via its pid file. Relies on agent-browser's
   * state-dir layout (`~/.agent-browser/<session>.pid`, confirmed for 0.26–0.27);
   * callers must treat `false` as "use the graceful path instead".
   *
   * Escalation is required: the 0.26–0.27 daemon honors SIGTERM only while idle —
   * a signal delivered mid-command (the wedged wait we're cleaning up after)
   * is dropped. So: SIGTERM, brief synchronous poll, and as a last resort
   * SIGTERM the daemon's children (Chrome) before SIGKILLing the daemon, so
   * the kill can't orphan a browser.
   */
  private terminateDaemon(): boolean {
    const pid = this.readDaemonPid();
    if (pid === undefined) return false;
    // Capture children before any kill so the escalation path still knows
    // which Chrome to take down.
    const children = childPidsSync(pid);
    try {
      process.kill(pid, "SIGTERM");
      const deadline = Date.now() + DAEMON_TERM_POLL_MS;
      while (Date.now() < deadline) {
        sleepSync(50);
        if (!isAlive(pid)) return true;
      }
      for (const child of children) {
        try {
          process.kill(child, "SIGTERM");
        } catch {
          // already gone
        }
      }
      process.kill(pid, "SIGKILL");
      return true;
    } catch {
      // ESRCH between checks means the daemon exited — that's a success.
      return !isAlive(pid);
    }
  }

  private readDaemonPid(): number | undefined {
    try {
      const raw = readFileSync(
        join(
          this.opts.stateDir ?? join(homedir(), ".agent-browser"),
          `${this.opts.session}.pid`,
        ),
        "utf8",
      );
      const pid = Number(raw.trim());
      return Number.isInteger(pid) && pid > 1 ? pid : undefined;
    } catch {
      return undefined;
    }
  }

  async doctor(): Promise<{
    ok: boolean;
    report: unknown;
    raw: InvocationResult;
  }> {
    const r = await this.invoke(["doctor", "--json"]);
    if (!r.ok) return { ok: false, report: null, raw: r };
    try {
      return { ok: true, report: JSON.parse(r.stdout), raw: r };
    } catch {
      return { ok: false, report: null, raw: r };
    }
  }

  /* ----- internals ----- */

  /**
   * Run a `batch` composite step as a single `agent-browser batch --bail`
   * invocation so transient UI state (a hover popover, focus) survives across
   * the sub-step chain. The hard-deadline timeout from invoke() applies to the
   * whole batch. On failure, name the sub-step that bailed.
   */
  private async runBatchStep(step: BatchStep): Promise<InvocationResult> {
    const commands = step.batch.map((sub) => batchSubStepToArgv(sub));
    const r = await this.batch(commands, { bail: true });
    if (r.ok) return r.raw;
    return {
      ...r.raw,
      ok: false,
      stderr: describeBatchFailure(commands, r.raw),
    };
  }

  private async runDownloadStep(step: DownloadStep): Promise<InvocationResult> {
    const { saveAs, assign: _assign, timeoutMs, ...locator } = step.download;
    if (locator.by === "selector") {
      return this.invoke(["download", locator.selector, saveAs], {
        timeoutMs,
      });
    }

    const resolved = await this.resolveInteractiveRef(
      locator as Locator,
      timeoutMs ?? this.locatorTimeoutMs(),
      "download",
      { preferLinkAncestor: true },
    );
    if (!resolved.ok) return resolved.result;
    const r = await this.invoke(
      ["download", `@${resolved.element.ref}`, saveAs],
      {
        timeoutMs,
      },
    );
    return { ...r, resolvedElement: toResolvedElement(resolved.element) };
  }

  /**
   * Click / hover / fill / upload, with the P0 dogfood fixes baked in:
   *
   *   1. Semantic locators resolve against the interactive accessibility
   *      snapshot BEFORE acting — zero matches fail here, at this step, with
   *      candidate diagnostics (never a silent `find … ✓ Done` no-op).
   *   2. The resolved element is scrolled into view first; agent-browser
   *      actions don't auto-scroll and below-fold targets silently no-op.
   *   3. Matching is against accessible names (post-text-transform),
   *      case-insensitive whole-name by default, visible-only (hidden nodes
   *      aren't in the a11y tree), and ambiguity is a hard error unless the
   *      locator carries `nth`.
   */
  private async runInteractiveStep(
    locator: Locator,
    action: "click" | "hover" | "fill" | "upload",
    value?: string,
  ): Promise<InvocationResult> {
    if (locator.by === "selector") {
      // Selector locators skip snapshot resolution (agent-browser errors on
      // missing selectors already) but still get the scroll-into-view guard.
      await this.scrollSelectorIntoView(locator.selector);
      const argv = [action, locator.selector];
      if (value !== undefined) argv.push(value);
      return this.invoke(argv);
    }

    const resolved = await this.resolveInteractiveRef(
      locator,
      this.locatorTimeoutMs(),
      action,
    );
    if (!resolved.ok) return resolved.result;

    // Best-effort: a failed scroll shouldn't fail the step — the action
    // itself will surface a real problem.
    await this.invoke(["scrollintoview", `@${resolved.element.ref}`]);

    const argv = [action, `@${resolved.element.ref}`];
    if (value !== undefined) argv.push(value);
    const r = await this.invoke(argv);
    return { ...r, resolvedElement: toResolvedElement(resolved.element) };
  }

  private locatorTimeoutMs(): number {
    return this.opts.locatorTimeoutMs ?? DEFAULT_LOCATOR_TIMEOUT_MS;
  }

  private async scrollSelectorIntoView(selector: string): Promise<void> {
    const script = `(() => {
      try {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return false;
        el.scrollIntoView({ block: "center", inline: "center" });
        return true;
      } catch (_) {
        return false;
      }
    })()`;
    await this.invoke(["eval", script]);
  }

  private async resolveInteractiveRef(
    locator: Locator,
    timeoutMs: number,
    action: string,
    opts: { preferLinkAncestor?: boolean } = {},
  ): Promise<
    | { ok: true; element: SnapshotElement }
    | { ok: false; result: InvocationResult }
  > {
    const start = Date.now();
    const deadline = start + Math.max(0, timeoutMs);
    let lastSnapshot: { ok: boolean; stdout: string; stderr: string } = {
      ok: false,
      stdout: "",
      stderr: "",
    };
    let lastShortfall: string | undefined;

    // Poll the interactive snapshot until the locator resolves or the timeout
    // expires — parity with Playwright's wait-for-visibility behavior.
    while (true) {
      const snapshot = await this.invoke(["snapshot", "-i"]);
      lastSnapshot = snapshot;
      if (snapshot.ok) {
        const parsed = parseSnapshot(snapshot.stdout);
        const matchIdx = collapseNestedMatches(
          matchingSnapshotIndices(locator, parsed),
          parsed,
        );
        const nth = "nth" in locator ? locator.nth : undefined;
        if (nth !== undefined) {
          if (nth < matchIdx.length) {
            return {
              ok: true,
              element: this.pickTarget(matchIdx[nth]!, parsed, opts),
            };
          }
          // nth out of range can be transient while the page hydrates — keep
          // polling and report the shortfall if the timeout expires.
          if (matchIdx.length > 0) {
            lastShortfall = `nth=${nth} requested but only ${matchIdx.length} match(es) visible`;
          }
        } else if (matchIdx.length === 1) {
          return {
            ok: true,
            element: this.pickTarget(matchIdx[0]!, parsed, opts),
          };
        } else if (matchIdx.length > 1) {
          // Strict mode: ambiguity won't resolve itself by waiting — fail now
          // with the candidate list (Playwright strict-mode style).
          return {
            ok: false,
            result: this.unresolvedFailure(action, start, [
              `ambiguous ${describeLocator(locator)} for ${action}: ${matchIdx.length} visible matches`,
              ...matchIdx.map((i) => {
                const el = parsed[i]!;
                return `  - ${el.role} ${
                  el.name ? JSON.stringify(el.name) : "<no name>"
                } ref=${el.ref}`;
              }),
              "disambiguate with `exact: true`, `nth: <index>`, a more specific name, or `by: selector`",
            ]),
          };
        }
      }
      if (Date.now() >= deadline) break;
      const remaining = deadline - Date.now();
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(50, remaining)));
    }

    const parsed = lastSnapshot.ok ? parseSnapshot(lastSnapshot.stdout) : [];
    const diagnostics = buildLocatorDiagnostics(locator, parsed);
    const stderrLines = [
      `element not found: could not resolve ${describeLocator(locator)} for ${action} within ${timeoutMs}ms`,
      ...(lastShortfall ? [lastShortfall] : []),
      ...diagnostics,
    ];
    if (!lastSnapshot.ok && lastSnapshot.stderr) {
      stderrLines.push(`snapshot stderr: ${lastSnapshot.stderr.trim()}`);
    }
    return {
      ok: false,
      result: this.unresolvedFailure(action, start, stderrLines),
    };
  }

  /**
   * Return the element to act on for a matched index — for downloads, prefer
   * the enclosing actionable ancestor (typically `<a href download>`).
   */
  private pickTarget(
    idx: number,
    parsed: SnapshotElement[],
    opts: { preferLinkAncestor?: boolean },
  ): SnapshotElement {
    if (opts.preferLinkAncestor) {
      return preferActionableAncestor(idx, parsed) ?? parsed[idx]!;
    }
    return parsed[idx]!;
  }

  private unresolvedFailure(
    action: string,
    startedAt: number,
    stderrLines: string[],
  ): InvocationResult {
    return {
      ok: false,
      stdout: "",
      stderr: stderrLines.join("\n"),
      exitCode: 1,
      durationMs: Date.now() - startedAt,
      argv: [
        "--session",
        this.opts.session,
        ...this.globalArgs,
        action,
        "<unresolved>",
      ],
    };
  }

  /**
   * Compose `[--session foo, ...globals, ...argv]` and invoke agent-browser.
   * Transient daemon-busy failures (`os error 35` under sequential multi-spec
   * load) are retried with backoff before surfacing — they're load hiccups,
   * not step failures.
   */
  private async invoke(
    argv: string[],
    invokeOpts: { timeoutMs?: number } = {},
  ): Promise<InvocationResult> {
    let result = await this.invokeOnce(argv, invokeOpts);
    for (const backoffMs of DAEMON_BUSY_BACKOFF_MS) {
      if (result.ok || !isTransientDaemonError(result.stderr)) break;
      await sleep(backoffMs);
      result = await this.invokeOnce(argv, invokeOpts);
    }
    return result;
  }

  private async invokeOnce(
    argv: string[],
    invokeOpts: { timeoutMs?: number } = {},
  ): Promise<InvocationResult> {
    const start = Date.now();
    const fullArgv = [
      "--session",
      this.opts.session,
      ...this.globalArgs,
      ...argv,
    ];
    // Every invocation carries a hard deadline so a wedged daemon can never
    // hang a run: execa SIGTERMs the child at `timeout` (SIGKILL 5s later).
    const timeoutMs =
      invokeOpts.timeoutMs ??
      this.opts.defaultTimeoutMs ??
      DEFAULT_COMMAND_TIMEOUT_MS;
    const result = await execa(this.binary, fullArgv, {
      reject: false,
      cwd: this.opts.cwd,
      timeout: timeoutMs,
    });
    if (result.timedOut) {
      this.sawChildTimeout = true;
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      return {
        ok: false,
        stdout: typeof result.stdout === "string" ? result.stdout : "",
        stderr: [
          `timed out after ${timeoutMs}ms — killed \`${this.binary} ${argv.join(" ")}\` (agent-browser daemon may be unresponsive)`,
          ...(stderr.trim() ? [stderr.trim()] : []),
        ].join("\n"),
        exitCode: result.exitCode ?? -1,
        durationMs: Date.now() - start,
        argv: fullArgv,
      };
    }
    return {
      ok: result.exitCode === 0,
      stdout: typeof result.stdout === "string" ? result.stdout : "",
      stderr: typeof result.stderr === "string" ? result.stderr : "",
      exitCode: result.exitCode ?? -1,
      durationMs: Date.now() - start,
      argv: fullArgv,
    };
  }
}

/* ----- helpers — see ./parseOutput.ts for unit-tested implementations ----- */

const DEFAULT_LOCATOR_TIMEOUT_MS = 10000;
const POLL_INTERVAL_MS = 250;

/**
 * Hard per-invocation deadline when nothing more specific applies. This is a
 * backstop against a wedged daemon, not the primary timeout — agent-browser's
 * own command timeouts (and spec-level `timeoutMs`) fire well before it.
 */
const DEFAULT_COMMAND_TIMEOUT_MS = 60_000;

/**
 * Extra time granted to the child past the spec's own `timeoutMs` so
 * agent-browser's richer timeout error wins when the daemon is healthy; the
 * kill only fires when the child failed to enforce its own deadline.
 */
const CHILD_KILL_GRACE_MS = 5_000;

/** Deadline for a child that was given an explicit step-level timeout. */
function childDeadline(stepTimeoutMs: number | undefined): number | undefined {
  return stepTimeoutMs === undefined
    ? undefined
    : stepTimeoutMs + CHILD_KILL_GRACE_MS;
}

/** How long the SIGTERM attempt waits for the daemon to exit. */
const DAEMON_TERM_POLL_MS = 1_500;

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Synchronous sleep — usable inside signal handlers where timers never fire. */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Direct child pids of `pid` (the daemon's Chrome). Best-effort, darwin/linux. */
function childPidsSync(pid: number): number[] {
  try {
    const r = spawnSync("pgrep", ["-P", String(pid)], {
      encoding: "utf8",
      timeout: 2_000,
    });
    if (typeof r.stdout !== "string") return [];
    return r.stdout
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((n) => Number.isInteger(n) && n > 1);
  } catch {
    return [];
  }
}

/** Backoff schedule for transient daemon-busy retries (dogfood P2 #14). */
const DAEMON_BUSY_BACKOFF_MS = [300, 1200];

/**
 * Build a step error for a failed `batch --bail`. agent-browser emits a JSON
 * array of per-command results on stdout; with --bail the run stops at the
 * first failure, so the array length tells us which sub-step bailed. Falls back
 * to raw stderr when the output can't be parsed.
 */
export function describeBatchFailure(
  commands: string[][],
  raw: { stdout: string; stderr: string; exitCode: number },
): string {
  const stderr = raw.stderr.trim();
  let results: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(raw.stdout.trim()) as unknown;
    if (Array.isArray(parsed)) results = parsed as Array<Record<string, unknown>>;
  } catch {
    // non-JSON output — fall through to the stderr-only message
  }
  const failedIdx = results.findIndex(
    (res) =>
      res &&
      (res["success"] === false ||
        res["ok"] === false ||
        typeof res["error"] === "string"),
  );
  // With --bail the failing command is the last one that produced a result.
  const idx = failedIdx >= 0 ? failedIdx : results.length;
  if (idx >= 0 && idx < commands.length) {
    const cmd = commands[idx]!.join(" ");
    const inner =
      (failedIdx >= 0 && typeof results[failedIdx]?.["error"] === "string"
        ? (results[failedIdx]!["error"] as string)
        : "") ||
      stderr ||
      `exit ${raw.exitCode}`;
    return `batch failed at sub-step #${idx + 1} (${cmd}): ${inner}`;
  }
  return stderr || `batch failed (exit ${raw.exitCode})`;
}

export function isTransientDaemonError(stderr: string): boolean {
  return /os error 35|Resource temporarily unavailable|daemon may be busy/i.test(
    stderr,
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function matchingSnapshotIndices(
  locator: Locator,
  snapshot: SnapshotElement[],
): number[] {
  const out: number[] = [];
  for (let i = 0; i < snapshot.length; i++) {
    const el = snapshot[i]!;
    if (!el.ref) continue;
    if (!matchesLocator(locator, el)) continue;
    out.push(i);
  }
  return out;
}

function matchesLocator(locator: Locator, el: SnapshotElement): boolean {
  switch (locator.by) {
    case "role":
      return (
        el.role === locator.role &&
        (locator.name === undefined ||
          nameMatches(el.name, locator.name, locator.exact))
      );
    case "label":
      return nameMatches(el.name, locator.name, locator.exact);
    case "text":
      return nameMatches(el.name, locator.text, locator.exact);
    case "selector":
      return false;
  }
}

/**
 * Accessible-name matching semantics (dogfood P0 #3): whole-name,
 * whitespace-normalized, case-insensitive by default; `exact: true` keeps the
 * case comparison. Substring matching is deliberately NOT supported — it let
 * `name: Cobrar` silently bind to "Cobrar plan".
 */
function nameMatches(
  elName: string | undefined,
  wanted: string,
  exact: boolean | undefined,
): boolean {
  const a = normalizeName(elName ?? "");
  const b = normalizeName(wanted);
  if (exact) return a === b;
  return a.toLowerCase() === b.toLowerCase();
}

function normalizeName(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Drop matches that sit inside the subtree of an earlier match. A link
 * wrapping a same-named button (or a text locator matching both a control and
 * its container) is one logical target, not an ambiguity — keep the outermost.
 */
export function collapseNestedMatches(
  indices: number[],
  snapshot: SnapshotElement[],
): number[] {
  const kept: number[] = [];
  let subtreeEnd = -1; // exclusive end of the last kept match's subtree
  for (const idx of indices) {
    if (idx < subtreeEnd) continue;
    kept.push(idx);
    subtreeEnd = subtreeEndOf(idx, snapshot);
  }
  return kept;
}

function subtreeEndOf(idx: number, snapshot: SnapshotElement[]): number {
  const level = snapshot[idx]!.level;
  let end = idx + 1;
  while (end < snapshot.length && snapshot[end]!.level > level) end++;
  return end;
}

function toResolvedElement(el: SnapshotElement): ResolvedElement {
  return {
    role: el.role,
    ...(el.name !== undefined ? { name: el.name } : {}),
    ...(el.ref !== undefined ? { ref: el.ref } : {}),
  };
}

/**
 * Walk back from a matched element and return the nearest ancestor that looks
 * like the real actionable target (typically `<a href download>`). Used for
 * downloads where the locator resolves to an inner control (e.g. a > button)
 * but clicking the inner control bypasses the link's download behavior.
 *
 * Returns undefined when no link ancestor is found within the search depth, in
 * which case the matched element is used as-is.
 */
export function preferActionableAncestor(
  matchIndex: number,
  snapshot: SnapshotElement[],
  maxDepth = 4,
): SnapshotElement | undefined {
  const match = snapshot[matchIndex];
  if (!match) return undefined;
  let currentLevel = match.level;
  let depth = 0;
  for (let i = matchIndex - 1; i >= 0 && depth < maxDepth; i--) {
    const el = snapshot[i]!;
    if (el.level >= currentLevel) continue;
    if (el.role === "link" && el.ref) return el;
    currentLevel = el.level;
    depth++;
  }
  return undefined;
}

/**
 * Build the failure-time diagnostic lines listing candidate elements that
 * almost matched the locator. Calls out elements inside `dialog` so authors
 * can see when the right control is hidden behind a still-open dialog.
 */
export function buildLocatorDiagnostics(
  locator: Locator,
  snapshot: SnapshotElement[],
): string[] {
  if (snapshot.length === 0) return ["snapshot was empty"];
  const candidates: Array<{
    el: SnapshotElement;
    dialog: SnapshotElement | undefined;
  }> = [];
  const targetRole = locator.by === "role" ? locator.role : undefined;
  for (let i = 0; i < snapshot.length; i++) {
    const el = snapshot[i]!;
    if (!el.ref) continue;
    if (targetRole && el.role !== targetRole) continue;
    if (!targetRole) {
      // For label/text locators, fall back to interactive controls.
      if (!INTERACTIVE_ROLES.has(el.role)) continue;
    }
    candidates.push({ el, dialog: enclosingDialog(i, snapshot) });
  }
  if (candidates.length === 0) {
    return [
      targetRole
        ? `no elements with role=${targetRole} in the current snapshot`
        : "no interactive elements in the current snapshot",
    ];
  }
  const lines: string[] = [];
  lines.push(`matching candidates (${candidates.length}):`);
  for (const c of candidates.slice(0, 12)) {
    const name = c.el.name ? JSON.stringify(c.el.name) : "<no name>";
    const ref = c.el.ref ? ` ref=${c.el.ref}` : "";
    const dlg = c.dialog
      ? ` in dialog ${
          c.dialog.name ? JSON.stringify(c.dialog.name) : "(unnamed)"
        }`
      : "";
    lines.push(`  - ${c.el.role} ${name}${ref}${dlg}`);
  }
  if (candidates.length > 12) {
    lines.push(`  …and ${candidates.length - 12} more`);
  }
  return lines;
}

const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "menuitem",
  "tab",
  "checkbox",
  "radio",
  "textbox",
  "combobox",
  "switch",
]);

function enclosingDialog(
  index: number,
  snapshot: SnapshotElement[],
): SnapshotElement | undefined {
  const el = snapshot[index];
  if (!el) return undefined;
  let level = el.level;
  for (let i = index - 1; i >= 0; i--) {
    const a = snapshot[i]!;
    if (a.level >= level) continue;
    if (a.role === "dialog" || a.attrs?.["role"] === "dialog") return a;
    level = a.level;
  }
  return undefined;
}

function describeLocator(locator: Locator): string {
  switch (locator.by) {
    case "role":
      return locator.name
        ? `role=${locator.role} name=${JSON.stringify(locator.name)}`
        : `role=${locator.role}`;
    case "label":
      return `label=${JSON.stringify(locator.name)}`;
    case "text":
      return `text=${JSON.stringify(locator.text)}`;
    case "selector":
      return `selector=${JSON.stringify(locator.selector)}`;
  }
}
