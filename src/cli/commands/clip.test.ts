import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { clipCommand, type ClipResult } from "./clip";
import * as vidtraceClip from "../../core/clip/vidtraceClip";
import * as stash from "./stash";

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairntrace-clip-test-"));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function makeRunDir(prefix: string): Promise<string> {
  const runDir = await mkdtemp(join(dir, prefix));
  return runDir;
}

async function makeVideo(runDir: string): Promise<string> {
  const videosDir = join(runDir, "videos");
  await mkdir(videosDir, { recursive: true });
  const videoPath = join(videosDir, "playwright-video.webm");
  await writeFile(videoPath, "fake");
  return videoPath;
}

describe("clipCommand", () => {
  it("returns an error when no video exists", async () => {
    const runDir = await makeRunDir("no-video-");

    let output = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });

    await clipCommand(runDir, {
      labels: ["issue=0:10-0:20"],
      json: true,
    });

    const parsed = JSON.parse(output) as ClipResult;
    expect(parsed.error).toMatch(/no run video found/);
    expect(parsed.clips).toEqual({});

    stdoutSpy.mockRestore();
  });

  it("returns an error for invalid label format", async () => {
    const runDir = await makeRunDir("bad-label-");
    await makeVideo(runDir);

    let output = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });

    await clipCommand(runDir, {
      labels: ["not-a-valid-label"],
      json: true,
    });

    const parsed = JSON.parse(output) as ClipResult;
    expect(parsed.error).toMatch(/invalid --label format/);

    stdoutSpy.mockRestore();
  });

  it("returns an error when vidtrace is unavailable", async () => {
    const runDir = await makeRunDir("no-vidtrace-");
    await makeVideo(runDir);

    vi.spyOn(vidtraceClip, "isVidtraceAvailable").mockResolvedValue({
      available: false,
    });

    let output = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });

    await clipCommand(runDir, {
      labels: ["issue=0:10-0:20"],
      json: true,
    });

    const parsed = JSON.parse(output) as ClipResult;
    expect(parsed.error).toMatch(/vidtrace not found/);

    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("cuts clips and moves them into the run dir", async () => {
    const runDir = await makeRunDir("success-");
    await makeVideo(runDir);

    vi.spyOn(vidtraceClip, "isVidtraceAvailable").mockResolvedValue({
      available: true,
      version: "v0.0.0",
    });
    vi.spyOn(vidtraceClip, "cutClipsWithVidtrace").mockResolvedValue({
      ok: true,
      outputDir: resolve(runDir, "tmp-clips"),
      clips: [
        {
          label: "issue",
          start_seconds: 10,
          end_seconds: 20,
          duration_seconds: 10,
          path: resolve(runDir, "tmp-clips", "issue.mp4"),
        },
      ],
    });
    vi.spyOn(vidtraceClip, "moveClipsIntoRunDir").mockResolvedValue({
      issue: "videos/clips/issue.mp4",
    });

    let output = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });

    await clipCommand(runDir, {
      labels: ["issue=0:10-0:20"],
      json: true,
    });

    const parsed = JSON.parse(output) as ClipResult;
    expect(parsed.clips).toEqual({ issue: "videos/clips/issue.mp4" });
    expect(parsed.error).toBeUndefined();

    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
  });

  it("stashes the run dir when --stash is passed", async () => {
    const runDir = await makeRunDir("stash-");
    await makeVideo(runDir);

    vi.spyOn(vidtraceClip, "isVidtraceAvailable").mockResolvedValue({
      available: true,
      version: "v0.0.0",
    });
    vi.spyOn(vidtraceClip, "cutClipsWithVidtrace").mockResolvedValue({
      ok: true,
      outputDir: resolve(runDir, "tmp-clips"),
      clips: [
        {
          label: "issue",
          start_seconds: 10,
          end_seconds: 20,
          duration_seconds: 10,
          path: resolve(runDir, "tmp-clips", "issue.mp4"),
        },
      ],
    });
    vi.spyOn(vidtraceClip, "moveClipsIntoRunDir").mockResolvedValue({
      issue: "videos/clips/issue.mp4",
    });
    vi.spyOn(stash, "stashDirectory").mockResolvedValue({
      ok: true,
      stashId: "stash-123",
    });

    let output = "";
    const stdoutSpy = vi
      .spyOn(process.stdout, "write")
      .mockImplementation((chunk) => {
        output += String(chunk);
        return true;
      });

    await clipCommand(runDir, {
      labels: ["issue=0:10-0:20"],
      stash: true,
      tags: ["intel"],
      json: true,
    });

    const parsed = JSON.parse(output) as ClipResult;
    expect(parsed.stashId).toBe("stash-123");

    stdoutSpy.mockRestore();
    vi.restoreAllMocks();
  });
});
