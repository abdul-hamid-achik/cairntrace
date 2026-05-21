import type { BrowserBackend } from "../adapters/browserBackend";
import { AgentBrowserAdapter } from "../adapters/agent-browser/AgentBrowserAdapter";
import { MockBrowserBackend } from "../adapters/mock/MockBrowserBackend";

export interface BackendOptions {
  mock?: boolean;
  session?: string;
  headed?: boolean;
  binary?: string;
}

/**
 * Construct the backend used by `cairn run`. `--mock` returns the in-memory
 * MockBrowserBackend, which always succeeds and is intended for smoke tests.
 */
export function createBackend(opts: BackendOptions): BrowserBackend {
  if (opts.mock) {
    return new MockBrowserBackend();
  }
  return new AgentBrowserAdapter({
    session: opts.session ?? `cairntrace-${process.pid}`,
    headed: opts.headed,
    binary: opts.binary,
  });
}
