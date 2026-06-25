import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { resolveArtifactRoot, resolveRunRef } from "../runRefs";
import { emit, resolveFormat } from "../format";
import type { OutputFormat } from "../format";
import {
  cutClipsWithVidtrace,
  isVidtraceAvailable,
  moveClipsIntoRunDir,
  parseClipLabel,
  type ClipLabel,
} from "../../core/clip/vidtraceClip";
import { stashDirectory } from "./stash";

export interface ClipResult {
  runId: string;
  runDir: string;
  sourceVideo?: string;
  outputDir?: string;
  clips: Record<string, string>;
  stashId?: string;
  error?: string;
}

export interface ClipOptions {
  labels?: string[];
  out?: string;
  name?: string;
  stash?: boolean;
  tags?: string[];
  reencode?: boolean;
  artifactRoot?: string;
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/* ---------------------------------------------------------------------------
 * cairn clip
 *
 * `cairn clip <run-ref> --label "name=start-end" [--label ...] [--out DIR]
 *   [--name PREFIX] [--stash] [--tag TAG] [--reencode] [--json]`
 *
 * Resolves a run directory, finds the recorded run video, and calls
 * `vidtrace clip cut` to produce named clips. Clips are moved into the run
 * directory under `videos/clips/` so they stay relative to the run artifacts.
 * ------------------------------------------------------------------------- */

export async function clipCommand(
  runRef: string,
  opts: ClipOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const root = await resolveArtifactRoot({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });

  const runDir = await resolveRunRef(runRef, root);
  const runId =
    runRef === "latest" || runRef === "previous"
      ? (runDir.split("/").pop() ?? runRef)
      : runRef;

  const result: ClipResult = {
    runId,
    runDir,
    clips: {},
  };

  // Resolve source video
  const videoCandidates = [
    resolve(runDir, "videos", "playwright-video.webm"),
    resolve(runDir, "videos", "agent-browser-video.webm"),
  ];
  const sourceVideo = videoCandidates.find((p) => existsSync(p));
  if (!sourceVideo) {
    result.error = "no run video found in videos/";
    writeResult(format, result);
    return;
  }
  result.sourceVideo = sourceVideo;

  // Parse labels
  const labels: ClipLabel[] = [];
  for (const raw of opts.labels ?? []) {
    const parsed = parseClipLabel(raw);
    if (!parsed) {
      result.error = `invalid --label format: ${raw} (expected name=start-end)`;
      writeResult(format, result);
      return;
    }
    labels.push(parsed);
  }
  if (labels.length === 0) {
    result.error = "at least one --label name=start-end is required";
    writeResult(format, result);
    return;
  }

  // Check vidtrace availability
  const vidtrace = await isVidtraceAvailable();
  if (!vidtrace.available) {
    result.error =
      "vidtrace not found on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/vidtrace";
    writeResult(format, result);
    return;
  }

  // Cut clips
  const cutResult = await cutClipsWithVidtrace(sourceVideo, labels, {
    outputDir: opts.out ? resolve(opts.out) : undefined,
    name: opts.name,
    stash: opts.stash,
    tags: opts.tags,
    reencode: opts.reencode,
  });

  if (!cutResult.ok) {
    result.error = cutResult.error;
    writeResult(format, result);
    return;
  }

  result.outputDir = cutResult.outputDir;

  // Move clips into the run dir so they're relative to run artifacts
  result.clips = await moveClipsIntoRunDir(runDir, cutResult);

  // Persist clips manifest for later tooling.
  await writeClipsManifest(runDir, result.clips);

  // Optionally stash the run dir (now enriched with clips)
  if (opts.stash) {
    const stashResult = await stashDirectory(runDir, {
      tags: [...(opts.tags ?? []), "vidtrace-clip"],
      tool: "cairntrace",
      source: sourceVideo,
    });
    if (stashResult?.ok && stashResult.stashId) {
      result.stashId = stashResult.stashId;
    }
  }

  writeResult(format, result);
}

async function writeClipsManifest(
  runDir: string,
  clips: Record<string, string>,
): Promise<void> {
  const dir = resolve(runDir, "videos", "clips");
  await mkdir(dir, { recursive: true });
  await writeFile(
    resolve(dir, "clips.json"),
    JSON.stringify({ clips, generatedAt: new Date().toISOString() }, null, 2) +
      "\n",
  );
}

function writeResult(format: OutputFormat, result: ClipResult): void {
  process.stdout.write(emit(format, result, () => clipMarkdown(result)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function clipMarkdown(result: ClipResult): string {
  const lines = [
    `# Clip result: ${result.runId}`,
    "",
    `- source video: ${result.sourceVideo ?? "(not found)"}`,
    ...(result.outputDir ? [`- output dir: ${result.outputDir}`] : []),
    ...(result.stashId ? [`- stash: ${result.stashId}`] : []),
    ...(result.error ? [`- error: ${result.error}`] : []),
    "",
    "## Clips",
    "",
  ];
  const entries = Object.entries(result.clips);
  if (entries.length === 0) {
    lines.push("- (no clips produced)");
  } else {
    for (const [label, path] of entries) {
      lines.push(`- ${label}: ${path}`);
    }
  }
  return lines.join("\n") + "\n";
}
