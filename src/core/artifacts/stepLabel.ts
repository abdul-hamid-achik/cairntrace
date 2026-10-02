import { basename } from "node:path";
import {
  openPath,
  type Locator,
  type Step,
  type WaitCondition,
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
  if ("click" in step) return `click ${locatorLabel(step.click)}`;
  if ("hover" in step) return `hover ${locatorLabel(step.hover)}`;
  if ("focus" in step) return `focus ${locatorLabel(step.focus)}`;
  if ("fill" in step) return `fill ${locatorLabel(step.fill)}`;
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
    return `use ${typeof step.use === "string" ? step.use : step.use.action}`;
  }
  if ("batch" in step) return `batch (${step.batch.length} sub-steps)`;
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

function waitLabel(wait: WaitCondition): string {
  if ("ms" in wait) return `${wait.ms}ms`;
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
