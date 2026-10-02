import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  DEFAULT_EVIDENCE_INCLUDE,
  type EvidenceCategory,
} from "../schema/config.v1";
import {
  ArtifactManifestSchema,
  type ArtifactSensitivity,
} from "../schema/run.v1";

/**
 * The evidence gate shared by auto-stash, `cairn stash save`, retention
 * archive and publish. A run directory is split into categories; only the
 * configured ones leave the machine (default `text` + `screenshots`).
 * Within them, sensitivity decides:
 *
 *   - `redacted` (written through the run redactor) and `safe` (browser
 *     media, produced files) always pass;
 *   - `sanitized` (a trace the best-effort sanitizer rewrote) is stashed
 *     when `traces` is included but never published;
 *   - `secret-bearing` (a trace the sanitizer could not rewrite, a raw
 *     monitor/heap profile, any text file cairn did not write itself) is
 *     never published and only stashed with
 *     `stash.unsafeIncludeRawTraces: true`.
 */

const MANIFEST_PATH = "artifact-manifest.json";
const IMAGE_RE = /\.(?:png|jpe?g|webp|gif|bmp)$/i;
const VIDEO_RE = /\.(?:webm|mp4|mov|mkv)$/i;

/** The include category a run-relative path belongs to. */
export function evidenceCategoryOf(relativePath: string): EvidenceCategory {
  const portable = relativePath.replaceAll("\\", "/");
  const top = portable.split("/", 1)[0]!;
  if (top === "traces") return "traces";
  if (top === "videos") return "videos";
  if (top === "downloads" || top === "transforms") return "downloads";
  if (top === "screenshots") return "screenshots";
  if (IMAGE_RE.test(portable)) return "screenshots";
  if (VIDEO_RE.test(portable)) return "videos";
  return "text";
}

/**
 * Raw process/network captures that hold whatever the process held (a CDP
 * heap snapshot keeps every string in the heap: env values, DB URLs,
 * session tokens). `monitor` profile steps write `monitor/<n>_profile.profile`.
 */
const RAW_CAPTURE_RE =
  /\.(?:profile|heapsnapshot|heapprofile|cpuprofile|pprof|har)(?:\.gz)?$/i;

/**
 * Sensitivity of a file whose provenance is known only by its path: a
 * legacy manifest entry without `sensitivity`, or a run with no manifest.
 * Traces and raw profiles may carry credentials; browser media and produced
 * files hold no credential structure (`safe`); other text was written by
 * cairn through the run redactor in every version that had no sensitivity.
 */
export function inferArtifactSensitivity(
  relativePath: string,
): ArtifactSensitivity {
  const category = evidenceCategoryOf(relativePath);
  if (category === "traces") return "secret-bearing";
  if (category === "text") {
    return RAW_CAPTURE_RE.test(relativePath) ? "secret-bearing" : "redacted";
  }
  return "safe";
}

/**
 * Sensitivity of a file cairn did not write through its redactor: a
 * producer-owned file (a monitor profile, a trace), an `--after` collector
 * output, or anything added after the manifest. Its text can hold anything,
 * so it is `secret-bearing`; media and produced files stay `safe`.
 */
export function inferUnredactedSensitivity(
  relativePath: string,
): ArtifactSensitivity {
  const inferred = inferArtifactSensitivity(relativePath);
  return inferred === "redacted" ? "secret-bearing" : inferred;
}

export interface EvidenceSelectionOptions {
  /** Categories to carry (default [text, screenshots]). */
  include?: readonly EvidenceCategory[];
  purpose: "stash" | "publish";
  /** stash only: keep secret-bearing members anyway. */
  unsafeIncludeRawTraces?: boolean;
}

export interface EvidenceSelection {
  /** Run-relative file paths that pass the gate. */
  files: string[];
  /**
   * Run-relative paths left out: a top-level directory as `dir/` when none
   * of its files passed, otherwise the individual files.
   */
  excluded: string[];
  /** Included-category files dropped because they are secret-bearing. */
  secretBearing: string[];
  /**
   * Every included-category file dropped for its sensitivity: the
   * secret-bearing ones and, on publish, sanitized traces.
   */
  withheld: string[];
  /** Nothing was excluded: the directory can be used as-is. */
  complete: boolean;
}

export interface ManifestSensitivity {
  /** Recorded sensitivity by run-relative path. */
  byPath: Map<string, ArtifactSensitivity>;
  /**
   * The manifest records sensitivities at all (written by a gate-aware
   * cairn): a file it does not list was not written by cairn's redactor.
   */
  tracked: boolean;
}

/** Read `artifact-manifest.json` sensitivities (empty when absent/invalid). */
export async function readManifestSensitivity(
  runDir: string,
): Promise<ManifestSensitivity> {
  const byPath = new Map<string, ArtifactSensitivity>();
  try {
    const manifest = ArtifactManifestSchema.parse(
      JSON.parse(await readFile(join(runDir, MANIFEST_PATH), "utf8")),
    );
    for (const entry of manifest.artifacts) {
      if (entry.sensitivity) byPath.set(entry.path, entry.sensitivity);
    }
  } catch {
    // A run without a (valid) manifest falls back to path inference.
  }
  return { byPath, tracked: byPath.size > 0 };
}

export async function selectRunEvidence(
  runDir: string,
  options: EvidenceSelectionOptions,
): Promise<EvidenceSelection> {
  const include = new Set(options.include ?? DEFAULT_EVIDENCE_INCLUDE);
  const marked = await readManifestSensitivity(runDir);
  const files = await listRunFiles(runDir);
  const kept: string[] = [];
  const dropped: string[] = [];
  const secretBearing: string[] = [];
  const withheld: string[] = [];
  for (const file of files) {
    if (!include.has(evidenceCategoryOf(file))) {
      dropped.push(file);
      continue;
    }
    const sensitivity =
      marked.byPath.get(file) ??
      // The manifest never lists itself; it holds paths and digests only.
      (file === MANIFEST_PATH
        ? "redacted"
        : marked.tracked
          ? inferUnredactedSensitivity(file)
          : inferArtifactSensitivity(file));
    const blocked =
      sensitivity === "secret-bearing"
        ? options.purpose === "publish" ||
          options.unsafeIncludeRawTraces !== true
        : sensitivity === "sanitized" && options.purpose === "publish";
    if (blocked) {
      dropped.push(file);
      withheld.push(file);
      if (sensitivity === "secret-bearing") secretBearing.push(file);
      continue;
    }
    kept.push(file);
  }
  return {
    files: kept,
    excluded: summarizeExcluded(dropped, kept),
    secretBearing,
    withheld,
    complete: dropped.length === 0,
  };
}

/** Collapse excluded files into `dir/` when nothing in that top dir survives. */
function summarizeExcluded(
  dropped: readonly string[],
  kept: readonly string[],
): string[] {
  const keptTops = new Set(
    kept.filter((file) => file.includes("/")).map((file) => topOf(file)),
  );
  const out = new Set<string>();
  for (const file of dropped) {
    const top = topOf(file);
    if (file.includes("/") && !keptTops.has(top)) out.add(`${top}/`);
    else out.add(file);
  }
  return [...out].toSorted();
}

function topOf(file: string): string {
  return file.split("/", 1)[0]!;
}

/** Every regular file under the run, run-relative and `/`-separated. */
async function listRunFiles(runDir: string): Promise<string[]> {
  const out: string[] = [];
  const visit = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await visit(join(dir, entry.name), relative);
      else if (entry.isFile()) out.push(relative);
    }
  };
  await visit(runDir, "");
  return out.toSorted();
}

export interface StagedEvidence {
  /** `<private tmp>/<name>/` holding only the selected files. */
  dir: string;
  cleanup(): Promise<void>;
}

/**
 * Copy the selected files into a private temp directory named `name` (the
 * run id, so the stash keeps a recognizable name). Links are never followed.
 */
export async function stageRunEvidence(
  runDir: string,
  selection: Pick<EvidenceSelection, "files">,
  name: string,
): Promise<StagedEvidence> {
  const base = await mkdtemp(join(tmpdir(), "cairntrace-evidence-"));
  const cleanup = async (): Promise<void> => {
    await rm(base, { recursive: true, force: true });
  };
  try {
    await chmod(base, 0o700);
    const dir = join(base, name);
    await mkdir(dir, { mode: 0o700 });
    for (const file of selection.files) {
      const source = join(runDir, file);
      const info = await lstat(source);
      if (!info.isFile()) continue;
      const target = join(dir, file);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target, constants.COPYFILE_FICLONE);
    }
    return { dir, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
