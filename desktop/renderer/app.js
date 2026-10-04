/**
 * Renderer bootstrap: shell chrome, router, and the IPC subscriptions that
 * keep live runs streaming into the UI.
 *
 * Boot ends by reporting readiness to the main process, which is what
 * `electron . --smoke` waits for — so a green smoke run proves the window,
 * preload bridge, every lib module, and the first view all wired up.
 */
(function bootApp() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, actions, api, fmt, toast, setStatus, setStatusRight } =
    Studio;

  const NAV = [
    { id: "runs", label: "Runs", glyph: "▤" },
    { id: "specs", label: "Specs", glyph: "≡" },
    { id: "suites", label: "Suites", glyph: "☰" },
    { id: "catalog", label: "Catalog", glyph: "⊞" },
    { id: "config-vars", label: "Config vars", glyph: "≔" },
    { id: "live", label: "Live", glyph: "▶", badge: () => liveCount() },
    { id: "invocations", label: "Invocations", glyph: "⇶" },
    { id: "sessions", label: "Sessions", glyph: "◉" },
    { id: "stashes", label: "Stashes", glyph: "⧉" },
    { sep: true },
    { id: "stats", label: "Cohorts", glyph: "∑" },
    { id: "docs", label: "Docs", glyph: "?" },
    { id: "doctor", label: "Environment", glyph: "⚕" },
    { sep: true },
    { id: "settings", label: "Settings", glyph: "⚙" },
  ];

  /** @type {{ destroy?: () => void } | null} */
  let currentView = null;
  /** Bumped by every mount, so a render that finishes late knows it lost. */
  let mountSeq = 0;
  /** @type {Array<() => void>} */
  const unsubscribes = [];

  /** @returns {number} */
  function liveCount() {
    let count = 0;
    for (const record of state.live.values()) if (!record.done) count += 1;
    for (const record of state.detected.values())
      if (!record.done && !record.stale && record.liveness?.state !== "dead")
        count += 1;
    return count;
  }

  /** Apply the interface settings (density, screenshot width). */
  function applyUiSettings() {
    const ui = state.settings?.ui ?? {};
    document.body.classList.toggle("density-compact", ui.density === "compact");
    const width = Number(ui.screenshotMaxWidth);
    document.documentElement.style.setProperty(
      "--shot-max",
      Number.isFinite(width) && width > 0 ? `${Math.round(width)}px` : "720px",
    );
  }

  /**
   * The sidebar is built once and then patched in place: pushes repaint it
   * many times a second during a run, and rebuilding it would throw away
   * keyboard focus on a nav item.
   * @type {{ items: Map<string, { button: HTMLElement, badge: HTMLElement }>, project: HTMLElement, projectSig: string } | null}
   */
  let navDom = null;

  /** @param {HTMLElement} sidebar */
  function buildNav(sidebar) {
    Studio.clear(sidebar);
    /** @type {Map<string, { button: HTMLElement, badge: HTMLElement }>} */
    const items = new Map();
    sidebar.appendChild(h("div", { class: "nav-label", text: "workspace" }));
    for (const item of NAV) {
      if (item.sep) {
        sidebar.appendChild(h("div", { class: "nav-sep", role: "separator" }));
        continue;
      }
      const badge = h("span", { class: "nav-badge hidden" });
      const button = h(
        "button",
        {
          class: "nav-item",
          type: "button",
          dataset: { view: item.id },
          onClick: () => Studio.navigate(item.id),
        },
        h("span", { class: "nav-glyph", ariaHidden: "true", text: item.glyph }),
        item.label,
        badge,
      );
      items.set(item.id, { button, badge });
      sidebar.appendChild(button);
    }
    const project = h("div", { class: "nav-project" });
    sidebar.appendChild(project);
    // Up/Down move between nav items; Tab still walks them in order.
    Studio.rovingKeys(sidebar, {
      items: () => /** @type {HTMLElement[]} */ ([
        ...sidebar.querySelectorAll("button.nav-item"),
      ]),
    });
    return { items, project, projectSig: "" };
  }

  function paintNav() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    if (!navDom || !sidebar.contains(navDom.project))
      navDom = buildNav(sidebar);
    for (const item of NAV) {
      if (item.sep) continue;
      const entry = navDom.items.get(item.id);
      if (!entry) continue;
      const active =
        state.view === item.id || (state.view === "run" && item.id === "runs");
      entry.button.classList.toggle("active", active);
      if (active) entry.button.setAttribute("aria-current", "page");
      else entry.button.removeAttribute("aria-current");
      const badge = item.badge ? item.badge() : 0;
      entry.badge.textContent = badge ? String(badge) : "";
      entry.badge.classList.toggle("hidden", !badge);
      entry.button.setAttribute(
        "aria-label",
        badge ? `${item.label} (${badge} in flight)` : item.label,
      );
    }
    const projectSig = JSON.stringify([
      state.project?.dir ?? null,
      (state.project?.specs ?? []).length,
      state.project?.config?.project ?? null,
    ]);
    if (projectSig === navDom.projectSig) return;
    navDom.projectSig = projectSig;
    const project = navDom.project;
    Studio.clear(project);
    if (!state.project?.dir) return;
    project.appendChild(h("div", { class: "nav-sep", role: "separator" }));
    project.appendChild(h("div", { class: "nav-label", text: "project" }));
    project.appendChild(
      h(
        "button",
        {
          class: "nav-item",
          type: "button",
          title: `${state.project.dir}\nOpen another project…`,
          ariaLabel: `project ${state.project.dir.split("/").pop()}: open another project`,
          onClick: () => Studio.emit("menu:open-project"),
        },
        h("span", { class: "nav-glyph", ariaHidden: "true", text: "⌂" }),
        h("span", {
          style: {
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          },
          text: state.project.dir.split("/").pop(),
        }),
      ),
    );
    project.appendChild(
      h("div", {
        class: "nav-label",
        style: {
          textTransform: "none",
          letterSpacing: "0",
          fontFamily: "var(--mono)",
          fontSize: "10px",
          wordBreak: "break-all",
        },
        text: `${(state.project.specs ?? []).length} specs · ${state.project.config?.project ?? "no config"}`,
      }),
    );
  }

  function paintTopbar() {
    const projectName = document.getElementById("project-name");
    const runsRoot = document.getElementById("runs-root");
    const cairnStatus = document.getElementById("cairn-status");
    if (projectName)
      projectName.textContent = state.project?.dir
        ? state.project.dir.split("/").pop()
        : "no project";
    if (runsRoot) {
      runsRoot.textContent = state.runsRoot?.runsRoot ?? "—";
      runsRoot.title = `artifact root (${state.runsRoot?.source ?? "?"})`;
    }
    if (cairnStatus) {
      const cairn = state.info?.cairn;
      const versions = state.versions;
      const version = versions?.resolved?.version;
      cairnStatus.textContent = cairn?.command
        ? `cairn${version ? ` ${version}` : ""} · ${cairn.source}${
            versions?.mismatch ? " ⚠" : ""
          }`
        : "cairn not found";
      cairnStatus.style.color = !cairn?.command
        ? "var(--bad)"
        : versions?.mismatch
          ? "var(--warn)"
          : "";
      cairnStatus.title = cairn?.command
        ? [
            cairn.command,
            versions?.path
              ? `PATH: ${versions.path.command} (${versions.path.version ?? "?"})`
              : null,
            versions?.repo
              ? `repo: ${versions.repo.command} (${versions.repo.version ?? "?"})`
              : null,
            versions?.warning ?? null,
          ]
            .filter(Boolean)
            .join("\n")
        : "set the binary in Settings";
    }
    const lockPill = document.getElementById("lock-pill");
    const lockLabel = document.getElementById("lock-label");
    if (lockPill && lockLabel) {
      const active = state.locks?.active ?? [];
      lockPill.classList.toggle("hidden", active.length === 0);
      lockLabel.textContent = active.length
        ? `${Studio.ops.lockHeadline(active)}${
            active[0].owner ? ` · ${active[0].owner}` : ""
          }`
        : "";
      lockPill.title = active
        .map((lock) => Studio.ops.lockSentence(lock))
        .join("\n");
    }
    const pill = document.getElementById("active-run-pill");
    const label = document.getElementById("active-run-label");
    if (pill && label) {
      const count = liveCount();
      pill.classList.toggle("hidden", count === 0);
      label.textContent =
        count === 1 ? "1 run in flight" : `${count} runs in flight`;
    }
  }

  /**
   * @param {string} viewId
   * @param {Record<string, any>} params
   */
  async function mount(viewId, params) {
    const root = /** @type {HTMLElement} */ (document.getElementById("view"));
    if (!root) return;
    const view = Studio.views?.[viewId] ?? Studio.views?.runs;
    const seq = ++mountSeq;
    if (currentView?.destroy) {
      try {
        currentView.destroy();
      } catch {
        // a view failing to clean up must not block navigation
      }
    }
    currentView = null;
    state.view = view.id;
    // Every mount renders into a host of its own (`display: contents`, so
    // layout is unchanged). The next mount detaches it, so a render that
    // finishes after the user moved on paints into a detached node, never
    // over the view on screen.
    const host = h("div", { class: "view-host" });
    Studio.clear(root);
    root.appendChild(host);
    paintNav();
    setStatus(`${view.label.toLowerCase()} view`);
    try {
      const result = await view.render(host, params);
      const handle =
        result && typeof result === "object"
          ? /** @type {{ destroy?: () => void }} */ (result)
          : null;
      if (seq !== mountSeq) {
        // The user moved on while this view was still loading: its pollers
        // must not outlive it, and the view now on screen keeps its handle.
        try {
          handle?.destroy?.();
        } catch {
          // a view failing to clean up must not block navigation
        }
        return;
      }
      currentView = handle;
    } catch (error) {
      // A late failure of a view the user already left is not news.
      if (seq !== mountSeq) return;
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, `${view.id} view`));
      toast(
        `${view.label} view failed`,
        String(error?.message ?? error),
        "bad",
      );
    }
  }

  // ── live run bookkeeping ──────────────────────────────────────────────────

  function subscribeLive() {
    unsubscribes.push(
      api.on("run:started", (payload) => {
        state.live.set(
          payload.token,
          Studio.initLiveRecord({
            token: payload.token,
            specs: payload.specs ?? [],
            suite: payload.suite ?? null,
            argv: payload.argv ?? [],
            command: payload.command ?? "",
            launcher: payload.launcher ?? "cairn",
            cwd: payload.cwd ?? "",
            runsRoot: payload.runsRoot ?? "",
            startedAt: Date.parse(payload.startedAt) || Date.now(),
            runDir: null,
            runId: null,
            pid: null,
            invocation: null,
            done: null,
          }),
        );
        paintNav();
        paintTopbar();
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:pid", ({ token, pid }) => {
        const record = state.live.get(token);
        if (!record) return;
        record.pid = pid ?? null;
        Studio.markDirty(record, ["status"]);
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:log", ({ token, entry }) => {
        const record = state.live.get(token);
        if (!record) return;
        Studio.appendLog(record, entry);
        setStatus(fmt.oneLine(String(entry?.msg ?? "")));
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:live", ({ token, runDir, runId }) => {
        const record = state.live.get(token);
        if (!record) return;
        record.runDir = runDir;
        record.runId = runId;
        Studio.markDirty(record, ["status", "screenshot", "logs"]);
        // The app's own tail claimed this run — suppress it from the
        // detected set for the whole session, so neither the remaining
        // watcher pushes nor its finish notification re-render it.
        Studio.suppressDetectedRun(runId);
        setStatus(`tailing ${runId}`);
        paintNav();
        paintTopbar();
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:events", ({ token, events }) => {
        const record = state.live.get(token);
        if (!record) return;
        Studio.applyEventsToRecord(record, events);
        if (record.model.invocation && !record.invocation)
          record.invocation = record.model.invocation;
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:done", (payload) => {
        const record = state.live.get(payload.token);
        // Exit 7, status "refused", or a batch whose every spec was refused:
        // the environment policy said no before anything ran. Not a failure,
        // so not a red toast — and no run directory: the document's
        // `refused_…` runId names nothing on disk, so it is never adopted.
        const refused = CairnPolicy.isRefusedOutcome(
          payload.exitCode,
          payload.payload,
        );
        // `synthetic: true`: the CLI never created this run (refused, or
        // errored/cancelled before it started) — its runId is a placeholder.
        const synthetic = CairnPolicy.isSyntheticResult(payload.payload);
        if (record) {
          record.done = { ...payload, at: Date.now() };
          if (payload.runDir && !record.runDir) record.runDir = payload.runDir;
          if (payload.payload?.runId && !record.runId && !refused && !synthetic)
            record.runId = payload.payload.runId;
          Studio.markDirty(record, ["status", "badges"]);
        }
        const specLabel = record?.suite
          ? `suite ${record.suite}`
          : (record?.specs ?? [])
              .map((spec) => spec.split("/").pop())
              .join(", ");
        const ok = Boolean(payload.ok) && !refused;
        const refusal = refused
          ? CairnPolicy.documentRefusal(payload.payload)
          : null;
        const refusalLine = refusal ? CairnPolicy.refusalText(refusal) : null;
        // A batch that passed with some specs refused says so.
        const refusedCount = Number(payload.payload?.summary?.refused) || 0;
        toast(
          ok
            ? `Passed · ${specLabel}`
            : refused
              ? `Refused · ${specLabel}`
              : `${payload.meaning ?? "failed"} · ${specLabel}`,
          ok
            ? `${fmt.formatDuration(
                payload.payload?.durationMs ?? payload.payload?.totalDurationMs,
              )}${payload.payload?.runId ? ` · ${payload.payload.runId}` : ""}${
                refusedCount
                  ? ` · ${refusedCount} refused by the environment policy`
                  : ""
              }`
            : fmt.truncate(
                refusalLine ??
                  (typeof payload.payload?.summary === "string"
                    ? payload.payload.summary
                    : null) ??
                  payload.error ??
                  payload.stderr ??
                  "",
                220,
              ),
          ok ? "ok" : refused ? "info" : "bad",
          ok ? 4200 : 9000,
        );
        setStatus(
          ok
            ? "run passed"
            : refused
              ? "run refused by the environment policy"
              : `run ${payload.meaning ?? "failed"}`,
        );
        setStatusRight("");
        paintNav();
        paintTopbar();
        Studio.live?.refreshIfVisible();
        maybeRefreshRuns();
      }),
    );
  }

  /** Watcher pushes for runs started outside the app. */
  function subscribeDetected() {
    unsubscribes.push(
      api.on("runs:detected", (payload) => {
        // Last-activity refreshes alone do not change what is running.
        if (!Studio.syncDetected(payload?.runs)) return;
        paintNav();
        paintTopbar();
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:external-events", ({ runId, events }) => {
        const record = Studio.applyExternalEvents(runId, events);
        if (!record) return;
        setStatus(
          fmt.oneLine(
            `${record.spec} ▸ ${Studio.events.describeEvent(events.at(-1)).label}`,
          ),
        );
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:external-finished", (payload) => {
        const record = Studio.markExternalFinished(payload);
        if (!record) return;
        const ok = Boolean(record.done.ok);
        const refused = record.done.status === "refused";
        toast(
          ok
            ? `Passed · ${record.spec}`
            : `${record.done.status} · ${record.spec}`,
          fmt.truncate(
            (refused && record.done.refusal
              ? CairnPolicy.refusalText(record.done.refusal)
              : null) ??
              record.done.summary ??
              "",
            220,
          ),
          ok ? "ok" : refused ? "info" : "bad",
          ok ? 4200 : 9000,
        );
        paintNav();
        paintTopbar();
        Studio.live?.refreshIfVisible();
        maybeRefreshRuns();
      }),
    );

    unsubscribes.push(
      api.on("runs:invocations", (payload) => {
        if (Studio.syncInvocations(payload?.invocations)) paintNav();
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("invocation:stream", ({ invocationId, events }) => {
        if (Studio.applyInvocationEvents(invocationId, events))
          Studio.live?.refreshIfVisible();
      }),
    );
  }

  /** Reload the Runs view after a finish, when the setting allows it. */
  function maybeRefreshRuns() {
    if (state.view !== "runs") return;
    if (state.settings?.ui?.autoRefreshRuns === false) return;
    void actions.loadRuns().then(() => {
      if (state.view === "runs") void mount("runs", {});
    });
  }

  /**
   * Shared handler for "Open Project…" — reached both from the app menu
   * (main → renderer push) and from in-view buttons (renderer bus).
   */
  async function openProjectDialog() {
    try {
      const dir = await api.call("projects:choose");
      if (!dir) return;
      await actions.loadProject(dir);
      await actions.loadInfo();
      await actions.loadRuns();
      paintNav();
      paintTopbar();
      toast("Project opened", dir, "ok", 2600);
      Studio.navigate("runs");
    } catch (error) {
      toast("Could not open project", String(error?.message ?? error), "bad");
    }
  }

  function subscribeMenus() {
    unsubscribes.push(
      api.on("menu:navigate", (payload) =>
        Studio.navigate(payload?.view ?? "runs"),
      ),
    );

    unsubscribes.push(
      api.on("menu:open-project", () => void openProjectDialog()),
    );
    unsubscribes.push(
      Studio.on("menu:open-project", () => void openProjectDialog()),
    );

    unsubscribes.push(
      api.on("menu:open-spec", async () => {
        try {
          const files = await api.call("dialog:open-spec");
          if (!files?.length) return;
          Studio.navigate("specs", { file: files[0] });
        } catch (error) {
          toast("Could not open spec", String(error?.message ?? error), "bad");
        }
      }),
    );

    unsubscribes.push(
      api.on("menu:run-focused", async () => {
        if (!state.selectedSpec) {
          toast(
            "No spec focused",
            "Open a spec in the Specs view first.",
            "bad",
          );
          return;
        }
        // The Specs view's Run path: its "run on" environment, the policy
        // warning, the unsaved-edits question, then Live.
        if (Studio.specsView?.runFocused) {
          await Studio.specsView.runFocused();
          return;
        }
        try {
          await actions.startRun([state.selectedSpec]);
          Studio.navigate("live");
        } catch (error) {
          // e.g. a suite lock is held (main refuses every run while it exists)
          toast("Run failed to start", String(error?.message ?? error), "bad");
        }
      }),
    );

    unsubscribes.push(
      api.on("menu:verify-focused", async () => {
        if (!state.selectedSpec) {
          toast(
            "No spec focused",
            "Open a spec in the Specs view first.",
            "bad",
          );
          return;
        }
        setStatus("cairn spec verify…");
        try {
          const result = await api.call("spec:verify", {
            spec: state.selectedSpec,
          });
          state.specFindings = { ...result, path: state.selectedSpec };
          toast(
            result.ok ? "Spec valid" : `Verify: ${result.meaning}`,
            result.ok ? null : fmt.truncate(result.stderr || "", 200),
            result.ok ? "ok" : "bad",
          );
          if (state.view === "specs")
            void mount("specs", { file: state.selectedSpec });
        } catch (error) {
          toast("Verify failed", String(error?.message ?? error), "bad");
        } finally {
          setStatus("ready");
        }
      }),
    );

    unsubscribes.push(
      api.on("app:open-files", (payload) => {
        const file = (payload?.files ?? [])[0];
        if (file) Studio.navigate("specs", { file });
      }),
    );

    unsubscribes.push(
      api.on("app:error", (payload) =>
        toast("Main process error", String(payload?.message ?? ""), "bad"),
      ),
    );

    unsubscribes.push(
      Studio.on("navigate", ({ view, params }) => void mount(view, params)),
    );
  }

  /**
   * @returns {Promise<{ ok: boolean, reason: string | null, checks: Record<string, unknown> }>}
   */
  async function boot() {
    /** @type {Record<string, any>} */
    const checks = {};
    try {
      checks.bridge = Boolean(/** @type {any} */ (globalThis.cairn?.call));
      if (!checks.bridge) throw new Error("preload bridge missing");

      // The watcher starts as soon as the page finishes loading; register its
      // subscriptions before anything awaits so no early push is dropped.
      subscribeDetected();

      const info = await actions.loadInfo();
      checks.appVersion = info?.appVersion ?? null;
      checks.cairnCommand = info?.cairn?.command ?? null;
      checks.cairnSource = info?.cairn?.source ?? null;
      checks.runsRoot = info?.runsRoot?.runsRoot ?? null;
      checks.userData = info?.userData ?? null;

      await actions.loadProject(info?.settings?.activeProject ?? null);
      checks.projectDir = state.project?.dir ?? null;
      checks.specCount = (state.project?.specs ?? []).length;
      checks.configFound = Boolean(state.project?.configPath);

      await actions.loadRuns();
      checks.runCount = state.runs.length;

      await actions.loadDetected();
      checks.detectedCount = state.detected.size;
      checks.eventsModule = Boolean(Studio.events?.describeEvent);
      checks.policyModule = Boolean(
        /** @type {any} */ (globalThis).CairnPolicy?.evaluateRequires,
      );

      applyUiSettings();
      unsubscribes.push(
        Studio.on("settings", () => {
          applyUiSettings();
          void actions.loadLocks().then(() => paintTopbar());
        }),
      );
      unsubscribes.push(Studio.on("versions", () => paintTopbar()));
      unsubscribes.push(Studio.on("locks", () => paintTopbar()));
      unsubscribes.push(Studio.on("project", () => void actions.loadLocks()));
      await actions.loadLocks();
      // Locks are files another process creates/removes: poll while
      // configured. The version probe spawns cairn, so it never blocks boot.
      setInterval(() => {
        // suite lock files, or a config `run: { lock }` another run may hold
        if (
          (state.locks?.lockFiles ?? []).length ||
          state.locks?.runLock?.configured
        )
          void actions.loadLocks();
      }, 5000);
      void actions.loadVersions();
      // One clock for every "3m ago" on screen (time.rel-time), so the same
      // moment reads the same in every view and never goes stale.
      setInterval(() => Studio.refreshRelativeTimes(), 15_000);

      subscribeLive();
      subscribeMenus();

      document
        .getElementById("project-picker")
        ?.addEventListener("click", () => Studio.emit("menu:open-project"));
      document
        .getElementById("refresh-button")
        ?.addEventListener("click", () => {
          void mount(state.view, state.viewParams);
          void actions.loadRuns();
        });

      paintNav();
      paintTopbar();
      await mount("runs", {});
      checks.viewMounted =
        (document.querySelector("#view > .view-host")?.childElementCount ?? 0) >
        0;
      checks.navItems =
        document.getElementById("sidebar")?.querySelectorAll(".nav-item")
          .length ?? 0;

      state.booted = true;
      setStatus("ready");
      setStatusRight(
        `${state.runs.length} runs · ${(state.project?.specs ?? []).length} specs · cairn ${info?.cairn?.source ?? "none"}`,
      );

      // A view script that fails to parse registers nothing; the smoke harness
      // must catch that instead of shipping a half-built app.
      const expectedViews = [
        "runs",
        "run",
        "specs",
        "suites",
        "catalog",
        "config-vars",
        "live",
        "invocations",
        "sessions",
        "stashes",
        "stats",
        "docs",
        "doctor",
        "settings",
      ];
      const missingViews = expectedViews.filter((id) => !Studio.views?.[id]);
      checks.views = Object.keys(Studio.views ?? {});
      checks.missingViews = missingViews;

      const ok =
        Boolean(
          checks.bridge &&
            checks.viewMounted &&
            checks.appVersion &&
            checks.eventsModule &&
            checks.policyModule,
        ) && missingViews.length === 0;
      return {
        ok,
        reason: ok
          ? null
          : missingViews.length
            ? `views missing: ${missingViews.join(", ")}`
            : "boot checks failed",
        checks,
      };
    } catch (error) {
      const root = document.getElementById("view");
      if (root) {
        Studio.clear(root);
        root.appendChild(Studio.errorBox(error, "startup"));
      }
      return { ok: false, reason: String(error?.message ?? error), checks };
    }
  }

  window.addEventListener("error", (event) => {
    toast("Renderer error", String(event?.message ?? event), "bad");
  });
  window.addEventListener("unhandledrejection", (event) => {
    toast(
      "Unhandled rejection",
      String(event?.reason?.message ?? event?.reason ?? ""),
      "bad",
    );
  });

  void boot().then((result) => {
    const bridge = /** @type {any} */ (globalThis).cairn;
    if (bridge?.smokeReady) bridge.smokeReady(result);
    if (!result.ok) console.error("boot failed", result.reason, result.checks);
  });
})();
