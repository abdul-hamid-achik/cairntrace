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
import { BUILTIN_LOGIN_ACTION, RequestTargetSchema } from "./request.v1";
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

/**
 * F15 fill flags. `mode: set` writes through the native value setter and
 * fires input/change only (no focus, no keydown — an autocomplete or address
 * overlay that opens on typing stays closed); `optional: true` skips the step
 * (recorded as skipped) when the control is absent.
 */
const fillTargetExtras = {
  value: z.string(),
  mode: z.enum(["fill", "set"]).optional(),
  optional: z.boolean().optional(),
};

const fillTargetSchema = z.union([
  RoleLocatorSchema.extend(fillTargetExtras).strict(),
  LabelLocatorSchema.extend(fillTargetExtras).strict(),
  TextLocatorSchema.extend(fillTargetExtras).strict(),
  SelectorLocatorSchema.extend(fillTargetExtras).strict(),
  TestIdLocatorSchema.extend(fillTargetExtras).strict(),
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
 * Typed API call: see `RequestTargetSchema` (schema/request.v1.ts, shared
 * with the environment `auth:` block) for the v1 fields and the v2 ones —
 * `credentials`, `until`, `retry`, `capture`, `matrix`.
 */
const requestTargetSchema = RequestTargetSchema;

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

const WaitMsSchema = z
  .object({
    /** Pause with no predicate. Use after a create so a search index can catch up. */
    ms: z.number().int().positive().max(300_000),
  })
  .strict();
const WaitTextSchema = z
  .object({
    text: z.string().min(1),
    /** Default false; rendered text matching also normalizes whitespace. */
    caseSensitive: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
const WaitNotTextSchema = z
  .object({
    notText: z.string().min(1),
    /** Default false; rendered text matching also normalizes whitespace. */
    caseSensitive: z.boolean().optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
const WaitLoadSchema = z
  .object({
    load: z.enum(["networkidle", "load", "domcontentloaded"]),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
const WaitSelectorSchema = z
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
  .strict();
const WaitValueSchema = z
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
  .strict();
const WaitUrlSchema = z
  .object({
    url: WaitUrlMatcherSchema,
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

export const WaitConditionSchema = z.union([
  WaitMsSchema,
  WaitTextSchema,
  WaitNotTextSchema,
  WaitLoadSchema,
  WaitSelectorSchema,
  WaitValueSchema,
  WaitUrlSchema,
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

/**
 * F20: wait until a config `browser.appHandle` value holds. `path` starts
 * with the handle name and walks properties (`store.auth.user.id`,
 * `store.items[0].status`; a dot segment may hold `/`, as in a namespaced
 * getter `store.getters.auth/isLoggedIn`). Exactly one of `equals` (deep
 * JSON equality), `in` (one of) or `exists`. Always polled by the runner
 * with bounded probes (like `optional` waits), so a miss never stops the
 * browser; the value itself never leaves the page (only a short preview
 * for the failure message).
 */
export const WaitAppConditionSchema = z
  .object({
    path: z
      .string()
      .regex(
        /^[A-Za-z][A-Za-z0-9_]*(?:\.[^.[\]\s]+|\[\d+\])*$/,
        "wait.app.path: <handle>.<property>… (e.g. store.user.id)",
      ),
    equals: z.unknown().optional(),
    in: z.array(z.unknown()).nonempty().optional(),
    exists: z.boolean().optional(),
  })
  .strict()
  .refine(
    (app) =>
      [
        Object.hasOwn(app, "equals") && app.equals !== undefined,
        app.in !== undefined,
        app.exists !== undefined,
      ].filter(Boolean).length === 1,
    { message: "wait.app needs exactly one of equals | in | exists" },
  );
export const WaitAppSchema = z
  .object({
    app: WaitAppConditionSchema,
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type WaitAppCondition = z.infer<typeof WaitAppSchema>;

/** A condition the runner can poll: a backend condition or an app check. */
export type RunnerWaitCondition = WaitCondition | WaitAppCondition;

/** `app store.user.id equals 7` — labels, narration, failure messages. */
export function describeAppWait(cond: WaitAppCondition): string {
  const { path } = cond.app;
  if (cond.app.exists !== undefined) {
    return `app ${path} ${cond.app.exists ? "exists" : "does not exist"}`;
  }
  if (cond.app.in !== undefined) {
    return `app ${path} in ${JSON.stringify(cond.app.in)}`;
  }
  return `app ${path} equals ${JSON.stringify(cond.app.equals)}`;
}

/**
 * Handle names `wait: { app }` steps read (groups included), in step order
 * and without duplicates — `cairn spec verify` checks them against config
 * `browser.appHandle`.
 */
export function appWaitHandleNames(steps: readonly Step[]): string[] {
  const names = new Set<string>();
  for (const step of walkSteps(steps)) {
    if (!("wait" in step)) continue;
    const wait = step.wait;
    const conditions: RunnerWaitCondition[] =
      "any" in wait ? wait.any : "all" in wait ? wait.all : [wait];
    for (const cond of conditions) {
      if (!("app" in cond)) continue;
      names.add(cond.app.path.replace(/\[\d+\]/g, "").split(".")[0] ?? "");
    }
  }
  return [...names];
}

/** True for `wait: { app: … }` (and an app member of a wait group). */
export function isAppWaitCondition(
  wait: RunnerWaitCondition | WaitStepCondition,
): wait is WaitAppCondition {
  return "app" in wait;
}

/**
 * F14: keys a `wait` STEP adds to its condition (not batch sub-steps, not
 * discovery waits).
 *   - `optional: true` never fails the step: a condition that does not hold
 *     within `timeoutMs` passes the step with `matched: false`.
 *   - `assign: <name>` exposes the result as `${waits.<name>.matched}`
 *     (`true`/`false`) and, for `wait.any`, `${waits.<name>.index}` (0-based
 *     index of the condition that held first). A `when` / `if` reads it with
 *     `{ var: waits.<name>.matched, equals: true }`.
 * Optional and grouped waits are polled by the runner (bounded probes per
 * condition and attempt) instead of a native backend wait, so a miss never
 * stops a browser.
 */
const waitStepExtras = {
  optional: z.boolean().optional(),
  assign: z
    .string()
    .min(1)
    .regex(/^[a-z][A-Za-z0-9_]*$/)
    .optional(),
};

/** Most conditions one `wait.any` / `wait.all` group may poll together. */
export const WAIT_GROUP_MAX_CONDITIONS = 10;

const waitGroupMembers = z
  .array(z.union([...WaitConditionSchema.options, WaitAppSchema]))
  .min(1)
  .max(WAIT_GROUP_MAX_CONDITIONS);

function refineWaitGroupMembers(
  key: "any" | "all",
  members: readonly RunnerWaitCondition[],
  ctx: z.RefinementCtx,
): void {
  members.forEach((member, index) => {
    if ("timeoutMs" in member && member.timeoutMs !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [key, index, "timeoutMs"],
        message: `wait.${key}: set timeoutMs on the group, not on its conditions`,
      });
    }
  });
}

/** F14: the first condition that holds within timeoutMs passes the step. */
export const WaitAnySchema = z
  .object({
    any: waitGroupMembers,
    /** Budget of the whole group (default 30000 × waitScale). */
    timeoutMs: z.number().int().positive().optional(),
    ...waitStepExtras,
  })
  .strict()
  .superRefine((group, ctx) => refineWaitGroupMembers("any", group.any, ctx));

/** F14: every condition must hold at the same poll within timeoutMs. */
export const WaitAllSchema = z
  .object({
    all: waitGroupMembers,
    /** Budget of the whole group (default 30000 × waitScale). */
    timeoutMs: z.number().int().positive().optional(),
    ...waitStepExtras,
  })
  .strict()
  .superRefine((group, ctx) => refineWaitGroupMembers("all", group.all, ctx));

/** What a `wait:` step accepts: a condition (+ optional/assign) or a group. */
export const WaitStepConditionSchema = z.union([
  WaitMsSchema,
  WaitTextSchema.extend(waitStepExtras),
  WaitNotTextSchema.extend(waitStepExtras),
  WaitLoadSchema.extend(waitStepExtras),
  WaitSelectorSchema.extend(waitStepExtras),
  WaitValueSchema.extend(waitStepExtras),
  WaitUrlSchema.extend(waitStepExtras),
  WaitAppSchema.extend(waitStepExtras),
  WaitAnySchema,
  WaitAllSchema,
]);
export type WaitStepCondition = z.infer<typeof WaitStepConditionSchema>;
export type WaitGroup =
  | z.infer<typeof WaitAnySchema>
  | z.infer<typeof WaitAllSchema>;

/** True for `wait.any` / `wait.all`. */
export function isWaitGroup(wait: WaitStepCondition): wait is WaitGroup {
  return "any" in wait || "all" in wait;
}

/**
 * True when the runner (not the backend) drives this wait: a group, an
 * optional condition (a native backend wait that times out may stop the
 * browser, which an optional miss must never do), or an app wait (F20, no
 * backend knows app handles).
 */
export function isRunnerDrivenWait(wait: WaitStepCondition): boolean {
  return (
    isWaitGroup(wait) ||
    isAppWaitCondition(wait) ||
    ("optional" in wait && wait.optional === true)
  );
}

/** The plain condition of a wait step (F14 step keys removed). */
export function plainWaitCondition(
  wait: Exclude<WaitStepCondition, WaitGroup>,
): RunnerWaitCondition {
  if ("ms" in wait) return wait;
  const { optional: _optional, assign: _assign, ...condition } = wait;
  return condition as RunnerWaitCondition;
}

/**
 * The condition a backend executes for a `wait` step. Groups, optional and
 * app waits never reach a backend: the runner polls them (see
 * isRunnerDrivenWait).
 */
export function backendWaitCondition(wait: WaitStepCondition): WaitCondition {
  if (isRunnerDrivenWait(wait) || isWaitGroup(wait)) {
    throw new Error(
      "wait.any / wait.all / optional / app waits are polled by the runner before adapter dispatch",
    );
  }
  const plain = plainWaitCondition(wait);
  if (isAppWaitCondition(plain)) {
    throw new Error("wait.app is polled by the runner before adapter dispatch");
  }
  return plain;
}

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

/** A scalar a `var` predicate compares with (values compare as strings). */
const VarScalarSchema = z.union([z.string(), z.number(), z.boolean()]);

/**
 * Name a `var` predicate reads: a config/spec/use-site var (`mode`) or a
 * dotted runtime value (`waits.banner.matched`, `repeat.index`,
 * `captures.order.id`, `runs.seed.count`, `requests.login.status`,
 * `evals.state.value`, `fixtures.buyer.id`).
 */
export const VarRefSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$/,
    "var: a var name, or a dotted runtime value such as waits.<name>.matched",
  );

const WHEN_PREDICATE_KEYS = [
  "urlContains",
  "urlNotContains",
  "urlMatches",
  "url",
  "text",
  "notText",
  "selector",
  "notSelector",
  "var",
] as const;

export const WhenObjectSchema = z
  .object({
    urlContains: z.string().min(1).optional(),
    urlNotContains: z.string().min(1).optional(),
    urlMatches: z.string().min(1).optional(),
    /** F14: the wait.url matcher (`includes` | `equals` | `pattern`). */
    url: WaitUrlMatcherSchema.optional(),
    text: z.string().min(1).optional(),
    notText: z.string().min(1).optional(),
    selector: z.string().min(1).optional(),
    notSelector: z.string().min(1).optional(),
    hasText: z.string().min(1).optional(),
    /**
     * F14: a var predicate — `{ var: mode, equals: fast }`,
     * `{ var: region, in: [eu, us] }`, `{ var: featureFlag, exists: true }`.
     * A plain name reads the vars of the file that declares the step (config,
     * spec, and the `use:` call's vars inside an action); a dotted name reads
     * a runtime value (see VarRefSchema). Values compare as strings; `exists`
     * holds for a set, non-empty value.
     */
    var: VarRefSchema.optional(),
    equals: VarScalarSchema.optional(),
    in: z.array(VarScalarSchema).min(1).optional(),
    exists: z.boolean().optional(),
    /**
     * Set by the parser, never authored (parseSpec refuses an authored one):
     * the plain var's value in the scope of the file that declares the step
     * (absent when that scope does not define it). It stays in this schema
     * because resolved steps are re-validated (the mock backend's strict
     * step check).
     */
    resolved: z.string().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const keys = WHEN_PREDICATE_KEYS.filter((key) => value[key] !== undefined);
    if (keys.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `when: exactly one of ${WHEN_PREDICATE_KEYS.join("|")}`,
      });
    }
    if (value.hasText !== undefined && keys[0] !== "selector") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["hasText"],
        message: "hasText is only valid with selector",
      });
    }
    const comparisons = (["equals", "in", "exists"] as const).filter(
      (key) => value[key] !== undefined,
    );
    if (value.var !== undefined && comparisons.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["var"],
        message: "when.var needs exactly one of equals | in | exists",
      });
    }
    if (value.var === undefined) {
      for (const key of [...comparisons, "resolved" as const]) {
        if (value[key] === undefined) continue;
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `${key} is only valid with var`,
        });
      }
    }
  });
export type WhenObject = z.infer<typeof WhenObjectSchema>;

/**
 * F14: the one condition grammar shared by `when:`, `repeat.until`,
 * `if.condition` and `use.retry.until` — the string DSL (`text:Saved`,
 * `urlContains:/done`, …) or the object form (urlContains | urlNotContains |
 * urlMatches | url | text | notText | selector (+hasText) | notSelector |
 * var). A condition is checked once, at that moment; it never waits.
 */
export const ConditionSchema = z.union([z.string().min(1), WhenObjectSchema]);
export type Condition = z.infer<typeof ConditionSchema>;

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
  /** Skip the step unless this condition holds (see ConditionSchema). */
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

/**
 * Runner-owned click flags (F15): `optional: true` skips the click (recorded
 * as skipped) when no visible target exists; `dispatch: true` fires a DOM
 * click on the element (no pointer, no actionability wait); `fallback:
 * dispatch` tries the pointer click first and falls back to the DOM click
 * when the pointer is blocked (the blocking element is recorded).
 */
const clickTargetExtras = {
  until: ClickUntilSchema.optional(),
  optional: z.boolean().optional(),
  dispatch: z.boolean().optional(),
  fallback: z.literal("dispatch").optional(),
};

const clickTargetSchema = z.union([
  RoleLocatorSchema.extend(clickTargetExtras).strict(),
  LabelLocatorSchema.extend(clickTargetExtras).strict(),
  TextLocatorSchema.extend(clickTargetExtras).strict(),
  SelectorLocatorSchema.extend(clickTargetExtras).strict(),
  TestIdLocatorSchema.extend(clickTargetExtras).strict(),
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

/** Locator portion of a click step, excluding the runner-owned flags. */
export function clickLocator(step: ClickStep): Locator {
  const {
    until: _until,
    optional: _optional,
    dispatch: _dispatch,
    fallback: _fallback,
    ...locator
  } = step.click;
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

/** Locator portion of a fill step (value and the F15 mode/optional flags removed). */
export function fillLocator(step: FillStep): Locator {
  const {
    value: _value,
    mode: _mode,
    optional: _optional,
    ...locator
  } = step.fill;
  return locator as Locator;
}

/** The fill step a backend receives: the F15 runner-owned flags removed. */
export function withoutFillFlags(step: FillStep): FillStep {
  const { mode: _mode, optional: _optional, ...fill } = step.fill;
  return { ...step, fill: fill as FillStep["fill"] };
}

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
  .object({ ...stepCommon, wait: WaitStepConditionSchema })
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

/** Most extra attempts one `use.retry` may make. */
export const USE_RETRY_MAX_TIMES = 10;

/**
 * F14: `use: { action, vars, retry: { times, until?, delayMs? } }` runs the
 * action's steps as one group and runs the whole group again when one of its
 * steps fails, or when `until` does not hold after they all passed — at most
 * `times` more attempts (so `times + 1` in all). An exhausted retry fails
 * the step with the last attempt's error. `delayMs` pauses between attempts.
 */
export const UseRetrySchema = z
  .object({
    times: z.number().int().min(1).max(USE_RETRY_MAX_TIMES),
    until: ConditionSchema.optional(),
    delayMs: z.number().int().min(0).max(60_000).optional(),
  })
  .strict();
export type UseRetry = z.infer<typeof UseRetrySchema>;

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
    retry: UseRetrySchema.optional(),
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

/**
 * F18: in a RESOLVED spec, `use: login` (or `use: { action: login, vars }`)
 * that no imported action named `login` expanded: the built-in action that
 * runs the environment's `auth:` block (config `environments.<name>.auth`).
 * An imported `login` action always wins (the parser inlines it).
 */
export function isBuiltinLoginUse(step: Step): boolean {
  return (
    "use" in step &&
    useActionName(step) === BUILTIN_LOGIN_ACTION &&
    !Array.isArray((step as { steps?: unknown }).steps)
  );
}

/** The F14 `retry` of a `use:` call, when it has one. */
export function useRetry(step: UseStep): UseRetry | undefined {
  return typeof step.use === "string" ? undefined : step.use.retry;
}

/**
 * A `use:` with `retry` after parseSpec expanded it: the action's resolved
 * steps travel with the call (`steps`) so the runner can retry them as one
 * group. Only `ParseResult.resolved` carries this shape; specs on disk never
 * author `steps:` next to `use:`.
 */
export type RetryUseStep = UseStep & {
  use: UseActionCall & { retry: UseRetry };
  steps: Step[];
};

/** True for a resolved `use:` + `retry` group (see RetryUseStep). */
export function isRetryUseStep(step: Step): step is RetryUseStep {
  return (
    "use" in step &&
    typeof step.use !== "string" &&
    step.use.retry !== undefined &&
    Array.isArray((step as { steps?: unknown }).steps)
  );
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

/* ----- F15 widget kit (set / check / uncheck / choose / form) ----- */

/**
 * A value a widget step writes: text or a number (input, select, picker,
 * date — ISO `YYYY-MM-DD` or `today` for a calendar), a boolean (a single
 * checkbox), a list (multi-select, checkbox group, pills), or
 * `{ query, option? }` for a searchable picker: type `query`, pick the
 * option labelled `option` (default: the query).
 */
export const WidgetValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.union([z.string(), z.number()])),
  z
    .object({
      query: z.string().min(1),
      option: z.string().min(1).optional(),
    })
    .strict(),
]);
export type WidgetValue = z.infer<typeof WidgetValueSchema>;

/** A driver name: built-in, or the `name` a custom driver module exports. */
export const WidgetDriverNameSchema = z
  .string()
  .min(1)
  .regex(
    /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
    "driver: a built-in or custom driver name",
  );

const fieldKeySchema = z.string().min(1);
const widgetOptionSchema = z.union([z.string().min(1), z.number()]);

const widgetTargetCommon = {
  /** Force a driver instead of auto-detecting one with `match(root)`. */
  driver: WidgetDriverNameSchema.optional(),
  /** Skip (recorded as skipped) when the field is absent. */
  optional: z.boolean().optional(),
  /** Budget for mounting + writing + reading back (default 10000 × waitScale). */
  timeoutMs: z.number().int().positive().optional(),
};

/**
 * `{ field: <key> }` (resolved through config `browser.fieldRoot`) or any
 * locator (`by: role | label | text | selector | testid`), plus `extras`.
 */
function widgetTargetSchema<T extends z.ZodRawShape>(extras: T) {
  const shape = { ...widgetTargetCommon, ...extras };
  return z.union([
    z.object({ field: fieldKeySchema, ...shape }).strict(),
    RoleLocatorSchema.extend(shape).strict(),
    LabelLocatorSchema.extend(shape).strict(),
    TextLocatorSchema.extend(shape).strict(),
    SelectorLocatorSchema.extend(shape).strict(),
    TestIdLocatorSchema.extend(shape).strict(),
  ]);
}

/**
 * `set: { field | locator, value, driver? }` — detect the widget driver
 * (`match(root)`), write the value, then READ IT BACK: the step fails with
 * evidence (`widgets/<n>_<id>.json`) when the committed value differs.
 * A field that already holds the value is left alone (idempotent).
 */
export const SetStepSchema = z
  .object({
    ...stepCommon,
    set: widgetTargetSchema({ value: WidgetValueSchema }),
  })
  .strict();
export type SetStep = z.infer<typeof SetStepSchema>;

/**
 * `check: { field | locator, option? }` — tick a checkbox (or the `option`
 * of a checkbox group / radio group). Idempotent: an option already checked
 * is never clicked; read back like `set`.
 */
export const CheckStepSchema = z
  .object({
    ...stepCommon,
    check: widgetTargetSchema({ option: widgetOptionSchema.optional() }),
  })
  .strict();
export type CheckStep = z.infer<typeof CheckStepSchema>;

/** `uncheck: { field | locator, option? }` — the inverse of `check`. */
export const UncheckStepSchema = z
  .object({
    ...stepCommon,
    uncheck: widgetTargetSchema({ option: widgetOptionSchema.optional() }),
  })
  .strict();
export type UncheckStep = z.infer<typeof UncheckStepSchema>;

/**
 * `choose: { field | locator, option }` — single choice: a radio group, a
 * select, a single vue-multiselect / autocomplete. Read back like `set`.
 */
export const ChooseStepSchema = z
  .object({
    ...stepCommon,
    choose: widgetTargetSchema({ option: widgetOptionSchema }),
  })
  .strict();
export type ChooseStep = z.infer<typeof ChooseStepSchema>;

/** Most fields one `form` step may hold. */
export const FORM_MAX_FIELDS = 100;

/** A form field with options (plain values are shorthand for `{ value }`). */
export const FormFieldObjectSchema = z
  .object({
    value: WidgetValueSchema,
    /** Skip when the field is not on the page (after a short presence check). */
    optional: z.boolean().optional(),
    /**
     * Earlier field key(s) this one appears after: the field gets the full
     * mount wait once they are written, and is skipped when one of them was.
     */
    dependsOn: z
      .union([fieldKeySchema, z.array(fieldKeySchema).min(1)])
      .optional(),
    driver: WidgetDriverNameSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();
export type FormFieldObject = z.infer<typeof FormFieldObjectSchema>;
export const FormFieldSchema = z.union([
  FormFieldObjectSchema,
  WidgetValueSchema,
]);
export type FormField = z.infer<typeof FormFieldSchema>;

/**
 * `form: { fields: { <key>: value | { value, optional?, dependsOn?, driver? } },
 * verify?: committed | none, onFailure?: dumpUnanswered }` — set fields in
 * declared order through `browser.fieldRoot`, each read back (`verify:
 * committed`, default) and re-read once more at the end, so a later field
 * that wiped an earlier one fails the step. Per-field evidence goes to
 * `widgets/<n>_<id>.json`; `onFailure: dumpUnanswered` adds the page's
 * empty fields to it.
 */
export const FormStepSchema = z
  .object({
    ...stepCommon,
    form: z
      .object({
        fields: z.record(fieldKeySchema, FormFieldSchema),
        verify: z.enum(["committed", "none"]).optional(),
        onFailure: z
          .union([
            z.literal("dumpUnanswered"),
            z.object({ dumpUnanswered: z.boolean().optional() }).strict(),
          ])
          .optional(),
        /** Per-field budget (default 10000 × waitScale); a field's own wins. */
        timeoutMs: z.number().int().positive().optional(),
      })
      .strict()
      .superRefine((form, ctx) => {
        const keys = Object.keys(form.fields);
        if (keys.length === 0) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["fields"],
            message: "form.fields needs at least one field",
          });
        }
        if (keys.length > FORM_MAX_FIELDS) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["fields"],
            message: `form.fields holds at most ${FORM_MAX_FIELDS} fields`,
          });
        }
        keys.forEach((key, index) => {
          if (/^\d+$/.test(key)) {
            ctx.addIssue({
              code: z.ZodIssueCode.custom,
              path: ["fields", key],
              message:
                "form field keys must not be integers (JavaScript reorders them); quote a prefix into the key or use separate set steps",
            });
          }
          const field = form.fields[key];
          const deps = formFieldDependsOn(field);
          for (const dep of deps) {
            const at = keys.indexOf(dep);
            if (at < 0 || at >= index) {
              ctx.addIssue({
                code: z.ZodIssueCode.custom,
                path: ["fields", key, "dependsOn"],
                message: `dependsOn ${JSON.stringify(dep)} must name an earlier field of this form`,
              });
            }
          }
        });
      }),
  })
  .strict();
export type FormStep = z.infer<typeof FormStepSchema>;

/** True for a `{ value, … }` form field (not a bare value). */
export function isFormFieldObject(
  field: FormField | undefined,
): field is FormFieldObject {
  return (
    field !== null &&
    typeof field === "object" &&
    !Array.isArray(field) &&
    "value" in field
  );
}

/** The `dependsOn` keys of a form field, as a list. */
export function formFieldDependsOn(field: FormField | undefined): string[] {
  if (!isFormFieldObject(field) || field.dependsOn === undefined) return [];
  return Array.isArray(field.dependsOn) ? field.dependsOn : [field.dependsOn];
}

/** Widget step kinds (F15). */
export type WidgetStep =
  | SetStep
  | CheckStep
  | UncheckStep
  | ChooseStep
  | FormStep;

export function isWidgetStep(step: Step): step is WidgetStep {
  return (
    "set" in step ||
    "check" in step ||
    "uncheck" in step ||
    "choose" in step ||
    "form" in step
  );
}

/** The single-field target of set / check / uncheck / choose. */
export type WidgetTarget =
  | SetStep["set"]
  | CheckStep["check"]
  | UncheckStep["uncheck"]
  | ChooseStep["choose"];

/** `{ field }` or the locator part of a widget target (flags removed). */
export function widgetTargetRef(
  target: WidgetTarget,
): { field: string } | { locator: Locator } {
  if ("field" in target) return { field: target.field };
  const {
    driver: _driver,
    optional: _optional,
    timeoutMs: _timeoutMs,
    ...rest
  } = target as Record<string, unknown>;
  delete rest["value"];
  delete rest["option"];
  return { locator: rest as Locator };
}

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

/** Every step kind except the F14 control-flow blocks (repeat / if). */
const LeafStepSchema = z.union([
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
  // F15 widget kit.
  SetStepSchema,
  CheckStepSchema,
  UncheckStepSchema,
  ChooseStepSchema,
  FormStepSchema,
]);
export type LeafStep = z.infer<typeof LeafStepSchema>;

/* ----- control flow (F14) ----- */

/** Most iterations one `repeat` may run. */
export const REPEAT_MAX_ITERATIONS = 100;

/** Fields every step shares, control-flow blocks included. */
interface StepCommonFields {
  id?: string;
  when?: string | WhenObject;
  postcondition?: Postcondition;
}

/**
 * `repeat: { max, until?, steps, indexVar?, onMax? }` runs `steps` up to
 * `max` (≤ 100) times. `until` is checked before every iteration and once
 * more after the last: the loop stops as soon as it holds. Reaching `max`
 * with an `until` that never held fails the step (`onMax: fail`, default) or
 * passes it (`onMax: continue`); without `until` the loop simply runs `max`
 * times. A failing nested step fails the repeat (and the run). Nested steps
 * see `${repeat.index}` (0-based) and `${repeat.iteration}` (1-based) of the
 * innermost loop, plus `${repeat.<indexVar>}` (0-based) of every enclosing
 * loop that names one.
 */
export interface RepeatStep extends StepCommonFields {
  repeat: {
    max: number;
    until?: Condition;
    steps: Step[];
    indexVar?: string;
    onMax?: "fail" | "continue";
  };
}

/**
 * `if: { condition, then, else? }` checks `condition` once (same grammar as
 * `when:`) and runs `then` or `else`. Without `else` a false condition runs
 * nothing and passes the step.
 */
export interface IfStep extends StepCommonFields {
  if: {
    condition: Condition;
    then: Step[];
    else?: Step[];
  };
}

/** Every step a spec, an action or a control-flow block may hold. */
export type Step = LeafStep | RepeatStep | IfStep;

/** Names `${repeat.*}` reserves for itself. */
const RESERVED_REPEAT_NAMES = new Set(["index", "iteration"]);

const nestedStepsSchema = z.array(z.lazy(() => StepSchema)).min(1);

export const RepeatStepSchema: z.ZodType<RepeatStep, z.ZodTypeDef, unknown> = z
  .object({
    ...stepCommon,
    repeat: z
      .object({
        max: z.number().int().min(1).max(REPEAT_MAX_ITERATIONS),
        until: ConditionSchema.optional(),
        steps: nestedStepsSchema,
        indexVar: z
          .string()
          .regex(/^[a-z][A-Za-z0-9_]*$/)
          .refine((name) => !RESERVED_REPEAT_NAMES.has(name), {
            message: "indexVar: index and iteration are reserved",
          })
          .optional(),
        onMax: z.enum(["fail", "continue"]).optional(),
      })
      .strict(),
  })
  .strict();

export const IfStepSchema: z.ZodType<IfStep, z.ZodTypeDef, unknown> = z
  .object({
    ...stepCommon,
    if: z
      .object({
        condition: ConditionSchema,
        // oxlint-disable-next-line unicorn/no-thenable -- `if.then` is a step list, never a function
        then: nestedStepsSchema,
        else: nestedStepsSchema.optional(),
      })
      .strict(),
  })
  .strict();

export const StepSchema: z.ZodType<Step, z.ZodTypeDef, unknown> = z
  .union([LeafStepSchema, RepeatStepSchema, IfStepSchema])
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
    if ("click" in step) {
      const click = step.click;
      if (click.dispatch === true && click.fallback !== undefined) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["click", "fallback"],
          message: "click: use dispatch: true or fallback: dispatch, not both",
        });
      }
      if (
        click.until !== undefined &&
        (click.dispatch === true || click.fallback !== undefined)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["click", "until"],
          message: "click.until cannot be combined with dispatch / fallback",
        });
      }
      if (
        step.postcondition !== undefined &&
        (click.dispatch === true || click.fallback !== undefined)
      ) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["postcondition"],
          message:
            "postcondition.network cannot be combined with click dispatch / fallback",
        });
      }
    }
    if (
      "fill" in step &&
      step.fill.mode === "set" &&
      step.postcondition !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["postcondition"],
        message: "postcondition.network cannot be combined with fill mode: set",
      });
    }
  });

/** True for the F14 control-flow steps (repeat / if / a resolved retry use). */
export function isControlFlowStep(
  step: Step,
): step is RepeatStep | IfStep | RetryUseStep {
  return "repeat" in step || "if" in step || isRetryUseStep(step);
}

/**
 * The nested step lists of a control-flow step, with the label each list
 * uses in nested step ids and paths (`steps`, `then`, `else`, `use`).
 */
export function nestedStepLists(
  step: Step,
): Array<{ key: "steps" | "then" | "else" | "use"; steps: Step[] }> {
  if ("repeat" in step) return [{ key: "steps", steps: step.repeat.steps }];
  if ("if" in step) {
    return [
      { key: "then", steps: step.if.then },
      ...(step.if.else ? [{ key: "else" as const, steps: step.if.else }] : []),
    ];
  }
  if (isRetryUseStep(step)) return [{ key: "use", steps: step.steps }];
  return [];
}

/**
 * Every step of a tree in document order (control-flow blocks first, then
 * their nested steps), without expanding `use:`.
 */
export function walkSteps(steps: readonly Step[]): Step[] {
  const out: Step[] = [];
  const visit = (list: readonly Step[]): void => {
    for (const step of list) {
      out.push(step);
      for (const nested of nestedStepLists(step)) visit(nested.steps);
    }
  };
  visit(steps);
  return out;
}

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
  // F14: control flow belongs to the steps; cleanup runs every item once.
  "repeat",
  "if",
  // F15: widget steps write read-back evidence; cleanup does not verify.
  "set",
  "check",
  "uncheck",
  "choose",
  "form",
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
