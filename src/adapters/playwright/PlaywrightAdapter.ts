import { chromium } from "playwright";
import type {
  Browser,
  BrowserContext,
  ConsoleMessage,
  Locator as PlaywrightLocator,
  Page,
  Request,
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
      } else if ("hover" in step) {
        await this.resolveLocator(step.hover).hover({
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
      } else if ("download" in step) {
        const { saveAs, assign: _assign, timeoutMs, ...loc } = step.download;
        const timeout = timeoutMs ?? this.opts.defaultTimeoutMs ?? 30_000;
        const downloadPromise = page.waitForEvent("download", { timeout });
        await this.resolveLocator(loc as Locator).click({ timeout });
        const download = await downloadPromise;
        await download.saveAs(saveAs);
      } else if ("wait" in step) {
        await this.applyWait(page, step.wait);
      } else if ("snapshot" in step) {
        // Snapshot is captured by the Runner via .snapshot() — no-op here.
      } else if ("transform" in step) {
        throw new Error(
          "transform steps are handled by the runner before adapter dispatch",
        );
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
      this.context = await this.browser!.newContext({
        storageState: path,
        acceptDownloads: true,
      });
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
      this.context = await this.browser!.newContext({
        ...(this.opts.initialStatePath
          ? { storageState: this.opts.initialStatePath }
          : {}),
        acceptDownloads: true,
      });
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
      this.context = await this.browser!.newContext({
        ...(this.opts.initialStatePath
          ? { storageState: this.opts.initialStatePath }
          : {}),
        acceptDownloads: true,
      });
    }
    this.page = await this.context.newPage();
    this.attachListeners(this.page);
    return this.page;
  }

  /** Map a behavioral Locator to a Playwright Locator. */
  resolveLocator(loc: Locator): PlaywrightLocator {
    if (!this.page) throw new Error("page not yet initialized");
    const nth = (l: PlaywrightLocator): PlaywrightLocator =>
      "nth" in loc && loc.nth !== undefined ? l.nth(loc.nth) : l;
    switch (loc.by) {
      case "role": {
        const role = loc.role as Parameters<Page["getByRole"]>[0];
        if (loc.name === undefined) return nth(this.page.getByRole(role));
        if (loc.exact)
          return nth(
            this.page.getByRole(role, { name: loc.name, exact: true }),
          );
        return nth(
          this.page.getByRole(role, { name: wholeNameRegex(loc.name) }),
        );
      }
      case "label":
        return nth(
          loc.exact
            ? this.page.getByLabel(loc.name, { exact: true })
            : this.page.getByLabel(wholeNameRegex(loc.name)),
        );
      case "text":
        return nth(
          loc.exact
            ? this.page.getByText(loc.text, { exact: true })
            : this.page.getByText(wholeNameRegex(loc.text)),
        );
      case "selector":
        return this.page.locator(loc.selector);
    }
  }

  private attachListeners(page: Page): void {
    page.on("request", (req: Request) => {
      const entry: NetworkEntry = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        startedAt: new Date().toISOString(),
      };
      this.networkLog.push(entry);
      // Pair *this* request with *its* response asynchronously. Previously we
      // matched response→request by URL, which stamped the wrong status on the
      // wrong entry whenever the same URL was hit more than once (login form
      // retries, polling, identical asset URLs).
      req
        .response()
        .then((res) => {
          if (res) entry.status = res.status();
        })
        .catch(() => {
          // Request was aborted / failed before a response — leave status undefined.
        });
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

/**
 * Cairntrace semantic-name semantics: whole-name, case-insensitive by
 * default; `exact: true` is case-sensitive whole-name. Playwright's bare
 * string matching is case-insensitive SUBSTRING, which diverges from the
 * agent-browser backend's strict whole-name resolution — an anchored
 * case-insensitive regex keeps the two backends agreeing on what matches.
 */
function wholeNameRegex(name: string): RegExp {
  return new RegExp(`^${escapeRegExp(name.replace(/\s+/g, " ").trim())}$`, "i");
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

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
