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
    fmt,
  });
})();
