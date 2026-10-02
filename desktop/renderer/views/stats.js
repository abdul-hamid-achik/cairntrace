/**
 * Cohorts view — `cairn stats --group-by` for A/B comparison.
 *
 * Renders the StatsResult v1 payload directly: pass rate, wall-clock
 * percentiles, the optional harvested domain metric, and the baseline deltas.
 */
(function bootStatsView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, api, fmt, state } = Studio;

  /** @type {{ groupBy: string, metric: string, baseline: string, limit: number, includeRuns: boolean }} */
  const form = {
    groupBy: "path",
    metric: "",
    baseline: "",
    limit: 500,
    includeRuns: false,
  };
  /** @type {any} */
  let lastResult = null;

  /** @param {HTMLElement} root */
  function render(root) {
    Studio.clear(root);
    root.appendChild(
      Studio.pageHeader(
        "Cohorts",
        "Aggregate labeled runs into A/B cohorts (`cairn run --label key=value`)",
        null,
      ),
    );

    // Offer the label keys run.json files actually carry (Runs view loads
    // them; refresh here so a first visit is not empty).
    const keyList = h("datalist", { id: "cohort-label-keys" });
    const fillKeys = () => {
      Studio.clear(keyList);
      for (const entry of state.labels ?? [])
        keyList.appendChild(
          h("option", {
            value: entry.key,
            text: `${entry.key} (${entry.count} runs: ${entry.values.slice(0, 4).join(", ")}${
              entry.values.length > 4 ? ", …" : ""
            })`,
          }),
        );
    };
    fillKeys();
    void Studio.api
      .call("runs:labels")
      .then((labels) => {
        state.labels = labels ?? [];
        fillKeys();
      })
      .catch(() => {});
    const groupBy = Studio.input({
      value: form.groupBy,
      list: "cohort-label-keys",
      style: { width: "140px" },
      onInput: (e) => (form.groupBy = e.target.value),
    });
    const metric = Studio.input({
      value: form.metric,
      placeholder: "processingDurationMS",
      style: { width: "190px" },
      onInput: (e) => (form.metric = e.target.value),
    });
    const baseline = Studio.input({
      value: form.baseline,
      placeholder: "auto (first group)",
      style: { width: "150px" },
      onInput: (e) => (form.baseline = e.target.value),
    });
    const limit = Studio.input({
      type: "number",
      value: String(form.limit),
      style: { width: "90px" },
      onInput: (e) => (form.limit = Number(e.target.value) || 500),
    });
    const includeRuns = Studio.checkbox(
      "include per-run rows",
      form.includeRuns,
      (value) => (form.includeRuns = value),
    );

    const host = h("div", { id: "stats-host" });

    root.appendChild(
      h(
        "div",
        { class: "toolbar" },
        h("label", { class: "field" }, "group by label key", groupBy, keyList),
        h(
          "label",
          { class: "field" },
          "metric field (outcomes/*.raw.json)",
          metric,
        ),
        h("label", { class: "field" }, "baseline cohort", baseline),
        h("label", { class: "field" }, "scan limit", limit),
        includeRuns,
        h("div", { class: "spacer" }),
        h("button", {
          class: "btn btn-primary",
          type: "button",
          text: "Aggregate",
          onClick: () => void run(host),
        }),
      ),
    );
    root.appendChild(host);

    if (lastResult) paint(host, lastResult);
    else
      host.appendChild(
        Studio.empty(
          "No aggregation yet",
          "Labels are stamped with `cairn run --label path=legacy`. Pick the label key to cohort by and aggregate the artifact root.",
        ),
      );
  }

  /** @param {HTMLElement} host */
  async function run(host) {
    Studio.clear(host);
    host.appendChild(Studio.loading("aggregating runs…"));
    try {
      const result = await api.call("stats:get", {
        groupBy: form.groupBy.trim(),
        metric: form.metric.trim() || null,
        baseline: form.baseline.trim() || null,
        limit: form.limit,
        includeRuns: form.includeRuns,
      });
      lastResult = result;
      paint(host, result);
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, "cairn stats"));
    }
  }

  /**
   * @param {HTMLElement} host
   * @param {any} result
   */
  function paint(host, result) {
    Studio.clear(host);
    if (!result?.ok) {
      host.appendChild(
        Studio.errorBox(
          new Error(result?.stderr || `cairn stats exited ${result?.exitCode}`),
          "stats",
        ),
      );
      return;
    }
    const payload = result.payload ?? {};
    const groups = payload.groups ?? [];

    host.appendChild(
      h("div", { class: "stat-cards", style: { marginTop: "14px" } }, [
        card("scanned", String(payload.scanned ?? 0), "run directories"),
        card(
          "matched",
          String(payload.matched ?? 0),
          `with label ${payload.groupBy ?? form.groupBy}`,
        ),
        card(
          "cohorts",
          String(groups.length),
          payload.metricName
            ? `metric: ${payload.metricName}`
            : "no domain metric",
        ),
        card(
          "artifact root",
          String(payload.artifactRoot ?? "—")
            .split("/")
            .slice(-2)
            .join("/"),
          payload.artifactRoot ?? "",
        ),
      ]),
    );

    if (!groups.length) {
      host.appendChild(
        Studio.empty(
          "No cohorts matched",
          `${payload.scanned ?? 0} runs were scanned but none carry a \`${payload.groupBy ?? form.groupBy}\` label. Stamp cohorts with \`cairn run --label ${payload.groupBy ?? "path"}=legacy\`.`,
        ),
      );
      return;
    }

    // Refused runs (environment policy) are not failures: their own column,
    // shown only when a cohort has any.
    const showRefused = groups.some(
      (group) => typeof group.refused === "number" && group.refused > 0,
    );
    const table = h(
      "table",
      { class: "grid" },
      h(
        "thead",
        h(
          "tr",
          h("th", { text: "cohort" }),
          h("th", { class: "num", text: "runs" }),
          h("th", { text: "pass rate" }),
          h("th", { class: "num", text: "failed" }),
          h("th", { class: "num", text: "errored" }),
          showRefused ? h("th", { class: "num", text: "refused" }) : null,
          h("th", { class: "num", text: "dur p50" }),
          h("th", { class: "num", text: "dur p95" }),
          payload.metricName
            ? h("th", { class: "num", text: `${payload.metricName} p50` })
            : null,
          payload.metricName
            ? h("th", { class: "num", text: `${payload.metricName} p95` })
            : null,
        ),
      ),
    );
    const body = h("tbody");
    for (const group of groups) {
      const passRate = Math.round((group.passRate ?? 0) * 1000) / 10;
      body.appendChild(
        h(
          "tr",
          { style: { cursor: "default" } },
          h("td", { class: "cell-spec", text: group.key }),
          h("td", { class: "num", text: String(group.runs ?? 0) }),
          h(
            "td",
            h(
              "div",
              { style: { display: "flex", alignItems: "center", gap: "8px" } },
              [
                h(
                  "div",
                  { class: `bar${passRate >= 99.9 ? " ok" : ""}` },
                  h("span", { style: { width: `${Math.max(2, passRate)}%` } }),
                ),
                h("span", {
                  class: "mono",
                  style: { fontSize: "11.5px" },
                  text: `${passRate}%`,
                }),
              ],
            ),
          ),
          h("td", { class: "num", text: String(group.failed ?? 0) }),
          h("td", { class: "num", text: String(group.errored ?? 0) }),
          showRefused
            ? h(
                "td",
                { class: "num" },
                group.refused
                  ? Studio.tag(String(group.refused), "refused")
                  : "0",
              )
            : null,
          h("td", {
            class: "num",
            text: fmt.formatDuration(group.duration?.p50),
          }),
          h("td", {
            class: "num",
            text: fmt.formatDuration(group.duration?.p95),
          }),
          payload.metricName
            ? h("td", {
                class: "num",
                text: fmt.formatDuration(group.metric?.p50),
              })
            : null,
          payload.metricName
            ? h("td", {
                class: "num",
                text: fmt.formatDuration(group.metric?.p95),
              })
            : null,
        ),
      );
    }
    table.appendChild(body);
    host.appendChild(
      h(
        "div",
        { class: "panel", style: { marginTop: "14px" } },
        h("div", { class: "panel-body tight" }, table),
      ),
    );

    if (Array.isArray(payload.deltas) && payload.deltas.length) {
      const deltaTable = h(
        "table",
        { class: "grid" },
        h(
          "thead",
          h(
            "tr",
            h("th", { text: "baseline" }),
            h("th", { text: "against" }),
            h("th", { class: "num", text: "pass-rate Δ" }),
            h("th", { class: "num", text: "dur p50 ×" }),
            h("th", { class: "num", text: "dur p95 ×" }),
            h("th", { class: "num", text: "metric p50 ×" }),
          ),
        ),
      );
      const deltaBody = h("tbody");
      for (const delta of payload.deltas) {
        deltaBody.appendChild(
          h(
            "tr",
            { style: { cursor: "default" } },
            h("td", { class: "cell-spec", text: delta.baseline }),
            h("td", { class: "cell-spec", text: delta.against }),
            h("td", { class: "num", text: signed(delta.passRateDelta) }),
            h("td", { class: "num", text: ratio(delta.durationP50Ratio) }),
            h("td", { class: "num", text: ratio(delta.durationP95Ratio) }),
            h("td", { class: "num", text: ratio(delta.metricP50Ratio) }),
          ),
        );
      }
      deltaTable.appendChild(deltaBody);
      // append, not appendChild: appendChild takes one node and silently
      // dropped the table that follows the title.
      host.append(
        h("div", { class: "section-title" }, "Deltas vs baseline"),
        h(
          "div",
          { class: "panel" },
          h("div", { class: "panel-body tight" }, deltaTable),
        ),
      );
    }

    if (Array.isArray(payload.runs) && payload.runs.length) {
      host.append(
        h("div", { class: "section-title" }, `Runs (${payload.runs.length})`),
        h(
          "div",
          { class: "panel" },
          h(
            "div",
            { class: "panel-body tight" },
            payload.runs.slice(0, 200).map((runRow) =>
              h(
                "div",
                {
                  class: "list-row",
                  onClick: () =>
                    Studio.navigate("run", { runRef: runRow.runId }),
                },
                h("span", {
                  class: `dot dot-${fmt.statusTone(runRow.status)}`,
                }),
                h("span", {
                  class: "mono",
                  style: { fontSize: "11.5px" },
                  text: runRow.specName,
                }),
                Studio.tag(runRow.status, fmt.statusTone(runRow.status)),
                h("span", {
                  class: "cell-dim",
                  text: fmt.formatDuration(runRow.durationMs),
                }),
                runRow.metricMs !== undefined
                  ? h("span", {
                      class: "cell-dim",
                      text: `metric ${fmt.formatDuration(runRow.metricMs)}`,
                    })
                  : null,
                h("span", {
                  class: "cell-dim",
                  style: { marginLeft: "auto" },
                  text: runRow.runId,
                }),
              ),
            ),
          ),
        ),
      );
    }

    host.appendChild(
      h(
        "details",
        { style: { marginTop: "12px" } },
        h("summary", { class: "cell-dim", text: "raw stats payload" }),
        h("div", { class: "tree" }, Studio.jsonTree(payload)),
      ),
    );
  }

  /**
   * @param {string} label
   * @param {string} value
   * @param {string} [note]
   */
  function card(label, value, note) {
    return h(
      "div",
      { class: "stat-card" },
      h("div", { class: "k", text: label }),
      h("div", { class: "v", style: { fontSize: "16px" }, text: value }),
      note ? h("div", { class: "n", text: fmt.truncate(note, 60) }) : null,
    );
  }

  /** @param {number | undefined} value */
  function signed(value) {
    if (typeof value !== "number") return "—";
    const rounded = Math.round(value * 1000) / 1000;
    return `${rounded > 0 ? "+" : ""}${rounded}`;
  }

  /** @param {number | undefined} value */
  function ratio(value) {
    if (typeof value !== "number") return "—";
    return `${Math.round(value * 100) / 100}×`;
  }

  Studio.views = Studio.views || {};
  Studio.views.stats = { id: "stats", label: "Cohorts", glyph: "∑", render };
})();
