/**
 * Wave 4 in lib/: readiness gates, spec teardown, expect/capture steps,
 * polled outcomes, fixtures and datasource evidence — the reducer, the
 * evidence normalizer, the config registries, and the run-detail reader.
 *
 * `events-gates-teardown.ndjson` is validated against the runner's strict
 * events.v1 (src/core/schema/events.desktopFixtures.test.ts); the masking
 * cases plant credentials the runner would never write, so they are built
 * inline.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const events = require("../lib/events");
const dataEvidence = require("../lib/dataEvidence");
const registries = require("../lib/registries");
const runs = require("../lib/runs");
const specs = require("../lib/specs");
const { cleanup, makeRun, tempDir, write } = require("./helpers");

after(() => cleanup());

/**
 * @param {string} name
 * @returns {Array<Record<string, any>>}
 */
function fixture(name) {
  return fs
    .readFileSync(path.join(__dirname, "fixtures", name), "utf8")
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

const SECRET = "hunter2-very-secret";

describe("gates, teardown, expect and polled outcomes (events.v1 fixture)", () => {
  const stream = fixture("events-gates-teardown.ndjson");
  const model = events.reduceEvents(stream);

  it("folds the gate wait with its attempts", () => {
    assert.equal(model.gates.length, 1);
    const gate = model.gates[0];
    assert.equal(gate.name, "api-health");
    assert.equal(gate.scope, "precondition");
    assert.equal(gate.status, "passed");
    assert.equal(gate.attempts, 4);
    assert.equal(gate.budgetMs, 60000);
    assert.equal(gate.everyMs, 1000);
    assert.equal(gate.durationMs, 3040);
    assert.deepEqual(
      gate.attemptLog.map((entry) => [entry.attempt, entry.ok]),
      [
        [1, false],
        [4, true],
      ],
    );
  });

  it("names an expect step by its verdict and keeps the evidence path", () => {
    const row = model.steps[model.stepIndex.banner_saved];
    assert.equal(row.kind, "expect", "a runner label of `step` becomes expect");
    assert.equal(row.status, "passed");
    assert.equal(row.expect.status, "passed");
    assert.equal(row.expect.attempts, 3);
    assert.ok(row.artifacts.includes("expects/003_banner_saved.json"));
    assert.equal(model.expects.length, 1);
    const seed = model.steps[model.stepIndex.seed_order];
    assert.equal(seed.kind, "run");
    assert.equal(seed.label, "run ./seed-order.sh → seeded");
  });

  it("keeps a polled outcome's attempts and poll time", () => {
    const row = model.outcomes[model.outcomeIndex.order_in_db];
    assert.equal(row.status, "passed");
    assert.equal(row.attempts, 3);
    assert.equal(row.polledMs, 2010);
    assert.equal(row.progress.at(-1), "attempt 3/~31: count=1");
  });

  it("folds the run's fixture verbs, the shared-environment dry-run with its reason", () => {
    assert.equal(model.fixtures.length, 1);
    const [row] = model.fixtures;
    assert.deepEqual(row.order, ["ensure", "reset", "teardown"]);
    assert.equal(row.verbs.reset.status, "dry-run");
    assert.equal(row.verbs.reset.reason, "shared environment");
    assert.equal(row.scope, "run");
    assert.deepEqual(row.outputs, [["orderId", "665f00000000000000000001"]]);
    const reset = stream.find((event) => event.type === "fixture.reset");
    assert.equal(
      events.describeEvent(reset ?? {}).detail,
      "shared environment",
    );
  });

  it("records each teardown item, the failed one with its error", () => {
    assert.equal(model.teardown.length, 2);
    const [first, second] = model.teardown;
    assert.equal(first.status, "failed");
    assert.equal(first.kind, "run");
    assert.equal(first.total, 2);
    assert.equal(first.runStatus, "passed");
    assert.match(first.error, /no order matched/);
    assert.equal(second.status, "passed");
    assert.equal(model.status, "passed", "a failed teardown keeps the verdict");
  });

  it("describes every new event with a meaningful line", () => {
    const lines = stream.map((event) => events.describeEvent(event));
    const byType = (type) =>
      lines.filter((line) => line.type === type).map((line) => line.label);
    assert.match(
      byType("gate.started")[0],
      /^gate api-health waiting · precondition \(budget 1m 0s, every 1\.00s\)$/,
    );
    assert.match(byType("gate.attempt")[0], /attempt 1 · not ready/);
    assert.match(byType("gate.passed")[0], /ready after 4 attempts · 3\.04s/);
    assert.match(
      byType("expect.passed")[0],
      /expect banner_saved passed \(visible\+text\) · 3 attempts/,
    );
    assert.match(byType("outcome.passed")[0], /3 attempts in 2\.01s/);
    assert.match(
      byType("teardown.started")[0],
      /^teardown 1\/2 · run \.\/clear-order\.sh · clear_order started \(run passed\)$/,
    );
    const failed = lines.find(
      (line) => line.type === "teardown.finished" && line.tone === "bad",
    );
    assert.match(failed?.label ?? "", /teardown 1 · clear_order failed/);
    assert.match(failed?.detail ?? "", /no order matched/);
    const attempt = lines.find((line) => line.type === "gate.attempt");
    assert.match(attempt?.detail ?? "", /503 \(want 2xx\|3xx\)/);
  });

  it("describes failed gates and expects", () => {
    const gate = events.describeEvent({
      type: "gate.failed",
      name: "db",
      attempts: 60,
      durationMs: 60000,
      lastDetail: "tcp localhost:27017 → ECONNREFUSED",
      timedOut: true,
    });
    assert.equal(gate.tone, "bad");
    assert.match(gate.label, /gate db timed out after 60 attempts/);
    const cancelled = events.describeEvent({
      type: "gate.failed",
      name: "db",
      attempts: 2,
      durationMs: 900,
      lastDetail: "x",
      cancelled: true,
    });
    assert.equal(cancelled.tone, "warn");
    const expect = events.describeEvent({
      type: "expect.failed",
      stepId: "check",
      expectId: "total",
      kind: "text",
      expected: 'text "3 items"',
      actual: 'text "2 items"',
      attempts: 20,
    });
    assert.equal(expect.tone, "bad");
    assert.equal(expect.detail, 'expected text "3 items"; got text "2 items"');
  });
});

describe("currentPhase while a gate waits or teardown runs", () => {
  const t0 = Date.parse("2026-10-02T09:00:00.000Z");
  const at = (/** @type {number} */ ms) => new Date(t0 + ms).toISOString();

  it("names the gate, its last answer and the attempt count", () => {
    const model = events.reduceEvents([
      { ts: at(0), type: "run.started", runId: "r", spec: "s" },
      {
        ts: at(10),
        type: "phase.changed",
        phase: "preconditions",
        item: "api-health",
        budgetMs: 60000,
      },
      {
        ts: at(10),
        type: "gate.started",
        name: "api-health",
        budgetMs: 60000,
        scope: "precondition",
      },
      {
        ts: at(2010),
        type: "gate.attempt",
        name: "api-health",
        attempt: 3,
        ok: false,
        detail: "GET http://localhost:8787/health → 503 (want 2xx|3xx)",
        scope: "precondition",
      },
    ]);
    const phase = events.currentPhase(model, t0 + 4010);
    assert.equal(
      phase?.head,
      "gate api-health (precondition) — GET http://localhost:8787/health → 503 (want 2xx|3xx)",
    );
    assert.equal(phase?.detail, " · 4.00s of 1m 0s · attempt 3");
    assert.equal(phase?.gate?.attempts, 3);
  });

  it("finds a services gate in a journal stream and closes it at the end", () => {
    const model = events.reduceEvents([
      { ts: at(0), type: "invocation.started", invocationId: "i", planned: 1 },
      { ts: at(5), type: "phase.changed", phase: "services", item: "mongo-up" },
      {
        ts: at(5),
        type: "gate.started",
        name: "mongo-up",
        budgetMs: 0,
        scope: "services.docker",
      },
    ]);
    const phase = events.currentPhase(model, t0 + 1005);
    assert.match(phase?.head ?? "", /^gate mongo-up \(docker\)$/);
    assert.equal(phase?.budgetMs, null, "0 means no deadline");
    events.applyEvent(model, {
      ts: at(2000),
      type: "invocation.finished",
      invocationId: "i",
      status: "aborted",
    });
    assert.equal(model.gates[0].status, "interrupted");
  });

  it("derives a waiting gate on runners without phase events", () => {
    const model = events.reduceEvents([
      { ts: at(0), type: "gate.started", name: "db", budgetMs: 30000 },
    ]);
    const phase = events.currentPhase(model, t0 + 500);
    assert.equal(phase?.phase, "preconditions");
    assert.equal(phase?.item, "db");
    assert.equal(phase?.budgetMs, 30000);
  });

  it("says which teardown item runs", () => {
    const model = events.reduceEvents([
      { ts: at(0), type: "run.started", runId: "r", spec: "s" },
      { ts: at(10), type: "phase.changed", phase: "teardown", item: "drop" },
      {
        ts: at(10),
        type: "teardown.started",
        index: 2,
        total: 3,
        kind: "run",
        stepId: "drop",
        label: "run ./drop.sh",
      },
    ]);
    assert.equal(
      events.currentPhase(model, t0 + 510)?.head,
      "teardown 2/3 drop · run ./drop.sh",
    );
  });
});

describe("fixture events", () => {
  it("folds verbs per fixture and masks credential-shaped outputs", () => {
    const model = events.createRunModel();
    const touched = events.applyEvent(model, {
      type: "fixture.ensure",
      name: "demo_order",
      adapter: "mongo",
      status: "ok",
      durationMs: 210,
      outputs: {
        orderId: "665f00000000000000000001",
        apiToken: SECRET,
        link: `mongodb://admin:${SECRET}@db.local:27017/shop`,
        header: `Bearer ${SECRET}`,
      },
    });
    assert.deepEqual(touched, ["fixtures"]);
    events.applyEvent(model, {
      type: "fixture.reset",
      name: "demo_order",
      adapter: "mongo",
      status: "dry-run",
      durationMs: 3,
    });
    events.applyEvent(model, {
      type: "fixture.teardown",
      name: "demo_order",
      adapter: "mongo",
      status: "failed",
      durationMs: 40,
      error: "guard refused database shop_prod",
    });
    const [row] = model.fixtures;
    assert.deepEqual(row.order, ["ensure", "reset", "teardown"]);
    assert.equal(row.verbs.reset.status, "dry-run");
    assert.equal(row.lastStatus, "failed");
    const outputs = Object.fromEntries(row.outputs);
    assert.equal(outputs.orderId, "665f00000000000000000001");
    assert.equal(outputs.apiToken, "••••••");
    assert.equal(outputs.link, "mongodb://***@db.local:27017/shop");
    assert.equal(outputs.header, "Bearer ••••••");
    assert.ok(!JSON.stringify(model).includes(SECRET));

    const line = events.describeEvent({
      type: "fixture.reset",
      name: "demo_order",
      adapter: "mongo",
      status: "dry-run",
    });
    assert.equal(line.label, "fixture demo_order reset dry-run (mongo)");
    assert.equal(line.tone, "info");
    assert.equal(
      events.describeEvent({
        type: "fixture.ensure",
        name: "kit",
        status: "ok",
        outputs: { id: "1", password: SECRET },
      }).detail,
      "outputs: id, password",
    );
  });

  it("reads a poll position from progress lines", () => {
    assert.deepEqual(
      events.parseAttemptProgress("attempt 3/~31: count=0 (want 1)"),
      {
        attempt: 3,
        of: "~31",
        text: "count=0 (want 1)",
      },
    );
    assert.equal(
      events.parseAttemptProgress("orders attempt 2/31: x")?.of,
      "31",
    );
    assert.equal(events.parseAttemptProgress("polling orders table"), null);
  });
});

describe("datasource evidence (outcomes/<id>.raw.json)", () => {
  const attempts = [
    { at: "2026-10-02T09:00:00.000Z", ok: false, summary: "count=0" },
    { at: "2026-10-02T09:00:01.500Z", ok: true, summary: "count=1" },
  ];

  it("lays mongo documents out as a table, bounded and masked", () => {
    const docs = Array.from({ length: 20 }, (_, index) => ({
      _id: { $oid: `665f0000000000000000${String(index).padStart(4, "0")}` },
      status: index % 2 ? "processed" : "pending",
      password: SECRET,
    }));
    const data = dataEvidence.normalizeRawEvidence({
      kind: "mongo",
      source: {
        name: "app_db",
        kind: "mongo",
        transport: "docker",
        database: "shop",
        service: "mongo",
        mode: "read-only",
      },
      request: { collection: "orders", filter: { ref: "demo-1" }, limit: 20 },
      observed: { count: 57, docs, truncated: true },
      attempts,
      polledMs: 1500,
    });
    assert.ok(data);
    assert.equal(data.kind, "mongo");
    assert.equal(
      data.source?.text,
      "mongo app_db · compose service mongo · db shop · read-only",
    );
    assert.deepEqual(data.table?.columns, ["_id", "status", "password"]);
    assert.equal(data.table?.shown, 20);
    assert.equal(data.table?.total, 57);
    assert.equal(data.table?.unit, "documents");
    assert.ok(data.truncated);
    assert.equal(data.table?.rows[0][2], "••••••");
    assert.deepEqual(data.facts, [["count", "57"]]);
    assert.equal(data.attempts?.length, 2);
    assert.equal(data.attempts?.[1].offsetMs, 1500);
    assert.equal(data.attemptCount, null, "a bounded log is not the count");
    assert.equal(data.polledMs, 1500);
    assert.match(data.request ?? "", /"collection": "orders"/);
    assert.ok(!JSON.stringify(data).includes(SECRET));
  });

  it("shows temporal executions, a described workflow, and its activities", () => {
    const query = dataEvidence.normalizeRawEvidence({
      kind: "temporal",
      source: {
        name: "flows",
        kind: "temporal",
        namespace: "default",
        api: `http://ops:${SECRET}@temporal.local:8080/api?token=${SECRET}`,
      },
      request: { query: "WorkflowType='Sync'" },
      observed: {
        count: 2,
        executions: [
          {
            workflowId: "sync-1",
            runId: "r1",
            status: "COMPLETED",
            type: "Sync",
          },
          {
            workflowId: "sync-2",
            runId: "r2",
            status: "RUNNING",
            type: "Sync",
          },
        ],
        truncated: false,
      },
    });
    assert.deepEqual(query?.table?.columns, [
      "workflowId",
      "runId",
      "status",
      "type",
    ]);
    assert.equal(query?.table?.unit, "executions");
    assert.ok(!JSON.stringify(query).includes(SECRET));
    assert.match(query?.source?.text ?? "", /temporal\.local:8080\/api\?…/);

    const described = dataEvidence.normalizeRawEvidence({
      kind: "temporal",
      source: {
        name: "flows",
        kind: "temporal",
        namespace: "default",
        api: "x",
      },
      request: { workflowId: "sync-1" },
      observed: {
        workflow: {
          workflowId: "sync-1",
          status: "COMPLETED",
          historyLength: 42,
        },
        history: {
          runs: [{ runId: "r1", events: 42, pages: 1 }],
          scheduledActivities: ["Fetch", "Store"],
          completedActivities: ["Fetch"],
          unsuccessfulActivities: ["Store"],
          maxAttempts: { Fetch: 1, Store: 5 },
          inputBytes: 2048,
        },
      },
    });
    const facts = Object.fromEntries(described?.facts ?? []);
    assert.equal(facts.status, "COMPLETED");
    assert.equal(facts["history runs"], "r1 (42 events)");
    assert.deepEqual(described?.table?.columns, [
      "activity",
      "completed",
      "unsuccessful",
      "max attempt",
    ]);
    assert.deepEqual(described?.table?.rows[1], ["Store", "no", "yes", "5"]);

    const absent = dataEvidence.normalizeRawEvidence({
      kind: "temporal",
      request: { workflowId: "gone" },
      observed: { workflow: null },
    });
    assert.match(absent?.note ?? "", /not found/);
  });

  it("previews http bodies and masks credential headers in the request", () => {
    const data = dataEvidence.normalizeRawEvidence({
      kind: "http",
      source: { name: "api", kind: "http", baseUrl: "http://api.local" },
      request: {
        method: "GET",
        url: "http://api.local/orders",
        headers: { authorization: `Bearer ${SECRET}`, accept: "json" },
      },
      observed: {
        status: 200,
        body: { ok: true, total: 3 },
        bytes: 24,
        truncated: false,
      },
    });
    assert.deepEqual(data?.facts, [
      ["status", "200"],
      ["bytes", "24"],
    ]);
    assert.equal(data?.table, null);
    assert.match(data?.value ?? "", /"total": 3/);
    assert.ok(!JSON.stringify(data).includes(SECRET));

    const list = dataEvidence.normalizeRawEvidence({
      kind: "http",
      request: { url: "/orders" },
      observed: { status: 200, body: { items: [{ id: 1 }, { id: 2 }] } },
    });
    assert.equal(list?.table?.unit, "items");
    assert.equal(list?.table?.rows.length, 2);
  });

  it("reads value, table and network evidence", () => {
    const value = dataEvidence.normalizeRawEvidence({
      kind: "value",
      request: { actual: "${captures.rows}", expect: { "$.length": 2 } },
      observed: { value: [{ sku: "A" }, { sku: "B" }], truncated: false },
    });
    assert.deepEqual(value?.table?.columns, ["sku"]);

    const table = dataEvidence.normalizeRawEvidence({
      kind: "table",
      request: { locator: { by: "role", value: "table" } },
      observed: {
        headers: ["Order", "Status"],
        rowCount: 25,
        rows: Array.from({ length: 20 }, (_, i) => [`#${i}`, "ok"]),
        truncated: true,
      },
    });
    assert.deepEqual(table?.table?.columns, ["Order", "Status"]);
    assert.equal(table?.table?.total, 25);
    assert.ok(table?.truncated);

    const network = dataEvidence.normalizeRawEvidence({
      kind: "network",
      request: { method: "PATCH", urlContains: "/api/answers" },
      observed: {
        candidates: 9,
        matching: 1,
        requests: [
          {
            method: "PATCH",
            url: "http://app.local/api/answers/1",
            status: 204,
            at: "2026-10-02T09:00:01.000Z",
          },
        ],
        truncated: false,
      },
      assign: { name: "save", at: "2026-10-02T09:00:01.000Z", count: 1 },
    });
    assert.deepEqual(network?.table?.columns, [
      "method",
      "url",
      "status",
      "at",
    ]);
    assert.equal(
      Object.fromEntries(network?.facts ?? []).assign,
      "save · at 2026-10-02T09:00:01.000Z · count 1",
    );
  });

  it("keeps an SDK poll's observation and attempt count; free-form raw stays raw", () => {
    const sdk = dataEvidence.normalizeRawEvidence({
      message: "never processed",
      observed: { state: "pending" },
      attempts,
      attemptCount: 31,
      polledMs: 30000,
    });
    assert.equal(sdk?.kind, "evidence");
    assert.equal(sdk?.attemptCount, 31);
    assert.match(sdk?.value ?? "", /pending/);
    assert.equal(
      dataEvidence.normalizeRawEvidence({ rows: 3, anything: true }),
      null,
    );
    assert.equal(dataEvidence.normalizeRawEvidence("text"), null);
  });
});

describe("run detail: wave-4 evidence on disk", () => {
  it("reads raw evidence, expects, captures, the fixture ledger and the failure", () => {
    const runsRoot = tempDir("cairn-wave4-");
    const runId = "2026-10-02T09-00-00-000Z_order_sync_ddeeff";
    const dir = makeRun(runsRoot, runId, {
      specName: "order_sync",
      run: {
        status: "errored",
        summary: "precondition wait api-health failed",
        failure: {
          phase: "precondition",
          name: "wait api-health",
          message: 'gate "api-health" not ready after 60s',
          timedOut: true,
        },
        outcomes: [
          {
            id: "order_in_db",
            status: "passed",
            evidence: "outcomes/order_in_db.md",
            evidenceRaw: "outcomes/order_in_db.raw.json",
          },
        ],
        steps: [
          {
            id: "banner_saved",
            status: "failed",
            durationMs: 5000,
            error:
              'expect banner_saved: expected text "Saved"; got text "Saving…"',
            artifacts: ["expects/003_banner_saved.json"],
          },
          {
            id: "grab_rows",
            status: "passed",
            durationMs: 30,
            artifacts: ["captures/rows.json"],
          },
        ],
      },
    });
    write(dir, "outcomes/order_in_db.md", "# order_in_db\n");
    write(
      dir,
      "outcomes/order_in_db.raw.json",
      JSON.stringify({
        kind: "mongo",
        source: {
          name: "app_db",
          kind: "mongo",
          transport: "driver",
          database: "shop",
          mode: "read-write",
        },
        request: { collection: "orders", limit: 20 },
        observed: {
          count: 1,
          docs: [{ _id: "o1", status: "processed" }],
          truncated: false,
        },
        attempts: [
          { at: "2026-10-02T09:00:00.000Z", ok: true, summary: "count=1" },
        ],
        polledMs: 10,
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
        value: { headers: ["Order", "Status"], rows: [["#1", "ok"]] },
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
            outputs: { orderId: "o1", secretKey: SECRET },
            status: "ok",
            reset: { status: "dry-run", at: "2026-10-02T09:00:00.000Z" },
            teardown: { status: "ok", at: "2026-10-02T09:00:09.000Z" },
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
          runId,
          spec: "order_sync",
        },
        {
          ts: "2026-10-02T09:00:00.010Z",
          type: "gate.started",
          name: "api-health",
          budgetMs: 60000,
          scope: "precondition",
        },
        {
          ts: "2026-10-02T09:00:00.020Z",
          type: "gate.attempt",
          name: "api-health",
          attempt: 1,
          ok: false,
          detail: "GET /health → 503",
          scope: "precondition",
        },
        {
          ts: "2026-10-02T09:01:00.020Z",
          type: "gate.failed",
          name: "api-health",
          attempts: 60,
          durationMs: 60000,
          lastDetail: "GET /health → 503",
          timedOut: true,
          scope: "precondition",
        },
        {
          ts: "2026-10-02T09:01:00.100Z",
          type: "teardown.started",
          index: 1,
          total: 1,
          kind: "run",
          stepId: "cleanup",
          runStatus: "errored",
        },
        {
          ts: "2026-10-02T09:01:00.300Z",
          type: "teardown.finished",
          index: 1,
          kind: "run",
          stepId: "cleanup",
          status: "failed",
          durationMs: 200,
          error: "exit 3",
        },
        {
          ts: "2026-10-02T09:01:00.400Z",
          type: "run.errored",
          runId,
          phase: "precondition",
          name: "wait api-health",
          error: "not ready",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );

    const detail = runs.readRunDetail(dir);
    const outcome = detail.outcomes[0];
    assert.equal(outcome.data?.kind, "mongo");
    assert.deepEqual(outcome.data?.table?.columns, ["_id", "status"]);
    assert.equal(detail.expects.length, 1);
    assert.equal(detail.expects[0].status, "failed");
    assert.match(detail.expects[0].observed ?? "", /Saving…/);
    assert.equal(detail.captures.length, 1);
    assert.deepEqual(detail.captures[0].table?.columns, ["Order", "Status"]);
    assert.equal(detail.fixtures?.entries.length, 1);
    assert.deepEqual(detail.fixtures?.entries[0].outputs, [
      ["orderId", "o1"],
      ["secretKey", "••••••"],
    ]);
    assert.equal(detail.fixtures?.entries[0].teardown?.status, "ok");
    assert.equal(detail.fixtures?.entries[0].reset?.status, "dry-run");
    assert.equal(detail.fixtures?.entries[0].status, "ok");
    assert.equal(detail.teardown, null, "run.json carries no teardown record");

    const failure = detail.failure;
    assert.equal(failure?.gate?.name, "api-health");
    assert.equal(failure?.gate?.timedOut, true);
    assert.equal(failure?.gate?.attempts, 60);
    assert.equal(failure?.expect?.id, "banner_saved");
    assert.equal(failure?.expect?.actual, 'text "Saving…"');
    assert.equal(failure?.teardown.length, 1);
    assert.equal(failure?.teardown[0].stepId, "cleanup");
    assert.ok(!JSON.stringify(detail).includes(SECRET));
  });

  it("reads a run.json teardown record when the runner writes one", () => {
    const runsRoot = tempDir("cairn-wave4-td-");
    const dir = makeRun(runsRoot, "2026-10-02T10-00-00-000Z_demo_aaaaaa", {
      run: {
        teardown: [
          {
            index: 1,
            stepId: "drop",
            kind: "run",
            status: "passed",
            durationMs: 12,
          },
        ],
      },
    });
    const detail = runs.readRunDetail(dir);
    assert.deepEqual(detail.teardown, [
      {
        index: 1,
        stepId: "drop",
        kind: "run",
        status: "passed",
        durationMs: 12,
        error: null,
      },
    ]);
    assert.deepEqual(detail.expects, []);
    assert.deepEqual(detail.captures, []);
    assert.equal(detail.fixtures, null);
  });
});

/** One record as src/core/fixtures/ledger.ts appendProjectLedger writes it. */
const record = (/** @type {Record<string, any>} */ fields) => ({
  v: 1,
  project: "shop",
  adapter: "mongo",
  scope: "suite",
  defHash: "abc123",
  origin: "run",
  pid: 4242,
  host: "devbox",
  ...fields,
});

describe("project fixture ledger (JSONL)", () => {
  it("folds verbs into the live state per environment and fixture", () => {
    const dir = tempDir("cairn-ledger-");
    const file = path.join(dir, "shop.ledger.jsonl");
    fs.writeFileSync(
      file,
      [
        record({
          ts: "2026-10-01T09:00:00.000Z",
          env: "local",
          name: "demo_order",
          verb: "ensure",
          status: "ok",
          outputs: { orderId: "o1", token: SECRET },
          ttlMs: 3_600_000,
          runId: "r1",
        }),
        "not json",
        record({
          ts: "2026-10-01T09:01:00.000Z",
          env: "staging",
          name: "demo_order",
          verb: "ensure",
          status: "dry-run",
        }),
        record({
          ts: "2026-10-01T09:02:00.000Z",
          env: "local",
          name: "demo_order",
          verb: "verify",
          status: "failed",
        }),
        record({
          ts: "2026-10-01T09:03:00.000Z",
          env: "local",
          name: "kit",
          adapter: "exec",
          scope: "seed",
          verb: "ensure",
          status: "ok",
        }),
        record({
          ts: "2026-10-01T09:04:00.000Z",
          env: "local",
          name: "kit",
          adapter: "exec",
          scope: "seed",
          verb: "teardown",
          status: "ok",
        }),
        record({
          ts: "2026-10-01T09:05:00.000Z",
          env: "local",
          name: "demo_order",
          verb: "teardown",
          status: "failed",
          error: `auth failed for mongodb://app:${SECRET}@db.local`,
        }),
        record({
          ts: "2026-10-01T09:06:00.000Z",
          env: "ci",
          name: "gone",
          verb: "teardown",
          status: "failed",
        }),
      ]
        .map((line) => (typeof line === "string" ? line : JSON.stringify(line)))
        .join("\n"),
    );
    const ledger = dataEvidence.readFixtureLedger(file);
    assert.equal(ledger.exists, true);
    assert.equal(ledger.lines, 8);
    const state = (/** @type {string} */ env, /** @type {string} */ name) =>
      ledger.entries.find((entry) => entry.env === env && entry.name === name);
    const order = state("local", "demo_order");
    assert.equal(order?.state, "live", "a failed teardown keeps it live");
    assert.equal(order?.ensuredAt, "2026-10-01T09:00:00.000Z");
    assert.equal(order?.expiresAt, "2026-10-01T10:00:00.000Z");
    assert.equal(order?.lastVerb, "teardown");
    assert.equal(order?.lastStatus, "failed");
    assert.match(order?.lastError ?? "", /mongodb:\/\/\*\*\*@db\.local/);
    assert.deepEqual(order?.outputs, [
      ["orderId", "o1"],
      ["token", "••••••"],
    ]);
    assert.equal(
      state("staging", "demo_order"),
      undefined,
      "dry-run changes nothing",
    );
    assert.equal(state("local", "kit")?.state, "torn-down");
    assert.equal(state("ci", "gone")?.state, "failed");
    assert.ok(!JSON.stringify(ledger).includes(SECRET));

    const tail = dataEvidence.readFixtureLedger(file, { maxBytes: 400 });
    assert.equal(tail.partial, true);
    assert.equal(
      dataEvidence.readFixtureLedger(path.join(dir, "none.jsonl")).exists,
      false,
    );
  });
});

describe("config registries (datasources, gates, fixtures)", () => {
  const doc = {
    project: "shop",
    datasources: {
      app_db: {
        kind: "mongo",
        docker: { service: "mongo", project: "shop" },
        database: "shop",
        guard: { databases: ["shop"] },
      },
      reports_db: {
        kind: "mongo",
        uri: `mongodb://reporter:${SECRET}@db1.local:27017,db2.local/reports?authSource=admin`,
        database: "reports",
        mode: "read-only",
      },
      flows: {
        kind: "temporal",
        api: "http://temporal.local:8080",
        namespace: "default",
        auth: { basic: `ops:${SECRET}` },
      },
      api: {
        kind: "http",
        baseUrl: "http://api.local",
        headers: { "x-api-key": SECRET },
        auth: { bearer: "${secrets.API_TOKEN}" },
      },
    },
    environments: {
      local: { baseUrl: "http://localhost:8787" },
      staging: {
        baseUrl: "https://staging.example.test",
        datasources: {
          app_db: { uri: "${secrets.STAGING_MONGO_URI}" },
          reports_db: false,
          audit: { kind: "http", baseUrl: "https://audit.example.test" },
        },
      },
    },
    gates: {
      "api-health": {
        http: {
          url: "http://localhost:8787/health",
          status: "2xx",
          json: { "checks.db": "ok" },
          auth: { basic: `ops:${SECRET}` },
        },
        timeout: "2m",
        every: "2s",
      },
      "db-port": { tcp: "localhost:27017", stable: 3 },
      "queue-drained": {
        command: {
          run: `./check.sh --password=${SECRET} -u ops:${SECRET} --env=\${env.X}`,
          exitCode: 0,
        },
      },
      "stack-ready": {
        all: ["api-health", "db-port", "http://localhost:9000/ready"],
      },
    },
    services: {
      docker: { command: "docker compose up -d", ready: ["db-port"] },
      tmux: {
        session: "s",
        windows: [
          {
            name: "api",
            command: "bun dev",
            after: "db-port",
            readyOn: { gate: "api-health" },
          },
        ],
      },
    },
    webServer: {
      command: "bun web",
      url: "http://localhost:3000",
      ready: "stack-ready",
    },
    fixtures: {
      demo_order: {
        kind: "mongo",
        scope: "run",
        source: "app_db",
        ensure: { insert: { orders: [{ ref: "demo-1" }] } },
        teardown: { delete: { orders: { ref: "demo-1" } } },
        outputs: { orderId: "$.insertedIds.0" },
        owner: "orders-suite",
        ttl: "2h",
        needs: ["kit"],
      },
      kit: {
        kind: "exec",
        scope: "seed",
        ensure: `./kit.sh --token=${SECRET}`,
      },
    },
  };
  const summary = registries.summarizeRegistries(doc);

  it("never carries a credential", () => {
    assert.ok(!JSON.stringify(summary).includes(SECRET));
  });

  it("describes datasources by kind and redacted target", () => {
    const byName = Object.fromEntries(
      summary.datasources.topLevel.map((ds) => [ds.name, ds]),
    );
    assert.equal(byName.app_db.target, "compose service mongo · project shop");
    assert.equal(byName.app_db.transport, "docker");
    assert.equal(
      byName.reports_db.target,
      "mongodb://***@db1.local:27017,db2.local/reports?…",
    );
    assert.equal(byName.reports_db.mode, "read-only");
    assert.equal(byName.flows.target, "http://temporal.local:8080");
    assert.deepEqual(Object.fromEntries(byName.flows.facts), {
      namespace: "default",
      auth: "basic",
    });
    assert.deepEqual(Object.fromEntries(byName.api.facts), {
      auth: "bearer · ${secrets.API_TOKEN}",
      headers: "x-api-key",
    });
  });

  it("merges environment overrides the way the runner does", () => {
    const staging = summary.datasources.environments.find(
      (env) => env.env === "staging",
    );
    const byName = Object.fromEntries(
      (staging?.datasources ?? []).map((ds) => [ds.name, ds]),
    );
    assert.equal(byName.app_db.state, "override");
    assert.equal(byName.app_db.target, "${secrets.STAGING_MONGO_URI}");
    assert.equal(
      byName.app_db.transport,
      "driver | mongosh",
      "a uri drops docker",
    );
    assert.equal(byName.reports_db.state, "disabled");
    assert.equal(byName.audit.state, "env-only");
    assert.equal(byName.audit.kind, "http");
    assert.equal(byName.flows.state, "inherited");
    const local = summary.datasources.environments.find(
      (env) => env.env === "local",
    );
    assert.ok(local?.datasources.every((ds) => ds.state === "inherited"));
  });

  it("summarizes gates and where the config waits on them", () => {
    const byName = Object.fromEntries(
      summary.gates.map((gate) => [gate.name, gate]),
    );
    assert.equal(byName["api-health"].probe, "http");
    assert.equal(
      byName["api-health"].target,
      "GET http://localhost:8787/health",
    );
    assert.equal(byName["api-health"].timeout, "2m");
    assert.deepEqual(Object.fromEntries(byName["api-health"].facts), {
      status: "2xx",
      json: "checks.db",
      auth: "basic",
    });
    assert.equal(byName["db-port"].target, "localhost:27017");
    assert.equal(byName["db-port"].stable, 3);
    assert.equal(
      byName["queue-drained"].target,
      "./check.sh --password=•••••• -u •••••• --env=${env.X}",
    );
    assert.equal(
      byName["stack-ready"].target,
      "api-health + db-port + http://localhost:9000/ready",
    );
    assert.deepEqual(byName["db-port"].usedBy, [
      "services.docker.ready",
      "services.tmux api.after",
    ]);
    assert.deepEqual(byName["api-health"].usedBy, [
      "services.tmux api.readyOn",
    ]);
    assert.deepEqual(byName["stack-ready"].usedBy, ["webServer.ready"]);
  });

  it("summarizes fixtures without commands or documents", () => {
    const [order, kit] = summary.fixtures;
    assert.deepEqual(order, {
      name: "demo_order",
      kind: "mongo",
      scope: "run",
      verbs: ["ensure", "teardown"],
      owner: "orders-suite",
      ttl: "2h",
      needs: ["kit"],
      outputs: ["orderId"],
      datasource: "app_db",
      description: null,
    });
    assert.equal(kit.scope, "seed");
    assert.deepEqual(kit.verbs, ["ensure"]);
  });

  it("names the ledger file like the CLI", () => {
    assert.equal(registries.ledgerProjectName("shop"), "shop");
    assert.equal(registries.ledgerProjectName(undefined), "cairntrace");
    assert.equal(registries.ledgerProjectName("My Shop"), null);
    assert.equal(registries.ledgerProjectName("../etc"), null);
    assert.equal(registries.ledgerProjectName("a..b"), null);
    assert.equal(registries.ledgerProjectName(""), null);
  });
});

describe("project config: registries from the unsubstituted text", () => {
  it("names env references, never their values, and keeps raw out of the renderer copy", () => {
    const dir = tempDir("cairn-wave4-config-");
    const configPath = write(
      dir,
      "cairntrace.config.yml",
      [
        "project: shop",
        "artifactRoot: ${config.dir}/runs",
        "datasources:",
        "  app_db:",
        "    kind: mongo",
        "    uri: ${env.CAIRN_TEST_MONGO_URI}",
        "    database: shop",
        "environments:",
        "  local:",
        "    baseUrl: http://localhost:8787",
        "",
      ].join("\n"),
    );
    const previous = process.env.CAIRN_TEST_MONGO_URI;
    process.env.CAIRN_TEST_MONGO_URI = `mongodb://app:${SECRET}@db.local/shop`;
    try {
      const config = specs.readProjectConfig(configPath);
      assert.equal(config.artifactRoot, `${dir}/runs`);
      assert.equal(
        config.registries.datasources.topLevel[0].target,
        "${env.CAIRN_TEST_MONGO_URI}",
      );
      assert.ok(JSON.stringify(config.raw).includes(SECRET), "main keeps raw");
      const shown = specs.publicConfig(config);
      assert.equal("raw" in shown, false);
      assert.ok(!JSON.stringify(shown).includes(SECRET));
    } finally {
      if (previous === undefined) delete process.env.CAIRN_TEST_MONGO_URI;
      else process.env.CAIRN_TEST_MONGO_URI = previous;
    }
  });
});

describe("spec summaries: poll, teardown, fixtures, wait", () => {
  it("reads the wave-4 blocks and keeps poll out of the verifier list", () => {
    const summary = specs.summarizeSpecText(
      [
        "name: order_sync",
        "intent: an order reaches the database",
        "fixtures: [demo_order, kit.reset, {use: account, with: {plan: pro}}]",
        "preconditions:",
        "  wait: [api-health, 'http://localhost:9000/ready?token=abc']",
        "steps:",
        "  - run: {shell: ./seed.sh, assign: seeded}",
        "  - expect: {by: role, role: status, text: Saved}",
        "  - capture: {assign: rows, table: {by: role, role: table}}",
        "outcomes:",
        "  - id: order_in_db",
        "    description: the order is stored",
        "    verify:",
        "      mongo: {source: app_db, collection: orders, expect: {exists: true}}",
        "      poll: {timeoutMs: 30000, everyMs: 1000}",
        "teardown:",
        "  failRun: true",
        "  steps:",
        "    - id: clear_order",
        "      run: {shell: ./clear.sh}",
        "    - click: {by: text, text: Close}",
        "",
      ].join("\n"),
    );
    assert.deepEqual(summary.outcomes[0].verifiers, ["mongo"]);
    assert.equal(summary.outcomes[0].polled, true);
    assert.deepEqual(
      summary.steps.map((step) => step.kind),
      ["run", "expect", "capture"],
    );
    assert.deepEqual(summary.teardown, [
      { id: "clear_order", kind: "run" },
      { id: "teardown_2", kind: "click" },
    ]);
    assert.equal(summary.teardownFailsRun, true);
    assert.deepEqual(summary.fixtures, ["demo_order", "kit.reset", "account"]);
    assert.deepEqual(summary.wait, [
      "api-health",
      "http://localhost:9000/ready?…",
    ]);
  });
});

describe("redaction gaps (fix pass)", () => {
  it("masks credential flags passed as a separate word, never a port", () => {
    const cases = /** @type {Array<[string, string]>} */ ([
      [
        `mongosh -u root -p ${SECRET} --quiet`,
        "mongosh -u root -p •••••• --quiet",
      ],
      [
        `docker exec demo-mongo mongosh --username root --password ${SECRET} --eval x`,
        "docker exec demo-mongo mongosh --username root --password •••••• --eval x",
      ],
      [`mysql -uroot -p${SECRET} shop`, "mysql -uroot -p•••••• shop"],
      [`sshpass -p ${SECRET} ssh demo-host`, "sshpass -p •••••• ssh demo-host"],
      [`redis-cli -a ${SECRET} ping`, "redis-cli -a •••••• ping"],
      [`tool --api-key "${SECRET} x" run`, 'tool --api-key "••••••" run'],
      [`curl --user ops:${SECRET} http://x`, "curl --user •••••• http://x"],
      // a reference stays readable; its default does not
      [
        "mongosh -u root -p ${secrets.MONGO_PW} --quiet",
        "mongosh -u root -p ${secrets.MONGO_PW} --quiet",
      ],
      [
        `mongosh -u root -p \${env.DB_ARG:-${SECRET}}`,
        "mongosh -u root -p ${env.DB_ARG:-••••••}",
      ],
      // -p as a port or a project stays
      [
        "docker run -p 8080:80 -u 1000 img",
        "docker run -p 8080:80 -u 1000 img",
      ],
      ["psql -U app -p 5432 -h localhost", "psql -U app -p 5432 -h localhost"],
      ["docker compose -p demo up -d", "docker compose -p demo up -d"],
      ["mkdir -p /tmp/x", "mkdir -p /tmp/x"],
    ]);
    for (const [input, expected] of cases)
      assert.equal(registries.scrubText(input), expected, input);
  });

  it("masks credential headers, quoted or not, and JSON credential keys", () => {
    assert.equal(
      registries.scrubText(
        `curl -H 'Cookie: session=${SECRET}; theme=dark' -H "X-Api-Key: ${SECRET}" http://x`,
      ),
      "curl -H 'Cookie: ••••••' -H \"X-Api-Key: ••••••\" http://x",
    );
    assert.equal(
      registries.scrubText(
        `curl -H "Authorization: Bearer ${SECRET}" http://x`,
      ),
      'curl -H "Authorization: ••••••" http://x',
    );
    assert.equal(
      registries.scrubText(
        'curl -H "Authorization: Bearer ${secrets.API_TOKEN}" http://x',
      ),
      'curl -H "Authorization: Bearer ${secrets.API_TOKEN}" http://x',
    );
    assert.equal(
      registries.scrubText(`fetch Cookie:${SECRET}`),
      "fetch Cookie:••••••",
    );
    assert.equal(
      registries.scrubText(`curl -d '{"password": "${SECRET}", "name": "x"}'`),
      `curl -d '{"password": "••••••", "name": "x"}'`,
    );
  });

  it("redacts a reference's literal default", () => {
    assert.equal(
      registries.redactTarget(
        `\${env.MONGO_URI:-mongodb://root:${SECRET}@localhost:27017/app}`,
      ),
      "${env.MONGO_URI:-mongodb://***@localhost:27017/app}",
    );
    assert.equal(
      registries.redactTarget(`\${secrets.MONGO_URI:-${SECRET}}`),
      "${secrets.MONGO_URI:-••••••}",
    );
    assert.equal(
      registries.redactTarget(`\${env.MONGO_PASSWORD:-${SECRET}}`),
      "${env.MONGO_PASSWORD:-••••••}",
    );
    assert.equal(
      registries.redactTarget("${env.DB_NAME:-shop}"),
      "${env.DB_NAME:-shop}",
    );
    assert.equal(
      registries.redactTarget("${env.MONGO_URI}"),
      "${env.MONGO_URI}",
    );
    assert.equal(
      registries.authKind({ basic: `\${env.TEMPORAL_BASIC:-ops:${SECRET}}` }),
      "basic · ${env.TEMPORAL_BASIC:-••••••}",
    );
    const summary = registries.summarizeRegistries({
      datasources: {
        app_db: {
          kind: "mongo",
          uri: `\${env.APP_MONGO_URI:-mongodb://root:${SECRET}@localhost:27017/app}`,
        },
      },
      environments: {
        local: {
          datasources: {
            app_db: {
              uri: `\${env.LOCAL_MONGO_URI:-mongodb://root:${SECRET}@localhost/app}`,
            },
          },
        },
      },
      gates: {
        db: { command: `mongosh -u root -p ${SECRET} --quiet --eval 1` },
        db2: {
          command: {
            run: `docker exec demo-mongo mongosh --username root --password ${SECRET}`,
          },
        },
        port: { tcp: `\${env.DB_ADDR:-root:${SECRET}@localhost:27017}` },
        api: {
          http: `\${env.API_HEALTH:-http://ops:${SECRET}@localhost/health}`,
        },
      },
    });
    assert.ok(!JSON.stringify(summary).includes(SECRET));
    assert.equal(
      summary.datasources.environments[0].datasources[0].target,
      "${env.LOCAL_MONGO_URI:-mongodb://***@localhost/app}",
    );
    const gates = Object.fromEntries(
      summary.gates.map((gate) => [gate.name, gate.target]),
    );
    assert.equal(gates.db, "mongosh -u root -p •••••• --quiet --eval 1");
    assert.equal(
      gates.db2,
      "docker exec demo-mongo mongosh --username root --password ••••••",
    );
  });

  it("masks secret keys at any depth of a cell or an output, and leaves metadata keys", () => {
    assert.equal(
      events.maskValue("user", { name: "a", password: SECRET, apiToken: "t" }),
      '{"name":"a","password":"••••••","apiToken":"••••••"}',
    );
    assert.deepEqual(events.safeOutputs({ conn: { password: SECRET } }), [
      ["conn", '{"password":"••••••"}'],
    ]);
    const evidence = dataEvidence.normalizeRawEvidence({
      kind: "mongo",
      observed: { count: 1, docs: [{ _id: "u1", user: { password: SECRET } }] },
    });
    assert.ok(!JSON.stringify(evidence).includes(SECRET));
    for (const key of [
      "tokenCount",
      "signatureStatus",
      "cookieConsent",
      "token_type",
      "accessTokenExpiresAt",
    ])
      assert.equal(events.isSecretKey(key), false, key);
    for (const key of [
      "apiToken",
      "csrf_token",
      "password",
      "x-api-key",
      "Set-Cookie",
      "clientSecret",
      "db_password",
    ])
      assert.equal(events.isSecretKey(key), true, key);
  });

  it("masks a capture saved under a credential-looking name", () => {
    const dir = makeRun(tempDir("cairn-captures-"), "r-captures");
    write(
      dir,
      "captures/apiToken.json",
      JSON.stringify({
        assign: "apiToken",
        kind: "text",
        value: `tok_${SECRET}`,
      }),
    );
    write(
      dir,
      "captures/tokenCount.json",
      JSON.stringify({ assign: "tokenCount", kind: "text", value: "3" }),
    );
    const captures = Object.fromEntries(
      dataEvidence.readCaptures(dir).map((entry) => [entry.assign, entry]),
    );
    assert.equal(captures.apiToken.value, "••••••");
    assert.equal(captures.apiToken.masked, true);
    assert.equal(captures.apiToken.table, null);
    assert.equal(captures.tokenCount.value, '"3"');
    assert.equal(captures.tokenCount.masked, false);
  });

  it("tells Studio's display cap from the runner's bound, and survives huge grids", () => {
    const grid = dataEvidence.tableFromValue({
      headers: ["a", "b"],
      rows: Array.from({ length: 100 }, (_, index) => [String(index), "x"]),
    });
    assert.equal(grid?.shown, 50);
    assert.equal(grid?.total, 100);
    assert.equal(grid?.cutBy, "studio");
    const runner = dataEvidence.normalizeRawEvidence({
      kind: "mongo",
      observed: {
        count: 57,
        docs: Array.from({ length: 20 }, (_, index) => ({ _id: `o${index}` })),
        truncated: true,
      },
    });
    assert.equal(runner?.table?.cutBy, "runner");
    assert.equal(runner?.table?.total, 57);
    const whole = dataEvidence.tableFromValue({
      headers: ["a"],
      rows: [["1"], ["2"]],
    });
    assert.equal(whole?.cutBy, null);
    assert.equal(whole?.truncated, false);
    const huge = dataEvidence.tableFromValue({
      headers: ["a"],
      rows: Array.from({ length: 130_000 }, () => []),
    });
    assert.equal(huge?.shown, 50);
    assert.equal(huge?.total, 130_000);
  });

  it("folds reset-only, released and run-scoped fixtures like cairn fixtures status", () => {
    const states = dataEvidence.foldLedgerRecords([
      record({
        ts: "2026-10-01T09:00:00.000Z",
        env: "local",
        name: "resetOnly",
        verb: "reset",
        status: "ok",
      }),
      record({
        ts: "2026-10-01T09:00:01.000Z",
        env: "local",
        name: "ens",
        verb: "ensure",
        status: "ok",
      }),
      record({
        ts: "2026-10-01T09:00:02.000Z",
        env: "local",
        name: "adopted",
        verb: "ensure",
        status: "ok",
      }),
      record({
        ts: "2026-10-01T09:00:03.000Z",
        env: "local",
        name: "adopted",
        verb: "teardown",
        status: "skipped",
        released: true,
      }),
      record({
        ts: "2026-10-01T09:00:04.000Z",
        env: "local",
        name: "skippedOnly",
        verb: "teardown",
        status: "skipped",
      }),
      record({
        ts: "2026-10-01T09:00:05.000Z",
        env: "local",
        name: "perRun",
        scope: "run",
        instance: "run-a",
        verb: "ensure",
        status: "ok",
      }),
      record({
        ts: "2026-10-01T09:00:06.000Z",
        env: "local",
        name: "perRun",
        scope: "run",
        instance: "run-b",
        verb: "ensure",
        status: "ok",
      }),
      record({
        ts: "2026-10-01T09:00:07.000Z",
        env: "local",
        name: "perRun",
        scope: "run",
        instance: "run-a",
        verb: "teardown",
        status: "ok",
      }),
      record({
        ts: "2026-10-01T09:00:08.000Z",
        env: "local",
        name: "failedReset",
        verb: "reset",
        status: "failed",
      }),
    ]);
    const shown = states.map((state) => [
      state.name,
      state.instance,
      state.state,
      state.fromReset,
    ]);
    assert.deepEqual(shown, [
      ["adopted", null, "released", false],
      ["ens", null, "live", false],
      ["perRun", "run-a", "torn-down", false],
      ["perRun", "run-b", "live", false],
      ["resetOnly", null, "live", true],
    ]);
    assert.equal(
      states.find((state) => state.name === "resetOnly")?.ensuredAt,
      "2026-10-01T09:00:00.000Z",
    );
  });
});
