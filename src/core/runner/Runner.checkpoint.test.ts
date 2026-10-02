import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { InvocationResult } from "../../adapters/browserBackend";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { CheckpointStore } from "../checkpoint/CheckpointStore";
import { buildCheckpointMeta } from "../checkpoint/meta";
import { RunEventSchema } from "../schema/events.v1";
import { buildRunNextActions, RunResultSchema } from "../schema/run.v1";
import { runSpec, SESSION_RESUME_STEP } from "./Runner";

/**
 * Scoped checkpoints (A10): a `session.resume` checkpoint that is missing,
 * expired or captured for another origin fails the run AFTER preconditions
 * (which may create or refresh the state they resume) and before any
 * browser work; a failed `loadState` is a failed `session.resume` step,
 * never swallowed.
 */

class RecordingBackend extends MockBrowserBackend {
  readonly loaded: string[] = [];
  constructor(private readonly loadResult?: InvocationResult) {
    super();
  }
  override async loadState(path: string): Promise<InvocationResult> {
    this.loaded.push(path);
    return this.loadResult ?? super.loadState(path);
  }
}

let dir: string;
let store: CheckpointStore;
const BASE = "https://app.example.test";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-run-checkpoint-"));
  store = new CheckpointStore(join(dir, "checkpoints"));
  await store.ensureRoot();
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
environments:
  local:
    baseUrl: ${BASE}
  staging:
    baseUrl: https://staging.example.test
`,
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function capture(
  name: string,
  meta: Parameters<typeof buildCheckpointMeta>[0],
): Promise<void> {
  await writeFile(store.pathFor(name), '{"cookies":[],"origins":[]}');
  await store.writeMeta(store.pathFor(name), buildCheckpointMeta(meta));
}

async function writeSpec(resume: string, marker: string): Promise<string> {
  const specPath = join(dir, "spec.yml");
  await writeFile(
    specPath,
    `version: 1
name: resume_${resume.replace(/[^a-z0-9]/gi, "_").toLowerCase()}
intent: Signed-in flow restored from a checkpoint.
session: { resume: ${resume} }
preconditions:
  commands:
    - name: mutate
      run: 'touch "${marker}"'
steps:
  - open: /home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
  );
  return specPath;
}

async function events(runDir: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("session.resume scoping", () => {
  it("restores a scoped, fresh checkpoint for its origin", async () => {
    await capture("admin", {
      name: "admin",
      baseUrl: BASE,
      env: "local",
      ttl: "1h",
    });
    const marker = join(dir, "mutated");
    const backend = new RecordingBackend();
    const result = await runSpec({
      specPath: await writeSpec("admin", marker),
      backend,
      artifactRoot: join(dir, "runs"),
      checkpointStore: store,
      environmentOverride: "local",
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("passed");
    expect(backend.loaded).toEqual([store.pathFor("admin")]);
    expect(existsSync(marker)).toBe(true);
  });

  for (const scenario of [
    {
      name: "expired",
      setup: () =>
        capture("admin", {
          name: "admin",
          baseUrl: BASE,
          ttl: "1h",
          now: new Date("2020-01-01T00:00:00.000Z"),
        }),
      env: "local",
      expect: /expired at 2020-01-01T01:00:00\.000Z/,
    },
    {
      name: "captured for another origin",
      setup: () => capture("admin", { name: "admin", baseUrl: BASE }),
      env: "staging",
      expect:
        /captured for https:\/\/app\.example\.test .*targets https:\/\/staging\.example\.test/,
    },
    {
      name: "missing",
      setup: async () => undefined,
      env: "local",
      expect: /does not exist/,
    },
  ]) {
    it(`fails before the browser when the checkpoint is ${scenario.name}`, async () => {
      await scenario.setup();
      const marker = join(dir, "mutated");
      const backend = new RecordingBackend();
      const result = await runSpec({
        specPath: await writeSpec("admin", marker),
        backend,
        artifactRoot: join(dir, "runs"),
        checkpointStore: store,
        environmentOverride: scenario.env,
        heartbeatIntervalMs: 0,
      });
      expect(RunResultSchema.parse(result)).toMatchObject({
        status: "errored",
        exitCode: 2,
        failure: { phase: "session", name: "admin", step: SESSION_RESUME_STEP },
        steps: [{ id: SESSION_RESUME_STEP, status: "failed" }],
      });
      expect(result.failure?.message).toMatch(scenario.expect);
      // Preconditions ran (they may mint the state); nothing browser-side did.
      expect(existsSync(marker)).toBe(true);
      expect(backend.loaded).toEqual([]);
      expect(backend.stepLog).toEqual([]);
      expect(buildRunNextActions(result)[0]?.command).toBe(
        "cairn checkpoint list --json",
      );
      const stream = await events(result.runDir);
      for (const event of stream) RunEventSchema.parse(event);
      expect(
        stream.find(
          (e) => e.type === "step.failed" && e.stepId === SESSION_RESUME_STEP,
        ),
      ).toBeDefined();
      expect(stream.at(-1)).toMatchObject({
        type: "run.errored",
        phase: "session",
        name: "admin",
      });
    });
  }

  it("resumes a checkpoint that a precondition creates", async () => {
    const statePath = store.pathFor("minted");
    const specPath = join(dir, "mint.yml");
    await writeFile(
      specPath,
      `version: 1
name: resume_minted
intent: A precondition mints the session it resumes.
session: { resume: minted }
preconditions:
  commands:
    - name: mint
      run: 'printf "{}" > "${statePath}"'
steps:
  - open: /home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const backend = new RecordingBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot: join(dir, "runs"),
      checkpointStore: store,
      environmentOverride: "local",
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("passed");
    expect(backend.loaded).toEqual([statePath]);
  });

  it("resumes a state a precondition re-minted although its old sidecar expired", async () => {
    await capture("admin", {
      name: "admin",
      baseUrl: "https://elsewhere.example.test",
      ttl: "1h",
      now: new Date("2020-01-01T00:00:00.000Z"),
    });
    const statePath = store.pathFor("admin");
    const specPath = join(dir, "remint.yml");
    await writeFile(
      specPath,
      `version: 1
name: resume_reminted
intent: A precondition refreshes the session it resumes.
session: { resume: admin }
preconditions:
  commands:
    - name: remint
      run: 'printf "{\\"fresh\\":true}" > "${statePath}"'
steps:
  - open: /home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
    );
    const backend = new RecordingBackend();
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot: join(dir, "runs"),
      checkpointStore: store,
      environmentOverride: "local",
      heartbeatIntervalMs: 0,
    });
    // The rewritten state no longer matches the sidecar: unscoped, allowed.
    expect(result.status).toBe("passed");
    expect(await readFile(statePath, "utf8")).toBe('{"fresh":true}');
    expect(backend.loaded).toEqual([statePath]);
  });

  it("fails the session.resume step when loadState fails instead of swallowing it", async () => {
    await capture("admin", { name: "admin", baseUrl: BASE });
    const marker = join(dir, "mutated");
    const backend = new RecordingBackend({
      ok: false,
      stdout: "",
      stderr: "state file is corrupt",
      exitCode: 1,
      durationMs: 1,
      argv: ["state", "load"],
    });
    const result = await runSpec({
      specPath: await writeSpec("admin", marker),
      backend,
      artifactRoot: join(dir, "runs"),
      checkpointStore: store,
      environmentOverride: "local",
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("errored");
    expect(result.steps).toEqual([
      expect.objectContaining({
        id: SESSION_RESUME_STEP,
        status: "failed",
        error: expect.stringContaining("state file is corrupt"),
      }),
    ]);
    expect(result.failure).toMatchObject({
      phase: "session",
      step: SESSION_RESUME_STEP,
    });
    expect(result.failure?.brief).toBeUndefined();
    // Preconditions ran; no browser step ran without the session.
    expect(existsSync(marker)).toBe(true);
    expect(backend.stepLog).toEqual([]);
    const stream = await events(result.runDir);
    for (const event of stream) RunEventSchema.parse(event);
  });
});
