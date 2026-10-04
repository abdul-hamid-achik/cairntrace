import type {
  BrowserBackend,
  InvocationResult,
} from "../../adapters/browserBackend";
import type { ArtifactWriter } from "../artifacts/ArtifactWriter";
import { isSensitiveName } from "../catalog/mask";
import { boundValue } from "../runner/verifiers/evidence";
import {
  clickLocator,
  fillLocator,
  formFieldDependsOn,
  isFormFieldObject,
  widgetTargetRef,
  withoutFillFlags,
  type ClickStep,
  type FillStep,
  type FormStep,
  type Locator,
  type Step,
  type WidgetStep,
  type WidgetTarget,
} from "../schema/spec.v1";
import {
  runWidgetOp,
  type PreparedWidgets,
  type WidgetOpInput,
  type WidgetOpResult,
  type WidgetTargetRef,
} from "./runtime";

/**
 * Runner glue for the F15 widget kit (set / check / uncheck / choose /
 * form) and the runner-owned interaction flags (click optional / dispatch /
 * fallback, fill mode: set / optional). Evidence goes to
 * `widgets/<n>_<id>.json`; one `widget.field` event per field.
 */

/** Default per-field budget: mount + write + read back. */
export const DEFAULT_WIDGET_TIMEOUT_MS = 10_000;
/** How long an optional field (no dependsOn) may take to show up. */
export const OPTIONAL_PRESENCE_MS = 750;
/** Read-back settle budget after a write. */
export const READ_BACK_MS = 2_000;
/** How long a dispatch / hit-test click waits for its target to mount. */
export const CLICK_MOUNT_MS = 5_000;

type StepWriter = Pick<ArtifactWriter, "writeJson" | "appendEvent">;

export interface WidgetDeps {
  backend: BrowserBackend;
  /** Prepared lazily (custom driver files are read on first use). */
  widgets: () => Promise<PreparedWidgets>;
  waitScale: number;
}

export interface WidgetStepDeps extends WidgetDeps {
  writer: StepWriter;
  stepId: string;
  /** 1-based step index (evidence file prefix). */
  index: number;
  /** F14: keeps the evidence of repeated executions apart. */
  fileSuffix?: string;
  /** F14 nested-step fields stamped on `widget.field` events. */
  place?: { parentId?: string; iteration?: number; branch?: "then" | "else" };
}

export interface WidgetStepOutcome {
  status: "passed" | "failed" | "skipped";
  error?: string;
  artifacts: string[];
  driver?: string;
  via?: string;
  detail?: string;
  skipReason?: string;
}

interface FieldEvidence {
  field: string;
  status: "committed" | "already" | "written" | "skipped" | "failed";
  driver?: string;
  via?: string;
  expected?: unknown;
  actual?: unknown;
  error?: string;
  reason?: string;
  root?: string;
  rootText?: string;
  notes?: string[];
  durationMs: number;
  /** form verify pass: what the field showed after every field was set. */
  final?: { actual?: unknown; matches?: boolean; status: string };
}

const MASK = "[redacted]";

function scaled(ms: number, waitScale: number): number {
  return Math.max(1, Math.round(ms * waitScale));
}

function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

function slug(text: string): string {
  return text.replace(/[^A-Za-z0-9_-]+/g, "_").slice(0, 80) || "widget";
}

/** A field key, or a short description of a locator target. */
export function describeWidgetTarget(ref: WidgetTargetRef): string {
  if ("field" in ref) return ref.field;
  const loc = ref.locator;
  const base =
    loc.by === "role"
      ? `role=${loc.role}${loc.name !== undefined ? ` "${loc.name}"` : ""}`
      : loc.by === "label"
        ? `label "${loc.name}"`
        : loc.by === "text"
          ? `text "${loc.text}"`
          : loc.by === "testid"
            ? `testid ${loc.testid}`
            : loc.selector;
  return loc.nth !== undefined ? `${base} nth=${loc.nth}` : base;
}

function fieldStatus(result: WidgetOpResult): FieldEvidence["status"] {
  if (!result.ok) return "failed";
  if (
    result.status === "committed" ||
    result.status === "already" ||
    result.status === "written" ||
    result.status === "skipped"
  ) {
    return result.status;
  }
  return "committed";
}

function evidenceFor(
  field: string,
  result: WidgetOpResult,
  sensitive: boolean,
): FieldEvidence {
  const masked = sensitive || result.sensitive === true;
  const value = (v: unknown): unknown =>
    v === undefined
      ? undefined
      : masked
        ? MASK
        : boundValue(v, 16 * 1024).value;
  const out: FieldEvidence = {
    field,
    status: fieldStatus(result),
    durationMs: Math.max(0, Math.round(result.durationMs ?? 0)),
  };
  if (result.driver) out.driver = result.driver;
  if (result.via) out.via = result.via;
  if (result.expected !== undefined) out.expected = value(result.expected);
  if (result.actual !== undefined) out.actual = value(result.actual);
  if (result.error) {
    out.error = masked
      ? scrubValues(result.error, [
          result.expected,
          result.actual,
          result.label,
        ])
      : result.error;
  }
  if (result.reason) out.reason = result.reason;
  if (result.root) out.root = result.root;
  if (result.rootText && !masked) out.rootText = result.rootText;
  if (result.notes?.length && !masked) out.notes = result.notes;
  return out;
}

/** Replace every string leaf of `values` (and its JSON form) in `text`. */
function scrubValues(text: string, values: unknown[]): string {
  const needles = new Set<string>();
  const walk = (value: unknown): void => {
    if (typeof value === "string" || typeof value === "number") {
      const s = String(value);
      if (s.length > 0) {
        needles.add(JSON.stringify(s));
        needles.add(s);
      }
    } else if (Array.isArray(value)) {
      needles.add(JSON.stringify(value));
      value.forEach(walk);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(walk);
    }
  };
  values.forEach(walk);
  let out = text;
  for (const needle of [...needles].toSorted((a, b) => b.length - a.length)) {
    out = out.split(needle).join(MASK);
  }
  return out;
}

function failureMessage(field: string, entry: FieldEvidence): string {
  return `field ${JSON.stringify(field)}: ${entry.error ?? "failed"}`;
}

/** Run a set / check / uncheck / choose / form step. */
export async function executeWidgetStep(
  step: WidgetStep,
  deps: WidgetStepDeps,
): Promise<WidgetStepOutcome> {
  let prepared: PreparedWidgets;
  try {
    prepared = await deps.widgets();
  } catch (e) {
    return {
      status: "failed",
      error: `widgets: ${(e as Error).message}`,
      artifacts: [],
    };
  }
  const kind =
    "set" in step
      ? "set"
      : "check" in step
        ? "check"
        : "uncheck" in step
          ? "uncheck"
          : "choose" in step
            ? "choose"
            : "form";
  const path = `widgets/${pad(deps.index)}_${slug(deps.stepId)}${deps.fileSuffix ?? ""}.json`;
  const fields: FieldEvidence[] = [];
  let unanswered: { total?: number; fields: unknown[] } | undefined;
  let outcome: Omit<WidgetStepOutcome, "artifacts">;

  const emit = async (entry: FieldEvidence): Promise<void> => {
    await deps.writer.appendEvent({
      ts: new Date().toISOString(),
      type: "widget.field",
      stepId: deps.stepId,
      field: entry.field.slice(0, 200) || "field",
      ...(entry.driver ? { driver: entry.driver } : {}),
      status: entry.status,
      ...(entry.via ? { via: entry.via } : {}),
      durationMs: entry.durationMs,
      path,
      ...deps.place,
    });
  };

  if (kind === "form") {
    const result = await runForm(
      step as FormStep,
      prepared,
      deps,
      fields,
      emit,
    );
    outcome = result.outcome;
    unanswered = result.unanswered;
  } else {
    const target = (step as Record<string, unknown>)[kind] as WidgetTarget;
    const ref = widgetTargetRef(target);
    const field = describeWidgetTarget(ref);
    const budget = scaled(
      target.timeoutMs ?? DEFAULT_WIDGET_TIMEOUT_MS,
      deps.waitScale,
    );
    const input: WidgetOpInput = {
      op: kind,
      target: ref,
      timeoutMs: budget,
      mountMs: target.optional
        ? Math.min(budget, scaled(OPTIONAL_PRESENCE_MS, deps.waitScale))
        : budget,
      readBackMs: scaled(READ_BACK_MS, deps.waitScale),
      ...(target.driver ? { driver: target.driver } : {}),
      ...(target.optional ? { optional: true } : {}),
      ...("value" in target ? { value: target.value } : {}),
      ...("option" in target && target.option !== undefined
        ? { option: String(target.option) }
        : {}),
    };
    const result = await runWidgetOp(deps.backend, prepared, input);
    const sensitive = isSensitiveName(field) || result.sensitive === true;
    const entry = evidenceFor(field, result, sensitive);
    fields.push(entry);
    await emit(entry);
    // A partial-label pick committed another label than the one asked for:
    // the step says which, so a substituted record never passes silently.
    const substitution = result.substituted
      ? sensitive
        ? "committed through a partial-label match"
        : (result.notes?.find((note) =>
            note.endsWith("(partial-label match)"),
          ) ?? "committed through a partial-label match")
      : undefined;
    const what = "field" in ref ? `field ${JSON.stringify(ref.field)}` : field;
    outcome =
      entry.status === "failed"
        ? {
            status: "failed",
            error: `${kind} ${what}: ${entry.error ?? "failed"}`,
            ...(entry.driver ? { driver: entry.driver } : {}),
          }
        : entry.status === "skipped"
          ? { status: "skipped", skipReason: entry.reason ?? "absent" }
          : {
              status: "passed",
              ...(entry.driver ? { driver: entry.driver } : {}),
              ...(entry.via
                ? { via: entry.via }
                : entry.status === "already"
                  ? { via: "already" }
                  : {}),
              ...(substitution ? { detail: substitution } : {}),
            };
  }

  await deps.writer.writeJson(
    path,
    {
      version: 1,
      stepId: deps.stepId,
      kind,
      status: outcome.status,
      ...(outcome.error ? { error: outcome.error } : {}),
      fields,
      ...(unanswered ? { unanswered } : {}),
    },
    "widget",
  );
  return { ...outcome, artifacts: [path] };
}

async function runForm(
  step: FormStep,
  prepared: PreparedWidgets,
  deps: WidgetStepDeps,
  fields: FieldEvidence[],
  emit: (entry: FieldEvidence) => Promise<void>,
): Promise<{
  outcome: Omit<WidgetStepOutcome, "artifacts">;
  unanswered?: { total?: number; fields: unknown[] };
}> {
  const form = step.form;
  const verify = form.verify !== "none";
  const byKey = new Map<string, FieldEvidence>();
  const written: Array<{
    key: string;
    value: unknown;
    driver?: string;
    label?: unknown;
  }> = [];
  let error: string | undefined;

  for (const [key, raw] of Object.entries(form.fields)) {
    const field = isFormFieldObject(raw) ? raw : { value: raw };
    const dependsOn = formFieldDependsOn(raw);
    const skippedDep = dependsOn.find(
      (dep) => byKey.get(dep)?.status === "skipped",
    );
    if (skippedDep !== undefined) {
      const entry: FieldEvidence = {
        field: key,
        status: "skipped",
        reason: `dependsOn ${skippedDep} was skipped`,
        durationMs: 0,
      };
      fields.push(entry);
      byKey.set(key, entry);
      await emit(entry);
      continue;
    }
    const optional = isFormFieldObject(raw) && raw.optional === true;
    const budget = scaled(
      field.timeoutMs ?? form.timeoutMs ?? DEFAULT_WIDGET_TIMEOUT_MS,
      deps.waitScale,
    );
    const result = await runWidgetOp(deps.backend, prepared, {
      op: "set",
      target: { field: key },
      value: field.value,
      timeoutMs: budget,
      mountMs:
        optional && dependsOn.length === 0
          ? Math.min(budget, scaled(OPTIONAL_PRESENCE_MS, deps.waitScale))
          : budget,
      readBackMs: scaled(READ_BACK_MS, deps.waitScale),
      verify,
      ...(optional ? { optional: true } : {}),
      ...(isFormFieldObject(raw) && raw.driver ? { driver: raw.driver } : {}),
    });
    const entry = evidenceFor(key, result, isSensitiveName(key));
    fields.push(entry);
    byKey.set(key, entry);
    await emit(entry);
    if (entry.status === "failed") {
      error = `form ${failureMessage(key, entry)}`;
      break;
    }
    if (entry.status !== "skipped") {
      written.push({
        key,
        value: field.value,
        ...(result.driver ? { driver: result.driver } : {}),
        ...(result.label !== undefined ? { label: result.label } : {}),
      });
    }
  }

  // A later field can re-render (and wipe) an earlier one: re-read them all.
  if (error === undefined && verify && written.length > 0) {
    const reread = await runWidgetOp(deps.backend, prepared, {
      op: "readMany",
      timeoutMs: scaled(5_000, deps.waitScale),
      targets: written.map((w) => ({
        target: { field: w.key },
        value: w.value,
        ...(w.label !== undefined ? { label: w.label } : {}),
        ...(w.driver ? { driver: w.driver } : {}),
      })),
    });
    if (!reread.ok) {
      error = `form verify: ${reread.error ?? "re-read failed"}`;
    } else {
      const results = reread.results ?? [];
      written.forEach((w, i) => {
        const r = results[i];
        const entry = byKey.get(w.key);
        if (!entry || !r) return;
        const masked =
          isSensitiveName(w.key) ||
          r.sensitive === true ||
          entry.expected === MASK;
        entry.final = {
          status: r.status,
          ...(r.actual !== undefined
            ? { actual: masked ? MASK : boundValue(r.actual, 16 * 1024).value }
            : {}),
          ...(r.matches !== undefined ? { matches: r.matches } : {}),
        };
        if (error !== undefined) return;
        if (!r.ok) {
          error = `form field ${JSON.stringify(w.key)}: ${r.error ?? "re-read failed"}`;
        } else if (r.status === "absent") {
          error = `form field ${JSON.stringify(w.key)} disappeared after later fields were set`;
        } else if (r.matches === false) {
          error = `form field ${JSON.stringify(w.key)} lost its value after later fields were set (shows ${
            masked ? MASK : JSON.stringify(r.actual)
          })`;
        }
      });
    }
  }

  let unanswered: { total?: number; fields: unknown[] } | undefined;
  const wantsDump =
    form.onFailure === "dumpUnanswered" ||
    (typeof form.onFailure === "object" &&
      form.onFailure.dumpUnanswered === true);
  if (error !== undefined && wantsDump) {
    const dump = await runWidgetOp(deps.backend, prepared, {
      op: "dump",
      timeoutMs: scaled(5_000, deps.waitScale),
      limit: 50,
    });
    unanswered = dump.ok
      ? {
          ...(dump.total !== undefined ? { total: dump.total } : {}),
          fields: dump.unanswered ?? [],
        }
      : { fields: [], ...(dump.error ? { error: dump.error } : {}) };
  }
  return {
    outcome:
      error !== undefined ? { status: "failed", error } : { status: "passed" },
    ...(unanswered ? { unanswered } : {}),
  };
}

/* ----- click / fill flags ----- */

export interface FlaggedOutcome {
  status: "passed" | "failed" | "skipped";
  error?: string;
  via?: string;
  detail?: string;
  skipReason?: string;
  /** The pointer path's backend result, when one ran. */
  invocation?: InvocationResult;
}

/** True when a click / fill carries a flag the runner (not the backend) owns. */
export function needsInteractionRuntime(step: Step): boolean {
  if ("click" in step) {
    return (
      step.click.optional === true ||
      step.click.dispatch === true ||
      step.click.fallback !== undefined
    );
  }
  if ("fill" in step) {
    return step.fill.mode === "set" || step.fill.optional === true;
  }
  return false;
}

/** The step a backend receives: runner-owned flags removed. */
export function withoutInteractionFlags(step: Step): Step {
  if ("click" in step) {
    const until = step.click.until;
    return {
      ...step,
      click: {
        ...clickLocator(step),
        ...(until ? { until } : {}),
      } as ClickStep["click"],
    };
  }
  if ("fill" in step) return withoutFillFlags(step);
  return step;
}

function firstLine(text: string): string {
  return (text.split("\n").find((line) => line.trim()) ?? text)
    .trim()
    .slice(0, 300);
}

/**
 * Run a click / fill that carries runner-owned flags. `browserStep` runs the
 * plain (flag-free) step through the usual resilient backend path.
 */
export async function runFlaggedInteraction(
  step: ClickStep | FillStep,
  deps: WidgetDeps & {
    browserStep: (step: Step) => Promise<InvocationResult>;
  },
): Promise<FlaggedOutcome> {
  let prepared: PreparedWidgets;
  try {
    prepared = await deps.widgets();
  } catch (e) {
    return { status: "failed", error: `widgets: ${(e as Error).message}` };
  }
  const op = (
    input: Omit<WidgetOpInput, "timeoutMs"> & { timeoutMs?: number },
  ) =>
    runWidgetOp(deps.backend, prepared, {
      timeoutMs: scaled(DEFAULT_WIDGET_TIMEOUT_MS, deps.waitScale),
      ...input,
    });
  const plain = withoutInteractionFlags(step);

  if ("fill" in step) {
    const locator: Locator = fillLocator(step);
    const optional = step.fill.optional === true;
    if (step.fill.mode === "set") {
      const r = await op({
        op: "fill",
        target: { locator },
        value: step.fill.value,
        mountMs: optional
          ? scaled(OPTIONAL_PRESENCE_MS, deps.waitScale)
          : scaled(CLICK_MOUNT_MS, deps.waitScale),
        verify: step.verifyFill !== false,
        settleMs: scaled(500, deps.waitScale),
        attempts: 4,
        ...(optional ? { optional: true } : {}),
      });
      if (r.ok && r.status === "skipped") {
        return { status: "skipped", skipReason: r.reason ?? "absent" };
      }
      return r.ok
        ? { status: "passed", via: "set" }
        : {
            status: "failed",
            via: "set",
            error: `fill (mode: set): ${r.error ?? "failed"}`,
          };
    }
    // fill.optional with the regular fill: the same presence window as an
    // optional widget field (a control that mounts a moment late still runs).
    const probe = await op({
      op: "probe",
      target: { locator },
      mountMs: scaled(OPTIONAL_PRESENCE_MS, deps.waitScale),
      optional: true,
      timeoutMs: scaled(2_000, deps.waitScale),
    });
    if (probe.ok && probe.status === "skipped") {
      return { status: "skipped", skipReason: probe.reason ?? "absent" };
    }
    return fromInvocation(await deps.browserStep(plain));
  }

  const locator = clickLocator(step);
  const optional = step.click.optional === true;
  if (optional) {
    // Presence is decided in the page by the shared locator resolver (open
    // shadow roots and image-alt names included; closed shadow roots and
    // iframes are not seen), with the optional-field presence window.
    const probe = await op({
      op: "probe",
      target: { locator },
      mountMs: scaled(OPTIONAL_PRESENCE_MS, deps.waitScale),
      optional: true,
      timeoutMs: scaled(2_000, deps.waitScale),
    });
    if (probe.ok && probe.status === "skipped") {
      return { status: "skipped", skipReason: probe.reason ?? "absent" };
    }
  }
  const mountMs = scaled(CLICK_MOUNT_MS, deps.waitScale);
  const dispatch = async (detail?: string): Promise<FlaggedOutcome> => {
    const r = await op({
      op: "click",
      mode: "dispatch",
      target: { locator },
      mountMs,
      ...(optional ? { optional: true } : {}),
    });
    if (r.ok && r.status === "skipped") {
      return { status: "skipped", skipReason: r.reason ?? "absent" };
    }
    const why =
      detail ?? (r.blockedBy ? `pointer would hit ${r.blockedBy}` : undefined);
    return r.ok
      ? { status: "passed", via: "dispatch", ...(why ? { detail: why } : {}) }
      : {
          status: "failed",
          via: "dispatch",
          error: `click (dispatch): ${r.error ?? "failed"}`,
          ...(why ? { detail: why } : {}),
        };
  };

  if (step.click.dispatch === true) return dispatch();

  if (step.click.fallback === "dispatch") {
    const hit = await op({
      op: "click",
      mode: "hit",
      target: { locator },
      mountMs,
    });
    if (hit.ok && hit.blockedBy) {
      return dispatch(`pointer blocked by ${hit.blockedBy}`);
    }
    const pointer = await deps.browserStep(plain);
    if (pointer.ok) {
      return { ...fromInvocation(pointer), via: "pointer" };
    }
    return dispatch(
      `pointer click failed: ${firstLine(pointer.stderr || `exit ${pointer.exitCode}`)}`,
    );
  }

  // optional only: the regular click; a target that vanished meanwhile skips.
  const r = await deps.browserStep(plain);
  if (!r.ok && optional) {
    const again = await op({
      op: "probe",
      target: { locator },
      mountMs: 0,
      optional: true,
      timeoutMs: scaled(2_000, deps.waitScale),
    });
    if (again.ok && again.status === "skipped") {
      return { status: "skipped", skipReason: "absent", invocation: r };
    }
  }
  return fromInvocation(r);
}

function fromInvocation(r: InvocationResult): FlaggedOutcome {
  return r.ok
    ? { status: "passed", invocation: r }
    : {
        status: "failed",
        error: r.stderr.trim() || `exit ${r.exitCode}`,
        invocation: r,
      };
}
