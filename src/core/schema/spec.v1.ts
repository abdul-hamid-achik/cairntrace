import { z } from "zod";
import { ClipPointSchema, type ClipPoint } from "./config.v1";
import { BackendSchema, ContractHashSchema } from "./shared";
import { GateRefListSchema } from "../gates/schema";
import {
  HttpMethodSchema,
  PathMatchersSchema,
  StatusMatcherSchema,
  ValueMatcherSchema,
  VerifierSchema,
} from "./verifier.v1";
import { SpecFixturesSchema } from "../fixtures/schema";
export { ClipPointSchema };
export type { ClipPoint };

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
const locatorNear = {
  /**
   * Scope the locator to the control nearest this visible text (a card title,
   * company name, row label). Matching is whitespace-normalized and
   * case-insensitive. Use when the accessible name is repeated (three Opens)
   * and a nearby heading distinguishes the one the user would click.
   */
  near: z.string().min(1).optional(),
  /**
   * Keep only matches whose visible text contains this string
   * (whitespace-normalized, case-insensitive). Use with a CSS root to pick
   * "Yes" inside `[data-qa="…"]` without an eval.
   */
  hasText: z.string().min(1).optional(),
  /**
   * Semantic locators drop hidden matches (display:none / visibility:hidden)
   * by default. Set false to act on a v-show=false a11y node.
   */
  visible: z.boolean().optional(),
};

const semanticLocatorExtras = {
  /** Case-sensitive whole-name match (default: case-insensitive whole-name). */
  exact: z.boolean().optional(),
  /** Pick the Nth match (0-based, document order) when several elements match. */
  nth: z.number().int().min(0).optional(),
  ...locatorNear,
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
    /** Pick the Nth CSS match (0-based, document order). */
    nth: z.number().int().min(0).optional(),
    ...locatorNear,
  })
  .strict();

/**
 * Attribute-based test id. Default attribute is `data-testid`; override per
 * project with `browser.testIdAttribute` (e.g. a custom `data-qa`).
 */
export const TestIdLocatorSchema = z
  .object({
    by: z.literal("testid"),
    testid: z.string().min(1),
    nth: z.number().int().min(0).optional(),
    ...locatorNear,
  })
  .strict();

export const LocatorSchema = z.union([
  RoleLocatorSchema,
  LabelLocatorSchema,
  TextLocatorSchema,
  SelectorLocatorSchema,
  TestIdLocatorSchema,
]);
export type Locator = z.infer<typeof LocatorSchema>;

const fillTargetSchema = z.union([
  RoleLocatorSchema.extend({ value: z.string() }).strict(),
  LabelLocatorSchema.extend({ value: z.string() }).strict(),
  TextLocatorSchema.extend({ value: z.string() }).strict(),
  SelectorLocatorSchema.extend({ value: z.string() }).strict(),
  TestIdLocatorSchema.extend({ value: z.string() }).strict(),
]);

const uploadTargetSchema = z.union([
  RoleLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  LabelLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  TextLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  SelectorLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  TestIdLocatorSchema.extend({ path: z.string().min(1) }).strict(),
]);

const downloadAssignExtras = {
  saveAs: z.string().min(1),
  assign: z
    .string()
    .min(1)
    .regex(/^[a-z][A-Za-z0-9_]*$/)
    .optional(),
  timeoutMs: z.number().int().positive().optional(),
};

const downloadTargetSchema = z.union([
  RoleLocatorSchema.extend(downloadAssignExtras).strict(),
  LabelLocatorSchema.extend(downloadAssignExtras).strict(),
  TextLocatorSchema.extend(downloadAssignExtras).strict(),
  SelectorLocatorSchema.extend(downloadAssignExtras).strict(),
  TestIdLocatorSchema.extend(downloadAssignExtras).strict(),
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

/**
 * `wait` is an explicit polling step. Playwright wraps text/notText/load waits
 * in a Cairntrace-side hard timeout (30000ms default, or `timeoutMs`). Real
 * Chromium runs also start an external watchdog that kills the browser at the
 * deadline, so a page caught in navigation churn fails the step instead of
 * waiting on Playwright's own timeout forever.
 */
/**
 * Poll the current page URL. Exactly one of `includes` | `equals` | `pattern`.
 * `pattern` is a JavaScript regular expression source. Use this instead of
 * an `eval` that reads `location.pathname` after a click that navigates.
 */
export const WaitUrlMatcherSchema = z
  .object({
    includes: z.string().min(1).optional(),
    equals: z.string().min(1).optional(),
    pattern: z
      .string()
      .min(1)
      .refine((value) => {
        try {
          const compiled = new RegExp(value);
          return compiled instanceof RegExp;
        } catch {
          return false;
        }
      }, "url.pattern must be a valid JavaScript regular expression")
      .optional(),
  })
  .strict()
  .refine(
    (value) =>
      [value.includes, value.equals, value.pattern].filter(
        (part) => part !== undefined,
      ).length === 1,
    { message: "wait.url needs exactly one of includes | equals | pattern" },
  );
export type WaitUrlMatcher = z.infer<typeof WaitUrlMatcherSchema>;

export const WaitConditionSchema = z.union([
  z
    .object({
      /** Pause with no predicate. Use after a create so a search index can catch up. */
      ms: z.number().int().positive().max(300_000),
    })
    .strict(),
  z
    .object({
      text: z.string().min(1),
      /** Default false; rendered text matching also normalizes whitespace. */
      caseSensitive: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      notText: z.string().min(1),
      /** Default false; rendered text matching also normalizes whitespace. */
      caseSensitive: z.boolean().optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      load: z.enum(["networkidle", "load", "domcontentloaded"]),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      selector: z.string().min(1),
      state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
      /**
       * Keep only matches whose visible text contains this string
       * (whitespace-normalized, case-insensitive). Use instead of
       * `wait.text` when the same copy also lives in a card concat or
       * header before the actual control exists.
       */
      hasText: z.string().min(1).optional(),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      value: z.union([
        RoleLocatorSchema.extend({ equals: z.string() }).strict(),
        LabelLocatorSchema.extend({ equals: z.string() }).strict(),
        TextLocatorSchema.extend({ equals: z.string() }).strict(),
        SelectorLocatorSchema.extend({ equals: z.string() }).strict(),
        TestIdLocatorSchema.extend({ equals: z.string() }).strict(),
      ]),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      url: WaitUrlMatcherSchema,
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

/**
 * Post-click condition used by `click.until`. The runner re-issues the click
 * (at most four total attempts) until this condition holds or its timeout is
 * exhausted. Text checks use the same normalized, case-insensitive semantics
 * as `wait` text/notText. `url` reuses the wait.url matcher so a click that
 * should navigate can be authored without an eval.
 */
export const ClickUntilSchema = z.union([
  z
    .object({
      selectorGone: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      selector: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
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
      url: WaitUrlMatcherSchema,
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type ClickUntil = z.infer<typeof ClickUntilSchema>;

/* ----- step variants (discriminated by which key is present) ----- */

export const WhenObjectSchema = z
  .object({
    urlContains: z.string().min(1).optional(),
    urlNotContains: z.string().min(1).optional(),
    urlMatches: z.string().min(1).optional(),
    text: z.string().min(1).optional(),
    notText: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    notSelector: z.string().min(1).optional(),
    hasText: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = (
      [
        "urlContains",
        "urlNotContains",
        "urlMatches",
        "text",
        "notText",
        "selector",
        "notSelector",
      ] as const
    ).filter((key) => value[key] !== undefined);
    if (keys.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "when: exactly one of urlContains|urlNotContains|urlMatches|text|notText|selector|notSelector",
      });
    }
    if (value.hasText !== undefined && keys[0] !== "selector") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hasText"],
        message: "hasText is only valid with selector",
      });
    }
  });
export type WhenObject = z.infer<typeof WhenObjectSchema>;

export const NetworkPostconditionSchema = z
  .object({
    method: HttpMethodSchema.optional(),
    urlContains: z.string().min(1),
    status: StatusMatcherSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
    /** Capture the matched request as `${requests.<assign>.…}`. */
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
  })
  .strict();
export type NetworkPostcondition = z.infer<typeof NetworkPostconditionSchema>;

const stepCommon = {
  id: z.string().min(1).optional(),
  when: z.union([z.string(), WhenObjectSchema]).optional(),
  /**
   * A bounded response expected from this action. The runner arms the
   * listener/baseline before dispatching the action and never retries the
   * mutation when this guard is present.
   */
  postcondition: z
    .object({
      network: NetworkPostconditionSchema,
    })
    .strict()
    .optional(),
};

export const PostconditionSchema = z
  .object({ network: NetworkPostconditionSchema })
  .strict();
export type Postcondition = z.infer<typeof PostconditionSchema>;

/** Remove the orchestration-only guard before dispatching the browser action. */
export function withoutPostcondition(step: Step): Step {
  const { postcondition: _postcondition, ...action } = step as Step & {
    postcondition?: Postcondition;
  };
  return action as Step;
}

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

const clickTargetSchema = z.union([
  RoleLocatorSchema.extend({ until: ClickUntilSchema.optional() }).strict(),
  LabelLocatorSchema.extend({ until: ClickUntilSchema.optional() }).strict(),
  TextLocatorSchema.extend({ until: ClickUntilSchema.optional() }).strict(),
  SelectorLocatorSchema.extend({ until: ClickUntilSchema.optional() }).strict(),
  TestIdLocatorSchema.extend({ until: ClickUntilSchema.optional() }).strict(),
]);

export const ClickStepSchema = z
  .object({
    ...stepCommon,
    click: clickTargetSchema,
    /** Override post-click settling for this interaction. */
    settleMs: z.number().int().min(0).optional(),
  })
  .strict();
export type ClickStep = z.infer<typeof ClickStepSchema>;

/** Locator portion of a click step, excluding the runner-owned `until`. */
export function clickLocator(step: ClickStep): Locator {
  const { until: _until, ...locator } = step.click;
  return locator as Locator;
}

export const HoverStepSchema = z
  .object({ ...stepCommon, hover: LocatorSchema })
  .strict();
export type HoverStep = z.infer<typeof HoverStepSchema>;

/** Focus a control without clicking it (useful for custom comboboxes). */
export const FocusStepSchema = z
  .object({ ...stepCommon, focus: LocatorSchema })
  .strict();
export type FocusStep = z.infer<typeof FocusStepSchema>;

export const FillStepSchema = z
  .object({
    ...stepCommon,
    fill: fillTargetSchema,
    /**
     * Re-read the live input value after a short settle and retry a wiped
     * value up to three times. Default true; set false for intentionally
     * transformed/masked controls whose DOM value differs from authored text.
     */
    verifyFill: z.boolean().optional(),
  })
  .strict();
export type FillStep = z.infer<typeof FillStepSchema>;

/**
 * `type` — type text character-by-character into a field.
 *
 * Unlike `fill` (which does a bulk value-set), `type` sends each character as
 * a real keyboard event via CDP. This is critical for SPA frameworks (Vue,
 * React, etc.) whose form validation listens for `keydown`/`keyup`/`input`
 * events that a bulk `fill` may not trigger — the classic symptom is a submit
 * button staying `[disabled]` after `fill` because the framework's reactivity
 * never fired.
 *
 * `delayMs` adds a per-keystroke delay (useful for slow debounced validators).
 * Defaults to 0 (as fast as Playwright can send keys).
 */
const typeTargetExtras = {
  value: z.string(),
  delayMs: z.number().int().min(0).optional(),
};

const typeTargetSchema = z.union([
  RoleLocatorSchema.extend(typeTargetExtras).strict(),
  LabelLocatorSchema.extend(typeTargetExtras).strict(),
  TextLocatorSchema.extend(typeTargetExtras).strict(),
  SelectorLocatorSchema.extend(typeTargetExtras).strict(),
  TestIdLocatorSchema.extend(typeTargetExtras).strict(),
]);

export const TypeStepSchema = z
  .object({
    ...stepCommon,
    type: typeTargetSchema,
    /** Same hydration-wipe guard as `fill`; default true. */
    verifyFill: z.boolean().optional(),
  })
  .strict();
export type TypeStep = z.infer<typeof TypeStepSchema>;

/**
 * `select` — choose an option in a native `<select>` element.
 *
 * Exactly one of `value` (the option's `value` attribute; `""` is legal and
 * picks a value-less placeholder option) or `label` (the option's visible
 * text) identifies the option. Both backends dispatch native `input`/`change`
 * events; clicking a `<select>` open and clicking an `<option>` does not work
 * under automation (the dropdown is browser chrome, not DOM), which is why
 * this is a first-class step and not a `click` recipe.
 */
const selectOptionExtras = {
  /** Match the option's `value` attribute. Exactly one of value | label. */
  value: z.string().optional(),
  /** Match the option's visible text. Exactly one of value | label. */
  label: z.string().min(1).optional(),
};
const exactlyOneSelectChoice = (v: { value?: string; label?: string }) =>
  (v.value === undefined) !== (v.label === undefined);
const selectChoiceMessage = {
  message: "select needs exactly one of value | label",
};

const selectTargetSchema = z.union([
  RoleLocatorSchema.extend(selectOptionExtras)
    .strict()
    .refine(exactlyOneSelectChoice, selectChoiceMessage),
  LabelLocatorSchema.extend(selectOptionExtras)
    .strict()
    .refine(exactlyOneSelectChoice, selectChoiceMessage),
  TextLocatorSchema.extend(selectOptionExtras)
    .strict()
    .refine(exactlyOneSelectChoice, selectChoiceMessage),
  SelectorLocatorSchema.extend(selectOptionExtras)
    .strict()
    .refine(exactlyOneSelectChoice, selectChoiceMessage),
  TestIdLocatorSchema.extend(selectOptionExtras)
    .strict()
    .refine(exactlyOneSelectChoice, selectChoiceMessage),
]);

export const SelectStepSchema = z
  .object({
    ...stepCommon,
    select: selectTargetSchema,
  })
  .strict();
export type SelectStep = z.infer<typeof SelectStepSchema>;

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

/**
 * `eval` — page-context JavaScript escape hatch.
 *
 * Runs arbitrary JS in the browser via `backend.evaluate()` and optionally
 * captures the JSON-serializable return value as `evals/<assign>.json`.
 * The captured value is spliced into later steps via `${evals.<name>.value.<field>}`.
 *
 * This is deliberately the last-resort locator-free step: opaque to `heal`,
 * bypassing the semantic-locator contract. Use it for state setup and
 * internal-state assertions that no UI affordance can reach.
 */
export const EvalStepSchema = z
  .object({
    ...stepCommon,
    eval: z
      .object({
        /** Inline JS source. Exactly one of `js` | `file` is required. */
        js: z.string().min(1).optional(),
        /**
         * Path to a .js file, resolved against the directory of the file
         * that declares the step (an imported action's own directory).
         */
        file: z.string().min(1).optional(),
        /** Capture return value → `evals/<assign>.json` + `${evals.<assign>.…}`. */
        assign: z.string().optional(),
        /** Passed as the single argument to the wrapped function. */
        args: z.record(z.unknown()).optional(),
        timeoutMs: z.number().int().positive().optional(),
        /** Retry once when a page navigation destroys this eval's CDP context. */
        retryOnNavigation: z.boolean().optional(),
      })
      .refine((v) => Boolean(v.js) !== Boolean(v.file), {
        message: "eval needs exactly one of js | file",
      }),
  })
  .strict();
export type EvalStep = z.infer<typeof EvalStepSchema>;

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
 * Optional `target` focuses that locator first so Vue `@keyup.enter` on an
 * input actually fires. Optional `until` retries the key (same budget as
 * click.until) so a search that waits on an index can be authored without eval.
 */
export const PressStepSchema = z
  .object({
    ...stepCommon,
    press: z.string().min(1),
    target: LocatorSchema.optional(),
    until: ClickUntilSchema.optional(),
  })
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
export const UseActionCallSchema = z
  .object({
    action: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/),
    vars: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
  })
  .strict();
export type UseActionCall = z.infer<typeof UseActionCallSchema>;

export const UseStepSchema = z
  .object({
    ...stepCommon,
    use: z.union([z.string().min(1), UseActionCallSchema]),
  })
  .strict();
export type UseStep = z.infer<typeof UseStepSchema>;

export function useActionName(step: UseStep): string {
  return typeof step.use === "string" ? step.use : step.use.action;
}

export function useActionVars(
  step: UseStep,
): Record<string, string | number | boolean> | undefined {
  return typeof step.use === "string" ? undefined : step.use.vars;
}

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

const batchTypeSchema = z
  .object({
    type: SelectorLocatorSchema.extend({ value: z.string() }).strict(),
  })
  .strict();

export const BatchSubStepSchema = z.union([
  batchClickSchema,
  batchHoverSchema,
  batchFillSchema,
  batchTypeSchema,
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

/**
 * `monitor` — capture a process profile or one-shot sample of the browser
 * process tree at a point in the flow, via the external `monitor` CLI. Useful
 * for taking a heap profile after navigating to a heavy screen, or a process
 * snapshot after a memory-intensive action.
 *
 * The step targets the backend's `browserPid()`; it fails if no browser PID is
 * available. With `assign`, the captured result is written to
 * `monitor/<assign>.json` and registered as a named artifact (kind `monitor`)
 * so later steps / script verifiers can reference it via
 * `${artifacts.<assign>.path}`. The `monitor` binary missing is a step failure
 * (the author explicitly asked to capture at this point), not a silent skip.
 *
 * `action: profile` requires `type` (heap | cpu | goroutine | sample).
 * `action: snapshot` captures a single `monitor process <pid>` sample.
 */
export const MonitorStepSchema = z
  .object({
    ...stepCommon,
    monitor: z
      .object({
        action: z.enum(["profile", "snapshot"]),
        /** Named config diagnostics.monitor.targets entry; defaults to browser. */
        target: z.string().min(1).optional(),
        type: z.enum(["heap", "cpu", "goroutine", "sample"]).optional(),
        /** CPU sampling duration. Monitor bounds this to at most two minutes. */
        durationSeconds: z.number().int().min(1).max(120).optional(),
        assign: z.string().min(1).optional(),
        label: z.string().optional(),
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .refine((m) => (m.action === "profile" ? m.type !== undefined : true), {
        message:
          "profile action requires a type: heap | cpu | goroutine | sample",
      }),
  })
  .strict();
export type MonitorStep = z.infer<typeof MonitorStepSchema>;

/**
 * Run a host shell command or a node script as a step (F3a) — fixtures,
 * seeds, worker kills, cleanup — instead of an outcome with side effects or
 * a precondition. `shell` runs through `/bin/sh -c` (`args` become `$1…$n`);
 * `node` runs `node <file> [args]` with the file resolved against the file
 * that declares the step. `cwd` resolves the same way. The child gets the
 * run context (`CAIRN_ENV`, `CAIRN_BASE_URL`, `CAIRN_RUN_ID`, `CAIRN_RUN_DIR`,
 * `CAIRN_RUN_TOKEN`, `CAIRN_CONFIG_DIR`; in `teardown:` also
 * `CAIRN_RUN_STATUS`) and its process tree is killed past `timeoutMs`
 * (default 120000) or on cancel. A non-zero exit fails the step. With
 * `assign`, the last non-empty stdout line must be JSON; later steps splice
 * it as `${runs.<assign>.<path>}`. The string form is `shell` shorthand.
 */
export const RunStepSchema = z
  .object({
    ...stepCommon,
    run: z.union([
      z.string().min(1),
      z
        .object({
          shell: z.string().min(1).optional(),
          node: z.string().min(1).optional(),
          args: z
            .array(z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
          cwd: z.string().optional(),
          env: z
            .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
            .optional(),
          timeoutMs: z.number().int().positive().optional(),
          assign: z
            .string()
            .regex(
              /^[a-z][A-Za-z0-9_]*$/,
              "assign must start with a lowercase letter (letters, digits, _)",
            )
            .optional(),
        })
        .strict()
        .refine(
          (run) => (run.shell === undefined) !== (run.node === undefined),
          {
            message: "run needs exactly one of shell or node",
          },
        ),
    ]),
  })
  .strict();
export type RunStep = z.infer<typeof RunStepSchema>;

/* ----- expect / capture (typed in-flow assertions and values) ----- */

const ExpectTextMatcherSchema = z
  .object({
    equals: z.string().optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
    caseSensitive: z.boolean().optional(),
  })
  .strict()
  .refine(
    (m) =>
      [m.equals, m.contains, m.matches].filter((x) => x !== undefined)
        .length === 1,
    {
      message: "exactly one of: equals, contains, matches",
    },
  );

const ExpectValueMatcherSchema = z
  .object({
    equals: z.string().optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
  })
  .strict()
  .refine(
    (m) =>
      [m.equals, m.contains, m.matches].filter((x) => x !== undefined)
        .length === 1,
    {
      message: "exactly one of: equals, contains, matches",
    },
  );

const ExpectAttributeSchema = z
  .object({
    name: z.string().min(1),
    equals: z.string().optional(),
    contains: z.string().optional(),
    matches: z.string().optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .refine(
    (m) =>
      [m.equals, m.contains, m.matches, m.exists].filter((x) => x !== undefined)
        .length === 1,
    { message: "exactly one of: equals, contains, matches, exists" },
  );

const ExpectIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "id must be snake_case starting with a letter");

/**
 * Assertions of an `expect` step on a locator. Inside `expect`, `visible`
 * and `hidden` are assertions (not the locator's include-hidden switch).
 * Text is whitespace-normalized and case-insensitive (like `wait`/`text`);
 * `value` and `attribute` compare raw. `count` takes a number or a
 * `{equals|atLeast|atMost|…}` matcher.
 */
const expectAssertionShape = {
  /** Evidence id (`expects/<id>.json`); default: the step id. */
  id: ExpectIdSchema.optional(),
  visible: z.boolean().optional(),
  hidden: z.boolean().optional(),
  count: ValueMatcherSchema.optional(),
  text: z.union([z.string(), ExpectTextMatcherSchema]).optional(),
  value: z.union([z.string(), ExpectValueMatcherSchema]).optional(),
  attribute: ExpectAttributeSchema.optional(),
  enabled: z.boolean().optional(),
  /** Retry budget until the expectation holds (default 5000ms × waitScale). */
  timeoutMs: z.number().int().positive().optional(),
};

/**
 * `by: text` locators already match on their text, so their `text` key stays
 * the locator (no text assertion on that variant).
 */
const { text: _expectTextAssertion, ...expectAssertionShapeForText } =
  expectAssertionShape;

/** `expect.request`: a session-cookie API call checked like an outcome. */
const ExpectRequestSchema = z
  .object({
    method: HttpMethodSchema.default("GET"),
    url: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    status: z.union([z.number().int(), StatusMatcherSchema]).optional(),
    json: PathMatchersSchema.optional(),
  })
  .strict();

export const ExpectSchema = z
  .union([
    RoleLocatorSchema.extend(expectAssertionShape).strict(),
    LabelLocatorSchema.extend(expectAssertionShape).strict(),
    TextLocatorSchema.extend(expectAssertionShapeForText).strict(),
    SelectorLocatorSchema.extend(expectAssertionShape).strict(),
    TestIdLocatorSchema.extend(expectAssertionShape).strict(),
    z
      .object({
        id: ExpectIdSchema.optional(),
        request: ExpectRequestSchema,
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
  ])
  .superRefine((e, ctx) => {
    if ("request" in e) return;
    const assertions = [
      "visible",
      "hidden",
      "count",
      ...(e.by === "text" ? [] : ["text"]),
      "value",
      "attribute",
      "enabled",
    ].filter((key) => (e as Record<string, unknown>)[key] !== undefined);
    if (assertions.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message:
          "expect needs at least one of: visible, hidden, count, text, value, attribute, enabled (or request)",
      });
    }
    if (e.visible !== undefined && e.hidden !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hidden"],
        message: "use visible or hidden, not both",
      });
    }
  });
export type Expect = z.infer<typeof ExpectSchema>;

/**
 * `expect` — assert mid-flow and record evidence like an outcome
 * (`expects/<id>.json`, `expect.passed` / `expect.failed` events); a
 * mismatch fails the step. Retries until `timeoutMs`.
 */
export const ExpectStepSchema = z
  .object({ ...stepCommon, expect: ExpectSchema })
  .strict();
export type ExpectStep = z.infer<typeof ExpectStepSchema>;

const captureAttributeTarget = z.union([
  RoleLocatorSchema.extend({ attributeName: z.string().min(1) }).strict(),
  LabelLocatorSchema.extend({ attributeName: z.string().min(1) }).strict(),
  TextLocatorSchema.extend({ attributeName: z.string().min(1) }).strict(),
  SelectorLocatorSchema.extend({ attributeName: z.string().min(1) }).strict(),
  TestIdLocatorSchema.extend({ attributeName: z.string().min(1) }).strict(),
]);

/**
 * `capture` — store a structured value from the page as
 * `${captures.<assign>…}` for later steps and outcome verifiers (and
 * `captures/<assign>.json`). Exactly one of: `text` (normalized text),
 * `value` (live control value), `attribute` (with `attributeName`), `table`
 * (`{headers, rows: [{<header>: <cell>}], cells, rowCount}`).
 */
export const CaptureStepSchema = z
  .object({
    ...stepCommon,
    capture: z
      .object({
        assign: z
          .string()
          .regex(
            /^[a-z][A-Za-z0-9_]*$/,
            "assign must start with a lowercase letter (letters, digits, _)",
          ),
        text: LocatorSchema.optional(),
        value: LocatorSchema.optional(),
        attribute: captureAttributeTarget.optional(),
        table: LocatorSchema.optional(),
        /** Wait for the target to appear (default 5000ms × waitScale). */
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .refine(
        (c) =>
          [c.text, c.value, c.attribute, c.table].filter((x) => x !== undefined)
            .length === 1,
        {
          message:
            "capture needs exactly one of: text, value, attribute, table",
        },
      ),
  })
  .strict();
export type CaptureStep = z.infer<typeof CaptureStepSchema>;

const browserActionKeys = [
  "open",
  "click",
  "hover",
  "focus",
  "fill",
  "type",
  "select",
  "upload",
  "download",
  "press",
  "scroll",
  "batch",
] as const;

export const StepSchema = z
  .union([
    OpenStepSchema,
    ClickStepSchema,
    HoverStepSchema,
    FocusStepSchema,
    FillStepSchema,
    TypeStepSchema,
    SelectStepSchema,
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
    EvalStepSchema,
    MonitorStepSchema,
    RunStepSchema,
    ExpectStepSchema,
    CaptureStepSchema,
  ])
  .superRefine((step, ctx) => {
    if (
      step.postcondition !== undefined &&
      !browserActionKeys.some((key) => key in step)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postcondition"],
        message: "postcondition.network is only valid on a browser action step",
      });
    }
  });
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
            /** Per-command timeout in ms (default 120000). Raise for slow
             * setup like environment quiesce polls. */
            timeoutMs: z.number().int().positive().optional(),
          })
          .strict(),
      )
      .optional(),
    /**
     * Readiness gates waited in order BEFORE `commands` (config `gates:`
     * names, `http(s)://…`, `tcp://host:port`, or inline gates). A gate that
     * is not ready fails the run like a failed precondition.
     */
    wait: GateRefListSchema.optional(),
  })
  .strict();
export type Preconditions = z.infer<typeof PreconditionsSchema>;

/**
 * Spec teardown (F3a): steps that run after the steps and outcomes on every
 * exit path — passed, failed, errored (a failed precondition or gate
 * included) and cancelled; on SIGINT/SIGTERM only its `run` steps run,
 * synchronously, within min(timeoutMs, 30000). Children see
 * `CAIRN_RUN_STATUS` (passed | failed | errored). Every item runs even when
 * an earlier one failed. A failed teardown is reported (teardown.* events,
 * run.log) but keeps the run status unless `failRun: true`, which turns a
 * passed run into an errored one (`failure.phase: teardown`).
 * `use:` is not expanded here: inline the steps.
 */
export const TeardownSchema = z
  .union([
    z.array(StepSchema).min(1),
    z
      .object({
        steps: z.array(StepSchema).min(1),
        /** A failed teardown step errors a passed run (default false). */
        failRun: z.boolean().optional(),
        /** Budget of the whole teardown in ms (default 300000). */
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict(),
  ])
  .superRefine((teardown, ctx) => {
    const steps = Array.isArray(teardown) ? teardown : teardown.steps;
    steps.forEach((step, index) => {
      const path = Array.isArray(teardown) ? [index] : ["steps", index];
      if ("use" in step) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message:
            "teardown does not expand use: — inline the action's steps here",
        });
      }
      const unsupported = TEARDOWN_UNSUPPORTED_KINDS.find(
        (kind) => kind in step,
      );
      if (unsupported) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path,
          message: `${unsupported} steps are not supported in teardown (use run, request, eval or a browser action)`,
        });
      }
    });
  });

/**
 * Step kinds a teardown refuses: they produce run artifacts, or (expect,
 * capture) are assertions and captures of the run's own verdict path —
 * cleanup does not verify.
 */
const TEARDOWN_UNSUPPORTED_KINDS = [
  "download",
  "upload",
  "transform",
  "monitor",
  "expect",
  "capture",
] as const;
export type Teardown = z.infer<typeof TeardownSchema>;

/** The teardown's steps and policy, whichever form was authored. */
export function teardownPlan(teardown: Teardown | undefined): {
  steps: Step[];
  failRun: boolean;
  timeoutMs: number;
} {
  if (!teardown) return { steps: [], failRun: false, timeoutMs: 300_000 };
  if (Array.isArray(teardown)) {
    return { steps: teardown, failRun: false, timeoutMs: 300_000 };
  }
  return {
    steps: teardown.steps,
    failRun: teardown.failRun ?? false,
    timeoutMs: teardown.timeoutMs ?? 300_000,
  };
}

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

/**
 * Video recording options. `slowMo` adds a delay (ms) between Playwright
 * actions so the recording is watchable when steps execute quickly.
 * `speed` (0.25–4) adjusts playback speed via ffmpeg post-processing;
 * values < 1 slow down, values > 1 speed up. Defaults: slowMo=0, speed=1.
 */
export const VideoConfigSchema = z
  .object({
    /** Delay (ms) between browser actions during recording. */
    slowMo: z.number().int().min(0).max(10_000).default(0),
    /** Playback speed multiplier (0.25–4). Applied via ffmpeg post-processing. */
    speed: z.number().min(0.25).max(4).default(1),
  })
  .strict();
export type VideoConfig = z.infer<typeof VideoConfigSchema>;

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
        video: CapturePolicySchema.default("never"),
        agentContext: CapturePolicySchema.default("always"),
        /**
         * Largest trace kept, in bytes (default 50 MiB). A bigger trace is
         * dropped with an `artifact.trace` event instead of filling the disk.
         */
        traceMaxBytes: z.number().int().positive(),
      })
      .strict()
      .partial(),
    /** Video recording options. Ignored when capture.video is `never`. */
    video: VideoConfigSchema.optional(),
    /** Pre-defined video clip points for auto-cutting on failure. */
    clipPoints: z.array(ClipPointSchema).optional(),
    /** Default tags applied to auto-generated clips. */
    clipTags: z.array(z.string()).optional(),
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

/* ----- environment requirements (`requires:`) ----- */

/**
 * One `requires.env` entry: a plain environment name (`local`), or a
 * single-key map that also needs an opt-in variable set to `1`/`true` in the
 * caller's environment (`{ dev: { optIn: CAIRN_ALLOW_DEV_MUTATIONS } }`).
 */
export const RequiresEnvEntrySchema = z.union([
  z.string().min(1),
  z
    .record(
      z.string().min(1),
      z
        .object({
          /** Variable that must be `1` or `true` for this environment. */
          optIn: z
            .string()
            .min(1)
            .regex(
              /^[A-Za-z_][A-Za-z0-9_]*$/,
              "optIn must be an environment variable name",
            ),
        })
        .strict(),
    )
    .refine((entry) => Object.keys(entry).length === 1, {
      message:
        "a requires.env map entry names exactly one environment: { <env>: { optIn: VAR } }",
    }),
]);
export type RequiresEnvEntry = z.infer<typeof RequiresEnvEntrySchema>;

/**
 * Where a spec may run. Evaluated by `cairn run` before services, hooks,
 * preconditions or a browser start; a spec the policy refuses ends with
 * status `refused` (exit 7) and never gets a run directory.
 *
 * - `env`: the environments the spec may run in. Absent = any environment
 *   that is not `policy.trait: protected`.
 * - `mutates`: the spec changes shared data; refused where the environment's
 *   `policy.mutations` is `deny`.
 */
export const SpecRequiresSchema = z
  .object({
    env: z.array(RequiresEnvEntrySchema).min(1).optional(),
    mutates: z.boolean().optional(),
  })
  .strict();
export type SpecRequires = z.infer<typeof SpecRequiresSchema>;

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
    /** Environment policy requirements (see SpecRequiresSchema). */
    requires: SpecRequiresSchema.optional(),
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
    /** Symbol this spec covers (FEATURES item 6): bound by `cairn spec scaffold --from-codemap`. */
    coversSymbol: z.string().optional(),
    /** Default post-click settling override for this spec. */
    settleMs: z.number().int().min(0).optional(),
    /** Explicitly acknowledge a public/sessionless cold-start flow. */
    coldStart: z.literal("guest").optional(),
    imports: z.array(z.string()).optional(),
    preconditions: PreconditionsSchema.optional(),
    /**
     * Config `fixtures:` this spec uses, ensured (needs first) after the
     * preconditions and before the browser starts: `name` (ensure),
     * `name.reset` (ensure, then its reset verb) or `{use, with, write}`.
     * Outputs splice as `${fixtures.<name>.<key>}` (a reference the spec
     * does not list, or one left without a value, errors the run in phase
     * fixture before the browser starts); run-scoped ones are torn down
     * after the spec teardown, on every exit path.
     */
    fixtures: SpecFixturesSchema.optional(),
    session: SessionSchema.optional(),

    outcomes: z.array(OutcomeSchema).min(1),
    steps: z.array(StepSchema).optional(),
    /** Always-run cleanup steps (see TeardownSchema). */
    teardown: TeardownSchema.optional(),

    artifacts: ArtifactsConfigSchema.optional(),
    redaction: RedactionConfigSchema.optional(),

    /**
     * sha256 over canonical-JSON(intent + outcomes). Stamped at scaffold time;
     * heal refuses writes that would change it. `cairn run` warns when missing
     * or stale and exits 6 if mismatch is detected at lint time.
     */
    contractHash: ContractHashSchema.optional(),

    /**
     * file.cheap stash settings for this spec's runs: `tags` extend the
     * config `stash.tags` on auto-stash and `cairn run --stash`.
     */
    stash: z
      .object({ tags: z.array(z.string().min(1)).optional() })
      .strict()
      .optional(),
  })
  .strict();
export type Spec = z.infer<typeof SpecSchema>;

/* ----- reusable action (action YAML files) ----- */

/**
 * One documented action input (`inputs.<name>` on an action): a `${vars.X}`
 * the action reads. Documentation for authors and `cairn catalog`; the value
 * a run uses still comes from the action's `vars:` defaults, config
 * environment vars, the importing spec's `vars:`, `--var`, and a call site's
 * `use: { action, vars }` (which overrides the others for that call).
 */
export const ActionInputSchema = z
  .object({
    description: z.string().min(1).optional(),
    /**
     * The action declares no `vars:` default: the importing spec's `vars:`,
     * a config environment var or `--var` must supply it. Imports are
     * resolved once before any `use:` expands, so a value passed only in
     * `use: { action, vars }` is not enough (it can override one, per call).
     */
    required: z.boolean().optional(),
    /** Mirrors `vars.<name>`; when set it must equal that default. */
    default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  })
  .strict();
export type ActionInput = z.infer<typeof ActionInputSchema>;

/**
 * Problems between an action's declared `inputs:` and its `vars:` defaults
 * (empty when consistent): an input `default` must equal `vars.<name>` (the
 * value runs actually use), and a `required` input cannot have one.
 */
export function actionInputProblems(action: {
  vars?: Record<string, string | number | boolean> | undefined;
  inputs?: Record<string, ActionInput> | undefined;
}): Array<{ input: string; message: string }> {
  const problems: Array<{ input: string; message: string }> = [];
  const vars = action.vars ?? {};
  for (const [name, input] of Object.entries(action.inputs ?? {})) {
    const hasVar = Object.hasOwn(vars, name);
    if (input.required === true && (hasVar || input.default !== undefined)) {
      problems.push({
        input: name,
        message: `inputs.${name} is required but has a default (${
          hasVar ? `vars.${name}` : `inputs.${name}.default`
        }); drop required or the default`,
      });
      continue;
    }
    if (input.default === undefined) continue;
    if (!hasVar) {
      problems.push({
        input: name,
        message: `inputs.${name}.default is not a vars default; add vars.${name}: ${JSON.stringify(input.default)} (runs read vars:)`,
      });
    } else if (String(vars[name]) !== String(input.default)) {
      problems.push({
        input: name,
        message: `inputs.${name}.default (${JSON.stringify(input.default)}) does not match vars.${name} (${JSON.stringify(vars[name])})`,
      });
    }
  }
  return problems;
}

/**
 * A reusable action lives in `actions/<name>.yml` and is imported by specs.
 * It has steps but no outcomes — it's a fragment, not a spec. `description`
 * and `inputs` document it for authors and `cairn catalog`.
 */
export const ReusableActionSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/),
    /** What the action does, for authors and `cairn catalog`. */
    description: z.string().min(1).optional(),
    /**
     * Default `${vars.X}` values for this action. Merged under the spec's
     * vars: action defaults < config env vars < spec vars < CLI `--var`.
     */
    vars: z
      .record(z.string(), z.union([z.string(), z.number(), z.boolean()]))
      .optional(),
    /** Documented inputs (see ActionInputSchema); checked against `vars`. */
    inputs: z.record(z.string().min(1), ActionInputSchema).optional(),
    /**
     * Other action files this action `use:`s, relative to THIS file. An
     * action's `use:` resolves against its own imports first, then its
     * importer's; import cycles are a parse error.
     */
    imports: z.array(z.string()).optional(),
    steps: z.array(StepSchema).min(1),
  })
  .strict()
  .superRefine((action, ctx) => {
    for (const problem of actionInputProblems(action)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["inputs", problem.input],
        message: problem.message,
      });
    }
  });
export type ReusableAction = z.infer<typeof ReusableActionSchema>;
