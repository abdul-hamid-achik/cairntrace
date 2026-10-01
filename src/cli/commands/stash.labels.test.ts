import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";
import { readRunLabels, stashTagsForRun, tagsFromLabels } from "./stash";

describe("tagsFromLabels", () => {
  it("returns sorted key=value tags", () => {
    expect(
      tagsFromLabels({ target: "intel", round: "r1", sha: "abc1234567" }),
    ).toEqual(["round=r1", "sha=abc1234567", "target=intel"]);
  });

  it("skips entries that would make ambiguous tags", () => {
    expect(
      tagsFromLabels({
        "a=b": "x",
        "": "x",
        "sp ace": "x",
        comma: "a,b",
        blank: "has space",
        ok: "",
      }),
    ).toEqual(["ok="]);
    expect(tagsFromLabels(undefined)).toEqual([]);
  });
});

describe("readRunLabels / stashTagsForRun", () => {
  it("reads string labels from run.json and merges them after explicit tags", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-labels-"));
    try {
      await writeFile(
        join(dir, "run.json"),
        JSON.stringify({
          runId: "r",
          labels: { variant: "gc", sha: "abc", bad: 3 },
        }),
      );
      expect(await readRunLabels(dir)).toEqual({ variant: "gc", sha: "abc" });
      expect(await stashTagsForRun(dir, ["bench", "sha=abc"], true)).toEqual([
        "bench",
        "sha=abc",
        "variant=gc",
      ]);
      expect(await stashTagsForRun(dir, ["bench"], false)).toEqual(["bench"]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("treats a missing or malformed run.json as no labels", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-labels-missing-"));
    try {
      expect(await readRunLabels(dir)).toEqual({});
      await writeFile(join(dir, "run.json"), "{not json");
      expect(await readRunLabels(dir)).toEqual({});
      await writeFile(join(dir, "run.json"), JSON.stringify({ labels: [1] }));
      expect(await readRunLabels(dir)).toEqual({});
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("cairn stash save --labels-as-tags --ttl / list --tag (repeatable)", () => {
  it("passes label tags, ttl and every list tag to fcheap", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairntrace-stash-labels-cli-"));
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "bench-2026-10-01T120000Z");
    const fakeBin = join(root, "bin");
    const argsLog = join(root, "args.log");
    await mkdir(runDir, { recursive: true });
    await mkdir(fakeBin, { recursive: true });
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({ labels: { round: "r7", target: "intel" } }),
    );
    const fakeFcheap = join(fakeBin, "fcheap");
    await writeFile(
      fakeFcheap,
      `#!/bin/sh
printf '%s\\n' "$*" >> "${argsLog}"
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"bench-stash","schema_version":"1.0","status":"saved"}'
  exit 0
fi
if [ "$1" = "list" ]; then
  printf '%s\\n' '[]'
  exit 0
fi
exit 2
`,
    );
    await chmod(fakeFcheap, 0o755);
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
    };
    const cairn = join(process.cwd(), "bin", "cairn");
    try {
      const saved = await execa(
        cairn,
        [
          "stash",
          "save",
          "latest",
          "--artifact-root",
          runsRoot,
          "--tag",
          "project=graphite",
          "--labels-as-tags",
          "--ttl",
          "30d",
          "--json",
        ],
        { reject: false, timeout: 10_000, env },
      );
      expect(saved.exitCode).toBe(0);
      expect(JSON.parse(saved.stdout)).toMatchObject({
        stashId: "bench-stash",
        tags: ["project=graphite", "round=r7", "target=intel"],
      });

      const listed = await execa(
        cairn,
        [
          "stash",
          "list",
          "--tag",
          "round=r7",
          "--tag",
          "target=intel",
          "--json",
        ],
        { reject: false, timeout: 10_000, env },
      );
      expect(listed.exitCode).toBe(0);

      const calls = (await readFile(argsLog, "utf8")).trim().split("\n");
      expect(calls[0]).toContain(
        "--tag project=graphite --tag round=r7 --tag target=intel",
      );
      expect(calls[0]).toContain("--ttl 30d");
      expect(calls[1]).toBe("list --tag round=r7 --tag target=intel --json");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
