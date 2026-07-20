import { describe, expect, it, vi } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import {
  captureCheckpoint,
  captureSnapshot,
  closeSession,
  closeAllSessions,
  getExportableSteps,
  getInventory,
  getSteps,
  interact,
  navigate,
  openSession,
  type SessionRegistry,
  sweepSessions,
} from "./DiscoverySession";

const SNAPSHOT_WITH_ELEMENTS = `- banner
  - heading "Welcome Back" [level=1, ref=e1]
  - textbox "Email" [ref=e2]
  - textbox "Password" [ref=e3]
  - button "Sign In" [ref=e4]
  - link "Forgot password?" [ref=e5]`;

const SNAPSHOT_DASHBOARD = `- main
  - heading "Dashboard" [level=1, ref=e1]
  - button "New Project" [ref=e2]
  - table "Recent Projects" [ref=e3]`;

function createMockBackend(
  snapshotText = SNAPSHOT_WITH_ELEMENTS,
): MockBrowserBackend {
  const backend = new MockBrowserBackend();
  backend.setSnapshot(snapshotText);
  // Validate recorded step shapes against the real schema so a recorder bug
  // (e.g. an invalid scroll shape) surfaces here instead of shipping green.
  backend.setStrictStepValidation();
  return backend;
}

/**
 * A mock backend that records the peak number of in-flight runStep calls, used
 * to prove the per-session lock actually serializes backend operations.
 */
class ConcurrencyTrackingBackend extends MockBrowserBackend {
  active = 0;
  maxConcurrent = 0;
  override async runStep(
    step: Parameters<MockBrowserBackend["runStep"]>[0],
  ): Promise<Awaited<ReturnType<MockBrowserBackend["runStep"]>>> {
    this.active++;
    this.maxConcurrent = Math.max(this.maxConcurrent, this.active);
    // Yield a few microtasks so an unserialized second call could overlap.
    await Promise.resolve();
    await Promise.resolve();
    try {
      return await super.runStep(step);
    } finally {
      this.active--;
    }
  }
}

describe("DiscoverySession", () => {
  describe("openSession", () => {
    it("opens a URL, captures snapshot, and creates a session", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");

      expect(handle.session.id).toBeTruthy();
      expect(handle.session.currentUrl).toBe("/login");
      expect(handle.session.lastSnapshot).toHaveLength(6);
      expect(handle.session.steps).toHaveLength(1);
      expect(handle.session.steps[0]!.step).toEqual({ open: "/login" });
      expect(handle.session.steps[0]!.ok).toBe(true);
    });

    it("throws on navigation failure", async () => {
      const backend = createMockBackend();
      backend.failNextStep("connection refused");
      await expect(openSession(backend, "/bad")).rejects.toThrow(
        /navigation failed/,
      );
    });

    it("executes the same waitUntil open step it records", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login", {
        waitUntil: "networkidle",
      });

      const recorded = { open: { path: "/login", waitUntil: "networkidle" } };
      expect(handle.session.steps[0]!.step).toEqual(recorded);
      // The backend must have actually run that step (not a hardcoded
      // `{ open: "/login" }`), so discovery settles the same way the export will.
      expect(backend.stepLog[0]).toEqual(recorded);
    });
  });

  describe("captureSnapshot", () => {
    it("captures the current page state", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      const { snapshot, url } = await captureSnapshot(handle);

      expect(snapshot).toHaveLength(6);
      expect(snapshot[0]!.role).toBe("banner");
      expect(url).toBe("/login");
    });

    it("handles empty snapshots", async () => {
      const backend = createMockBackend("- generic\n  - body");
      const handle = await openSession(backend, "/empty");
      const { snapshot } = await captureSnapshot(handle);
      expect(snapshot).toHaveLength(2);
    });
  });

  describe("interact", () => {
    it("records a click step and returns the result", async () => {
      const backend = createMockBackend(SNAPSHOT_DASHBOARD);
      const handle = await openSession(backend, "/login");

      // After click, change the snapshot to dashboard
      backend.setSnapshot(SNAPSHOT_DASHBOARD);

      const result = await interact(handle, {
        action: "click",
        target: { by: "role", role: "button", name: "Sign In" },
      });

      expect(result.ok).toBe(true);
      expect(result.url).toBe("/login");
      expect(result.snapshot).toHaveLength(4);
      expect(result.recordedStep).toEqual({
        click: { by: "role", role: "button", name: "Sign In" },
      });
      // 2 steps: open + click
      expect(handle.session.steps).toHaveLength(2);
    });

    it("records a fill step", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");

      const result = await interact(handle, {
        action: "fill",
        target: { by: "role", role: "textbox", name: "Email" },
        value: "admin@test.com",
      });

      expect(result.ok).toBe(true);
      expect(result.recordedStep).toEqual({
        fill: {
          by: "role",
          role: "textbox",
          name: "Email",
          value: "admin@test.com",
        },
      });
    });

    it("records a press step", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");

      const result = await interact(handle, {
        action: "press",
        value: "Enter",
      });

      expect(result.ok).toBe(true);
      expect(result.recordedStep).toEqual({ press: "Enter" });
    });

    it("returns error for invalid interaction (click without target)", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");

      const result = await interact(handle, { action: "click" });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("click");
      expect(result.error).toContain("target");
      // Step should not be recorded
      expect(handle.session.steps).toHaveLength(1);
    });

    it("returns error for fill without value", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");

      const result = await interact(handle, {
        action: "fill",
        target: { by: "role", role: "textbox", name: "Email" },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("fill");
    });

    it("rejects an ephemeral snapshot @ref with a specific error", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");

      const result = await interact(handle, {
        action: "click",
        target: "@e4",
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("@ref");
      expect(result.error).toContain("cannot replay");
      // The brittle step must not be recorded.
      expect(handle.session.steps).toHaveLength(1);
    });

    it("propagates the resolved element to the result and recorded step", async () => {
      class ResolvingBackend extends MockBrowserBackend {
        override async runStep(
          step: Parameters<MockBrowserBackend["runStep"]>[0],
        ): Promise<Awaited<ReturnType<MockBrowserBackend["runStep"]>>> {
          const r = await super.runStep(step);
          return {
            ...r,
            resolvedElement: { role: "button", name: "Sign In", ref: "e4" },
          };
        }
      }
      const backend = new ResolvingBackend();
      backend.setSnapshot(SNAPSHOT_WITH_ELEMENTS);
      const handle = await openSession(backend, "/login");

      const result = await interact(handle, {
        action: "click",
        target: { by: "role", role: "button", name: "Sign In" },
      });

      expect(result.resolvedElement).toEqual({
        role: "button",
        name: "Sign In",
        ref: "e4",
      });
      // The recorded step carries the resolved element as side metadata.
      const last = handle.session.steps[handle.session.steps.length - 1]!;
      expect(last.resolvedElement).toEqual({
        role: "button",
        name: "Sign In",
        ref: "e4",
      });
    });

    it("records a scroll step with direction and pixels", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/page");

      const result = await interact(handle, {
        action: "scroll",
        scrollDirection: "down",
        scrollPixels: 300,
      });

      expect(result.ok).toBe(true);
      expect(result.recordedStep).toEqual({
        scroll: { direction: "down", px: 300 },
      });
    });

    it("records a scroll to a locator", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/page");

      const result = await interact(handle, {
        action: "scroll",
        target: { by: "role", role: "button", name: "Submit" },
      });

      expect(result.ok).toBe(true);
      expect(result.recordedStep).toEqual({
        scroll: { to: { by: "role", role: "button", name: "Submit" } },
      });
    });

    it("records step failure when backend fails", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      backend.failNextStep("element not found");

      const result = await interact(handle, {
        action: "click",
        target: { by: "role", role: "button", name: "Missing" },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("element not found");
      // Step still recorded (with ok=false)
      expect(handle.session.steps).toHaveLength(2);
      expect(handle.session.steps[1]!.ok).toBe(false);
    });

    it("serializes concurrent interactions on the shared backend", async () => {
      const backend = new ConcurrencyTrackingBackend();
      backend.setSnapshot(SNAPSHOT_WITH_ELEMENTS);
      const handle = await openSession(backend, "/page");

      // Fire three interactions without awaiting between them.
      await Promise.all([
        interact(handle, { action: "click", target: "#a" }),
        interact(handle, { action: "click", target: "#b" }),
        interact(handle, { action: "click", target: "#c" }),
      ]);

      // The lock must keep backend.runStep strictly one-at-a-time.
      expect(backend.maxConcurrent).toBe(1);
      // All three recorded in call order (plus the initial open).
      expect(handle.session.steps).toHaveLength(4);
      expect(handle.session.steps.slice(1).map((s) => s.step)).toEqual([
        { click: { by: "selector", selector: "#a" } },
        { click: { by: "selector", selector: "#b" } },
        { click: { by: "selector", selector: "#c" } },
      ]);
    });

    it("a throwing op does not poison the lock queue for later ops", async () => {
      class ThrowingBackend extends MockBrowserBackend {
        throwNext = false;
        override async runStep(
          step: Parameters<MockBrowserBackend["runStep"]>[0],
        ): Promise<Awaited<ReturnType<MockBrowserBackend["runStep"]>>> {
          if (this.throwNext) {
            this.throwNext = false;
            throw new Error("backend exploded");
          }
          return super.runStep(step);
        }
      }
      const backend = new ThrowingBackend();
      backend.setSnapshot(SNAPSHOT_WITH_ELEMENTS);
      const handle = await openSession(backend, "/page");

      // First interact throws inside the lock; second queues behind it.
      backend.throwNext = true;
      const first = interact(handle, { action: "click", target: "#a" });
      const second = interact(handle, { action: "click", target: "#b" });

      await expect(first).rejects.toThrow("backend exploded");
      // The stored lock swallows the rejection, so the queued op still runs.
      const ok = await second;
      expect(ok.ok).toBe(true);
      expect(ok.recordedStep).toEqual({
        click: { by: "selector", selector: "#b" },
      });
    });
  });

  describe("navigate", () => {
    it("navigates to a new URL and records an open step", async () => {
      const backend = createMockBackend(SNAPSHOT_DASHBOARD);
      const handle = await openSession(backend, "/login");

      backend.setSnapshot(SNAPSHOT_DASHBOARD);
      const result = await navigate(handle, "/dashboard");

      expect(result.ok).toBe(true);
      expect(result.url).toBe("/dashboard");
      expect(result.snapshot).toHaveLength(4);
      // 2 steps: original open + new open
      expect(handle.session.steps).toHaveLength(2);
      expect(handle.session.steps[1]!.step).toEqual({ open: "/dashboard" });
    });

    it("records failed navigation", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      backend.failNextStep("404");

      const result = await navigate(handle, "/missing");

      expect(result.ok).toBe(false);
      expect(handle.session.steps).toHaveLength(2);
      expect(handle.session.steps[1]!.ok).toBe(false);
    });
  });

  describe("getInventory", () => {
    it("collects role inventory from the current page", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      const inventory = await getInventory(handle, {
        roles: true,
        testids: false,
      });

      expect(inventory.roles).toBeDefined();
      expect(inventory.roles!.length).toBeGreaterThan(0);
      const buttonEntry = inventory.roles!.find((r) => r.role === "button");
      expect(buttonEntry).toBeDefined();
      expect(buttonEntry!.name).toBe("Sign In");
    });

    it("collects testid inventory when requested", async () => {
      const backend = createMockBackend();
      backend.enqueueEvalResult([
        {
          testId: "login-btn",
          tagName: "button",
          text: "Sign In",
          selector: '[data-testid="login-btn"]',
        },
      ]);
      const handle = await openSession(backend, "/login");
      const inventory = await getInventory(handle, {
        roles: false,
        testids: true,
      });

      expect(inventory.testids).toBeDefined();
      expect(inventory.testids).toHaveLength(1);
      expect(inventory.testids![0]!.testId).toBe("login-btn");
      // roles not requested → absent
      expect(inventory.roles).toBeUndefined();
    });

    it("collects both roles and testids by default", async () => {
      const backend = createMockBackend();
      backend.enqueueEvalResult([
        {
          testId: "login-btn",
          tagName: "button",
          text: "Sign In",
          selector: '[data-testid="login-btn"]',
        },
      ]);
      const handle = await openSession(backend, "/login");
      const inventory = await getInventory(handle);

      expect(inventory.roles).toBeDefined();
      expect(inventory.testids).toBeDefined();
      expect(inventory.testids![0]!.testId).toBe("login-btn");
    });

    it("surfaces unnamed interactive elements as nameless role locators", async () => {
      // An unnamed button is still interactive — the inventory surfaces it as a
      // role locator without a name (plus its count), giving the agent a stable
      // alternative to an ephemeral @ref.
      const backend = createMockBackend(
        "- main\n  - button [ref=e1]\n  - button [ref=e2]",
      );
      const handle = await openSession(backend, "/page");
      const inventory = await getInventory(handle, {
        roles: true,
        testids: false,
      });

      const unnamedButton = inventory.roles!.find(
        (r) => r.role === "button" && r.name === undefined,
      );
      expect(unnamedButton).toBeDefined();
      expect(unnamedButton!.count).toBe(2);
      expect(unnamedButton!.locator).toEqual({ by: "role", role: "button" });
    });
  });

  describe("getSteps", () => {
    it("returns all recorded steps", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");

      await interact(handle, {
        action: "fill",
        target: { by: "role", role: "textbox", name: "Email" },
        value: "test@test.com",
      });
      await interact(handle, {
        action: "click",
        target: { by: "role", role: "button", name: "Sign In" },
      });

      const steps = getSteps(handle);
      expect(steps).toHaveLength(3); // open + fill + click
      expect(steps[0]).toEqual({ open: "/login" });
      expect(steps[1]).toEqual({
        fill: {
          by: "role",
          role: "textbox",
          name: "Email",
          value: "test@test.com",
        },
      });
      expect(steps[2]).toEqual({
        click: { by: "role", role: "button", name: "Sign In" },
      });
    });
  });

  describe("getExportableSteps", () => {
    it("excludes failed steps and reports skippedFailed", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login"); // ok open step

      await interact(handle, {
        action: "fill",
        target: { by: "role", role: "textbox", name: "Email" },
        value: "test@test.com",
      });

      backend.failNextStep("element not found");
      await interact(handle, {
        action: "click",
        target: { by: "role", role: "button", name: "Missing" },
      });

      const { steps, skippedFailed } = getExportableSteps(handle);
      // open + fill replayed; the failed click is excluded so the exported
      // spec stays replayable.
      expect(steps).toHaveLength(2);
      expect(steps[0]).toEqual({ open: "/login" });
      expect(steps[1]).toEqual({
        fill: {
          by: "role",
          role: "textbox",
          name: "Email",
          value: "test@test.com",
        },
      });
      expect(skippedFailed).toBe(1);
    });

    it("reports zero skippedFailed when every step succeeded", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      await interact(handle, { action: "press", value: "Enter" });

      const { steps, skippedFailed } = getExportableSteps(handle);
      expect(steps).toHaveLength(2);
      expect(skippedFailed).toBe(0);
    });
  });

  describe("captureCheckpoint", () => {
    it("saves the backend state to the given path", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");

      const result = await captureCheckpoint(
        handle,
        "/tmp/checkpoints/auth.json",
      );

      expect(result.ok).toBe(true);
      expect(backend.saveStatePaths).toEqual(["/tmp/checkpoints/auth.json"]);
    });
  });

  describe("closeSession", () => {
    it("closes the backend", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      await closeSession(handle);
      expect(backend.closeCalls).toBe(1);
    });
  });

  describe("sweepSessions", () => {
    it("removes expired sessions from the registry", async () => {
      const registry: SessionRegistry = new Map();
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      registry.set(handle.session.id, handle);

      // Make the session appear expired
      handle.session.lastActivity = Date.now() - 10 * 60 * 1000; // 10 min ago

      const expired = await sweepSessions(registry);
      expect(expired).toHaveLength(1);
      expect(registry.size).toBe(0);
      expect(backend.closeCalls).toBe(1);
    });

    it("keeps active sessions", async () => {
      const registry: SessionRegistry = new Map();
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      registry.set(handle.session.id, handle);

      const expired = await sweepSessions(registry);
      expect(expired).toHaveLength(0);
      expect(registry.size).toBe(1);
    });

    it("sweeps just past the TTL boundary but keeps a session exactly at it", async () => {
      vi.useFakeTimers();
      try {
        const registry: SessionRegistry = new Map();
        const backend = createMockBackend();
        const handle = await openSession(backend, "/login");
        registry.set(handle.session.id, handle);

        const now = Date.now();
        // Exactly at the 5-minute TTL: kept (the check is strictly >).
        handle.session.lastActivity = now - 5 * 60 * 1000;
        expect(await sweepSessions(registry)).toHaveLength(0);
        expect(registry.size).toBe(1);

        // One millisecond past the boundary: swept and closed.
        handle.session.lastActivity = now - (5 * 60 * 1000 + 1);
        expect(await sweepSessions(registry)).toHaveLength(1);
        expect(registry.size).toBe(0);
        expect(backend.closeCalls).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });
  });

  describe("closeAllSessions", () => {
    it("closes all sessions and clears the registry", async () => {
      const registry: SessionRegistry = new Map();
      const b1 = createMockBackend();
      const b2 = createMockBackend();
      const h1 = await openSession(b1, "/page1");
      const h2 = await openSession(b2, "/page2");
      registry.set(h1.session.id, h1);
      registry.set(h2.session.id, h2);

      await closeAllSessions(registry);
      expect(registry.size).toBe(0);
      expect(b1.closeCalls).toBe(1);
      expect(b2.closeCalls).toBe(1);
    });
  });
});
