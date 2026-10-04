import { basename } from "node:path";
import { describeWaitUrl } from "../locators";
import {
  openPath,
  widgetTargetRef,
  type WidgetTarget,
  type Condition,
  type Locator,
  type Step,
  describeAppWait,
  type RunnerWaitCondition,
  type WaitStepCondition,
} from "../schema/spec.v1";

/**
 * Short, human-scannable description of a step for `step.started` events and
 * live views: `kind` is the step's action key, `label` reads like
 * `click role=button "Save"`.
 *
 * Labels are built from the locator and target only. They never include
 * fill/type/select values, upload paths, request bodies/headers, or URL query
 * strings, so a typed secret cannot leak through the event log even before
 * the writer's redactor runs.
 */
export interface StepDescription {
  kind: string;
  label: string;
}

const MAX_LABEL_CHARS = 160;

/** Action keys in the order they are probed (one per Step variant). */
const STEP_KINDS = [
  "open",
  "click",
  "hover",
  "focus",
  "fill",
  "type",
  "select",
  "upload",
  "download",
  "transform",
  "wait",
  "request",
  "press",
  "scroll",
  "snapshot",
  "use",
  "batch",
  "eval",
  "monitor",
  // F14 control flow.
  "repeat",
  "if",
  // F15 widget kit.
  "set",
  "check",
  "uncheck",
  "choose",
  "form",
] as const;

export function stepKind(step: Step): string {
  return STEP_KINDS.find((key) => key in step) ?? "step";
}

export function describeStep(step: Step): StepDescription {
  const kind = stepKind(step);
  return { kind, label: truncate(rawLabel(step, kind)) };
}

function rawLabel(step: Step, kind: string): string {
  if ("open" in step) return `open ${withoutQuery(openPath(step))}`;
  if ("click" in step) {
    const flags = [
      step.click.optional ? "optional" : "",
      step.click.dispatch ? "dispatch" : "",
      step.click.fallback ? `fallback ${step.click.fallback}` : "",
    ].filter(Boolean);
    return `click ${locatorLabel(step.click)}${
      flags.length > 0 ? ` (${flags.join(", ")})` : ""
    }`;
  }
  if ("hover" in step) return `hover ${locatorLabel(step.hover)}`;
  if ("focus" in step) return `focus ${locatorLabel(step.focus)}`;
  if ("fill" in step) {
    const flags = [
      step.fill.mode === "set" ? "mode set" : "",
      step.fill.optional ? "optional" : "",
    ].filter(Boolean);
    return `fill ${locatorLabel(step.fill)}${
      flags.length > 0 ? ` (${flags.join(", ")})` : ""
    }`;
  }
  if ("type" in step) return `type ${locatorLabel(step.type)}`;
  if ("select" in step) return `select ${locatorLabel(step.select)}`;
  if ("upload" in step) return `upload ${locatorLabel(step.upload)}`;
  if ("download" in step) return `download ${locatorLabel(step.download)}`;
  if ("transform" in step) {
    return `transform ${basename(step.transform.file)}`;
  }
  if ("wait" in step) return `wait ${waitLabel(step.wait)}`;
  if ("request" in step) {
    return `request ${step.request.method ?? "GET"} ${withoutQuery(
      step.request.url,
    )}`;
  }
  if ("press" in step) {
    return step.target
      ? `press ${step.press} on ${locatorLabel(step.target)}`
      : `press ${step.press}`;
  }
  if ("scroll" in step) {
    return "to" in step.scroll
      ? `scroll to ${locatorLabel(step.scroll.to)}`
      : `scroll ${step.scroll.direction}${
          step.scroll.px !== undefined ? ` ${step.scroll.px}px` : ""
        }`;
  }
  if ("snapshot" in step) {
    return step.snapshot.label
      ? `snapshot ${JSON.stringify(step.snapshot.label)}`
      : "snapshot";
  }
  if ("use" in step) {
    if (typeof step.use === "string") return `use ${step.use}`;
    return step.use.retry
      ? `use ${step.use.action} (retry ×${step.use.retry.times})`
      : `use ${step.use.action}`;
  }
  if ("repeat" in step) {
    return `repeat ≤${step.repeat.max}${
      step.repeat.until !== undefined
        ? ` until ${conditionLabel(step.repeat.until)}`
        : ""
    } (${step.repeat.steps.length} steps)`;
  }
  if ("if" in step) {
    return `if ${conditionLabel(step.if.condition)} (then ${step.if.then.length}${
      step.if.else ? `, else ${step.if.else.length}` : ""
    })`;
  }
  if ("batch" in step) return `batch (${step.batch.length} sub-steps)`;
  // F15: the target and driver only, never the value.
  if ("set" in step) return `set ${widgetLabel(step.set)}`;
  if ("check" in step) return `check ${widgetLabel(step.check)}`;
  if ("uncheck" in step) return `uncheck ${widgetLabel(step.uncheck)}`;
  if ("choose" in step) return `choose ${widgetLabel(step.choose)}`;
  if ("form" in step) {
    const count = Object.keys(step.form.fields).length;
    return `form (${count} field${count === 1 ? "" : "s"})`;
  }
  if ("eval" in step) {
    if (step.eval.file) return `eval ${basename(step.eval.file)}`;
    return step.eval.assign ? `eval → ${step.eval.assign}` : "eval (inline)";
  }
  if ("monitor" in step) {
    return [
      "monitor",
      step.monitor.action,
      step.monitor.type,
      step.monitor.target,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" ");
  }
  return kind;
}

/** `field "country"` or the locator label, plus a forced driver. */
function widgetLabel(target: WidgetTarget): string {
  const ref = widgetTargetRef(target);
  const base =
    "field" in ref
      ? `field ${JSON.stringify(ref.field)}`
      : locatorLabel(ref.locator);
  return target.driver ? `${base} via ${target.driver}` : base;
}

/** Locator → `role=button "Save"`, `label "Email"`, `selector "#id" nth=1`. */
function locatorLabel(locator: Locator): string {
  const base =
    locator.by === "role"
      ? `role=${locator.role}${
          locator.name !== undefined ? ` ${JSON.stringify(locator.name)}` : ""
        }`
      : locator.by === "label"
        ? `label ${JSON.stringify(locator.name)}`
        : locator.by === "text"
          ? `text ${JSON.stringify(locator.text)}`
          : locator.by === "testid"
            ? `testid ${JSON.stringify(locator.testid)}`
            : `selector ${JSON.stringify(locator.selector)}`;
  return locator.nth !== undefined ? `${base} nth=${locator.nth}` : base;
}

/**
 * A condition for labels: the predicate kind and its target, never a var's
 * value (a `var` predicate shows only the name).
 */
function conditionLabel(condition: Condition): string {
  if (typeof condition === "string") {
    const colon = condition.indexOf(":");
    return colon < 0
      ? condition
      : `${condition.slice(0, colon)} ${JSON.stringify(condition.slice(colon + 1))}`;
  }
  if (condition.var !== undefined) return `var ${condition.var}`;
  if (condition.url !== undefined) {
    return `url ${describeWaitUrl(condition.url)}`;
  }
  const entry = Object.entries(condition).find(
    ([key, value]) => value !== undefined && key !== "hasText",
  );
  return entry ? `${entry[0]} ${JSON.stringify(entry[1])}` : "condition";
}

function waitLabel(wait: WaitStepCondition): string {
  const optional = "optional" in wait && wait.optional ? " (optional)" : "";
  if ("any" in wait) {
    return `any of ${wait.any.map(waitLabel).join(" | ")}${optional}`;
  }
  if ("all" in wait) {
    return `all of ${wait.all.map(waitLabel).join(" & ")}${optional}`;
  }
  return `${plainWaitLabel(wait)}${optional}`;
}

function plainWaitLabel(wait: RunnerWaitCondition): string {
  if ("ms" in wait) return `${wait.ms}ms`;
  if ("app" in wait) return describeAppWait(wait);
  if ("text" in wait) return `text ${JSON.stringify(wait.text)}`;
  if ("notText" in wait) return `notText ${JSON.stringify(wait.notText)}`;
  if ("load" in wait) return `load=${wait.load}`;
  if ("selector" in wait) {
    return `selector ${JSON.stringify(wait.selector)}${
      wait.state ? ` ${wait.state}` : ""
    }`;
  }
  if ("value" in wait) {
    const { equals: _equals, ...locator } = wait.value;
    return `value ${locatorLabel(locator)}`;
  }
  const url = wait.url;
  if (url.includes !== undefined) {
    return `url includes ${JSON.stringify(url.includes)}`;
  }
  if (url.equals !== undefined) {
    return `url equals ${JSON.stringify(withoutQuery(url.equals))}`;
  }
  return `url matches ${JSON.stringify(url.pattern ?? "")}`;
}

/**
 * A step result as reports list it: the id, plus where an F14 nested
 * execution ran (`#2` iteration, `[then]` branch) and what a block did
 * (`×3` iterations, `→ else`). A flat spec's results print their id only.
 */
export function stepResultLabel(step: {
  id: string;
  iteration?: number;
  branch?: string;
  iterations?: number;
  taken?: string;
  matched?: boolean;
  via?: string;
  skipReason?: string;
}): string {
  return [
    step.id,
    ...(step.iteration !== undefined ? [`#${step.iteration}`] : []),
    ...(step.branch !== undefined ? [`[${step.branch}]`] : []),
    ...(step.iterations !== undefined ? [`×${step.iterations}`] : []),
    ...(step.taken !== undefined ? [`→ ${step.taken}`] : []),
    ...(step.matched === false ? ["(not matched)"] : []),
    // F15: only the fallback paths are worth a reader's attention.
    ...(step.via === "dispatch" || step.via === "dataTransfer"
      ? [`via ${step.via}`]
      : []),
    ...(step.skipReason !== undefined ? [`(${step.skipReason})`] : []),
  ].join(" ");
}

/** Drop a URL's query string and fragment; they can carry tokens. */
export function withoutQuery(url: string): string {
  const cut = url.search(/[?#]/);
  return cut >= 0 ? url.slice(0, cut) : url;
}

function truncate(label: string): string {
  return label.length <= MAX_LABEL_CHARS
    ? label
    : `${label.slice(0, MAX_LABEL_CHARS - 1)}…`;
}
