import { describe, expect, it } from "vitest";
import type {
  BrowserBackend,
  InvocationResult,
} from "../adapters/browserBackend";
import {
  closeTrackedBackends,
  trackBackend,
  trackServices,
  trackWebServer,
} from "./cleanup";

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

describe("cleanup registry — webServer tracking", () => {
  it("terminates tracked webServers synchronously", () => {
    const calls: string[] = [];
    trackWebServer({
      terminateSync: () => {
        calls.push("webServer-terminateSync");
      },
    });
    closeTrackedBackends();

    expect(calls).toEqual(["webServer-terminateSync"]);
  });

  it("untracked webServers are not touched", () => {
    const calls: string[] = [];
    const untrack = trackWebServer({
      terminateSync: () => {
        calls.push("webServer-terminateSync");
      },
    });
    untrack();
    closeTrackedBackends();

    expect(calls).toEqual([]);
  });

  it("survives a throwing webServer teardown", () => {
    const calls: string[] = [];
    trackWebServer({
      terminateSync: () => {
        calls.push("webServer-thrower");
        throw new Error("webServer teardown blew up");
      },
    });
    // Must not throw
    closeTrackedBackends();

    expect(calls).toEqual(["webServer-thrower"]);
  });
});

describe("cleanup registry — services tracking", () => {
  it("terminates tracked services synchronously", () => {
    const calls: string[] = [];
    trackServices({
      terminateSync: () => {
        calls.push("services-terminateSync");
      },
    });
    closeTrackedBackends();

    expect(calls).toEqual(["services-terminateSync"]);
  });

  it("untracked services are not touched", () => {
    const calls: string[] = [];
    const untrack = trackServices({
      terminateSync: () => {
        calls.push("services-terminateSync");
      },
    });
    untrack();
    closeTrackedBackends();

    expect(calls).toEqual([]);
  });

  it("survives a throwing services teardown", () => {
    const calls: string[] = [];
    trackServices({
      terminateSync: () => {
        calls.push("services-thrower");
        throw new Error("services teardown blew up");
      },
    });
    // Must not throw
    closeTrackedBackends();

    expect(calls).toEqual(["services-thrower"]);
  });
});

describe("cleanup registry — mixed tracking (backend + webServer + services)", () => {
  it("tears down backends, webServers, and services in order", () => {
    const calls: string[] = [];

    trackBackend(
      fakeBackend({
        terminateSync: () => {
          calls.push("backend");
        },
      }),
    );
    trackWebServer({
      terminateSync: () => {
        calls.push("webServer");
      },
    });
    trackServices({
      terminateSync: () => {
        calls.push("services");
      },
    });

    closeTrackedBackends();

    // Backends are cleaned up first, then webServers, then services
    expect(calls).toEqual(["backend", "webServer", "services"]);
  });

  it("clears all registries after closeTrackedBackends", () => {
    let backendCalls = 0;
    let webServerCalls = 0;
    let servicesCalls = 0;

    trackBackend(
      fakeBackend({
        terminateSync: () => {
          backendCalls++;
        },
      }),
    );
    trackWebServer({
      terminateSync: () => {
        webServerCalls++;
      },
    });
    trackServices({
      terminateSync: () => {
        servicesCalls++;
      },
    });

    closeTrackedBackends();
    // Second call should be a no-op — registries are cleared
    closeTrackedBackends();

    expect(backendCalls).toBe(1);
    expect(webServerCalls).toBe(1);
    expect(servicesCalls).toBe(1);
  });
});
