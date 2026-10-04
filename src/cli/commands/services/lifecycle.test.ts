import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { randomUUID } from "node:crypto";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
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
import type { MockInstance } from "vitest";
import {
  checkServicesLive,
  composePsInvocation,
  formatServicesAge,
  readServicesLock,
  resolveServicesLockPath,
  servicesLockAgeSeconds,
  servicesLockPath,
  writeServicesLock,
} from "../../../core/runner/services";
import {
  ServicesDownResultSchema,
  ServicesUpResultSchema,
} from "../../../core/schema/services.v1";
import { buildMcpServer } from "../../../mcp/server";
import { executeRunInvocation } from "../../invocation/executeRunInvocation";
import { servicesDown, servicesDownCommand } from "./down";

// The CLI wrapper registers signal-time teardown for the boot window; keep
// the real process-wide signal handlers out of the test worker.
const cleanup = vi.hoisted(() => ({
  untrack: vi.fn(),
  tracked: [] as Array<{ terminateSync(): void }>,
}));
vi.mock("../../cleanup", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../cleanup")>()),
  trackServices: (handle: { terminateSync(): void }) => {
    cleanup.tracked.push(handle);
    return cleanup.untrack;
  },
}));
import {
  describeLockReport,
  getServicesStatus,
  servicesStatusCommand,
} from "./status";
import { phasesFromEvents, servicesUp, servicesUpCommand } from "./up";

/**
 * `cairn services up` → `cairn run --reuse-services` → `cairn services down`
 * end to end, with fake `docker` / `tmux` executables (shell stubs on PATH
 * that keep their state in a temp dir and log every call) and a seed that is
 * a plain shell command. The run uses the mock browser backend.
 */

let root: string;
let originalPath: string | undefined;
let originalHome: string | undefined;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-services-lock-"));
  originalPath = process.env.PATH;
  // Owner locks and seed state live under ~/.cairntrace/services: keep them
  // out of the real home.
  originalHome = process.env.HOME;
  process.env.HOME = join(root, "home");
  await mkdir(process.env.HOME, { recursive: true });
});

afterAll(async () => {
  process.env.PATH = originalPath;
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  await rm(root, { recursive: true, force: true });
});

// `services up` and `cairn run` cold-start (fresh docker, no reuse) when CI is
// truthy. These cases assert reuse, so pin CI off: GitHub Actions sets CI=true.
beforeEach(() => {
  vi.stubEnv("CI", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.env.PATH = originalPath;
  process.exitCode = undefined;
});

interface Fixture {
  dir: string;
  bin: string;
  configPath: string;
  /** The canonical config path the lock stores (symlinks resolved). */
  canonicalConfigPath: string;
  specPath: string;
  calls: string;
  state: string;
  project: string;
  session: string;
}

/** POSIX single-quoted shell literal. */
function sq(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

async function fixture(
  /** Leave `project:` out (the config falls back to "cairntrace"). */
  overrides: {
    services?: string;
    environments?: string;
    noProject?: boolean;
  } = {},
): Promise<Fixture> {
  const id = randomUUID().slice(0, 8);
  const dir = join(root, id);
  const bin = join(dir, "bin");
  const state = join(dir, "state");
  const calls = join(dir, "calls.log");
  await mkdir(bin, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(calls, "");
  const project = `svc-${id}`;
  const session = `svc-${id}`;

  await writeFile(
    join(bin, "docker"),
    `#!/bin/sh
S=${sq(state)}
printf 'docker %s\\n' "$*" >> ${sq(calls)}
case "$1 $2" in
  "compose up") touch "$S/docker-up"; echo "Container app Started"; exit 0;;
  "compose down") rm -f "$S/docker-up"; exit 0;;
  "compose ps") [ -f "$S/docker-up" ] && echo '{"Name":"app","State":"running","Status":"Up 1 minute"}'; exit 0;;
  "compose logs") echo "app | log line"; exit 0;;
esac
exit 0
`,
  );
  await writeFile(
    join(bin, "tmux"),
    `#!/bin/sh
S=${sq(state)}
printf 'tmux %s\\n' "$*" >> ${sq(calls)}
sub="$1"; shift
target=""; sname=""; wname=""; first=""; last=""; fmt=""
while [ $# -gt 0 ]; do
  case "$1" in
    -t) target="$2"; shift 2;;
    -s) sname="$2"; shift 2;;
    -n) wname="$2"; shift 2;;
    -F) fmt="$2"; shift 2;;
    -c|-S) shift 2;;
    -d|-p|-J) shift;;
    *) [ -z "$first" ] && first="$1"; last="$1"; shift;;
  esac
done
sess="\${target%%:*}"; win="\${target#*:}"
[ "$win" = "$target" ] && win=""
sess="\${sess#=}"; win="\${win#=}"
case "$sub" in
  has-session) [ -f "$S/session-$sess" ] && exit 0; exit 1;;
  kill-session) rm -f "$S/session-$sess"; rm -rf "$S/win-$sess"; exit 0;;
  new-session) touch "$S/session-$sname"; mkdir -p "$S/win-$sname"; echo zsh > "$S/win-$sname/$wname.cmd"; : > "$S/win-$sname/$wname.pane"; exit 0;;
  new-window) mkdir -p "$S/win-$sess"; echo zsh > "$S/win-$sess/$wname.cmd"; : > "$S/win-$sess/$wname.pane"; exit 0;;
  list-windows) [ -f "$S/session-$sess" ] || exit 1; for f in "$S/win-$sess"/*.cmd; do [ -e "$f" ] && basename "$f" .cmd; done; exit 0;;
  list-panes)
    [ -f "$S/win-$sess/$win.cmd" ] || exit 1
    c=$(cat "$S/win-$sess/$win.cmd")
    if [ -f "$S/win-$sess/$win.dead" ]; then
      printf '1\\t%s\\t\\n' "$(cat "$S/win-$sess/$win.dead")"; exit 0
    fi
    case "$fmt" in *pane_dead*) printf '0\\t\\t%s\\n' "$c";; *) printf '%s\\n' "$c";; esac
    exit 0;;
  send-keys) echo node > "$S/win-$sess/$win.cmd"; printf '$ %s\\nserver ready\\n' "$first" >> "$S/win-$sess/$win.pane"; exit 0;;
  capture-pane) cat "$S/win-$sess/$win.pane" 2>/dev/null; exit 0;;
esac
exit 0
`,
  );
  await chmod(join(bin, "docker"), 0o755);
  await chmod(join(bin, "tmux"), 0o755);
  process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;

  const configPath = join(dir, "cairntrace.config.yml");
  await writeFile(
    configPath,
    `version: 1
${
  overrides.noProject ? "" : `project: ${project}\n`
}artifactRoot: ${JSON.stringify(join(dir, "runs"))}
defaultEnvironment: local
environments:
${overrides.environments ?? "  local: {}\n  remote:\n    services: false"}
${
  overrides.services ??
  `services:
  docker:
    command: docker compose up -d
  seed:
    command: ${sq(`echo seed >> ${calls}`)}
  tmux:
    session: ${session}
    windows:
      - name: web
        command: yarn serve
        readyOn: { text: server ready }
  artifacts:
    when: always
  teardown:
    - tmux kill-session -t ${session}
    - docker compose down`
}
`,
  );
  const specPath = join(dir, "spec.yml");
  await writeFile(
    specPath,
    `version: 1
name: reuse_services_${id.replaceAll("-", "_")}
intent: A mock run against services started by services up.
coldStart: guest
steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`,
  );
  return {
    dir,
    bin,
    configPath,
    canonicalConfigPath: await realpath(configPath),
    specPath,
    calls,
    state,
    project,
    session,
  };
}

/** The calls a liveness look makes: none of them starts or stops anything. */
const READ_ONLY_PROBE =
  /^(docker compose (?:.* )?ps\b|tmux (?:has-session|list-windows|list-panes|capture-pane)\b)/;

async function callLog(f: Fixture): Promise<string[]> {
  return (await readFile(f.calls, "utf8")).split("\n").filter(Boolean);
}

async function journalEventTypes(journalDir: string): Promise<string[]> {
  const text = await readFile(join(journalDir, "events.ndjson"), "utf8");
  return text
    .split("\n")
    .filter(Boolean)
    .map((line) => (JSON.parse(line) as { type: string }).type);
}

function run(f: Fixture, options: Record<string, unknown> = {}) {
  return executeRunInvocation(
    {
      specs: [f.specPath],
      options: { mock: true, noWebServer: true, ...options },
      cwd: f.dir,
    },
    { origin: "mcp" },
  );
}

describe("services up → run --reuse-services → services down", () => {
  it("boots once, reuses without start/teardown, then tears down", async () => {
    const f = await fixture();

    const up = await servicesUp({ config: f.configPath, by: "cli" });
    expect(ServicesUpResultSchema.parse(up)).toMatchObject({
      ok: true,
      exitCode: 0,
      project: f.project,
      env: "local",
      phases: { docker: "started", seed: "ran", tmux: "created" },
      lock: {
        version: 1,
        owner: "services-up",
        project: f.project,
        env: "local",
        configPath: f.canonicalConfigPath,
        pid: process.pid,
        by: "cli",
      },
    });
    expect(up.lockPath).toBe(await resolveServicesLockPath(f.configPath));
    const lock = await readServicesLock(f.configPath);
    expect(lock).toMatchObject({ state: "held", lock: up.lock });
    const bootCalls = await callLog(f);
    expect(bootCalls).toContain("docker compose up -d");
    expect(bootCalls).toContain("seed");
    expect(bootCalls.some((c) => c.startsWith("tmux new-session"))).toBe(true);

    const status = await getServicesStatus({ config: f.configPath });
    expect(status.env).toBe("local");
    expect(status.lock).toMatchObject({
      state: "held",
      stale: false,
      lock: { owner: "services-up", by: "cli" },
    });
    expect(status.lock?.ageSeconds).toBeGreaterThanOrEqual(0);

    const before = bootCalls.length;
    const reused = await run(f, { reuseServices: true });
    expect(reused).toMatchObject({ kind: "single", exitCode: 0 });
    const runCalls = (await callLog(f)).slice(before);
    for (const call of runCalls) {
      expect(call).not.toMatch(
        /compose up|compose down|new-session|new-window|kill-session|send-keys/,
      );
      expect(call).not.toBe("seed");
    }
    const types = await journalEventTypes(reused.journalDir!);
    expect(types).toContain("services.docker.reuse");
    expect(types).toContain("services.seed.skip");
    expect(types).toContain("services.tmux.reuse");
    expect(types.filter((t) => t.startsWith("services.teardown."))).toEqual([]);
    expect(types.filter((t) => /^services\.\w+\.start$/.test(t))).toEqual([]);
    // The run's own events carry the reuse events, and its service evidence
    // records the reused ownership.
    const runDir = reused.runDirs[0]!;
    const runEvents = await readFile(join(runDir, "events.ndjson"), "utf8");
    expect(runEvents).toContain("services.tmux.reuse");
    const manifest = JSON.parse(
      await readFile(join(runDir, "services", "manifest.json"), "utf8"),
    ) as { ownership?: Record<string, string> };
    expect(manifest.ownership).toEqual({ docker: "reused", tmux: "reused" });
    // Warm stack, cold browser — unless the caller sets coldStart itself.
    expect(reused.document).toMatchObject({ coldStart: true });
    const warm = await run(f, { reuseServices: true, coldStart: false });
    expect(warm).toMatchObject({ exitCode: 0, document: { coldStart: false } });
    // Still up and still locked.
    expect((await readServicesLock(f.configPath)).state).toBe("held");

    const down = await servicesDown({ config: f.configPath });
    expect(ServicesDownResultSchema.parse(down)).toMatchObject({
      ok: true,
      exitCode: 0,
      lockState: "held",
      removedLock: up.lock,
      tmuxSession: f.session,
      tmuxKilled: false,
      teardown: [
        { command: `tmux kill-session -t ${f.session}`, ok: true, exitCode: 0 },
        { command: "docker compose down", ok: true, exitCode: 0 },
      ],
    });
    expect(down.events.map((e) => `${e.phase}.${e.event}`)).toEqual([
      "teardown.complete",
      "teardown.complete",
    ]);
    const downCalls = await callLog(f);
    expect(downCalls).toContain(`tmux kill-session -t ${f.session}`);
    expect(downCalls).toContain("docker compose down");
    expect((await readServicesLock(f.configPath)).state).toBe("absent");
    expect((await getServicesStatus({ config: f.configPath })).lock).toEqual({
      state: "absent",
      path: await resolveServicesLockPath(f.configPath),
    });
  }, 60_000);

  it("refuses a run without --reuse-services before anything starts (exit 4)", async () => {
    const f = await fixture();
    const up = await servicesUp({ config: f.configPath });
    expect(up.ok).toBe(true);
    const before = (await callLog(f)).length;

    const refused = await run(f);
    expect(refused).toMatchObject({
      kind: "errored",
      exitCode: 4,
      runDirs: [],
    });
    expect(refused.error).toContain("owned by `cairn services up`");
    expect(refused.error).toContain("--reuse-services");
    expect(refused.error).toContain("cairn services down --env local");
    // Nothing started: only the read-only liveness probes ran after the boot.
    for (const call of (await callLog(f)).slice(before)) {
      expect(call).toMatch(READ_ONLY_PROBE);
    }

    // A dry run reports what a run would do instead of refusing.
    const dry = await run(f, { servicesDryRun: true });
    expect(dry).toMatchObject({ kind: "services-dry-run", exitCode: 0 });
    const plan = (dry.document as { plan: string[] }).plan.join("\n");
    expect(plan).toContain("lock: held by `cairn services up`");
    expect(plan).toContain("would refuse (exit 4) without --reuse-services");
    const dryReuse = await run(f, {
      servicesDryRun: true,
      reuseServices: true,
    });
    expect((dryReuse.document as { plan: string[] }).plan.join("\n")).toContain(
      "would reuse it after a readiness check (no start, no teardown)",
    );

    // --no-services never looks at the lock.
    const skipped = await run(f, { noServices: true });
    expect(skipped).toMatchObject({ kind: "single", exitCode: 0 });

    // An environment with `services: false` never looks at the lock.
    const other = await run(f, { env: "remote" });
    expect(other.exitCode).toBe(0);

    await servicesDown({ config: f.configPath });
  }, 60_000);

  it("reports a stale lock clearly (status and --reuse-services, exit 4)", async () => {
    const f = await fixture();
    expect((await servicesUp({ config: f.configPath })).ok).toBe(true);
    // The stack died behind the lock's back.
    await rm(join(f.state, `session-${f.session}`), { force: true });
    await rm(join(f.state, "docker-up"), { force: true });

    const status = await getServicesStatus({ config: f.configPath });
    expect(status.lock).toMatchObject({ state: "held", stale: true });
    expect(status.lock?.problems).toEqual([
      "docker compose reports no running containers (set services.docker.readinessCheck for an exact check)",
      `tmux session "${f.session}" is not running`,
    ]);

    const before = (await callLog(f)).length;
    // Without --reuse-services the refusal names the dead stack too.
    const refused = await run(f);
    expect(refused).toMatchObject({ kind: "errored", exitCode: 4 });
    expect(refused.error).toContain("is stale");
    expect(refused.error).toContain(
      `tmux session "${f.session}" is not running`,
    );
    expect(refused.error).toContain(
      "run again (the run starts and stops its own stack)",
    );
    // The dry run says it does not check liveness.
    const dry = await run(f, { servicesDryRun: true, reuseServices: true });
    expect((dry.document as { plan: string[] }).plan.join("\n")).toContain(
      "liveness not checked here",
    );

    const stale = await run(f, { reuseServices: true });
    expect(stale).toMatchObject({ kind: "errored", exitCode: 4, runDirs: [] });
    expect(stale.error).toContain("is stale");
    expect(stale.error).toContain(`tmux session "${f.session}" is not running`);
    expect(stale.error).toContain("cairn services down --env local");
    // Only read-only probes ran.
    for (const call of (await callLog(f)).slice(before)) {
      expect(call).toMatch(READ_ONLY_PROBE);
    }
    // The lock stays until `services down` clears it.
    expect((await readServicesLock(f.configPath)).state).toBe("held");
    const down = await servicesDown({ config: f.configPath });
    expect(down).toMatchObject({
      ok: true,
      lockState: "held",
      tmuxKilled: false,
    });
    expect((await readServicesLock(f.configPath)).state).toBe("absent");
  }, 60_000);

  it("--reuse-services without a lock, and an unreadable lock, refuse with exit 4", async () => {
    const f = await fixture();
    const missing = await run(f, { reuseServices: true });
    expect(missing).toMatchObject({ kind: "errored", exitCode: 4 });
    expect(missing.error).toContain("no `cairn services up` lock");
    expect(missing.error).toContain("cairn services up --env local");
    expect(await callLog(f)).toEqual([]);

    const path = await resolveServicesLockPath(f.configPath);
    await mkdir(join(path, ".."), { recursive: true });
    await writeFile(path, "{not json");
    for (const options of [{}, { reuseServices: true }]) {
      const unreadable = await run(f, options);
      expect(unreadable).toMatchObject({ kind: "errored", exitCode: 4 });
      expect(unreadable.error).toContain("cannot be read");
    }
    expect(
      (await getServicesStatus({ config: f.configPath })).lock,
    ).toMatchObject({ state: "unreadable" });
    // `services up` replaces it (with a warning), `down` removes it.
    const up = await servicesUp({ config: f.configPath });
    expect(up.ok).toBe(true);
    expect(up.warnings.join("\n")).toContain(
      "replacing an unreadable services lock",
    );
    const again = await servicesUp({ config: f.configPath, by: "mcp" });
    expect(again).toMatchObject({
      ok: true,
      replacedLock: { by: "cli" },
      lock: { by: "mcp" },
      phases: { docker: "reused", tmux: "reused" },
    });
    expect((await servicesDown({ config: f.configPath })).ok).toBe(true);
  }, 60_000);

  it("one lock per config: sibling envs refuse instead of tearing the stack down", async () => {
    const f = await fixture({
      environments: "  local: {}\n  e2e: {}\n  remote:\n    services: false",
    });
    expect((await servicesUp({ config: f.configPath })).ok).toBe(true);
    const before = (await callLog(f)).length;

    for (const options of [
      { env: "e2e" },
      { env: "e2e", reuseServices: true },
    ]) {
      const refused = await run(f, options);
      expect(refused).toMatchObject({
        kind: "errored",
        exitCode: 4,
        runDirs: [],
      });
      expect(refused.error).toContain('are up for env "local"');
      expect(refused.error).toContain("cairn services down --env local");
    }
    const dry = await run(f, { env: "e2e", servicesDryRun: true });
    expect((dry.document as { plan: string[] }).plan.join("\n")).toContain(
      'lock: held for env "local"',
    );

    const upOther = await servicesUp({ config: f.configPath, env: "e2e" });
    expect(upOther).toMatchObject({ ok: false, exitCode: 4, env: "e2e" });
    expect(upOther.error).toContain('already up for env "local"');
    const downOther = await servicesDown({ config: f.configPath, env: "e2e" });
    expect(downOther).toMatchObject({
      ok: false,
      exitCode: 4,
      lockState: "held",
      teardown: [],
    });
    expect(downOther.error).toContain("nothing was torn down");
    // Nothing started or stopped: only read-only probes since the boot.
    for (const call of (await callLog(f)).slice(before)) {
      expect(call).toMatch(READ_ONLY_PROBE);
    }
    const sibling = await getServicesStatus({
      config: f.configPath,
      env: "e2e",
    });
    expect(sibling.lock).toMatchObject({
      state: "held",
      lock: { env: "local" },
    });
    expect(sibling.lock?.stale).toBeUndefined();
    expect(describeLockReport(sibling.lock!, "e2e")).toContain(
      'runs of env "e2e" refuse',
    );
    expect(
      (await getServicesStatus({ config: f.configPath })).lock,
    ).toMatchObject({ state: "held", stale: false });

    expect((await servicesDown({ config: f.configPath })).ok).toBe(true);
    expect((await readServicesLock(f.configPath)).state).toBe("absent");
  }, 60_000);

  it("keys the lock by config file: repos without `project:` never share one", async () => {
    const a = await fixture({ noProject: true });
    expect((await servicesUp({ config: a.configPath })).ok).toBe(true);
    // PATH now points at b's stubs.
    const b = await fixture({ noProject: true });
    expect(await resolveServicesLockPath(b.configPath)).not.toBe(
      await resolveServicesLockPath(a.configPath),
    );

    // b runs its own lifecycle and `down` in b never touches a's lock.
    const runB = await run(b);
    expect(runB).toMatchObject({ kind: "single", exitCode: 0 });
    const downB = await servicesDown({ config: b.configPath });
    expect(downB).toMatchObject({ ok: true, lockState: "absent" });
    expect(downB.removedLock).toBeUndefined();
    expect(await readServicesLock(a.configPath)).toMatchObject({
      state: "held",
      lock: { project: "cairntrace", configPath: a.canonicalConfigPath },
    });

    process.env.PATH = `${a.bin}${delimiter}${originalPath ?? ""}`;
    expect((await servicesDown({ config: a.configPath })).ok).toBe(true);
    expect((await readServicesLock(a.configPath)).state).toBe("absent");
  }, 60_000);
});

describe("services up / down edge cases", () => {
  it("fails clearly without a config, for an unknown env, or with no services", async () => {
    const empty = join(root, `empty-${randomUUID().slice(0, 8)}`);
    await mkdir(empty, { recursive: true });
    // No config anywhere above a tmp dir is not guaranteed; pass a missing one.
    const missing = await servicesUp({
      config: join(empty, "cairntrace.config.yml"),
    });
    expect(missing).toMatchObject({ ok: false, exitCode: 2 });
    expect(missing.error).toContain("config file not found");

    const f = await fixture();
    const unknown = await servicesUp({ config: f.configPath, env: "nope" });
    expect(unknown).toMatchObject({ ok: false, exitCode: 4 });
    expect(unknown.error).toContain('unknown environment "nope"');

    const none = await servicesUp({ config: f.configPath, env: "remote" });
    expect(none).toMatchObject({ ok: false, exitCode: 4, env: "remote" });
    expect(none.error).toContain("no services configured");
    expect(await callLog(f)).toEqual([]);

    const downNone = await servicesDown({
      config: f.configPath,
      env: "remote",
    });
    expect(downNone).toMatchObject({
      ok: true,
      exitCode: 0,
      lockState: "absent",
    });
    expect(downNone.warnings.join("\n")).toContain("nothing to tear down");

    const downUnknown = await servicesDown({
      config: f.configPath,
      env: "nope",
    });
    expect(downUnknown).toMatchObject({ ok: false, exitCode: 4 });
  });

  it("reports a failed boot (exit 2) and writes no lock", async () => {
    const f = await fixture({
      services: `services:
  docker:
    command: docker compose up -d && exit 3`,
    });
    const up = await servicesUp({ config: f.configPath });
    expect(up).toMatchObject({ ok: false, exitCode: 2 });
    expect(up.error).toContain("docker command failed (exit 3)");
    expect((await readServicesLock(f.configPath)).state).toBe("absent");
  });

  it("down without a lock still tears down, and reports failing commands (exit 2)", async () => {
    const f = await fixture({
      services: `services:
  tmux:
    session: placeholder
    windows:
      - name: web
        command: yarn serve
  teardown:
    - "false"
    - docker compose down`,
    });
    // A leftover session the config manages (no lock): down kills it.
    await writeFile(join(f.state, "session-placeholder"), "");
    const down = await servicesDown({ config: f.configPath });
    expect(down).toMatchObject({
      ok: false,
      exitCode: 2,
      lockState: "absent",
      tmuxSession: "placeholder",
      tmuxKilled: true,
      teardown: [
        { command: "false", ok: false, exitCode: 1 },
        { command: "docker compose down", ok: true, exitCode: 0 },
      ],
    });
    expect(down.error).toContain("1 teardown command(s) failed");
    expect(down.events.map((e) => e.event)).toEqual(["fail", "complete"]);
  });

  it("derives phases from lifecycle events", () => {
    const at = new Date().toISOString();
    const e = (phase: "docker" | "seed" | "tmux", event: string) => ({
      phase,
      event: event as "start",
      message: "",
      timestamp: at,
    });
    expect(
      phasesFromEvents([
        e("docker", "start"),
        e("seed", "skip"),
        e("tmux", "recreate"),
        e("tmux", "start"),
      ]),
    ).toEqual({ docker: "started", seed: "skipped", tmux: "recreated" });
    expect(phasesFromEvents([])).toEqual({});
  });

  it("keeps lock file names inside the state dir and unambiguous", async () => {
    const a = servicesLockPath("/repos/a.b/cairntrace.config.yml", "/state");
    const b = servicesLockPath("/repos/a/b/cairntrace.config.yml", "/state");
    expect(a).not.toBe(b);
    expect(a).toMatch(/^\/state\/a%2Eb\.[0-9a-f]{16}\.lock\.json$/);
    expect(servicesLockPath("/x/../cairntrace.config.yml", "/state")).toMatch(
      /^\/state\/%2E%2E\.[0-9a-f]{16}\.lock\.json$/,
    );
    // Same project name, different config files: different locks.
    expect(servicesLockPath("/one/app/c.yml", "/s")).not.toBe(
      servicesLockPath("/two/app/c.yml", "/s"),
    );
    const dir = join(root, `locks-${randomUUID().slice(0, 8)}`);
    const lock = {
      version: 1 as const,
      owner: "services-up" as const,
      project: "p",
      env: "e",
      configPath: "/cfg.yml",
      startedAt: new Date().toISOString(),
      pid: 1,
      by: "cli" as const,
    };
    const path = await writeServicesLock(lock, dir);
    expect(path).toBe(await resolveServicesLockPath("/cfg.yml", dir));
    expect(JSON.parse(await readFile(path, "utf8"))).toEqual(lock);
    expect(await readServicesLock("/cfg.yml", dir)).toEqual({
      state: "held",
      path,
      lock,
    });
    // A newer cairn's additive field does not lock older readers out.
    await writeFile(path, JSON.stringify({ ...lock, addedLater: { x: 1 } }));
    expect(await readServicesLock("/cfg.yml", dir)).toEqual({
      state: "held",
      path,
      lock,
    });
    await writeFile(path, JSON.stringify({ ...lock, owner: "someone" }));
    expect(await readServicesLock("/cfg.yml", dir)).toMatchObject({
      state: "unreadable",
    });
    await writeFile(
      path,
      JSON.stringify({ ...lock, configPath: "/other.yml" }),
    );
    expect(await readServicesLock("/cfg.yml", dir)).toMatchObject({
      state: "unreadable",
      reason: "written for another config (/other.yml)",
    });
  });
});

/** A running fake session with the given windows (all live). */
async function liveSession(f: Fixture, windows: string[]): Promise<void> {
  await writeFile(join(f.state, `session-${f.session}`), "");
  await mkdir(join(f.state, `win-${f.session}`), { recursive: true });
  for (const name of windows) {
    await writeFile(join(f.state, `win-${f.session}`, `${name}.cmd`), "node");
  }
}

describe("checkServicesLive", () => {
  it("names every phase that is not up", async () => {
    const f = await fixture();
    const marker = join(f.state, "ready");
    await liveSession(f, ["dead", "idle", "url", "ok"]);
    await writeFile(join(f.state, `win-${f.session}`, "dead.dead"), "137");
    await writeFile(join(f.state, `win-${f.session}`, "idle.cmd"), "zsh");
    const cfg = {
      docker: {
        command: "./provision.sh",
        readinessCheck: `test -f ${sq(marker)}`,
      },
      tmux: {
        session: f.session,
        windows: [
          { name: "missing", command: "x" },
          { name: "dead", command: "x" },
          { name: "idle", command: "x" },
          {
            name: "url",
            command: "x",
            readyOn: { url: "http://127.0.0.1:1/" },
          },
          { name: "ok", command: "x", readyOn: { text: "ready" } },
        ],
      },
    };
    const down = await checkServicesLive(cfg, { configDir: f.dir });
    expect(down).toEqual({
      live: false,
      problems: [
        "docker readiness check failed (exit 1)",
        'tmux window "missing" is missing',
        'tmux window "dead" pane exited (exit 137)',
        'tmux window "idle" is back at an idle shell (zsh); its command is not running',
        'tmux window "url" is not ready (http://127.0.0.1:1/ does not answer)',
      ],
      unchecked: [],
    });
    await writeFile(marker, "");
    expect(
      await checkServicesLive(
        {
          docker: cfg.docker,
          tmux: { ...cfg.tmux, windows: [cfg.tmux.windows[4]!] },
        },
        { configDir: f.dir },
      ),
    ).toEqual({ live: true, problems: [], unchecked: [] });
    // A provisioner without a readiness check cannot be probed: trusted.
    expect(
      await checkServicesLive(
        { docker: { command: "./provision.sh" } },
        { configDir: f.dir },
      ),
    ).toEqual({
      live: true,
      problems: [],
      unchecked: [
        "docker: not a Compose command and no readinessCheck; trusted as up (set services.docker.readinessCheck for an exact check)",
      ],
    });
  });

  it("probes the compose project the command starts and trusts what it cannot see", async () => {
    const dir = join(root, `compose-${randomUUID().slice(0, 8)}`);
    const bin = join(dir, "bin");
    const calls = join(dir, "calls.log");
    await mkdir(bin, { recursive: true });
    await writeFile(calls, "");
    // Like real compose: `ps` without the command's -f (or COMPOSE_FILE)
    // finds no compose file in the cwd and fails.
    await writeFile(
      join(bin, "docker"),
      `#!/bin/sh
printf 'docker %s|%s\\n' "$*" "$COMPOSE_FILE" >> ${sq(calls)}
case " $* " in
  *" -f infra/compose.yml "*) echo '{"Name":"db","State":"running"}'; exit 0;;
esac
[ "$COMPOSE_FILE" = "infra/compose.yml" ] && { echo '{"Name":"db","State":"running"}'; exit 0; }
[ "$COMPOSE_FILE" = "infra/stopped.yml" ] && exit 0
echo "no configuration file provided: not found" >&2
exit 1
`,
    );
    await chmod(join(bin, "docker"), 0o755);
    process.env.PATH = `${bin}${delimiter}${originalPath ?? ""}`;
    const live = (docker: { command: string; env?: Record<string, string> }) =>
      checkServicesLive({ docker }, { configDir: dir });
    const up = { live: true, problems: [], unchecked: [] };

    expect(
      await live({ command: "docker compose -f infra/compose.yml up -d" }),
    ).toEqual(up);
    expect(
      await live({
        command: "docker compose up -d",
        env: { COMPOSE_FILE: "infra/compose.yml" },
      }),
    ).toEqual(up);
    expect(
      await live({
        command: "COMPOSE_FILE=infra/compose.yml docker compose up -d",
      }),
    ).toEqual(up);
    // `ps` answered and lists nothing running: stale.
    expect(
      await live({
        command: "docker compose up -d",
        env: { COMPOSE_FILE: "infra/stopped.yml" },
      }),
    ).toMatchObject({
      live: false,
      problems: [
        "docker compose reports no running containers (set services.docker.readinessCheck for an exact check)",
      ],
    });
    // `ps` failed, or the command cannot be read: unchecked, never stale.
    const failed = await live({ command: "docker compose up -d" });
    expect(failed).toMatchObject({ live: true, problems: [] });
    expect(failed.unchecked[0]).toContain(
      "`docker compose ps --format json` failed (exit 1)",
    );
    const opaque = await live({ command: "cd infra && docker compose up -d" });
    expect(opaque).toMatchObject({ live: true, problems: [] });
    expect(opaque.unchecked[0]).toContain(
      "not a plain `docker compose …` invocation",
    );
    const log = (await readFile(calls, "utf8")).split("\n").filter(Boolean);
    expect(log).toContain(
      "docker compose -f infra/compose.yml ps --format json|",
    );
    expect(log).toContain("docker compose ps --format json|infra/compose.yml");
  });

  it("reads the project options of a compose command", () => {
    expect(composePsInvocation("docker compose up -d")).toEqual({
      args: [],
      env: {},
    });
    expect(
      composePsInvocation(
        "docker compose -f infra/compose.yml -p shop --ansi never up -d --wait",
      ),
    ).toEqual({ args: ["-f", "infra/compose.yml", "-p", "shop"], env: {} });
    expect(
      composePsInvocation(
        `COMPOSE_PROJECT_NAME=shop docker-compose --file="my file.yml" --project-directory ./infra --profile web --dry-run up`,
      ),
    ).toEqual({
      args: [
        "--file",
        "my file.yml",
        "--project-directory",
        "./infra",
        "--profile",
        "web",
      ],
      env: { COMPOSE_PROJECT_NAME: "shop" },
    });
    for (const opaque of [
      "cd infra && docker compose up -d",
      "docker compose -f $FILE up -d",
      "docker --context remote compose up -d",
      "docker compose --unknown-flag up",
      "docker compose -f",
      "docker compose -f x.yml",
      "./bin/up.sh",
      "docker compose -f 'unterminated up",
    ]) {
      expect(composePsInvocation(opaque)).toBeUndefined();
    }
  });

  it("renders the lock in status markdown and the MCP summary line", async () => {
    const f = await fixture();
    expect((await servicesUp({ config: f.configPath })).ok).toBe(true);
    const stdout = vi
      .spyOn(process.stdout, "write")
      .mockImplementation(() => true);
    try {
      await servicesStatusCommand({ config: f.configPath, env: "local" });
      const md = stdout.mock.calls.map((c) => c[0]).join("");
      expect(md).toContain("- env: local");
      expect(md).toContain("- lock: held by `cairn services up` (cli, pid");
      expect(md).toContain("runs need --reuse-services");
    } finally {
      stdout.mockRestore();
    }
    await rm(join(f.state, `session-${f.session}`), { force: true });
    const status = await getServicesStatus({ config: f.configPath });
    expect(describeLockReport(status.lock!)).toContain(
      `STALE: tmux session "${f.session}" is not running`,
    );
    expect(
      describeLockReport({ state: "unreadable", path: "/x.lock.json" }),
    ).toContain("unreadable (invalid)");
    expect(describeLockReport({ state: "absent", path: "/x" })).toBe("none");
    const remote = await getServicesStatus({
      config: f.configPath,
      env: "remote",
    });
    expect(remote).toMatchObject({ hasServices: false, env: "remote" });
    // One lock per config: the status of another env shows who holds it.
    expect(remote.lock).toMatchObject({
      state: "held",
      lock: { env: "local" },
    });
    expect(remote.lock?.stale).toBeUndefined();
    const unknown = await getServicesStatus({
      config: f.configPath,
      env: "nope",
    });
    expect(unknown.errors.join("\n")).toContain('unknown environment "nope"');
    await servicesDown({ config: f.configPath });
  }, 60_000);

  it("formats lock ages", () => {
    expect(formatServicesAge(42)).toBe("42s");
    expect(formatServicesAge(300)).toBe("5m");
    expect(formatServicesAge(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatServicesAge(2 * 86_400 + 4 * 3600)).toBe("2d 4h");
    expect(servicesLockAgeSeconds({ startedAt: "not a date" })).toBe(0);
  });
});

describe("MCP cairn_services_up / _status / _down", () => {
  it("drive the same lifecycle with by: mcp", async () => {
    const f = await fixture();
    const server = buildMcpServer({ allowServices: true });
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "services-test", version: "0" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    try {
      const up = await client.callTool({
        name: "cairn_services_up",
        arguments: { config: f.configPath, env: "local" },
      });
      expect(up.isError).toBe(false);
      expect(ServicesUpResultSchema.parse(up.structuredContent)).toMatchObject({
        ok: true,
        lock: { by: "mcp", env: "local" },
      });
      expect(JSON.stringify(up.content)).toContain("tmux=created");

      const status = await client.callTool({
        name: "cairn_services_status",
        arguments: { config: f.configPath, env: "local" },
      });
      expect(status.structuredContent).toMatchObject({
        env: "local",
        lock: { state: "held", stale: false, lock: { by: "mcp" } },
      });
      expect(JSON.stringify(status.content)).toContain(
        "runs need --reuse-services",
      );

      const down = await client.callTool({
        name: "cairn_services_down",
        arguments: { config: f.configPath },
      });
      expect(down.isError).toBe(false);
      expect(
        ServicesDownResultSchema.parse(down.structuredContent),
      ).toMatchObject({ ok: true, removedLock: { by: "mcp" } });

      const failed = await client.callTool({
        name: "cairn_services_up",
        arguments: { config: f.configPath, env: "remote" },
      });
      expect(failed.isError).toBe(true);
      expect(JSON.stringify(failed.content)).toContain(
        "services up failed (exit 4)",
      );
    } finally {
      await client.close();
    }
  }, 60_000);
});

describe("services up / down CLI wrappers", () => {
  let stdout: MockInstance;
  let stderr: MockInstance;

  afterEach(() => {
    stdout?.mockRestore();
    stderr?.mockRestore();
  });

  it("print JSON results and set the exit code", async () => {
    const f = await fixture();
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await servicesUpCommand({ config: f.configPath, json: true });
    const up = ServicesUpResultSchema.parse(
      JSON.parse(stdout.mock.calls.map((c) => c[0]).join("")),
    );
    expect(up).toMatchObject({ ok: true, lock: { by: "cli" } });
    expect(process.exitCode).toBe(0);
    // Tracked for Ctrl-C while booting, untracked once the services are up.
    expect(cleanup.tracked.length).toBeGreaterThan(0);
    expect(cleanup.untrack).toHaveBeenCalled();

    stdout.mockClear();
    await servicesUpCommand({ config: f.configPath, env: "nope" });
    expect(stdout.mock.calls.map((c) => c[0]).join("")).toContain(
      "status: failed (exit 4)",
    );
    expect(process.exitCode).toBe(4);

    stdout.mockClear();
    await servicesDownCommand({ config: f.configPath });
    const md = stdout.mock.calls.map((c) => c[0]).join("");
    expect(md).toContain("# Services down");
    expect(md).toContain("- status: down");
    expect(md).toContain("- lock: removed");
    expect(process.exitCode).toBe(0);
  }, 60_000);
});
