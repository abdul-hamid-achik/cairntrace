/**
 * Wave 5 in a DOM (happy-dom): Run detail's Steps tab nests repeat
 * iterations, if branches and retried attempts as collapsible groups, and
 * shows F15 widget fields (expected vs committed, driver, the unanswered
 * dump), interaction paths (dispatch fallback, optional skips), F18
 * requests (polls, matrix status per combination) and environment auth by
 * method / path / status only; Outcomes shows the F17 xlsx checks; Live
 * groups nested executions as they stream; Catalog shows the widget
 * registry, environment auth and the built-in login action.
 *
 * The run directories (primitives-fixture.js) plant credentials the runner
 * would have redacted; every test checks they never reach the DOM, text or
 * attributes.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const env = require("./dom-env");
const { cleanup, tempDir, write } = require("./helpers");
const registries = require("../lib/registries");
const runs = require("../lib/runs");
const {
  SECRET,
  RUN_A,
  RUN_B,
  makeRunA,
  makeRunB,
  configDoc,
} = require("./primitives-fixture");

const { Studio, document } = env.installDom();

after(() => {
  env.teardown();
  cleanup();
});

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

/** No planted credential anywhere: text, titles, data attributes. */
function assertNoSecret(/** @type {HTMLElement} */ root) {
  assert.ok(!root.innerHTML.includes(SECRET), "a planted credential leaked");
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

/** @param {Record<string, any>} [config] */
function configuredState(config = {}) {
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
    specs: [],
    config: {
      path: "/tmp/project/cairntrace.config.yml",
      project: "profiles",
      environments: [
        { name: "local", baseUrl: "http://localhost:4567", policy: null },
        {
          name: "staging",
          baseUrl: "https://staging.example.test",
          policy: null,
        },
      ],
      registries: registries.summarizeRegistries(configDoc()),
      ...config,
    },
  };
}

/** @type {string} */
let runsRoot;

before(() => {
  runsRoot = tempDir("cairn-dom-wave5-");
  makeRunA(runsRoot);
  makeRunB(runsRoot);
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

describe("Run detail: F14 groups and F15 / F18 evidence in Steps", () => {
  it("nests iterations, branches and attempts as collapsible groups", async () => {
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: RUN_A, from: "runs" });
    await env.waitFor(() => root.querySelector("#run-tab-steps"), "tabs");
    await openTab(root, "steps");

    // repeat: one group per iteration, each with its own execution
    const repeat = /** @type {HTMLElement} */ (
      root.querySelector('.step-block[data-block="each_row"]')
    );
    assert.ok(repeat, "the repeat block");
    assert.match(text(repeat.querySelector(".step-row")), /×2/);
    const iterations = all(
      repeat,
      ":scope > .step-groups > details.step-group",
    );
    assert.deepEqual(
      iterations.map((group) => group.dataset.group),
      ["iteration 1", "iteration 2"],
    );
    // passed iterations of a multi-group block start collapsed
    assert.ok(iterations.every((group) => !group.hasAttribute("open")));
    for (const [index, group] of iterations.entries()) {
      const row = group.querySelector('.step-row[data-step="pick_row"]');
      assert.ok(row, `pick_row in iteration ${index + 1}`);
      // each iteration shows its own widget file
      assert.ok(
        group.querySelector(
          `.widget-entry[data-widget="widgets/006_pick_row_i${index + 1}.json"]`,
        ),
      );
      assert.match(text(group), new RegExp(`Owner ${index + 1}`));
    }

    // if: the branch that ran, open (the block's only group)
    const branch = /** @type {HTMLElement} */ (
      root.querySelector(
        '.step-block[data-block="maybe_confirm"] details.step-group',
      )
    );
    assert.equal(branch.dataset.group, "then");
    assert.ok(branch.hasAttribute("open"));
    assert.match(
      text(root.querySelector('.step-block[data-block="maybe_confirm"]')),
      /→ then/,
    );

    // a retried use: the dropped attempt as a retried group with its error
    const retry = /** @type {HTMLElement} */ (
      root.querySelector('.step-block[data-block="submit_retry"]')
    );
    const attempts = all(retry, "details.step-group");
    assert.deepEqual(
      attempts.map((group) => group.dataset.group),
      ["attempt 1", "attempt 2"],
    );
    assert.ok(attempts[0].classList.contains("step-group-retried"));
    assert.match(text(attempts[0]), /retried/);
    assert.match(text(attempts[0]), /no match/);
    assert.ok(attempts[1].querySelector('[data-step="submit_retry.1"]'));
    assertNoSecret(root);
  });

  it("shows widget fields, interaction paths, requests and auth without values", async () => {
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: RUN_A, from: "runs" });
    await env.waitFor(() => root.querySelector("#run-tab-steps"), "tabs");
    await openTab(root, "steps");

    // F15 form: expected vs committed per field, driver, after-form value
    const form = /** @type {HTMLElement} */ (
      root.querySelector(
        '.widget-entry[data-widget="widgets/002_profile_form.json"]',
      )
    );
    assert.ok(form, "the form's widget evidence");
    const field = (/** @type {string} */ name) =>
      /** @type {HTMLElement} */ (
        form.querySelector(`tr.widget-field[data-field="${name}"]`)
      );
    assert.match(text(field("start_date")), /2027-03-15/);
    assert.match(text(field("start_date")), /03\/15\/2027/);
    assert.match(text(field("start_date")), /primevue-calendar · picker/);
    assert.match(text(field("certify")), /already/);
    assert.match(text(field("account_password")), /••••••/);
    assert.match(text(form), /after the form/);

    // F15 interaction paths
    const save = /** @type {HTMLElement} */ (
      root.querySelector('.step-row[data-step="save_draft"]')
    );
    assert.match(text(save), /via dispatched click/);
    assert.match(text(save), /pointer blocked by div\.p-dialog-mask/);
    assert.match(
      text(root.querySelector('.step-row[data-step="start_task"]')),
      /skipped · absent/,
    );

    // F18 environment auth: method, path, status — nothing else
    const login = /** @type {HTMLElement} */ (
      root.querySelector('.step-row[data-step="sign_in"] .login-entry')
    );
    assert.ok(login, "the auth summary");
    assert.deepEqual(
      all(login, "tbody tr").map((row) => text(row)),
      [
        "already authenticated?POST /api/check4011",
        "loginPOST /api/login2001",
        "follow-upPUT /api/otp/[redacted]2001",
      ],
    );
    assert.match(text(login), /credentials and issued tokens are never shown/);
    assert.ok(!/captures|bearer/i.test(text(login).replace(/never shown/, "")));
    assert.match(
      text(root.querySelector('.step-row[data-step="sign_in"]')),
      /logged in \(POST \/api\/login → 200\)/,
    );

    // F18 polled request: attempts and masked captures
    const tasks = /** @type {HTMLElement} */ (
      root.querySelector('.request-entry[data-request="tasks"]')
    );
    assert.match(text(tasks), /3 attempts/);
    assert.match(text(tasks), /\$\{requests\.tasks\.captures\.taskId\}/);
    assert.match(text(tasks), /t-42/);
    assert.match(text(tasks), /csrfToken\}••••••/);
    assert.match(text(tasks), /api\/tasks\?…/);

    // F18 matrix: status per combination, the mismatch marked
    const denied = /** @type {HTMLElement} */ (
      root.querySelector('.request-entry[data-request="denied"]')
    );
    assert.ok(denied.classList.contains("request-mismatched"));
    assert.match(text(denied), /4 combinations · 1 mismatched/);
    const rows = all(denied, ".matrix-table tbody tr");
    assert.equal(rows.length, 4);
    assert.deepEqual(
      rows.map((row) => row.className),
      [
        "matrix-matched",
        "matrix-matched",
        "matrix-matched",
        "matrix-mismatched",
      ],
    );
    assert.match(text(rows[3]), /POST \/api\/admin\/create/);
    assert.match(text(rows[3]), /200/);
    assert.match(text(rows[1]), /auth=••••••/);
    assertNoSecret(root);
  });

  it("opens on the failing request matrix, and shows xlsx checks in Outcomes", async () => {
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: RUN_A, from: "runs" });
    await env.waitFor(() => root.querySelector("#run-tab-failure"), "tabs");
    // the view keeps the tab an earlier test opened: ask for Failure
    await openTab(root, "failure");
    const panel = /** @type {HTMLElement} */ (
      root.querySelector("#tab-host .failure-panel")
    );
    assert.match(text(panel), /denied/);
    assert.ok(panel.querySelector('.request-entry[data-request="denied"]'));
    assert.ok(panel.querySelector(".matrix-table tr.matrix-mismatched"));

    await openTab(root, "outcomes");
    const evidence = /** @type {HTMLElement} */ (
      root.querySelector('.data-evidence[data-kind="xlsx"]')
    );
    assert.ok(evidence, "xlsx evidence");
    assert.match(text(evidence), /template\.xlsx/);
    assert.match(text(evidence), /6 \(1 failed\)/);
    const checks = all(evidence, ".evidence-check");
    assert.equal(checks.length, 6);
    const failed = all(evidence, ".evidence-check-failed");
    assert.equal(failed.length, 1);
    assert.match(text(failed[0]), /headers present · missing Phone/);
    // the header columns as a table
    assert.match(text(evidence.querySelector(".data-table")), /Staff_Email/);
    assertNoSecret(root);
  });

  it("names the failing iteration, its widget fields and the unanswered dump", async () => {
    configuredState();
    runBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: RUN_B, from: "runs" });
    await env.waitFor(
      () => root.querySelector("#tab-host .failure-panel"),
      "failure panel",
    );
    const panel = /** @type {HTMLElement} */ (
      root.querySelector("#tab-host .failure-panel")
    );
    assert.match(text(panel), /in each_profile #2/);
    const widget = /** @type {HTMLElement} */ (
      panel.querySelector(
        '.widget-entry[data-widget="widgets/001_profile_form_i2.json"]',
      )
    );
    assert.ok(widget, "the failed iteration's widget evidence");
    assert.ok(widget.classList.contains("widget-failed"));
    assert.match(text(widget), /field country: read back "" after writing/);
    assert.match(text(widget), /Unanswered fields · 2 of 6 on the page/);
    assert.deepEqual(
      all(widget, ".widget-unanswered-table tbody tr").map(
        (row) => row.dataset.unanswered,
      ),
      ["country", "tax_id"],
    );
    // and the iteration that passed is not what the panel shows
    assert.ok(
      !panel.querySelector('[data-widget="widgets/001_profile_form_i1.json"]'),
    );

    await openTab(root, "steps");
    const groups = all(root, '.step-block[data-block="each_profile"] details');
    assert.deepEqual(
      groups.map(
        (group) => `${group.dataset.group}:${group.hasAttribute("open")}`,
      ),
      ["iteration 1:false", "iteration 2:true"],
    );
  });
});

describe("Live: nested executions stream into groups", () => {
  it("groups iterations, branches and attempts, with field and request chips", async () => {
    configuredState();
    runBridge();
    const runId = "2026-10-02T15-00-00-000Z_profile_wizard_feed00";
    const runDir = path.join(runsRoot, runId);
    write(runDir, "run.log", "running\n");
    const list = env
      .readEvents("events-control-flow.ndjson")
      .filter((event) => event.type !== "run.failed")
      .map((event) => (event.runId ? { ...event, runId } : event));
    Studio.syncDetected([
      {
        runId,
        runDir,
        spec: "profile_wizard",
        startedAtMs: Date.now() - 20_000,
        lastActivityMs: Date.now(),
        liveness: { state: "running", reason: "heartbeat" },
        invocation: null,
      },
    ]);
    // stream in two halves: the groups grow under their blocks
    const half = list.findIndex(
      (event) =>
        event.type === "step.started" && event.stepId === "submit_retry",
    );
    Studio.applyExternalEvents(runId, list.slice(0, half));
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
      const repeatGroups = () =>
        all(card, ".live-groups details.step-group").map(
          (group) => group.dataset.group,
        );
      assert.deepEqual(repeatGroups(), ["then", "iteration 1", "iteration 2"]);

      Studio.applyExternalEvents(runId, list.slice(half));
      await Studio.live.flush();
      assert.deepEqual(repeatGroups(), [
        "then",
        "iteration 1",
        "iteration 2",
        "attempt 1",
        "attempt 2",
      ]);
      const groups = all(card, ".live-groups details.step-group");
      assert.ok(groups[3].classList.contains("step-group-retried"));
      assert.match(text(groups[3].querySelector("summary")), /retried/);
      assert.ok(groups[3].querySelector(".step-live.step-retried"));
      assert.ok(groups[4].classList.contains("step-group-passed"));
      // nested rows live inside their group, not at the top level
      assert.equal(
        all(card, ".steps-list > .step-live").length,
        9,
        "nine top-level rows",
      );
      assert.ok(
        all(card, ".section-title").some((node) =>
          /^Steps \(9\/9\)$/.test(text(node)),
        ),
        "Steps (9/9) counts top-level steps",
      );

      // F15 field chips (never values) and F18 request chips
      const form = /** @type {HTMLElement} */ (
        card.querySelector('.step-live[data-step="profile_form"]')
      );
      assert.deepEqual(
        all(form, ".widget-chips .tag").map((tag) => text(tag)),
        ["country committed", "start_date committed", "certify already"],
      );
      assert.match(
        text(card.querySelector('.step-live[data-step="wait_task"]')),
        /tasks → 200 · 3 attempts/,
      );
      assert.match(
        text(card.querySelector('.step-live[data-step="denied"]')),
        /denied → 401 · 4 combination\(s\), 1 mismatched/,
      );
      assert.match(
        text(card.querySelector('.step-live[data-step="save_draft"]')),
        /via dispatch/,
      );
      assert.match(
        text(card.querySelector('.step-live[data-step="save_draft"]')),
        /pointer blocked by div\.p-dialog-mask/,
      );
      assertNoSecret(card);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});

describe("Catalog: widgets, environment auth, built-in login", () => {
  /** @param {Array<Record<string, any>>} actions */
  function catalogBridge(actions) {
    return env.installBridge({
      "catalog:get": () => ({
        ok: true,
        exitCode: 0,
        meaning: "success",
        cli: "cairn catalog --json",
        payload: {
          root: "/tmp/project",
          actions,
          vars: [],
          verifiers: [],
          envs: [
            { name: "local", baseUrl: "http://localhost:4567", vars: 0 },
            {
              name: "staging",
              baseUrl: "https://staging.example.test",
              vars: 0,
            },
          ],
          flows: [],
          checkpoints: [],
          totals: { actions: actions.length },
          scan: { files: 1 },
          warnings: [],
        },
      }),
      "fs:reveal": (/** @type {string} */ target) => target,
    });
  }

  it("lists the built-in login, auth per environment and the widget registry", async () => {
    configuredState();
    catalogBridge([
      {
        name: "open_profile",
        description: "Open the profile page",
        inputs: [],
        steps: 2,
        usedBy: [],
        file: "flows/actions/open_profile.yml",
      },
    ]);
    Studio.catalogView.filters.query = "";
    Studio.catalogView.filters.env = "";
    Studio.catalogView.filters.tab = "actions";
    const root = mountPoint();
    const handle = await Studio.views.catalog.render(root, {});
    try {
      const tabs = all(root, '.catalog-tabs [role="tab"]').map(text);
      assert.ok(tabs.includes("Actions2"), tabs.join(","));
      // 6 drivers, 1 field root, 1 app handle
      assert.ok(tabs.includes("Widgets8"), tabs.join(","));
      const login = /** @type {HTMLElement} */ (
        root.querySelector('.catalog-actions tr[data-name="login"]')
      );
      assert.ok(login, "the built-in login row");
      assert.match(text(login), /built-in/);
      assert.match(text(login), /environments\.<env>\.auth \(local\)/);
      assert.match(text(login), /config auth:/);

      /** @type {HTMLElement} */ (
        root.querySelector('[data-tab="envs"]')
      ).click();
      const envs =
        /** @type {HTMLElement} */ (root.querySelector(".catalog-envs"));
      assert.match(text(envs.querySelector("thead")), /auth/);
      const local = /** @type {HTMLElement} */ (
        envs.querySelector('tr[data-name="local"]')
      );
      assert.match(text(local), /use: login/);
      assert.match(text(local), /POST \/api\/login \+1 follow-up · hydrate/);
      assert.match(text(local), /secrets: E2E_EMAIL, E2E_OTP, E2E_PASSWORD/);
      assert.match(
        String(local.querySelector(".catalog-auth")?.getAttribute("title")),
        /otp PUT \/api\/otp\/\$\{secrets\.E2E_OTP\} \(when requests\.login\.body\.user\.mfa\)/,
      );
      assert.match(
        text(envs.querySelector('tr[data-name="staging"]')),
        /—\s*$/,
      );

      /** @type {HTMLElement} */ (
        root.querySelector('[data-tab="widgets"]')
      ).click();
      const widgets =
        /** @type {HTMLElement} */ (root.querySelector(".catalog-widgets"));
      assert.deepEqual(
        all(widgets, 'tr.catalog-row[data-section="driver"]').map(
          (row) => row.dataset.name,
        ),
        [
          "vue-multiselect",
          "upper.js",
          "radio-group",
          "checkbox-group",
          "native-select",
          "native-input",
        ],
      );
      assert.match(
        text(widgets.querySelector('tr[data-name="upper.js"]')),
        /project driver/,
      );
      assert.match(
        text(widgets.querySelector('tr[data-name="radio-group"]')),
        /appended \(native\)/,
      );
      assert.deepEqual(
        all(widgets, 'tr.catalog-row[data-section="fieldRoot"]').map(
          (row) => row.dataset.name,
        ),
        ['[data-field-key="{key}"]'],
      );
      assert.ok(
        widgets.querySelector(
          'tr[data-section="appHandle"][data-name="store"]',
        ),
      );
      assertNoSecret(root);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });

  it("lets an imported login win, and hides what the config does not declare", async () => {
    configuredState();
    catalogBridge([
      {
        name: "login",
        description: "Log in through the form",
        inputs: [],
        steps: 4,
        usedBy: [],
        file: "flows/actions/login.yml",
      },
    ]);
    Studio.catalogView.filters.tab = "actions";
    const root = mountPoint();
    const handle = await Studio.views.catalog.render(root, {});
    try {
      const rows = all(root, ".catalog-actions tbody tr");
      assert.equal(rows.length, 1);
      assert.match(text(rows[0]), /overrides built-in/);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }

    // a config with no auth and no browser widgets: no auth column, no tab
    configuredState({ registries: registries.summarizeRegistries({}) });
    catalogBridge([]);
    Studio.catalogView.filters.tab = "envs";
    const root2 = mountPoint();
    const handle2 = await Studio.views.catalog.render(root2, {});
    try {
      assert.ok(!/auth/.test(text(root2.querySelector(".catalog-envs thead"))));
      const tabs = all(root2, '.catalog-tabs [role="tab"]').map(text);
      assert.ok(!tabs.some((tab) => tab.startsWith("Widgets")), tabs.join(","));
      assert.ok(!root2.querySelector('.catalog-actions tr[data-name="login"]'));
    } finally {
      /** @type {any} */ (handle2)?.destroy?.();
    }
  });
});
