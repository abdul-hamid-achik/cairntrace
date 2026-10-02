import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { InvocationResult } from "../../adapters/browserBackend";
import { runSpec, type RunOptions } from "../runner/Runner";
import type { ServicesEvent } from "../runner/services";
import type { Step } from "./spec.v1";
import {
  RunEventSchema,
  ServicesEventTypeSchema,
  isServicesEventType,
} from "./events.v1";

/**
 * Golden events.ndjson streams for the canonical run shapes. The normalized
 * fixtures under __fixtures__/events/ are a cross-lane contract: Studio's
 * event describer is tested against them. Regenerate after an intentional
 * vocabulary change with:
 *
 *   UPDATE_EVENT_GOLDENS=1 bun run test -- src/core/schema/events.v1.test.ts
 */
const FIXTURE_DIR = join(import.meta.dirname, "__fixtures__", "events");
const UPDATE = process.env.UPDATE_EVENT_GOLDENS === "1";

/** Fails the Nth runStep call (1-based) with an agent-browser-like error. */
class FailOnNthStepBackend extends MockBrowserBackend {
  private calls = 0;
  constructor(private readonly failAt: number) {
    super();
  }
  override async runStep(step: Step): Promise<InvocationResult> {
    this.calls += 1;
    if (this.calls === this.failAt) {
      this.failNextStep('no visible element matches role=button "Save"');
    }
    return super.runStep(step);
  }
}

interface Scenario {
  name: string;
  spec: string;
  backend: () => MockBrowserBackend;
  servicesEvents?: ServicesEvent[];
}

const SERVICES_EVENTS: ServicesEvent[] = [
  {
    phase: "docker",
    event: "start",
    message: "docker: starting",
    timestamp: "2026-01-01T00:00:00.000Z",
  },
  {
    phase: "docker",
    event: "ready",
    message: "docker: ready",
    timestamp: "2026-01-01T00:00:01.000Z",
    data: { reused: false },
  },
];

const SCENARIOS: Scenario[] = [
  {
    name: "pass",
    spec: `version: 1
name: demo_save_profile
intent: A signed-in user saves the profile form.
coldStart: guest
viewport: { width: 1280, height: 720 }
preconditions:
  commands:
    - name: seed_check
      run: echo ready
      timeoutMs: 30000
steps:
  - id: open_profile
    open: https://demo.example.test/profile?session=abc
  - fill: { by: label, name: Email, value: user@example.test }
  - click: { by: role, role: button, name: Save }
outcomes:
  - id: on_profile
    description: The profile page stays open.
    verify: { url: { matches: "/profile" } }
  - id: saved_banner
    description: The saved confirmation is visible.
    verify: { text: { contains: Saved } }
`,
    backend: () => {
      const backend = new MockBrowserBackend();
      backend.setPageText("Profile Saved");
      return backend;
    },
    servicesEvents: SERVICES_EVENTS,
  },
  {
    name: "step-fail",
    spec: `version: 1
name: demo_step_fail
intent: The save button is missing, so the run stops at the click.
coldStart: guest
steps:
  - id: open_profile
    open: https://demo.example.test/profile
  - id: save
    click: { by: role, role: button, name: Save }
  - id: never_runs
    wait: { text: Saved }
outcomes:
  - id: on_profile
    description: The profile page stays open.
    verify: { url: { matches: "/profile" } }
`,
    backend: () => new FailOnNthStepBackend(2),
  },
  {
    name: "when-skip",
    spec: `version: 1
name: demo_when_skip
intent: The optional cookie banner is dismissed only when present.
coldStart: guest
steps:
  - open: https://demo.example.test/home
  - id: dismiss_banner
    when: "text:Accept cookies"
    click: { by: role, role: button, name: Accept }
  - id: settle
    wait: { ms: 10 }
outcomes:
  - id: home
    description: The home page is open.
    verify: { url: { matches: "/home" } }
`,
    backend: () => {
      const backend = new MockBrowserBackend();
      backend.setPageText("Welcome home");
      return backend;
    },
  },
  {
    name: "precondition-fail",
    spec: `version: 1
name: demo_precondition_fail
intent: A failing data guard stops the run before the browser.
coldStart: guest
preconditions:
  commands:
    - name: data_guard
      run: "echo checking fixtures; echo fatal: fixture database unreachable; exit 3"
      timeoutMs: 30000
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: The home page is open.
    verify: { url: { matches: "/home" } }
`,
    backend: () => new MockBrowserBackend(),
  },
  {
    name: "outcome-fail",
    spec: `version: 1
name: demo_outcome_fail
intent: The page opens but the welcome copy regressed.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: welcome_copy
    description: The welcome copy is visible.
    verify: { text: { contains: Welcome back } }
  - id: home
    description: The home page is open.
    verify: { url: { matches: "/home" } }
`,
    backend: () => {
      const backend = new MockBrowserBackend();
      backend.setPageText("Hello there");
      return backend;
    },
  },
  {
    name: "script-progress",
    spec: `version: 1
name: demo_script_progress
intent: A long verifier and a setup command report progress while they run.
coldStart: guest
preconditions:
  commands:
    - name: quiesce
      run: 'echo waiting; echo 3/9 queues idle >> "$CAIRN_PROGRESS_FILE"; echo settled'
      timeoutMs: 30000
steps:
  - open: https://demo.example.test/tasks
outcomes:
  - id: tasks_terminal
    description: Every task reached a terminal state.
    verify:
      script:
        runtime: node
        run: |
          console.log("polling tasks");
          ctx.progress("47/120 tasks terminal");
          ctx.progress("120/120 tasks terminal");
          return { ok: true, evidence: { terminal: 120 } };
`,
    backend: () => new MockBrowserBackend(),
  },
];

async function runScenario(
  scenario: Scenario,
): Promise<Record<string, unknown>[]> {
  const workDir = await mkdtemp(
    join(tmpdir(), `cairn-events-${scenario.name}-`),
  );
  const specPath = join(workDir, `${scenario.name}.yml`);
  await writeFile(specPath, scenario.spec);
  const options: RunOptions = {
    specPath,
    backend: scenario.backend(),
    artifactRoot: join(workDir, "runs"),
    env: { PATH: process.env.PATH },
    // Goldens must not depend on wall time: no heartbeats here (covered by
    // the Runner observability tests with a short interval).
    heartbeatIntervalMs: 0,
    ...(scenario.servicesEvents
      ? { servicesEvents: scenario.servicesEvents }
      : {}),
  };
  const result = await runSpec(options);
  const raw = await readFile(join(result.runDir, "events.ndjson"), "utf8");
  return raw
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** Replace wall-clock and run-identity values with stable placeholders. */
function normalize(event: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...event };
  if (typeof out.type === "string" && !out.type.startsWith("services.")) {
    out.ts = "<ts>";
  }
  if ("runId" in out) out.runId = "<runId>";
  if ("durationMs" in out) out.durationMs = 0;
  if ("elapsedMs" in out) out.elapsedMs = 0;
  if ("runElapsedMs" in out) out.runElapsedMs = 0;
  if ("deadline" in out) out.deadline = "<ts>";
  if ("pid" in out) out.pid = 0;
  return out;
}

describe("events.v1 schema", () => {
  for (const scenario of SCENARIOS) {
    it(`validates every event of the ${scenario.name} run and matches its golden`, async () => {
      const events = await runScenario(scenario);
      for (const event of events) {
        const parsed = RunEventSchema.safeParse(event);
        expect(
          parsed.success,
          `${JSON.stringify(event)}\n${
            parsed.success ? "" : parsed.error.message
          }`,
        ).toBe(true);
      }

      const normalized = events.map(normalize);
      const goldenPath = join(FIXTURE_DIR, `${scenario.name}.ndjson`);
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
    });
  }

  it("keeps the golden fixtures schema-valid", async () => {
    for (const scenario of SCENARIOS) {
      const lines = (
        await readFile(join(FIXTURE_DIR, `${scenario.name}.ndjson`), "utf8")
      )
        .trim()
        .split("\n");
      for (const line of lines) {
        const event = JSON.parse(line) as Record<string, unknown>;
        // Placeholders are not ISO timestamps; restore one for validation.
        const candidate = {
          ...event,
          ts:
            event.ts === "<ts>" ? "2026-01-01T00:00:00.000Z" : (event.ts ?? ""),
          ...(event.deadline === "<ts>"
            ? { deadline: "2026-01-01T00:00:30.000Z" }
            : {}),
          ...(event.pid === 0 ? { pid: 1 } : {}),
        };
        expect(RunEventSchema.safeParse(candidate).success, line).toBe(true);
      }
    }
  });

  it("rejects unknown fields and unknown types (producer strictness)", () => {
    expect(
      RunEventSchema.safeParse({
        ts: "2026-01-01T00:00:00.000Z",
        type: "step.started",
        stepId: "s1",
        surprise: true,
      }).success,
    ).toBe(false);
    expect(
      RunEventSchema.safeParse({
        ts: "2026-01-01T00:00:00.000Z",
        type: "step.teleported",
        stepId: "s1",
      }).success,
    ).toBe(false);
  });

  it("accepts the new lifecycle events of the v1 contract", () => {
    const ts = "2026-01-01T00:00:00.000Z";
    const samples = [
      {
        ts,
        type: "phase.changed",
        phase: "preconditions",
        item: "quiesce",
        budgetMs: 1_500_000,
        deadline: "2026-01-01T00:25:00.000Z",
      },
      {
        ts,
        type: "run.heartbeat",
        phase: "outcomes",
        item: "tasks_terminal",
        elapsedMs: 15_000,
        budgetMs: 300_000,
        runElapsedMs: 90_000,
        pid: 4242,
      },
      { ts, type: "outcome.started", outcomeId: "o1", kind: "script" },
      { ts, type: "outcome.progress", outcomeId: "o1", message: "47/120" },
      {
        ts,
        type: "log.opened",
        kind: "precondition",
        name: "quiesce",
        path: "logs/precondition-01-quiesce.log",
      },
      { ts, type: "precondition.progress", name: "quiesce", message: "3/9" },
      {
        ts,
        type: "hook.started",
        hook: "before",
        index: 1,
        command: "tools/flip.sh [redacted]",
        logPath: "logs/hook-before-01.log",
      },
      {
        ts,
        type: "hook.finished",
        hook: "before",
        index: 1,
        exitCode: 0,
        durationMs: 120,
        outputTail: "ok",
      },
      {
        ts,
        type: "invocation.started",
        invocationId: "2026-01-01T00-00-00-000Z_4242_a1b2c3",
        planned: 4,
      },
      {
        ts,
        type: "invocation.finished",
        invocationId: "2026-01-01T00-00-00-000Z_4242_a1b2c3",
        status: "aborted",
      },
      {
        ts,
        type: "run.started",
        runId: "demo-2026",
        spec: "demo",
        invocation: {
          id: "2026-01-01T00-00-00-000Z_4242_a1b2c3",
          index: 2,
          total: 4,
          dir: "_invocations/2026-01-01T00-00-00-000Z_4242_a1b2c3",
        },
      },
      {
        ts,
        type: "step.failed",
        stepId: "save",
        durationMs: 10,
        error: "boom",
        url: "https://demo.example.test/profile",
        screenshot: "screenshots/002_save.png",
      },
    ];
    for (const sample of samples) {
      const parsed = RunEventSchema.safeParse(sample);
      expect(
        parsed.success,
        `${sample.type}: ${parsed.success ? "" : parsed.error.message}`,
      ).toBe(true);
    }
  });

  it("covers every services.<phase>.<event> pairing services.ts can emit", async () => {
    const source = await readFile(
      join(import.meta.dirname, "..", "runner", "services.ts"),
      "utf8",
    );
    const emitted = new Set<string>();
    for (const match of source.matchAll(/emit\(\s*"(\w+)",\s*"([\w-]+)"/g)) {
      emitted.add(`services.${match[1]}.${match[2]}`);
    }
    expect(emitted.size).toBeGreaterThan(10);
    for (const type of emitted) {
      expect(isServicesEventType(type), type).toBe(true);
    }
    // Every emit site passes literals, so the scan is exhaustive.
    expect(source).not.toMatch(/emit\(\s*[a-z]\w*\s*,/);
    expect(ServicesEventTypeSchema.options).toContain(
      "services.stash.complete",
    );
  });
});
