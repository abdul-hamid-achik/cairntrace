import type { Step } from "../core/schema/spec.v1";

/**
 * Generic browser-backend interface. Implemented by AgentBrowserAdapter and
 * MockBrowserBackend. The Runner and OutcomeEvaluator depend on this interface
 * only — not on any specific backend — so backends are swappable.
 */

export interface InvocationResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  argv: string[];
}

export interface SnapshotResult {
  ok: boolean;
  text: string;
  durationMs: number;
}

export interface ScreenshotResult {
  ok: boolean;
  path: string;
  durationMs: number;
}

export interface NetworkEntry {
  id?: string;
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  durationMs?: number;
  startedAt?: string;
  [extra: string]: unknown;
}

export interface ConsoleEntry {
  type: "log" | "warn" | "error" | "info" | "debug";
  text: string;
  stack?: string;
  timestamp?: string;
  location?: { url: string; line?: number; column?: number };
  [extra: string]: unknown;
}

export interface ArtifactRef {
  /** Absolute path on disk. */
  path: string;
  /** Path relative to the run directory. */
  relativePath: string;
  kind: "download";
}

export interface NetworkFilter {
  method?: string;
  /** Single (200), range (4xx), or comma-separated (200,201). Backend-parsed. */
  status?: string;
  type?: string;
  filter?: string;
}

export interface BrowserBackend {
  readonly name: string;

  /** Dispatch a behavioral step to the backend. */
  runStep(step: Step): Promise<InvocationResult>;

  /** Capture the accessibility tree (compact text). */
  snapshot(opts?: { interactive?: boolean }): Promise<SnapshotResult>;

  /** Save a screenshot to `path` (absolute, or relative to backend's screenshot dir). */
  screenshot(opts: {
    path: string;
    fullPage?: boolean;
    annotate?: boolean;
    format?: "png" | "jpeg";
    quality?: number;
  }): Promise<ScreenshotResult>;

  /* ----- page info (used by outcome verifiers) ----- */
  getUrl(): Promise<string>;
  getTitle(): Promise<string>;
  getText(selector: string): Promise<string>;
  getCount(selector: string): Promise<number>;

  /* ----- network ----- */
  getNetworkRequests(filter?: NetworkFilter): Promise<NetworkEntry[]>;
  clearNetworkLog(): Promise<void>;

  /* ----- console ----- */
  getConsole(): Promise<ConsoleEntry[]>;
  clearConsole(): Promise<void>;
  /**
   * Return the union of:
   *   - page-level uncaught exceptions (Playwright's `pageerror`, agent-browser's `errors`)
   *   - console messages with type === "error"
   *
   * Both backends must agree on this set so the `console.errorsMax` verifier
   * is portable. Backends that can only surface one of the two sources should
   * say so explicitly in their docs.
   */
  getErrors(): Promise<ConsoleEntry[]>;

  /* ----- script escape hatch ----- */
  evaluate(js: string): Promise<InvocationResult>;

  /* ----- state / checkpoints ----- */
  saveState(path: string): Promise<InvocationResult>;
  loadState(path: string): Promise<InvocationResult>;

  /* ----- cold-start (§10.6) ----- */
  /**
   * Wipe cookies + localStorage + sessionStorage so the spec runs from a clean
   * browser. Called by the Runner at the start of a run when `coldStart: true`.
   */
  clearBrowserState(): Promise<void>;

  /* ----- tracing ----- */
  /**
   * Begin recording a trace of the run. Best-effort: backends without trace
   * support no-op. Playwright writes a Trace Viewer-compatible .zip;
   * agent-browser's trace also produces a .zip.
   */
  startTrace?(): Promise<void>;
  /**
   * Stop recording and save the trace to `path`. Returns whether the save
   * succeeded so the runner can decide whether to record the artifact path.
   */
  stopTrace?(path: string): Promise<{ ok: boolean; path: string }>;

  /* ----- lifecycle ----- */
  close(): Promise<InvocationResult>;
}
