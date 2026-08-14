import { randomUUID } from "node:crypto";
import type { BrowserBackend } from "../../adapters/browserBackend";
import { parseSnapshot, type SnapshotElement } from "../healer/snapshotParser";
import {
  collectLocatorInventory,
  type LocatorInventory,
} from "../snapshot/locatorInventory";
import type { BriefMissPacket } from "../schema/brief.v1";
import type { Locator } from "../schema/spec.v1";
import type { RunResult } from "../schema/run.v1";
import {
  runSpec,
  type LocatorMissDecision,
  type RunOptions,
} from "../runner/Runner";

export const ACCOMPANY_TTL_MS = 5 * 60 * 1000;
export const MAX_ACCOMPANY_SESSIONS = 8;

export type AccompanyStatus =
  | "running"
  | "needs_choice"
  | "completed"
  | "failed"
  | "closed";

export interface AccompanyHandle {
  id: string;
  createdAt: number;
  lastActivity: number;
  status: AccompanyStatus;
  backend: BrowserBackend["name"];
  parked?: BriefMissPacket;
  result?: RunResult;
  lastSnapshot?: SnapshotElement[];
}

export interface AccompanyOpenResult {
  sessionId: string;
  status: "needs_choice" | "completed" | "failed";
  parked?: BriefMissPacket;
  result?: RunResult;
}

interface InternalSession {
  handle: AccompanyHandle;
  backend: BrowserBackend;
  runPromise: Promise<RunResult>;
  aborted: boolean;
  decision?: {
    resolve: (decision: LocatorMissDecision) => void;
  };
  gate: {
    resolve: () => void;
    promise: Promise<void>;
  };
}

const registry = new Map<string, InternalSession>();

export function resetAccompanyRegistryForTests(): void {
  registry.clear();
}

function newGate(): InternalSession["gate"] {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { resolve, promise };
}

function toOpenResult(handle: AccompanyHandle): AccompanyOpenResult {
  const status =
    handle.status === "needs_choice"
      ? "needs_choice"
      : handle.status === "completed"
        ? "completed"
        : "failed";
  return {
    sessionId: handle.id,
    status,
    ...(handle.parked ? { parked: handle.parked } : {}),
    ...(handle.result ? { result: handle.result } : {}),
  };
}

function touch(session: InternalSession): void {
  session.handle.lastActivity = Date.now();
}

export function listAccompany(): AccompanyHandle[] {
  return [...registry.values()].map((s) => s.handle);
}

export function statusAccompany(id: string): AccompanyHandle | undefined {
  const session = registry.get(id);
  if (!session) return undefined;
  touch(session);
  return session.handle;
}

export async function sweepExpiredAccompany(
  now = Date.now(),
): Promise<string[]> {
  const expired: string[] = [];
  for (const [id, session] of registry) {
    if (session.handle.status === "running") continue;
    if (now - session.handle.lastActivity > ACCOMPANY_TTL_MS) {
      expired.push(id);
      await closeAccompany(id).catch(() => undefined);
    }
  }
  return expired;
}

export function terminateAllAccompanySync(): void {
  for (const session of registry.values()) {
    session.aborted = true;
    session.decision?.resolve({ action: "abort" });
    session.decision = undefined;
    try {
      session.backend.terminateSync?.();
    } catch {
      // best-effort — keep terminating the remaining sessions
    }
  }
}

export function locatorFromSnapshotRef(
  snapshot: SnapshotElement[],
  ref: string,
  backend: BrowserBackend["name"] = "agent-browser",
): Locator {
  const id = ref.replace(/^@/, "");
  const el = snapshot.find((e) => e.ref === id || e.ref === `@${id}`);
  if (!el) {
    throw new Error(`snapshot ref ${ref} not found`);
  }
  if (backend !== "playwright") {
    return { by: "selector", selector: `@${id}` };
  }
  const peers = snapshot.filter(
    (e) => e.role === el.role && e.name === el.name,
  );
  const nth = peers.findIndex((e) => (e.ref ?? "") === (el.ref ?? ""));
  return {
    by: "role",
    role: el.role,
    ...(el.name ? { name: el.name } : {}),
    ...(peers.length > 1 && nth >= 0 ? { nth } : {}),
  };
}

export async function openAccompany(
  opts: Omit<RunOptions, "onLocatorMiss"> & { backend: BrowserBackend },
): Promise<{ handle: AccompanyHandle; open: AccompanyOpenResult }> {
  await sweepExpiredAccompany();
  const live = [...registry.values()].filter(
    (s) => s.handle.status === "running" || s.handle.status === "needs_choice",
  ).length;
  if (live >= MAX_ACCOMPANY_SESSIONS) {
    throw new Error(
      `too many open accompany sessions (${live}/${MAX_ACCOMPANY_SESSIONS})`,
    );
  }

  const id = randomUUID();
  const now = Date.now();
  const handle: AccompanyHandle = {
    id,
    createdAt: now,
    lastActivity: now,
    status: "running",
    backend: opts.backend.name,
  };
  const session: InternalSession = {
    handle,
    backend: opts.backend,
    runPromise: Promise.resolve() as unknown as Promise<RunResult>,
    aborted: false,
    gate: newGate(),
  };
  registry.set(id, session);

  session.runPromise = runSpec({
    ...opts,
    onLocatorMiss: async (ctx) => {
      if (session.aborted) return { action: "abort" };
      touch(session);
      const parked = await buildMissPacket(opts.backend, ctx.brief, ctx.error);
      if (parked.snapshot) {
        session.handle.lastSnapshot = parseSnapshot(parked.snapshot);
      }
      session.handle.parked = parked;
      session.handle.status = "needs_choice";
      session.gate.resolve();
      return await new Promise<LocatorMissDecision>((resolve) => {
        session.decision = { resolve };
      });
    },
  });

  void session.runPromise.then(
    (result) => {
      session.handle.result = result;
      session.handle.parked = result.failure?.brief ?? session.handle.parked;
      session.handle.status =
        result.status === "passed" ? "completed" : "failed";
      session.gate.resolve();
      void session.backend.close().catch(() => undefined);
    },
    () => {
      session.handle.status = "failed";
      session.gate.resolve();
      void session.backend.close().catch(() => undefined);
    },
  );

  try {
    await Promise.race([session.runPromise, session.gate.promise]);
  } catch (error) {
    await closeAccompany(id).catch(() => undefined);
    throw error;
  }
  return { handle: session.handle, open: toOpenResult(session.handle) };
}

export async function chooseAccompany(
  id: string,
  locator: Locator,
): Promise<AccompanyOpenResult> {
  const session = registry.get(id);
  if (!session) throw new Error(`accompany session not found: ${id}`);
  if (session.handle.status !== "needs_choice" || !session.decision) {
    throw new Error(`accompany session ${id} is not waiting for a locator`);
  }
  touch(session);
  session.handle.status = "running";
  session.handle.parked = undefined;
  session.gate = newGate();
  const resolve = session.decision.resolve;
  session.decision = undefined;
  resolve({ action: "retry", locator });
  await Promise.race([session.runPromise, session.gate.promise]);
  return toOpenResult(session.handle);
}

export async function closeAllAccompany(): Promise<void> {
  const ids = [...registry.keys()];
  for (const id of ids) {
    await closeAccompany(id).catch(() => undefined);
  }
}

export async function closeAccompany(id: string): Promise<void> {
  const session = registry.get(id);
  if (!session) return;
  registry.delete(id);
  session.aborted = true;
  if (session.decision) {
    session.decision.resolve({ action: "abort" });
    session.decision = undefined;
  }
  try {
    session.backend.terminateSync?.();
  } catch {
    // close() still runs below
  }
  await session.runPromise.catch(() => undefined);
  await session.backend.close().catch(() => undefined);
  session.handle.status = "closed";
}

async function buildMissPacket(
  backend: BrowserBackend,
  step: BriefMissPacket["step"],
  error: string,
): Promise<BriefMissPacket> {
  const snap = await backend
    .snapshot({ interactive: true })
    .catch(() => undefined);
  let inventory: LocatorInventory | undefined;
  try {
    inventory = await collectLocatorInventory(backend, {
      roles: true,
      testids: true,
    });
  } catch {
    try {
      inventory = await collectLocatorInventory(backend, { roles: true });
    } catch {
      inventory = undefined;
    }
  }
  return {
    step,
    error,
    ...(inventory ? { inventory } : {}),
    ...(snap?.ok ? { snapshot: snap.text } : {}),
  };
}
