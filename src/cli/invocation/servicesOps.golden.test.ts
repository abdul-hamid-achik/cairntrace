import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createFakeTmux } from "../../testing/fakeTmux";
import { RunEventSchema } from "../../core/schema/events.v1";
import { restartTmuxWindows } from "../../core/runner/services";
import { executeRunInvocation } from "./executeRunInvocation";

/**
 * Golden `events.ndjson` slices for the service operations (F10, F12): the
 * services.provisioner / tunnel / files / seed.phase / restart events. Every
 * line validates against the strict events.v1 producer schema and the
 * normalized stream matches its fixture. Regenerate after an intentional
 * vocabulary change with:
 *
 *   UPDATE_EVENT_GOLDENS=1 bun run test -- src/cli/invocation/servicesOps.golden.test.ts
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
const SERVICES_EVENT = /^services\./;

let dir: string;

const SPEC = `version: 1
name: golden_ops
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
  dir = await mkdtemp(join(tmpdir(), "cairn-ops-golden-"));
  await writeFile(join(dir, "s.yml"), SPEC);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const PLACEHOLDERS: Record<string, unknown> = {
  ts: "<ts>",
  pid: 0,
  durationMs: 0,
  generation: "<generation>",
  uptimeMs: 0,
};

function normalize(value: unknown): unknown {
  // services.files fingerprints are keyed per process.
  if (typeof value === "string" && /^hmac-sha256:[0-9a-f]{16}$/.test(value)) {
    return "<fingerprint>";
  }
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        Object.hasOwn(PLACEHOLDERS, key) ? PLACEHOLDERS[key] : normalize(item),
      ]),
    );
  }
  return value;
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
  if (UPDATE) {
    await mkdir(FIXTURE_DIR, { recursive: true });
    await writeFile(
      goldenPath,
      `${normalized.map((event) => JSON.stringify(event)).join("\n")}\n`,
    );
  }
  if (!existsSync(goldenPath)) {
    throw new Error(
      `missing golden ${goldenPath}; run with UPDATE_EVENT_GOLDENS=1`,
    );
  }
  const golden = (await readFile(goldenPath, "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  expect(normalized).toEqual(golden);
  // The fixture stays schema-valid once its placeholders are real.
  for (const event of golden) {
    const candidate = JSON.parse(
      JSON.stringify(event)
        .replace('"<ts>"', '"2026-01-01T00:00:00.000Z"')
        .replace('"<generation>"', '"0a1b2c3d"'),
    );
    expect(
      RunEventSchema.safeParse(candidate).success,
      JSON.stringify(event),
    ).toBe(true);
  }
}

async function scenario(
  name: string,
  services: string,
  options: Record<string, unknown> = {},
) {
  const configPath = join(dir, `${name}.config.yml`);
  await writeFile(
    configPath,
    `version: 1
project: golden-ops
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
services:
${services}`,
  );
  const result = await executeRunInvocation(
    {
      specs: [join(dir, "s.yml")],
      options: {
        mock: true,
        config: configPath,
        artifactRoot: join(dir, `runs-${name}`),
        noWebServer: true,
        ...options,
      },
      cwd: dir,
    },
    { origin: "cli", allowServicesBoot: true } as never,
  );
  const text = await readFile(
    join(result.journalDir!, "events.ndjson"),
    "utf8",
  );
  const events = text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((event) => SERVICES_EVENT.test(String(event.type)));
  return { events, result };
}

describe("service operations event goldens", () => {
  beforeEach(() => {
    // Seed and tunnel state live under the hermetic HOME of the test worker.
  });

  it("services-ops-pass: provisioner, tunnel, files, seed phases, commit", async () => {
    const { events, result } = await scenario(
      "services-ops-pass",
      `  provisioner:
    up: "true"
    down: "true"
    exports:
      OPS_HOST: "echo 10.0.0.9"
  tunnels:
    - name: db
      command: "exec sleep 49"
  files:
    - path: generated.json
      json:
        host: "\${exports.OPS_HOST}"
  seed:
    commit: afterPostCommands
    target: golden
    phases:
      - name: import
        run: "echo imported"
    postCommands:
      - name: ensure
        run: "echo ensured"
      - name: other-env-only
        run: "echo never"
        when: { env: staging }
`,
    );
    expect(result.exitCode).toBe(0);
    expect(
      JSON.parse(await readFile(join(dir, "generated.json"), "utf8")),
    ).toEqual({
      host: "10.0.0.9",
    });
    await check("services-ops-pass", events);
  });

  it("services-ops-fail: a failed phase, the cleanup, and a failed critical down (exit 8)", async () => {
    const { events, result } = await scenario(
      "services-ops-fail",
      `  provisioner:
    up: "true"
    down: "exit 3"
  seed:
    phases:
      - name: import
        run: "echo broken; exit 1"
`,
    );
    expect(result.exitCode).toBe(8);
    await check("services-ops-fail", events);
  });

  it("services-restart: restart, give-up and unhealthy vocabulary", async () => {
    const fake = createFakeTmux();
    const undo = fake.activate();
    try {
      fake.seedRunning("golden", ["web"]);
      fake.setPane("golden", "web", "old\n");
      fake.setOutput("golden", "web", "listening on 3000\n");
      const collected: Array<Record<string, unknown>> = [];
      const toEvent = (e: {
        phase: string;
        event: string;
        message: string;
        timestamp: string;
        data?: Record<string, unknown>;
      }) =>
        collected.push({
          ts: e.timestamp,
          type: `services.${e.phase}.${e.event}`,
          message: e.message,
          ...(e.data ? { data: e.data } : {}),
        });
      const report = await restartTmuxWindows(
        {
          session: "golden",
          windows: [
            {
              name: "web",
              command: "run-web",
              readyOn: { text: "listening on 3000" },
            },
          ],
        },
        {
          configDir: dir,
          project: "golden-ops",
          onEvent: toEvent,
        },
        ["web"],
        { stopTimeoutMs: 5_000, reason: "manual" },
      );
      expect(report.results[0]?.ok).toBe(true);
      // The vocabulary a supervisor adds.
      toEvent({
        phase: "restart",
        event: "giveup",
        message: '"web" gave up after 3 restarts',
        timestamp: new Date().toISOString(),
        data: { window: "web", reason: "exited", restarts: 3 },
      });
      toEvent({
        phase: "tunnel",
        event: "giveup",
        message: 'tunnel "db" gave up after 5 restarts',
        timestamp: new Date().toISOString(),
        data: { tunnel: "db", restarts: 5 },
      });
      await check("services-restart", collected);
    } finally {
      undo();
      fake.cleanup();
    }
  }, 30_000);
});
