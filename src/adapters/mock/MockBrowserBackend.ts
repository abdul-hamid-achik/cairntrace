import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { openPath, type Step, StepSchema } from "../../core/schema/spec.v1";
import type {
  BackendRequest,
  BackendResponse,
  BrowserBackend,
  ConsoleEntry,
  InvocationResult,
  NetworkEntry,
  NetworkFilter,
  ScreenshotResult,
  SnapshotResult,
} from "../browserBackend";

/** Result an enqueued `evaluate()` call returns. Matches the `script` verifier contract. */
export interface ScriptInvocationResult {
  ok: boolean;
  evidence: unknown;
}

/**
 * In-memory BrowserBackend for tests and `cairn run --mock`.
 *
 * Defaults to succeeding every step and returning empty network/console.
 * Tests script behavior via setters (`setPageText`, `pushNetworkEntry`, …).
 *
 * Files written by screenshot() are real files at the requested path so the
 * artifact writer's existence checks succeed.
 */
export class MockBrowserBackend implements BrowserBackend {
  readonly name = "mock" as const;

  private url = "about:blank";
  private title = "";
  private snapshotText = "- generic\n  - body";
  private textByRegion = new Map<string, string>();
  private countBySelector = new Map<string, number>();
  private networkLog: NetworkEntry[] = [];
  private consoleLog: ConsoleEntry[] = [];
  private scriptQueue: unknown[] = [];
  private stepShouldFail = false;
  private stepFailureMessage = "mock step failure";
  private strictStepValidation = false;
  /** Recorded steps for assertions in tests. */
  public readonly stepLog: Step[] = [];
  public readonly requestLog: BackendRequest[] = [];
  public lastEvaluatedScript = "";
  public lastEvaluateOptions: { timeoutMs?: number } | undefined;
  public lastRequest: BackendRequest | undefined;

  /* ----- scripting hooks for tests ----- */

  setUrl(u: string): void {
    this.url = u;
  }
  setTitle(t: string): void {
    this.title = t;
  }
  setSnapshot(text: string): void {
    this.snapshotText = text;
  }
  setPageText(text: string): void {
    this.textByRegion.set("page", text);
  }
  setRegionText(region: string, text: string): void {
    this.textByRegion.set(region, text);
  }
  setCount(selector: string, n: number): void {
    this.countBySelector.set(selector, n);
  }
  pushNetworkEntry(
    e: Partial<NetworkEntry> & { url: string; method: string },
  ): void {
    this.networkLog.push({ ...e } as NetworkEntry);
  }
  pushConsoleEntry(
    e: Partial<ConsoleEntry> & { type: ConsoleEntry["type"]; text: string },
  ): void {
    this.consoleLog.push({ ...e } as ConsoleEntry);
  }
  /** Queue the next script-verifier result. FIFO. */
  enqueueScriptResult(r: ScriptInvocationResult): void {
    this.scriptQueue.push(r);
  }
  /** Queue a raw evaluate() result (e.g. a request-step response envelope). FIFO with script results. */
  enqueueEvalResult(value: unknown): void {
    this.scriptQueue.push(value);
  }
  failNextStep(message = "mock step failure"): void {
    this.stepShouldFail = true;
    this.stepFailureMessage = message;
  }
  /**
   * When enabled, runStep validates each step against StepSchema and fails on
   * a shape the schema rejects. Off by default (so existing tests are
   * unaffected); turn it on to catch step-shape bugs — e.g. a recorder or
   * exporter emitting a step the real backends would reject — that the
   * permissive default would otherwise pass green.
   */
  setStrictStepValidation(on = true): void {
    this.strictStepValidation = on;
  }

  /* ----- BrowserBackend impl ----- */

  async runStep(step: Step): Promise<InvocationResult> {
    this.stepLog.push(step);
    if (this.strictStepValidation) {
      const parsed = StepSchema.safeParse(step);
      if (!parsed.success) {
        return failure(
          `mock: step rejected by StepSchema: ${parsed.error.issues
            .map((i) => `${i.path.join(".")} ${i.message}`)
            .join("; ")}`,
        );
      }
    }
    if ("open" in step) this.url = openPath(step);
    if ("download" in step) {
      await mkdir(dirname(step.download.saveAs), { recursive: true });
      await writeFile(step.download.saveAs, MOCK_DOWNLOAD);
    }
    if (this.stepShouldFail) {
      this.stepShouldFail = false;
      return failure(this.stepFailureMessage);
    }
    return success();
  }

  async snapshot(_opts?: { interactive?: boolean }): Promise<SnapshotResult> {
    return { ok: true, text: this.snapshotText, durationMs: 0 };
  }

  async screenshot(opts: {
    path: string;
    fullPage?: boolean;
  }): Promise<ScreenshotResult> {
    await writeFile(opts.path, MOCK_PNG);
    return { ok: true, path: opts.path, durationMs: 0 };
  }

  async getUrl(): Promise<string> {
    return this.url;
  }
  async getTitle(): Promise<string> {
    return this.title;
  }
  async getText(selector: string): Promise<string> {
    return (
      this.textByRegion.get(selector) ?? this.textByRegion.get("page") ?? ""
    );
  }
  async getCount(selector: string): Promise<number> {
    return this.countBySelector.get(selector) ?? 0;
  }

  async getNetworkRequests(filter?: NetworkFilter): Promise<NetworkEntry[]> {
    return this.networkLog.filter((e) => matchesNetworkFilter(e, filter));
  }
  async clearNetworkLog(): Promise<void> {
    this.networkLog = [];
  }

  async getConsole(): Promise<ConsoleEntry[]> {
    return [...this.consoleLog];
  }
  async clearConsole(): Promise<void> {
    this.consoleLog = [];
  }
  async getErrors(): Promise<ConsoleEntry[]> {
    return this.consoleLog.filter((e) => e.type === "error");
  }

  /** Viewport sizes applied via setViewport, for test assertions. */
  public readonly viewportLog: Array<{ width: number; height: number }> = [];
  async setViewport(width: number, height: number): Promise<void> {
    this.viewportLog.push({ width, height });
  }

  async request(req: BackendRequest): Promise<BackendResponse> {
    this.lastRequest = req;
    this.requestLog.push(req);
    const raw = this.scriptQueue.shift() ?? {
      status: 200,
      ok: true,
      headers: {},
      body: { ok: true },
    };
    if (
      raw &&
      typeof raw === "object" &&
      typeof (raw as Record<string, unknown>)["requestError"] === "string"
    ) {
      const error = String((raw as Record<string, unknown>)["requestError"]);
      this.networkLog.push({
        url: req.url,
        method: req.method,
        status: 0,
        resourceType: "fetch",
        source: "cairntrace.request",
        error,
      });
      return { ok: false, status: 0, headers: {}, body: null, error };
    }
    const envelope =
      raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
    const status =
      typeof envelope["status"] === "number" ? envelope["status"] : 200;
    const headers =
      envelope["headers"] && typeof envelope["headers"] === "object"
        ? (envelope["headers"] as Record<string, string>)
        : {};
    const body = "body" in envelope ? envelope["body"] : raw;
    this.networkLog.push({
      url: req.url,
      method: req.method,
      status,
      resourceType: "fetch",
      source: "cairntrace.request",
    });
    return { ok: true, status, headers, body };
  }

  async evaluate(
    _js: string,
    _opts: { timeoutMs?: number } = {},
  ): Promise<InvocationResult> {
    this.lastEvaluatedScript = _js;
    this.lastEvaluateOptions = _opts;
    if (this.scriptQueue.length === 0 && _js.includes("expectedTextExcerpts")) {
      return {
        ok: true,
        stdout: JSON.stringify({
          url: this.url,
          title: this.title,
          expectedTextExcerpts: [{ needle: "Submit", found: false }],
        }),
        stderr: "",
        exitCode: 0,
        durationMs: 0,
        argv: ["eval"],
      };
    }
    const r = this.scriptQueue.shift() ?? { ok: true, evidence: null };
    return {
      ok: true,
      stdout: JSON.stringify(r),
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      argv: ["eval"],
    };
  }

  async saveState(_path: string): Promise<InvocationResult> {
    return success();
  }
  async loadState(_path: string): Promise<InvocationResult> {
    return success();
  }
  /** Counter tests can assert against. */
  public clearBrowserStateCalls = 0;
  async clearBrowserState(): Promise<void> {
    this.clearBrowserStateCalls++;
  }
  async close(): Promise<InvocationResult> {
    return success();
  }
}

/* ----- helpers ----- */

function success(): InvocationResult {
  return {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 1,
    argv: [],
  };
}

function failure(message: string): InvocationResult {
  return {
    ok: false,
    stdout: "",
    stderr: message,
    exitCode: 1,
    durationMs: 1,
    argv: [],
  };
}

function matchesNetworkFilter(
  e: NetworkEntry,
  f: NetworkFilter | undefined,
): boolean {
  if (!f) return true;
  if (f.method && e.method !== f.method) return false;
  if (f.filter && !e.url.includes(f.filter)) return false;
  if (f.type && e.resourceType !== f.type) return false;
  if (f.status) {
    if (e.status === undefined) return false;
    if (!matchesStatusFilter(e.status, f.status)) return false;
  }
  return true;
}

function matchesStatusFilter(status: number, filter: string): boolean {
  // accept exact (200), comma-separated (200,201), or range pattern (4xx, 5xx)
  if (filter.includes(",")) {
    return filter
      .split(",")
      .map((s) => s.trim())
      .some((s) => matchesStatusFilter(status, s));
  }
  if (/^\dxx$/.test(filter)) {
    const hundred = Number(filter[0]) * 100;
    return status >= hundred && status < hundred + 100;
  }
  const n = Number(filter);
  return Number.isFinite(n) ? status === n : false;
}

/** Minimal 1×1 transparent PNG. */
const MOCK_PNG = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
  0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06,
  0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44,
  0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00, 0x05, 0x00, 0x01, 0x0d,
  0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42,
  0x60, 0x82,
]);

const MOCK_DOWNLOAD = new Uint8Array([
  0x6d, 0x6f, 0x63, 0x6b, 0x20, 0x64, 0x6f, 0x77, 0x6e, 0x6c, 0x6f, 0x61, 0x64,
  0x0a,
]);
