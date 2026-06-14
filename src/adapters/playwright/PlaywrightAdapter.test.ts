import { afterEach, describe, expect, it, vi } from "vitest";
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
  page: { evaluate: (js: string) => Promise<unknown> },
): void {
  (
    adapter as unknown as {
      page: typeof page;
    }
  ).page = page;
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
