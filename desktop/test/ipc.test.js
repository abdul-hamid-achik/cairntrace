/**
 * The IPC trust boundary (ipc.js) with a stubbed `electron` module: no
 * renderer argument is trusted. A renderer-named project must be a known one,
 * reads and writes stay inside the allowed roots, settings changes go through
 * validated handlers (with native confirmations the renderer cannot answer),
 * the suite lock gates every run, and a restored stash is addressed by its
 * folder.
 *
 * Spawns only fake `cairn` / launcher shell scripts written into temp dirs.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const { after, afterEach, describe, it } = require("node:test");

const cliLib = require("../lib/cli");
const { cleanup, tempDir, write } = require("./helpers");

/** @type {Map<string, (event: unknown, ...args: any[]) => any>} */
const handlers = new Map();
/** @type {Array<Record<string, any>>} */
const dialogCalls = [];
/** @type {Array<[string, string]>} */
const shellCalls = [];
const fake = {
  /** 0 = the confirm button, 1 = Cancel. */
  dialogResponse: 0,
  /**
   * Runs while a message box is "open", before it answers (to change the
   * world under a confirmation).
   * @type {null | (() => Promise<void>)}
   */
  whileDialogOpen: null,
  /** @type {string | null} */
  openDirectory: null,
};

const fakeElectron = {
  app: {
    getPath: (/** @type {string} */ name) =>
      path.join(tempDir("cairn-ipc-app-"), name),
    getVersion: () => "0.0.0-test",
    on() {},
    quit() {},
  },
  dialog: {
    /** @param {...any} args */
    showMessageBox: async (...args) => {
      dialogCalls.push(args.at(-1));
      await fake.whileDialogOpen?.();
      return { response: fake.dialogResponse };
    },
    showOpenDialog: async () =>
      fake.openDirectory
        ? { canceled: false, filePaths: [fake.openDirectory] }
        : { canceled: true, filePaths: [] },
    showSaveDialog: async () => ({ canceled: true }),
  },
  ipcMain: {
    /**
     * @param {string} channel
     * @param {(event: unknown, ...args: any[]) => any} fn
     */
    handle: (channel, fn) => handlers.set(channel, fn),
  },
  shell: {
    /** @param {string} target */
    showItemInFolder: (target) => shellCalls.push(["reveal", target]),
    /** @param {string} target */
    openPath: async (target) => {
      shellCalls.push(["open", target]);
      return "";
    },
    /** @param {string} target */
    openExternal: async (target) => {
      shellCalls.push(["external", target]);
    },
  },
};

// Node's internal loader hook, so `require("electron")` returns the stub.
const LOAD = "_load";
const loader = /** @type {any} */ (Module);
const originalLoad = loader[LOAD];
loader[LOAD] = function (/** @type {string} */ request, ...rest) {
  if (request === "electron") return fakeElectron;
  return originalLoad.call(this, request, ...rest);
};
const { registerIpc } = require("../ipc");

const RESTORED_RUN = "2026-09-01T11-00-00-000Z_checkout_d4e5f6";

// what the fake cairn answers for the wave 6 commands
const SUITES_DOC = {
  $schema: "urn:cairntrace.dev:suites:v1",
  version: "1",
  project: "demo",
  root: "/proj",
  suites: [
    {
      name: "smoke",
      description: "fast checks",
      bail: true,
      envs: [
        {
          env: "local",
          specs: ["flows/demo.yml"],
          before: 1,
          after: 1,
          vars: ["PORT"],
        },
        {
          env: "prod",
          specs: [],
          problem: "requires.env rules prod out",
          before: 0,
          after: 0,
        },
      ],
    },
  ],
  warnings: [],
};
const CONFIG_VARS_DOC = {
  $schema: "urn:cairntrace.dev:config-vars:v1",
  version: "1",
  ok: true,
  path: "/proj/cairntrace.config.yml",
  files: ["cairntrace.config.yml"],
  environments: ["local"],
  totals: {
    vars: 2,
    unused: 1,
    sameInAllEnvironments: 2,
    differing: 0,
    sameWhereDefined: 0,
  },
  vars: [
    {
      name: "apiUrl",
      kind: "string",
      values: {
        local: { value: "http://localhost:3000", scope: "vars", at: "c.yml:3" },
      },
      definedAt: [{ scope: "vars", at: "c.yml:3" }],
      overriddenBy: [],
      usedBy: [{ kind: "spec", name: "demo", file: "flows/demo.yml" }],
    },
    {
      name: "dbPassword",
      kind: "string",
      values: { local: { value: "hunter2", scope: "vars", at: "c.yml:4" } },
      definedAt: [{ scope: "vars", at: "c.yml:4" }],
      overriddenBy: [],
      usedBy: [],
      unused: true,
    },
  ],
  findings: [],
};
const ORPHANS_DOC = {
  $schema: "urn:cairntrace.dev:doctor-orphans:v1",
  version: "1",
  ok: false,
  exitCode: 1,
  orphans: [
    {
      session: "cairn-orphan-1",
      backend: "agent-browser",
      invocationId: "inv-gone",
      ownerPid: 99999,
      startedAt: "2026-10-03T09:00:00.000Z",
      processes: [{ pid: 4321, command: "chrome --headless" }],
    },
  ],
  staleEntriesRemoved: 0,
  liveSessions: 0,
  killRequested: false,
  killed: 0,
  remaining: [],
};
const ORPHANS_KILLED_DOC = {
  ...ORPHANS_DOC,
  ok: true,
  exitCode: 0,
  killRequested: true,
  killed: 1,
};
const RESTART_DOC = {
  $schema: "urn:cairntrace.dev:services-restart:v1",
  version: "1",
  ok: true,
  exitCode: 0,
  session: "demo-local",
  windows: [
    { window: "web", ok: true, alreadyStopped: false, durationMs: 900 },
  ],
  events: [],
  durationMs: 950,
  warnings: [],
};
const LOGS_DOC = {
  $schema: "urn:cairntrace.dev:services-logs:v1",
  version: "1",
  ok: true,
  exitCode: 0,
  session: "demo-local",
  window: "web",
  lines: ["listening on :3000", "db url postgres://app:topsecret@db/app"],
  totalLines: 2,
  sinceRestart: { requested: true, found: true },
  durationMs: 20,
  warnings: [],
};
const SPEC = "intent: demo\nsteps:\n  - open: /\noutcomes: []\n";

/** @type {Array<() => void>} */
const shutdowns = [];

after(() => {
  for (const stop of shutdowns) stop();
  loader[LOAD] = originalLoad;
  cleanup();
});

afterEach(() => {
  dialogCalls.length = 0;
  shellCalls.length = 0;
  fake.dialogResponse = 0;
  fake.whileDialogOpen = null;
  fake.openDirectory = null;
});

/**
 * @param {string} file
 * @param {string} body
 */
function script(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  return file;
}

/**
 * A fresh IPC surface over a temp project, a second recent project, an
 * outside directory, an artifact root, and fake executables.
 */
function setup() {
  const base = tempDir("cairn-ipc-");
  const project = path.join(base, "project");
  const other = path.join(base, "other-project");
  const outside = path.join(base, "outside");
  const runsRoot = path.join(base, "runs");
  const bin = path.join(base, "bin");
  write(project, "flows/demo.yml", SPEC);
  write(other, "flows/other.yml", SPEC);
  write(outside, "secret.txt", "TOP-SECRET");
  write(outside, "evil.yml", SPEC);
  fs.mkdirSync(runsRoot, { recursive: true });
  const cairn = script(
    path.join(bin, "cairn"),
    [
      'here="$(cd "$(dirname "$0")" && pwd)"',
      'if [ "$1" = "stash" ] && [ "$2" = "restore" ]; then',
      `  d="$5/${RESTORED_RUN}"`,
      '  mkdir -p "$d"',
      `  printf '{"runId":"${RESTORED_RUN}","status":"failed"}' > "$d/run.json"`,
      "  printf '<html>report</html>' > \"$d/report.html\"",
      "  echo '{\"ok\":true}'",
      "  exit 0",
      "fi",
      'if [ "$1" = "run" ]; then echo "$@" > "$here/ran.txt"; fi',
      // a run of a spec named *slow* stays up until it is cancelled
      'if [ "$1" = "run" ]; then case "$*" in *slow*) sleep 20;; esac; fi',
      // *graceful*: records the cancel signal; on SIGINT it takes 3s to
      // finish (a delegated cairn waiting for its runner), past the 2s a
      // SIGKILL escalation would allow
      'if [ "$1" = "run" ]; then case "$*" in *graceful*)',
      "  trap 'echo INT > \"$here/signal.txt\"; sleep 3; exit 130' INT",
      "  trap 'echo TERM > \"$here/signal.txt\"; exit 143' TERM",
      '  echo ready > "$here/graceful-ready.txt"',
      "  n=0; while [ $n -lt 300 ]; do sleep 0.1; n=$((n+1)); done;;",
      "esac; fi",
      'if [ "$1" = "spec" ] && [ "$2" = "heal" ]; then echo "$@" > "$here/healed.txt"; fi',
      'if [ "$1" = "clean" ]; then echo "$@" > "$here/cleaned.txt"; fi',
      // authoring: one argv entry per line, so a joined flag stays one entry
      'if [ "$1" = "discover" ] || [ "$1" = "catalog" ]; then printf "%s\\n" "$@" > "$here/$1.txt"; fi',
      // the outcomes file Studio wrote (it is gone once the export returns)
      'if [ "$1" = "discover" ]; then for a in "$@"; do case "$a" in --outcomes=*) cat "${a#--outcomes=}" > "$here/outcomes-seen.json";; esac; done; fi',
      'if [ "$1" = "spec" ] && [ "$2" = "promote" ]; then',
      '  printf "%s\\n" "$@" > "$here/promoted.txt"',
      '  cat "$3" > "$here/promoted-content.txt"',
      '  case "$3" in *refuse*) printf \'cairn spec promote: refusing to promote %s: no `cairn spec finish` ran for it. Run `cairn spec finish %s` until it is green (or pass --force)\\n\' "$3" "$3" >&2; exit 4;; esac',
      '  printf \'{"from":"%s","to":"flows/promoted.yml","contractHash":"sha256:abc","warnings":["rebased ../actions/login.yml"]}\\n\' "$3"',
      "  exit 0",
      "fi",
      'if [ "$1" = "services" ]; then printf "%s\\n" "$@" >> "$here/services.txt"; fi',
      'if [ "$1" = "services" ] && [ "$2" = "status" ]; then',
      '  echo \'{"hasServices":true,"lock":{"state":"held","path":"/locks/demo.local.lock.json","ageSeconds":120,"lock":{"version":1,"owner":"services-up","project":"demo","env":"local","configPath":"/p/c.yml","startedAt":"2026-10-02T11:58:00.000Z","pid":77,"by":"cli"}},"tmux":{"configured":true,"sessionExists":true,"session":"demo-local","windows":[{"name":"web","healthy":true,"paneTail":"TOKEN=hunter2"},{"name":"worker","healthy":false}]},"tunnels":[{"name":"db","state":"ready","running":true,"pid":4,"restarts":0}],"provisioner":{"exports":["OPS_HOST"]},"docker":{"configured":false,"running":false},"seed":{"configured":false,"expired":true},"errors":[]}\'',
      "  exit 0",
      "fi",
      // wave 6: restart / logs / suites / config vars / orphans read their
      // answers from files next to the binary, so a test sets the scene
      'if [ "$1" = "services" ] && [ "$2" = "restart" ]; then cat "$here/services-restart.json"; exit $(cat "$here/restart.exit" 2>/dev/null || echo 0); fi',
      'if [ "$1" = "services" ] && [ "$2" = "logs" ]; then cat "$here/services-logs.json"; exit 0; fi',
      'if [ "$1" = "suites" ]; then printf "%s\\n" "$@" > "$here/suites.txt"; cat "$here/suites.json"; exit 0; fi',
      'if [ "$1" = "config" ] && [ "$2" = "vars" ]; then printf "%s\\n" "$@" > "$here/config-vars.txt"; cat "$here/config-vars.json"; exit 0; fi',
      'if [ "$1" = "doctor" ] && [ "$2" = "--orphans" ]; then',
      '  printf "%s\\n" "$@" >> "$here/doctor.txt"',
      '  case " $* " in *" --kill "*) cat "$here/orphans-killed.json"; exit 0;; esac',
      '  cat "$here/orphans.json"; exit 1',
      "fi",
      "echo '{}'",
    ].join("\n"),
  );
  write(bin, "suites.json", JSON.stringify(SUITES_DOC));
  write(bin, "config-vars.json", JSON.stringify(CONFIG_VARS_DOC));
  write(bin, "orphans.json", JSON.stringify(ORPHANS_DOC));
  write(bin, "orphans-killed.json", JSON.stringify(ORPHANS_KILLED_DOC));
  write(bin, "services-restart.json", JSON.stringify(RESTART_DOC));
  write(bin, "services-logs.json", JSON.stringify(LOGS_DOC));
  const launcher = script(
    path.join(bin, "launcher.sh"),
    'echo "$@" > "$(cd "$(dirname "$0")" && pwd)/launched.txt"',
  );
  const settingsFile = path.join(base, "userData", "settings.json");
  write(
    path.dirname(settingsFile),
    "settings.json",
    JSON.stringify({
      activeProject: project,
      projects: [{ path: project }, { path: other }],
      cairnBin: cairn,
      artifactRoot: runsRoot,
    }),
  );
  /** @type {Array<[string, any]>} */
  const sent = [];
  handlers.clear();
  const fixturesLedgerDir = path.join(base, "fixture-ledgers");
  const runLockDir = path.join(base, "run-locks");
  fs.mkdirSync(runLockDir, { recursive: true });
  const handle = registerIpc({
    settingsFile,
    repoRoot: path.join(base, "no-repo"),
    getWindow: () => null,
    send: (channel, payload) => sent.push([channel, payload]),
    fixturesLedgerDir,
    runLockDir,
  });
  shutdowns.push(handle.shutdown);
  /**
   * @param {string} channel
   * @param {...any} args
   * @returns {Promise<{ ok: boolean, data?: any, error?: string }>}
   */
  const call = async (channel, ...args) => {
    const fn = handlers.get(channel);
    assert.ok(fn, `no handler for ${channel}`);
    return fn({}, ...args);
  };
  const settings = () => JSON.parse(fs.readFileSync(settingsFile, "utf8"));
  return {
    base,
    project,
    other,
    outside,
    runsRoot,
    bin,
    cairn,
    launcher,
    sent,
    call,
    settings,
    fixturesLedgerDir,
    runLockDir,
    shutdown: handle.shutdown,
  };
}

/**
 * Wait for a pushed message.
 * @param {Array<[string, any]>} sent
 * @param {string} channel
 * @param {number} [timeoutMs]
 */
async function waitForSent(sent, channel, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const hit = sent.find(([name]) => name === channel);
    if (hit) return hit[1];
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`${channel} was never sent`);
}

describe("ipc: Live Cancel of a delegated run (M1)", () => {
  const CONFIG = [
    "version: 1",
    "environments:",
    "  local: { baseUrl: http://demo.example.test }",
    "  remote:",
    "    baseUrl: http://demo.example.test",
    "    services: false",
    "    runner: { command: [remote-runner], cancelGraceMs: 1000 }",
    "",
  ].join("\n");

  /**
   * @param {ReturnType<typeof setup>} h
   * @param {string} env
   */
  async function cancelGraceful(h, env) {
    write(h.project, "cairntrace.config.yml", CONFIG);
    const spec = write(h.project, "flows/graceful.yml", SPEC);
    const run = await h.call("run:start", {
      specs: [spec],
      overrides: { env },
    });
    assert.equal(run.ok, true, run.error);
    const ready = path.join(h.bin, "graceful-ready.txt");
    const deadline = Date.now() + 8000;
    while (!fs.existsSync(ready) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 25));
    const cancel = await h.call("run:cancel", run.data.token);
    assert.equal(cancel.ok, true, cancel.error);
    const done = await waitForSent(h.sent, "run:done", 15_000);
    return {
      cancel: cancel.data,
      done,
      signal: fs.readFileSync(path.join(h.bin, "signal.txt"), "utf8").trim(),
    };
  }

  it("sends SIGINT and does not SIGKILL it while cairn cancels its runner", async () => {
    const h = setup();
    const { cancel, done, signal } = await cancelGraceful(h, "remote");
    assert.deepEqual(cancel, {
      cancelled: true,
      signal: "SIGINT",
      delegated: true,
    });
    assert.equal(signal, "INT");
    // It finished its 3s cancel and exited on its own: no SIGKILL at 2s.
    assert.equal(done.exitCode, 130);
  });

  it("keeps SIGTERM (then SIGKILL) for a run that is not delegated", async () => {
    const h = setup();
    const { cancel, done, signal } = await cancelGraceful(h, "local");
    assert.deepEqual(cancel, { cancelled: true });
    assert.equal(signal, "TERM");
    assert.equal(done.exitCode, 143);
  });
});

describe("ipc: renderer-named project directories", () => {
  it("refuses a project the user never opened", async () => {
    const h = setup();
    const secret = path.join(h.outside, "secret.txt");
    const named = await h.call("spec:read", secret, h.outside);
    assert.equal(named.ok, false);
    assert.match(named.error, /unknown project/);
    const etc = await h.call("spec:read", "/etc/hosts", "/etc");
    assert.equal(etc.ok, false);
    assert.match(etc.error, /unknown project/);
    const fallback = await h.call("spec:read", secret);
    assert.equal(fallback.ok, false);
    assert.match(fallback.error, /path outside project/);
    for (const channel of ["specs:list", "project:inspect", "project:locks"]) {
      const result = await h.call(channel, h.outside);
      assert.equal(result.ok, false, channel);
    }
  });

  it("serves the active and recent projects", async () => {
    const h = setup();
    const active = await h.call(
      "spec:read",
      path.join(h.project, "flows", "demo.yml"),
      h.project,
    );
    assert.equal(active.ok, true);
    const recent = await h.call(
      "spec:read",
      path.join(h.other, "flows", "other.yml"),
      h.other,
    );
    assert.equal(recent.ok, true);
  });

  it("re-opens only recent projects", async () => {
    const h = setup();
    const refused = await h.call("projects:open-recent", h.outside);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not a recent project/);
    assert.notEqual(h.settings().activeProject, h.outside);
    const reopened = await h.call("projects:open-recent", h.other);
    assert.equal(reopened.ok, true);
    assert.equal(h.settings().activeProject, h.other);
  });
});

describe("ipc: spec writes", () => {
  it("writes YAML inside the project only", async () => {
    const h = setup();
    const outsideTarget = path.join(h.outside, "written.yml");
    const named = await h.call("spec:write", outsideTarget, SPEC, h.outside);
    assert.equal(named.ok, false);
    const plain = await h.call("spec:write", outsideTarget, SPEC);
    assert.equal(plain.ok, false);
    assert.equal(fs.existsSync(outsideTarget), false);

    const shellFile = await h.call(
      "spec:write",
      path.join(h.project, "tools", "run.sh"),
      "echo hi",
    );
    assert.equal(shellFile.ok, false);
    assert.match(shellFile.error, /only \.yml\/\.yaml/);
    assert.equal(fs.existsSync(path.join(h.project, "tools", "run.sh")), false);

    const spec = await h.call(
      "spec:write",
      path.join(h.project, "flows", "new.yml"),
      SPEC,
    );
    assert.equal(spec.ok, true);
    assert.equal(
      fs.readFileSync(path.join(h.project, "flows", "new.yml"), "utf8"),
      SPEC,
    );
  });
});

describe("ipc: settings", () => {
  it("settings:update patches run/ui only", async () => {
    const h = setup();
    for (const patch of [
      {
        projectSettings: { [h.project]: { launchTemplate: "sh -c x {spec}" } },
      },
      { cairnBin: "/bin/sh" },
      { artifactRoot: "/" },
      { activeProject: h.outside },
      { projects: [{ path: h.outside }] },
    ]) {
      const result = await h.call("settings:update", patch);
      assert.equal(result.ok, false, JSON.stringify(patch));
      assert.match(result.error, /cannot change/);
    }
    const flag = await h.call("settings:update", {
      run: { env: "--config=/tmp/x.yml" },
    });
    assert.equal(flag.ok, false);
    const ok = await h.call("settings:update", {
      ui: { density: "compact" },
      run: { env: "staging" },
    });
    assert.equal(ok.ok, true);
    assert.equal(h.settings().ui.density, "compact");
    assert.equal(h.settings().run.env, "staging");
    assert.equal(h.settings().projectSettings[h.project], undefined);
  });

  it("asks before using a binary not named cairn, and honours Cancel", async () => {
    const h = setup();
    const wrapper = script(path.join(h.bin, "wrapper.sh"), "echo '{}'");
    fake.dialogResponse = 1;
    const cancelled = await h.call("settings:set-cairn-bin", wrapper);
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.error, /not changed/);
    assert.equal(dialogCalls.length, 1);
    assert.match(dialogCalls[0].detail, /wrapper\.sh/);
    assert.equal(h.settings().cairnBin, h.cairn);

    fake.dialogResponse = 0;
    const confirmed = await h.call("settings:set-cairn-bin", wrapper);
    assert.equal(confirmed.ok, true);
    assert.equal(h.settings().cairnBin, wrapper);

    // A `cairn…` executable needs no confirmation; a non-executable is refused.
    dialogCalls.length = 0;
    const named = await h.call("settings:set-cairn-bin", h.cairn);
    assert.equal(named.ok, true);
    assert.equal(dialogCalls.length, 0);
    const notExec = await h.call(
      "settings:set-cairn-bin",
      path.join(h.outside, "secret.txt"),
    );
    assert.equal(notExec.ok, false);
  });

  it("refuses a root that would expose everything, confirms a typed one, trusts a picked one", async () => {
    const h = setup();
    const slash = await h.call("settings:set-artifact-root", "/");
    assert.equal(slash.ok, false);
    assert.match(slash.error, /filesystem root/);

    const typed = path.join(h.base, "typed-runs");
    fake.dialogResponse = 1;
    const cancelled = await h.call("settings:set-artifact-root", typed);
    assert.equal(cancelled.ok, false);
    assert.equal(dialogCalls.length, 1);
    assert.equal(h.settings().artifactRoot, h.runsRoot);

    fake.dialogResponse = 0;
    assert.equal((await h.call("settings:set-artifact-root", typed)).ok, true);
    assert.equal(h.settings().artifactRoot, typed);

    dialogCalls.length = 0;
    const picked = path.join(h.base, "picked-runs");
    fs.mkdirSync(picked);
    fake.openDirectory = picked;
    assert.equal((await h.call("dialog:open-directory")).data, picked);
    assert.equal((await h.call("settings:set-artifact-root", picked)).ok, true);
    assert.equal(
      dialogCalls.length,
      0,
      "a dialog-picked folder is not re-confirmed",
    );
    assert.equal(h.settings().artifactRoot, picked);
  });
});

describe("ipc: heal and prune argv", () => {
  it("heals with Run's environment and vars, and per-call overrides", async () => {
    const h = setup();
    const spec = path.join(h.project, "flows", "demo.yml");
    assert.equal(
      (
        await h.call("settings:update", {
          run: { env: "staging", vars: ["tenant=acme"] },
        })
      ).ok,
      true,
    );
    const healed = await h.call("spec:heal", { spec });
    assert.equal(healed.ok, true, healed.error);
    const argv = fs.readFileSync(path.join(h.bin, "healed.txt"), "utf8");
    assert.match(
      argv,
      /^spec heal .*demo\.yml --env staging .*--var tenant=acme/,
    );

    const override = await h.call("spec:heal", {
      spec,
      env: "local",
      vars: ["tenant=other"],
    });
    assert.equal(override.ok, true, override.error);
    const second = fs.readFileSync(path.join(h.bin, "healed.txt"), "utf8");
    assert.match(second, /--env local .*--var tenant=other/);
    assert.doesNotMatch(second, /staging|tenant=acme/);
  });

  it("prunes with --keep N (the flag cairn clean registers)", async () => {
    const h = setup();
    const pruned = await h.call("clean:runs", { keepRuns: 2 });
    assert.equal(pruned.ok, true, pruned.error);
    const argv = fs.readFileSync(path.join(h.bin, "cleaned.txt"), "utf8");
    assert.match(argv, /^clean --artifact-root .* --format json --keep 2$/m);
    assert.doesNotMatch(argv, /--keep-runs/);
  });
});

describe("ipc: launch templates and the suite lock", () => {
  it("confirms a new template in a native dialog, and Cancel keeps the old one", async () => {
    const h = setup();
    const template = `${h.launcher} {spec}`;
    fake.dialogResponse = 1;
    const cancelled = await h.call("project:launch-update", {
      launchTemplate: template,
      lockFiles: [],
    });
    assert.equal(cancelled.ok, false);
    assert.match(cancelled.error, /not changed/);
    assert.equal(dialogCalls.length, 1);
    assert.match(dialogCalls[0].detail, /launcher\.sh \{spec\}/);
    assert.equal(h.settings().projectSettings?.[h.project], undefined);

    fake.dialogResponse = 0;
    const saved = await h.call("project:launch-update", {
      launchTemplate: template,
      lockFiles: [],
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.launchTemplate, template);

    // Unchanged template (only lock files edited): no new confirmation.
    dialogCalls.length = 0;
    const locksOnly = await h.call("project:launch-update", {
      launchTemplate: template,
      lockFiles: ["runs/.suite.lock"],
    });
    assert.equal(locksOnly.ok, true);
    assert.equal(dialogCalls.length, 0);
  });

  it("refuses every run while a lock exists (no force override), then runs", async () => {
    const h = setup();
    assert.equal(
      (
        await h.call("project:launch-update", {
          launchTemplate: null,
          lockFiles: [".suite.lock"],
        })
      ).ok,
      true,
    );
    write(h.project, ".suite.lock", JSON.stringify({ owner: "nightly" }));
    const spec = path.join(h.project, "flows", "demo.yml");
    const refused = await h.call("run:start", { specs: [spec], force: true });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /suite in progress/);
    assert.match(refused.error, /nightly/);
    // Heal re-runs the spec (preconditions included): gated the same way.
    const heal = await h.call("spec:heal", { spec });
    assert.equal(heal.ok, false);
    assert.match(heal.error, /suite in progress.*Heal is disabled/);
    assert.equal(fs.existsSync(path.join(h.bin, "ran.txt")), false);

    fs.rmSync(path.join(h.project, ".suite.lock"));
    const started = await h.call("run:start", { specs: [spec] });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.data.launcher, "cairn");
    const done = await waitForSent(h.sent, "run:done");
    assert.equal(done.ok, true);
    assert.match(
      fs.readFileSync(path.join(h.bin, "ran.txt"), "utf8"),
      /^run .*demo\.yml/,
    );
  });

  it("asks before a config change lifts a held lock (remove entry, reset)", async () => {
    const h = setup();
    assert.equal(
      (
        await h.call("project:launch-update", {
          launchTemplate: null,
          lockFiles: [".suite.lock"],
        })
      ).ok,
      true,
    );
    // Not held: editing the list needs no confirmation.
    assert.equal(
      (
        await h.call("project:launch-update", {
          launchTemplate: null,
          lockFiles: [".suite.lock", ".other.lock"],
        })
      ).ok,
      true,
    );
    assert.equal(dialogCalls.length, 0);

    write(h.project, ".suite.lock", "nightly");
    fake.dialogResponse = 1;
    const removal = await h.call("project:launch-update", {
      launchTemplate: null,
      lockFiles: [".other.lock"],
    });
    assert.equal(removal.ok, false);
    assert.match(removal.error, /lock files not changed/);
    assert.match(dialogCalls[0].detail, /\.suite\.lock/);
    const reset = await h.call("settings:reset");
    assert.equal(reset.ok, false);
    assert.match(reset.error, /not reset/);
    // The gate still holds.
    const run = await h.call("run:start", {
      specs: [path.join(h.project, "flows", "demo.yml")],
    });
    assert.equal(run.ok, false);
    assert.match(run.error, /suite in progress/);

    fake.dialogResponse = 0;
    assert.equal((await h.call("settings:reset")).ok, true);
    assert.equal(h.settings().cairnBin, null);
  });

  it("spawns the confirmed template instead of cairn run", async () => {
    const h = setup();
    assert.equal(
      (
        await h.call("project:launch-update", {
          launchTemplate: `${h.launcher} FLOW={spec}`,
          lockFiles: [],
        })
      ).ok,
      true,
    );
    const started = await h.call("run:start", {
      specs: [path.join(h.project, "flows", "demo.yml")],
    });
    assert.equal(started.ok, true, started.error);
    assert.equal(started.data.launcher, "template");
    await waitForSent(h.sent, "run:done");
    assert.equal(
      fs.readFileSync(path.join(h.bin, "launched.txt"), "utf8").trim(),
      "FLOW=flows/demo.yml",
    );
  });

  it("refuses a spec outside the project and override flags that read as flags", async () => {
    const h = setup();
    const outsideSpec = await h.call("run:start", {
      specs: [path.join(h.outside, "evil.yml")],
    });
    assert.equal(outsideSpec.ok, false);
    assert.match(outsideSpec.error, /outside project/);
    const flagged = await h.call("run:start", {
      specs: [path.join(h.project, "flows", "demo.yml")],
      overrides: { env: "--artifact-root=/" },
    });
    assert.equal(flagged.ok, false);
    assert.match(flagged.error, /cannot start with "-"/);
  });
});

describe("ipc: run references", () => {
  it("opens a restored stash's report and artifacts by its folder", async () => {
    const h = setup();
    const restored = await h.call("stash:restore", "stash_abc");
    assert.equal(restored.ok, true, restored.error);
    const runDir = restored.data.runDir;
    assert.equal(path.basename(runDir), RESTORED_RUN);
    try {
      const detail = await h.call("run:detail", runDir);
      assert.equal(detail.ok, true, detail.error);
      assert.equal(detail.data.runDir, runDir);

      // What the UI sends now (Studio.runRefOf → runDir) works …
      const report = await h.call("run:open-report", runDir, null, "external");
      assert.equal(report.ok, true, report.error);
      const reveal = await h.call("run:reveal", runDir, "report.html");
      assert.equal(reveal.ok, true, reveal.error);
      assert.deepEqual(shellCalls, [
        ["open", path.join(runDir, "report.html")],
        ["reveal", path.join(runDir, "report.html")],
      ]);
      // … while the bare id only resolves inside the local artifact root.
      const byId = await h.call(
        "run:open-report",
        RESTORED_RUN,
        null,
        "external",
      );
      assert.equal(byId.ok, false);
      assert.match(byId.error, /unknown run/);
    } finally {
      fs.rmSync(restored.data.restoredTo, { recursive: true, force: true });
    }
  });

  it("refuses absolute run refs that are not run folders inside the roots", async () => {
    const h = setup();
    write(h.runsRoot, "notes/secret.txt", "x");
    for (const ref of [
      path.join(h.runsRoot, "notes"),
      h.runsRoot,
      h.project,
      h.outside,
    ]) {
      const result = await h.call("run:artifact-text", {
        runDir: ref,
        path: "secret.txt",
      });
      assert.equal(result.ok, false, ref);
      assert.match(result.error, /unknown run/);
    }
  });

  it("serves a hook log from the run's invocation journal, never elsewhere", async () => {
    const h = setup();
    const invocation = "2026-10-02T06-03-43-993Z_12486_5f0347";
    const runId = "2026-10-02T06-03-44-062Z_orders_flow_ec1d04";
    const runDir = path.join(h.runsRoot, runId);
    write(
      runDir,
      "run.json",
      JSON.stringify({
        runId,
        status: "failed",
        invocation: {
          id: invocation,
          index: 1,
          total: 1,
          dir: `_invocations/${invocation}`,
        },
      }),
    );
    const journal = path.join(h.runsRoot, "_invocations", invocation);
    write(journal, `logs/hook-after-01-${runId}.log`, "collecting metrics\n");
    const read = await h.call("run:journal-text", {
      runDir,
      path: `logs/hook-after-01-${runId}.log`,
    });
    assert.equal(read.ok, true, read.error);
    assert.equal(read.data.ok, true, read.data.error);
    assert.equal(read.data.text, "collecting metrics\n");

    const escape = await h.call("run:journal-text", {
      runDir,
      path: `../../${runId}/run.json`,
    });
    assert.equal(escape.data.ok, false);
    assert.match(escape.data.error, /escapes/);

    const noJournal = path.join(h.runsRoot, RESTORED_RUN);
    write(noJournal, "run.json", JSON.stringify({ runId: RESTORED_RUN }));
    const missing = await h.call("run:journal-text", {
      runDir: noJournal,
      path: "logs/hook-before-01.log",
    });
    assert.equal(missing.data.ok, false);
    assert.match(missing.data.error, /no invocation journal/);
  });

  it("allow-lists only a YAML spec path from a run record", async () => {
    const h = setup();
    const runDir = path.join(h.runsRoot, RESTORED_RUN);
    write(
      runDir,
      "run.json",
      JSON.stringify({
        runId: RESTORED_RUN,
        status: "failed",
        spec: { name: "x", path: path.join(h.outside, "secret.txt") },
      }),
    );
    assert.equal((await h.call("run:detail", runDir)).ok, true);
    const read = await h.call("spec:read", path.join(h.outside, "secret.txt"));
    assert.equal(read.ok, false, "a run record cannot unlock a non-YAML file");

    write(
      runDir,
      "run.json",
      JSON.stringify({
        runId: RESTORED_RUN,
        status: "failed",
        spec: { name: "x", path: path.join(h.outside, "evil.yml") },
      }),
    );
    assert.equal((await h.call("run:detail", runDir)).ok, true);
    assert.equal(
      (await h.call("spec:read", path.join(h.outside, "evil.yml"))).ok,
      true,
    );
  });
});

describe("ipc: config registries and the fixture ledger (wave 4)", () => {
  const SECRET = "hunter2-very-secret";

  it("sends the config without its env-substituted document, registries redacted", async () => {
    const h = setup();
    write(
      h.project,
      "cairntrace.config.yml",
      [
        "project: shop",
        "datasources:",
        "  app_db:",
        "    kind: mongo",
        "    uri: ${env.CAIRN_IPC_TEST_MONGO_URI}",
        "    database: shop",
        "  reports_db:",
        "    kind: mongo",
        `    uri: mongodb://reporter:${SECRET}@db.local/reports`,
        "    database: reports",
        "environments:",
        "  local:",
        "    baseUrl: http://localhost:8787",
        "  staging:",
        "    baseUrl: https://qa:${env.CAIRN_IPC_TEST_STAGING_PW}@staging.example.test",
        "    datasources:",
        "      app_db:",
        `        uri: \${env.CAIRN_IPC_TEST_UNSET_URI:-mongodb://root:${SECRET}@localhost:27017/app}`,
        "gates:",
        "  db:",
        `    command: mongosh -u root -p ${SECRET} --quiet --eval 1`,
        "  db2:",
        "    command:",
        `      run: docker exec demo-mongo mongosh --username root --password ${SECRET}`,
        "  api:",
        `    command: "curl -fsS -H 'Cookie: session=${SECRET}' http://localhost:8787/health"`,
        "",
      ].join("\n"),
    );
    const previous = process.env.CAIRN_IPC_TEST_MONGO_URI;
    const previousPw = process.env.CAIRN_IPC_TEST_STAGING_PW;
    process.env.CAIRN_IPC_TEST_MONGO_URI = `mongodb://app:${SECRET}@db.local/shop`;
    process.env.CAIRN_IPC_TEST_STAGING_PW = SECRET;
    try {
      const result = await h.call("project:inspect", h.project);
      assert.equal(result.ok, true, result.error);
      const config = result.data.config;
      assert.equal("raw" in config, false, "no parsed document");
      assert.ok(!JSON.stringify(result.data).includes(SECRET));
      const targets = Object.fromEntries(
        config.registries.datasources.topLevel.map((/** @type {any} */ ds) => [
          ds.name,
          ds.target,
        ]),
      );
      assert.deepEqual(targets, {
        app_db: "${env.CAIRN_IPC_TEST_MONGO_URI}",
        reports_db: "mongodb://***@db.local/reports",
      });
      const staging = config.registries.datasources.environments.find(
        (/** @type {any} */ env) => env.env === "staging",
      );
      assert.equal(
        staging.datasources.find(
          (/** @type {any} */ ds) => ds.name === "app_db",
        ).target,
        "${env.CAIRN_IPC_TEST_UNSET_URI:-mongodb://***@localhost:27017/app}",
      );
      const gates = Object.fromEntries(
        config.registries.gates.map((/** @type {any} */ gate) => [
          gate.name,
          gate.target,
        ]),
      );
      assert.deepEqual(gates, {
        db: "mongosh -u root -p •••••• --quiet --eval 1",
        db2: "docker exec demo-mongo mongosh --username root --password ••••••",
        api: "curl -fsS -H 'Cookie: ••••••' http://localhost:8787/health",
      });
      // the env-substituted baseUrl goes out redacted
      assert.deepEqual(
        config.environments.map((/** @type {any} */ env) => env.baseUrl),
        ["http://localhost:8787", "https://***@staging.example.test"],
      );
    } finally {
      if (previous === undefined) delete process.env.CAIRN_IPC_TEST_MONGO_URI;
      else process.env.CAIRN_IPC_TEST_MONGO_URI = previous;
      if (previousPw === undefined)
        delete process.env.CAIRN_IPC_TEST_STAGING_PW;
      else process.env.CAIRN_IPC_TEST_STAGING_PW = previousPw;
    }
  });

  it("reads the project's fixture ledger by the config's project name, outputs masked", async () => {
    const h = setup();
    write(h.project, "cairntrace.config.yml", "project: shop\n");
    write(
      h.fixturesLedgerDir,
      "shop.ledger.jsonl",
      `${JSON.stringify({
        v: 1,
        ts: "2026-10-02T09:00:00.000Z",
        project: "shop",
        env: "local",
        name: "demo_order",
        adapter: "mongo",
        scope: "suite",
        verb: "ensure",
        status: "ok",
        defHash: "abc",
        origin: "run",
        outputs: { orderId: "o1", password: SECRET },
      })}\n`,
    );
    const result = await h.call("fixtures:ledger", h.project);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.exists, true);
    assert.equal(result.data.project, "shop");
    assert.equal(result.data.entries[0].env, "local");
    assert.equal(result.data.entries[0].state, "live");
    assert.deepEqual(result.data.entries[0].outputs, [
      ["orderId", "o1"],
      ["password", "••••••"],
    ]);
    assert.ok(!JSON.stringify(result.data).includes(SECRET));
  });

  it("names no file outside the ledger folder and refuses unknown projects", async () => {
    const h = setup();
    write(h.project, "cairntrace.config.yml", "project: ../../outside\n");
    write(h.outside, "outside.ledger.jsonl", '{"name":"x"}\n');
    const result = await h.call("fixtures:ledger", h.project);
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.exists, false);
    assert.ok(
      result.data.path === null ||
        path.dirname(result.data.path) === path.resolve(h.fixturesLedgerDir),
    );
    const refused = await h.call("fixtures:ledger", h.outside);
    assert.equal(refused.ok, false);
    assert.match(refused.error, /unknown project/);
  });
});

describe("ipc: wave-5 evidence and registries", () => {
  const primitives = require("./primitives-fixture");
  const PLANTED = primitives.SECRET;

  it("serves widget and request evidence summarized, a planted credential never", async () => {
    const h = setup();
    primitives.makeRunA(h.runsRoot);
    const result = await h.call("run:detail", primitives.RUN_A, h.project);
    assert.equal(result.ok, true, result.error);
    const detail = result.data;
    assert.deepEqual(
      detail.widgets.map((/** @type {any} */ entry) => entry.path),
      [
        "widgets/002_profile_form.json",
        "widgets/006_pick_row_i1.json",
        "widgets/006_pick_row_i2.json",
      ],
    );
    assert.equal(
      detail.requests.find(
        (/** @type {any} */ entry) => entry.assign === "denied",
      ).matrix.mismatched,
      1,
    );
    // run.json keeps the F14 / F15 fields for the renderer
    assert.equal(
      detail.steps.find((/** @type {any} */ step) => step.id === "submit_retry")
        .retries.length,
      1,
    );
    assert.ok(!JSON.stringify(detail).includes(PLANTED));
  });

  it("sends the widget registry and auth blocks by name, never their values", async () => {
    const h = setup();
    write(
      h.project,
      "cairntrace.config.yml",
      [
        "project: profiles",
        "browser:",
        "  widgets:",
        "    - use: pills",
        "    - file: ./drivers/upper.js",
        "  appHandle:",
        "    store: window.appStore",
        "environments:",
        "  local:",
        "    baseUrl: http://localhost:4567",
        "    auth:",
        "      login:",
        "        url: /api/login",
        `        headers: { x-api-key: ${PLANTED} }`,
        "        body:",
        "          email: ${secrets.E2E_EMAIL}",
        `          password: ${PLANTED}`,
        "      hydrate:",
        "        eval: window.__signedIn = true",
        "",
      ].join("\n"),
    );
    const result = await h.call("project:inspect", h.project);
    assert.equal(result.ok, true, result.error);
    const config = result.data.config;
    assert.ok(!JSON.stringify(result.data).includes(PLANTED));
    assert.deepEqual(config.registries.auth, [
      {
        env: "local",
        login: { method: "POST", path: "/api/login" },
        alreadyAuthenticated: null,
        after: [],
        hydrate: "inline script",
        secrets: ["E2E_EMAIL"],
      },
    ]);
    assert.equal(config.registries.widgets.declared, true);
    assert.deepEqual(config.registries.widgets.appHandles, ["store"]);
    assert.deepEqual(
      config.registries.widgets.drivers
        .slice(0, 2)
        .map((/** @type {any} */ driver) => driver.name),
      ["pills", "upper.js"],
    );
  });
});

describe("ipc: channel allowlist", () => {
  it("every preload invoke channel has a handler, and every handler is reachable", () => {
    setup();
    const source = fs.readFileSync(
      path.join(__dirname, "..", "preload.js"),
      "utf8",
    );
    const block = /INVOKE_CHANNELS = new Set\(\[([\s\S]*?)\]\)/.exec(source);
    assert.ok(block, "INVOKE_CHANNELS not found in preload.js");
    const allowed = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    const registered = [...handlers.keys()];
    assert.deepEqual(
      allowed.filter((channel) => !handlers.has(channel)),
      [],
      "preload allows channels nobody handles",
    );
    assert.deepEqual(
      registered.filter((channel) => !allowed.includes(channel)),
      [],
      "handlers the renderer cannot reach",
    );
  });
});

/**
 * Resolves with the exit code once a child process has exited.
 * @param {import("node:child_process").ChildProcess} child
 */
function exited(child) {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null)
      resolve(child.exitCode);
    else child.once("exit", (code) => resolve(code));
  });
}

/**
 * @param {number} pid
 * @returns {boolean}
 */
function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe("ipc: invocations", () => {
  /** @type {import("node:child_process").ChildProcess[]} */
  const children = [];
  after(() => {
    for (const child of children) {
      if (child.exitCode !== null || child.signalCode !== null) continue;
      try {
        // A detached fake leads its own group: take its hook child too.
        process.kill(-(/** @type {number} */ (child.pid)), "SIGKILL");
      } catch {
        child.kill("SIGKILL");
      }
    }
  });

  /**
   * Write a journal for `pid` (its id embeds the pid, as the runner's does).
   * @param {string} runsRoot
   * @param {number} pid
   * @param {Record<string, any>} [overrides]
   */
  function journalFor(runsRoot, pid, overrides = {}) {
    // `overrides.invocationId` rewrites an existing journal in place.
    const id =
      overrides.invocationId ??
      `${new Date().toISOString().replace(/[:.]/g, "-")}_${pid}_${(
        0xabc000 +
        (pid % 0xfff)
      ).toString(16)}`;
    write(
      path.join(runsRoot, "_invocations", id),
      "invocation.json",
      JSON.stringify({
        version: 1,
        invocationId: id,
        pid,
        argv: ["run", "flows/demo.yml"],
        cwd: "/tmp/project",
        parallel: 1,
        planned: [{ index: 1, spec: "flows/demo.yml" }],
        status: "running",
        startedAt: new Date(Date.now() + 1000).toISOString(),
        current: { index: 1, spec: "flows/demo.yml" },
        runs: [],
        ...overrides,
      }),
    );
    return id;
  }

  /**
   * A long-running fake `cairn` that records SIGINT and exits 130. With
   * `hook`, it first runs a foreground `sh -c '…; exec sleep 30'`, the shape
   * of a compound --before hook: SIGINT to the fake alone waits for that
   * sleep, while SIGINT to its process group ends both at once. `detached`
   * makes it lead its own process group, as a terminal job or a Studio run
   * does.
   * @param {string} dir
   * @param {{ args?: string[], hook?: boolean, detached?: boolean }} [options]
   */
  function spawnFakeCairn(dir, options = {}) {
    const tools = path.join(dir, "tools");
    const bin = script(
      path.join(tools, "cairn"),
      [
        `trap 'echo interrupted > "$here/sigint.txt"; exit 130' INT`,
        'here="$(cd "$(dirname "$0")" && pwd)"',
        options.hook
          ? `/bin/sh -c 'echo $$ > "$1/hook.pid"; exec sleep 30' hook "$here"`
          : "",
        ': > "$here/ready.txt"',
        "while :; do sleep 0.1; done",
      ].join("\n"),
    );
    const { spawn } = require("node:child_process");
    const child = spawn(bin, options.args ?? ["run", "flows/demo.yml"], {
      stdio: "ignore",
      detached: Boolean(options.detached),
    });
    children.push(child);
    // The trap is installed before the hook starts, and before ready.txt.
    const ready = path.join(tools, options.hook ? "hook.pid" : "ready.txt");
    const waitReady = async () => {
      const deadline = Date.now() + 5000;
      while (!fs.existsSync(ready) && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 20));
      // hook.pid exists once `echo` opened it; wait for the pid itself.
      while (
        options.hook &&
        !fs.readFileSync(ready, "utf8").trim() &&
        Date.now() < deadline
      )
        await new Promise((resolve) => setTimeout(resolve, 20));
    };
    return {
      child,
      waitReady,
      sigintFile: path.join(tools, "sigint.txt"),
      hookPid: () => Number(fs.readFileSync(ready, "utf8").trim()),
    };
  }

  it("lists journals with origin and client, and reads one by id", async () => {
    const h = setup();
    const id = journalFor(h.runsRoot, 4242, {
      status: "passed",
      origin: "mcp",
      client: "an-agent",
      endedAt: new Date().toISOString(),
    });
    const list = await h.call("invocations:list", { limit: 5 });
    assert.equal(list.ok, true, list.error);
    assert.equal(list.data.invocations.length, 1);
    assert.equal(list.data.invocations[0].origin, "mcp");
    assert.equal(list.data.invocations[0].client, "an-agent");
    assert.ok(list.data.invocations[0].eta);
    const one = await h.call("invocation:get", { invocationId: id });
    assert.equal(one.data.invocationId, id);
    const bad = await h.call("invocation:get", { invocationId: "../x" });
    assert.equal(bad.data, null);
  });

  it("never signals a finished invocation or a non-cairn process", async () => {
    const h = setup();
    const done = journalFor(h.runsRoot, 4343, { status: "failed" });
    const finished = await h.call("invocation:stop", { invocationId: done });
    assert.equal(finished.ok, false);
    assert.match(finished.error, /already ended/);

    const { spawn } = require("node:child_process");
    const sleeper = spawn("sleep", ["30"], { stdio: "ignore" });
    children.push(sleeper);
    const id = journalFor(h.runsRoot, /** @type {number} */ (sleeper.pid));
    const refused = await h.call("invocation:stop", { invocationId: id });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /not a cairn process/);
    assert.equal(dialogCalls.length, 0, "no dialog for a refused stop");
    assert.equal(sleeper.exitCode, null, "the process was not signalled");
  });

  it("sends SIGINT to a live cairn process only after the native confirm", async () => {
    const h = setup();
    const { child, sigintFile, waitReady } = spawnFakeCairn(h.base);
    // The trap must be installed before the signal arrives.
    await waitReady();
    const id = journalFor(h.runsRoot, /** @type {number} */ (child.pid));

    fake.dialogResponse = 1;
    const cancelled = await h.call("invocation:stop", { invocationId: id });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.deepEqual(cancelled.data, { stopped: false, cancelled: true });
    assert.equal(dialogCalls.length, 1);
    assert.match(dialogCalls[0].detail, /SIGINT/);
    assert.match(dialogCalls[0].detail, new RegExp(`pid ${child.pid}`));
    assert.equal(dialogCalls[0].buttons[0], "Stop run");
    assert.equal(child.exitCode, null, "cancel leaves the process running");

    // Spawned without `detached`, the fake shares this test's process group:
    // only its pid may be signalled, and the dialog says hooks may linger.
    assert.match(dialogCalls[0].detail, new RegExp(`pid ${child.pid} only`));
    assert.match(dialogCalls[0].detail, /may outlive it/);

    fake.dialogResponse = 0;
    const stopped = await h.call("invocation:stop", { invocationId: id });
    assert.equal(stopped.ok, true, stopped.error);
    assert.deepEqual(stopped.data, {
      stopped: true,
      pid: child.pid,
      signal: "SIGINT",
      target: "process",
    });
    assert.equal(await exited(child), 130);
    assert.equal(fs.readFileSync(sigintFile, "utf8").trim(), "interrupted");
  });

  it("signals the whole process group when cairn leads it, like Ctrl-C", async () => {
    const h = setup();
    const { child, sigintFile, waitReady, hookPid } = spawnFakeCairn(h.base, {
      hook: true,
      detached: true,
    });
    await waitReady();
    const hook = hookPid();
    assert.ok(pidAlive(hook), "the hook is running");
    const id = journalFor(h.runsRoot, /** @type {number} */ (child.pid));
    const stopped = await h.call("invocation:stop", { invocationId: id });
    assert.equal(stopped.ok, true, stopped.error);
    assert.equal(stopped.data.target, "group");
    assert.match(dialogCalls[0].detail, /process group/);
    // The hook's sleep got SIGINT too, so the fake's trap ran at once
    // instead of after the 30s sleep.
    const code = await Promise.race([
      exited(child),
      new Promise((resolve) =>
        setTimeout(() => resolve("still running"), 5000),
      ),
    ]);
    assert.equal(code, 130);
    assert.equal(fs.readFileSync(sigintFile, "utf8").trim(), "interrupted");
    const deadline = Date.now() + 3000;
    while (pidAlive(hook) && Date.now() < deadline)
      await new Promise((resolve) => setTimeout(resolve, 20));
    assert.equal(pidAlive(hook), false, "the hook subprocess was not orphaned");
  });

  it("re-checks after the dialog and sends nothing when the run ended meanwhile", async () => {
    const h = setup();
    const { child, sigintFile, waitReady } = spawnFakeCairn(h.base);
    await waitReady();
    const id = journalFor(h.runsRoot, /** @type {number} */ (child.pid));
    // The run finishes while the user reads the confirmation.
    fake.whileDialogOpen = async () => {
      journalFor(h.runsRoot, /** @type {number} */ (child.pid), {
        invocationId: id,
        status: "passed",
        endedAt: new Date().toISOString(),
      });
    };
    const result = await h.call("invocation:stop", { invocationId: id });
    assert.equal(dialogCalls.length, 1, "the dialog was shown");
    assert.equal(result.ok, false);
    assert.match(result.error, /not stopped: invocation already ended/);
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(fs.existsSync(sigintFile), false, "no SIGINT was sent");
    assert.equal(child.exitCode, null, "the process is untouched");
    child.kill("SIGKILL");
  });

  it("warns that an MCP-origin stop ends the whole MCP server", async () => {
    const h = setup();
    const { child, waitReady } = spawnFakeCairn(h.base, { args: ["mcp"] });
    await waitReady();
    const id = journalFor(h.runsRoot, /** @type {number} */ (child.pid), {
      origin: "mcp",
      client: "an-agent",
    });
    fake.dialogResponse = 1;
    const result = await h.call("invocation:stop", { invocationId: id });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.stopped, false);
    assert.equal(dialogCalls[0].buttons[0], "Stop MCP server");
    assert.match(dialogCalls[0].detail, /MCP server \(client: an-agent\)/);
    child.kill("SIGKILL");
  });

  it("knows an MCP server by its command line, whatever the journal says", async () => {
    const h = setup();
    const { child, waitReady } = spawnFakeCairn(h.base, { args: ["mcp"] });
    await waitReady();
    // No origin in the journal: still the MCP warning.
    const bare = journalFor(h.runsRoot, /** @type {number} */ (child.pid));
    fake.dialogResponse = 1;
    const warned = await h.call("invocation:stop", { invocationId: bare });
    assert.equal(warned.ok, true, warned.error);
    assert.equal(dialogCalls[0].buttons[0], "Stop MCP server");
    // A journal claiming a CLI run that points at an MCP server: refused
    // before any dialog.
    dialogCalls.length = 0;
    const cli = journalFor(h.runsRoot, /** @type {number} */ (child.pid), {
      invocationId: bare,
      origin: "cli",
    });
    const refused = await h.call("invocation:stop", { invocationId: cli });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /origin "cli" but process \d+ is `cairn mcp`/);
    assert.equal(dialogCalls.length, 0);
    assert.equal(child.exitCode, null);
    child.kill("SIGKILL");
  });
});

describe("ipc: publish, pin and policy (contract 2b)", () => {
  const RUN = "2026-10-02T10-00-00-000Z_checkout_e0e0e0";

  /**
   * A finished run in the artifact root plus a fake cairn that records its
   * argv and writes what the real CLI would: publish-receipt.json and an
   * artifact.publish event on publish, a pinned run.json on pin.
   * @param {{ webUrl?: string, publishFails?: boolean }} [options]
   */
  function evidenceSetup(options = {}) {
    const h = setup();
    const runDir = path.join(h.runsRoot, RUN);
    const record = {
      runId: RUN,
      status: "failed",
      spec: {
        name: "checkout",
        path: path.join(h.project, "flows", "demo.yml"),
      },
    };
    write(runDir, "run.json", JSON.stringify(record));
    write(runDir, "events.ndjson", "");
    write(
      h.bin,
      "receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: "fcheap://cloud/vaults/private/artifacts/e0",
        sha256: "e".repeat(64),
        sizeBytes: 4096,
        publishedAt: "2026-10-02T10:00:00.000Z",
        expiresAt: "2026-10-09T10:00:00.000Z",
        webUrl: options.webUrl ?? "https://file.cheap/a/e0",
      }),
    );
    write(
      h.bin,
      "publish-error.ndjson",
      `${JSON.stringify({
        type: "artifact.publish",
        status: "error",
        reason: "auth",
        message: "device token expired",
      })}\n`,
    );
    write(
      h.bin,
      "pinned.json",
      JSON.stringify({
        ...record,
        pinned: { at: "2026-10-02T10:05:00.000Z", reason: "bug 42" },
      }),
    );
    write(h.bin, "unpinned.json", JSON.stringify(record));
    script(
      h.cairn,
      [
        'here="$(cd "$(dirname "$0")" && pwd)"',
        'if [ "$1" = "stash" ] && [ "$2" = "restore" ]; then',
        `  d="$5/${RESTORED_RUN}"`,
        '  mkdir -p "$d"',
        `  printf '{"runId":"${RESTORED_RUN}","status":"failed"}' > "$d/run.json"`,
        "  echo '{}'; exit 0",
        "fi",
        'case "$1" in publish|pin|unpin) printf "%s\\n" "$*" >> "$here/argv.txt" ;; esac',
        'if [ "$1" = "publish" ]; then',
        options.publishFails
          ? '  cat "$here/publish-error.ndjson" >> "$2/events.ndjson"; echo \'{"status":"error","reason":"auth"}\'; exit 2'
          : '  cp "$here/receipt.json" "$2/publish-receipt.json"; echo \'{"status":"published"}\'; exit 0',
        "fi",
        'if [ "$1" = "pin" ]; then cp "$here/pinned.json" "$2/run.json"; echo \'{"pinned":true}\'; exit 0; fi',
        'if [ "$1" = "unpin" ]; then cp "$here/unpinned.json" "$2/run.json"; echo \'{"pinned":false}\'; exit 0; fi',
        "echo '{}'",
      ].join("\n"),
    );
    const argv = () =>
      fs.existsSync(path.join(h.bin, "argv.txt"))
        ? fs
            .readFileSync(path.join(h.bin, "argv.txt"), "utf8")
            .trim()
            .split("\n")
        : [];
    return { ...h, runDir, argv };
  }

  it("asks natively before publishing, and Cancel uploads nothing", async () => {
    const h = evidenceSetup();
    fake.dialogResponse = 1;
    const cancelled = await h.call("run:publish", h.runDir);
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.deepEqual(cancelled.data, { published: false, cancelled: true });
    assert.equal(dialogCalls.length, 1);
    assert.match(dialogCalls[0].message, /Publish this run to file\.cheap/);
    assert.match(dialogCalls[0].detail, /sanitized, private package/);
    assert.match(dialogCalls[0].detail, /keeps it for 7 days/);
    assert.match(dialogCalls[0].detail, /cairn publish .*e0e0e0 --json/);
    assert.deepEqual(h.argv(), [], "nothing spawned");
    assert.equal(
      fs.existsSync(path.join(h.runDir, "publish-receipt.json")),
      false,
    );
  });

  it("publishes on confirm, returns the receipt, and opens only its https URL", async () => {
    const h = evidenceSetup();
    write(
      h.project,
      "cairntrace.config.yml",
      "retention:\n  publish:\n    enabled: true\n    retentionDays: 14\n",
    );
    // An earlier failed attempt's event never speaks for this one.
    fs.copyFileSync(
      path.join(h.bin, "publish-error.ndjson"),
      path.join(h.runDir, "events.ndjson"),
    );
    const published = await h.call("run:publish", RUN);
    assert.equal(published.ok, true, published.error);
    assert.match(dialogCalls[0].detail, /keeps it for 14 days/);
    assert.deepEqual(h.argv(), [`publish ${h.runDir} --json`]);
    assert.equal(published.data.published, true);
    assert.equal(published.data.error, null);
    assert.equal(
      published.data.receipt.artifactRef,
      "fcheap://cloud/vaults/private/artifacts/e0",
    );
    assert.equal(published.data.receipt.expiresAt, "2026-10-09T10:00:00.000Z");

    const opened = await h.call("run:open-published", h.runDir);
    assert.equal(opened.ok, true, opened.error);
    assert.deepEqual(shellCalls, [["external", "https://file.cheap/a/e0"]]);
  });

  it("never opens a receipt URL that is not https", async () => {
    const h = evidenceSetup({ webUrl: "http://file.cheap/a/e0" });
    const published = await h.call("run:publish", h.runDir);
    assert.equal(published.data.published, true);
    assert.equal(published.data.receipt.webUrl, null);
    const opened = await h.call("run:open-published", h.runDir);
    assert.equal(opened.ok, false);
    assert.match(opened.error, /no https web URL/);
    assert.deepEqual(shellCalls, []);
    const missing = evidenceSetup();
    const none = await missing.call("run:open-published", missing.runDir);
    assert.equal(none.ok, false);
    assert.match(none.error, /no publish-receipt/);
  });

  it("returns the artifact.publish reason when the publish fails", async () => {
    const h = evidenceSetup({ publishFails: true });
    const failed = await h.call("run:publish", h.runDir);
    assert.equal(failed.ok, true, failed.error);
    assert.equal(failed.data.published, false);
    assert.equal(failed.data.exitCode, 2);
    assert.deepEqual(failed.data.error, {
      reason: "auth",
      message: "device token expired",
    });
    assert.equal(failed.data.event.ok, false);
    assert.equal(failed.data.receipt, null);
  });

  it("pins with a reason joined to its flag, and unpins", async () => {
    const h = evidenceSetup();
    const pinned = await h.call("run:pin", {
      runRef: h.runDir,
      reason: "--all the evidence\nfor bug 42",
    });
    assert.equal(pinned.ok, true, pinned.error);
    assert.equal(pinned.data.ok, true);
    assert.deepEqual(pinned.data.pinned, {
      at: "2026-10-02T10:05:00.000Z",
      reason: "bug 42",
    });
    const unpinned = await h.call("run:unpin", { runRef: RUN });
    assert.equal(unpinned.ok, true, unpinned.error);
    assert.equal(unpinned.data.pinned, null);
    assert.deepEqual(h.argv(), [
      `pin ${h.runDir} --reason=--all the evidence for bug 42 --json`,
      `unpin ${h.runDir} --json`,
    ]);
    const tooLong = await h.call("run:pin", {
      runRef: h.runDir,
      reason: "x".repeat(500),
    });
    assert.equal(tooLong.ok, false);
    assert.match(tooLong.error, /longer than/);
  });

  it("pins only finished runs inside the artifact root", async () => {
    const h = evidenceSetup();
    const restored = await h.call("stash:restore", "stash_abc");
    try {
      const refused = await h.call("run:pin", {
        runRef: restored.data.runDir,
      });
      assert.equal(refused.ok, false);
      assert.match(refused.error, /restored stash/);
      const detail = await h.call("run:detail", restored.data.runDir);
      assert.equal(detail.data.restored, true);
      const local = await h.call("run:detail", h.runDir);
      assert.equal(local.data.restored, false);
    } finally {
      fs.rmSync(restored.data.restoredTo, { recursive: true, force: true });
    }
    for (const ref of [h.outside, h.project, "../escape"]) {
      const result = await h.call("run:pin", { runRef: ref });
      assert.equal(result.ok, false, ref);
    }
    const unfinished = path.join(
      h.runsRoot,
      "2026-10-02T11-00-00-000Z_wip_f0f0f0",
    );
    write(unfinished, "events.ndjson", "");
    const wip = await h.call("run:pin", { runRef: unfinished });
    assert.equal(wip.ok, false);
    assert.match(wip.error, /finished run/);
    assert.deepEqual(h.argv(), [], "nothing spawned for refused pins");
  });

  it("answers requires.env opt-ins with booleans, never values", async () => {
    const h = setup();
    const spec = write(
      h.project,
      "flows/reset.yml",
      [
        "intent: reset",
        "requires:",
        "  env:",
        "    - local",
        "    - staging: { optIn: CAIRN_STUDIO_TEST_OPTIN }",
        "    - prod: { optIn: CAIRN_STUDIO_TEST_UNSET }",
        "  mutates: true",
        "steps:",
        "  - open: /",
        "outcomes: []",
        "",
      ].join("\n"),
    );
    process.env.CAIRN_STUDIO_TEST_OPTIN = "1";
    delete process.env.CAIRN_STUDIO_TEST_UNSET;
    try {
      const read = await h.call("spec:read", spec);
      assert.equal(read.ok, true, read.error);
      assert.deepEqual(read.data.optIns, {
        CAIRN_STUDIO_TEST_OPTIN: true,
        CAIRN_STUDIO_TEST_UNSET: false,
      });
      assert.equal(read.data.summary.requires.mutates, true);
    } finally {
      delete process.env.CAIRN_STUDIO_TEST_OPTIN;
    }
  });

  it("links local stash receipts to their runs", async () => {
    const h = evidenceSetup();
    write(
      h.runDir,
      "stash-receipt.json",
      JSON.stringify({
        stashId: "stash_e0",
        status: "saved",
        postSaveFailureCount: 0,
        recordedAt: "2026-10-02T10:01:00.000Z",
        excluded: ["traces/"],
      }),
    );
    const listed = await h.call("stash:receipts");
    assert.equal(listed.ok, true, listed.error);
    assert.equal(listed.data.length, 1);
    assert.equal(listed.data[0].stashId, "stash_e0");
    assert.equal(listed.data[0].runId, RUN);
    assert.deepEqual(listed.data[0].receipt.excluded, ["traces/"]);
  });

  it("refuses a second publish of a run while one is in flight", async () => {
    const h = evidenceSetup();
    /** @type {any} */
    let second = null;
    fake.whileDialogOpen = async () => {
      fake.whileDialogOpen = null;
      second = await h.call("run:publish", RUN);
    };
    const first = await h.call("run:publish", h.runDir);
    assert.equal(first.ok, true, first.error);
    assert.equal(first.data.published, true);
    assert.equal(second?.ok, false);
    assert.match(String(second?.error), /already in progress/);
    assert.equal(dialogCalls.length, 1, "one confirmation, one upload");
    assert.deepEqual(h.argv(), [`publish ${h.runDir} --json`]);
    // settled: the next publish is allowed again
    const third = await h.call("run:publish", h.runDir);
    assert.equal(third.ok, true, third.error);
    assert.equal(h.argv().length, 2);
  });

  it("answers opt-ins from the project's dotenv files the way Bun loads them, case-insensitively", async () => {
    const h = setup();
    const spec = write(
      h.project,
      "flows/optin.yml",
      [
        "intent: optin",
        "requires:",
        "  env:",
        "    - staging: { optIn: CAIRN_STUDIO_DOTENV_A }",
        "    - qa: { optIn: CAIRN_STUDIO_DOTENV_B }",
        "    - prod: { optIn: CAIRN_STUDIO_DOTENV_C }",
        "steps:",
        "  - open: /",
        "outcomes: []",
        "",
      ].join("\n"),
    );
    write(
      h.project,
      ".env",
      "CAIRN_STUDIO_DOTENV_A=TRUE\nCAIRN_STUDIO_DOTENV_B=1\nCAIRN_STUDIO_DOTENV_C=1\n",
    );
    // .env.local wins over .env; the spawn environment wins over both
    write(h.project, ".env.local", "CAIRN_STUDIO_DOTENV_B=0\n");
    process.env.CAIRN_STUDIO_DOTENV_C = "no";
    // Bun skips .env.local when NODE_ENV is "test": pin the default
    const nodeEnv = process.env.NODE_ENV;
    delete process.env.NODE_ENV;
    try {
      const read = await h.call("spec:read", spec);
      assert.equal(read.ok, true, read.error);
      assert.deepEqual(read.data.optIns, {
        CAIRN_STUDIO_DOTENV_A: true,
        CAIRN_STUDIO_DOTENV_B: false,
        CAIRN_STUDIO_DOTENV_C: false,
      });
      // only booleans: no dotenv value reaches the renderer
      assert.doesNotMatch(JSON.stringify(read.data.optIns), /TRUE|"1"|"no"/);

      // spec:write answers the opt-ins of the requires it just saved
      const written = await h.call(
        "spec:write",
        spec,
        [
          "intent: optin",
          "requires:",
          "  env:",
          "    - staging: { optIn: CAIRN_STUDIO_DOTENV_A }",
          "steps:",
          "  - open: /",
          "outcomes: []",
          "",
        ].join("\n"),
      );
      assert.equal(written.ok, true, written.error);
      assert.deepEqual(written.data.optIns, { CAIRN_STUDIO_DOTENV_A: true });
      assert.equal(written.data.summary.requires.env.length, 1);
    } finally {
      delete process.env.CAIRN_STUDIO_DOTENV_C;
      if (nodeEnv !== undefined) process.env.NODE_ENV = nodeEnv;
    }
  });

  it("asks natively before a prune that uploads, and Cancel prunes nothing", async () => {
    const h = setup();
    const cleaned = path.join(h.bin, "cleaned.txt");
    const plain = await h.call("clean:runs", { keepRuns: 2 });
    assert.equal(plain.ok, true, plain.error);
    assert.equal(dialogCalls.length, 0, "no upload, no extra question");
    fs.rmSync(cleaned);

    write(
      h.project,
      "cairntrace.config.yml",
      "retention:\n  archiveToStash: true\n  publish:\n    enabled: true\n    retentionDays: 3\n",
    );
    fake.dialogResponse = 1;
    const cancelled = await h.call("clean:runs", { all: true });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.data.cancelled, true);
    assert.equal(fs.existsSync(cleaned), false, "nothing spawned");
    assert.equal(dialogCalls.length, 1);
    assert.match(dialogCalls[0].message, /Delete every run and upload/);
    assert.match(
      dialogCalls[0].detail,
      /archives it to your file\.cheap stash and publishes it to file\.cheap, kept 3 days/,
    );
    assert.match(dialogCalls[0].detail, /cairn clean --artifact-root .* --all/);

    fake.dialogResponse = 0;
    const confirmed = await h.call("clean:runs", { keepRuns: 1 });
    assert.equal(confirmed.ok, true, confirmed.error);
    assert.equal(confirmed.data.ok, true);
    assert.match(fs.readFileSync(cleaned, "utf8"), /--keep 1/);
  });
});

describe("ipc: authoring (session journals, promote, catalog, services)", () => {
  const SESSION = "sess_alpha01";
  const OUTCOMES = [
    {
      id: "website_saved",
      description: "the new value shows after save",
      verify: { text: { contains: "example.org" } },
    },
  ];

  /**
   * Point the project config's `artifactRoot` at its own folder, apart from
   * Studio's artifact-root override (`h.runsRoot`): the CLI and MCP write
   * journals under the config's root and never hear of the override.
   * @param {ReturnType<typeof setup>} h
   * @returns {string} the journal root
   */
  function journalRoot(h) {
    const root = path.join(h.base, "journals");
    fs.mkdirSync(root, { recursive: true });
    write(
      h.project,
      "cairntrace.config.yml",
      `version: 1\nartifactRoot: ${root}\ndefaultEnvironment: local\nenvironments:\n  local:\n    baseUrl: http://localhost:9\n`,
    );
    return root;
  }

  /**
   * A discovery journal under an artifact root.
   * @param {string} runsRoot
   * @param {Record<string, any>} [extra] more session.json fields
   */
  function makeJournal(runsRoot, extra = {}) {
    const dir = path.join(runsRoot, "_sessions", SESSION);
    write(
      dir,
      "session.json",
      JSON.stringify({
        version: 1,
        sessionId: SESSION,
        kind: "discovery",
        pid: process.pid,
        origin: "cli",
        startUrl: "/login",
        backend: "playwright",
        headed: false,
        status: "open",
        openedAt: new Date().toISOString(),
        lastActivityAt: new Date().toISOString(),
        ttlMs: 1_800_000,
        ...extra,
      }),
    );
    write(
      dir,
      "events.ndjson",
      `${JSON.stringify({ ts: new Date().toISOString(), type: "session.opened", sessionId: SESSION, kind: "discovery" })}\n`,
    );
    write(dir, "snapshots/001.txt", '- button "Save"\n');
    write(dir, "draft.spec.yml", "intent: draft\n");
    fs.mkdirSync(path.join(dir, "screenshots"), { recursive: true });
    fs.writeFileSync(
      path.join(dir, "screenshots", "001.png"),
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
    return dir;
  }

  it("reads journals by id or exact folder, and only their own files", async () => {
    const h = setup();
    const root = journalRoot(h);
    const dir = makeJournal(root);
    // Studio's override is not where journals are: one planted there is
    // neither listed nor addressable.
    write(
      path.join(h.runsRoot, "_sessions", "sess_beta001"),
      "session.json",
      JSON.stringify({ version: 1, sessionId: "sess_beta001", status: "open" }),
    );
    const listed = await h.call("sessions:list", {});
    assert.equal(listed.ok, true, listed.error);
    assert.deepEqual(
      listed.data.sessions.map((/** @type {any} */ entry) => entry.sessionId),
      [SESSION],
    );
    assert.equal(listed.data.sessions[0].liveness.state, "live");
    assert.equal(listed.data.sessionsDir, path.join(root, "_sessions"));
    const overridden = await h.call("session:get", {
      sessionId: path.join(h.runsRoot, "_sessions", "sess_beta001"),
    });
    assert.equal(overridden.ok, false);

    const byDir = await h.call("session:get", { sessionId: dir });
    assert.equal(byDir.data.sessionId, SESSION);
    const events = await h.call("session:events", { sessionId: SESSION });
    assert.equal(events.data.events[0].type, "session.opened");
    const snapshot = await h.call("session:text", {
      sessionId: SESSION,
      path: "snapshots/001.txt",
    });
    assert.match(snapshot.data.text, /button "Save"/);
    const image = await h.call("session:image", {
      sessionId: SESSION,
      path: "screenshots/001.png",
    });
    assert.match(image.data.dataUrl, /^data:image\/png;base64,/);
    // The journal folder can be revealed although it is outside the
    // override; the rest of the config root cannot.
    assert.equal((await h.call("fs:exists", dir)).data, true);
    write(root, "elsewhere.txt", "x");
    assert.equal(
      (await h.call("fs:exists", path.join(root, "elsewhere.txt"))).data,
      false,
    );

    // Never outside the journal, never another folder of the artifact root.
    write(root, "_sessions/secret.txt", "TOP-SECRET");
    for (const bad of [
      { sessionId: SESSION, path: "../secret.txt" },
      { sessionId: SESSION, path: "/etc/hosts" },
      { sessionId: SESSION, path: "screenshots/001.png" },
      { sessionId: "../_sessions", path: "secret.txt" },
      { sessionId: path.join(h.outside), path: "secret.txt" },
      { sessionId: path.join(dir, "snapshots"), path: "001.txt" },
    ]) {
      const refused = await h.call("session:text", bad);
      assert.equal(refused.ok, false, JSON.stringify(bad));
    }
    const elsewhere = await h.call("session:get", {
      sessionId: path.join(h.outside, "_sessions", SESSION),
    });
    assert.equal(elsewhere.ok, false);
    assert.match(elsewhere.error, /invalid session/);
    const notImage = await h.call("session:image", {
      sessionId: SESSION,
      path: "snapshots/001.txt",
    });
    assert.equal(notImage.ok, false);
  });

  it("re-exports only with the contract of an earlier export, asking before it rewrites a file", async () => {
    const h = setup();
    const root = journalRoot(h);
    const configPath = path.join(h.project, "cairntrace.config.yml");
    const discover = path.join(h.bin, "discover.txt");

    // Never exported: Studio has no contract to pass and invents none.
    makeJournal(root);
    const first = await h.call("session:export", { sessionId: SESSION });
    assert.equal(first.ok, false);
    assert.match(first.error, /not been exported yet.*cairn_discover_export/);
    assert.equal(fs.existsSync(discover), false, "nothing spawned");

    const target = path.join(h.project, "flows", "_drafts", "website.yml");
    const dir = makeJournal(root, {
      intent: "the supplier saves a website",
      outcomes: OUTCOMES,
      exportedTo: [target, path.join(h.outside, "evil.yml")],
    });
    // The file is gone (promoted): no dialog, the CLI writes it again.
    const fresh = await h.call("session:export", { sessionId: SESSION });
    assert.equal(fresh.ok, true, fresh.error);
    assert.equal(fresh.data.ok, true);
    assert.equal(dialogCalls.length, 0);
    const argv = fs.readFileSync(discover, "utf8").trim().split("\n");
    assert.deepEqual(argv.slice(0, 4), [
      "discover",
      "export",
      `--from-session=${dir}`,
      "--intent=the supplier saves a website",
    ]);
    const outcomesArg = argv.find((entry) => entry.startsWith("--outcomes="));
    assert.ok(outcomesArg);
    assert.deepEqual(
      JSON.parse(
        fs.readFileSync(path.join(h.bin, "outcomes-seen.json"), "utf8"),
      ),
      OUTCOMES,
    );
    assert.equal(
      fs.existsSync(outcomesArg.slice("--outcomes=".length)),
      false,
      "the outcomes file is removed after the export",
    );
    // Only an earlier export inside the project is re-targeted.
    assert.deepEqual(argv.slice(-3), [
      `--path=${target}`,
      `--config=${configPath}`,
      "--json",
    ]);

    // The file exists: the dialog names it and shows the contract.
    write(h.project, "flows/_drafts/website.yml", "intent: edited by hand\n");
    fs.rmSync(discover);
    fake.dialogResponse = 1;
    const cancelled = await h.call("session:export", { sessionId: SESSION });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.data.cancelled, true);
    assert.equal(fs.existsSync(discover), false, "nothing spawned");
    assert.match(dialogCalls[0].message, /Re-export this session/);
    assert.match(dialogCalls[0].detail, /^flows\/_drafts\/website\.yml/);
    assert.match(dialogCalls[0].detail, /Edits made to the file since then/);
    assert.match(
      dialogCalls[0].detail,
      /- website_saved: the new value shows after save\n\s+verify: \{ text: \{ contains: example\.org \} \}/,
    );
    fake.dialogResponse = 0;
    const confirmed = await h.call("session:export", { sessionId: SESSION });
    assert.equal(confirmed.ok, true, confirmed.error);
    assert.equal(confirmed.data.cancelled, false);
    assert.ok(fs.existsSync(discover));

    // An accompany session never exports as a spec.
    makeJournal(root, {
      kind: "accompany",
      intent: "x",
      outcomes: OUTCOMES,
    });
    const accompany = await h.call("session:export", { sessionId: SESSION });
    assert.equal(accompany.ok, false);
    assert.match(accompany.error, /only a discovery session/);
    const refused = await h.call("session:export", { sessionId: "nope" });
    assert.equal(refused.ok, false);
  });

  it("promotes only a draft inside the project, and only the text the dialog showed", async () => {
    const h = setup();
    makeJournal(journalRoot(h));
    const draftText = [
      "name: profile_website",
      "intent: supplier edits the website field and it persists",
      "steps:",
      "  - open: /profile",
      "outcomes:",
      "  - id: website_saved",
      "    description: the new value shows after save",
      "    verify:",
      "      text: { contains: example.org }",
      "",
    ].join("\n");
    const draft = write(
      h.project,
      "flows/_drafts/profile_website.yml",
      draftText,
    );
    const promoted = path.join(h.bin, "promoted.txt");

    for (const bad of [
      path.join(h.outside, "evil.yml"),
      path.join(h.outside, "secret.txt"),
      "../outside/evil.yml",
      path.join(h.project, "flows", "_drafts", "missing.yml"),
    ]) {
      const refused = await h.call("spec:promote", { draft: bad });
      assert.equal(refused.ok, false, bad);
      assert.match(refused.error, /inside the project/);
    }
    // Inside the project but not a draft (the CLI's rule): no dialog.
    for (const notDraft of ["cairntrace.config.yml", "flows/demo.yml"]) {
      const refused = await h.call("spec:promote", { draft: notDraft });
      assert.equal(refused.ok, false, notDraft);
      assert.match(refused.error, /is not a draft inside the project/);
    }
    assert.equal(dialogCalls.length, 0, "refused before any dialog");

    fake.dialogResponse = 1;
    const cancelled = await h.call("spec:promote", {
      draft: "flows/_drafts/profile_website.yml",
      sessionId: SESSION,
    });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.data.cancelled, true);
    assert.equal(fs.existsSync(promoted), false, "nothing spawned");
    assert.equal(dialogCalls.length, 1);
    assert.match(dialogCalls[0].message, /Promote this draft/);
    assert.match(
      dialogCalls[0].detail,
      /intent: supplier edits the website field and it persists/,
    );
    assert.match(
      dialogCalls[0].detail,
      /- website_saved: the new value shows after save\n\s+verify: \{ text: \{ contains: example\.org \} \}/,
    );

    // The agent rewrites the contract while the human reads the dialog.
    fake.dialogResponse = 0;
    fake.whileDialogOpen = async () => {
      fs.writeFileSync(
        draft,
        draftText
          .replace("website_saved", "nothing_checked")
          .replace("example.org", ""),
      );
    };
    const raced = await h.call("spec:promote", { draft, force: true });
    assert.equal(raced.ok, true, raced.error);
    assert.equal(raced.data.promoted, false);
    assert.equal(raced.data.changed, true);
    assert.match(raced.data.error, /changed while you reviewed it/);
    assert.equal(raced.data.forceable, false);
    assert.equal(fs.existsSync(promoted), false, "nothing spawned");
    fake.whileDialogOpen = null;

    // Asked again, the dialog shows the new contract, and that is promoted.
    dialogCalls.length = 0;
    const done = await h.call("spec:promote", { draft });
    assert.equal(done.ok, true, done.error);
    assert.match(dialogCalls[0].detail, /- nothing_checked/);
    assert.equal(done.data.promoted, true);
    assert.equal(done.data.to, path.join(h.project, "flows", "promoted.yml"));
    assert.equal(done.data.payload.contractHash, "sha256:abc");
    assert.deepEqual(done.data.warnings, ["rebased ../actions/login.yml"]);
    const promotedText = fs.readFileSync(
      path.join(h.bin, "promoted-content.txt"),
      "utf8",
    );
    assert.match(promotedText, /nothing_checked/);
    // The CLI gets the hash of the text the dialog showed.
    const shownHash = crypto
      .createHash("sha256")
      .update(promotedText)
      .digest("hex");
    assert.deepEqual(fs.readFileSync(promoted, "utf8").trim().split("\n"), [
      "spec",
      "promote",
      draft,
      `--expect-content-hash=${shownHash}`,
      "--json",
    ]);

    dialogCalls.length = 0;
    const forced = await h.call("spec:promote", { draft, force: true });
    assert.equal(forced.ok, true, forced.error);
    assert.match(dialogCalls[0].message, /without a green spec finish/);
    assert.match(dialogCalls[0].detail, /--force: promotes without a green/);
    assert.deepEqual(fs.readFileSync(promoted, "utf8").trim().split("\n"), [
      "spec",
      "promote",
      draft,
      "--force",
      `--expect-content-hash=${shownHash}`,
      "--json",
    ]);

    // A refusal reads whole, and offers --force only for the finish gate.
    const gated = write(h.project, "flows/_drafts/refuse_me.yml", draftText);
    const refused = await h.call("spec:promote", { draft: gated });
    assert.equal(refused.ok, true, refused.error);
    assert.equal(refused.data.promoted, false);
    assert.equal(refused.data.forceable, true);
    assert.match(
      refused.data.error,
      /^cairn spec promote: refusing to promote .*\(or pass --force\)$/,
    );
    assert.equal(refused.data.unsupported, false);
    const again = await h.call("spec:promote", { draft: gated, force: true });
    assert.equal(again.data.forceable, false, "never offered twice");
  });

  it("asks cairn catalog with the query as one argv entry", async () => {
    const h = setup();
    const result = await h.call("catalog:get", {
      query: "--config=/etc/evil edit website",
      env: "local",
      limit: 50,
    });
    assert.equal(result.ok, true, result.error);
    const argv = fs
      .readFileSync(path.join(h.bin, "catalog.txt"), "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(argv.slice(0, 4), [
      "catalog",
      "--query=--config=/etc/evil edit website",
      "--env=local",
      "--limit=50",
    ]);
    assert.equal(argv.at(-1), "--json");
    // Studio's own artifact-root override is passed on, like run:start.
    assert.ok(argv.includes(`--artifact-root=${h.runsRoot}`));
    const bad = await h.call("catalog:get", { env: "--all" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /invalid environment name/);
  });

  it("reads the services lock, asks before up/down, and is gated by the suite lock", async () => {
    const h = setup();
    const services = path.join(h.bin, "services.txt");
    const lock = await h.call("services:lock", { env: "local" });
    assert.equal(lock.ok, true, lock.error);
    assert.equal(lock.data.lock.state, "held");
    assert.equal(lock.data.lock.lock.pid, 77);
    assert.equal(lock.data.hasServices, true);
    assert.equal(lock.data.busy, null);
    fs.rmSync(services);

    fake.dialogResponse = 1;
    const cancelled = await h.call("services:up", { env: "local" });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.data.cancelled, true);
    assert.equal(dialogCalls.length, 1);
    assert.match(dialogCalls[0].message, /Start the services for "local"/);
    assert.match(
      dialogCalls[0].detail,
      /Lock now: held by services up \(cli, pid 77\)/,
    );
    // Only the status probe ran.
    assert.deepEqual(
      fs.readFileSync(services, "utf8").trim().split("\n").slice(0, 2),
      ["services", "status"],
    );
    assert.ok(!fs.readFileSync(services, "utf8").includes("\nup\n"));

    fake.dialogResponse = 0;
    dialogCalls.length = 0;
    const down = await h.call("services:down", { env: "local" });
    assert.equal(down.ok, true, down.error);
    assert.equal(down.data.cancelled, false);
    assert.equal(down.data.ok, true);
    assert.match(dialogCalls[0].message, /Tear down the services for "local"/);
    assert.ok(
      fs.readFileSync(services, "utf8").includes("down\n--env=local\n--json"),
    );

    const bad = await h.call("services:up", { env: "--everything" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /invalid environment name/);

    assert.equal(
      (
        await h.call("project:launch-update", {
          launchTemplate: null,
          lockFiles: [".suite.lock"],
        })
      ).ok,
      true,
    );
    // A suite that takes its lock while the dialog is open still wins.
    fs.rmSync(services);
    dialogCalls.length = 0;
    fake.whileDialogOpen = async () => {
      write(h.project, ".suite.lock", JSON.stringify({ owner: "nightly" }));
    };
    const raced = await h.call("services:down", { env: "local" });
    assert.equal(raced.ok, false);
    assert.match(raced.error, /suite in progress.*Services down is disabled/);
    assert.equal(dialogCalls.length, 1);
    assert.ok(
      !fs.readFileSync(services, "utf8").includes("\ndown\n"),
      "only the status probe ran",
    );
    fake.whileDialogOpen = null;

    dialogCalls.length = 0;
    const gated = await h.call("services:down", { env: "local" });
    assert.equal(gated.ok, false);
    assert.match(gated.error, /suite in progress.*Services down is disabled/);
    assert.equal(dialogCalls.length, 0);
  });

  it("keeps Studio's runs and services up/down on one environment apart", async () => {
    const h = setup();
    const slow = write(h.project, "flows/slow.yml", SPEC);
    const demo = path.join(h.project, "flows", "demo.yml");
    const services = path.join(h.bin, "services.txt");

    // While `services up` boots (its lock comes only after), a run on that
    // environment is refused; one on another environment is not.
    fake.dialogResponse = 0;
    /** @type {any} */
    let duringUp = null;
    /** @type {any} */
    let elsewhere = null;
    /** @type {any} */
    let unknownEnv = null;
    /** @type {any} */
    let healDuringUp = null;
    fake.whileDialogOpen = async () => {
      duringUp = await h.call("run:start", {
        specs: [demo],
        overrides: { env: "local" },
      });
      healDuringUp = await h.call("spec:heal", { spec: demo, env: "local" });
      unknownEnv = await h.call("run:start", { specs: [demo] });
      elsewhere = await h.call("run:start", {
        specs: [demo],
        overrides: { env: "staging" },
      });
    };
    const up = await h.call("services:up", { env: "local" });
    fake.whileDialogOpen = null;
    assert.equal(up.ok, true, up.error);
    assert.equal(duringUp.ok, false);
    assert.match(
      duringUp.error,
      /cairn services up is running for "local" — Run is disabled/,
    );
    assert.equal(healDuringUp.ok, false);
    assert.match(healDuringUp.error, /Heal is disabled/);
    // no --env, no spec environment, no config default: it may be "local"
    assert.equal(unknownEnv.ok, false);
    assert.match(unknownEnv.error, /cannot be told before it starts/);
    assert.equal(elsewhere.ok, true, elsewhere.error);
    await waitForSent(h.sent, "run:done");

    // A run Studio started holds its environment against services up/down.
    const run = await h.call("run:start", {
      specs: [slow],
      overrides: { env: "local" },
    });
    assert.equal(run.ok, true, run.error);
    fs.rmSync(services, { force: true });
    dialogCalls.length = 0;
    for (const action of ["services:down", "services:up"]) {
      const refused = await h.call(action, { env: "local" });
      assert.equal(refused.ok, false, action);
      assert.match(
        refused.error,
        /a run Studio started is using "local" \(slow\.yml\)/,
      );
    }
    assert.equal(dialogCalls.length, 0, "refused before any dialog");
    assert.equal(fs.existsSync(services), false, "nothing spawned");
    const other = await h.call("services:down", { env: "staging" });
    assert.equal(other.ok, true, other.error);
    assert.equal(other.data.ok, true);
    assert.equal(
      (await h.call("run:cancel", run.data.token)).data.cancelled,
      true,
    );
    const freed = await h.call("services:down", { env: "local" });
    assert.equal(freed.ok, true, freed.error);
    assert.equal(freed.data.ok, true);
  });
});

describe("ipc: authoring ↔ the real CLI", () => {
  // The argv Studio builds must be one the repo's own cairn accepts (the
  // export once sent no --intent/--outcomes and could never succeed).
  const BIN = path.join(__dirname, "..", "..", "bin", "cairn");
  const bun = cliLib.which("bun");
  const SESSION = "sess_real01";

  it("re-exports a fabricated journal, then promotes the draft", async (t) => {
    if (!bun || !fs.existsSync(BIN)) {
      t.skip("needs bun and the repo's bin/cairn");
      return;
    }
    const h = setup();
    const settings = h.settings();
    fs.writeFileSync(
      path.join(h.base, "userData", "settings.json"),
      JSON.stringify({ ...settings, cairnBin: BIN }),
    );
    const configPath = write(
      h.project,
      "cairntrace.config.yml",
      "version: 1\nproject: studio_contract\nartifactRoot: ./journals\ndefaultEnvironment: local\nenvironments:\n  local:\n    baseUrl: http://localhost:9\n",
    );
    const target = path.join(
      h.project,
      "flows",
      "_drafts",
      "website_saved.yml",
    );
    const now = new Date().toISOString();
    const dir = path.join(h.project, "journals", "_sessions", SESSION);
    write(
      dir,
      "session.json",
      JSON.stringify({
        version: 1,
        sessionId: SESSION,
        kind: "discovery",
        pid: 999_999,
        origin: "mcp",
        startUrl: "/",
        backend: "mock",
        headed: false,
        configPath,
        status: "closed",
        openedAt: now,
        lastActivityAt: now,
        ttlMs: 1_800_000,
        exportedTo: [target],
        intent: "the supplier saves a website and it persists",
        outcomes: [
          {
            id: "website_saved",
            description: "the profile page is shown",
            verify: { url: { matches: "/profile" } },
          },
        ],
      }),
    );
    write(
      dir,
      "events.ndjson",
      [
        {
          ts: now,
          type: "session.opened",
          sessionId: SESSION,
          kind: "discovery",
        },
        {
          ts: now,
          type: "step.recorded",
          index: 1,
          step: { open: "/profile" },
        },
      ]
        .map((event) => `${JSON.stringify(event)}\n`)
        .join(""),
    );

    const exported = await h.call("session:export", { sessionId: SESSION });
    assert.equal(exported.ok, true, exported.error);
    assert.equal(
      exported.data.ok,
      true,
      `${exported.data.exitCode}: ${exported.data.stderr}`,
    );
    assert.equal(exported.data.unsupported, false);
    assert.equal(exported.data.payload.verifyOk, true);
    const written = fs.readFileSync(target, "utf8");
    assert.match(
      written,
      /intent: the supplier saves a website and it persists/,
    );
    assert.match(written, /- open: \/profile/);

    // No green `cairn spec finish`: refused, and --force is offered.
    fake.dialogResponse = 0;
    const refused = await h.call("spec:promote", { draft: target });
    assert.equal(refused.ok, true, refused.error);
    assert.equal(refused.data.promoted, false);
    assert.equal(refused.data.forceable, true);
    assert.equal(refused.data.unsupported, false);
    assert.match(refused.data.error, /no `cairn spec finish` ran for it/);
    const forced = await h.call("spec:promote", { draft: target, force: true });
    assert.equal(forced.ok, true, forced.error);
    assert.equal(
      forced.data.promoted,
      true,
      `${forced.data.exitCode}: ${forced.data.stderr}`,
    );
    assert.equal(
      forced.data.to,
      path.join(h.project, "flows", "website_saved.yml"),
    );
    assert.match(forced.data.payload.contractHash, /^sha256:/);
    assert.ok(
      forced.data.warnings.some((/** @type {string} */ entry) =>
        /promoted with --force/.test(entry),
      ),
    );
    // The draft moved: the journal lists its export as missing.
    const session = await h.call("session:get", { sessionId: SESSION });
    assert.deepEqual(session.data.exportedMissing, [target]);
  });
});

// ── wave 6: run lock, suites, config vars, orphans, service windows ─────────

/**
 * A project config that takes the run lock, and a lock file for it.
 * @param {ReturnType<typeof setup>} h
 * @param {{ pid?: number, scope?: "config" | "project", config?: string }} [options]
 */
function holdRunLock(h, options = {}) {
  const configPath = write(
    h.project,
    "cairntrace.config.yml",
    options.config ?? "project: demo\nrun:\n  lock: true\n",
  );
  write(
    h.runLockDir,
    "demo.0123456789abcdef.run.lock.json",
    JSON.stringify({
      version: 1,
      token: "t",
      pid: options.pid ?? process.pid,
      startedAt: new Date(Date.now() - 1000).toISOString(),
      argv: ["run", "flows/other.yml"],
      cwd: h.project,
      scope: options.scope ?? "config",
      key:
        options.scope === "project"
          ? "project:demo"
          : fs.realpathSync(configPath),
      invocationId: "2026-10-03T10-00-00-000Z_1_abcdef",
      origin: "cli",
      env: "local",
    }),
  );
  return configPath;
}

describe("ipc: the config run lock", () => {
  it("blocks every run, heal and services action while a live owner holds it, then lifts", async () => {
    const h = setup();
    holdRunLock(h);
    const locks = await h.call("project:locks");
    assert.equal(locks.ok, true, locks.error);
    assert.equal(locks.data.runLock.configured, true);
    assert.equal(locks.data.runLock.held.length, 1);
    assert.equal(locks.data.active[0].kind, "run-lock");
    assert.equal(locks.data.active[0].pid, process.pid);
    assert.match(locks.data.active[0].owner, /cli, invocation .*, env "local"/);
    assert.equal(locks.data.active[0].command, "cairn run flows/other.yml");

    const spec = path.join(h.project, "flows", "demo.yml");
    const refused = await h.call("run:start", { specs: [spec] });
    assert.equal(refused.ok, false);
    assert.match(
      refused.error,
      /a cairn run holds this project's run lock \(pid \d+ \(cli, invocation .*, env "local"\), running for \ds: cairn run flows\/other\.yml\) — Run is disabled until it finishes/,
    );
    const heal = await h.call("spec:heal", { spec });
    assert.equal(heal.ok, false);
    assert.match(heal.error, /run lock.*Heal is disabled/);
    const up = await h.call("services:up", { env: "local" });
    assert.equal(up.ok, false);
    assert.match(up.error, /run lock.*Services up is disabled/);
    const restart = await h.call("services:restart", {
      env: "local",
      window: "web",
    });
    assert.equal(restart.ok, false);
    assert.match(restart.error, /run lock.*Service restart is disabled/);
    assert.equal(fs.existsSync(path.join(h.bin, "ran.txt")), false);
    assert.equal(dialogCalls.length, 0, "refused before any dialog");

    fs.rmSync(path.join(h.runLockDir, "demo.0123456789abcdef.run.lock.json"));
    const started = await h.call("run:start", { specs: [spec] });
    assert.equal(started.ok, true, started.error);
    await waitForSent(h.sent, "run:done");
  });

  it("does not count a dead owner's lock (cairn reclaims it), or a lock of another config", async () => {
    const h = setup();
    holdRunLock(h, { pid: 2_147_000_000 });
    const dead = await h.call("project:locks");
    assert.equal(dead.data.runLock.held.length, 0);
    assert.equal(dead.data.active.length, 0);
    fs.rmSync(path.join(h.runLockDir, "demo.0123456789abcdef.run.lock.json"));
    write(
      h.runLockDir,
      "other.fedcba9876543210.run.lock.json",
      JSON.stringify({
        version: 1,
        token: "t",
        pid: process.pid,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        argv: [],
        cwd: "/elsewhere",
        scope: "config",
        key: "/elsewhere/cairntrace.config.yml",
      }),
    );
    const other = await h.call("project:locks");
    assert.equal(other.data.active.length, 0);
  });

  it("matches a project-scoped lock by the project name", async () => {
    const h = setup();
    holdRunLock(h, {
      scope: "project",
      config: "project: demo\nrun:\n  lock:\n    scope: project\n",
    });
    const locks = await h.call("project:locks");
    assert.equal(locks.data.runLock.held[0].scope, "project");
    assert.equal(locks.data.active.length, 1);
  });

  it("ignores lock files for a config that takes no run lock", async () => {
    const h = setup();
    const configPath = write(
      h.project,
      "cairntrace.config.yml",
      "project: demo\n",
    );
    write(
      h.runLockDir,
      "demo.0123456789abcdef.run.lock.json",
      JSON.stringify({
        version: 1,
        token: "t",
        pid: process.pid,
        startedAt: new Date(Date.now() - 1000).toISOString(),
        argv: [],
        cwd: h.project,
        scope: "config",
        key: fs.realpathSync(configPath),
      }),
    );
    const locks = await h.call("project:locks");
    assert.equal(locks.data.runLock.configured, false);
    assert.equal(locks.data.active.length, 0);
  });

  it("keeps the suite lock files and the run lock together", async () => {
    const h = setup();
    holdRunLock(h);
    await h.call("project:launch-update", {
      launchTemplate: null,
      lockFiles: [".suite.lock"],
    });
    write(h.project, ".suite.lock", JSON.stringify({ owner: "nightly" }));
    const locks = await h.call("project:locks");
    assert.deepEqual(
      locks.data.active.map((/** @type {any} */ entry) => entry.kind ?? "file"),
      ["file", "run-lock"],
    );
    const spec = path.join(h.project, "flows", "demo.yml");
    const refused = await h.call("run:start", { specs: [spec] });
    assert.match(refused.error, /suite in progress.*nightly/);
  });
});

describe("ipc: suites", () => {
  it("lists suites with the environment as one flag, and normalizes the document", async () => {
    const h = setup();
    const result = await h.call("suites:list", { env: "local" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.suites.suites[0].name, "smoke");
    assert.equal(
      result.data.suites.suites[0].envs[1].problem,
      "requires.env rules prod out",
    );
    const argv = fs
      .readFileSync(path.join(h.bin, "suites.txt"), "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(argv, ["suites", "list", "--env=local", "--json"]);
    const bad = await h.call("suites:list", { env: "--all" });
    assert.equal(bad.ok, false);
    assert.match(bad.error, /invalid environment name/);
  });

  it("degrades to a message when cairn answers without a suites document", async () => {
    const h = setup();
    fs.writeFileSync(path.join(h.bin, "suites.json"), "not json at all");
    const result = await h.call("suites:list", {});
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.suites, null);
  });

  it("starts a suite as one --suite=<name> entry through the run path", async () => {
    const h = setup();
    const started = await h.call("run:start", {
      suite: "smoke",
      overrides: { env: "local" },
    });
    assert.equal(started.ok, true, started.error);
    const begun = await waitForSent(h.sent, "run:started");
    assert.equal(begun.suite, "smoke");
    assert.deepEqual(begun.specs, [path.resolve("/proj", "flows/demo.yml")]);
    const done = await waitForSent(h.sent, "run:done");
    assert.equal(done.ok, true);
    const argv = fs.readFileSync(path.join(h.bin, "ran.txt"), "utf8").trim();
    assert.match(argv, /^run --suite=smoke --env local /);
    assert.ok(!argv.includes(".yml"), "no spec paths next to --suite");
    // the CLI is asked for the suite's resolution on that environment first
    assert.deepEqual(
      fs
        .readFileSync(path.join(h.bin, "suites.txt"), "utf8")
        .trim()
        .split("\n"),
      ["suites", "list", "--env=local", "--json"],
    );
  });

  it("refuses an unknown suite, an environment its requires rule out, spec + suite, and a bad name", async () => {
    const h = setup();
    const spec = path.join(h.project, "flows", "demo.yml");
    const unknown = await h.call("run:start", { suite: "nightly" });
    assert.equal(unknown.ok, false);
    assert.match(unknown.error, /unknown suite: nightly/);
    const ruledOut = await h.call("run:start", {
      suite: "smoke",
      overrides: { env: "prod" },
    });
    assert.equal(ruledOut.ok, false);
    assert.match(
      ruledOut.error,
      /suite smoke cannot run on prod: requires\.env rules prod out/,
    );
    const both = await h.call("run:start", { suite: "smoke", specs: [spec] });
    assert.equal(both.ok, false);
    assert.match(both.error, /specs or one suite, not both/);
    for (const suite of ["--env=prod", "-x"]) {
      const flag = await h.call("run:start", { suite });
      assert.equal(flag.ok, false, suite);
      assert.match(flag.error, /invalid suite name/);
    }
    assert.equal(fs.existsSync(path.join(h.bin, "ran.txt")), false);
  });

  it("refuses a suite while a launch template is set (it runs one spec at a time)", async () => {
    const h = setup();
    fake.dialogResponse = 0;
    await h.call("project:launch-update", {
      launchTemplate: `${h.launcher} {spec}`,
      lockFiles: [],
    });
    const refused = await h.call("run:start", { suite: "smoke" });
    assert.equal(refused.ok, false);
    assert.match(
      refused.error,
      /launch template, which takes one spec at a time/,
    );
    assert.equal(fs.existsSync(path.join(h.bin, "ran.txt")), false);
  });

  it("says so when cairn has no suites command", async () => {
    const h = setup();
    script(h.cairn, "echo \"error: unknown command 'suites'\" >&2; exit 1");
    const refused = await h.call("run:start", { suite: "smoke" });
    assert.equal(refused.ok, false);
    assert.match(refused.error, /this cairn has no `cairn suites list`/);
    const listed = await h.call("suites:list", {});
    assert.equal(listed.data.unsupported, true);
  });
});

describe("ipc: config vars", () => {
  it("reads vars with the environment and unused flags as argv, values masked", async () => {
    const h = setup();
    const result = await h.call("config:vars", { env: "local", unused: true });
    assert.equal(result.ok, true, result.error);
    const dump = JSON.stringify(result.data);
    assert.ok(
      !dump.includes("hunter2"),
      "a credential-named var never leaves main",
    );
    const password = result.data.vars.vars.find(
      (/** @type {any} */ row) => row.name === "dbPassword",
    );
    assert.equal(password.values[0].masked, true);
    assert.equal(password.unused, true);
    const argv = fs
      .readFileSync(path.join(h.bin, "config-vars.txt"), "utf8")
      .trim()
      .split("\n");
    assert.deepEqual(argv, [
      "config",
      "vars",
      "--env=local",
      "--unused",
      "--json",
    ]);
    assert.equal((await h.call("config:vars", { env: "--x" })).ok, false);
  });

  it("degrades when the document is missing", async () => {
    const h = setup();
    fs.writeFileSync(path.join(h.bin, "config-vars.json"), "");
    const result = await h.call("config:vars", {});
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.vars, null);
  });
});

describe("ipc: orphan sessions", () => {
  it("lists them (exit 1 is a finding, not a failure)", async () => {
    const h = setup();
    const result = await h.call("orphans:list");
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.ok, true);
    assert.equal(result.data.exitCode, 1);
    assert.equal(result.data.orphans.orphans[0].session, "cairn-orphan-1");
    assert.deepEqual(
      fs
        .readFileSync(path.join(h.bin, "doctor.txt"), "utf8")
        .trim()
        .split("\n"),
      ["doctor", "--orphans", "--json"],
    );
  });

  it("kills only after a native confirmation that lists the sessions and pids", async () => {
    const h = setup();
    fake.dialogResponse = 1;
    const cancelled = await h.call("orphans:kill");
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.data.cancelled, true);
    assert.equal(dialogCalls.length, 1);
    assert.match(
      dialogCalls[0].message,
      /End 1 browser process\(es\) of 1 orphaned session\(s\)\?/,
    );
    assert.match(dialogCalls[0].detail, /cairn-orphan-1 \(agent-browser\)/);
    assert.match(dialogCalls[0].detail, /pid 4321 {2}chrome --headless/);
    assert.ok(
      !fs
        .readFileSync(path.join(h.bin, "doctor.txt"), "utf8")
        .includes("--kill"),
      "cancelled: the CLI never saw --kill",
    );

    fake.dialogResponse = 0;
    dialogCalls.length = 0;
    const killed = await h.call("orphans:kill");
    assert.equal(killed.ok, true, killed.error);
    assert.equal(killed.data.cancelled, false);
    assert.equal(killed.data.ok, true);
    assert.equal(killed.data.orphans.killed, 1);
    const calls = fs.readFileSync(path.join(h.bin, "doctor.txt"), "utf8");
    // Exactly the confirmed sessions and pids: nothing listed later is hit.
    assert.match(
      calls,
      /doctor\n--orphans\n--kill\n--yes\n--only=cairn-orphan-1,4321\n--json/,
    );
  });

  it("does not ask when there is nothing to end", async () => {
    const h = setup();
    fs.writeFileSync(
      path.join(h.bin, "orphans.json"),
      JSON.stringify({ ...ORPHANS_DOC, ok: true, exitCode: 0, orphans: [] }),
    );
    const result = await h.call("orphans:kill");
    assert.equal(result.data.nothing, true);
    assert.equal(dialogCalls.length, 0);
  });
});

describe("ipc: service windows", () => {
  it("reads windows, tunnels and the provisioner's export names, never pane text", async () => {
    const h = setup();
    const result = await h.call("services:windows", { env: "local" });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.ok, true);
    assert.deepEqual(
      result.data.status.tmux.windows.map((/** @type {any} */ row) => row.name),
      ["web", "worker"],
    );
    assert.deepEqual(result.data.status.provisioner, { exports: ["OPS_HOST"] });
    assert.equal(result.data.status.tunnels[0].name, "db");
    assert.ok(!JSON.stringify(result.data.status).includes("hunter2"));
    assert.equal(result.data.lock.state, "held");
    assert.equal((await h.call("services:windows", { env: "--x" })).ok, false);
  });

  it("restarts one window after a native confirmation naming it and the command", async () => {
    const h = setup();
    fake.dialogResponse = 1;
    const cancelled = await h.call("services:restart", {
      env: "local",
      window: "web",
    });
    assert.equal(cancelled.ok, true, cancelled.error);
    assert.equal(cancelled.data.cancelled, true);
    assert.match(dialogCalls[0].message, /Restart "web" in "local"\?/);
    assert.match(dialogCalls[0].detail, /services restart web --env=local/);
    assert.ok(
      !fs
        .readFileSync(path.join(h.bin, "services.txt"), "utf8")
        .includes("restart\nweb"),
      "cancelled: nothing was restarted",
    );

    fake.dialogResponse = 0;
    const restarted = await h.call("services:restart", {
      env: "local",
      window: "web",
    });
    assert.equal(restarted.ok, true, restarted.error);
    assert.equal(restarted.data.ok, true);
    assert.equal(restarted.data.restart.windows[0].window, "web");
    assert.match(
      fs.readFileSync(path.join(h.bin, "services.txt"), "utf8"),
      /restart\nweb\n--env=local\n--json/,
    );
  });

  it("refuses a window the CLI's own status does not list, and a name that is not one, before any dialog", async () => {
    const h = setup();
    const unknown = await h.call("services:restart", {
      env: "local",
      window: "nope",
    });
    assert.equal(unknown.ok, false);
    assert.match(
      unknown.error,
      /"nope" is not a service window of local \(windows: web, worker\)/,
    );
    for (const window of ["--force", "a b", ""]) {
      const bad = await h.call("services:restart", { env: "local", window });
      assert.equal(bad.ok, false, JSON.stringify(window));
      assert.match(bad.error, /invalid service window name/);
    }
    assert.equal(dialogCalls.length, 0);
  });

  it("is gated by the suite lock and by a run Studio started on that environment", async () => {
    const h = setup();
    await h.call("project:launch-update", {
      launchTemplate: null,
      lockFiles: [".suite.lock"],
    });
    write(h.project, ".suite.lock", JSON.stringify({ owner: "nightly" }));
    const locked = await h.call("services:restart", {
      env: "local",
      window: "web",
    });
    assert.equal(locked.ok, false);
    assert.match(
      locked.error,
      /suite in progress.*Service restart is disabled/,
    );
    fs.rmSync(path.join(h.project, ".suite.lock"));

    const slow = write(h.project, "flows/slow.yml", SPEC);
    const run = await h.call("run:start", {
      specs: [slow],
      overrides: { env: "local" },
    });
    assert.equal(run.ok, true, run.error);
    const busy = await h.call("services:restart", {
      env: "local",
      window: "web",
    });
    assert.equal(busy.ok, false);
    assert.match(
      busy.error,
      /a run Studio started is using "local".*before cairn services restart/,
    );
    await h.call("run:cancel", run.data.token);
  });

  it("reports a failed restart with the CLI's own message", async () => {
    const h = setup();
    fs.writeFileSync(
      path.join(h.bin, "services-restart.json"),
      JSON.stringify({
        ...RESTART_DOC,
        ok: false,
        exitCode: 2,
        windows: [
          {
            window: "web",
            ok: false,
            alreadyStopped: false,
            durationMs: 5,
            error: "readyOn never matched",
          },
        ],
        error: "web did not become ready",
      }),
    );
    fs.writeFileSync(path.join(h.bin, "restart.exit"), "2");
    const result = await h.call("services:restart", {
      env: "local",
      window: "web",
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.ok, false);
    assert.equal(result.data.error, "web did not become ready");
    assert.equal(result.data.exitCode, 2);
  });

  it("reads a window's log, bounded, masked and read-only", async () => {
    const h = setup();
    const result = await h.call("services:logs", {
      env: "local",
      window: "web",
      sinceRestart: true,
      lines: 99999,
    });
    assert.equal(result.ok, true, result.error);
    assert.equal(result.data.ok, true);
    assert.deepEqual(result.data.logs.lines, [
      "listening on :3000",
      "db url postgres://***@db/app",
    ]);
    assert.ok(!JSON.stringify(result.data).includes("topsecret"));
    const argv = fs.readFileSync(path.join(h.bin, "services.txt"), "utf8");
    assert.match(
      argv,
      /logs\nweb\n--env=local\n--since-restart\n--lines=1000\n--json/,
    );
    assert.ok(!argv.includes("--follow") && !argv.includes("--wait"));
    assert.equal(
      (await h.call("services:logs", { env: "local", window: "-x" })).ok,
      false,
    );
  });
});

describe("ipc: metrics history", () => {
  it("reads one spec's metric across the artifact root's runs", async () => {
    const h = setup();
    ["2026-10-01", "2026-10-02"].forEach((day, index) => {
      const dir = path.join(
        h.runsRoot,
        `${day}T10-00-00-000Z_demo_aaaa0${index}`,
      );
      write(
        dir,
        "run.json",
        JSON.stringify({
          runId: path.basename(dir),
          spec: { name: "demo" },
          status: "passed",
        }),
      );
      write(
        dir,
        "diagnostics/metrics.json",
        JSON.stringify({
          metrics: [
            {
              name: "depth",
              scope: "spec",
              delta: (index + 1) * 3,
              failures: 0,
            },
          ],
        }),
      );
    });
    const result = await h.call("metrics:history", { spec: "demo" });
    assert.equal(result.ok, true, result.error);
    assert.deepEqual(
      result.data.metrics.depth.points.map(
        (/** @type {any} */ point) => point.value,
      ),
      [3, 6],
    );
    const empty = await h.call("metrics:history", { spec: "x".repeat(300) });
    assert.equal(empty.ok, true);
    assert.equal(empty.data.scanned, 2, "an overlong spec filter is ignored");
  });
});

describe("ipc: wave 6 ↔ the real CLI", () => {
  // The documents Studio normalizes must be the ones the repo's own cairn
  // prints (a shape drift would otherwise read as "no document").
  const BIN = path.join(__dirname, "..", "..", "bin", "cairn");
  const bun = cliLib.which("bun");

  it("reads suites, config vars and the orphan ledger from a real cairn", async (t) => {
    if (!bun || !fs.existsSync(BIN)) {
      t.skip("needs bun and the repo's bin/cairn");
      return;
    }
    const h = setup();
    fs.writeFileSync(
      path.join(h.base, "userData", "settings.json"),
      JSON.stringify({ ...h.settings(), cairnBin: BIN }),
    );
    write(
      h.project,
      "cairntrace.config.yml",
      [
        "version: 1",
        "project: demo",
        "vars:",
        "  apiUrl: http://localhost:3000",
        "  dbPassword: s3cr3t-do-not-show",
        "environments:",
        "  local:",
        "    baseUrl: http://localhost:3000",
        "suites:",
        "  smoke:",
        "    description: fast checks",
        "    specs: [flows/demo.yml]",
        "",
      ].join("\n"),
    );
    // the orphan ledger lives under $HOME: never read (or tidy) the real one
    const home = tempDir("cairn-real-home-");
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const suites = await h.call("suites:list", { env: "local" });
      assert.equal(suites.ok, true, suites.error);
      assert.ok(suites.data.suites, JSON.stringify(suites.data));
      assert.equal(suites.data.suites.suites[0].name, "smoke");
      assert.equal(suites.data.suites.suites[0].envs[0].env, "local");

      const vars = await h.call("config:vars", {});
      assert.equal(vars.ok, true, vars.error);
      assert.ok(vars.data.vars, JSON.stringify(vars.data));
      assert.ok(!JSON.stringify(vars.data).includes("s3cr3t-do-not-show"));
      const password = vars.data.vars.vars.find(
        (/** @type {any} */ row) => row.name === "dbPassword",
      );
      assert.equal(password.values[0].masked, true);
      const apiUrl = vars.data.vars.vars.find(
        (/** @type {any} */ row) => row.name === "apiUrl",
      );
      assert.equal(apiUrl.values[0].display, "http://localhost:3000");

      const orphans = await h.call("orphans:list");
      assert.equal(orphans.ok, true, orphans.error);
      assert.equal(orphans.data.ok, true, JSON.stringify(orphans.data));
      assert.deepEqual(orphans.data.orphans.orphans, []);
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
  });
});
