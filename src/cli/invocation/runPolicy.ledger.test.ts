import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { listLedger } from "../../core/runPolicy/sessionLedger";
import { executeRunInvocation } from "./executeRunInvocation";

/**
 * The engine records every real browser session it starts in the owned
 * browser-session ledger (`cairn doctor --orphans`, `verifyClean: browsers`):
 * the entry names the session, the invocation, the project and the browser
 * pid, and is removed when the browser closed cleanly. The backend is a mock
 * that reports a pid, so no browser is launched.
 */

const fake = vi.hoisted(() => ({ pid: undefined as number | undefined }));

vi.mock("../backendFactory", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../backendFactory")>();
  return {
    ...actual,
    createBackend: () => {
      const backend = new MockBrowserBackend();
      (
        backend as unknown as { browserPid: () => number | undefined }
      ).browserPid = () => fake.pid;
      return backend;
    },
  };
});

let dir: string;
const children: ChildProcess[] = [];

const SPEC = `version: 1
name: ledger_pass
intent: A run through a backend that reports a browser pid.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-ledger-"));
  await writeFile(join(dir, "pass.yml"), SPEC);
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    "version: 1\ndefaultEnvironment: local\nenvironments:\n  local:\n    baseUrl: https://demo.example.test\n",
  );
});

afterEach(() => {
  fake.pid = undefined;
  for (const child of children.splice(0)) {
    try {
      if (child.pid) process.kill(child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function runOnce(
  ledgerRoot: string,
  extra: Record<string, unknown> = {},
) {
  return executeRunInvocation(
    {
      specs: [join(dir, "pass.yml")],
      options: {
        config: join(dir, "cairntrace.config.yml"),
        artifactRoot: join(dir, "runs"),
        backend: "agent-browser",
        noWebServer: true,
        noServices: true,
        ...extra,
      },
      cwd: dir,
    },
    { origin: "cli", runPolicyDeps: { ledgerRoot } },
  );
}

describe("owned browser-session ledger in the run engine", () => {
  it("removes the entry when the browser closed and nothing of it survives", async () => {
    const ledgerRoot = join(dir, "ledger-clean");
    const result = await runOnce(ledgerRoot);
    expect(result.exitCode).toBe(0);
    expect(listLedger(ledgerRoot)).toEqual([]);
  });

  it("keeps an entry naming the session, invocation, project and pid when the browser survived the close", async () => {
    const survivor = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 60000)", "agent-browser-fake-daemon"],
      { stdio: "ignore" },
    );
    children.push(survivor);
    fake.pid = survivor.pid;
    const ledgerRoot = join(dir, "ledger-survivor");
    const result = await runOnce(ledgerRoot);
    expect(result.exitCode).toBe(0);
    const entries = listLedger(ledgerRoot);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.entry).toMatchObject({
      backend: "agent-browser",
      invocationId: result.invocationId,
      ownerPid: process.pid,
      projectDir: dir,
      pids: [survivor.pid],
    });
    expect(entries[0]!.entry.session).toMatch(
      /^cairntrace-\d+-w0-s0$|^cairntrace-\d+$/,
    );
  });

  it("records nothing for the mock backend", async () => {
    const ledgerRoot = join(dir, "ledger-mock");
    await runOnce(ledgerRoot, { mock: true, backend: undefined });
    expect(listLedger(ledgerRoot)).toEqual([]);
  });
});
