import { describe, expect, it, vi } from "vitest";
import type { Page, Request, Response } from "playwright";
import { PlaywrightAdapter } from "./PlaywrightAdapter";

describe("PlaywrightAdapter native network evidence", () => {
  it("captures an epoch timestamp and a sanitized JSON body without headers", async () => {
    const adapter = new PlaywrightAdapter();
    const page = fakePage();
    attachListeners(adapter, page.value);
    const before = Date.now();
    const request = fakeRequest({
      contentType: "application/problem+json; charset=utf-8",
      body: JSON.stringify({
        product_name: "cairn.example",
        code: "public-result-code",
        nested: {
          password: "do-not-persist",
          accessToken: "token-value",
          code_verifier: "raw-code-verifier",
          otp: "123456",
          passcode: "raw-passcode",
          credential: "raw-credential",
          assertion: "raw-assertion",
        },
      }),
    });

    page.emit("request", request.value);
    page.emit("response", fakeResponse(request.value, 204));
    page.emit("requestfinished", request.value);

    const [entry] = await adapter.getNetworkRequests();
    expect(entry).toMatchObject({
      url: "https://example.test/api/answers",
      method: "PATCH",
      resourceType: "fetch",
      status: 204,
      timestamp: expect.any(Number),
    });
    expect(entry!.timestamp).toBeGreaterThanOrEqual(before);
    expect(entry!.timestamp).toBeLessThanOrEqual(Date.now());
    expect(entry!.startedAt).toBe(new Date(entry!.timestamp!).toISOString());
    expect(entry!.responseTimestamp).toBeGreaterThanOrEqual(entry!.timestamp!);
    expect(entry!.durationMs).toBe(
      entry!.responseTimestamp! - entry!.timestamp!,
    );
    expect(JSON.parse(entry!.postData!)).toEqual({
      product_name: "cairn.example",
      code: "public-result-code",
      nested: {
        password: "[redacted]",
        accessToken: "[redacted]",
        code_verifier: "[redacted]",
        otp: "[redacted]",
        passcode: "[redacted]",
        credential: "[redacted]",
        assertion: "[redacted]",
      },
    });
    expect(entry).not.toHaveProperty("headers");
    expect(entry).not.toHaveProperty("requestHeaders");
    expect(entry).not.toHaveProperty("responseHeaders");
    expect(JSON.stringify(entry)).not.toContain("raw-authorization-header");
    expect(request.headers).toHaveBeenCalledOnce();
  });

  it("omits an oversized JSON body instead of persisting a partial payload", () => {
    const adapter = new PlaywrightAdapter();
    const page = fakePage();
    attachListeners(adapter, page.value);
    const body = JSON.stringify({ value: "x".repeat(64 * 1024) });
    const request = fakeRequest({ contentType: "application/json", body });

    page.emit("request", request.value);

    return expect(adapter.getNetworkRequests())
      .resolves.toEqual([
        expect.objectContaining({
          postDataBytes: Buffer.byteLength(body, "utf8"),
          postDataTruncated: true,
          postDataOmittedReason: "oversized",
        }),
      ])
      .then(async () => {
        const [entry] = await adapter.getNetworkRequests();
        expect(entry).not.toHaveProperty("postData");
      });
  });

  it("omits opaque form bodies", async () => {
    const adapter = new PlaywrightAdapter();
    const page = fakePage();
    attachListeners(adapter, page.value);
    const request = fakeRequest({
      contentType: "application/x-www-form-urlencoded",
      body: "password=do-not-persist",
    });

    page.emit("request", request.value);

    const [entry] = await adapter.getNetworkRequests();
    expect(entry).toMatchObject({ postDataOmittedReason: "non-json" });
    expect(entry).not.toHaveProperty("postData");
    expect(JSON.stringify(entry)).not.toContain("do-not-persist");
  });

  it("waits for a terminal event and correlates identical URLs by Request identity", async () => {
    const adapter = new PlaywrightAdapter();
    const page = fakePage();
    attachListeners(adapter, page.value);
    const failedRequest = fakeRequest({
      contentType: "application/json",
      body: JSON.stringify({ answer: "failed" }),
      failure: "net::ERR_CONNECTION_RESET",
    });
    const finishedRequest = fakeRequest({
      contentType: "application/json",
      body: JSON.stringify({ answer: "finished" }),
    });

    page.emit("request", failedRequest.value);
    page.emit("request", finishedRequest.value);

    const pending = await adapter.getNetworkRequests();
    expect(pending).toHaveLength(2);
    for (const entry of pending) {
      expect(entry).not.toHaveProperty("status");
      expect(entry).not.toHaveProperty("error");
      expect(entry).not.toHaveProperty("responseTimestamp");
      expect(entry).not.toHaveProperty("durationMs");
    }

    page.emit("response", fakeResponse(finishedRequest.value, 202));
    let entries = await adapter.getNetworkRequests();
    expect(entries[1]).not.toHaveProperty("status");
    expect(entries[1]).not.toHaveProperty("responseTimestamp");

    page.emit("requestfinished", finishedRequest.value);
    entries = await adapter.getNetworkRequests();
    expect(entries[0]).not.toHaveProperty("responseTimestamp");
    expect(entries[1]).toMatchObject({
      status: 202,
      responseTimestamp: expect.any(Number),
      durationMs: expect.any(Number),
    });

    page.emit("requestfailed", failedRequest.value);
    entries = await adapter.getNetworkRequests();
    expect(entries[0]).toMatchObject({
      error: "net::ERR_CONNECTION_RESET",
      responseTimestamp: expect.any(Number),
      durationMs: expect.any(Number),
    });
    expect(entries[0]).not.toHaveProperty("status");
  });

  it("fails closed when a finished request has no response", async () => {
    const adapter = new PlaywrightAdapter();
    const page = fakePage();
    attachListeners(adapter, page.value);
    const request = fakeRequest({
      contentType: "application/json",
      body: JSON.stringify({ answer: "value" }),
    });

    page.emit("request", request.value);
    page.emit("requestfinished", request.value);

    const [entry] = await adapter.getNetworkRequests();
    expect(entry).toMatchObject({
      error: "request finished without response status",
      responseTimestamp: expect.any(Number),
      durationMs: expect.any(Number),
    });
    expect(entry).not.toHaveProperty("status");
  });

  it("records request-step bodies with the same timestamp and JSON policy", async () => {
    const adapter = new PlaywrightAdapter();
    const timestamp = 1_785_326_400_000;
    (
      adapter as unknown as {
        recordSyntheticRequest(
          request: {
            url: string;
            method: string;
            body: unknown;
          },
          timestamp: number,
          result: { status: number; durationMs: number },
        ): void;
      }
    ).recordSyntheticRequest(
      {
        url: "https://example.test/api/request-step",
        method: "POST",
        body: { answer: "kept", password: "do-not-persist" },
      },
      timestamp,
      { status: 201, durationMs: 12 },
    );

    const [entry] = await adapter.getNetworkRequests();
    expect(entry).toMatchObject({
      timestamp,
      responseTimestamp: timestamp + 12,
      startedAt: new Date(timestamp).toISOString(),
      source: "cairntrace.request",
    });
    expect(JSON.parse(entry!.postData!)).toEqual({
      answer: "kept",
      password: "[redacted]",
    });
  });
});

function attachListeners(adapter: PlaywrightAdapter, page: Page): void {
  (
    adapter as unknown as { attachListeners(target: Page): void }
  ).attachListeners(page);
}

function fakePage(): {
  value: Page;
  emit(event: string, value: unknown): void;
} {
  const listeners = new Map<string, Array<(value: unknown) => void>>();
  const value = {
    on(event: string, listener: (value: unknown) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(listener);
      listeners.set(event, existing);
      return value;
    },
  };
  return {
    value: value as unknown as Page,
    emit(event, eventValue) {
      for (const listener of listeners.get(event) ?? []) listener(eventValue);
    },
  };
}

function fakeRequest(input: {
  contentType: string;
  body: string;
  failure?: string;
}): {
  value: Request;
  headers: ReturnType<typeof vi.fn>;
} {
  const headers = vi.fn(() => ({
    "content-type": input.contentType,
    authorization: "raw-authorization-header",
  }));
  const value = {
    url: () => "https://example.test/api/answers",
    method: () => "PATCH",
    resourceType: () => "fetch",
    postData: () => input.body,
    headers,
    failure: () =>
      input.failure === undefined ? null : { errorText: input.failure },
  };
  return { value: value as unknown as Request, headers };
}

function fakeResponse(request: Request, status: number): Response {
  return {
    request: () => request,
    status: () => status,
  } as unknown as Response;
}
