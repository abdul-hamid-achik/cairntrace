import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";
import { targetChildEnv } from "../../core/processEnv";
import type {
  APIRequestContext,
  Browser,
  BrowserContext,
  ConsoleMessage,
  Locator as PlaywrightLocator,
  Page,
  Request,
  Response,
} from "playwright";
import type {
  BatchSubStep,
  Locator,
  NetworkPostcondition,
  Step,
  WaitCondition,
} from "../../core/schema/spec.v1";
import { clickLocator, withoutPostcondition } from "../../core/schema/spec.v1";
import {
  DEFAULT_NETWORK_POSTCONDITION_TIMEOUT_MS,
  describeNetworkPostcondition,
  matchesStatus,
} from "../../core/networkPostcondition";
import { bodyTextContainsExpression } from "../../core/textMatching";
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
   * subprocess cookie bridge under Bun and APIRequestContext elsewhere.
   */
  requestMode?: RequestMode;
  /**
   * Chromium launch args. Defaults to CI hardening args when CI is truthy;
   * set an explicit empty array to suppress them in tests or local overrides.
   */
  launchArgs?: string[];
  /** Internal/test override for the isolated subprocess fetch program. */
  isolatedFetchScript?: string;
}

type RequestMode = "api" | "cookie-bridge" | "subprocess-cookie-bridge";

/**
 * Keep network evidence useful for request correlation without allowing a
 * single upload/large mutation to grow every run artifact without bound.
 */
const MAX_CAPTURED_POST_DATA_BYTES = 64 * 1024;
const SENSITIVE_POST_DATA_KEY_RE =
  /authorization|cookie|set-cookie|token|secret|password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|code[_-]?verifier|otp|passcode|credential|assertion/i;

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
  /** Set by startVideo() — enables recordVideo on the next context creation. */
  private videoEnabled = false;
  /** Temp directory where Playwright stores the raw .webm before saveAs. */
  private videoTempDir: string | undefined;
  /** Delay (ms) between browser actions during video recording. */
  private videoSlowMo = 0;
  /** Playback speed multiplier for ffmpeg post-processing (1 = original). */
  private videoSpeed = 1;
  /** Sticky when an in-process hard deadline had to abandon a page operation. */
  private pageOperationWedged = false;
  /** Environment-level multiplier for waits and network-idle quiet windows. */
  private waitScale = 1;

  constructor(private readonly opts: PlaywrightAdapterOptions = {}) {}

  /* ----- BrowserBackend impl ----- */

  /**
   * Arm Playwright's response listener before dispatching the action. The
   * action is sent exactly once; callers use this instead of the resilient
   * mutation path when duplicate effects would be unsafe.
   */
  async runStepWithNetworkPostcondition(
    step: Step,
    postcondition: NetworkPostcondition,
  ): Promise<InvocationResult> {
    const startedAt = Date.now();
    const page = await this.ensurePage();
    const timeoutMs =
      postcondition.timeoutMs ?? DEFAULT_NETWORK_POSTCONDITION_TIMEOUT_MS;
    const responsePromise = page.waitForResponse(
      (response) => matchesPostconditionResponse(response, postcondition),
      { timeout: timeoutMs },
    );
    // Mark a rejection as observed immediately: a slow action may outlive the
    // response timeout, but the original promise is still awaited below so the
    // step retains fail-closed semantics.
    void responsePromise.catch(() => undefined);

    const action = await this.runStep(step);
    if (!action.ok) {
      return action;
    }

    try {
      await responsePromise;
      return {
        ...action,
        durationMs: Date.now() - startedAt,
        stdout: `network postcondition matched ${describeNetworkPostcondition(postcondition)}`,
      };
    } catch (error) {
      return {
        ...action,
        ok: false,
        stdout: "",
        stderr: `network postcondition timed out after ${timeoutMs}ms: ${describeNetworkPostcondition(postcondition)} (${(error as Error).message})`,
        exitCode: 1,
        durationMs: Date.now() - startedAt,
      };
    }
  }

  async runStep(step: Step): Promise<InvocationResult> {
    if (step.postcondition?.network) {
      return this.runStepWithNetworkPostcondition(
        withoutPostcondition(step),
        step.postcondition.network,
      );
    }
    const start = Date.now();
    const page = await this.ensurePage();
    try {
      if ("open" in step) {
        if (typeof step.open === "string") {
          await page.goto(step.open, { timeout: this.opts.defaultTimeoutMs });
        } else {
          const timeout = step.open.timeoutMs ?? this.opts.defaultTimeoutMs;
          await page.goto(step.open.path, {
            waitUntil: step.open.waitUntil,
            timeout,
          });
          if (step.open.waitUntil === "networkidle" && this.waitScale > 1) {
            await this.waitForScaledNetworkIdle(
              page,
              timeout ?? DEFAULT_WAIT_TIMEOUT_MS,
            );
          }
        }
      } else if ("click" in step) {
        await this.resolveLocator(clickLocator(step)).click({
          timeout: this.opts.defaultTimeoutMs,
        });
        if (step.settleMs !== undefined && step.settleMs > 0) {
          await this.waitForScaledNetworkIdle(page, step.settleMs);
        }
      } else if ("hover" in step) {
        await this.resolveLocator(step.hover).hover({
          timeout: this.opts.defaultTimeoutMs,
        });
      } else if ("focus" in step) {
        await this.resolveLocator(step.focus).focus({
          timeout: this.opts.defaultTimeoutMs,
        });
      } else if ("fill" in step) {
        // Playwright's fill() already sets date-ish inputs
        // (type=date|time|datetime-local) natively — value assignment plus
        // input/change events, verified live 2026-07-16 — so unlike the
        // agent-browser adapter no special date path is needed here. Keep
        // every fill on this call; rerouting date inputs would lose fill()'s
        // format validation ("Malformed value" on a bad date string).
        const { value, ...loc } = step.fill;
        await this.resolveLocator(loc as Locator).fill(value, {
          timeout: this.opts.defaultTimeoutMs,
        });
      } else if ("select" in step) {
        // selectOption matches strictly by value OR label per the authored
        // key (agent-browser's CLI matches either; specs should author the
        // key they mean so both backends agree).
        const { value, label, ...loc } = step.select;
        await this.resolveLocator(loc as Locator).selectOption(
          value !== undefined ? { value } : { label: label! },
          { timeout: this.opts.defaultTimeoutMs },
        );
      } else if ("type" in step) {
        const { value, delayMs, ...loc } = step.type;
        await this.resolveLocator(loc as Locator).pressSequentially(value, {
          timeout: this.opts.defaultTimeoutMs,
          ...(delayMs !== undefined ? { delay: delayMs } : {}),
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
      } else if ("eval" in step) {
        throw new Error(
          "eval steps are handled by the runner via backend.evaluate before adapter dispatch",
        );
      } else if ("use" in step) {
        throw new Error(
          `'use: ${step.use}' must be expanded by the runner before adapter dispatch`,
        );
      } else {
        // Fail loudly on an unhandled step type rather than reporting a
        // green pass for a step that did nothing.
        throw new Error(
          `unhandled step type: ${JSON.stringify(Object.keys(step as object))}`,
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
      await this.hardBoundPageOperation(
        () =>
          page.screenshot({
            path: opts.path,
            fullPage: opts.fullPage ?? false,
            timeout: SCREENSHOT_TIMEOUT_MS,
          }),
        SCREENSHOT_TIMEOUT_MS,
        screenshotTimeoutMessage(),
      );
      return { ok: true, path: opts.path, durationMs: Date.now() - start };
    } catch (error) {
      const message = (error as Error).message;
      const timedOut = /timed?\s*out|timeout/i.test(message);
      if (timedOut) {
        // Playwright can reject with its own TimeoutError just before the
        // external watchdog marks itself fired. Treat either signal as sticky
        // wedging so Runner never queues diagnostics behind a dead page. Keep
        // any still-live browser ref: close() must be able to tear it down.
        // The watchdog/private-floor branch already reset refs after killing.
        this.pageOperationWedged = true;
      }
      const cause = timedOut
        ? screenshotTimeoutMessage()
        : `screenshot capture failed: ${message}`;
      return {
        ok: false,
        path: opts.path,
        durationMs: Date.now() - start,
        error: cause,
      };
    }
  }

  isWedged(): boolean {
    return this.pageOperationWedged;
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
      const locator = page.locator(target);
      // A region may legitimately match several elements — notText's guard
      // admits count > 1 — but innerText() is strict-mode and throws on 2+,
      // while agent-browser's `get text` silently returns only the first
      // match. Read every match so both backends see the same haystack and an
      // absence assertion can't confirm "absent" over match #1 while the text
      // sits in match #2.
      //
      // allInnerTexts() resolves immediately instead of auto-waiting the way
      // innerText() does, so wait for the first match explicitly: without it a
      // region that simply hasn't hydrated yet would read as empty — the same
      // vacuous pass this method exists to prevent, in a new costume.
      await locator
        .first()
        .waitFor({ state: "attached", timeout: this.opts.defaultTimeoutMs });
      return (await locator.allInnerTexts()).join("\n");
    } catch (e) {
      // Never degrade to "": `notText` reads an empty haystack as "confirmed
      // absent" and `when: notText:…` reads it as satisfied, so a region that
      // merely hydrated too slowly would report a green verdict. A region that
      // exists but holds no text returns "" from innerText without throwing,
      // so only real failures (timeout, detached node, bad selector) land here.
      throw new Error(
        `could not read text from ${JSON.stringify(selector)}: ${
          (e as Error).message
        }`,
        { cause: e },
      );
    }
  }

  async getCount(selector: string): Promise<number> {
    const page = await this.ensurePage();
    try {
      return await page.locator(selector).count();
    } catch (e) {
      // A selector that legitimately matches nothing resolves to 0 without
      // throwing, so anything landing here is malformed or unsupported — never
      // 0, which `count: {equals: 0}` and `atMost` read as a satisfied
      // assertion.
      throw new Error(
        `could not count elements matching ${JSON.stringify(selector)}: ${
          (e as Error).message
        }`,
        { cause: e },
      );
    }
  }

  async getValue(locator: Locator): Promise<string> {
    try {
      return await this.resolveLocator(locator).inputValue({
        timeout: this.opts.defaultTimeoutMs,
      });
    } catch (e) {
      throw new Error(`could not read input value: ${(e as Error).message}`, {
        cause: e,
      });
    }
  }

  async waitForTimeout(timeoutMs: number): Promise<void> {
    const page = await this.ensurePage();
    await page.waitForTimeout(timeoutMs);
  }

  setWaitScale(scale: number): void {
    this.waitScale = scale;
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
      const result = await this.hardBoundPageOperation(
        () => page.evaluate(js),
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
      this.recordSyntheticRequest(req, start, {
        status: response.status,
        durationMs: Date.now() - start,
      });
      return response;
    } catch (e) {
      const message = (e as Error).message;
      this.recordSyntheticRequest(req, start, {
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
        ...(this.videoEnabled && this.videoTempDir
          ? { recordVideo: { dir: this.videoTempDir } }
          : {}),
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

  async startVideo(opts?: { slowMo?: number; speed?: number }): Promise<void> {
    this.videoEnabled = true;
    this.videoSlowMo = opts?.slowMo ?? 0;
    this.videoSpeed = opts?.speed ?? 1;
    // If a context already exists (unlikely at this point — the runner calls
    // startVideo before any step), close it so the next ensureContext()
    // creates one with recordVideo enabled.
    if (this.context) {
      try {
        await this.context.close();
      } catch {
        // best-effort
      }
      this.context = undefined;
      this.page = undefined;
    }
    if (!this.videoTempDir) {
      this.videoTempDir = await mkdtemp(join(tmpdir(), "cairntrace-video-"));
    }
  }

  async stopVideo(path: string): Promise<{ ok: boolean; path: string }> {
    if (!this.page || !this.videoEnabled) return { ok: false, path };
    const video = this.page.video();
    if (!video) return { ok: false, path };

    try {
      // Playwright finalizes native recordings only when the context closes.
      // Runner calls stopVideo after all outcome verifiers have finished with
      // the live page, so closing here is safe and prevents saveAs deadlocks.
      await this.context?.close();
      this.context = undefined;
      this.page = undefined;

      // If speed is 1 (default), save directly — no ffmpeg needed.
      if (this.videoSpeed === 1) {
        await video.saveAs(path);
        return { ok: true, path };
      }
      // Save to a temp file first, then re-encode with ffmpeg for speed.
      const rawPath = join(this.videoTempDir ?? tmpdir(), "raw.webm");
      await video.saveAs(rawPath);
      const reencoded = await this.reencodeVideoSpeed(
        rawPath,
        path,
        this.videoSpeed,
      );
      // Clean up the raw file.
      try {
        await rm(rawPath, { force: true });
      } catch {
        /* best-effort */
      }
      return { ok: reencoded, path };
    } catch {
      return { ok: false, path };
    } finally {
      // slowMo is a browser-launch option. Close the browser so a later run on
      // the same adapter can relaunch with its own recording settings.
      await this.browser?.close().catch(() => undefined);
      this.browser = undefined;
      this.context = undefined;
      this.page = undefined;
      this.videoEnabled = false;
      this.videoSlowMo = 0;
      this.videoSpeed = 1;
    }
  }

  /**
   * Re-encode a Playwright video at a different playback speed using ffmpeg.
   * Playwright's native recordings are video-only, so no audio filter is
   * needed (and supplying one makes ffmpeg fail on the absent audio stream).
   * Returns true if ffmpeg succeeded and the output file exists.
   */
  private async reencodeVideoSpeed(
    input: string,
    output: string,
    speed: number,
  ): Promise<boolean> {
    const videoFilter = `setpts=${(1 / speed).toFixed(4)}*PTS`;
    return new Promise((resolve) => {
      const proc = spawn(
        "ffmpeg",
        [
          "-y",
          "-i",
          input,
          "-vf",
          videoFilter,
          "-an",
          "-c:v",
          "libvpx-vp9",
          "-b:v",
          "1M",
          output,
        ],
        {
          stdio: ["ignore", "ignore", "ignore"],
          env: targetChildEnv(process.env),
        },
      );
      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => {
        resolve(existsSync(output) && code === 0);
      });
    });
  }

  async startTrace(): Promise<void> {
    // Use ensureContext so the video recordVideo option is included when
    // startVideo was called first.
    await this.ensureContext();
    try {
      await this.context!.tracing.start({
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
      // Clean up the video temp directory.
      if (this.videoTempDir) {
        await rm(this.videoTempDir, { recursive: true, force: true });
        this.videoTempDir = undefined;
      }
      this.videoEnabled = false;
      this.videoSlowMo = 0;
      this.videoSpeed = 1;
      return success(Date.now() - start);
    } catch (e) {
      return failure((e as Error).message, Date.now() - start);
    }
  }

  /* ----- internals ----- */

  private async ensureBrowser(): Promise<Browser> {
    if (this.browser) return this.browser;
    const args = this.launchArgs();
    this.browser = await chromium.launch({
      headless: !this.opts.headed,
      env: targetChildEnv(process.env),
      ...(args.length > 0 ? { args } : {}),
      // slowMo adds a delay between Playwright actions when video recording
      // is enabled with slowMo > 0. This makes the video watchable.
      ...(this.videoSlowMo > 0 ? { slowMo: this.videoSlowMo } : {}),
    });
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
      ...(this.videoEnabled && this.videoTempDir
        ? { recordVideo: { dir: this.videoTempDir } }
        : {}),
    });
    return this.context;
  }

  private async fetchRequest(
    context: BrowserContext,
    req: BackendRequest,
    timeoutMs: number,
  ): Promise<BackendResponse> {
    const mode = this.resolveRequestMode();
    if (mode === "cookie-bridge") {
      return this.fetchRequestWithCookieBridge(context, req, timeoutMs);
    }
    if (mode === "subprocess-cookie-bridge") {
      return this.fetchRequestWithSubprocessCookieBridge(
        context,
        req,
        timeoutMs,
      );
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
    const { headers, body } = await this.prepareCookieBridgeRequest(
      context,
      req,
    );
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

  private async fetchRequestWithSubprocessCookieBridge(
    context: BrowserContext,
    req: BackendRequest,
    timeoutMs: number,
  ): Promise<BackendResponse> {
    const { headers, body } = await this.prepareCookieBridgeRequest(
      context,
      req,
    );
    const result = await runIsolatedFetch(
      {
        url: req.url,
        method: req.method,
        headers: headersToRecord(headers),
        ...(body !== undefined ? { body: serializeBodyForChild(body) } : {}),
        timeoutMs,
      },
      timeoutMs,
      this.opts.isolatedFetchScript ?? ISOLATED_FETCH_SCRIPT,
    );
    const cookies = parseSetCookieHeaders(
      result.setCookieHeaders,
      result.url || req.url,
    );
    if (cookies.length > 0) {
      await context.addCookies(cookies);
    }
    return {
      ok: true,
      status: result.status,
      headers: result.headers,
      body: parseResponseBody(result.text),
    };
  }

  private async prepareCookieBridgeRequest(
    context: BrowserContext,
    req: BackendRequest,
  ): Promise<{ headers: Headers; body: EncodedRequestBody }> {
    const headers = new Headers(req.headers ?? {});
    if (!headers.has("cookie")) {
      const cookieHeader = serializeCookies(await context.cookies(req.url));
      if (cookieHeader) headers.set("cookie", cookieHeader);
    }
    return { headers, body: encodeRequestBody(req.body, headers) };
  }

  private resolveRequestMode(): RequestMode {
    if (this.opts.requestMode) return this.opts.requestMode;
    return hasBunRuntime() ? "subprocess-cookie-bridge" : "api";
  }

  private launchArgs(): string[] {
    if (this.opts.launchArgs) return this.opts.launchArgs;
    const envArgs = parseLaunchArgsEnv(
      process.env.CAIRN_PLAYWRIGHT_LAUNCH_ARGS,
    );
    if (envArgs.length > 0) return envArgs;
    return isTruthyEnv(process.env.CI) ? DEFAULT_CI_CHROMIUM_ARGS : [];
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
    } else if ("type" in sub) {
      const { value, ...loc } = sub.type;
      await this.resolveLocator(loc as Locator).pressSequentially(value, {
        timeout,
      });
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
    } else {
      throw new Error(
        `unhandled batch sub-step type: ${JSON.stringify(Object.keys(sub as object))}`,
      );
    }
  }

  private attachListeners(page: Page): void {
    const pendingRequests = new WeakMap<
      Request,
      { entry: NetworkEntry; timestamp: number; status?: number }
    >();

    const stampTerminalTiming = (
      request: Request,
    ):
      | { entry: NetworkEntry; timestamp: number; status?: number }
      | undefined => {
      const pending = pendingRequests.get(request);
      if (!pending) return undefined;
      pendingRequests.delete(request);
      const responseTimestamp = Date.now();
      pending.entry.responseTimestamp = responseTimestamp;
      pending.entry.durationMs = Math.max(
        0,
        responseTimestamp - pending.timestamp,
      );
      return pending;
    };

    page.on("request", (req: Request) => {
      const timestamp = Date.now();
      const entry: NetworkEntry = {
        url: req.url(),
        method: req.method(),
        resourceType: req.resourceType(),
        timestamp,
        startedAt: new Date(timestamp).toISOString(),
        ...captureJsonPostData(req.postData(), req.headers()["content-type"]),
      };
      this.networkLog.push(entry);
      pendingRequests.set(req, { entry, timestamp });
    });
    page.on("response", (res: Response) => {
      const pending = pendingRequests.get(res.request());
      if (pending) pending.status = res.status();
    });
    page.on("requestfinished", (req: Request) => {
      const pending = stampTerminalTiming(req);
      if (!pending) return;

      // Response headers arrive before the body is complete. Keep their status
      // private until requestfinished makes the whole terminal record visible.
      if (pending.status !== undefined) pending.entry.status = pending.status;
      else
        pending.entry.error =
          req.failure()?.errorText ??
          "request finished without response status";
    });
    page.on("requestfailed", (req: Request) => {
      const pending = stampTerminalTiming(req);
      if (!pending) return;
      pending.entry.error = req.failure()?.errorText ?? "request failed";
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
    timestamp: number,
    result: { status: number; durationMs: number; error?: string },
  ): void {
    this.networkLog.push({
      id: `request-step-${this.networkLog.length + 1}`,
      url: req.url,
      method: req.method,
      status: result.status,
      resourceType: "fetch",
      timestamp,
      responseTimestamp: timestamp + result.durationMs,
      startedAt: new Date(timestamp).toISOString(),
      durationMs: result.durationMs,
      source: "cairntrace.request",
      ...captureBackendRequestPostData(req),
      ...(result.error ? { error: result.error } : {}),
    });
  }

  private async applyWait(page: Page, cond: WaitCondition): Promise<void> {
    const timeout = cond.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS;
    await this.hardBoundPageOperation(
      () => this.applyPlaywrightWait(page, cond, timeout),
      timeout,
      `wait timed out after ${timeout}ms`,
    );
  }

  private async applyPlaywrightWait(
    page: Page,
    cond: WaitCondition,
    timeout: number,
  ): Promise<void> {
    if ("text" in cond) {
      // String form sidesteps needing the DOM lib for tsc.
      await page.waitForFunction(
        bodyTextContainsExpression(cond.text, cond.caseSensitive ?? false),
        undefined,
        { timeout },
      );
    } else if ("notText" in cond) {
      const expression = bodyTextContainsExpression(
        cond.notText,
        cond.caseSensitive ?? false,
      );
      await page.waitForFunction(`!(${expression})`, undefined, { timeout });
    } else if ("selector" in cond) {
      await page.waitForSelector(cond.selector, {
        state: cond.state ?? "visible",
        timeout,
      });
    } else if ("value" in cond) {
      throw new Error("wait.value is handled by the cross-backend runner");
    } else {
      if (cond.load === "networkidle") {
        await this.waitForScaledNetworkIdle(page, timeout);
      } else {
        await page.waitForLoadState(cond.load, { timeout });
      }
    }
  }

  /**
   * Playwright's built-in networkidle uses a fixed ~500ms quiet window. After
   * it succeeds, keep tracking new requests until the environment-scaled
   * remainder is also continuously quiet.
   */
  private async waitForScaledNetworkIdle(
    page: Page,
    timeoutMs: number,
  ): Promise<void> {
    const started = Date.now();
    await page.waitForLoadState("networkidle", { timeout: timeoutMs });
    const extraQuietMs = Math.max(
      0,
      Math.round(NETWORK_IDLE_BASE_WINDOW_MS * (this.waitScale - 1)),
    );
    if (extraQuietMs === 0) return;
    const remaining = timeoutMs - (Date.now() - started);
    if (remaining <= 0) {
      throw new TimeoutError(`networkidle timed out after ${timeoutMs}ms`);
    }
    await waitForContinuousRequestQuiet(page, extraQuietMs, remaining);
  }

  private evaluateTimeoutMs(): number {
    return Math.max(
      this.opts.defaultTimeoutMs ?? 0,
      DEFAULT_EVALUATE_TIMEOUT_MS,
    );
  }

  private async hardBoundPageOperation<T>(
    operation: () => Promise<T>,
    timeoutMs: number,
    message: string,
  ): Promise<T> {
    // The browser-kill watchdog is the primary escalation — it SIGKILLs a wedged
    // browser process so the in-page op rejects cleanly and its resources are
    // freed. But a spawned watchdog can silently fail to fire (a sandboxed CI
    // runner can deny the cross-process kill, and the child's spawn error is
    // swallowed). A bare `await` on the op would then hang FOREVER — exactly the
    // 30-minute CI stall this guards against. So ALWAYS race an in-process
    // timeout floor too: when the watchdog is enabled the floor sits just past
    // its kill deadline (let the clean kill win in the normal case); when it is
    // disabled the floor IS the bound. Either way the await is guaranteed to
    // settle within the floor, turning an unbounded hang into a timeout result.
    const watchdog = this.startBrowserKillWatchdog(timeoutMs, message);
    const floorMs = watchdog.enabled
      ? timeoutMs + HARD_TIMEOUT_SIGKILL_GRACE_MS + HARD_TIMEOUT_FLOOR_BUFFER_MS
      : timeoutMs;
    try {
      return await withTimeout(operation(), floorMs, message);
    } catch (e) {
      if (watchdog.didFire() || e instanceof TimeoutError) {
        // Browser is (or may be) wedged — abandon the refs so the next operation
        // spins up a fresh page instead of reusing a dead/hung one.
        this.pageOperationWedged = true;
        this.resetBrowserRefs();
        throw new TimeoutError(message);
      }
      throw e;
    } finally {
      watchdog.stop();
    }
  }

  private startBrowserKillWatchdog(
    timeoutMs: number,
    message: string,
  ): HardTimeoutWatchdog {
    const pid = this.browserProcessPid();
    if (!pid) return NOOP_HARD_TIMEOUT_WATCHDOG;

    const markerPath = hardTimeoutMarkerPath();
    const deadlineMs = Date.now() + timeoutMs;
    const child = spawn(
      process.execPath,
      ["--eval", HARD_TIMEOUT_WATCHDOG_SCRIPT],
      {
        stdio: ["pipe", "ignore", "ignore"],
        windowsHide: true,
        env: targetChildEnv(process.env),
      },
    );
    child.on("error", () => {
      // If the watchdog cannot start, the in-process timeout below still covers
      // normal cases. Real browser runs should have a process pid and watchdog.
    });
    child.stdin?.end(
      JSON.stringify({
        pid,
        timeoutMs,
        markerPath,
        message,
        sigkillGraceMs: HARD_TIMEOUT_SIGKILL_GRACE_MS,
      }),
    );

    return {
      enabled: true,
      didFire: () =>
        existsSync(markerPath) ||
        (Date.now() >= deadlineMs && !processIsAlive(pid)),
      stop: () => {
        child.kill("SIGTERM");
        removeFileIfExists(markerPath);
      },
    };
  }

  /**
   * The spawned Chromium process PID — the root of the browser process tree
   * (`monitor tree <pid>` captures renderer/GPU/worker children). Valid once
   * the browser has launched and undefined before/after.
   */
  browserPid(): number | undefined {
    return this.browserProcessPid();
  }

  private browserProcessPid(): number | undefined {
    const proc = (
      this.browser as unknown as
        | { process?: () => { pid?: number } | undefined }
        | undefined
    )?.process?.();
    return proc?.pid;
  }

  private resetBrowserRefs(): void {
    this.browser = undefined;
    this.context = undefined;
    this.page = undefined;
    // Note: we intentionally do NOT reset videoEnabled/videoTempDir here.
    // resetBrowserRefs is called after a browser-kill watchdog fires; the
    // next ensureContext() should still create a video-capable context, and
    // the temp dir cleanup happens in close().
  }
}

/* ----- helpers ----- */

/** Matches agent-browser's default `scroll <dir>` distance closely enough. */
const DEFAULT_SCROLL_PX = 400;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_EVALUATE_TIMEOUT_MS = 30_000;
const DEFAULT_WAIT_TIMEOUT_MS = 30_000;
const NETWORK_IDLE_BASE_WINDOW_MS = 500;
const SCREENSHOT_TIMEOUT_MS = 15_000;
const DEFAULT_CI_CHROMIUM_ARGS = ["--no-sandbox", "--disable-dev-shm-usage"];
const HARD_TIMEOUT_SIGKILL_GRACE_MS = 250;
// Extra slack added to the in-process timeout floor (over the watchdog's kill
// deadline) so the clean browser-process kill wins in the normal case and the
// floor only fires as a last resort when the external kill never lands.
const HARD_TIMEOUT_FLOOR_BUFFER_MS = 1_000;

class TimeoutError extends Error {}

function waitForContinuousRequestQuiet(
  page: Page,
  quietMs: number,
  timeoutMs: number,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const pending = new Set<Request>();
    let quietTimer: ReturnType<typeof setTimeout> | undefined;
    const timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new TimeoutError(`networkidle timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const armQuietTimer = (): void => {
      if (pending.size > 0) return;
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = setTimeout(() => {
        cleanup();
        resolve();
      }, quietMs);
    };
    const onRequest = (request: Request): void => {
      pending.add(request);
      if (quietTimer) clearTimeout(quietTimer);
      quietTimer = undefined;
    };
    const onRequestDone = (request: Request): void => {
      pending.delete(request);
      armQuietTimer();
    };
    const cleanup = (): void => {
      clearTimeout(timeoutTimer);
      if (quietTimer) clearTimeout(quietTimer);
      page.off("request", onRequest);
      page.off("requestfinished", onRequestDone);
      page.off("requestfailed", onRequestDone);
    };

    page.on("request", onRequest);
    page.on("requestfinished", onRequestDone);
    page.on("requestfailed", onRequestDone);
    armQuietTimer();
  });
}

function matchesPostconditionResponse(
  response: Response,
  postcondition: NetworkPostcondition,
): boolean {
  if (
    postcondition.method !== undefined &&
    response.request().method().toUpperCase() !== postcondition.method
  ) {
    return false;
  }
  if (!response.url().includes(postcondition.urlContains)) return false;
  return postcondition.status === undefined
    ? true
    : matchesStatus(response.status(), postcondition.status);
}

function captureJsonPostData(
  raw: string | null,
  contentType: string | undefined,
): Pick<
  NetworkEntry,
  "postData" | "postDataBytes" | "postDataTruncated" | "postDataOmittedReason"
> {
  if (raw === null) return {};
  const bytes = Buffer.byteLength(raw, "utf8");
  if (!isJsonContentType(contentType)) {
    return { postDataBytes: bytes, postDataOmittedReason: "non-json" };
  }
  if (bytes > MAX_CAPTURED_POST_DATA_BYTES) {
    return {
      postDataBytes: bytes,
      postDataTruncated: true,
      postDataOmittedReason: "oversized",
    };
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed === null || typeof parsed !== "object") {
      return { postDataBytes: bytes, postDataOmittedReason: "invalid-json" };
    }
    return { postData: JSON.stringify(redactSensitivePostData(parsed)) };
  } catch {
    return { postDataBytes: bytes, postDataOmittedReason: "invalid-json" };
  }
}

function captureBackendRequestPostData(
  request: BackendRequest,
): Pick<
  NetworkEntry,
  "postData" | "postDataBytes" | "postDataTruncated" | "postDataOmittedReason"
> {
  if (request.body === undefined) return {};
  if (typeof request.body !== "string") {
    try {
      return captureJsonPostData(
        JSON.stringify(request.body),
        "application/json",
      );
    } catch {
      return { postDataOmittedReason: "invalid-json" };
    }
  }
  const contentType = Object.entries(request.headers ?? {}).find(
    ([name]) => name.toLowerCase() === "content-type",
  )?.[1];
  return captureJsonPostData(request.body, contentType);
}

function isJsonContentType(value: string | undefined): boolean {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase();
  return (
    mediaType === "application/json" || Boolean(mediaType?.endsWith("+json"))
  );
}

function redactSensitivePostData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitivePostData);
  if (value === null || typeof value !== "object") return value;
  const redacted: Record<string, unknown> = {};
  for (const [key, nested] of Object.entries(value)) {
    redacted[key] = SENSITIVE_POST_DATA_KEY_RE.test(key)
      ? "[redacted]"
      : redactSensitivePostData(nested);
  }
  return redacted;
}

function screenshotTimeoutMessage(): string {
  return `screenshot capture timed out after ${SCREENSHOT_TIMEOUT_MS}ms — no rendering surface; is the display asleep or headless?`;
}

interface HardTimeoutWatchdog {
  enabled: boolean;
  didFire(): boolean;
  stop(): void;
}

const NOOP_HARD_TIMEOUT_WATCHDOG: HardTimeoutWatchdog = {
  enabled: false,
  didFire: () => false,
  stop: () => {},
};

type EncodedRequestBody = string | Uint8Array | undefined;

interface ChildBody {
  kind: "text" | "base64";
  value: string;
}

interface IsolatedFetchPayload {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: ChildBody;
  timeoutMs: number;
}

interface IsolatedFetchResult {
  ok: true;
  status: number;
  url: string;
  headers: Record<string, string>;
  setCookieHeaders: string[];
  text: string;
}

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

function runIsolatedFetch(
  payload: IsolatedFetchPayload,
  timeoutMs: number,
  script: string,
): Promise<IsolatedFetchResult> {
  return new Promise<IsolatedFetchResult>((resolve, reject) => {
    const child = spawn(process.execPath, ["--eval", script], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      env: targetChildEnv(process.env),
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new TimeoutError(`request timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    const settle = (): boolean => {
      if (settled) return false;
      settled = true;
      clearTimeout(timer);
      return true;
    };
    const resolveOnce = (value: IsolatedFetchResult): void => {
      if (settle()) resolve(value);
    };
    const rejectOnce = (err: Error): void => {
      if (settle()) reject(err);
    };

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => rejectOnce(err));
    child.on("close", (code, signal) => {
      if (settled) return;
      try {
        resolveOnce(parseIsolatedFetchResult(stdout));
      } catch (e) {
        const fallback =
          stderr.trim() ||
          (signal
            ? `request subprocess exited with signal ${signal}`
            : `request subprocess exited with code ${code ?? "unknown"}`);
        rejectOnce(new Error((e as Error).message || fallback));
      }
    });
    child.stdin?.end(JSON.stringify(payload));
  });
}

function parseIsolatedFetchResult(stdout: string): IsolatedFetchResult {
  if (!stdout.trim()) throw new Error("request subprocess returned no output");
  const parsed = JSON.parse(stdout) as
    | IsolatedFetchResult
    | { ok: false; error?: string };
  if (parsed.ok === true) return parsed;
  throw new Error(parsed.error || "request subprocess failed");
}

function serializeBodyForChild(
  body: Exclude<EncodedRequestBody, undefined>,
): ChildBody {
  if (typeof body === "string") return { kind: "text", value: body };
  return {
    kind: "base64",
    value: Buffer.from(body).toString("base64"),
  };
}

function parseLaunchArgsEnv(value: string | undefined): string[] {
  if (!value) return [];
  return value
    .split(/\s+/)
    .map((arg) => arg.trim())
    .filter(Boolean);
}

function isTruthyEnv(value: string | undefined): boolean {
  return value !== undefined && value !== "" && value !== "0";
}

function hasBunRuntime(): boolean {
  return Boolean(process.versions.bun);
}

function hardTimeoutMarkerPath(): string {
  return join(
    tmpdir(),
    `cairntrace-hard-timeout-${process.pid}-${Date.now()}-${Math.random()
      .toString(16)
      .slice(2)}.json`,
  );
}

function removeFileIfExists(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

const HARD_TIMEOUT_WATCHDOG_SCRIPT = String.raw`
const fs = require("node:fs");

const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const payload = JSON.parse(chunks.join(""));
  setTimeout(() => {
    try {
      fs.writeFileSync(
        payload.markerPath,
        JSON.stringify({
          pid: payload.pid,
          message: payload.message,
          firedAt: Date.now(),
        }),
      );
    } catch {}
    try {
      process.kill(payload.pid, "SIGTERM");
    } catch {}
    setTimeout(() => {
      try {
        process.kill(payload.pid, "SIGKILL");
      } catch {}
    }, payload.sigkillGraceMs);
  }, payload.timeoutMs);
});
`;

const ISOLATED_FETCH_SCRIPT = String.raw`
const chunks = [];
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  let payload;
  try {
    payload = JSON.parse(chunks.join(""));
    const headers = new Headers(payload.headers || {});
    let body;
    if (payload.body?.kind === "text") {
      body = payload.body.value;
    } else if (payload.body?.kind === "base64") {
      body = Buffer.from(payload.body.value, "base64");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), payload.timeoutMs);
    try {
      const response = await fetch(payload.url, {
        method: payload.method,
        headers,
        ...(body !== undefined ? { body } : {}),
        redirect: "follow",
        signal: controller.signal,
      });
      const text = await response.text();
      clearTimeout(timer);
      process.stdout.write(JSON.stringify({
        ok: true,
        status: response.status,
        url: response.url || payload.url,
        headers: headersToRecord(response.headers),
        setCookieHeaders: getSetCookieHeaders(response.headers),
        text,
      }));
    } catch (error) {
      clearTimeout(timer);
      const message =
        error && error.name === "AbortError"
          ? "request timed out after " + payload.timeoutMs + "ms"
          : error && error.message
            ? error.message
            : String(error);
      process.stdout.write(JSON.stringify({ ok: false, error: message }));
      process.exitCode = 1;
    }
  } catch (error) {
    const message = error && error.message ? error.message : String(error);
    process.stdout.write(JSON.stringify({ ok: false, error: message }));
    process.exitCode = 1;
  }
});

function headersToRecord(headers) {
  const out = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}

function getSetCookieHeaders(headers) {
  if (typeof headers.getSetCookie === "function") {
    return headers.getSetCookie();
  }
  const raw = typeof headers.raw === "function" ? headers.raw() : undefined;
  if (raw && raw["set-cookie"]) return raw["set-cookie"];
  const single = headers.get("set-cookie");
  return single ? splitSetCookieHeader(single) : [];
}

function splitSetCookieHeader(value) {
  const out = [];
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
`;

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
): EncodedRequestBody {
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
