// @thelacanians/cairntrace/verifier — the typed verifier SDK.
//
//   import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";
//
//   export default defineVerifier({
//     description: "The order appears in the orders API",
//     fixtures: z.object({ orderId: z.string(), expectedCount: z.number().default(1) }),
//     async run(ctx) {
//       const rows = await ctx.poll(() => ctx.datasources.app.find("orders", { id: ctx.fixtures.orderId }), {
//         until: (r) => r.length === ctx.fixtures.expectedCount,
//         within: 30_000,
//       });
//       return ctx.result.ok({ rows: rows.length });
//     },
//   });
//
// defineVerifier() returns a plain `verify(ctx)` function, so the Node
// bootstrap that has always called `export default async function verify(ctx)`
// runs SDK verifiers unchanged; the function builds the rich context from the
// legacy one. Plain ESM JavaScript on purpose: this file runs inside the Node
// child of a `script.runtime: node` verifier, and Node does not strip
// TypeScript from files under node_modules. Types live in verifier.d.ts.

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import process from "node:process";
import { z } from "zod";
import { readWorkbook } from "./workbook.js";

export { z };

/** Wire protocol between the runner and this SDK (ctx.runtime.protocol). */
export const SDK_PROTOCOL = 1;

const VERIFIER = Symbol.for("cairntrace.verifier");
const FAILURE = Symbol.for("cairntrace.verifier.failure");
const DEFAULT_POLL_WITHIN_MS = 30_000;
const DEFAULT_POLL_EVERY_MS = 1_000;
// `every: 0` would spin; attempts are at least this far apart.
const MIN_POLL_EVERY_MS = 50;
// An attempt started at the very end of `within` still gets max(every, 1s).
const MIN_LAST_ATTEMPT_MS = 1_000;
const DEFAULT_CANCEL_GRACE_MS = 1_000;
// Attempt log kept in evidence: the first 5 and the last 15 (as typed polls).
const LOG_HEAD = 5;
const LOG_TAIL = 15;
const MAX_ROWS = 20;
const MAX_ROW_BYTES = 4_096;
const MAX_SUMMARY = 160;

/**
 * A check that did not hold. Throw it (or call `ctx.fail`) anywhere inside
 * `run(ctx)`: the verifier reports a failed outcome with `message` as the
 * observed value and `details` in outcomes/<id>.raw.json — not a crash.
 */
export class VerifierFailure extends Error {
  /** @param {string} message @param {unknown} [details] */
  constructor(message, details) {
    super(message);
    this.name = "VerifierFailure";
    this.details = details;
    Object.defineProperty(this, FAILURE, { value: true });
  }
}

/** `ctx.poll` ran out of budget (or hit `failWhen`) — carries the last observation. */
export class PollTimeoutError extends VerifierFailure {
  /**
   * @param {string} message
   * @param {{ observation?: unknown, attempts: number, polledMs: number, history: unknown[], lastError?: string, reason: string }} info
   */
  constructor(message, info) {
    super(message, {
      reason: info.reason,
      observed: bounded(info.observation),
      attempts: info.history,
      attemptCount: info.attempts,
      polledMs: info.polledMs,
      ...(info.lastError ? { lastError: info.lastError } : {}),
    });
    this.name = "PollTimeoutError";
    this.observation = info.observation;
    this.attempts = info.attempts;
    this.polledMs = info.polledMs;
  }
}

/**
 * Declare a typed verifier.
 * @param {{ description?: string, fixtures?: import("zod").ZodTypeAny, run: (ctx: any) => unknown }} definition
 */
export function defineVerifier(definition) {
  if (!definition || typeof definition !== "object") {
    throw new TypeError("defineVerifier({ fixtures, run }) expects an object");
  }
  if (typeof definition.run !== "function") {
    throw new TypeError("defineVerifier: `run(ctx)` must be a function");
  }
  const schema = definition.fixtures;
  if (schema !== undefined && typeof schema?.safeParse !== "function") {
    throw new TypeError(
      "defineVerifier: `fixtures` must be a zod schema (z.object({ … }))",
    );
  }
  if (schema !== undefined && "_zod" in schema) {
    // zod v4 schemas parse, but the coercion of YAML strings and the
    // rejection of unknown keys read zod v3 internals: they would silently
    // switch off. Refuse instead.
    throw new TypeError(
      'defineVerifier: `fixtures` is a zod v4 schema; build it with the z re-exported by "@thelacanians/cairntrace/verifier" (zod v3)',
    );
  }
  const description =
    typeof definition.description === "string"
      ? definition.description
      : undefined;

  async function verify(rawCtx) {
    return executeVerifier(definition, schema, rawCtx ?? {});
  }
  Object.defineProperty(verify, VERIFIER, {
    value: Object.freeze({ protocol: SDK_PROTOCOL, description, schema }),
  });
  return verify;
}

/**
 * The fixtures contract of a value returned by defineVerifier(), or null for
 * anything else. Used by `cairn verifier schema --load`.
 * @param {unknown} value
 */
export function inspectVerifier(value) {
  const meta =
    typeof value === "function" /** @type {any} */ ? value[VERIFIER] : null;
  if (!meta) return null;
  return {
    protocol: meta.protocol,
    ...(meta.description ? { description: meta.description } : {}),
    fixtures: describeFixtures(meta.schema),
  };
}

/**
 * Describe a fixtures schema as `{ strict, dynamic, keys }` (the same shape
 * `cairn verifier schema` extracts statically).
 * @param {import("zod").ZodTypeAny | undefined} schema
 */
export function describeFixtures(schema) {
  if (!schema) return { strict: false, dynamic: false, keys: [] };
  const parts = objectParts(schema);
  if (!parts) {
    return {
      strict: false,
      dynamic: true,
      keys: [],
      reason:
        "the fixtures schema is not a z.object() (or an intersection of them)",
    };
  }
  return {
    strict: !parts.some(acceptsUnknownKeys),
    dynamic: false,
    keys: Object.entries(mergedShape(parts)).map(([name, type]) =>
      describeKey(name, type),
    ),
  };
}

/* ------------------------------------------------------------------ */
/* execution                                                           */
/* ------------------------------------------------------------------ */

async function executeVerifier(definition, schema, rawCtx) {
  const meta = isRecord(rawCtx.runtime) ? rawCtx.runtime : {};
  const runtime = createRuntime(meta);
  try {
    const parsed = parseFixtures(schema, rawCtx.fixtures);
    if (!parsed.ok) {
      return {
        sdk: SDK_PROTOCOL,
        ok: false,
        message: parsed.message,
        evidence: { message: parsed.message, issues: parsed.issues },
      };
    }
    const ctx = buildContext(rawCtx, parsed.value, meta, runtime);
    // run(ctx) settles, or the deadline passes and the verifier reports why
    // instead of waiting for the runner's hard kill.
    const settled = await Promise.race([
      new Promise((resolve) => resolve(definition.run(ctx))).then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      runtime.late,
    ]);
    if (settled.late) {
      const message = `run(ctx) was still running at the verifier deadline (script.timeoutMs ${runtime.timeoutMs}ms); pass ctx.signal to slow calls or poll with ctx.poll`;
      return runtime.withStats(failureResult(message, { reason: "deadline" }));
    }
    if ("error" in settled) {
      if (isFailure(settled.error)) {
        return runtime.withStats(
          failureResult(settled.error.message, settled.error.details),
        );
      }
      throw settled.error;
    }
    return runtime.withStats(normalizeResult(settled.value));
  } finally {
    runtime.dispose();
  }
}

function normalizeResult(out) {
  if (typeof out === "boolean") {
    return { sdk: SDK_PROTOCOL, ok: out, evidence: null };
  }
  if (isRecord(out) && typeof out.ok === "boolean") {
    return {
      sdk: SDK_PROTOCOL,
      ok: out.ok,
      evidence: out.evidence === undefined ? null : out.evidence,
      ...(typeof out.message === "string" ? { message: out.message } : {}),
    };
  }
  const message = `run(ctx) must return ctx.result.ok(…) or ctx.result.fail(…), got ${
    out === null ? "null" : typeof out
  }`;
  return { sdk: SDK_PROTOCOL, ok: false, message, evidence: { message } };
}

function failureResult(message, details) {
  return {
    sdk: SDK_PROTOCOL,
    ok: false,
    message,
    evidence: mergeMessage(message, details),
  };
}

function mergeMessage(message, details) {
  if (details === undefined) return { message };
  if (isRecord(details)) return { message, ...details };
  return { message, details };
}

/** Deadline, cancellation and poll statistics for one verifier invocation. */
function createRuntime(meta) {
  const controller = new AbortController();
  const startedAtMs =
    typeof meta.startedAtMs === "number" ? meta.startedAtMs : Date.now();
  const timeoutMs =
    typeof meta.timeoutMs === "number" && meta.timeoutMs > 0
      ? meta.timeoutMs
      : undefined;
  // Leave the verifier a margin before the runner's hard kill so a poll can
  // still turn its last observation into evidence.
  const margin = timeoutMs
    ? Math.min(2_000, Math.max(250, Math.round(timeoutMs * 0.05)))
    : 0;
  const deadline = timeoutMs ? startedAtMs + timeoutMs - margin : undefined;
  const timers = [];
  // Resolves { late: true } half the margin after the deadline: run(ctx)
  // did not settle even with ctx.signal aborted.
  let markLate;
  const late = new Promise((resolve) => {
    markLate = () => resolve({ late: true });
  });
  if (deadline !== undefined) {
    // Referenced on purpose: a run(ctx) stuck on a promise nothing else keeps
    // alive still reaches the deadline and reports, instead of exiting
    // without a result. dispose() clears them once run settles.
    timers.push(
      setTimeout(
        () => {
          controller.abort(
            new Error(
              `verifier deadline reached (script.timeoutMs ${timeoutMs}ms)`,
            ),
          );
          timers.push(
            setTimeout(markLate, Math.max(50, Math.floor(margin / 2))),
          );
        },
        Math.max(0, deadline - Date.now()),
      ),
    );
  }
  const graceMs =
    typeof meta.cancelGraceMs === "number" && meta.cancelGraceMs >= 0
      ? meta.cancelGraceMs
      : DEFAULT_CANCEL_GRACE_MS;
  const hardDeadline = timeoutMs ? startedAtMs + timeoutMs : undefined;
  const onSignal = (name) => {
    // The runner's own timeout kill (SIGTERM at script.timeoutMs): the grace
    // window is for cancellation, not for overrunning the budget.
    if (hardDeadline !== undefined && Date.now() >= hardDeadline) {
      process.exit(name === "SIGINT" ? 130 : 143);
    }
    if (!controller.signal.aborted) {
      controller.abort(new Error(`verifier cancelled (${name})`));
    }
    // Give run(ctx) the grace window to clean up, then leave before the
    // runner's SIGKILL; an unref'd timer never holds an idle child open.
    const exit = setTimeout(
      () => process.exit(name === "SIGINT" ? 130 : 143),
      Math.max(0, graceMs - 100),
    );
    exit.unref?.();
  };
  const signals = ["SIGTERM", "SIGINT"];
  for (const name of signals) process.on(name, onSignal);
  const stats = { attempts: 0, polledMs: 0, polls: 0 };
  return {
    signal: controller.signal,
    deadline,
    timeoutMs,
    late,
    stats,
    remainingMs() {
      return deadline === undefined
        ? Number.POSITIVE_INFINITY
        : Math.max(0, deadline - Date.now());
    },
    withStats(result) {
      return stats.polls > 0
        ? { ...result, attempts: stats.attempts, polledMs: stats.polledMs }
        : result;
    },
    dispose() {
      for (const timer of timers) clearTimeout(timer);
      for (const name of signals) process.off(name, onSignal);
    },
  };
}

/* ------------------------------------------------------------------ */
/* fixtures                                                            */
/* ------------------------------------------------------------------ */

function parseFixtures(schema, raw) {
  const input = isRecord(raw) ? { ...raw } : {};
  if (!schema) return { ok: true, value: input };
  const parts = objectParts(schema);
  const issues = [];
  if (parts) {
    const shape = mergedShape(parts);
    coerceFixtures(shape, input);
    if (!parts.some(acceptsUnknownKeys)) {
      const unknown = Object.keys(input).filter(
        (key) => !Object.hasOwn(shape, key),
      );
      const zodRejects = parts.some(
        (part) => defOf(part)?.unknownKeys === "strict",
      );
      if (unknown.length > 0 && !zodRejects) {
        // zod's default `strip` would drop a misspelled key silently; the
        // contract rejects it (use .passthrough() to accept extra keys).
        issues.push({
          path: unknown.join(", "),
          code: "unrecognized_keys",
          message: `unknown fixture key(s): ${unknown.join(", ")} (known: ${
            Object.keys(shape).join(", ") || "none"
          })`,
        });
      }
    }
  }
  const result = schema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push({
        path: issue.path.join(".") || "(fixtures)",
        code: issue.code,
        message:
          issue.code === "unrecognized_keys" && Array.isArray(issue.keys)
            ? `unknown fixture key(s): ${issue.keys.join(", ")}`
            : issue.code === "invalid_enum_value" &&
                Array.isArray(issue.options)
              ? // zod's own message echoes the received value.
                `Invalid enum value. Expected ${issue.options
                  .map((o) => `'${String(o)}'`)
                  .join(" | ")}`
              : issue.code === "invalid_type" &&
                  issue.expected === "array" &&
                  issue.received === "string"
                ? `${issue.message} (write a YAML list, not a delimited string)`
                : issue.message,
      });
    }
  }
  if (issues.length > 0) {
    const message = `fixtures do not match the verifier's contract: ${issues
      .map((issue) =>
        issue.code === "unrecognized_keys"
          ? issue.message
          : `${issue.path}: ${issue.message}`,
      )
      .join("; ")}`;
    return { ok: false, message, issues };
  }
  return { ok: true, value: result.data };
}

/**
 * YAML authors and `${vars.X}` interpolation hand fixtures over as strings.
 * Convert a string to the type the contract declares for that key: numbers,
 * "true"/"false", ISO dates, and JSON text for arrays/objects. An empty
 * string for an optional non-string key counts as absent, so the default
 * applies (`${vars.X:-}` → "").
 */
function coerceFixtures(shape, input) {
  for (const [key, value] of Object.entries(input)) {
    const type = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (!type || typeof value !== "string") continue;
    const { base, optional } = unwrap(type);
    const kind = typeName(base);
    const text = value.trim();
    if (text === "" && optional && kind !== "ZodString") {
      delete input[key];
      continue;
    }
    if (kind === "ZodNumber" && text !== "" && Number.isFinite(Number(text))) {
      input[key] = Number(text);
    } else if (kind === "ZodBoolean" && /^(true|false)$/i.test(text)) {
      input[key] = text.toLowerCase() === "true";
    } else if (kind === "ZodDate" && !Number.isNaN(Date.parse(text))) {
      input[key] = new Date(text);
    } else if (
      (kind === "ZodArray" ||
        kind === "ZodObject" ||
        kind === "ZodRecord" ||
        kind === "ZodTuple") &&
      /^[[{]/.test(text)
    ) {
      try {
        input[key] = JSON.parse(text);
      } catch {
        // Leave it: the schema reports the mismatch.
      }
    }
  }
}

/** zod v3 keeps a schema's definition on `_def`. */
function defOf(schema) {
  return schema?.["_def"];
}

function typeName(schema) {
  return defOf(schema)?.typeName;
}

const WRAPPERS = new Set([
  "ZodOptional",
  "ZodDefault",
  "ZodNullable",
  "ZodCatch",
  "ZodReadonly",
  "ZodBranded",
  "ZodEffects",
  "ZodLazy",
  "ZodPipeline",
]);

/** Peel wrappers: the base schema plus what the wrappers said. */
function unwrap(schema) {
  let current = schema;
  let optional = false;
  let defaultValue;
  let hasDefault = false;
  let description;
  for (let depth = 0; depth < 32 && current; depth++) {
    description ??= current.description ?? defOf(current)?.description;
    const kind = typeName(current);
    if (!WRAPPERS.has(kind)) break;
    const def = defOf(current);
    if (kind === "ZodOptional" || kind === "ZodCatch") optional = true;
    if (kind === "ZodDefault") {
      optional = true;
      if (!hasDefault) {
        hasDefault = true;
        try {
          defaultValue = def.defaultValue();
        } catch {
          defaultValue = undefined;
        }
      }
    }
    current =
      kind === "ZodEffects"
        ? def.schema
        : kind === "ZodBranded"
          ? def.type
          : kind === "ZodLazy"
            ? def.getter()
            : kind === "ZodPipeline"
              ? def.in
              : def.innerType;
  }
  return { base: current, optional, hasDefault, defaultValue, description };
}

/**
 * The z.object()s a fixtures schema is made of: one, or every side of an
 * intersection (`a.and(b)`); undefined for anything else (a union, …).
 */
function objectParts(schema, depth = 0) {
  if (depth > 8) return undefined;
  const { base } = unwrap(schema);
  const kind = typeName(base);
  if (kind === "ZodObject") return [base];
  if (kind === "ZodIntersection") {
    const left = objectParts(defOf(base).left, depth + 1);
    const right = objectParts(defOf(base).right, depth + 1);
    return left && right ? [...left, ...right] : undefined;
  }
  return undefined;
}

function objectShape(object) {
  const shape = object.shape ?? defOf(object)?.shape?.();
  return isRecord(shape) ? shape : {};
}

function mergedShape(parts) {
  return Object.assign({}, ...parts.map(objectShape));
}

function acceptsUnknownKeys(object) {
  const def = defOf(object) ?? {};
  return (
    def.unknownKeys === "passthrough" ||
    (def.catchall !== undefined && typeName(def.catchall) !== "ZodNever")
  );
}

function describeKey(name, type) {
  const info = unwrap(type);
  let optional = info.optional;
  try {
    // zod's own answer: a key whose schema accepts undefined (z.any(), a
    // union with z.undefined(), …) may be left out.
    if (typeof type.isOptional === "function") optional = type.isOptional();
  } catch {
    // A refinement that throws on undefined: keep the wrapper reading.
  }
  const key = {
    name,
    type: typeLabel(info.base),
    required: !optional,
  };
  if (info.hasDefault && isJsonSafe(info.defaultValue)) {
    key.default = toJson(info.defaultValue);
  }
  if (typeof info.description === "string" && info.description) {
    key.description = info.description;
  }
  const values = enumValues(info.base);
  if (values) key.values = values;
  return key;
}

function typeLabel(schema, depth = 0) {
  if (depth > 6) return "unknown";
  const kind = typeName(schema);
  switch (kind) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBigInt":
      return "bigint";
    case "ZodBoolean":
      return "boolean";
    case "ZodDate":
      return "date";
    case "ZodObject":
      return "object";
    case "ZodRecord":
      return "record";
    case "ZodTuple":
      return "tuple";
    case "ZodEnum":
    case "ZodNativeEnum":
      return "enum";
    case "ZodLiteral":
      return "literal";
    case "ZodNull":
      return "null";
    case "ZodUndefined":
      return "undefined";
    case "ZodVoid":
      return "void";
    case "ZodAny":
      return "any";
    case "ZodIntersection":
      return [defOf(schema).left, defOf(schema).right]
        .map((side) => typeLabel(unwrap(side).base, depth + 1))
        .join(" & ");
    case "ZodArray": {
      const inner = typeLabel(unwrap(defOf(schema).type).base, depth + 1);
      return inner.includes(" | ") ? `(${inner})[]` : `${inner}[]`;
    }
    case "ZodUnion":
    case "ZodDiscriminatedUnion": {
      const options = defOf(schema).options;
      const list = Array.isArray(options)
        ? options
        : [...(options?.values?.() ?? [])];
      return list.map((o) => typeLabel(unwrap(o).base, depth + 1)).join(" | ");
    }
    default:
      return "unknown";
  }
}

function enumValues(schema) {
  const kind = typeName(schema);
  const def = defOf(schema);
  if (kind === "ZodEnum" && Array.isArray(def.values)) {
    return [...def.values];
  }
  if (kind === "ZodNativeEnum" && isRecord(def.values)) {
    return Object.values(def.values).filter(
      (v) => typeof v === "string" || typeof v === "number",
    );
  }
  if (kind === "ZodLiteral") {
    const v = def.value;
    if (["string", "number", "boolean"].includes(typeof v)) return [v];
  }
  return undefined;
}

function isJsonSafe(value) {
  if (value === undefined || typeof value === "function") return false;
  try {
    JSON.stringify(value);
    return true;
  } catch {
    return false;
  }
}

function toJson(value) {
  return JSON.parse(JSON.stringify(value));
}

/* ------------------------------------------------------------------ */
/* context                                                             */
/* ------------------------------------------------------------------ */

function buildContext(raw, fixtures, meta, runtime) {
  const runRaw = isRecord(raw.run) ? raw.run : {};
  const runDir = typeof raw.runDir === "string" ? raw.runDir : undefined;
  const specDir = typeof raw.specDir === "string" ? raw.specDir : undefined;
  const run = Object.freeze({
    id: stringOr(runRaw.id, process.env.CAIRN_RUN_ID),
    token: stringOr(runRaw.token, process.env.CAIRN_RUN_TOKEN),
    startedAt: stringOr(runRaw.startedAt, undefined),
    labels: Object.freeze(isRecord(runRaw.labels) ? { ...runRaw.labels } : {}),
    failedStep:
      typeof runRaw.failedStep === "string" ? runRaw.failedStep : null,
    lastSuccessfulStep:
      typeof runRaw.lastSuccessfulStep === "string"
        ? runRaw.lastSuccessfulStep
        : null,
    dir: runDir,
  });
  const progress =
    typeof raw.progress === "function" ? raw.progress : progressToFile;
  const log = (...args) => {
    process.stderr.write(`[verifier] ${args.map(formatLogArg).join(" ")}\n`);
  };
  const ctx = {
    fixtures,
    vars: isRecord(raw.vars) ? raw.vars : {},
    run,
    specDir,
    runDir,
    network: createNetwork(
      Array.isArray(raw.networkEntries) ? raw.networkEntries : [],
    ),
    evals: isRecord(raw.evals) ? raw.evals : {},
    requests: isRecord(raw.requests) ? raw.requests : {},
    captures: isRecord(raw.captures) ? raw.captures : {},
    runs: isRecord(raw.runs) ? raw.runs : {},
    fixturesOutputs: isRecord(raw.fixturesOutputs) ? raw.fixturesOutputs : {},
    artifacts: isRecord(raw.artifacts) ? raw.artifacts : {},
    datasources: createDatasources(meta, runtime.signal),
    deadline: runtime.deadline,
    remainingMs: runtime.remainingMs,
    signal: runtime.signal,
    progress: (message) => progress(String(message)),
    log,
    xlsx: (path) => openWorkbook(path, { runDir, specDir }),
    fail(message, details) {
      throw new VerifierFailure(message, details);
    },
    result: Object.freeze({
      ok: (details) => ({
        ok: true,
        evidence: details === undefined ? null : details,
      }),
      fail: (message, details) => ({
        ok: false,
        message,
        evidence: mergeMessage(message, details),
      }),
    }),
  };
  ctx.poll = (fn, options) => poll(ctx, runtime, fn, options ?? {});
  return ctx;
}

function progressToFile(message) {
  const file = process.env.CAIRN_PROGRESS_FILE;
  if (!file) return;
  try {
    appendFileSync(file, `${message.replace(/\r?\n/g, " ")}\n`);
  } catch {
    // Progress is best-effort.
  }
}

/* ------------------------------------------------------------------ */
/* poll                                                                */
/* ------------------------------------------------------------------ */

async function poll(ctx, runtime, fn, options) {
  if (typeof fn !== "function") {
    throw new TypeError("ctx.poll(fn, options): fn must be a function");
  }
  const label = typeof options.label === "string" ? options.label : "poll";
  const every = Math.max(
    MIN_POLL_EVERY_MS,
    positiveNumber(options.every, DEFAULT_POLL_EVERY_MS),
  );
  const stableFor = Math.max(0, positiveNumber(options.stableFor, 0));
  const requested = positiveNumber(options.within, DEFAULT_POLL_WITHIN_MS);
  const within = Math.min(requested, runtime.remainingMs());
  const until =
    typeof options.until === "function" ? options.until : defaultUntil;
  const describe =
    typeof options.describe === "function" ? options.describe : summarize;
  const want =
    typeof options.want === "string" ? ` (want ${options.want})` : "";
  const retryOnError = options.retryOnError !== false;
  const maxAttempts = Math.max(1, Math.floor(within / every) + 1);
  const started = Date.now();
  const pollDeadline = started + within;
  const history = [];
  let attempt = 0;
  let observation;
  let lastSummary;
  let lastError;
  let okSince;
  runtime.stats.polls += 1;

  const finish = (reason, message) => {
    const polledMs = Date.now() - started;
    runtime.stats.polledMs += polledMs;
    return new PollTimeoutError(message, {
      reason,
      observation,
      attempts: attempt,
      polledMs,
      history:
        history.length > LOG_HEAD + LOG_TAIL
          ? [...history.slice(0, LOG_HEAD), ...history.slice(-LOG_TAIL)]
          : history,
      ...(lastError ? { lastError } : {}),
    });
  };

  while (true) {
    if (runtime.signal.aborted) {
      throw finish(
        "aborted",
        `${label} stopped: ${abortReason(runtime.signal)} after ${attempt} attempt(s)`,
      );
    }
    if (options.failFastOnStepFailure && ctx.run.failedStep) {
      throw finish(
        "step-failed",
        `${label} not attempted: step "${ctx.run.failedStep}" failed`,
      );
    }
    attempt += 1;
    runtime.stats.attempts += 1;
    const attemptStarted = Date.now();
    const at = new Date(attemptStarted).toISOString();
    // An attempt never outlives the poll: it is abandoned when `within` runs
    // out (yet always gets at least max(every, 1s), so the attempt at the
    // very edge can answer), at the deadline and on cancel; its signal
    // aborts so cooperative work stops too.
    const budget =
      Math.max(
        pollDeadline,
        attemptStarted + Math.max(every, MIN_LAST_ATTEMPT_MS),
      ) - attemptStarted;
    const settled = await runAttempt(fn, attempt, budget, runtime.signal);
    if (settled.kind === "aborted") {
      throw finish(
        "aborted",
        `${label} stopped: ${abortReason(runtime.signal)} after ${attempt} attempt(s)`,
      );
    }
    if (settled.kind === "timeout") {
      const elapsed = Date.now() - started;
      history.push({
        at,
        ok: false,
        summary: `still running after ${budget}ms: abandoned`,
      });
      ctx.progress(
        `${label} attempt ${attempt}/${maxAttempts}: still running after ${budget}ms: abandoned`,
      );
      throw finish(
        "timeout",
        `${label} timed out after ${elapsed}ms (${attempt} attempt(s)): attempt ${attempt} was still running after ${budget}ms; ${
          lastSummary === undefined
            ? "no attempt completed"
            : `last ${lastSummary}`
        }${want}`,
      );
    }
    let ok = false;
    let summary;
    let terminal;
    let failed = settled.kind === "error";
    let error = settled.error;
    if (!failed) {
      observation = settled.value;
      try {
        const failure =
          typeof options.failWhen === "function"
            ? options.failWhen(observation)
            : undefined;
        if (typeof failure === "string" && failure) terminal = failure;
        ok = !terminal && Boolean(until(observation));
        summary = safeSummary(describe, observation);
        lastError = undefined;
      } catch (thrown) {
        // `d.status` on a document that is not there yet: "not yet" too.
        failed = true;
        error = thrown;
      }
    }
    if (failed) {
      if (runtime.signal.aborted) {
        throw finish(
          "aborted",
          `${label} stopped: ${abortReason(runtime.signal)} after ${attempt} attempt(s)`,
        );
      }
      if (isFailure(error)) {
        // ctx.fail(), network.findOne() or a nested poll's timeout: a
        // decision, not a "not yet" — end the poll with it.
        history.push({
          at,
          ok: false,
          summary: `failed: ${truncate(error.message, MAX_SUMMARY)}`,
        });
        ctx.progress(
          `${label} attempt ${attempt}/${maxAttempts}: failed: ${truncate(error.message, MAX_SUMMARY)}`,
        );
        runtime.stats.polledMs += Date.now() - started;
        throw error;
      }
      if (!retryOnError) {
        runtime.stats.polledMs += Date.now() - started;
        throw error;
      }
      ok = false;
      terminal = undefined;
      lastError = errorMessage(error);
      summary = `error: ${truncate(lastError, MAX_SUMMARY)}`;
    }
    lastSummary = summary;
    history.push({ at, ok, summary });
    ctx.progress(
      `${label} attempt ${attempt}/${maxAttempts}: ${summary}${
        terminal ? "" : want
      }`,
    );
    if (terminal) {
      throw finish("fail-when", `${label} failed: ${terminal}`);
    }
    const now = Date.now();
    if (ok) {
      okSince ??= now;
      if (now - okSince >= stableFor) {
        runtime.stats.polledMs += now - started;
        return observation;
      }
    } else {
      okSince = undefined;
    }
    const elapsed = now - started;
    if (elapsed >= within) {
      const stability =
        okSince !== undefined
          ? `; held for ${now - okSince}ms of the required ${stableFor}ms`
          : "";
      throw finish(
        "timeout",
        `${label} timed out after ${elapsed}ms (${attempt} attempt(s)): last ${summary}${want}${stability}`,
      );
    }
    await sleep(Math.min(every, within - elapsed), runtime.signal);
  }
}

/**
 * One attempt raced against its budget and the verifier's signal. Resolves
 * { kind: "value" | "error" | "timeout" | "aborted" }; an abandoned attempt
 * keeps running in the background with its signal aborted, and its late
 * result or rejection is ignored.
 */
function runAttempt(fn, attempt, budgetMs, outer) {
  if (outer.aborted) return Promise.resolve({ kind: "aborted" });
  const controller = new AbortController();
  let timer;
  let onAbort;
  return new Promise((resolve) => {
    onAbort = () => {
      resolve({ kind: "aborted" });
      controller.abort(outer.reason);
    };
    outer.addEventListener("abort", onAbort, { once: true });
    timer = setTimeout(
      () => {
        resolve({ kind: "timeout" });
        controller.abort(
          new Error(
            `poll attempt ${attempt} exceeded its ${budgetMs}ms budget`,
          ),
        );
      },
      Math.max(0, budgetMs),
    );
    new Promise((inner) =>
      inner(fn({ attempt, signal: controller.signal })),
    ).then(
      (value) => resolve({ kind: "value", value }),
      (error) => resolve({ kind: "error", error }),
    );
  }).finally(() => {
    clearTimeout(timer);
    outer.removeEventListener("abort", onAbort);
  });
}

function defaultUntil(observation) {
  return Array.isArray(observation)
    ? observation.length > 0
    : Boolean(observation);
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, Math.max(0, ms));
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function abortReason(signal) {
  const reason = signal.reason;
  return reason instanceof Error ? reason.message : String(reason ?? "aborted");
}

/* ------------------------------------------------------------------ */
/* network                                                             */
/* ------------------------------------------------------------------ */

function createNetwork(entries) {
  const list = Object.freeze([...entries]);
  const find = (filter) => list.filter(networkMatcher(filter));
  return Object.freeze({
    entries: list,
    find,
    findOne(filter) {
      const matches = find(filter);
      if (matches.length === 1) return matches[0];
      const what = describeNetworkFilter(filter);
      throw new VerifierFailure(
        matches.length === 0
          ? `network: no request matched ${what} (${list.length} captured)`
          : `network: ${matches.length} requests matched ${what}; expected exactly one`,
        {
          filter: what,
          matched: matches.length,
          candidates: matches.slice(0, 10).map(summarizeEntry),
        },
      );
    },
    json(entry) {
      if (!entry || typeof entry.postData !== "string") return undefined;
      try {
        return JSON.parse(entry.postData);
      } catch {
        return undefined;
      }
    },
  });
}

function networkMatcher(filter) {
  if (filter === undefined || filter === null) return () => true;
  if (typeof filter === "function") return filter;
  const method = filter.method?.toUpperCase();
  const since =
    filter.since === undefined
      ? undefined
      : filter.since instanceof Date
        ? filter.since.getTime()
        : typeof filter.since === "string"
          ? Date.parse(filter.since)
          : filter.since;
  return (entry) => {
    if (method && String(entry.method).toUpperCase() !== method) return false;
    const url = String(entry.url ?? "");
    if (typeof filter.url === "string" && !url.includes(filter.url))
      return false;
    if (filter.url instanceof RegExp && !filter.url.test(url)) return false;
    if (filter.urlContains !== undefined && !url.includes(filter.urlContains))
      return false;
    if (filter.path !== undefined && pathnameOf(url) !== filter.path)
      return false;
    if (
      filter.resourceType !== undefined &&
      entry.resourceType !== filter.resourceType
    )
      return false;
    if (
      filter.status !== undefined &&
      !statusMatches(entry.status, filter.status)
    )
      return false;
    if (
      since !== undefined &&
      !(typeof entry.timestamp === "number" && entry.timestamp >= since)
    )
      return false;
    if (typeof filter.where === "function" && !filter.where(entry))
      return false;
    return true;
  };
}

function statusMatches(status, expected) {
  if (typeof status !== "number") return false;
  if (typeof expected === "number") return status === expected;
  if (Array.isArray(expected)) return expected.includes(status);
  if (isRecord(expected)) {
    if (typeof expected.atLeast === "number" && status < expected.atLeast)
      return false;
    if (typeof expected.below === "number" && status >= expected.below)
      return false;
    return true;
  }
  return false;
}

function pathnameOf(url) {
  try {
    return new URL(url, "http://cairn.invalid").pathname;
  } catch {
    return url;
  }
}

function describeNetworkFilter(filter) {
  if (typeof filter === "function") return "a predicate";
  if (!isRecord(filter)) return "any request";
  const parts = [];
  if (filter.method) parts.push(String(filter.method).toUpperCase());
  if (filter.url !== undefined) parts.push(`url ${String(filter.url)}`);
  if (filter.urlContains !== undefined)
    parts.push(`url ~ ${filter.urlContains}`);
  if (filter.path !== undefined) parts.push(`path ${filter.path}`);
  if (filter.status !== undefined)
    parts.push(`status ${JSON.stringify(filter.status)}`);
  if (filter.resourceType !== undefined)
    parts.push(`type ${filter.resourceType}`);
  if (filter.since !== undefined) parts.push(`since ${String(filter.since)}`);
  if (typeof filter.where === "function") parts.push("where(…)");
  return parts.join(" ") || "any request";
}

function summarizeEntry(entry) {
  return {
    method: entry.method,
    url: truncate(String(entry.url ?? ""), 300),
    ...(entry.status !== undefined ? { status: entry.status } : {}),
    ...(entry.timestamp !== undefined ? { timestamp: entry.timestamp } : {}),
  };
}

/* ------------------------------------------------------------------ */
/* datasources                                                         */
/* ------------------------------------------------------------------ */

/**
 * `ctx.datasources.<name>.<method>(...args)`: forwarded to the runner, which
 * owns the configured clients (connection strings and credentials never
 * enter this process). Arguments and results cross the boundary as JSON;
 * a Date argument travels as `{ $date: iso }` (EJSON).
 */
function createDatasources(meta, signal) {
  const channel = isRecord(meta.rpc) ? meta.rpc : undefined;
  const listed = Array.isArray(meta.datasources) ? meta.datasources : [];
  const names = listed
    .map((d) => (isRecord(d) ? d.name : d))
    .filter((n) => typeof n === "string");
  const call = async (name, method, args) => {
    if (!channel || typeof channel.url !== "string") {
      throw new Error(
        `ctx.datasources.${name}.${method}(): no datasource channel — run the verifier through cairn with datasources: configured`,
      );
    }
    if (names.length > 0 && !names.includes(name)) {
      throw new Error(
        `ctx.datasources.${name} is not configured (configured: ${names.join(", ")})`,
      );
    }
    const response = await fetch(channel.url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${channel.token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(
        { op: "datasource", name, method, args },
        ejsonReplacer,
      ),
      signal,
    });
    let body;
    try {
      body = await response.json();
    } catch {
      throw new Error(
        `ctx.datasources.${name}.${method}(): bad response (HTTP ${response.status})`,
      );
    }
    if (!isRecord(body) || body.ok !== true) {
      const error = new Error(
        `ctx.datasources.${name}.${method}(): ${
          isRecord(body) && isRecord(body.error)
            ? String(body.error.message)
            : `HTTP ${response.status}`
        }`,
      );
      error.name = "DatasourceError";
      throw error;
    }
    return body.value;
  };
  const clients = new Map();
  const client = (name) => {
    if (!clients.has(name)) {
      clients.set(
        name,
        new Proxy(
          {},
          {
            get(_, method) {
              if (typeof method !== "string" || NOT_METHODS.has(method))
                return undefined;
              return (...args) => call(name, method, args);
            },
          },
        ),
      );
    }
    return clients.get(name);
  };
  return new Proxy(
    {},
    {
      get(_, name) {
        if (typeof name !== "string" || NOT_METHODS.has(name)) return undefined;
        return client(name);
      },
      has: (_, name) => typeof name === "string" && names.includes(name),
      ownKeys: () => [...names],
      getOwnPropertyDescriptor: (_, name) =>
        typeof name === "string" && names.includes(name)
          ? { enumerable: true, configurable: true, value: client(name) }
          : undefined,
    },
  );
}

/** Names inspection and promise resolution probe; never datasource calls. */
const NOT_METHODS = new Set(["then", "toJSON", "constructor", "inspect"]);

function ejsonReplacer(key, value) {
  const original = this[key];
  if (original instanceof Date) return { $date: original.toISOString() };
  return value;
}

/* ------------------------------------------------------------------ */
/* xlsx                                                                */
/* ------------------------------------------------------------------ */

async function openWorkbook(path, dirs) {
  if (typeof path !== "string" || path === "") {
    throw new TypeError("ctx.xlsx(path): path must be a non-empty string");
  }
  const abs = resolveDataPath(path, dirs);
  const parsed = readWorkbook(readFileSync(abs));
  const sheets = parsed.sheets.map((sheet) =>
    Object.freeze({
      name: sheet.name,
      rows: sheet.rows,
      validations: sheet.validations,
      cell: (ref) => sheet.cells.get(String(ref).toUpperCase()),
      records: (options = {}) => sheetRecords(sheet.rows, options),
    }),
  );
  return Object.freeze({
    path: abs,
    sheetNames: sheets.map((s) => s.name),
    sheets,
    sheet: (name) => sheets.find((s) => s.name === name),
  });
}

function resolveDataPath(path, { runDir, specDir }) {
  if (isAbsolute(path)) return path;
  for (const base of [runDir, specDir]) {
    if (base && existsSync(resolvePath(base, path)))
      return resolvePath(base, path);
  }
  return resolvePath(specDir ?? process.cwd(), path);
}

function sheetRecords(rows, options) {
  const headerRow = positiveNumber(options.headerRow, 1);
  const header = (rows[headerRow - 1] ?? []).map((h) => String(h).trim());
  const out = [];
  for (const row of rows.slice(headerRow)) {
    if (!row || row.every((cell) => cell === "")) continue;
    const record = {};
    header.forEach((name, i) => {
      if (name) record[name] = row[i] ?? "";
    });
    out.push(record);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isFailure(error) {
  return Boolean(error && typeof error === "object" && error[FAILURE]);
}

function stringOr(value, fallback) {
  return typeof value === "string" && value !== ""
    ? value
    : fallback || undefined;
}

function positiveNumber(value, fallback) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : fallback;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function truncate(text, max) {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function summarize(observation) {
  if (observation === undefined) return "undefined";
  if (Array.isArray(observation)) {
    return `${observation.length} item(s)${
      observation.length > 0
        ? `: ${truncate(safeJson(observation[0]), 100)}`
        : ""
    }`;
  }
  return truncate(
    typeof observation === "string" ? observation : safeJson(observation),
    MAX_SUMMARY,
  );
}

function safeSummary(describe, observation) {
  try {
    return truncate(String(describe(observation)), MAX_SUMMARY);
  } catch (error) {
    return `describe() threw: ${errorMessage(error)}`;
  }
}

function safeJson(value) {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function formatLogArg(value) {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.stack ?? value.message;
  return safeJson(value);
}

/**
 * Bound an observation for evidence: at most 20 array items, each at most
 * 4KB of JSON (larger items become a truncated string), with a flag when
 * anything was cut.
 */
function bounded(value) {
  if (value === undefined) return undefined;
  const clip = (item) => {
    const json = safeJson(item);
    return json.length <= MAX_ROW_BYTES
      ? item
      : { truncated: true, preview: `${json.slice(0, MAX_ROW_BYTES)}…` };
  };
  if (Array.isArray(value)) {
    const rows = value.slice(0, MAX_ROWS).map(clip);
    return {
      rows,
      total: value.length,
      truncated:
        value.length > MAX_ROWS ||
        rows.some((r) => isRecord(r) && r.truncated === true),
    };
  }
  return clip(value);
}
