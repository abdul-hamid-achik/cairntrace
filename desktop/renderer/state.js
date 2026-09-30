/**
 * Renderer state, the IPC facade, and cross-view plumbing (toasts, status
 * bar, modal, event bus).
 *
 * Views stay dumb: they read `Studio.state`, call `Studio.actions.*`, and
 * re-render when the bus emits. All main-process access funnels through
 * `Studio.api.call`, which is the only place that knows about the envelope.
 */
(function bootState() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h } = Studio;
  const fmt = Studio.fmt;

  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();

  /**
   * @param {string} event
   * @param {(payload?: any) => void} handler
   * @returns {() => void}
   */
  function on(event, handler) {
    const set = listeners.get(event) ?? new Set();
    set.add(handler);
    listeners.set(event, set);
    return () => set.delete(handler);
  }

  /**
   * @param {string} event
   * @param {any} [payload]
   */
  function emit(event, payload) {
    for (const handler of listeners.get(event) ?? []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`listener for ${event} failed`, error);
      }
    }
  }

  /** The IPC facade. Every call unwraps `{ok,data}` or throws. */
  const api = {
    /**
     * @param {string} channel
     * @param {...any} args
     */
    async call(channel, ...args) {
      const bridge = /** @type {any} */ (globalThis).cairn;
      if (!bridge) throw new Error("preload bridge missing (window.cairn)");
      return bridge.call(channel, ...args);
    },
    /**
     * @param {string} channel
     * @param {(payload: any) => void} listener
     */
    on(channel, listener) {
      const bridge = /** @type {any} */ (globalThis).cairn;
      return bridge ? bridge.on(channel, listener) : () => {};
    },
  };

  const state = {
    booted: false,
    info: null,
    settings: null,
    project: null,
    projectError: null,
    runs: [],
    runsRoot: null,
    runsError: null,
    runsLoading: false,
    specNames: [],
    filters: { status: "", spec: "", search: "", limit: 150 },
    selectedRun: null,
    runDetail: null,
    specs: [],
    selectedSpec: null,
    specText: "",
    specDirty: false,
    specSummary: null,
    specFindings: null,
    /** token → live run record */
    live: new Map(),
    liveOrder: [],
    /** runId → externally started run record (watcher-detected) */
    detected: new Map(),
    view: "runs",
    viewParams: {},
  };

  /**
   * @param {string} title
   * @param {string} [body]
   * @param {"ok" | "bad" | "info"} [tone]
   * @param {number} [ttl]
   */
  function toast(title, body, tone = "info", ttl = 5200) {
    const host = document.getElementById("toasts");
    if (!host) return;
    const node = h(
      "div",
      { class: `toast ${tone}` },
      h("div", { class: "toast-title", text: title }),
      body ? h("div", { class: "toast-body", text: body }) : null,
    );
    host.appendChild(node);
    setTimeout(() => node.remove(), ttl);
  }

  /** @param {string} text */
  function setStatus(text) {
    const node = document.getElementById("status-text");
    if (node) node.textContent = text;
  }

  /** @param {string} text */
  function setStatusRight(text) {
    const node = document.getElementById("status-right");
    if (node) node.textContent = text;
  }

  /**
   * Promise-based confirm dialog built on <dialog>.
   * @param {{ title: string, body?: string, confirmLabel?: string, danger?: boolean }} options
   * @returns {Promise<boolean>}
   */
  function confirm(options) {
    return new Promise((resolve) => {
      const dialog =
        /** @type {HTMLDialogElement} */ (document.getElementById("modal"));
      if (!dialog || typeof dialog.showModal !== "function") {
        resolve(globalThis.confirm(options.title));
        return;
      }
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        dialog.removeEventListener("cancel", onCancel);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onCancel = () => finish(false);

      dialog.textContent = "";
      dialog.appendChild(
        h(
          "div",
          { class: "modal-body" },
          h("h3", { text: options.title }),
          options.body
            ? h("p", {
                style: { color: "var(--text-dim)", margin: "0" },
                text: options.body,
              })
            : null,
        ),
      );
      dialog.appendChild(
        h(
          "div",
          { class: "modal-actions" },
          h("button", {
            class: "btn",
            type: "button",
            text: "Cancel",
            onClick: () => finish(false),
          }),
          h("button", {
            class: options.danger ? "btn btn-danger" : "btn btn-primary",
            type: "button",
            text: options.confirmLabel ?? "Confirm",
            onClick: () => finish(true),
          }),
        ),
      );
      dialog.addEventListener("cancel", onCancel);
      dialog.showModal();
    });
  }

  /**
   * @param {string} view
   * @param {Record<string, any>} [params]
   */
  function navigate(view, params = {}) {
    state.view = view;
    state.viewParams = params;
    emit("navigate", { view, params });
  }

  const actions = {
    async loadInfo() {
      state.info = await api.call("app:info");
      state.settings = state.info.settings;
      state.runsRoot = state.info.runsRoot;
      emit("info", state.info);
      return state.info;
    },

    async loadProject(dir) {
      state.projectError = null;
      try {
        state.project = await api.call("project:inspect", dir ?? null);
        state.specs = state.project.specs ?? [];
        if (dir) await api.call("projects:open-recent", dir);
      } catch (error) {
        state.projectError = error;
        state.project = null;
      }
      emit("project", state.project);
      return state.project;
    },

    async loadRuns() {
      state.runsLoading = true;
      emit("runs:loading");
      try {
        const result = await api.call("runs:list", {
          limit: state.filters.limit,
          status: state.filters.status || null,
          spec: state.filters.spec || null,
          search: state.filters.search || null,
        });
        state.runs = result.runs ?? [];
        state.runsRoot = { runsRoot: result.runsRoot, source: result.source };
        state.runsError = result.exists
          ? null
          : new Error(`artifact root missing: ${result.runsRoot}`);
        state.specNames = result.specNames ?? [];
      } catch (error) {
        state.runsError = error;
        state.runs = [];
      }
      state.runsLoading = false;
      emit("runs", state.runs);
      return state.runs;
    },

    /** Initial snapshot of runs detected in the artifact root. */
    async loadDetected() {
      try {
        syncDetected(await api.call("runs:detected"));
      } catch {
        // the watcher snapshot is best-effort
      }
      return state.detected;
    },

    async openRun(runDirOrId) {
      state.selectedRun = runDirOrId;
      state.runDetail = null;
      emit("run:selected", runDirOrId);
      try {
        state.runDetail = await api.call("run:detail", runDirOrId);
      } catch (error) {
        state.runDetail = { error };
      }
      emit("run:detail", state.runDetail);
      return state.runDetail;
    },

    async openSpec(file) {
      state.selectedSpec = file;
      state.specFindings = null;
      emit("spec:selected", file);
      const result = await api.call("spec:read", file);
      state.specText = result.text;
      state.specDirty = false;
      state.specSummary = result.summary;
      emit("spec:loaded", result);
      return result;
    },

    /**
     * @param {string[]} specPaths
     * @param {Record<string, any>} [overrides]
     */
    async startRun(specPaths, overrides) {
      const started = await api.call(
        "run:start",
        { specs: specPaths, overrides },
        null,
      );
      setStatus(`running ${specPaths.length} spec(s)…`);
      toast(
        "Run started",
        specPaths.map((p) => p.split("/").pop()).join(", "),
        "info",
        3000,
      );
      return started;
    },

    async cancelRun(token) {
      const result = await api.call("run:cancel", token);
      if (result?.cancelled) toast("Run cancelled", null, "info", 2600);
      return result;
    },

    async saveSettings(patch) {
      state.settings = await api.call("settings:update", patch);
      emit("settings", state.settings);
      return state.settings;
    },

    refresh() {
      emit("refresh");
    },
  };

  /**
   * Shared label for a run row.
   * @param {Record<string, any>} run
   */
  function runLabel(run) {
    return run?.spec ?? run?.runId ?? "run";
  }

  /**
   * `3/5` style outcome counter.
   * @param {Record<string, any>} run
   */
  function outcomeLabel(run) {
    const outcomes = run?.outcomes;
    if (!outcomes || !outcomes.total) return "—";
    return `${outcomes.passed}/${outcomes.total}`;
  }

  // ── externally started runs (watcher-detected) ────────────────────────────

  /**
   * Run ids that must never surface as detected runs, for the whole session:
   * run ids an app-owned live tail claimed (the watcher keeps tracking them
   * after the claim and pushes their finish — which would otherwise render a
   * duplicate card and a second toast), and run ids the user explicitly hid.
   * @type {Set<string>}
   */
  const suppressedDetected = new Set();

  /** @param {string} runId */
  function suppressDetectedRun(runId) {
    if (!runId) return;
    suppressedDetected.add(runId);
    state.detected.delete(runId);
  }

  /**
   * Roll streamed events into per-step rows. Shared by app-started and
   * detected-run records (mirrors lib/live.stepProgress; the renderer cannot
   * require main-process modules).
   * @param {any} record
   */
  function rollupSteps(record) {
    const steps = new Map();
    for (const event of record.events) {
      const stepId = typeof event?.stepId === "string" ? event.stepId : null;
      if (!stepId) continue;
      const row = steps.get(stepId) ?? {
        stepId,
        status: "running",
        durationMs: null,
        startedAt: null,
      };
      switch (String(event?.type ?? "")) {
        case "step.started":
          row.status = "running";
          row.startedAt = event.ts ?? row.startedAt;
          break;
        case "step.finished":
          row.status = event?.status === "failed" ? "failed" : "passed";
          row.durationMs =
            typeof event?.durationMs === "number"
              ? event.durationMs
              : row.durationMs;
          break;
        case "step.skipped":
          row.status = "skipped";
          break;
        default:
          break;
      }
      steps.set(stepId, row);
    }
    record.steps = [...steps.values()];
    return record.steps;
  }

  /**
   * Sync the detected-runs map with a watcher snapshot. Records the renderer
   * already holds are kept (streamed events included); a record missing from
   * the snapshot is marked stale rather than dropped, so a card the user is
   * watching does not vanish — the watcher only omits runs that finished,
   * went quiet past the stale window, or were deleted.
   * @param {Array<Record<string, any>>} runs
   * @returns {boolean} true when the visible set changed (badge/pill repaint)
   */
  function syncDetected(runs) {
    let changed = false;
    /** @type {Set<string>} */
    const seen = new Set();
    for (const run of runs ?? []) {
      seen.add(run.runId);
      if (suppressedDetected.has(run.runId)) continue;
      let record = state.detected.get(run.runId);
      if (!record) {
        changed = true;
        record = {
          runId: run.runId,
          spec: run.spec ?? run.runId,
          runDir: run.runDir ?? null,
          startedAtMs: run.startedAtMs ?? null,
          lastActivityMs: run.lastActivityMs ?? null,
          events: [],
          steps: [],
          done: null,
          stale: false,
        };
        state.detected.set(run.runId, record);
        continue;
      }
      if (record.done) continue;
      record.runDir = run.runDir ?? record.runDir;
      record.spec = run.spec ?? record.spec;
      record.startedAtMs = run.startedAtMs ?? record.startedAtMs;
      record.lastActivityMs = run.lastActivityMs ?? record.lastActivityMs;
      if (record.stale) {
        record.stale = false;
        changed = true;
      }
    }
    for (const record of state.detected.values()) {
      if (record.done || record.stale || seen.has(record.runId)) continue;
      record.stale = true;
      changed = true;
    }
    return changed;
  }

  /**
   * Append tail events to a detected run's record, creating a stub when the
   * events race ahead of the first snapshot.
   * @param {string} runId
   * @param {Array<Record<string, any>>} events
   * @returns {Record<string, any> | null} the record, or null when empty
   */
  function applyExternalEvents(runId, events) {
    if (!Array.isArray(events) || !events.length) return null;
    if (suppressedDetected.has(runId)) return null;
    let record = state.detected.get(runId);
    if (!record) {
      record = {
        runId,
        spec: runId,
        runDir: null,
        startedAtMs: null,
        lastActivityMs: Date.now(),
        events: [],
        steps: [],
        done: null,
        stale: false,
      };
      state.detected.set(runId, record);
    }
    record.events.push(...events);
    if (record.events.length > 6000)
      record.events.splice(0, record.events.length - 6000);
    record.lastActivityMs = Date.now();
    rollupSteps(record);
    return record;
  }

  /**
   * @param {{ runId: string, runDir?: string | null, status?: string | null, summary?: string | null }} payload
   * @returns {Record<string, any> | null}
   */
  function markExternalFinished(payload) {
    const record = state.detected.get(payload.runId);
    if (!record || record.done) return null;
    if (payload.runDir) record.runDir = payload.runDir;
    record.done = {
      ok: payload.status === "passed",
      status: payload.status ?? "unknown",
      summary: payload.summary ?? null,
      at: Date.now(),
    };
    return record;
  }

  /**
   * Hide a detected run for this session. The suppression outlives the
   * record: the next watcher snapshot or event push must not resurrect the
   * card while the run is still going.
   * @param {string} runId
   */
  function hideDetected(runId) {
    suppressDetectedRun(runId);
  }

  Object.assign(Studio, {
    api,
    state,
    on,
    emit,
    navigate,
    toast,
    setStatus,
    setStatusRight,
    confirm,
    actions,
    runLabel,
    outcomeLabel,
    rollupSteps,
    syncDetected,
    applyExternalEvents,
    markExternalFinished,
    suppressDetectedRun,
    hideDetected,
    fmt,
  });
})();
