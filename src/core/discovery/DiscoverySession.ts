import { randomUUID } from "node:crypto";
import type {
  BrowserBackend,
  InvocationResult,
  ResolvedElement,
} from "../../adapters/browserBackend";
import { parseSnapshot, type SnapshotElement } from "../healer/snapshotParser";
import {
  collectLocatorInventory,
  type LocatorInventory,
} from "../snapshot/locatorInventory";
import {
  recordInteraction,
  recordOpen,
  recordOpenWithWait,
} from "./stepRecorder";
import type {
  DiscoveryAction,
  DiscoveryInteractResult,
} from "../schema/discovery.v1";

/**
 * A stateful discovery session that keeps a browser backend alive across
 * interactions. Each interaction is recorded as a spec-compatible step so
 * the agent can later export the full session as a spec YAML.
 *
 * Session lifecycle:
 *   1. `create()` — opens a URL, captures initial snapshot + inventory
 *   2. `snapshot()` — captures the current page state
 *   3. `interact()` — performs an action, records the step, returns new snapshot
 *   4. `navigate()` — navigates to a new URL within the session
 *   5. `getInventory()` — collects role + testid inventory from current page
 *   6. `getSteps()` — returns all recorded steps for export
 *   7. `close()` — closes the backend, frees resources
 */

export interface DiscoverySession {
  readonly id: string;
  readonly createdAt: number;
  lastActivity: number;
  currentUrl: string;
  readonly steps: RecordedStep[];
  lastSnapshot: SnapshotElement[];
}

export interface RecordedStep {
  step: Record<string, unknown>;
  timestamp: string;
  ok: boolean;
  resolvedElement?: ResolvedElement;
}

/** Map of active sessions — managed by the MCP server / CLI. */
export type SessionRegistry = Map<string, DiscoverySessionHandle>;

export interface DiscoverySessionHandle {
  session: DiscoverySession;
  backend: BrowserBackend;
  /**
   * Serializes backend operations so two concurrent calls against the same
   * session can't interleave on the single shared browser (which would corrupt
   * the recorded-step order and the last-snapshot/url state).
   */
  lock: Promise<unknown>;
}

const SESSION_TTL_MS = 5 * 60 * 1000;

/**
 * Run `fn` exclusively against a session's backend: concurrent calls queue
 * behind one another instead of racing on the same browser. The stored lock
 * never carries a rejection, so one failed op can't poison the queue.
 */
function withLock<T>(
  handle: DiscoverySessionHandle,
  fn: () => Promise<T>,
): Promise<T> {
  const run = handle.lock.then(fn, fn);
  handle.lock = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/**
 * Create a new discovery session: instantiate a backend, open the URL,
 * capture the initial snapshot and locator inventory.
 */
export async function openSession(
  backend: BrowserBackend,
  url: string,
  opts?: { waitUntil?: "networkidle" | "load" | "domcontentloaded" },
): Promise<DiscoverySessionHandle> {
  const id = randomUUID();
  const now = Date.now();

  // Navigate to the URL
  const openStep =
    opts?.waitUntil !== undefined
      ? recordOpenWithWait(url, opts.waitUntil)
      : recordOpen(url);
  const result = await backend.runStep({ open: url } as never);
  if (!result.ok) {
    throw new Error(
      `discovery: navigation failed: ${result.stderr || result.stdout || "unknown error"}`,
    );
  }

  // Capture initial snapshot
  const snap = await backend.snapshot({ interactive: true });
  const snapshotElements = snap.ok ? parseSnapshot(snap.text) : [];
  const currentUrl = await backend.getUrl().catch(() => url);

  const session: DiscoverySession = {
    id,
    createdAt: now,
    lastActivity: now,
    currentUrl,
    steps: [
      { step: openStep, timestamp: new Date(now).toISOString(), ok: result.ok },
    ],
    lastSnapshot: snapshotElements,
  };

  return { session, backend, lock: Promise.resolve() };
}

/**
 * Capture the current page snapshot.
 */
export async function captureSnapshot(
  handle: DiscoverySessionHandle,
): Promise<{ snapshot: SnapshotElement[]; url: string }> {
  handle.session.lastActivity = Date.now();
  return withLock(handle, async () => {
    const snap = await handle.backend.snapshot({ interactive: true });
    const elements = snap.ok ? parseSnapshot(snap.text) : [];
    handle.session.lastSnapshot = elements;
    const url = await handle.backend
      .getUrl()
      .catch(() => handle.session.currentUrl);
    handle.session.currentUrl = url;
    return { snapshot: elements, url };
  });
}

/**
 * Perform an interaction on the page and record the step.
 */
export async function interact(
  handle: DiscoverySessionHandle,
  input: {
    action: DiscoveryAction;
    target?: Parameters<typeof recordInteraction>[0]["target"];
    value?: string;
    scrollDirection?: "up" | "down" | "left" | "right";
    scrollPixels?: number;
  },
): Promise<DiscoveryInteractResult> {
  handle.session.lastActivity = Date.now();

  // Build the spec-compatible step to run
  const recordedStep = recordInteraction({
    action: input.action,
    target: input.target,
    value: input.value,
    scrollDirection: input.scrollDirection,
    scrollPixels: input.scrollPixels,
  });

  if (!recordedStep) {
    return {
      ok: false,
      url: handle.session.currentUrl,
      snapshot: handle.session.lastSnapshot,
      error: `invalid interaction: action=${input.action} requires target${
        input.action === "fill" || input.action === "type" ? " and value" : ""
      }`,
    };
  }

  return withLock(handle, async () => {
    // Execute the step on the backend
    const result: InvocationResult = await handle.backend.runStep(
      recordedStep as never,
    );

    // Capture post-interaction snapshot
    const snap = await handle.backend.snapshot({ interactive: true });
    const elements = snap.ok ? parseSnapshot(snap.text) : [];
    handle.session.lastSnapshot = elements;
    const url = await handle.backend
      .getUrl()
      .catch(() => handle.session.currentUrl);
    handle.session.currentUrl = url;

    // Record the step
    handle.session.steps.push({
      step: recordedStep,
      timestamp: new Date().toISOString(),
      ok: result.ok,
      ...(result.resolvedElement
        ? { resolvedElement: result.resolvedElement }
        : {}),
    });

    return {
      ok: result.ok,
      ...(result.resolvedElement
        ? { resolvedElement: result.resolvedElement }
        : {}),
      url,
      snapshot: elements,
      ...(result.ok
        ? {}
        : { error: result.stderr || result.stdout || "step failed" }),
      recordedStep,
    };
  });
}

/**
 * Navigate to a new URL within the session.
 */
export async function navigate(
  handle: DiscoverySessionHandle,
  url: string,
  opts?: { waitUntil?: "networkidle" | "load" | "domcontentloaded" },
): Promise<{ ok: boolean; url: string; snapshot: SnapshotElement[] }> {
  handle.session.lastActivity = Date.now();
  const openStep =
    opts?.waitUntil !== undefined
      ? recordOpenWithWait(url, opts.waitUntil)
      : recordOpen(url);

  return withLock(handle, async () => {
    const result = await handle.backend.runStep(openStep as never);

    const snap = await handle.backend.snapshot({ interactive: true });
    const elements = snap.ok ? parseSnapshot(snap.text) : [];
    handle.session.lastSnapshot = elements;
    const currentUrl = await handle.backend.getUrl().catch(() => url);
    handle.session.currentUrl = currentUrl;

    handle.session.steps.push({
      step: openStep,
      timestamp: new Date().toISOString(),
      ok: result.ok,
    });

    return { ok: result.ok, url: currentUrl, snapshot: elements };
  });
}

/**
 * Collect locator inventory from the current page.
 */
export async function getInventory(
  handle: DiscoverySessionHandle,
  opts?: { roles?: boolean; testids?: boolean },
): Promise<LocatorInventory> {
  handle.session.lastActivity = Date.now();
  const includeRoles = opts?.roles || (!opts?.roles && !opts?.testids);
  const includeTestIds = opts?.testids || (!opts?.roles && !opts?.testids);
  return withLock(handle, () =>
    collectLocatorInventory(handle.backend, {
      roles: includeRoles,
      testids: includeTestIds,
    }),
  );
}

/**
 * Get all recorded steps (for suggest/review). Refreshes the session's
 * activity timestamp so reviewing a session keeps it alive — otherwise a long
 * review pause could let the idle sweep reap the session mid-export.
 */
export function getSteps(
  handle: DiscoverySessionHandle,
): Record<string, unknown>[] {
  handle.session.lastActivity = Date.now();
  return handle.session.steps.map((s) => s.step);
}

/**
 * Get the steps that are safe to export as a spec: only those that executed
 * successfully. A failed interaction (a click that didn't resolve, a 404
 * navigate) never achieved its effect, so exporting it would produce a spec
 * that can't replay. Returns the count of excluded failed steps so callers can
 * warn the agent.
 */
export function getExportableSteps(handle: DiscoverySessionHandle): {
  steps: Record<string, unknown>[];
  skippedFailed: number;
} {
  handle.session.lastActivity = Date.now();
  const ok = handle.session.steps.filter((s) => s.ok);
  return {
    steps: ok.map((s) => s.step),
    skippedFailed: handle.session.steps.length - ok.length,
  };
}

/**
 * Close a session and free the backend.
 */
export async function closeSession(
  handle: DiscoverySessionHandle,
): Promise<void> {
  await handle.backend.close().catch(() => undefined);
}

/**
 * Sweep expired sessions from the registry. Returns the IDs of closed sessions.
 */
export async function sweepSessions(
  registry: SessionRegistry,
): Promise<string[]> {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, handle] of registry) {
    if (now - handle.session.lastActivity > SESSION_TTL_MS) {
      expired.push(id);
      await closeSession(handle).catch(() => undefined);
      registry.delete(id);
    }
  }
  return expired;
}

/**
 * Close all sessions in the registry (used on server shutdown).
 */
export async function closeAllSessions(
  registry: SessionRegistry,
): Promise<void> {
  for (const handle of registry.values()) {
    await closeSession(handle).catch(() => undefined);
  }
  registry.clear();
}
