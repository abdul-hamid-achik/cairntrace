/**
 * Runs view — the artifact-root history browser.
 *
 * This is the operator's default landing page: every run cairn has recorded,
 * newest first, filterable by status/spec/text, one click into full evidence.
 */
(function bootRunsView() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h, state, actions, fmt, toast, api } = Studio;

  const STATUSES = [
    ["", "all statuses"],
    ["running", "running"],
    ["passed", "passed"],
    ["failed", "failed"],
    ["errored", "errored"],
    ["interrupted", "interrupted"],
  ];

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
      placeholder: "filter by run id, spec, or failure text…",
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
        h("div", { class: "spacer" }),
        state.runsLoading ? h("span", { class: "spinner" }) : null,
        h("span", {
          class: "cell-dim",
          text: `source: ${state.runsRoot?.source ?? "default"}`,
        }),
      ),
    );

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
      host.appendChild(
        Studio.empty(
          "No runs match",
          "Run a spec from the Specs view, or widen the filters. Runs land in the artifact root configured by cairntrace.config.yml (default ~/.cairntrace/runs).",
        ),
      );
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
          h("th", { text: "detail" }),
        ),
      ),
    );

    const body = h("tbody");
    for (const run of state.runs) {
      const row = h(
        "tr",
        {
          class: state.selectedRun === run.runId ? "selected" : "",
          onClick: () =>
            Studio.navigate("run", { runRef: run.runId, from: "runs" }),
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
          run.status,
        ),
        h("td", { class: "cell-spec", text: run.spec }),
        h(
          "td",
          { class: "cell-dim", title: fmt.formatTimestamp(run.startedAt) },
          run.startedAt
            ? fmt.relativeTime(run.startedAt)
            : run.runId.slice(0, 20),
        ),
        h("td", { class: "num", text: fmt.formatDuration(run.durationMs) }),
        h("td", { class: "num", text: Studio.outcomeLabel(run) }),
        h("td", {
          class: "cell-dim",
          text:
            [run.backend, run.environment].filter(Boolean).join(" · ") || "—",
        }),
        h("td", {
          class: "cell-summary",
          title: run.summary ?? "",
          text: fmt.truncate(
            run.summary ??
              (run.running
                ? "in progress — streaming in the Live view"
                : run.interrupted
                  ? "interrupted before run.json was written"
                  : ""),
            120,
          ),
        }),
      );
      body.appendChild(row);
    }
    table.appendChild(body);
    host.appendChild(table);
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
