/**
 * Wave 5 in lib/: the event reducer and step trees over F14 control flow
 * (repeat iterations, if branches, a retried use whose first attempt
 * failed), F15 widget fields and interaction paths, F18 requests (polls,
 * matrix) and environment auth, the F17 xlsx evidence, and the config
 * registries Catalog shows (widget drivers, app handles, auth blocks).
 *
 * `fixtures/events-control-flow.ndjson` is a strict events.v1 stream; the
 * run directories plant credentials that must never come out of lib/.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const events = require("../lib/events");
const dataEvidence = require("../lib/dataEvidence");
const registries = require("../lib/registries");
const runs = require("../lib/runs");
const { cleanup, tempDir } = require("./helpers");
const {
  SECRET,
  RUN_A,
  RUN_B,
  makeRunA,
  makeRunB,
  configDoc,
} = require("./primitives-fixture");

after(() => cleanup());

/** @returns {Array<Record<string, any>>} */
function fixtureEvents() {
  return fs
    .readFileSync(
      path.join(__dirname, "fixtures", "events-control-flow.ndjson"),
      "utf8",
    )
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

/**
 * A tree as text lines (`key status` and `[label] status`), for asserting
 * its shape in one go.
 * @param {any[]} nodes
 * @param {(item: any) => string} name
 * @param {number} [depth]
 * @returns {string[]}
 */
function treeLines(nodes, name, depth = 0) {
  return nodes.flatMap((node) => [
    `${"  ".repeat(depth)}${name(node.item)} ${node.item.status}`,
    ...node.groups.flatMap((/** @type {any} */ group) => [
      `${"  ".repeat(depth + 1)}[${group.label}] ${group.status}`,
      ...treeLines(group.nodes, name, depth + 2),
    ]),
  ]);
}

describe("events: F14 nested executions", () => {
  it("keeps one row per execution, hung under its block's open row", () => {
    const model = events.reduceEvents(fixtureEvents());
    // the total is the top-level one, never a block's list length
    assert.equal(model.stepTotal, 9);
    const keys = model.steps.map((/** @type {any} */ row) => row.key);
    assert.deepEqual(keys, [
      "sign_in",
      "profile_form",
      "save_draft",
      "start_task",
      "maybe_confirm",
      "maybe_confirm.then.1",
      "each_row",
      "pick_row",
      "pick_row#2",
      "submit_retry",
      "submit_retry.1",
      "submit_retry.1#2",
      "wait_task",
      "denied",
    ]);
    const row = (/** @type {string} */ key) =>
      model.steps.find((/** @type {any} */ entry) => entry.key === key);
    assert.equal(row("pick_row").parentKey, "each_row");
    assert.equal(row("pick_row").iteration, 1);
    assert.equal(row("pick_row#2").iteration, 2);
    assert.equal(row("pick_row#2").depth, 1);
    // artifacts land on the execution that wrote them
    assert.deepEqual(row("pick_row").artifacts, [
      "widgets/006_pick_row_i1.json",
    ]);
    assert.deepEqual(row("pick_row#2").artifacts, [
      "widgets/006_pick_row_i2.json",
    ]);
    // stepIndex names the newest execution
    assert.equal(model.steps[model.stepIndex.pick_row].key, "pick_row#2");
    assert.equal(row("maybe_confirm.then.1").branch, "then");
    assert.equal(row("maybe_confirm").taken, "then");
    assert.equal(row("each_row").iterations, 2);
    // the retried attempt is superseded, not a failure of the run
    assert.equal(row("submit_retry.1").status, "failed");
    assert.equal(row("submit_retry.1").superseded, true);
    assert.equal(row("submit_retry.1#2").superseded, false);
    assert.equal(row("submit_retry.1#2").status, "passed");
  });

  it("records F15 paths and F18 requests on their rows", () => {
    const model = events.reduceEvents(fixtureEvents());
    const row = (/** @type {string} */ key) =>
      model.steps.find((/** @type {any} */ entry) => entry.key === key);
    assert.equal(row("save_draft").via, "dispatch");
    assert.equal(
      row("save_draft").detail,
      "pointer blocked by div.p-dialog-mask",
    );
    assert.equal(row("start_task").status, "skipped");
    assert.equal(row("start_task").skipReason, "absent");
    assert.deepEqual(
      row("profile_form").widgets.map(
        (/** @type {any} */ field) => `${field.field}:${field.status}`,
      ),
      ["country:committed", "start_date:committed", "certify:already"],
    );
    assert.equal(row("profile_form").widgets[1].via, "picker");
    assert.deepEqual(
      row("sign_in").requests.map(
        (/** @type {any} */ request) => `${request.assign}→${request.status}`,
      ),
      ["login_check→401", "login→200", "login_after_1→200"],
    );
    assert.equal(row("wait_task").requests[0].attempts, 3);
    assert.equal(row("denied").requests[0].combinations, 4);
    assert.equal(row("denied").requests[0].mismatches, 1);
    assert.match(
      row("sign_in").detail,
      /^logged in \(POST \/api\/login → 200\)/,
    );
  });

  it("returns the current step to its block, and names where it runs", () => {
    const list = fixtureEvents();
    const model = events.createRunModel();
    const at = list.findIndex(
      (event) => event.type === "step.started" && event.iteration === 2,
    );
    for (const event of list.slice(0, at + 1)) events.applyEvent(model, event);
    assert.equal(model.currentStepId, "pick_row");
    const phase = events.currentPhase(model, Date.parse(list[at].ts) + 1000);
    assert.match(phase?.text ?? "", /pick_row|set field/);
    assert.match(phase?.text ?? "", /in each_row #2/);
    // the nested step finishes: the repeat is open again
    events.applyEvent(model, list[at + 2]);
    assert.equal(model.currentStepId, "each_row");
  });

  it("builds the live tree with iteration, branch and attempt groups", () => {
    const tree = events.modelStepTree(events.reduceEvents(fixtureEvents()));
    assert.deepEqual(
      treeLines(tree, (item) => item.key),
      [
        "sign_in passed",
        "profile_form passed",
        "save_draft passed",
        "start_task skipped",
        "maybe_confirm passed",
        "  [then] passed",
        "    maybe_confirm.then.1 passed",
        "each_row passed",
        "  [iteration 1] passed",
        "    pick_row passed",
        "  [iteration 2] passed",
        "    pick_row#2 passed",
        "submit_retry passed",
        "  [attempt 1] retried",
        "    submit_retry.1 failed",
        "  [attempt 2] passed",
        "    submit_retry.1#2 passed",
        "wait_task passed",
        "denied failed",
      ],
    );
  });

  it("builds the run.json tree from post-order results, retries included", () => {
    const dir = makeRunA(tempDir("cairn-prims-"));
    const run = JSON.parse(fs.readFileSync(path.join(dir, "run.json"), "utf8"));
    const kinds = { submit_retry: "use", each_row: "repeat" };
    const tree = events.resultStepTree(
      run.steps,
      (id) => /** @type {any} */ (kinds)[id] ?? null,
    );
    assert.deepEqual(
      treeLines(tree, (item) => item.id),
      [
        "sign_in passed",
        "profile_form passed",
        "save_draft passed",
        "start_task skipped",
        "maybe_confirm passed",
        "  [then] passed",
        "    maybe_confirm.then.1 passed",
        "each_row passed",
        "  [iteration 1] passed",
        "    pick_row passed",
        "  [iteration 2] passed",
        "    pick_row passed",
        "submit_retry passed",
        "  [attempt 1] retried",
        "  [attempt 2] passed",
        "    submit_retry.1 passed",
        "wait_task passed",
        "denied failed",
      ],
    );
    const retried = tree.find((node) => node.item.id === "submit_retry")
      ?.groups[0];
    assert.match(String(retried?.error), /no match/);
  });

  it("nests a repeat in a repeat, and keeps orphans of an unrecorded block", () => {
    const steps = [
      {
        id: "cell",
        status: "passed",
        durationMs: 1,
        parentId: "inner",
        iteration: 1,
      },
      {
        id: "inner",
        status: "passed",
        durationMs: 2,
        parentId: "outer",
        iteration: 1,
        iterations: 1,
      },
      {
        id: "cell",
        status: "passed",
        durationMs: 1,
        parentId: "inner",
        iteration: 1,
      },
      {
        id: "cell",
        status: "failed",
        durationMs: 1,
        parentId: "inner",
        iteration: 2,
      },
      {
        id: "inner",
        status: "failed",
        durationMs: 2,
        parentId: "outer",
        iteration: 2,
        iterations: 2,
      },
      { id: "outer", status: "failed", durationMs: 5, iterations: 2 },
      // an interrupted block that never recorded its own result
      {
        id: "lost",
        status: "passed",
        durationMs: 1,
        parentId: "gone",
        iteration: 1,
      },
    ];
    assert.deepEqual(
      treeLines(events.resultStepTree(steps), (item) => item.id),
      [
        "outer failed",
        "  [iteration 1] passed",
        "    inner passed",
        "      [iteration 1] passed",
        "        cell passed",
        "  [iteration 2] failed",
        "    inner failed",
        "      [iteration 1] passed",
        "        cell passed",
        "      [iteration 2] failed",
        "        cell failed",
        "lost passed",
      ],
    );
    // a flat spec's tree is its list
    assert.deepEqual(
      treeLines(
        events.resultStepTree([
          { id: "a", status: "passed" },
          { id: "b", status: "failed" },
        ]),
        (item) => item.id,
      ),
      ["a passed", "b failed"],
    );
  });

  it("describes nested steps, blocks and interaction paths in one line each", () => {
    const labels = fixtureEvents()
      .filter((event) => event.type.startsWith("step."))
      .map((event) => events.describeEvent(event).label);
    assert.ok(labels.includes("step maybe_confirm passed · 60ms · → then"));
    assert.ok(
      labels.includes(
        '[1/1] step pick_row started · set field "row_owner" (in each_row #2)',
      ),
    );
    assert.ok(labels.includes("step each_row passed · 30ms · ×2"));
    assert.ok(labels.includes("step start_task skipped (absent)"));
    assert.ok(labels.includes("step save_draft passed · 8ms · via dispatch"));
    assert.ok(
      labels.includes(
        "step submit_retry.1 failed · 5.00s (in submit_retry #1)",
      ),
      labels.join("\n"),
    );
    // flat events read exactly as before
    assert.equal(
      events.describeEvent({
        type: "step.finished",
        stepId: "a",
        durationMs: 5,
      }).label,
      "step a passed · 5ms",
    );
    assert.equal(
      events.describeEvent({
        type: "step.finished",
        stepId: "w",
        durationMs: 5,
        matched: false,
      }).tone,
      "muted",
    );
  });

  it("caps execution rows and folds the rest into the newest one", () => {
    const model = events.createRunModel();
    events.applyEvent(model, {
      type: "step.started",
      stepId: "loop",
      kind: "repeat",
    });
    for (let iteration = 1; iteration <= 5100; iteration += 1) {
      events.applyEvent(model, {
        type: "step.started",
        stepId: "body",
        parentId: "loop",
        iteration,
      });
      events.applyEvent(model, {
        type: "step.finished",
        stepId: "body",
        durationMs: 1,
        parentId: "loop",
        iteration,
      });
    }
    assert.equal(model.steps.length, 5000);
    assert.equal(model.stepsDropped, 101);
  });
});

describe("dataEvidence: F15 widgets, F18 requests, F17 xlsx", () => {
  it("reads widget fields with values masked by name, and the unanswered dump", () => {
    const root = tempDir("cairn-prims-");
    const a = makeRunA(root);
    const widgets = dataEvidence.readWidgets(a);
    assert.deepEqual(
      widgets.map((entry) => entry.path),
      [
        "widgets/002_profile_form.json",
        "widgets/006_pick_row_i1.json",
        "widgets/006_pick_row_i2.json",
      ],
    );
    const form = widgets[0];
    assert.equal(form.kind, "form");
    assert.equal(form.fieldsTotal, 4);
    const field = (/** @type {string} */ name) =>
      form.fields.find((entry) => entry.field === name);
    assert.equal(field("start_date")?.expected, "2027-03-15");
    assert.equal(field("start_date")?.actual, "03/15/2027");
    assert.equal(field("start_date")?.via, "picker");
    assert.equal(field("country")?.final?.matches, true);
    const password = field("account_password");
    assert.equal(password?.masked, true);
    assert.equal(password?.expected, "••••••");
    assert.equal(password?.actual, "••••••");
    assert.equal(password?.final?.actual, "••••••");
    assert.equal(password?.rootText, null);
    assert.ok(!JSON.stringify(widgets).includes(SECRET));

    const b = makeRunB(root);
    const failed = dataEvidence
      .readWidgets(b)
      .find((entry) => entry.path === "widgets/001_profile_form_i2.json");
    assert.equal(failed?.status, "failed");
    assert.match(String(failed?.fields[0].error), /read back/);
    assert.equal(failed?.unanswered?.total, 6);
    assert.deepEqual(
      failed?.unanswered?.fields.map((entry) => entry.key),
      ["country", "tax_id"],
    );
    assert.equal(failed?.unanswered?.fields[0].required, true);
  });

  it("reads request envelopes without bodies, headers or credentials", () => {
    const dir = makeRunA(tempDir("cairn-prims-"));
    const requests = dataEvidence.readRequests(dir);
    const byAssign = Object.fromEntries(
      requests.map((entry) => [entry.assign, entry]),
    );
    assert.equal(byAssign.tasks.attempts, 3);
    assert.equal(byAssign.tasks.url, "http://127.0.0.1:4567/api/tasks?…");
    assert.deepEqual(byAssign.tasks.captures, [
      ["taskId", "t-42"],
      ["csrfToken", "••••••"],
    ]);
    assert.equal(byAssign.denied.matrix.total, 4);
    assert.equal(byAssign.denied.matrix.mismatched, 1);
    assert.deepEqual(
      byAssign.denied.matrix.rows.map(
        (/** @type {any} */ row) =>
          `${row.method} ${row.status} ${row.matched}`,
      ),
      ["GET 401 true", "GET 403 true", "POST 401 true", "POST 200 false"],
    );
    assert.match(byAssign.denied.matrix.rows[1].values, /auth=••••••/);
    assert.equal(byAssign.login.status, 200);
    assert.ok(!("body" in byAssign.login));
    assert.ok(!JSON.stringify(requests).includes(SECRET));
  });

  it("normalizes the xlsx sidecar into facts, header columns and checks", () => {
    const dir = makeRunA(tempDir("cairn-prims-"));
    const data = dataEvidence.normalizeRawEvidence(
      dataEvidence.readJsonBounded(
        path.join(dir, "outcomes", "template_columns.raw.json"),
      ),
    );
    assert.equal(data?.kind, "xlsx");
    assert.deepEqual(data?.facts, [
      ["workbook", "template.xlsx"],
      ["sheets", "Import Template, Template Guide"],
      ["checked sheet", "Import Template"],
      ["checks", "6 (1 failed)"],
    ]);
    assert.deepEqual(data?.table?.columns, ["column", "label", "key"]);
    assert.equal(data?.table?.rows.length, 3);
    const checks = data?.checks ?? [];
    assert.deepEqual(
      checks.map((check) => `${check.ok} ${check.label}`),
      [
        "true sheet Template Guide contains Use a unique address",
        "false headers present",
        "true includesInOrder Name, Country, Email",
        "true data rows after row 2: count 0",
        "true cell Import Template!C3",
        "true validation Staff_Email (custom)",
      ],
    );
    assert.equal(checks[1].detail, "missing Phone");
    // a free-form script sidecar still has no table
    assert.equal(dataEvidence.normalizeRawEvidence({ anything: 1 }), null);
  });
});

describe("runs: wave-5 run detail", () => {
  it("carries widgets and requests, and the failing execution of a looped step", () => {
    const root = tempDir("cairn-prims-");
    const a = runs.readRunDetail(makeRunA(root));
    assert.equal(a.widgets.length, 3);
    assert.equal(a.requests.length, 5);
    assert.equal(a.failure?.step?.id, "denied");
    assert.deepEqual(a.failure?.step?.artifacts, ["requests/denied.json"]);
    assert.ok(!JSON.stringify(a).includes(SECRET));

    const b = runs.readRunDetail(makeRunB(root));
    assert.equal(b.failure?.step?.id, "profile_form");
    assert.equal(b.failure?.step?.place, "in each_profile #2");
    assert.deepEqual(b.failure?.step?.artifacts, [
      "widgets/001_profile_form_i2.json",
    ]);
    assert.equal(b.runId, RUN_B);
    assert.equal(a.runId, RUN_A);
  });
});

describe("registries: widget drivers, app handles, environment auth", () => {
  it("lists drivers in detection order, field roots and app handle names", () => {
    const widgets = registries.summarizeWidgets(configDoc());
    assert.equal(widgets.declared, true);
    assert.deepEqual(
      widgets.drivers.map(
        (driver) =>
          `${driver.name}:${driver.source}${driver.appended ? "+" : ""}`,
      ),
      [
        "vue-multiselect:built-in",
        "upper.js:project",
        "radio-group:built-in+",
        "checkbox-group:built-in+",
        "native-select:built-in+",
        "native-input:built-in+",
      ],
    );
    assert.deepEqual(widgets.fieldRoot, ['[data-field-key="{key}"]']);
    assert.deepEqual(widgets.appHandles, ["store"]);
    // nothing declared: every built-in, the default roots
    const defaults = registries.summarizeWidgets({
      browser: { testIdAttribute: "data-qa" },
    });
    assert.equal(defaults.declared, false);
    assert.equal(defaults.drivers.length, 8);
    assert.deepEqual(defaults.fieldRoot, [
      '[data-qa="{key}"]',
      '[name="{key}"]',
    ]);
  });

  it("keeps the built-in driver list in step with the runner's", () => {
    const shared = fs.readFileSync(
      path.join(__dirname, "..", "..", "src", "core", "schema", "shared.ts"),
      "utf8",
    );
    const block = /BUILTIN_WIDGET_DRIVERS = \[([\s\S]*?)\] as const/.exec(
      shared,
    );
    assert.ok(block, "BUILTIN_WIDGET_DRIVERS in shared.ts");
    const names = [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    assert.deepEqual(registries.BUILTIN_WIDGET_DRIVERS, names);
  });

  it("summarizes auth by method, path and secret names, never values", () => {
    const auth = registries.summarizeAuth(configDoc());
    assert.equal(auth.length, 1);
    assert.deepEqual(auth[0], {
      env: "local",
      login: { method: "POST", path: "/api/login" },
      alreadyAuthenticated: { method: "POST", path: "/api/check" },
      after: [
        {
          id: "otp",
          method: "PUT",
          path: "/api/otp/${secrets.E2E_OTP}",
          when: "requests.login.body.user.mfa",
        },
      ],
      hydrate: "file hydrate.js",
      secrets: ["E2E_EMAIL", "E2E_OTP", "E2E_PASSWORD"],
    });
    const all = registries.summarizeRegistries(configDoc());
    assert.ok(!JSON.stringify(all).includes(SECRET));
    assert.equal(all.auth.length, 1);
    assert.equal(all.widgets.declared, true);
    // no config: empty registries, never a throw
    const empty = registries.summarizeRegistries(null);
    assert.deepEqual(empty.auth, []);
    assert.equal(empty.widgets.declared, false);
  });
});
