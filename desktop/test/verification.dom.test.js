/**
 * Wave 4 in a DOM (happy-dom): datasource evidence tables and poll
 * attempts, expect / capture entries, gate waits, teardown, run-step output
 * and fixtures in Run detail and Live, and the config registries
 * (datasources per environment, gates, fixtures) in Environment and
 * Catalog.
 *
 * Run detail reads a temp run directory through the real lib/runs.js reader;
 * Environment and Catalog get the registries lib/registries.js builds. Events
 * are built inline because they plant credentials the runner would never
 * write: every test checks that a planted credential never reaches the
 * structured views.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const env = require("./dom-env");
const { cleanup, makeRun, tempDir, write } = require("./helpers");
const invocations = require("../lib/invocations");
const registries = require("../lib/registries");
const runs = require("../lib/runs");

const { Studio, document } = env.installDom();

after(() => {
  env.teardown();
  cleanup();
});

const SECRET = "hunter2-very-secret";

/** @param {Element | null | undefined} node */
const text = (node) => node?.textContent ?? "";
/**
 * @param {ParentNode} root
 * @param {string} selector
 * @returns {HTMLElement[]}
 */
const all = (root, selector) => [...root.querySelectorAll(selector)];

function mountPoint() {
  const root = /** @type {HTMLElement} */ (document.getElementById("view"));
  Studio.clear(root);
  return root;
}

/**
 * @param {HTMLElement} root
 * @param {string} id
 */
async function openTab(root, id) {
  const tab = /** @type {HTMLElement | null} */ (
    root.querySelector(`#run-tab-${id}`)
  );
  assert.ok(tab, `tab ${id}`);
  tab.click();
  await env.waitFor(
    () => !root.querySelector("#tab-host .loading"),
    `tab ${id} painted`,
  );
}

const CONFIG_DOC = {
  project: "shop",
  datasources: {
    app_db: {
      kind: "mongo",
      docker: { service: "mongo" },
      database: "shop",
    },
    reports_db: {
      kind: "mongo",
      uri: `mongodb://reporter:${SECRET}@db.local:27017/reports`,
      database: "reports",
      mode: "read-only",
    },
    flows: {
      kind: "temporal",
      api: "http://temporal.local:8080",
      namespace: "default",
      auth: { basic: `ops:${SECRET}` },
    },
  },
  environments: {
    local: { baseUrl: "http://localhost:8787" },
    staging: {
      baseUrl: "https://staging.example.test",
      datasources: {
        app_db: { uri: "${secrets.STAGING_MONGO_URI}" },
        reports_db: false,
      },
    },
  },
  gates: {
    "api-health": {
      http: { url: "http://localhost:8787/health", auth: { bearer: SECRET } },
      timeout: "2m",
    },
    "db-port": { tcp: "localhost:27017", stable: 3 },
  },
  services: { docker: { command: "docker compose up -d", ready: "db-port" } },
  fixtures: {
    demo_order: {
      kind: "mongo",
      scope: "run",
      ensure: { insert: {} },
      teardown: { delete: {} },
      outputs: { orderId: "$.id" },
      owner: "orders-suite",
    },
  },
};

/** @param {Record<string, any>} [extra] */
function configuredState(extra = {}) {
  Studio.state.booted = true;
  Studio.state.info = {
    cairn: { command: "/usr/local/bin/cairn", source: "path" },
    userData: "/tmp/studio-test",
  };
  Studio.state.settings = {
    activeProject: "/tmp/project",
    run: {},
    ui: {},
    projects: [],
  };
  Studio.state.project = {
    dir: "/tmp/project",
    configPath: "/tmp/project/cairntrace.config.yml",
    specs: [
      {
        path: "/tmp/project/flows/order.yml",
        rel: "flows/order.yml",
        summary: { name: "order_sync", wait: ["api-health"] },
      },
    ],
    config: {
      path: "/tmp/project/cairntrace.config.yml",
      project: "shop",
      defaultEnvironment: "local",
      environments: [
        { name: "local", baseUrl: "http://localhost:8787", policy: null },
        {
          name: "staging",
          baseUrl: "https://staging.example.test",
          policy: { trait: "shared", mutations: "deny", description: null },
        },
      ],
      registries: registries.summarizeRegistries(CONFIG_DOC),
      ...extra,
    },
  };
}

// ── Run detail ─────────────────────────────────────────────────────────────

const RUN = "2026-10-02T09-00-00-000Z_order_sync_ddeeff";
/** @type {string} */
let runsRoot;

before(() => {
  runsRoot = tempDir("cairn-dom-wave4-");
  const dir = makeRun(runsRoot, RUN, {
    specName: "order_sync",
    run: {
      status: "failed",
      summary: "1 of 2 outcomes failed",
      failure: {
        phase: "steps",
        step: "banner_saved",
        message:
          'expect banner_saved: expected text "Saved"; got text "Saving…"',
      },
      outcomes: [
        {
          id: "order_in_db",
          status: "passed",
          evidence: "outcomes/order_in_db.md",
          evidenceRaw: "outcomes/order_in_db.raw.json",
        },
        {
          id: "workflow_done",
          status: "failed",
          evidence: "outcomes/workflow_done.md",
          evidenceRaw: "outcomes/workflow_done.raw.json",
        },
      ],
      steps: [
        {
          id: "seed_order",
          status: "passed",
          durationMs: 890,
          artifacts: [],
        },
        {
          id: "grab_rows",
          status: "passed",
          durationMs: 40,
          artifacts: [
            "captures/rows.json",
            "captures/apiToken.json",
            "captures/many.json",
          ],
        },
        {
          id: "banner_saved",
          status: "failed",
          durationMs: 5000,
          error:
            'expect banner_saved: expected text "Saved"; got text "Saving…"',
          artifacts: ["expects/003_banner_saved.json"],
        },
        {
          id: "sync_now",
          status: "failed",
          durationMs: 300,
          error:
            "run ./sync.sh failed (exit 2): connecting\nqueue sync: 0/3 done\nerror: worker unavailable",
          artifacts: [],
        },
      ],
    },
  });
  write(
    dir,
    "outcomes/order_in_db.md",
    "# order_in_db\n\n**status:** passed\n",
  );
  write(
    dir,
    "outcomes/workflow_done.md",
    "# workflow_done\n\n**status:** failed\n",
  );
  write(
    dir,
    "outcomes/order_in_db.raw.json",
    JSON.stringify({
      kind: "mongo",
      source: {
        name: "app_db",
        kind: "mongo",
        transport: "docker",
        database: "shop",
        service: "mongo",
        mode: "read-write",
      },
      request: { collection: "orders", filter: { ref: "demo-1" }, limit: 20 },
      observed: {
        count: 57,
        docs: Array.from({ length: 20 }, (_, index) => ({
          _id: `o${index}`,
          status: "processed",
          apiToken: SECRET,
        })),
        truncated: true,
      },
      attempts: [
        ...Array.from({ length: 5 }, (_, index) => ({
          at: new Date(
            Date.parse("2026-10-02T09:00:00.000Z") + index * 1000,
          ).toISOString(),
          ok: false,
          summary: "count=0 (want exists)",
        })),
        ...Array.from({ length: 15 }, (_, index) => ({
          at: new Date(
            Date.parse("2026-10-02T09:00:20.000Z") + index * 1000,
          ).toISOString(),
          ok: index === 14,
          summary: index === 14 ? "count=57" : "count=0 (want exists)",
        })),
      ],
      polledMs: 34000,
    }),
  );
  write(
    dir,
    "outcomes/workflow_done.raw.json",
    JSON.stringify({
      kind: "temporal",
      source: {
        name: "flows",
        kind: "temporal",
        namespace: "default",
        api: `http://ops:${SECRET}@temporal.local:8080`,
      },
      request: { workflowId: "sync-demo-1" },
      observed: {
        workflow: { workflowId: "sync-demo-1", status: "RUNNING" },
        history: {
          runs: [{ runId: "r1", events: 12, pages: 1 }],
          scheduledActivities: ["Fetch", "Store"],
          completedActivities: ["Fetch"],
          unsuccessfulActivities: [],
          maxAttempts: { Fetch: 1, Store: 4 },
        },
      },
    }),
  );
  write(
    dir,
    "expects/003_banner_saved.json",
    JSON.stringify({
      version: 1,
      id: "banner_saved",
      stepId: "banner_saved",
      status: "failed",
      kind: "text",
      expected: 'text "Saved"',
      actual: 'text "Saving…"',
      attempts: 20,
      durationMs: 5000,
      observed: { text: "Saving…" },
    }),
  );
  write(
    dir,
    "captures/rows.json",
    JSON.stringify({
      version: 1,
      assign: "rows",
      kind: "table",
      value: { headers: ["Order", "Status"], rows: [["#1", "processed"]] },
    }),
  );
  // a value captured under a credential-looking name: the runner writes it
  // as captured, so Studio is the only lock
  write(
    dir,
    "captures/apiToken.json",
    JSON.stringify({
      version: 1,
      assign: "apiToken",
      kind: "text",
      value: `tok_live_${SECRET}`,
    }),
  );
  // more rows than Studio lists (the runner bounds captures by bytes)
  write(
    dir,
    "captures/many.json",
    JSON.stringify({
      version: 1,
      assign: "many",
      kind: "table",
      value: {
        headers: ["n"],
        rows: Array.from({ length: 100 }, (_, index) => [String(index)]),
      },
    }),
  );
  write(
    dir,
    "fixtures.json",
    JSON.stringify({
      version: 1,
      entries: [
        {
          name: "demo_order",
          adapter: "mongo",
          scope: "run",
          ensuredAt: "2026-10-02T08:59:59.000Z",
          outputs: { orderId: "o1", password: SECRET },
          teardown: { status: "ok", at: "2026-10-02T09:01:00.000Z" },
        },
      ],
    }),
  );
  write(
    dir,
    "events.ndjson",
    `${[
      {
        ts: "2026-10-02T09:00:00.000Z",
        type: "run.started",
        runId: RUN,
        spec: "order_sync",
      },
      {
        ts: "2026-10-02T09:00:00.010Z",
        type: "fixture.ensure",
        name: "demo_order",
        adapter: "mongo",
        status: "ok",
        durationMs: 20,
        outputs: { orderId: "o1", password: SECRET },
      },
      {
        ts: "2026-10-02T09:00:00.020Z",
        type: "fixture.reset",
        name: "demo_order",
        adapter: "mongo",
        status: "dry-run",
        durationMs: 2,
      },
      {
        ts: "2026-10-02T09:00:00.030Z",
        type: "gate.started",
        name: "api-health",
        budgetMs: 60000,
        scope: "precondition",
        everyMs: 1000,
      },
      {
        ts: "2026-10-02T09:00:00.040Z",
        type: "gate.attempt",
        name: "api-health",
        attempt: 1,
        ok: false,
        detail: "GET http://localhost:8787/health → 503 (want 2xx|3xx)",
        scope: "precondition",
      },
      {
        ts: "2026-10-02T09:00:02.040Z",
        type: "gate.attempt",
        name: "api-health",
        attempt: 3,
        ok: true,
        detail: "GET http://localhost:8787/health → 200",
        scope: "precondition",
      },
      {
        ts: "2026-10-02T09:00:02.050Z",
        type: "gate.passed",
        name: "api-health",
        attempts: 3,
        durationMs: 2020,
        lastDetail: "GET http://localhost:8787/health → 200",
        scope: "precondition",
      },
      {
        ts: "2026-10-02T09:00:02.100Z",
        type: "step.started",
        stepId: "seed_order",
        index: 1,
        total: 4,
        kind: "run",
        label: "run ./seed.sh → seeded",
      },
      {
        ts: "2026-10-02T09:00:03.000Z",
        type: "step.finished",
        stepId: "seed_order",
        durationMs: 890,
      },
      {
        ts: "2026-10-02T09:00:03.010Z",
        type: "step.started",
        stepId: "grab_rows",
        index: 2,
        total: 4,
        kind: "step",
        label: "step",
      },
      {
        ts: "2026-10-02T09:00:03.050Z",
        type: "step.finished",
        stepId: "grab_rows",
        durationMs: 40,
      },
      {
        ts: "2026-10-02T09:00:03.060Z",
        type: "step.started",
        stepId: "banner_saved",
        index: 3,
        total: 4,
        kind: "step",
        label: "step",
      },
      {
        ts: "2026-10-02T09:00:08.060Z",
        type: "expect.failed",
        stepId: "banner_saved",
        expectId: "banner_saved",
        kind: "text",
        path: "expects/003_banner_saved.json",
        attempts: 20,
        durationMs: 5000,
        expected: 'text "Saved"',
        actual: 'text "Saving…"',
      },
      {
        ts: "2026-10-02T09:00:08.070Z",
        type: "step.failed",
        stepId: "banner_saved",
        durationMs: 5000,
        error: 'expect banner_saved: expected text "Saved"; got text "Saving…"',
      },
      {
        ts: "2026-10-02T09:00:08.100Z",
        type: "step.started",
        stepId: "sync_now",
        index: 4,
        total: 4,
        kind: "run",
        label: "run ./sync.sh",
      },
      {
        ts: "2026-10-02T09:00:08.400Z",
        type: "step.failed",
        stepId: "sync_now",
        durationMs: 300,
        error:
          "run ./sync.sh failed (exit 2): connecting\nqueue sync: 0/3 done\nerror: worker unavailable",
      },
      {
        ts: "2026-10-02T09:00:08.500Z",
        type: "outcome.started",
        outcomeId: "order_in_db",
        kind: "mongo",
        timeoutMs: 40000,
      },
      {
        ts: "2026-10-02T09:00:42.500Z",
        type: "outcome.passed",
        outcomeId: "order_in_db",
        durationMs: 34000,
        attempts: 35,
        polledMs: 34000,
      },
      {
        ts: "2026-10-02T09:00:42.600Z",
        type: "outcome.started",
        outcomeId: "workflow_done",
        kind: "temporal",
      },
      {
        ts: "2026-10-02T09:00:43.600Z",
        type: "outcome.failed",
        outcomeId: "workflow_done",
        durationMs: 1000,
      },
      {
        ts: "2026-10-02T09:00:43.700Z",
        type: "teardown.started",
        index: 1,
        total: 2,
        kind: "run",
        stepId: "clear_order",
        label: "run ./clear.sh",
        runStatus: "failed",
      },
      {
        ts: "2026-10-02T09:00:44.000Z",
        type: "teardown.finished",
        index: 1,
        kind: "run",
        stepId: "clear_order",
        status: "failed",
        durationMs: 300,
        error: "run ./clear.sh failed (exit 1): no order matched demo-1",
      },
      {
        ts: "2026-10-02T09:00:44.010Z",
        type: "teardown.started",
        index: 2,
        total: 2,
        kind: "click",
        stepId: "close_banner",
        runStatus: "failed",
      },
      {
        ts: "2026-10-02T09:00:44.200Z",
        type: "teardown.finished",
        index: 2,
        kind: "click",
        stepId: "close_banner",
        status: "passed",
        durationMs: 190,
      },
      {
        ts: "2026-10-02T09:00:44.300Z",
        type: "run.failed",
        runId: RUN,
        durationMs: 44300,
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );
});

function runBridge() {
  return env.installBridge({
    "run:detail": (/** @type {string} */ ref) => ({
      ...runs.readRunDetail(
        path.isAbsolute(ref) ? ref : path.join(runsRoot, ref),
      ),
      restored: false,
    }),
    "runs:history": () => [],
    "run:artifact-text": (/** @type {any} */ options) =>
      runs.readBoundedText(
        String(options?.runDir),
        String(options?.path ?? ""),
        400_000,
      ),
    "run:artifact-image": () => ({ ok: false, error: "no images in tests" }),
    "run:events": (/** @type {any} */ options) =>
      runs.readEventsFrom(
        String(options?.runDir),
        Number(options?.offset ?? 0),
      ),
    "fs:exists": () => true,
  });
}

describe("Run detail: wave-4 evidence", () => {
  it("opens failure-first on the failed expect, with the teardown failure", async () => {
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: RUN, from: "runs" });
    await env.waitFor(
      () => root.querySelector("#tab-host .failure-first"),
      "failure panel",
    );
    const panel =
      /** @type {HTMLElement} */ (root.querySelector(".failure-expect"));
    assert.ok(panel, "an expect panel");
    assert.match(text(panel), /expected\s*text "Saved"/);
    assert.match(text(panel), /actual\s*text "Saving…"/);
    assert.match(text(panel), /20 attempts/);
    const teardown =
      /** @type {HTMLElement} */ (root.querySelector(".failure-teardown"));
    assert.match(text(teardown), /clear_order/);
    assert.match(text(teardown), /no order matched demo-1/);
    assert.match(text(teardown), /keeps the run's verdict/);
    // badges under the title
    assert.match(text(root.querySelector(".run-badges")), /teardown 1 failed/);
    assert.match(
      text(root.querySelector(".run-badges")),
      /fixtures dry-run · 1/,
    );
    assert.ok(!text(root).includes(SECRET));
  });

  it("shows datasource rows, truncation and the poll attempts per outcome", async () => {
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: RUN, tab: "outcomes" });
    await env.waitFor(() => root.querySelector(".outcome-card"), "outcomes");
    const mongo = /** @type {HTMLElement} */ (
      root.querySelector('.outcome-card[data-outcome="order_in_db"]')
    );
    assert.match(text(mongo.querySelector("summary")), /35 attempts · 34\.0s/);
    const evidence =
      /** @type {HTMLElement} */ (mongo.querySelector(".data-evidence"));
    assert.match(
      text(evidence.querySelector(".data-source")),
      /^mongoapp_db · compose service mongo · db shop/,
    );
    assert.ok(
      evidence.querySelector(".data-source .tag-warn"),
      "truncated tag",
    );
    const headers = all(evidence, ".data-table th").map((th) => text(th));
    assert.deepEqual(headers, ["_id", "status", "apiToken"]);
    assert.equal(all(evidence, ".data-table tbody tr").length, 20);
    assert.match(
      text(evidence.querySelector(".data-note")),
      /showing 20 of 57 documents/,
    );
    const attempts = all(evidence, ".attempt-row");
    assert.equal(attempts.length, 21, "20 kept attempts + the gap marker");
    assert.match(text(attempts[5]), /15 attempts not kept/);
    assert.match(text(attempts[6]), /#21/);
    assert.match(text(attempts[20]), /#35.*count=57/);
    assert.match(
      text(evidence.querySelector(".attempts-title")),
      /35 attempts over 34\.0s/,
    );

    const temporal = /** @type {HTMLElement} */ (
      root.querySelector('.outcome-card[data-outcome="workflow_done"]')
    );
    assert.match(text(temporal), /namespace default/);
    assert.match(text(temporal), /RUNNING/);
    assert.deepEqual(
      all(temporal, ".data-table th").map((th) => text(th)),
      ["activity", "completed", "unsuccessful", "max attempt"],
    );

    const expects =
      /** @type {HTMLElement} */ (root.querySelector(".expects-section"));
    assert.match(text(expects), /Step expectations \(1\)/);
    // The structured views mask what the runner's redactor would; the raw
    // sidecar <pre> shows the file as the runner wrote it (redacted there).
    for (const view of all(root, ".data-evidence")) {
      assert.ok(!text(view).includes(SECRET));
      assert.ok(!text(view).includes("ops:"), "no connection userinfo");
    }
  });

  it("puts expect, capture and run-step output in the step list", async () => {
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: RUN, tab: "steps" });
    await env.waitFor(() => root.querySelector(".step-row"), "steps");
    const step = (/** @type {string} */ id) =>
      /** @type {HTMLElement} */ (
        root.querySelector(`.step-row[data-step="${id}"]`)
      );
    assert.match(
      text(step("seed_order").querySelector(".step-what")),
      /run\s+run \.\/seed\.sh → seeded/,
    );
    const rows = step("grab_rows").querySelector(
      '.capture-entry[data-capture="rows"]',
    );
    assert.match(text(rows), /\$\{captures\.rows\}/);
    assert.deepEqual(
      all(/** @type {HTMLElement} */ (rows), "th").map((th) => text(th)),
      ["Order", "Status"],
    );
    const token = /** @type {HTMLElement} */ (
      step("grab_rows").querySelector('.capture-entry[data-capture="apiToken"]')
    );
    assert.match(text(token), /\$\{captures\.apiToken\}/);
    assert.match(text(token), /••••••/);
    assert.match(text(token), /masked: the name looks like a credential/);
    assert.ok(
      !text(token).includes("tok_live"),
      "a secret-named capture shows no value",
    );
    const many = /** @type {HTMLElement} */ (
      step("grab_rows").querySelector('.capture-entry[data-capture="many"]')
    );
    assert.equal(all(many, ".data-table tbody tr").length, 50);
    assert.match(
      text(many.querySelector(".data-note")),
      /showing the first 50 of 100 rows \(Studio lists at most 50/,
    );
    assert.doesNotMatch(text(many), /evidence keeps at most 20/);
    assert.ok(!text(root).includes(SECRET));
    const banner = step("banner_saved");
    assert.match(text(banner.querySelector(".step-what")), /expect/);
    assert.ok(banner.querySelector(".expect-entry.expect-failed"));
    const output = step("sync_now").querySelector("pre.step-error-output");
    assert.ok(output, "a run step's output keeps its lines");
    assert.match(
      text(output),
      /queue sync: 0\/3 done\nerror: worker unavailable/,
    );
  });

  it("lists gates, teardown and fixtures in their own tabs", async () => {
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: RUN, tab: "overview" });
    await env.waitFor(() => root.querySelector("#run-tab-gates"), "tabs");
    assert.equal(text(root.querySelector("#run-tab-gates .count")), "1");
    assert.equal(text(root.querySelector("#run-tab-teardown .count")), "2");
    assert.equal(text(root.querySelector("#run-tab-fixtures .count")), "1");
    const overview = text(root.querySelector("#tab-host"));
    assert.match(overview, /api-health ready \(3 attempts\)/);
    assert.match(overview, /2 items · 1 failed/);

    await openTab(root, "gates");
    const gate = /** @type {HTMLElement} */ (root.querySelector(".gate-card"));
    assert.match(text(gate.querySelector("summary")), /gate api-health/);
    assert.match(text(gate.querySelector("summary")), /precondition/);
    assert.match(text(gate.querySelector("summary")), /ready/);
    assert.match(
      text(gate.querySelector("summary")),
      /3 attempts · 2\.02s of 1m 0s/,
    );
    assert.equal(all(gate, ".attempt-row").length, 2);
    assert.match(text(gate), /503 \(want 2xx\|3xx\)/);

    await openTab(root, "teardown");
    const items = all(root, ".teardown-row");
    assert.equal(items.length, 2);
    assert.ok(items[0].classList.contains("teardown-failed"));
    assert.match(text(items[0]), /CAIRN_RUN_STATUS=failed/);
    assert.match(text(items[0]), /no order matched/);

    await openTab(root, "fixtures");
    const fixture = /** @type {HTMLElement} */ (
      root.querySelector('tr.fixture-row[data-name="demo_order"]')
    );
    assert.match(text(fixture), /ensure ok/);
    assert.match(text(fixture), /reset dry-run/);
    assert.match(text(fixture), /orderId\s*o1/);
    assert.match(text(fixture), /ok · /, "the ledger's teardown");
    assert.match(
      text(root.querySelector("#tab-host")),
      /dry-run: the environment's policy is shared/,
    );
    assert.ok(!text(root).includes(SECRET));
  });

  it("opens a gate failure with its attempts", async () => {
    const dir = makeRun(
      runsRoot,
      "2026-10-02T11-00-00-000Z_order_sync_aaaaaa",
      {
        specName: "order_sync",
        run: {
          status: "errored",
          summary: "precondition wait api-health failed",
          failure: {
            phase: "precondition",
            name: "wait api-health",
            message: 'gate "api-health" not ready after 1m',
            timedOut: true,
          },
          outcomes: [],
          steps: [],
        },
      },
    );
    write(
      dir,
      "events.ndjson",
      `${[
        {
          ts: "2026-10-02T11:00:00.000Z",
          type: "run.started",
          runId: "x",
          spec: "order_sync",
        },
        {
          ts: "2026-10-02T11:00:00.010Z",
          type: "gate.started",
          name: "api-health",
          budgetMs: 60000,
          scope: "precondition",
        },
        {
          ts: "2026-10-02T11:00:00.020Z",
          type: "gate.attempt",
          name: "api-health",
          attempt: 1,
          ok: false,
          detail: "GET /health → 503",
          scope: "precondition",
        },
        {
          ts: "2026-10-02T11:01:00.020Z",
          type: "gate.failed",
          name: "api-health",
          attempts: 60,
          durationMs: 60000,
          lastDetail: "GET /health → 503",
          timedOut: true,
          scope: "precondition",
        },
        {
          ts: "2026-10-02T11:01:00.100Z",
          type: "run.errored",
          runId: "x",
          phase: "precondition",
          name: "wait api-health",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, {
      runRef: "2026-10-02T11-00-00-000Z_order_sync_aaaaaa",
    });
    await env.waitFor(() => root.querySelector(".failure-gate"), "gate panel");
    const panel =
      /** @type {HTMLElement} */ (root.querySelector(".failure-gate"));
    assert.match(text(panel), /Gate · api-health/);
    assert.match(text(panel), /timed out/);
    assert.match(text(panel), /60 attempts · 1m 0s of 1m 0s/);
    assert.match(text(panel), /GET \/health → 503/);
  });
});

// ── Live ───────────────────────────────────────────────────────────────────

describe("Live: gate waits, expect lines, polled outcomes, teardown, fixtures", () => {
  it("streams them into the card and the phase banner", async () => {
    configuredState();
    runBridge();
    const runId = "2026-10-02T12-00-00-000Z_order_sync_bbbbbb";
    const runDir = path.join(runsRoot, runId);
    write(runDir, "run.log", "running\n");
    const now = Date.now();
    const ts = (/** @type {number} */ offset) =>
      new Date(now - 20_000 + offset).toISOString();
    Studio.syncDetected([
      {
        runId,
        runDir,
        spec: "order_sync",
        startedAtMs: now - 20_000,
        lastActivityMs: now,
        liveness: { state: "running", reason: "heartbeat" },
        invocation: null,
      },
    ]);
    Studio.applyExternalEvents(runId, [
      { ts: ts(0), type: "run.started", runId, spec: "order_sync" },
      {
        ts: ts(5),
        type: "fixture.ensure",
        name: "demo_order",
        adapter: "mongo",
        status: "ok",
        durationMs: 20,
        outputs: { orderId: "o1", apiToken: SECRET },
      },
      {
        ts: ts(10),
        type: "phase.changed",
        phase: "preconditions",
        item: "api-health",
        budgetMs: 120000,
      },
      {
        ts: ts(10),
        type: "gate.started",
        name: "api-health",
        budgetMs: 120000,
        scope: "precondition",
      },
      {
        ts: ts(5000),
        type: "gate.attempt",
        name: "api-health",
        attempt: 6,
        ok: false,
        detail: "GET http://localhost:8787/health → 503 (want 2xx|3xx)",
        scope: "precondition",
      },
    ]);
    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      await Studio.live.flush();
      const card = /** @type {HTMLElement} */ (
        all(root, ".live-card").find((node) =>
          String(node.dataset.key).endsWith(runId),
        )
      );
      assert.ok(card, "the run card");
      const banner =
        /** @type {HTMLElement} */ (card.querySelector(".phase-banner"));
      assert.match(
        text(banner.querySelector(".phase-head")),
        /^gate api-health \(precondition\) — GET http:\/\/localhost:8787\/health → 503/,
      );
      assert.match(
        text(banner.querySelector(".phase-detail")),
        /of 2m 0s · attempt 6$/,
      );
      const gateRow =
        /** @type {HTMLElement} */ (card.querySelector(".gate-live"));
      assert.match(
        text(gateRow),
        /gate api-health \(precondition\) · attempt 6 — GET/,
      );
      assert.ok(gateRow.querySelector(".dot-running"));
      assert.match(text(card), /Gates/);
      const fixture =
        /** @type {HTMLElement} */ (card.querySelector(".fixture-live"));
      assert.match(text(fixture), /fixture demo_order \(mongo\)/);
      assert.match(text(fixture), /ensure ok/);
      assert.match(text(fixture), /orderId=o1/);

      Studio.applyExternalEvents(runId, [
        {
          ts: ts(6000),
          type: "gate.passed",
          name: "api-health",
          attempts: 7,
          durationMs: 5990,
          lastDetail: "GET … → 200",
          scope: "precondition",
        },
        { ts: ts(6100), type: "phase.changed", phase: "steps" },
        {
          ts: ts(6200),
          type: "step.started",
          stepId: "banner_saved",
          index: 1,
          total: 1,
          kind: "step",
          label: "step",
        },
        {
          ts: ts(9000),
          type: "expect.failed",
          stepId: "banner_saved",
          expectId: "banner_saved",
          kind: "text",
          path: "expects/001_banner_saved.json",
          attempts: 12,
          durationMs: 2800,
          expected: 'text "Saved"',
          actual: 'text "Saving…"',
        },
        {
          ts: ts(9010),
          type: "step.failed",
          stepId: "banner_saved",
          durationMs: 2810,
          error:
            'expect banner_saved: expected text "Saved"; got text "Saving…"',
        },
        { ts: ts(9100), type: "phase.changed", phase: "outcomes" },
        {
          ts: ts(9200),
          type: "outcome.started",
          outcomeId: "order_in_db",
          kind: "mongo",
          timeoutMs: 30000,
        },
        {
          ts: ts(9300),
          type: "outcome.progress",
          outcomeId: "order_in_db",
          message: "attempt 4/~31: count=0 (want exists)",
        },
      ]);
      await Studio.live.flush();
      assert.match(
        text(card.querySelector(".gate-live")),
        /ready after 7 attempts/,
      );
      const step =
        /** @type {HTMLElement} */ (card.querySelector(".step-live"));
      const expect = step.querySelector(".expect-live.expect-failed");
      assert.match(
        text(expect),
        /expect banner_saved \(text\): expected text "Saved"; got text "Saving…" · 12 attempts/,
      );
      assert.equal(
        all(step, ".inline-error").length,
        1,
        "the verdict, not the error twice",
      );
      const progress = /** @type {HTMLElement} */ (
        card.querySelector(".outcome-live .outcome-progress")
      );
      assert.equal(
        text(progress.querySelector(".attempt-pos")),
        "attempt 4/~31",
      );
      assert.match(text(progress), /count=0 \(want exists\)/);

      Studio.applyExternalEvents(runId, [
        {
          ts: ts(12000),
          type: "outcome.passed",
          outcomeId: "order_in_db",
          durationMs: 2800,
          attempts: 7,
          polledMs: 2700,
        },
        {
          ts: ts(12100),
          type: "phase.changed",
          phase: "teardown",
          item: "clear_order",
          budgetMs: 60000,
        },
        {
          ts: ts(12110),
          type: "teardown.started",
          index: 1,
          total: 1,
          kind: "run",
          stepId: "clear_order",
          label: "run ./clear.sh",
          runStatus: "failed",
        },
      ]);
      await Studio.live.flush();
      assert.match(
        text(card.querySelector(".outcome-live .outcome-attempts")),
        /polled · 7 attempts in 2\.70s/,
      );
      assert.match(
        text(banner.querySelector(".phase-head")),
        /^teardown 1\/1 clear_order · run \.\/clear\.sh$/,
      );
      const teardown =
        /** @type {HTMLElement} */ (card.querySelector(".teardown-live-row"));
      assert.ok(teardown.querySelector(".dot-running"));

      Studio.applyExternalEvents(runId, [
        {
          ts: ts(12400),
          type: "teardown.finished",
          index: 1,
          kind: "run",
          stepId: "clear_order",
          status: "failed",
          durationMs: 290,
          error: "run ./clear.sh failed (exit 1): no order matched",
        },
        { ts: ts(12500), type: "run.failed", runId, durationMs: 12500 },
      ]);
      await Studio.live.flush();
      assert.match(
        text(card.querySelector(".teardown-live")),
        /no order matched/,
      );
      assert.match(text(card), /Teardown \(1\/1 · 1 failed\)/);
      assert.ok(!text(card).includes(SECRET));
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.detected.clear();
    }
  });
});

// ── Invocations ────────────────────────────────────────────────────────────

/**
 * A journal timestamp `offset` ms after "9s ago".
 * @param {number} offset
 */
function journalTs(offset) {
  return new Date(Date.now() - 9_000 + offset).toISOString();
}

describe("Invocations: services gates and suite fixtures from the journal", () => {
  it("shows the gate wait in the banner, then the settled gates and fixtures", async () => {
    configuredState();
    const root2 = tempDir("cairn-inv-wave4-");
    const id = "2026-10-02T14-00-00-000Z_4444_abcdef";
    write(
      path.join(root2, "_invocations", id),
      "invocation.json",
      JSON.stringify({
        version: 1,
        invocationId: id,
        pid: process.pid,
        origin: "cli",
        argv: ["run", "flows/order.yml"],
        planned: [{ index: 1, spec: "flows/order.yml" }],
        status: "running",
        startedAt: new Date(Date.now() - 10_000).toISOString(),
        runs: [],
      }),
    );
    /** @type {Array<Record<string, any>>} */
    let journal = [
      {
        ts: journalTs(0),
        type: "invocation.started",
        invocationId: id,
        planned: 1,
      },
      {
        ts: journalTs(10),
        type: "fixture.ensure",
        name: "catalog_seed",
        adapter: "exec",
        status: "skipped",
        durationMs: 1,
        scope: "seed",
        reason: "fresh: ensured 2026-10-02T08:00:00.000Z",
      },
      {
        ts: journalTs(20),
        type: "phase.changed",
        phase: "services",
        item: "db-port",
        budgetMs: 120000,
      },
      {
        ts: journalTs(20),
        type: "gate.started",
        name: "db-port",
        budgetMs: 120000,
        scope: "services.docker",
      },
      {
        ts: journalTs(30),
        type: "gate.attempt",
        name: "db-port",
        attempt: 2,
        ok: false,
        detail: "tcp localhost:27017 → ECONNREFUSED",
        scope: "services.docker",
      },
    ];
    let offset = 0;
    env.installBridge({
      "invocations:list": () => ({
        runsRoot: root2,
        invocations: invocations.listInvocations(root2),
      }),
      "invocation:get": (/** @type {any} */ options) =>
        invocations.readInvocation(root2, String(options?.invocationId)),
      "invocation:events": (/** @type {any} */ options) => {
        const from = Number(options?.offset ?? 0);
        const batch = journal.slice(from);
        offset = journal.length;
        return { events: batch, offset };
      },
      "invocation:tail-text": () => ({ ok: true, text: "", offset: 0 }),
      "invocation:stop": () => ({ stopped: false }),
    });
    Studio.state.view = "invocations";
    const root = mountPoint();
    const handle = await Studio.views.invocations.render(root, {
      invocationId: id,
    });
    try {
      const detail =
        /** @type {HTMLElement} */ (root.querySelector(".inv-detail"));
      await env.waitFor(
        () => detail.querySelector(".inv-setup .gate-live"),
        "the gate row",
      );
      const gate = /** @type {HTMLElement} */ (
        detail.querySelector(".inv-setup .gate-live")
      );
      assert.match(
        text(gate),
        /gate db-port \(docker\) · attempt 2 — tcp localhost:27017 → ECONNREFUSED/,
      );
      const fixture = /** @type {HTMLElement} */ (
        detail.querySelector(".inv-setup .fixture-live")
      );
      assert.match(text(fixture), /fixture catalog_seed \(seed\)/);
      assert.match(text(fixture), /ensure skipped/);
      assert.match(
        String(fixture.querySelector(".tag")?.getAttribute("title")),
        /fresh: ensured/,
      );
      const banner = detail.querySelector(".phase-banner");
      assert.match(
        text(banner?.querySelector(".phase-head")),
        /^gate db-port \(docker\) — tcp localhost:27017 → ECONNREFUSED$/,
      );
      assert.match(
        text(banner?.querySelector(".phase-detail")),
        /of 2m 0s · attempt 2$/,
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});

// ── Environment + Catalog ──────────────────────────────────────────────────

describe("Environment: datasources, gates and fixtures", () => {
  it("lists datasources per environment with redacted targets, gates and the fixture ledger", async () => {
    configuredState();
    /** @type {any[]} */
    const asked = [];
    env.installBridge({
      "app:info": () => ({
        appVersion: "0.0.0-test",
        cairn: { command: "/usr/local/bin/cairn", source: "path" },
        runsRoot: { runsRoot: "/tmp/runs", source: "default" },
      }),
      "cairn:doctor": () => ({ ok: true, payload: { ok: true, checks: [] } }),
      "services:status": () => ({ ok: true, payload: { hasServices: false } }),
      "checkpoints:list": () => ({ ok: true, payload: { checkpoints: [] } }),
      "fixtures:ledger": () => {
        asked.push("ledger");
        return {
          path: "/home/me/.cairntrace/fixtures/shop.ledger.jsonl",
          exists: true,
          partial: false,
          lines: 2,
          entries: [
            {
              env: "local",
              name: "demo_order",
              state: "live",
              ensuredAt: new Date(Date.now() - 3_600_000).toISOString(),
              lastVerb: "teardown",
              lastStatus: "failed",
              lastAt: new Date().toISOString(),
              lastError: "guard refused database shop_prod",
              outputs: [],
            },
            {
              env: "staging",
              name: "demo_order",
              state: "torn-down",
              ensuredAt: null,
              lastVerb: "teardown",
              lastStatus: "ok",
              lastAt: new Date(Date.now() - 60_000).toISOString(),
              outputs: [],
            },
          ],
        };
      },
    });
    Studio.state.view = "doctor";
    const root = mountPoint();
    await Studio.views.doctor.render(root);
    const panel =
      /** @type {HTMLElement} */ (root.querySelector(".registries-panel"));
    assert.ok(panel, "the registries panel");
    const row = (/** @type {string} */ envName, /** @type {string} */ name) =>
      /** @type {HTMLElement} */ (
        panel.querySelector(
          `tr.datasource-row[data-env="${envName}"][data-name="${name}"]`,
        )
      );
    assert.match(text(row("local", "app_db")), /compose service mongo/);
    assert.match(text(row("local", "app_db")), /inherited/);
    assert.match(
      text(row("local", "reports_db")),
      /mongodb:\/\/\*\*\*@db\.local:27017\/reports/,
    );
    assert.match(
      text(row("staging", "app_db")),
      /\$\{secrets\.STAGING_MONGO_URI\}/,
    );
    assert.match(text(row("staging", "app_db")), /override/);
    assert.ok(row("staging", "reports_db").classList.contains("ds-disabled"));
    assert.match(text(row("local", "flows")), /auth: basic/);

    const gate = /** @type {HTMLElement} */ (
      panel.querySelector('tr.gate-row[data-name="db-port"]')
    );
    assert.match(text(gate), /localhost:27017/);
    assert.match(text(gate), /stable ×3/);
    assert.match(text(gate), /services\.docker\.ready/);
    assert.match(
      text(panel.querySelector('tr.gate-row[data-name="api-health"]')),
      /order_sync/,
      "a spec that waits on it",
    );
    const fixture = /** @type {HTMLElement} */ (
      panel.querySelector('tr.fixture-registry-row[data-name="demo_order"]')
    );
    assert.match(text(fixture), /ensure · teardown/);
    assert.match(text(fixture), /owner orders-suite/);
    const states = all(fixture, ".ledger-state");
    assert.equal(states.length, 2, "one live state per environment");
    assert.match(text(states[0]), /local: live/);
    assert.match(text(states[0].querySelector("time.rel-time")), /ago/);
    assert.match(states[0].title, /last: teardown failed\nguard refused/);
    assert.match(text(states[1]), /staging: torn-down/);
    assert.deepEqual(asked, ["ledger"]);
    assert.ok(!text(root).includes(SECRET));
  });

  it("leaves the panel out when the config declares none of them", async () => {
    configuredState({ registries: registries.summarizeRegistries({}) });
    env.installBridge({
      "app:info": () => ({
        appVersion: "0.0.0-test",
        cairn: { command: "/usr/local/bin/cairn", source: "path" },
        runsRoot: { runsRoot: "/tmp/runs", source: "default" },
      }),
      "cairn:doctor": () => ({ ok: true, payload: { ok: true, checks: [] } }),
      "services:status": () => ({ ok: true, payload: {} }),
      "checkpoints:list": () => ({ ok: true, payload: { checkpoints: [] } }),
    });
    const root = mountPoint();
    await Studio.views.doctor.render(root);
    assert.equal(root.querySelector(".registries-panel"), null);
  });
});

describe("Catalog: datasources, gates and fixtures from the config", () => {
  it("adds the tabs, filters by environment and search, and renders without the catalog", async () => {
    configuredState();
    env.installBridge({
      "catalog:get": () => ({
        ok: false,
        unsupported: true,
        exitCode: 1,
        meaning: "error",
        stderr: "error: unknown command 'catalog'",
        cli: "cairn catalog --json",
      }),
    });
    Studio.catalogView.filters.query = "";
    Studio.catalogView.filters.env = "";
    Studio.catalogView.filters.tab = "datasources";
    const root = mountPoint();
    await Studio.views.catalog.render(root);
    const tabs = all(root, ".catalog-tabs .tab").map((tab) => text(tab));
    assert.ok(tabs.includes("Datasources3"));
    assert.ok(tabs.includes("Gates2"));
    assert.ok(tabs.includes("Fixtures1"));
    const body =
      /** @type {HTMLElement} */ (root.querySelector(".catalog-body"));
    assert.match(
      text(body.querySelector('tr[data-name="app_db"]')),
      /staging: override/,
    );
    assert.match(
      text(body.querySelector('tr[data-name="reports_db"]')),
      /staging: disabled/,
    );
    assert.match(text(body), /From the project config/);

    // an environment resolves the overrides
    Studio.catalogView.filters.env = "staging";
    await Studio.views.catalog.render(root);
    const staging =
      /** @type {HTMLElement} */ (root.querySelector(".catalog-body"));
    assert.match(
      text(staging.querySelector('tr[data-name="app_db"]')),
      /\$\{secrets\.STAGING_MONGO_URI\}/,
    );
    assert.match(
      text(staging.querySelector('tr[data-name="reports_db"]')),
      /disabled here/,
    );

    Studio.catalogView.filters.env = "";
    Studio.catalogView.filters.query = "temporal";
    await Studio.views.catalog.render(root);
    assert.deepEqual(
      all(root, ".catalog-body tr.catalog-row").map((row) => row.dataset.name),
      ["flows"],
    );

    Studio.catalogView.filters.query = "";
    Studio.catalogView.filters.tab = "fixtures";
    await Studio.views.catalog.render(root);
    assert.match(
      text(root.querySelector('.catalog-body tr[data-name="demo_order"]')),
      /\$\{fixtures\.demo_order\.orderId\}/,
    );
    assert.ok(!text(root).includes(SECRET));
  });
});
