import type { Step } from "../core/schema/spec.v1";

/**
 * Generic browser-backend interface. Implemented by AgentBrowserAdapter and
 * MockBrowserBackend. The Runner and OutcomeEvaluator depend on this interface
 * only — not on any specific backend — so backends are swappable.
 */

/**
 * The element an interactive step actually acted on, captured from the
 * accessibility snapshot at resolution time. Step-level evidence: issues 1–3
 * of the liftclub dogfood report were diagnosable only by manual CLI
 * bisection because runs never recorded what a click really hit.
 */
export interface ResolvedElement {
  role: string;
  name?: string;
  ref?: string;
}

export interface InvocationResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
  argv: string[];
  /** Present when the backend resolved a semantic locator before acting. */
  resolvedElement?: ResolvedElement;
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

export interface BackendRequest {
  method: string;
  /** Absolute URL. The runner resolves spec-relative URLs before dispatch. */
  url: string;
  headers?: Record<string, string>;
  /** Objects are JSON-encoded by capable backends; strings are sent raw. */
  body?: unknown;
  /** Hard request deadline in milliseconds. */
  timeoutMs?: number;
}

export interface BackendResponse {
  /** Transport success: true when a response was received, regardless of HTTP status. */
  ok: boolean;
  status: number;
  headers: Record<string, string>;
  body: unknown;
  error?: string;
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
  kind: "download" | "transform" | "request";
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

  /* ----- viewport ----- */
  /**
   * Resize the browser viewport. Optional: backends without window control
   * may omit it; the Runner applies it best-effort at run start.
   */
  setViewport?(width: number, height: number): Promise<void>;

  /* ----- HTTP request escape hatch ----- */
  /**
   * Execute an HTTP request outside the page while sharing the browser
   * context's cookies when the backend supports it. Backends without a native
   * request primitive omit this and the runner uses a bounded evaluate fallback.
   */
  request?(req: BackendRequest): Promise<BackendResponse>;

  /* ----- script escape hatch ----- */
  evaluate(
    js: string,
    opts?: { timeoutMs?: number },
  ): Promise<InvocationResult>;

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

  /**
   * Forceful teardown for signal-time cleanup (SIGINT/SIGTERM). Must be
   * fully SYNCHRONOUS: with an in-flight execa child, signal-exit re-raises
   * the signal as soon as the handler's synchronous portion returns, so any
   * async continuation silently never runs. Unlike `close()`, this must not
   * queue behind in-flight backend work — kill owned processes directly.
   * Optional: backends without owned processes can omit it.
   */
  terminateSync?(): void;
}
