/**
 * Invocations view — one row per `cairn run` process.
 *
 * An invocation is what a person or an agent actually launches: a terminal
 * `cairn run a.yml b.yml`, an MCP agent's run, or a Run button here. It has
 * a life of its own outside any run directory — services boot and
 * `--before` hooks happen before the first run exists, `--after` hooks after
 * the last — and its own logs under `<artifactRoot>/_invocations/<id>/logs/`.
 * Runs lists run directories and Live shows what is in flight right now; this
 * view is the invocation history: newest first, finished ones included.
 *
 * Master/detail. The list (an ARIA listbox: arrows move, selection follows
 * focus) shows status, origin (CLI / MCP agent + client / Studio), start
 * time, elapsed, progress and liveness. The detail shows the current phase
 * (`phase.changed` / `run.heartbeat` from the journal's events.ndjson, read
 * with the `invocation:events` offset reader), the planned specs with their
 * status and links into Run detail, and tails of narration.log,
 * services-*.log and hook-*.log that follow the bottom while it runs.
 *
 * Stop sends SIGINT to the invocation's pid. The main process refuses it
 * unless the journal is running and the pid is a live cairn process that
 * started no later than the journal, and asks in a native dialog first; the
 * button is never offered for a finished invocation.
 */
(function bootInvocationsView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, api, fmt, toast } = Studio;

  /** Journals listed (newest first). */
  const LIST_LIMIT = 60;
  /** How often the list re-reads the journals. */
  const LIST_POLL_MS = 2500;
  /** How often the selected invocation's events and logs are tailed. */
  const DETAIL_POLL_MS = 1000;
  /** Elapsed clocks and the phase banner. */
  const TICK_MS = 500;
  /** Offset reads per poll before yielding (a long journal catches up). */
  const MAX_EVENT_READS = 6;

  /** @type {HTMLElement | null} */
  let viewRoot = null;
  /** Bumped by every render; a handle only tears down its own render. */
  let renderSeq = 0;
  /** @type {HTMLElement | null} */
  let listHost = null;
  /** @type {HTMLElement | null} */
  let detailHost = null;
  /** @type {HTMLElement | null} */
  let subtitle = null;
  /** @type {Array<Record<string, any>>} */
  let journals = [];
  /** @type {Map<string, { el: HTMLElement, sig: string }>} */
  const items = new Map();
  /** @type {string | null} */
  let selectedId = null;
  /** @type {ReturnType<typeof createDetail> | null} */
  let detail = null;
  /** @type {Array<ReturnType<typeof setInterval>>} */
  let timers = [];
  let listLoading = false;
  /** @type {unknown} */
  let listError = null;

  // ── pure helpers (unit-tested) ───────────────────────────────────────────

  /**
   * Status of every planned spec: the run the journal recorded for it, the
   * current one, or — when the invocation ended before reaching it — "not
   * run" instead of a misleading "pending". A spec the environment policy
   * refused has no run (no run directory): its `run.refused` journal event
   * (`refusals`, the reduced model's list) makes it "refused".
   * @param {Record<string, any> | null} journal
   * @param {Array<Record<string, any>>} [refusals] model.refusals
   * @param {Record<string, any> | null} [bailed] model.policy.bailed
   * @returns {Array<{ index: number, spec: string, labels: Record<string, string> | null, status: string, reason: string | null, runId: string | null, refusal: ReturnType<typeof CairnPolicy.normalizeRefusal> }>}
   */
  function plannedRows(journal, refusals = [], bailed = null) {
    const runs = new Map(
      (journal?.runs ?? []).map((/** @type {any} */ entry) => [
        entry.index,
        entry,
      ]),
    );
    const ended = journal?.status && journal.status !== "running";
    return (journal?.planned ?? []).map((/** @type {any} */ entry) => {
      const run = runs.get(entry.index);
      const isCurrent = journal?.current?.index === entry.index;
      const refused = run
        ? null
        : Studio.events.plannedRefusal(refusals, entry);
      let status =
        run?.status ??
        (refused ? "refused" : isCurrent ? "running" : "pending");
      // A run still "running" in an ended journal was cut off.
      if (ended && status === "running") status = "interrupted";
      // --bail: specs the first failure kept from starting are skipped, not
      // "not run" (an invocation.bailed event or the settled summary says so)
      let reason = null;
      if (ended && status === "pending") {
        const skipped =
          Boolean(bailed) || Number(journal?.summary?.skipped) > 0;
        status = skipped ? "skipped" : "not run";
        if (skipped)
          reason = bailed?.spec ? `bailed after ${bailed.spec}` : "bailed";
      }
      return {
        reason,
        index: entry.index,
        spec: entry.spec,
        labels: entry.labels ?? null,
        status,
        // A `synthetic` entry errored before its run started: its runId
        // names no directory, so there is no run to open.
        runId: run?.synthetic
          ? null
          : (run?.runId ??
            (isCurrent ? (journal?.current?.runId ?? null) : null)),
        // status "refused": why the environment policy said no
        refusal:
          status === "refused"
            ? CairnPolicy.normalizeRefusal(refused ?? run?.refusal)
            : null,
      };
    });
  }

  /**
   * `done/total` for the list and the head: finished planned runs, refused
   * ones included (they are settled, without a run). The list has no
   * journal events: a finished journal's summary accounts for its refusals.
   * @param {Record<string, any> | null} journal
   * @param {Array<Record<string, any>>} [refusals] model.refusals
   * @returns {{ done: number, total: number, text: string }}
   */
  function progressOf(journal, refusals = []) {
    const total = journal?.planned?.length ?? 0;
    const ran = (journal?.runs ?? []).filter(
      (/** @type {any} */ entry) => entry.status && entry.status !== "running",
    );
    const refused = Studio.events.invocationRefusedCount(journal, refusals);
    const done = Math.min(total, ran.length + refused);
    return { done, total, text: total ? `${done}/${total}` : "—" };
  }

  /**
   * The status to show: the journal's, or "refused" when the environment
   * policy refused every planned spec (or the invocation exited 7).
   * @param {Record<string, any> | null} journal
   * @param {Array<Record<string, any>>} [refusals] model.refusals
   * @returns {string}
   */
  function displayStatus(journal, refusals = []) {
    return (
      Studio.events.invocationStatus(journal, refusals) ??
      String(journal?.status ?? "unknown")
    );
  }

  /**
   * Tab order of a journal log: narration, services, before hooks, after
   * hooks, anything else (the order lib/invocations.js lists them in).
   * @param {string} file
   * @returns {number}
   */
  function logRank(file) {
    const name = file.split("/").pop() ?? "";
    if (name === "narration.log") return 0;
    if (name.startsWith("services-")) return 1;
    if (name.startsWith("hook-before-")) return 2;
    if (name.startsWith("hook-after-")) return 3;
    return 4;
  }

  /**
   * A readable tab label for a journal log path.
   * @param {string} logPath e.g. `logs/hook-after-01-<runId>.log`
   * @returns {string}
   */
  function logLabel(logPath) {
    const name = String(logPath ?? "")
      .split("/")
      .pop()
      ?.replace(/\.log$/, "");
    if (!name) return String(logPath ?? "log");
    if (name === "narration") return "narration";
    const services = /^services-(.+)$/.exec(name);
    if (services) return `services ${services[1]}`;
    const hook = /^hook-(before|after)-0*(\d+)(?:-(.+))?$/.exec(name);
    if (hook) {
      const spec = hook[3]
        ? (/_(.+)_[0-9a-f]{6}(?:-\d+)?$/.exec(hook[3])?.[1] ?? hook[3])
        : null;
      return `${hook[1]} hook #${hook[2]}${spec ? ` · ${spec}` : ""}`;
    }
    return name;
  }

  /**
   * A short title: the first planned spec (+N more), else the argv.
   * @param {Record<string, any> | null} journal
   * @returns {string}
   */
  function titleOf(journal) {
    const planned = journal?.planned ?? [];
    if (planned.length) {
      const first = String(planned[0].spec).split("/").pop();
      return planned.length > 1
        ? `${first} +${planned.length - 1} more`
        : `${first}`;
    }
    return (
      (journal?.argv ?? []).join(" ") || String(journal?.invocationId ?? "")
    );
  }

  /**
   * @param {Record<string, any> | null} journal
   * @returns {number | null} start epoch ms
   */
  function startMs(journal) {
    const value = Date.parse(journal?.startedAt ?? "");
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Elapsed (running) or total duration (finished).
   * @param {Record<string, any> | null} journal
   * @param {number} now
   */
  function durationText(journal, now) {
    const start = startMs(journal);
    if (start === null) return "—";
    const end = Date.parse(journal?.endedAt ?? "");
    if (journal?.status !== "running" || !journal?.alive)
      return Number.isFinite(end)
        ? fmt.formatDuration(Math.max(0, end - start))
        : fmt.formatDuration(journal?.summary?.durationMs ?? null);
    return fmt.formatDuration(Math.max(0, now - start));
  }

  /**
   * @param {string | null | undefined} status
   * @param {boolean} alive
   */
  function statusDot(status, alive) {
    const tone =
      status === "running" && alive
        ? "running"
        : status === "aborted"
          ? "warn"
          : fmt.statusTone(status);
    return h("span", { class: `dot dot-${tone}`, ariaHidden: "true" });
  }

  /** @param {string | null | undefined} status */
  function statusTone(status) {
    if (status === "running") return "info";
    if (status === "aborted") return "warn";
    const tone = fmt.statusTone(status);
    return tone === "muted" ? undefined : tone;
  }

  /**
   * Pids of runs this app started, so their invocations read "Studio".
   * @returns {Set<number>}
   */
  function appPids() {
    const pids = new Set();
    for (const record of state.live.values())
      if (Number.isInteger(record.pid)) pids.add(record.pid);
    return pids;
  }

  // ── list ─────────────────────────────────────────────────────────────────

  /**
   * @param {Record<string, any>} journal
   * @param {Set<number>} pids
   */
  function itemSig(journal, pids) {
    return JSON.stringify([
      journal.status,
      journal.summary,
      journal.alive,
      journal.origin,
      journal.client,
      pids.has(journal.pid),
      journal.liveness?.state,
      journal.current?.index,
      (journal.runs ?? []).map((/** @type {any} */ entry) => entry.status),
      journal.endedAt,
      journal.delegate?.remoteInvocationId ?? null,
    ]);
  }

  /**
   * @param {HTMLElement} el
   * @param {Record<string, any>} journal
   * @param {Set<number>} pids
   */
  function paintItem(el, journal, pids) {
    Studio.clear(el);
    const progress = progressOf(journal);
    const running = journal.status === "running" && journal.alive;
    const start = startMs(journal);
    const shown = displayStatus(journal);
    el.setAttribute(
      "aria-label",
      `${shown} invocation, ${titleOf(journal)}, ${progress.text} specs`,
    );
    el.appendChild(
      Studio.frag(
        h(
          "div",
          { class: "inv-item-head" },
          statusDot(shown, journal.alive),
          Studio.tag(shown, statusTone(shown)),
          Studio.originBadge(journal, { fromApp: pids.has(journal.pid) }),
          delegateTag(journal),
          progress.total
            ? h("span", {
                class: "tag",
                title: "finished / planned specs",
                text: progress.text,
              })
            : null,
          h("span", {
            class: "inv-elapsed mono",
            dataset: running && start !== null ? { start: String(start) } : {},
            text: durationText(journal, Date.now()),
          }),
        ),
        h("div", { class: "inv-item-title mono", text: titleOf(journal) }),
        h(
          "div",
          { class: "inv-item-meta cell-dim" },
          Studio.relTime(journal.startedAt, { prefix: "started " }),
          running ? Studio.livenessTag(journal.liveness) : null,
          journal.status !== "running" && journal.signal
            ? h("span", { text: ` · ${journal.signal}` })
            : null,
        ),
      ),
    );
  }

  /**
   * "delegated" on an invocation whose environment has a runner: its runs
   * execute elsewhere; this process relays them and owns Stop.
   * @param {Record<string, any>} journal
   * @returns {HTMLElement | null}
   */
  function delegateTag(journal) {
    const delegate = journal?.delegate;
    if (!delegate) return null;
    const remote = delegate.remoteInvocationId
      ? `remote invocation ${delegate.remoteInvocationId}`
      : "remote invocation not announced yet";
    return h("span", {
      class: delegate.diagnostics > 0 ? "tag tag-warn" : "tag tag-info",
      title: `runs on a delegated runner (${delegate.command.join(" ")}); ${remote}${
        delegate.diagnostics > 0
          ? `; ${delegate.diagnostics} runner diagnostic(s) in the journal`
          : ""
      }. Stop cancels the runner, which cancels the remote invocation.`,
      text: "delegated",
    });
  }

  function paintList() {
    if (!listHost) return;
    const pids = appPids();
    if (!journals.length) {
      items.clear();
      Studio.clear(listHost);
      listHost.appendChild(
        listError
          ? Studio.errorBox(listError, "invocations")
          : listLoading
            ? Studio.loading("reading invocation journals…")
            : Studio.empty(
                "No invocations yet",
                "Every `cairn run` journals itself under <artifact root>/_invocations/: from a terminal, an agent, or the Run buttons here. Run a spec and it appears here with its plan, phase, logs, and a Stop button while it runs.",
                [
                  h("button", {
                    class: "btn btn-primary",
                    type: "button",
                    text: "Open Specs",
                    onClick: () => Studio.navigate("specs"),
                  }),
                ],
              ),
      );
      return;
    }
    listHost.querySelector(".empty, .error-box, .loading")?.remove();
    const seen = new Set();
    /** @type {HTMLElement[]} */
    const ordered = [];
    for (const journal of journals) {
      const id = journal.invocationId;
      seen.add(id);
      let entry = items.get(id);
      const sig = itemSig(journal, pids);
      if (!entry) {
        const el = h("div", {
          class: "inv-item",
          role: "option",
          tabindex: "-1",
          dataset: { id },
          onClick: () => select(id, { focus: true }),
        });
        entry = { el, sig: "" };
        items.set(id, entry);
      }
      if (entry.sig !== sig) {
        paintItem(entry.el, journal, pids);
        entry.sig = sig;
      }
      const on = id === selectedId;
      entry.el.classList.toggle("selected", on);
      entry.el.setAttribute("aria-selected", on ? "true" : "false");
      ordered.push(entry.el);
    }
    // Deleting the current key while iterating a Map is safe.
    for (const id of items.keys()) if (!seen.has(id)) items.delete(id);
    // Move nodes only when out of place, so focus and scroll survive.
    ordered.forEach((el, index) => {
      if (listHost?.children[index] !== el)
        listHost?.insertBefore(el, listHost.children[index] ?? null);
    });
    while (listHost.children.length > ordered.length)
      listHost.removeChild(/** @type {Node} */ (listHost.lastChild));
    const current = selectedId ? items.get(selectedId)?.el : null;
    if (!ordered.some((el) => el.getAttribute("tabindex") === "0"))
      Studio.setRovingStop(ordered, current);
  }

  /** A slow read must not stack polls behind it. */
  let listInFlight = false;

  async function loadList() {
    if (listInFlight) return;
    listInFlight = true;
    listLoading = true;
    try {
      const result = await api.call("invocations:list", { limit: LIST_LIMIT });
      journals = Array.isArray(result?.invocations) ? result.invocations : [];
      listError = null;
      if (subtitle)
        subtitle.textContent = `${journals.length} newest from ${result?.runsRoot ?? "the artifact root"}/_invocations`;
    } catch (error) {
      listError = error;
    } finally {
      listLoading = false;
      listInFlight = false;
    }
    if (!viewRoot) return;
    paintList();
    if (selectedId) {
      const journal =
        journals.find((entry) => entry.invocationId === selectedId) ??
        (await api
          .call("invocation:get", { invocationId: selectedId })
          .catch(() => null));
      if (journal && detail?.id === selectedId) detail.setJournal(journal);
    }
  }

  /**
   * @param {string} id
   * @param {{ focus?: boolean }} [options]
   */
  function select(id, options = {}) {
    if (!viewRoot || !detailHost) return;
    const changed = selectedId !== id;
    selectedId = id;
    state.viewParams = { ...state.viewParams, invocationId: id };
    for (const [key, entry] of items) {
      const on = key === id;
      entry.el.classList.toggle("selected", on);
      entry.el.setAttribute("aria-selected", on ? "true" : "false");
    }
    const el = items.get(id)?.el ?? null;
    if (el) {
      Studio.setRovingStop(
        [...items.values()].map((entry) => entry.el),
        el,
      );
      if (options.focus) el.focus();
    }
    if (!changed && detail) return;
    detail?.destroy();
    const journal = journals.find((entry) => entry.invocationId === id) ?? null;
    detail = createDetail(id, journal);
    Studio.clear(detailHost);
    detailHost.appendChild(detail.root);
    if (!journal)
      void api
        .call("invocation:get", { invocationId: id })
        .then((found) => {
          if (found && detail?.id === id) detail.setJournal(found);
          else if (!found && detail?.id === id) detail.missing();
        })
        .catch(() => detail?.id === id && detail.missing());
    void detail.poll();
  }

  // ── detail ───────────────────────────────────────────────────────────────

  /**
   * @param {string} id
   * @param {Record<string, any> | null} initial
   */
  function createDetail(id, initial) {
    /** @type {Record<string, any> | null} */
    let journal = initial;
    const model = Studio.events.createRunModel();
    let eventsOffset = 0;
    let renderedEvents = 0;
    /** @type {Array<Record<string, any>>} */
    const events = [];
    let final = false;
    let polling = false;
    let headSig = "";
    let planSig = "";
    let policySig = "";
    let setupSig = "";
    let destroyed = false;

    const dot = h("span", { class: "dot dot-running", ariaHidden: "true" });
    const status = Studio.tag("…", "info");
    const originSlot = h("span", { class: "origin-slot" });
    const livenessSlot = h("span", { class: "liveness-slot" });
    const pidTag = h("span", { class: "tag hidden" });
    const elapsed = h("span", {
      class: "elapsed",
      title: "elapsed (running) or total duration",
    });
    const stopButton = h("button", {
      class: "btn btn-sm btn-danger hidden",
      type: "button",
      text: "Stop",
      ariaLabel: `stop invocation ${id} (sends SIGINT after a confirmation)`,
      title: "Send SIGINT to this cairn process, like Ctrl-C (asks first)",
      onClick: () => void stop(),
    });
    const revealButton = h("button", {
      class: "btn btn-sm btn-ghost",
      type: "button",
      text: "Reveal",
      ariaLabel: "reveal the invocation journal folder in Finder",
      onClick: () => {
        if (journal?.dir)
          void api
            .call("fs:reveal", journal.dir)
            .catch((error) =>
              toast("Reveal failed", String(error?.message ?? error), "bad"),
            );
      },
    });
    const banner = h("div", { class: "phase-banner idle" });
    Studio.paintPhaseBanner(banner, null, "reading the journal…");
    const failure = h("div", { class: "error-box hidden" });
    const facts = h("div", { class: "inv-facts" });
    const planTitle = h(
      "div",
      { class: "section-title", style: { marginTop: "0" } },
      "Plan",
    );
    const planList = h("ol", {
      class: "planned-list inv-plan",
      ariaLabel: "planned specs",
    });
    // Readiness gates services / the web server waited on, and suite / seed
    // fixtures: the journal's gate.* and fixture.* events.
    const setupTitle = h(
      "div",
      { class: "section-title hidden" },
      "Gates & fixtures",
    );
    const setupList = h("div", { class: "timeline inv-setup hidden" });
    const output = Studio.panes.createOutputPanel({ title: "Logs" });
    // what the config run: block, --bail and --suite did (journal events)
    const policyTitle = h(
      "div",
      { class: "section-title hidden", style: { marginTop: "0" } },
      "Run policy",
    );
    const policyHost = h("div", { class: "inv-policy hidden" });
    const suiteTag = h("span", { class: "tag hidden" });
    const root = h(
      "section",
      {
        class: "panel inv-detail",
        ariaLabel: `invocation ${id}`,
      },
      h(
        "div",
        { class: "panel-head inv-head" },
        dot,
        h("span", { class: "mono card-title", title: id, text: id }),
        status,
        originSlot,
        livenessSlot,
        pidTag,
        suiteTag,
        delegateTag(journal),
        elapsed,
        h("div", { class: "card-actions" }, stopButton, revealButton),
      ),
      banner,
      h(
        "div",
        { class: "panel-body" },
        failure,
        facts,
        policyTitle,
        policyHost,
        h(
          "div",
          { class: "inv-detail-grid" },
          h(
            "div",
            { class: "inv-plan-col" },
            planTitle,
            planList,
            setupTitle,
            setupList,
          ),
          h("div", { class: "inv-logs-col" }, output.el),
        ),
      ),
    );

    /** The run policy's findings, from the journal's events and summary. */
    function paintPolicy() {
      const summary = journal?.summary ?? null;
      const services = model.services.filter(
        (/** @type {any} */ row) =>
          row.phase === "teardown" &&
          row.event === "fail" &&
          (row.data?.critical || row.data?.provisioner),
      );
      const suite = journal?.suite ?? model.policy.suite?.name ?? null;
      const sig = JSON.stringify([
        { ...model.policy, metrics: model.policy.metrics.length },
        summary?.runPolicy ?? null,
        summary?.skipped ?? null,
        summary?.exitCode ?? null,
        services.length,
        suite,
      ]);
      if (sig === policySig) return;
      policySig = sig;
      if (suite) {
        suiteTag.textContent = `suite ${suite}`;
        suiteTag.title = "cairn run --suite";
        suiteTag.className = "tag tag-info";
      } else suiteTag.className = "tag hidden";
      Studio.clear(policyHost);
      const panel = Studio.ops.policyPanel({
        policy: model.policy,
        summary,
        services,
      });
      policyTitle.classList.toggle("hidden", !panel);
      policyHost.classList.toggle("hidden", !panel);
      if (panel) policyHost.appendChild(panel);
    }

    /** Gate waits and fixture verbs from the journal (repainted on change). */
    function paintSetup() {
      const sig = JSON.stringify([
        model.gates.map((gate) => [
          gate.name,
          gate.status,
          gate.attempts,
          gate.lastDetail,
        ]),
        model.fixtures.map((row) => [row.name, row.lastVerb, row.lastStatus]),
      ]);
      if (sig === setupSig) return;
      setupSig = sig;
      const empty = !model.gates.length && !model.fixtures.length;
      setupTitle.classList.toggle("hidden", empty);
      setupList.classList.toggle("hidden", empty);
      Studio.clear(setupList);
      for (const gate of model.gates) {
        const scope = Studio.events.gateScopeLabel(gate.scope);
        setupList.appendChild(
          h(
            "div",
            { class: "timeline-row gate-live", dataset: { gate: gate.name } },
            h("span", {
              class: `dot dot-${
                gate.status === "waiting"
                  ? "running"
                  : gate.status === "passed"
                    ? "ok"
                    : gate.status === "failed" && !gate.cancelled
                      ? "bad"
                      : "warn"
              }`,
            }),
            h(
              "span",
              { class: "label", title: gate.lastDetail ?? "" },
              `gate ${gate.name}${scope ? ` (${scope})` : ""}`,
              h("span", {
                class: "cell-dim",
                text: ` · ${
                  gate.status === "waiting"
                    ? `attempt ${gate.attempts || 1}`
                    : gate.status === "passed"
                      ? "ready"
                      : gate.timedOut
                        ? "timed out"
                        : gate.status
                }${gate.lastDetail ? ` — ${gate.lastDetail}` : ""}`,
              }),
            ),
            h("span", {
              class: "ts",
              text:
                gate.status === "waiting"
                  ? "…"
                  : fmt.formatDuration(gate.durationMs),
            }),
          ),
        );
      }
      for (const row of model.fixtures)
        setupList.appendChild(
          h(
            "div",
            { class: "timeline-row fixture-live", dataset: { name: row.name } },
            h("span", {
              class: `dot dot-${Studio.events.fixtureTone(row.lastStatus)}`,
            }),
            h(
              "span",
              { class: "label" },
              `fixture ${row.name}${row.scope ? ` (${row.scope})` : ""}`,
              ...row.order.map((/** @type {string} */ verb) =>
                h("span", {
                  class:
                    `tag tag-${Studio.events.fixtureTone(row.verbs[verb].status)}`.replace(
                      "tag-muted",
                      "tag",
                    ),
                  title: row.verbs[verb].error ?? row.verbs[verb].reason ?? "",
                  text: `${verb} ${row.verbs[verb].status}`,
                }),
              ),
            ),
            h("span", { class: "ts", text: "" }),
          ),
        );
    }

    /** Add a tab for every log the journal holds or announced. */
    function syncSources() {
      /** @type {string[]} */
      const paths = [];
      for (const entry of journal?.logs ?? []) paths.push(entry.path);
      for (const entry of model.logs ?? [])
        if (typeof entry.path === "string" && !paths.includes(entry.path))
          paths.push(entry.path);
      for (const file of paths.toSorted((a, b) => logRank(a) - logRank(b))) {
        const sourceId = `file:${file}`;
        if (output.sources.has(sourceId)) continue;
        output.addSource(sourceId, logLabel(file), { file });
      }
      if (!output.sources.has("events")) {
        // Events come last; select them only when there is no log at all.
        const source = output.addSource("events", "events");
        if (output.sources.size === 1) output.select(source.id);
      }
    }

    function paintHead() {
      if (!journal) return;
      const pids = appPids();
      const sig = JSON.stringify([
        journal.status,
        journal.alive,
        journal.pid,
        journal.pidAlive,
        journal.origin,
        journal.client,
        pids.has(journal.pid),
        journal.liveness?.state,
        journal.liveness?.reason,
        journal.summary,
        model.refusals.length,
        journal.signal,
        journal.endedAt,
        journal.env,
        journal.labels,
      ]);
      if (sig === headSig) return;
      headSig = sig;
      const running = journal.status === "running" && journal.alive;
      const shown = displayStatus(journal, model.refusals);
      dot.className = `dot dot-${
        running
          ? "running"
          : shown === "aborted"
            ? "warn"
            : fmt.statusTone(shown)
      }`;
      status.textContent = shown;
      status.className = `tag${
        statusTone(shown) ? ` tag-${statusTone(shown)}` : ""
      }`;
      Studio.clear(originSlot);
      const origin = Studio.originBadge(journal, {
        fromApp: pids.has(journal.pid),
      });
      if (origin) originSlot.appendChild(origin);
      Studio.clear(livenessSlot);
      const liveness = running ? Studio.livenessTag(journal.liveness) : null;
      if (liveness) livenessSlot.appendChild(liveness);
      if (journal.pid) {
        pidTag.textContent = `pid ${journal.pid}${
          journal.pidAlive === false ? " (gone)" : ""
        }`;
        pidTag.className = `tag${
          journal.pidAlive === false ? " tag-warn" : ""
        }`;
      } else pidTag.className = "tag hidden";
      // Stop is offered only while the journal runs and its process lives;
      // main re-checks everything (and asks natively) before signalling.
      stopButton.classList.toggle("hidden", !running);
      stopButton.toggleAttribute("disabled", false);

      const summary = journal.summary ?? null;
      const problem =
        summary?.error ??
        (journal.status === "aborted"
          ? journal.signal
            ? `aborted by ${journal.signal}`
            : (journal.liveness?.reason ??
              "the process ended without finishing the journal")
          : null);
      if (problem) {
        Studio.clear(failure);
        failure.append(
          h("strong", { text: journal.status }),
          h("pre", { text: String(problem) }),
        );
        failure.classList.remove("hidden");
      } else failure.classList.add("hidden");

      /** @type {Array<[string, any]>} */
      const rows = [
        [
          "started",
          journal.startedAt
            ? h(
                "span",
                Studio.relTime(journal.startedAt),
                ` · ${fmt.formatTimestamp(journal.startedAt)}`,
              )
            : "—",
        ],
      ];
      if (journal.endedAt)
        rows.push(["ended", fmt.formatTimestamp(journal.endedAt)]);
      if (summary) {
        const refused = Studio.events.invocationRefusedCount(
          journal,
          model.refusals,
        );
        rows.push([
          "result",
          `${summary.passed ?? 0} passed · ${summary.failed ?? 0} failed · ${
            summary.errored ?? 0
          } errored${refused ? ` · ${refused} refused` : ""}${
            summary.skipped ? ` · ${summary.skipped} skipped (bailed)` : ""
          } of ${summary.total ?? "?"} · exit ${summary.exitCode ?? "?"}${
            summary.exitCode === 7
              ? " (refused by the environment policy)"
              : summary.exitCode === 8
                ? " (critical teardown failed)"
                : summary.exitCode === 9
                  ? " (dirty state after the run)"
                  : ""
          }`,
        ]);
      }
      if (journal.env) rows.push(["environment", journal.env]);
      if (journal.parallel && journal.parallel > 1)
        rows.push(["parallel", String(journal.parallel)]);
      if (journal.labels && Object.keys(journal.labels).length)
        rows.push([
          "labels",
          Object.entries(journal.labels)
            .map(([key, value]) => `${key}=${value}`)
            .join("  "),
        ]);
      if (journal.client) rows.push(["client", journal.client]);
      if (journal.cwd) rows.push(["cwd", journal.cwd]);
      rows.push([
        "command",
        Studio.codeBlock(`cairn ${(journal.argv ?? []).join(" ")}`.trim(), {
          tight: true,
        }),
      ]);
      Studio.clear(facts);
      facts.appendChild(Studio.keyValue(rows));
    }

    function paintPlan() {
      const rows = plannedRows(journal, model.refusals, model.policy.bailed);
      const sig = JSON.stringify(rows);
      if (sig === planSig) return;
      planSig = sig;
      const progress = progressOf(journal, model.refusals);
      planTitle.textContent = `Plan (${progress.text})`;
      Studio.clear(planList);
      if (!rows.length) {
        planList.appendChild(
          h("li", { class: "cell-dim", text: "no planned specs recorded" }),
        );
        return;
      }
      for (const row of rows) {
        const tone =
          row.status === "running"
            ? "running"
            : row.status === "pending" || row.status === "not run"
              ? "muted"
              : fmt.statusTone(row.status);
        planList.appendChild(
          h(
            "li",
            {
              class: `planned-item planned-${row.status.replace(/\s+/g, "-")}`,
            },
            h("span", { class: `dot dot-${tone}`, ariaHidden: "true" }),
            h("span", {
              class: "mono planned-spec",
              title: row.spec,
              text: row.spec,
            }),
            row.labels
              ? h("span", {
                  class: "cell-dim",
                  text: Object.entries(row.labels)
                    .map(([key, value]) => `${key}=${value}`)
                    .join(" "),
                })
              : null,
            h("span", {
              class: "planned-status cell-dim",
              title:
                row.status === "refused"
                  ? CairnPolicy.refusalText(row.refusal)
                  : null,
              text: row.reason ? `${row.status} · ${row.reason}` : row.status,
            }),
            row.status === "refused" && row.refusal?.reason
              ? h("span", {
                  class: "planned-refusal",
                  title: CairnPolicy.refusalText(row.refusal),
                  text: fmt.truncate(row.refusal.reason, 80),
                })
              : null,
            row.runId
              ? h("button", {
                  class: "btn btn-sm btn-ghost",
                  type: "button",
                  text: "Open run",
                  ariaLabel: `open the run of ${row.spec}`,
                  onClick: () =>
                    Studio.navigate("run", {
                      runRef: row.runId,
                      from: "invocations",
                      invocationId: id,
                    }),
                })
              : null,
          ),
        );
      }
    }

    function paintEvents() {
      const source = output.sources.get("events");
      if (!source || renderedEvents >= events.length) return;
      const slice = events.slice(
        Math.max(renderedEvents, events.length - Studio.panes.MAX_PANE_LINES),
      );
      source.pane.append(slice.map(Studio.panes.eventLine));
      renderedEvents = events.length;
    }

    /** @param {number} now */
    function tick(now) {
      elapsed.textContent = journal ? durationText(journal, now) : "—";
      const running = journal?.status === "running" && journal?.alive;
      const phase = running ? Studio.events.currentPhase(model, now) : null;
      Studio.paintPhaseBanner(
        banner,
        phase,
        !journal
          ? "reading the journal…"
          : running
            ? model.eventCount
              ? "between phases…"
              : "waiting for the first phase…"
            : `finished · ${displayStatus(journal, model.refusals)}`,
      );
    }

    async function pollEvents() {
      for (let read = 0; read < MAX_EVENT_READS; read += 1) {
        const result = await api.call("invocation:events", {
          invocationId: id,
          offset: eventsOffset,
        });
        if (destroyed) return 0;
        eventsOffset = result?.offset ?? eventsOffset;
        const batch = Array.isArray(result?.events) ? result.events : [];
        for (const event of batch) {
          Studio.events.applyEvent(model, event);
          events.push(event);
        }
        if (events.length > 4000) {
          const drop = events.length - 4000;
          events.splice(0, drop);
          renderedEvents = Math.max(0, renderedEvents - drop);
        }
        if (!batch.length) return read;
      }
      return MAX_EVENT_READS;
    }

    /** One poll: events, then the log tails (lazily once finished). */
    async function poll() {
      if (polling || destroyed || final) return;
      polling = true;
      try {
        const ended =
          Boolean(journal) &&
          !(journal?.status === "running" && journal?.alive);
        await pollEvents();
        if (destroyed) return;
        syncSources();
        paintEvents();
        paintSetup();
        paintPolicy();
        // run.refused events settle planned specs that never got a run (and
        // may make the whole invocation "refused").
        if (journal && (model.refusals.length || model.policy.bailed)) {
          paintHead();
          paintPlan();
        }
        for (const source of output.sources.values()) {
          if (!source.file) continue;
          const visible = output.selected() === source.id;
          // A finished invocation's logs no longer grow: fetch each tab once,
          // when it is shown.
          if (ended && (source.fetched || !visible)) continue;
          await Studio.panes.pollFileSource(source, { invocationId: id });
          if (ended) Studio.panes.flushCarry(source);
        }
        // Stop polling once an ended journal is drained and every tab the
        // reader has opened is loaded; selecting another tab re-polls.
        if (ended)
          final = [...output.sources.values()].every(
            (source) => !source.file || source.fetched,
          );
      } catch {
        // the next poll retries
      } finally {
        polling = false;
      }
      tick(Date.now());
    }

    async function stop() {
      stopButton.toggleAttribute("disabled", true);
      try {
        const result = await api.call("invocation:stop", { invocationId: id });
        if (result?.stopped)
          toast(
            "SIGINT sent",
            `${
              result.target === "group"
                ? `process group ${result.pid}`
                : `pid ${result.pid}`
            }: cairn is stopping the current spec; the journal turns "aborted" when it exits.`,
            "info",
            6000,
          );
      } catch (error) {
        toast("Not stopped", String(error?.message ?? error), "bad", 9000);
      } finally {
        stopButton.toggleAttribute("disabled", false);
        void loadList();
      }
    }

    // Selecting a log tab of a finished invocation loads it on demand.
    output.el.addEventListener("click", () => {
      final = false;
      void poll();
    });

    if (journal) {
      paintHead();
      paintPlan();
    }
    syncSources();
    tick(Date.now());

    return {
      id,
      root,
      /** @param {Record<string, any>} next */
      setJournal(next) {
        const wasEnded =
          journal && !(journal.status === "running" && journal.alive);
        journal = next;
        // A journal that just ended gets one more full drain.
        if (!wasEnded && !(next.status === "running" && next.alive))
          final = false;
        paintHead();
        paintPlan();
        syncSources();
        tick(Date.now());
      },
      missing() {
        Studio.paintPhaseBanner(
          banner,
          null,
          "this journal is gone (pruned by retention?)",
        );
        final = true;
      },
      poll,
      tick,
      destroy() {
        destroyed = true;
      },
    };
  }

  // ── view lifecycle ───────────────────────────────────────────────────────

  /**
   * @param {HTMLElement} root
   * @param {{ invocationId?: string }} [params]
   */
  async function render(root, params = {}) {
    destroy();
    const seq = ++renderSeq;
    viewRoot = root;
    Studio.clear(root);
    const header = Studio.pageHeader(
      "Invocations",
      "One row per cairn run process: a terminal, an agent through MCP, or this app",
      [
        h("button", {
          class: "btn",
          type: "button",
          text: "Refresh",
          onClick: () => void loadList(),
        }),
        h("button", {
          class: "btn",
          type: "button",
          text: "Go to Live",
          onClick: () => Studio.navigate("live"),
        }),
      ],
    );
    subtitle = /** @type {HTMLElement | null} */ (header.querySelector(".sub"));
    root.appendChild(header);
    const notice = Studio.setupNotice();
    if (notice) root.appendChild(notice);
    listHost = h("div", {
      class: "inv-list",
      role: "listbox",
      ariaLabel: "invocations, newest first",
    });
    detailHost = h("div", { class: "inv-detail-host" });
    root.appendChild(
      h(
        "div",
        { class: "inv-layout" },
        h("div", { class: "panel inv-list-panel" }, listHost),
        detailHost,
      ),
    );
    Studio.rovingKeys(listHost, {
      items: () => [...items.values()].map((entry) => entry.el),
      roving: true,
      onMove: (item) => {
        const id = item.dataset.id;
        if (id) select(id);
      },
      onActivate: (item) => {
        // Enter moves into the detail: its first control.
        const id = item.dataset.id;
        if (id) select(id);
        /** @type {HTMLElement | null | undefined} */ (
          detailHost?.querySelector("button:not(.hidden):not([disabled])")
        )?.focus();
      },
    });
    listLoading = true;
    paintList();
    await loadList();
    // The view is module state, so a handle may only tear down the render
    // that returned it: after a newer render (or none, once the user left),
    // a stale handle's destroy must not wipe the view now on screen.
    const handle = {
      destroy: () => {
        if (seq === renderSeq) destroy();
      },
    };
    if (seq !== renderSeq || viewRoot !== root) return { destroy() {} };
    if (state.view !== "invocations") {
      // Left while the first list was loading: start no pollers.
      destroy();
      return { destroy() {} };
    }
    // A named invocation older than the list window still opens: main
    // validates the id and reads that journal on its own.
    const wanted =
      typeof params?.invocationId === "string" && params.invocationId
        ? params.invocationId
        : (journals.find((entry) => entry.status === "running" && entry.alive)
            ?.invocationId ??
          journals[0]?.invocationId ??
          null);
    if (wanted) select(wanted);
    else if (detailHost)
      detailHost.appendChild(
        h(
          "div",
          { class: "panel inv-detail-empty" },
          h("p", {
            class: "cell-dim",
            text: "Select an invocation to see its plan, phase, and logs.",
          }),
        ),
      );
    timers = [
      setInterval(() => void loadList(), LIST_POLL_MS),
      setInterval(() => void detail?.poll(), DETAIL_POLL_MS),
      setInterval(() => {
        const now = Date.now();
        detail?.tick(now);
        for (const node of listHost?.querySelectorAll(
          ".inv-elapsed[data-start]",
        ) ?? []) {
          const start = Number(/** @type {HTMLElement} */ (node).dataset.start);
          if (Number.isFinite(start))
            node.textContent = fmt.formatDuration(Math.max(0, now - start));
        }
      }, TICK_MS),
    ];
    return handle;
  }

  function destroy() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
    detail?.destroy();
    detail = null;
    items.clear();
    journals = [];
    selectedId = null;
    viewRoot = null;
    listHost = null;
    detailHost = null;
    subtitle = null;
  }

  Studio.views = Studio.views || {};
  Studio.views.invocations = {
    id: "invocations",
    label: "Invocations",
    glyph: "⇶",
    render,
  };
  Studio.invocationsView = {
    plannedRows,
    progressOf,
    displayStatus,
    logLabel,
    titleOf,
  };
})();
