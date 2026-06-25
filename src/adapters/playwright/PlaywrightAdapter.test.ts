import { spawn, type ChildProcess } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { chromium } from "playwright";
import { PlaywrightAdapter } from "./PlaywrightAdapter";

describe("PlaywrightAdapter request", () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("uses APIRequestContext with an explicit timeout and records network parity", async () => {
    const adapter = new PlaywrightAdapter({ requestMode: "api" });
    const fetch = vi.fn(async () =>
      apiResponse(201, JSON.stringify({ ok: true }), {
        "content-type": "application/json",
      }),
    );
    installContext(adapter, fetch);

    const result = await adapter.request({
      method: "POST",
      url: "http://app.test/api/seed",
      headers: { "x-test": "1" },
      body: { user: "dev" },
      timeoutMs: 1234,
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://app.test/api/seed",
      expect.objectContaining({
        method: "POST",
        headers: { "x-test": "1" },
        data: { user: "dev" },
        timeout: 1234,
        failOnStatusCode: false,
        maxRedirects: 20,
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      status: 201,
      body: { ok: true },
      headers: { "content-type": "application/json" },
    });

    const network = await adapter.getNetworkRequests({
      method: "POST",
      filter: "/api/seed",
    });
    expect(network[0]).toMatchObject({
      url: "http://app.test/api/seed",
      method: "POST",
      status: 201,
      resourceType: "fetch",
      source: "cairntrace.request",
    });
  });

  it("applies the default 30s request timeout when none is provided", async () => {
    const adapter = new PlaywrightAdapter({
      defaultTimeoutMs: 10,
      requestMode: "api",
    });
    const fetch = vi.fn(async () => apiResponse(200, "plain text"));
    installContext(adapter, fetch);

    const result = await adapter.request({
      method: "GET",
      url: "http://app.test/api/state",
    });

    expect(fetch).toHaveBeenCalledWith(
      "http://app.test/api/state",
      expect.objectContaining({ timeout: 30_000 }),
    );
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body: "plain text",
    });
  });

  it("uses the cookie bridge to send and persist browser-context cookies", async () => {
    const adapter = new PlaywrightAdapter({ requestMode: "cookie-bridge" });
    const addedCookies: unknown[] = [];
    installCookieBridgeContext(adapter, {
      cookies: async () => [
        {
          name: "pre",
          value: "sent",
          domain: "app.test",
          path: "/",
          expires: -1,
          httpOnly: false,
          secure: false,
          sameSite: "Lax",
        },
      ],
      addCookies: async (cookies) => {
        addedCookies.push(...cookies);
      },
    });
    const fetch = vi.fn(
      async (_url: string, _init: { headers: Headers }) =>
        new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
            "set-cookie": "session=abc; Path=/; HttpOnly; SameSite=Lax",
          },
        }),
    );
    vi.stubGlobal("fetch", fetch);

    const result = await adapter.request({
      method: "POST",
      url: "http://app.test/api/login",
      body: { ok: true },
      timeoutMs: 1000,
    });

    const init = fetch.mock.calls[0]![1];
    expect(init.headers.get("cookie")).toBe("pre=sent");
    expect(init.headers.get("content-type")).toBe("application/json");
    expect(addedCookies[0]).toMatchObject({
      name: "session",
      value: "abc",
      domain: "app.test",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body: { ok: true },
    });
  });

  it("uses the subprocess cookie bridge without parent-process fetch", async () => {
    const adapter = new PlaywrightAdapter({
      requestMode: "subprocess-cookie-bridge",
    });
    installCookieBridgeContext(adapter, {
      cookies: async () => [],
      addCookies: async () => {},
    });
    const parentFetch = vi.fn(() => {
      throw new Error("parent fetch should not run");
    });
    vi.stubGlobal("fetch", parentFetch);

    const result = await adapter.request({
      method: "GET",
      url: "data:application/json,%7B%22ok%22%3Atrue%7D",
      timeoutMs: 5_000,
    });

    expect(parentFetch).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      status: 200,
      body: { ok: true },
    });
  });

  it("hard-bounds an unresponsive subprocess cookie bridge", async () => {
    const adapter = new PlaywrightAdapter({
      requestMode: "subprocess-cookie-bridge",
      isolatedFetchScript:
        "setInterval(() => {}, 1000); process.stdin.resume();",
    });
    installCookieBridgeContext(adapter, {
      cookies: async () => [],
      addCookies: async () => {},
    });

    const result = await adapter.request({
      method: "GET",
      url: "data:text/plain,unused",
      timeoutMs: 80,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      error: "request timed out after 80ms",
    });
  });

  it("returns a transport failure instead of throwing on request errors", async () => {
    const adapter = new PlaywrightAdapter({ requestMode: "api" });
    const fetch = vi.fn(async () => {
      throw new Error("Request timed out after 25ms");
    });
    installContext(adapter, fetch);

    const result = await adapter.request({
      method: "GET",
      url: "http://app.test/api/hang",
      timeoutMs: 25,
    });

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      body: null,
      error: "Request timed out after 25ms",
    });
    const network = await adapter.getNetworkRequests({
      method: "GET",
      filter: "/api/hang",
    });
    expect(network[0]).toMatchObject({
      status: 0,
      error: "Request timed out after 25ms",
      source: "cairntrace.request",
    });
  });

  it("bounds response body reads with the request timeout", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightAdapter({ requestMode: "api" });
    const fetch = vi.fn(async () => ({
      status: () => 200,
      text: () => new Promise(() => {}),
      headers: () => ({}),
    }));
    installContext(adapter, fetch);

    const pending = adapter.request({
      method: "GET",
      url: "http://app.test/api/body-hang",
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      error: "request timed out after 25ms",
    });
  });

  it("aborts cookie-bridge body reads on timeout", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightAdapter({ requestMode: "cookie-bridge" });
    installCookieBridgeContext(adapter, {
      cookies: async () => [],
      addCookies: async () => {},
    });
    const fetch = vi.fn(
      async (_url: string, init: { signal: AbortSignal }) => ({
        status: 200,
        url: "http://app.test/api/body-hang",
        headers: new Headers(),
        text: () =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          }),
      }),
    );
    vi.stubGlobal("fetch", fetch);

    const pending = adapter.request({
      method: "GET",
      url: "http://app.test/api/body-hang",
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      status: 0,
      error: "request timed out after 25ms",
    });
  });
});

describe("PlaywrightAdapter evaluate", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a timeout result when page evaluation never resolves", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightAdapter();
    installPage(adapter, {
      evaluate: vi.fn(() => new Promise(() => {})),
    });

    const pending = adapter.evaluate("(() => new Promise(() => {}))()", {
      timeoutMs: 25,
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(result).toMatchObject({
      ok: false,
      stderr: "evaluate timed out after 25ms",
      exitCode: 124,
      argv: ["eval"],
    });
  });

  it("uses an external watchdog to abort evaluate when a browser process is present", async () => {
    const adapter = new PlaywrightAdapter();
    const browserProcess = startHungProcess();
    installBrowserProcess(adapter, browserProcess);
    installPage(adapter, {
      evaluate: vi.fn(() => rejectWhenProcessExits(browserProcess)),
    });

    try {
      const result = await adapter.evaluate("(() => new Promise(() => {}))()", {
        timeoutMs: 80,
      });

      expect(result).toMatchObject({
        ok: false,
        stderr: "evaluate timed out after 80ms",
        exitCode: 124,
        argv: ["eval"],
      });
      expect(adapterInternals(adapter).browser).toBeUndefined();
      expect(adapterInternals(adapter).page).toBeUndefined();
    } finally {
      stopProcess(browserProcess);
    }
  });

  it("falls back to an in-process timeout floor when the watchdog never settles the op", async () => {
    // Regression for the 30-min CI hang: a browser process is present (so the
    // watchdog path is taken) but the page op never settles. Before the
    // in-process floor, the watchdog-enabled branch did a bare `await` and hung
    // forever. The floor must still resolve evaluate to a timeout result.
    const adapter = new PlaywrightAdapter();
    const browserProcess = startHungProcess();
    installBrowserProcess(adapter, browserProcess);
    installPage(adapter, {
      evaluate: vi.fn(() => new Promise(() => {})),
    });

    try {
      const result = await adapter.evaluate("(() => new Promise(() => {}))()", {
        timeoutMs: 50,
      });
      expect(result).toMatchObject({
        ok: false,
        stderr: "evaluate timed out after 50ms",
        exitCode: 124,
        argv: ["eval"],
      });
      expect(adapterInternals(adapter).browser).toBeUndefined();
      expect(adapterInternals(adapter).page).toBeUndefined();
    } finally {
      stopProcess(browserProcess);
    }
  });
});

describe("PlaywrightAdapter wait", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("hard-bounds text waits with the step timeout", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightAdapter();
    const waitForFunction = vi.fn(() => new Promise(() => {}));
    installPage(adapter, { waitForFunction });

    const pending = adapter.runStep({
      wait: { text: "AWAITING ORDERS", timeoutMs: 25 },
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(waitForFunction).toHaveBeenCalledWith(
      `document.body.innerText.includes("AWAITING ORDERS")`,
      undefined,
      { timeout: 25 },
    );
    expect(result).toMatchObject({
      ok: false,
      stderr: "wait timed out after 25ms",
      exitCode: 1,
    });
  });

  it("uses a 30s default hard bound for wait steps", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightAdapter({ defaultTimeoutMs: 10 });
    const waitForFunction = vi.fn(() => new Promise(() => {}));
    installPage(adapter, { waitForFunction });

    const pending = adapter.runStep({
      wait: { notText: "Loading" },
    });
    await vi.advanceTimersByTimeAsync(30_000);
    const result = await pending;

    expect(waitForFunction).toHaveBeenCalledWith(
      `!document.body.innerText.includes("Loading")`,
      undefined,
      { timeout: 30_000 },
    );
    expect(result).toMatchObject({
      ok: false,
      stderr: "wait timed out after 30000ms",
    });
  });

  it("hard-bounds load-state waits with the step timeout", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightAdapter();
    const waitForLoadState = vi.fn(() => new Promise(() => {}));
    installPage(adapter, { waitForLoadState });

    const pending = adapter.runStep({
      wait: { load: "networkidle", timeoutMs: 25 },
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(waitForLoadState).toHaveBeenCalledWith("networkidle", {
      timeout: 25,
    });
    expect(result).toMatchObject({
      ok: false,
      stderr: "wait timed out after 25ms",
      exitCode: 1,
    });
  });

  it("waits for a selector to become visible by default", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightAdapter();
    const waitForSelector = vi.fn(() => new Promise(() => {}));
    installPage(adapter, { waitForSelector });

    const pending = adapter.runStep({
      wait: { selector: "#element_69d53d5dabbab17b1fede24f", timeoutMs: 25 },
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(waitForSelector).toHaveBeenCalledWith(
      "#element_69d53d5dabbab17b1fede24f",
      { state: "visible", timeout: 25 },
    );
    expect(result).toMatchObject({
      ok: false,
      stderr: "wait timed out after 25ms",
      exitCode: 1,
    });
  });

  it("waits for a selector to become hidden when state is hidden", async () => {
    vi.useFakeTimers();
    const adapter = new PlaywrightAdapter();
    const waitForSelector = vi.fn(() => new Promise(() => {}));
    installPage(adapter, { waitForSelector });

    const pending = adapter.runStep({
      wait: { selector: ".loading-overlay", state: "hidden", timeoutMs: 25 },
    });
    await vi.advanceTimersByTimeAsync(25);
    const result = await pending;

    expect(waitForSelector).toHaveBeenCalledWith(".loading-overlay", {
      state: "hidden",
      timeout: 25,
    });
    expect(result).toMatchObject({
      ok: false,
      stderr: "wait timed out after 25ms",
      exitCode: 1,
    });
  });

  it("uses an external watchdog to abort wait when a browser process is present", async () => {
    const adapter = new PlaywrightAdapter();
    const browserProcess = startHungProcess();
    installBrowserProcess(adapter, browserProcess);
    installPage(adapter, {
      waitForFunction: vi.fn(() => rejectWhenProcessExits(browserProcess)),
    });

    try {
      const result = await adapter.runStep({
        wait: { text: "NEVER", timeoutMs: 80 },
      });

      expect(result).toMatchObject({
        ok: false,
        stderr: "wait timed out after 80ms",
        exitCode: 1,
      });
      expect(adapterInternals(adapter).browser).toBeUndefined();
      expect(adapterInternals(adapter).page).toBeUndefined();
    } finally {
      stopProcess(browserProcess);
    }
  });
});

describe("PlaywrightAdapter launch", () => {
  const originalCi = process.env.CI;
  const originalLaunchArgs = process.env.CAIRN_PLAYWRIGHT_LAUNCH_ARGS;

  afterEach(() => {
    restoreEnv("CI", originalCi);
    restoreEnv("CAIRN_PLAYWRIGHT_LAUNCH_ARGS", originalLaunchArgs);
    vi.restoreAllMocks();
  });

  it("adds Chromium CI hardening args when CI is truthy", async () => {
    process.env.CI = "true";
    delete process.env.CAIRN_PLAYWRIGHT_LAUNCH_ARGS;
    const launch = vi
      .spyOn(chromium, "launch")
      .mockResolvedValue(fakeBrowser() as never);

    const adapter = new PlaywrightAdapter();
    await ensureBrowser(adapter);

    expect(launch).toHaveBeenCalledWith({
      headless: true,
      args: ["--no-sandbox", "--disable-dev-shm-usage"],
    });
  });

  it("allows explicit Playwright launch args to override CI defaults", async () => {
    process.env.CI = "true";
    const launch = vi
      .spyOn(chromium, "launch")
      .mockResolvedValue(fakeBrowser() as never);

    const adapter = new PlaywrightAdapter({ launchArgs: ["--custom-arg"] });
    await ensureBrowser(adapter);

    expect(launch).toHaveBeenCalledWith({
      headless: true,
      args: ["--custom-arg"],
    });
  });

  it("reads Playwright launch args from the environment", async () => {
    delete process.env.CI;
    process.env.CAIRN_PLAYWRIGHT_LAUNCH_ARGS = "--foo --bar=baz";
    const launch = vi
      .spyOn(chromium, "launch")
      .mockResolvedValue(fakeBrowser() as never);

    const adapter = new PlaywrightAdapter();
    await ensureBrowser(adapter);

    expect(launch).toHaveBeenCalledWith({
      headless: true,
      args: ["--foo", "--bar=baz"],
    });
  });
});

function installContext(
  adapter: PlaywrightAdapter,
  fetch: (url: string, options: unknown) => Promise<unknown>,
): void {
  (
    adapter as unknown as {
      context: { request: { fetch: typeof fetch } };
    }
  ).context = { request: { fetch } };
}

function installCookieBridgeContext(
  adapter: PlaywrightAdapter,
  context: {
    cookies: (url: string) => Promise<
      Array<{
        name: string;
        value: string;
        domain: string;
        path: string;
        expires: number;
        httpOnly: boolean;
        secure: boolean;
        sameSite: "Strict" | "Lax" | "None";
      }>
    >;
    addCookies: (cookies: readonly unknown[]) => Promise<void>;
  },
): void {
  (
    adapter as unknown as {
      context: typeof context;
    }
  ).context = context;
}

function installPage(
  adapter: PlaywrightAdapter,
  page: Record<string, unknown>,
): void {
  (
    adapter as unknown as {
      page: typeof page;
    }
  ).page = page;
}

function installBrowserProcess(
  adapter: PlaywrightAdapter,
  browserProcess: ChildProcess,
): void {
  (
    adapter as unknown as {
      browser: { process: () => ChildProcess };
    }
  ).browser = { process: () => browserProcess };
}

function adapterInternals(adapter: PlaywrightAdapter): {
  browser?: unknown;
  page?: unknown;
} {
  return adapter as unknown as { browser?: unknown; page?: unknown };
}

async function ensureBrowser(adapter: PlaywrightAdapter): Promise<unknown> {
  return (
    adapter as unknown as {
      ensureBrowser: () => Promise<unknown>;
    }
  ).ensureBrowser();
}

function fakeBrowser(): { close: () => Promise<void> } {
  return { close: async () => {} };
}

function startHungProcess(): ChildProcess {
  return spawn(process.execPath, ["--eval", "setInterval(() => {}, 1000)"], {
    stdio: "ignore",
    windowsHide: true,
  });
}

function rejectWhenProcessExits(child: ChildProcess): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    child.once("exit", () => reject(new Error("Target closed")));
  });
}

function stopProcess(child: ChildProcess): void {
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
  }
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

function apiResponse(
  status: number,
  text: string,
  headers: Record<string, string> = {},
): {
  status: () => number;
  text: () => Promise<string>;
  headers: () => Record<string, string>;
} {
  return {
    status: () => status,
    text: async () => text,
    headers: () => headers,
  };
}
