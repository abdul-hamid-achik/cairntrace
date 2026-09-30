/**
 * Live view — watch runs happen.
 *
 * Two sections: runs started from this app (step progress from the run's own
 * `events.ndjson` plus cairn's NDJSON log stream), and runs detected in the
 * artifact root that something else started — a terminal `cairn run`, an
 * agent — streamed from the same `events.ndjson` by the main-process watcher.
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
        "Runs from this app plus any cairn run detected in the artifact root, streaming from events.ndjson",
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
      for (const node of document.querySelectorAll("[data-elapsed-detected]")) {
        const record = state.detected.get(
          node.getAttribute("data-elapsed-detected"),
        );
        if (!record?.startedAtMs) continue;
        node.textContent = fmt.formatDuration(Date.now() - record.startedAtMs);
      }
      for (const node of document.querySelectorAll(
        "[data-activity-detected]",
      )) {
        const record = state.detected.get(
          node.getAttribute("data-activity-detected"),
        );
        if (!record?.lastActivityMs) continue;
        node.textContent = `active ${fmt.relativeTime(record.lastActivityMs)}`;
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
    const appTokens = [...state.live.keys()].toReversed();
    const detectedIds = [...state.detected.keys()].toReversed();

    if (!appTokens.length && !detectedIds.length) {
      host.appendChild(
        Studio.empty(
          "Nothing running",
          "Start a spec from the Specs view, or run `cairn run` anywhere — runs started outside the app appear here automatically while they execute.",
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

    if (appTokens.length) {
      host.appendChild(
        h(
          "div",
          { class: "section-title", style: { marginTop: "4px" } },
          `from this app (${appTokens.length})`,
        ),
      );
      for (const token of appTokens)
        host.appendChild(runCard(state.live.get(token), root));
    }

    if (detectedIds.length) {
      host.appendChild(
        h(
          "div",
          { class: "section-title", style: { marginTop: "18px" } },
          `detected outside the app (${detectedIds.length})`,
        ),
      );
      for (const runId of detectedIds)
        host.appendChild(detectedCard(state.detected.get(runId), root));
    }
  }

  /**
   * One-line description of a run event, for the detected-run log pane.
   * @param {Record<string, any>} event
   * @returns {string}
   */
  function describeEventLine(event) {
    const type = String(event?.type ?? "unknown");
    switch (type) {
      case "run.started":
        return `run started (${event?.spec ?? ""})`;
      case "run.errored":
        return `run errored: ${fmt.oneLine(String(event?.error ?? ""))}`;
      case "step.started":
        return `step ${event?.stepId ?? ""} started`;
      case "step.finished":
        return `step ${event?.stepId ?? ""} finished in ${event?.durationMs ?? 0}ms${
          event?.status === "failed" ? " — FAILED" : ""
        }`;
      case "step.skipped":
        return `step ${event?.stepId ?? ""} skipped (when:)`;
      case "outcome.evaluated":
        return `outcome ${event?.outcomeId ?? event?.id ?? ""}: ${event?.status ?? ""}`;
      case "artifact.screenshot":
        return `screenshot ${event?.path ?? ""}`;
      case "artifact.snapshot":
        return `snapshot ${event?.path ?? ""}`;
      case "viewport.set":
        return `viewport ${event?.width ?? "?"}×${event?.height ?? "?"}`;
      default:
        return fmt.oneLine(String(event?.message ?? type));
    }
  }

  /**
   * A run detected in the artifact root that this app did not start.
   * @param {any} record
   * @param {HTMLElement} root
   */
  function detectedCard(record, root) {
    const done = record.done;
    const status = done ? done.status : record.stale ? "stale" : "running";
    const dotClass = done
      ? `dot dot-${fmt.statusTone(done.status)}`
      : record.stale
        ? "dot dot-warn"
        : "dot dot-running";

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

    const logLines = (record.events ?? []).slice(-300).map((event) =>
      h(
        "div",
        { class: "log-line" },
        h("span", {
          class: "lvl",
          text: String(event?.type ?? "event").slice(0, 6),
        }),
        event?.ts ? `${String(event.ts).slice(11, 23)} ` : "",
        describeEventLine(event),
      ),
    );

    return h(
      "section",
      { class: "panel", style: { marginBottom: "14px" } },
      h(
        "div",
        { class: "panel-head" },
        h("span", { class: dotClass }),
        h("span", {
          class: "mono",
          style: { fontSize: "12.5px" },
          text: `${record.spec} · ${record.runId.slice(0, 24)}`,
        }),
        Studio.tag(
          status,
          done ? fmt.statusTone(done.status) : record.stale ? "warn" : "info",
        ),
        h("span", {
          class: "elapsed",
          "data-elapsed-detected": record.runId,
          text: record.startedAtMs
            ? fmt.formatDuration(Date.now() - record.startedAtMs)
            : "—",
        }),
        h("span", {
          class: "cell-dim",
          style: { fontSize: "11px" },
          "data-activity-detected": record.runId,
          text: record.lastActivityMs
            ? `active ${fmt.relativeTime(record.lastActivityMs)}`
            : "",
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
            record.runDir
              ? h("button", {
                  class: "btn btn-sm btn-ghost",
                  type: "button",
                  text: "Reveal",
                  onClick: () =>
                    void Studio.api
                      .call("fs:reveal", record.runDir)
                      .catch(() => {}),
                })
              : null,
            h("button", {
              class: "btn btn-sm btn-ghost",
              type: "button",
              text: "Hide",
              onClick: () => {
                Studio.hideDetected(record.runId);
                render(root);
              },
            }),
          ],
        ),
      ),
      h(
        "div",
        { class: "panel-body" },
        h(
          "div",
          {
            class: "cell-dim",
            style: { marginBottom: "10px" },
          },
          done
            ? `finished · ${record.done.status}${
                record.done.summary
                  ? ` · ${fmt.oneLine(record.done.summary)}`
                  : ""
              }`
            : record.stale
              ? "no longer detected — quiet for a while, deleted, or its process died (a crashed run leaves no run.json)"
              : "started outside Studio (terminal or agent) — streaming the run's events.ndjson",
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
              `Events (${(record.events ?? []).length})`,
            ),
            h(
              "div",
              { class: "log-pane" },
              logLines.length
                ? logLines
                : h("div", {
                    class: "log-line",
                    style: { color: "var(--text-faint)" },
                    text: "no events yet",
                  }),
            ),
          ),
        ]),
      ),
    );
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
    for (const [runId, record] of state.detected.entries())
      if (record.done || record.stale) state.detected.delete(runId);
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
