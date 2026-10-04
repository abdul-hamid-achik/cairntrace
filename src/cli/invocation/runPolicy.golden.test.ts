import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { CommandRunner } from "../../core/runPolicy/cleanliness";
import { RunEventSchema } from "../../core/schema/events.v1";
import { executeRunInvocation } from "./executeRunInvocation";

/**
 * Golden `_invocations/<id>/events.ndjson` slices for the run policy (F8):
 * the run.lock.*, preflight.*, cleanliness.*, finally.* and invocation.bailed
 * events. Every line validates against the strict events.v1 producer schema,
 * and the normalized stream matches its fixture. Regenerate after an
 * intentional vocabulary change with:
 *
 *   UPDATE_EVENT_GOLDENS=1 bun run test -- src/cli/invocation/runPolicy.golden.test.ts
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
const POLICY_EVENT =
  /^(run\.lock\.|preflight\.|cleanliness\.|finally\.|invocation\.)/;

let dir: string;

const PASSING = `version: 1
name: golden_pass
intent: A mock run that passes.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;
const FAILING = PASSING.replace("golden_pass", "golden_fail").replace(
  'matches: "/home"',
  'matches: "/never"',
);

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-policy-golden-"));
  await writeFile(join(dir, "pass.yml"), PASSING);
  await writeFile(
    join(dir, "pass2.yml"),
    PASSING.replace("golden_pass", "golden_pass2"),
  );
  await writeFile(join(dir, "fail.yml"), FAILING);
  await writeFile(
    join(dir, "posture.json"),
    JSON.stringify({ mode: "durable" }),
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const FIELD_PLACEHOLDERS: Record<string, unknown> = {
  ts: "<ts>",
  path: "<lock path>",
  heldMs: 0,
  durationMs: 0,
  invocationId: "<invocationId>",
  outputTail: "<output>",
  message: "<message>",
  spec: "<spec>",
};

function normalize(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    out[key] = Object.hasOwn(FIELD_PLACEHOLDERS, key)
      ? FIELD_PLACEHOLDERS[key]
      : value;
  }
  return out;
}

async function scenario(
  name: string,
  config: string,
  specs: string[],
  options: Record<string, unknown>,
  runner: CommandRunner,
): Promise<Array<Record<string, unknown>>> {
  const configPath = join(dir, `${name}.config.yml`);
  await writeFile(
    configPath,
    `version: 1
project: golden-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
${config}`,
  );
  vi.stubEnv("CAIRN_GOLDEN_SECRET", "present");
  vi.stubEnv("CAIRN_VERIFY_CLEAN_GRACE_MS", "0");
  try {
    const result = await executeRunInvocation(
      {
        specs: specs.map((spec) => join(dir, spec)),
        options: {
          mock: true,
          config: configPath,
          artifactRoot: join(dir, `runs-${name}`),
          noWebServer: true,
          ...options,
        },
        cwd: dir,
      },
      {
        origin: "cli",
        runPolicyDeps: {
          lockRoot: join(dir, `locks-${name}`),
          ledgerRoot: join(dir, `ledger-${name}`),
          run: runner,
        },
      },
    );
    const text = await readFile(
      join(result.journalDir!, "events.ndjson"),
      "utf8",
    );
    return text
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as Record<string, unknown>)
      .filter((event) => POLICY_EVENT.test(String(event.type)));
  } finally {
    vi.unstubAllEnvs();
  }
}

async function check(name: string, events: Array<Record<string, unknown>>) {
  for (const event of events) {
    const parsed = RunEventSchema.safeParse(event);
    expect(
      parsed.success,
      `${JSON.stringify(event)}\n${parsed.success ? "" : parsed.error.message}`,
    ).toBe(true);
  }
  const normalized = events.map(normalize);
  const goldenPath = join(FIXTURE_DIR, `${name}.ndjson`);
  if (UPDATE || !existsSync(goldenPath)) {
    if (!UPDATE) {
      throw new Error(
        `missing golden ${goldenPath}; run with UPDATE_EVENT_GOLDENS=1`,
      );
    }
    await mkdir(FIXTURE_DIR, { recursive: true });
    await writeFile(
      goldenPath,
      `${normalized.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  }
  const golden = (await readFile(goldenPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(normalized).toEqual(golden);
  // The fixture itself stays schema-valid once its placeholders are real.
  for (const event of golden) {
    const candidate = {
      ...event,
      ...(event.ts === "<ts>" ? { ts: "2026-01-01T00:00:00.000Z" } : {}),
      ...(event.path === "<lock path>"
        ? { path: "/locks/example.run.lock.json" }
        : {}),
      ...(event.invocationId === "<invocationId>"
        ? { invocationId: "2026-01-01T00-00-00-000Z_1_abcdef" }
        : {}),
      ...(event.message === "<message>" ? { message: "refused" } : {}),
    };
    expect(
      RunEventSchema.safeParse(candidate).success,
      JSON.stringify(event),
    ).toBe(true);
  }
}

const cleanRunner: CommandRunner = () => ({
  status: 1,
  stdout: "",
  stderr: "",
});

describe("run policy event goldens", () => {
  it("run-policy-pass: lock, preflight, clean before/after, finally", async () => {
    const events = await scenario(
      "run-policy-pass",
      `run:
  lock: true
  preflight:
    - { json: posture.json, assert: ".mode == \\"durable\\"" }
    - { secret: CAIRN_GOLDEN_SECRET }
    - { command: "true" }
  verifyClean: [{ tmux: golden-session }]
  finally:
    - "true"
`,
      ["pass.yml"],
      {},
      cleanRunner,
    );
    await check("run-policy-pass", events);
  });

  it("run-policy-dirty-bail: bail, a dirty machine after the run, a failing belt", async () => {
    let call = 0;
    const events = await scenario(
      "run-policy-dirty-bail",
      `run:
  lock: true
  verifyClean: [{ tmux: golden-session }]
  finally:
    - "exit 3"
`,
      ["fail.yml", "pass.yml", "pass2.yml"],
      { bail: true },
      () => ({ status: call++ === 0 ? 1 : 0, stdout: "", stderr: "" }),
    );
    await check("run-policy-dirty-bail", events);
  });
});
