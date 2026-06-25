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
    /** Optional selector region for text/notText checks. */
    region: z.string().optional(),
  })
  .strict()
  .refine(
    (m) =>
      [m.equals, m.contains, m.matches].filter((x) => x !== undefined)
        .length === 1,
    { message: "exactly one of: equals, contains, matches" },
  );
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

/** #4 — at least one matching request happened with given properties */
export const NetworkVerifierSchema = z
  .object({
    network: z
      .object({
        method: HttpMethodSchema.optional(),
        urlContains: z.string().min(1),
        status: StatusMatcherSchema,
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
        text: z.string().optional(),
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
        (c) =>
          [c.role, c.selector, c.text].filter((x) => x !== undefined).length >=
          1,
        { message: "must specify one of: role, selector, text" },
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
        // verifier isn't supported". Objects/arrays are still rejected as genuine errors.
        fixtures: z
          .record(
            z.string(),
            z
              .union([z.string(), z.number(), z.boolean()])
              .transform((v) => String(v)),
          )
          .optional(),
        run: z.string().min(1).optional(),
        file: z.string().min(1).optional(),
      })
      .strict()
      .refine(
        (s) => [s.run, s.file].filter((x) => x !== undefined).length === 1,
        { message: "exactly one of: run, file" },
      ),
  })
  .strict();
export type ScriptVerifier = z.infer<typeof ScriptVerifierSchema>;

/* ----- the union ----- */

export const VerifierSchema = z.union([
  TextVerifierSchema,
  NotTextVerifierSchema,
  UrlVerifierSchema,
  NetworkVerifierSchema,
  NoFailedRequestsVerifierSchema,
  ConsoleVerifierSchema,
  CountVerifierSchema,
  XlsxVerifierSchema,
  FileVerifierSchema,
  HttpJsonVerifierSchema,
  ScriptVerifierSchema,
]);
export type Verifier = z.infer<typeof VerifierSchema>;

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

export const verifierKind = (v: Verifier): VerifierKind => {
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
  return "script";
};
