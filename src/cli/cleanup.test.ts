import { describe, expect, it } from "vitest";
import type { BrowserBackend, InvocationResult } from "../adapters/browserBackend";
import { closeTrackedBackends, trackBackend } from "./cleanup";

function fakeBackend(overrides: Partial<BrowserBackend> = {}): BrowserBackend {
  const ok: InvocationResult = {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 0,
    argv: [],
  };
  return {
    name: "agent-browser",
    runStep: async () => ok,
    snapshot: async () => ({ ok: true, text: "", durationMs: 0 }),
    screenshot: async () => ({ ok: true, path: "", durationMs: 0 }),
    getUrl: async () => "",
    getTitle: async () => "",
    getText: async () => "",
    getCount: async () => 0,
    getNetworkRequests: async () => [],
    clearNetworkLog: async () => undefined,
    getConsole: async () => [],
    clearConsole: async () => undefined,
    getErrors: async () => [],
    evaluate: async () => ok,
    saveState: async () => ok,
    loadState: async () => ok,
    clearBrowserState: async () => undefined,
    close: async () => ok,
    ...overrides,
  } as BrowserBackend;
}

describe("cleanup registry", () => {
  it("terminates tracked backends synchronously and prefers terminateSync over close", () => {
    const calls: string[] = [];
    const backend = fakeBackend({
      terminateSync: () => {
        calls.push("terminateSync");
      },
      close: async () => {
        calls.push("close");
        throw new Error("close must not be used when terminateSync exists");
      },
    });

    trackBackend(backend);
    closeTrackedBackends();

    expect(calls).toEqual(["terminateSync"]);
  });

  it("untracked backends are not touched", () => {
    const calls: string[] = [];
    const backend = fakeBackend({
      terminateSync: () => {
        calls.push("terminateSync");
      },
    });

    const untrack = trackBackend(backend);
    untrack();
    closeTrackedBackends();

    expect(calls).toEqual([]);
  });

  it("falls back to fire-and-forget close and survives a throwing teardown", () => {
    const calls: string[] = [];
    const closer = fakeBackend({
      close: async () => {
        calls.push("close");
        throw new Error("ignored");
      },
    });
    const thrower = fakeBackend({
      terminateSync: () => {
        calls.push("thrower");
        throw new Error("teardown blew up");
      },
    });

    trackBackend(closer);
    trackBackend(thrower);
    // Must not throw, must reach every backend.
    closeTrackedBackends();

    expect(calls).toEqual(["close", "thrower"]);
  });
});
