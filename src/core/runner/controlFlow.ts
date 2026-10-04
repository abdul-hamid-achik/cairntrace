import {
  nestedStepLists,
  type Condition,
  type IfStep,
  type RepeatStep,
  type RetryUseStep,
  type Step,
} from "../schema/spec.v1";
import { formatWhen } from "./conditions";

/**
 * F14 control flow: where a step runs in the step tree, the ids and artifact
 * names of nested executions, `${repeat.*}` / `${waits.*}` splicing, and the
 * repeat / if / use-retry drivers. The Runner owns step execution and
 * evidence; this module only decides what runs next.
 *
 * Ids are stable across runs: a nested step keeps its own `id`, else it is
 * `<parent id>.<n>` (repeat body, retried action) or `<parent id>.then.<n>` /
 * `<parent id>.else.<n>` (if branches), n 1-based. Every execution of a
 * nested step reports `parentId`, the 1-based `iteration` (repeat) or attempt
 * (retry) of its innermost loop, and the `branch` it ran in.
 */

export interface StepPlace {
  /** 0-based index of the top-level step this execution runs under. */
  top: number;
  /** Stable step id (see module comment). */
  id: string;
  /**
   * Resolved path of the step: `"3"` at the top level, `"3/steps/0"`,
   * `"3/then/1"`, `"3/use/0"` when nested (ParseResult.nestedOrigins key).
   */
  path: string;
  /** 1-based position in the enclosing list (step.started `index`). */
  index: number;
  /** Length of the enclosing list (step.started `total`). */
  total: number;
  parentId?: string;
  /** 1-based iteration (repeat) or attempt (retry) of the innermost loop. */
  iteration?: number;
  /** The if branch this execution runs in. */
  branch?: "then" | "else";
  /** Artifact-name suffix that keeps repeated executions apart. */
  suffix: string;
  /** `${repeat.*}` values visible here (index/iteration of the innermost loop). */
  repeat: Readonly<Record<string, string>>;
}

export function topLevelPlace(
  step: Step,
  index: number,
  total: number,
): StepPlace {
  return {
    top: index,
    id: step.id ?? `step_${index + 1}`,
    path: String(index),
    index: index + 1,
    total,
    suffix: "",
    repeat: {},
  };
}

/** Place of the `j`-th step of one of `parent`'s nested lists. */
export function childPlace(
  parent: StepPlace,
  child: Step,
  list: {
    key: "steps" | "then" | "else" | "use";
    j: number;
    total: number;
    /** 0-based iteration (repeat) or attempt (retry) index, when looping. */
    loop?: number;
    /** A repeat's indexVar. */
    indexVar?: string;
  },
): StepPlace {
  const branch =
    list.key === "then" || list.key === "else" ? list.key : undefined;
  const iteration = list.loop !== undefined ? list.loop + 1 : parent.iteration;
  const suffix =
    list.loop === undefined
      ? parent.suffix
      : `${parent.suffix}_${list.key === "use" ? "a" : "i"}${list.loop + 1}`;
  const repeat =
    list.key === "steps" && list.loop !== undefined
      ? {
          ...parent.repeat,
          index: String(list.loop),
          iteration: String(list.loop + 1),
          ...(list.indexVar ? { [list.indexVar]: String(list.loop) } : {}),
        }
      : parent.repeat;
  return {
    top: parent.top,
    id:
      child.id ??
      (branch
        ? `${parent.id}.${branch}.${list.j + 1}`
        : `${parent.id}.${list.j + 1}`),
    path: `${parent.path}/${list.key}/${list.j}`,
    index: list.j + 1,
    total: list.total,
    parentId: parent.id,
    ...(iteration !== undefined ? { iteration } : {}),
    ...(branch ? { branch } : {}),
    suffix,
    repeat,
  };
}

/**
 * The default name of an unassigned `request` nested in a control-flow block
 * (undefined at the top level, which keeps `request_<n>`): the top-level
 * number, each nested position (`then1` / `else2` inside an if), and the
 * iteration / attempt suffix — `request_3_2_i2` is the second step of the
 * third top-level block's second iteration. Iterations and siblings never
 * share a `requests/<name>.json` file or a `${requests.<name>}` binding.
 */
export function nestedRequestName(place: StepPlace): string | undefined {
  if (place.parentId === undefined) return undefined;
  const segments = place.path.split("/").slice(1);
  const parts: string[] = [];
  for (let k = 0; k + 1 < segments.length; k += 2) {
    const key = segments[k];
    const position = Number(segments[k + 1]) + 1;
    parts.push(
      key === "then" || key === "else" ? `${key}${position}` : String(position),
    );
  }
  return `request_${place.top + 1}_${parts.join("_")}${place.suffix}`;
}

/** The additive event / result fields of a nested execution. */
export function placeFields(place: StepPlace): {
  parentId?: string;
  iteration?: number;
  branch?: "then" | "else";
} {
  return {
    ...(place.parentId !== undefined ? { parentId: place.parentId } : {}),
    ...(place.iteration !== undefined ? { iteration: place.iteration } : {}),
    ...(place.branch !== undefined ? { branch: place.branch } : {}),
  };
}

/** Listener info of a nested execution (undefined at the top level). */
export function nestedStepInfo(
  place: StepPlace,
):
  | { parentId: string; iteration?: number; branch?: "then" | "else" }
  | undefined {
  if (place.parentId === undefined) return undefined;
  return {
    parentId: place.parentId,
    ...(place.iteration !== undefined ? { iteration: place.iteration } : {}),
    ...(place.branch !== undefined ? { branch: place.branch } : {}),
  };
}

/** What a `wait` step with `assign` recorded (`${waits.<name>.…}`). */
export interface WaitRecord {
  matched: boolean;
  index?: number;
}

const CONTROL_REF =
  /\$\{(repeat|waits)\.([A-Za-z0-9_]+)(?:\.([A-Za-z0-9_]+))?\}/g;

/** One control reference (`repeat.index`, `waits.banner.matched`), or undefined. */
export function lookupControlRef(
  ref: string,
  place: Pick<StepPlace, "repeat">,
  waits: Readonly<Record<string, WaitRecord>>,
): string | undefined {
  const [ns, name, field, ...rest] = ref.split(".");
  if (rest.length > 0 || name === undefined) return undefined;
  if (ns === "repeat") {
    return field === undefined && Object.hasOwn(place.repeat, name)
      ? place.repeat[name]
      : undefined;
  }
  if (ns === "waits") {
    const record = Object.hasOwn(waits, name) ? waits[name] : undefined;
    if (!record) return undefined;
    if (field === "matched") return String(record.matched);
    if (field === "index" && record.index !== undefined) {
      return String(record.index);
    }
  }
  return undefined;
}

/**
 * Splice `${repeat.*}` and `${waits.*}` into one string. Unknown references
 * stay literal (like the other runtime splices).
 */
export function resolveControlPlaceholders(
  text: string,
  place: Pick<StepPlace, "repeat">,
  waits: Readonly<Record<string, WaitRecord>>,
): string {
  if (!text.includes("${")) return text;
  return text.replace(
    CONTROL_REF,
    (match, ns: string, name: string, field: string | undefined) =>
      lookupControlRef(
        field === undefined ? `${ns}.${name}` : `${ns}.${name}.${field}`,
        place,
        waits,
      ) ?? match,
  );
}

/** How one nested step execution ended. */
export interface ChildOutcome {
  status: "passed" | "failed" | "skipped";
  error?: string;
}

export interface ControlFlowDeps {
  /** Run one nested step (when:, evidence, events, its own result). */
  executeChild: (step: Step, place: StepPlace) => Promise<ChildOutcome>;
  /** Check a condition at `place` (it never waits). */
  holds: (condition: Condition, place: StepPlace) => Promise<boolean>;
  /** True once the run was cancelled or the backend wedged: stop retrying. */
  stopped: () => boolean;
  /** Number of step results recorded so far. */
  mark: () => number;
  /**
   * Drop the results recorded since `mark` (a failed attempt that will be
   * retried) and return the artifacts they referenced.
   */
  dropSince: (mark: number) => string[];
  sleep: (ms: number) => Promise<void>;
}

export interface ControlFlowResult {
  status: "passed" | "failed";
  error?: string;
  /** repeat: iterations that ran; retry: attempts that ran. */
  iterations?: number;
  /** if: the branch that ran (`none` when false without else). */
  branch?: "then" | "else" | "none";
  /** retry: the failed attempts that were retried. */
  retries?: Array<{ attempt: number; error: string }>;
  /** retry: artifacts of the dropped attempts' steps. */
  artifacts?: string[];
}

async function runList(
  parent: StepPlace,
  steps: readonly Step[],
  list: Omit<Parameters<typeof childPlace>[2], "j" | "total">,
  deps: ControlFlowDeps,
): Promise<{ failed?: { id: string; error: string } }> {
  for (let j = 0; j < steps.length; j++) {
    const step = steps[j]!;
    const place = childPlace(parent, step, { ...list, j, total: steps.length });
    const outcome = await deps.executeChild(step, place);
    if (outcome.status === "failed") {
      return {
        failed: { id: place.id, error: outcome.error ?? "step failed" },
      };
    }
  }
  return {};
}

function describeChildFailure(failed: { id: string; error: string }): string {
  return `step '${failed.id}' failed: ${failed.error}`;
}

/** Drive a repeat / if / retried use (see spec.v1 for the semantics). */
export async function runControlFlowStep(
  step: RepeatStep | IfStep | RetryUseStep,
  place: StepPlace,
  deps: ControlFlowDeps,
): Promise<ControlFlowResult> {
  if ("repeat" in step) return runRepeat(step, place, deps);
  if ("if" in step) return runIf(step, place, deps);
  return runRetryUse(step, place, deps);
}

async function runRepeat(
  step: RepeatStep,
  place: StepPlace,
  deps: ControlFlowDeps,
): Promise<ControlFlowResult> {
  const { max, until, onMax = "fail", indexVar } = step.repeat;
  let iterations = 0;
  for (let k = 0; k < max; k++) {
    if (until !== undefined && (await deps.holds(until, place))) {
      return { status: "passed", iterations };
    }
    if (deps.stopped()) {
      return { status: "failed", iterations, error: "repeat: run stopped" };
    }
    iterations = k + 1;
    const ran = await runList(
      place,
      step.repeat.steps,
      { key: "steps", loop: k, ...(indexVar ? { indexVar } : {}) },
      deps,
    );
    if (ran.failed) {
      return {
        status: "failed",
        iterations,
        error: `repeat iteration ${k + 1}/${max}: ${describeChildFailure(ran.failed)}`,
      };
    }
  }
  if (until === undefined || (await deps.holds(until, place))) {
    return { status: "passed", iterations };
  }
  const missed = `repeat: until ${formatWhen(until)} did not hold after ${max} iteration(s)`;
  return onMax === "continue"
    ? { status: "passed", iterations }
    : { status: "failed", iterations, error: missed };
}

async function runIf(
  step: IfStep,
  place: StepPlace,
  deps: ControlFlowDeps,
): Promise<ControlFlowResult> {
  const branch = (await deps.holds(step.if.condition, place))
    ? "then"
    : step.if.else
      ? "else"
      : "none";
  if (branch === "none") return { status: "passed", branch };
  const list = nestedStepLists(step).find((entry) => entry.key === branch)!;
  const ran = await runList(place, list.steps, { key: branch }, deps);
  return ran.failed
    ? {
        status: "failed",
        branch,
        error: `if (${branch}): ${describeChildFailure(ran.failed)}`,
      }
    : { status: "passed", branch };
}

async function runRetryUse(
  step: RetryUseStep,
  place: StepPlace,
  deps: ControlFlowDeps,
): Promise<ControlFlowResult> {
  const { times, until, delayMs } = step.use.retry;
  const attempts = times + 1;
  const retries: Array<{ attempt: number; error: string }> = [];
  const artifacts: string[] = [];
  for (let attempt = 1; ; attempt++) {
    const mark = deps.mark();
    const ran = await runList(
      place,
      step.steps,
      { key: "use", loop: attempt - 1 },
      deps,
    );
    let error = ran.failed ? describeChildFailure(ran.failed) : undefined;
    if (
      error === undefined &&
      until !== undefined &&
      !(await deps.holds(until, place))
    ) {
      error = `until ${formatWhen(until)} did not hold`;
    }
    const extra = {
      iterations: attempt,
      ...(retries.length > 0 ? { retries } : {}),
      ...(artifacts.length > 0 ? { artifacts } : {}),
    };
    if (error === undefined) return { status: "passed", ...extra };
    if (attempt >= attempts || deps.stopped()) {
      return {
        status: "failed",
        ...extra,
        error: `use ${step.use.action}: attempt ${attempt}/${attempts} failed: ${error}`,
      };
    }
    // The attempt will be retried: its failure stays in the events and in
    // `retries`, but no longer counts as a failed step of the run.
    artifacts.push(...deps.dropSince(mark));
    retries.push({ attempt, error });
    if (delayMs) await deps.sleep(delayMs);
  }
}
