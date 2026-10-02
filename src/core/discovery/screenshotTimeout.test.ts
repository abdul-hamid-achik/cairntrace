import { existsSync } from "node:fs";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { ScreenshotResult } from "../../adapters/browserBackend";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { SessionEventSchema } from "../schema/events.v1";
import {
  closeSession,
  interact,
  navigate,
  openSession,
  resumeSession,
  type DiscoverySessionOptions,
} from "./DiscoverySession";
import { readSessionJournal } from "./sessionJournal";
import {
  withScreenshotDeadline,
  type DiscoveryScreenshots,
} from "./stepRunner";

/**
 * A screenshot that never comes back (a slept or locked display leaves
 * Chromium without a frame) must not cost the session its browser: the
 * capture is bounded, the first timeout turns screenshots off for the rest
 * of the session (journal event + warning), and every later action runs on
 * the same page without trying again.
 */

const PAGE = `- main
  - heading "Projects" [level=1, ref=e1]
  - textbox "Search" [ref=e2]
  - button "New Project" [ref=e3]`;

/** Screenshots follow `plan`, one entry per call; the last entry repeats. */
class ScreenshotBackend extends MockBrowserBackend {
  screenshotCalls = 0;
  wedged = false;
  constructor(
    private readonly plan: Array<"hang" | "ok" | "timeout" | "fail" | "stop">,
  ) {
    super();
    this.setSnapshot(PAGE);
  }

  override async screenshot(opts: {
    path: string;
    fullPage?: boolean;
  }): Promise<ScreenshotResult> {
    const mode =
      this.plan[Math.min(this.screenshotCalls, this.plan.length - 1)]!;
    this.screenshotCalls += 1;
    if (mode === "hang") return new Promise<ScreenshotResult>(() => {});
    if (mode === "stop") {
      // A backend that had to stop its browser over the hung capture.
      this.wedged = true;
      return {
        ok: false,
        path: opts.path,
        durationMs: 37_000,
        error:
          "screenshot capture timed out after 15000ms and agent-browser was still stuck on it 20000ms later, so the session daemon and its browser were stopped (the page state is gone) — Chromium may have no rendering surface (is the display asleep/headless?)",
      };
    }
    if (mode === "timeout") {
      // What AgentBrowserAdapter reports when its own deadline fires.
      return {
        ok: false,
        path: opts.path,
        durationMs: 15_000,
        error:
          "screenshot capture timed out after 15000ms — Chromium may have no rendering surface (is the display asleep/headless?)",
      };
    }
    if (mode === "fail") {
      return {
        ok: false,
        path: opts.path,
        durationMs: 1,
        error: "screenshot capture failed: target closed",
      };
    }
    return super.screenshot(opts);
  }

  isWedged(): boolean {
    return this.wedged;
  }
}

async function options(
  extra: DiscoverySessionOptions = {},
): Promise<DiscoverySessionOptions> {
  const dir = await mkdtemp(join(tmpdir(), "cairn-discovery-shot-"));
  return {
    artifactRoot: join(dir, "runs"),
    origin: "mcp",
    configDir: dir,
    cwd: dir,
    mock: true,
    screenshotTimeoutMs: 100,
    ...extra,
  };
}

async function journalEvents(
  dir: string,
): Promise<Array<Record<string, unknown>>> {
  const raw = await readFile(join(dir, "events.ndjson"), "utf8");
  return raw
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("discovery screenshot timeouts", () => {
  it("a capture that never resolves turns screenshots off once and keeps the session", async () => {
    const b = new ScreenshotBackend(["hang"]);
    const handle = await openSession(b, "/projects", await options());

    // The open finished despite the hung capture, with a warning and no shot.
    expect(handle.opened?.screenshot).toBeUndefined();
    expect(handle.opened?.warnings).toEqual([
      expect.stringContaining(
        "screenshots are off for the rest of this session: screenshot capture timed out after 100ms",
      ),
    ]);
    expect(handle.opened?.warnings?.[0]).toContain(
      "The session and its browser keep going",
    );
    expect(b.screenshotCalls).toBe(1);

    // The next actions run on the same browser and page; no capture is tried.
    const typed = await interact(handle, {
      action: "fill",
      target: { by: "role", role: "textbox", name: "Search" },
      value: "alpha",
    });
    expect(typed).toMatchObject({ ok: true, index: 2 });
    expect(typed.screenshot).toBeUndefined();
    expect(typed.warnings).toBeUndefined();
    const clicked = await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "New Project" },
    });
    expect(clicked).toMatchObject({ ok: true, index: 3 });
    const moved = await navigate(handle, "/projects/new");
    expect(moved.ok).toBe(true);
    expect(b.screenshotCalls).toBe(1);
    expect(b.closeCalls).toBe(0);
    expect(b.stepLog.map((step) => Object.keys(step)[0])).toEqual([
      "open",
      "fill",
      "click",
      "open",
    ]);

    const dir = handle.journal!.dir;
    const events = await journalEvents(dir);
    for (const event of events) {
      expect(SessionEventSchema.safeParse(event).success).toBe(true);
    }
    const disabled = events.filter((e) => e["type"] === "screenshots.disabled");
    expect(disabled).toEqual([
      {
        ts: expect.any(String),
        type: "screenshots.disabled",
        index: 1,
        reason: expect.stringContaining("timed out after 100ms"),
      },
    ]);
    // Journaled right after the action whose capture timed out.
    const types = events.map((e) => e["type"]);
    expect(types.indexOf("screenshots.disabled")).toBe(
      types.indexOf("action.performed") + 1,
    );
    const performed = events.filter((e) => e["type"] === "action.performed");
    expect(performed).toHaveLength(4);
    expect(performed.every((e) => e["screenshot"] === undefined)).toBe(true);
    expect(existsSync(join(dir, "screenshots"))).toBe(false);

    // A reader that validates events still sees every one of them.
    const read = await readSessionJournal(dir);
    expect(read?.events.some((e) => e.type === "screenshots.disabled")).toBe(
      true,
    );
    await closeSession(handle);
  }, 20_000);

  it("a backend-reported capture timeout warns on the action it happened in", async () => {
    const b = new ScreenshotBackend(["ok", "timeout", "ok"]);
    const handle = await openSession(b, "/projects", await options());
    expect(handle.opened?.screenshot).toBe("screenshots/001.png");
    expect(handle.opened?.warnings).toEqual([]);

    const first = await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "New Project" },
    });
    expect(first.ok).toBe(true);
    expect(first.screenshot).toBeUndefined();
    expect(first.warnings).toEqual([
      expect.stringContaining("no rendering surface"),
    ]);

    const second = await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "New Project" },
    });
    expect(second.ok).toBe(true);
    expect(second.warnings).toBeUndefined();
    expect(second.screenshot).toBeUndefined();
    // The third plan entry ("ok") is never asked for.
    expect(b.screenshotCalls).toBe(2);
    const events = await journalEvents(handle.journal!.dir);
    expect(
      events.filter((e) => e["type"] === "screenshots.disabled"),
    ).toMatchObject([{ index: 2 }]);
    await closeSession(handle);
  }, 20_000);

  it("says the page state is gone when the backend had to stop its browser", async () => {
    const b = new ScreenshotBackend(["ok", "stop"]);
    const handle = await openSession(b, "/projects", await options());
    expect(handle.opened?.warnings).toEqual([]);

    const first = await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "New Project" },
    });
    expect(first.warnings).toHaveLength(1);
    expect(first.warnings![0]).toContain("still stuck on it");
    expect(first.warnings![0]).toContain(
      "had to stop its browser over the hung capture",
    );
    expect(first.warnings![0]).not.toContain("keep going");
    const events = await journalEvents(handle.journal!.dir);
    expect(
      events.filter((e) => e["type"] === "screenshots.disabled"),
    ).toMatchObject([{ index: 2 }]);
    await closeSession(handle);
  }, 20_000);

  it("a capture failure that is not a timeout keeps screenshots on", async () => {
    const b = new ScreenshotBackend(["fail", "ok"]);
    const handle = await openSession(b, "/projects", await options());
    expect(handle.opened?.screenshot).toBeUndefined();
    expect(handle.opened?.warnings).toEqual([]);
    const next = await interact(handle, {
      action: "click",
      target: { by: "role", role: "button", name: "New Project" },
    });
    expect(next.screenshot).toBe("screenshots/002.png");
    expect(b.screenshotCalls).toBe(2);
    const events = await journalEvents(handle.journal!.dir);
    expect(events.some((e) => e["type"] === "screenshots.disabled")).toBe(
      false,
    );
    await closeSession(handle);
  }, 20_000);

  it("a resumed session reports a replay capture timeout too", async () => {
    const opts = await options();
    const first = await openSession(
      new ScreenshotBackend(["ok"]),
      "/projects",
      opts,
    );
    const dir = first.journal!.dir;
    await closeSession(first);

    const read = await readSessionJournal(dir);
    const b = new ScreenshotBackend(["hang"]);
    const { artifactRoot: _root, ...resumeOpts } = opts;
    const resumed = await resumeSession(b, read!, resumeOpts);
    expect(resumed.opened?.warnings).toEqual([
      expect.stringContaining("screenshots are off"),
    ]);
    const after = await interact(resumed, {
      action: "click",
      target: { by: "role", role: "button", name: "New Project" },
    });
    expect(after.ok).toBe(true);
    expect(b.screenshotCalls).toBe(1);
    await closeSession(resumed);
  }, 20_000);
});

describe("withScreenshotDeadline", () => {
  it("bounds only screenshots and passes every other call through", async () => {
    const b = new ScreenshotBackend(["hang"]);
    const state: DiscoveryScreenshots = { timeoutMs: 20 };
    const guarded = withScreenshotDeadline(b, state);
    expect(guarded.name).toBe("mock");
    expect(await guarded.getUrl()).toBe(await b.getUrl());

    const shot = await guarded.screenshot({ path: "/nonexistent/1.png" });
    expect(shot).toMatchObject({ ok: false, path: "/nonexistent/1.png" });
    expect(shot.error).toContain("timed out after 20ms");
    expect(state.disabled).toBe(shot.error);

    const skipped = await guarded.screenshot({ path: "/nonexistent/2.png" });
    expect(skipped.ok).toBe(false);
    expect(skipped.durationMs).toBe(0);
    expect(skipped.error).toMatch(/^screenshot skipped: screenshots are off/);
    expect(b.screenshotCalls).toBe(1);
  });

  it("turns a throwing capture into a failed result without disabling", async () => {
    const b = new MockBrowserBackend();
    b.screenshot = async () => {
      throw new Error("socket hang up");
    };
    const state: DiscoveryScreenshots = { timeoutMs: 1_000 };
    const shot = await withScreenshotDeadline(b, state).screenshot({
      path: "/nonexistent/1.png",
    });
    expect(shot).toMatchObject({
      ok: false,
      error: "screenshot failed: socket hang up",
    });
    expect(state.disabled).toBeUndefined();
  });
});
