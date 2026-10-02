import type { RunInvocationState } from "../../core/schema/runInvocation.v1";
import {
  startRunInvocation,
  type RunInvocationHandle,
  type RunInvocationIO,
  type RunInvocationRequest,
  type RunInvocationResult,
} from "./executeRunInvocation";

/**
 * In-process registry of run invocations for a long-lived host (the MCP
 * server): invocations outlive the tool call that started them, can be
 * polled and cancelled by id, and share one environment lock so two agents
 * never boot the same services/webServer stack at once.
 */

/** One tracked invocation. */
export interface RegisteredInvocation {
  readonly id: string;
  readonly handle: RunInvocationHandle;
  readonly startedAt: string;
  readonly origin: RunInvocationIO["origin"];
  readonly client?: string;
  /** Settles (never rejects) when the invocation and its teardown finished. */
  readonly settled: Promise<void>;
  cancelRequested: boolean;
  result?: RunInvocationResult;
  /** The engine threw (a bug): the invocation is errored with this message. */
  failure?: string;
  journalDir?: string;
  artifactRoot?: string;
}

/** Settled invocations kept for status queries before the oldest is dropped. */
const MAX_SETTLED = 200;

/**
 * Invocations one registry (one MCP server) runs at once. Each can hold
 * `parallel` browsers; past the cap `start` refuses instead of letting one
 * client fork browsers without bound.
 */
export const MAX_RUNNING_INVOCATIONS = 8;

/** `start` refused: the registry already runs its maximum. */
export class RegistryFullError extends Error {
  constructor(readonly limit: number) {
    super(
      `this server already runs ${limit} invocations (the maximum); wait for one to settle (cairn_run_status) or cancel one (cairn_run_cancel)`,
    );
    this.name = "RegistryFullError";
  }
}

/**
 * FIFO mutex per key. `acquire` resolves with a release function once every
 * earlier holder of the key released it; an aborted waiter leaves the queue
 * without blocking the ones behind it.
 *
 * Each acquirer appends one link to the key's chain: its link settles only
 * after the previous link settled AND it released. An aborted waiter
 * releases its own slot at once, but its link still waits for the links
 * before it, so whoever queued behind it keeps waiting for the real holder.
 * The chain entry is dropped only once the newest link settled.
 */
export class KeyedLock {
  private readonly tails = new Map<string, Promise<void>>();
  private readonly holders = new Map<string, string[]>();

  async acquire(
    key: string,
    owner: string,
    options: {
      signal?: AbortSignal;
      onWait?: (holder: string | undefined) => void;
    } = {},
  ): Promise<() => void> {
    const previous = this.tails.get(key);
    let release!: () => void;
    const mine = new Promise<void>((resolveMine) => {
      release = resolveMine;
    });
    const tail = (previous ?? Promise.resolve()).then(() => mine);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    const queue = this.holders.get(key) ?? [];
    queue.push(owner);
    this.holders.set(key, queue);
    let released = false;
    const releaseOnce = (): void => {
      if (released) return;
      released = true;
      const owners = this.holders.get(key);
      const at = owners?.indexOf(owner) ?? -1;
      if (owners && at >= 0) owners.splice(at, 1);
      if (owners?.length === 0) this.holders.delete(key);
      release();
    };
    if (previous) {
      options.onWait?.(queue[0] === owner ? undefined : queue[0]);
      try {
        await abortable(previous, options.signal);
      } catch (error) {
        releaseOnce();
        throw error;
      }
    }
    return releaseOnce;
  }

  /** The owner currently holding `key`, if any. */
  holder(key: string): string | undefined {
    return this.holders.get(key)?.[0];
  }
}

function abortable(
  promise: Promise<void>,
  signal?: AbortSignal,
): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) {
    return Promise.reject(
      new Error("cancelled while waiting for the services environment"),
    );
  }
  return new Promise<void>((resolveWait, rejectWait) => {
    const onAbort = (): void =>
      rejectWait(
        new Error("cancelled while waiting for the services environment"),
      );
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolveWait();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        rejectWait(error);
      },
    );
  });
}

/** Live/settled state of a registered invocation. */
export function invocationState(
  entry: RegisteredInvocation,
): RunInvocationState {
  if (entry.failure !== undefined) return "errored";
  const result = entry.result;
  if (!result) return entry.cancelRequested ? "cancelling" : "running";
  if (result.aborted) return "aborted";
  if (result.exitCode === 0) return "passed";
  // Exit 7 (the environment policy refused what was asked) did not run it:
  // "failed" like the invocation journal, not an infrastructure error.
  if (result.exitCode === 1 || result.exitCode === 7) return "failed";
  return "errored";
}

export class RunInvocationRegistry {
  private readonly entries = new Map<string, RegisteredInvocation>();
  private readonly controllers = new Map<string, AbortController>();
  readonly environmentLock = new KeyedLock();
  private readonly maxRunning: number;

  constructor(options: { maxRunning?: number } = {}) {
    this.maxRunning = Math.max(
      1,
      options.maxRunning ?? MAX_RUNNING_INVOCATIONS,
    );
  }

  /**
   * Start an invocation and track it. The registry owns its AbortSignal and
   * the environment lock; everything else comes from `io`. Throws
   * {@link RegistryFullError} when the registry already runs its maximum.
   */
  start(
    request: RunInvocationRequest,
    io: Omit<RunInvocationIO, "signal" | "environmentLock">,
  ): RegisteredInvocation {
    const running = this.list().filter(
      (entry) => !entry.result && entry.failure === undefined,
    ).length;
    if (running >= this.maxRunning)
      throw new RegistryFullError(this.maxRunning);
    const controller = new AbortController();
    let id = "";
    const handle = startRunInvocation(request, {
      ...io,
      signal: controller.signal,
      environmentLock: (key, options) =>
        this.environmentLock.acquire(key, id, options),
    });
    id = handle.invocationId;
    const entry: RegisteredInvocation = {
      id,
      handle,
      startedAt: new Date().toISOString(),
      origin: io.origin,
      ...(io.client ? { client: io.client } : {}),
      cancelRequested: false,
      settled: handle.result.then(
        (result) => {
          entry.result = result;
          if (result.journalDir) entry.journalDir = result.journalDir;
          if (result.artifactRoot) entry.artifactRoot = result.artifactRoot;
          this.prune();
        },
        (error: unknown) => {
          entry.failure = (error as Error)?.message ?? String(error);
          this.prune();
        },
      ),
    };
    void handle.started.then((started) => {
      if (started.journalDir) entry.journalDir = started.journalDir;
      if (started.artifactRoot) entry.artifactRoot = started.artifactRoot;
    });
    this.entries.set(id, entry);
    this.controllers.set(id, controller);
    return entry;
  }

  get(id: string): RegisteredInvocation | undefined {
    return this.entries.get(id);
  }

  list(): RegisteredInvocation[] {
    return [...this.entries.values()];
  }

  /**
   * Request a graceful cancel (idempotent). Returns the entry, or undefined
   * when this registry does not own the invocation.
   */
  cancel(id: string): RegisteredInvocation | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    if (!entry.result && entry.failure === undefined) {
      entry.cancelRequested = true;
      this.controllers.get(id)?.abort();
    }
    return entry;
  }

  /** Gracefully cancel every running invocation (server shutdown). */
  shutdown(): Promise<void> {
    const running = this.list().filter(
      (entry) => !entry.result && entry.failure === undefined,
    );
    for (const entry of running) this.cancel(entry.id);
    return Promise.all(running.map((entry) => entry.settled)).then(
      () => undefined,
    );
  }

  /** Process-exit path: synchronous emergency teardown of every invocation. */
  terminateAllSync(signal: "SIGINT" | "SIGTERM"): void {
    for (const entry of this.entries.values()) {
      if (entry.result || entry.failure !== undefined) continue;
      try {
        entry.handle.terminateSync(signal);
        // Keep the (still running) engine from relaunching a browser: every
        // later browser call now fails fast and the invocation winds down.
        entry.cancelRequested = true;
        this.controllers.get(entry.id)?.abort();
      } catch {
        // Keep terminating the remaining invocations.
      }
    }
  }

  /** Drop the oldest settled entries beyond {@link MAX_SETTLED}. */
  private prune(): void {
    const settled = this.list().filter(
      (entry) => entry.result || entry.failure !== undefined,
    );
    for (const entry of settled.slice(
      0,
      Math.max(0, settled.length - MAX_SETTLED),
    )) {
      this.entries.delete(entry.id);
      this.controllers.delete(entry.id);
    }
  }
}
