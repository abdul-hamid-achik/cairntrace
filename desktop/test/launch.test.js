/**
 * Launch safety: template tokenizing/validation/substitution and suite lock
 * detection with owner info.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const launch = require("../lib/launch");
const { cleanup, tempDir, write } = require("./helpers");

after(cleanup);

describe("tokenizeTemplate", () => {
  it("splits on whitespace and honours quotes and escapes", () => {
    assert.deepEqual(
      launch.tokenizeTemplate(
        `task run FLOW={spec} NOTE="two words" 'a b' c\\ d`,
      ),
      ["task", "run", "FLOW={spec}", "NOTE=two words", "a b", "c d"],
    );
    assert.throws(() => launch.tokenizeTemplate(`task "open`), /unterminated/);
  });
});

describe("validateTemplate", () => {
  it("requires a command and a spec placeholder, and refuses shell syntax", () => {
    assert.equal(
      launch.validateTemplate("task run FLOW={spec} -- {cairnArgs}").ok,
      true,
    );
    assert.match(launch.validateTemplate("").error, /empty/);
    assert.match(launch.validateTemplate("{spec} run").error, /first token/);
    assert.match(launch.validateTemplate("task run").error, /\{spec\}/);
    assert.match(
      launch.validateTemplate("task run {spec} | tee x").error,
      /shell/,
    );
    assert.match(
      launch.validateTemplate("task run {spec} {nope}").error,
      /unknown placeholder/,
    );
  });
});

describe("buildLaunchCommand", () => {
  const runArgv = [
    "run",
    "/work/demo/flows/orders.yml",
    "--env",
    "local",
    "--label",
    "round=2",
    "--progress",
    "plain",
    "--format",
    "json",
  ];

  it("substitutes a project-relative spec, env, and the remaining cairn flags", () => {
    const built = launch.buildLaunchCommand(
      "task run FLOW={spec} ENV={env} NAME={specName} -- {cairnArgs}",
      {
        specs: ["/work/demo/flows/orders.yml"],
        env: "local",
        runArgv,
        projectDir: "/work/demo",
      },
    );
    assert.deepEqual(built, {
      command: "task",
      args: [
        "run",
        "FLOW=flows/orders.yml",
        "ENV=local",
        "NAME=orders",
        "--",
        "--label",
        "round=2",
        "--progress",
        "plain",
        "--format",
        "json",
      ],
    });
  });

  it("keeps --env in cairnArgs when the template does not route {env}", () => {
    const built = launch.buildLaunchCommand(
      "./tools/run-suite.sh {spec} {cairnArgs}",
      {
        specs: ["/work/demo/flows/orders.yml"],
        env: "local",
        runArgv,
        projectDir: "/work/demo",
      },
    );
    assert.deepEqual(built.args.slice(0, 3), [
      "flows/orders.yml",
      "--env",
      "local",
    ]);
  });

  it("spreads {specs} and refuses several specs for a single-spec template", () => {
    const two = ["/work/demo/a.yml", "/work/demo/b.yml"];
    assert.deepEqual(
      launch.buildLaunchCommand("wrap {specs}", {
        specs: two,
        runArgv: ["run", ...two],
        projectDir: "/work/demo",
      }).args,
      ["a.yml", "b.yml"],
    );
    assert.throws(
      () =>
        launch.buildLaunchCommand("wrap {spec}", {
          specs: two,
          runArgv: ["run", ...two],
          projectDir: "/work/demo",
        }),
      /one spec at a time/,
    );
  });

  it("joins an embedded {specs} (FLOWS={specs}) for several specs", () => {
    const two = ["/work/demo/a.yml", "/work/demo/b.yml"];
    assert.deepEqual(
      launch.buildLaunchCommand("task run FLOWS={specs}", {
        specs: two,
        runArgv: ["run", ...two],
        projectDir: "/work/demo",
      }),
      { command: "task", args: ["run", "FLOWS=a.yml b.yml"] },
    );
  });
});

describe("readLockState", () => {
  it("reports absent, file, and directory locks with owner info", () => {
    const project = tempDir("cairn-launch-");
    write(
      project,
      "runs/.suite.lock",
      JSON.stringify({ pid: 777, host: "ci-box", started: "09:00" }),
    );
    fs.mkdirSync(path.join(project, "runs", "batch.lock"), { recursive: true });
    write(
      project,
      "runs/batch.lock/owner",
      "agent session 12\nstarted by task\n",
    );
    const state = launch.readLockState(project, [
      "runs/.suite.lock",
      "runs/batch.lock",
      "runs/free.lock",
      "../outside.lock",
    ]);
    assert.deepEqual(
      state.map((lock) => [lock.path, lock.exists, lock.kind, lock.owner]),
      [
        ["runs/.suite.lock", true, "file", "pid=777 host=ci-box started=09:00"],
        ["runs/batch.lock", true, "dir", "agent session 12 · started by task"],
        ["runs/free.lock", false, null, null],
        ["../outside.lock", false, null, null],
      ],
    );
    assert.match(state[3].error, /inside the project/);
  });

  it("reads per-project settings by resolved directory", () => {
    const settings = {
      projectSettings: {
        [path.resolve("/work/demo")]: {
          launchTemplate: " task run {spec} ",
          lockFiles: ["runs/.suite.lock", ""],
        },
      },
    };
    assert.deepEqual(launch.projectLaunchSettings(settings, "/work/demo/"), {
      launchTemplate: "task run {spec}",
      lockFiles: ["runs/.suite.lock"],
    });
    assert.deepEqual(launch.projectLaunchSettings({}, "/work/demo"), {
      launchTemplate: null,
      lockFiles: [],
    });
  });
});
