import { mkdir, mkdtemp, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BriefDocumentSchema } from "../../core/schema/brief.v1";
import { exportOneBrief } from "./exportBrief";

describe("exportOneBrief", () => {
  it("stdout json is a valid BriefDocument", async () => {
    const { document, markdown } = await exportOneBrief(
      "examples/flows/01-dashboard-nav.yml",
      {},
    );
    expect(BriefDocumentSchema.parse(document).spec.name).toBe("dashboard_nav");
    expect(document.steps.some((s) => s.action === "click")).toBe(true);
    expect(markdown).toContain("# Brief: dashboard_nav");
  });

  it("attaches seenLocally from --from-run", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "cairn-brief-run-"));
    await writeFile(
      join(runDir, "run.json"),
      JSON.stringify({
        $schema: "urn:cairntrace.dev:run:v1",
        version: "1",
        runId: "run-from-test",
        runDir,
        spec: {
          name: "dashboard_nav",
          path: "/tmp/01-dashboard-nav.yml",
        },
        environment: "local",
        backend: "mock",
        coldStart: false,
        status: "passed",
        summary: "3/3 outcomes passed",
        startedAt: "2026-01-01T00:00:00.000Z",
        endedAt: "2026-01-01T00:00:01.000Z",
        durationMs: 1000,
        outcomes: [],
        steps: [
          {
            id: "click_open_dashboard",
            status: "passed",
            durationMs: 10,
            resolved: { role: "link", name: "Open dashboard" },
          },
        ],
        artifacts: {
          agentContext: "agent_context.md",
          events: "events.ndjson",
        },
        exitCode: 0,
      }),
    );

    const { document } = await exportOneBrief(
      "examples/flows/01-dashboard-nav.yml",
      { fromRun: runDir, artifactRoot: runDir },
    );
    expect(document.fromRun?.runId).toBe("run-from-test");
    expect(
      document.steps.find((s) => s.id === "click_open_dashboard")?.seenLocally,
    ).toEqual({ role: "link", name: "Open dashboard" });
  });

  it("does not inline ${env.PASSWORD} when PASSWORD is set", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-brief-secret-"));
    const specPath = join(dir, "login.yml");
    await writeFile(
      specPath,
      `version: 1
name: secret_login
intent: sign in
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: fill_password
    fill:
      by: label
      name: Password
      value: "\${env.PASSWORD}"
`,
    );
    const previous = process.env.PASSWORD;
    process.env.PASSWORD = "hunter2";
    try {
      const { document } = await exportOneBrief(specPath, {});
      const step = document.steps.find((s) => s.id === "fill_password")!;
      expect(step.value).toEqual({ kind: "secret", name: "PASSWORD" });
      expect(JSON.stringify(document)).not.toContain("hunter2");
    } finally {
      if (previous === undefined) delete process.env.PASSWORD;
      else process.env.PASSWORD = previous;
    }
  });

  it("--from-run latest skips a newer run from another spec", async () => {
    const root = await mkdtemp(join(tmpdir(), "cairn-brief-runs-"));
    const other = join(root, "other_run");
    const mine = join(root, "mine_run");
    await mkdir(other);
    await mkdir(mine);
    const runJson = (
      runId: string,
      runDir: string,
      name: string,
      path: string,
    ) => ({
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId,
      runDir,
      spec: { name, path },
      environment: "local",
      backend: "mock",
      coldStart: false,
      status: "passed",
      summary: "ok",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:01.000Z",
      durationMs: 1000,
      outcomes: [],
      steps: [
        {
          id: "click_open_dashboard",
          status: "passed",
          durationMs: 10,
          resolved: { role: "link", name: name },
        },
      ],
      artifacts: { agentContext: "agent_context.md", events: "events.ndjson" },
      exitCode: 0,
    });
    await writeFile(
      join(other, "run.json"),
      JSON.stringify(runJson("other", other, "other_spec", "/tmp/other.yml")),
    );
    await writeFile(
      join(mine, "run.json"),
      JSON.stringify(
        runJson(
          "mine",
          mine,
          "dashboard_nav",
          "/Users/abdulachik/projects/cairntrace/examples/flows/01-dashboard-nav.yml",
        ),
      ),
    );
    await utimes(other, new Date("2026-02-01"), new Date("2026-02-01"));
    await utimes(mine, new Date("2026-01-01"), new Date("2026-01-01"));

    const { document } = await exportOneBrief(
      "examples/flows/01-dashboard-nav.yml",
      { fromRun: "latest", artifactRoot: root },
    );
    expect(document.fromRun?.runId).toBe("mine");
    expect(
      document.steps.find((s) => s.id === "click_open_dashboard")?.seenLocally
        ?.name,
    ).toBe("dashboard_nav");
  });

  it("expands imported use: actions instead of skipping them", async () => {
    const { document } = await exportOneBrief(
      "examples/flows/09-imported-drift.yml",
      {},
    );
    expect(document.steps.some((s) => s.action === "machine")).toBe(false);
    expect(document.steps.map((s) => s.id)).toEqual([
      "open_home",
      "click_link",
    ]);
    expect(document.steps.find((s) => s.id === "click_link")?.action).toBe(
      "click",
    );
  });

  it("does not inline a config var interpolated from ${env.PASSWORD}", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-brief-var-"));
    const specPath = join(dir, "login.yml");
    const configPath = join(dir, "cairntrace.config.yml");
    await writeFile(
      configPath,
      `version: 1
defaultEnvironment: local
environments:
  local:
    vars:
      admin_password: "\${env.PASSWORD}"
`,
    );
    await writeFile(
      specPath,
      `version: 1
name: config_var_login
intent: sign in
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: fill_password
    fill:
      by: label
      name: Password
      value: "\${vars.admin_password}"
`,
    );
    const previous = process.env.PASSWORD;
    process.env.PASSWORD = "hunter2";
    try {
      const { document } = await exportOneBrief(specPath, {
        config: configPath,
      });
      const step = document.steps.find((s) => s.id === "fill_password")!;
      expect(step.value).toEqual({ kind: "secret", name: "PASSWORD" });
      expect(JSON.stringify(document)).not.toContain("hunter2");
    } finally {
      if (previous === undefined) delete process.env.PASSWORD;
      else process.env.PASSWORD = previous;
    }
  });

  it("does not inline ${env.DATABASE_URL}", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-brief-db-"));
    const specPath = join(dir, "login.yml");
    await writeFile(
      specPath,
      `version: 1
name: db_url_fill
intent: fill a connection string
coldStart: guest
outcomes:
  - id: ok
    description: ok
    verify: { console: { errorsMax: 0 } }
steps:
  - id: fill_dsn
    fill:
      by: label
      name: DSN
      value: "\${env.DATABASE_URL}"
`,
    );
    const previous = process.env.DATABASE_URL;
    process.env.DATABASE_URL = "postgres://user:hunter2@localhost/app";
    try {
      const { document } = await exportOneBrief(specPath, {});
      const step = document.steps.find((s) => s.id === "fill_dsn")!;
      expect(step.value).toEqual({ kind: "secret", name: "DATABASE_URL" });
      expect(JSON.stringify(document)).not.toContain("hunter2");
      expect(JSON.stringify(document)).not.toContain("postgres://");
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});
