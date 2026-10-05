import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { RunEventSchema, type RunEvent } from "../../core/schema/events.v1";
import { dropExitEvents } from "../../testing/lostExit";
import {
  executeRunInvocation,
  type RunInvocationResult,
} from "./executeRunInvocation";
import { runHookCommands } from "./hooks";

/**
 * The teardown after a wedged spec must always reach the exit. Production
 * (Linux, Bun, `--suite S --bail --hook-timeout-ms 600000`): after a wedge,
 * the suite `after` hook's shell exited but the runtime never reported it
 * (a `<defunct>` child) and cairn waited for it forever — the hook timeout
 * fired into a zombie and settled nothing. A browser close that never
 * returns must not hold the after hooks or the exit either.
 */

const fake = vi.hoisted(() => ({
  hangClose: false,
  terminated: 0,
}));

vi.mock("../backendFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../backendFactory")>();
  return {
    ...actual,
    createBackend: () => {
      const backend = new MockBrowserBackend();
      if (fake.hangClose) {
        backend.close = () => new Promise(() => {});
        (backend as unknown as { terminateSync: () => void }).terminateSync =
          () => {
            fake.terminated += 1;
          };
      }
      return backend;
    },
  };
});

const MARK = "cairn-wedge-teardown-probe";
let dir: string;
let runsRoot: string;
let counter = 0;
let restore: (() => void) | undefined;

const SPEC = `version: 1
name: wedge_teardown
intent: A mock run whose teardown is exercised.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-wedge-"));
  runsRoot = await mkdtemp(join(tmpdir(), "cairn-wedge-runs-"));
  await writeFile(join(dir, "pass.yml"), SPEC);
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
  await rm(runsRoot, { recursive: true, force: true });
});

beforeEach(() => {
  counter += 1;
});

afterEach(() => {
  restore?.();
  restore = undefined;
  fake.hangClose = false;
  fake.terminated = 0;
});

async function suiteConfig(marks: string): Promise<string> {
  const path = join(dir, `cfg-${counter}.config.yml`);
  await writeFile(
    path,
    `version: 1
project: wedge-demo
defaultEnvironment: local
environments:
  local:
    baseUrl: https://demo.example.test
suites:
  s:
    specs: [pass.yml]
    bail: true
    after: ['echo "after exit=$CAIRN_EXIT_CODE" >> "${marks}" # ${MARK}']
    hookTimeoutMs: 60000
`,
  );
  return path;
}

async function run(
  configPath: string,
  notes: string[],
  backendCloseTimeoutMs?: number,
): Promise<RunInvocationResult> {
  return executeRunInvocation(
    {
      specs: [],
      options: {
        mock: true,
        suite: "s",
        config: configPath,
        artifactRoot: join(runsRoot, `runs-${counter}`),
        noWebServer: true,
        noServices: true,
      },
      cwd: dir,
    },
    {
      origin: "cli",
      narration: { note: (_kind, message) => void notes.push(message) },
      ...(backendCloseTimeoutMs !== undefined ? { backendCloseTimeoutMs } : {}),
    },
  );
}

async function events(result: RunInvocationResult): Promise<RunEvent[]> {
  const text = await readFile(
    join(result.journalDir!, "events.ndjson"),
    "utf8",
  );
  return text
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as RunEvent);
}

describe("teardown after a wedge", () => {
  it("finishes a suite after hook whose exit event the runtime lost", async () => {
    restore = dropExitEvents(MARK);
    const marks = join(dir, `marks-${counter}.txt`);
    const notes: string[] = [];
    const started = Date.now();
    const result = await run(await suiteConfig(marks), notes);
    // Before the fix this never returned (the hook timeout is 60s here).
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(result.exitCode).toBe(0);
    expect(await readFile(marks, "utf8")).toBe("after exit=0\n");
    const all = await events(result);
    for (const event of all) {
      expect(RunEventSchema.safeParse(event).success).toBe(true);
    }
    expect(all.find((e) => e.type === "suite.hook.finished")).toMatchObject({
      hook: "after",
      ok: false,
    });
    expect(all.at(-1)).toMatchObject({ type: "invocation.finished" });
    expect(notes.join("\n")).toContain(
      "the runtime never reported its exit; the process table shows it ended",
    );
  });

  it("does not let a browser close that never returns hold the after hooks or the exit", async () => {
    fake.hangClose = true;
    const marks = join(dir, `marks-close-${counter}.txt`);
    const notes: string[] = [];
    const result = await run(await suiteConfig(marks), notes, 200);
    expect(result.exitCode).toBe(0);
    expect(await readFile(marks, "utf8")).toBe("after exit=0\n");
    expect(fake.terminated).toBe(1);
    expect(notes.join("\n")).toContain(
      "the mock browser did not close within 200ms; its processes were killed",
    );
  });
});

describe("--before / --after hooks with a lost exit event", () => {
  it("settles a hook the runtime never reported as exited", async () => {
    restore = dropExitEvents(MARK);
    const marks = join(dir, `hook-${counter}.txt`);
    const notes: string[] = [];
    const started = Date.now();
    await runHookCommands("after", [`echo ran >> "${marks}" # ${MARK}`], {
      fatal: false,
      cwd: dir,
      timeoutMs: 60_000,
      note: (_kind, message) => void notes.push(message),
    });
    expect(Date.now() - started).toBeLessThan(20_000);
    expect(existsSync(marks)).toBe(true);
    expect(notes.join("\n")).toContain(
      "after hook: the runtime never reported its exit",
    );
  });
});
