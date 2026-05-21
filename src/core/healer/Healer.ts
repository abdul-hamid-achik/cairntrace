import { readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parse as parseYaml, parseDocument } from "yaml";
import type { BrowserBackend } from "../../adapters/browserBackend";
import { runSpec } from "../runner/Runner";
import type { PatchOp } from "../schema/heal.v1";
import type { ExitCode } from "../schema/shared";
import { SpecSchema, type Step } from "../schema/spec.v1";
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
 * v0 heal — diagnose UI drift on a single `find role <X> --name <Y>` step.
 *
 * Algorithm:
 *   1. Run the spec.
 *   2. Find the first failed step. If none, the spec already passes — nothing to heal.
 *   3. Read the snapshot captured at that step (post-attempt page state).
 *   4. If the failed step uses a role+name locator, look for elements with the
 *      same role in the snapshot. If exactly one has a different name, propose
 *      a `replace /steps/<N>/click/name` (or fill/upload) op.
 *   5. With `--apply`, rewrite the YAML in place via the yaml lib's parseDocument
 *      API so comments and formatting are preserved.
 *
 * Not yet handled: imports/`use:` step expansion, multi-step drift, role swaps,
 * wait insertion. Add as we observe real drift patterns.
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

  // Re-parse the on-disk YAML for source-level patching (preserves original
  // structure better than re-serializing the validated object).
  const yamlText = await readFile(opts.specPath, "utf8");
  const yamlObj = parseYaml(yamlText) as unknown;
  const spec = SpecSchema.parse(yamlObj);
  const step = spec.steps?.[failedStepIdx];
  if (!step) {
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "no-heal-possible",
      outcomesStillReachable: false,
      ops: [],
      summary: `step index ${failedStepIdx} not found in spec — heal cannot rewrite imports/use:`,
      exitCode: 5,
    };
  }

  // Read the snapshot agent-browser took at the failing step (post-attempt page).
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

  // Propose ops based on what kind of locator the failed step uses.
  const ops = proposeOps(step, failedStepIdx, snapshot);

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
    // parseDocument preserves comments + formatting; setIn mutates in place.
    const doc = parseDocument(yamlText);
    for (const op of ops) {
      const path = jsonPointerToPath(op.path);
      if (op.op === "replace") {
        doc.setIn(path, (op as { to: unknown }).to);
      } else if (op.op === "remove") {
        doc.deleteIn(path);
      } else if (op.op === "insert") {
        doc.addIn(path, (op as { value: unknown }).value);
      }
    }
    await writeFile(opts.specPath, String(doc));
    return {
      specPath: specPathAbs,
      basedOnRunId: result.runId,
      status: "patch-applied",
      outcomesStillReachable: true,
      ops,
      appliedPath: specPathAbs,
      summary: `applied ${ops.length} op(s); re-run the spec to confirm`,
      exitCode: 0,
    };
  }

  return {
    specPath: specPathAbs,
    basedOnRunId: result.runId,
    status: "patch-proposed",
    outcomesStillReachable: true,
    ops,
    summary: `proposed ${ops.length} op(s); pass --apply to write them to the file`,
    exitCode: 0,
  };
}

/* ----- core proposal logic ----- */

export function proposeOps(
  step: Step,
  stepIdx: number,
  snapshot: SnapshotElement[],
): PatchOp[] {
  // Currently handles click / fill / upload with `by: role` locators.
  const locatorOps: PatchOp[] = [];

  const tryLocator = (
    key: "click" | "fill" | "upload",
    locator: { by: string; role?: string; name?: string },
  ): PatchOp | undefined => {
    if (locator.by !== "role" || !locator.role || locator.name === undefined) {
      return undefined;
    }
    const candidates = findByRole(snapshot, locator.role).filter(
      (e) => e.name !== undefined,
    );
    if (candidates.length === 0) return undefined;

    const exactMatch = candidates.find((c) => c.name === locator.name);
    if (exactMatch) return undefined; // not a name drift — locator should have worked

    // Heuristic: if exactly one candidate exists, propose that name.
    // If multiple, find the closest by simple string distance.
    const best =
      candidates.length === 1
        ? candidates[0]!
        : candidates.toSorted(
            (a, b) =>
              stringDistance(a.name!, locator.name!) -
              stringDistance(b.name!, locator.name!),
          )[0]!;

    return {
      op: "replace",
      path: `/steps/${stepIdx}/${key}/name`,
      from: locator.name,
      to: best.name!,
      reason: `snapshot shows role=${locator.role} with name="${best.name}" (${candidates.length} candidate${
        candidates.length === 1 ? "" : "s"
      })`,
    };
  };

  if ("click" in step) {
    const op = tryLocator("click", step.click);
    if (op) locatorOps.push(op);
  } else if ("fill" in step) {
    const op = tryLocator("fill", step.fill);
    if (op) locatorOps.push(op);
  } else if ("upload" in step) {
    const op = tryLocator("upload", step.upload);
    if (op) locatorOps.push(op);
  }

  return locatorOps;
}

/* ----- helpers ----- */

/** Convert a JSON Pointer (`/steps/1/click/name`) to the path form yaml's Document expects. */
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
