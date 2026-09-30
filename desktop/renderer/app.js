/**
 * Renderer bootstrap: shell chrome, router, and the IPC subscriptions that
 * keep live runs streaming into the UI.
 *
 * Boot ends by reporting readiness to the main process, which is what
 * `electron . --smoke` waits for — so a green smoke run proves the window,
 * preload bridge, every lib module, and the first view all wired up.
 */
(function bootApp() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h, state, actions, api, fmt, toast, setStatus, setStatusRight } =
    Studio;

  const NAV = [
    { id: "runs", label: "Runs", glyph: "▤" },
    { id: "specs", label: "Specs", glyph: "≡" },
    { id: "live", label: "Live", glyph: "▶", badge: () => liveCount() },
    { sep: true },
    { id: "stats", label: "Cohorts", glyph: "∑" },
    { id: "docs", label: "Docs", glyph: "?" },
    { id: "doctor", label: "Environment", glyph: "⚕" },
    { sep: true },
    { id: "settings", label: "Settings", glyph: "⚙" },
  ];

  /** @type {{ destroy?: () => void } | null} */
  let currentView = null;
  /** @type {Array<() => void>} */
  const unsubscribes = [];

  /** @returns {number} */
  function liveCount() {
    let count = 0;
    for (const record of state.live.values()) if (!record.done) count += 1;
    for (const record of state.detected.values())
      if (!record.done && !record.stale) count += 1;
    return count;
  }

  function paintNav() {
    const sidebar = document.getElementById("sidebar");
    if (!sidebar) return;
    Studio.clear(sidebar);
    sidebar.appendChild(h("div", { class: "nav-label", text: "workspace" }));
    for (const item of NAV) {
      if (item.sep) {
        sidebar.appendChild(h("div", { class: "nav-sep" }));
        continue;
      }
      const badge = item.badge ? item.badge() : 0;
      sidebar.appendChild(
        h(
          "button",
          {
            class: `nav-item${state.view === item.id ? " active" : ""}`,
            type: "button",
            onClick: () => Studio.navigate(item.id),
          },
          h("span", { class: "nav-glyph", text: item.glyph }),
          item.label,
          badge ? h("span", { class: "nav-badge", text: String(badge) }) : null,
        ),
      );
    }
    if (state.project?.dir) {
      sidebar.appendChild(h("div", { class: "nav-sep" }));
      sidebar.appendChild(h("div", { class: "nav-label", text: "project" }));
      sidebar.appendChild(
        h(
          "button",
          {
            class: "nav-item",
            type: "button",
            onClick: () => Studio.emit("menu:open-project"),
          },
          h("span", { class: "nav-glyph", text: "⌂" }),
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
      sidebar.appendChild(
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
      cairnStatus.textContent = cairn?.command
        ? `cairn · ${cairn.source}`
        : "cairn not found";
      cairnStatus.style.color = cairn?.command ? "" : "var(--bad)";
      cairnStatus.title = cairn?.command ?? "set the binary in Settings";
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
    if (currentView?.destroy) {
      try {
        currentView.destroy();
      } catch {
        // a view failing to clean up must not block navigation
      }
    }
    currentView = null;
    state.view = view.id;
    Studio.clear(root);
    paintNav();
    setStatus(`${view.label.toLowerCase()} view`);
    try {
      const result = await view.render(root, params);
      currentView = result && typeof result === "object" ? result : null;
    } catch (error) {
      Studio.clear(root);
      root.appendChild(Studio.errorBox(error, `${view.id} view`));
      toast(
        `${view.label} view failed`,
        String(error?.message ?? error),
        "bad",
      );
    }
  }

  // ── live run bookkeeping ──────────────────────────────────────────────────

  /** Kept for the views' benefit; the rollup itself lives in state.js. */
  const rollupSteps = (record) => Studio.rollupSteps(record);

  function subscribeLive() {
    unsubscribes.push(
      api.on("run:started", (payload) => {
        state.live.set(payload.token, {
          token: payload.token,
          specs: payload.specs ?? [],
          argv: payload.argv ?? [],
          command: payload.command ?? "",
          cwd: payload.cwd ?? "",
          runsRoot: payload.runsRoot ?? "",
          startedAt: Date.parse(payload.startedAt) || Date.now(),
          runDir: null,
          runId: null,
          events: [],
          steps: [],
          logs: [],
          done: null,
        });
        paintNav();
        paintTopbar();
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:log", ({ token, entry }) => {
        const record = state.live.get(token);
        if (!record) return;
        record.logs.push(entry);
        if (record.logs.length > 3000)
          record.logs.splice(0, record.logs.length - 3000);
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
        record.events.push(...events);
        if (record.events.length > 6000)
          record.events.splice(0, record.events.length - 6000);
        rollupSteps(record);
        Studio.live?.refreshIfVisible();
      }),
    );

    unsubscribes.push(
      api.on("run:done", (payload) => {
        const record = state.live.get(payload.token);
        if (record) {
          record.done = { ...payload, at: Date.now() };
          if (payload.runDir && !record.runDir) record.runDir = payload.runDir;
          if (payload.payload?.runId && !record.runId)
            record.runId = payload.payload.runId;
        }
        const specLabel = (record?.specs ?? [])
          .map((spec) => spec.split("/").pop())
          .join(", ");
        const ok = Boolean(payload.ok);
        toast(
          ok
            ? `Passed · ${specLabel}`
            : `${payload.meaning ?? "failed"} · ${specLabel}`,
          ok
            ? `${fmt.formatDuration(payload.payload?.durationMs)} · ${payload.payload?.runId ?? ""}`
            : fmt.truncate(
                payload.payload?.summary ??
                  payload.error ??
                  payload.stderr ??
                  "",
                220,
              ),
          ok ? "ok" : "bad",
          ok ? 4200 : 9000,
        );
        setStatus(ok ? "run passed" : `run ${payload.meaning ?? "failed"}`);
        setStatusRight("");
        paintNav();
        paintTopbar();
        Studio.live?.refreshIfVisible();
        if (state.view === "runs")
          void actions.loadRuns().then(() => mount("runs", {}));
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
            `${record.spec} ▸ ${String(events.at(-1)?.message ?? events.at(-1)?.type ?? "")}`,
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
        toast(
          ok
            ? `Passed · ${record.spec}`
            : `${record.done.status} · ${record.spec}`,
          fmt.truncate(record.done.summary ?? "", 220),
          ok ? "ok" : "bad",
          ok ? 4200 : 9000,
        );
        paintNav();
        paintTopbar();
        Studio.live?.refreshIfVisible();
        if (state.view === "runs")
          void actions.loadRuns().then(() => mount("runs", {}));
      }),
    );
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
        await actions.startRun([state.selectedSpec]);
        Studio.navigate("live");
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

      await actions.loadProject(info?.settings?.activeProject ?? null);
      checks.projectDir = state.project?.dir ?? null;
      checks.specCount = (state.project?.specs ?? []).length;
      checks.configFound = Boolean(state.project?.configPath);

      await actions.loadRuns();
      checks.runCount = state.runs.length;

      await actions.loadDetected();
      checks.detectedCount = state.detected.size;

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
        (document.getElementById("view")?.childElementCount ?? 0) > 0;
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
        "live",
        "stats",
        "docs",
        "doctor",
        "settings",
      ];
      const missingViews = expectedViews.filter((id) => !Studio.views?.[id]);
      checks.views = Object.keys(Studio.views ?? {});
      checks.missingViews = missingViews;

      const ok =
        Boolean(checks.bridge && checks.viewMounted && checks.appVersion) &&
        missingViews.length === 0;
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
