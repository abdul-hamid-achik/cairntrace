/**
 * Renderer state, the IPC facade, and cross-view plumbing (toasts, status
 * bar, modal, event bus).
 *
 * Views stay dumb: they read `Studio.state`, call `Studio.actions.*`, and
 * re-render when the bus emits. All main-process access funnels through
 * `Studio.api.call`, which is the only place that knows about the envelope.
 */
(function bootState() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h } = Studio;
  const fmt = Studio.fmt;
  /** The shared event describer/reducer (lib/events.js, loaded as a script). */
  const Events = /** @type {any} */ (globalThis).CairnEvents;
  Studio.events = Events;

  /** Per-record event buffer bound (the model keeps the rolled-up state). */
  const MAX_EVENTS = 6000;
  const MAX_LOGS = 3000;

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
    /** label keys/values discovered from run.json files */
    labels: [],
    filters: {
      status: "",
      spec: "",
      search: "",
      labels: [],
      limit: 150,
      groupByInvocation: false,
    },
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
    /** invocationId → { journal, model, … } from the watcher */
    invocations: new Map(),
    /** project lock status (launch safety) */
    locks: null,
    /** `cairn --version` for the resolved / PATH / repo binaries */
    versions: null,
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
   * Promise-based one-line text prompt on the same <dialog>: resolves the
   * trimmed text ("" when left empty) on confirm, null on Cancel/Escape.
   * @param {{ title: string, body?: string, placeholder?: string, confirmLabel?: string, maxLength?: number }} options
   * @returns {Promise<string | null>}
   */
  function promptText(options) {
    return new Promise((resolve) => {
      const dialog =
        /** @type {HTMLDialogElement} */ (document.getElementById("modal"));
      if (!dialog || typeof dialog.showModal !== "function") {
        const answer = globalThis.prompt?.(options.title, "");
        resolve(answer === null || answer === undefined ? null : answer.trim());
        return;
      }
      let settled = false;
      const input = /** @type {HTMLInputElement} */ (
        h("input", {
          class: "prompt-input",
          type: "text",
          placeholder: options.placeholder ?? "",
          maxlength: String(options.maxLength ?? 200),
          ariaLabel: options.title,
          onKeydown: (/** @type {KeyboardEvent} */ event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finish(input.value.trim());
            }
          },
        })
      );
      const finish = (/** @type {string | null} */ value) => {
        if (settled) return;
        settled = true;
        dialog.removeEventListener("cancel", onCancel);
        if (dialog.open) dialog.close();
        resolve(value);
      };
      const onCancel = () => finish(null);

      dialog.textContent = "";
      dialog.appendChild(
        h(
          "div",
          { class: "modal-body" },
          h("h3", { text: options.title }),
          options.body
            ? h("p", {
                style: { color: "var(--text-dim)", margin: "0 0 8px" },
                text: options.body,
              })
            : null,
          input,
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
            onClick: () => finish(null),
          }),
          h("button", {
            class: "btn btn-primary",
            type: "button",
            text: options.confirmLabel ?? "OK",
            onClick: () => finish(input.value.trim()),
          }),
        ),
      );
      dialog.addEventListener("cancel", onCancel);
      dialog.showModal();
      input.focus();
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
          labels: state.filters.labels?.length ? state.filters.labels : null,
        });
        state.runs = result.runs ?? [];
        state.runsRoot = { runsRoot: result.runsRoot, source: result.source };
        state.runsError = result.exists
          ? null
          : new Error(`artifact root missing: ${result.runsRoot}`);
        state.specNames = result.specNames ?? [];
        state.labels = result.labels ?? [];
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
      // Re-run on the Live card repeats these (main sends run:started
      // before it answers, so the record exists by now).
      const record = started?.token ? state.live.get(started.token) : null;
      if (record) record.overrides = overrides ?? null;
      setStatus(`running ${specPaths.length} spec(s)…`);
      toast(
        "Run started",
        specPaths.map((p) => p.split("/").pop()).join(", "),
        "info",
        3000,
      );
      return started;
    },

    /**
     * `cairn run --suite <name>` through the same launch path as Run (main
     * resolves the suite's specs, refuses an environment its `requires`
     * rules out, and spawns the CLI).
     * @param {string} name
     * @param {Record<string, any>} [overrides] e.g. `{ env }`
     */
    async startSuite(name, overrides) {
      const started = await api.call(
        "run:start",
        { suite: name, overrides },
        null,
      );
      const record = started?.token ? state.live.get(started.token) : null;
      if (record) record.overrides = overrides ?? null;
      setStatus(`running suite ${name}…`);
      toast("Suite started", name, "info", 3000);
      return started;
    },

    async cancelRun(token) {
      const result = await api.call("run:cancel", token);
      if (result?.cancelled && result.delegated)
        toast(
          "Cancelling the delegated run",
          "SIGINT sent: cairn gives its runner up to cancelGraceMs to cancel the remote invocation and copy the results back",
          "info",
          5000,
        );
      else if (result?.cancelled) toast("Run cancelled", null, "info", 2600);
      return result;
    },

    /** Lock files + launch template for the open project (launch safety). */
    async loadLocks() {
      try {
        state.locks = await api.call(
          "project:locks",
          state.project?.dir ?? null,
        );
      } catch {
        state.locks = null;
      }
      emit("locks", state.locks);
      return state.locks;
    },

    /** Resolved / PATH / repo `cairn --version` (spawns, so never blocks boot). */
    async loadVersions() {
      try {
        state.versions = await api.call("cairn:versions");
      } catch {
        state.versions = null;
      }
      emit("versions", state.versions);
      return state.versions;
    },

    /** Run/ui defaults only; the main process refuses any other key. */
    async saveSettings(patch) {
      state.settings = await api.call("settings:update", patch);
      emit("settings", state.settings);
      return state.settings;
    },

    /**
     * Validated in main; a binary not named `cairn…` asks for confirmation
     * in a native dialog.
     * @param {string | null} value
     */
    async setCairnBin(value) {
      state.settings = await api.call("settings:set-cairn-bin", value);
      emit("settings", state.settings);
      return state.settings;
    },

    /**
     * Validated in main; a folder typed by hand (not picked with Browse…)
     * asks for confirmation in a native dialog.
     * @param {string | null} value
     */
    async setArtifactRoot(value) {
      state.settings = await api.call("settings:set-artifact-root", value);
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
   * The reference run-scoped IPC calls should use for an opened run: its
   * absolute folder (valid for restored stashes, which live outside the
   * artifact root) before its id (which only resolves inside the root).
   * @param {Record<string, any> | null | undefined} detail
   * @returns {string | null}
   */
  function runRefOf(detail) {
    if (typeof detail?.runDir === "string" && detail.runDir)
      return detail.runDir;
    if (typeof detail?.runId === "string" && detail.runId) return detail.runId;
    return null;
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
   * Live-record plumbing shared by app-started runs, detected runs, and
   * invocation journals: every record carries the rolled-up model from
   * lib/events.js (the same reducer the main process uses), a bounded raw
   * event buffer for the event pane, monotonic counters so views append
   * only what is new, and a `dirty` set of model sections the Live view
   * repaints on its next frame.
   * @param {Record<string, any>} record
   * @returns {Record<string, any>}
   */
  function initLiveRecord(record) {
    record.model = record.model ?? Events.createRunModel();
    record.events = record.events ?? [];
    record.eventTotal = record.eventTotal ?? 0;
    record.logs = record.logs ?? [];
    record.logTotal = record.logTotal ?? 0;
    record.dirty = record.dirty ?? new Set(["all"]);
    record.steps = record.model.steps;
    return record;
  }

  /**
   * @param {Record<string, any>} record
   * @param {Iterable<string>} sections
   */
  function markDirty(record, sections) {
    if (!record) return;
    if (!record.dirty) record.dirty = new Set();
    for (const section of sections) record.dirty.add(section);
  }

  /**
   * Fold streamed events into a record's model and event buffer.
   * @param {Record<string, any>} record
   * @param {Array<Record<string, any>>} events
   * @returns {Record<string, any>}
   */
  function applyEventsToRecord(record, events) {
    initLiveRecord(record);
    for (const event of events ?? []) {
      markDirty(record, Events.applyEvent(record.model, event));
      record.events.push(event);
      record.eventTotal += 1;
    }
    if (record.events.length > MAX_EVENTS)
      record.events.splice(0, record.events.length - MAX_EVENTS);
    markDirty(record, ["events"]);
    record.steps = record.model.steps;
    return record;
  }

  /**
   * Append cairn NDJSON log lines (stderr of an app-started run).
   * @param {Record<string, any>} record
   * @param {Record<string, any>} entry
   */
  function appendLog(record, entry) {
    initLiveRecord(record);
    record.logs.push(entry);
    record.logTotal += 1;
    if (record.logs.length > MAX_LOGS)
      record.logs.splice(0, record.logs.length - MAX_LOGS);
    markDirty(record, ["logs"]);
  }

  /**
   * Kept for compatibility: the per-step rows of a record (now the model's).
   * @param {any} record
   */
  function rollupSteps(record) {
    if (!record.model) {
      record.model = Events.reduceEvents(record.events ?? []);
      initLiveRecord(record);
    }
    record.steps = record.model.steps;
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
        record = initLiveRecord({
          runId: run.runId,
          spec: run.spec ?? run.runId,
          runDir: run.runDir ?? null,
          startedAtMs: run.startedAtMs ?? null,
          lastActivityMs: run.lastActivityMs ?? null,
          liveness: run.liveness ?? null,
          invocation: run.invocation ?? null,
          done: null,
          stale: false,
        });
        state.detected.set(run.runId, record);
        continue;
      }
      if (record.done) continue;
      record.runDir = run.runDir ?? record.runDir;
      record.spec = run.spec ?? record.spec;
      record.startedAtMs = run.startedAtMs ?? record.startedAtMs;
      record.lastActivityMs = run.lastActivityMs ?? record.lastActivityMs;
      record.invocation = run.invocation ?? record.invocation;
      const nextState = run.liveness?.state ?? null;
      if ((record.liveness?.state ?? null) !== nextState) {
        changed = true;
        markDirty(record, ["status"]);
      }
      record.liveness = run.liveness ?? record.liveness;
      if (record.stale) {
        record.stale = false;
        changed = true;
        markDirty(record, ["status"]);
      }
    }
    for (const record of state.detected.values()) {
      if (record.done || record.stale || seen.has(record.runId)) continue;
      record.stale = true;
      markDirty(record, ["status"]);
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
      record = initLiveRecord({
        runId,
        spec: runId,
        runDir: null,
        startedAtMs: null,
        lastActivityMs: Date.now(),
        liveness: null,
        invocation: null,
        done: null,
        stale: false,
      });
      state.detected.set(runId, record);
    }
    applyEventsToRecord(record, events);
    if (record.model.invocation && !record.invocation)
      record.invocation = record.model.invocation;
    if (record.model.spec && record.spec === runId)
      record.spec = record.model.spec;
    record.lastActivityMs = Date.now();
    return record;
  }

  /**
   * @param {{ runId: string, runDir?: string | null, status?: string | null, summary?: string | null, invocation?: Record<string, any> | null, refusal?: Record<string, any> | null }} payload
   * @returns {Record<string, any> | null}
   */
  function markExternalFinished(payload) {
    const record = state.detected.get(payload.runId);
    if (!record || record.done) return null;
    if (payload.runDir) record.runDir = payload.runDir;
    if (payload.invocation && !record.invocation)
      record.invocation = payload.invocation;
    record.done = {
      ok: payload.status === "passed",
      status: payload.status ?? "unknown",
      summary: payload.summary ?? null,
      // status "refused": the environment policy said no (run.json refusal)
      refusal: payload.refusal ?? null,
      at: Date.now(),
    };
    markDirty(record, ["status", "badges"]);
    return record;
  }

  // ── invocation journals (watcher pushes) ──────────────────────────────────

  /**
   * Sync the invocation map with a watcher snapshot (journal + ETA). Records
   * are kept with their streamed model; ones that left the snapshot are
   * dropped unless a visible card still references them.
   * @param {Array<Record<string, any>>} list
   * @returns {boolean} true when the visible set changed
   */
  function syncInvocations(list) {
    let changed = false;
    const seen = new Set();
    for (const journal of list ?? []) {
      const id = journal?.invocationId;
      if (!id) continue;
      seen.add(id);
      let record = state.invocations.get(id);
      if (!record) {
        record = initLiveRecord({ invocationId: id, journal });
        state.invocations.set(id, record);
        changed = true;
      } else {
        if (record.journal?.status !== journal.status) changed = true;
        if (
          record.journal?.current?.index !== journal.current?.index ||
          record.journal?.eta?.etaMs !== journal.eta?.etaMs
        )
          markDirty(record, ["status"]);
        record.journal = journal;
      }
      markDirty(record, ["journal"]);
    }
    for (const [id, record] of state.invocations) {
      if (seen.has(id)) continue;
      const referenced =
        [...state.live.values()].some((entry) => entry.invocation?.id === id) ||
        [...state.detected.values()].some(
          (entry) => entry.invocation?.id === id,
        );
      if (!referenced && record) {
        state.invocations.delete(id);
        changed = true;
      }
    }
    return changed;
  }

  /**
   * @param {string} invocationId
   * @param {Array<Record<string, any>>} events
   * @returns {Record<string, any> | null}
   */
  function applyInvocationEvents(invocationId, events) {
    if (!invocationId || !Array.isArray(events) || !events.length) return null;
    let record = state.invocations.get(invocationId);
    if (!record) {
      record = initLiveRecord({ invocationId, journal: null });
      state.invocations.set(invocationId, record);
    }
    return applyEventsToRecord(record, events);
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

  // Typed against globals.d.ts: a member missing there, or one whose
  // signature drifted from its declaration, fails the renderer typecheck.
  /** @type {Partial<StudioGlobal>} */
  const published = {
    api,
    state,
    on,
    emit,
    navigate,
    toast,
    setStatus,
    setStatusRight,
    confirm,
    promptText,
    actions,
    runLabel,
    runRefOf,
    outcomeLabel,
    rollupSteps,
    initLiveRecord,
    markDirty,
    applyEventsToRecord,
    appendLog,
    syncInvocations,
    applyInvocationEvents,
    syncDetected,
    applyExternalEvents,
    markExternalFinished,
    suppressDetectedRun,
    hideDetected,
    fmt,
  };
  Object.assign(Studio, published);
})();
