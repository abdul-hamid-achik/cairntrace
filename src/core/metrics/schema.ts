import { z } from "zod";
import { DurationSchema, durationMs } from "../gates/schema";
import { parsePath } from "../runner/verifiers/matchers";

/**
 * Config `metrics:` probes (F11): numbers the engine samples around a spec
 * (or the whole invocation) instead of an `--after` collector script.
 *
 * ```yaml
 * metrics:
 *   - name: queue_depth
 *     sample: [before, after]            # or: every: 5s
 *     scope: spec                        # spec (default) | invocation
 *     command: ./tools/queue-depth.sh
 *     parse: { json: $.depth }           # or { regex: "depth=(\\d+)", unit: msgs }
 *     timeout: 10s                       # per sample, default 10s
 *   - name: indexed_docs
 *     sample: [before, after]
 *     scope: invocation
 *     http:
 *       url: ${vars.searchUrl}/_stats
 *       auth: { bearer: "${secrets.SEARCH_TOKEN}" }
 *       json: { path: $.indices[*].docs.count, reduce: sum }
 * ```
 *
 * Each probe lands in `<runDir>/diagnostics/metrics.json` with its
 * before/after samples and delta, and in `diagnostics/report.json` as the
 * flat top-level numerics `<name>.before`, `<name>.after`, `<name>.delta`
 * (and `.min` / `.max` / `.mean` for `every:`), which `cairn stats --metric
 * <name>.delta` reads. A failing probe is recorded and never fails the run.
 * `environments.<n>.metrics` merges over the top-level list by name.
 */

export const METRIC_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]*$/;
export const MetricNameSchema = z
  .string()
  .regex(
    METRIC_NAME_PATTERN,
    "metric names start with a letter (letters, digits, _ -); no dots: the report keys are <name>.delta",
  );

export const METRIC_REDUCERS = ["sum", "max", "min", "count"] as const;
export const MetricReducerSchema = z.enum(METRIC_REDUCERS);
export type MetricReducer = z.infer<typeof MetricReducerSchema>;

export const METRIC_SCOPES = ["spec", "invocation"] as const;
export const MetricScopeSchema = z.enum(METRIC_SCOPES);
export type MetricScope = z.infer<typeof MetricScopeSchema>;

/** Fastest `every:` cadence: a probe is a process or a request. */
export const MIN_EVERY_MS = 250;
/** Default and maximum budget of one sample. */
export const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
export const MAX_PROBE_TIMEOUT_MS = 300_000;

const JsonParseSchema = z
  .object({
    /** JSON path into the command's stdout (`$.a.b`, `items[*].n`, filters). */
    json: z.string().min(1),
    /** Combine several matches into one number (required for a wildcard path). */
    reduce: MetricReducerSchema.optional(),
  })
  .strict();

const RegexParseSchema = z
  .object({
    /** Matched against stdout (multiline); the number is capture group `group`. */
    regex: z.string().min(1),
    /** Capture group holding the number (default 1, or the whole match without groups). */
    group: z.number().int().min(0).max(20).optional(),
    /** Unit label recorded with the metric (informational). */
    unit: z.string().min(1).optional(),
  })
  .strict();

export const MetricParseSchema = z.union([JsonParseSchema, RegexParseSchema], {
  errorMap: () => ({
    message:
      "parse: expected { json: <path>, reduce? } or { regex, group?, unit? }",
  }),
});

const HttpJsonSchema = z
  .object({
    /** JSON path into the response (`$.a.b`, `items[*].n`, filters). */
    path: z.string().min(1),
    /** Combine several matches into one number (required for a wildcard path). */
    reduce: MetricReducerSchema.optional(),
  })
  .strict();

export const MetricHttpSchema = z
  .object({
    url: z.string().min(1),
    /** Extra request headers; values may use `${secrets.X}` / `${env.X}` / `${vars.X}`. */
    headers: z.record(z.string(), z.string()).optional(),
    /** `bearer` token or `basic` (`user:password`); same shape as a datasource's `auth`. */
    auth: z
      .object({
        bearer: z.string().min(1).optional(),
        basic: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (auth) => (auth.bearer === undefined) !== (auth.basic === undefined),
        {
          message: "auth takes exactly one of bearer or basic",
        },
      )
      .optional(),
    json: HttpJsonSchema,
    unit: z.string().min(1).optional(),
  })
  .strict();

const SAMPLE_PHASES = ["before", "after"] as const;

export const MetricProbeSchema = z
  .object({
    name: MetricNameSchema,
    description: z.string().optional(),
    /** When to sample: `before` and/or `after` the scope (default both). Not with `every`. */
    sample: z.array(z.enum(SAMPLE_PHASES)).min(1).max(2).optional(),
    /** Sample periodically while the scope runs (plus once at each end). Not with `sample`. */
    every: DurationSchema.optional(),
    /** `spec` (default): around each spec; `invocation`: around each iteration's specs. */
    scope: MetricScopeSchema.optional(),
    /** A shell command (run in the config directory); needs `parse`. */
    command: z.string().min(1).optional(),
    parse: MetricParseSchema.optional(),
    /** An HTTP GET whose JSON answer holds the number. */
    http: MetricHttpSchema.optional(),
    /** Budget of one sample (default 10s, max 5m). */
    timeout: DurationSchema.optional(),
    unit: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((probe, ctx) => {
    const issue = (path: string, message: string): void =>
      void ctx.addIssue({ code: z.ZodIssueCode.custom, path: [path], message });
    if (probe.sample !== undefined && probe.every !== undefined) {
      issue("every", "use `sample` or `every`, not both");
    }
    if (probe.sample && new Set(probe.sample).size !== probe.sample.length) {
      issue("sample", "sample lists each phase once");
    }
    if ((probe.command === undefined) === (probe.http === undefined)) {
      issue(
        "command",
        "a metric needs exactly one source: `command` (with `parse`) or `http`",
      );
    }
    if (probe.command !== undefined && probe.parse === undefined) {
      issue("parse", "a command metric needs `parse: { json } | { regex }`");
    }
    if (probe.http !== undefined && probe.parse !== undefined) {
      issue(
        "parse",
        "an http metric reads `http.json`; `parse` belongs to `command`",
      );
    }
    if (probe.every !== undefined) {
      const ms = durationMs(probe.every)!;
      if (ms < MIN_EVERY_MS) {
        issue("every", `every must be at least ${MIN_EVERY_MS}ms`);
      }
    }
    if (probe.timeout !== undefined) {
      const ms = durationMs(probe.timeout)!;
      if (ms < 1 || ms > MAX_PROBE_TIMEOUT_MS) {
        issue(
          "timeout",
          `timeout must be between 1ms and ${MAX_PROBE_TIMEOUT_MS / 1000}s`,
        );
      }
    }
    const parse = probe.parse;
    if (parse && "regex" in parse) {
      try {
        void new RegExp(parse.regex, "m");
      } catch (error) {
        issue("parse", `invalid regex: ${(error as Error).message}`);
      }
    }
    const jsonPath =
      parse && "json" in parse ? parse.json : probe.http?.json.path;
    if (jsonPath !== undefined) {
      try {
        parsePath(jsonPath);
      } catch (error) {
        issue(
          probe.http ? "http" : "parse",
          `invalid json path: ${(error as Error).message}`,
        );
      }
    }
  });
export type MetricProbe = z.infer<typeof MetricProbeSchema>;

/** A metrics list: names are unique. */
export const MetricsListSchema = z
  .array(MetricProbeSchema)
  .superRefine((list, ctx) => {
    const seen = new Set<string>();
    for (const [index, probe] of list.entries()) {
      if (seen.has(probe.name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index, "name"],
          message: `duplicate metric name "${probe.name}"`,
        });
      }
      seen.add(probe.name);
    }
  });
export type MetricsList = z.infer<typeof MetricsListSchema>;

/** `environments.<n>.metrics` over the top-level list, by name (the environment wins). */
export function mergeMetrics(
  base: MetricsList | undefined,
  override: MetricsList | undefined,
): MetricsList | undefined {
  if (!override) return base;
  if (!base) return override;
  const byName = new Map(base.map((probe) => [probe.name, probe] as const));
  for (const probe of override) byName.set(probe.name, probe);
  return [...byName.values()];
}

/** A probe with its policy spelled out. */
export interface NormalizedProbe {
  probe: MetricProbe;
  scope: MetricScope;
  /** Phases sampled (`every` implies both ends). */
  phases: ReadonlyArray<"before" | "after">;
  everyMs: number | undefined;
  timeoutMs: number;
  unit: string | undefined;
}

export function normalizeProbe(probe: MetricProbe): NormalizedProbe {
  const everyMs = durationMs(probe.every);
  const parse = probe.parse;
  const unit =
    probe.unit ??
    probe.http?.unit ??
    (parse && "regex" in parse ? parse.unit : undefined);
  return {
    probe,
    scope: probe.scope ?? "spec",
    phases:
      everyMs !== undefined
        ? ["before", "after"]
        : (probe.sample ?? ["before", "after"]),
    everyMs,
    timeoutMs: durationMs(probe.timeout) ?? DEFAULT_PROBE_TIMEOUT_MS,
    unit,
  };
}
