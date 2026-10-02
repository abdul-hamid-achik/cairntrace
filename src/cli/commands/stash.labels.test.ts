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
      tagsFromLabels({ target: "staging", round: "r1", sha: "abc1234567" }),
    ).toEqual(["round=r1", "sha=abc1234567", "target=staging"]);
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

// Spawns bin/cairn; vitest's 5s default is too tight under full-suite load.
describe(
  "cairn stash save --labels-as-tags --ttl / list --tag (repeatable)",
  { timeout: 30_000 },
  () => {
    it("passes label tags, ttl and every list tag to fcheap", async () => {
      const root = await mkdtemp(
        join(tmpdir(), "cairntrace-stash-labels-cli-"),
      );
      const runsRoot = join(root, "runs");
      const runDir = join(runsRoot, "2026-10-01T12-00-00-000Z_bench_a1b2c3");
      const fakeBin = join(root, "bin");
      const argsLog = join(root, "args.log");
      await mkdir(runDir, { recursive: true });
      await mkdir(fakeBin, { recursive: true });
      await writeFile(
        join(runDir, "run.json"),
        JSON.stringify({ labels: { round: "r7", target: "staging" } }),
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
            "project=demo-shop",
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
          tags: ["project=demo-shop", "round=r7", "target=staging"],
        });

        const listed = await execa(
          cairn,
          [
            "stash",
            "list",
            "--tag",
            "round=r7",
            "--tag",
            "target=staging",
            "--json",
          ],
          { reject: false, timeout: 10_000, env },
        );
        expect(listed.exitCode).toBe(0);

        // Capability probes (`save --help`) are not stash calls.
        const calls = (await readFile(argsLog, "utf8"))
          .trim()
          .split("\n")
          .filter((call) => !call.includes("--help"));
        expect(calls[0]).toContain(
          "--tag project=demo-shop --tag round=r7 --tag target=staging",
        );
        expect(calls[0]).toContain("--ttl 30d");
        expect(calls[1]).toBe(
          "list --tag round=r7 --tag target=staging --json",
        );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  },
);
