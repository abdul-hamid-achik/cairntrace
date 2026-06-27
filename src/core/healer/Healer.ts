import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { isSeq, parseDocument } from "yaml";
import type { BrowserBackend } from "../../adapters/browserBackend";
import { parseSpec } from "../parser/parseSpec";
import { runSpec } from "../runner/Runner";
import type { PatchOp } from "../schema/heal.v1";
import type { ExitCode } from "../schema/shared";
import type { Step } from "../schema/spec.v1";
import {
  findByRole,
  parseSnapshot,
  type SnapshotElement,
} from "./snapshotParser";

export interface HealOptions {
  specPath: string;
  backend: BrowserBackend;
  artifactRoot?: string;
  /** Write the patched spec back to disk. */
  apply?: boolean;
}

export interface HealOutput {
  specPath: string;
  basedOnRunId: string;
  status: "patch-proposed" | "patch-applied" | "no-heal-possible";
  outcomesStillReachable: boolean;
  ops: PatchOp[];
  /** Present when --apply succeeded. */
  appliedPath?: string;
  /** Human-readable explanation of what changed (or didn't). */
  summary: string;
  exitCode: ExitCode;
}

/**
 * v0.4 heal — diagnose UI drift on a single locator-bearing step.
 *
 * Algorithm:
 *   1. Run the spec.
 *   2. Find the first failed step. If none, the spec already passes — nothing to heal.
 *   3. Read the snapshot captured at that step (post-attempt page state).
 *   4. proposeOps tries, in order:
 *        a. Name-drift heal — `by: role | label | text` → propose name/text replacement
 *           against the closest snapshot candidate.
 *        b. Wait-insertion — when no candidate exists and the previous step
 *           isn't already a wait, insert a `wait: { text: <name>, timeoutMs: 5000 }`
 *           step before the failed one.
 *   5. With `--apply`, rewrite the YAML in place via the yaml lib's parseDocument
 *      API so comments and formatting are preserved.
 *
 * Not yet handled: imports/`use:` step expansion, multi-step drift, role swaps,
 * heal across multiple failing steps in one pass. Add as we observe real
 * drift patterns.
 */
export async function healSpec(opts: HealOptions): Promise<HealOutput> {
  const specPathAbs = isAbsolute(opts.specPath)
    ? opts.specPath
    : resolve(process.cwd(), opts.specPath);

  // Run the spec; the Runner already writes a full run dir we can read.
  const result = await runSpec({
    specPath: opts.specPath,
    backend: opts.backend,
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
  });

  if (result.status === "passed") {
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "no-heal-possible",
      outcomesStillReachable: true,
      ops: [],
      summary: "spec already passes — nothing to heal",
      exitCode: 0,
    };
  }

  const failedStepIdx = result.steps.findIndex((s) => s.status === "failed");
  if (failedStepIdx < 0) {
    // Outcome failure but no step failure → not a drift; this is a real regression.
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "no-heal-possible",
      outcomesStillReachable: false,
      ops: [],
      summary:
        "all steps passed but outcomes failed — this is a behavior regression, not selector drift",
      exitCode: 5,
    };
  }

  // Re-parse the spec with origins so we can map the resolved-step index back
  // to the file that owns it (main spec OR an imported action file).
  const parsed = await parseSpec(opts.specPath);
  const origin = parsed.origins[failedStepIdx];
  if (!origin) {
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "no-heal-possible",
      outcomesStillReachable: false,
      ops: [],
      summary: `step index ${failedStepIdx} not in the resolved step list — spec may have changed since this run`,
      exitCode: 5,
    };
  }

  // eval steps are an escape hatch — they run arbitrary page-context JS and
  // have no locator to repair. Skip healing with a clear message.
  if ("eval" in origin.step) {
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "no-heal-possible",
      outcomesStillReachable: false,
      ops: [],
      summary:
        "eval steps are not healable — they are an escape hatch running arbitrary page-context JS with no locator to repair. Fix the eval source or the page under test.",
      exitCode: 5,
    };
  }

  // Read the snapshot the backend took at the failing step (post-attempt page).
  const failedStepResult = result.steps[failedStepIdx]!;
  const stepIdForFile = failedStepResult.id;
  const snapshotPath = join(
    result.runDir,
    "snapshots",
    `${pad(failedStepIdx + 1)}_${stepIdForFile}.txt`,
  );
  let snapshotText: string;
  try {
    snapshotText = await readFile(snapshotPath, "utf8");
  } catch {
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "no-heal-possible",
      outcomesStillReachable: false,
      ops: [],
      summary: `snapshot file ${snapshotPath} not found — cannot infer drift`,
      exitCode: 5,
    };
  }
  const snapshot = parseSnapshot(snapshotText);

  // Determine the "owning file" steps array — main spec or an imported action.
  // Wait-insertion needs this so the inserted step lands in the right file.
  const ownerSteps = stepsForFile(parsed, origin.filePath);

  const ops = proposeOps(origin.step, origin.fileStepIdx, snapshot, {
    allSteps: ownerSteps,
  });

  if (ops.length === 0) {
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "no-heal-possible",
      outcomesStillReachable: false,
      ops: [],
      summary:
        "no healing candidates found in the snapshot — the role may not exist on the page, or there are too many matches to disambiguate",
      exitCode: 5,
    };
  }

  if (opts.apply) {
    // applyPatchOps preserves comments + formatting on the OWNING file
    // (which may be an imported action, not the main spec).
    const ownerText = await readFile(origin.filePath, "utf8");
    await writeFile(origin.filePath, applyPatchOps(ownerText, ops));
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "patch-applied",
      outcomesStillReachable: true,
      ops,
      appliedPath: origin.filePath,
      summary: `applied ${ops.length} op(s) to ${origin.filePath}; re-run the spec to confirm`,
      exitCode: 0,
    };
  }

  return {
    specPath: specPathAbs,
    basedOnRunId: result.runId,
    status: "patch-proposed",
    outcomesStillReachable: true,
    ops,
    summary: `proposed ${ops.length} op(s) on ${origin.filePath}; pass --apply to write`,
    exitCode: 0,
  };
}

/** Steps array of the file that owns the failed step (main spec or action). */
function stepsForFile(
  parsed: Awaited<ReturnType<typeof parseSpec>>,
  filePath: string,
): Step[] {
  if (filePath === parsed.path) return parsed.spec.steps ?? [];
  for (const loaded of parsed.actionsByName.values()) {
    if (loaded.path === filePath) return loaded.action.steps;
  }
  return [];
}

/* ----- core proposal logic ----- */

export interface ProposeOpsContext {
  /** The full step list, used by wait-insertion heuristic to detect existing waits. */
  allSteps?: Step[];
}

export function proposeOps(
  step: Step,
  stepIdx: number,
  snapshot: SnapshotElement[],
  ctx: ProposeOpsContext = {},
): PatchOp[] {
  /* 1) Name-drift heal — covers `by: role`, `by: label`, `by: text`. */
  const locatorOp = tryLocatorDrift(step, stepIdx, snapshot);
  if (locatorOp) return [locatorOp];

  /* 2) Wait-insertion heal — runs when no name candidate is found but the
        step has a healable locator and there isn't already a wait right
        before it. Inserts a `wait: { text: <locator-name> }` step. */
  const waitOp = tryWaitInsertion(step, stepIdx, ctx.allSteps);
  if (waitOp) return [waitOp];

  return [];
}

function tryLocatorDrift(
  step: Step,
  stepIdx: number,
  snapshot: SnapshotElement[],
): PatchOp | undefined {
  // Find which locator key is on this step, and what kind of locator
  // (role/label/text/selector).
  const target = extractLocatorTarget(step);
  if (!target) return undefined;
  const { key, locator } = target;

  const candidates = candidatesForLocator(locator, snapshot);
  if (candidates.length === 0) return undefined;

  // The drifted "field" is the name for role/label, the text for text-locator.
  const current = locator.by === "text" ? locator.text : locator.name;
  if (current === undefined) return undefined;

  const exactMatch = candidates.find((c) => (c.name ?? "") === current);
  if (exactMatch) return undefined;

  const best =
    candidates.length === 1
      ? candidates[0]!
      : candidates.toSorted(
          (a, b) =>
            stringDistance(a.name ?? "", current) -
            stringDistance(b.name ?? "", current),
        )[0]!;

  const driftedField = locator.by === "text" ? "text" : "name";
  const newValue = best.name ?? "";

  return {
    op: "replace",
    path: `/steps/${stepIdx}/${key}/${driftedField}`,
    from: current,
    to: newValue,
    reason: describeLocatorMatch(
      locator,
      best.role,
      newValue,
      candidates.length,
    ),
  };
}

function tryWaitInsertion(
  step: Step,
  stepIdx: number,
  allSteps: Step[] | undefined,
): PatchOp | undefined {
  // Wait insertion is opt-in: only fires when the caller supplies allSteps
  // (i.e., a real healSpec invocation). Unit tests that pass `proposeOps`
  // bare locator drift cases shouldn't get spurious wait inserts.
  if (!allSteps) return undefined;

  const target = extractLocatorTarget(step);
  if (!target) return undefined;
  const { locator } = target;
  const lookFor = locator.by === "text" ? locator.text : locator.name;
  if (!lookFor) return undefined;

  // If the previous step is already a wait, skip — repeating won't help.
  const prev = allSteps[stepIdx - 1];
  if (prev && "wait" in prev) return undefined;

  return {
    op: "insert",
    path: `/steps/${stepIdx}`,
    value: {
      id: `wait_for_${slugify(lookFor)}`,
      wait: { text: lookFor, timeoutMs: 5000 },
    },
    reason: `no name candidate matched — insert a wait for "${lookFor}" in case the element appears after async`,
  };
}

interface LocatorTarget {
  key: "click" | "hover" | "fill" | "upload" | "download";
  locator: {
    by: string;
    role?: string;
    name?: string;
    text?: string;
    selector?: string;
  };
}

function extractLocatorTarget(step: Step): LocatorTarget | undefined {
  if ("click" in step) return { key: "click", locator: step.click };
  if ("hover" in step) return { key: "hover", locator: step.hover };
  if ("fill" in step) return { key: "fill", locator: step.fill };
  if ("upload" in step) return { key: "upload", locator: step.upload };
  if ("download" in step) {
    const {
      saveAs: _saveAs,
      assign: _assign,
      timeoutMs: _timeoutMs,
      ...locator
    } = step.download;
    return { key: "download", locator };
  }
  return undefined;
}

/**
 * Return snapshot elements that could plausibly be the target of this locator.
 * - role+name: matching role only
 * - label+name: any element with a name (labels in agent-browser snapshots
 *   surface as the accessible name on form controls)
 * - text:      any element with a name (text-locators bind to the accessible name)
 * - selector:  unsupported in v0 (no good heuristic without a CSS engine)
 */
function candidatesForLocator(
  locator: LocatorTarget["locator"],
  snapshot: SnapshotElement[],
): SnapshotElement[] {
  if (locator.by === "role" && locator.role) {
    return findByRole(snapshot, locator.role).filter(
      (e) => e.name !== undefined,
    );
  }
  if (locator.by === "label" || locator.by === "text") {
    return snapshot.filter((e) => e.name !== undefined && e.name.length > 0);
  }
  return [];
}

function describeLocatorMatch(
  locator: LocatorTarget["locator"],
  matchRole: string,
  newValue: string,
  candidateCount: number,
): string {
  const noun = candidateCount === 1 ? "candidate" : "candidates";
  if (locator.by === "role") {
    return `snapshot shows role=${locator.role} with name="${newValue}" (${candidateCount} ${noun})`;
  }
  if (locator.by === "label") {
    return `snapshot shows ${matchRole} labeled "${newValue}" (${candidateCount} ${noun})`;
  }
  return `snapshot shows ${matchRole} with text "${newValue}" (${candidateCount} ${noun})`;
}

function slugify(s: string): string {
  return (
    s
      .toLowerCase()
      .replaceAll(/[^a-z0-9]+/g, "_")
      .replaceAll(/^_|_$/g, "") || "el"
  );
}

/* ----- helpers ----- */

/** Convert a JSON Pointer (`/steps/1/click/name`) to the path form yaml's Document expects. */
/**
 * Apply heal patch ops to a YAML source string via the Document API, preserving
 * comments / quoting / key order on untouched nodes. Returns the new source.
 * Exported for testing the apply path directly.
 */
export function applyPatchOps(ownerText: string, ops: PatchOp[]): string {
  const doc = parseDocument(ownerText);
  for (const op of ops) {
    const path = jsonPointerToPath(op.path);
    if (op.op === "replace") {
      doc.setIn(path, (op as { to: unknown }).to);
    } else if (op.op === "remove") {
      doc.deleteIn(path);
    } else if (op.op === "insert") {
      // Splice a NEW sibling seq item at the index. addIn(["steps", N], …)
      // would instead resolve steps[N] and merge the value INTO it as a complex
      // mapping key — corrupting that step and making the file unparseable.
      const idx = path[path.length - 1];
      const seq = doc.getIn(path.slice(0, -1));
      const value = (op as { value: unknown }).value;
      if (isSeq(seq) && typeof idx === "number") {
        seq.items.splice(idx, 0, doc.createNode(value));
      } else {
        doc.addIn(path, value);
      }
    }
  }
  return String(doc);
}

function jsonPointerToPath(p: string): (string | number)[] {
  return (
    p
      .split("/")
      .slice(1) // discard leading ""
      .map((seg) => (/^\d+$/.test(seg) ? Number(seg) : seg))
  );
}

function pad(n: number): string {
  return n.toString().padStart(3, "0");
}

/**
 * Cheap distance for picking the closest candidate name.
 * Substring containment dominates — `"Apply"` should match `"Apply coupon"`
 * before `"Cancel"` even though length-diff alone says otherwise.
 */
function stringDistance(a: string, b: string): number {
  const al = a.toLowerCase();
  const bl = b.toLowerCase();
  // Strong signal: one is a substring of the other (e.g. label was extended/shortened).
  if (bl.includes(al) || al.includes(bl)) {
    return Math.abs(al.length - bl.length) * 0.1;
  }
  // Otherwise: positional char mismatch + length diff.
  const lenDiff = Math.abs(al.length - bl.length);
  let mismatches = 0;
  const min = Math.min(al.length, bl.length);
  for (let i = 0; i < min; i++) {
    if (al[i] !== bl[i]) mismatches++;
  }
  return lenDiff + mismatches;
}
