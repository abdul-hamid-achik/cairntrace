/**
 * Run detail view — the evidence screen.
 *
 * One run's whole artifact directory, organised the way an operator debugs:
 * what failed, which step, what the page actually said, what it looked like,
 * and what the network did. Everything is read from the artifacts cairn
 * already wrote; nothing is re-derived here.
 */
(function bootRunDetailView() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h, state, actions, api, fmt, toast } = Studio;

  const TABS = [
    { id: "overview", label: "Overview" },
    { id: "steps", label: "Steps" },
    { id: "outcomes", label: "Outcomes" },
    { id: "artifacts", label: "Artifacts" },
    { id: "events", label: "Events" },
    { id: "console", label: "Console" },
    { id: "network", label: "Network" },
    { id: "diff", label: "Compare" },
  ];

  let activeTab = "overview";

  /**
   * @param {HTMLElement} root
   * @param {{ runRef: string }} params
   */
  async function render(root, params) {
    const runRef = params?.runRef ?? state.selectedRun;
    if (!runRef) {
      Studio.clear(root);
      root.appendChild(
        Studio.empty("No run selected", "Pick a run from the Runs view."),
      );
      return;
    }
    activeTab = params?.tab ?? activeTab;
    Studio.clear(root);
    root.appendChild(Studio.loading(`loading ${runRef}…`));
    try {
      state.runDetail = await api.call("run:detail", runRef);
      state.selectedRun = runRef;
    } catch (error) {
      Studio.clear(root);
      root.appendChild(Studio.errorBox(error, "run detail"));
      return;
    }
    paint(root, runRef);
  }

  /**
   * @param {HTMLElement} root
   * @param {string} runRef
   */
  function paint(root, runRef) {
    Studio.clear(root);
    const detail = state.runDetail;
    const run = detail?.run ?? null;

    root.appendChild(
      Studio.pageHeader(
        detail?.runId ?? runRef,
        run
          ? `${run.spec?.name ?? "?"} · ${run.environment ?? "?"} · ${run.backend ?? "?"} · ${fmt.formatDuration(run.durationMs)} · ${fmt.formatTimestamp(run.startedAt)}`
          : !run && detail?.hasEvents
            ? "run.json missing — this run is still executing (or was interrupted); its event stream is in the Live view"
            : "run.json missing — this run was interrupted before it could write its record",
        [
          !run && detail?.hasEvents
            ? h("button", {
                class: "btn",
                type: "button",
                text: "Watch in Live",
                onClick: () => Studio.navigate("live"),
              })
            : null,
          h("button", {
            class: "btn",
            type: "button",
            text: "Reveal run dir",
            onClick: () =>
              api
                .call("fs:reveal", detail?.runDir)
                .catch((error) =>
                  toast(
                    "Reveal failed",
                    String(error?.message ?? error),
                    "bad",
                  ),
                ),
          }),
          detail?.hasReportHtml
            ? h("button", {
                class: "btn",
                type: "button",
                text: "Open report.html",
                onClick: () =>
                  api
                    .call("run:open-report", detail.runId)
                    .catch((error) =>
                      toast(
                        "Report failed",
                        String(error?.message ?? error),
                        "bad",
                      ),
                    ),
              })
            : null,
          run?.spec?.path
            ? h("button", {
                class: "btn",
                type: "button",
                text: "Open spec",
                onClick: () =>
                  Studio.navigate("specs", { file: run.spec.path }),
              })
            : null,
          h("button", {
            class: "btn",
            type: "button",
            text: "Re-run",
            title: "Run this spec again with the current run settings",
            onClick: () => reRun(run),
          }),
          h("button", {
            class: "btn btn-ghost",
            type: "button",
            text: "← Runs",
            onClick: () => Studio.navigate("runs"),
          }),
        ],
      ),
    );

    if (!run) {
      root.appendChild(
        Studio.panel("Interrupted run", [
          h("p", {
            style: { color: "var(--text-dim)", marginTop: "0" },
            text: "A signal killed this run before run.json was written. The files that do exist are listed below.",
          }),
          fileQuickList(detail),
        ]),
      );
      return;
    }

    if (run.status !== "passed") {
      root.appendChild(
        h(
          "div",
          { class: "error-box", style: { marginBottom: "14px" } },
          h("strong", {
            text: `${run.status}: ${run.summary ?? "no summary"}`,
          }),
          run.failure?.step
            ? h("div", {
                class: "mono",
                style: { fontSize: "11px", marginTop: "4px" },
                text: `failed step: ${run.failure.step}`,
              })
            : null,
          run.failure?.outcome
            ? h("div", {
                class: "mono",
                style: { fontSize: "11px", marginTop: "4px" },
                text: `failed outcome: ${run.failure.outcome}`,
              })
            : null,
          run.failure?.message && run.failure.message !== run.summary
            ? h("pre", { text: run.failure.message })
            : null,
        ),
      );
    }

    root.appendChild(
      h(
        "div",
        { class: "tabs" },
        TABS.map((tab) => {
          const count = tabCount(tab.id, detail);
          return h(
            "button",
            {
              class: `tab${activeTab === tab.id ? " active" : ""}`,
              type: "button",
              onClick: () => {
                activeTab = tab.id;
                paint(root, runRef);
              },
            },
            tab.label,
            count === null
              ? null
              : h("span", { class: "count", text: String(count) }),
          );
        }),
      ),
    );

    const host = h("div", { id: "tab-host" });
    root.appendChild(host);
    void paintTab(host, activeTab, detail, root, runRef);
  }

  /**
   * @param {string} tabId
   * @param {any} detail
   * @returns {number | null}
   */
  function tabCount(tabId, detail) {
    switch (tabId) {
      case "steps":
        return detail?.steps?.length ? detail.steps.length : null;
      case "outcomes":
        return detail?.outcomes?.length ? detail.outcomes.length : null;
      case "artifacts":
        return detail?.manifest?.artifacts?.length ?? null;
      default:
        return null;
    }
  }

  /**
   * @param {HTMLElement} host
   * @param {string} tabId
   * @param {any} detail
   * @param {HTMLElement} root
   * @param {string} runRef
   */
  async function paintTab(host, tabId, detail, root, runRef) {
    Studio.clear(host);
    host.appendChild(Studio.loading());
    try {
      const node = await TAB_RENDERERS[tabId](detail, root, runRef);
      Studio.clear(host);
      host.appendChild(node);
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, tabId));
    }
  }

  /** @type {Record<string, (detail: any, root: HTMLElement, runRef: string) => Promise<Node> | Node>} */
  const TAB_RENDERERS = {
    overview(detail) {
      const run = detail.run;
      const rows = [
        ["status", Studio.statusTag(run.status)],
        ["spec", run.spec?.name ?? "—"],
        ["spec path", run.spec?.path ?? "—"],
        ["contract hash", run.spec?.contractHash ?? "not stamped"],
        ["environment", run.environment ?? "—"],
        ["backend", run.backend ?? "—"],
        ["cold start", String(Boolean(run.coldStart))],
        [
          "started",
          `${fmt.formatTimestamp(run.startedAt)} (${fmt.relativeTime(run.startedAt)})`,
        ],
        ["ended", fmt.formatTimestamp(run.endedAt)],
        ["duration", fmt.formatDuration(run.durationMs)],
        [
          "exit code",
          run.exitCode === undefined || run.exitCode === null
            ? "—"
            : `${run.exitCode}`,
        ],
        ["run dir", detail.runDir],
      ];
      if (run.labels && Object.keys(run.labels).length)
        rows.push([
          "labels",
          Object.entries(run.labels)
            .map(([k, v]) => `${k}=${v}`)
            .join("  "),
        ]);
      if (run.viewport)
        rows.push([
          "viewport",
          `${run.viewport.width ?? "?"}×${run.viewport.height ?? "?"}`,
        ]);

      const nodes = [
        Studio.panel("Run record", Studio.keyValue(rows)),
        h("div", { class: "stat-cards", style: { marginTop: "14px" } }, [
          statCard(
            "Outcomes passed",
            `${(run.outcomes ?? []).filter((o) => o.status === "passed").length}`,
            `${(run.outcomes ?? []).length} total`,
          ),
          statCard(
            "Steps",
            `${(run.steps ?? []).length}`,
            `${(run.steps ?? []).filter((s) => s.status === "passed").length} passed`,
          ),
          statCard(
            "Duration",
            fmt.formatDuration(run.durationMs),
            run.startedAt ? fmt.relativeTime(run.startedAt) : "",
          ),
          statCard(
            "Artifacts",
            `${detail.manifest?.artifacts?.length ?? 0}`,
            "checksummed files",
          ),
        ]),
      ];

      if (detail.hasAgentContext) {
        nodes.push(
          h("div", { class: "section-title" }, "Agent context"),
          h("div", { id: "agent-context-host" }, Studio.loading()),
        );
        setTimeout(() => {
          const host = document.getElementById("agent-context-host");
          if (!host) return;
          api
            .call("run:artifact-text", {
              runDir: detail.runDir,
              path: "agent_context.md",
            })
            .then((result) => {
              Studio.clear(host);
              host.appendChild(
                result?.ok
                  ? Studio.markdown.render(result.text)
                  : Studio.errorBox(
                      new Error(result?.error ?? "unreadable"),
                      "agent_context.md",
                    ),
              );
            })
            .catch((error) => {
              Studio.clear(host);
              host.appendChild(Studio.errorBox(error, "agent_context.md"));
            });
        }, 0);
      }
      return h("div", null, nodes);
    },

    steps(detail) {
      const steps = detail.steps ?? [];
      if (!steps.length)
        return Studio.empty(
          "No steps recorded",
          "This run did not reach step execution.",
        );
      const viewer = h("div", {
        id: "step-artifact-viewer",
        style: { marginTop: "14px" },
      });
      const rows = steps.map((step, index) =>
        h(
          "div",
          { class: "step-row" },
          h("span", { class: `dot dot-${fmt.statusTone(step.status)}` }),
          h("span", { class: "step-id", text: step.id ?? `step_${index + 1}` }),
          h("span", {
            class: "step-meta",
            text: fmt.formatDuration(step.durationMs),
          }),
          h(
            "div",
            { style: { minWidth: "0" } },
            step.resolved
              ? h("span", {
                  class: "cell-dim",
                  text: `resolved ${step.resolved.role}${
                    step.resolved.name ? ` "${step.resolved.name}"` : ""
                  }${step.resolved.ref ? ` @${step.resolved.ref}` : ""}`,
                })
              : null,
            step.error
              ? h("div", {
                  class: "step-error",
                  text: fmt.truncate(step.error, 400),
                })
              : null,
            (step.artifacts ?? []).length
              ? h(
                  "div",
                  {
                    class: "toolbar",
                    style: { margin: "4px 0 0", gap: "5px" },
                  },
                  step.artifacts.map((artifact) =>
                    h("button", {
                      class: "btn btn-sm btn-ghost mono",
                      type: "button",
                      text: artifact.split("/").pop(),
                      onClick: async () => {
                        Studio.clear(viewer);
                        viewer.appendChild(Studio.loading());
                        viewer.appendChild(
                          await Studio.artifactViewer(detail.runDir, artifact),
                        );
                        viewer.scrollIntoView({
                          behavior: "smooth",
                          block: "nearest",
                        });
                      },
                    }),
                  ),
                )
              : null,
          ),
        ),
      );
      return h(
        "div",
        h(
          "div",
          { class: "panel" },
          h("div", { class: "panel-body tight" }, rows),
        ),
        viewer,
      );
    },

    outcomes(detail) {
      const outcomes = detail.outcomes ?? [];
      if (!outcomes.length)
        return Studio.empty(
          "No outcomes",
          "This spec declared no outcomes, or the run never reached evaluation.",
        );
      return h(
        "div",
        null,
        outcomes.map((outcome) =>
          h(
            "details",
            { class: "outcome-card", open: outcome.status !== "passed" },
            h(
              "summary",
              h("span", { class: `dot dot-${fmt.statusTone(outcome.status)}` }),
              h("span", { class: "outcome-id", text: outcome.id }),
              Studio.tag(outcome.status, fmt.statusTone(outcome.status)),
              outcome.evidence
                ? h("span", {
                    class: "cell-dim",
                    style: { marginLeft: "auto" },
                    text: outcome.evidence,
                  })
                : null,
            ),
            h(
              "div",
              { class: "outcome-body" },
              outcome.evidenceText
                ? Studio.markdown.render(outcome.evidenceText)
                : h("p", {
                    class: "cell-dim",
                    text: "no evidence file for this outcome",
                  }),
              outcome.evidenceRawText
                ? h(
                    "details",
                    { style: { marginTop: "10px" } },
                    h("summary", {
                      class: "cell-dim",
                      text: `raw sidecar (${outcome.evidenceRaw})`,
                    }),
                    h("pre", {
                      class: "code tight",
                      text: outcome.evidenceRawText,
                    }),
                  )
                : null,
            ),
          ),
        ),
      );
    },

    artifacts(detail) {
      const groups = detail.artifacts ?? {};
      const kinds = Object.keys(groups);
      if (!kinds.length)
        return Studio.empty(
          "No artifacts",
          "The manifest is empty for this run.",
        );
      const viewer = h("div", {
        id: "artifact-viewer",
        style: { marginTop: "14px" },
      });
      const list = h("div");
      for (const kind of kinds) {
        list.appendChild(
          h(
            "div",
            { class: "section-title" },
            `${kind} (${groups[kind].length})`,
          ),
        );
        list.appendChild(
          h(
            "div",
            { class: "panel" },
            h(
              "div",
              { class: "panel-body tight" },
              groups[kind].map((entry) =>
                h(
                  "div",
                  { class: "list-row" },
                  h("span", {
                    class: "mono",
                    style: { fontSize: "11.5px" },
                    text: entry.path,
                  }),
                  h("span", {
                    class: "cell-dim",
                    style: { marginLeft: "auto" },
                    text: fmt.formatBytes(entry.bytes),
                  }),
                  h("button", {
                    class: "btn btn-sm",
                    type: "button",
                    text: "view",
                    onClick: async () => {
                      Studio.clear(viewer);
                      viewer.appendChild(Studio.loading());
                      const node = await Studio.artifactViewer(
                        detail.runDir,
                        entry.path,
                      );
                      Studio.clear(viewer);
                      viewer.appendChild(node);
                    },
                  }),
                  h("button", {
                    class: "btn btn-sm btn-ghost",
                    type: "button",
                    text: "reveal",
                    onClick: () =>
                      api
                        .call("run:reveal", detail.runId, entry.path)
                        .catch((error) =>
                          toast(
                            "Reveal failed",
                            String(error?.message ?? error),
                            "bad",
                          ),
                        ),
                  }),
                ),
              ),
            ),
          ),
        );
      }
      return h("div", list, viewer);
    },

    async events(detail) {
      const result = await api.call("run:events", {
        runDir: detail.runDir,
        offset: 0,
      });
      const events = result?.events ?? [];
      if (!events.length)
        return Studio.empty(
          "No events",
          "events.ndjson is empty — the run produced no timeline.",
        );
      return h(
        "div",
        { class: "panel" },
        h(
          "div",
          { class: "panel-body tight" },
          h("div", { class: "timeline" }, events.map(eventRow)),
        ),
      );
    },

    async console(detail) {
      const node = await artifactIfExists(
        detail,
        "console/console.ndjson",
        "No console capture for this run.",
      );
      const errors = await artifactIfExists(
        detail,
        "console/errors.ndjson",
        null,
      );
      return h(
        "div",
        errors ? h("div", { class: "section-title" }, "Console errors") : null,
        errors,
        h("div", { class: "section-title" }, "All console messages"),
        node,
      );
    },

    async network(detail) {
      const failed = await artifactIfExists(
        detail,
        "network/failed_requests.ndjson",
        null,
      );
      const requests = await artifactIfExists(
        detail,
        "network/requests.ndjson",
        "No network capture for this run.",
        700_000,
      );
      return h(
        "div",
        h("div", { class: "section-title" }, "Failed requests"),
        failed ?? h("p", { class: "cell-dim", text: "none captured" }),
        h("div", { class: "section-title" }, "All requests"),
        requests,
      );
    },

    async diff(detail, _root, runRef) {
      const options = (state.runs ?? []).length
        ? state.runs
        : ((await api.call("runs:list", { limit: 60 })).runs ?? []);
      const others = options.filter((run) => run.runId !== detail.runId);
      const select = Studio.select(
        [
          ["previous", "previous run (auto)"],
          ...others.map((run) => [
            run.runId,
            `${run.spec} · ${fmt.relativeTime(run.startedAt)} · ${run.status}`,
          ]),
        ],
        { style: { minWidth: "320px" } },
      );
      const host = h("div", { style: { marginTop: "12px" } });
      const run = async () => {
        Studio.clear(host);
        host.appendChild(Studio.loading("comparing runs…"));
        try {
          const result = await api.call("runs:diff", {
            a: select.value,
            b: runRef,
          });
          Studio.clear(host);
          host.appendChild(renderDiff(result));
        } catch (error) {
          Studio.clear(host);
          host.appendChild(Studio.errorBox(error, "cairn diff"));
        }
      };
      return h(
        "div",
        h(
          "div",
          { class: "toolbar" },
          h("span", { class: "cell-dim", text: "compare" }),
          select,
          h("span", { class: "cell-dim", text: "→" }),
          h("span", {
            class: "mono",
            style: { fontSize: "11.5px" },
            text: detail.runId,
          }),
          h("button", {
            class: "btn btn-primary",
            type: "button",
            text: "Diff",
            onClick: () => void run(),
          }),
        ),
        host,
      );
    },
  };

  /**
   * @param {Record<string, any>} event
   */
  function eventRow(event) {
    const described = describeEvent(event);
    return h(
      "div",
      { class: "timeline-row" },
      h("span", {
        class: `dot dot-${
          described.tone === "info" ? "muted" : described.tone
        }`,
      }),
      h("span", { class: "label", text: described.label }),
      h("span", {
        class: "ts",
        text: event?.ts ? String(event.ts).slice(11, 23) : "",
      }),
    );
  }

  /**
   * Local mirror of lib/live.describeEvent so the view needs no extra round trip.
   * @param {Record<string, any>} event
   */
  function describeEvent(event) {
    const type = String(event?.type ?? "unknown");
    const stepId = event?.stepId ? ` ${event.stepId}` : "";
    switch (type) {
      case "run.started":
        return {
          label: `run started${event?.spec ? ` · ${event.spec}` : ""}`,
          tone: "info",
        };
      case "run.finished":
        return {
          label: `run finished · ${event?.status ?? "unknown"}`,
          tone: event?.status === "passed" ? "ok" : "bad",
        };
      case "step.started":
        return { label: `step${stepId} started`, tone: "info" };
      case "step.finished":
        return {
          label: `step${stepId} finished · ${fmt.formatDuration(event?.durationMs)}`,
          tone: event?.status === "failed" ? "bad" : "ok",
        };
      case "step.skipped":
        return { label: `step${stepId} skipped (when:)`, tone: "muted" };
      case "outcome.evaluated":
        return {
          label: `outcome ${event?.outcomeId ?? event?.id ?? ""} · ${event?.status ?? ""}`,
          tone: event?.status === "passed" ? "ok" : "bad",
        };
      case "artifact.screenshot":
        return { label: `screenshot ${event?.path ?? ""}`, tone: "muted" };
      case "artifact.snapshot":
        return { label: `snapshot ${event?.path ?? ""}`, tone: "muted" };
      case "viewport.set":
        return {
          label: `viewport ${event?.width ?? "?"}×${event?.height ?? "?"}`,
          tone: "muted",
        };
      default:
        return { label: type, tone: "muted" };
    }
  }

  /**
   * @param {any} detail
   * @param {string} relativePath
   * @param {string | null} emptyMessage
   * @param {number} [maxBytes]
   */
  async function artifactIfExists(
    detail,
    relativePath,
    emptyMessage,
    maxBytes = 400_000,
  ) {
    const listed = (detail.manifest?.artifacts ?? []).some(
      (entry) => entry.path === relativePath,
    );
    if (!listed && emptyMessage)
      return h("p", { class: "cell-dim", text: emptyMessage });
    const node = await Studio.artifactViewer(detail.runDir, relativePath, {
      maxBytes,
    });
    return node;
  }

  /**
   * @param {any} result
   */
  function renderDiff(result) {
    if (!result?.ok)
      return Studio.errorBox(
        new Error(result?.stderr || `cairn diff exited ${result?.exitCode}`),
        "diff",
      );
    const payload = result.payload ?? {};
    const nodes = [];
    const summary = payload.summary ?? payload.diffSummary ?? null;
    if (summary && typeof summary === "object") {
      nodes.push(
        Studio.panel(
          "Summary",
          Studio.keyValue(
            Object.entries(summary).map(([key, value]) => [
              key,
              typeof value === "object" ? JSON.stringify(value) : String(value),
            ]),
          ),
        ),
      );
    }
    nodes.push(
      h("div", { class: "section-title" }, "Structural diff"),
      h(
        "div",
        { class: "panel" },
        h(
          "div",
          { class: "panel-body" },
          h("div", { class: "tree" }, Studio.jsonTree(payload)),
        ),
      ),
    );
    return h("div", null, nodes);
  }

  /**
   * @param {any} detail
   */
  function fileQuickList(detail) {
    const entries = detail?.manifest?.artifacts ?? [];
    if (!entries.length)
      return h("p", { class: "cell-dim", text: "no manifest entries" });
    return h(
      "div",
      { class: "panel" },
      h(
        "div",
        { class: "panel-body tight" },
        entries.slice(0, 40).map((entry) =>
          h(
            "div",
            { class: "list-row" },
            h("span", {
              class: "mono",
              style: { fontSize: "11.5px" },
              text: entry.path,
            }),
            h("span", {
              class: "cell-dim",
              style: { marginLeft: "auto" },
              text: fmt.formatBytes(entry.bytes),
            }),
          ),
        ),
      ),
    );
  }

  /**
   * @param {string} label
   * @param {string} value
   * @param {string} [note]
   */
  function statCard(label, value, note) {
    return h(
      "div",
      { class: "stat-card" },
      h("div", { class: "k", text: label }),
      h("div", { class: "v", text: value }),
      note ? h("div", { class: "n", text: note }) : null,
    );
  }

  /**
   * @param {any} run
   */
  async function reRun(run) {
    const specPath = run?.spec?.path;
    if (!specPath) {
      toast("Cannot re-run", "This run record has no spec path.", "bad");
      return;
    }
    const exists = await api.call("fs:exists", specPath).catch(() => false);
    if (!exists) {
      toast("Spec missing", `${specPath} no longer exists on disk.`, "bad");
      return;
    }
    await actions.startRun([specPath]);
    Studio.navigate("live");
  }

  Studio.views = Studio.views || {};
  Studio.views.run = {
    id: "run",
    label: "Run detail",
    glyph: "•",
    render,
    hidden: true,
  };
})();
