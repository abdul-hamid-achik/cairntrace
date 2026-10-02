/**
 * Studio D3 in a DOM (happy-dom): stash/publish/pin evidence, refused runs,
 * environment policy, and checkpoint scope, against the 2b contract.
 *
 * Views render from the shapes the main process sends; the artifact-backed
 * ones come from the same lib/ readers ipc.js calls over a temp artifact
 * root. Events are built inline: desktop .ndjson fixtures are validated
 * against the runner's strict events.v1 schema, which gains these fields in
 * the runner lanes.
 */
const assert = require("node:assert/strict");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const env = require("./dom-env");
const { cleanup, makeRun, tempDir, write } = require("./helpers");
const runs = require("../lib/runs");
const invocations = require("../lib/invocations");

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
/**
 * @param {ParentNode} root
 * @param {string} label
 * @returns {HTMLElement | undefined}
 */
const button = (root, label) =>
  all(root, "button").find((b) => text(b) === label);

function mountPoint() {
  const root = /** @type {HTMLElement} */ (document.getElementById("view"));
  Studio.clear(root);
  return root;
}

/** The shared <dialog>: Studio.confirm / Studio.promptText draw into it. */
function modal() {
  return /** @type {HTMLDialogElement} */ (document.getElementById("modal"));
}

const ENVIRONMENTS = [
  {
    name: "local",
    baseUrl: "http://localhost:8787",
    policy: { trait: "owned", mutations: "allow", description: null },
  },
  {
    name: "staging",
    baseUrl: "https://staging.example.test",
    policy: {
      trait: "shared",
      mutations: "deny",
      description: "shared with the QA team",
    },
  },
  {
    name: "prod",
    baseUrl: "https://example.test",
    policy: { trait: "protected", mutations: "deny", description: null },
  },
];

function configuredState() {
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
      project: "fixture",
      defaultEnvironment: "local",
      environments: ENVIRONMENTS,
    },
  };
}

const REFUSED = "2026-10-02T09-00-00-000Z_reset_orders_d00001";
const PINNED = "2026-10-02T10-00-00-000Z_checkout_d00002";
const STASH_FAILED = "2026-10-02T11-00-00-000Z_landing_d00003";

/** @type {string} */
let runsRoot;

before(() => {
  runsRoot = tempDir("cairn-dom-2b-");
  const refusedDir = makeRun(runsRoot, REFUSED, {
    specName: "reset_orders",
    run: {
      status: "refused",
      summary: "refused by environment policy",
      environment: "prod",
      exitCode: 7,
      outcomes: [],
      steps: [],
      refusal: {
        reason: "prod is protected and requires.env does not list it",
        env: "prod",
        requires: { env: ["local", "staging"], mutates: true },
      },
    },
  });
  write(
    refusedDir,
    "events.ndjson",
    `${[
      { type: "run.started", runId: REFUSED, spec: "reset_orders" },
      {
        type: "run.refused",
        reason: "prod is protected and requires.env does not list it",
        env: "prod",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );

  const pinnedDir = makeRun(runsRoot, PINNED, {
    specName: "checkout",
    run: {
      status: "failed",
      summary: "outcome order_saved failed",
      failure: { outcome: "order_saved", message: "outcome failed" },
      pinned: { at: "2026-10-02T10:05:00.000Z", reason: "bug 42 evidence" },
    },
  });
  write(
    pinnedDir,
    "stash-receipt.json",
    JSON.stringify({
      stashId: "stash_pin",
      status: "saved",
      postSaveFailureCount: 0,
      recordedAt: "2026-10-02T10:06:00.000Z",
      contentHash: "sha256:abc",
      fileCount: 31,
      sizeBytes: 40960,
      expiresAt: "2099-10-16T10:06:00.000Z",
      tags: ["spec:checkout", "keep"],
      excluded: ["traces/"],
      secretsFound: 1,
    }),
  );
  write(
    pinnedDir,
    "publish-receipt.json",
    JSON.stringify({
      version: 1,
      artifactRef: "fcheap://cloud/vaults/private/artifacts/pin1",
      sha256: "a".repeat(64),
      sizeBytes: 9000,
      publishedAt: "2026-10-02T10:07:00.000Z",
      expiresAt: "2099-10-09T10:07:00.000Z",
      webUrl: "https://file.cheap/a/pin1",
      runIndexSkipped: "too-large",
    }),
  );
  write(
    pinnedDir,
    "artifact-manifest.json",
    JSON.stringify({
      version: "1",
      artifacts: [
        {
          path: "run.json",
          kind: "run",
          bytes: 10,
          sha256: "b".repeat(64),
          sensitivity: "redacted",
        },
        {
          path: "screenshots/001_step_1.png",
          kind: "screenshot",
          bytes: 20,
          sha256: "c".repeat(64),
          sensitivity: "safe",
        },
        {
          path: "traces/agent-browser-trace.json",
          kind: "trace",
          bytes: 30,
          sha256: "d".repeat(64),
          sensitivity: "sanitized",
        },
        {
          path: "diagnostics/after-collector.txt",
          kind: "diagnostic",
          bytes: 40,
          sha256: "e".repeat(64),
          sensitivity: "secret-bearing",
        },
      ],
    }),
  );

  const stashFailedDir = makeRun(runsRoot, STASH_FAILED, {
    specName: "landing",
  });
  write(
    stashFailedDir,
    "events.ndjson",
    `${[
      { type: "run.started", runId: STASH_FAILED, spec: "landing" },
      { type: "run.passed", durationMs: 4250 },
      {
        type: "artifact.stash",
        action: "auto-stash",
        status: "error",
        reason: "fcheap-missing",
        message: "fcheap was not found on PATH",
      },
    ]
      .map((event) => JSON.stringify(event))
      .join("\n")}\n`,
  );
});

/**
 * Bridge handlers backed by the real lib readers over `runsRoot`.
 * @param {Record<string, (...args: any[]) => any>} [extra]
 */
function libBridge(extra = {}) {
  return env.installBridge({
    "runs:list": (/** @type {any} */ options) => ({
      runsRoot,
      source: "settings",
      exists: true,
      runs: runs.listRuns(runsRoot, { status: options?.status ?? null }),
      specNames: runs.listRunSpecs(runsRoot),
      labels: [],
    }),
    "run:detail": (/** @type {string} */ ref) => {
      const dir = path.isAbsolute(ref) ? ref : path.join(runsRoot, ref);
      return { ...runs.readRunDetail(dir), restored: false };
    },
    "runs:history": (/** @type {any} */ options) =>
      runs.runHistory(runsRoot, String(options?.spec ?? ""), { limit: 20 }),
    "run:artifact-text": (/** @type {any} */ options) =>
      runs.readBoundedText(
        String(options?.runDir),
        String(options?.path ?? ""),
        400_000,
      ),
    "run:tail-text": (/** @type {any} */ options) =>
      runs.readTextFrom(
        String(options?.runDir),
        String(options?.path ?? ""),
        Number(options?.offset ?? 0),
      ),
    "run:artifact-image": () => ({ ok: false, error: "no images in tests" }),
    "fs:exists": () => true,
    ...extra,
  });
}

// ── Runs ───────────────────────────────────────────────────────────────────

// Forward compatible: the CLI writes no run directory for a refused spec
// today (src/cli/invocation/policy.ts), so the refused run directories built
// here (REFUSED) cannot occur yet. They pin how Runs, Run detail and Cohorts
// would style one; the shapes the CLI produces now are covered by the Live
// (exit 7 payload) and Invocations (journal) tests below.
describe("Runs view: pinned and refused runs", () => {
  it("marks pinned rows and styles a refused record apart from failures (forward compatible)", async () => {
    configuredState();
    Studio.state.filters.status = "";
    libBridge();
    const root = mountPoint();
    await Studio.views.runs.render(root);

    const rows = all(root, "tr.run-row");
    const byId = (/** @type {string} */ id) =>
      rows.find((row) => row.dataset.runId === id);
    const pinned = byId(PINNED);
    const refused = byId(REFUSED);
    assert.ok(pinned?.classList.contains("pinned"), "pinned row is marked");
    assert.equal(text(pinned?.querySelector(".tag-pin")), "pinned");
    assert.match(
      String(pinned?.querySelector(".tag-pin")?.getAttribute("title")),
      /bug 42 evidence/,
    );
    assert.match(String(pinned?.getAttribute("aria-label")), /pinned/);

    assert.ok(refused?.classList.contains("refused"));
    assert.ok(!refused?.classList.contains("pinned"));
    assert.equal(text(refused?.querySelector(".status-cell")), "refused");
    assert.ok(refused?.querySelector(".status-cell .dot-refused"));
    assert.ok(!refused?.querySelector(".dot-bad"), "not styled as a failure");
    assert.match(
      text(refused?.querySelector(".cell-summary")),
      /refused on prod: prod is protected/,
    );

    // No "refused" status filter: the CLI never writes a refused run
    // directory, so it could only ever be empty.
    const statusSelect =
      /** @type {HTMLSelectElement} */ (root.querySelector(".toolbar select"));
    assert.ok(
      ![...statusSelect.options].some((option) => option.value === "refused"),
    );
  });
});

// ── Run detail ─────────────────────────────────────────────────────────────

describe("Run detail: evidence, publish, pin, refusal", () => {
  it("shows a refused record's refusal instead of a failure (forward compatible)", async () => {
    configuredState();
    libBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: REFUSED, from: "runs" });

    const box = root.querySelector(".refusal-box");
    assert.ok(box, "a refusal box");
    assert.match(text(box), /refused by the environment policy on prod/);
    assert.match(text(box), /prod is protected/);
    assert.match(text(box), /requires: env local, staging · mutates/);
    assert.ok(
      !root.querySelector(":scope > .error-box"),
      "no failure box for a refusal",
    );
    const tabs = all(root, '[role="tab"]').map((tab) => tab.dataset.tab);
    assert.ok(!tabs.includes("failure"), tabs.join(","));
    assert.equal(
      text(root.querySelector('[role="tab"][aria-selected="true"]')),
      "Overview",
    );
    assert.ok(root.querySelector(".run-badges .tag-refused"));
    await env.waitFor(
      () => root.querySelector(".history .history-cell"),
      "the history strip",
    );
    assert.ok(root.querySelector(".history .history-refused"));
    assert.equal(
      text(root.querySelector(".history > .cell-dim")),
      "1 refused in the last 1 runs",
    );
    assert.ok(
      !button(root, "Publish to file.cheap"),
      "refused: nothing to publish",
    );
    assert.ok(button(root, "Pin"), "a refused run can still be pinned");
    await env.waitFor(
      () => root.querySelector(".evidence-panel"),
      "the evidence panel",
    );
    assert.match(
      text(root.querySelector(".evidence-stash")),
      /Refused runs are never stashed/,
    );
  });

  it("shows the stash receipt's excluded members, secrets, expiry and tags, and the publish receipt", async () => {
    configuredState();
    /** @type {any[]} */
    const opened = [];
    libBridge({
      "run:open-published": (/** @type {string} */ ref) => {
        opened.push(ref);
        return { opened: true };
      },
    });
    const root = mountPoint();
    await Studio.views.run.render(root, {
      runRef: PINNED,
      from: "runs",
      tab: "overview",
    });

    const stashTag = root.querySelector(".run-badges .stash-tag");
    assert.equal(text(stashTag), "stashed stash_pin · 1 secret finding(s)");
    assert.ok(stashTag?.classList.contains("tag-warn"), "secrets warn");
    const tooltip = String(stashTag?.getAttribute("title"));
    assert.match(tooltip, /left out: traces\/ — opt in with stash\.include/);
    assert.match(tooltip, /secrets found: 1/);
    assert.match(tooltip, /tags: spec:checkout, keep/);
    assert.match(tooltip, /expires: /);
    assert.equal(text(root.querySelector(".run-badges .tag-pin")), "pinned");
    assert.equal(
      text(root.querySelector(".run-badges .publish-tag")),
      "published",
    );

    await env.waitFor(
      () => root.querySelector(".evidence-panel"),
      "the evidence panel",
    );
    const lines = all(root, ".evidence-stash .evidence-lines li").map(text);
    assert.ok(lines.includes("left out: traces/ — opt in with stash.include"));
    assert.ok(
      all(root, ".evidence-stash .evidence-lines li.warn").some((li) =>
        text(li).startsWith("secrets found: 1"),
      ),
    );
    assert.ok(lines.includes("contents: 31 file(s) · 40 KB"), lines.join("|"));
    assert.ok(lines.includes("content hash: sha256:abc"));
    const publishLines = all(root, ".evidence-publish .evidence-lines li").map(
      text,
    );
    assert.ok(
      publishLines.includes(
        "published to file.cheap: fcheap://cloud/vaults/private/artifacts/pin1",
      ),
    );
    assert.ok(publishLines.some((line) => line.startsWith("expires: ")));
    assert.ok(
      publishLines.some((line) =>
        line.startsWith("not listed in the console: too-large — "),
      ),
      publishLines.join("|"),
    );
    // what leaves the machine: manifest sensitivities, sanitized included
    const sensitivity = root.querySelector(".evidence-sensitivity");
    assert.ok(sensitivity, "a sensitivity block for a manifest with labels");
    const sensitivityTags = all(
      /** @type {HTMLElement} */ (sensitivity),
      ".tag",
    ).map(text);
    assert.deepEqual(sensitivityTags, ["1 secret-bearing", "1 sanitized"]);
    const sensitivityLines = all(
      /** @type {HTMLElement} */ (sensitivity),
      ".evidence-lines li",
    ).map(text);
    assert.ok(
      sensitivityLines.some((line) =>
        line.startsWith(
          "never published: traces/agent-browser-trace.json (sanitized), diagnostics/after-collector.txt (secret-bearing)",
        ),
      ),
      sensitivityLines.join("|"),
    );
    assert.match(text(root.querySelector(".evidence-pin")), /bug 42 evidence/);
    assert.match(text(root.querySelector("dl.kv")), /pinned/);

    const open = button(root, "Open in file.cheap");
    assert.ok(open, "an Open in file.cheap button for an https receipt URL");
    open.click();
    await env.settle();
    assert.deepEqual(opened, [path.join(runsRoot, PINNED)]);
  });

  it("names a failed stash's reason code", async () => {
    configuredState();
    libBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, {
      runRef: STASH_FAILED,
      from: "runs",
      tab: "overview",
    });
    const tag = root.querySelector(".run-badges .stash-tag");
    assert.equal(text(tag), "not stashed · fcheap-missing");
    assert.match(
      String(tag?.getAttribute("title")),
      /reason: fcheap-missing — fcheap is not installed or not on PATH/,
    );
    assert.match(
      String(tag?.getAttribute("title")),
      /fcheap was not found on PATH/,
    );
    assert.ok(!root.querySelector(".run-badges .publish-tag"));
  });

  it("publishes through main and reports the receipt or the reason", async () => {
    configuredState();
    /** @type {any[]} */
    const published = [];
    let fail = false;
    libBridge({
      "run:publish": (/** @type {string} */ ref) => {
        published.push(ref);
        return fail
          ? {
              published: false,
              cancelled: false,
              exitCode: 2,
              meaning: "errored",
              error: { reason: "auth", message: "device token expired" },
            }
          : {
              published: true,
              cancelled: false,
              receipt: {
                artifactRef: "fcheap://cloud/vaults/private/artifacts/new1",
                expiresAt: "2099-10-09T10:00:00.000Z",
              },
            };
      },
    });
    const toasts =
      /** @type {HTMLElement} */ (document.getElementById("toasts"));
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: STASH_FAILED, from: "runs" });
    button(root, "Publish to file.cheap")?.click();
    await env.waitFor(
      () => /Published to file\.cheap/.test(text(toasts)),
      "the published toast",
    );
    assert.match(text(toasts), /artifacts\/new1/);
    assert.deepEqual(published, [path.join(runsRoot, STASH_FAILED)]);

    fail = true;
    Studio.clear(toasts);
    await env.waitFor(
      () => button(root, "Publish to file.cheap"),
      "the re-rendered header",
    );
    button(root, "Publish to file.cheap")?.click();
    await env.waitFor(
      () => /Publish failed · auth/.test(text(toasts)),
      "the publish failure toast",
    );
    assert.match(text(toasts), /credentials are missing or expired/);
    assert.match(text(toasts), /device token expired/);
    Studio.clear(toasts);
  });

  it("pins with an optional reason from a prompt, and unpins", async () => {
    configuredState();
    /** @type {any[]} */
    const pins = [];
    libBridge({
      "run:pin": (/** @type {any} */ options) => {
        pins.push(["pin", options]);
        return {
          ok: true,
          pinned: { at: "2026-10-02T12:00:00.000Z", reason: options.reason },
          cli: "cairn pin …",
        };
      },
      "run:unpin": (/** @type {any} */ options) => {
        pins.push(["unpin", options]);
        return { ok: true, pinned: null, cli: "cairn unpin …" };
      },
    });
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: STASH_FAILED, from: "runs" });
    button(root, "Pin")?.click();
    await env.waitFor(() => modal().open, "the pin prompt");
    const input =
      /** @type {HTMLInputElement} */ (
        modal().querySelector("input.prompt-input")
      );
    assert.ok(input, "a reason input");
    input.value = "  flaky checkout evidence ";
    /** @type {HTMLElement} */ (button(modal(), "Pin")).click();
    await env.waitFor(() => pins.length === 1, "run:pin");
    assert.deepEqual(pins[0], [
      "pin",
      {
        runRef: path.join(runsRoot, STASH_FAILED),
        reason: "flaky checkout evidence",
      },
    ]);

    // Cancel sends nothing.
    await env.waitFor(() => button(root, "Pin"), "the re-rendered header");
    button(root, "Pin")?.click();
    await env.waitFor(() => modal().open, "the pin prompt again");
    /** @type {HTMLElement} */ (button(modal(), "Cancel")).click();
    await env.settle();
    assert.equal(pins.length, 1);

    // A pinned run offers Unpin, with no prompt.
    await Studio.views.run.render(root, { runRef: PINNED, from: "runs" });
    button(root, "Unpin")?.click();
    await env.waitFor(() => pins.length === 2, "run:unpin");
    assert.deepEqual(pins[1], [
      "unpin",
      { runRef: path.join(runsRoot, PINNED) },
    ]);
  });
});

// ── Live ───────────────────────────────────────────────────────────────────

describe("Live: refused runs and stash reasons", () => {
  it("shows a refused detected run as refused, with its refusal (forward compatible)", async () => {
    configuredState();
    libBridge();
    const runId = "2026-10-02T12-00-00-000Z_reset_orders_e00001";
    const runDir = path.join(runsRoot, runId);
    write(runDir, "run.log", "refused\n");
    Studio.syncDetected([
      {
        runId,
        runDir,
        spec: "reset_orders",
        startedAtMs: Date.now() - 1000,
        lastActivityMs: Date.now(),
        liveness: { state: "running", reason: "heartbeat" },
        invocation: null,
      },
    ]);
    Studio.applyExternalEvents(runId, [
      { type: "run.started", runId, spec: "reset_orders" },
      {
        type: "run.refused",
        reason: "staging denies mutations",
        env: "staging",
      },
    ]);
    Studio.markExternalFinished({
      runId,
      runDir,
      status: "refused",
      summary: "refused by environment policy",
      refusal: { reason: "staging denies mutations", env: "staging" },
    });
    // A stash failure on another detected run names its reason code.
    const stashRun = "2026-10-02T12-01-00-000Z_landing_e00002";
    Studio.syncDetected([
      {
        runId,
        runDir,
        spec: "reset_orders",
        liveness: { state: "running", reason: "heartbeat" },
      },
      {
        runId: stashRun,
        runDir: path.join(runsRoot, stashRun),
        spec: "landing",
        startedAtMs: Date.now() - 1000,
        lastActivityMs: Date.now(),
        liveness: { state: "running", reason: "heartbeat" },
      },
    ]);
    Studio.applyExternalEvents(stashRun, [
      { type: "run.started", runId: stashRun, spec: "landing" },
      {
        type: "artifact.stash",
        action: "auto-stash",
        status: "error",
        reason: "auth",
      },
    ]);

    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      await Studio.live.flush();
      const cards = all(root, ".live-card");
      const refused = cards.find((card) =>
        String(card.dataset.key).endsWith(runId),
      );
      assert.ok(refused, "the refused run's card");
      const status = refused.querySelector(".panel-head .tag");
      assert.equal(text(status), "refused");
      assert.ok(status?.classList.contains("tag-refused"));
      assert.ok(refused.querySelector(".panel-head .dot-refused"));
      const slot = refused.querySelector(".refusal-slot");
      assert.ok(slot && !slot.classList.contains("hidden"));
      assert.match(text(slot), /on staging/);
      assert.match(text(slot), /staging denies mutations/);
      assert.ok(
        refused.querySelector(".error-box")?.classList.contains("hidden"),
        "the failure box stays hidden",
      );

      const stashCard = cards.find((card) =>
        String(card.dataset.key).endsWith(stashRun),
      );
      assert.equal(
        text(stashCard?.querySelector(".badges .stash-tag")),
        "not stashed · auth",
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.detected.clear();
    }
  });
});

describe("Live: a refused app run (exit 7)", () => {
  it("shows the refusal from the run document, not a failure", async () => {
    configuredState();
    env.installBridge({});
    Studio.state.live.set(
      "tok-refused",
      Studio.initLiveRecord({
        token: "tok-refused",
        specs: ["/tmp/project/flows/reset.yml"],
        argv: ["run", "/tmp/project/flows/reset.yml", "--env", "prod"],
        command: "cairn",
        launcher: "cairn",
        startedAt: Date.now() - 1000,
        runDir: null,
        runId: null,
        pid: null,
        invocation: null,
        done: {
          ok: false,
          exitCode: 7,
          meaning: "refused by environment policy",
          at: Date.now(),
          payload: {
            status: "refused",
            summary: "refused: prod is protected",
            refusal: {
              reason: "prod is protected",
              env: "prod",
              requires: { env: ["local"] },
              code: "protected-env",
            },
          },
        },
      }),
    );
    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      await Studio.live.flush();
      const card = root.querySelector('.live-card[data-key="app:tok-refused"]');
      assert.ok(card, "the app run card");
      assert.equal(text(card.querySelector(".panel-head .tag")), "refused");
      assert.match(
        text(card.querySelector(".card-note")),
        /exit 7 · refused by environment policy/,
      );
      const slot = card.querySelector(".refusal-slot");
      assert.ok(slot && !slot.classList.contains("hidden"));
      assert.match(text(slot), /on prod/);
      assert.match(text(slot), /requires: env local/);
      assert.ok(card.querySelector(".error-box")?.classList.contains("hidden"));
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.live.clear();
    }
  });
});

// ── Invocations ────────────────────────────────────────────────────────────

describe("Invocations: refused plan entries", () => {
  it("settles a refused planned spec from its run.refused journal event", async () => {
    configuredState();
    const root2b = tempDir("cairn-inv-2b-");
    const id = "2026-10-02T13-00-00-000Z_4343_abcdef";
    write(
      path.join(root2b, "_invocations", id),
      "invocation.json",
      JSON.stringify({
        version: 1,
        invocationId: id,
        pid: 4343,
        origin: "cli",
        argv: ["run", "flows/reset.yml", "flows/landing.yml"],
        planned: [
          { index: 1, spec: "flows/reset.yml" },
          { index: 2, spec: "flows/landing.yml" },
        ],
        status: "passed",
        startedAt: "2026-10-02T13:00:00.000Z",
        endedAt: "2026-10-02T13:01:00.000Z",
        // The runner journals no run for a refused spec (it gets no run
        // directory): only a run.refused event in the journal stream.
        runs: [
          {
            index: 2,
            spec: "flows/landing.yml",
            runId: STASH_FAILED,
            runDir: "y",
            status: "passed",
          },
        ],
        summary: {
          total: 2,
          passed: 1,
          failed: 0,
          errored: 0,
          refused: 1,
          exitCode: 0,
        },
      }),
    );
    const journalEvents = [
      {
        ts: "2026-10-02T13:00:01.000Z",
        type: "invocation.started",
        invocationId: id,
        planned: 2,
      },
      {
        ts: "2026-10-02T13:00:02.000Z",
        type: "run.refused",
        spec: "reset",
        reason: "prod is protected",
        env: "prod",
        code: "protected-env",
        index: 1,
        path: "flows/reset.yml",
      },
    ];
    env.installBridge({
      "invocations:list": () => ({
        runsRoot: root2b,
        invocations: invocations.listInvocations(root2b),
      }),
      "invocation:get": (/** @type {any} */ options) =>
        invocations.readInvocation(root2b, String(options?.invocationId)),
      "invocation:events": (/** @type {any} */ options) =>
        Number(options?.offset ?? 0) > 0
          ? { events: [], offset: 1 }
          : { events: journalEvents, offset: 1 },
      "invocation:tail-text": () => ({ ok: true, text: "", offset: 0 }),
    });
    Studio.state.view = "invocations";
    const root = mountPoint();
    const handle = await Studio.views.invocations.render(root, {
      invocationId: id,
    });
    try {
      const detail =
        /** @type {HTMLElement} */ (root.querySelector(".inv-detail"));
      assert.match(
        text(detail),
        /1 passed · 0 failed · 0 errored · 1 refused of 2/,
      );
      await env.waitFor(
        () =>
          text(detail.querySelector(".inv-plan .planned-status")) === "refused",
        "the refused plan entry",
      );
      const statuses = all(detail, ".inv-plan .planned-status");
      assert.deepEqual(statuses.map(text), ["refused", "passed"]);
      assert.match(
        String(statuses[0].getAttribute("title")),
        /refused on prod: prod is protected/,
      );
      assert.equal(
        text(detail.querySelector(".inv-plan .planned-refusal")),
        "prod is protected",
      );
      assert.ok(detail.querySelector(".inv-plan .dot-refused"));
      assert.match(text(detail), /Plan \(2\/2\)/, "a refused spec is settled");
      assert.match(
        text(detail),
        /\[1\] run refused · reset · env prod — protected-env — prod is protected/,
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });

  it("marks the refused spec in the Live invocation group's plan", async () => {
    configuredState();
    const id = "2026-10-02T14-00-00-000Z_4444_abcdef";
    Studio.syncInvocations([
      {
        invocationId: id,
        pid: 4444,
        status: "running",
        alive: true,
        startedAt: new Date().toISOString(),
        argv: ["run", "flows/reset.yml", "flows/landing.yml"],
        planned: [
          { index: 1, spec: "flows/reset.yml" },
          { index: 2, spec: "flows/landing.yml" },
        ],
        current: { index: 2, spec: "flows/landing.yml" },
        runs: [],
        logs: [],
      },
    ]);
    Studio.applyInvocationEvents(id, [
      {
        type: "run.refused",
        spec: "reset",
        reason: "staging denies mutations",
        env: "staging",
        index: 1,
        path: "flows/reset.yml",
      },
    ]);
    const record = Studio.state.invocations.get(id);
    assert.equal(record?.model.status, "running", "the journal stays live");
    assert.equal(record?.model.terminal, null);
    env.installBridge({
      "invocation:tail-text": () => ({ ok: true, text: "", offset: 0 }),
    });
    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      await Studio.live.flush();
      const items = all(root, ".live-group .planned-item");
      assert.equal(items.length, 2);
      assert.ok(items[0].classList.contains("planned-refused"));
      assert.match(
        String(items[0].getAttribute("title")),
        /refused on staging: staging denies mutations/,
      );
      assert.ok(items[0].querySelector(".dot-refused"));
      assert.ok(items[1].classList.contains("planned-running"));
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.invocations.clear();
    }
  });
});

// ── Environment ────────────────────────────────────────────────────────────

describe("Environment: policies, checkpoints, prune", () => {
  it("lists every environment's policy and each checkpoint's scope and health", async () => {
    configuredState();
    env.installBridge({
      "app:info": () => ({
        appVersion: "0.0.0-test",
        electronVersion: "test",
        nodeVersion: "test",
        platform: "darwin",
        arch: "arm64",
        cairn: { command: "/usr/local/bin/cairn", source: "path" },
        runsRoot: { runsRoot, source: "settings" },
      }),
      "cairn:doctor": () => ({ ok: true, payload: { ok: true, checks: [] } }),
      "services:status": () => ({ ok: true, payload: null, stdout: "" }),
      "checkpoints:list": () => ({
        ok: true,
        payload: {
          root: "/tmp/checkpoints",
          checkpoints: [
            {
              name: "admin_local",
              env: "local",
              baseUrl: "http://localhost:8787",
              createdAt: new Date(Date.now() - 3_600_000).toISOString(),
              expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
              ttl: "24h",
              health: "ok",
              sizeBytes: 2048,
            },
            {
              name: "admin_staging",
              scope: {
                env: "staging",
                baseUrl: "https://staging.example.test",
              },
              createdAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
              expiresAt: new Date(Date.now() - 3_600_000).toISOString(),
              healthy: true,
            },
            {
              // captured before checkpoints recorded their scope
              name: "legacy",
              path: "/tmp/checkpoints/legacy.json",
              sizeBytes: 512,
              modifiedAt: new Date(Date.now() - 600_000).toISOString(),
              health: "unscoped",
            },
          ],
        },
      }),
    });
    const root = mountPoint();
    await Studio.views.doctor.render(root);

    const envRows = all(root, "table.env-policy tr.env-row");
    assert.deepEqual(
      envRows.map((row) => row.dataset.env),
      ["local", "staging", "prod"],
    );
    assert.match(text(envRows[0]), /\(default\)/);
    assert.match(
      text(envRows[1]),
      /shared.*mutations denied.*shared with the QA team/,
    );
    assert.ok(envRows[2].querySelector(".tag-refused"), "protected stands out");
    assert.match(text(envRows[2]), /protected/);

    const rows = all(root, "table.checkpoints tr.checkpoint-row");
    assert.equal(rows.length, 3);
    const cells = (/** @type {HTMLElement} */ row) =>
      all(row, "td").map((cell) => text(cell));
    assert.deepEqual(cells(rows[0]).slice(0, 3), [
      "admin_local",
      "local",
      "http://localhost:8787",
    ]);
    assert.match(cells(rows[0])[4], /^in /);
    assert.equal(cells(rows[0])[5], "ok");
    assert.ok(rows[0].querySelector(".tag-ok"));
    assert.equal(all(rows[0], "td")[4].getAttribute("title"), "ttl 24h");
    assert.deepEqual(cells(rows[1]).slice(1, 3), [
      "staging",
      "https://staging.example.test",
    ]);
    assert.equal(cells(rows[1])[5], "expired", "past expiry wins over healthy");
    assert.deepEqual(cells(rows[2]).slice(1, 3), ["—", "—"]);
    assert.equal(cells(rows[2])[4], "never");
    const unscoped = rows[2].querySelector("td .tag");
    assert.equal(text(unscoped), "unscoped");
    assert.ok(!unscoped?.classList.contains("tag-bad"), "still resumable");
    assert.match(String(unscoped?.getAttribute("title")), /still resumable/);
    assert.match(cells(rows[2])[3], /ago/, "modifiedAt stands in for created");
  });

  it("says pinned runs are kept before pruning", async () => {
    configuredState();
    env.installBridge({
      "app:info": () => ({
        appVersion: "0.0.0-test",
        cairn: { command: "/usr/local/bin/cairn", source: "path" },
        runsRoot: { runsRoot, source: "settings" },
      }),
      "cairn:doctor": () => ({ ok: true, payload: { ok: true, checks: [] } }),
      "services:status": () => ({ ok: true, payload: null }),
      "checkpoints:list": () => ({ ok: true, payload: { checkpoints: [] } }),
    });
    const root = mountPoint();
    await Studio.views.doctor.render(root);
    assert.match(text(root), /pinned runs are never pruned/);
    button(root, "Prune now")?.click();
    await env.waitFor(() => modal().open, "the prune confirmation");
    assert.match(text(modal()), /pinned runs \(cairn pin\) are always kept/);
    /** @type {HTMLElement} */ (button(modal(), "Cancel")).click();
    await env.settle();
    button(root, "Remove everything…")?.click();
    await env.waitFor(() => modal().open, "the clean --all confirmation");
    assert.match(text(modal()), /Pinned runs are kept/);
    /** @type {HTMLElement} */ (button(modal(), "Cancel")).click();
    await env.settle();
  });
});

// ── Specs ──────────────────────────────────────────────────────────────────

describe("Specs: requires and the policy warning before Run", () => {
  it("shows requires, warns on an environment that would refuse, and still lets Run through", async () => {
    configuredState();
    Studio.state.selectedSpec = null;
    Studio.state.specDirty = false;
    const requires = {
      env: [
        { name: "local", optIn: null },
        { name: "staging", optIn: "ALLOW_STAGING" },
      ],
      mutates: true,
    };
    const specs = [
      {
        path: "/tmp/project/flows/reset.yml",
        rel: "flows/reset.yml",
        name: "reset",
        mtimeMs: Date.now() - 60_000,
        summary: {
          name: "reset",
          intent: "reset orders",
          outcomes: [{}],
          steps: [{}],
          requires,
        },
      },
    ];
    /** @type {any[]} */
    const started = [];
    env.installBridge({
      "specs:list": () => specs,
      "spec:read": (/** @type {string} */ file) => ({
        path: file,
        text: "intent: reset orders\nrequires:\n  mutates: true\nsteps:\n  - open: /\noutcomes: []\n",
        summary: {
          name: "reset",
          intent: "reset orders",
          environment: null,
          outcomes: [],
          steps: [{ id: "s", kind: "open" }],
          requires,
        },
        bytes: 80,
        optIns: { ALLOW_STAGING: false },
      }),
      "run:start": (/** @type {any} */ options) => {
        started.push(options);
        return { token: "t1", argv: [], command: "cairn", cwd: "/tmp/project" };
      },
    });
    const root = mountPoint();
    const handle = await Studio.views.specs.render(root, {});
    try {
      assert.equal(
        text(root.querySelector(".spec-item .requires-line")),
        "requires env local, staging (opt-in ALLOW_STAGING) · mutates",
      );
      await env.waitFor(
        () => root.querySelector("#spec-policy-warning"),
        "the spec detail",
      );
      assert.match(
        text(root.querySelector("dl.kv")),
        /requires.*env local, staging \(opt-in ALLOW_STAGING\) · mutates/,
      );
      const warning = /** @type {HTMLElement} */ (
        root.querySelector("#spec-policy-warning")
      );
      assert.ok(warning.classList.contains("hidden"), "local is allowed");

      const picker =
        /** @type {HTMLSelectElement} */ (
          root.querySelector(".env-picker select")
        );
      assert.deepEqual(
        [...picker.options].map((option) => option.textContent),
        [
          "default (local)",
          "local · owned · mutations allowed",
          "staging · shared · mutations denied",
          "prod · protected · mutations denied",
        ],
      );
      picker.value = "staging";
      picker.dispatchEvent(new window.Event("change"));
      assert.ok(!warning.classList.contains("hidden"));
      assert.match(text(warning), /refuse this spec on "staging"/);
      assert.match(text(warning), /ALLOW_STAGING=1/);
      assert.match(text(warning), /denies mutations/);

      picker.value = "prod";
      picker.dispatchEvent(new window.Event("change"));
      assert.match(text(warning), /lists local, staging, not "prod"/);

      // Run asks once (never blocks) and passes the picked environment.
      button(root, "Run")?.click();
      await env.waitFor(() => modal().open, "the refusal confirmation");
      assert.match(text(modal()), /would refuse this spec on "prod"/);
      /** @type {HTMLElement} */ (button(modal(), "Run anyway")).click();
      await env.waitFor(() => started.length === 1, "run:start");
      assert.deepEqual(started[0].specs, ["/tmp/project/flows/reset.yml"]);
      assert.equal(started[0].overrides?.env, "prod");

      // Cancel at the confirmation starts nothing.
      button(root, "Run")?.click();
      await env.waitFor(() => modal().open, "the confirmation again");
      /** @type {HTMLElement} */ (button(modal(), "Cancel")).click();
      await env.settle();
      assert.equal(started.length, 1);

      picker.value = "local";
      picker.dispatchEvent(new window.Event("change"));
      assert.ok(warning.classList.contains("hidden"));
      button(root, "Run")?.click();
      await env.waitFor(() => started.length === 2, "run:start without asking");
      assert.equal(started[1].overrides?.env, "local");
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});

// ── Stashes ────────────────────────────────────────────────────────────────

describe("Stashes: receipts and secret flags", () => {
  it("links a stash to its local run and shows the receipt", async () => {
    configuredState();
    env.installBridge({
      "stash:list": () => ({
        ok: true,
        exitCode: 0,
        cli: "cairn stash list --tool cairntrace --format json",
        payload: {
          stashes: [
            {
              id: "stash_pin",
              name: "checkout failed",
              tags: ["cairntrace"],
              fileCount: 31,
              sizeBytes: 40960,
              createdAt: new Date(Date.now() - 3_600_000).toISOString(),
              expiresAt: new Date(Date.now() + 14 * 86_400_000).toISOString(),
            },
            {
              id: "stash_other",
              tags: ["cairntrace"],
              fileCount: 2,
              sizeBytes: 100,
              createdAt: new Date(Date.now() - 7_200_000).toISOString(),
              custom: { secrets_found: "true" },
            },
          ],
        },
      }),
      "stash:receipts": () => runs.listStashReceipts(runsRoot),
      "stash:info": (/** @type {string} */ id) => ({
        ok: true,
        exitCode: 0,
        cli: `cairn stash info ${id} --format json`,
        payload: {
          id,
          tool: "cairntrace",
          tags: ["cairntrace"],
          fileCount: 31,
          sizeBytes: 40960,
          contentHash: "sha256:abc",
          createdAt: new Date().toISOString(),
          custom: {},
        },
      }),
    });
    const root = mountPoint();
    await Studio.views.stashes.render(root);
    const rows = all(root, "tr.stash-row");
    assert.equal(rows.length, 2);
    const pinRow = rows[0];
    assert.match(text(pinRow), /1 secret finding\(s\)/);
    assert.match(text(pinRow), /1 left out/);
    assert.ok(pinRow.querySelector(".tag-pin"), "the local run is pinned");
    const runButton = all(pinRow, "button").find((b) =>
      /^run · checkout$/.test(text(b)),
    );
    assert.ok(runButton, "a link to the local run");
    assert.match(text(rows[1]), /secrets found/, "fcheap's custom flag counts");
    assert.ok(!rows[1].querySelector(".tag-pin"));

    /** @type {HTMLElement} */ (button(pinRow, "Info")).click();
    await env.waitFor(
      () => root.querySelector(".stash-receipt"),
      "the receipt block",
    );
    const receipt =
      /** @type {HTMLElement} */ (root.querySelector(".stash-receipt"));
    assert.match(
      text(receipt),
      /left out: traces\/ — opt in with stash\.include/,
    );
    assert.match(text(receipt), /tags: spec:checkout, keep/);
    assert.match(
      text(root.querySelector("#stash-detail dl.kv")),
      /secrets found1/,
    );
  });
});

// ── Cohorts ────────────────────────────────────────────────────────────────

describe("Cohorts: refused counts", () => {
  // Forward compatible: stats.v1 has no refused count today.
  it("adds a refused column only when a cohort has refused runs (forward compatible)", async () => {
    configuredState();
    env.installBridge({
      "runs:labels": () => [{ key: "variant", count: 2, values: ["a", "b"] }],
      "stats:get": () => ({
        ok: true,
        exitCode: 0,
        payload: {
          scanned: 3,
          matched: 3,
          groupBy: "variant",
          groups: [
            {
              key: "a",
              runs: 2,
              passRate: 1,
              failed: 0,
              errored: 0,
              refused: 1,
              duration: { p50: 1000, p95: 1200 },
            },
            {
              key: "b",
              runs: 1,
              passRate: 1,
              failed: 0,
              errored: 0,
              duration: { p50: 900, p95: 900 },
            },
          ],
          runs: [
            {
              runId: REFUSED,
              specName: "reset_orders",
              status: "refused",
              durationMs: 0,
            },
          ],
        },
      }),
    });
    const root = mountPoint();
    Studio.views.stats.render(root);
    button(root, "Aggregate")?.click();
    await env.waitFor(
      () => root.querySelector("table.grid"),
      "the cohort table",
    );
    const headers = all(root, "table.grid th").map(text);
    assert.ok(headers.includes("refused"), headers.join(","));
    assert.ok(root.querySelector("table.grid td .tag-refused"));
    assert.ok(
      all(root, ".list-row").some(
        (row) => row.querySelector(".dot-refused") && /refused/.test(text(row)),
      ),
    );
  });
});

// ── 2b review fixes: the shapes the CLI actually produces ─────────────────

describe("Live: a Studio run the CLI refused (real exit-7 payload)", () => {
  it("offers no Open evidence for the synthetic refused_… run id", async () => {
    configuredState();
    env.installBridge({});
    // `cairn run refused.yml --format json`, exit 7: a runId and runDir that
    // name nothing on disk (src/cli/invocation/policy.ts).
    const payload = {
      $schema: "urn:cairntrace.dev:run:v1",
      version: "1",
      runId: "refused_1790934496527_gtewiz",
      runDir: "/tmp/project/.cairntrace/refused/refused_1790934496527_gtewiz",
      spec: { name: "refused_probe", path: "/tmp/project/flows/refused.yml" },
      environment: "local",
      status: "refused",
      refusal: {
        reason:
          'requires.env allows "staging"; the resolved environment is "local"',
        env: "local",
        requires: { env: ["staging"] },
        code: "env-not-listed",
      },
      summary: 'refused: requires.env allows "staging"',
      exitCode: 7,
    };
    Studio.state.live.set(
      "tok-real-refused",
      Studio.initLiveRecord({
        token: "tok-real-refused",
        specs: ["/tmp/project/flows/refused.yml"],
        argv: ["run", "/tmp/project/flows/refused.yml"],
        command: "cairn",
        launcher: "cairn",
        startedAt: Date.now() - 1000,
        runDir: null,
        // even if a runId was adopted, a refused card offers nothing to open
        runId: payload.runId,
        pid: null,
        invocation: null,
        done: {
          ok: false,
          exitCode: 7,
          meaning: "refused by environment policy",
          at: Date.now(),
          payload,
        },
      }),
    );
    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      await Studio.live.flush();
      const card = root.querySelector(
        '.live-card[data-key="app:tok-real-refused"]',
      );
      assert.ok(card, "the app run card");
      assert.equal(text(card.querySelector(".panel-head .tag")), "refused");
      const labels = all(card, ".card-actions button").map(text);
      assert.ok(!labels.includes("Open evidence"), labels.join(","));
      assert.ok(labels.includes("Re-run"));
      assert.match(text(card.querySelector(".refusal-slot")), /on local/);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.live.clear();
    }
  });

  it("shows an all-refused batch (exit 0) as refused, with the first refusal", async () => {
    configuredState();
    env.installBridge({});
    Studio.state.live.set(
      "tok-batch-refused",
      Studio.initLiveRecord({
        token: "tok-batch-refused",
        specs: ["/tmp/project/flows/a.yml", "/tmp/project/flows/b.yml"],
        argv: [],
        command: "cairn",
        launcher: "cairn",
        startedAt: Date.now() - 1000,
        runDir: null,
        runId: null,
        pid: null,
        invocation: null,
        done: {
          ok: true,
          exitCode: 0,
          meaning: "passed",
          at: Date.now(),
          payload: {
            $schema: "urn:cairntrace.dev:run-batch:v1",
            summary: { total: 2, passed: 0, failed: 0, errored: 0, refused: 2 },
            results: [
              {
                runId: "refused_1",
                status: "refused",
                refusal: { reason: "a needs staging", env: "local" },
              },
              { runId: "refused_2", status: "refused" },
            ],
            exitCode: 0,
          },
        },
      }),
    );
    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      await Studio.live.flush();
      const card = root.querySelector(
        '.live-card[data-key="app:tok-batch-refused"]',
      );
      assert.ok(card);
      assert.equal(text(card.querySelector(".panel-head .tag")), "refused");
      assert.match(
        text(card.querySelector(".refusal-slot")),
        /a needs staging/,
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.live.clear();
    }
  });
});

describe("Invocations: the journal the CLI writes for a refused spec", () => {
  // Real `cairn run flows/refused.yml` journal: status failed, no runs, no
  // summary.refused, exit 7, and one run.refused event.
  const id = "2026-10-02T15-00-00-000Z_5151_abcdef";
  const journal = {
    version: 1,
    invocationId: id,
    pid: 5151,
    origin: "cli",
    argv: ["run", "flows/refused.yml"],
    env: "local",
    parallel: 1,
    planned: [{ index: 1, spec: "flows/refused.yml" }],
    status: "failed",
    startedAt: "2026-10-02T15:00:00.000Z",
    endedAt: "2026-10-02T15:00:00.010Z",
    runs: [],
    summary: {
      total: 1,
      passed: 0,
      failed: 0,
      errored: 0,
      durationMs: 6,
      exitCode: 7,
    },
  };
  const journalEvents = [
    {
      ts: "2026-10-02T15:00:00.001Z",
      type: "invocation.started",
      invocationId: id,
      planned: 1,
    },
    {
      ts: "2026-10-02T15:00:00.002Z",
      type: "run.refused",
      spec: "refused_probe",
      reason:
        'requires.env allows "staging"; the resolved environment is "local"',
      env: "local",
      code: "env-not-listed",
      index: 1,
      path: "flows/refused.yml",
    },
    {
      ts: "2026-10-02T15:00:00.003Z",
      type: "invocation.finished",
      invocationId: id,
      status: "failed",
    },
  ];

  it("lists and heads it as refused, not a red failed, with 1/1 settled", async () => {
    configuredState();
    const root2b = tempDir("cairn-inv-real-");
    write(
      path.join(root2b, "_invocations", id),
      "invocation.json",
      JSON.stringify(journal),
    );
    env.installBridge({
      "invocations:list": () => ({
        runsRoot: root2b,
        invocations: invocations.listInvocations(root2b),
      }),
      "invocation:get": (/** @type {any} */ options) =>
        invocations.readInvocation(root2b, String(options?.invocationId)),
      "invocation:events": (/** @type {any} */ options) =>
        Number(options?.offset ?? 0) > 0
          ? { events: [], offset: 1 }
          : { events: journalEvents, offset: 1 },
      "invocation:tail-text": () => ({ ok: true, text: "", offset: 0 }),
    });
    Studio.state.view = "invocations";
    const root = mountPoint();
    const handle = await Studio.views.invocations.render(root, {
      invocationId: id,
    });
    try {
      const item = /** @type {HTMLElement} */ (root.querySelector(".inv-item"));
      assert.ok(item, "the list row");
      const tags = all(item, ".inv-item-head .tag").map(text);
      assert.equal(tags[0], "refused");
      assert.ok(tags.includes("1/1"), tags.join(","));
      assert.ok(!item.querySelector(".tag-bad"), "no failure red in the list");
      assert.ok(item.querySelector(".dot-refused"));
      assert.match(String(item.getAttribute("aria-label")), /^refused /);

      const detail =
        /** @type {HTMLElement} */ (root.querySelector(".inv-detail"));
      await env.waitFor(
        () =>
          text(detail.querySelector(".inv-plan .planned-status")) === "refused",
        "the refused plan entry",
      );
      const head = all(detail, ".tag").find(
        (node) => text(node) === "refused" || text(node) === "failed",
      );
      assert.equal(text(head), "refused");
      assert.ok(head?.classList.contains("tag-refused"));
      assert.match(
        text(detail),
        /0 passed · 0 failed · 0 errored · 1 refused of 1 · exit 7 \(refused by the environment policy\)/,
      );
      assert.match(text(detail), /Plan \(1\/1\)/);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });

  it("shows the Live invocation group of a Studio run as refused", async () => {
    configuredState();
    Studio.syncInvocations([{ ...journal, alive: false, logs: [] }]);
    Studio.applyInvocationEvents(id, journalEvents);
    // the app run whose process wrote this journal (same pid) groups under it
    Studio.state.live.set(
      "tok-inv-refused",
      Studio.initLiveRecord({
        token: "tok-inv-refused",
        specs: ["/tmp/project/flows/refused.yml"],
        argv: [],
        command: "cairn",
        launcher: "cairn",
        startedAt: Date.now() - 1000,
        runDir: null,
        runId: null,
        pid: 5151,
        invocation: null,
        done: { ok: false, exitCode: 7, at: Date.now(), payload: null },
      }),
    );
    env.installBridge({
      "invocation:tail-text": () => ({ ok: true, text: "", offset: 0 }),
    });
    Studio.state.view = "live";
    const root = mountPoint();
    const handle = Studio.views.live.render(root);
    try {
      await Studio.live.flush();
      const group = root.querySelector(`.live-group[data-key="inv:${id}"]`);
      assert.ok(group, "the invocation group");
      const tag = group.querySelector(".group-head .tag");
      assert.equal(text(tag), "refused");
      assert.ok(tag?.classList.contains("tag-refused"));
      assert.ok(group.querySelector(".group-head .dot-refused"));
      assert.ok(!group.querySelector(".group-head .tag-bad"));
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.state.invocations.clear();
      Studio.state.live.clear();
    }
  });
});

describe("Run detail: publish state and the in-flight guard", () => {
  const EXPIRED = "2026-10-02T16-00-00-000Z_expired_d00004";
  const REPUBLISH_FAILED = "2026-10-02T17-00-00-000Z_republish_d00005";

  before(() => {
    const expiredDir = makeRun(runsRoot, EXPIRED, { specName: "expired" });
    write(
      expiredDir,
      "publish-receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: "fcheap://cloud/vaults/private/artifacts/old1",
        sha256: "b".repeat(64),
        sizeBytes: 100,
        publishedAt: "2020-01-01T00:00:00.000Z",
        expiresAt: "2020-01-08T00:00:00.000Z",
        webUrl: "https://file.cheap/a/old1",
      }),
    );
    const failedDir = makeRun(runsRoot, REPUBLISH_FAILED, {
      specName: "republish",
    });
    write(
      failedDir,
      "publish-receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: "fcheap://cloud/vaults/private/artifacts/first",
        sha256: "c".repeat(64),
        sizeBytes: 100,
        publishedAt: "2026-10-02T17:01:00.000Z",
        expiresAt: "2099-10-09T17:01:00.000Z",
        webUrl: "https://file.cheap/a/first",
      }),
    );
    write(
      failedDir,
      "events.ndjson",
      `${[
        { type: "run.started", runId: REPUBLISH_FAILED, spec: "republish" },
        { type: "run.passed", durationMs: 1000 },
        {
          ts: "2026-10-02T17:05:00.000Z",
          type: "artifact.publish",
          status: "error",
          reason: "save-failed",
          message: "upload interrupted",
        },
      ]
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
    );
  });

  it("marks an expired package expired, with nothing to open", async () => {
    configuredState();
    libBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: EXPIRED, from: "runs" });
    const tag = root.querySelector(".evidence-publish .publish-tag");
    assert.equal(text(tag), "publish expired");
    assert.ok(tag?.classList.contains("tag-warn"));
    assert.ok(!root.querySelector('[data-action="open-published"]'));
  });

  it("shows a failed re-publish newer than the receipt", async () => {
    configuredState();
    libBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, {
      runRef: REPUBLISH_FAILED,
      from: "runs",
    });
    const tag = root.querySelector(".evidence-publish .publish-tag");
    assert.equal(text(tag), "publish failed · save-failed");
    assert.match(
      text(root.querySelector(".evidence-publish")),
      /fcheap could not upload the package/,
    );
    // the earlier package is still kept: it can still be opened
    assert.equal(
      text(root.querySelector('[data-action="open-published"]')),
      "Open in file.cheap",
    );
  });

  it("disables Publish while an upload is in flight and sends one publish", async () => {
    configuredState();
    /** @type {any[]} */
    const published = [];
    /** @type {Array<(value: any) => void>} */
    const answers = [];
    libBridge({
      "run:publish": (/** @type {string} */ ref) => {
        published.push(ref);
        return new Promise((resolve) => answers.push(resolve));
      },
    });
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: STASH_FAILED, from: "runs" });
    /** @type {HTMLButtonElement} */ (
      root.querySelector('[data-action="publish"]')
    ).click();
    await env.waitFor(() => published.length === 1, "run:publish");
    const busy = /** @type {HTMLButtonElement} */ (
      root.querySelector('[data-action="publish"]')
    );
    assert.equal(text(busy), "Publishing…");
    assert.equal(busy.disabled, true);
    busy.click();
    // a re-render while the upload runs keeps the guard
    await Studio.views.run.render(root, { runRef: STASH_FAILED, from: "runs" });
    const again = /** @type {HTMLButtonElement} */ (
      root.querySelector('[data-action="publish"]')
    );
    assert.equal(again.disabled, true);
    again.click();
    await env.settle();
    assert.equal(published.length, 1, "one publish in flight");

    answers[0]({
      published: true,
      cancelled: false,
      receipt: { artifactRef: "fcheap://cloud/vaults/private/artifacts/n2" },
    });
    await env.waitFor(
      () =>
        text(root.querySelector('[data-action="publish"]')) ===
        "Publish to file.cheap",
      "Publish enabled again",
    );
    assert.equal(
      /** @type {HTMLButtonElement} */ (
        root.querySelector('[data-action="publish"]')
      ).disabled,
      false,
    );
  });

  it("labels a receipt URL on another host with that host", async () => {
    configuredState();
    const foreign = "2026-10-02T18-00-00-000Z_foreign_d00006";
    const dir = makeRun(runsRoot, foreign, { specName: "foreign" });
    write(
      dir,
      "publish-receipt.json",
      JSON.stringify({
        version: 1,
        artifactRef: "fcheap://cloud/vaults/private/artifacts/f1",
        publishedAt: "2026-10-02T18:01:00.000Z",
        expiresAt: "2099-10-09T18:01:00.000Z",
        webUrl: "https://example.test/a/f1",
      }),
    );
    libBridge();
    const root = mountPoint();
    await Studio.views.run.render(root, { runRef: foreign, from: "runs" });
    assert.equal(
      text(root.querySelector('[data-action="open-published"]')),
      "Open on example.test",
    );
  });
});

/**
 * @param {string} specText
 */
function summaryOf(specText) {
  return {
    name: "save",
    intent: "save",
    environment: null,
    outcomes: [],
    steps: [{ id: "s", kind: "open" }],
    requires: specText.includes("staging")
      ? { env: [{ name: "staging", optIn: null }], mutates: null }
      : null,
  };
}

describe("Specs: ⌘R and Save follow the picker and the saved requires", () => {
  const FILE = "/tmp/project/flows/save.yml";
  const PLAIN = "intent: save\nsteps:\n  - open: /\noutcomes: []\n";
  const NEEDS_STAGING =
    "intent: save\nrequires:\n  env: [staging]\nsteps:\n  - open: /\noutcomes: []\n";

  it("runs ⌘R through the Run path, and re-reads the policy after Save", async () => {
    configuredState();
    Studio.state.selectedSpec = null;
    Studio.state.specDirty = false;
    let onDisk = PLAIN;
    /** @type {any[]} */
    const started = [];
    /** @type {string[]} */
    const reads = [];
    env.installBridge({
      "specs:list": () => [
        {
          path: FILE,
          rel: "flows/save.yml",
          name: "save",
          mtimeMs: Date.now() - 60_000,
          summary: summaryOf(onDisk),
        },
      ],
      "spec:read": (/** @type {string} */ file) => {
        reads.push(file);
        return {
          path: file,
          text: onDisk,
          summary: summaryOf(onDisk),
          bytes: onDisk.length,
          optIns: {},
        };
      },
      "spec:write": (
        /** @type {string} */ file,
        /** @type {string} */ body,
      ) => {
        onDisk = body;
        return {
          path: file,
          bytes: body.length,
          summary: summaryOf(body),
          optIns: {},
        };
      },
      "spec:verify": () => ({
        ok: true,
        exitCode: 0,
        meaning: "ok",
        payload: { status: "valid" },
      }),
      "run:start": (/** @type {any} */ options) => {
        started.push(options);
        return { token: `t${started.length}`, argv: [] };
      },
    });
    const root = mountPoint();
    const handle = await Studio.views.specs.render(root, { file: FILE });
    try {
      await env.waitFor(
        () => root.querySelector("#spec-policy-warning"),
        "the spec detail",
      );
      const warning = /** @type {HTMLElement} */ (
        root.querySelector("#spec-policy-warning")
      );
      const picker =
        /** @type {HTMLSelectElement} */ (
          root.querySelector(".env-picker select")
        );
      picker.value = "";
      picker.dispatchEvent(new window.Event("change"));
      assert.ok(warning.classList.contains("hidden"), "no requires yet");
      assert.ok(!root.querySelector(".spec-item .requires-line"));

      // Save a requires.env the default environment (local) is not in.
      const editor =
        /** @type {HTMLTextAreaElement} */ (
          root.querySelector("textarea.editor")
        );
      editor.value = NEEDS_STAGING;
      editor.dispatchEvent(new window.Event("input"));
      button(root, "Save")?.click();
      await env.waitFor(
        () => !warning.classList.contains("hidden"),
        "the warning after Save",
      );
      assert.match(text(warning), /refuse this spec on "local"/);
      assert.equal(
        text(root.querySelector("#spec-requires-value")),
        "env staging",
      );
      assert.equal(
        text(root.querySelector(".spec-item .requires-line")),
        "requires env staging",
      );
      button(root, "Run")?.click();
      await env.waitFor(() => modal().open, "the refusal confirmation");
      assert.match(text(modal()), /would refuse this spec on "local"/);
      /** @type {HTMLElement} */ (button(modal(), "Cancel")).click();
      await env.settle();
      assert.equal(started.length, 0);

      // ⌘R uses the picked environment, and asks when it would be refused.
      picker.value = "prod";
      picker.dispatchEvent(new window.Event("change"));
      const focused = Studio.specsView.runFocused();
      await env.waitFor(() => modal().open, "the ⌘R refusal confirmation");
      assert.match(text(modal()), /would refuse this spec on "prod"/);
      /** @type {HTMLElement} */ (button(modal(), "Run anyway")).click();
      await focused;
      assert.equal(started.length, 1);
      assert.deepEqual(started[0].specs, [FILE]);
      assert.equal(started[0].overrides?.env, "prod");

      // Removing the requirement clears the warning (no stale refusal).
      await Studio.views.specs.render(root, { file: FILE });
      await env.waitFor(
        () => root.querySelector("#spec-policy-warning"),
        "the spec detail again",
      );
      const warning2 = /** @type {HTMLElement} */ (
        root.querySelector("#spec-policy-warning")
      );
      const picker2 =
        /** @type {HTMLSelectElement} */ (
          root.querySelector(".env-picker select")
        );
      picker2.value = "staging";
      picker2.dispatchEvent(new window.Event("change"));
      assert.ok(warning2.classList.contains("hidden"), "staging is listed");
      picker2.value = "";
      picker2.dispatchEvent(new window.Event("change"));
      assert.ok(!warning2.classList.contains("hidden"));
      const editor2 =
        /** @type {HTMLTextAreaElement} */ (
          root.querySelector("textarea.editor")
        );
      editor2.value = PLAIN;
      editor2.dispatchEvent(new window.Event("input"));
      button(root, "Save")?.click();
      await env.waitFor(
        () => warning2.classList.contains("hidden"),
        "the warning cleared after Save",
      );
      assert.ok(!root.querySelector(".spec-item .requires-line"));
      // ⌘R now runs straight through on the default environment.
      await Studio.specsView.runFocused();
      assert.equal(started.length, 2);
      assert.equal(started[1].overrides, undefined);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});

describe("Environment: prune says what it uploads", () => {
  it("names the archive and publication retention would upload", async () => {
    configuredState();
    Studio.state.project.config.retention = {
      archiveToStash: true,
      publish: { enabled: true, retentionDays: 5 },
    };
    /** @type {any[]} */
    const cleans = [];
    env.installBridge({
      "app:info": () => ({
        appVersion: "0.0.0-test",
        cairn: { command: "/usr/local/bin/cairn", source: "path" },
        runsRoot: { runsRoot, source: "settings" },
      }),
      "cairn:doctor": () => ({ ok: true, payload: { ok: true, checks: [] } }),
      "services:status": () => ({ ok: true, payload: null }),
      "checkpoints:list": () => ({ ok: true, payload: { checkpoints: [] } }),
      // main asked natively and the user cancelled
      "clean:runs": (/** @type {any} */ options) => {
        cleans.push(options);
        return { ok: false, cancelled: true, exitCode: null, stderr: "" };
      },
    });
    const toasts =
      /** @type {HTMLElement} */ (document.getElementById("toasts"));
    Studio.clear(toasts);
    const root = mountPoint();
    try {
      await Studio.views.doctor.render(root);
      button(root, "Prune now")?.click();
      await env.waitFor(() => modal().open, "the prune confirmation");
      assert.match(text(modal()), /Prune old runs and upload them\?/);
      assert.match(
        text(modal()),
        /archives it to your file\.cheap stash and publishes it to file\.cheap \(kept 5 days\)/,
      );
      /** @type {HTMLElement} */ (button(modal(), "Prune")).click();
      await env.waitFor(() => cleans.length === 1, "clean:runs");
      await env.settle();
      assert.ok(!/Prune finished/.test(text(toasts)), "a cancel is not news");

      button(root, "Remove everything…")?.click();
      await env.waitFor(() => modal().open, "the clean --all confirmation");
      assert.match(text(modal()), /publishes it to file\.cheap/);
      /** @type {HTMLElement} */ (button(modal(), "Cancel")).click();
      await env.settle();
      assert.equal(cleans.length, 1);
    } finally {
      delete Studio.state.project.config.retention;
    }
  });
});
