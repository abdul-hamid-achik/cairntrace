import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deriveComposeProject,
  resolveCleanlinessTargets,
  verifyClean,
  type CleanlinessContext,
  type CommandRunner,
} from "./cleanliness";
import type { ProcessProbe, ProcessRow } from "./processProbe";
import { recordLedgerSession } from "./sessionLedger";

interface FakeProcess extends ProcessRow {
  cwd?: string;
}

function fakeProbe(processes: FakeProcess[]): ProcessProbe {
  return {
    list: () =>
      processes.map(({ pid, ppid, command }) => ({ pid, ppid, command })),
    cwd: (pid) => processes.find((p) => p.pid === pid)?.cwd,
    elapsedSeconds: () => 100,
    isAlive: (pid) => processes.some((p) => p.pid === pid),
    command: (pid) => processes.find((p) => p.pid === pid)?.command,
  };
}

let home: string;
let project: string;
let ledgerRoot: string;
let stateDir: string;

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), "cairn-clean-"));
  project = join(home, "project");
  ledgerRoot = join(home, "ledger");
  stateDir = join(home, "agent-browser-state");
  await mkdir(stateDir, { recursive: true });
});

/** agent-browser's `<session>.pid` file for a daemon. */
async function pidFile(session: string, pid: number): Promise<void> {
  await writeFile(join(stateDir, `${session}.pid`), `${pid}\n`);
}

afterEach(async () => {
  await rm(home, { recursive: true, force: true });
});

function context(over: Partial<CleanlinessContext> = {}): CleanlinessContext {
  return {
    projectDir: project,
    env: { PATH: process.env.PATH },
    redact: (text) => text,
    ledgerRoot,
    agentBrowserStateDir: stateDir,
    ignorePids: [],
    ...over,
  };
}

describe("verifyClean: browsers", () => {
  it("is clean with no ledger entries and no agent-browser in the project", () => {
    const probe = fakeProbe([
      { pid: 10, ppid: 1, command: "/usr/bin/some-editor" },
    ]);
    const [finding] = verifyClean([{ kind: "browsers" }], context({ probe }));
    expect(finding).toMatchObject({
      kind: "browsers",
      clean: true,
      survivors: [],
    });
  });

  it("flags the agent-browser daemon of a cairn run session working inside the project", async () => {
    await pidFile("cairntrace-4242-w0-s1", 300);
    const probe = fakeProbe([
      {
        pid: 300,
        ppid: 1,
        command: "/opt/agent-browser/bin/agent-browser-darwin-arm64 daemon",
        cwd: join(project, "flows"),
      },
    ]);
    const [finding] = verifyClean([{ kind: "browsers" }], context({ probe }));
    expect(finding!.clean).toBe(false);
    expect(finding!.survivors).toEqual([
      expect.stringContaining(
        "pid 300 /opt/agent-browser/bin/agent-browser-darwin-arm64",
      ),
    ]);
  });

  it("never flags a discovery or user session, nor a process that merely mentions agent-browser", async () => {
    await pidFile("cairntrace-disc-4242-abcdef", 310);
    await pidFile("default", 311);
    const probe = fakeProbe([
      {
        pid: 310,
        ppid: 1,
        command: "/opt/agent-browser/bin/agent-browser-darwin-arm64 daemon",
        cwd: project,
      },
      {
        pid: 311,
        ppid: 1,
        command: "/opt/agent-browser/bin/agent-browser-darwin-arm64 daemon",
        cwd: project,
      },
      {
        pid: 312,
        ppid: 1,
        command: "bun -e console.log(1) agent-browser-notes.md",
        cwd: project,
      },
    ]);
    const [finding] = verifyClean([{ kind: "browsers" }], context({ probe }));
    expect(finding).toMatchObject({ clean: true, survivors: [] });
  });

  it("never flags cairn's ancestor chain", async () => {
    await pidFile("cairntrace-90", 400);
    const probe = fakeProbe([
      {
        pid: 400,
        ppid: 1,
        command: "/opt/agent-browser/bin/agent-browser-darwin-arm64 daemon",
        cwd: project,
      },
      { pid: 401, ppid: 400, command: "/bin/zsh", cwd: project },
      { pid: 402, ppid: 401, command: "bun ./bin/cairn run", cwd: project },
    ]);
    const [finding] = verifyClean(
      [{ kind: "browsers" }],
      context({ probe, ignorePids: [402] }),
    );
    expect(finding!.clean).toBe(true);
  });

  it("never flags another project's agent-browser", async () => {
    await pidFile("cairntrace-1-w0-s0", 301);
    await pidFile("cairntrace-1-w0-s1", 302);
    const probe = fakeProbe([
      {
        pid: 301,
        ppid: 1,
        command: "/opt/agent-browser/bin/agent-browser-darwin-arm64 daemon",
        cwd: join(home, "other-project"),
      },
      {
        pid: 302,
        ppid: 1,
        command: "/opt/agent-browser/bin/agent-browser-darwin-arm64 daemon",
        // Same prefix, different directory: not inside the project.
        cwd: `${project}-sibling`,
      },
    ]);
    const [finding] = verifyClean([{ kind: "browsers" }], context({ probe }));
    expect(finding!.clean).toBe(true);
  });

  it("never flags cairn itself (ignored pids)", async () => {
    await pidFile("cairntrace-400", 400);
    const probe = fakeProbe([
      {
        pid: 400,
        ppid: 1,
        command: "/usr/lib/node_modules/agent-browser/bin/daemon.js",
        cwd: project,
      },
    ]);
    const [finding] = verifyClean(
      [{ kind: "browsers" }],
      context({ probe, ignorePids: [400] }),
    );
    expect(finding!.clean).toBe(true);
  });

  it("flags a ledger session of this project whose browser survived, and its children", () => {
    const probe = fakeProbe([
      {
        pid: 500,
        ppid: 1,
        command: "/cache/ms-playwright/chromium/headless_shell --remote",
      },
      {
        pid: 501,
        ppid: 500,
        command: "/cache/ms-playwright/chromium/headless_shell --type=renderer",
      },
      { pid: 600, ppid: 1, command: "/usr/bin/unrelated" },
    ]);
    const handle = recordLedgerSession({
      session: "cairntrace-77-w0-s0",
      backend: "playwright",
      invocationId: "inv-1",
      projectDir: project,
      root: ledgerRoot,
      probe,
    });
    handle.setPids([500]);
    const [finding] = verifyClean([{ kind: "browsers" }], context({ probe }));
    expect(finding!.clean).toBe(false);
    expect(finding!.survivors).toHaveLength(2);
    expect(finding!.survivors.join("\n")).toContain("pid 500");
    expect(finding!.survivors.join("\n")).toContain("pid 501");
  });

  it("ignores ledger sessions of another project", () => {
    const probe = fakeProbe([
      {
        pid: 500,
        ppid: 1,
        command: "/cache/ms-playwright/chromium/headless_shell",
      },
    ]);
    const handle = recordLedgerSession({
      session: "elsewhere",
      backend: "playwright",
      invocationId: "inv-9",
      projectDir: join(home, "other"),
      root: ledgerRoot,
      probe,
    });
    handle.setPids([500]);
    const [finding] = verifyClean([{ kind: "browsers" }], context({ probe }));
    expect(finding!.clean).toBe(true);
  });

  it("never signals a ledger pid that no longer looks like a browser (recycled pid)", () => {
    const handle = recordLedgerSession({
      session: "recycled",
      backend: "playwright",
      invocationId: "inv-2",
      projectDir: project,
      root: ledgerRoot,
      probe: fakeProbe([
        {
          pid: 700,
          ppid: 1,
          command: "/cache/ms-playwright/chromium/headless_shell",
        },
      ]),
    });
    handle.setPids([700]);
    const probe = fakeProbe([
      { pid: 700, ppid: 1, command: "/usr/bin/postgres -D data" },
    ]);
    const [finding] = verifyClean([{ kind: "browsers" }], context({ probe }));
    expect(finding!.clean).toBe(true);
  });

  it("never counts a recycled pid that is a browser again but started later", () => {
    const at = (startTime: string) => ({
      ...fakeProbe([
        {
          pid: 710,
          ppid: 1,
          command: "/cache/ms-playwright/chromium/headless_shell --remote",
        },
      ]),
      startTime: () => startTime,
    });
    const handle = recordLedgerSession({
      session: "recycled-browser",
      backend: "playwright",
      invocationId: "inv-3",
      projectDir: project,
      root: ledgerRoot,
      probe: at("Thu Oct  1 10:00:00 2026"),
    });
    handle.setPids([710]);
    // Same pid, same kind of command — another start time: another process.
    const [later] = verifyClean(
      [{ kind: "browsers" }],
      context({ probe: at("Fri Oct  2 09:00:00 2026") }),
    );
    expect(later!.clean).toBe(true);
    const [same] = verifyClean(
      [{ kind: "browsers" }],
      context({ probe: at("Thu Oct  1 10:00:00 2026") }),
    );
    expect(same!.clean).toBe(false);
  });
});

const runner = (
  answers: Record<string, ReturnType<CommandRunner>>,
  calls: string[][] = [],
): CommandRunner => {
  return (file, args) => {
    calls.push([file, ...args]);
    return answers[file] ?? { status: 1, stdout: "", stderr: "" };
  };
};

describe("verifyClean: tmux and docker-project", () => {
  it("tmux: a live session is dirty, a missing one (or no tmux) is clean", () => {
    const calls: string[][] = [];
    const dirty = verifyClean(
      [{ kind: "tmux", name: "demo" }],
      context({
        run: runner({ tmux: { status: 0, stdout: "", stderr: "" } }, calls),
      }),
    );
    expect(dirty[0]).toMatchObject({
      kind: "tmux",
      name: "demo",
      clean: false,
    });
    expect(calls[0]).toEqual(["tmux", "has-session", "-t", "=demo"]);
    expect(
      verifyClean(
        [{ kind: "tmux", name: "demo" }],
        context({
          run: runner({ tmux: { status: 1, stdout: "", stderr: "no server" } }),
        }),
      )[0]!.clean,
    ).toBe(true);
    expect(
      verifyClean(
        [{ kind: "tmux", name: "demo" }],
        context({
          run: runner({
            tmux: {
              status: null,
              stdout: "",
              stderr: "",
              error: "spawn tmux ENOENT",
            },
          }),
        }),
      )[0]!.clean,
    ).toBe(true);
  });

  it("docker-project: containers of the compose project are dirty, none is clean", () => {
    const calls: string[][] = [];
    const dirty = verifyClean(
      [{ kind: "docker-project", name: "demo" }],
      context({
        run: runner(
          {
            docker: {
              status: 0,
              stdout: "abc123def4567890\nfeed00112233\n",
              stderr: "",
            },
          },
          calls,
        ),
      }),
    );
    expect(dirty[0]!.clean).toBe(false);
    expect(dirty[0]!.survivors).toEqual([
      'container abc123def456 of compose project "demo"',
      'container feed00112233 of compose project "demo"',
    ]);
    expect(calls[0]).toEqual([
      "docker",
      "ps",
      "-q",
      "--filter",
      "label=com.docker.compose.project=demo",
    ]);
    expect(
      verifyClean(
        [{ kind: "docker-project", name: "demo" }],
        context({
          run: runner({ docker: { status: 0, stdout: "\n", stderr: "" } }),
        }),
      )[0]!.clean,
    ).toBe(true);
  });

  it("docker-project: a daemon that is down (or no docker CLI) is clean, with a warning", () => {
    for (const docker of [
      {
        status: 1,
        stdout: "",
        stderr:
          "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?",
      },
      {
        status: null,
        stdout: "",
        stderr: "",
        error: "spawnSync docker ENOENT",
      },
    ]) {
      const [finding] = verifyClean(
        [{ kind: "docker-project", name: "demo" }],
        context({ run: runner({ docker }) }),
      );
      expect(finding).toMatchObject({ clean: true, survivors: [] });
      expect(finding!.warnings?.[0]).toContain("not reachable");
    }
  });

  it("docker-project: an unverifiable daemon (permission denied) is not a clean bill of health", () => {
    const [finding] = verifyClean(
      [{ kind: "docker-project", name: "demo" }],
      context({
        run: runner({
          docker: {
            status: 1,
            stdout: "",
            stderr:
              "permission denied while trying to connect to the docker API at unix:///var/run/docker.sock",
          },
        }),
      }),
    );
    expect(finding!.clean).toBe(false);
    expect(finding!.survivors[0]).toContain("could not verify");
    expect(finding!.survivors[0]).toContain("permission denied");
  });
});

const docker = (command: string, env?: Record<string, string>) =>
  ({
    docker: { command, ...(env ? { env } : {}) },
  }) as unknown as CleanlinessContext["services"];

describe("verifyClean target resolution", () => {
  const services = {
    docker: { command: "docker compose -p demo-stack up -d" },
    tmux: { session: "demo-session", windows: [] },
  } as unknown as CleanlinessContext["services"];

  it("derives the tmux session and the compose project from services", () => {
    const { targets, problems } = resolveCleanlinessTargets(
      ["browsers", "tmux", "docker-project"],
      { projectDir: project, services, env: {} },
    );
    expect(problems).toEqual([]);
    expect(targets).toEqual([
      { kind: "browsers" },
      { kind: "tmux", name: "demo-session" },
      { kind: "docker-project", name: "demo-stack" },
    ]);
  });

  it("takes explicit names over the derived ones", () => {
    const { targets } = resolveCleanlinessTargets(
      [
        { tmux: "other" },
        { "docker-project": "other-stack" },
        { browsers: true },
      ],
      { projectDir: project, services, env: {} },
    );
    expect(targets).toEqual([
      { kind: "tmux", name: "other" },
      { kind: "docker-project", name: "other-stack" },
      { kind: "browsers" },
    ]);
  });

  it("reports a tmux check with nothing to look at instead of passing it", () => {
    const { targets, problems } = resolveCleanlinessTargets(["tmux"], {
      projectDir: project,
      services: undefined,
      env: {},
    });
    expect(targets).toEqual([]);
    expect(problems[0]).toContain("needs a session");
  });

  it("derives the compose project from -p, --project-name, env, then the directory", () => {
    expect(
      deriveComposeProject(
        docker("docker compose --project-name=alpha up"),
        project,
        {},
      ),
    ).toBe("alpha");
    expect(
      deriveComposeProject(
        docker("docker compose up", { COMPOSE_PROJECT_NAME: "beta" }),
        project,
        {},
      ),
    ).toBe("beta");
    expect(
      deriveComposeProject(docker("docker compose up"), project, {
        COMPOSE_PROJECT_NAME: "gamma",
      }),
    ).toBe("gamma");
    expect(
      deriveComposeProject(
        docker("docker compose up"),
        "/work/My Project!",
        {},
      ),
    ).toBe("myproject");
  });
});
