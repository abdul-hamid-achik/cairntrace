import { z } from "zod";
import { BackendSchema, ContractHashSchema } from "./shared";
import { VerifierSchema } from "./verifier.v1";

/**
 * Behavioral spec format v1 (plan §10).
 * Intent + outcomes are the contract; steps are repairable hints.
 *
 * The contractHash (sha256 of intent + outcomes) is stamped by `cairn spec scaffold`
 * and validated by `cairn spec heal` to enforce contract immutability.
 */

/* ----- locators (used by click / hover / fill / upload / count) ----- */

/**
 * Disambiguators shared by the semantic (role/label/text) locators.
 * Default name matching is case-insensitive whole-name against the
 * accessibility tree; multiple visible matches are a hard error.
 */
const semanticLocatorExtras = {
  /** Case-sensitive whole-name match (default: case-insensitive whole-name). */
  exact: z.boolean().optional(),
  /** Pick the Nth match (0-based, document order) when several elements match. */
  nth: z.number().int().min(0).optional(),
};

export const RoleLocatorSchema = z
  .object({
    by: z.literal("role"),
    role: z.string().min(1),
    name: z.string().optional(),
    ...semanticLocatorExtras,
  })
  .strict();
export const LabelLocatorSchema = z
  .object({
    by: z.literal("label"),
    name: z.string().min(1),
    ...semanticLocatorExtras,
  })
  .strict();
export const TextLocatorSchema = z
  .object({
    by: z.literal("text"),
    text: z.string().min(1),
    ...semanticLocatorExtras,
  })
  .strict();
export const SelectorLocatorSchema = z
  .object({
    by: z.literal("selector"),
    selector: z.string().min(1),
  })
  .strict();

export const LocatorSchema = z.union([
  RoleLocatorSchema,
  LabelLocatorSchema,
  TextLocatorSchema,
  SelectorLocatorSchema,
]);
export type Locator = z.infer<typeof LocatorSchema>;

const fillTargetSchema = z.union([
  RoleLocatorSchema.extend({ value: z.string() }).strict(),
  LabelLocatorSchema.extend({ value: z.string() }).strict(),
  TextLocatorSchema.extend({ value: z.string() }).strict(),
  SelectorLocatorSchema.extend({ value: z.string() }).strict(),
]);

const uploadTargetSchema = z.union([
  RoleLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  LabelLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  TextLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  SelectorLocatorSchema.extend({ path: z.string().min(1) }).strict(),
]);

const downloadTargetSchema = z.union([
  RoleLocatorSchema.extend({
    saveAs: z.string().min(1),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  LabelLocatorSchema.extend({
    saveAs: z.string().min(1),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  TextLocatorSchema.extend({
    saveAs: z.string().min(1),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  SelectorLocatorSchema.extend({
    saveAs: z.string().min(1),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
]);

const artifactAssignSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][A-Za-z0-9_]*$/);

const transformTargetSchema = z
  .object({
    runtime: z.literal("node").optional(),
    file: z.string().min(1),
    input: z.string().min(1),
    saveAs: z.string().min(1),
    assign: artifactAssignSchema.optional(),
    fixtures: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/**
 * Typed authenticated API call (the promotion of the fetch+cookie glue that
 * kept reappearing in `script` verifiers). Backends with a native request
 * primitive execute it out of page while sharing the browser context's cookie
 * jar. The Playwright Bun bridge runs in an isolated subprocess so the parent
 * can enforce `timeoutMs` even if native fetch stalls; older backends fall back
 * to a timeout-bounded page fetch with `credentials: "include"`. Relative
 * `url` resolves against config `baseUrl` when present, otherwise against the
 * current page origin.
 *
 * `assign` names the captured response: the full envelope is written to
 * `requests/<name>.json` (also addressable as `${artifacts.<name>.path}`),
 * and later steps/fixtures can splice response fields with
 * `${requests.<name>.body.<field>}` / `${requests.<name>.status}` — e.g.
 * fetch a QR token via API, then `fill` it into the scanner UI.
 */
const requestTargetSchema = z
  .object({
    method: z
      .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
      .default("GET"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    /** Objects are JSON-encoded (content-type: application/json unless overridden); strings are sent raw. */
    body: z.unknown().optional(),
    /** Per-request hard deadline. Defaults to 30000ms. */
    timeoutMs: z.number().int().positive().optional(),
    /** Fail the step unless the response status is (one of) these. Omit to accept any completed response. */
    expectStatus: z
      .union([z.number().int(), z.array(z.number().int()).nonempty()])
      .optional(),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
  })
  .strict();

/* ----- wait conditions ----- */

export const WaitConditionSchema = z.union([
  z
    .object({
      text: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      notText: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      load: z.enum(["networkidle", "load", "domcontentloaded"]),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

/* ----- step variants (discriminated by which key is present) ----- */

const stepCommon = {
  id: z.string().min(1).optional(),
  when: z.string().optional(), // simple condition string, e.g. "notAuthenticated"
};

/**
 * `open: /path` or the object form with a post-navigation wait:
 *   open: { path: /admin, waitUntil: networkidle, timeoutMs: 45000 }
 *
 * The object form exists because SPA hydration races the first interaction —
 * a click before the framework attaches handlers is swallowed. `waitUntil`
 * folds the `wait: { load: ... }` boilerplate into the navigation itself.
 */
export const OpenStepSchema = z
  .object({
    ...stepCommon,
    open: z.union([
      z.string().min(1),
      z
        .object({
          path: z.string().min(1),
          waitUntil: z.enum(["networkidle", "load", "domcontentloaded"]),
          timeoutMs: z.number().int().positive().optional(),
        })
        .strict(),
    ]),
  })
  .strict();
export type OpenStep = z.infer<typeof OpenStepSchema>;

/** The navigation target of an open step, regardless of form. */
export function openPath(step: OpenStep): string {
  return typeof step.open === "string" ? step.open : step.open.path;
}

export const ClickStepSchema = z
  .object({ ...stepCommon, click: LocatorSchema })
  .strict();
export type ClickStep = z.infer<typeof ClickStepSchema>;

export const HoverStepSchema = z
  .object({ ...stepCommon, hover: LocatorSchema })
  .strict();
export type HoverStep = z.infer<typeof HoverStepSchema>;

export const FillStepSchema = z
  .object({
    ...stepCommon,
    fill: fillTargetSchema,
  })
  .strict();
export type FillStep = z.infer<typeof FillStepSchema>;

export const UploadStepSchema = z
  .object({
    ...stepCommon,
    upload: uploadTargetSchema,
  })
  .strict();
export type UploadStep = z.infer<typeof UploadStepSchema>;

export const DownloadStepSchema = z
  .object({
    ...stepCommon,
    download: downloadTargetSchema,
  })
  .strict();
export type DownloadStep = z.infer<typeof DownloadStepSchema>;

export const TransformStepSchema = z
  .object({
    ...stepCommon,
    transform: transformTargetSchema,
  })
  .strict();
export type TransformStep = z.infer<typeof TransformStepSchema>;

export const WaitStepSchema = z
  .object({ ...stepCommon, wait: WaitConditionSchema })
  .strict();
export type WaitStep = z.infer<typeof WaitStepSchema>;

/** See `requestTargetSchema` above for semantics. */
export const RequestStepSchema = z
  .object({ ...stepCommon, request: requestTargetSchema })
  .strict();
export type RequestStep = z.infer<typeof RequestStepSchema>;

/**
 * Keyboard key press, e.g. `press: Enter` or `press: Control+a`.
 * Useful for Enter-to-submit flows and as a below-fold submit fallback.
 */
export const PressStepSchema = z
  .object({ ...stepCommon, press: z.string().min(1) })
  .strict();
export type PressStep = z.infer<typeof PressStepSchema>;

/**
 * Scroll the page by direction/pixels, or bring a locator into view:
 *   - scroll: { direction: down, px: 600 }
 *   - scroll: { to: { by: role, role: button, name: Submit } }
 */
export const ScrollStepSchema = z
  .object({
    ...stepCommon,
    scroll: z.union([
      z
        .object({
          direction: z.enum(["up", "down", "left", "right"]),
          px: z.number().int().positive().optional(),
        })
        .strict(),
      z.object({ to: LocatorSchema }).strict(),
    ]),
  })
  .strict();
export type ScrollStep = z.infer<typeof ScrollStepSchema>;

export const SnapshotStepSchema = z
  .object({
    ...stepCommon,
    snapshot: z
      .object({
        interactive: z.boolean().default(false),
        label: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type SnapshotStep = z.infer<typeof SnapshotStepSchema>;

/** Reusable action invocation, e.g. `use: login_admin`. */
export const UseStepSchema = z
  .object({ ...stepCommon, use: z.string().min(1) })
  .strict();
export type UseStep = z.infer<typeof UseStepSchema>;

/* ----- batch (composite single-invocation step) ----- */

/**
 * Sub-steps allowed inside a `batch`. Restricted to actions that map to one
 * agent-browser command WITHOUT a snapshot round-trip, so the whole block runs
 * as a single backend invocation — which is the entire point of `batch`: the
 * hover state survives long enough to click the popover button it reveals.
 *
 * Semantic locators (`by: role|label|text`) need their own snapshot resolution
 * (the strict-matching path in AgentBrowserAdapter) and so are deliberately
 * NOT accepted here — a batch that re-snapshotted between sub-steps wouldn't
 * preserve transient UI state. Use selector locators inside `batch`, or split
 * the semantic interactions into separate top-level steps.
 */
const batchClickSchema = z.object({ click: SelectorLocatorSchema }).strict();
const batchHoverSchema = z.object({ hover: SelectorLocatorSchema }).strict();
const batchFillSchema = z
  .object({
    fill: SelectorLocatorSchema.extend({ value: z.string() }).strict(),
  })
  .strict();
const batchUploadSchema = z
  .object({
    upload: SelectorLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  })
  .strict();
const batchPressSchema = z.object({ press: z.string().min(1) }).strict();
const batchScrollSchema = z
  .object({
    scroll: z.union([
      z
        .object({
          direction: z.enum(["up", "down", "left", "right"]),
          px: z.number().int().positive().optional(),
        })
        .strict(),
      z.object({ to: SelectorLocatorSchema }).strict(),
    ]),
  })
  .strict();
const batchWaitSchema = z.object({ wait: WaitConditionSchema }).strict();

export const BatchSubStepSchema = z.union([
  batchClickSchema,
  batchHoverSchema,
  batchFillSchema,
  batchUploadSchema,
  batchPressSchema,
  batchScrollSchema,
  batchWaitSchema,
]);
export type BatchSubStep = z.infer<typeof BatchSubStepSchema>;

/**
 * Run a chain of selector interactions in ONE backend invocation. On
 * agent-browser this maps to `agent-browser batch --bail`, so intermediate
 * state (hover popovers, focus, transient menus) persists across the chain
 * instead of being lost to a fresh CLI process per step. `--bail` semantics:
 * the first failing sub-step fails the whole batch step.
 */
export const BatchStepSchema = z
  .object({
    ...stepCommon,
    batch: z
      .array(BatchSubStepSchema)
      .min(2, "batch requires at least 2 sub-steps; use a normal step for one"),
  })
  .strict();
export type BatchStep = z.infer<typeof BatchStepSchema>;

export const StepSchema = z.union([
  OpenStepSchema,
  ClickStepSchema,
  HoverStepSchema,
  FillStepSchema,
  UploadStepSchema,
  DownloadStepSchema,
  TransformStepSchema,
  WaitStepSchema,
  RequestStepSchema,
  PressStepSchema,
  ScrollStepSchema,
  SnapshotStepSchema,
  UseStepSchema,
  BatchStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;

/* ----- outcome (the contract) ----- */

export const OutcomeSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "id must be snake_case starting with a letter",
      ),
    description: z.string().min(1),
    verify: VerifierSchema,
  })
  .strict();
export type Outcome = z.infer<typeof OutcomeSchema>;

/* ----- preconditions / session / artifacts / redaction ----- */

export const PreconditionsSchema = z
  .object({
    env: z
      .record(z.string(), z.union([z.string(), z.boolean(), z.number()]))
      .optional(),
    commands: z
      .array(
        z
          .object({
            name: z.string().optional(),
            run: z.string().min(1),
            cwd: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type Preconditions = z.infer<typeof PreconditionsSchema>;

export const SessionSchema = z
  .object({
    profile: z.string().optional(),
    reuseAuth: z.boolean().optional(),
    /** Restore a captured checkpoint before running steps. */
    resume: z.string().optional(),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;

export const CapturePolicySchema = z.enum(["always", "on-failure", "never"]);
export type CapturePolicy = z.infer<typeof CapturePolicySchema>;

export const ArtifactsConfigSchema = z
  .object({
    capture: z
      .object({
        screenshots: CapturePolicySchema.default("on-failure"),
        snapshots: CapturePolicySchema.default("always"),
        console: CapturePolicySchema.default("always"),
        network: CapturePolicySchema.default("always"),
        storage: CapturePolicySchema.default("on-failure"),
        trace: CapturePolicySchema.default("on-failure"),
        agentContext: CapturePolicySchema.default("always"),
      })
      .strict()
      .partial(),
  })
  .strict();
export type ArtifactsConfig = z.infer<typeof ArtifactsConfigSchema>;

export const RedactionConfigSchema = z
  .object({
    headers: z.array(z.string()).optional(),
    queryParams: z.array(z.string()).optional(),
    storageKeys: z.array(z.string()).optional(),
    values: z.array(z.string()).optional(),
  })
  .strict();
export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;

export const SpecMetadataSchema = z
  .object({
    feature: z.string().optional(),
    owner: z.string().optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type SpecMetadata = z.infer<typeof SpecMetadataSchema>;

/* ----- the spec itself ----- */

export const SpecSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "name must be snake_case starting with a letter",
      ),
    intent: z.string().min(1),

    environment: z.string().optional(),
    backend: BackendSchema.optional(),
    mode: z.enum(["normal", "debug"]).default("normal"),
    /** Spec-local `${vars.X}` values. Config env vars < spec vars < CLI --var. */
    vars: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),

    /**
     * Browser viewport for this spec. Overrides the environment-level
     * `viewport` from cairntrace.config.yml. Applied at run start, before any
     * step executes.
     */
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .strict()
      .optional(),

    metadata: SpecMetadataSchema.optional(),
    imports: z.array(z.string()).optional(),
    preconditions: PreconditionsSchema.optional(),
    session: SessionSchema.optional(),

    outcomes: z.array(OutcomeSchema).min(1),
    steps: z.array(StepSchema).optional(),

    artifacts: ArtifactsConfigSchema.optional(),
    redaction: RedactionConfigSchema.optional(),

    /**
     * sha256 over canonical-JSON(intent + outcomes). Stamped at scaffold time;
     * heal refuses writes that would change it. `cairn run` warns when missing
     * or stale and exits 6 if mismatch is detected at lint time.
     */
    contractHash: ContractHashSchema.optional(),
  })
  .strict();
export type Spec = z.infer<typeof SpecSchema>;

/* ----- reusable action (action YAML files) ----- */

/**
 * A reusable action lives in `actions/<name>.yml` and is imported by specs.
 * It has steps but no outcomes — it's a fragment, not a spec.
 */
export const ReusableActionSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/),
    steps: z.array(StepSchema).min(1),
  })
  .strict();
export type ReusableAction = z.infer<typeof ReusableActionSchema>;
