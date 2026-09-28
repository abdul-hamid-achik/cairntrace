/**
 * Live view — watch a run happen.
 *
 * Step progress comes from the run's own `events.ndjson` (tailed by the main
 * process), log lines from cairn's `--log-format json` stderr stream. When the
 * child exits, the run payload from stdout becomes the summary and the view
 * links straight into the run's evidence.
 */
(function bootLiveView() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h, state, actions, fmt } = Studio;

  /** @type {number | null} */
  let ticker = null;

  /** @param {HTMLElement} root */
  function render(root) {
    Studio.clear(root);
    root.appendChild(
      Studio.pageHeader(
        "Live",
        "Runs started from this app, streaming from events.ndjson",
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "Clear finished",
            onClick: () => {
              clearFinished();
              render(root);
            },
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Go to Runs",
            onClick: () => Studio.navigate("runs"),
          }),
        ],
      ),
    );

    const host = h("div", { id: "live-host" });
    root.appendChild(host);
    paintRuns(host, root);

    if (ticker) clearInterval(ticker);
    ticker = setInterval(() => {
      for (const node of document.querySelectorAll("[data-elapsed-token]")) {
        const record = state.live.get(node.getAttribute("data-elapsed-token"));
        if (!record) continue;
        node.textContent = fmt.formatDuration(elapsed(record));
      }
      for (const record of state.live.values()) {
        if (!record.done) continue;
      }
    }, 500);

    return {
      destroy() {
        if (ticker) clearInterval(ticker);
        ticker = null;
      },
    };
  }

  /**
   * @param {any} record
   * @returns {number}
   */
  function elapsed(record) {
    const end = record.done?.at ?? Date.now();
    return Math.max(0, end - record.startedAt);
  }

  /**
   * @param {HTMLElement} host
   * @param {HTMLElement} root
   */
  function paintRuns(host, root) {
    Studio.clear(host);
    const tokens = [...state.live.keys()].toReversed();
    if (!tokens.length) {
      host.appendChild(
        Studio.empty(
          "Nothing running",
          "Start a spec from the Specs view (Run / Run headed / Cold-start run), or re-run any historical run from its detail page. Progress streams here while it executes.",
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
    for (const token of tokens)
      host.appendChild(runCard(state.live.get(token), root));
  }

  /**
   * @param {any} record
   * @param {HTMLElement} root
   */
  function runCard(record, root) {
    const specNames = (record.specs ?? [])
      .map((spec) => spec.split("/").pop())
      .join(", ");
    const done = record.done;
    const status = done
      ? done.ok
        ? "passed"
        : done.exitCode === 1
          ? "failed"
          : "errored"
      : "running";
    const payload = done?.payload ?? null;

    const stepRows = (record.steps ?? []).map((step) =>
      h(
        "div",
        { class: "timeline-row" },
        h("span", { class: `dot dot-${fmt.statusTone(step.status)}` }),
        h("span", { class: "label", text: step.stepId }),
        h("span", {
          class: "ts",
          text:
            step.status === "running"
              ? "…"
              : fmt.formatDuration(step.durationMs),
        }),
      ),
    );

    const logLines = (record.logs ?? []).slice(-400).map((entry) =>
      h(
        "div",
        {
          class: `log-line level-${String(entry.level ?? "info").toLowerCase()}`,
        },
        h("span", {
          class: "lvl",
          text: String(entry.level ?? "log").slice(0, 6),
        }),
        entry.ts ? `${String(entry.ts).slice(11, 23)} ` : "",
        entry.scope ? `${entry.scope} › ` : "",
        fmt.oneLine(String(entry.msg ?? JSON.stringify(entry))),
      ),
    );

    return h(
      "section",
      { class: "panel", style: { marginBottom: "14px" } },
      h(
        "div",
        { class: "panel-head" },
        h("span", {
          class: `dot dot-${fmt.statusTone(status)}${
            status === "running" ? " dot-running" : ""
          }`,
        }),
        h("span", {
          class: "mono",
          style: { fontSize: "12.5px" },
          text: specNames || record.token,
        }),
        Studio.tag(status, fmt.statusTone(status)),
        h("span", {
          class: "elapsed",
          "data-elapsed-token": record.token,
          text: fmt.formatDuration(elapsed(record)),
        }),
        h(
          "div",
          { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
          [
            done && record.runId
              ? h("button", {
                  class: "btn btn-sm",
                  type: "button",
                  text: "Open evidence",
                  onClick: () =>
                    Studio.navigate("run", { runRef: record.runId }),
                })
              : null,
            done
              ? h("button", {
                  class: "btn btn-sm btn-ghost",
                  type: "button",
                  text: "Re-run",
                  onClick: () =>
                    void actions
                      .startRun(record.specs)
                      .then(() => render(root)),
                })
              : null,
            !done
              ? h("button", {
                  class: "btn btn-sm btn-danger",
                  type: "button",
                  text: "Cancel",
                  onClick: () =>
                    void actions
                      .cancelRun(record.token)
                      .then(() => render(root)),
                })
              : null,
          ],
        ),
      ),
      h(
        "div",
        { class: "panel-body" },
        done && payload
          ? h(
              "div",
              { style: { marginBottom: "12px" } },
              Studio.keyValue([
                ["status", Studio.statusTag(payload.status)],
                ["summary", payload.summary ?? "—"],
                [
                  "outcomes",
                  `${(payload.outcomes ?? []).filter((o) => o.status === "passed").length}/${(payload.outcomes ?? []).length} passed`,
                ],
                ["duration", fmt.formatDuration(payload.durationMs)],
                ["exit", `${done.exitCode ?? "—"} · ${done.meaning ?? ""}`],
                ["run id", payload.runId ?? record.runId ?? "—"],
              ]),
              payload.failure?.message
                ? h(
                    "div",
                    { class: "error-box", style: { marginTop: "10px" } },
                    h("strong", { text: "failure" }),
                    h("pre", { text: payload.failure.message }),
                  )
                : null,
            )
          : h(
              "div",
              { class: "cell-dim", style: { marginBottom: "10px" } },
              record.runDir
                ? `tailing ${record.runDir}`
                : "waiting for the run directory to appear…",
            ),
        h("div", { class: "live-grid" }, [
          h(
            "div",
            h(
              "div",
              { class: "section-title", style: { marginTop: "0" } },
              `Steps (${stepRows.length})`,
            ),
            h(
              "div",
              { class: "panel" },
              h(
                "div",
                { class: "panel-body tight" },
                h(
                  "div",
                  { class: "timeline" },
                  stepRows.length
                    ? stepRows
                    : h(
                        "div",
                        { class: "timeline-row" },
                        h("span", { class: "dot" }),
                        h("span", {
                          class: "label cell-dim",
                          text: "no steps yet",
                        }),
                      ),
                ),
              ),
            ),
          ),
          h(
            "div",
            h(
              "div",
              { class: "section-title", style: { marginTop: "0" } },
              `Logs (${(record.logs ?? []).length})`,
            ),
            h(
              "div",
              { class: "log-pane" },
              logLines.length
                ? logLines
                : h("div", {
                    class: "log-line",
                    style: { color: "var(--text-faint)" },
                    text: "no log lines yet",
                  }),
            ),
          ),
        ]),
        h(
          "details",
          { style: { marginTop: "10px" } },
          h("summary", { class: "cell-dim", text: "command line" }),
          h("pre", {
            class: "code tight",
            text: `${record.command} ${(record.argv ?? []).join(" ")}`,
          }),
        ),
      ),
    );
  }

  function clearFinished() {
    for (const [token, record] of state.live.entries())
      if (record.done) state.live.delete(token);
  }

  /** Re-paint if the live view is on screen. */
  function refreshIfVisible() {
    if (state.view !== "live") return;
    const host = document.getElementById("live-host");
    const root = document.getElementById("view");
    if (host && root) paintRuns(host, root);
  }

  Studio.views = Studio.views || {};
  Studio.views.live = {
    id: "live",
    label: "Live",
    glyph: "▶",
    render,
    refresh: refreshIfVisible,
  };
  Studio.live = { refreshIfVisible };
})();
