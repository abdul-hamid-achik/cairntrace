import { execa } from "execa";
import { existsSync } from "node:fs";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

export interface ClipLabel {
  label: string;
  start: string;
  end: string;
}

export interface VidtraceClipResult {
  ok: boolean;
  outputDir?: string;
  clips?: Array<{
    label: string;
    start_seconds: number;
    end_seconds: number;
    duration_seconds: number;
    path: string;
  }>;
  error?: string;
}

export interface VidtraceAvailability {
  available: boolean;
  version?: string;
}

/**
 * Check whether `vidtrace` is on $PATH and parse its version.
 */
export async function isVidtraceAvailable(): Promise<VidtraceAvailability> {
  try {
    const r = await execa("vidtrace", ["version"], { reject: false });
    if (r.exitCode !== 0) return { available: false };
    const version = r.stdout.trim().split("\n")[0]?.trim();
    return { available: true, version };
  } catch {
    return { available: false };
  }
}

/**
 * Run `vidtrace clip cut` against a source video, writing clips into a target
 * directory and returning a structured report.
 *
 * When `outputDir` is not provided, clips are written into a sibling
 * `videos/clips` directory next to the source video.
 */
export async function cutClipsWithVidtrace(
  videoPath: string,
  labels: ClipLabel[],
  opts: {
    outputDir?: string;
    name?: string;
    stash?: boolean;
    tags?: string[];
    reencode?: boolean;
  } = {},
): Promise<VidtraceClipResult> {
  if (labels.length === 0) {
    return { ok: false, error: "at least one clip label is required" };
  }
  if (!existsSync(videoPath)) {
    return { ok: false, error: `video not found: ${videoPath}` };
  }

  const avail = await isVidtraceAvailable();
  if (!avail.available) {
    return {
      ok: false,
      error:
        "vidtrace not found on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/vidtrace",
    };
  }

  const resolvedOutputDir = opts.outputDir ?? join(dirname(videoPath), "clips");
  const outputDir = opts.name
    ? join(resolvedOutputDir, opts.name)
    : resolvedOutputDir;
  await mkdir(outputDir, { recursive: true });

  const args = ["clip", "cut", resolve(videoPath)];
  for (const label of labels) {
    args.push("--label", `${label.label}=${label.start}-${label.end}`);
  }
  args.push("--out", resolve(outputDir));
  if (opts.name) args.push("--name", opts.name);
  if (opts.reencode) args.push("--reencode");
  if (opts.stash) {
    args.push("--stash", "--tool", "cairntrace");
    for (const tag of opts.tags ?? []) args.push("--tag", tag);
  }
  args.push("--json");

  try {
    const r = await execa("vidtrace", args, {
      reject: false,
      timeout: 600_000,
    });
    if (r.exitCode !== 0) {
      return {
        ok: false,
        error: `vidtrace clip cut failed: ${r.stderr || r.stdout}`,
      };
    }
    const data = JSON.parse(r.stdout);
    return {
      ok: data.ok === true,
      outputDir: data.output_dir ?? outputDir,
      clips: Array.isArray(data.clips) ? data.clips : undefined,
      error: data.ok === true ? undefined : data.error,
    };
  } catch (e) {
    return {
      ok: false,
      error: `failed to run vidtrace: ${(e as Error).message}`,
    };
  }
}

/**
 * Move clips produced by vidtrace into the Cairntrace run directory.
 *
 * vidtrace writes clips into `<outputDir>/<name>/<label>.mp4`. We want them in
 * `<runDir>/videos/clips/<label>.mp4` so they are relative to the run dir and
 * follow Cairntrace artifact conventions.
 */
export async function moveClipsIntoRunDir(
  runDir: string,
  clipResult: VidtraceClipResult,
): Promise<Record<string, string>> {
  const clips: Record<string, string> = {};
  if (!clipResult.clips || clipResult.clips.length === 0) return clips;

  const targetDir = join(runDir, "videos", "clips");
  await mkdir(targetDir, { recursive: true });

  for (const clip of clipResult.clips) {
    const safeLabel = clip.label.replace(/[^a-zA-Z0-9._-]+/g, "_");
    const targetPath = join(targetDir, `${safeLabel}.mp4`);
    try {
      await rm(targetPath, { force: true });
      await rename(resolve(clip.path), targetPath);
      clips[clip.label] = `videos/clips/${safeLabel}.mp4`;
    } catch (e) {
      clips[clip.label] = `videos/clips/${safeLabel}.mp4 (move failed: ${
        (e as Error).message
      })`;
    }
  }
  return clips;
}

/**
 * Convert config clip points into vidtrace labels.
 */
export function clipPointsToLabels(
  points: Array<{ label: string; start: string; end: string }>,
): ClipLabel[] {
  return points.map((p) => ({ label: p.label, start: p.start, end: p.end }));
}

/**
 * Parse a CLI --label string of the form `name=start-end`.
 */
export function parseClipLabel(input: string): ClipLabel | undefined {
  const match = input.match(/^([^=]+)=(\d+(?::\d+){0,2})-(\d+(?::\d+){0,2})$/);
  if (!match) return undefined;
  const label = match[1];
  const start = match[2];
  const end = match[3];
  if (label === undefined || start === undefined || end === undefined) {
    return undefined;
  }
  return {
    label: label.trim(),
    start,
    end,
  };
}
