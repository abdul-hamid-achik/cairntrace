import { chromium } from "playwright";
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Locator as PlaywrightLocator,
  Page,
  Request,
  Response,
} from "playwright";
import type { Locator, Step, WaitCondition } from "../../core/schema/spec.v1";
import type {
  BrowserBackend,
  ConsoleEntry,
  InvocationResult,
  NetworkEntry,
  NetworkFilter,
  ScreenshotResult,
  SnapshotResult,
} from "../browserBackend";

export interface PlaywrightAdapterOptions {
  /** Show the browser window (Chromium headed mode). */
  headed?: boolean;
  /** Default per-step timeout (ms). */
  defaultTimeoutMs?: number;
  /** Path to a storage-state JSON to seed the initial context. */
  initialStatePath?: string;
}

/**
 * Playwright BrowserBackend.
 *
 * Single-context, single-page model. Network and console events are buffered
 * into in-memory logs that mirror the AgentBrowserAdapter's contract so the
 * outcome verifiers don't care which backend is running.
 *
 * Lazy: the browser launches on the first operation. `loadState` rebuilds the
 * context so `session.resume` can swap storage between Runner phases.
 */
export class PlaywrightAdapter implements BrowserBackend {
  readonly name = "playwright" as const;

  private browser: Browser | undefined;
  private context: BrowserContext | undefined;
  private page: Page | undefined;
  private networkLog: NetworkEntry[] = [];
  private consoleLog: ConsoleEntry[] = [];
  /** Resets to a fresh number per request so we can match request → response. */
  private requestSeq = 0;
  private requestById = new Map<string, NetworkEntry>();

  constructor(private readonly opts: PlaywrightAdapterOptions = {}) {}

  /* ----- BrowserBackend impl ----- */

  async runStep(step: Step): Promise<InvocationResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    try {
      if ("open" in step) {
        await page.goto(step.open, { timeout: this.opts.defaultTimeoutMs });
      } else if ("click" in step) {
        await this.resolveLocator(step.click).click({
          timeout: this.opts.defaultTimeoutMs,
        });
      } else if ("fill" in step) {
        const { value, ...loc } = step.fill;
        await this.resolveLocator(loc as Locator).fill(value, {
          timeout: this.opts.defaultTimeoutMs,
        });
      } else if ("upload" in step) {
        const { path, ...loc } = step.upload;
        await this.resolveLocator(loc as Locator).setInputFiles(path, {
          timeout: this.opts.defaultTimeoutMs,
        });
      } else if ("wait" in step) {
        await this.applyWait(page, step.wait);
      } else if ("snapshot" in step) {
        // Snapshot is captured by the Runner via .snapshot() — no-op here.
      } else if ("use" in step) {
        throw new Error(
          `'use: ${step.use}' must be expanded by the runner before adapter dispatch`,
        );
      }
      return success(Date.now() - start);
    } catch (e) {
      return failure((e as Error).message, Date.now() - start);
    }
  }

  async snapshot(): Promise<SnapshotResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    try {
      // Playwright's ariaSnapshot returns text in essentially the same format
      // as agent-browser's `snapshot`, so the heal snapshotParser reads either.
      const text = await page.locator("html").ariaSnapshot();
      return { ok: true, text, durationMs: Date.now() - start };
    } catch (e) {
      return {
        ok: false,
        text: `<snapshot failed: ${(e as Error).message}>`,
        durationMs: Date.now() - start,
      };
    }
  }

  async screenshot(opts: {
    path: string;
    fullPage?: boolean;
  }): Promise<ScreenshotResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    try {
      await page.screenshot({
        path: opts.path,
        fullPage: opts.fullPage ?? false,
      });
      return { ok: true, path: opts.path, durationMs: Date.now() - start };
    } catch {
      return { ok: false, path: opts.path, durationMs: Date.now() - start };
    }
  }

  async getUrl(): Promise<string> {
    const page = await this.ensurePage();
    return page.url();
  }

  async getTitle(): Promise<string> {
    const page = await this.ensurePage();
    return page.title();
  }

  async getText(selector: string): Promise<string> {
    const page = await this.ensurePage();
    // Cairntrace's `text` verifier passes the sentinel "page" for whole-body text.
    const target = selector === "page" ? "body" : selector;
    try {
      return await page.locator(target).innerText({
        timeout: this.opts.defaultTimeoutMs,
      });
    } catch {
      return "";
    }
  }

  async getCount(selector: string): Promise<number> {
    const page = await this.ensurePage();
    try {
      return await page.locator(selector).count();
    } catch {
      return 0;
    }
  }

  async getNetworkRequests(filter?: NetworkFilter): Promise<NetworkEntry[]> {
    return this.networkLog.filter((e) => matchesNetworkFilter(e, filter));
  }

  async clearNetworkLog(): Promise<void> {
    this.networkLog = [];
    this.requestById.clear();
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

  async evaluate(js: string): Promise<InvocationResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    try {
      // The script verifier passes a complete expression like `(function(){...})()`.
      // Playwright's evaluate treats a string as an expression to eval in the
      // page; passing it through unwrapped preserves the IIFE's return value.
      const result = await page.evaluate(js);
      // JSON.stringify(undefined) returns undefined (the value), so guard.
      const stdout = result === undefined ? "null" : JSON.stringify(result);
      return {
        ok: true,
        stdout,
        stderr: "",
        exitCode: 0,
        durationMs: Date.now() - start,
        argv: ["eval"],
      };
    } catch (e) {
      return failure((e as Error).message, Date.now() - start);
    }
  }

  async saveState(path: string): Promise<InvocationResult> {
    const start = Date.now();
    await this.ensurePage();
    try {
      await this.context!.storageState({ path });
      return success(Date.now() - start);
    } catch (e) {
      return failure((e as Error).message, Date.now() - start);
    }
  }

  /**
   * Rebuild the context with the given storage state file. Playwright doesn't
   * allow setting storage on an existing context — has to be a fresh one.
   */
  async loadState(path: string): Promise<InvocationResult> {
    const start = Date.now();
    try {
      // Make sure the browser is up; only the context+page change.
      await this.ensureBrowser();
      if (this.context) {
        await this.context.close();
      }
      this.context = await this.browser!.newContext({ storageState: path });
      this.page = await this.context.newPage();
      this.attachListeners(this.page);
      return success(Date.now() - start);
    } catch (e) {
      return failure((e as Error).message, Date.now() - start);
    }
  }

  async clearBrowserState(): Promise<void> {
    await this.ensurePage();
    if (this.context) {
      try {
        await this.context.clearCookies();
      } catch {
        // best-effort
      }
    }
    if (this.page) {
      try {
        // String form sidesteps needing the DOM lib in tsc; runs in page context.
        await this.page.evaluate(
          `try{localStorage.clear()}catch(_){};try{sessionStorage.clear()}catch(_){}`,
        );
      } catch {
        // ignore (page may be on about:blank or cross-origin)
      }
    }
  }

  async startTrace(): Promise<void> {
    await this.ensureBrowser();
    if (!this.context) {
      this.context = await this.browser!.newContext(
        this.opts.initialStatePath
          ? { storageState: this.opts.initialStatePath }
          : {},
      );
    }
    try {
      await this.context.tracing.start({
        screenshots: true,
        snapshots: true,
        sources: true,
      });
    } catch {
      // tracing.start can throw if already started; ignore
    }
  }

  async stopTrace(path: string): Promise<{ ok: boolean; path: string }> {
    if (!this.context) return { ok: false, path };
    try {
      await this.context.tracing.stop({ path });
      return { ok: true, path };
    } catch {
      return { ok: false, path };
    }
  }

  async close(): Promise<InvocationResult> {
    const start = Date.now();
    try {
      if (this.browser) {
        await this.browser.close();
        this.browser = undefined;
        this.context = undefined;
        this.page = undefined;
      }
      return success(Date.now() - start);
    } catch (e) {
      return failure((e as Error).message, Date.now() - start);
    }
  }

  /* ----- internals ----- */

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    this.browser = await chromium.launch({ headless: !this.opts.headed });
    return this.browser;
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    await this.ensureBrowser();
    if (!this.context) {
      this.context = await this.browser!.newContext(
        this.opts.initialStatePath
          ? { storageState: this.opts.initialStatePath }
          : {},
      );
    }
    this.page = await this.context.newPage();
    this.attachListeners(this.page);
    return this.page;
  }

  /** Map a behavioral Locator to a Playwright Locator. */
  resolveLocator(loc: Locator): PlaywrightLocator {
    if (!this.page) throw new Error("page not yet initialized");
    switch (loc.by) {
      case "role":
        return this.page.getByRole(
          loc.role as Parameters<Page["getByRole"]>[0],
          loc.name ? { name: loc.name } : undefined,
        );
      case "label":
        return this.page.getByLabel(loc.name);
      case "text":
        return this.page.getByText(loc.text);
      case "selector":
        return this.page.locator(loc.selector);
    }
  }

  private attachListeners(page: Page): void {
    page.on("request", (req: Request) => {
      const id = `r${++this.requestSeq}`;
      const entry: NetworkEntry = {
        id,
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        startedAt: new Date().toISOString(),
      };
      this.requestById.set(id, entry);
      this.networkLog.push(entry);
    });
    page.on("response", (res: Response) => {
      const url = res.url();
      // Match newest request with this URL that doesn't have a status yet.
      const pending = [...this.networkLog]
        .toReversed()
        .find((e) => e.url === url && e.status === undefined);
      if (pending) {
        pending.status = res.status();
      }
    });
    page.on("console", (msg: ConsoleMessage) => {
      const type = msg.type();
      this.consoleLog.push({
        type: mapConsoleType(type),
        text: msg.text(),
      });
    });
    page.on("pageerror", (err) => {
      this.consoleLog.push({
        type: "error",
        text: err.message,
        stack: err.stack,
      });
    });
  }

  private async applyWait(page: Page, cond: WaitCondition): Promise<void> {
    const timeout = cond.timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
    if ("text" in cond) {
      // String form sidesteps needing the DOM lib for tsc.
      await page.waitForFunction(
        `document.body.innerText.includes(${JSON.stringify(cond.text)})`,
        undefined,
        { timeout },
      );
    } else if ("notText" in cond) {
      await page.waitForFunction(
        `!document.body.innerText.includes(${JSON.stringify(cond.notText)})`,
        undefined,
        { timeout },
      );
    } else {
      await page.waitForLoadState(cond.load, { timeout });
    }
  }
}

/* ----- helpers ----- */

function mapConsoleType(t: string): ConsoleEntry["type"] {
  if (t === "error" || t === "warning" || t === "info" || t === "debug")
    return t === "warning" ? "warn" : (t as ConsoleEntry["type"]);
  return "log";
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

function success(durationMs: number): InvocationResult {
  return {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs,
    argv: [],
  };
}

function failure(message: string, durationMs: number): InvocationResult {
  return {
    ok: false,
    stdout: "",
    stderr: message,
    exitCode: 1,
    durationMs,
    argv: [],
  };
}
