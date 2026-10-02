import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { BrowserBackend } from "../../adapters/browserBackend";
import { createArtifactRedactor } from "../artifacts/redaction";
import { withoutQuery } from "../artifacts/stepLabel";
import { resolveSpecRuntimeContext } from "../config/runtimeContext";
import { SessionJournal } from "../discovery/sessionJournal";
import { parseSpec } from "../parser/parseSpec";
import {
  AccompanyRecorder,
  type AccompanyDecision,
  type StepOriginRef,
} from "./accompanyJournal";
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
  /** Session journal directory (`_sessions/<id>/`). */
  journal?: string;
  /** Locator decisions so far (accepted ones are in the draft copy). */
  decisions?: AccompanyDecision[];
  /** Draft copy with the accepted replacements (never the source spec). */
  draftPath?: string;
}

/** Journal options of an accompany session. */
export interface AccompanyJournalOptions {
  origin?: "cli" | "mcp";
  /** MCP client `name/version`. */
  client?: string;
  headed?: boolean;
  /** Also write the draft copy here (must not be the source spec). */
  draftTo?: string;
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
  journal?: SessionJournal;
  recorder?: AccompanyRecorder;
  runPromise: Promise<RunResult>;
  aborted: boolean;
  decision?: {
    resolve: (decision: LocatorMissDecision) => void;
  };
  gate: {
    resolve: () => void;
    promise: Promise<void>;
  };
  /** The step the session is parked on (for the decision recorder). */
  parkedStep?: { index: number; id: string };
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
      await closeAccompany(id, "ttl").catch(() => undefined);
    }
  }
  return expired;
}

export function terminateAllAccompanySync(): void {
  for (const session of registry.values()) {
    endAccompanyJournal(session, "shutdown");
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
  opts: Omit<RunOptions, "onLocatorMiss"> & {
    backend: BrowserBackend;
    /** Session journal (default on); false disables it. */
    journal?: AccompanyJournalOptions | false;
  },
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
  const { journal: journalOpts, ...runOpts } = opts;
  // Registered before any await so a concurrent open sees the slot taken.
  registry.set(id, session);
  if (journalOpts !== false) {
    // Best-effort: a journal that cannot be created never blocks the run
    // (an unreadable spec still fails in runSpec, as before) — except a
    // draftTo that names the source spec, which is refused outright.
    try {
      await attachJournal(session, runOpts, journalOpts ?? {});
    } catch (error) {
      registry.delete(id);
      endAccompanyJournal(session, "close", (error as Error).message);
      throw error;
    }
  }

  const callerListener = runOpts.listener;
  session.runPromise = runSpec({
    ...runOpts,
    listener: {
      ...callerListener,
      onStepFinish: (idx, stepId, status, durationMs, error) => {
        session.recorder?.stepFinished(idx, status, error);
        callerListener?.onStepFinish?.(idx, stepId, status, durationMs, error);
      },
    },
    onLocatorMiss: async (ctx) => {
      if (session.aborted) return { action: "abort" };
      touch(session);
      if (session.recorder) {
        const url = await opts.backend.getUrl().catch(() => "");
        session.recorder.park(ctx.index, ctx.error, url);
        session.parkedStep = { index: ctx.index, id: ctx.stepId };
        syncDecisions(session);
      }
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
    endAccompanyJournal(session, "close", (error as Error).message);
    await closeAccompany(id).catch(() => undefined);
    throw error;
  }
  return { handle: session.handle, open: toOpenResult(session.handle) };
}

/** Create the `kind: accompany` journal and the decision recorder. */
async function attachJournal(
  session: InternalSession,
  opts: Omit<RunOptions, "onLocatorMiss">,
  journalOpts: AccompanyJournalOptions,
): Promise<void> {
  const specPath = resolvePath(opts.specPath);
  let artifactRoot = opts.artifactRoot;
  let envName: string | undefined;
  let configPath: string | undefined;
  let origins = new Map<number, StepOriginRef>();
  let startUrl = "";
  try {
    const runtime = await resolveSpecRuntimeContext(specPath, {
      ...(opts.environmentOverride !== undefined
        ? { envOverride: opts.environmentOverride }
        : {}),
      ...(opts.configPath !== undefined ? { configPath: opts.configPath } : {}),
      ...(opts.vars !== undefined ? { vars: opts.vars } : {}),
      ...(opts.env ? { env: opts.env } : {}),
    });
    artifactRoot ??= runtime.config?.artifactRoot;
    envName = runtime.envName;
    configPath = runtime.configPath;
    // Only WHERE each step is declared is needed: secrets stay references.
    const parsed = await parseSpec(specPath, {
      ...(opts.env ? { env: opts.env } : {}),
      vars: runtime.vars,
      configDir: runtime.configDir,
      ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
      runtime: { workerIndex: 0, runToken: "accompany" },
      secretRef: (name) => `\${secrets.${name}}`,
    });
    origins = new Map(
      parsed.origins.map((origin, index) => [
        index,
        { file: origin.filePath, stepIndex: origin.fileStepIdx },
      ]),
    );
    const first = parsed.spec.steps?.find((step) => "open" in step);
    if (first && "open" in first) {
      startUrl = typeof first.open === "string" ? first.open : first.open.path;
    }
  } catch {
    // runSpec reports an unreadable spec; the journal just has less detail.
  }
  const sourceText = await readFile(specPath, "utf8").catch(() => undefined);
  const redactor = createArtifactRedactor(
    undefined,
    opts.env ?? process.env,
    opts.secretValues,
  );
  const now = new Date(session.handle.createdAt).toISOString();
  const journal = SessionJournal.create(
    artifactRoot ?? join(homedir(), ".cairntrace", "runs"),
    {
      version: 1,
      sessionId: session.handle.id,
      kind: "accompany",
      pid: process.pid,
      origin: journalOpts.origin ?? "mcp",
      ...(journalOpts.client ? { client: journalOpts.client } : {}),
      startUrl: withoutQuery(redactor.text(startUrl)),
      backend: opts.backend.name,
      headed: journalOpts.headed === true,
      ...(envName ? { env: envName } : {}),
      ...(configPath ? { configPath } : {}),
      status: "open",
      openedAt: now,
      lastActivityAt: now,
      ttlMs: ACCOMPANY_TTL_MS,
      specPath,
      stepCount: 0,
      actionCount: 0,
    },
    redactor,
  );
  if (!journal) return;
  session.journal = journal;
  session.handle.journal = journal.dir;
  session.recorder = new AccompanyRecorder({
    journal,
    specPath,
    ...(sourceText !== undefined ? { sourceText } : {}),
    origins,
    ...(journalOpts.draftTo !== undefined
      ? { draftTo: journalOpts.draftTo }
      : {}),
  });
  session.handle.decisions = session.recorder.decisions;
}

function syncDecisions(session: InternalSession): void {
  const recorder = session.recorder;
  if (!recorder) return;
  const draftPath = recorder.draftPath;
  if (draftPath) session.handle.draftPath = draftPath;
  session.journal?.update({ lastActivityAt: new Date().toISOString() });
}

function endAccompanyJournal(
  session: InternalSession,
  reason: "ttl" | "close" | "shutdown",
  error?: string,
): void {
  const journal = session.journal;
  if (!journal || journal.snapshot.status !== "open") return;
  const now = new Date().toISOString();
  journal.append({
    ts: now,
    type: "session.closed",
    reason,
    ...(error ? { error: journal.redactText(error) } : {}),
  });
  journal.update({
    status: reason === "ttl" ? "expired" : "closed",
    closedAt: now,
    lastActivityAt: now,
  });
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
  if (session.recorder && session.parkedStep) {
    session.recorder.choose(
      session.parkedStep.index,
      session.parkedStep.id,
      locator,
      session.handle.lastSnapshot,
    );
  }
  session.handle.status = "running";
  session.handle.parked = undefined;
  session.gate = newGate();
  const resolveDecision = session.decision.resolve;
  session.decision = undefined;
  resolveDecision({ action: "retry", locator });
  await Promise.race([session.runPromise, session.gate.promise]);
  syncDecisions(session);
  return toOpenResult(session.handle);
}

export async function closeAllAccompany(): Promise<void> {
  const ids = [...registry.keys()];
  for (const id of ids) {
    await closeAccompany(id).catch(() => undefined);
  }
}

export async function closeAccompany(
  id: string,
  reason: "ttl" | "close" | "shutdown" = "close",
): Promise<void> {
  const session = registry.get(id);
  if (!session) return;
  registry.delete(id);
  syncDecisions(session);
  endAccompanyJournal(session, reason);
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
