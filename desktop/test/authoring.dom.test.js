/**
 * The authoring lane in a DOM (happy-dom): the Sessions view over a real
 * session journal (read through lib/authoring.js and the offset readers, the
 * same calls ipc.js makes), the Catalog view over a `cairn catalog --json`
 * payload, and the Environment view's services up/down controls.
 *
 * Session events are built inline (the journal contract of
 * src/core/schema/events.v1.ts, session union).
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, before, describe, it } = require("node:test");

const env = require("./dom-env");
const { cleanup, tempDir, write } = require("./helpers");
const authoring = require("../lib/authoring");
const runs = require("../lib/runs");

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

function recordNavigation() {
  /** @type {Array<{ view: string, params: Record<string, any> }>} */
  const seen = [];
  const off = Studio.on("navigate", (payload) => seen.push(payload));
  return { seen, off };
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
    config: { project: "fixture", environments: [], ...config },
  };
}

// ── a live discovery session journal ───────────────────────────────────────

const LIVE = "sess_live0001";
const DONE = "sess_done0001";
const PNG = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
  "hex",
);

/** @type {string} */
let runsRoot;
/** @type {string} */
let projectDir;
/** @type {string} */
let liveDir;

const iso = (/** @type {number} */ offsetMs) =>
  new Date(Date.now() + offsetMs).toISOString();

/**
 * @param {string} dir
 * @param {Array<Record<string, any>>} events
 */
function appendEvents(dir, events) {
  fs.appendFileSync(
    path.join(dir, "events.ndjson"),
    events.map((event) => `${JSON.stringify(event)}\n`).join(""),
  );
}

const DRAFT_V1 = [
  "name: profile_website",
  "intent: draft",
  "steps:",
  "  - use: login_as_supplier",
  "  - click: { role: link, name: Profile }",
  "  - click: { role: button, name: Save }",
  "outcomes: []",
  "",
].join("\n");

before(() => {
  const base = tempDir("cairn-authoring-dom-");
  runsRoot = path.join(base, "runs");
  projectDir = path.join(base, "project");
  const draft = write(
    projectDir,
    "flows/_drafts/profile_website.yml",
    DRAFT_V1,
  );
  liveDir = path.join(runsRoot, "_sessions", LIVE);
  write(
    liveDir,
    "session.json",
    JSON.stringify({
      version: 1,
      sessionId: LIVE,
      kind: "discovery",
      pid: process.pid,
      origin: "mcp",
      client: "an-agent",
      startUrl: "${env.baseUrl}/home",
      currentUrl: "/profile",
      backend: "playwright",
      headed: false,
      env: "local",
      status: "open",
      openedAt: iso(-5 * 60_000),
      lastActivityAt: iso(-10_000),
      ttlMs: 30 * 60_000,
      setup: [{ use: "login_as_supplier" }],
      exportedTo: [draft],
      // the agent's export kept its contract: Studio may re-export
      intent: "supplier edits the website field and it persists",
      outcomes: [
        {
          id: "website_saved",
          description: "the new value shows",
          verify: { text: { contains: "example.org" } },
        },
      ],
      stepCount: 2,
      actionCount: 5,
    }),
  );
  fs.mkdirSync(path.join(liveDir, "screenshots"), { recursive: true });
  for (const index of ["001", "002", "003", "004"])
    fs.writeFileSync(path.join(liveDir, "screenshots", `${index}.png`), PNG);
  write(liveDir, "snapshots/002.txt", '- link "Profile"\n- heading "Home"\n');
  write(
    liveDir,
    "network/004.json",
    JSON.stringify([{ method: "PATCH", path: "/api/answers", status: 204 }]),
  );
  write(liveDir, "draft.spec.yml", DRAFT_V1);
  write(liveDir, "events.ndjson", "");
  appendEvents(liveDir, [
    {
      ts: iso(-300_000),
      type: "session.opened",
      sessionId: LIVE,
      kind: "discovery",
    },
    {
      ts: iso(-290_000),
      type: "action.performed",
      index: 1,
      action: "setup",
      ok: true,
      urlBefore: "",
      urlAfter: "/home",
      durationMs: 2400,
      screenshot: "screenshots/001.png",
    },
    {
      ts: iso(-280_000),
      type: "action.performed",
      index: 2,
      action: "click",
      locator: { role: "link", name: "Profile" },
      ok: true,
      urlBefore: "/home",
      urlAfter: "/profile",
      durationMs: 420,
      screenshot: "screenshots/002.png",
      snapshot: "snapshots/002.txt",
    },
    {
      ts: iso(-279_000),
      type: "step.recorded",
      index: 2,
      step: { click: { role: "link", name: "Profile" } },
    },
    {
      ts: iso(-279_000),
      type: "draft.updated",
      path: "draft.spec.yml",
      steps: 1,
    },
    {
      ts: iso(-270_000),
      type: "action.performed",
      index: 3,
      action: "fill",
      locator: { label: "Website" },
      ok: false,
      error: "element not found: label Website",
      urlBefore: "/profile",
      urlAfter: "/profile",
      durationMs: 5000,
      screenshot: "screenshots/003.png",
    },
    {
      ts: iso(-260_000),
      type: "action.performed",
      index: 4,
      action: "click",
      locator: { role: "button", name: "Save" },
      ok: true,
      urlBefore: "/profile",
      urlAfter: "/profile",
      durationMs: 610,
      screenshot: "screenshots/004.png",
      network: {
        mutations: [{ method: "PATCH", path: "/api/answers", status: 204 }],
      },
    },
    {
      ts: iso(-259_000),
      type: "step.recorded",
      index: 4,
      step: { click: { role: "button", name: "Save" } },
    },
    {
      ts: iso(-250_000),
      type: "action.performed",
      index: 5,
      action: "wait",
      ok: true,
      urlBefore: "/profile",
      urlAfter: "/profile",
      durationMs: 100,
    },
    {
      ts: iso(-249_000),
      type: "step.recorded",
      index: 5,
      step: { wait: { ms: 500 } },
    },
    { ts: iso(-248_000), type: "step.removed", index: 5 },
    {
      ts: iso(-247_000),
      type: "draft.updated",
      path: "draft.spec.yml",
      steps: 2,
    },
    {
      ts: iso(-200_000),
      type: "export.written",
      path: "flows/_drafts/profile_website.yml",
      verify: {
        status: "warnings",
        findings: ["literal lifted to ${vars.websiteValue}"],
      },
    },
  ]);

  const doneDir = path.join(runsRoot, "_sessions", DONE);
  write(
    doneDir,
    "session.json",
    JSON.stringify({
      version: 1,
      sessionId: DONE,
      kind: "accompany",
      pid: 4242,
      origin: "cli",
      startUrl: "/checkout",
      backend: "agent-browser",
      headed: true,
      status: "closed",
      openedAt: iso(-86_400_000),
      lastActivityAt: iso(-86_000_000),
      ttlMs: 30 * 60_000,
    }),
  );
  write(
    doneDir,
    "events.ndjson",
    `${JSON.stringify({ ts: iso(-86_400_000), type: "session.opened", sessionId: DONE, kind: "accompany" })}\n${JSON.stringify(
      {
        ts: iso(-86_000_000),
        type: "session.closed",
        reason: "shutdown",
        error: "setup failed: login_as_supplier",
      },
    )}\n`,
  );
});

/**
 * Bridge handlers backed by lib/authoring.js + the offset readers.
 * @param {Record<string, (...args: any[]) => any>} [extra]
 */
function sessionBridge(extra = {}) {
  const dirOf = (/** @type {any} */ options) => {
    const dir = authoring.resolveSessionRef(runsRoot, options?.sessionId);
    if (!dir) throw new Error("invalid session");
    return dir;
  };
  return env.installBridge({
    "sessions:list": () => ({
      runsRoot,
      sessionsDir: path.join(runsRoot, "_sessions"),
      sessions: authoring.listSessions(runsRoot),
    }),
    "session:get": (/** @type {any} */ options) =>
      authoring.readSessionDir(dirOf(options)),
    "session:events": (/** @type {any} */ options) =>
      runs.readEventsFrom(dirOf(options), Number(options?.offset ?? 0)),
    "session:text": (/** @type {any} */ options) => {
      const dir = dirOf(options);
      const rel = authoring.journalFile(dir, options?.path, "text");
      if (!rel) throw new Error("not a journal text file");
      return runs.readBoundedText(dir, rel);
    },
    "session:image": (/** @type {any} */ options) => {
      const dir = dirOf(options);
      const rel = authoring.journalFile(dir, options?.path, "image");
      if (!rel) throw new Error("not a journal image");
      return runs.readAsDataUrl(dir, rel);
    },
    "fs:reveal": () => null,
    ...extra,
  });
}

describe("Sessions view", () => {
  it("lists journals and follows the live one: timeline, preview, steps, draft, exports", async () => {
    configuredState();
    /** @type {any[]} */
    const exports = [];
    /** @type {any[]} */
    const promotes = [];
    sessionBridge({
      "session:export": (/** @type {any} */ options) => {
        exports.push(options);
        return {
          ok: true,
          exitCode: 0,
          meaning: "success",
          cli: `cairn discover export --from-session=${liveDir} --json`,
          payload: {
            path: "flows/_drafts/profile_website.yml",
            verifyOk: true,
            stepCount: 2,
            skippedFailed: 1,
            warnings: ["literal lifted to ${vars.websiteValue}"],
          },
        };
      },
      "spec:promote": (/** @type {any} */ options) => {
        promotes.push(options);
        return options.force
          ? {
              promoted: true,
              cancelled: false,
              ok: true,
              exitCode: 0,
              meaning: "success",
              draft: options.draft,
              to: path.join(projectDir, "flows", "profile_website.yml"),
              payload: {
                from: options.draft,
                to: "flows/profile_website.yml",
                intent: "draft",
                outcomes: [],
                contractHash: "sha256:abc",
              },
              warnings: [
                "promoted with --force: no green `cairn spec finish` of this content",
              ],
              cli: "cairn spec promote … --force --json",
            }
          : {
              promoted: false,
              cancelled: false,
              ok: false,
              exitCode: 4,
              meaning: "lint failure",
              error: "no green cairn spec finish for this draft",
              forceable: true,
              cli: "cairn spec promote … --json",
            };
      },
    });
    Studio.state.view = "sessions";
    const root = mountPoint();
    const handle = await Studio.views.sessions.render(root, {});
    try {
      const items = all(root, '.inv-list [role="option"]');
      assert.equal(items.length, 2);
      assert.equal(items[0].dataset.id, LIVE);
      assert.equal(items[0].getAttribute("aria-selected"), "true");
      assert.match(text(items[0]), /open/);
      assert.match(text(items[0]), /discovery/);
      assert.match(text(items[0]), /MCP agent · an-agent/);
      assert.match(text(items[0]), /live/);
      assert.match(text(items[0]), /\/profile/);
      assert.match(
        text(items[0]),
        /2 steps · 5 actions · env local · 1 export/,
      );
      assert.match(text(items[1]), /closed/);
      assert.match(text(items[1]), /accompany/);
      assert.ok(!/live/.test(text(items[1].querySelector(".inv-item-head"))));

      const detail =
        /** @type {HTMLElement} */ (root.querySelector(".ses-detail"));
      await env.waitFor(
        () => all(detail, ".ses-timeline .ses-action").length === 5,
        "the action timeline",
      );
      assert.match(text(detail), /use login_as_supplier/);
      const actions = all(detail, ".ses-timeline .ses-action");
      assert.ok(actions[2].classList.contains("failed"));
      assert.match(text(actions[2]), /element not found: label Website/);
      assert.match(text(actions[1]), /\/home → \/profile/);
      assert.match(text(actions[1]), /recorded/);
      assert.match(text(actions[3]), /PATCH \/api\/answers 204/);
      assert.match(text(actions[4]), /step removed/);
      assert.match(
        text(detail.querySelector(".section-title")),
        /5 · 1 failed/,
      );
      assert.ok(!/\bnull\b|undefined/.test(text(detail)), "no stray null");

      // Preview: the latest screenshot, thumbnails, the network log.
      await env.waitFor(
        () => detail.querySelector(".ses-shot img")?.getAttribute("src"),
        "the latest screenshot",
      );
      assert.match(
        String(detail.querySelector(".ses-shot img")?.getAttribute("src")),
        /^data:image\/png;base64,/,
      );
      assert.match(
        text(detail.querySelector(".ses-preview-head")),
        /#004 click \(latest\)/,
      );
      const thumbs = all(detail, ".ses-thumbs .ses-thumb");
      assert.equal(thumbs.length, 4);
      assert.equal(thumbs[3].getAttribute("aria-pressed"), "true");
      const network =
        /** @type {HTMLDetailsElement} */ (
          detail.querySelector(".ses-network")
        );
      assert.ok(!network.classList.contains("hidden"));
      assert.match(
        text(network.querySelector("summary")),
        /network\/004\.json/,
      );

      // Click an older thumbnail: preview pins it, its snapshot loads on open.
      thumbs[1].click();
      assert.match(
        text(detail.querySelector(".ses-preview-head")),
        /#002 click/,
      );
      const follow = all(detail, "button").find(
        (b) => text(b) === "Follow latest",
      );
      assert.ok(follow && !follow.classList.contains("hidden"));
      const snapshot =
        /** @type {HTMLDetailsElement} */ (
          detail.querySelector(".ses-snapshot")
        );
      assert.match(
        text(snapshot.querySelector("summary")),
        /snapshots\/002\.txt/,
      );
      snapshot.open = true;
      snapshot.dispatchEvent(new Event("toggle"));
      await env.waitFor(
        () => /link "Profile"/.test(text(snapshot.querySelector("pre"))),
        "the accessibility snapshot",
      );
      assert.ok(detail.querySelector('.ses-action.selected[data-index="2"]'));
      /** @type {HTMLElement} */ (follow).click();
      assert.match(text(detail.querySelector(".ses-preview-head")), /#004/);

      // Steps: recorded minus removed.
      const steps = all(detail, ".ses-steps .ses-step");
      assert.deepEqual(
        steps.map((row) => row.dataset.index),
        ["2", "4"],
      );
      assert.match(text(steps[1]), /click.*role: button, name: Save/);
      assert.match(
        text(detail.querySelector(".ses-steps-col")),
        /2 · 1 removed/,
      );

      // Draft: Studio did not see the earlier version → the added steps.
      await env.waitFor(
        () => /Steps the latest draft.updated added/.test(text(detail)),
        "the draft panel",
      );
      assert.match(
        text(detail.querySelector(".ses-draft-body")),
        /\+ #004 click/,
      );
      // A new draft.updated: the diff against the version Studio read.
      write(
        liveDir,
        "draft.spec.yml",
        DRAFT_V1.replace(
          "outcomes: []",
          "  - fill: { label: Website, value: ${vars.websiteValue} }\noutcomes: []",
        ),
      );
      appendEvents(liveDir, [
        {
          ts: iso(0),
          type: "action.performed",
          index: 6,
          action: "fill",
          locator: { label: "Website" },
          ok: true,
          urlBefore: "/profile",
          urlAfter: "/profile",
          durationMs: 300,
        },
        {
          ts: iso(0),
          type: "step.recorded",
          index: 6,
          step: { fill: { label: "Website", value: "${vars.websiteValue}" } },
        },
        { ts: iso(0), type: "draft.updated", path: "draft.spec.yml", steps: 3 },
      ]);
      await env.waitFor(
        () => detail.querySelector(".ses-diff .diff-add"),
        "the draft diff",
        4000,
      );
      assert.match(
        text(detail.querySelector(".ses-diff .diff-add")),
        /^\+\s+- fill: \{ label: Website/,
      );
      assert.match(
        text(detail.querySelector(".ses-diff-stats")),
        /\+1 −0 lines/,
      );
      const draftTabs = all(detail, '.ses-draft-tabs [role="tab"]');
      draftTabs[1].click();
      assert.match(
        text(detail.querySelector(".ses-draft-text")),
        /name: profile_website/,
      );
      assert.equal(all(detail, ".ses-timeline .ses-action").length, 6);

      // Exports: verify findings and Promote (refused → force offered).
      const exportRow =
        /** @type {HTMLElement} */ (detail.querySelector(".ses-export"));
      assert.match(text(exportRow), /verify warnings/);
      assert.match(text(exportRow), /literal lifted/);
      /** @type {HTMLElement} */ (
        all(exportRow, "button").find((b) => text(b) === "Promote…")
      ).click();
      await env.waitFor(() => promotes.length === 1, "the promote request");
      assert.deepEqual(promotes[0], {
        draft: path.join(projectDir, "flows", "_drafts", "profile_website.yml"),
        sessionId: LIVE,
        force: false,
      });
      await env.waitFor(
        () => /Promote refused/.test(text(detail.querySelector(".ses-result"))),
        "the refusal",
      );
      assert.match(
        text(detail.querySelector(".ses-result")),
        /no green cairn spec finish/,
      );
      /** @type {HTMLElement} */ (
        all(detail, ".ses-result button").find((b) =>
          /Promote anyway/.test(text(b)),
        )
      ).click();
      await env.waitFor(
        () => /Draft promoted/.test(text(detail.querySelector(".ses-result"))),
        "the promoted result",
      );
      assert.equal(promotes[1].force, true);
      assert.match(text(detail.querySelector(".ses-result")), /sha256:abc/);
      assert.match(
        text(detail.querySelector(".ses-result")),
        /warning: promoted with --force/,
      );
      const nav = recordNavigation();
      /** @type {HTMLElement} */ (
        all(detail, ".ses-result button").find(
          (b) => text(b) === "Open in Specs",
        )
      ).click();
      nav.off();
      assert.deepEqual(nav.seen[0], {
        view: "specs",
        params: { file: path.join(projectDir, "flows", "profile_website.yml") },
      });

      // Export draft (a re-export: the session kept a contract).
      const exportButton = /** @type {HTMLButtonElement} */ (
        all(detail, "button").find((b) => text(b) === "Export draft")
      );
      assert.equal(exportButton.disabled, false);
      exportButton.click();
      await env.waitFor(
        () => /Draft exported/.test(text(detail.querySelector(".ses-result"))),
        "the export result",
      );
      assert.deepEqual(exports[0], { sessionId: LIVE });
      assert.match(
        text(detail.querySelector(".ses-result")),
        /1 failed action\(s\)/,
      );
      assert.match(
        text(detail.querySelector(".ses-result")),
        /--from-session=/,
      );

      // Arrow keys move to the closed session: its close error shows.
      items[0].focus();
      env.press(items[0], "ArrowDown");
      const closed =
        /** @type {HTMLElement} */ (root.querySelector(".ses-detail"));
      await env.waitFor(
        () => /setup failed: login_as_supplier/.test(text(closed)),
        "the closed session's error",
      );
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });

  it("re-exports only after the agent's export, and reads an older cairn as one", async () => {
    configuredState();
    /** @type {any} */
    let answer = {
      ok: false,
      exitCode: 1,
      meaning: "error",
      unsupported: true,
      error: "error: unknown option '--from-session'",
      stderr: "error: unknown option '--from-session'\n",
      cli: "cairn discover export --json",
    };
    // A session whose only export moved (promoted since).
    const movedDir = path.join(runsRoot, "_sessions", "sess_moved001");
    const gone = path.join(projectDir, "flows", "_drafts", "gone.yml");
    write(
      movedDir,
      "session.json",
      JSON.stringify({
        version: 1,
        sessionId: "sess_moved001",
        kind: "discovery",
        pid: 4343,
        origin: "mcp",
        startUrl: "/",
        backend: "playwright",
        headed: false,
        status: "exported",
        openedAt: iso(-90_000_000),
        lastActivityAt: iso(-90_000_000),
        ttlMs: 30 * 60_000,
        exportedTo: [gone],
      }),
    );
    write(
      movedDir,
      "events.ndjson",
      `${JSON.stringify({ ts: iso(-90_000_000), type: "export.written", path: gone, verify: { status: "ok", findings: [] } })}\n`,
    );
    sessionBridge({ "session:export": () => answer });
    Studio.state.view = "sessions";
    try {
      // An accompany session never exports as a spec.
      let root = mountPoint();
      let handle = await Studio.views.sessions.render(root, {
        sessionId: DONE,
      });
      let detail =
        /** @type {HTMLElement} */ (root.querySelector(".ses-detail"));
      await env.waitFor(() => text(detail).includes("accompany"), "the head");
      let button = /** @type {HTMLButtonElement} */ (
        all(detail, "button").find((b) => text(b) === "Export draft")
      );
      assert.equal(button.disabled, true);
      assert.match(button.title, /only a discovery session/);
      /** @type {any} */ (handle)?.destroy?.();

      // Never exported by the agent (no contract kept): disabled, and why.
      root = mountPoint();
      handle = await Studio.views.sessions.render(root, {
        sessionId: "sess_moved001",
      });
      detail = /** @type {HTMLElement} */ (root.querySelector(".ses-detail"));
      await env.waitFor(
        () => detail.querySelector(".ses-export"),
        "the export row",
      );
      button = /** @type {HTMLButtonElement} */ (
        all(detail, "button").find((b) => text(b) === "Export draft")
      );
      assert.equal(button.disabled, true);
      assert.match(
        button.title,
        /comes from the agent \(cairn_discover_export/,
      );
      // Its export moved: no Promote, a "moved" tag instead.
      const row =
        /** @type {HTMLElement} */ (detail.querySelector(".ses-export"));
      assert.match(text(row), /moved/);
      assert.equal(
        all(row, "button").some((b) => /Promote|Open in Specs/.test(text(b))),
        false,
      );
      /** @type {any} */ (handle)?.destroy?.();

      // A re-export against a cairn that does not know the flag.
      root = mountPoint();
      handle = await Studio.views.sessions.render(root, { sessionId: LIVE });
      detail = /** @type {HTMLElement} */ (root.querySelector(".ses-detail"));
      await env.waitFor(
        () =>
          /** @type {HTMLButtonElement | undefined} */ (
            all(detail, "button").find((b) => text(b) === "Export draft")
          )?.disabled === false,
        "Export draft enabled",
      );
      /** @type {HTMLElement} */ (
        all(detail, "button").find((b) => text(b) === "Export draft")
      ).click();
      await env.waitFor(
        () =>
          /does not know `cairn discover export --from-session`/.test(
            text(detail),
          ),
        "the unsupported hint",
      );
      // A contract refusal reads whole, as the CLI wrote it.
      answer = {
        ok: false,
        exitCode: 4,
        meaning: "lint failure",
        unsupported: false,
        error:
          "cairn discover export: flows/_drafts/profile_website.yml already exists with a stamped contractHash (sha256:abc); pass overwrite:true (--overwrite) to replace it",
        stderr: "…",
        cli: "cairn discover export --json",
      };
      /** @type {HTMLElement} */ (
        all(detail, "button").find((b) => text(b) === "Export draft")
      ).click();
      await env.waitFor(
        () => /already exists with a stamped contractHash/.test(text(detail)),
        "the refusal",
      );
      assert.doesNotMatch(text(detail), /does not know/);
      /** @type {any} */ (handle)?.destroy?.();
    } finally {
      fs.rmSync(movedDir, { recursive: true, force: true });
    }
  });

  it("says what sessions are when there are none", async () => {
    configuredState();
    env.installBridge({
      "sessions:list": () => ({
        runsRoot: "/tmp/none",
        sessionsDir: "/tmp/none/_sessions",
        sessions: [],
      }),
    });
    Studio.state.view = "sessions";
    const root = mountPoint();
    const handle = await Studio.views.sessions.render(root, {});
    try {
      assert.match(text(root), /No sessions yet/);
      assert.match(text(root), /_sessions/);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });

  it("diffs drafts and folds sessions events like the CLI", () => {
    const view = Studio.sessionsView;
    const ops = view.lineDiff(
      "a\nb\nc\nd\ne\nf\ng\nh\ni\n",
      "a\nb\nc\nd\nX\nf\ng\nh\ni\nj\n",
    );
    assert.deepEqual(view.diffStats(ops), { added: 2, removed: 1 });
    const rows = view.diffRows(ops, 1);
    assert.deepEqual(
      rows.map((/** @type {any} */ row) =>
        "gap" in row ? `…${row.gap}` : `${row.op}${row.text}`,
      ),
      ["…3", " d", "-e", "+X", " f", "…2", " i", "+j"],
    );
    assert.deepEqual(view.diffRows(view.lineDiff("same\n", "same\n")), []);

    const model = view.applySessionEvents(view.createSessionModel(), [
      { type: "step.recorded", index: 1, step: { open: "/" } },
      { type: "draft.updated", path: "draft.spec.yml", steps: 1 },
      { type: "step.recorded", index: 2, step: { click: { text: "Go" } } },
      { type: "step.recorded", index: 3, step: { wait: { ms: 1 } } },
      { type: "step.removed", index: 3 },
      { type: "draft.updated", path: "draft.spec.yml", steps: 2 },
      { type: "something.new", index: 9 },
    ]);
    assert.deepEqual([...model.steps.keys()], [1, 2]);
    assert.equal(model.unknown, 1);
    assert.deepEqual(
      view
        .stepsSinceDraft(model)
        .map((/** @type {any} */ entry) => entry.index),
      [2],
    );
    assert.deepEqual(view.stepSummary({ id: "go", click: { text: "Go" } }), {
      kind: "click",
      text: "{text: Go}",
      id: "go",
    });
    assert.equal(
      view.setupText({ fromSpec: "flows/login.yml", untilStep: "logged_in" }),
      "steps of flows/login.yml through logged_in",
    );
    const exportModel = view.applySessionEvents(view.createSessionModel(), [
      {
        type: "export.written",
        path: "flows/_drafts/a.yml",
        verify: { status: "failed", findings: ["x"] },
      },
      {
        type: "export.written",
        path: "flows/_drafts/a.yml",
        verify: { status: "ok", findings: [] },
      },
    ]);
    const rowsOut = view.exportRows(exportModel, {
      exportedTo: ["/p/flows/_drafts/a.yml", "/p/flows/_drafts/b.yml"],
    });
    assert.deepEqual(
      rowsOut.map((/** @type {any} */ row) => [
        row.abs,
        row.verify?.status ?? null,
      ]),
      [
        ["/p/flows/_drafts/b.yml", null],
        ["/p/flows/_drafts/a.yml", "ok"],
      ],
    );
  });
});

// ── Catalog ────────────────────────────────────────────────────────────────

const LAST_GREEN = "2026-10-01T10-00-00-000Z_profile_aaaaaa";

function catalogPayload() {
  return {
    $schema: "urn:cairntrace.dev:catalog:v1",
    version: "1",
    project: "fixture",
    root: "/tmp/project",
    configPath: "/tmp/project/cairntrace.config.yml",
    kinds: ["actions", "vars", "verifiers", "envs", "flows", "checkpoints"],
    totals: {
      actions: 1,
      vars: 3,
      verifiers: 1,
      envs: 2,
      flows: 1,
      checkpoints: 1,
    },
    actions: [
      {
        name: "login_as_supplier",
        file: "flows/actions/login.yml",
        description: "Log in as the supplier test user",
        descriptionSource: "field",
        inputs: [
          { name: "email", required: true, declared: true, referenced: true },
          {
            name: "password",
            required: false,
            default: "[redacted]",
            declared: true,
            referenced: true,
            configEnvs: ["local"],
          },
        ],
        steps: 4,
        usedBy: [{ kind: "spec", name: "profile", file: "flows/profile.yml" }],
        lastGreenRun: {
          runId: LAST_GREEN,
          spec: "profile",
          status: "passed",
          startedAt: "2026-10-01T10:00:00.000Z",
        },
      },
    ],
    vars: [
      {
        name: "websiteFieldSelector",
        env: "local",
        value: "#website",
        comment: "the profile form field",
        definedIn: "environment",
        usedBy: [],
      },
      {
        name: "apiToken",
        env: "local",
        value: "[redacted]",
        masked: true,
        definedIn: "environment",
        usedBy: [],
      },
      {
        name: "websiteFieldSelector",
        env: "dev",
        value: "#website",
        definedIn: "inherited",
        inheritedFrom: "local",
        usedBy: [],
      },
    ],
    verifiers: [
      {
        file: "verifiers/profile-persisted.ts",
        exists: true,
        description: "Checks the profile value survived a reload",
        fixtures: {
          source: "header",
          keys: [{ name: "field", required: true, source: "header" }],
        },
        usedBy: [
          {
            spec: "profile",
            file: "flows/profile.yml",
            outcome: "persisted",
            runtime: "node",
            fixtureKeys: ["field"],
            missingKeys: [],
          },
        ],
      },
    ],
    envs: [
      {
        name: "local",
        default: true,
        baseUrl: "http://localhost:3000",
        policy: { trait: "owned", mutations: "allow" },
        services: { enabled: true, phases: ["docker", "seed", "tmux"] },
        vars: 2,
      },
      {
        name: "dev",
        default: false,
        baseUrl: "https://dev.example.test",
        policy: { trait: "shared", mutations: "deny" },
        services: { enabled: false, phases: [] },
        secrets: { provider: "tvault", keys: ["API_TOKEN"] },
        vars: 1,
      },
    ],
    flows: [
      {
        name: "profile_website",
        file: "flows/_drafts/profile_website.yml",
        intent: "supplier edits the website field and it persists",
        draft: true,
        requires: { env: ["local"], mutates: true },
        actions: ["login_as_supplier"],
        lastRun: {
          runId: LAST_GREEN,
          spec: "profile_website",
          status: "failed",
          startedAt: "2026-10-01T10:00:00.000Z",
        },
      },
    ],
    checkpoints: [
      {
        name: "supplier",
        health: "expired",
        scope: { env: "local", baseUrl: "http://localhost:3000" },
        problem: { code: "expired", message: "past its TTL: recapture it" },
        usedBy: [],
      },
    ],
    scan: { files: 12, specs: 3, actions: 1, runs: 5 },
    warnings: ["1 action reads a var it does not declare"],
  };
}

describe("Catalog view", () => {
  it("renders every kind as a tab, searches with --query, and clicks through", async () => {
    configuredState({
      environments: [{ name: "local" }, { name: "dev" }],
    });
    /** @type {any[]} */
    const asked = [];
    /** @type {any[]} */
    const revealed = [];
    env.installBridge({
      "catalog:get": (/** @type {any} */ options) => {
        asked.push(options);
        return {
          ok: true,
          exitCode: 0,
          meaning: "success",
          cli: "cairn catalog --json",
          payload: catalogPayload(),
        };
      },
      "fs:reveal": (/** @type {string} */ target) => {
        revealed.push(target);
        return target;
      },
    });
    Studio.catalogView.filters.query = "";
    Studio.catalogView.filters.env = "";
    Studio.catalogView.filters.tab = "actions";
    const root = mountPoint();
    const handle = await Studio.views.catalog.render(root, {});
    try {
      assert.deepEqual(asked[0], { query: "", env: null, limit: null });
      assert.match(text(root), /cairn catalog --json/);
      const tabs = all(root, '.catalog-tabs [role="tab"]');
      assert.deepEqual(tabs.map(text), [
        "Actions1",
        "Vars3",
        "Verifiers1",
        "Environments2",
        "Flows1",
        "Checkpoints1",
      ]);
      assert.equal(tabs[0].getAttribute("aria-selected"), "true");
      const action = /** @type {HTMLElement} */ (
        root.querySelector(".catalog-actions tbody tr")
      );
      assert.match(text(action), /login_as_supplier/);
      assert.match(text(action), /Log in as the supplier test user/);
      assert.deepEqual(all(action, ".catalog-input").map(text), [
        "email*",
        "password",
      ]);
      assert.match(text(action), /1 use/);
      assert.match(
        text(root.querySelector(".catalog-warnings")),
        /does not declare/,
      );
      // No stray "null" / "undefined" text from optional pieces.
      assert.ok(
        !/\bnull\b|undefined/.test(text(root.querySelector(".catalog-body"))),
      );

      // Files reveal; last runs open in Run detail.
      /** @type {HTMLElement} */ (
        action.querySelector(".catalog-file")
      ).click();
      assert.deepEqual(revealed, ["/tmp/project/flows/actions/login.yml"]);
      const nav = recordNavigation();
      /** @type {HTMLElement} */ (action.querySelector(".catalog-run")).click();
      assert.deepEqual(nav.seen[0], {
        view: "run",
        params: { runRef: LAST_GREEN },
      });

      // Vars, grouped per environment; masked values never show.
      tabs[1].click();
      const groups = all(root, ".catalog-vars .catalog-group");
      assert.deepEqual(
        groups.map((row) => row.dataset.env),
        ["local", "dev"],
      );
      assert.match(text(root.querySelector(".catalog-vars")), /masked/);
      assert.ok(
        !/\[redacted\]/.test(text(root.querySelector(".catalog-vars"))),
      );
      assert.match(
        text(root.querySelector(".catalog-vars")),
        /inherited from local/,
      );
      // Arrow keys move between tabs.
      const varsTab =
        /** @type {HTMLElement} */ (root.querySelector('[data-tab="vars"]'));
      varsTab.focus();
      env.press(varsTab, "ArrowRight");
      assert.equal(
        root
          .querySelector('[data-tab="verifiers"]')
          ?.getAttribute("aria-selected"),
        "true",
      );
      assert.match(
        text(root.querySelector(".catalog-verifiers")),
        /profile · persisted/,
      );

      // Flows open in Specs.
      /** @type {HTMLElement} */ (
        root.querySelector('[data-tab="flows"]')
      ).click();
      const flow = /** @type {HTMLElement} */ (
        root.querySelector(".catalog-flows tbody tr")
      );
      assert.match(text(flow), /draft/);
      assert.match(text(flow), /env local · mutates/);
      /** @type {HTMLElement} */ (
        all(flow, "button").find((b) => text(b) === "Open")
      ).click();
      nav.off();
      assert.deepEqual(nav.seen.at(-1), {
        view: "specs",
        params: { file: "/tmp/project/flows/_drafts/profile_website.yml" },
      });

      /** @type {HTMLElement} */ (
        root.querySelector('[data-tab="checkpoints"]')
      ).click();
      assert.match(text(root.querySelector(".catalog-checkpoints")), /expired/);
      assert.match(
        text(root.querySelector(".catalog-checkpoints")),
        /past its TTL/,
      );
      /** @type {HTMLElement} */ (
        root.querySelector('[data-tab="envs"]')
      ).click();
      assert.match(
        text(root.querySelector(".catalog-envs")),
        /docker → seed → tmux/,
      );
      assert.match(
        text(root.querySelector(".catalog-envs")),
        /mutations denied/,
      );

      // Search (Enter) and environment pass straight to cairn catalog.
      const search =
        /** @type {HTMLInputElement} */ (root.querySelector(".catalog-search"));
      search.value = "website field";
      env.press(search, "Enter");
      await env.waitFor(() => asked.length === 2, "the search");
      assert.deepEqual(asked[1], {
        query: "website field",
        env: null,
        limit: 50,
      });
      const select =
        /** @type {HTMLSelectElement} */ (root.querySelector("select"));
      select.value = "local";
      select.dispatchEvent(new Event("change"));
      await env.waitFor(() => asked.length === 3, "the env change");
      assert.deepEqual(asked[2], {
        query: "website field",
        env: "local",
        limit: 50,
      });
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
      Studio.catalogView.filters.query = "";
      Studio.catalogView.filters.env = "";
    }
  });

  it("says when this cairn has no catalog", async () => {
    configuredState();
    env.installBridge({
      "catalog:get": () => ({
        ok: false,
        exitCode: 1,
        meaning: "outcome failure",
        unsupported: true,
        stderr: "error: unknown command 'catalog'",
        cli: "cairn catalog --json",
      }),
    });
    const root = mountPoint();
    const handle = await Studio.views.catalog.render(root, {});
    try {
      assert.match(text(root), /This cairn has no catalog/);
      assert.match(text(root), /unknown command 'catalog'/);
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });

  it("drops an environment the newly opened project does not have", async () => {
    /** @type {any[]} */
    const asked = [];
    env.installBridge({
      "catalog:get": (/** @type {any} */ options) => {
        asked.push(options);
        return {
          ok: true,
          exitCode: 0,
          meaning: "success",
          cli: "cairn catalog --json",
          payload: catalogPayload(),
        };
      },
    });
    // Picked in project A…
    configuredState({ environments: [{ name: "staging" }] });
    Studio.catalogView.filters.query = "";
    Studio.catalogView.filters.env = "staging";
    let handle = await Studio.views.catalog.render(mountPoint(), {});
    /** @type {any} */ (handle)?.destroy?.();
    assert.equal(asked[0].env, "staging");
    // …then project B (no "staging") opens: never sent as --env.
    configuredState({ environments: [{ name: "local" }] });
    const root = mountPoint();
    handle = await Studio.views.catalog.render(root, {});
    try {
      assert.equal(asked[1].env, null);
      assert.equal(Studio.catalogView.filters.env, "");
      const select = /** @type {HTMLSelectElement} */ (
        root.querySelector(
          'select[aria-label="environment for vars and last runs"]',
        )
      );
      assert.equal(select.value, "");
    } finally {
      /** @type {any} */ (handle)?.destroy?.();
    }
  });
});

// ── Environment: services up / down ────────────────────────────────────────

describe("Environment view services controls", () => {
  it("shows each environment's services lock and runs services up/down", async () => {
    configuredState({
      hasServices: true,
      environments: [
        {
          name: "local",
          baseUrl: "http://localhost:3000",
          policy: { trait: "owned" },
        },
        {
          name: "dev",
          baseUrl: "https://dev.example.test",
          disabled: true,
          policy: null,
        },
      ],
    });
    /** @type {any[]} */
    const ups = [];
    env.installBridge({
      "app:info": () => ({
        appVersion: "0.0.0-test",
        cairn: { command: "/usr/local/bin/cairn", source: "path" },
        runsRoot: { runsRoot: "/tmp/runs", source: "default" },
      }),
      "cairn:doctor": () => ({ ok: true, payload: { ok: true, checks: [] } }),
      "services:status": () => ({ ok: true, payload: { hasServices: true } }),
      "checkpoints:list": () => ({ ok: true, payload: { checkpoints: [] } }),
      "services:lock": (/** @type {any} */ options) => ({
        env: options.env,
        ok: true,
        busy: null,
        lock: {
          state: "held",
          path: "/locks/fixture.local.lock.json",
          ageSeconds: 300,
          lock: {
            by: "mcp",
            pid: 77,
            startedAt: new Date(Date.now() - 300_000).toISOString(),
          },
        },
      }),
      "services:up": (/** @type {any} */ options) => {
        ups.push(options);
        return {
          cancelled: false,
          ok: true,
          exitCode: 0,
          payload: {
            phases: { docker: "reused", seed: "skipped", tmux: "created" },
            durationMs: 4200,
            warnings: [],
          },
        };
      },
    });
    Studio.state.view = "doctor";
    const root = mountPoint();
    await Studio.views.doctor.render(root);
    const local = /** @type {HTMLElement} */ (
      root.querySelector('tr.env-row[data-env="local"]')
    );
    const dev = /** @type {HTMLElement} */ (
      root.querySelector('tr.env-row[data-env="dev"]')
    );
    await env.waitFor(
      () => /held/.test(text(local.querySelector(".services-lock"))),
      "the lock cell",
    );
    assert.match(text(local.querySelector(".services-lock")), /mcp · pid 77/);
    assert.match(text(local.querySelector(".services-lock")), /since/);
    assert.ok(!/\bnull\b|undefined/.test(text(local)));
    assert.match(text(dev), /services off/);
    assert.equal(all(dev, "button").length, 0);
    const up = /** @type {HTMLElement} */ (
      all(local, "button").find((b) => text(b) === "Services up")
    );
    assert.ok(all(local, "button").some((b) => text(b) === "Services down"));
    up.click();
    await env.waitFor(() => ups.length === 1, "services:up");
    assert.deepEqual(ups[0], { env: "local" });
    await env.waitFor(
      () => /Services up · local/.test(text(document.getElementById("toasts"))),
      "the toast",
    );
    assert.match(
      text(document.getElementById("toasts")),
      /docker reused · seed skipped · tmux created/,
    );
  });
});
