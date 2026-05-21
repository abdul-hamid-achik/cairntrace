import { AgentBrowserAdapter } from "../adapters/agent-browser/AgentBrowserAdapter";
import type { BrowserBackend } from "../adapters/browserBackend";
import { MockBrowserBackend } from "../adapters/mock/MockBrowserBackend";
import { PlaywrightAdapter } from "../adapters/playwright/PlaywrightAdapter";

export type BackendChoice = "agent-browser" | "playwright" | "mock";

export interface BackendOptions {
  /** Explicit choice. `mock` is also selected when --mock is passed. */
  backend?: BackendChoice;
  mock?: boolean;
  session?: string;
  headed?: boolean;
  binary?: string;
}

/**
 * Construct the backend used by `cairn run`. Selection order:
 *   1. `--mock` (or `mock: true`) → MockBrowserBackend
 *   2. explicit `backend` arg (`agent-browser` | `playwright`)
 *   3. default: agent-browser
 */
export function createBackend(opts: BackendOptions): BrowserBackend {
  if (opts.mock) return new MockBrowserBackend();

  const choice: BackendChoice = opts.backend ?? "agent-browser";

  switch (choice) {
    case "mock":
      return new MockBrowserBackend();
    case "playwright":
      return new PlaywrightAdapter({
        // 10s default per step — Playwright's 30s default makes heal+drift
        // demos sit on each failing locator for half a minute.
        defaultTimeoutMs: 10_000,
        ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
      });
    case "agent-browser":
      return new AgentBrowserAdapter({
        session: opts.session ?? `cairntrace-${process.pid}`,
        ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
        ...(opts.binary !== undefined ? { binary: opts.binary } : {}),
      });
  }
}
