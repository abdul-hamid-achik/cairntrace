import { chromium } from "playwright";
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  ConsoleMessage,
  Locator as PlaywrightLocator,
  Page,
  Request,
} from "playwright";
import type {
  BatchSubStep,
  Locator,
  Step,
  WaitCondition,
} from "../../core/schema/spec.v1";
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

export interface PlaywrightAdapterOptions {
  /** Show the browser window (Chromium headed mode). */
  headed?: boolean;
  /** Default per-step timeout (ms). */
  defaultTimeoutMs?: number;
  /** Path to a storage-state JSON to seed the initial context. */
  initialStatePath?: string;
  /**
   * Internal/test override. Bun exposes a relative IncomingMessage.url to
   * Playwright's APIRequestContext Set-Cookie parser, so the default uses a
   * cookie bridge under Bun and APIRequestContext elsewhere.
   */
  requestMode?: "api" | "cookie-bridge";
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
  /** Sticky viewport — re-applied when loadState rebuilds the page. */
  private viewport: { width: number; height: number } | undefined;

  constructor(private readonly opts: PlaywrightAdapterOptions = {}) {}

  /* ----- BrowserBackend impl ----- */

  async runStep(step: Step): Promise<InvocationResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    try {
      if ("open" in step) {
        if (typeof step.open === "string") {
          await page.goto(step.open, { timeout: this.opts.defaultTimeoutMs });
        } else {
          await page.goto(step.open.path, {
            waitUntil: step.open.waitUntil,
            timeout: step.open.timeoutMs ?? this.opts.defaultTimeoutMs,
          });
        }
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
      } else if ("press" in step) {
        await page.keyboard.press(step.press);
      } else if ("scroll" in step) {
        if ("to" in step.scroll) {
          await this.resolveLocator(step.scroll.to).scrollIntoViewIfNeeded({
            timeout: this.opts.defaultTimeoutMs,
          });
        } else {
          const px = step.scroll.px ?? DEFAULT_SCROLL_PX;
          const { direction } = step.scroll;
          const dx =
            direction === "left" ? -px : direction === "right" ? px : 0;
          const dy = direction === "up" ? -px : direction === "down" ? px : 0;
          await page.mouse.wheel(dx, dy);
        }
      } else if ("batch" in step) {
        // Same browser context — interactions run in-process, so hover/focus
        // state already persists across the chain. Run them in order; --bail
        // parity means the first throw fails the step.
        for (const sub of step.batch) {
          await this.runBatchSubStep(page, sub);
        }
      } else if ("snapshot" in step) {
        // Snapshot is captured by the Runner via .snapshot() — no-op here.
      } else if ("transform" in step) {
        throw new Error(
          "transform steps are handled by the runner before adapter dispatch",
        );
      } else if ("request" in step) {
        throw new Error(
          "request steps are handled by the runner before adapter dispatch",
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

  async setViewport(width: number, height: number): Promise<void> {
    this.viewport = { width, height };
    if (this.page) {
      await this.page.setViewportSize(this.viewport);
    }
  }

  async evaluate(
    js: string,
    opts: { timeoutMs?: number } = {},
  ): Promise<InvocationResult> {
    const start = Date.now();
    const page = await this.ensurePage();
    const timeoutMs = opts.timeoutMs ?? this.evaluateTimeoutMs();
    try {
      // The script verifier passes a complete expression like `(function(){...})()`.
      // Playwright's evaluate treats a string as an expression to eval in the
      // page; passing it through unwrapped preserves the IIFE's return value.
      const result = await withTimeout(
        page.evaluate(js),
        timeoutMs,
        `evaluate timed out after ${timeoutMs}ms`,
      );
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
      if (e instanceof TimeoutError) {
        return {
          ok: false,
          stdout: "",
          stderr: e.message,
          exitCode: 124,
          durationMs: Date.now() - start,
          argv: ["eval"],
        };
      }
      return failure((e as Error).message, Date.now() - start);
    }
  }

  async request(req: BackendRequest): Promise<BackendResponse> {
    const start = Date.now();
    const context = await this.ensureContext();
    const timeoutMs = req.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    try {
      const response = await withTimeout(
        this.fetchRequest(context, req, timeoutMs),
        timeoutMs,
        `request timed out after ${timeoutMs}ms`,
      );
      this.recordSyntheticRequest(req, {
        status: response.status,
        durationMs: Date.now() - start,
      });
      return response;
    } catch (e) {
      const message = (e as Error).message;
      this.recordSyntheticRequest(req, {
        status: 0,
        durationMs: Date.now() - start,
        error: message,
      });
      return {
        ok: false,
        status: 0,
        headers: {},
        body: null,
        error: message,
      };
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
        ...(this.viewport ? { viewport: this.viewport } : {}),
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

  private async ensureContext(): Promise<BrowserContext> {
    if (this.context) return this.context;
    await this.ensureBrowser();
    this.context = await this.browser!.newContext({
      ...(this.opts.initialStatePath
        ? { storageState: this.opts.initialStatePath }
        : {}),
      acceptDownloads: true,
      ...(this.viewport ? { viewport: this.viewport } : {}),
    });
    return this.context;
  }

  private async fetchRequest(
    context: BrowserContext,
    req: BackendRequest,
    timeoutMs: number,
  ): Promise<BackendResponse> {
    if (this.useCookieBridge()) {
      return this.fetchRequestWithCookieBridge(context, req, timeoutMs);
    }
    return this.fetchRequestWithApiContext(context, req, timeoutMs);
  }

  private async fetchRequestWithApiContext(
    context: BrowserContext,
    req: BackendRequest,
    timeoutMs: number,
  ): Promise<BackendResponse> {
    const fetchOptions: NonNullable<Parameters<APIRequestContext["fetch"]>[1]> =
      {
        method: req.method,
        headers: req.headers,
        timeout: timeoutMs,
        failOnStatusCode: false,
        maxRedirects: 20,
      };
    if (req.body !== undefined) {
      fetchOptions.data = req.body as typeof fetchOptions.data;
    }

    const response = await context.request.fetch(req.url, fetchOptions);
    const text = await response.text();
    return {
      ok: true,
      status: response.status(),
      headers: response.headers(),
      body: parseResponseBody(text),
    };
  }

  private async fetchRequestWithCookieBridge(
    context: BrowserContext,
    req: BackendRequest,
    timeoutMs: number,
  ): Promise<BackendResponse> {
    const headers = new Headers(req.headers ?? {});
    if (!headers.has("cookie")) {
      const cookieHeader = serializeCookies(await context.cookies(req.url));
      if (cookieHeader) headers.set("cookie", cookieHeader);
    }
    const body = encodeRequestBody(req.body, headers);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(req.url, {
        method: req.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "follow",
        signal: controller.signal,
      });
      const text = await response.text();
      const cookies = parseSetCookieHeaders(
        getSetCookieHeaders(response.headers),
        response.url || req.url,
      );
      if (cookies.length > 0) {
        await context.addCookies(cookies);
      }
      return {
        ok: true,
        status: response.status,
        headers: headersToRecord(response.headers),
        body: parseResponseBody(text),
      };
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        throw new TimeoutError(`request timed out after ${timeoutMs}ms`);
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  private useCookieBridge(): boolean {
    if (this.opts.requestMode) return this.opts.requestMode === "cookie-bridge";
    return Boolean(process.versions.bun);
  }

  private async ensurePage(): Promise<Page> {
    if (this.page) return this.page;
    const context = await this.ensureContext();
    this.page = await context.newPage();
    if (this.viewport) {
      await this.page.setViewportSize(this.viewport);
    }
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

  /** Run one selector-only `batch` sub-step in the live page context. */
  private async runBatchSubStep(page: Page, sub: BatchSubStep): Promise<void> {
    const timeout = this.opts.defaultTimeoutMs;
    if ("click" in sub) {
      await this.resolveLocator(sub.click).click({ timeout });
    } else if ("hover" in sub) {
      await this.resolveLocator(sub.hover).hover({ timeout });
    } else if ("fill" in sub) {
      const { value, ...loc } = sub.fill;
      await this.resolveLocator(loc as Locator).fill(value, { timeout });
    } else if ("upload" in sub) {
      const { path, ...loc } = sub.upload;
      await this.resolveLocator(loc as Locator).setInputFiles(path, {
        timeout,
      });
    } else if ("press" in sub) {
      await page.keyboard.press(sub.press);
    } else if ("scroll" in sub) {
      if ("to" in sub.scroll) {
        await this.resolveLocator(sub.scroll.to).scrollIntoViewIfNeeded({
          timeout,
        });
      } else {
        const px = sub.scroll.px ?? DEFAULT_SCROLL_PX;
        const { direction } = sub.scroll;
        const dx = direction === "left" ? -px : direction === "right" ? px : 0;
        const dy = direction === "up" ? -px : direction === "down" ? px : 0;
        await page.mouse.wheel(dx, dy);
      }
    } else if ("wait" in sub) {
      await this.applyWait(page, sub.wait);
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

  private recordSyntheticRequest(
    req: BackendRequest,
    result: { status: number; durationMs: number; error?: string },
  ): void {
    this.networkLog.push({
      id: `request-step-${this.networkLog.length + 1}`,
      url: req.url,
      method: req.method,
      status: result.status,
      resourceType: "fetch",
      startedAt: new Date().toISOString(),
      durationMs: result.durationMs,
      source: "cairntrace.request",
      ...(result.error ? { error: result.error } : {}),
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

  private evaluateTimeoutMs(): number {
    return Math.max(
      this.opts.defaultTimeoutMs ?? 0,
      DEFAULT_EVALUATE_TIMEOUT_MS,
    );
  }
}

/* ----- helpers ----- */

/** Matches agent-browser's default `scroll <dir>` distance closely enough. */
const DEFAULT_SCROLL_PX = 400;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EVALUATE_TIMEOUT_MS = 30_000;

class TimeoutError extends Error {}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  message: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(message)), timeoutMs);
    }),
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

function parseResponseBody(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

type ContextCookie = Awaited<ReturnType<BrowserContext["cookies"]>>[number];
type CookieToAdd = Parameters<BrowserContext["addCookies"]>[0][number];

function serializeCookies(cookies: ContextCookie[]): string {
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

function encodeRequestBody(
  body: unknown,
  headers: Headers,
): string | Uint8Array | undefined {
  if (body === undefined) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return JSON.stringify(body);
}

function headersToRecord(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function getSetCookieHeaders(headers: Headers): string[] {
  const extended = headers as Headers & {
    getSetCookie?: () => string[];
    raw?: () => Record<string, string[]>;
  };
  if (typeof extended.getSetCookie === "function") {
    return extended.getSetCookie();
  }
  const raw = typeof extended.raw === "function" ? extended.raw() : undefined;
  if (raw?.["set-cookie"]) return raw["set-cookie"];
  const single = headers.get("set-cookie");
  return single ? splitSetCookieHeader(single) : [];
}

function splitSetCookieHeader(value: string): string[] {
  const out: string[] = [];
  let start = 0;
  let inExpires = false;
  for (let i = 0; i < value.length; i++) {
    if (value.slice(i, i + 8).toLowerCase() === "expires=") {
      inExpires = true;
      i += 7;
      continue;
    }
    if (inExpires && value[i] === ";") {
      inExpires = false;
      continue;
    }
    if (!inExpires && value[i] === ",") {
      out.push(value.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(value.slice(start).trim());
  return out.filter(Boolean);
}

function parseSetCookieHeaders(
  values: string[],
  responseUrl: string,
): CookieToAdd[] {
  return values
    .map((value) => parseSetCookieHeader(value, responseUrl))
    .filter((cookie): cookie is CookieToAdd => Boolean(cookie));
}

function parseSetCookieHeader(
  header: string,
  responseUrl: string,
): CookieToAdd | undefined {
  const url = new URL(responseUrl);
  const parts = header
    .split(";")
    .map((part) => part.trim())
    .filter(Boolean);
  const [nameValue, ...attrs] = parts;
  if (!nameValue) return undefined;
  const equals = nameValue.indexOf("=");
  if (equals <= 0) return undefined;

  const cookie: CookieToAdd = {
    name: nameValue.slice(0, equals),
    value: nameValue.slice(equals + 1),
    domain: url.hostname,
    path: defaultCookiePath(url.pathname),
  };

  for (const attr of attrs) {
    const attrEquals = attr.indexOf("=");
    const key =
      attrEquals === -1
        ? attr.toLowerCase()
        : attr.slice(0, attrEquals).toLowerCase();
    const value = attrEquals === -1 ? "" : attr.slice(attrEquals + 1);
    if (key === "domain" && value) {
      if (!domainMatches(url.hostname, value)) return undefined;
      cookie.domain = value;
    } else if (key === "path" && value.startsWith("/")) {
      cookie.path = value;
    } else if (key === "expires") {
      const expires = Date.parse(value);
      if (Number.isFinite(expires)) cookie.expires = Math.floor(expires / 1000);
    } else if (key === "max-age") {
      const seconds = Number(value);
      if (Number.isFinite(seconds)) {
        cookie.expires = Math.floor(Date.now() / 1000 + seconds);
      }
    } else if (key === "httponly") {
      cookie.httpOnly = true;
    } else if (key === "secure") {
      cookie.secure = true;
    } else if (key === "samesite") {
      const sameSite = normalizeSameSite(value);
      if (sameSite) cookie.sameSite = sameSite;
    }
  }

  return cookie;
}

function defaultCookiePath(pathname: string): string {
  const lastSlash = pathname.lastIndexOf("/");
  return lastSlash <= 0 ? "/" : pathname.slice(0, lastSlash);
}

function domainMatches(hostname: string, domain: string): boolean {
  const normalized = domain.startsWith(".") ? domain.slice(1) : domain;
  return hostname === normalized || hostname.endsWith(`.${normalized}`);
}

function normalizeSameSite(value: string): CookieToAdd["sameSite"] | undefined {
  const lower = value.toLowerCase();
  if (lower === "strict") return "Strict";
  if (lower === "lax") return "Lax";
  if (lower === "none") return "None";
  return undefined;
}

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
