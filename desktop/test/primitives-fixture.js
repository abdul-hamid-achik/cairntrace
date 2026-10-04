/**
 * Run directories for the wave-5 primitives (F14 control flow, F15 widgets
 * and interaction flags, F17 xlsx v2, F18 request v2 and environment auth),
 * shared by primitives.test.js (lib/) and primitives.dom.test.js (views).
 *
 * Run A replays `fixtures/events-control-flow.ndjson` (a strict events.v1
 * stream) with the run.json the runner writes for it: nested results in
 * post-order, the retried attempt dropped into `retries`. Run B is a form in
 * a repeat whose second iteration failed with the unanswered-fields dump.
 *
 * Every file plants a credential the runner would have redacted (a raw
 * token in a login body, a capture under a credential name, a matrix
 * value, a password field's value): Studio is the second lock, and the
 * tests check that none of them reaches a structured view. The value is
 * built at runtime so no secret-shaped literal lives in the repository.
 */
const fs = require("node:fs");
const path = require("node:path");

const { makeRun, write } = require("./helpers");

/** A planted credential, built at runtime. */
const SECRET = ["planted", "cred", String(process.pid), "x9"].join("-");

const RUN_A = "2026-10-02T12-00-00-000Z_profile_wizard_c0ffee";
const RUN_B = "2026-10-02T13-00-00-000Z_profile_wizard_d00d1e";

/**
 * A matrix route value.
 * @param {string} method
 * @param {string} p
 */
function route(method, p) {
  return { method, path: p };
}

/**
 * Run A: every primitive in one failed run (the request matrix mismatched).
 * @param {string} runsRoot
 * @returns {string} the run directory
 */
function makeRunA(runsRoot) {
  const dir = makeRun(runsRoot, RUN_A, {
    specName: "profile_wizard",
    run: {
      status: "failed",
      summary: "step denied failed",
      failure: {
        phase: "steps",
        step: "denied",
        message:
          "request matrix: 1/4 combination(s) did not match expectStatus [401, 403]",
      },
      outcomes: [
        {
          id: "template_columns",
          status: "failed",
          evidence: "outcomes/template_columns.md",
          evidenceRaw: "outcomes/template_columns.raw.json",
        },
      ],
      steps: [
        {
          id: "sign_in",
          status: "passed",
          durationMs: 420,
          artifacts: [
            "requests/login_check.json",
            "requests/login.json",
            "requests/login_after_1.json",
          ],
          detail: "logged in (POST /api/login → 200); 1 follow-up(s); hydrated",
        },
        {
          id: "profile_form",
          status: "passed",
          durationMs: 90,
          artifacts: ["widgets/002_profile_form.json"],
        },
        {
          id: "save_draft",
          status: "passed",
          durationMs: 8,
          via: "dispatch",
          detail: "pointer blocked by div.p-dialog-mask",
        },
        {
          id: "start_task",
          status: "skipped",
          durationMs: 6,
          skipReason: "absent",
        },
        {
          id: "maybe_confirm.then.1",
          status: "passed",
          durationMs: 40,
          parentId: "maybe_confirm",
          branch: "then",
        },
        {
          id: "maybe_confirm",
          status: "passed",
          durationMs: 60,
          taken: "then",
        },
        {
          id: "pick_row",
          status: "passed",
          durationMs: 9,
          artifacts: ["widgets/006_pick_row_i1.json"],
          parentId: "each_row",
          iteration: 1,
          driver: "native-select",
        },
        {
          id: "pick_row",
          status: "passed",
          durationMs: 9,
          artifacts: ["widgets/006_pick_row_i2.json"],
          parentId: "each_row",
          iteration: 2,
          driver: "native-select",
        },
        { id: "each_row", status: "passed", durationMs: 30, iterations: 2 },
        {
          id: "submit_retry.1",
          status: "passed",
          durationMs: 70,
          parentId: "submit_retry",
          iteration: 2,
        },
        {
          id: "submit_retry",
          status: "passed",
          durationMs: 5200,
          iterations: 2,
          retries: [
            {
              attempt: 1,
              error:
                "step 'submit_retry.1' failed: click role=button \"Submit\": no match",
            },
          ],
        },
        {
          id: "wait_task",
          status: "passed",
          durationMs: 2100,
          artifacts: ["requests/tasks.json"],
        },
        {
          id: "denied",
          status: "failed",
          durationMs: 300,
          error:
            "request matrix: 1/4 combination(s) did not match expectStatus [401, 403]: route=… auth=[redacted] → 200",
          artifacts: ["requests/denied.json"],
        },
      ],
    },
  });
  fs.copyFileSync(
    path.join(__dirname, "fixtures", "events-control-flow.ndjson"),
    path.join(dir, "events.ndjson"),
  );
  write(
    dir,
    "widgets/002_profile_form.json",
    JSON.stringify({
      version: 1,
      stepId: "profile_form",
      kind: "form",
      status: "passed",
      fields: [
        {
          field: "country",
          status: "committed",
          durationMs: 12,
          driver: "vue-multiselect",
          expected: "Portugal",
          actual: "Portugal",
          root: "div.question",
          rootText: "Country * Portugal",
          final: { status: "present", actual: "Portugal", matches: true },
        },
        {
          field: "start_date",
          status: "committed",
          durationMs: 30,
          driver: "primevue-calendar",
          via: "picker",
          expected: "2027-03-15",
          actual: "03/15/2027",
          final: { status: "present", actual: "03/15/2027", matches: true },
        },
        {
          field: "certify",
          status: "already",
          durationMs: 1,
          driver: "radio-group",
          expected: "Yes",
          actual: "Yes",
          final: { status: "present", actual: "Yes", matches: true },
        },
        // the runner masks this one; Studio masks it again by its name
        {
          field: "account_password",
          status: "committed",
          durationMs: 2,
          driver: "native-input",
          expected: SECRET,
          actual: SECRET,
          rootText: `Password ${SECRET}`,
          final: { status: "present", actual: SECRET, matches: true },
        },
      ],
    }),
  );
  for (const iteration of [1, 2])
    write(
      dir,
      `widgets/006_pick_row_i${iteration}.json`,
      JSON.stringify({
        version: 1,
        stepId: "pick_row",
        kind: "set",
        status: "passed",
        fields: [
          {
            field: "row_owner",
            status: "committed",
            durationMs: 3,
            driver: "native-select",
            expected: `Owner ${iteration}`,
            actual: `Owner ${iteration}`,
          },
        ],
      }),
    );
  const headers = { "content-type": "application/json" };
  write(
    dir,
    "requests/login_check.json",
    JSON.stringify({
      url: "http://127.0.0.1:4567/api/check",
      method: "POST",
      status: 401,
      ok: false,
      headers,
      body: { authenticated: false },
    }),
  );
  write(
    dir,
    "requests/login.json",
    JSON.stringify({
      url: "http://127.0.0.1:4567/api/login",
      method: "POST",
      status: 200,
      ok: true,
      headers: { ...headers, "set-cookie": `session=${SECRET}` },
      body: { token: SECRET, user: { email: "qa@example.test", mfa: "otp" } },
      captures: { bearer: SECRET },
    }),
  );
  write(
    dir,
    "requests/login_after_1.json",
    JSON.stringify({
      // the runner redacts the resolved secret in the path; the query is
      // dropped by Studio whatever it holds
      url: `http://127.0.0.1:4567/api/otp/[redacted]?code=${SECRET}`,
      method: "PUT",
      status: 200,
      ok: true,
      headers,
      body: { ok: true },
    }),
  );
  write(
    dir,
    "requests/tasks.json",
    JSON.stringify({
      url: `http://127.0.0.1:4567/api/tasks?access_token=${SECRET}`,
      method: "GET",
      status: 200,
      ok: true,
      headers,
      body: { tasks: [{ id: "t-42", title: "Report" }] },
      attempts: 3,
      captures: { taskId: "t-42", csrfToken: SECRET },
    }),
  );
  write(
    dir,
    "requests/denied.json",
    JSON.stringify({
      url: "${matrix.route.path}",
      method: "${matrix.route.method}",
      status: 200,
      ok: false,
      headers: {},
      body: null,
      matrix: [
        ["GET", "/api/admin/list", "", 401],
        ["GET", "/api/admin/list", `Bearer ${SECRET}`, 403],
        ["POST", "/api/admin/create", "", 401],
        ["POST", "/api/admin/create", `Bearer ${SECRET}`, 200],
      ].map(([method, p, auth, status]) => ({
        values: { route: route(String(method), String(p)), auth },
        method,
        url: `http://127.0.0.1:4567${p}`,
        status,
        matched: status !== 200,
      })),
    }),
  );
  write(
    dir,
    "outcomes/template_columns.md",
    "# Outcome: template_columns\n**Status:** failed\n",
  );
  write(
    dir,
    "outcomes/template_columns.raw.json",
    JSON.stringify({
      path: path.join(dir, "downloads", "template.xlsx"),
      sheets: ["Import Template", "Template Guide"],
      sheet: "Import Template",
      columns: [
        { index: 0, letter: "A", label: "Name *", key: "Staff_Name" },
        { index: 1, letter: "B", label: "Country", key: "Staff_Country" },
        { index: 2, letter: "C", label: "Email", key: "Staff_Email" },
      ],
      checks: [
        {
          sheet: "Template Guide",
          found: true,
          contains: ["Use a unique address"],
          missingText: [],
        },
        {
          headers: {
            labelRow: 1,
            keyRow: 2,
            columnCount: 3,
            present: { missing: ["Phone"] },
            includesInOrder: {
              list: ["Name", "Country", "Email"],
              missing: [],
              outOfOrder: [],
              positions: ["A", "B", "C"],
            },
          },
        },
        {
          rows: {
            dataRows: 0,
            firstDataRow: 3,
            afterKeyRow: { expected: { count: 0 }, actual: 0 },
          },
        },
        {
          cell: "Import Template!C3",
          value: "",
          numFmt: { id: 49, code: "@" },
          passed: true,
        },
        {
          validation: { column: "Staff_Email", type: "custom" },
          columnIndex: 2,
          found: true,
          matching: [],
          covering: [
            {
              type: "custom",
              sqref: "C3:C1000",
              formula1: 'ISNUMBER(SEARCH("@",C3))',
            },
          ],
        },
      ],
    }),
  );
  return dir;
}

/**
 * Run B: a form inside a repeat; iteration 2 lost a field and the form's
 * `onFailure: dumpUnanswered` listed the empty ones.
 * @param {string} runsRoot
 * @returns {string} the run directory
 */
function makeRunB(runsRoot) {
  const dir = makeRun(runsRoot, RUN_B, {
    specName: "profile_wizard",
    run: {
      status: "failed",
      summary: "step profile_form failed",
      failure: {
        phase: "steps",
        step: "profile_form",
        message: 'form field "country": read back "" after writing',
      },
      steps: [
        {
          id: "profile_form",
          status: "passed",
          durationMs: 80,
          artifacts: ["widgets/001_profile_form_i1.json"],
          parentId: "each_profile",
          iteration: 1,
        },
        {
          id: "profile_form",
          status: "failed",
          durationMs: 4000,
          error: 'form field "country": read back "" after writing',
          artifacts: ["widgets/001_profile_form_i2.json"],
          parentId: "each_profile",
          iteration: 2,
        },
        {
          id: "each_profile",
          status: "failed",
          durationMs: 4100,
          iterations: 2,
          error:
            'repeat iteration 2/3: step \'profile_form\' failed: form field "country": read back "" after writing',
        },
      ],
    },
  });
  const events = [
    { type: "run.started", runId: RUN_B, spec: "profile_wizard" },
    {
      type: "step.started",
      stepId: "each_profile",
      index: 1,
      total: 1,
      kind: "repeat",
      label: "repeat ≤3 (1 steps)",
    },
    ...[1, 2].flatMap((iteration) => [
      {
        type: "step.started",
        stepId: "profile_form",
        index: 1,
        total: 1,
        kind: "form",
        label: "form (2 fields)",
        parentId: "each_profile",
        iteration,
      },
      {
        type: "widget.field",
        stepId: "profile_form",
        field: "country",
        driver: "vue-multiselect",
        status: iteration === 1 ? "committed" : "failed",
        durationMs: 10,
        path: `widgets/001_profile_form_i${iteration}.json`,
        parentId: "each_profile",
        iteration,
      },
      iteration === 1
        ? {
            type: "step.finished",
            stepId: "profile_form",
            durationMs: 80,
            parentId: "each_profile",
            iteration,
          }
        : {
            type: "step.failed",
            stepId: "profile_form",
            durationMs: 4000,
            error: 'form field "country": read back "" after writing',
            parentId: "each_profile",
            iteration,
          },
    ]),
    {
      type: "step.failed",
      stepId: "each_profile",
      durationMs: 4100,
      iterations: 2,
      error: "repeat iteration 2/3: step 'profile_form' failed",
    },
    { type: "run.failed", runId: RUN_B, durationMs: 4200 },
  ];
  let at = Date.parse("2026-10-02T13:00:00.000Z");
  write(
    dir,
    "events.ndjson",
    `${events
      .map((event) => {
        at += 100;
        return JSON.stringify({ ts: new Date(at).toISOString(), ...event });
      })
      .join("\n")}\n`,
  );
  write(
    dir,
    "widgets/001_profile_form_i1.json",
    JSON.stringify({
      version: 1,
      stepId: "profile_form",
      kind: "form",
      status: "passed",
      fields: [
        {
          field: "country",
          status: "committed",
          durationMs: 10,
          driver: "vue-multiselect",
          expected: "Portugal",
          actual: "Portugal",
        },
      ],
    }),
  );
  write(
    dir,
    "widgets/001_profile_form_i2.json",
    JSON.stringify({
      version: 1,
      stepId: "profile_form",
      kind: "form",
      status: "failed",
      error: 'form field "country": read back "" after writing',
      fields: [
        {
          field: "country",
          status: "failed",
          durationMs: 4000,
          driver: "vue-multiselect",
          expected: "Portugal",
          actual: "",
          error: 'read back "" after writing',
          root: "div.question",
          rootText: "Country *",
        },
      ],
      unanswered: {
        total: 6,
        fields: [
          {
            key: "country",
            driver: "vue-multiselect",
            required: true,
            label: "Country *",
          },
          {
            key: "tax_id",
            driver: "native-input",
            required: false,
            label: "Tax id",
          },
        ],
      },
    }),
  );
  return dir;
}

/**
 * A config document (as parsed, unsubstituted) with the F15 widget registry,
 * F20 app handles and an F18 auth block that plants literal credentials in
 * places Studio never shows (a body, a header value).
 */
function configDoc() {
  return {
    project: "profiles",
    browser: {
      testIdAttribute: "data-qa",
      fieldRoot: ['[data-field-key="{key}"]'],
      widgets: [{ use: "vue-multiselect" }, { file: "./drivers/upper.js" }],
      appHandle: { store: "window.appStore" },
    },
    environments: {
      local: {
        baseUrl: "http://localhost:4567",
        auth: {
          alreadyAuthenticated: { method: "POST", url: "/api/check" },
          login: {
            url: "/api/login?next=/home",
            headers: { "x-api-key": SECRET },
            body: {
              email: "${secrets.E2E_EMAIL}",
              password: "${secrets.E2E_PASSWORD}",
              backup: SECRET,
            },
          },
          after: [
            {
              id: "otp",
              when: { var: "requests.login.body.user.mfa", equals: "otp" },
              request: {
                method: "PUT",
                url: "/api/otp/${secrets.E2E_OTP}",
                headers: {
                  authorization: "Bearer ${requests.login.body.token}",
                },
              },
            },
          ],
          hydrate: { file: "./auth/hydrate.js" },
        },
      },
      staging: { baseUrl: "https://staging.example.test" },
    },
  };
}

module.exports = { SECRET, RUN_A, RUN_B, makeRunA, makeRunB, configDoc };
