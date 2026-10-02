import { z } from "zod";

/**
 * Outcome verifier vocabulary (plan §10.5).
 * Typed verifiers + one escape hatch. Discriminated union by top-level key.
 *
 * If a need appears in 3+ real specs via `script`, promote it to a typed verifier.
 */

/* ----- shared sub-matchers ----- */

export const TextMatcherSchema = z
  .object({
    equals: z.string().optional(),
    contains: z.string().optional(),
    matches: z.string().optional(), // regex source
    /** Case-sensitive equals/contains (default: case-insensitive). */
    caseSensitive: z.boolean().optional(),
    /** Optional selector region for text/notText checks. */
    region: z.string().optional(),
  })
  .strict()
  .refine(
    (m) =>
      [m.equals, m.contains, m.matches].filter((x) => x !== undefined)
        .length === 1,
    { message: "exactly one of: equals, contains, matches" },
  )
  .superRefine((m, ctx) => {
    if (m.matches !== undefined && m.caseSensitive !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["caseSensitive"],
        message:
          "caseSensitive is only valid with equals or contains; regex matches remain raw and case-sensitive",
      });
    }
  });
export type TextMatcher = z.infer<typeof TextMatcherSchema>;

export const UrlMatcherSchema = z
  .object({
    equals: z.string().optional(),
    startsWith: z.string().optional(),
    endsWith: z.string().optional(),
    matches: z.string().optional(),
  })
  .strict()
  .refine(
    (m) =>
      [m.equals, m.startsWith, m.endsWith, m.matches].filter(
        (x) => x !== undefined,
      ).length === 1,
    { message: "exactly one of: equals, startsWith, endsWith, matches" },
  );
export type UrlMatcher = z.infer<typeof UrlMatcherSchema>;

export const StatusMatcherSchema = z
  .object({
    equals: z.number().int().optional(),
    below: z.number().int().optional(),
    atLeast: z.number().int().optional(),
    in: z.array(z.number().int()).nonempty().optional(),
  })
  .strict()
  .refine(
    (m) =>
      [m.equals, m.below, m.atLeast, m.in].filter((x) => x !== undefined)
        .length === 1,
    { message: "exactly one of: equals, below, atLeast, in" },
  );
export type StatusMatcher = z.infer<typeof StatusMatcherSchema>;

export const HttpMethodSchema = z.enum([
  "GET",
  "POST",
  "PUT",
  "PATCH",
  "DELETE",
  "HEAD",
  "OPTIONS",
]);
export type HttpMethod = z.infer<typeof HttpMethodSchema>;

/* ----- the 7 + 1 verifier variants ----- */

/** #1 — text appears on the page */
export const TextVerifierSchema = z
  .object({
    text: TextMatcherSchema,
    /** Legacy v1.8 shape; prefer text.region. */
    region: z.string().optional(),
  })
  .strict();
export type TextVerifier = z.infer<typeof TextVerifierSchema>;

/** #2 — text does NOT appear on the page */
export const NotTextVerifierSchema = z
  .object({
    notText: TextMatcherSchema,
    /** Legacy v1.8 shape; prefer notText.region. */
    region: z.string().optional(),
  })
  .strict();
export type NotTextVerifier = z.infer<typeof NotTextVerifierSchema>;

export function textVerifierRegion(v: TextVerifier): string {
  return v.text.region ?? v.region ?? "page";
}

export function notTextVerifierRegion(v: NotTextVerifier): string {
  return v.notText.region ?? v.region ?? "page";
}

/** #3 — URL post-condition */
export const UrlVerifierSchema = z
  .object({
    url: UrlMatcherSchema,
  })
  .strict();
export type UrlVerifier = z.infer<typeof UrlVerifierSchema>;

/* ----- shared data matchers (mongo / temporal / http / value / network) ----- */

/**
 * A data matcher: a bare scalar (`status: COMPLETED`, `count: 1`) is shorthand
 * for `equals`; the object form combines any of the assertion keys (every
 * present key must hold). Comparisons are raw and case-sensitive unless
 * `ignoreCase: true` (strings only).
 *
 * - `equals` / `oneOf`: structural deep equality (object key order ignored).
 * - `contains`: substring of a string, a deep-equal (or, for objects, a
 *   subset-matching) element of an array, or a subset of an object.
 * - `matches`: regex source tested against the value as a string.
 * - `atLeast` / `atMost`: numeric bounds (numbers or numeric strings only).
 * - `exists`: the path is present (`null` counts as present).
 * - `empty`: null, missing, "", [] or {}.
 * - `all` / `each` (synonyms): the value is an array and every element
 *   matches the nested matcher.
 */
export interface ValueMatcherObject {
  equals?: unknown;
  contains?: unknown;
  matches?: string;
  oneOf?: unknown[];
  atLeast?: number;
  atMost?: number;
  exists?: boolean;
  empty?: boolean;
  all?: ValueMatcher;
  each?: ValueMatcher;
  ignoreCase?: boolean;
}
export type ValueMatcher =
  | string
  | number
  | boolean
  | null
  | ValueMatcherObject;

const VALUE_MATCHER_ASSERTION_KEYS = [
  "equals",
  "contains",
  "matches",
  "oneOf",
  "atLeast",
  "atMost",
  "exists",
  "empty",
  "all",
  "each",
] as const;

/** The compile error of a regex source, or undefined when it compiles. */
function invalidRegex(source: string): string | undefined {
  try {
    return RegExp(source).source.length >= 0 ? undefined : "empty";
  } catch (error) {
    return (error as Error).message;
  }
}

export const ValueMatcherSchema: z.ZodType<ValueMatcher> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z
      .object({
        equals: z.unknown().optional(),
        contains: z.unknown().optional(),
        matches: z.string().optional(),
        oneOf: z.array(z.unknown()).nonempty().optional(),
        atLeast: z.number().optional(),
        atMost: z.number().optional(),
        exists: z.boolean().optional(),
        empty: z.boolean().optional(),
        all: ValueMatcherSchema.optional(),
        each: ValueMatcherSchema.optional(),
        ignoreCase: z.boolean().optional(),
      })
      .strict()
      .superRefine((m, ctx) => {
        const present = VALUE_MATCHER_ASSERTION_KEYS.filter((key) =>
          Object.hasOwn(m, key),
        );
        if (present.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `a matcher needs at least one of: ${VALUE_MATCHER_ASSERTION_KEYS.join(", ")}`,
          });
        }
        if (Object.hasOwn(m, "all") && Object.hasOwn(m, "each")) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["each"],
            message: "all and each are synonyms; use one",
          });
        }
        const regexError =
          m.matches !== undefined ? invalidRegex(m.matches) : undefined;
        if (regexError !== undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["matches"],
            message: `invalid regex: ${regexError}`,
          });
        }
      }),
  ]),
);

/** A `path → matcher` map; `$` (or an empty path) is the value itself. */
export const PathMatchersSchema = z
  .record(z.string(), ValueMatcherSchema)
  .refine((m) => Object.keys(m).length > 0, {
    message: "needs at least one path → matcher entry",
  });
export type PathMatchers = Record<string, ValueMatcher>;

/** Names a value later steps/outcomes read as `${captures.<name>…}`. */
const AssignNameSchema = z
  .string()
  .regex(
    /^[a-z][A-Za-z0-9_]*$/,
    "assign must start with a lowercase letter (letters, digits, _)",
  );

/**
 * Poll modifier accepted on EVERY verifier (`verify: { <kind>: …, poll: … }`).
 * The verifier is re-evaluated every `everyMs` until it passes or
 * `timeoutMs` elapses. With `stableMs`, a pass only counts once the verifier
 * held green for that long (any red sample restarts the window) — use it for
 * "exactly one, and it stays one" and "absent, and stays absent" checks.
 * `failFastOnStepFailure` (default true) evaluates once without waiting when
 * a step already failed: the side effect being polled for will not come.
 */
export const PollSchema = z
  .object({
    timeoutMs: z.number().int().positive().max(7_200_000),
    everyMs: z.number().int().min(50).max(600_000).optional(),
    stableMs: z.number().int().min(0).max(7_200_000).optional(),
    failFastOnStepFailure: z.boolean().optional(),
  })
  .strict()
  .refine(
    // The window opens at the first green sample (after that sample's I/O)
    // and needs a closing sample: it must fit with one interval to spare,
    // or the verdict depends on timing jitter.
    (p) =>
      (p.stableMs ?? 0) === 0 ||
      p.stableMs! + (p.everyMs ?? 1000) <= p.timeoutMs,
    {
      path: ["stableMs"],
      message:
        "stableMs + everyMs (default 1000) must be <= timeoutMs: the stability window opens at the first green sample and needs one more sample to close inside the budget",
    },
  );
export type Poll = z.infer<typeof PollSchema>;

/**
 * Locator for verifier targets (`table.locator`). Mirrors the spec step
 * locator vocabulary (`by: role|label|text|selector|testid`); kept here
 * because spec.v1 imports this module (a back-import would be circular).
 */
const verifierLocatorNear = {
  near: z.string().min(1).optional(),
  hasText: z.string().min(1).optional(),
  visible: z.boolean().optional(),
};
const verifierSemanticExtras = {
  exact: z.boolean().optional(),
  nth: z.number().int().min(0).optional(),
  ...verifierLocatorNear,
};
export const VerifierLocatorSchema = z.union([
  z
    .object({
      by: z.literal("role"),
      role: z.string().min(1),
      name: z.string().optional(),
      ...verifierSemanticExtras,
    })
    .strict(),
  z
    .object({
      by: z.literal("label"),
      name: z.string().min(1),
      ...verifierSemanticExtras,
    })
    .strict(),
  z
    .object({
      by: z.literal("text"),
      text: z.string().min(1),
      ...verifierSemanticExtras,
    })
    .strict(),
  z
    .object({
      by: z.literal("selector"),
      selector: z.string().min(1),
      nth: z.number().int().min(0).optional(),
      ...verifierLocatorNear,
    })
    .strict(),
  z
    .object({
      by: z.literal("testid"),
      testid: z.string().min(1),
      nth: z.number().int().min(0).optional(),
      ...verifierLocatorNear,
    })
    .strict(),
]);
export type VerifierLocator = z.infer<typeof VerifierLocatorSchema>;

/** #4 — at least one matching request happened with given properties */
export const NetworkVerifierSchema = z
  .object({
    network: z
      .object({
        method: HttpMethodSchema.optional(),
        urlContains: z.string().min(1),
        /** Absent: any status (including a still-pending request). */
        status: StatusMatcherSchema.optional(),
        /**
         * Match the captured REQUEST body (JSON `postData`): `subset`
         * (default) requires every key/value of `json`; `exact` requires
         * deep equality. Runtime refs (`${captures.x}` …) are resolved.
         */
        body: z
          .object({
            json: z.unknown(),
            match: z.enum(["exact", "subset"]).optional(),
          })
          .strict()
          .optional(),
        /**
         * Count matcher over the matching requests (`count: 1`,
         * `count: { atMost: 2 }`); without it, at least one must match.
         */
        count: ValueMatcherSchema.optional(),
        /**
         * Expose the last matching request as `${network.<assign>.at}` (ISO
         * timestamp), `.firstAt`, `.count`, `.url`, `.status`, `.body` to
         * the outcomes evaluated after this one.
         */
        assign: AssignNameSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type NetworkVerifier = z.infer<typeof NetworkVerifierSchema>;

/**
 * #5 — no matching request failed (4xx/5xx).
 * Split from `network` into its own top-level key for cleaner type narrowing.
 */
export const NoFailedRequestsVerifierSchema = z
  .object({
    noFailedRequests: z
      .object({
        urlContains: z.string().min(1),
        method: HttpMethodSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type NoFailedRequestsVerifier = z.infer<
  typeof NoFailedRequestsVerifierSchema
>;

/** #6 — bounded console errors */
export const ConsoleVerifierSchema = z
  .object({
    console: z
      .object({
        errorsMax: z.number().int().min(0),
      })
      .strict(),
  })
  .strict();
export type ConsoleVerifier = z.infer<typeof ConsoleVerifierSchema>;

/** #7 — N elements match a role/selector/text in an optional region */
export const CountVerifierSchema = z
  .object({
    count: z
      .object({
        role: z.string().optional(),
        selector: z.string().optional(),
        in_region: z.string().optional(),
        equals: z.number().int().min(0).optional(),
        atLeast: z.number().int().min(0).optional(),
        atMost: z.number().int().min(0).optional(),
        between: z
          .tuple([z.number().int().min(0), z.number().int().min(0)])
          .optional(),
      })
      .strict()
      .refine(
        (c) => [c.role, c.selector].filter((x) => x !== undefined).length >= 1,
        {
          // `text` is intentionally NOT a count target: counting elements by
          // visible text needs the a11y/innerText tree, which the count
          // verifier doesn't have. Use the `text` verifier for presence, or the
          // `script` escape hatch for a real text-based count.
          message: "must specify one of: role, selector",
        },
      )
      .refine(
        (c) =>
          [c.equals, c.atLeast, c.atMost, c.between].filter(
            (x) => x !== undefined,
          ).length === 1,
        { message: "exactly one of: equals, atLeast, atMost, between" },
      ),
  })
  .strict();
export type CountVerifier = z.infer<typeof CountVerifierSchema>;

/** #8 — workbook content checks for downloaded `.xlsx` artifacts. */
export const XlsxVerifierSchema = z
  .object({
    xlsx: z
      .object({
        path: z.string().min(1),
        sheets: z
          .array(
            z
              .object({
                name: z.string().min(1),
                contains: z.array(z.string().min(1)).optional(),
              })
              .strict(),
          )
          .optional(),
        validations: z
          .array(
            z
              .object({
                sheet: z.string().min(1),
                column: z.string().min(1),
                type: z.string().min(1).optional(),
              })
              .strict(),
          )
          .optional(),
      })
      .strict()
      .refine((x) => Boolean(x.sheets?.length || x.validations?.length), {
        message: "xlsx verifier requires sheets or validations",
      }),
  })
  .strict();
export type XlsxVerifier = z.infer<typeof XlsxVerifierSchema>;

/**
 * #9 — poll for a file on disk, optionally requiring its text to contain a
 * needle. Covers file-based test doubles generically (e.g. a local email
 * driver writing `*-welcome-user@example.com.json` captures) without a
 * hand-rolled script poller.
 *
 * `glob` resolves relative to the spec's directory; `*` and `?` wildcards are
 * supported in the FILENAME only — the directory part is literal.
 */
export const FileVerifierSchema = z
  .object({
    file: z
      .object({
        glob: z.string().min(1),
        contains: z.string().min(1).optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
  })
  .strict();
export type FileVerifier = z.infer<typeof FileVerifierSchema>;

/** #10 — fetch JSON from the app and assert a simple JSON path. */
const httpJsonMatcherShape = {
  equals: z.unknown().optional(),
  contains: z.union([z.string(), z.number(), z.boolean()]).optional(),
  matches: z.string().optional(),
  atLeast: z.number().optional(),
  atMost: z.number().optional(),
  exists: z.boolean().optional(),
};

export const HttpJsonMatcherSchema = z
  .object(httpJsonMatcherShape)
  .strict()
  .refine(
    (m) =>
      [m.equals, m.contains, m.matches, m.atLeast, m.atMost, m.exists].filter(
        (x) => x !== undefined,
      ).length === 1,
    {
      message:
        "exactly one of: equals, contains, matches, atLeast, atMost, exists",
    },
  );
export type HttpJsonMatcher = z.infer<typeof HttpJsonMatcherSchema>;

export const HttpJsonVerifierSchema = z
  .object({
    httpJson: z
      .object({
        url: z.string().min(1),
        jsonPath: z.string().min(1).default("$"),
        ...httpJsonMatcherShape,
      })
      .strict()
      .refine(
        (m) =>
          [
            m.equals,
            m.contains,
            m.matches,
            m.atLeast,
            m.atMost,
            m.exists,
          ].filter((x) => x !== undefined).length === 1,
        {
          message:
            "exactly one of: equals, contains, matches, atLeast, atMost, exists",
        },
      ),
  })
  .strict();
export type HttpJsonVerifier = z.infer<typeof HttpJsonVerifierSchema>;

/**
 * Escape hatch — page-evaluated JS returning { ok, evidence }.
 * `evidence` is truncated per §13b; untruncated form goes to outcomes/<id>.raw.json.
 */
/** A JSON value nested inside a structured script fixture. */
export type ScriptFixtureJson =
  | string
  | number
  | boolean
  | null
  | ScriptFixtureJson[]
  | { [key: string]: ScriptFixtureJson };
const ScriptFixtureJsonSchema: z.ZodType<ScriptFixtureJson> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(ScriptFixtureJsonSchema),
    z.record(z.string(), ScriptFixtureJsonSchema),
  ]),
);
/** A script fixture as the verifier receives it: a string, or a list/map. */
export type ScriptFixtureValue =
  | string
  | ScriptFixtureJson[]
  | { [key: string]: ScriptFixtureJson };

export const ScriptVerifierSchema = z
  .object({
    script: z
      .object({
        runtime: z.enum(["browser", "node"]).optional(),
        // 1.13.0: fixture values are handed to verifiers as strings, but spec authors routinely
        // supply numbers/booleans — most often via ${var} interpolation (e.g. an expected row
        // count of 0). Accept those scalars and stringify them instead of failing the whole script
        // verifier. Because ScriptVerifierSchema is one member of the strict VerifierSchema union,
        // a single bad fixture value used to surface as a misleading "Unrecognized key(s): 'script'"
        // (every sibling member rejecting the unmatched `script` key), which read as "the script
        // verifier isn't supported".
        // 2.16: structured fixtures — a top-level list or map passes through as JSON (nested
        // values keep their types), so verifiers stop decoding pipe-lists and JSON-in-strings.
        // Top-level scalars stay strings for existing scripts; the SDK coerces them to the
        // type its contract declares.
        fixtures: z
          .record(
            z.string(),
            z.union([
              z
                .union([z.string(), z.number(), z.boolean()])
                .transform((v) => String(v)),
              z.array(ScriptFixtureJsonSchema),
              z.record(z.string(), ScriptFixtureJsonSchema),
            ]),
          )
          .optional(),
        run: z.string().min(1).optional(),
        file: z.string().min(1).optional(),
        /**
         * Hard budget for `runtime: node` scripts, which otherwise run
         * unbounded — a verifier that polls for an external side effect can
         * spend whatever completion window it implements internally, and
         * nothing above it caps a bug. Browser scripts are already bounded
         * by the backend's evaluate timeout; this field is ignored there.
         */
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .refine(
        (s) => [s.run, s.file].filter((x) => x !== undefined).length === 1,
        { message: "exactly one of: run, file" },
      ),
  })
  .strict();
export type ScriptVerifier = z.infer<typeof ScriptVerifierSchema>;

/**
 * #11 — assert on monitor-reported browser process metrics as an outcome.
 *
 * Backed by the `--monitor` run sampler (ProcessMetricsSummary). Each matcher
 * is optional; every present matcher must pass. RSS matchers compare against
 * megabytes (author-friendly: `peakRss: { below: 500 }` = 500 MB). CPU
 * matchers compare against summed tree CPU percent (may exceed 100 on
 * multi-core). `samples` compares against the number of successful ticks.
 *
 * Reports `skipped` (not `failed`) when no sampler ran — i.e. the run wasn't
 * started with `--monitor` / `MONITOR=1`, so there are no metrics to assert on.
 */
const processMetricMatcherSchema = z
  .object({
    below: z.number().optional(),
    atLeast: z.number().optional(),
    equals: z.number().optional(),
  })
  .strict()
  .refine(
    (m) =>
      [m.below, m.atLeast, m.equals].filter((x) => x !== undefined).length ===
      1,
    { message: "exactly one of: below, atLeast, equals" },
  );

export const ProcessVerifierSchema = z
  .object({
    process: z
      .object({
        /** Peak tree RSS (MB). */
        peakRss: processMetricMatcherSchema.optional(),
        /** Mean tree RSS (MB). */
        meanRss: processMetricMatcherSchema.optional(),
        /** Final tree RSS at the last sample (MB). */
        finalRss: processMetricMatcherSchema.optional(),
        /** Peak summed tree CPU%. */
        peakCpu: processMetricMatcherSchema.optional(),
        /** Mean summed tree CPU%. */
        meanCpu: processMetricMatcherSchema.optional(),
        /** Number of successful sample points. */
        samples: processMetricMatcherSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type ProcessVerifier = z.infer<typeof ProcessVerifierSchema>;

/* ----- datasource verifiers (config `datasources:`) ----- */

/**
 * #13 — query a `kind: mongo` datasource. `filter` / `projection` / `sort`
 * are extended JSON (`{ $oid: … }`, `{ $date: … }`); runtime refs are
 * resolved first and a string that is exactly one placeholder keeps its
 * type (an object/number/array stays one). Values are passed to the
 * transport as data, never spliced into shell or JS source.
 *
 * `expect.count` matches `countDocuments(filter)`; `exists` is sugar for
 * count ≥ 1 / count = 0; `fields` paths are read from the FIRST document of
 * the (sorted) result — sort `{ updatedAt: -1 }` to assert on the latest.
 * Without `expect` the verifier requires at least one document.
 */
export const MongoVerifierSchema = z
  .object({
    mongo: z
      .object({
        source: z.string().min(1),
        collection: z.string().min(1),
        /** Override the datasource `database` for this query. */
        database: z.string().min(1).optional(),
        filter: z.record(z.string(), z.unknown()).optional(),
        projection: z.record(z.string(), z.unknown()).optional(),
        sort: z
          .record(z.string(), z.union([z.literal(1), z.literal(-1)]))
          .optional(),
        /** Documents fetched per attempt (default 20, max 100). */
        limit: z.number().int().min(1).max(100).optional(),
        /** Per-query deadline (default 15000ms, capped by the poll budget). */
        queryTimeoutMs: z.number().int().positive().optional(),
        /** Expose `{count, docs}` (relaxed EJSON) as `${captures.<assign>…}`. */
        assign: AssignNameSchema.optional(),
        expect: z
          .object({
            count: ValueMatcherSchema.optional(),
            exists: z.boolean().optional(),
            fields: PathMatchersSchema.optional(),
          })
          .strict()
          .refine(
            (e) =>
              e.count !== undefined ||
              e.exists !== undefined ||
              e.fields !== undefined,
            { message: "expect needs at least one of: count, exists, fields" },
          )
          .optional(),
      })
      .strict(),
  })
  .strict();
export type MongoVerifier = z.infer<typeof MongoVerifierSchema>;

/**
 * #14 — inspect a Temporal workflow through a `kind: temporal` datasource
 * (the Temporal UI / HTTP API). Exactly one of `workflowId` (describe; a
 * 404 is absence) or `query` (visibility list query, e.g.
 * `WorkflowType='Sync' AND ExecutionStatus='Running'`). `activities` and
 * `inputBytes` read the workflow history (all pages, following
 * continue-as-new); `count` applies to `query`.
 */
export const TemporalVerifierSchema = z
  .object({
    temporal: z
      .object({
        source: z.string().min(1),
        workflowId: z.string().min(1).optional(),
        runId: z.string().min(1).optional(),
        query: z.string().min(1).optional(),
        /** Per-request deadline (default 15000ms, capped by the poll budget). */
        requestTimeoutMs: z.number().int().positive().optional(),
        /** Expose `{workflowId, runId, status, …}` as `${captures.<assign>…}`. */
        assign: AssignNameSchema.optional(),
        expect: z
          .object({
            /** Status without the WORKFLOW_EXECUTION_STATUS_ prefix; a list = any of. */
            status: z
              .union([z.string().min(1), z.array(z.string().min(1)).nonempty()])
              .optional(),
            count: ValueMatcherSchema.optional(),
            activities: z
              .object({
                includeAnyOf: z.array(z.string().min(1)).nonempty().optional(),
                includeAll: z.array(z.string().min(1)).nonempty().optional(),
                /** Highest activity attempt allowed (retries show as attempt > 1). */
                maxAttempts: z.number().int().positive().optional(),
              })
              .strict()
              .refine(
                (a) =>
                  a.includeAnyOf !== undefined ||
                  a.includeAll !== undefined ||
                  a.maxAttempts !== undefined,
                {
                  message:
                    "activities needs at least one of: includeAnyOf, includeAll, maxAttempts",
                },
              )
              .optional(),
            inputBytes: z
              .object({ atMost: z.number().int().nonnegative() })
              .strict()
              .optional(),
            /** No such workflow (404 / zero matches); `{ stableMs }` = and it stays absent. */
            absent: z
              .union([
                z.boolean(),
                z.object({ stableMs: z.number().int().positive() }).strict(),
              ])
              .optional(),
          })
          .strict()
          .refine((e) => Object.keys(e).length > 0, {
            message:
              "expect needs at least one of: status, count, activities, inputBytes, absent",
          }),
      })
      .strict()
      .superRefine((t, ctx) => {
        if ((t.workflowId === undefined) === (t.query === undefined)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "exactly one of: workflowId, query",
          });
        }
        if (t.runId !== undefined && t.workflowId === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["runId"],
            message: "runId requires workflowId",
          });
        }
        if (t.expect.count !== undefined && t.query === undefined) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["expect", "count"],
            message: "expect.count applies to query",
          });
        }
        if (
          t.expect.absent !== undefined &&
          t.expect.absent !== false &&
          Object.keys(t.expect).length > 1
        ) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["expect", "absent"],
            message: "expect.absent cannot be combined with other expectations",
          });
        }
      }),
  })
  .strict();
export type TemporalVerifier = z.infer<typeof TemporalVerifierSchema>;

/**
 * #15 — a Node-side HTTP call (no browser cookies; use `httpJson` or a
 * `request` step for session-authenticated calls). With `source`, `url` is
 * resolved against the `kind: http` datasource `baseUrl` and its headers /
 * auth are sent; without it, `url` is absolute or relative to the
 * environment `baseUrl`. Default expectation: a 2xx status.
 */
export const HttpVerifierSchema = z
  .object({
    http: z
      .object({
        source: z.string().min(1).optional(),
        url: z.string().min(1),
        method: HttpMethodSchema.optional(),
        headers: z.record(z.string(), z.string()).optional(),
        body: z.unknown().optional(),
        /** Per-request deadline (default 15000ms, capped by the poll budget). */
        requestTimeoutMs: z.number().int().positive().optional(),
        /** Expose `{status, body}` as `${captures.<assign>…}`. */
        assign: AssignNameSchema.optional(),
        expect: z
          .object({
            status: z.union([z.number().int(), StatusMatcherSchema]).optional(),
            json: PathMatchersSchema.optional(),
          })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();
export type HttpVerifier = z.infer<typeof HttpVerifierSchema>;

/**
 * #16 — assert on a value the run already holds: `actual` is a runtime
 * expression (`${evals.state.value}`, `${requests.save.body}`,
 * `${captures.rows}`, `${fixtures.kit.id}`, `${network.save.at}`); a string
 * that is exactly one placeholder keeps its type. `file` reads JSON (or
 * text) from disk instead (artifact placeholders allowed, relative paths
 * resolve against the spec directory). `expect` maps paths (`$` = the value
 * itself) to matchers.
 */
export const ValueVerifierSchema = z
  .object({
    value: z
      .object({
        actual: z.unknown().optional(),
        file: z.string().min(1).optional(),
        expect: PathMatchersSchema,
      })
      .strict()
      .refine(
        (v) =>
          (Object.hasOwn(v, "actual") ? 1 : 0) +
            (v.file !== undefined ? 1 : 0) ===
          1,
        { message: "exactly one of: actual, file" },
      ),
  })
  .strict();
export type ValueVerifier = z.infer<typeof ValueVerifierSchema>;

/**
 * #17 — read a rendered table (`<table>`, or role table/grid with row and
 * cell roles) resolved by `locator`. `rows` bounds the data-row count;
 * `noBlank` fails on a row whose cells are all empty (cells whose text or
 * column header is listed in `ignoreCells` — e.g. Edit/Delete — don't
 * count). `contains` entries must each match a row: a string matches the
 * row text, an object maps column headers to cell text (whitespace-
 * normalized, case-insensitive substring). `headers.includes` lists
 * required column headers (`inOrder: true` = in that relative order).
 */
export const TableVerifierSchema = z
  .object({
    table: z
      .object({
        locator: VerifierLocatorSchema,
        rows: z
          .object({
            equals: z.number().int().min(0).optional(),
            atLeast: z.number().int().min(0).optional(),
            atMost: z.number().int().min(0).optional(),
            noBlank: z.boolean().optional(),
            ignoreCells: z.array(z.string()).optional(),
          })
          .strict()
          .optional(),
        contains: z
          .array(
            z.union([
              z.string().min(1),
              z
                .record(z.string(), z.string())
                .refine((row) => Object.keys(row).length > 0, {
                  message: "a row matcher maps at least one column",
                }),
            ]),
          )
          .nonempty()
          .optional(),
        headers: z
          .object({
            includes: z.array(z.string().min(1)).nonempty(),
            inOrder: z.boolean().optional(),
          })
          .strict()
          .optional(),
        /** How long to wait for the table to render (default 5000ms). */
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .refine(
        (t) =>
          t.rows !== undefined ||
          t.contains !== undefined ||
          t.headers !== undefined,
        { message: "table needs at least one of: rows, contains, headers" },
      ),
  })
  .strict();
export type TableVerifier = z.infer<typeof TableVerifierSchema>;

/* ----- the union ----- */

/** Every verifier accepts the `poll` modifier next to its kind key. */
const pollModifier = { poll: PollSchema.optional() };

export const VerifierSchema = z.union([
  TextVerifierSchema.extend(pollModifier),
  NotTextVerifierSchema.extend(pollModifier),
  UrlVerifierSchema.extend(pollModifier),
  NetworkVerifierSchema.extend(pollModifier),
  NoFailedRequestsVerifierSchema.extend(pollModifier),
  ConsoleVerifierSchema.extend(pollModifier),
  CountVerifierSchema.extend(pollModifier),
  XlsxVerifierSchema.extend(pollModifier),
  FileVerifierSchema.extend(pollModifier),
  HttpJsonVerifierSchema.extend(pollModifier),
  ScriptVerifierSchema.extend(pollModifier),
  ProcessVerifierSchema.extend(pollModifier),
  MongoVerifierSchema.extend(pollModifier),
  TemporalVerifierSchema.extend(pollModifier),
  HttpVerifierSchema.extend(pollModifier),
  ValueVerifierSchema.extend(pollModifier),
  TableVerifierSchema.extend(pollModifier),
]);
export type Verifier = z.infer<typeof VerifierSchema>;

/** The `poll` modifier of a verifier, when it declares one. */
export function verifierPoll(v: Verifier): Poll | undefined {
  return (v as { poll?: Poll }).poll;
}

/** Stable identifier for each verifier variant — used by `cairn explain --json`. */
export const VerifierKindSchema = z.enum([
  "text",
  "notText",
  "url",
  "network",
  "noFailedRequests",
  "console",
  "count",
  "xlsx",
  "file",
  "httpJson",
  "script",
  "process",
  "mongo",
  "temporal",
  "http",
  "value",
  "table",
]);
export type VerifierKind = z.infer<typeof VerifierKindSchema>;

/* ----- type predicates for narrowing ----- */

export const isTextVerifier = (v: Verifier): v is TextVerifier => "text" in v;
export const isNotTextVerifier = (v: Verifier): v is NotTextVerifier =>
  "notText" in v;
export const isUrlVerifier = (v: Verifier): v is UrlVerifier => "url" in v;
export const isNetworkVerifier = (v: Verifier): v is NetworkVerifier =>
  "network" in v;
export const isNoFailedRequestsVerifier = (
  v: Verifier,
): v is NoFailedRequestsVerifier => "noFailedRequests" in v;
export const isConsoleVerifier = (v: Verifier): v is ConsoleVerifier =>
  "console" in v;
export const isCountVerifier = (v: Verifier): v is CountVerifier =>
  "count" in v;
export const isXlsxVerifier = (v: Verifier): v is XlsxVerifier => "xlsx" in v;
export const isFileVerifier = (v: Verifier): v is FileVerifier => "file" in v;
export const isHttpJsonVerifier = (v: Verifier): v is HttpJsonVerifier =>
  "httpJson" in v;
export const isScriptVerifier = (v: Verifier): v is ScriptVerifier =>
  "script" in v;
export const isProcessVerifier = (v: Verifier): v is ProcessVerifier =>
  "process" in v;
export const isMongoVerifier = (v: Verifier): v is MongoVerifier =>
  "mongo" in v;
export const isTemporalVerifier = (v: Verifier): v is TemporalVerifier =>
  "temporal" in v;
export const isHttpVerifier = (v: Verifier): v is HttpVerifier => "http" in v;
export const isValueVerifier = (v: Verifier): v is ValueVerifier =>
  "value" in v;
export const isTableVerifier = (v: Verifier): v is TableVerifier =>
  "table" in v;

export const verifierKind = (v: Verifier): VerifierKind => {
  if (isMongoVerifier(v)) return "mongo";
  if (isTemporalVerifier(v)) return "temporal";
  if (isHttpVerifier(v)) return "http";
  if (isValueVerifier(v)) return "value";
  if (isTableVerifier(v)) return "table";
  if (isTextVerifier(v)) return "text";
  if (isNotTextVerifier(v)) return "notText";
  if (isUrlVerifier(v)) return "url";
  if (isNetworkVerifier(v)) return "network";
  if (isNoFailedRequestsVerifier(v)) return "noFailedRequests";
  if (isConsoleVerifier(v)) return "console";
  if (isCountVerifier(v)) return "count";
  if (isXlsxVerifier(v)) return "xlsx";
  if (isFileVerifier(v)) return "file";
  if (isHttpJsonVerifier(v)) return "httpJson";
  if (isScriptVerifier(v)) return "script";
  return "process";
};
