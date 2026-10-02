import { execa } from "execa";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { aggregateRunStats } from "../../core/stats/runStats";

const SPEC = `version: 1
name: repeat_matrix_e2e
intent: exercise --repeat/--matrix/--after with the mock backend.
coldStart: guest
outcomes:
  - id: ok
    description: url always matches
    verify: { url: { matches: ".*" } }
steps:
  - open: { path: "data:text/html,<h1>x</h1>", waitUntil: load }
`;

describe(
  "cairn run --repeat/--matrix/--after (mock backend, via CLI)",
  { timeout: 30_000 },
  () => {
    let dir: string;
    let artifactRoot: string;
    let specPath: string;
    const bin = join(process.cwd(), "bin", "cairn");

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "cairntrace-rm-e2e-"));
      artifactRoot = join(dir, "runs");
      specPath = join(dir, "s.yml");
      await writeFile(specPath, SPEC);
    });
    afterEach(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    const base = () => [
      "run",
      specPath,
      "--mock",
      "--no-services",
      "--no-web-server",
      "--artifact-root",
      artifactRoot,
      "--json",
    ];

    it("runs the cartesian product x repeat, stamping labels, env, after-hook metrics", async () => {
      const log = join(dir, "before.log");
      const result = await execa(
        bin,
        [
          ...base(),
          "--repeat",
          "2",
          "--matrix",
          "cfg=a,b",
          "--before",
          `echo "$CAIRN_MATRIX_CFG/$CAIRN_REPEAT" >> "${log}"`,
          "--after",
          `echo '{"gcSeconds": 1.5, "rootMs": 10}' > "$CAIRN_RUN_DIR/diagnostics/report.json"`,
        ],
        { cwd: dir, reject: false, timeout: 60_000 },
      );
      expect(result.exitCode).toBe(0);
      // --before runs once per iteration, with matrix env exported.
      expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
        "a/1",
        "b/1",
        "a/2",
        "b/2",
      ]);
      expect(result.stderr).toContain("Summary: 4/4 run(s) executed");
      expect(result.stderr).toContain("4 passed, 0 failed");

      const runDirs = (await readdir(artifactRoot)).filter(
        (d) => d !== "index",
      );
      expect(runDirs.length).toBeGreaterThanOrEqual(4);

      const byCfg = await aggregateRunStats({
        artifactRoot,
        groupBy: "cfg",
        metricNames: ["gcSeconds"],
      });
      expect(byCfg.groups.map((g) => [g.key, g.runs])).toEqual([
        ["a", 2],
        ["b", 2],
      ]);
      expect(byCfg.groups[0]!.metric?.p50).toBe(1.5);

      const byRepeat = await aggregateRunStats({
        artifactRoot,
        groupBy: "repeat",
      });
      expect(byRepeat.groups.map((g) => g.key)).toEqual(["1", "2"]);
    }, 90_000);

    it("--stop-on-fail halts after the first failing run", async () => {
      const result = await execa(
        bin,
        [...base(), "--matrix", "n=1,2,3", "--stop-on-fail"],
        { cwd: dir, reject: false, timeout: 60_000 },
      );
      // Passing spec: all three run (stop-on-fail only triggers on failure).
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("3/3 run(s) executed");

      const failing = join(dir, "fail.yml");
      await writeFile(
        failing,
        SPEC.replace('matches: ".*"', 'matches: "^never$"').replace(
          "repeat_matrix_e2e",
          "repeat_matrix_fail",
        ),
      );
      const failed = await execa(
        bin,
        [
          "run",
          failing,
          "--mock",
          "--no-services",
          "--no-web-server",
          "--artifact-root",
          join(dir, "runs2"),
          "--json",
          "--matrix",
          "n=1,2,3",
          "--stop-on-fail",
        ],
        { cwd: dir, reject: false, timeout: 60_000 },
      );
      expect(failed.exitCode).not.toBe(0);
      expect(failed.stderr).toContain("1/3 run(s) executed");
      expect(failed.stderr).toContain("--stop-on-fail");
    }, 90_000);

    it("rejects invalid --repeat/--matrix with exit 2", async () => {
      for (const args of [
        ["--repeat", "0"],
        ["--matrix", "oops"],
      ]) {
        const r = await execa(bin, [...base(), ...args], {
          cwd: dir,
          reject: false,
          timeout: 30_000,
        });
        expect(r.exitCode).toBe(2);
      }
    });
  },
);
