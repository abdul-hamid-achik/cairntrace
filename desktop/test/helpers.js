/**
 * Shared test helpers: temp fixture trees that look like a cairn artifact root
 * and a cairntrace project.
 */
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

/** @type {string[]} */
const created = [];

/**
 * @param {string} [prefix]
 * @returns {string}
 */
function tempDir(prefix = "cairn-desktop-") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * @param {string} root
 * @param {string} relative
 * @param {string} contents
 * @returns {string} absolute path
 */
function write(root, relative, contents) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents, "utf8");
  return absolute;
}

/**
 * Build a run directory with a run.json and the usual artifact siblings.
 * @param {string} runsRoot
 * @param {string} runId
 * @param {Record<string, any>} [overrides]
 * @returns {string} the run directory
 */
function makeRun(runsRoot, runId, overrides = {}) {
  const dir = path.join(runsRoot, runId);
  fs.mkdirSync(dir, { recursive: true });
  const run = {
    $schema: "urn:cairntrace.dev:run:v1",
    version: "1",
    runId,
    runDir: dir,
    spec: {
      name: overrides.specName ?? "demo_spec",
      path: `/tmp/${runId}.yml`,
    },
    environment: "local",
    backend: "agent-browser",
    coldStart: false,
    status: "passed",
    summary: "all outcomes passed",
    startedAt: "2026-09-01T10:00:00.000Z",
    endedAt: "2026-09-01T10:00:04.250Z",
    durationMs: 4250,
    outcomes: [
      {
        id: "landing_loaded",
        status: "passed",
        evidence: "outcomes/landing_loaded.md",
      },
    ],
    steps: [
      {
        id: "step_1",
        status: "passed",
        durationMs: 120,
        artifacts: ["snapshots/001_step_1.txt"],
      },
    ],
    ...overrides.run,
  };
  fs.writeFileSync(
    path.join(dir, "run.json"),
    JSON.stringify(run, null, 2),
    "utf8",
  );
  write(
    dir,
    "outcomes/landing_loaded.md",
    "# landing_loaded\n\n**status:** passed\n",
  );
  write(dir, "snapshots/001_step_1.txt", '- heading "Welcome" [ref=e1]\n');
  write(
    dir,
    "events.ndjson",
    [
      JSON.stringify({
        ts: "2026-09-01T10:00:00.000Z",
        type: "run.started",
        runId,
        spec: "demo_spec",
      }),
      JSON.stringify({
        ts: "2026-09-01T10:00:00.100Z",
        type: "step.started",
        stepId: "step_1",
      }),
      JSON.stringify({
        ts: "2026-09-01T10:00:00.220Z",
        type: "step.finished",
        stepId: "step_1",
        durationMs: 120,
      }),
      "",
    ].join("\n"),
  );
  write(
    dir,
    "artifact-manifest.json",
    JSON.stringify({
      version: "1",
      artifacts: [
        {
          path: "events.ndjson",
          kind: "event-log",
          bytes: 10,
          sha256: "a".repeat(64),
        },
        {
          path: "snapshots/001_step_1.txt",
          kind: "snapshot",
          bytes: 8,
          sha256: "b".repeat(64),
        },
        {
          path: "outcomes/landing_loaded.md",
          kind: "outcome-evidence",
          bytes: 9,
          sha256: "c".repeat(64),
        },
      ],
    }),
  );
  return dir;
}

/**
 * Copy an events fixture (test/fixtures/*.ndjson) into a run directory.
 * @param {string} runDir
 * @param {string} fixtureName
 */
function useEventsFixture(runDir, fixtureName) {
  fs.copyFileSync(
    path.join(__dirname, "fixtures", fixtureName),
    path.join(runDir, "events.ndjson"),
  );
}

/**
 * A minimal project: config + two specs + a decoy YAML that is not a spec.
 * @param {string} root
 * @returns {string}
 */
function makeProject(root = tempDir("cairn-project-")) {
  write(
    root,
    "cairntrace.config.yml",
    [
      "version: 1",
      "project: fixture-project",
      "defaultEnvironment: local",
      "artifactRoot: /tmp/fixture-runs",
      "browser:",
      "  testIdAttribute: data-qa",
      "environments:",
      "  local:",
      "    baseUrl: http://localhost:8787",
      "  staging:",
      "    baseUrl: https://staging.example.com",
      "    services: false",
      "",
    ].join("\n"),
  );
  write(
    root,
    "flows/checkout.yml",
    [
      "version: 1",
      "name: checkout",
      "intent: a guest can complete checkout",
      "imports:",
      "  - actions/login_admin.yml",
      "metadata:",
      "  tags: [smoke, checkout]",
      "outcomes:",
      "  - id: order_saved",
      "    description: the order confirmation renders",
      "    verify:",
      "      text:",
      "        contains: Order saved",
      "steps:",
      "  - id: open_home",
      "    open: /",
      "  - id: click_buy",
      "    click: { by: role, role: button, name: Buy }",
      "  - id: maybe_dismiss",
      '    when: "text:Accept cookies"',
      "    optional: true",
      "    click: { by: text, text: Accept }",
      "",
    ].join("\n"),
  );
  write(root, "flows/broken.yml", "steps:\n  - open: /\noutcomes: [\n");
  write(
    root,
    "config/docker-compose.yml",
    "services:\n  db:\n    image: postgres\n",
  );
  write(
    root,
    "node_modules/pkg/flows/nested.yml",
    "steps: []\nintent: ignored\n",
  );
  return root;
}

/** Remove every temp dir this process created. */
function cleanup() {
  for (const dir of created.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort; the OS reaps tmp
    }
  }
}

module.exports = {
  tempDir,
  write,
  makeRun,
  makeProject,
  useEventsFixture,
  cleanup,
};
