import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { renderAgentContext } from "../artifacts/agentContext";
import type { RunResult } from "../schema/run.v1";
import type { Spec } from "../schema/spec.v1";
import { aggregateRunStats } from "../stats/runStats";
import { RunResultSchema } from "../schema/run.v1";
import { runSpec } from "./Runner";

let root: string | undefined;

afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true });
  root = undefined;
});

async function makeRoot(): Promise<string> {
  root = await mkdtemp(join(tmpdir(), "cairntrace-run-boundary-"));
  return root;
}

describe("run artifact boundaries", () => {
  it("does not call an empty outcome set passed even on a nominal run", () => {
    const spec: Spec = {
      version: 1,
      name: "empty_contract",
      intent: "an empty contract is not passing evidence",
      mode: "normal",
      outcomes: [],
    };
    const result: RunResult = {
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId: "empty_contract_run",
      runDir: "/tmp/empty_contract_run",
      spec: { name: spec.name, path: "/tmp/empty-contract.yml" },
      environment: "local",
      backend: "mock",
      coldStart: false,
      status: "passed",
      summary: "0/0 outcomes passed",
      startedAt: "2026-01-01T00:00:00.000Z",
      endedAt: "2026-01-01T00:00:00.000Z",
      durationMs: 0,
      outcomes: [],
      steps: [],
      artifacts: {
        agentContext: "agent_context.md",
        events: "events.ndjson",
      },
      exitCode: 0,
    };

    const context = renderAgentContext(spec, result);
    expect(context).toContain("No outcomes were evaluated");
    expect(context).not.toContain("All outcomes passed");
  });

  it("redacts dynamic credential headers before console/network NDJSON serialization", async () => {
    const dir = await makeRoot();
    const artifactRoot = join(dir, "runs");
    const specPath = join(dir, "redaction.yml");
    await writeFile(
      specPath,
      `version: 1
name: structured_redaction
intent: captured structured headers never expose credentials
coldStart: guest
outcomes:
  - id: ok
    description: mock console remains usable
    verify: { console: { errorsMax: 0 } }
steps: []
`,
    );

    class CapturedEntryBackend extends MockBrowserBackend {
      override async clearNetworkLog(): Promise<void> {}
      override async clearConsole(): Promise<void> {}
    }
    const backend = new CapturedEntryBackend();
    backend.pushConsoleEntry({
      type: "log",
      text: "request captured",
      headers: {
        Authorization: "dynamic-auth-value",
        Cookie: "dynamic-cookie-value",
      },
    });
    backend.pushNetworkEntry({
      url: "https://example.test/private",
      method: "GET",
      status: 200,
      requestHeaders: {
        Authorization: "dynamic-network-auth-value",
        Cookie: "dynamic-network-cookie-value",
      },
      responseHeaders: { "Set-Cookie": "dynamic-response-cookie-value" },
    });

    const result = await runSpec({ specPath, backend, artifactRoot });
    const consoleRaw = await readFile(
      join(result.runDir, "console/console.ndjson"),
      "utf8",
    );
    const networkRaw = await readFile(
      join(result.runDir, "network/requests.ndjson"),
      "utf8",
    );

    expect(`${consoleRaw}${networkRaw}`).not.toContain("dynamic-");
    expect(JSON.parse(consoleRaw).headers).toEqual({
      Authorization: "[redacted]",
      Cookie: "[redacted]",
    });
    expect(JSON.parse(networkRaw)).toMatchObject({
      requestHeaders: {
        Authorization: "[redacted]",
        Cookie: "[redacted]",
      },
      responseHeaders: { "Set-Cookie": "[redacted]" },
    });
  });

  it("persists a timed-out precondition as its real run and includes it in stats", async () => {
    const dir = await makeRoot();
    const artifactRoot = join(dir, "runs");
    await mkdir(join(dir, "project"), { recursive: true });
    const projectDir = join(dir, "project");
    await writeFile(
      join(projectDir, "cairntrace.config.yml"),
      `version: 1
defaultEnvironment: remote
environments:
  remote: {}
retention:
  keepRuns: 1
  keepFailedRuns: 0
`,
    );
    const specPath = join(projectDir, "timeout.yml");
    await writeFile(
      specPath,
      `version: 1
name: real_precondition_timeout
intent: precondition deadlines remain durable run evidence
preconditions:
  commands:
    - name: readiness_gate
      run: sleep 1
      timeoutMs: 20
outcomes:
  - id: never
    description: browser work does not begin
    verify: { console: { errorsMax: 0 } }
steps: []
`,
    );

    let finishDetails: { timedOut?: boolean; signal?: string } | undefined;
    const runOptions = {
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot,
      labels: { path: "timeout" },
      listener: {
        onPreconditionFinish(
          _name: string,
          _exitCode: number | undefined,
          _durationMs: number,
          details?: { timedOut?: boolean; signal?: string },
        ) {
          finishDetails = details;
        },
      },
    };
    const result = await runSpec(runOptions);

    expect(RunResultSchema.parse(result)).toMatchObject({
      runId: expect.stringContaining("real_precondition_timeout"),
      runDir: expect.stringContaining(artifactRoot),
      environment: "remote",
      backend: "mock",
      status: "errored",
      failure: {
        phase: "precondition",
        name: "readiness_gate",
        timedOut: true,
        signal: "SIGKILL",
      },
      steps: [],
      exitCode: 2,
    });
    expect(result.durationMs).toBeGreaterThan(0);
    expect(result.failure?.durationMs).toBeGreaterThan(0);
    expect(finishDetails).toEqual({ timedOut: true, signal: "SIGKILL" });
    const events = (
      await readFile(join(result.runDir, "events.ndjson"), "utf8")
    )
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "precondition.run",
          name: "readiness_gate",
          timedOut: true,
          signal: "SIGKILL",
        }),
        expect.objectContaining({
          type: "run.errored",
          phase: "precondition",
          name: "readiness_gate",
          timedOut: true,
          signal: "SIGKILL",
        }),
      ]),
    );
    expect(
      JSON.parse(await readFile(join(result.runDir, "run.json"), "utf8")),
    ).toMatchObject({ runId: result.runId, status: "errored" });
    await expect(
      readFile(join(result.runDir, "report.json"), "utf8"),
    ).resolves.toContain('"status": "errored"');
    const agentContext = await readFile(
      join(result.runDir, "agent_context.md"),
      "utf8",
    );
    expect(agentContext).toContain(
      'Not evaluated — precondition "readiness_gate" timed out',
    );
    expect(agentContext).not.toContain("All outcomes passed");
    await expect(
      readFile(join(result.runDir, "artifact-manifest.json"), "utf8"),
    ).resolves.toContain('"path": "run.json"');

    const stats = await aggregateRunStats({
      artifactRoot,
      groupBy: "path",
      includeRuns: true,
    });
    expect(stats).toMatchObject({
      matched: 1,
      groups: [{ key: "timeout", runs: 1, errored: 1 }],
      runs: [{ runId: result.runId, status: "errored" }],
    });

    const second = await runSpec({
      ...runOptions,
      backend: new MockBrowserBackend(),
    });
    expect(await readdir(artifactRoot)).toEqual([second.runId]);
  });

  it("passes only the invocation-scoped target environment to Node verifiers", async () => {
    const dir = await makeRoot();
    const artifactRoot = join(dir, "runs");
    const specPath = join(dir, "node-env.yml");
    await writeFile(
      specPath,
      `version: 1
name: scoped_node_verifier_env
intent: node verifiers receive the selected invocation environment only
coldStart: guest
outcomes:
  - id: scoped
    description: scoped target values are present and controls are absent
    verify:
      script:
        runtime: node
        run: |
          return {
            ok: process.env.MONGO_URI === "scoped-mongo" &&
              process.env.TVAULT_SELECTED === "selected-value" &&
              process.env.TVAULT_CONTROL === undefined &&
              process.env.FILECHEAP_INGEST_TOKEN === undefined &&
              ctx.childEnv === undefined &&
              ctx.selectedTvaultKeys === undefined,
            evidence: "environment boundary checked",
          };
steps: []
`,
    );

    const result = await runSpec({
      specPath,
      backend: new MockBrowserBackend(),
      artifactRoot,
      env: { PATH: process.env.PATH },
      childEnv: {
        PATH: process.env.PATH,
        MONGO_URI: "scoped-mongo",
        TVAULT_SELECTED: "selected-value",
        TVAULT_CONTROL: "must-not-cross",
        FILECHEAP_INGEST_TOKEN: "publisher-only",
      },
      selectedTvaultKeys: ["TVAULT_SELECTED"],
    });

    expect(result.status).toBe("passed");
    expect(result.outcomes).toEqual([
      expect.objectContaining({ id: "scoped", status: "passed" }),
    ]);
  });
});
