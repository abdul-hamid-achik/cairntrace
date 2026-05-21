import { execa } from "execa";
import type { Step } from "../../core/schema/spec.v1";
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
    // `errors` returns page errors; we treat them as console entries with type "error".
    const r = await this.invoke(["errors", "--json"]);
    if (!r.ok) return [];
    return parseEnvelope<ConsoleEntry>(r.stdout, "errors").map((e) => ({
      ...e,
      // agent-browser emits errors with no `type` field; normalize for verifiers.
      type: e.type ?? "error",
    }));
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

  /** Compose `[--session foo, ...globals, ...argv]` and invoke agent-browser. */
  private async invoke(argv: string[]): Promise<InvocationResult> {
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
      timeout: this.opts.defaultTimeoutMs,
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

/* ----- helpers ----- */

function buildGlobalArgs(opts: AgentBrowserOptions): string[] {
  const a: string[] = [];
  if (opts.headed) a.push("--headed");
  if (opts.profile) a.push("--profile", opts.profile);
  if (opts.initialStatePath) a.push("--state", opts.initialStatePath);
  if (opts.screenshotDir) a.push("--screenshot-dir", opts.screenshotDir);
  if (opts.maxOutput !== undefined)
    a.push("--max-output", String(opts.maxOutput));
  if (opts.debug) a.push("--debug");
  if (opts.extraGlobalArgs) a.push(...opts.extraGlobalArgs);
  return a;
}

function parseJsonArray<T>(stdout: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

/**
 * agent-browser wraps JSON results in `{ success, data: { <key>: [...] }, error }`.
 * Pull the inner array out by key. Returns `[]` on any parse failure or
 * mismatch — verifiers should never crash because of an unexpected output shape.
 */
function parseEnvelope<T>(stdout: string, key: string): T[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as {
      success?: boolean;
      data?: Record<string, unknown>;
    };
    const inner = parsed?.data?.[key];
    return Array.isArray(inner) ? (inner as T[]) : [];
  } catch {
    return [];
  }
}

function quoteIfNeeded(s: string): string {
  // batch argv is space-joined, so any arg containing whitespace, quotes,
  // or shell metacharacters needs to be quoted with double quotes and have
  // internal double-quotes/backslashes escaped.
  if (!/[\s"\\]/.test(s)) return s;
  return `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}
