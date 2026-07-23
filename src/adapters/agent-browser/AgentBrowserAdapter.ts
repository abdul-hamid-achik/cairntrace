import { Buffer } from "node:buffer";
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
  WaitCondition,
  WaitStep,
} from "../../core/schema/spec.v1";
import { clickLocator } from "../../core/schema/spec.v1";
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
  openReadinessArgv,
  stepToArgv,
  waitConditionToArgv,
} from "./commandBuilder";
import {
  buildGlobalArgs,
  type ElementBox,
  parseBoxEnvelope,
  parseEnvelope,
  parseJsonArray,
  parseViewportMetrics,
  quoteIfNeeded,
} from "./parseOutput";
import type { AgentBrowserOptions } from "./types";

type BatchCommandPhase = "probe" | "action" | "pace" | "verify";

interface BatchCommandPlanEntry {
  argv: string[];
  /** Zero-based index in the authored `batch:` array. */
  sourceIndex: number;
  phase: BatchCommandPhase;
  /** Authored command, used in diagnostics for expanded helper commands. */
  originalArgv: string[];
}

interface LinkClickProbe {
  target: string;
  beforeUrl: string;
  beforeTimeOrigin?: number;
  stateKey: string;
}

/**
 * A link whose click cannot change THIS document — `target="_blank"`, a
 * `download` attribute, or a non-http(s) scheme (`mailto:`/`tel:`/`javascript:`
 * …). Such a link is clicked exactly once and passes with a diagnostic note;
 * the same-document delivery probe + physical retry (which would double-fire
 * the click and then hard-fail on a link that legitimately never mutates the
 * page) is skipped for it.
 */
interface ExternalLinkClick {
  externalReason: string;
}

/**
 * Rect-settle report from the in-page guard on the `by: selector` click path:
 * whether the target's bounding rect held still across two consecutive
 * animation frames and whether its center landed inside the viewport. An
 * `undefined` report (eval failed, old page, target missing) is inconclusive
 * and never blocks the click — mirroring `detectOffViewportAfterScroll`.
 */
interface SelectorRectSettle {
  stable: boolean;
  inViewport: boolean;
  cx?: number;
  cy?: number;
  innerWidth?: number;
  innerHeight?: number;
}

/**
 * Report from the folded scroll + date-ish-fill eval on the `by: selector`
 * fill path: whether the target was a date-ish input the eval handled
 * natively and, when it was, whether the browser accepted the value
 * (`applied`) — an invalid format is sanitized to `""` by the value setter,
 * never an exception. A `dateish: false` report (or no report at all) means
 * the normal `fill` invocation must still run.
 */
interface DateishFillReport {
  dateish: boolean;
  type?: string;
  applied?: boolean;
  value?: string;
}

/**
 * Outcome of the pre-click link classification eval: a same-tab nav link to
 * verify or an external-effect link to pass with a note (`prepared`), a hard
 * failure to return immediately (`failure`, the classification eval itself
 * hard-timed-out), and — on the selector path, where scrollIntoView is folded
 * into the same eval — the rect-settle viewport guard report (`settle`).
 */
interface LinkClickPreparation {
  prepared?: LinkClickProbe | ExternalLinkClick;
  failure?: InvocationResult;
  settle?: SelectorRectSettle;
}

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
 *
 * Version note: the daemon-lifecycle, wait-slicing, and viewport-relative
 * `get box` behavior documented throughout this file were verified against
 * agent-browser 0.31.1, resolved from `$PATH` and not version-pinned by
 * cairntrace. If wait/snapshot behavior looks wrong after an agent-browser
 * update, compare `agent-browser --version` against this note first (origin:
 * the 2026-07-12 empty-<main> investigation, where a streamed-SSR dashboard
 * showed the Suspense fallback under heavy machine contention).
 */
export class AgentBrowserAdapter implements BrowserBackend {
  readonly name = "agent-browser" as const;
  private readonly binary: string;
  private readonly globalArgs: string[];
  /** Set when a child had to be killed — close() escalates to a daemon kill. */
  private sawChildTimeout = false;
  /** Environment-level multiplier for waits and network-idle quiet windows. */
  private waitScale = 1;

  constructor(private readonly opts: AgentBrowserOptions) {
    this.binary = opts.binary ?? "agent-browser";
    this.globalArgs = buildGlobalArgs(opts);
  }

  /**
   * Whether a child invocation has been observed in a wedged state during
   * this run. Once true, stays true — a re-spawned daemon on a later step
   * is rare in practice and would itself need a fresh `false` baseline that
   * the spec-time evidence can't distinguish from "the same wedged session".
   */
  isWedged(): boolean {
    return this.sawChildTimeout;
  }

  /* ----- step dispatch ----- */

  async runStep(step: Step): Promise<InvocationResult> {
    if ("batch" in step) return this.runBatchStep(step);
    if ("download" in step) return this.runDownloadStep(step);
    if ("click" in step)
      return this.runInteractiveStep(
        clickLocator(step),
        "click",
        undefined,
        step.settleMs,
      );
    if ("hover" in step) return this.runInteractiveStep(step.hover, "hover");
    if ("fill" in step) {
      const { value, ...locator } = step.fill;
      return this.runInteractiveStep(locator as Locator, "fill", value);
    }
    if ("type" in step) {
      const { value, delayMs: _delayMs, ...locator } = step.type;
      return this.runInteractiveStep(locator as Locator, "type", value);
    }
    if ("select" in step) {
      // agent-browser's `select` matches the trailing argument against option
      // values AND visible labels (verified against 0.31.1), so `value` and
      // `label` both pass as the same positional arg; a non-matching choice
      // exits non-zero listing the available options (note: 0.31.1 leaves the
      // select deselected after a failed match — acceptable because the step
      // fails and the spec stops there). Semantic locators resolve against
      // the snapshot first — a `<select>` shows up as a combobox with a ref —
      // exactly like fill/click.
      const { value, label, ...locator } = step.select;
      return this.runInteractiveStep(
        locator as Locator,
        "select",
        value ?? label,
      );
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
      // first interaction doesn't race SPA hydration. `domcontentloaded`/`load`
      // use a `document.readyState` predicate (`wait --fn`) — agent-browser's
      // `--load` only observes FUTURE load-state transitions, so after `navigate`
      // (which blocks on load) the page has already reached the state and
      // `--load` would burn its full budget (or time out) for nothing.
      const nav = await this.invoke(["navigate", step.open.path]);
      if (!nav.ok) return nav;
      const waitStartedAt = Date.now();
      const wait = await this.invoke(
        openReadinessArgv(step.open.waitUntil, step.open.timeoutMs),
        { timeoutMs: childDeadline(step.open.timeoutMs) },
      );
      // `networkidle` has no readyState equivalent; a quiet page never re-fires
      // idle, so agent-browser's `--load networkidle` times out even on a healthy
      // page. Treat that specific timeout as success — a genuine error (daemon
      // crash, non-idle polling loop) carries a different stderr and propagates.
      if (
        !wait.ok &&
        step.open.waitUntil === "networkidle" &&
        /timed out/i.test(wait.stderr)
      ) {
        // The full authored/scaled budget was already spent observing a page
        // that had reached idle before this follow-up command subscribed.
        return { ...wait, ok: true, stderr: "" };
      }
      return step.open.waitUntil === "networkidle"
        ? this.extendNetworkIdleWindow(wait, step.open.timeoutMs, waitStartedAt)
        : wait;
    }
    if ("wait" in step) return this.runWaitStep(step);
    return this.invoke(stepToArgv(step));
  }

  /**
   * `wait` step dispatch. State-predicate waits (`text`/`notText`/`selector`)
   * carrying an explicit spec `timeoutMs` are sliced into fresh
   * WAIT_SLICE_MS subprocess invocations (see `runSlicedWaitStep`) instead of
   * trusting a single long-lived agent-browser wait to catch a DOM state
   * that only exists for part of the wait. Load-state waits and waits
   * without a spec budget keep the single-invocation path.
   */
  private async runWaitStep(step: WaitStep): Promise<InvocationResult> {
    const w = step.wait;
    const budgetMs = w.timeoutMs;
    if ("load" in w || budgetMs === undefined) {
      // Cairn enforces the wait deadline itself: the child gets the spec's
      // timeout plus a grace period, so agent-browser's own (richer) timeout
      // error wins when the daemon is healthy, and a wedged daemon gets the
      // child killed instead of hanging the run forever (dogfood P0).
      //
      // `--load` specifically can never be sliced: agent-browser's `--load`
      // only observes FUTURE load-state transitions, so re-arming it every
      // slice would risk missing the one transition it's waiting for if that
      // transition lands inside a slice boundary gap. A budgetless wait has
      // no spec deadline to divide into slices in the first place — cairn
      // still enforces the deadline via `childDeadline`, it just doesn't own
      // a spec-level number to slice.
      const startedAt = Date.now();
      const result = await this.invoke(stepToArgv(step), {
        timeoutMs: childDeadline(budgetMs),
      });
      return "load" in w && w.load === "networkidle"
        ? this.extendNetworkIdleWindow(result, budgetMs, startedAt)
        : result;
    }
    return this.runSlicedWaitStep(w, budgetMs);
  }

  /**
   * Re-issue a state-predicate `wait` (`text`/`notText`/`selector`) as a
   * sequence of fresh WAIT_SLICE_MS subprocess invocations until the spec's
   * `timeoutMs` budget is spent. Each slice is a brand-new agent-browser
   * `wait` command, so it re-queries the *live* document rather than relying
   * on a single invocation's internal poll loop to notice a DOM state that
   * only exists for part of the wait window — the root cause of the
   * 2026-07-12 empty-<main> investigation: a server-streamed /dashboard that
   * genuinely showed the Suspense fallback for longer than a single `wait`
   * invocation's own polling, under heavy machine contention (a stream
   * abort, not a driver misread).
   *
   * The first slice succeeding is the happy path and costs nothing extra —
   * it's the same single invocation as before slicing existed. Slicing only
   * shows up once a slice times out. Slicing stops immediately on:
   *   - success (return that slice's result as-is)
   *   - a child-kill (execa had to SIGTERM a wedged daemon for THIS slice) —
   *     retrying against a wedged daemon is pointless; `close()` already
   *     escalates to a daemon kill once `sawChildTimeout` is set
   *   - any non-timeout error (stderr doesn't match /timed out/i) — a real
   *     error (e.g. "no active session") won't heal by polling again
   *
   * When the budget is exhausted across more than one poll, the final
   * slice's stderr is prefixed so the failure reads as "the live document
   * was checked N times fresh and never satisfied the wait," not a single
   * mysterious timeout.
   */
  private async runSlicedWaitStep(
    w: WaitCondition,
    budgetMs: number,
  ): Promise<InvocationResult> {
    const deadline = Date.now() + budgetMs;
    let polls = 0;
    let last: InvocationResult;

    for (;;) {
      const remaining = deadline - Date.now();
      const sliceMs = Math.max(
        WAIT_SLICE_FLOOR_MS,
        Math.min(WAIT_SLICE_MS, remaining),
      );
      polls++;
      const wedgedBefore = this.sawChildTimeout;
      last = await this.invoke(
        waitConditionToArgv({ ...w, timeoutMs: sliceMs }),
        { timeoutMs: childDeadline(sliceMs) },
      );
      if (last.ok) return last;
      const childKilledThisSlice = !wedgedBefore && this.sawChildTimeout;
      if (childKilledThisSlice) return last;
      if (!/timed out/i.test(last.stderr)) return last;
      if (Date.now() >= deadline) break;
    }

    if (polls > 1) {
      return {
        ...last,
        stderr: `wait exhausted its ${budgetMs}ms budget across ${polls} fresh live-document polls\n${last.stderr}`,
      };
    }
    return last;
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
    const r = await this.invoke(argv, { timeoutMs: SCREENSHOT_TIMEOUT_MS });
    const error = !r.ok
      ? /timed out/i.test(r.stderr)
        ? `screenshot capture timed out after ${SCREENSHOT_TIMEOUT_MS}ms — Chromium may have no rendering surface (is the display asleep/headless?)`
        : r.stderr.trim() || `screenshot capture failed with exit ${r.exitCode}`
      : undefined;
    return {
      ok: r.ok,
      path: opts.path,
      durationMs: r.durationMs,
      ...(error ? { error } : {}),
    };
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

    // `get text` returns only the FIRST match, but a region may legitimately
    // match several elements (notText's guard admits count > 1). An absence
    // assertion over match #1 would report "confirmed absent" for text sitting
    // in match #2, so read every match — the same haystack Playwright's
    // allInnerTexts() produces. A `@ref` already addresses one resolved
    // element and is not a CSS selector, so it keeps the direct path.
    const r = real.startsWith("@")
      ? await this.invoke(["get", "text", real])
      : await this.evaluate(allMatchesTextJs(real));

    // A failed read must never degrade to "": `notText` reads an empty
    // haystack as "confirmed absent" and `when: notText:…` reads it as
    // satisfied, so both would report a green verdict over text nobody
    // successfully looked at. An element that exists but holds no text still
    // exits 0 with empty stdout, so only real failures land here.
    if (!r.ok) {
      throw new Error(
        `could not read text from ${JSON.stringify(selector)}: ${
          r.stderr.trim() || `exit ${r.exitCode}`
        }`,
      );
    }
    if (real.startsWith("@")) return r.stdout;

    // `eval` hands back the JSON-encoded return value.
    try {
      const parsed: unknown = JSON.parse(r.stdout.trim());
      if (typeof parsed !== "string") {
        throw new Error(`expected a string, got ${typeof parsed}`);
      }
      return parsed;
    } catch (e) {
      throw new Error(
        `could not read text from ${JSON.stringify(selector)}: unreadable \`eval\` result ${JSON.stringify(
          r.stdout.trim().slice(0, 120),
        )}: ${(e as Error).message}`,
        { cause: e },
      );
    }
  }

  async getCount(selector: string): Promise<number> {
    const r = await this.invoke(["get", "count", selector]);
    // A selector that legitimately matches nothing exits 0 with "0", so a
    // failed invocation is a real error — never 0, which `count: {equals: 0}`
    // and `atMost` would read as a satisfied assertion.
    if (!r.ok) {
      throw new Error(
        `could not count elements matching ${JSON.stringify(selector)}: ${
          r.stderr.trim() || `exit ${r.exitCode}`
        }`,
      );
    }
    // Blank stdout must be rejected before Number(): `Number("")` is 0, which
    // Number.isFinite accepts, so an exit-0-but-silent invocation would
    // otherwise slip through as a clean "0 elements".
    const raw = r.stdout.trim();
    const n = raw === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(n)) {
      throw new Error(
        `could not count elements matching ${JSON.stringify(selector)}: expected a number from \`get count\`, got ${JSON.stringify(
          raw,
        )}`,
      );
    }
    return n;
  }

  async getValue(locator: Locator): Promise<string> {
    let target: string;
    if (locator.by === "selector") {
      target = locator.selector;
    } else {
      const resolved = await this.resolveInteractiveRef(
        locator,
        this.locatorTimeoutMs(),
        "fill",
      );
      if (!resolved.ok) {
        throw new Error(
          `could not read input value: ${
            resolved.result.stderr.trim() || `exit ${resolved.result.exitCode}`
          }`,
        );
      }
      target = `@${resolved.element.ref}`;
    }
    const result = await this.invoke(["get", "value", target]);
    if (!result.ok) {
      throw new Error(
        `could not read input value from ${describeLocator(locator)}: ${
          result.stderr.trim() || `exit ${result.exitCode}`
        }`,
      );
    }
    return result.stdout;
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    const result = await this.invoke(["wait", String(timeoutMs)], {
      timeoutMs: childDeadline(timeoutMs),
    });
    if (!result.ok) {
      throw new Error(
        result.stderr.trim() || `wait timed out after ${timeoutMs}ms`,
      );
    }
  }

  setWaitScale(scale: number): void {
    this.waitScale = scale;
  }

  /* ----- network ----- */

  async getNetworkRequests(filter?: NetworkFilter): Promise<NetworkEntry[]> {
    const argv = ["network", "requests", "--json"];
    if (filter?.method) argv.push("--method", filter.method);
    if (filter?.status) argv.push("--status", filter.status);
    if (filter?.type) argv.push("--type", filter.type);
    if (filter?.filter) argv.push("--filter", filter.filter);
    const r = await this.invoke(argv);
    // Degrading to [] reports "no matching requests observed" for a page whose
    // network log was never read — and `noFailedRequests` reads an empty set as
    // a PASS, so a run in which every request 500'd would certify green.
    if (!r.ok) {
      throw new Error(
        `could not read network requests: ${
          r.stderr.trim() || `exit ${r.exitCode}`
        }`,
      );
    }
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
    // Degrading to [] here would report "no console messages" for a page whose
    // console was never read. The Runner's console.ndjson dump wraps this in
    // `safe()` and keeps its best-effort behaviour; verdict paths must not.
    if (!r.ok) {
      throw new Error(
        `could not read the console log: ${
          r.stderr.trim() || `exit ${r.exitCode}`
        }`,
      );
    }
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
    // Both probes must succeed. Degrading either to [] reports "0 errors" for
    // a page whose errors were never observed, and `console.errorsMax` reads
    // that as a PASS — a green verdict that needs no step to fail, because
    // outcomes are evaluated after the steps already succeeded. Playwright's
    // getErrors() reads an in-memory log and cannot fail this way, so
    // swallowing here would also break the very cross-backend agreement this
    // method exists to guarantee.
    if (!pageErrorsR.ok) {
      throw new Error(
        `could not read page errors: ${
          pageErrorsR.stderr.trim() || `exit ${pageErrorsR.exitCode}`
        }`,
      );
    }
    if (!consoleR.ok) {
      throw new Error(
        `could not read the console log: ${
          consoleR.stderr.trim() || `exit ${consoleR.exitCode}`
        }`,
      );
    }
    const pageErrors: ConsoleEntry[] = parseEnvelope<ConsoleEntry>(
      pageErrorsR.stdout,
      "errors",
    ).map((e) => ({
      ...e,
      type: e.type ?? "error",
    }));
    const consoleErrors: ConsoleEntry[] = parseEnvelope<ConsoleEntry>(
      consoleR.stdout,
      "messages",
    ).filter((e) => e.type === "error");
    return [...pageErrors, ...consoleErrors];
  }

  /* ----- viewport ----- */

  async setViewport(width: number, height: number): Promise<void> {
    // agent-browser namespaces browser-settings mutators under `set` (`set
    // viewport|device|geo|offline|headers|credentials|media`) — there is no
    // bare top-level `viewport` command. Sending `viewport <w> <h>` hits
    // "Unknown command: viewport" (exit 1), which the Runner's `safe()`
    // wrapper swallows, so the configured viewport silently never applied.
    await this.invoke(["set", "viewport", String(width), String(height)]);
  }

  /* ----- evaluation (script verifier escape hatch) ----- */

  /**
   * Evaluate JS in the page and return the raw stdout.
   * The script-verifier evaluator parses the JSON-shaped result.
   */
  async evaluate(
    js: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<InvocationResult> {
    return this.invoke(["eval", js], opts);
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
    const embeddedFailure = results.some(isFailedBatchResult);
    const resultCountMismatch = results.length !== commands.length;
    const failed = embeddedFailure || resultCountMismatch;
    const raw = failed
      ? {
          ...r,
          ok: false,
          exitCode: r.exitCode === 0 ? 1 : r.exitCode,
          stderr: [
            r.stderr.trim(),
            ...(resultCountMismatch
              ? [
                  `batch returned ${results.length} result(s) for ${commands.length} command(s)`,
                ]
              : []),
          ]
            .filter(Boolean)
            .join("\n"),
        }
      : r;
    return {
      ok: !failed,
      results,
      raw,
    };
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
    const graceful = await this.invoke(["close"]);
    if (graceful.ok) return graceful;
    // Graceful close failed — typically a wedged daemon whose serial queue
    // blocked the `close` client behind whatever it's stuck on, so the client
    // timed out and died while the daemon lives on. Escalate to killing the
    // daemon so we don't orphan it + Chrome, mirroring the child-timeout
    // escalation above.
    if (this.terminateDaemon()) {
      return {
        ok: true,
        stdout: "session daemon terminated after graceful close failed",
        stderr: "",
        exitCode: 0,
        durationMs: 0,
        argv: ["--session", this.opts.session, "close"],
      };
    }
    return graceful;
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

  /**
   * The agent-browser session daemon PID — the root of the browser process
   * tree (`monitor tree <pid>` captures its Chrome children). Read live from
   * the daemon's pid file, so it's valid once the first command has launched
   * the session and undefined before that.
   */
  browserPid(): number | undefined {
    return this.readDaemonPid();
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
    const plan = buildBatchCommandPlan(step);
    const r = await this.batch(
      plan.map((entry) => entry.argv),
      { bail: true },
    );
    if (r.ok) return r.raw;
    return {
      ...r.raw,
      ok: false,
      stderr: describeBatchFailure(plan, r.raw),
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
   * Click / hover / fill / type / select / upload, with the P0 dogfood fixes
   * baked in:
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
   *   4. `click` specifically gets an extra post-scroll viewport check (see
   *      detectOffViewportAfterScroll): agent-browser's own `scrollintoview`
   *      and `click` both report success even when the target sits fully
   *      outside window.innerHeight, e.g. inside a `position: fixed`
   *      container taller than the viewport — scrollIntoView cannot help
   *      there (a fixed element's position doesn't change with document
   *      scroll) yet `click` still exits 0 without the click ever landing.
   */
  private async runInteractiveStep(
    locator: Locator,
    action: "click" | "hover" | "fill" | "type" | "select" | "upload",
    value?: string,
    settleMsOverride?: number,
  ): Promise<InvocationResult> {
    const start = Date.now();
    if (locator.by === "selector") {
      // Selector locators skip snapshot resolution (agent-browser errors on
      // missing selectors already) but still get the scroll-into-view guard.
      // For a click with the probe enabled, the scroll AND the link-kind
      // classification (and observer install for same-tab links) run in the
      // SAME eval — a non-link click (e.g. a button) therefore pays no extra
      // invocation over the scroll it already needs. When the probe is
      // disabled (verifyAfterClick:false or a resolved settleMs of 0) a click
      // still runs the rect-settle scroll eval; other actions keep the plain
      // scroll-only eval.
      const probeEnabled =
        action === "click" && this.clickProbeEnabled(settleMsOverride);
      let prepared: LinkClickProbe | ExternalLinkClick | undefined;
      let settle: SelectorRectSettle | undefined;
      if (probeEnabled) {
        const p = await this.prepareLinkClickProbe(locator, locator.selector);
        if (p.failure) return p.failure;
        prepared = p.prepared;
        settle = p.settle;
      } else if (action === "click") {
        settle = await this.scrollSelectorIntoViewForClick(locator.selector);
      } else if (action === "fill") {
        // Date-ish inputs (<input type=date|time|datetime-local>) swallow
        // agent-browser's keystroke-simulation `fill` — it exits 0 while the
        // value stays empty, because the shadow-DOM picker owns the keys. The
        // scroll eval this path already pays detects the input type and, when
        // date-ish, sets the value natively (value property + input/change
        // events) in the SAME eval — so a handled date fill returns here and
        // an ordinary input falls through to the normal `fill` invocation at
        // the same invocation count as before.
        const handled = await this.scrollAndFillDateishSelector(
          locator.selector,
          value ?? "",
          start,
        );
        if (handled) return handled;
      } else {
        await this.scrollSelectorIntoView(locator.selector);
      }
      if (action === "click") {
        // Same delivery guard the ref path gets from
        // detectOffViewportAfterScroll: agent-browser dispatches the click at
        // the resolved coordinate and exits 0 even when the target has left
        // it (mid-CSS-transition sheet/dialog) or never reached the viewport
        // — the step would otherwise report ✓ while the app's handler never
        // fired.
        const undelivered = rectSettleFailure(settle);
        if (undelivered) {
          return this.unresolvedFailure(action, start, [
            `element found (selector ${JSON.stringify(locator.selector)}) but ${undelivered}`,
            "agent-browser's click would silently no-op instead of erroring — a transitioning sheet/dialog that never finishes opening, or a position:fixed/sticky container taller than the viewport, both leave the click coordinate stale",
            "fix: `wait` for the sheet/dialog content to finish appearing before the click, or widen the spec/environment `viewport: { width, height }` to fit the fixed content",
          ]);
        }
      }
      const argv = [action, locator.selector];
      if (value !== undefined) argv.push(value);
      const r = await this.invoke(argv);
      if (!r.ok) {
        return await this.appendSelectorMatchDiagnostics(r, locator.selector);
      }
      if (action === "click") {
        const delivered = await this.verifyLinkClickDelivery(r, prepared);
        return await this.verifyAndSettleAfterClick(
          delivered,
          locator,
          undefined,
          settleMsOverride,
        );
      }
      return r;
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

    if (action === "click") {
      const offViewport = await this.detectOffViewportAfterScroll(
        resolved.element.ref!,
      );
      if (offViewport) {
        return {
          ...this.unresolvedFailure(action, start, [
            `element resolved (${describeLocator(locator)} -> ref=${resolved.element.ref}) but stayed off-viewport after scrollIntoView: ${offViewport}`,
            "this usually means the target is in a position:fixed/sticky container taller than the current viewport — scrollIntoView cannot help there (a fixed element's position doesn't change with document scroll), and agent-browser's click would otherwise silently no-op instead of erroring",
            "fix: widen the spec/environment `viewport: { width, height }` to fit the fixed content, or reduce the modal/dialog height in the app under test",
          ]),
          resolvedElement: toResolvedElement(resolved.element),
        };
      }
    }

    const argv = [action, `@${resolved.element.ref}`];
    if (value !== undefined) argv.push(value);
    const preparation =
      action === "click" && this.clickProbeEnabled(settleMsOverride)
        ? await this.prepareLinkClickProbe(
            locator,
            `@${resolved.element.ref}`,
            resolved.element,
          )
        : undefined;
    if (preparation?.failure) {
      return {
        ...preparation.failure,
        resolvedElement: toResolvedElement(resolved.element),
      };
    }
    const r = await this.invoke(argv);
    if (action === "click") {
      const delivered = await this.verifyLinkClickDelivery(
        r,
        preparation?.prepared,
      );
      return await this.verifyAndSettleAfterClick(
        delivered,
        locator,
        resolved.element,
        settleMsOverride,
      );
    }
    return { ...r, resolvedElement: toResolvedElement(resolved.element) };
  }

  /** The resolved post-click settle budget (click override → config → default). */
  private resolveClickSettleMs(settleMsOverride?: number): number {
    if (settleMsOverride !== undefined) return settleMsOverride;
    return Math.max(
      1,
      Math.round(
        (this.opts.postClickSettleMs ?? POST_CLICK_NAV_SETTLE_MS) *
          this.waitScale,
      ),
    );
  }

  /**
   * agent-browser's networkidle transition uses a fixed ~500ms quiet window.
   * Once it reports idle, keep polling PerformanceTiming until the most recent
   * completed navigation/resource has stayed quiet for the scaled window.
   */
  private async extendNetworkIdleWindow(
    result: InvocationResult,
    timeoutMs: number | undefined,
    startedAt: number,
  ): Promise<InvocationResult> {
    if (!result.ok || this.waitScale <= 1) return result;
    const budgetMs =
      timeoutMs ?? this.opts.defaultTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS;
    const remaining = budgetMs - (Date.now() - startedAt);
    if (remaining <= 0) {
      return {
        ...result,
        ok: false,
        exitCode: 1,
        stderr: appendLine(
          result.stderr,
          `scaled networkidle window timed out after ${budgetMs}ms`,
        ),
      };
    }
    const quietMs = Math.max(
      NETWORK_IDLE_BASE_WINDOW_MS,
      Math.round(NETWORK_IDLE_BASE_WINDOW_MS * this.waitScale),
    );
    const extended = await this.invoke(
      [
        "wait",
        "--fn",
        networkIdleQuietExpression(quietMs),
        "--timeout",
        String(remaining),
      ],
      { timeoutMs: childDeadline(remaining) },
    );
    return {
      ...result,
      ok: extended.ok,
      exitCode: extended.ok ? result.exitCode : extended.exitCode,
      durationMs: result.durationMs + extended.durationMs,
      stderr: appendLine(
        result.stderr,
        extended.ok
          ? ""
          : `scaled networkidle window: ${
              extended.stderr.trim() || `timed out after ${remaining}ms`
            }`,
      ),
    };
  }

  /**
   * Whether a click should run the link-delivery probe at all. Disabled by
   * `verifyAfterClick:false` and by a resolved `settleMs: 0` — both are the
   * author saying "don't do post-click waiting; the next step waits on the
   * destination", which the probe's own `wait --fn` would otherwise violate.
   */
  private clickProbeEnabled(settleMsOverride?: number): boolean {
    if (this.opts.verifyAfterClick === false) return false;
    return this.resolveClickSettleMs(settleMsOverride) !== 0;
  }

  /**
   * Classify a click target and, for a same-tab nav link, install a
   * before-click URL + MutationObserver delivery probe. On the selector path
   * the scroll-into-view AND the rect-settle viewport guard are folded into
   * this same eval (so a non-link click pays no extra invocation); on the
   * semantic path the ref was already scrolled and guarded, and the element
   * is located by its accessible name. The returned `LinkClickPreparation`
   * carries a `LinkClickProbe` (verify same-tab delivery) or an
   * `ExternalLinkClick` (click once + note, no verification) in `prepared`
   * (absent for a plain non-link click), a `failure` to return immediately
   * (the eval hard-timed out), and the selector path's `settle` report.
   */
  private async prepareLinkClickProbe(
    locator: Locator,
    target: string,
    resolved?: SnapshotElement,
  ): Promise<LinkClickPreparation> {
    const isSelector = locator.by === "selector";
    if (!isSelector && resolved?.role.toLowerCase() !== "link") {
      return {};
    }

    const script = linkClickProbeScript(
      isSelector
        ? { selector: locator.selector, scroll: true, assumeLink: false }
        : { name: resolved?.name, scroll: false, assumeLink: true },
    );
    const result = await this.invoke(["eval", script, "--json"]);
    if (!result.ok) {
      return this.sawChildTimeout ? { failure: result } : {};
    }
    const metadata = parseEvalResult<{
      linkLike?: boolean;
      externalReason?: string | null;
      beforeUrl?: string;
      beforeTimeOrigin?: number;
      settle?: unknown;
    }>(result.stdout);
    const settle = normalizeRectSettle(metadata?.settle);
    const base: LinkClickPreparation = settle ? { settle } : {};
    if (
      !metadata ||
      metadata.linkLike !== true ||
      typeof metadata.beforeUrl !== "string"
    ) {
      return base;
    }
    if (
      typeof metadata.externalReason === "string" &&
      metadata.externalReason
    ) {
      return {
        ...base,
        prepared: { externalReason: metadata.externalReason },
      };
    }
    return {
      ...base,
      prepared: {
        target,
        beforeUrl: metadata.beforeUrl,
        ...(typeof metadata.beforeTimeOrigin === "number"
          ? { beforeTimeOrigin: metadata.beforeTimeOrigin }
          : {}),
        stateKey: LINK_CLICK_PROBE_KEY,
      },
    };
  }

  /**
   * A successful CDP click is not proof that a framework link handler ran.
   * Give URL/DOM delivery a short window; when neither changes and the target
   * is still actionable, retry once with low-level mouse input at its center.
   *
   * `prepared` is `undefined` for non-link clicks (nothing to verify), an
   * `ExternalLinkClick` for `_blank`/download/mailto/tel/js links (which pass
   * with a note — they legitimately never mutate this document), or a
   * `LinkClickProbe` for same-tab nav links (the only kind that runs the
   * delivery-verification + single physical retry + failure path).
   */
  private async verifyLinkClickDelivery(
    clicked: InvocationResult,
    prepared: LinkClickProbe | ExternalLinkClick | undefined,
  ): Promise<InvocationResult> {
    if (!clicked.ok || !prepared) return clicked;
    if ("externalReason" in prepared) {
      return {
        ...clicked,
        stderr: [
          clicked.stderr,
          `link click delivery probe skipped: ${prepared.externalReason} opens/handles outside this document; clicked once without same-document verification`,
        ]
          .filter(Boolean)
          .join("\n"),
      };
    }
    const probe = prepared;
    const startedAt = Date.now();
    const first = await this.waitForLinkDelivery(probe);
    if (first.ok) {
      return {
        ...clicked,
        durationMs: clicked.durationMs + (Date.now() - startedAt),
      };
    }
    if (!/timed out/i.test(first.stderr)) {
      return linkDeliveryFailure(
        clicked,
        `link click delivery check failed: ${first.stderr.trim() || `exit ${first.exitCode}`}`,
        startedAt,
      );
    }
    if (this.sawChildTimeout) {
      return linkDeliveryFailure(
        clicked,
        `link click delivery check timed out and the browser backend became unresponsive; low-level retry skipped: ${first.stderr.trim()}`,
        startedAt,
      );
    }

    const point = await this.linkRetryPoint(probe.target);
    if (!point.ok) {
      return linkDeliveryFailure(
        clicked,
        `link click produced neither a URL change nor a DOM mutation; physical retry skipped because ${point.reason}`,
        startedAt,
      );
    }

    const retry = await this.batch(
      [
        ["mouse", "move", String(point.x), String(point.y)],
        ["mouse", "down", "left"],
        ["mouse", "up", "left"],
      ],
      { bail: true },
    );
    if (!retry.ok) {
      return linkDeliveryFailure(
        clicked,
        `link click physical retry failed: ${retry.raw.stderr.trim() || `exit ${retry.raw.exitCode}`}`,
        startedAt,
      );
    }

    const second = await this.waitForLinkDelivery(probe);
    if (!second.ok) {
      return linkDeliveryFailure(
        clicked,
        `link click produced neither a URL change nor a DOM mutation after one low-level mouse retry: ${second.stderr.trim() || `exit ${second.exitCode}`}`,
        startedAt,
      );
    }
    return {
      ...clicked,
      stderr: [
        clicked.stderr,
        "link click delivered after one low-level mouse retry",
      ]
        .filter(Boolean)
        .join("\n"),
      durationMs: clicked.durationMs + (Date.now() - startedAt),
    };
  }

  private waitForLinkDelivery(
    probe: LinkClickProbe,
  ): Promise<InvocationResult> {
    const expression = `(() => {
      const state = globalThis[Symbol.for(${JSON.stringify(probe.stateKey)})];
      const delivered = location.href !== ${JSON.stringify(probe.beforeUrl)} ||
        ${
          probe.beforeTimeOrigin === undefined
            ? "false"
            : `performance.timeOrigin !== ${probe.beforeTimeOrigin}`
        } ||
        Boolean(state && state.mutated);
      if (delivered && state && state.observer) state.observer.disconnect();
      return delivered;
    })()`;
    return this.invoke(
      [
        "wait",
        "--fn",
        expression,
        "--timeout",
        String(LINK_CLICK_DELIVERY_TIMEOUT_MS),
      ],
      { timeoutMs: childDeadline(LINK_CLICK_DELIVERY_TIMEOUT_MS) },
    );
  }

  private async linkRetryPoint(
    target: string,
  ): Promise<
    { ok: true; x: number; y: number } | { ok: false; reason: string }
  > {
    if (!target.startsWith("@")) {
      const result = await this.invoke([
        "eval",
        selectorRetryPointScript(target),
        "--json",
      ]);
      const point = result.ok
        ? parseEvalResult<{
            present?: boolean;
            enabled?: boolean;
            x?: number;
            y?: number;
          }>(result.stdout)
        : undefined;
      if (!point?.present)
        return { ok: false, reason: "the target disappeared" };
      if (!point.enabled)
        return { ok: false, reason: "the target is disabled" };
      if (typeof point.x !== "number" || typeof point.y !== "number") {
        return { ok: false, reason: "its center point could not be resolved" };
      }
      return { ok: true, x: point.x, y: point.y };
    }

    const enabledResult = await this.invoke([
      "is",
      "enabled",
      target,
      "--json",
    ]);
    const enabled = enabledResult.ok
      ? parseBooleanResult(enabledResult.stdout)
      : undefined;
    if (enabled !== true) {
      return {
        ok: false,
        reason:
          enabled === false
            ? "the target is disabled"
            : "the target disappeared",
      };
    }
    const boxResult = await this.invoke(["get", "box", target, "--json"]);
    const box = boxResult.ok ? parseBoxEnvelope(boxResult.stdout) : undefined;
    if (!box)
      return { ok: false, reason: "its center point could not be resolved" };
    return {
      ok: true,
      x: Math.round(box.x + box.width / 2),
      y: Math.round(box.y + box.height / 2),
    };
  }

  /** Add strict-selector context only on failure, keeping the happy path cheap. */
  private async appendSelectorMatchDiagnostics(
    result: InvocationResult,
    selector: string,
  ): Promise<InvocationResult> {
    const diagnostic = await this.invoke([
      "eval",
      selectorMatchDiagnosticsScript(selector),
      "--json",
    ]);
    const detail = diagnostic.ok
      ? parseEvalResult<{
          count?: number;
          candidates?: Array<{ tag?: string; role?: string; name?: string }>;
        }>(diagnostic.stdout)
      : undefined;
    if (!detail || typeof detail.count !== "number" || detail.count <= 1) {
      return result;
    }
    const candidates = (detail.candidates ?? [])
      .slice(0, 3)
      .map((candidate) => {
        const kind = candidate.role || candidate.tag || "element";
        return `${kind} ${JSON.stringify(candidate.name || "<no accessible name>")}`;
      });
    const omitted = Math.max(0, detail.count - candidates.length);
    const message = [
      `selector matched ${detail.count} elements; first ${candidates.length}: ${candidates.join(", ")}`,
      ...(omitted > 0 ? [`${omitted} more omitted`] : []),
    ].join("; ");
    return {
      ...result,
      stderr: [result.stderr.trim(), message].filter(Boolean).join("\n"),
    };
  }

  /**
   * Verify-after-click + post-nav settle.
   *
   * Two concerns that are easy to miss until a spec actually fails on them
   * (liftclub member_checkout, 2026-07-02):
   *
   *   1. agent-browser's `click` returns exit 0 even when the click never
   *      reached the app's handler (verified on 0.26–0.27: CDP reports
   *      success on the gesture, but the page never navigates). The
   *      verify-after-click step captures the URL pre/post and surfaces a
   *      clear failure when the click was expected to navigate but didn't.
   *      Same-page clicks (most form clicks) are unaffected.
   *
   *   2. When the click *does* land and the app issues a hard
   *      `window.location.assign(...)`, the next spec step's `wait` is a
   *      fresh execa subprocess reconnecting to the daemon with zero
   *      handoff (no in-process page handle). Folding a short networkidle
   *      wait into the click step's own invocation bridges that race.
   *
   * Both `opts.verifyAfterClick=false` and a resolved click-level `settleMs: 0`
   * disable BOTH effects — the networkidle fold here AND the link-delivery
   * probe upstream (see `clickProbeEnabled`) — because each is the author
   * declaring they handle post-click waiting themselves.
   */
  private async verifyAndSettleAfterClick(
    r: InvocationResult,
    locator: Locator,
    resolved?: SnapshotElement,
    settleMsOverride?: number,
  ): Promise<InvocationResult> {
    if (!r.ok) return r;
    if (this.opts.verifyAfterClick === false) {
      return resolved
        ? { ...r, resolvedElement: toResolvedElement(resolved) }
        : r;
    }
    const settleMs = this.resolveClickSettleMs(settleMsOverride);
    if (settleMs === 0) {
      return resolved
        ? { ...r, resolvedElement: toResolvedElement(resolved) }
        : r;
    }
    const settleStartedAt = Date.now();
    const initialSettle = await this.invoke(
      waitConditionToArgv({
        load: "networkidle",
        timeoutMs: settleMs,
      }),
      { timeoutMs: childDeadline(settleMs) },
    );
    const settleResult = await this.extendNetworkIdleWindow(
      initialSettle,
      settleMs,
      settleStartedAt,
    );
    // A click that ran for 700ms+ then a wait that timed out is the exact
    // shape of the liftclub failure; surface a short, honest message at the
    // click step instead of letting the next step's wait hang for ~60s.
    // (We never fail a click just because the URL didn't change — many
    // clicks legitimately stay on the same page; we *do* fail a click whose
    // settle ran out of time, since that means the page is still churning.)
    const settleStderr = settleResult.ok
      ? ""
      : `post-click settle: ${settleResult.stderr.trim() || `timed out after ${settleMs}ms`}`;
    return {
      ok: settleResult.ok,
      stdout: r.stdout,
      stderr: [r.stderr, settleStderr].filter(Boolean).join("\n"),
      exitCode: settleResult.ok ? r.exitCode : settleResult.exitCode,
      durationMs: r.durationMs + settleResult.durationMs,
      argv: r.argv,
      resolvedElement: resolved
        ? toResolvedElement(resolved)
        : r.resolvedElement,
    };
  }

  /**
   * Best-effort, independent confirmation that a resolved element's
   * bounding box actually falls within the live viewport after
   * scrollIntoView. Needed because agent-browser's own actionability
   * signals are not reliable for this case: in a local repro (fixture with a
   * `position: fixed` dialog taller than the viewport, footer button beyond
   * `window.innerHeight`), `scrollintoview` reports "✓ Done" with the
   * element's box byte-for-byte unchanged, `is visible` reports `true`, and
   * `click` exits 0 — yet `document.elementFromPoint` at the button's
   * coordinates returns `null` and the app's click handler never fires.
   *
   * Returns a short human-readable reason when the target is confirmed
   * off-viewport, or `undefined` when it's on-screen *or* when the check
   * itself couldn't be completed (never blocks the action on an
   * inconclusive result — e.g. an agent-browser version without `get box`).
   */
  private async detectOffViewportAfterScroll(
    ref: string,
  ): Promise<string | undefined> {
    // A one-shot box read races two real-world effects (both observed as
    // intermittent liftclub member_checkout failures):
    //   1. CSS `scroll-behavior: smooth` animates scrollIntoView over
    //      several hundred ms — the read fires mid-travel.
    //   2. Async sections above the target collapse/expand when their data
    //      lands, yanking an already-centered target back out of view
    //      (seen as a negative center-y right after a successful scroll).
    // Poll briefly and RE-SCROLL between reads — re-reading alone can't
    // recover from (2). The happy path (already visible) returns on the
    // first read; a genuinely unreachable target (position:fixed taller
    // than the viewport) pays the budget before failing, since re-scrolling
    // is a no-op there.
    const deadline = Date.now() + OFF_VIEWPORT_SETTLE_MS;
    for (;;) {
      const reason = await this.checkOffViewportOnce(ref);
      if (!reason) return undefined;
      if (Date.now() >= deadline) return reason;
      await sleep(OFF_VIEWPORT_POLL_INTERVAL_MS);
      await this.invoke(["scrollintoview", `@${ref}`]);
    }
  }

  /** `target` is an already-formed `@ref` or a raw CSS selector — `get box` takes either. */
  private async readBox(target: string): Promise<ElementBox | undefined> {
    const r = await this.invoke(["get", "box", target, "--json"]);
    return r.ok ? parseBoxEnvelope(r.stdout) : undefined;
  }

  private async checkOffViewportOnce(ref: string): Promise<string | undefined> {
    const box = await this.readBox(`@${ref}`);
    if (!box) return undefined;

    const metricsResult = await this.invoke([
      "eval",
      "(() => ({ scrollX: window.scrollX, scrollY: window.scrollY, innerWidth: window.innerWidth, innerHeight: window.innerHeight }))()",
      "--json",
    ]);
    const metrics = metricsResult.ok
      ? parseViewportMetrics(metricsResult.stdout)
      : undefined;
    if (!metrics) return undefined;

    // `get box` returns VIEWPORT-relative coordinates (verified against
    // getBoundingClientRect on agent-browser 0.31.1: identical y at
    // scrollY=816) — do NOT subtract scroll here. The original subtraction
    // double-counted the scroll and flagged every legitimately-scrolled
    // click as off-viewport (deterministic liftclub member_checkout
    // failure: in-view button at viewport y≈460, scrollY≈875 → cy=-415).
    // It went unnoticed because clicks near the page top ran at scrollY=0,
    // where subtracting zero is harmless.
    const cx = box.x + box.width / 2;
    const cy = box.y + box.height / 2;
    if (
      cx >= 0 &&
      cx <= metrics.innerWidth &&
      cy >= 0 &&
      cy <= metrics.innerHeight
    ) {
      return undefined;
    }
    return `target center (${Math.round(cx)}, ${Math.round(cy)}) is outside the ${metrics.innerWidth}x${metrics.innerHeight} viewport`;
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

  /**
   * Click-specific scroll variant for the selector path when the link-click
   * probe is disabled (verifyAfterClick:false / settleMs: 0): fold the
   * rect-settle viewport guard into the scroll eval — still one invocation —
   * and report the outcome so the click isn't dispatched at a coordinate the
   * target has left. Returns `undefined` when the check is inconclusive.
   */
  private async scrollSelectorIntoViewForClick(
    selector: string,
  ): Promise<SelectorRectSettle | undefined> {
    const script = `(async () => {
      try {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
        ${rectSettleJs()}
        return await __rectSettle(el);
      } catch (_) {
        return null;
      }
    })()`;
    const r = await this.invoke(["eval", script, "--json"]);
    if (!r.ok) return undefined;
    return normalizeRectSettle(parseEvalResult<unknown>(r.stdout));
  }

  /**
   * Fill-specific scroll variant for the selector path: scroll into view and,
   * when the target is a date-ish input (`type=date|time|datetime-local`),
   * set the value natively in the SAME eval — the standard framework-safe
   * shape (prototype value setter + bubbling input/change events, so
   * React/Vue value trackers observe the change) — because agent-browser's
   * keystroke `fill` reports ✓ Done against these inputs while the value
   * stays empty (verified against agent-browser 0.31.1; liftclub PAR-Q,
   * round-2 TODO item 4).
   *
   * Returns a completed InvocationResult when the fill was handled (or
   * definitively failed) here, and `undefined` to fall through to the normal
   * `fill` invocation — ordinary inputs, a missing element (agent-browser's
   * own error + selector diagnostics are better), or an inconclusive eval.
   *
   * Note the semantic-locator path needs no equivalent: date-ish inputs have
   * NO presence in the interactive accessibility snapshot (only their shadow
   * spinbutton parts appear), so a semantic fill against one already fails
   * loudly at resolution with candidate diagnostics — use `by: selector` to
   * reach them on this backend.
   */
  private async scrollAndFillDateishSelector(
    selector: string,
    value: string,
    startedAt: number,
  ): Promise<InvocationResult | undefined> {
    const r = await this.invoke([
      "eval",
      fillDateishProbeScript(selector, value),
      "--json",
    ]);
    if (!r.ok) {
      // Mirror prepareLinkClickProbe: a killed child means the daemon is
      // wedged — surface that instead of queueing another invocation.
      return this.sawChildTimeout ? r : undefined;
    }
    const report = normalizeDateishFill(parseEvalResult<unknown>(r.stdout));
    if (!report?.dateish || report.applied === undefined) return undefined;
    if (report.applied) return r;
    return this.unresolvedFailure("fill", startedAt, [
      `fill: <input type="${report.type}"> (selector ${JSON.stringify(selector)}) rejected value ${JSON.stringify(value)} — the browser sanitized it to ${JSON.stringify(report.value)}`,
      `date-ish inputs only accept normalized values: date=YYYY-MM-DD, time=HH:MM, datetime-local=YYYY-MM-DDTHH:MM`,
    ]);
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
              ...matchIdx.slice(0, 3).map((i) => {
                const el = parsed[i]!;
                return `  - ${el.role} ${
                  el.name ? JSON.stringify(el.name) : "<no name>"
                } ref=${el.ref}`;
              }),
              ...(matchIdx.length > 3
                ? [`  …and ${matchIdx.length - 3} more`]
                : []),
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
      // sawChildTimeout === true means the *previous* child was killed by
      // execa, not the daemon, and retrying now would just hit the same
      // path (see `timed out after …ms — killed \`agent-browser …\``). The
      // close path escalates to a daemon kill instead. Without this guard
      // a healthy-looking but really-unresponsive daemon would burn the
      // whole backoff window before the step surfaces as failed.
      if (result.ok || this.sawChildTimeout) break;
      if (!isTransientDaemonError(result.stderr)) break;
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
      // Set the flag AFTER composing the result so the retry guard's
      // `sawChildTimeout` check in invoke() reflects only PRIOR kills.
      // (Setting it before would make the same-call retry decide it has
      // already wedged, which is true but a confusing way to encode it.)
      const stderr = typeof result.stderr === "string" ? result.stderr : "";
      const ret: InvocationResult = {
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
      this.sawChildTimeout = true;
      return ret;
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
 * Length of each fresh subprocess slice used to re-issue a state-predicate
 * `wait` (`text`/`notText`/`selector`) against the live document, instead of
 * trusting one long-lived agent-browser wait's own internal polling loop for
 * the whole spec budget (see `runSlicedWaitStep`). Tuned to be long enough
 * that a passing wait finishes in slice #1 — no overhead on the happy path —
 * and short enough that a wedged daemon only costs one slice before
 * `sawChildTimeout` flips and slicing stops.
 */
const WAIT_SLICE_MS = 5_000;

/**
 * Floor for the final slice of a sliced wait, so a nearly-spent budget still
 * gets one real poll instead of an effectively-zero-timeout invocation.
 */
const WAIT_SLICE_FLOOR_MS = 250;

/**
 * Default max time the verify-after-click settle is willing to wait
 * (override per adapter via `opts.postClickSettleMs`, per project via the
 * config `browser.postClickSettleMs`). Tuned short enough to fail fast on
 * the liftclub-style hang (click that never lands → page never settles →
 * wait-step timeout 60s later) and long enough that a production SPA's
 * post-navigation fetch burst can complete without being cut off. Dev-mode
 * servers that compile modules on demand routinely need more — raise the
 * config knob there instead of disabling the guard. The same value is the
 * explicit `--timeout` passed to `agent-browser wait --load networkidle`,
 * so the daemon's own deadline matches the wrapper's hard kill.
 */
const POST_CLICK_NAV_SETTLE_MS = 5_000;
const NETWORK_IDLE_BASE_WINDOW_MS = 500;

/** Link clicks should synchronously schedule SPA navigation; keep retry cheap. */
const LINK_CLICK_DELIVERY_TIMEOUT_MS = 750;
const LINK_CLICK_PROBE_KEY = "cairntrace.link-click-delivery";

/**
 * Chromium screenshot capture can wedge when macOS has no compositing surface
 * (for example, while the display is asleep). Do not spend the generic 60s
 * command budget on an optional artifact.
 */
const SCREENSHOT_TIMEOUT_MS = 15_000;

/**
 * Budget for the post-scrollIntoView viewport confirmation. Covers a CSS
 * `scroll-behavior: smooth` animation (typically 300-500ms) with headroom;
 * a genuinely fixed off-viewport target spends this long before failing.
 * The selector path's in-page rect-settle guard shares the same budget.
 */
const OFF_VIEWPORT_SETTLE_MS = 1_500;
const OFF_VIEWPORT_POLL_INTERVAL_MS = 250;

/**
 * Frame fallback for the in-page rect-settle guard: a throttled/background
 * tab pauses requestAnimationFrame entirely — exactly the environment where
 * a stuck CSS transition leaves a sheet's button stably off-viewport — so
 * each frame wait races rAF against a setTimeout to stay bounded there.
 */
const RECT_SETTLE_FRAME_FALLBACK_MS = 250;

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

function appendLine(existing: string, line: string): string {
  return [existing.trim(), line.trim()].filter(Boolean).join("\n");
}

function networkIdleQuietExpression(quietMs: number): string {
  return `(() => {
    const entries = [
      ...performance.getEntriesByType("navigation"),
      ...performance.getEntriesByType("resource"),
    ];
    const lastActivity = entries.reduce((latest, entry) => {
      const responseEnd = Number(entry.responseEnd || 0);
      const startTime = Number(entry.startTime || 0);
      return Math.max(latest, responseEnd, startTime);
    }, 0);
    return performance.now() - lastActivity >= ${quietMs};
  })()`;
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

/** Give Vue/React one macrotask window to commit a click-triggered rerender. */
const BATCH_CLICK_PACE_MS = 100;
/**
 * Stage 1 grace: how long the verifier keeps re-polling a still-unchanged
 * control before deciding the authored CDP click was actually dropped and
 * firing the one recovery `.click()`. Long enough to cover an async framework
 * commit (Vue/React effects, ~400ms+ observed) so a merely-slow click is not
 * mistaken for a dropped one and double-toggled.
 */
const BATCH_CLICK_RECOVERY_GRACE_MS = 500;
/**
 * Stage 2 settle: after the recovery `.click()`, wait this long before judging
 * so BOTH a late authored commit AND the recovery commit have landed. If the
 * control then reads back at its ORIGINAL value, both toggles applied (a
 * double-toggle) and the verifier fails loudly instead of silently passing a
 * flipped-back state.
 */
const BATCH_CLICK_SETTLE_MS = 500;
/** Bound the whole two-stage in-batch state poll (grace + recovery + settle). */
const BATCH_CLICK_VERIFY_TIMEOUT_MS = 2_500;

/**
 * Expand checkable clicks while keeping the entire authored batch inside one
 * native `agent-browser batch` invocation. The pre-click probe records only a
 * primitive state — never a DOM node — and the verifier re-queries the
 * selector on every poll, so a framework replacing the control does not make
 * the check stale. If the CDP click was silently dropped, the verifier invokes
 * the authored element's native `.click()` once, then keeps polling until the
 * state changes (or fails loudly at the deadline).
 */
function buildBatchCommandPlan(step: BatchStep): BatchCommandPlanEntry[] {
  const plan: BatchCommandPlanEntry[] = [];
  step.batch.forEach((sub, sourceIndex) => {
    const originalArgv = batchSubStepToArgv(sub);
    if (!("click" in sub)) {
      plan.push({
        argv: originalArgv,
        sourceIndex,
        phase: "action",
        originalArgv,
      });
      return;
    }

    const selector = sub.click.selector;
    const stateKey = `cairntrace.batch-click.${sourceIndex}`;
    plan.push(
      {
        argv: [
          "eval",
          "-b",
          Buffer.from(batchClickProbeScript(selector, stateKey)).toString(
            "base64",
          ),
        ],
        sourceIndex,
        phase: "probe",
        originalArgv,
      },
      {
        argv: originalArgv,
        sourceIndex,
        phase: "action",
        originalArgv,
      },
      {
        argv: ["wait", String(BATCH_CLICK_PACE_MS)],
        sourceIndex,
        phase: "pace",
        originalArgv,
      },
      {
        argv: [
          "wait",
          "--fn",
          batchClickVerifyExpression(selector, stateKey),
          "--timeout",
          String(BATCH_CLICK_VERIFY_TIMEOUT_MS),
        ],
        sourceIndex,
        phase: "verify",
        originalArgv,
      },
    );
  });
  return plan;
}

function batchClickProbeScript(selector: string, stateKey: string): string {
  return `(() => {
    const raw = document.querySelector(${JSON.stringify(selector)});
    const stateTarget = (() => {
      if (!raw) return null;
      const checkable = 'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"], [aria-checked]';
      if (raw.matches(checkable)) return raw;
      if (raw.tagName === 'LABEL' && raw.control) return raw.control;
      const label = raw.closest('label');
      if (label && label.control) return label.control;
      return raw.querySelector(checkable) || raw.closest('[role="checkbox"], [role="radio"], [role="switch"], [aria-checked]');
    })();
    const read = (el) => {
      if (!el) return null;
      if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) {
        return { kind: el.type === 'radio' ? 'radio' : 'toggle', value: Boolean(el.checked) };
      }
      const aria = el.getAttribute('aria-checked');
      if (aria === 'true' || aria === 'false' || aria === 'mixed') {
        return { kind: el.getAttribute('role') === 'radio' ? 'radio' : 'toggle', value: aria };
      }
      return null;
    };
    const before = read(stateTarget);
    globalThis[Symbol.for(${JSON.stringify(stateKey)})] = before
      ? { ...before, recoveryAttempted: false, recoveryAfter: null, settleAfter: null }
      : { kind: null, value: null, recoveryAttempted: false, recoveryAfter: 0, settleAfter: null };
    return before;
  })()`;
}

function batchClickVerifyExpression(
  selector: string,
  stateKey: string,
): string {
  return `(() => {
    const state = globalThis[Symbol.for(${JSON.stringify(stateKey)})];
    if (!state || state.kind === null) return true;
    const raw = document.querySelector(${JSON.stringify(selector)});
    if (!raw) return false;
    const checkable = 'input[type="checkbox"], input[type="radio"], [role="checkbox"], [role="radio"], [role="switch"], [aria-checked]';
    const stateTarget = raw.matches(checkable)
      ? raw
      : (raw.tagName === 'LABEL' && raw.control)
        ? raw.control
        : (raw.closest('label') && raw.closest('label').control)
          ? raw.closest('label').control
          : raw.querySelector(checkable) || raw.closest('[role="checkbox"], [role="radio"], [role="switch"], [aria-checked]');
    let current = null;
    if (stateTarget instanceof HTMLInputElement && (stateTarget.type === 'checkbox' || stateTarget.type === 'radio')) {
      current = Boolean(stateTarget.checked);
    } else if (stateTarget) {
      const aria = stateTarget.getAttribute('aria-checked');
      if (aria === 'true' || aria === 'false' || aria === 'mixed') current = aria;
    }
    const changed = state.kind === 'radio'
      ? current === true || current === 'true'
      : current !== null && current !== state.value;
    const now = Date.now();
    if (!state.recoveryAttempted) {
      // Stage 1: the authored CDP click may just be slow to commit. Return
      // success the moment it lands; otherwise re-poll for the full grace
      // before concluding it was dropped, so a late commit is never mistaken
      // for a drop and then double-toggled by the recovery click.
      if (changed) {
        delete globalThis[Symbol.for(${JSON.stringify(stateKey)})];
        return true;
      }
      // Start the grace at the first post-action poll (a slow authored click
      // must not consume the grace and trigger an immediate duplicate).
      if (state.recoveryAfter === null) {
        state.recoveryAfter = now + ${BATCH_CLICK_RECOVERY_GRACE_MS};
        return false;
      }
      if (now < state.recoveryAfter) return false;
      // Grace elapsed and still unchanged: recover once, then hold for the
      // settle window before judging so both potential commits can land.
      state.recoveryAttempted = true;
      state.settleAfter = now + ${BATCH_CLICK_SETTLE_MS};
      const disabled = raw.matches(':disabled') || raw.getAttribute('aria-disabled') === 'true' || Boolean(raw.disabled);
      if (!disabled && typeof raw.click === 'function') raw.click();
      return false;
    }
    // Stage 2: after the recovery click, wait out the settle before judging.
    if (now < state.settleAfter) return false;
    if (changed) {
      delete globalThis[Symbol.for(${JSON.stringify(stateKey)})];
      return true;
    }
    // Settled back at the ORIGINAL value: a late authored commit AND the
    // recovery both applied → double-toggle. Fail loudly rather than pass a
    // flipped-back state. Deliberately DO NOT clear the state before throwing:
    // if agent-browser's wait --fn swallows the throw and re-polls, the next
    // poll re-enters this branch and throws again (eventually timing out as a
    // failure) instead of finding a cleared state and silently passing.
    throw new Error('batch click double-toggled: recovery click landed a second toggle and the control returned to its original state (framework commit slower than the recovery grace) — split this into a top-level click step or raise settle timing');
  })()`;
}

function isFailedBatchResult(result: unknown): boolean {
  if (typeof result !== "object" || result === null || Array.isArray(result)) {
    return true;
  }
  const record = result as Record<string, unknown>;
  const explicitlySucceeded =
    record["success"] === true ||
    (record["success"] === undefined && record["ok"] === true);
  const hasError =
    record["error"] !== undefined &&
    record["error"] !== null &&
    record["error"] !== "";
  return !explicitlySucceeded || hasError;
}

/**
 * JS for reading the text of EVERY element matching `selector`, joined the way
 * Playwright's allInnerTexts().join("\n") joins them, so the two backends hand
 * the text verifiers an identical haystack.
 *
 * A malformed selector must throw rather than resolve to an empty string:
 * querySelectorAll raises SyntaxError, which surfaces as a failed `eval` and
 * therefore a failed read — never a silent "" that `notText` would report as
 * "confirmed absent".
 */
export function allMatchesTextJs(selector: string): string {
  return `(() => Array.from(document.querySelectorAll(${JSON.stringify(
    selector,
  )})).map((el) => el.innerText ?? el.textContent ?? '').join('\\n'))()`;
}

/**
 * Build a step error for a failed `batch --bail`. agent-browser emits a JSON
 * array of per-command results on stdout; with --bail the run stops at the
 * first failure, so the array length tells us which sub-step bailed. Falls back
 * to raw stderr when the output can't be parsed.
 */
export function describeBatchFailure(
  plan: BatchCommandPlanEntry[],
  raw: { stdout: string; stderr: string; exitCode: number },
): string {
  const stderr = raw.stderr.trim();
  let results: Array<Record<string, unknown>> = [];
  try {
    const parsed = JSON.parse(raw.stdout.trim()) as unknown;
    if (Array.isArray(parsed))
      results = parsed as Array<Record<string, unknown>>;
  } catch {
    // non-JSON output — fall through to the stderr-only message
  }
  const failedIdx = results.findIndex(isFailedBatchResult);
  const stderrCommand = /command\s+(\d+)/i.exec(stderr);
  let idx = failedIdx;
  if (idx < 0 && stderrCommand) idx = Number(stderrCommand[1]) - 1;
  if (idx < 0 && results.length > 0) {
    const allExplicitlySucceeded = results.every(
      (res) => res["success"] === true || res["ok"] === true,
    );
    idx =
      allExplicitlySucceeded && results.length < plan.length
        ? results.length
        : results.length - 1;
  }
  if (idx >= 0 && idx < plan.length) {
    const entry = plan[idx]!;
    const cmd = entry.originalArgv.join(" ");
    const inner =
      (failedIdx >= 0 && typeof results[failedIdx]?.["error"] === "string"
        ? (results[failedIdx]!["error"] as string)
        : "") ||
      stderr ||
      `exit ${raw.exitCode}`;
    const phase =
      entry.phase === "probe"
        ? "pre-click state probe"
        : entry.phase === "pace"
          ? "post-click pacing"
          : entry.phase === "verify"
            ? "post-click state verification"
            : "action";
    return `batch failed at sub-step #${entry.sourceIndex + 1} (${cmd}) during ${phase}: ${inner}`;
  }
  return stderr || `batch failed (exit ${raw.exitCode})`;
}

/**
 * In-page rect-settle guard for `by: selector` clicks (the ref path gets the
 * same protection out-of-process via `detectOffViewportAfterScroll`). After
 * scrollIntoView, sample `getBoundingClientRect()` on consecutive animation
 * frames until two frames agree AND the center sits inside the viewport,
 * re-scrolling between stable-but-off-viewport samples (an async section
 * collapsing above the target can yank a centered target back out). Runs
 * entirely inside the eval that already exists on this path, so a selector
 * click pays ZERO extra invocations for the guard — the reverted `get box`
 * subprocess-polling gate added ~2 invocations per click. Resolves to a
 * `{ stable, inViewport, cx, cy, innerWidth, innerHeight }` report, or null
 * when the check couldn't run (inconclusive → never blocks the click).
 */
function rectSettleJs(): string {
  return `const __rectSettle = async (el) => {
      try {
        const frame = () => new Promise((resolve) => {
          let done = false;
          const finish = () => { if (!done) { done = true; resolve(); } };
          if (typeof requestAnimationFrame === "function") requestAnimationFrame(finish);
          setTimeout(finish, ${RECT_SETTLE_FRAME_FALLBACK_MS});
        });
        const read = () => {
          const r = el.getBoundingClientRect();
          return { x: r.x, y: r.y, w: r.width, h: r.height };
        };
        const same = (a, b) => Math.abs(a.x - b.x) < 0.5 && Math.abs(a.y - b.y) < 0.5 &&
          Math.abs(a.w - b.w) < 0.5 && Math.abs(a.h - b.h) < 0.5;
        const report = (rect, stable) => {
          const cx = rect.x + rect.w / 2;
          const cy = rect.y + rect.h / 2;
          return {
            stable,
            inViewport: cx >= 0 && cx <= window.innerWidth && cy >= 0 && cy <= window.innerHeight,
            cx: Math.round(cx), cy: Math.round(cy),
            innerWidth: window.innerWidth, innerHeight: window.innerHeight,
          };
        };
        const deadline = Date.now() + ${OFF_VIEWPORT_SETTLE_MS};
        let prev = read();
        for (;;) {
          await frame();
          const cur = read();
          const out = report(cur, same(prev, cur));
          if ((out.stable && out.inViewport) || Date.now() >= deadline) return out;
          if (out.stable) {
            try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
          }
          prev = cur;
        }
      } catch (_) {
        return null;
      }
    };`;
}

/**
 * Build the pre-click classification eval. `scroll` folds scrollIntoView AND
 * the rect-settle viewport guard into the same invocation (selector path; the
 * eval becomes async — agent-browser awaits promise results, verified on
 * 0.31.2). The element is located by CSS selector or, on the semantic path,
 * by matching a link's accessible name. `assumeLink` (semantic path, where
 * the snapshot already resolved a role=link) treats an un-locatable target as
 * a same-tab link so its delivery is still verified — only a
 * POSITIVELY-classified external-effect link skips verification.
 */
function linkClickProbeScript(opts: {
  selector?: string;
  name?: string;
  scroll: boolean;
  assumeLink: boolean;
}): string {
  const findExpr =
    opts.selector !== undefined
      ? `document.querySelector(${JSON.stringify(opts.selector)})`
      : opts.name !== undefined
        ? `__findLinkByName(${JSON.stringify(opts.name)})`
        : "null";
  return `(${opts.scroll ? "async " : ""}() => {
    const __norm = (s) => String(s == null ? "" : s).replace(/\\s+/g, " ").trim().toLowerCase();
    const __findLinkByName = (want) => {
      const target = __norm(want);
      const links = Array.from(document.querySelectorAll('a[href], [role=link]'));
      const matches = links.filter((el) => __norm(el.getAttribute("aria-label") || el.getAttribute("title") || el.textContent || "") === target);
      return matches.length === 1 ? matches[0] : null;
    };
    const raw = ${findExpr};
    ${
      opts.scroll
        ? 'if (raw) { try { raw.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {} }'
        : ""
    }
    ${opts.scroll ? rectSettleJs() : ""}
    ${
      // Settle BEFORE capturing beforeUrl — the guard may wait up to its
      // budget, and a URL captured before it could be stale for delivery.
      opts.scroll
        ? "const __settle = raw ? await __rectSettle(raw) : null;"
        : ""
    }
    const base = { beforeUrl: location.href, beforeTimeOrigin: performance.timeOrigin${
      opts.scroll ? ", settle: __settle" : ""
    } };
    const anchor = raw && (raw.matches && raw.matches('a[href], [role=link]')
      ? raw
      : (raw.closest ? raw.closest('a[href], [role=link]') : null));
    if (!anchor) {
      // Selector path: a non-link target (button, div…) → no probe. Semantic
      // path (assumeLink): the snapshot resolved a role=link but we could not
      // re-locate it by name, so verify same-tab delivery to be safe.
      if (!${opts.assumeLink}) return { ...base, linkLike: false };
      __installLinkObserver();
      return { ...base, linkLike: true, externalReason: null };
    }
    // External-effect: click cannot change THIS document.
    const __external = (() => {
      if (anchor.hasAttribute && anchor.hasAttribute("download")) return "a download attribute";
      const t = (anchor.getAttribute && anchor.getAttribute("target")) || "";
      if (t && t !== "_self") return 'target="' + t + '"';
      const href = (anchor.getAttribute && anchor.getAttribute("href")) || "";
      const scheme = /^\\s*([a-z][a-z0-9+.-]*):/i.exec(href);
      if (scheme && !/^https?$/i.test(scheme[1])) return "a " + scheme[1].toLowerCase() + ": href";
      return null;
    })();
    if (__external) return { ...base, linkLike: true, externalReason: __external };
    __installLinkObserver();
    return { ...base, linkLike: true, externalReason: null };
    function __installLinkObserver() {
      const key = Symbol.for(${JSON.stringify(LINK_CLICK_PROBE_KEY)});
      const previous = globalThis[key];
      if (previous && previous.observer) previous.observer.disconnect();
      const state = { mutated: false, observer: null };
      state.observer = new MutationObserver(() => { state.mutated = true; });
      state.observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
      globalThis[key] = state;
    }
  })()`;
}

/**
 * Scroll a selector target into view and, when it is a date-ish input, set
 * the value natively inside the same eval (see
 * `scrollAndFillDateishSelector`). The prototype value setter bypasses
 * framework-patched instance descriptors (React) and the bubbling
 * input/change events feed framework value trackers — the exact shape the
 * liftclub PAR-Q specs carried as an eval workaround before this landed.
 * Returns `{ dateish: false }` for ordinary targets and `null` when the
 * element is missing or the probe itself failed (both fall through to the
 * normal `fill` invocation, whose own diagnostics are better).
 */
function fillDateishProbeScript(selector: string, value: string): string {
  return `(() => {
    try {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      try { el.scrollIntoView({ block: "center", inline: "center" }); } catch (_) {}
      const type = el instanceof HTMLInputElement ? el.type : "";
      if (type !== "date" && type !== "time" && type !== "datetime-local") {
        return { dateish: false };
      }
      const want = ${JSON.stringify(value)};
      const previous = el.value;
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      const setValue = (v) => {
        if (descriptor && descriptor.set) { descriptor.set.call(el, v); } else { el.value = v; }
      };
      setValue(want);
      // The value setter sanitizes: an invalid format becomes "" silently. A
      // valid value may be normalized (e.g. trailing ":00" dropped), so
      // "accepted" is "non-empty result for a non-empty request".
      const applied = want === "" ? el.value === "" : el.value !== "";
      if (!applied) {
        // A failing step must not leave the field wiped: restore what was
        // there and fire no events — the app never sees the bad value.
        setValue(previous);
        return { dateish: true, type, applied, value: "" };
      }
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { dateish: true, type, applied, value: el.value };
    } catch (_) {
      return null;
    }
  })()`;
}

/** Accept a date-ish fill report only when it carries the decision boolean. */
function normalizeDateishFill(value: unknown): DateishFillReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record["dateish"] !== "boolean") return undefined;
  return {
    dateish: record["dateish"],
    ...(typeof record["type"] === "string" ? { type: record["type"] } : {}),
    ...(typeof record["applied"] === "boolean"
      ? { applied: record["applied"] }
      : {}),
    ...(typeof record["value"] === "string" ? { value: record["value"] } : {}),
  };
}

function selectorRetryPointScript(selector: string): string {
  return `(() => {
    const raw = document.querySelector(${JSON.stringify(selector)});
    if (!raw) return { present: false, enabled: false };
    const disabled = raw.matches(':disabled') || raw.getAttribute('aria-disabled') === 'true' || Boolean(raw.disabled);
    const rect = raw.getBoundingClientRect();
    return {
      present: true,
      enabled: !disabled && rect.width > 0 && rect.height > 0,
      x: Math.round(rect.left + rect.width / 2),
      y: Math.round(rect.top + rect.height / 2),
    };
  })()`;
}

function selectorMatchDiagnosticsScript(selector: string): string {
  return `(() => {
    const normalize = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
    const nodes = Array.from(document.querySelectorAll(${JSON.stringify(selector)}));
    return {
      count: nodes.length,
      candidates: nodes.slice(0, 3).map((node) => ({
        tag: node.tagName.toLowerCase(),
        role: node.getAttribute('role') || '',
        name: normalize(node.getAttribute('aria-label') || node.getAttribute('title') || node.innerText || node.textContent || node.value),
      })),
    };
  })()`;
}

/**
 * Accept a rect-settle report only when it carries the two decision booleans —
 * anything else (null from a failed in-page check, an envelope object leaked
 * by `parseEvalResult`'s fallback chain, a mocked eval without the field) is
 * inconclusive and must never block the click.
 */
function normalizeRectSettle(value: unknown): SelectorRectSettle | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  if (
    typeof record["stable"] !== "boolean" ||
    typeof record["inViewport"] !== "boolean"
  ) {
    return undefined;
  }
  return {
    stable: record["stable"],
    inViewport: record["inViewport"],
    ...(typeof record["cx"] === "number" ? { cx: record["cx"] } : {}),
    ...(typeof record["cy"] === "number" ? { cy: record["cy"] } : {}),
    ...(typeof record["innerWidth"] === "number"
      ? { innerWidth: record["innerWidth"] }
      : {}),
    ...(typeof record["innerHeight"] === "number"
      ? { innerHeight: record["innerHeight"] }
      : {}),
  };
}

/**
 * Short human-readable reason a selector click must not be dispatched, or
 * `undefined` when the target settled in-viewport (or the check was
 * inconclusive — parity with `detectOffViewportAfterScroll`, which never
 * blocks on a check it couldn't complete).
 */
function rectSettleFailure(
  settle: SelectorRectSettle | undefined,
): string | undefined {
  if (!settle) return undefined;
  const center =
    typeof settle.cx === "number" && typeof settle.cy === "number"
      ? `: target center (${settle.cx}, ${settle.cy})`
      : "";
  const viewport =
    typeof settle.innerWidth === "number" &&
    typeof settle.innerHeight === "number"
      ? ` the ${settle.innerWidth}x${settle.innerHeight} viewport`
      : " the viewport";
  if (!settle.stable) {
    return `its bounding rect was still moving after ${OFF_VIEWPORT_SETTLE_MS}ms (a CSS transition/animation that never settled)${center} vs${viewport}`;
  }
  if (!settle.inViewport) {
    return `it stayed off-viewport after scrollIntoView${center} is outside${viewport}`;
  }
  return undefined;
}

function parseEvalResult<T>(stdout: string): T | undefined {
  const trimmed = stdout.trim();
  if (!trimmed) return undefined;
  try {
    const parsed = JSON.parse(trimmed) as {
      data?: { result?: unknown };
      result?: unknown;
    };
    return (parsed.data?.result ?? parsed.result ?? parsed) as T;
  } catch {
    return undefined;
  }
}

function parseBooleanResult(stdout: string): boolean | undefined {
  const trimmed = stdout.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  try {
    const parsed = JSON.parse(trimmed) as {
      data?: { enabled?: unknown; result?: unknown; value?: unknown };
      enabled?: unknown;
      result?: unknown;
      value?: unknown;
    };
    for (const candidate of [
      parsed.data?.enabled,
      parsed.data?.result,
      parsed.data?.value,
      parsed.enabled,
      parsed.result,
      parsed.value,
    ]) {
      if (typeof candidate === "boolean") return candidate;
    }
  } catch {
    return undefined;
  }
  const result = parseEvalResult<unknown>(stdout);
  if (typeof result === "boolean") return result;
  if (result && typeof result === "object") {
    const record = result as Record<string, unknown>;
    if (typeof record["value"] === "boolean") return record["value"];
  }
  return undefined;
}

function linkDeliveryFailure(
  clicked: InvocationResult,
  message: string,
  startedAt: number,
): InvocationResult {
  return {
    ...clicked,
    ok: false,
    stderr: [clicked.stderr.trim(), message].filter(Boolean).join("\n"),
    exitCode: clicked.exitCode === 0 ? 1 : clicked.exitCode,
    durationMs: clicked.durationMs + (Date.now() - startedAt),
  };
}

export function isTransientDaemonError(stderr: string): boolean {
  return /os error 35|Resource temporarily unavailable|daemon may be busy|daemon may be unresponsive/i.test(
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
