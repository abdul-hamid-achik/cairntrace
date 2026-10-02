import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { RunFixtureLedgerSchema } from "../fixtures/schema";
import { FixtureHost } from "../fixtures/runtime";
import { RunEventSchema } from "../schema/events.v1";
import { RunResultSchema } from "../schema/run.v1";
import { runSpec } from "./Runner";

/**
 * F3b in the runner: a spec's `fixtures:` are ensured after the
 * preconditions, spliced as ${fixtures.<name>.<key>} into steps, teardown
 * and verifiers, recorded in <runDir>/fixtures.json, and torn down after the
 * spec teardown on every exit path (pass, failure, cancel, SIGTERM).
 */

let dir: string;
let log: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-run-fixtures-"));
  log = join(dir, "fixture.log");
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

type Event = Record<string, unknown> & { type: string };

async function events(runDir: string): Promise<Event[]> {
  const stream = (await readFile(join(runDir, "events.ndjson"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as Event);
  for (const event of stream) RunEventSchema.parse(event);
  return stream;
}

async function lines(path: string): Promise<string[]> {
  return existsSync(path)
    ? (await readFile(path, "utf8")).trim().split("\n").filter(Boolean)
    : [];
}

function config(extra = ""): string {
  return `version: 1
project: fixturedemo
defaultEnvironment: local
environments:
  local: {}
  shared:
    policy: { trait: shared }
fixtures:
  tenant:
    kind: exec
    ensure: 'echo "ensure tenant" >> "${log}"; echo "{\\"id\\":\\"t-1\\"}"'
    teardown: 'echo "teardown tenant $CAIRN_RUN_STATUS" >> "${log}"'
    outputs: { id: "$.id" }
  kit:
    kind: exec
    needs: [tenant]
    with: { label: demo }
    ensure:
      shell: 'echo "ensure kit $1" >> "${log}"; echo "{\\"kitId\\":\\"k-$1\\"}"'
      args: ["\${fixtures.tenant.id}"]
    reset: 'echo "reset kit" >> "${log}"'
    teardown: 'echo "teardown kit \${fixtures.kit.kitId}" >> "${log}"'
    outputs: { kitId: "$.kitId", label: "\${with.label}" }
${extra}`;
}

async function setup(spec: string, cfg = config()): Promise<string> {
  await writeFile(join(dir, "cairntrace.config.yml"), cfg);
  const specPath = join(dir, "spec.yml");
  await writeFile(specPath, spec);
  return specPath;
}

async function run(
  spec: string,
  extra: Partial<Parameters<typeof runSpec>[0]> = {},
  cfg?: string,
) {
  const specPath = await setup(spec, cfg);
  const backend = new MockBrowserBackend();
  const result = await runSpec({
    specPath,
    backend,
    artifactRoot: join(dir, "runs"),
    heartbeatIntervalMs: 0,
    ...extra,
  });
  return { result, backend };
}

const SPEC_HEAD = `version: 1
name: fixture_flow
intent: A flow that runs against declared fixtures.
coldStart: guest
`;

const PLAIN_OUTCOME = `outcomes:
  - id: page_ok
    description: nothing to check
    verify: { value: { actual: 1, expect: { $: 1 } } }
`;

const KIT_OUTCOME = `outcomes:
  - id: kit_is_seeded
    description: the kit output is what the flow opened
    verify:
      value:
        actual: "\${fixtures.kit.kitId}"
        expect: { $: k-t-1 }
`;

describe("runner fixtures", () => {
  it("ensures needs first, splices outputs into steps/verifiers and tears down after the spec teardown", async () => {
    const { result, backend } = await run(`${SPEC_HEAD}fixtures:
  - kit.reset
steps:
  - open: https://demo.example.test/kits/\${fixtures.kit.kitId}?label=\${fixtures.kit.label}
teardown:
  - run: 'echo "spec teardown" >> "${log}"'
${KIT_OUTCOME}`);
    expect(RunResultSchema.parse(result)).toMatchObject({ status: "passed" });
    expect(backend.stepLog).toEqual([
      expect.objectContaining({
        open: "https://demo.example.test/kits/k-t-1?label=demo",
      }),
    ]);
    expect(await lines(log)).toEqual([
      "ensure tenant",
      "ensure kit t-1",
      "reset kit",
      "spec teardown",
      "teardown kit k-t-1",
      "teardown tenant passed",
    ]);
    const stream = await events(result.runDir);
    const fixtureEvents = stream.filter((e) => e.type.startsWith("fixture."));
    expect(fixtureEvents.map((e) => `${e.type}:${e.name}:${e.status}`)).toEqual(
      [
        "fixture.ensure:tenant:ok",
        "fixture.ensure:kit:ok",
        "fixture.reset:kit:ok",
        "fixture.teardown:kit:ok",
        "fixture.teardown:tenant:ok",
      ],
    );
    expect(fixtureEvents[1]).toMatchObject({
      adapter: "exec",
      scope: "run",
      outputs: { kitId: "k-t-1", label: "demo" },
    });
    expect(stream).toContainEqual(
      expect.objectContaining({
        type: "phase.changed",
        phase: "preconditions",
        item: "fixture ensure kit",
      }),
    );
    const ledger = RunFixtureLedgerSchema.parse(
      JSON.parse(await readFile(join(result.runDir, "fixtures.json"), "utf8")),
    );
    expect(
      ledger.entries.map((e) => [e.name, e.status, e.teardown?.status]),
    ).toEqual([
      ["tenant", "ok", "ok"],
      ["kit", "ok", "ok"],
    ]);
    const manifest = await readFile(
      join(result.runDir, "artifact-manifest.json"),
      "utf8",
    );
    expect(manifest).toContain("fixtures.json");
    // The project ledger recorded every verb.
    const project = await readFile(
      join(
        process.env["HOME"]!,
        ".cairntrace",
        "fixtures",
        "fixturedemo.ledger.jsonl",
      ),
      "utf8",
    );
    expect(project).toContain('"runId"');
  });

  it("tears fixtures down after a failed step", async () => {
    const specPath = await setup(`${SPEC_HEAD}fixtures: [kit]
steps:
  - id: boom
    open: https://demo.example.test/fails
${KIT_OUTCOME}`);
    const backend = new MockBrowserBackend();
    backend.failNextStep("element gone");
    const result = await runSpec({
      specPath,
      backend,
      artifactRoot: join(dir, "runs"),
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("failed");
    expect((await lines(log)).slice(-2)).toEqual([
      "teardown kit k-t-1",
      "teardown tenant failed",
    ]);
  });

  it("tears fixtures down after a cancel", async () => {
    const pidFile = join(dir, "slow.pid");
    const controller = new AbortController();
    const pending = run(
      `${SPEC_HEAD}fixtures: [kit]
steps:
  - id: slow
    run: 'sleep 30 & echo $! > "${pidFile}"; wait'
${KIT_OUTCOME}`,
      { signal: controller.signal },
    );
    const deadline = Date.now() + 10_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    controller.abort();
    const { result } = await pending;
    expect(result.failure?.phase).toBe("cancelled");
    expect((await lines(log)).slice(-2)).toEqual([
      "teardown kit k-t-1",
      "teardown tenant errored",
    ]);
  }, 20_000);

  it("errors the run in phase fixture when an ensure fails, and still tears down what was ensured", async () => {
    const { result } = await run(
      `${SPEC_HEAD}fixtures: [broken]
steps:
  - open: https://demo.example.test/never
${PLAIN_OUTCOME}`,
      {},
      config(`  broken:
    kind: exec
    needs: [tenant]
    ensure: 'echo "no seed data" >&2; exit 4'
`),
    );
    expect(result.status).toBe("errored");
    expect(result.failure).toMatchObject({ phase: "fixture", name: "broken" });
    expect(result.failure?.message).toMatch(
      /fixture broken ensure failed: .*exit 4.*no seed data/,
    );
    expect(result.summary).toMatch(/^errored in fixture 'broken'/);
    expect(await lines(log)).toEqual([
      "ensure tenant",
      "teardown tenant errored",
    ]);
  });

  it("refuses unknown fixtures and references outside the spec's fixtures before anything runs", async () => {
    const unknown = await run(`${SPEC_HEAD}fixtures: [nope]
preconditions:
  commands:
    - run: 'echo "precondition ran" >> "${log}"'
${KIT_OUTCOME}`);
    expect(unknown.result.failure).toMatchObject({
      phase: "fixture",
      name: "nope",
    });
    expect(unknown.result.failure?.message).toMatch(
      /unknown fixture "nope"; config fixtures: tenant, kit/,
    );
    const stray = await run(`${SPEC_HEAD}fixtures: [tenant]
${KIT_OUTCOME}`);
    expect(stray.result.failure).toMatchObject({
      phase: "fixture",
      name: "kit",
    });
    expect(stray.result.failure?.message).toMatch(/do not include it/);
    expect(await lines(log)).toEqual([]);
  });

  it("dry-runs mutating verbs on a shared environment unless writes are allowed", async () => {
    const spec = `${SPEC_HEAD}fixtures: [tenant]
${PLAIN_OUTCOME}`;
    const dry = await run(spec, { environmentOverride: "shared" });
    expect(dry.result.status).toBe("passed");
    expect(await lines(log)).toEqual([]);
    const stream = await events(dry.result.runDir);
    expect(stream.filter((e) => e.type.startsWith("fixture."))).toEqual([
      expect.objectContaining({
        type: "fixture.ensure",
        status: "dry-run",
        reason: expect.stringContaining("environment shared is shared"),
      }),
    ]);
    const wrote = await run(spec, {
      environmentOverride: "shared",
      allowFixtureWrites: true,
    });
    expect(wrote.result.status).toBe("passed");
    expect(await lines(log)).toEqual([
      "ensure tenant",
      "teardown tenant passed",
    ]);
  });

  it("shares a suite fixture through the invocation host", async () => {
    const host = new FixtureHost();
    const cfg = config(`  shared_tenant:
    kind: exec
    scope: suite
    ensure: 'echo "ensure suite" >> "${log}"; echo "{\\"id\\":\\"s-1\\"}"'
    teardown: 'echo "teardown suite" >> "${log}"'
    outputs: { id: "$.id" }
`);
    const spec = `${SPEC_HEAD}fixtures: [shared_tenant]
steps:
  - open: https://demo.example.test/t/\${fixtures.shared_tenant.id}
outcomes:
  - id: ok
    description: ok
    verify: { value: { actual: "\${fixtures.shared_tenant.id}", expect: { $: s-1 } } }
`;
    const first = await run(spec, { fixtureHost: host }, cfg);
    const second = await run(spec, { fixtureHost: host }, cfg);
    expect([first.result.status, second.result.status]).toEqual([
      "passed",
      "passed",
    ]);
    expect(await lines(log)).toEqual(["ensure suite"]);
    const secondEvents = (await events(second.result.runDir)).filter((e) =>
      e.type.startsWith("fixture."),
    );
    expect(secondEvents).toEqual([
      expect.objectContaining({
        type: "fixture.ensure",
        status: "skipped",
        scope: "suite",
        outputs: { id: "s-1" },
      }),
    ]);
    await host.teardownAll();
    expect(await lines(log)).toEqual(["ensure suite", "teardown suite"]);
  });

  it("refuses ${fixtures.*} in a spec that lists no fixtures, before anything runs", async () => {
    const { result, backend } = await run(`${SPEC_HEAD}steps:
  - open: https://demo.example.test/?id=\${fixtures.tenant.id}
${PLAIN_OUTCOME}`);
    expect(result.status).toBe("errored");
    expect(result.failure).toMatchObject({ phase: "fixture", name: "tenant" });
    expect(result.failure?.message).toMatch(/the spec lists no fixtures/);
    expect(backend.stepLog).toEqual([]);
    const pre = await run(`${SPEC_HEAD}fixtures: [tenant]
preconditions:
  commands:
    - run: 'echo "\${fixtures.tenant.id}" >> "${log}"'
${PLAIN_OUTCOME}`);
    expect(pre.result.failure?.message).toMatch(
      /used in preconditions, which run before the fixtures are ensured/,
    );
    expect(await lines(log)).toEqual([]);
  });

  it("errors in phase fixture when a dry-run leaves a spliced output without a value", async () => {
    const cfg = config().replace("project: fixturedemo", "project: dryrundemo");
    const { result, backend } = await run(
      `${SPEC_HEAD}fixtures: [tenant]
steps:
  - open: https://demo.example.test/t/\${fixtures.tenant.id}
${PLAIN_OUTCOME}`,
      { environmentOverride: "shared" },
      cfg,
    );
    expect(result.status).toBe("errored");
    expect(result.failure).toMatchObject({ phase: "fixture", name: "tenant" });
    expect(result.failure?.message).toMatch(
      /\$\{fixtures\.tenant\.id\} has no value after the fixtures were set up \(fixture tenant: dry-run: environment shared is shared/,
    );
    expect(backend.stepLog).toEqual([]);
    expect(await lines(log)).toEqual([]);
  });

  it("keeps fixture writes off on a mutations: deny environment", async () => {
    const cfg = config().replace(
      "  shared:\n    policy: { trait: shared }",
      "  shared:\n    policy: { trait: shared }\n  locked:\n    policy: { trait: owned, mutations: deny }",
    );
    const { result } = await run(
      `${SPEC_HEAD}fixtures: [{ use: tenant, write: true }]
${PLAIN_OUTCOME}`,
      { environmentOverride: "locked", allowFixtureWrites: true },
      cfg,
    );
    expect(result.status).toBe("passed");
    expect(await lines(log)).toEqual([]);
    const stream = await events(result.runDir);
    expect(stream.filter((e) => e.type.startsWith("fixture."))).toEqual([
      expect.objectContaining({
        type: "fixture.ensure",
        status: "dry-run",
        reason: expect.stringContaining("denies mutations"),
      }),
    ]);
  });

  it("keeps secret and sensitive fixture outputs out of the run's evidence", async () => {
    const cfg = config(`  sec:
    kind: exec
    ensure: 'echo "{\\"id\\":\\"x1\\",\\"t\\":\\"zzSECRETzz99\\",\\"apiToken\\":\\"tokSUPERSECRET123\\"}"'
    outputs: { id: "$.id", token: { from: "$.t", secret: true }, apiToken: "$.apiToken" }
`);
    const { result, backend } = await run(
      `${SPEC_HEAD}fixtures: [sec]
steps:
  - open: https://demo.example.test/?id=\${fixtures.sec.id}&t=\${fixtures.sec.token}&k=\${fixtures.sec.apiToken}
outcomes:
  - id: page_ok
    description: the page carries the id
    verify: { url: { matches: "id=x1" } }
`,
      {},
      cfg,
    );
    expect(result.status).toBe("passed");
    // The browser got the real values...
    expect(JSON.stringify(backend.stepLog)).toContain("zzSECRETzz99");
    // ...no artifact of the run did.
    const files = (await readdir(result.runDir, { recursive: true })).map(
      String,
    );
    for (const file of files) {
      const text = await readFile(join(result.runDir, file), "utf8").catch(
        () => "",
      );
      expect(text, file).not.toContain("zzSECRETzz99");
      expect(text, file).not.toContain("tokSUPERSECRET123");
    }
  });

  it("still tears fixtures down (and runs the spec teardown) when the run throws mid-way", async () => {
    const specPath = await setup(`${SPEC_HEAD}fixtures: [kit]
steps:
  - id: break_evidence
    run: 'chmod 444 "$CAIRN_RUN_DIR/events.ndjson"'
teardown:
  - run: 'echo "spec teardown $CAIRN_RUN_STATUS" >> "${log}"'
${KIT_OUTCOME}`);
    await expect(
      runSpec({
        specPath,
        backend: new MockBrowserBackend(),
        artifactRoot: join(dir, "runs"),
        heartbeatIntervalMs: 0,
      }),
    ).rejects.toThrow(/EACCES|EPERM/);
    expect(await lines(log)).toEqual([
      "ensure tenant",
      "ensure kit t-1",
      "spec teardown errored",
      "teardown kit k-t-1",
      "teardown tenant errored",
    ]);
  });

  it("runs exec fixture teardowns from the SIGTERM handler", async () => {
    const pidFile = join(dir, "slow.pid");
    const specPath = await setup(`${SPEC_HEAD}fixtures: [kit]
steps:
  - id: slow
    run: 'sleep 30 & echo $! > "${pidFile}"; wait'
teardown:
  - run: 'echo "spec teardown $CAIRN_RUN_SIGNAL" >> "${log}"'
${KIT_OUTCOME}`);
    const script = join(dir, "child.ts");
    await writeFile(
      script,
      `import { runSpec } from ${JSON.stringify(join(import.meta.dirname, "Runner.ts"))};
import { MockBrowserBackend } from ${JSON.stringify(join(import.meta.dirname, "..", "..", "adapters", "mock", "MockBrowserBackend.ts"))};
await runSpec({ specPath: ${JSON.stringify(specPath)}, backend: new MockBrowserBackend(), artifactRoot: ${JSON.stringify(join(dir, "runs"))}, heartbeatIntervalMs: 0 });
`,
    );
    const child = spawn("bun", [script], { stdio: "ignore" });
    const exited = new Promise<NodeJS.Signals | null>((resolveExit) =>
      child.on("exit", (_code, signal) => resolveExit(signal)),
    );
    const deadline = Date.now() + 15_000;
    while (!existsSync(pidFile) && Date.now() < deadline) {
      await new Promise((resolveTick) => setTimeout(resolveTick, 25));
    }
    expect(existsSync(pidFile)).toBe(true);
    child.kill("SIGTERM");
    expect(await exited).toBe("SIGTERM");
    // Spec teardown first, then fixtures newest first — like the normal path.
    expect(await lines(log)).toEqual([
      "ensure tenant",
      "ensure kit t-1",
      "spec teardown SIGTERM",
      "teardown kit k-t-1",
      "teardown tenant errored",
    ]);
    try {
      process.kill(Number((await readFile(pidFile, "utf8")).trim()), "SIGKILL");
    } catch {
      // already gone
    }
  }, 30_000);
});
