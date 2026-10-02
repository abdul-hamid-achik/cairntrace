/**
 * Run detail view — the evidence screen.
 *
 * One run's whole artifact directory, organised the way an operator debugs:
 * what failed, which step, what the page actually said, what it looked like,
 * and what the network did. Everything is read from the artifacts cairn
 * already wrote; nothing is re-derived here.
 */
(function bootRunDetailView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, actions, api, fmt, toast } = Studio;

  const TABS = [
    {
      id: "failure",
      label: "Failure",
      when: (detail) => Boolean(detail?.failure),
    },
    { id: "overview", label: "Overview" },
    { id: "steps", label: "Steps" },
    { id: "outcomes", label: "Outcomes" },
    {
      id: "teardown",
      label: "Teardown",
      when: (detail) =>
        (detail?.eventsModel?.teardown ?? []).length > 0 ||
        (detail?.teardown ?? []).length > 0,
    },
    {
      id: "preconditions",
      label: "Preconditions",
      when: (detail) => (detail?.eventsModel?.preconditions ?? []).length > 0,
    },
    {
      id: "gates",
      label: "Gates",
      when: (detail) => (detail?.eventsModel?.gates ?? []).length > 0,
    },
    {
      id: "fixtures",
      label: "Fixtures",
      when: (detail) =>
        (detail?.eventsModel?.fixtures ?? []).length > 0 ||
        (detail?.fixtures?.entries ?? []).length > 0,
    },
    {
      id: "hooks",
      label: "Hooks",
      when: (detail) => (detail?.eventsModel?.hooks ?? []).length > 0,
    },
    {
      id: "services",
      label: "Services",
      when: (detail) =>
        (detail?.eventsModel?.services ?? []).length > 0 ||
        (detail?.servicesFiles ?? []).length > 0,
    },
    {
      id: "media",
      label: "Video & trace",
      when: (detail) =>
        (detail?.videos ?? []).length > 0 || (detail?.traces ?? []).length > 0,
    },
    {
      id: "logs",
      label: "Logs",
      when: (detail) => detail?.hasRunLog || (detail?.logs ?? []).length > 0,
    },
    { id: "artifacts", label: "Artifacts" },
    { id: "events", label: "Events" },
    { id: "console", label: "Console" },
    { id: "network", label: "Network" },
    { id: "diff", label: "Compare" },
  ];

  let activeTab = "overview";
  /** The run the active tab belongs to: a different run opens failure-first. */
  let activeRunRef = null;
  /**
   * Where "back" goes: the view that opened this run (an invocation's plan
   * opens its runs here and expects to return to that invocation).
   * @type {{ view: string, params: Record<string, any>, label: string }}
   */
  let back = { view: "runs", params: {}, label: "← Runs" };
  /**
   * Runs (by run ref) with a `cairn publish` in flight: their Publish button
   * stays disabled across re-renders until the upload answers (main refuses
   * a second concurrent publish of the same run too).
   * @type {Set<string>}
   */
  const publishing = new Set();

  /**
   * @param {HTMLElement} root
   * @param {{ runRef?: string, tab?: string, from?: string, invocationId?: string }} params
   */
  async function render(root, params) {
    const runRef = params?.runRef ?? state.selectedRun;
    // An explicit origin sets "back"; a run opened from inside run detail
    // (history strip, compare) keeps the one it had.
    if (params?.from === "invocations")
      back = {
        view: "invocations",
        params: params.invocationId
          ? { invocationId: params.invocationId }
          : {},
        label: "← Invocation",
      };
    else if (params?.from === "live")
      back = { view: "live", params: {}, label: "← Live" };
    else if (params?.from === "runs")
      back = { view: "runs", params: {}, label: "← Runs" };
    if (!runRef) {
      Studio.clear(root);
      root.appendChild(
        Studio.empty("No run selected", "Pick a run from the Runs view."),
      );
      return;
    }
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
    if (params?.tab) activeTab = params.tab;
    else if (activeRunRef !== runRef)
      activeTab = state.runDetail?.failure ? "failure" : "overview";
    activeRunRef = runRef;
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
                    .call("run:open-report", Studio.runRefOf(detail))
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
          // Pinning is about retention, which only applies in the artifact
          // root (a restored stash is a temp copy).
          run && !detail?.restored
            ? h("button", {
                class: "btn",
                type: "button",
                text: detail?.pinned ? "Unpin" : "Pin",
                dataset: { action: "pin" },
                title: detail?.pinned
                  ? "cairn unpin: let retention prune this run again"
                  : "cairn pin: retention never prunes this run",
                onClick: () => void togglePin(root, runRef),
              })
            : null,
          run && run.status !== "refused"
            ? publishButton(root, runRef, detail)
            : null,
          h("button", {
            class: "btn btn-ghost",
            type: "button",
            text: back.label,
            onClick: () => Studio.navigate(back.view, back.params),
          }),
        ],
      ),
    );

    const badges = runBadges(detail);
    if (badges) root.appendChild(badges);
    if (run?.spec?.name || run?.spec?.path) {
      const historyHost = h("div", { class: "history-host" });
      root.appendChild(historyHost);
      void loadHistory(
        historyHost,
        run.spec.name ?? run.spec.path,
        detail.runId,
      );
    }

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

    if (run.status === "refused") {
      root.appendChild(
        Studio.refusalBox(detail.refusal, { summary: run.summary ?? null }),
      );
    } else if (run.status !== "passed" && activeTab !== "failure") {
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

    const tabStrip = h(
      "div",
      { class: "tabs", role: "tablist", ariaLabel: "run evidence" },
      TABS.filter((tab) => !tab.when || tab.when(detail)).map((tab) => {
        const count = tabCount(tab.id, detail);
        const selected = activeTab === tab.id;
        return h(
          "button",
          {
            class: `tab${selected ? " active" : ""}`,
            type: "button",
            role: "tab",
            id: `run-tab-${tab.id}`,
            ariaSelected: selected ? "true" : "false",
            ariaControls: "tab-host",
            tabindex: selected ? "0" : "-1",
            dataset: { tab: tab.id },
            onClick: () => {
              activeTab = tab.id;
              paint(root, runRef);
              // The repaint replaced the strip: keep focus on the new tab.
              /** @type {HTMLElement | null} */ (
                root.querySelector(`#run-tab-${tab.id}`)
              )?.focus();
            },
          },
          tab.label,
          count === null
            ? null
            : h("span", { class: "count", text: String(count) }),
        );
      }),
    );
    // Left/Right move between tabs (automatic activation), Home/End jump.
    Studio.rovingKeys(tabStrip, {
      items: () => /** @type {HTMLElement[]} */ ([
        ...tabStrip.querySelectorAll(".tab"),
      ]),
      orientation: "horizontal",
      onMove: (tab) => tab.click(),
    });
    root.appendChild(tabStrip);

    const host = h("div", {
      id: "tab-host",
      role: "tabpanel",
      ariaLabelledby: `run-tab-${activeTab}`,
    });
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
      case "preconditions":
        return detail?.eventsModel?.preconditions?.length || null;
      case "gates":
        return detail?.eventsModel?.gates?.length || null;
      case "teardown":
        return teardownRows(detail).length || null;
      case "fixtures":
        return fixtureRows(detail).length || null;
      case "hooks":
        return detail?.eventsModel?.hooks?.length || null;
      case "logs":
        return (
          (detail?.logs?.length ?? 0) + (detail?.hasRunLog ? 1 : 0) || null
        );
      case "events":
        return detail?.eventCount || null;
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
      const renderer = TAB_RENDERERS[tabId] ?? TAB_RENDERERS.overview;
      const node = await renderer(detail, root, runRef);
      Studio.clear(host);
      host.appendChild(node);
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, tabId));
    }
  }

  /** @type {Record<string, (detail: any, root: HTMLElement, runRef: string) => Promise<Node> | Node>} */
  const TAB_RENDERERS = {
    failure(detail) {
      return renderFailure(detail);
    },

    gates(detail) {
      const rows = detail.eventsModel?.gates ?? [];
      return h(
        "div",
        null,
        h("p", {
          class: "cell-dim",
          style: { marginTop: "0" },
          text: "Readiness gates this run waited on (a spec's preconditions.wait; services and the web server log theirs to the invocation journal). A gate that is not ready within its budget errors the run as the precondition `wait <gate>`.",
        }),
        rows.map((row) => gateCard(row)),
      );
    },

    teardown(detail) {
      const rows = teardownRows(detail);
      const failed = rows.filter((row) => row.status === "failed").length;
      return h(
        "div",
        null,
        h("p", {
          class: "cell-dim",
          style: { marginTop: "0" },
          text: `Teardown runs after the outcomes on every exit path (passed, failed, errored, cancelled; run items also on SIGINT/SIGTERM) and sees the verdict in CAIRN_RUN_STATUS. ${
            failed
              ? "A failed item keeps the run's verdict unless the spec sets failRun: true."
              : "Every item finished."
          }`,
        }),
        h(
          "div",
          { class: "panel" },
          h(
            "div",
            { class: "panel-body tight" },
            rows.map((row) => teardownRowView(row)),
          ),
        ),
      );
    },

    fixtures(detail) {
      const rows = fixtureRows(detail);
      const dryRun = rows.some((row) =>
        Object.values(row.verbs ?? {}).some(
          (/** @type {any} */ verb) => verb.status === "dry-run",
        ),
      );
      const body = h("tbody");
      for (const row of rows) {
        body.appendChild(
          h(
            "tr",
            { class: "fixture-row", dataset: { name: row.name } },
            h("td", { class: "mono", text: row.name }),
            h("td", { class: "cell-dim", text: row.adapter ?? "—" }),
            h("td", { class: "cell-dim", text: row.scope ?? "—" }),
            h(
              "td",
              { class: "cell-labels" },
              (row.order ?? []).length
                ? row.order.map((/** @type {string} */ verb) => {
                    const entry = row.verbs[verb];
                    return h("span", {
                      class:
                        `tag tag-${Studio.events.fixtureTone(entry.status)}`.replace(
                          "tag-muted",
                          "tag",
                        ),
                      title: [
                        entry.durationMs === null
                          ? null
                          : fmt.formatDuration(entry.durationMs),
                        entry.ts ? fmt.formatTimestamp(entry.ts) : null,
                        entry.reason,
                        entry.error,
                      ]
                        .filter(Boolean)
                        .join("\n"),
                      text: `${verb} ${entry.status}`,
                    });
                  })
                : h("span", { class: "cell-dim", text: "—" }),
            ),
            h("td", {
              class: "cell-dim",
              text: row.ensuredAt ? fmt.formatTimestamp(row.ensuredAt) : "—",
            }),
            h("td", {
              class: "cell-dim",
              text: row.teardown
                ? `${row.teardown.status}${
                    row.teardown.at
                      ? ` · ${fmt.formatTimestamp(row.teardown.at)}`
                      : ""
                  }`
                : "—",
            }),
            h(
              "td",
              null,
              Studio.outputsList(row.outputs) ??
                h("span", { class: "cell-dim", text: "—" }),
            ),
          ),
        );
        const errors = Object.entries(row.verbs ?? {}).filter(
          ([, entry]) => /** @type {any} */ (entry).error,
        );
        for (const [verb, entry] of errors)
          body.appendChild(
            h(
              "tr",
              { class: "fixture-error-row" },
              h(
                "td",
                { colSpan: 7 },
                h("div", {
                  class: "step-error",
                  text: `${verb}: ${/** @type {any} */ (entry).error}`,
                }),
              ),
            ),
          );
      }
      return h(
        "div",
        null,
        dryRun
          ? h("p", {
              class: "cell-dim",
              style: { marginTop: "0" },
              text: "dry-run: the environment's policy is shared, so mutating fixture verbs only reported what they would do (opt in from the spec or CLI to run them).",
            })
          : null,
        h(
          "table",
          { class: "grid fixtures-table" },
          h(
            "thead",
            h(
              "tr",
              [
                "fixture",
                "adapter",
                "scope",
                "verbs",
                "ensured",
                "teardown",
                "outputs",
              ].map((label) => h("th", { text: label })),
            ),
          ),
          body,
        ),
        detail.fixtures
          ? h("p", {
              class: "cell-dim",
              text: "fixtures.json is this run's ledger; outputs are the non-secret values the fixtures exposed as ${fixtures.<name>.<key>} (credential-looking keys stay masked).",
            })
          : null,
      );
    },

    preconditions(detail) {
      const rows = detail.eventsModel?.preconditions ?? [];
      return h(
        "div",
        null,
        rows.map((row) =>
          h(
            "details",
            { class: "outcome-card", open: row.status !== "passed" },
            h(
              "summary",
              h("span", {
                class: `dot dot-${fmt.statusTone(row.status === "running" ? "interrupted" : row.status)}`,
              }),
              h("span", { class: "outcome-id", text: row.name }),
              Studio.tag(
                row.timedOut ? "timed out" : `exit ${row.exitCode ?? "?"}`,
                row.status === "passed" ? "ok" : "bad",
              ),
              h("span", {
                class: "cell-dim",
                style: { marginLeft: "auto" },
                text: `${fmt.formatDuration(row.durationMs)}${
                  row.timeoutMs
                    ? ` of ${fmt.formatDuration(row.timeoutMs)}`
                    : ""
                }`,
              }),
            ),
            h(
              "div",
              { class: "outcome-body" },
              row.progress?.length
                ? h("div", {
                    class: "cell-dim",
                    text: `last progress: ${row.progress.at(-1)}`,
                  })
                : null,
              outputBlock(detail, row.logPath, row.outputTail, "output"),
            ),
          ),
        ),
      );
    },

    hooks(detail) {
      const rows = detail.eventsModel?.hooks ?? [];
      return h(
        "div",
        null,
        rows.map((row) =>
          h(
            "details",
            { class: "outcome-card", open: row.status === "failed" },
            h(
              "summary",
              h("span", { class: `dot dot-${fmt.statusTone(row.status)}` }),
              h("span", {
                class: "outcome-id",
                text: `${row.hook} hook #${row.index ?? "?"}`,
              }),
              Studio.tag(
                row.timedOut ? "timed out" : `exit ${row.exitCode ?? "?"}`,
                row.status === "passed"
                  ? "ok"
                  : row.status === "failed"
                    ? "bad"
                    : "info",
              ),
              h("span", {
                class: "cell-dim",
                style: { marginLeft: "auto" },
                text: fmt.formatDuration(row.durationMs),
              }),
            ),
            h(
              "div",
              { class: "outcome-body" },
              row.command
                ? Studio.codeBlock(row.command, { tight: true })
                : null,
              outputBlock(
                detail,
                row.logPath,
                row.outputTail,
                "output",
                row.logSource,
              ),
            ),
          ),
        ),
      );
    },

    services(detail) {
      const events = detail.eventsModel?.services ?? [];
      const files = detail.servicesFiles ?? [];
      const viewer = h("div", { style: { marginTop: "12px" } });
      return h(
        "div",
        null,
        events.length
          ? h(
              "div",
              h(
                "div",
                { class: "section-title", style: { marginTop: "0" } },
                `Lifecycle (${events.length})`,
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
                    events.map((entry) =>
                      eventRow({
                        ts: entry.ts,
                        type: `services.${entry.phase}.${entry.event}`,
                        message: entry.message,
                        data: entry.data,
                      }),
                    ),
                  ),
                ),
              ),
            )
          : h("p", {
              class: "cell-dim",
              text: "no services lifecycle events in this run",
            }),
        files.length
          ? h(
              "div",
              h(
                "div",
                { class: "section-title" },
                `Captured evidence (${files.length})`,
              ),
              fileButtons(detail, files, viewer),
              viewer,
            )
          : null,
      );
    },

    async media(detail) {
      const nodes = [];
      for (const video of detail.videos ?? []) {
        nodes.push(
          h(
            "div",
            { class: "section-title" },
            `Video · ${fmt.formatBytes(video.bytes)}`,
          ),
        );
        nodes.push(await Studio.videoViewer(detail.runDir, video.path));
      }
      for (const trace of detail.traces ?? []) {
        nodes.push(h("div", { class: "section-title" }, "Trace"));
        const entry = (detail.manifest?.artifacts ?? []).find(
          (/** @type {any} */ item) => item?.path === trace.path,
        );
        nodes.push(
          await Studio.traceViewer(
            detail.runDir,
            trace.path,
            typeof entry?.sensitivity === "string" ? entry.sensitivity : null,
          ),
        );
      }
      return h("div", null, nodes);
    },

    async logs(detail) {
      const files = [
        ...(detail.hasRunLog ? [{ path: "run.log", bytes: null }] : []),
        ...(detail.logs ?? []),
      ];
      const viewer = h("div", { style: { marginTop: "12px" } });
      const node = h("div", fileButtons(detail, files, viewer), viewer);
      if (files[0]) {
        viewer.appendChild(
          await Studio.artifactViewer(detail.runDir, files[0].path, {
            maxBytes: 400_000,
          }),
        );
      }
      return node;
    },

    overview(detail, root, runRef) {
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
          h(
            "span",
            `${fmt.formatTimestamp(run.startedAt)} (`,
            Studio.relTime(run.startedAt),
            ")",
          ),
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
      if (detail.pinned)
        rows.push([
          "pinned",
          `${detail.pinned.at ? fmt.formatTimestamp(detail.pinned.at) : "yes"}${
            detail.pinned.reason ? ` · ${detail.pinned.reason}` : ""
          }`,
        ]);
      if (detail.refusal)
        rows.push(["refusal", CairnPolicy.refusalText(detail.refusal)]);
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
      const gates = detail.eventsModel?.gates ?? [];
      if (gates.length)
        rows.push([
          "gates",
          gates
            .map(
              (/** @type {any} */ gate) =>
                `${gate.name} ${
                  gate.status === "passed" ? "ready" : gate.status
                } (${gate.attempts} attempt${gate.attempts === 1 ? "" : "s"})`,
            )
            .join(" · "),
        ]);
      const fixtures = fixtureRows(detail);
      if (fixtures.length)
        rows.push([
          "fixtures",
          fixtures
            .map(
              (row) =>
                `${row.name}${
                  row.lastStatus ? ` ${row.lastVerb} ${row.lastStatus}` : ""
                }`,
            )
            .join(" · "),
        ]);
      const teardown = teardownRows(detail);
      if (teardown.length) {
        const failedTeardown = teardown.filter(
          (row) => row.status === "failed",
        );
        rows.push([
          "teardown",
          `${teardown.length} item${teardown.length === 1 ? "" : "s"}${
            failedTeardown.length
              ? ` · ${failedTeardown.length} failed`
              : " · all finished"
          }`,
        ]);
      }

      const nodes = [
        Studio.panel("Run record", Studio.keyValue(rows)),
        evidencePanel(detail, root, runRef),
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
      const model = detail.eventsModel ?? null;
      const rows = steps.map((step, index) => {
        const id = step.id ?? `step_${index + 1}`;
        const live =
          model && model.stepIndex?.[id] !== undefined
            ? model.steps[model.stepIndex[id]]
            : null;
        const expects = stepExpects(detail, id);
        const captures = stepCaptures(detail, step);
        // A runner that labels capture steps `step`: the capture file says.
        const kind =
          (!live?.kind || live.kind === "step") && captures.length
            ? "capture"
            : (live?.kind ?? null);
        const what = live
          ? kind === "capture" && (!live.label || live.label === "step")
            ? `capture → ${captures.map((entry) => entry.assign).join(", ")}`
            : Studio.events.stepWhat(kind, live.label)
          : "";
        const failedExpect = expects.some((entry) => entry.status === "failed");
        // A run step's error carries its output tail: keep its lines.
        const multiline =
          live?.kind === "run" || /\n/.test(String(step.error ?? ""));
        return h(
          "div",
          { class: "step-row", dataset: { step: id } },
          h("span", { class: `dot dot-${fmt.statusTone(step.status)}` }),
          h("span", { class: "step-id", text: id }),
          h("span", {
            class: "step-meta",
            text: fmt.formatDuration(step.durationMs),
          }),
          h(
            "div",
            { style: { minWidth: "0" } },
            what
              ? h(
                  "div",
                  { class: "step-what" },
                  kind ? Studio.tag(kind, "muted") : null,
                  h("span", {
                    class: "cell-dim mono",
                    text: ` ${fmt.truncate(what, 200)}`,
                  }),
                )
              : null,
            step.resolved
              ? h("span", {
                  class: "cell-dim",
                  text: `resolved ${step.resolved.role}${
                    step.resolved.name ? ` "${step.resolved.name}"` : ""
                  }${step.resolved.ref ? ` @${step.resolved.ref}` : ""}`,
                })
              : null,
            // a failed expect's verdict block says it better than its error
            step.error && failedExpect
              ? null
              : step.error && multiline
                ? Studio.codeBlock(fmt.truncate(step.error, 4000), {
                    tight: true,
                    className: "step-error-output",
                  })
                : step.error
                  ? h("div", {
                      class: "step-error",
                      text: fmt.truncate(step.error, 400),
                    })
                  : null,
            expects.map((entry) => expectBlock(entry)),
            captures.map((entry) => captureBlock(entry)),
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
        );
      });
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
      const expects = allExpects(detail);
      if (!outcomes.length && !expects.length)
        return Studio.empty(
          "No outcomes",
          "This spec declared no outcomes, or the run never reached evaluation.",
        );
      const model = detail.eventsModel ?? null;
      return h(
        "div",
        null,
        outcomes.map((outcome) => {
          const row =
            model && model.outcomeIndex?.[outcome.id] !== undefined
              ? model.outcomes[model.outcomeIndex[outcome.id]]
              : null;
          const attempts = outcome.data?.attemptCount ?? row?.attempts ?? null;
          const polledMs = outcome.data?.polledMs ?? row?.polledMs ?? null;
          return h(
            "details",
            {
              class: "outcome-card",
              open: outcome.status !== "passed",
              dataset: { outcome: outcome.id },
            },
            h(
              "summary",
              h("span", { class: `dot dot-${fmt.statusTone(outcome.status)}` }),
              h("span", { class: "outcome-id", text: outcome.id }),
              Studio.tag(outcome.status, fmt.statusTone(outcome.status)),
              row?.kind ? Studio.tag(row.kind, "muted") : null,
              attempts
                ? h("span", {
                    class: "tag attempts-tag",
                    title: "evaluated under poll",
                    text: `${attempts} attempt${attempts === 1 ? "" : "s"}${
                      polledMs === null
                        ? ""
                        : ` · ${fmt.formatDuration(polledMs)}`
                    }`,
                  })
                : null,
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
              outcome.data
                ? h(
                    "div",
                    h("div", { class: "section-title" }, "Observed"),
                    Studio.dataEvidenceView(outcome.data, {
                      count: row?.attempts ?? null,
                      polledMs: row?.polledMs ?? null,
                    }),
                  )
                : null,
              // Without an attempt log on disk, the progress lines the
              // verifier narrated while it polled are the timeline.
              !outcome.data?.attempts && (row?.progress ?? []).length
                ? h(
                    "div",
                    h(
                      "div",
                      { class: "section-title" },
                      `Progress (${row.progress.length})`,
                    ),
                    h(
                      "div",
                      { class: "attempt-list" },
                      row.progress.map((/** @type {string} */ line) =>
                        h("div", {
                          class: "attempt-row cell-dim mono",
                          text: line,
                        }),
                      ),
                    ),
                  )
                : null,
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
          );
        }),
        expects.length
          ? h(
              "div",
              { class: "expects-section" },
              h(
                "div",
                { class: "section-title" },
                `Step expectations (${expects.length})`,
              ),
              expects.map((entry) => expectBlock(entry, { withStep: true })),
            )
          : null,
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
                        .call("run:reveal", Studio.runRefOf(detail), entry.path)
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

  // ── wave 4: gates, teardown, fixtures, expect / capture ─────────────────

  /**
   * Teardown items: the events (richer), else run.json's `teardown` record.
   * @param {any} detail
   * @returns {Array<Record<string, any>>}
   */
  function teardownRows(detail) {
    const fromEvents = detail?.eventsModel?.teardown ?? [];
    if (fromEvents.length) return fromEvents;
    return (detail?.teardown ?? []).map(
      (/** @type {any} */ entry, /** @type {number} */ index) => ({
        index: entry.index ?? index + 1,
        total: null,
        kind: entry.kind,
        stepId: entry.stepId,
        label: null,
        runStatus: null,
        signal: null,
        status: entry.status,
        durationMs: entry.durationMs,
        error: entry.error,
        timedOut: false,
      }),
    );
  }

  /**
   * Fixtures the run touched: `fixture.*` verbs merged with the run's
   * ledger (`fixtures.json`) by name.
   * @param {any} detail
   * @returns {Array<Record<string, any>>}
   */
  function fixtureRows(detail) {
    /** @type {Map<string, Record<string, any>>} */
    const byName = new Map();
    for (const row of detail?.eventsModel?.fixtures ?? [])
      byName.set(row.name, {
        ...row,
        ensuredAt: null,
        teardown: null,
      });
    for (const entry of detail?.fixtures?.entries ?? []) {
      const row = byName.get(entry.name) ?? {
        name: entry.name,
        adapter: null,
        scope: null,
        verbs: {},
        order: [],
        outputs: null,
        lastVerb: null,
        lastStatus: null,
        ensuredAt: null,
        teardown: null,
      };
      row.adapter = row.adapter ?? entry.adapter;
      row.scope = row.scope ?? entry.scope;
      row.ensuredAt = entry.ensuredAt ?? row.ensuredAt;
      row.teardown = entry.teardown ?? row.teardown;
      if (!row.outputs?.length && entry.outputs?.length)
        row.outputs = entry.outputs;
      // Without fixture.* events (a stream cut short), the ledger's own
      // verdicts stand in: the ensure status, the reset, the teardown.
      if (!row.order.length) {
        /** @type {Array<[string, any]>} */
        const verbs = [
          [
            "ensure",
            entry.status ? { status: entry.status, at: entry.ensuredAt } : null,
          ],
          ["reset", entry.reset],
          ["teardown", entry.teardown],
        ];
        for (const [verb, record] of verbs) {
          if (!record) continue;
          row.verbs[verb] = {
            status: record.status,
            durationMs: null,
            error: record.error ?? null,
            reason: verb === "ensure" ? (entry.reason ?? null) : null,
            ts: record.at ?? null,
          };
          row.order.push(verb);
        }
      }
      byName.set(entry.name, row);
    }
    return [...byName.values()];
  }

  /**
   * Status tone of a gate row.
   * @param {Record<string, any>} gate
   */
  function gateTone(gate) {
    if (gate.status === "passed") return "ok";
    if (gate.status === "failed") return gate.cancelled ? "warn" : "bad";
    if (gate.status === "interrupted") return "warn";
    return "info";
  }

  /**
   * One gate wait: scope, verdict, budget, and its attempts.
   * @param {Record<string, any>} gate
   */
  function gateCard(gate) {
    const scope = Studio.events.gateScopeLabel(gate.scope);
    const verdict =
      gate.status === "passed"
        ? "ready"
        : gate.status === "failed"
          ? gate.cancelled
            ? "cancelled"
            : gate.timedOut
              ? "timed out"
              : "not ready"
          : gate.status;
    const first = gate.attemptLog?.[0]?.ts
      ? Date.parse(gate.attemptLog[0].ts)
      : null;
    return h(
      "details",
      {
        class: "outcome-card gate-card",
        open: gate.status !== "passed",
        dataset: { gate: gate.name },
      },
      h(
        "summary",
        h("span", { class: `dot dot-${gateTone(gate)}` }),
        h("span", { class: "outcome-id", text: `gate ${gate.name}` }),
        scope ? Studio.tag(scope, "muted") : null,
        Studio.tag(verdict, gateTone(gate)),
        h("span", {
          class: "cell-dim",
          style: { marginLeft: "auto" },
          text: `${gate.attempts} attempt${gate.attempts === 1 ? "" : "s"}${
            gate.durationMs === null
              ? ""
              : ` · ${fmt.formatDuration(gate.durationMs)}`
          }${gate.budgetMs ? ` of ${fmt.formatDuration(gate.budgetMs)}` : ""}`,
        }),
      ),
      h(
        "div",
        { class: "outcome-body" },
        Studio.keyValue([
          [
            "budget",
            gate.budgetMs ? fmt.formatDuration(gate.budgetMs) : "no deadline",
          ],
          ...(gate.everyMs
            ? [["every", fmt.formatDuration(gate.everyMs)]]
            : []),
          ...(gate.stable
            ? [["stable", `${gate.stable} passing attempts in a row`]]
            : []),
          ["last answer", gate.lastDetail ?? "—"],
        ]),
        (gate.attemptLog ?? []).length
          ? h(
              "div",
              h(
                "div",
                { class: "section-title" },
                `Attempts${
                  gate.attemptsDropped
                    ? ` (${gate.attemptsDropped} repeated attempts not shown)`
                    : ""
                }`,
              ),
              h(
                "div",
                { class: "attempt-list" },
                gate.attemptLog.map((/** @type {any} */ attempt) =>
                  h(
                    "div",
                    {
                      class: `attempt-row attempt-${attempt.ok ? "ok" : "bad"}`,
                    },
                    h("span", {
                      class: `dot dot-${attempt.ok ? "ok" : "bad"}`,
                    }),
                    h("span", {
                      class: "attempt-n mono",
                      text: `#${attempt.attempt}`,
                    }),
                    h("span", {
                      class: "attempt-at cell-dim mono",
                      text:
                        first !== null && attempt.ts
                          ? `+${fmt.formatDuration(Math.max(0, Date.parse(attempt.ts) - first))}`
                          : "",
                    }),
                    h("span", {
                      class: "attempt-summary",
                      text: attempt.detail ?? "",
                    }),
                  ),
                ),
              ),
              h("p", {
                class: "cell-dim",
                text: "Identical attempts are coalesced by the runner: one is written when the answer changes, and at most every 5s otherwise.",
              }),
            )
          : null,
      ),
    );
  }

  /**
   * One teardown item.
   * @param {Record<string, any>} row
   */
  function teardownRowView(row) {
    const what = Studio.events.stepWhat(row.kind, row.label);
    return h(
      "div",
      {
        class: `step-row teardown-row teardown-${row.status}`,
        dataset: { teardown: String(row.index) },
      },
      h("span", {
        class: `dot dot-${
          row.status === "running" ? "running" : fmt.statusTone(row.status)
        }`,
      }),
      h("span", {
        class: "step-id",
        text: `${row.index}${
          row.total ? `/${row.total}` : ""
        } ${row.stepId ?? ""}`.trim(),
      }),
      h("span", {
        class: "step-meta",
        text:
          row.status === "skipped"
            ? "skipped"
            : fmt.formatDuration(row.durationMs),
      }),
      h(
        "div",
        { style: { minWidth: "0" } },
        h(
          "div",
          { class: "step-what" },
          row.kind ? Studio.tag(row.kind, "muted") : null,
          what && what !== row.kind
            ? h("span", { class: "cell-dim mono", text: ` ${what}` })
            : null,
          row.runStatus
            ? h("span", {
                class: "cell-dim",
                text: ` · saw CAIRN_RUN_STATUS=${row.runStatus}`,
              })
            : null,
          row.signal ? Studio.tag(`on ${row.signal}`, "warn") : null,
          row.timedOut ? Studio.tag("timed out", "bad") : null,
        ),
        row.error
          ? Studio.codeBlock(fmt.truncate(row.error, 4000), {
              tight: true,
              className: "step-error-output",
            })
          : null,
      ),
    );
  }

  /**
   * Expect verdicts of one step: its files, else its events.
   * @param {any} detail
   * @param {string} stepId
   * @returns {Array<Record<string, any>>}
   */
  function stepExpects(detail, stepId) {
    const files = (detail?.expects ?? []).filter(
      (/** @type {any} */ entry) => entry.stepId === stepId,
    );
    if (files.length) return files;
    const row =
      detail?.eventsModel?.stepIndex?.[stepId] !== undefined
        ? detail.eventsModel.steps[detail.eventsModel.stepIndex[stepId]]
        : null;
    return row?.expect ? [expectFromEvent(row.expect)] : [];
  }

  /**
   * An `expect.*` event row in the expect-file shape.
   * @param {Record<string, any>} entry
   */
  function expectFromEvent(entry) {
    return {
      path: entry.path,
      id: entry.expectId,
      stepId: entry.stepId,
      status: entry.status,
      kind: entry.kind,
      expected: entry.expected,
      actual: entry.actual,
      attempts: entry.attempts,
      durationMs: entry.durationMs,
      table: null,
      observed: null,
    };
  }

  /**
   * Every expect verdict of the run (files first, events for the rest).
   * @param {any} detail
   * @returns {Array<Record<string, any>>}
   */
  function allExpects(detail) {
    const files = detail?.expects ?? [];
    const seen = new Set(files.map((/** @type {any} */ entry) => entry.path));
    return [
      ...files,
      ...(detail?.eventsModel?.expects ?? [])
        .filter(
          (/** @type {any} */ entry) => !entry.path || !seen.has(entry.path),
        )
        .map(expectFromEvent),
    ];
  }

  /**
   * Captured values of one step (its `captures/*.json` artifacts).
   * @param {any} detail
   * @param {Record<string, any>} step
   * @returns {Array<Record<string, any>>}
   */
  function stepCaptures(detail, step) {
    const paths = new Set(
      (step.artifacts ?? []).filter((/** @type {string} */ entry) =>
        entry.startsWith("captures/"),
      ),
    );
    return (detail?.captures ?? []).filter((/** @type {any} */ entry) =>
      paths.has(entry.path),
    );
  }

  /**
   * An expect verdict: what was asserted, what the page said, how long it
   * retried.
   * @param {Record<string, any>} entry
   * @param {{ withStep?: boolean }} [options]
   */
  function expectBlock(entry, options = {}) {
    const passed = entry.status === "passed";
    return h(
      "div",
      {
        class: `expect-entry expect-${passed ? "passed" : "failed"}`,
        dataset: { expect: entry.id ?? "" },
      },
      h(
        "div",
        { class: "expect-head" },
        Studio.tag(
          `expect ${passed ? "passed" : entry.status}`,
          passed ? "ok" : "bad",
        ),
        h("span", { class: "mono", text: entry.id ?? "?" }),
        options.withStep && entry.stepId && entry.stepId !== entry.id
          ? h("span", { class: "cell-dim", text: ` · step ${entry.stepId}` })
          : null,
        entry.kind ? Studio.tag(entry.kind, "muted") : null,
        h("span", {
          class: "cell-dim",
          text: `${
            entry.attempts
              ? ` ${entry.attempts} attempt${entry.attempts === 1 ? "" : "s"}`
              : ""
          }${
            entry.durationMs === null || entry.durationMs === undefined
              ? ""
              : ` · ${fmt.formatDuration(entry.durationMs)}`
          }`,
        }),
      ),
      Studio.keyValue([
        ["expected", entry.expected ?? "—"],
        ["actual", entry.actual ?? "—"],
      ]),
      Studio.dataTable(entry.table),
      entry.observed ? Studio.codeBlock(entry.observed, { tight: true }) : null,
    );
  }

  /**
   * A captured value: `${captures.<assign>}` and what it holds.
   * @param {Record<string, any>} entry
   */
  function captureBlock(entry) {
    return h(
      "div",
      { class: "capture-entry", dataset: { capture: entry.assign } },
      h(
        "div",
        { class: "expect-head" },
        Studio.tag("capture", "info"),
        h("span", { class: "mono", text: `\${captures.${entry.assign}}` }),
        entry.kind ? Studio.tag(entry.kind, "muted") : null,
      ),
      Studio.dataTable(entry.table),
      entry.value ? Studio.codeBlock(entry.value, { tight: true }) : null,
      entry.masked
        ? h("p", {
            class: "cell-dim",
            text: "masked: the name looks like a credential (see the capture file for the value)",
          })
        : null,
      !entry.table && !entry.value
        ? h("p", { class: "cell-dim", text: "no value recorded" })
        : null,
    );
  }

  /**
   * One event row via the shared describer (lib/events.js).
   * @param {Record<string, any>} event
   */
  function eventRow(event) {
    const described = Studio.events.describeEvent(event);
    return h(
      "div",
      { class: "timeline-row" },
      h("span", {
        class: `dot dot-${
          described.tone === "info" ? "muted" : described.tone
        }`,
      }),
      h(
        "span",
        { class: "label", title: described.detail ?? described.label },
        described.label,
        described.detail
          ? h("span", { class: "cell-dim", text: ` — ${described.detail}` })
          : null,
      ),
      h("span", {
        class: "ts",
        text: event?.ts ? String(event.ts).slice(11, 23) : "",
      }),
    );
  }

  /**
   * Stash + retention badges for the header.
   * @param {any} detail
   */
  function runBadges(detail) {
    const model = detail?.eventsModel;
    const tags = [];
    if (detail?.run?.status === "refused")
      tags.push(
        h("span", {
          class: "tag tag-refused",
          title: CairnPolicy.refusalText(detail.refusal),
          text: `refused${
            detail.refusal?.env ? ` on ${detail.refusal.env}` : ""
          }`,
        }),
      );
    const pin = Studio.pinTag(detail?.pinned);
    if (pin) tags.push(pin);
    const stash = Studio.stashTag(stashState(detail));
    if (stash) tags.push(stash);
    const publish = Studio.publishTag(publishState(detail));
    if (publish) tags.push(publish);
    if (model?.retention)
      tags.push(
        h("span", {
          class: `tag${model.retention.warning ? " tag-warn" : ""}`,
          title: model.retention.warning ?? model.retention.summary ?? "",
          text: model.retention.warning
            ? "retention warning"
            : `retention ${model.retention.action ?? ""}`,
        }),
      );
    // A failed teardown keeps the verdict (unless failRun): say so up top.
    const teardownFailed = teardownRows(detail).filter(
      (row) => row.status === "failed",
    );
    if (teardownFailed.length)
      tags.push(
        h("span", {
          class: "tag tag-warn teardown-tag",
          title: teardownFailed
            .map(
              (row) => `${row.stepId ?? row.index}: ${row.error ?? "failed"}`,
            )
            .join("\n"),
          text: `teardown ${teardownFailed.length} failed`,
        }),
      );
    const dryRun = fixtureRows(detail).filter((row) =>
      Object.values(row.verbs ?? {}).some(
        (/** @type {any} */ verb) => verb.status === "dry-run",
      ),
    );
    if (dryRun.length)
      tags.push(
        h("span", {
          class: "tag tag-info",
          title: `mutating fixture verbs ran as dry-run on a shared environment: ${dryRun
            .map((row) => row.name)
            .join(", ")}`,
          text: `fixtures dry-run · ${dryRun.length}`,
        }),
      );
    if (detail?.run?.invocation?.id)
      tags.push(
        h("span", {
          class: "tag tag-info",
          title: `invocation ${detail.run.invocation.id}`,
          text: `spec ${detail.run.invocation.index ?? "?"}/${detail.run.invocation.total ?? "?"}`,
        }),
      );
    for (const [key, value] of Object.entries(detail?.run?.labels ?? {}))
      tags.push(h("span", { class: "tag", text: `${key}=${value}` }));
    if (!tags.length) return null;
    return h("div", { class: "badges run-badges" }, tags);
  }

  /**
   * The run's stash state: the receipt is the durable record, the
   * `artifact.stash` event the live one (and the only one for a failure).
   * The event fills fields the receipt does not carry (ttl, message).
   * @param {any} detail
   * @returns {Record<string, any> | null}
   */
  function stashState(detail) {
    const receipt = detail?.stashReceipt ?? null;
    const event = detail?.eventsModel?.stash ?? null;
    if (!receipt) return event;
    const sameStash = event?.ok && event.stashId === receipt.stashId;
    return { ...(sameStash ? event : {}), ...receipt, ok: true };
  }

  /**
   * The run's publish state: `publish-receipt.json`, else the last
   * `artifact.publish` event (a failure has no receipt).
   * @param {any} detail
   * @returns {Record<string, any> | null}
   */
  function publishState(detail) {
    return Studio.events.publishState(
      detail?.publishReceipt ?? null,
      detail?.eventsModel?.publish ?? null,
    );
  }

  /**
   * "Open in file.cheap" for a file.cheap URL; any other host is named, so a
   * hand-written or foreign receipt cannot pass for file.cheap.
   * @param {string} webUrl
   * @returns {string}
   */
  function openPublishedLabel(webUrl) {
    let host = "";
    try {
      host = new URL(webUrl).hostname.toLowerCase();
    } catch {
      return "Open published package";
    }
    return host === "file.cheap" || host.endsWith(".file.cheap")
      ? "Open in file.cheap"
      : `Open on ${host}`;
  }

  /**
   * "Publish to file.cheap", or a disabled "Publishing…" while this run's
   * upload is in flight.
   * @param {HTMLElement} root
   * @param {string} runRef
   * @param {any} detail
   */
  function publishButton(root, runRef, detail) {
    const key = Studio.runRefOf(detail) ?? runRef;
    const busy = publishing.has(key);
    return h("button", {
      class: "btn",
      type: "button",
      text: busy ? "Publishing…" : "Publish to file.cheap",
      disabled: busy,
      ariaBusy: busy ? "true" : null,
      dataset: { action: "publish" },
      title: busy
        ? "cairn publish is uploading this run — the result shows here when it answers"
        : "cairn publish: upload a sanitized private package (asks first)",
      onClick: () => void publishRun(root, runRef),
    });
  }

  /**
   * Stash, publish and pin, with every fact the CLI recorded, plus the
   * actions (open the published package, pin/unpin).
   * @param {any} detail
   * @param {HTMLElement} root
   * @param {string} runRef
   * @returns {HTMLElement}
   */
  function evidencePanel(detail, root, runRef) {
    const stash = stashState(detail);
    const publish = publishState(detail);
    const stashBadge = Studio.events.stashBadge(stash);
    const publishBadge = Studio.events.publishBadge(publish);
    const refused = detail.run?.status === "refused";
    return Studio.panel(
      "Evidence",
      [
        h(
          "div",
          { class: "evidence-block evidence-stash" },
          h(
            "div",
            { class: "toolbar" },
            h("strong", { text: "file.cheap stash" }),
            Studio.stashTag(stash) ??
              Studio.tag(refused ? "never stashed (refused)" : "not stashed"),
          ),
          stashBadge
            ? Studio.evidenceLines(stashBadge.lines)
            : h("p", {
                class: "cell-dim",
                text: refused
                  ? "Refused runs are never stashed."
                  : "No stash recorded for this run (cairn stash save <run>, or stash.autoStash in the config).",
              }),
        ),
        h(
          "div",
          { class: "evidence-block evidence-publish" },
          h(
            "div",
            { class: "toolbar" },
            h("strong", { text: "published package" }),
            Studio.publishTag(publish) ?? Studio.tag("not published"),
            // main opens the https URL it reads from the receipt itself;
            // an expired package is gone, so there is nothing to open
            detail.publishReceipt?.webUrl &&
              !Studio.events.publishExpired(detail.publishReceipt)
              ? h("button", {
                  class: "btn btn-sm",
                  type: "button",
                  // the label names the host the receipt points at
                  text: openPublishedLabel(detail.publishReceipt.webUrl),
                  dataset: { action: "open-published" },
                  title: detail.publishReceipt.webUrl,
                  onClick: () =>
                    void api
                      .call("run:open-published", Studio.runRefOf(detail))
                      .catch((error) =>
                        toast(
                          "Open failed",
                          String(error?.message ?? error),
                          "bad",
                        ),
                      ),
                })
              : null,
          ),
          publishBadge
            ? Studio.evidenceLines(publishBadge.lines)
            : h("p", {
                class: "cell-dim",
                text: "Publish to file.cheap uploads a sanitized private package with an expiry; the receipt lands in publish-receipt.json.",
              }),
        ),
        h(
          "div",
          { class: "evidence-block evidence-pin" },
          h(
            "div",
            { class: "toolbar" },
            h("strong", { text: "retention" }),
            Studio.pinTag(detail.pinned) ??
              Studio.tag(detail.restored ? "restored copy" : "not pinned"),
            !detail.restored
              ? h("button", {
                  class: "btn btn-sm btn-ghost",
                  type: "button",
                  text: detail.pinned ? "Unpin" : "Pin…",
                  onClick: () => void togglePin(root, runRef),
                })
              : null,
          ),
          h("p", {
            class: "cell-dim",
            text: detail.restored
              ? "This run was restored from a stash into a temp folder; retention does not apply."
              : detail.pinned
                ? `Retention keeps this run until it is unpinned${
                    detail.pinned.reason
                      ? ` (reason: ${detail.pinned.reason})`
                      : ""
                  }.`
                : "Retention may prune this run (keepRuns per spec). Pin it to keep its evidence.",
          }),
        ),
        sensitivityBlock(detail),
      ],
      { className: "evidence-panel" },
    );
  }

  /**
   * What leaves the machine: the manifest's files by `sensitivity`, and
   * the ones a default stash or any publication keeps local (sanitized
   * traces, secret-bearing files). Null for a run without a manifest.
   * @param {any} detail
   * @returns {HTMLElement | null}
   */
  function sensitivityBlock(detail) {
    const summary = Studio.events.sensitivitySummary(detail?.manifest);
    if (!summary) return null;
    const kept = [
      ...summary.sanitized.map((path) => `${path} (sanitized)`),
      ...summary.secretBearing.map((path) => `${path} (secret-bearing)`),
    ];
    return h(
      "div",
      { class: "evidence-block evidence-sensitivity" },
      h(
        "div",
        { class: "toolbar" },
        h("strong", { text: "what leaves the machine" }),
        summary.counts["secret-bearing"] > 0
          ? Studio.tag(
              `${summary.counts["secret-bearing"]} secret-bearing`,
              "warn",
            )
          : null,
        summary.counts.sanitized > 0
          ? Studio.tag(`${summary.counts.sanitized} sanitized`, "info")
          : null,
      ),
      Studio.evidenceLines([
        ...summary.lines,
        ...(kept.length
          ? [
              `never published: ${kept.slice(0, 8).join(", ")}${
                kept.length > 8 ? ` and ${kept.length - 8} more` : ""
              }`,
            ]
          : []),
      ]),
    );
  }

  /**
   * Pin (with an optional reason) or unpin the open run through the CLI,
   * then repaint from what the CLI wrote.
   * @param {HTMLElement} root
   * @param {string} runRef
   */
  async function togglePin(root, runRef) {
    const detail = state.runDetail;
    const target = Studio.runRefOf(detail) ?? runRef;
    try {
      let result;
      if (detail?.pinned) {
        result = await api.call("run:unpin", { runRef: target });
      } else {
        const reason = await Studio.promptText({
          title: "Pin this run?",
          body: "Retention never prunes a pinned run. A reason is optional (it is stored in run.json).",
          placeholder: "why keep it, e.g. evidence for a bug report",
          confirmLabel: "Pin",
          maxLength: 200,
        });
        if (reason === null) return;
        result = await api.call("run:pin", {
          runRef: target,
          reason: reason || null,
        });
      }
      if (!result?.ok)
        toast(
          detail?.pinned ? "Unpin failed" : "Pin failed",
          fmt.truncate(
            result?.payload?.error ||
              result?.stderr ||
              `exit ${result?.exitCode} (${result?.meaning})`,
            240,
          ),
          "bad",
        );
      else
        toast(
          result.pinned ? "Run pinned" : "Run unpinned",
          result.cli,
          "ok",
          2600,
        );
      await render(root, { runRef, tab: activeTab });
      void actions.loadRuns();
    } catch (error) {
      toast("Pin failed", String(error?.message ?? error), "bad");
    }
  }

  /**
   * Publish the open run: main asks in a native dialog (it uploads), runs
   * `cairn publish <runDir> --json`, and returns the receipt or the reason.
   * @param {HTMLElement} root
   * @param {string} runRef
   */
  async function publishRun(root, runRef) {
    const target = Studio.runRefOf(state.runDetail) ?? runRef;
    if (publishing.has(target)) return;
    /** This run's header is still on screen (the user did not move on). */
    const onScreen = () =>
      Studio.runRefOf(state.runDetail) === target
        ? root.querySelector('button[data-action="publish"]')
        : null;
    /** Repaint the button in place when this run is still on screen. */
    const paintButton = () =>
      onScreen()?.replaceWith(publishButton(root, runRef, state.runDetail));
    publishing.add(target);
    paintButton();
    try {
      toast("Publish to file.cheap", "confirm in the dialog", "info", 2400);
      const result = await api.call("run:publish", target);
      if (result?.cancelled) {
        publishing.delete(target);
        paintButton();
        return;
      }
      if (result?.published) {
        toast(
          "Published to file.cheap",
          [
            result.receipt?.artifactRef,
            result.receipt?.expiresAt
              ? `expires ${fmt.formatTimestamp(result.receipt.expiresAt)}`
              : null,
            result.receipt?.runIndexSkipped
              ? `not listed in the console (${result.receipt.runIndexSkipped})`
              : null,
          ]
            .filter(Boolean)
            .join(" · "),
          "ok",
          6000,
        );
      } else {
        const reason = result?.error?.reason ?? null;
        toast(
          reason ? `Publish failed · ${reason}` : "Publish failed",
          fmt.truncate(
            [
              reason ? Studio.events.PUBLISH_REASONS[reason] : null,
              result?.error?.message,
              !reason && !result?.error?.message
                ? result?.stderr ||
                  `exit ${result?.exitCode} (${result?.meaning})`
                : null,
            ]
              .filter(Boolean)
              .join(" — "),
            300,
          ),
          "bad",
          9000,
        );
      }
      publishing.delete(target);
      // Only when the user is still on this run: never pull them back.
      if (onScreen()) await render(root, { runRef, tab: "overview" });
    } catch (error) {
      publishing.delete(target);
      paintButton();
      toast("Publish failed", String(error?.message ?? error), "bad");
    }
  }

  /**
   * @param {HTMLElement} hostEl
   * @param {string} spec
   * @param {string} runId
   */
  async function loadHistory(hostEl, spec, runId) {
    try {
      const entries = await api.call("runs:history", { spec, limit: 20 });
      if (!entries?.length) return;
      hostEl.appendChild(
        Studio.historyStrip(entries, runId, (target) =>
          Studio.navigate("run", { runRef: target }),
        ),
      );
    } catch {
      // history is a nicety
    }
  }

  /**
   * Output for a precondition/hook/outcome: the log file when the runner
   * wrote one, else the tail the event carried. Hook logs live in the run's
   * invocation journal (`source: "invocation"`), not the run folder.
   * @param {any} detail
   * @param {string | null} logPath
   * @param {string | null} tail
   * @param {string} label
   * @param {string | null} [source]
   */
  function outputBlock(detail, logPath, tail, label, source = null) {
    const journal = source === "invocation";
    const exists =
      logPath &&
      (journal ? (detail.journal?.logs ?? []) : (detail.logs ?? [])).some(
        (/** @type {{ path: string }} */ entry) => entry.path === logPath,
      );
    if (exists) {
      const holder = h("div", Studio.loading(`reading ${logPath}…`));
      void Studio.artifactViewer(detail.runDir, logPath, {
        maxBytes: 400_000,
        journal,
      }).then((node) => {
        Studio.clear(holder);
        holder.appendChild(node);
      });
      return holder;
    }
    if (!tail)
      return h("p", { class: "cell-dim", text: `no ${label} captured` });
    return h(
      "div",
      h("div", {
        class: "cell-dim",
        text: `${label} (tail from events.ndjson)`,
      }),
      Studio.codeBlock(tail, { tight: true }),
    );
  }

  /**
   * Buttons that open run files in a shared viewer.
   * @param {any} detail
   * @param {Array<{ path: string, bytes: number | null }>} files
   * @param {HTMLElement} viewer
   */
  function fileButtons(detail, files, viewer) {
    return h(
      "div",
      { class: "toolbar file-buttons" },
      files.map((file) =>
        h("button", {
          class: "btn btn-sm btn-ghost mono",
          type: "button",
          text: `${file.path}${
            file.bytes ? ` · ${fmt.formatBytes(file.bytes)}` : ""
          }`,
          onClick: async () => {
            Studio.clear(viewer);
            viewer.appendChild(Studio.loading());
            const node = await Studio.artifactViewer(detail.runDir, file.path, {
              maxBytes: 400_000,
            });
            Studio.clear(viewer);
            viewer.appendChild(node);
          },
        }),
      ),
    );
  }

  /**
   * The failure-first panel: what failed, where the page was, what the
   * verifier saw, and the output of whatever phase broke.
   * @param {any} detail
   */
  function renderFailure(detail) {
    const failure = detail.failure;
    if (!failure) return Studio.empty("Nothing failed", "This run passed.");
    const nodes = [];
    nodes.push(
      h(
        "div",
        { class: "error-box", style: { marginBottom: "14px" } },
        h("strong", {
          text: `${failure.status}: ${failure.summary ?? failure.message ?? "no summary"}`,
        }),
        failure.phase
          ? h("div", {
              class: "mono",
              style: { fontSize: "11px", marginTop: "4px" },
              text: `phase: ${failure.phase}${
                failure.name ? ` · ${failure.name}` : ""
              }${failure.timedOut ? " · timed out" : ""}`,
            })
          : null,
        failure.message && failure.message !== failure.summary
          ? h("pre", { text: failure.message })
          : null,
      ),
    );

    if (failure.step) {
      const step = failure.step;
      const shotHost = h("div", { class: "failure-shot" });
      const shot = step.screenshot ?? failure.lastScreenshot;
      if (shot) {
        shotHost.appendChild(Studio.loading("loading screenshot…"));
        void Studio.artifactViewer(detail.runDir, shot).then((node) => {
          Studio.clear(shotHost);
          if (!step.screenshot)
            shotHost.appendChild(
              h("div", {
                class: "cell-dim",
                text: "latest screenshot before the failure",
              }),
            );
          shotHost.appendChild(node);
        });
      } else
        shotHost.appendChild(
          h("p", { class: "cell-dim", text: "no screenshot for this step" }),
        );
      const diag = failure.diagnostics;
      nodes.push(
        Studio.panel(
          `Failing step${step.index ? ` ${step.index}` : ""} · ${step.id}`,
          h(
            "div",
            { class: "failure-grid" },
            h(
              "div",
              Studio.keyValue([
                ["kind", step.kind ?? "—"],
                ["label", step.label ?? "—"],
                ["duration", fmt.formatDuration(step.durationMs)],
                ["url", step.url ?? diag?.url ?? "—"],
                ...(diag?.title ? [["title", diag.title]] : []),
                ...(diag?.readyState ? [["readyState", diag.readyState]] : []),
              ]),
              step.error
                ? h("div", {
                    class: "step-error",
                    style: { marginTop: "8px" },
                    text: step.error,
                  })
                : null,
              diag ? diagnosticsSummary(diag) : null,
              step.diagnosticsPath
                ? h("button", {
                    class: "btn btn-sm btn-ghost",
                    type: "button",
                    style: { marginTop: "8px" },
                    text: `open ${step.diagnosticsPath}`,
                    onClick: () => {
                      void Studio.artifactViewer(
                        detail.runDir,
                        step.diagnosticsPath,
                      ).then((node) => {
                        const viewer =
                          document.getElementById("failure-viewer");
                        if (!viewer) return;
                        Studio.clear(viewer);
                        viewer.appendChild(node);
                      });
                    },
                  })
                : null,
            ),
            shotHost,
          ),
          { className: "failure-panel" },
        ),
      );
    }

    if (failure.expect)
      nodes.push(
        Studio.panel(
          `Expect · ${failure.expect.id ?? failure.expect.stepId ?? "?"}`,
          expectBlock(failure.expect),
          { className: "failure-panel failure-expect" },
        ),
      );

    for (const outcome of failure.outcomes ?? []) {
      nodes.push(
        Studio.panel(
          `Outcome · ${outcome.id}`,
          h(
            "div",
            outcome.expected
              ? h(
                  "div",
                  h(
                    "div",
                    { class: "section-title", style: { marginTop: "0" } },
                    "Expected",
                  ),
                  Studio.codeBlock(outcome.expected, { tight: true }),
                )
              : null,
            outcome.actual
              ? h(
                  "div",
                  h("div", { class: "section-title" }, "Actual"),
                  Studio.codeBlock(outcome.actual, { tight: true }),
                )
              : null,
            !outcome.expected && !outcome.actual
              ? h("p", {
                  class: "cell-dim",
                  text: "no expected/actual recorded — see the evidence file",
                })
              : null,
            outcome.logPath
              ? outputBlock(detail, outcome.logPath, null, "verifier output")
              : null,
            outcome.evidence
              ? h("button", {
                  class: "btn btn-sm btn-ghost",
                  type: "button",
                  style: { marginTop: "8px" },
                  text: `open ${outcome.evidence}`,
                  onClick: () =>
                    Studio.navigate("run", {
                      runRef: Studio.runRefOf(detail) ?? state.selectedRun,
                      tab: "outcomes",
                    }),
                })
              : null,
          ),
          { className: "failure-panel" },
        ),
      );
    }

    if (failure.gate) {
      const gate = failure.gate;
      nodes.push(
        Studio.panel(
          `Gate · ${gate.name}`,
          gateCard({
            ...gate,
            stable: null,
            everyMs: null,
            attemptsDropped: 0,
          }),
          { className: "failure-panel failure-gate" },
        ),
      );
    }

    if (failure.precondition) {
      const pre = failure.precondition;
      nodes.push(
        Studio.panel(
          `Precondition · ${pre.name}`,
          h(
            "div",
            h("div", {
              class: "cell-dim",
              text: `${
                pre.timedOut ? "timed out" : `exit ${pre.exitCode ?? "?"}`
              } · ${fmt.formatDuration(pre.durationMs)}`,
            }),
            outputBlock(detail, pre.logPath, pre.outputTail, "output"),
          ),
          { className: "failure-panel" },
        ),
      );
    }

    for (const hook of failure.hooks ?? []) {
      nodes.push(
        Studio.panel(
          `${hook.hook} hook #${hook.index ?? "?"}`,
          h(
            "div",
            hook.command
              ? Studio.codeBlock(hook.command, { tight: true })
              : null,
            h("div", {
              class: "cell-dim",
              text: `${
                hook.timedOut ? "timed out" : `exit ${hook.exitCode ?? "?"}`
              } · ${fmt.formatDuration(hook.durationMs)}`,
            }),
            outputBlock(
              detail,
              hook.logPath,
              hook.outputTail,
              "output",
              hook.logSource,
            ),
          ),
          { className: "failure-panel" },
        ),
      );
    }

    if ((failure.teardown ?? []).length)
      nodes.push(
        Studio.panel(
          `Teardown · ${failure.teardown.length} failed`,
          h(
            "div",
            failure.teardown.map((/** @type {any} */ row) =>
              teardownRowView({ ...row, status: "failed" }),
            ),
            h("p", {
              class: "cell-dim",
              text:
                failure.phase === "teardown"
                  ? "The spec sets teardown.failRun: true, so this failed teardown errored a run that had passed."
                  : "A failed teardown keeps the run's verdict; the failure above is the app's.",
            }),
          ),
          { className: "failure-panel failure-teardown" },
        ),
      );

    if ((failure.servicesLogs ?? []).length) {
      const viewer = h("div", { style: { marginTop: "10px" } });
      nodes.push(
        Studio.panel(
          "Services evidence",
          h(
            "div",
            fileButtons(
              detail,
              failure.servicesLogs.map((entry) => ({
                path: entry,
                bytes: null,
              })),
              viewer,
            ),
            viewer,
          ),
          { className: "failure-panel" },
        ),
      );
    }
    nodes.push(
      h("div", { id: "failure-viewer", style: { marginTop: "12px" } }),
    );
    return h("div", { class: "failure-first" }, nodes);
  }

  /**
   * What the page offered when the step failed.
   * @param {any} diag
   */
  function diagnosticsSummary(diag) {
    const list = (
      /** @type {string} */ label,
      /** @type {string[]} */ items,
    ) =>
      items?.length
        ? h(
            "div",
            { class: "diag-list" },
            h("span", { class: "cell-dim", text: `${label}: ` }),
            items.map((item) =>
              h("span", { class: "tag", text: fmt.truncate(item, 60) }),
            ),
          )
        : null;
    return h(
      "div",
      { class: "diag-summary" },
      diag.diagnosticsError
        ? h("div", {
            class: "cell-dim",
            text: `diagnostics: ${diag.diagnosticsError}`,
          })
        : null,
      diag.selectorCount !== null && diag.selectorCount !== undefined
        ? h("div", {
            class: "cell-dim",
            text: `selector matches: ${diag.selectorCount}`,
          })
        : null,
      list("visible buttons", diag.buttons),
      list("links", diag.links),
      list("inputs", diag.inputs),
      (diag.excerpts ?? []).length
        ? h(
            "div",
            { class: "diag-list" },
            diag.excerpts.map((entry) =>
              h("div", {
                class: entry.found ? "cell-dim" : "step-error",
                text: `"${entry.needle}" ${
                  entry.found ? `found: …${entry.excerpt}…` : "not on the page"
                }`,
              }),
            ),
          )
        : null,
    );
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
            entry.sensitivity === "sanitized" ||
              entry.sensitivity === "secret-bearing"
              ? Studio.sensitivityTag(entry.sensitivity)
              : null,
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
    try {
      await actions.startRun([specPath]);
      Studio.navigate("live");
    } catch (error) {
      // e.g. a suite lock is held, or the launch template is invalid
      toast("Run failed to start", String(error?.message ?? error), "bad");
    }
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
