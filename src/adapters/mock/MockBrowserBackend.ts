import { writeFile } from "node:fs/promises";
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
  private scriptQueue: ScriptInvocationResult[] = [];
  private stepShouldFail = false;
  private stepFailureMessage = "mock step failure";
  /** Recorded steps for assertions in tests. */
  public readonly stepLog: Step[] = [];

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
  failNextStep(message = "mock step failure"): void {
    this.stepShouldFail = true;
    this.stepFailureMessage = message;
  }

  /* ----- BrowserBackend impl ----- */

  async runStep(step: Step): Promise<InvocationResult> {
    this.stepLog.push(step);
    if ("open" in step) this.url = step.open;
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

  async evaluate(_js: string): Promise<InvocationResult> {
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
