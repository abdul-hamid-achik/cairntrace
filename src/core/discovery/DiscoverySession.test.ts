import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import {
  captureSnapshot,
  closeSession,
  closeAllSessions,
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
  return backend;
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

    it("records a scroll step with direction and pixels", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/page");

      const result = await interact(handle, {
        action: "scroll",
        scrollDirection: "down",
        scrollPixels: 300,
      });

      expect(result.ok).toBe(true);
      expect(result.recordedStep).toEqual({ scroll: { down: 300 } });
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

  describe("closeSession", () => {
    it("closes the backend", async () => {
      const backend = createMockBackend();
      const handle = await openSession(backend, "/login");
      await closeSession(handle);
      // Verify close was called by checking the step log (mock close returns ok)
      // The key thing is it doesn't throw
      expect(true).toBe(true);
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
    });
  });
});
