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
const activeServers = new Set<WebServerLike>();
const activeServices = new Set<ServicesLike>();
let handlersInstalled = false;

/** The slice of a webServer handle the signal path needs (see webServer.ts). */
export interface WebServerLike {
  terminateSync(): void;
}

/** The slice of a services handle the signal path needs (see services.ts). */
export interface ServicesLike {
  terminateSync(): void;
}

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
 * Track a started webServer so Ctrl-C / SIGTERM tears the server (and its
 * process tree) down before exit, alongside the browser session. Returns an
 * untrack function — call it from the `finally` that calls `handle.stop()`.
 * Reused servers register a no-op `terminateSync`, so a stale stamp never kills
 * a server cairn didn't start.
 */
export function trackWebServer(handle: WebServerLike): () => void {
  activeServers.add(handle);
  installSignalHandlers();
  return () => {
    activeServers.delete(handle);
  };
}

/**
 * Track a started services environment so Ctrl-C / SIGTERM tears the tmux
 * session (and its services) down before exit, alongside the browser session.
 * Returns an untrack function — call it from the `finally` that calls `handle.stop()`.
 * Reused services register a no-op `terminateSync`.
 */
export function trackServices(handle: ServicesLike): () => void {
  activeServices.add(handle);
  installSignalHandlers();
  return () => {
    activeServices.delete(handle);
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
  for (const server of activeServers) {
    try {
      server.terminateSync();
    } catch {
      // Cleanup must never block the exit path.
    }
  }
  activeServers.clear();
  for (const svc of activeServices) {
    try {
      svc.terminateSync();
    } catch {
      // Cleanup must never block the exit path.
    }
  }
  activeServices.clear();
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
