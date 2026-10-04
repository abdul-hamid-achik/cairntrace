import { z } from "zod";
import { HttpMethodSchema, PathMatchersSchema } from "./verifier.v1";

/**
 * The typed `request` step (spec `steps:`) and the environment `auth:` block
 * (config `environments.<name>.auth`) share these schemas. A leaf module:
 * spec.v1 and config.v1 both import it, so neither has to import the other.
 */

/** Most extra attempts one `request.retry` may make. */
export const REQUEST_RETRY_MAX_TIMES = 10;
/** Most requests one `request.matrix` may expand to. */
export const REQUEST_MATRIX_MAX_COMBINATIONS = 200;
/** Whole-poll budget of `request.until` when it sets no `timeoutMs`. */
export const DEFAULT_REQUEST_UNTIL_TIMEOUT_MS = 30_000;
/** Pause between `request.until` attempts when it sets no `every`. */
export const DEFAULT_REQUEST_UNTIL_EVERY_MS = 1_000;
/** Pause between `request.retry` attempts when it sets no `delayMs`. */
export const DEFAULT_REQUEST_RETRY_DELAY_MS = 500;

/** `assign` / `capture` / `matrix` key names. */
const RequestNameSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][A-Za-z0-9_]*$/);
const RequestKeySchema = z
  .string()
  .min(1)
  .regex(/^[A-Za-z_][A-Za-z0-9_]*$/, "a key: letters, digits and _");

/** One status or a non-empty list (`expectStatus`, `until.status`). */
export const RequestStatusListSchema = z.union([
  z.number().int(),
  z.array(z.number().int()).nonempty(),
]);
export type RequestStatusList = z.infer<typeof RequestStatusListSchema>;

/**
 * `credentials: include` (default) sends the browser session's cookies and
 * keeps any `Set-Cookie` the response carries; `omit` sends none and keeps
 * none (an anonymous caller, e.g. an authorization-boundary check).
 */
export const RequestCredentialsSchema = z.enum(["include", "omit"]);
export type RequestCredentials = z.infer<typeof RequestCredentialsSchema>;

/**
 * `until`: send the request again until the response satisfies every
 * present check — `status` (one of these) and `json` (`path → matcher`,
 * the shared data matchers; paths may filter: `$.tasks[?(@.title=="x")]`).
 * `every` (ms, default 1000) is the pause between attempts and `timeoutMs`
 * (default 30000) the whole poll's budget; the request's own `timeoutMs`
 * still bounds each attempt. A transport error counts as "not yet".
 */
export const RequestUntilSchema = z
  .object({
    status: RequestStatusListSchema.optional(),
    json: PathMatchersSchema.optional(),
    every: z.number().int().min(50).max(60_000).optional(),
    timeoutMs: z.number().int().positive().max(3_600_000).optional(),
  })
  .strict()
  .refine((until) => until.status !== undefined || until.json !== undefined, {
    message: "request.until needs status or json",
  });
export type RequestUntil = z.infer<typeof RequestUntilSchema>;

/** What `retry.on` re-sends after: a 5xx answer, a transport failure. */
export const RequestRetryOnSchema = z.enum(["5xx", "network"]);
export type RequestRetryOn = z.infer<typeof RequestRetryOnSchema>;

/**
 * `retry`: re-send after a 5xx answer or a transport failure (`on`, default
 * both), at most `times` more attempts, `delayMs` (default 500) apart. Any
 * other answer (2xx–4xx) is final.
 */
export const RequestRetrySchema = z
  .object({
    times: z.number().int().min(1).max(REQUEST_RETRY_MAX_TIMES),
    on: z.array(RequestRetryOnSchema).nonempty().optional(),
    delayMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();
export type RequestRetry = z.infer<typeof RequestRetrySchema>;

/**
 * `capture: { <key>: <path> }` reads values out of the JSON response into
 * `${requests.<assign>.captures.<key>}`. A path is `$.a.b`, `items[0].id`,
 * `rows[*].name` or a filter `$.tasks[?(@.title=="x")].id` (`==`, `!=`,
 * `<`, `<=`, `>`, `>=`, `&&`, `||`, or a bare `@.field` for presence). A
 * wildcard or filter path captures its first match. A path that matches
 * nothing fails the step.
 */
export const RequestCaptureSchema = z
  .record(RequestKeySchema, z.string().min(1))
  .refine((capture) => Object.keys(capture).length > 0, {
    message: "request.capture needs at least one key",
  });
export type RequestCapture = z.infer<typeof RequestCaptureSchema>;

/**
 * `matrix: { <key>: [values] }`: one request per combination (the cartesian
 * product, keys in order), each spliced with `${matrix.<key>}` (or
 * `${matrix.<key>.<field>}` for an object value) in `url`, `method`,
 * `headers` and `body`. A whole `${matrix.<key>}` value keeps its type, so
 * `body: ${matrix.route.body}` sends an object. Every combination runs; the
 * step fails listing each combination whose status is not in `expectStatus`.
 */
export const RequestMatrixSchema = z
  .record(RequestKeySchema, z.array(z.unknown()).min(1))
  .refine((matrix) => Object.keys(matrix).length > 0, {
    message: "request.matrix needs at least one key",
  });
export type RequestMatrix = z.infer<typeof RequestMatrixSchema>;

const MATRIX_METHOD_RE =
  /^\$\{matrix\.[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)*\}$/;
/** Every `${matrix.<key>…}` reference in a string (key in group 1). */
export const MATRIX_REF_RE =
  /\$\{matrix\.([A-Za-z_][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\}/g;

const RequestFieldsShape = {
  /**
   * An HTTP method; with `matrix`, also a whole `${matrix.<key>…}` reference
   * that names one per combination.
   */
  method: z
    .union([
      HttpMethodSchema,
      z
        .string()
        .regex(
          MATRIX_METHOD_RE,
          "method: GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS, or ${matrix.<key>} with matrix",
        ),
    ])
    .default("GET"),
  url: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  /** Objects are JSON-encoded (content-type: application/json unless overridden); strings are sent raw. */
  body: z.unknown().optional(),
  /** Per-request (per-attempt) hard deadline. Defaults to 30000ms. */
  timeoutMs: z.number().int().positive().optional(),
  /** Fail the step unless the response status is (one of) these. Omit to accept any completed response. */
  expectStatus: RequestStatusListSchema.optional(),
  assign: RequestNameSchema.optional(),
};

/** Strings of a value (url, headers, body) for `${matrix.…}` checks. */
function stringsOf(value: unknown, out: string[] = []): string[] {
  if (typeof value === "string") out.push(value);
  else if (Array.isArray(value)) value.forEach((item) => stringsOf(item, out));
  else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) stringsOf(item, out);
  }
  return out;
}

/** Number of requests a matrix expands to (the cartesian product). */
export function matrixCombinationCount(matrix: RequestMatrix): number {
  return Object.values(matrix).reduce((n, values) => n * values.length, 1);
}

/**
 * Typed API call (the promotion of the fetch+cookie glue that kept
 * reappearing in `script` verifiers). Backends with a native request
 * primitive execute it out of page while sharing the browser context's cookie
 * jar. The Playwright Bun bridge runs in an isolated subprocess so the parent
 * can enforce `timeoutMs` even if native fetch stalls; other backends fall
 * back to a timeout-bounded page fetch. Relative `url` resolves against
 * config `baseUrl` when present, otherwise against the current page origin.
 *
 * `assign` names the captured response: the full envelope is written to
 * `requests/<name>.json` (also addressable as `${artifacts.<name>.path}`),
 * and later steps/fixtures can splice response fields with
 * `${requests.<name>.body.<field>}` / `${requests.<name>.status}` /
 * `${requests.<name>.captures.<key>}` — e.g. fetch a QR token via API, then
 * `fill` it into the scanner UI, or send a captured bearer in `headers`.
 *
 * v2 (all optional, additive): `credentials`, `until` (+ `every`,
 * `timeoutMs` inside it), `retry`, `capture`, `matrix`.
 */
export const RequestTargetSchema = z
  .object({
    ...RequestFieldsShape,
    credentials: RequestCredentialsSchema.optional(),
    until: RequestUntilSchema.optional(),
    retry: RequestRetrySchema.optional(),
    capture: RequestCaptureSchema.optional(),
    matrix: RequestMatrixSchema.optional(),
  })
  .strict()
  .superRefine((request, ctx) => {
    if (request.until && request.retry) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["retry"],
        message:
          "request.until already re-sends the request until it holds; drop retry",
      });
    }
    const matrix = request.matrix;
    if (matrix) {
      for (const key of ["until", "capture"] as const) {
        if (request[key] === undefined) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `request.matrix sends one request per combination; ${key} is not supported with it`,
        });
      }
      const count = matrixCombinationCount(matrix);
      if (count > REQUEST_MATRIX_MAX_COMBINATIONS) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["matrix"],
          message: `request.matrix expands to ${count} requests (at most ${REQUEST_MATRIX_MAX_COMBINATIONS}); split the step`,
        });
      }
    }
    const fields = {
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: request.body,
    };
    for (const [field, value] of Object.entries(fields)) {
      for (const text of stringsOf(value)) {
        for (const match of text.matchAll(MATRIX_REF_RE)) {
          const key = match[1]!;
          if (!matrix) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [field],
              message: `\${matrix.${key}} needs a request.matrix`,
            });
          } else if (!Object.hasOwn(matrix, key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: [field],
              message: `\${matrix.${key}}: the matrix has no key "${key}" (keys: ${Object.keys(matrix).join(", ")})`,
            });
          }
        }
      }
    }
  });
export type RequestTarget = z.infer<typeof RequestTargetSchema>;

/* ----- environment auth (config environments.<name>.auth) ----- */

/**
 * `alreadyAuthenticated`: a probe sent before logging in. When its answer
 * satisfies `status` (default any 2xx) and every `json` matcher, the session
 * is already this user's and the login is skipped. Matcher operands may use
 * `${secrets.X}` (e.g. the expected email); they are redacted like the rest.
 */
export const EnvAuthCheckSchema = z
  .object({
    method: HttpMethodSchema.default("GET"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
    status: RequestStatusListSchema.optional(),
    json: PathMatchersSchema.optional(),
  })
  .strict();
export type EnvAuthCheck = z.infer<typeof EnvAuthCheckSchema>;

/**
 * `login`: the request that signs in (default `POST`). `body` and `headers`
 * take `${secrets.X}` / `${env.X}` / `${vars.X}`, resolved when it runs and
 * never written to artifacts. Its response is `${requests.login.…}`.
 */
export const EnvAuthLoginSchema = z
  .object({
    method: HttpMethodSchema.default("POST"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    timeoutMs: z.number().int().positive().optional(),
    expectStatus: RequestStatusListSchema.optional(),
    retry: RequestRetrySchema.optional(),
    capture: RequestCaptureSchema.optional(),
  })
  .strict();
export type EnvAuthLogin = z.infer<typeof EnvAuthLoginSchema>;

/**
 * A follow-up of the login (an OTP verify with the captured bearer, an
 * entity switch): a request plus an optional `when` var predicate over
 * runtime values (`{ var: requests.login.body.user.mfa, equals: otp }`).
 */
export const EnvAuthAfterStepSchema = z
  .object({
    id: z.string().min(1).optional(),
    when: z
      .object({
        var: z
          .string()
          .min(1)
          .regex(/^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/),
        equals: z.union([z.string(), z.number(), z.boolean()]).optional(),
        in: z
          .array(z.union([z.string(), z.number(), z.boolean()]))
          .min(1)
          .optional(),
        exists: z.boolean().optional(),
      })
      .strict()
      .refine(
        (when) =>
          [when.equals, when.in, when.exists].filter((v) => v !== undefined)
            .length === 1,
        {
          message: "auth.after when needs exactly one of equals | in | exists",
        },
      )
      .optional(),
    request: z
      .object({
        ...RequestFieldsShape,
        method: HttpMethodSchema.default("GET"),
        credentials: RequestCredentialsSchema.optional(),
        retry: RequestRetrySchema.optional(),
        capture: RequestCaptureSchema.optional(),
      })
      .strict(),
  })
  .strict();
export type EnvAuthAfterStep = z.infer<typeof EnvAuthAfterStepSchema>;

/**
 * `hydrate`: page JavaScript run once after a fresh login (inline `eval`
 * or a `file` relative to the config directory), for an app that only
 * reads its session from a client store. It sees `args.login` (the login
 * response body) — never the credentials.
 */
export const EnvAuthHydrateSchema = z
  .object({
    eval: z.string().min(1).optional(),
    file: z.string().min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .refine(
    (hydrate) => (hydrate.eval === undefined) !== (hydrate.file === undefined),
    {
      message: "auth.hydrate needs exactly one of eval or file",
    },
  );
export type EnvAuthHydrate = z.infer<typeof EnvAuthHydrateSchema>;

/**
 * `environments.<name>.auth`: how `use: login` signs a run in through the
 * API instead of the sign-in form — `alreadyAuthenticated?` probe, `login`
 * request, `after?` follow-ups, `hydrate?` page script. Secrets come from
 * the run's provider (`${secrets.X}`) and never reach artifacts.
 */
export const EnvAuthSchema = z
  .object({
    login: EnvAuthLoginSchema,
    alreadyAuthenticated: EnvAuthCheckSchema.optional(),
    after: z.array(EnvAuthAfterStepSchema).max(20).optional(),
    hydrate: EnvAuthHydrateSchema.optional(),
  })
  .strict();
export type EnvAuth = z.infer<typeof EnvAuthSchema>;

/** The built-in action `use: login` runs (environment auth). */
export const BUILTIN_LOGIN_ACTION = "login";
