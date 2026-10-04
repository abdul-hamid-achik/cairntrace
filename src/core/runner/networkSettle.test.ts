import { describe, expect, it } from "vitest";
import type { NetworkEntry } from "../../adapters/browserBackend";
import { OutcomeSchema } from "../schema/spec.v1";
import { judgedNetworkFilters, settledNetworkSnapshot } from "./networkSettle";

function backendOf(entries: NetworkEntry[]) {
  let reads = 0;
  return {
    reads: () => reads,
    async getNetworkRequests(): Promise<NetworkEntry[]> {
      reads += 1;
      return entries.map((entry) => ({ ...entry }));
    },
  };
}

describe("settledNetworkSnapshot (the end-of-steps request log)", () => {
  it("reads once when no judged request is in flight", async () => {
    const backend = backendOf([
      { url: "http://app.test/api/a", method: "GET", status: 200 },
      // in flight, but no outcome judges it
      { url: "http://app.test/static/x.js", method: "GET" },
    ]);
    const started = Date.now();
    const entries = await settledNetworkSnapshot(backend, [
      { urlContains: "/api/" },
    ]);
    expect(entries).toHaveLength(2);
    expect(backend.reads()).toBe(1);
    expect(Date.now() - started).toBeLessThan(50);
  });

  it("re-reads until a judged in-flight request gets its status (a fresh object per read)", async () => {
    const live: NetworkEntry[] = [
      { url: "http://app.test/api/save", method: "POST" },
    ];
    const backend = backendOf(live);
    setTimeout(() => {
      live[0]!.status = 500;
    }, 150);
    const entries = await settledNetworkSnapshot(backend, [
      { urlContains: "/api/save", method: "POST" },
    ]);
    expect(entries[0]!.status).toBe(500);
    expect(backend.reads()).toBeGreaterThan(1);
  });

  it("an error settles a request too, and the wait is bounded", async () => {
    const live: NetworkEntry[] = [
      { url: "http://app.test/api/a", method: "GET" },
      { url: "http://app.test/api/b", method: "GET" },
    ];
    setTimeout(() => {
      live[0]!["error"] = "net::ERR_ABORTED";
    }, 50);
    const started = Date.now();
    const entries = await settledNetworkSnapshot(
      backendOf(live),
      [{ urlContains: "/api/" }],
      { timeoutMs: 300, pollMs: 25 },
    );
    expect(entries[0]!["error"]).toBe("net::ERR_ABORTED");
    // /api/b never answers: judged pending after the bound.
    expect(entries[1]!.status).toBeUndefined();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(1500);
  });

  it("a backend that never marks failed requests (agent-browser) re-reads once, never waiting out the bound", async () => {
    // A refused request on agent-browser: no status, no error, ever.
    const backend = {
      ...backendOf([{ url: "http://127.0.0.1:9/api/refused", method: "GET" }]),
      reportsRequestFailures: false,
    };
    const started = Date.now();
    const entries = await settledNetworkSnapshot(backend, [
      { urlContains: "/api/" },
    ]);
    expect(entries[0]!.status).toBeUndefined();
    expect(backend.reads()).toBe(2);
    // one 100ms poll, not the 2s bound
    expect(Date.now() - started).toBeLessThan(600);
  });

  it("collects the filters of network and noFailedRequests outcomes only", () => {
    const outcomes = [
      {
        id: "a",
        description: "a",
        verify: { network: { urlContains: "/api/x", method: "POST" } },
      },
      {
        id: "b",
        description: "b",
        verify: { noFailedRequests: { urlContains: "/api/" } },
      },
      { id: "c", description: "c", verify: { text: { contains: "ok" } } },
    ].map((outcome) => OutcomeSchema.parse(outcome));
    expect(judgedNetworkFilters(outcomes)).toEqual([
      { urlContains: "/api/x", method: "POST" },
      { urlContains: "/api/" },
    ]);
  });
});
