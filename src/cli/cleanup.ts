import type { BrowserBackend } from "../adapters/browserBackend";

/**
 * Registry of live browser backends so an interrupted CLI process can tear
 * down what it owns before exiting. Without this, Ctrl-C / SIGTERM during a
 * run leaves the agent-browser session daemon (and its Chrome instance +
 * profile lock) running until someone kills it by hand.
 *
 * The teardown MUST be synchronous: while an execa child is in flight,
 * signal-exit (execa's dependency) re-raises the signal as soon as the
 * handler's synchronous portion returns, so promise continuations scheduled
 * here never run. Backends expose `terminateSync()` for exactly this path.
 *
 * Scope: we kill OUR session's daemon only. The default agent-browser session
 * and sessions owned by other tools are deliberately left alone.
 */

const active = new Set<BrowserBackend>();
let handlersInstalled = false;

/**
 * Track a backend for signal-time cleanup. Returns an untrack function —
 * call it from the same `finally` that calls `backend.close()`.
 */
export function trackBackend(backend: BrowserBackend): () => void {
  active.add(backend);
  installSignalHandlers();
  return () => {
    active.delete(backend);
  };
}

/**
 * Synchronously tear down every tracked backend. Backends without
 * `terminateSync` get a fire-and-forget `close()` — it may not finish before
 * exit, which is acceptable for backends whose browser dies with this
 * process (Playwright) or that hold no processes at all (mock).
 */
export function closeTrackedBackends(): void {
  for (const backend of active) {
    try {
      if (backend.terminateSync) {
        backend.terminateSync();
      } else {
        void backend.close().catch(() => undefined);
      }
    } catch {
      // Cleanup must never block the exit path.
    }
  }
  active.clear();
}

function installSignalHandlers(): void {
  if (handlersInstalled) return;
  handlersInstalled = true;
  for (const [signal, code] of [
    ["SIGINT", 130],
    ["SIGTERM", 143],
  ] as const) {
    process.once(signal, () => {
      process.stderr.write(
        `\ncairn: received ${signal}, closing browser session…\n`,
      );
      closeTrackedBackends();
      process.exit(code);
    });
  }
}
