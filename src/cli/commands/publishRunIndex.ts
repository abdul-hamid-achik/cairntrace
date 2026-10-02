import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { inferArtifactSensitivity } from "../../core/artifacts/evidenceSelection";
import {
  ArtifactManifestSchema,
  type ArtifactManifestEntry,
  type ArtifactSensitivity,
} from "../../core/schema/run.v1";
import { CAIRN_VERSION } from "../version";

/**
 * Metadata-only `RunIndexV1` sidecar (`fcheap publish --run-index`): what
 * the private file.cheap console lists for a published run without opening
 * the archive. Contract: file.cheap `platform/src/features/runs/
 * index-contract.ts` — at most 12 KiB, 200 evidence entries and 100
 * outcomes, unknown keys rejected. It never contains logs, intent, summaries,
 * failure messages, URLs or secret values: only ids, statuses, timestamps,
 * counts and an inventory summarized by evidence role.
 */

export const RUN_INDEX_MAX_BYTES = 12 * 1024;
const MAX_EVIDENCE = 200;
const MAX_OUTCOMES = 100;
const MAX_COUNT = 100_000;
const SAFE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;
const SAFE_PATH_RE = /^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/;
const ROLE_RE = /^[a-z][a-z0-9-]*$/;
/** Members listed one by one; everything else is summarized per directory. */
const KEY_ROLES = new Set([
  "run",
  "report",
  "agent-context",
  "event-log",
  "run-log",
  "resolved-spec",
  "replay",
  "trace",
  "video",
]);

type Presence = "present" | "empty" | "missing";
type Integrity = "verified" | "declared" | "changed" | "unknown";
type Medium =
  | "structured-text"
  | "text"
  | "image"
  | "video"
  | "archive"
  | "binary"
  | "unknown";
type IndexSensitivity =
  | "metadata-safe"
  | "redacted"
  | "potentially-sensitive"
  | "secret-bearing"
  | "unknown";

interface IndexedEvidence {
  declaredBytes?: number;
  inspectability: "metadata-only";
  integrity: Integrity;
  medium: Medium;
  path: string;
  presence: "declared" | Presence | "partial" | "unknown";
  role: string;
  sensitivity: IndexSensitivity;
}

export interface RunIndexV1 {
  $schema: "urn:filecheap.dev:run-index:v1";
  counts: { artifacts: number; outcomes: number; steps: number };
  detector: { name: "cairntrace-run"; version: string };
  evidence: IndexedEvidence[];
  health: {
    changed: number;
    declared: number;
    empty: number;
    missing: number;
    present: number;
    reasons: string[];
    state: "ok" | "degraded" | "incomplete" | "unknown";
  };
  outcomes: Array<{ id: string; status: string }>;
  run: Record<string, string | number>;
  version: 1;
}

interface MemberState {
  entry: ArtifactManifestEntry;
  presence: Presence;
  integrity: Integrity;
}

/**
 * Build the index for `runDir` as published: `included` lists the
 * run-relative files inside the archive (excluded members are left out of
 * the inventory and its health — they are reported by the publish receipt).
 */
export async function buildRunIndex(
  runDir: string,
  runId: string,
  included: readonly string[],
): Promise<RunIndexV1> {
  const run = await readJsonObject(join(runDir, "run.json"));
  const manifest = await readJsonObject(
    join(runDir, "artifact-manifest.json"),
  ).then((raw) => {
    const parsed = ArtifactManifestSchema.safeParse(raw);
    return parsed.success ? parsed.data : undefined;
  });
  const keep = new Set(included);
  const members: MemberState[] = [];
  for (const entry of manifest?.artifacts ?? []) {
    if (!keep.has(entry.path)) continue;
    members.push(await memberState(runDir, entry));
  }

  const outcomes = arrayOf(run?.outcomes)
    .map((outcome) => ({
      id: stringOf(outcome?.id),
      status: outcomeStatus(stringOf(outcome?.status)),
    }))
    .filter(
      (outcome): outcome is { id: string; status: string } =>
        outcome.id !== undefined &&
        outcome.id.length <= 160 &&
        SAFE_ID_RE.test(outcome.id),
    );
  const uniqueOutcomes = [
    ...new Map(outcomes.map((outcome) => [outcome.id, outcome])).values(),
  ].slice(0, MAX_OUTCOMES);

  const index: RunIndexV1 = {
    $schema: "urn:filecheap.dev:run-index:v1",
    counts: {
      artifacts: clampCount(Math.max(members.length, keep.size)),
      outcomes: clampCount(
        Math.max(arrayOf(run?.outcomes).length, uniqueOutcomes.length),
      ),
      steps: clampCount(arrayOf(run?.steps).length),
    },
    detector: { name: "cairntrace-run", version: detectorVersion() },
    evidence: [],
    health: health(run, manifest !== undefined, members),
    outcomes: uniqueOutcomes,
    run: runSummary(runId, run),
    version: 1,
  };
  index.evidence = fitEvidence(index, summarizeEvidence(members));
  index.outcomes = fitOutcomes(index);
  return index;
}

async function memberState(
  runDir: string,
  entry: ArtifactManifestEntry,
): Promise<MemberState> {
  const absolute = join(runDir, entry.path);
  const info = await stat(absolute).catch(() => undefined);
  if (!info?.isFile()) {
    return { entry, presence: "missing", integrity: "unknown" };
  }
  if (info.size === 0)
    return { entry, presence: "empty", integrity: "unknown" };
  // events.ndjson is append-only: post-run events (stash, retention) grow it
  // after the manifest checksummed it. That is expected, not drift.
  if (entry.kind === "event-log" && info.size >= entry.bytes) {
    return {
      entry,
      presence: "present",
      integrity: info.size === entry.bytes ? "verified" : "declared",
    };
  }
  if (info.size !== entry.bytes) {
    return { entry, presence: "present", integrity: "changed" };
  }
  const sha256 = await hashFile(absolute);
  return {
    entry,
    presence: "present",
    integrity: sha256 === entry.sha256 ? "verified" : "changed",
  };
}

function health(
  run: Record<string, unknown> | undefined,
  hasManifest: boolean,
  members: readonly MemberState[],
): RunIndexV1["health"] {
  const count = (fn: (member: MemberState) => boolean): number =>
    clampCount(members.filter(fn).length);
  const missing = count((m) => m.presence === "missing");
  const empty = count((m) => m.presence === "empty");
  const changed = count((m) => m.integrity === "changed");
  const present = count((m) => m.presence === "present");
  const reasons: string[] = [];
  if (!hasManifest) reasons.push("manifest-unavailable");
  const requiredMissing = members.some(
    (m) =>
      m.presence === "missing" &&
      (m.entry.path === "run.json" || m.entry.path === "agent_context.md"),
  );
  if (requiredMissing) reasons.push("required-member-missing");
  if (missing > 0 && !requiredMissing) reasons.push("declared-member-missing");
  if (empty > 0) reasons.push("empty-capture");
  if (members.some((m) => m.integrity === "changed")) {
    reasons.push("hash-mismatch");
  }
  const incomplete = typeof run?.status !== "string";
  if (incomplete) reasons.push("incomplete-run");
  return {
    changed,
    declared: clampCount(members.length),
    empty,
    missing,
    present,
    reasons,
    state: !hasManifest
      ? "unknown"
      : incomplete
        ? "incomplete"
        : reasons.length > 0
          ? "degraded"
          : "ok",
  };
}

function runSummary(
  runId: string,
  run: Record<string, unknown> | undefined,
): RunIndexV1["run"] {
  const spec = (run?.spec ?? {}) as Record<string, unknown>;
  const specName = bounded(stringOf(spec.name), 240);
  const environment = bounded(stringOf(run?.environment), 80);
  const backend = bounded(stringOf(run?.backend), 80);
  const startedAt = isoOf(run?.startedAt);
  const endedAtRaw = isoOf(run?.endedAt);
  const endedAt =
    startedAt && endedAtRaw && Date.parse(endedAtRaw) < Date.parse(startedAt)
      ? undefined
      : endedAtRaw;
  const durationMs =
    typeof run?.durationMs === "number" &&
    Number.isInteger(run.durationMs) &&
    run.durationMs >= 0 &&
    run.durationMs <= 30 * 24 * 60 * 60 * 1000
      ? run.durationMs
      : undefined;
  const exitCode =
    typeof run?.exitCode === "number" &&
    Number.isInteger(run.exitCode) &&
    Math.abs(run.exitCode) <= 255
      ? run.exitCode
      : undefined;
  const failure = (run?.failure ?? {}) as Record<string, unknown>;
  const errorKind = stringOf(failure.phase);
  return {
    nativeId: runId,
    seriesKey: seriesKey(specName ?? runId, environment ?? ""),
    status: runStatus(stringOf(run?.status)),
    ...(specName ? { specName } : {}),
    ...(environment ? { environment } : {}),
    ...(backend ? { backend } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(endedAt ? { endedAt } : {}),
    ...(durationMs !== undefined ? { durationMs } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
    ...(errorKind && errorKind.length <= 160 && SAFE_ID_RE.test(errorKind)
      ? { errorKind }
      : {}),
  };
}

/** Stable per spec + environment, so the console can chart a series. */
function seriesKey(specName: string, environment: string): string {
  return `ct_${createHash("sha256")
    .update(`cairntrace\u0000${specName}\u0000${environment}`)
    .digest("hex")
    .slice(0, 40)}`;
}

function runStatus(status: string | undefined): string {
  switch (status) {
    case "passed":
    case "failed":
    case "errored":
      return status;
    case "refused":
      return "cancelled";
    default:
      return status === undefined ? "incomplete" : "unknown";
  }
}

function outcomeStatus(status: string | undefined): string {
  return status === "passed" || status === "failed" || status === "skipped"
    ? status
    : status === "errored"
      ? "errored"
      : "unknown";
}

/**
 * Key members one by one; everything else one entry per (directory, role)
 * with summed bytes and the worst presence/integrity/sensitivity.
 */
function summarizeEvidence(members: readonly MemberState[]): IndexedEvidence[] {
  const single: IndexedEvidence[] = [];
  const groups = new Map<string, MemberState[]>();
  for (const member of members) {
    const role = roleOf(member.entry.kind);
    if (KEY_ROLES.has(role) && SAFE_PATH_RE.test(member.entry.path)) {
      single.push(evidenceOf(member.entry.path, role, [member]));
      continue;
    }
    const slash = member.entry.path.lastIndexOf("/");
    const dir = slash > 0 ? member.entry.path.slice(0, slash) : "";
    const key = `${dir}\u0000${role}`;
    const group = groups.get(key) ?? [];
    group.push(member);
    groups.set(key, group);
  }
  const grouped: IndexedEvidence[] = [];
  for (const [key, group] of groups) {
    const [dir, role] = key.split("\u0000") as [string, string];
    const path =
      group.length === 1 && SAFE_PATH_RE.test(group[0]!.entry.path)
        ? group[0]!.entry.path
        : dir && SAFE_PATH_RE.test(dir)
          ? dir
          : undefined;
    if (!path) continue;
    grouped.push(evidenceOf(path, role, group));
  }
  const seen = new Set<string>();
  return [
    ...single,
    ...grouped.toSorted((a, b) => a.path.localeCompare(b.path)),
  ].filter((item) => {
    if (seen.has(item.path)) return false;
    seen.add(item.path);
    return true;
  });
}

/** The value ranked last in `order` among `values`. */
function worst<T extends string>(order: readonly T[], values: T[]): T {
  return order[Math.max(...values.map((value) => order.indexOf(value)))]!;
}

function evidenceOf(
  path: string,
  role: string,
  members: readonly MemberState[],
): IndexedEvidence {
  return {
    declaredBytes: members.reduce((sum, m) => sum + m.entry.bytes, 0),
    inspectability: "metadata-only",
    integrity: worst(
      ["verified", "declared", "unknown", "changed"] as const,
      members.map((m) => m.integrity),
    ),
    medium: mediumOf(members[0]!.entry.path),
    path,
    presence:
      members.length > 1 &&
      members.some((m) => m.presence === "present") &&
      members.some((m) => m.presence !== "present")
        ? "partial"
        : worst(
            ["present", "empty", "missing"] as const,
            members.map((m) => m.presence),
          ),
    role,
    sensitivity: worst(
      [
        "metadata-safe",
        "redacted",
        "potentially-sensitive",
        "secret-bearing",
      ] as const,
      members.map((m) =>
        indexSensitivity(
          m.entry.sensitivity ?? inferArtifactSensitivity(m.entry.path),
        ),
      ),
    ),
  };
}

/** Drop the least important entries until the index fits 12 KiB / 200. */
function fitEvidence(
  index: RunIndexV1,
  evidence: IndexedEvidence[],
): IndexedEvidence[] {
  let kept = evidence.slice(0, MAX_EVIDENCE);
  const size = (items: IndexedEvidence[]): number =>
    Buffer.byteLength(JSON.stringify({ ...index, evidence: items }), "utf8");
  while (kept.length > 0 && size(kept) > RUN_INDEX_MAX_BYTES) {
    kept = kept.slice(0, -1);
  }
  return kept;
}

/**
 * When run metadata alone is over 12 KiB (many long outcome ids) and the
 * evidence is already gone, drop outcomes — passed ones first, newest last
 * kept — until it fits. `counts.outcomes` still reports the full number.
 */
function fitOutcomes(index: RunIndexV1): RunIndexV1["outcomes"] {
  const size = (outcomes: RunIndexV1["outcomes"]): number =>
    Buffer.byteLength(JSON.stringify({ ...index, outcomes }), "utf8");
  if (size(index.outcomes) <= RUN_INDEX_MAX_BYTES) return index.outcomes;
  const priority = [
    ...index.outcomes.filter((outcome) => outcome.status !== "passed"),
    ...index.outcomes.filter((outcome) => outcome.status === "passed"),
  ];
  let keep = priority.length;
  const keptInOrder = (): RunIndexV1["outcomes"] => {
    const chosen = new Set(priority.slice(0, keep));
    return index.outcomes.filter((outcome) => chosen.has(outcome));
  };
  while (keep > 0 && size(keptInOrder()) > RUN_INDEX_MAX_BYTES) keep--;
  return keptInOrder();
}

function indexSensitivity(value: ArtifactSensitivity): IndexSensitivity {
  if (value === "redacted") return "redacted";
  if (value === "secret-bearing") return "secret-bearing";
  return "potentially-sensitive";
}

function mediumOf(path: string): Medium {
  if (/\.(?:json|ndjson|ya?ml)$/i.test(path)) return "structured-text";
  if (/\.(?:md|log|txt|html?|csv|tsv|srt|vtt|xml)$/i.test(path)) return "text";
  if (/\.(?:png|jpe?g|webp|gif|bmp)$/i.test(path)) return "image";
  if (/\.(?:webm|mp4|mov|mkv)$/i.test(path)) return "video";
  if (/\.(?:zip|gz|tgz|tar|zst)$/i.test(path)) return "archive";
  return "binary";
}

function roleOf(kind: string): string {
  const role = kind
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^[^a-z]+/, "")
    .slice(0, 64);
  return ROLE_RE.test(role) ? role : "artifact";
}

function detectorVersion(): string {
  const cleaned = CAIRN_VERSION.replace(/[^A-Za-z0-9._-]/g, "-").slice(0, 32);
  return /^[A-Za-z0-9]/.test(cleaned) ? cleaned : "0";
}

function isoOf(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : new Date(ms).toISOString();
}

function bounded(value: string | undefined, max: number): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed.slice(0, max) : undefined;
}

function stringOf(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayOf(value: unknown): Array<Record<string, unknown> | undefined> {
  return Array.isArray(value)
    ? value.map((item) =>
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : undefined,
      )
    : [];
}

function clampCount(value: number): number {
  return Math.min(MAX_COUNT, Math.max(0, value));
}

async function readJsonObject(
  path: string,
): Promise<Record<string, unknown> | undefined> {
  try {
    const parsed = JSON.parse(await readFile(path, "utf8")) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

async function hashFile(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path))
    hash.update(chunk as Buffer);
  return hash.digest("hex");
}
