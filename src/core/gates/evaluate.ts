import type { GateEvent } from "../schema/events.v1";
import {
  displayUrl,
  probeCommand,
  probeHttp,
  probeTcp,
  truncate,
  type ProbeContext,
  type ProbeOutcome,
} from "./probes";
import {
  DEFAULT_READY_STATUS,
  durationMs,
  isInlineGateString,
  type GateNode,
  type GateRef,
  type GateResult,
  type HttpStatusMatch,
} from "./schema";

/**
 * Gate evaluation: one `attempt()` walks the probe tree once (children of
 * `all` / `any` in parallel); `waitForGate` repeats attempts every `every`
 * until the gate passes `stable` consecutive times or its `timeout` budget
 * runs out. Every wait reports `gate.started` / `gate.attempt` /
 * `gate.passed` / `gate.failed` through `onEvent`.
 */

const DEFAULT_GATE_TIMEOUT_MS = 60_000;
const DEFAULT_GATE_EVERY_MS = 1_000;
/** Identical attempts are written at most this often (see GateAttemptEvent). */
const ATTEMPT_EVENT_INTERVAL_MS = 5_000;
const MAX_DETAIL_CHARS = 500;

/** An unknown gate name, a reference cycle, or an unusable inline gate. */
export class GateReferenceError extends Error {
  override name = "GateReferenceError";
}

export interface GateContext extends ProbeContext {
  /** The config's `gates:` registry. */
  registry?: Readonly<Record<string, GateNode>>;
  /**
   * Base directory for command probes of REGISTRY gates (the config's
   * directory); `cwd` stays the base of inline gates (e.g. the spec's).
   */
  registryCwd?: string;
  /** Event sink (gate.started / attempt / passed / failed). */
  onEvent?: (event: GateEvent) => void;
  /** Where the gate is waited on (`precondition`, `services.docker`, …). */
  scope?: string;
  /** Budget when the gate sets no `timeout` (default 60s; 0 = no deadline). */
  defaultTimeoutMs?: number;
  /** Pause between attempts when the gate sets no `every` (default 1s). */
  defaultEveryMs?: number;
  /** Status rule of `http(s)://` string refs (default 2xx/3xx). */
  urlStatus?: HttpStatusMatch;
  /** Accept any HTTP answer for `http(s)://` string refs (legacy readiness). */
  anyResponse?: boolean;
  /** Redaction for event details (the writer redacts again). */
  redact?: (text: string) => string;
}

/** Explicit overrides of the waited gate's own policy (`cairn wait` flags). */
interface GateWaitOverrides {
  timeoutMs?: number;
  everyMs?: number;
  stable?: number;
}

interface ResolvedGate {
  name: string;
  node: GateNode;
  /** Set when the name is a registry key (cycle detection). */
  registered?: boolean;
}

/** Every HTTP status class: the legacy "any answer means up" readiness. */
const ANY_HTTP_STATUS: HttpStatusMatch = ["1xx", "2xx", "3xx", "4xx", "5xx"];

function urlGate(url: string, ctx: GateContext): GateNode {
  const status = ctx.anyResponse ? ANY_HTTP_STATUS : ctx.urlStatus;
  return { http: status ? { url, status } : url };
}

function tcpGate(ref: string): GateNode {
  return { tcp: ref.replace(/^tcp:\/\//i, "").replace(/\/+$/, "") };
}

/** A short display name for an inline gate. */
function describeGate(node: GateNode): string {
  if (node.name) return node.name;
  if (node.gate) return node.gate;
  if (node.tcp !== undefined) {
    const tcp = node.tcp;
    return `tcp ${typeof tcp === "string" ? tcp : `${tcp.host}:${tcp.port}`}`;
  }
  if (node.http !== undefined) {
    const url = typeof node.http === "string" ? node.http : node.http.url;
    return displayUrl(url);
  }
  if (node.command !== undefined) {
    const run =
      typeof node.command === "string" ? node.command : node.command.run;
    return `command ${truncate(run, 40)}`;
  }
  if (node.all) return `all(${node.all.map(describeRef).join(", ")})`;
  if (node.any) return `any(${node.any.map(describeRef).join(", ")})`;
  return "gate";
}

function describeRef(ref: GateRef): string {
  if (typeof ref !== "string") return describeGate(ref);
  return isInlineGateString(ref) ? displayUrl(ref) : ref;
}

/**
 * Resolve a reference against the registry: a name, `http(s)://…`,
 * `tcp://host:port`, or an inline gate. Throws {@link GateReferenceError}.
 */
function resolveGateRef(ref: GateRef, ctx: GateContext): ResolvedGate {
  if (typeof ref !== "string") {
    if (ref.gate !== undefined && Object.keys(ref).length === 1) {
      return resolveGateRef(ref.gate, ctx);
    }
    return { name: truncate(describeGate(ref), 120), node: ref };
  }
  if (/^https?:\/\//i.test(ref)) {
    return { name: displayUrl(ref), node: urlGate(ref, ctx) };
  }
  if (/^tcp:\/\//i.test(ref)) {
    const node = tcpGate(ref);
    if (!/^(?:\[[^\]]+\]|[^\s:/]+):\d{1,5}$/.test(node.tcp as string)) {
      throw new GateReferenceError(
        `invalid tcp gate "${ref}" (want tcp://host:port)`,
      );
    }
    return { name: `tcp ${node.tcp as string}`, node };
  }
  const registry = ctx.registry ?? {};
  const node = Object.hasOwn(registry, ref) ? registry[ref] : undefined;
  if (!node) {
    const known = Object.keys(registry).toSorted();
    throw new GateReferenceError(
      `unknown gate "${ref}" (${
        known.length > 0
          ? `defined: ${known.join(", ")}`
          : "the config defines no gates:"
      })`,
    );
  }
  return { name: ref, node, registered: true };
}

/** Check that every reference resolves (names, cycles) before waiting. */
export function assertGateRefs(
  refs: readonly GateRef[],
  ctx: GateContext,
): void {
  const seen = new Set<string>();
  const walk = (ref: GateRef, stack: string[]): void => {
    if (typeof ref === "string" && !isInlineGateString(ref)) {
      if (stack.includes(ref)) {
        throw new GateReferenceError(
          `gate reference cycle: ${[...stack.slice(stack.indexOf(ref)), ref].join(" → ")}`,
        );
      }
      const { node } = resolveGateRef(ref, ctx);
      if (seen.has(ref)) return;
      seen.add(ref);
      walkNode(node, [...stack, ref]);
      return;
    }
    if (typeof ref === "string") {
      resolveGateRef(ref, ctx);
      return;
    }
    walkNode(ref, stack);
  };
  const walkNode = (node: GateNode, stack: string[]): void => {
    if (node.gate !== undefined) walk(node.gate, stack);
    for (const child of [...(node.all ?? []), ...(node.any ?? [])]) {
      walk(child, stack);
    }
  };
  for (const ref of refs) walk(ref, []);
}

interface AttemptOutcome {
  ok: boolean;
  detail: string;
}

/** Registry names on the path (cycle guard) and where command probes run. */
interface Frame {
  stack: string[];
  cwd: string | undefined;
}

/**
 * Stateful single-attempt evaluator of one gate tree. Stability counters
 * live per node object, so `stable` works at any depth: a child with
 * `stable: 3` only counts once it passed three attempts in a row. A node
 * reached twice in one tree (`full: {all: [stack, api]}` where `stack`
 * also needs `api`) is evaluated once per attempt, so its streak counts
 * attempts, not paths.
 */
class GateChecker {
  readonly name: string;
  readonly node: GateNode;
  private readonly rootFrame: Frame;
  private readonly registryCwd: string | undefined;
  private readonly streaks = new WeakMap<object, number>();
  private readonly stableOverride: number | undefined;
  private readonly singleLook: boolean;
  /** This attempt's outcome per node (see the class comment). */
  private visited = new Map<GateNode, Promise<AttemptOutcome>>();

  constructor(
    ref: GateRef,
    private readonly ctx: GateContext,
    /** One look: `stable` counts as 1 at every depth (liveness checks). */
    overrides: Pick<GateWaitOverrides, "stable"> & {
      singleLook?: boolean;
    } = {},
  ) {
    const resolved = resolveGateRef(ref, ctx);
    this.name = resolved.name;
    this.node = resolved.node;
    this.registryCwd = ctx.registryCwd ?? ctx.cwd;
    this.rootFrame = resolved.registered
      ? { stack: [resolved.name], cwd: this.registryCwd }
      : { stack: [], cwd: ctx.cwd };
    this.stableOverride = overrides.stable;
    this.singleLook = overrides.singleLook === true;
  }

  /** Evaluate the whole tree once within `budgetMs` (Infinity = per-probe defaults). */
  async attempt(budgetMs = Number.POSITIVE_INFINITY): Promise<AttemptOutcome> {
    this.visited = new Map();
    const outcome = await this.evalNode(
      this.node,
      this.rootFrame,
      budgetMs,
      true,
    );
    return {
      ok: outcome.ok,
      detail: truncate(this.redact(outcome.detail), MAX_DETAIL_CHARS),
    };
  }

  private redact(text: string): string {
    return this.ctx.redact ? this.ctx.redact(text) : text;
  }

  private async evalRef(
    ref: GateRef,
    frame: Frame,
    budgetMs: number,
  ): Promise<AttemptOutcome> {
    if (typeof ref === "string" && !isInlineGateString(ref)) {
      if (frame.stack.includes(ref)) {
        return { ok: false, detail: `gate reference cycle at "${ref}"` };
      }
      const { node } = resolveGateRef(ref, this.ctx);
      const inner = await this.evalNode(
        node,
        { stack: [...frame.stack, ref], cwd: this.registryCwd },
        budgetMs,
        false,
      );
      return { ok: inner.ok, detail: `${ref}: ${inner.detail}` };
    }
    const { node } = resolveGateRef(ref, this.ctx);
    return this.evalNode(node, frame, budgetMs, false);
  }

  private evalNode(
    node: GateNode,
    frame: Frame,
    budgetMs: number,
    top: boolean,
  ): Promise<AttemptOutcome> {
    let outcome = this.visited.get(node);
    if (!outcome) {
      outcome = this.evalNodeOnce(node, frame, budgetMs, top);
      this.visited.set(node, outcome);
    }
    return outcome;
  }

  private async evalNodeOnce(
    node: GateNode,
    frame: Frame,
    budgetMs: number,
    top: boolean,
  ): Promise<AttemptOutcome> {
    const raw = await this.rawNode(node, frame, budgetMs);
    const stable = this.singleLook
      ? 1
      : top
        ? (this.stableOverride ?? node.stable ?? 1)
        : (node.stable ?? 1);
    const streak = raw.ok ? (this.streaks.get(node) ?? 0) + 1 : 0;
    this.streaks.set(node, streak);
    if (!raw.ok || streak >= stable) return raw;
    return { ok: false, detail: `${raw.detail} (stable ${streak}/${stable})` };
  }

  private async rawNode(
    node: GateNode,
    frame: Frame,
    budgetMs: number,
  ): Promise<AttemptOutcome | ProbeOutcome> {
    // The last attempt right at the deadline still gets a usable slice (a
    // wait may overrun its budget by up to 250ms) instead of a starved one
    // that would replace a meaningful last detail with "no answer in 3ms".
    const probeBudget = Number.isFinite(budgetMs)
      ? Math.max(250, budgetMs)
      : Number.MAX_SAFE_INTEGER;
    if (node.tcp !== undefined) {
      return probeTcp(node.tcp, probeBudget, this.ctx.signal);
    }
    if (node.http !== undefined) {
      return probeHttp(node.http, probeBudget, this.probeCtx(frame));
    }
    if (node.command !== undefined) {
      return probeCommand(node.command, probeBudget, this.probeCtx(frame));
    }
    if (node.gate !== undefined) {
      return this.evalRef(node.gate, frame, budgetMs);
    }
    const children = node.all ?? node.any ?? [];
    const results = await Promise.all(
      children.map((child) => this.evalRef(child, frame, budgetMs)),
    );
    if (node.all) {
      const failed = results.filter((r) => !r.ok);
      if (failed.length === 0) {
        return {
          ok: true,
          detail:
            results.length === 1
              ? results[0]!.detail
              : `all ${results.length} ok`,
        };
      }
      return {
        ok: false,
        detail: `${failed.length}/${results.length} not ready: ${failed
          .map((r) => r.detail)
          .join("; ")}`,
      };
    }
    const passed = results.find((r) => r.ok);
    if (passed) return { ok: true, detail: passed.detail };
    return {
      ok: false,
      detail: `none of ${results.length} ready: ${results.map((r) => r.detail).join("; ")}`,
    };
  }

  private probeCtx(frame: Frame): ProbeContext & {
    defaultStatus?: HttpStatusMatch;
  } {
    return {
      ...(this.ctx.env ? { env: this.ctx.env } : {}),
      ...(frame.cwd ? { cwd: frame.cwd } : {}),
      ...(this.ctx.signal ? { signal: this.ctx.signal } : {}),
      defaultStatus: DEFAULT_READY_STATUS,
    };
  }
}

/**
 * One look at a gate (no waiting; `stable` is ignored at every depth):
 * liveness checks of a reused environment.
 */
export async function checkGateOnce(
  ref: GateRef,
  ctx: GateContext,
): Promise<AttemptOutcome & { name: string }> {
  const checker = new GateChecker(ref, ctx, { singleLook: true });
  const outcome = await checker.attempt();
  return { name: checker.name, ...outcome };
}

function sleepUnlessAborted(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolveSleep) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolveSleep();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** The waited gate's budget and cadence after overrides and defaults. */
function gatePolicy(
  node: GateNode,
  ctx: GateContext,
  overrides: GateWaitOverrides = {},
): { budgetMs: number; everyMs: number; stable: number } {
  return {
    budgetMs:
      overrides.timeoutMs ??
      durationMs(node.timeout) ??
      ctx.defaultTimeoutMs ??
      DEFAULT_GATE_TIMEOUT_MS,
    everyMs: Math.max(
      10,
      overrides.everyMs ??
        durationMs(node.every) ??
        ctx.defaultEveryMs ??
        DEFAULT_GATE_EVERY_MS,
    ),
    stable: overrides.stable ?? node.stable ?? 1,
  };
}

/**
 * The event side of one wait: `gate.started` on construction, coalesced
 * `gate.attempt`s, and `gate.passed` / `gate.failed` from `finish`. Callers
 * with their own polling loop (tmux `readyOn.gate`) drive it directly.
 */
export class GateWatch {
  readonly name: string;
  readonly budgetMs: number;
  attempts = 0;
  lastDetail = "not attempted";
  private readonly startedAt = Date.now();
  private lastEmitted: { ok: boolean; detail: string; at: number } | undefined;

  constructor(
    private readonly checker: GateChecker,
    private readonly ctx: GateContext,
    policy: { budgetMs: number; everyMs: number; stable: number },
  ) {
    this.name = checker.name;
    this.budgetMs = policy.budgetMs;
    this.emit({
      ts: new Date(this.startedAt).toISOString(),
      type: "gate.started",
      name: this.name,
      budgetMs: policy.budgetMs,
      everyMs: policy.everyMs,
      ...(policy.stable > 1 ? { stable: policy.stable } : {}),
      ...this.scope(),
    });
  }

  private scope(): { scope?: string } {
    return this.ctx.scope ? { scope: this.ctx.scope } : {};
  }

  private emit(event: GateEvent): void {
    try {
      this.ctx.onEvent?.(event);
    } catch {
      // An observer must never break the wait.
    }
  }

  /** One attempt (bounded by `remainingMs`), reported coalesced. */
  async attempt(
    remainingMs = Number.POSITIVE_INFINITY,
  ): Promise<AttemptOutcome> {
    this.attempts += 1;
    const outcome = await this.checker.attempt(remainingMs);
    this.lastDetail = outcome.detail;
    const now = Date.now();
    const last = this.lastEmitted;
    if (
      !last ||
      outcome.ok ||
      last.ok !== outcome.ok ||
      last.detail !== outcome.detail ||
      now - last.at >= ATTEMPT_EVENT_INTERVAL_MS
    ) {
      this.lastEmitted = { ok: outcome.ok, detail: outcome.detail, at: now };
      this.emit({
        ts: new Date(now).toISOString(),
        type: "gate.attempt",
        name: this.name,
        attempt: this.attempts,
        ok: outcome.ok,
        detail: outcome.detail,
        ...this.scope(),
      });
    }
    return outcome;
  }

  /** Settle the wait: `gate.passed` / `gate.failed` and the result. Idempotent. */
  finish(
    ok: boolean,
    extra: { timedOut?: boolean; cancelled?: boolean; detail?: string } = {},
  ): GateResult {
    if (this.settled) return this.settled;
    this.settled = this.settle(ok, extra);
    return this.settled;
  }

  private settled: GateResult | undefined;

  private settle(
    ok: boolean,
    extra: { timedOut?: boolean; cancelled?: boolean; detail?: string },
  ): GateResult {
    if (extra.detail !== undefined) this.lastDetail = extra.detail;
    const elapsedMs = Math.max(0, Date.now() - this.startedAt);
    const flags = ok
      ? {}
      : {
          ...(extra.timedOut ? { timedOut: true } : {}),
          ...(extra.cancelled ? { cancelled: true } : {}),
        };
    const end = {
      ts: new Date().toISOString(),
      name: this.name,
      attempts: this.attempts,
      durationMs: elapsedMs,
      lastDetail: this.lastDetail,
      ...this.scope(),
    };
    this.emit(
      ok
        ? { ...end, type: "gate.passed" }
        : { ...end, type: "gate.failed", ...flags },
    );
    return {
      name: this.name,
      ok,
      attempts: this.attempts,
      durationMs: elapsedMs,
      budgetMs: this.budgetMs,
      lastDetail: this.lastDetail,
      ...flags,
    };
  }
}

/** Start watching a gate (resolves the reference; emits `gate.started`). */
export function watchGate(
  ref: GateRef,
  ctx: GateContext,
  overrides: GateWaitOverrides = {},
): { watch: GateWatch; everyMs: number; budgetMs: number } {
  const checker = new GateChecker(ref, ctx, overrides);
  const policy = gatePolicy(checker.node, ctx, overrides);
  return {
    watch: new GateWatch(checker, ctx, policy),
    everyMs: policy.everyMs,
    budgetMs: policy.budgetMs,
  };
}

/**
 * Wait for one gate. Never throws for a gate that is not ready (the result
 * says so); throws {@link GateReferenceError} for an unknown name.
 */
export async function waitForGate(
  ref: GateRef,
  ctx: GateContext,
  overrides: GateWaitOverrides = {},
): Promise<GateResult> {
  const { watch, everyMs, budgetMs } = watchGate(ref, ctx, overrides);
  const deadline =
    budgetMs > 0 ? Date.now() + budgetMs : Number.POSITIVE_INFINITY;
  for (;;) {
    if (ctx.signal?.aborted) {
      return watch.finish(false, {
        cancelled: true,
        ...(watch.attempts === 0
          ? { detail: "cancelled before the first attempt" }
          : {}),
      });
    }
    const outcome = await watch.attempt(deadline - Date.now());
    if (outcome.ok) return watch.finish(true);
    if (ctx.signal?.aborted) return watch.finish(false, { cancelled: true });
    const now = Date.now();
    if (now >= deadline) return watch.finish(false, { timedOut: true });
    await sleepUnlessAborted(Math.min(everyMs, deadline - now), ctx.signal);
  }
}

/**
 * Wait for several gates in order, stopping at the first that is not ready.
 * Unknown names are reported before any wait starts.
 */
export async function waitForGates(
  refs: readonly GateRef[],
  ctx: GateContext,
  overrides: GateWaitOverrides = {},
): Promise<GateResult[]> {
  assertGateRefs(refs, ctx);
  const results: GateResult[] = [];
  for (const ref of refs) {
    const result = await waitForGate(ref, ctx, overrides);
    results.push(result);
    if (!result.ok) break;
  }
  return results;
}

/** One-line summary of a failed wait, for errors and run failures. */
export function gateFailureMessage(result: GateResult): string {
  const why = result.cancelled
    ? "cancelled"
    : result.timedOut
      ? `not ready within ${result.budgetMs}ms`
      : "not ready";
  return `gate "${result.name}" ${why} after ${result.attempts} attempt(s): ${result.lastDetail}`;
}
