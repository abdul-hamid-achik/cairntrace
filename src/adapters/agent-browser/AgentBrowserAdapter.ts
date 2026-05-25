import { execa } from "execa";
import {
  parseSnapshot,
  type SnapshotElement,
} from "../../core/healer/snapshotParser";
import type {
  DownloadStep,
  HoverStep,
  Locator,
  Step,
} from "../../core/schema/spec.v1";
import type {
  BrowserBackend,
  ConsoleEntry,
  InvocationResult,
  NetworkEntry,
  NetworkFilter,
  ScreenshotResult,
  SnapshotResult,
} from "../browserBackend";
import { stepToArgv } from "./commandBuilder";
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

  constructor(private readonly opts: AgentBrowserOptions) {
    this.binary = opts.binary ?? "agent-browser";
    this.globalArgs = buildGlobalArgs(opts);
  }

  /* ----- step dispatch ----- */

  async runStep(step: Step): Promise<InvocationResult> {
    if ("download" in step) return this.runDownloadStep(step);
    if ("hover" in step) return this.runHoverStep(step);
    return this.invoke(stepToArgv(step));
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
    return this.invoke([
      "wait",
      "--text",
      text,
      "--timeout",
      String(timeoutMs),
    ]);
  }

  async waitForUrl(
    pattern: string,
    timeoutMs: number,
  ): Promise<InvocationResult> {
    return this.invoke([
      "wait",
      "--url",
      pattern,
      "--timeout",
      String(timeoutMs),
    ]);
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
    return this.invoke(["close"]);
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

  private async runDownloadStep(step: DownloadStep): Promise<InvocationResult> {
    const { saveAs, assign: _assign, timeoutMs, ...locator } = step.download;
    if (locator.by === "selector") {
      return this.invoke(["download", locator.selector, saveAs], {
        timeoutMs,
      });
    }

    const resolved = await this.resolveInteractiveRef(
      locator as Locator,
      timeoutMs ?? DEFAULT_LOCATOR_TIMEOUT_MS,
    );
    if (!resolved.ok) return resolved.result;
    return this.invoke(["download", resolved.ref, saveAs], { timeoutMs });
  }

  private async runHoverStep(step: HoverStep): Promise<InvocationResult> {
    if (step.hover.by === "selector") {
      await this.scrollSelectorIntoView(step.hover.selector);
    }
    return this.invoke(stepToArgv(step));
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
  ): Promise<
    { ok: true; ref: string } | { ok: false; result: InvocationResult }
  > {
    const start = Date.now();
    const deadline = start + Math.max(0, timeoutMs);
    let lastSnapshot: { ok: boolean; stdout: string; stderr: string } = {
      ok: false,
      stdout: "",
      stderr: "",
    };

    // Poll the interactive snapshot until the locator resolves or the timeout
    // expires — parity with click's wait-for-visibility behavior. Selector-only
    // downloads skip this path; agent-browser's `download <selector>` waits on
    // its own.
    while (true) {
      const snapshot = await this.invoke(["snapshot", "-i"]);
      lastSnapshot = snapshot;
      if (snapshot.ok) {
        const parsed = parseSnapshot(snapshot.stdout);
        const matchIdx = matchingSnapshotIndices(locator, parsed);
        if (matchIdx.length > 0) {
          // Prefer the enclosing actionable ancestor (typically <a href download>)
          // when the locator resolves to an inner control like a > button.
          const idx = matchIdx[0]!;
          const target = preferActionableAncestor(idx, parsed) ?? parsed[idx]!;
          if (target.ref) {
            return { ok: true, ref: `@${target.ref}` };
          }
        }
      }
      if (Date.now() >= deadline) break;
      const remaining = deadline - Date.now();
      await sleep(Math.min(POLL_INTERVAL_MS, Math.max(50, remaining)));
    }

    const parsed = lastSnapshot.ok ? parseSnapshot(lastSnapshot.stdout) : [];
    const diagnostics = buildLocatorDiagnostics(locator, parsed);
    const stderrLines = [
      `could not resolve ${describeLocator(locator)} to an interactive snapshot ref for download within ${timeoutMs}ms`,
      ...diagnostics,
    ];
    if (!lastSnapshot.ok && lastSnapshot.stderr) {
      stderrLines.push(`snapshot stderr: ${lastSnapshot.stderr.trim()}`);
    }
    return {
      ok: false,
      result: {
        ok: false,
        stdout: "",
        stderr: stderrLines.join("\n"),
        exitCode: 1,
        durationMs: Date.now() - start,
        argv: [
          "--session",
          this.opts.session,
          ...this.globalArgs,
          "download",
          "<unresolved>",
        ],
      },
    };
  }

  /** Compose `[--session foo, ...globals, ...argv]` and invoke agent-browser. */
  private async invoke(
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
    const result = await execa(this.binary, fullArgv, {
      reject: false,
      cwd: this.opts.cwd,
      timeout: invokeOpts.timeoutMs ?? this.opts.defaultTimeoutMs,
    });
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
        (locator.name === undefined || el.name === locator.name)
      );
    case "label":
      return el.name === locator.name;
    case "text":
      return el.name === locator.text;
    case "selector":
      return false;
  }
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
      ? ` in dialog ${c.dialog.name ? JSON.stringify(c.dialog.name) : "(unnamed)"}`
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
