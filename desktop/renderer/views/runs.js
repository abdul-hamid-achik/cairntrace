/**
 * Runs view — the artifact-root history browser.
 *
 * This is the operator's default landing page: every run cairn has recorded,
 * newest first, filterable by status/spec/text, one click into full evidence.
 */
(function bootRunsView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, actions, fmt, toast, api } = Studio;

  const STATUSES = [
    ["", "all statuses"],
    ["running", "running"],
    ["passed", "passed"],
    ["failed", "failed"],
    ["errored", "errored"],
    ["interrupted", "interrupted"],
  ];
  // No "refused" filter: a spec the environment policy refuses gets no run
  // directory (its refusal lives in Live and the Invocations journal), so
  // the filter could only ever be empty. A refused record, should one ever
  // be written, still lists under "all statuses" with its own style.

  /** @param {HTMLElement} root */
  async function render(root) {
    Studio.clear(root);
    root.appendChild(Studio.loading("loading run history…"));
    await actions.loadRuns();
    paint(root);
  }

  /** @param {HTMLElement} root */
  function paint(root) {
    Studio.clear(root);

    const search = Studio.input({
      type: "search",
      placeholder: "filter by run id, spec, labels, or failure text…",
      value: state.filters.search,
      style: { minWidth: "280px" },
      onInput: debounce((event) => {
        state.filters.search = event.target.value;
        void actions.loadRuns().then(() => paintTable(root));
      }, 260),
    });

    const statusSelect = Studio.select(STATUSES, {
      value: state.filters.status,
      onChange: (event) => {
        state.filters.status = event.target.value;
        void actions.loadRuns().then(() => paintTable(root));
      },
    });

    const specSelect = Studio.select(
      [
        ["", "all specs"],
        ...(state.specNames ?? []).map((name) => [name, name]),
      ],
      {
        value: state.filters.spec,
        onChange: (event) => {
          state.filters.spec = event.target.value;
          void actions.loadRuns().then(() => paintTable(root));
        },
      },
    );

    const runsRoot = state.runsRoot?.runsRoot ?? "—";

    // Label filter: keys and values discovered from run.json labels.
    const labelKeys = (state.labels ?? []).map((entry) => entry.key);
    const valueSelect = Studio.select([["", "any value"]], {});
    const keySelect = Studio.select(
      [
        ["", labelKeys.length ? "label…" : "no labels found"],
        ...labelKeys.map((key) => [key, key]),
      ],
      {
        disabled: !labelKeys.length,
        onChange: () => {
          const entry = (state.labels ?? []).find(
            (item) => item.key === keySelect.value,
          );
          Studio.clear(valueSelect);
          for (const [value, label] of [
            ["", "any value"],
            ...(entry?.values ?? []).map((v) => [v, v]),
          ])
            valueSelect.appendChild(h("option", { value, text: label }));
        },
      },
    );
    const addLabel = h("button", {
      class: "btn btn-sm",
      type: "button",
      text: "+ label filter",
      disabled: !labelKeys.length,
      onClick: () => {
        if (!keySelect.value) return;
        const filter = valueSelect.value
          ? `${keySelect.value}=${valueSelect.value}`
          : keySelect.value;
        if (!state.filters.labels.includes(filter))
          state.filters.labels.push(filter);
        void actions.loadRuns().then(() => paint(root));
      },
    });
    const chips = state.filters.labels.map((filter) =>
      h(
        "span",
        { class: "tag tag-info chip-filter" },
        filter,
        h("button", {
          class: "chip-x",
          type: "button",
          text: "×",
          title: "remove filter",
          ariaLabel: `remove label filter ${filter}`,
          onClick: () => {
            state.filters.labels = state.filters.labels.filter(
              (entry) => entry !== filter,
            );
            void actions.loadRuns().then(() => paint(root));
          },
        }),
      ),
    );
    const groupToggle = Studio.checkbox(
      "group by invocation",
      state.filters.groupByInvocation,
      (checked) => {
        state.filters.groupByInvocation = checked;
        paintTable(root);
      },
      "group runs that one cairn invocation produced",
    );

    root.appendChild(
      Studio.pageHeader(
        "Runs",
        `${state.runs.length} run${
          state.runs.length === 1 ? "" : "s"
        } from ${runsRoot}`,
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "Reveal artifact root",
            title: runsRoot,
            onClick: () => revealRoot(runsRoot),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Refresh",
            onClick: () => void render(root),
          }),
        ],
      ),
    );

    root.appendChild(
      h(
        "div",
        { class: "toolbar" },
        search,
        statusSelect,
        specSelect,
        keySelect,
        valueSelect,
        addLabel,
        groupToggle,
        h("div", { class: "spacer" }),
        state.runsLoading ? h("span", { class: "spinner" }) : null,
        h("span", {
          class: "cell-dim",
          text: `source: ${state.runsRoot?.source ?? "default"}`,
        }),
      ),
    );

    if (chips.length)
      root.appendChild(h("div", { class: "toolbar filter-chips" }, chips));

    const notice = Studio.setupNotice();
    if (notice) root.appendChild(notice);

    if (state.runsError)
      root.appendChild(Studio.errorBox(state.runsError, "artifact root"));

    const tableHost = h("div", { class: "panel" });
    root.appendChild(tableHost);
    paintTableInto(tableHost);
  }

  /** @param {HTMLElement} root */
  function paintTable(root) {
    const host = root.querySelector(".panel");
    if (!host) {
      paint(root);
      return;
    }
    paintTableInto(/** @type {HTMLElement} */ (host));
  }

  /** @param {HTMLElement} host */
  function paintTableInto(host) {
    Studio.clear(host);
    if (!state.runs.length) {
      host.appendChild(emptyState());
      return;
    }

    const table = h(
      "table",
      { class: "grid" },
      h(
        "thead",
        h(
          "tr",
          h("th", { text: "status" }),
          h("th", { text: "spec" }),
          h("th", { text: "started" }),
          h("th", { class: "num", text: "duration" }),
          h("th", { class: "num", text: "outcomes" }),
          h("th", { text: "backend / env" }),
          h("th", { text: "labels" }),
          h("th", { text: "detail" }),
        ),
      ),
    );

    const body = h("tbody");
    const groups = state.filters.groupByInvocation
      ? groupByInvocation(state.runs)
      : [{ id: null, runs: state.runs }];
    for (const group of groups) {
      if (state.filters.groupByInvocation) body.appendChild(groupHeader(group));
      for (const run of group.runs) body.appendChild(runRow(run));
    }
    table.appendChild(body);
    host.appendChild(table);
    // Rows are one Tab stop: arrows move, Enter/Space open the run.
    const rows = () => /** @type {HTMLElement[]} */ ([
      ...body.querySelectorAll("tr.run-row"),
    ]);
    Studio.setRovingStop(
      rows(),
      rows().find((row) => row.dataset.runId === state.selectedRun),
    );
    Studio.rovingKeys(body, {
      items: rows,
      roving: true,
      onActivate: (row) => openRun(row.dataset.runId ?? ""),
    });
  }

  /** @param {string} runId */
  function openRun(runId) {
    if (runId) Studio.navigate("run", { runRef: runId, from: "runs" });
  }

  /**
   * What to do when the table is empty: the filters hide everything, or
   * nothing has been recorded in this artifact root yet.
   * @returns {HTMLElement}
   */
  function emptyState() {
    const filtered = Boolean(
      state.filters.status ||
        state.filters.spec ||
        state.filters.search ||
        state.filters.labels.length,
    );
    if (filtered)
      return Studio.empty(
        "No runs match these filters",
        "Clear the filters to see every run in the artifact root.",
        [
          h("button", {
            class: "btn btn-primary",
            type: "button",
            text: "Clear filters",
            onClick: () => {
              state.filters.status = "";
              state.filters.spec = "";
              state.filters.search = "";
              state.filters.labels = [];
              Studio.navigate("runs");
            },
          }),
        ],
      );
    const root = state.runsRoot?.runsRoot ?? "the artifact root";
    return Studio.empty(
      "No runs yet",
      `Runs land in ${root} (set by artifactRoot in cairntrace.config.yml, Settings, or ~/.cairntrace/runs). Run a spec from the Specs view, or run cairn in a terminal or through an agent: it shows up in Live while it runs and here when it finishes.`,
      [
        h("button", {
          class: "btn btn-primary",
          type: "button",
          text: "Open Specs",
          onClick: () => Studio.navigate("specs"),
        }),
        h("button", {
          class: "btn",
          type: "button",
          text: "Live",
          onClick: () => Studio.navigate("live"),
        }),
      ],
    );
  }

  /**
   * @param {Array<Record<string, any>>} list
   * @returns {Array<{ id: string | null, runs: Array<Record<string, any>> }>}
   */
  function groupByInvocation(list) {
    /** @type {Map<string | null, Array<Record<string, any>>>} */
    const groups = new Map();
    for (const run of list) {
      const id = run.invocation?.id ?? null;
      const entry = groups.get(id) ?? [];
      entry.push(run);
      groups.set(id, entry);
    }
    return [...groups.entries()]
      .map(([id, runs]) => ({
        id,
        runs: runs.toSorted(
          (a, b) => (a.invocation?.index ?? 0) - (b.invocation?.index ?? 0),
        ),
      }))
      .toSorted((a, b) => {
        if (a.id === null) return 1;
        if (b.id === null) return -1;
        return String(b.id).localeCompare(String(a.id));
      });
  }

  /** @param {{ id: string | null, runs: Array<Record<string, any>> }} group */
  function groupHeader(group) {
    const counts = {};
    for (const run of group.runs)
      counts[run.status] = (counts[run.status] ?? 0) + 1;
    const total = group.runs[0]?.invocation?.total ?? null;
    return h(
      "tr",
      { class: "group-row" },
      h(
        "td",
        { colspan: "8" },
        h("span", {
          class: "mono",
          text: group.id ? `invocation ${group.id}` : "no invocation recorded",
        }),
        h("span", {
          class: "cell-dim",
          text: ` · ${group.runs.length}${total ? `/${total}` : ""} run${
            group.runs.length === 1 ? "" : "s"
          } · ${Object.entries(counts)
            .map(([status, count]) => `${count} ${status}`)
            .join(", ")}`,
        }),
        group.id
          ? h("button", {
              class: "btn btn-sm btn-ghost group-open",
              type: "button",
              text: "Open invocation",
              ariaLabel: `open invocation ${group.id} in the Invocations view`,
              onClick: (/** @type {Event} */ event) => {
                event.stopPropagation();
                Studio.navigate("invocations", { invocationId: group.id });
              },
            })
          : null,
      ),
    );
  }

  /** @param {Record<string, any>} run */
  function runRow(run) {
    const live = run.liveness;
    const statusText =
      run.status === "running" && live?.state === "quiet"
        ? "running (quiet)"
        : run.status === "interrupted" && live?.state === "dead"
          ? "dead"
          : run.status;
    const refused = run.status === "refused";
    const refusalLine = refused ? CairnPolicy.refusalText(run.refusal) : null;
    const row = h(
      "tr",
      {
        class: `run-row${state.selectedRun === run.runId ? " selected" : ""}${
          run.pinned ? " pinned" : ""
        }${refused ? " refused" : ""}`,
        tabindex: "-1",
        dataset: { runId: run.runId },
        ariaLabel: `${statusText}${
          run.pinned ? " · pinned" : ""
        } · ${run.spec} · ${
          run.startedAt ? fmt.relativeTime(run.startedAt) : run.runId
        }`,
        onClick: () => openRun(run.runId),
      },
      h(
        "td",
        { class: "status-cell" },
        h("span", {
          class:
            run.status === "running"
              ? "dot dot-running"
              : `dot dot-${fmt.statusTone(run.status)}`,
        }),
        statusText,
      ),
      h(
        "td",
        { class: "cell-spec", title: live?.reason ?? "" },
        run.spec,
        run.pinned ? " " : null,
        Studio.pinTag(run.pinned),
        run.invocation?.index
          ? h("span", {
              class: "cell-dim",
              text: ` · ${run.invocation.index}/${run.invocation.total ?? "?"}`,
            })
          : null,
      ),
      h(
        "td",
        { class: "cell-dim" },
        run.startedAt ? Studio.relTime(run.startedAt) : run.runId.slice(0, 20),
      ),
      h("td", { class: "num", text: fmt.formatDuration(run.durationMs) }),
      h("td", { class: "num", text: Studio.outcomeLabel(run) }),
      h("td", {
        class: "cell-dim",
        text: [run.backend, run.environment].filter(Boolean).join(" · ") || "—",
      }),
      h(
        "td",
        { class: "cell-labels" },
        Object.entries(run.labels ?? {}).map(([key, value]) =>
          h("span", {
            class: "tag label-tag",
            title: `${key}=${value}`,
            text: `${key}=${value}`,
          }),
        ),
      ),
      h("td", {
        class: "cell-summary",
        title: refusalLine ?? run.summary ?? "",
        text: fmt.truncate(
          refusalLine ??
            run.summary ??
            (run.running
              ? "in progress — streaming in the Live view"
              : run.interrupted
                ? live?.state === "dead"
                  ? `process gone before run.json was written (${live.reason})`
                  : "interrupted before run.json was written"
                : ""),
          120,
        ),
      }),
    );
    return row;
  }

  /** @param {string} runsRoot */
  async function revealRoot(runsRoot) {
    try {
      await api.call("fs:reveal", runsRoot);
    } catch (error) {
      toast("Nothing to reveal yet", String(error?.message ?? error), "bad");
    }
  }

  /**
   * @param {(event: any) => void} fn
   * @param {number} ms
   */
  function debounce(fn, ms) {
    let timer = null;
    return (event) => {
      const value = event?.target?.value;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => fn({ target: { value } }), ms);
    };
  }

  Studio.views = Studio.views || {};
  Studio.views.runs = { id: "runs", label: "Runs", glyph: "▤", render };
})();
