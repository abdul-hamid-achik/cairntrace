import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

const CAIRN = join(process.cwd(), "bin", "cairn");
/** Each test spawns bin/cairn; vitest's 5s default is too tight under load. */
const E2E_TIMEOUT_MS = 30_000;

const PASSING_SPEC = (name: string) => `version: 1
name: ${name}
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
  - click: { by: role, role: button, name: Continue }
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

const FAILING_SPEC = `version: 1
name: demo_json_fail
intent: The welcome copy regressed.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: welcome_copy
    description: The welcome copy is visible.
    verify: { text: { contains: Welcome back } }
`;

interface LogEntry {
  ts: string;
  level: string;
  scope?: string;
  msg: string;
  [field: string]: unknown;
}

/** Every non-empty stderr line must be one JSON object. */
function parseStderr(stderr: string): LogEntry[] {
  return stderr
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      try {
        return JSON.parse(line) as LogEntry;
      } catch {
        throw new Error(`stderr line is not JSON: ${line}`);
      }
    });
}

/** Shell hook that dumps the CAIRN_* run context, one value per line. */
const captureContext = (file: string) =>
  `printf '%s\\n' "$CAIRN_ENV" "$CAIRN_BASE_URL" "$CAIRN_CONFIG_DIR" "\${CAIRN_RUN_ID:-none}" "\${CAIRN_RUN_DIR:-none}" "\${CAIRN_RUN_TOKEN:-none}" > "${file}"`;

const progress = (entries: LogEntry[]) =>
  entries.filter((entry) => entry.scope === "progress");

describe("cairn run --format json --log-format json narration", () => {
  it(
    "narrates a single run as NDJSON on stderr and keeps stdout the document",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cairn-json-narration-"));
      const specPath = join(dir, "pass.yml");
      await writeFile(specPath, PASSING_SPEC("demo_json_pass"));

      const result = await execa(
        CAIRN,
        [
          "--log-format",
          "json",
          "run",
          specPath,
          "--mock",
          "--no-services",
          "--no-web-server",
          "--artifact-root",
          join(dir, "runs"),
          "--json",
        ],
        { cwd: dir, reject: false, timeout: 20_000, env: { CI: "true" } },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({ status: "passed" });

      const entries = progress(parseStderr(result.stderr));
      const messages = entries.map((entry) => entry.msg);
      expect(messages).toEqual(
        expect.arrayContaining([
          "run start",
          "step finished",
          "outcomes evaluating",
          "outcome verifying",
          "outcome passed",
          "run end",
        ]),
      );
      const runId = entries.find((entry) => entry.msg === "run start")?.runId;
      expect(typeof runId).toBe("string");
      const steps = entries.filter((entry) => entry.msg === "step finished");
      expect(steps).toHaveLength(2);
      expect(steps[1]).toMatchObject({
        level: "info",
        runId,
        index: 2,
        status: "passed",
      });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "logs failures at warn with expected/actual",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cairn-json-narration-fail-"));
      const specPath = join(dir, "fail.yml");
      await writeFile(specPath, FAILING_SPEC);

      const result = await execa(
        CAIRN,
        [
          "--log-format",
          "json",
          "run",
          specPath,
          "--mock",
          "--no-services",
          "--no-web-server",
          "--artifact-root",
          join(dir, "runs"),
          "--yaml",
        ],
        { cwd: dir, reject: false, timeout: 20_000, env: { CI: "true" } },
      );
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("status: failed");
      const entries = progress(parseStderr(result.stderr));
      expect(entries.find((e) => e.msg === "outcome failed")).toMatchObject({
        level: "warn",
        outcomeId: "welcome_copy",
        expected: expect.stringContaining("Welcome back"),
      });
      expect(entries.find((e) => e.msg === "run end")).toMatchObject({
        level: "warn",
        status: "failed",
      });
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "narrates batch rows with their position",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cairn-json-narration-batch-"));
      const first = join(dir, "first.yml");
      const second = join(dir, "second.yml");
      await writeFile(first, PASSING_SPEC("demo_batch_first"));
      await writeFile(second, PASSING_SPEC("demo_batch_second"));

      const result = await execa(
        CAIRN,
        [
          "--log-format",
          "json",
          "run",
          first,
          second,
          "--parallel",
          "2",
          "--mock",
          "--no-services",
          "--no-web-server",
          "--artifact-root",
          join(dir, "runs"),
          "--json",
        ],
        { cwd: dir, reject: false, timeout: 30_000, env: { CI: "true" } },
      );
      expect(result.exitCode).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        summary: { total: 2, passed: 2 },
      });
      const entries = progress(parseStderr(result.stderr));
      const finished = entries.filter((e) => e.msg === "spec finished");
      expect(finished.map((e) => e.specIndex).toSorted()).toEqual([1, 2]);
      expect(finished.every((e) => e.specTotal === 2)).toBe(true);
      const stepRows = entries.filter((e) => e.msg === "step finished");
      expect(stepRows.every((e) => typeof e.runId === "string")).toBe(true);
      expect(stepRows.every((e) => e.specTotal === 2)).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "keeps stderr NDJSON for --repeat summaries",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cairn-json-narration-repeat-"));
      const specPath = join(dir, "pass.yml");
      await writeFile(specPath, PASSING_SPEC("demo_json_repeat"));
      const result = await execa(
        CAIRN,
        [
          "--log-format",
          "json",
          "run",
          specPath,
          "--repeat",
          "2",
          "--mock",
          "--no-services",
          "--no-web-server",
          "--artifact-root",
          join(dir, "runs"),
          "--json",
        ],
        { cwd: dir, reject: false, timeout: 30_000, env: { CI: "true" } },
      );
      expect(result.exitCode).toBe(0);
      const entries = parseStderr(result.stderr);
      expect(entries.find((e) => e.msg === "iterations summary")).toMatchObject(
        {
          executed: 2,
          planned: 2,
          passed: 2,
          failed: 0,
        },
      );
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "stays silent on stderr without --log-format json (unchanged default)",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cairn-json-quiet-"));
      const specPath = join(dir, "pass.yml");
      await writeFile(specPath, PASSING_SPEC("demo_json_quiet"));
      const result = await execa(
        CAIRN,
        [
          "run",
          specPath,
          "--mock",
          "--no-services",
          "--no-web-server",
          "--artifact-root",
          join(dir, "runs"),
          "--json",
        ],
        { cwd: dir, reject: false, timeout: 20_000, env: { CI: "true" } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stderr).not.toContain("step finished");
    },
    E2E_TIMEOUT_MS,
  );
});

describe("hook context env", () => {
  it(
    "exports CAIRN_ENV/BASE_URL/CONFIG_DIR to --before and run ids to --after",
    async () => {
      const dir = await mkdtemp(join(tmpdir(), "cairn-hook-context-"));
      const configPath = join(dir, "cairntrace.config.yml");
      await writeFile(
        configPath,
        `version: 1
defaultEnvironment: staging
environments:
  staging:
    baseUrl: https://demo.example.test
`,
      );
      const specPath = join(dir, "pass.yml");
      await writeFile(specPath, PASSING_SPEC("demo_hook_context"));
      const beforeOut = join(dir, "before.txt");
      const afterOut = join(dir, "after.txt");

      const result = await execa(
        CAIRN,
        [
          "run",
          specPath,
          "--config",
          configPath,
          "--mock",
          "--no-services",
          "--no-web-server",
          "--artifact-root",
          join(dir, "runs"),
          "--before",
          captureContext(beforeOut),
          "--after",
          captureContext(afterOut),
          "--json",
        ],
        {
          cwd: dir,
          reject: false,
          timeout: 20_000,
          env: { CI: "true" },
        },
      );
      expect(result.exitCode).toBe(0);
      const run = JSON.parse(result.stdout) as {
        runId: string;
        runDir: string;
      };

      const before = (await readFile(beforeOut, "utf8")).trim().split("\n");
      expect(before).toEqual([
        "staging",
        "https://demo.example.test",
        dir,
        "none",
        "none",
        "none",
      ]);

      const after = (await readFile(afterOut, "utf8")).trim().split("\n");
      expect(after.slice(0, 5)).toEqual([
        "staging",
        "https://demo.example.test",
        dir,
        run.runId,
        run.runDir,
      ]);
      expect(after[5]).toMatch(/^[a-z0-9]+_[a-z0-9]+$/);
    },
    E2E_TIMEOUT_MS,
  );
});
