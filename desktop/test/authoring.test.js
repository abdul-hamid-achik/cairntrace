/**
 * lib/authoring.js: session journals (listing, liveness, the files a
 * renderer may read), the argv Studio spawns for export / promote / catalog
 * / services (renderer values joined to their flag, never a flag of their
 * own), draft resolution inside the project, and the confirmation texts.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { after, describe, it } = require("node:test");

const authoring = require("../lib/authoring");
const { cleanup, tempDir, write } = require("./helpers");

after(() => cleanup());

const NOW = Date.parse("2026-10-02T12:00:00.000Z");

/**
 * @param {Record<string, any>} [overrides]
 * @returns {Record<string, any>}
 */
function sessionJson(overrides = {}) {
  return {
    version: 1,
    sessionId: "sess_alpha01",
    kind: "discovery",
    pid: 4242,
    origin: "mcp",
    client: "claude-code/2.1",
    startUrl: "${env.baseUrl}/login",
    backend: "playwright",
    headed: false,
    env: "local",
    status: "open",
    openedAt: "2026-10-02T11:50:00.000Z",
    lastActivityAt: "2026-10-02T11:58:00.000Z",
    ttlMs: 30 * 60_000,
    setup: [{ use: "login_as_supplier", vars: { email: "[redacted]" } }],
    stepCount: 3,
    actionCount: 4,
    ...overrides,
  };
}

/**
 * @param {string} runsRoot
 * @param {string} id
 * @param {Record<string, any>} [overrides]
 */
function makeSession(runsRoot, id, overrides = {}) {
  return write(
    runsRoot,
    `_sessions/${id}/session.json`,
    JSON.stringify(sessionJson({ sessionId: id, ...overrides })),
  );
}

describe("authoring: session ids and journal paths", () => {
  it("accepts the CLI's ids and nothing that reads as a path", () => {
    assert.ok(authoring.isSessionId("sess_alpha01"));
    assert.ok(authoring.isSessionId("0f8e2a44-1c9b-4b7a-9d1e-5a6b7c8d9e0f"));
    for (const bad of [
      "",
      "abc",
      "../escape",
      "a/b/c/d/e/f",
      "-flagged1",
      ".hidden1",
      "x".repeat(200),
    ])
      assert.equal(authoring.isSessionId(bad), false, bad);
  });

  it("resolves an id or the exact journal folder, nothing else", () => {
    const root = tempDir("cairn-auth-");
    const dir = path.join(root, "_sessions", "sess_alpha01");
    assert.equal(authoring.resolveSessionRef(root, "sess_alpha01"), dir);
    assert.equal(authoring.resolveSessionRef(root, dir), dir);
    assert.equal(authoring.resolveSessionRef(root, `${dir}/screenshots`), null);
    assert.equal(
      authoring.resolveSessionRef(root, path.join(root, "sess_alpha01")),
      null,
    );
    assert.equal(
      authoring.resolveSessionRef(
        root,
        path.join(root, "_invocations", "sess_alpha01"),
      ),
      null,
    );
    assert.equal(
      authoring.resolveSessionRef(root, "/elsewhere/_sessions/sess_alpha01"),
      null,
    );
    assert.equal(authoring.resolveSessionRef(root, "../sess"), null);
    assert.equal(authoring.resolveSessionRef(root, 42), null);
  });

  it("lets the renderer read only journal text and image files", () => {
    const dir = "/tmp/runs/_sessions/sess_alpha01";
    assert.equal(
      authoring.journalFile(dir, "snapshots/003.txt", "text"),
      "snapshots/003.txt",
    );
    assert.equal(
      authoring.journalFile(dir, "network/003.json", "text"),
      "network/003.json",
    );
    assert.equal(
      authoring.journalFile(dir, "draft.spec.yml", "text"),
      "draft.spec.yml",
    );
    assert.equal(
      authoring.journalFile(dir, "screenshots/003.png", "image"),
      "screenshots/003.png",
    );
    for (const bad of [
      "../other/session.json",
      "/etc/passwd",
      "screenshots/003.png",
      ".session.json.4242.tmp",
      "snapshots/../../x.txt",
      "setup/run/video.webm",
      "",
    ])
      assert.equal(authoring.journalFile(dir, bad, "text"), null, bad);
    assert.equal(authoring.journalFile(dir, "draft.spec.yml", "image"), null);
  });
});

describe("authoring: session listing and liveness", () => {
  it("lists journals newest first with what Studio shows", () => {
    const root = tempDir("cairn-auth-");
    makeSession(root, "sess_older01", {
      openedAt: "2026-10-01T09:00:00.000Z",
      status: "exported",
      exportedTo: ["/p/flows/_drafts/a.yml"],
    });
    makeSession(root, "sess_newer01");
    write(root, "_sessions/sess_newer01/draft.spec.yml", "intent: x\n");
    // not journals: a bad id, a file, a folder without session.json
    write(root, "_sessions/bad id/session.json", "{}");
    write(root, "_sessions/loose.txt", "x");
    fs.mkdirSync(path.join(root, "_sessions", "sess_empty01"), {
      recursive: true,
    });
    write(root, "_sessions/sess_corrupt/session.json", "{not json");
    const list = authoring.listSessions(root, {
      now: NOW,
      pidAlive: () => true,
    });
    assert.deepEqual(
      list.map((session) => session.sessionId),
      ["sess_newer01", "sess_older01"],
    );
    const [newest, older] = list;
    assert.equal(newest.kind, "discovery");
    assert.equal(newest.origin, "mcp");
    assert.equal(newest.client, "claude-code/2.1");
    assert.equal(newest.startUrl, "${env.baseUrl}/login");
    assert.equal(newest.hasDraft, true);
    assert.deepEqual(newest.setup, [
      { use: "login_as_supplier", vars: ["email"] },
    ]);
    assert.equal(newest.liveness.state, "live");
    assert.equal(older.liveness.state, "ended");
    assert.deepEqual(older.exportedTo, ["/p/flows/_drafts/a.yml"]);
    assert.equal(authoring.listSessions(root, { limit: 1 }).length, 1);
    assert.deepEqual(authoring.listSessions(path.join(root, "missing")), []);
  });

  it("judges liveness from status, pid, last activity and TTL", () => {
    const base = /** @type {any} */ ({
      status: "open",
      pid: 4242,
      lastActivityAt: "2026-10-02T11:58:00.000Z",
      openedAt: "2026-10-02T11:50:00.000Z",
      ttlMs: 30 * 60_000,
    });
    const live = authoring.sessionLiveness(base, {
      now: NOW,
      pidAlive: () => true,
    });
    assert.equal(live.state, "live");
    assert.equal(live.idleMs, 2 * 60_000);
    assert.equal(live.expiresAt, "2026-10-02T12:28:00.000Z");
    assert.equal(
      authoring.sessionLiveness(base, { now: NOW, pidAlive: () => false })
        .state,
      "dead",
    );
    assert.equal(
      authoring.sessionLiveness(
        { ...base, lastActivityAt: "2026-10-02T11:00:00.000Z" },
        { now: NOW, pidAlive: () => true },
      ).state,
      "idle",
    );
    assert.equal(
      authoring.sessionLiveness(
        {
          ...base,
          pid: null,
          ttlMs: 0,
          lastActivityAt: "2026-10-02T10:00:00.000Z",
        },
        { now: NOW },
      ).state,
      "stale",
    );
    for (const status of ["expired", "closed", "exported"]) {
      const verdict = authoring.sessionLiveness(
        { ...base, status },
        { now: NOW, pidAlive: () => true },
      );
      assert.equal(verdict.state, "ended");
      assert.equal(verdict.reason, status);
    }
  });
});

describe("authoring: argv builders", () => {
  it("export passes the earlier contract (absolute files, joined flags)", () => {
    assert.deepEqual(
      authoring.buildSessionExportArgv({
        sessionDir: "/r/_sessions/sess_alpha01",
        intent: "--path=/etc/evil the supplier saves a website",
        outcomesFile: "/tmp/x/outcomes.json",
        path: "/p/flows/_drafts/website.yml",
        config: "/p/cairntrace.config.yml",
      }),
      [
        "discover",
        "export",
        "--from-session=/r/_sessions/sess_alpha01",
        "--intent=--path=/etc/evil the supplier saves a website",
        "--outcomes=/tmp/x/outcomes.json",
        "--path=/p/flows/_drafts/website.yml",
        "--config=/p/cairntrace.config.yml",
        "--json",
      ],
    );
    assert.deepEqual(
      authoring.buildSessionExportArgv({
        sessionDir: "/r/_sessions/sess_alpha01",
        intent: "x",
        outcomesFile: "/tmp/o.json",
      }),
      [
        "discover",
        "export",
        "--from-session=/r/_sessions/sess_alpha01",
        "--intent=x",
        "--outcomes=/tmp/o.json",
        "--json",
      ],
    );
    const ok = { sessionDir: "/r/s", intent: "x", outcomesFile: "/o.json" };
    assert.throws(() =>
      authoring.buildSessionExportArgv({ ...ok, sessionDir: "relative/dir" }),
    );
    assert.throws(() =>
      authoring.buildSessionExportArgv({ ...ok, intent: " " }),
    );
    assert.throws(() =>
      authoring.buildSessionExportArgv({ ...ok, outcomesFile: "o.json" }),
    );
    assert.throws(() =>
      authoring.buildSessionExportArgv({ ...ok, path: "flows/a.yml" }),
    );
  });

  it("re-exports only a session that kept a contract from its last export", () => {
    const dir = path.join(tempDir("cairn-auth-"), "_sessions", "sess_alpha01");
    const base = {
      version: 1,
      sessionId: "sess_alpha01",
      kind: "discovery",
      status: "closed",
    };
    write(dir, "session.json", JSON.stringify(base));
    assert.equal(authoring.sessionContract(dir), null);
    assert.equal(authoring.readSessionDir(dir)?.reexportable, false);
    const outcomes = [
      { id: "saved", description: "d", verify: { text: { contains: "x" } } },
    ];
    write(
      dir,
      "session.json",
      JSON.stringify({ ...base, intent: "it saves", outcomes }),
    );
    assert.deepEqual(authoring.sessionContract(dir), {
      intent: "it saves",
      outcomes,
    });
    assert.equal(authoring.readSessionDir(dir)?.reexportable, true);
    for (const bad of [
      { intent: "", outcomes },
      { intent: "x", outcomes: [] },
      { intent: "x", outcomes: [{ description: "no id" }] },
      { intent: "x", outcomes: ["saved"] },
    ]) {
      write(dir, "session.json", JSON.stringify({ ...base, ...bad }));
      assert.equal(authoring.sessionContract(dir), null, JSON.stringify(bad));
    }
    // accompany sessions never export as a spec
    write(
      dir,
      "session.json",
      JSON.stringify({ ...base, kind: "accompany", intent: "x", outcomes }),
    );
    assert.equal(authoring.readSessionDir(dir)?.reexportable, false);
  });

  it("lists exports that no longer exist", () => {
    const base = tempDir("cairn-auth-");
    const dir = path.join(base, "_sessions", "sess_alpha01");
    const kept = write(base, "flows/_drafts/kept.yml", "intent: x\n");
    const gone = path.join(base, "flows", "_drafts", "gone.yml");
    write(
      dir,
      "session.json",
      JSON.stringify({
        version: 1,
        sessionId: "sess_alpha01",
        kind: "discovery",
        status: "exported",
        exportedTo: [kept, gone],
      }),
    );
    assert.deepEqual(authoring.readSessionDir(dir)?.exportedMissing, [gone]);
  });

  it("promote takes an absolute draft and --force only when asked", () => {
    assert.deepEqual(authoring.buildPromoteArgv("/p/flows/_drafts/a.yml"), [
      "spec",
      "promote",
      "/p/flows/_drafts/a.yml",
      "--json",
    ]);
    assert.deepEqual(
      authoring.buildPromoteArgv("/p/flows/_drafts/a.yml", { force: true }),
      ["spec", "promote", "/p/flows/_drafts/a.yml", "--force", "--json"],
    );
    const hash = "a".repeat(64);
    assert.deepEqual(
      authoring.buildPromoteArgv("/p/flows/_drafts/a.yml", {
        expectContentHash: hash,
      }),
      [
        "spec",
        "promote",
        "/p/flows/_drafts/a.yml",
        `--expect-content-hash=${hash}`,
        "--json",
      ],
    );
    assert.throws(() =>
      authoring.buildPromoteArgv("/p/flows/_drafts/a.yml", {
        expectContentHash: "--force",
      }),
    );
    assert.throws(() => authoring.buildPromoteArgv("--force"));
  });

  it("catalog joins the query to its flag and validates the environment", () => {
    assert.deepEqual(
      authoring.buildCatalogArgv({
        query: "  --config=/etc/evil\n edit  website ",
        env: "local",
        limit: 50,
        config: "/p/cairntrace.config.yml",
      }),
      [
        "catalog",
        "--query=--config=/etc/evil edit website",
        "--env=local",
        "--limit=50",
        "--config=/p/cairntrace.config.yml",
        "--json",
      ],
    );
    assert.deepEqual(authoring.buildCatalogArgv({}), ["catalog", "--json"]);
    assert.throws(() => authoring.buildCatalogArgv({ env: "--all" }));
    assert.throws(() => authoring.buildCatalogArgv({ env: "a b" }));
  });

  it("services up/down/status name one environment", () => {
    assert.deepEqual(authoring.buildServicesArgv("up", { env: "local" }), [
      "services",
      "up",
      "--env=local",
      "--json",
    ]);
    assert.deepEqual(
      authoring.buildServicesArgv("down", {
        env: "dev.eu-1",
        config: "/p/c.yml",
      }),
      ["services", "down", "--env=dev.eu-1", "--config=/p/c.yml", "--json"],
    );
    assert.throws(() =>
      authoring.buildServicesArgv(/** @type {any} */ ("restart"), {
        env: "local",
      }),
    );
    assert.throws(() => authoring.buildServicesArgv("up", { env: "" }));
    assert.throws(() => authoring.buildServicesArgv("up", { env: "-x" }));
  });

  it("recognizes a cairn that lacks the command (commander's first line only)", () => {
    assert.equal(
      authoring.looksUnsupported({
        ok: false,
        stderr: "error: unknown command 'promote'\n",
      }),
      true,
    );
    assert.equal(
      authoring.looksUnsupported({
        ok: false,
        stderr: "\nerror: unknown option '--from-session'\n",
      }),
      true,
    );
    // A contract refusal is a refusal, not an old binary.
    assert.equal(
      authoring.looksUnsupported({
        ok: false,
        stderr:
          "cairn discover export: --from-session, --intent and --outcomes are required",
      }),
      false,
    );
    // services up streams docker / seed / tmux output to stderr.
    assert.equal(
      authoring.looksUnsupported({
        ok: false,
        stderr:
          "[docker] starting db\n[seed] error: unknown option '--fast'\ntmux: unknown command 'x'\n",
      }),
      false,
    );
    assert.equal(
      authoring.looksUnsupported({ ok: false, stderr: "verify failed" }),
      false,
    );
    assert.equal(
      authoring.looksUnsupported({ ok: true, stderr: "unknown command" }),
      false,
    );
  });
});

describe("authoring: drafts and dialogs", () => {
  it("resolves a draft only to a YAML file inside the project", () => {
    const base = tempDir("cairn-auth-");
    const project = path.join(base, "project");
    const draft = write(project, "flows/_drafts/profile.yml", "intent: x\n");
    write(base, "outside/evil.yml", "intent: x\n");
    write(project, "flows/_drafts/notes.txt", "x");
    const context = { projectDir: project };
    assert.equal(authoring.resolveDraftPath(draft, context), draft);
    assert.equal(
      authoring.resolveDraftPath("flows/_drafts/profile.yml", context),
      draft,
    );
    assert.equal(
      authoring.resolveDraftPath(
        path.join(base, "outside", "evil.yml"),
        context,
      ),
      null,
    );
    assert.equal(
      authoring.resolveDraftPath("../outside/evil.yml", context),
      null,
    );
    assert.equal(
      authoring.resolveDraftPath("flows/_drafts/notes.txt", context),
      null,
    );
    assert.equal(
      authoring.resolveDraftPath("flows/_drafts/missing.yml", context),
      null,
    );
    assert.equal(authoring.resolveDraftPath("", context), null);
    // relative to the session's config folder, or matched in exportedTo
    const nested = path.join(project, "suite");
    const inSuite = write(nested, "flows/_drafts/b.yml", "intent: y\n");
    assert.equal(
      authoring.resolveDraftPath("flows/_drafts/b.yml", {
        projectDir: project,
        session: { configPath: path.join(nested, "cairntrace.config.yml") },
      }),
      inSuite,
    );
    assert.equal(
      authoring.resolveDraftPath("_drafts/b.yml", {
        projectDir: project,
        session: { exportedTo: [inSuite] },
      }),
      inSuite,
    );
  });

  it("shows the contract a promote will stamp, verify parameters included", () => {
    const outcomes = Array.from({ length: 25 }, (_, i) => [
      `  - id: extra_${i + 1}`,
      "    description: more",
      "    verify:",
      `      url: { matches: "/step/${i + 1}" }`,
    ]).flat();
    const contract = authoring.draftContract(
      [
        "name: profile",
        "intent: supplier edits the website field and it persists",
        "outcomes:",
        "  - id: website_saved",
        "    description: the new value is shown",
        "    verify:",
        "      text: { contains: saved }",
        "  - id: persisted_after_reload",
        "    description: still there",
        "    verify:",
        "      text: { contains: '' }",
        ...outcomes,
        "steps:",
        "  - open: /",
      ].join("\n"),
    );
    const text = authoring.promoteDialogText({
      draft: "/p/flows/_drafts/profile.yml",
      projectDir: "/p",
      contract,
      cli: "cairn spec promote /p/flows/_drafts/profile.yml --json",
    });
    assert.match(text, /^flows\/_drafts\/profile\.yml/);
    assert.match(text, /intent: supplier edits the website field/);
    assert.match(text, /outcomes \(27\):/);
    assert.match(
      text,
      / - website_saved: the new value is shown\n\s+verify: \{ text: \{ contains: saved \} \}/,
    );
    // an empty expectation reads differently from a real one
    assert.match(
      text,
      / - persisted_after_reload: still there\n\s+verify: \{ text: \{ contains: "" \} \}/,
    );
    // every outcome, none cut off
    assert.match(
      text,
      / - extra_25: more\n\s+verify: \{ url: \{ matches: \/step\/25 \} \}/,
    );
    assert.doesNotMatch(text, /… \d+ more/);
    assert.match(text, /stamps its contract hash/);
    assert.match(text, /refuses a draft without a green/);
    assert.match(text, /cairn spec promote \/p\/flows/);
    // a huge parameter is cut, and says so
    const huge = authoring.contractLines({
      intent: "x",
      outcomes: [
        { id: "big", verify: { text: { contains: "y".repeat(900) } } },
      ],
    });
    assert.match(huge.join("\n"), /… \(\d+ more characters; see the file\)/);
    const forced = authoring.promoteDialogText({
      draft: "/p/a.yml",
      projectDir: "/p",
      contract: authoring.draftContract("intent: [unclosed"),
      force: true,
      cli: "x",
    });
    assert.match(forced, /does not parse \(/);
    assert.match(forced, /--force: promotes without a green/);
  });

  it("applies the CLI's draft rule before asking, and offers --force only for the finish gate", () => {
    const project = tempDir("cairn-auth-");
    const config = path.join(project, "cairntrace.config.yml");
    const context = { projectDir: project, configPath: config, config: {} };
    for (const draft of [
      "flows/_drafts/a.yml",
      "flows/_drafts/nested/b.yml",
      "flows/_wip/c.yml",
      "_scratch.yml",
    ])
      assert.equal(
        authoring.isPromotableDraft(path.join(project, draft), context),
        true,
        draft,
      );
    for (const notDraft of [
      "cairntrace.config.yml",
      "flows/real.yml",
      "flows/drafts/a.yml",
    ])
      assert.equal(
        authoring.isPromotableDraft(path.join(project, notDraft), context),
        false,
        notDraft,
      );
    // authoring.draftsDir moves the drafts folder (relative to the config)
    const custom = {
      ...context,
      config: { raw: { authoring: { draftsDir: "specs/pending" } } },
    };
    assert.equal(
      authoring.isPromotableDraft(
        path.join(project, "specs/pending/a.yml"),
        custom,
      ),
      true,
    );
    assert.equal(
      authoring.isPromotableDraft(
        path.join(project, "flows/_drafts/a.yml"),
        custom,
      ),
      true,
      "a _ folder is still a draft",
    );

    assert.equal(
      authoring.promoteForceable({
        ok: false,
        stderr:
          "cairn spec promote: refusing to promote flows/_drafts/a.yml: no `cairn spec finish` ran for it. Run `cairn spec finish flows/_drafts/a.yml` until it is green (or pass --force)\n",
      }),
      true,
    );
    for (const stderr of [
      "cairn spec promote: flows/real.yml is not a draft: drafts live in flows/_drafts",
      "cairn spec promote: flows/a.yml already exists; pass --to <another path> (promote never replaces a spec)",
      'cairn spec promote: cannot stamp flows/a.yml: [\n  {\n    "message": "Invalid input"\n  }\n] (the draft was left in place)',
    ])
      assert.equal(authoring.promoteForceable({ ok: false, stderr }), false);

    // a refusal reads from its first line, bounded
    const zod =
      'cairn spec promote: cannot stamp flows/a.yml: [\n  {\n    "message": "Invalid input"\n  }\n] (the draft was left in place)\n';
    assert.match(
      authoring.refusalText(zod) ?? "",
      /^cairn spec promote: cannot stamp flows\/a\.yml[\s\S]*the draft was left in place\)$/,
    );
    assert.equal(authoring.refusalText("  "), null);
    assert.ok((authoring.refusalText("x".repeat(5000)) ?? "").length <= 2001);
    assert.notEqual(
      authoring.contentHash("intent: a\n"),
      authoring.contentHash("intent: b\n"),
    );
  });

  it("describes a services lock and asks before up/down", () => {
    assert.equal(
      authoring.describeServicesLock({ state: "absent", path: "/l" }),
      "no services-up lock",
    );
    assert.match(
      authoring.describeServicesLock({
        state: "unreadable",
        path: "/l",
        reason: "bad json",
      }),
      /unreadable lock \(bad json\)/,
    );
    const held = authoring.describeServicesLock({
      state: "held",
      path: "/l",
      ageSeconds: 600,
      lock: { by: "cli", pid: 77, startedAt: "2026-10-02T11:50:00.000Z" },
      stale: true,
      problems: ["tmux session gone"],
    });
    assert.match(held, /held by services up \(cli, pid 77\)/);
    assert.match(held, /\(10m.*ago\)/);
    assert.match(held, /stale: tmux session gone/);
    const up = authoring.servicesDialog({
      action: "up",
      env: "dev",
      lock: { state: "absent", path: "/l" },
      policy: { trait: "shared" },
      cli: "cairn services up --env=dev --json",
    });
    assert.equal(up.confirmLabel, "Services up");
    assert.match(up.message, /Start the services for "dev"/);
    assert.match(up.detail, /--reuse-services/);
    assert.match(up.detail, /Environment: dev \(shared\)/);
    assert.match(up.detail, /other people may depend/);
    const down = authoring.servicesDialog({
      action: "down",
      env: "local",
      lock: null,
      cli: "cairn services down --env=local --json",
    });
    assert.match(down.message, /Tear down the services for "local"/);
    assert.match(down.detail, /lock state unknown/);
  });
});
