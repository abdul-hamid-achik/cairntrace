import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunEventSchema } from "../../core/schema/events.v1";
import { executeRunInvocation } from "./executeRunInvocation";

/**
 * Golden `_invocations/<id>/events.ndjson` slice for suites (F9) and metrics
 * (F11): suite.started, suite.hook.*, metric.sampled and suite.finished.
 * Every line validates against the strict events.v1 producer schema, and the
 * normalized stream matches its fixture. Regenerate after an intentional
 * vocabulary change with:
 *
 *   UPDATE_EVENT_GOLDENS=1 bun run test -- src/cli/invocation/suite.golden.test.ts
 */
const FIXTURE_DIR = join(
  import.meta.dirname,
  "..",
  "..",
  "core",
  "schema",
  "__fixtures__",
  "events",
);
const UPDATE = process.env.UPDATE_EVENT_GOLDENS === "1";
const WANTED = /^(suite\.|metric\.)/;

let dir: string;
let runsRoot: string;

const SPEC = `version: 1
name: golden_suite
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-suite-golden-"));
  runsRoot = await mkdtemp(join(tmpdir(), "cairn-suite-golden-runs-"));
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(join(dir, "flows", "one.yml"), SPEC);
  await writeFile(
    join(dir, "flows", "two.yml"),
    SPEC.replace("golden_suite", "golden_suite2"),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(runsRoot, { recursive: true, force: true });
});

const PLACEHOLDERS: Record<string, unknown> = {
  ts: "<ts>",
  durationMs: 0,
  outputTail: "<output>",
  runId: "<runId>",
};

function normalize(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    out[key] = Object.hasOwn(PLACEHOLDERS, key) ? PLACEHOLDERS[key] : value;
  }
  return out;
}

describe("suite and metrics event goldens", () => {
  it("suite-metrics-pass: hooks, samples, finished", async () => {
    const configPath = join(dir, "golden.config.yml");
    await writeFile(
      configPath,
      `version: 1
project: golden-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
suites:
  golden:
    specs: [flows/one.yml, flows/two.yml]
    bail: true
    before: ["echo warming"]
    after: ["echo cleaning $CAIRN_EXIT_CODE"]
metrics:
  - { name: depth, command: "echo 3", parse: { regex: "(\\\\d)" } }
  - { name: total, scope: invocation, command: "echo 9", parse: { regex: "(\\\\d)" } }
  - { name: broken, command: "exit 1", parse: { json: "$.x" }, sample: [after] }
`,
    );
    const result = await executeRunInvocation(
      {
        specs: [],
        options: {
          mock: true,
          config: configPath,
          suite: "golden",
          artifactRoot: join(runsRoot, "runs"),
          noWebServer: true,
          noServices: true,
        },
        cwd: dir,
      },
      { origin: "cli" },
    );
    expect(result.exitCode).toBe(0);
    const events = (
      await readFile(join(result.journalDir!, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => WANTED.test(String(event.type)));
    for (const event of events) {
      const parsed = RunEventSchema.safeParse(event);
      expect(
        parsed.success,
        `${JSON.stringify(event)}\n${
          parsed.success ? "" : parsed.error.message
        }`,
      ).toBe(true);
    }
    // The two spec runs interleave `metric.sampled` lines of their own
    // runs in a stable order: normalize, then compare with the fixture.
    const normalized = events.map(normalize);
    const goldenPath = join(FIXTURE_DIR, "suite-metrics-pass.ndjson");
    if (UPDATE) {
      await writeFile(
        goldenPath,
        `${normalized.map((event) => JSON.stringify(event)).join("\n")}\n`,
      );
    } else if (!existsSync(goldenPath)) {
      throw new Error(
        `missing golden ${goldenPath}; run with UPDATE_EVENT_GOLDENS=1`,
      );
    }
    const golden = (await readFile(goldenPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(normalized).toEqual(golden);
    for (const event of golden) {
      const candidate = {
        ...event,
        ...(event.ts === "<ts>" ? { ts: "2026-01-01T00:00:00.000Z" } : {}),
        ...(event.runId === "<runId>"
          ? { runId: "2026-01-01T00-00-00-000Z_golden_abcdef" }
          : {}),
      };
      expect(
        RunEventSchema.safeParse(candidate).success,
        JSON.stringify(event),
      ).toBe(true);
    }
  });
});
