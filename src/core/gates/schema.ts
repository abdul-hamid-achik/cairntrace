import { z } from "zod";

/**
 * Typed readiness gates (F2). A gate is a probe tree — `tcp`, `http`,
 * `command`, a reference to another named `gate`, or an `all` / `any`
 * composition — plus the waiting policy of the gate being waited on:
 * `stable` (N consecutive passing attempts), `every` (pause between
 * attempts) and `timeout` (the whole wait's budget).
 *
 * Gates live in the config's top-level `gates:` registry and are referenced
 * by name (or written inline) from `services.docker.ready`,
 * `services.tmux.windows[].readyOn.gate` / `.after`, `webServer.ready`,
 * a spec's `preconditions.wait`, and `cairn wait` / MCP `cairn_wait`.
 *
 * A string reference is a registry name, except `http(s)://…` (an HTTP gate
 * that needs a 2xx/3xx answer) and `tcp://host:port` (a TCP connect gate).
 */

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h)$/;

/** Milliseconds, or a string like `500ms`, `2s`, `5m`, `1h`. `0` = no deadline. */
export const DurationSchema = z.union([
  z.number().int().nonnegative(),
  z
    .string()
    .regex(
      DURATION_PATTERN,
      'duration must be milliseconds or a number with ms|s|m|h (e.g. "30s")',
    ),
]);
export type Duration = z.infer<typeof DurationSchema>;

const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
};

/** Duration → milliseconds (undefined stays undefined). Throws on garbage. */
export function durationMs(value: Duration | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (typeof value === "number") return value;
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) throw new Error(`invalid duration "${value}"`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2]!]!);
}

const STATUS_TOKEN = /^(?:[1-5]xx|[1-5]\d\d(?:-[1-5]\d\d)?)$/;
const StatusTokenSchema = z.union([
  z.number().int().min(100).max(599),
  z
    .string()
    .regex(
      STATUS_TOKEN,
      'status must be a code (200), a class ("2xx") or a range ("200-299")',
    ),
]);

/** Accepted HTTP statuses: a code, a class (`2xx`), a range, or a list. */
export const HttpStatusMatchSchema = z.union([
  StatusTokenSchema,
  z.array(StatusTokenSchema).min(1),
]);
export type HttpStatusMatch = z.infer<typeof HttpStatusMatchSchema>;

/** The readiness default for URL probes: any 2xx or 3xx answer. */
export const DEFAULT_READY_STATUS: HttpStatusMatch = ["2xx", "3xx"];

const JsonScalarSchema = z.union([z.string(), z.number(), z.boolean()]);
const JsonLiteralSchema = z.union([JsonScalarSchema, z.null()]);

/**
 * One JSON-body matcher. A bare scalar means `equals`; the object form
 * combines `equals`, `in`, `contains` (substring or array member), `matches`
 * (regex), `exists`, and numeric `gt` / `gte` / `lt` / `lte`.
 */
const JsonValueMatcherSchema = z.union([
  JsonLiteralSchema,
  z
    .object({
      equals: JsonLiteralSchema.optional(),
      in: z.array(JsonLiteralSchema).min(1).optional(),
      contains: JsonScalarSchema.optional(),
      matches: z.string().min(1).optional(),
      exists: z.boolean().optional(),
      gt: z.number().optional(),
      gte: z.number().optional(),
      lt: z.number().optional(),
      lte: z.number().optional(),
    })
    .strict()
    .refine((m) => Object.keys(m).length > 0, {
      message:
        "a JSON matcher needs at least one of equals/in/contains/matches/exists/gt/gte/lt/lte",
    }),
]);
export type JsonValueMatcher = z.infer<typeof JsonValueMatcherSchema>;

/**
 * Credentials for an HTTP gate; they never appear in events, details or
 * artifacts. `${secrets.X}` resolves from the probe's (scoped) environment
 * when the gate runs, and an unset one fails the attempt as "X not set".
 * `${env.X}` is substituted when the config loads, like anywhere else in
 * the config — an unset variable becomes "". Empty values are therefore
 * accepted here (an unexported variable must not invalidate the whole
 * config); a 401/403 answer then names the empty credential.
 */
const GateAuthSchema = z
  .object({
    /** `user:password`, or `{username, password}`. */
    basic: z
      .union([
        z.string(),
        z.object({ username: z.string(), password: z.string() }).strict(),
      ])
      .optional(),
    bearer: z.string().optional(),
  })
  .strict()
  .refine(
    (auth) => (auth.basic === undefined) !== (auth.bearer === undefined),
    {
      message: "gate auth needs exactly one of basic or bearer",
    },
  );
export type GateAuth = z.infer<typeof GateAuthSchema>;

const HOST_PORT = /^(?:\[[0-9a-fA-F:.]+\]|[^\s:/[\]]+):\d{1,5}$/;

/** `host:port`, or `{host, port, timeoutMs?}`. Ready when a connect succeeds. */
const TcpProbeSchema = z.union([
  z.string().regex(HOST_PORT, 'tcp probe must be "host:port"'),
  z
    .object({
      host: z.string().min(1),
      port: z.number().int().min(1).max(65_535),
      /** Per-attempt connect timeout (default 2000). */
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type TcpProbe = z.infer<typeof TcpProbeSchema>;

/** A URL, or the object form with status / JSON / text expectations. */
const HttpProbeSchema = z.union([
  z.string().url(),
  z
    .object({
      url: z.string().url(),
      method: z.enum(["GET", "HEAD", "POST"]).optional(),
      /** Accepted statuses (default 2xx/3xx). Redirects are not followed. */
      status: HttpStatusMatchSchema.optional(),
      /** Dotted JSON paths (`checks.db`, `items.0.state`, `items.length`). */
      json: z.record(z.string().min(1), JsonValueMatcherSchema).optional(),
      /** The response body must contain this text. */
      text: z.string().min(1).optional(),
      headers: z.record(z.string()).optional(),
      auth: GateAuthSchema.optional(),
      /** Per-attempt request timeout (default 5000). */
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type HttpProbe = z.infer<typeof HttpProbeSchema>;

/** A shell command, or `{run, exitCode?, stdout?, cwd?, env?, timeoutMs?}`. */
const CommandProbeSchema = z.union([
  z.string().min(1),
  z
    .object({
      run: z.string().min(1),
      /** Exit code(s) that mean ready (default 0). */
      exitCode: z
        .union([z.number().int(), z.array(z.number().int()).min(1)])
        .optional(),
      /** The combined output must contain this text. */
      stdout: z.string().min(1).optional(),
      /** Relative to the config file's directory (spec directory for spec gates). */
      cwd: z.string().optional(),
      env: z.record(z.string()).optional(),
      /** Per-attempt timeout (default 30000); the process tree is killed past it. */
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type CommandProbe = z.infer<typeof CommandProbeSchema>;

/** A gate: exactly one probe kind plus the waiting policy. */
export interface GateNode {
  /** Display name for an inline gate (registry gates are named by their key). */
  name?: string;
  description?: string;
  tcp?: TcpProbe;
  http?: HttpProbe;
  command?: CommandProbe;
  /** A gate of the registry, by name. */
  gate?: string;
  /** Every child must pass in the same attempt. */
  all?: GateRef[];
  /** At least one child must pass. */
  any?: GateRef[];
  /** Consecutive passing attempts required (default 1). */
  stable?: number;
  /** Pause between attempts (default 1s). Only the waited-on gate's applies. */
  every?: Duration;
  /** Budget of the whole wait (default 60s; 0 = no deadline). */
  timeout?: Duration;
}

/** A registry name, `http(s)://…`, `tcp://host:port`, or an inline gate. */
export type GateRef = string | GateNode;

const GATE_KINDS = ["tcp", "http", "command", "gate", "all", "any"] as const;

export const GateNodeSchema: z.ZodType<GateNode> = z.lazy(() =>
  z.object({
    name: z.string().min(1).optional(),
    description: z.string().optional(),
    tcp: TcpProbeSchema.optional(),
    http: HttpProbeSchema.optional(),
    command: CommandProbeSchema.optional(),
    gate: z.string().min(1).optional(),
    all: z.array(GateRefSchema).min(1).optional(),
    any: z.array(GateRefSchema).min(1).optional(),
    stable: z.number().int().min(1).max(1_000).optional(),
    every: DurationSchema.optional(),
    timeout: DurationSchema.optional(),
  })
    .strict()
    .superRefine((node, ctx) => {
      const kinds = GATE_KINDS.filter((kind) => node[kind] !== undefined);
      if (kinds.length !== 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `a gate needs exactly one of ${GATE_KINDS.join(", ")}${
            kinds.length > 1 ? ` (found ${kinds.join(", ")})` : ""
          }`,
        });
      }
    }),
);

export const GateRefSchema: z.ZodType<GateRef> = z.lazy(() =>
  z.union([z.string().min(1), GateNodeSchema]),
);

/** One gate reference or a list of them (waited in order). */
export const GateRefListSchema = z.union([
  GateRefSchema,
  z.array(GateRefSchema).min(1),
]);
export type GateRefList = z.infer<typeof GateRefListSchema>;

/** Normalize a single-or-list reference field to a list. */
export function gateRefList(refs: GateRefList | undefined): GateRef[] {
  if (refs === undefined) return [];
  return Array.isArray(refs) ? refs : [refs];
}

const GATE_NAME = /^[A-Za-z][A-Za-z0-9_.-]*$/;

/** True for string refs that are inline probes rather than registry names. */
export function isInlineGateString(ref: string): boolean {
  return /^(?:https?|tcp):\/\//i.test(ref);
}

/**
 * Registry names a reference list uses, inline gates' children included
 * (`{all: [db, "http://…"]}` → `db`). URL and `tcp://` strings are not names.
 */
export function gateRefNames(refs: GateRefList | undefined): string[] {
  const names: string[] = [];
  const walk = (ref: GateRef): void => {
    if (typeof ref === "string") {
      if (!isInlineGateString(ref)) names.push(ref);
      return;
    }
    if (ref.gate !== undefined) names.push(ref.gate);
    for (const child of [...(ref.all ?? []), ...(ref.any ?? [])]) walk(child);
  };
  for (const ref of gateRefList(refs)) walk(ref);
  return names;
}

/**
 * Registry problems a schema can see: references to undefined gates and
 * reference cycles (`a → b → a`).
 */
export function gateRegistryProblems(
  registry: Readonly<Record<string, GateNode>>,
): string[] {
  const problems: string[] = [];
  const refsOf = (node: GateRef): string[] => {
    if (typeof node === "string") {
      return isInlineGateString(node) ? [] : [node];
    }
    if (node.gate !== undefined) return [node.gate];
    return [...(node.all ?? []), ...(node.any ?? [])].flatMap(refsOf);
  };
  for (const [name, node] of Object.entries(registry)) {
    for (const ref of refsOf(node)) {
      if (!Object.hasOwn(registry, ref)) {
        problems.push(`gate "${name}" references unknown gate "${ref}"`);
      }
    }
  }
  const state = new Map<string, "visiting" | "done">();
  const visit = (name: string, path: string[]): void => {
    if (state.get(name) === "done" || !Object.hasOwn(registry, name)) return;
    if (state.get(name) === "visiting") {
      problems.push(
        `gate reference cycle: ${[...path.slice(path.indexOf(name)), name].join(" → ")}`,
      );
      return;
    }
    state.set(name, "visiting");
    for (const ref of refsOf(registry[name]!)) visit(ref, [...path, name]);
    state.set(name, "done");
  };
  for (const name of Object.keys(registry)) visit(name, []);
  return problems;
}

/** The config's top-level `gates:` registry (names are letters/digits/`_.-`). */
export const GatesRegistrySchema = z
  .record(
    z
      .string()
      .regex(
        GATE_NAME,
        "gate names start with a letter: letters, digits, _ . -",
      ),
    GateNodeSchema,
  )
  .superRefine((registry, ctx) => {
    for (const message of gateRegistryProblems(registry)) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    }
  });

/* ----- results (`cairn wait`, MCP `cairn_wait`) ----- */

const GateResultSchema = z
  .object({
    name: z.string().min(1),
    ok: z.boolean(),
    attempts: z.number().int().nonnegative(),
    durationMs: z.number().int().nonnegative(),
    /** The wait's budget; 0 means it had no deadline. */
    budgetMs: z.number().int().nonnegative(),
    /** The last attempt's verdict line (redacted, bounded). */
    lastDetail: z.string(),
    timedOut: z.boolean().optional(),
    cancelled: z.boolean().optional(),
  })
  .strict();
export type GateResult = z.infer<typeof GateResultSchema>;

export const WAIT_RESULT_SCHEMA_ID = "urn:cairntrace.dev:wait:v1";

export const WaitResultSchema = z
  .object({
    $schema: z.literal(WAIT_RESULT_SCHEMA_ID),
    version: z.literal("1"),
    /** Every gate passed. */
    ok: z.boolean(),
    durationMs: z.number().int().nonnegative(),
    /** One entry per waited gate, in order; the wait stops at the first failure. */
    gates: z.array(GateResultSchema),
    /** 0 ready · 1 not ready (failed / timed out / cancelled) · 2 error · 4 invalid input. */
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4)]),
    /** Present when the wait could not start (unknown gate, bad config, …). */
    error: z.string().optional(),
    /** The config whose registry resolved gate names, when one was used. */
    config: z.string().optional(),
  })
  .strict();
export type WaitResult = z.infer<typeof WaitResultSchema>;
