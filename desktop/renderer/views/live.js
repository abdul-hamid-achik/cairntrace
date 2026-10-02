/**
 * Live view — watch runs happen.
 *
 * Cards for runs started from this app and for runs detected in the artifact
 * root (a terminal `cairn run`, an agent), grouped by invocation when the
 * runner stamps one ("spec 3/7", planned list, ETA from local history).
 *
 * The view never rebuilds itself on a push. Each card is a controller that
 * owns its DOM; pushes only mark model sections dirty (state.js), and one
 * batched repaint per animation frame updates just those sections: new step
 * rows are appended, changed rows patched, log panes appended into a
 * windowed list. Scroll positions survive because nothing is re-created;
 * panes auto-follow while scrolled to the bottom and offer "jump to latest"
 * once the user scrolls up.
 *
 * Per card: a phase banner (`phase.changed` / `run.heartbeat`, or the open
 * row on older runners), `i/N kind label` step rows with the error inline,
 * outcome "verifying…" rows with progress, the latest screenshot, output
 * tails for every log the runner announced (`log.opened`, tailed through the
 * offset reader), the event stream, and stash/retention badges.
 */
(function bootLiveView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, actions, fmt } = Studio;
  // Streaming panes are shared with the Invocations view (renderer/panes.js).
  const {
    MAX_PANE_LINES,
    isNearBottom,
    splitChunk,
    line,
    eventLine,
    logLine,
    createOutputPanel,
    pollFileSource,
  } = Studio.panes;

  /** Keep polling a finished card's log tails this long. */
  const TAIL_SETTLE_MS = 12_000;

  /** @type {HTMLElement | null} */
  let host = null;
  /** @type {HTMLElement | null} */
  let viewRoot = null;
  /** @type {Map<string, any>} card/group key → controller */
  const controllers = new Map();
  /** @type {number | null} */
  let frame = null;
  /**
   * Which scheduler produced `frame`: rAF ids and timer ids come from
   * separate counters, so cancelling with the wrong API could clear an
   * unrelated timer (app.js's lock poll) that happens to share the number.
   * @type {"raf" | "timeout" | null}
   */
  let frameKind = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let ticker = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let tailTimer = null;

  // ── pure layout (unit-tested) ────────────────────────────────────────────

  /**
   * Group live records by invocation. App records join an invocation by the
   * id their run.started carried, or — before the run directory exists — by
   * the invocation journal's pid matching the spawned child's.
   * @param {{ live: Array<Record<string, any>>, detected: Array<Record<string, any>>, invocations: Array<Record<string, any>> }} input
   * @returns {Array<{ type: "invocation", id: string, app: string[], detected: string[] } | { type: "app", keys: string[] } | { type: "detected", keys: string[] }>}
   */
  function computeLiveLayout(input) {
    const journals = new Map(
      (input.invocations ?? []).map((record) => [record.invocationId, record]),
    );
    /** @type {Map<string, { app: Array<[number, string]>, detected: Array<[number, string]> }>} */
    const groups = new Map();
    const ensure = (/** @type {string} */ id) => {
      let entry = groups.get(id);
      if (!entry) {
        entry = { app: [], detected: [] };
        groups.set(id, entry);
      }
      return entry;
    };
    const ungroupedApp = [];
    const ungroupedDetected = [];
    for (const record of input.live ?? []) {
      let id = record.invocation?.id ?? null;
      if (!id && record.pid) {
        for (const journal of journals.values())
          if (journal.journal?.pid && journal.journal.pid === record.pid) {
            id = journal.invocationId;
            break;
          }
      }
      if (id)
        ensure(id).app.push([record.invocation?.index ?? 0, record.token]);
      else ungroupedApp.push(record.token);
    }
    for (const record of input.detected ?? []) {
      const id = record.invocation?.id ?? null;
      if (id)
        ensure(id).detected.push([record.invocation?.index ?? 0, record.runId]);
      else ungroupedDetected.push(record.runId);
    }
    // A running journal with no run yet (services, before hooks) still shows.
    for (const journal of journals.values())
      if (journal.journal?.alive) ensure(journal.invocationId);

    /** @type {Array<any>} */
    const out = [];
    for (const id of [...groups.keys()].toSorted((a, b) =>
      b.localeCompare(a),
    )) {
      const entry = /** @type {any} */ (groups.get(id));
      out.push({
        type: "invocation",
        id,
        app: entry.app.toSorted(byIndex).map((pair) => pair[1]),
        detected: entry.detected.toSorted(byIndex).map((pair) => pair[1]),
      });
    }
    if (ungroupedApp.length)
      out.push({ type: "app", keys: ungroupedApp.toReversed() });
    if (ungroupedDetected.length)
      out.push({ type: "detected", keys: ungroupedDetected.toReversed() });
    return out;
  }

  /**
   * Order `[index, key]` pairs by invocation index.
   * @param {[number, string]} a
   * @param {[number, string]} b
   */
  function byIndex(a, b) {
    return a[0] - b[0];
  }

  /**
   * @param {string | null | undefined} iso
   * @returns {number | null}
   */
  function ms(iso) {
    const value = iso ? Date.parse(iso) : NaN;
    return Number.isFinite(value) ? value : null;
  }

  /**
   * Why a refused run was refused: the run.refused event, else run.json's
   * refusal (watcher finish / the app run's JSON document).
   * @param {Record<string, any>} record
   */
  function refusalOf(record) {
    return (
      CairnPolicy.normalizeRefusal(record.model.refusal) ??
      record.done?.refusal ??
      CairnPolicy.documentRefusal(record.done?.payload) ??
      null
    );
  }

  // ── run card ─────────────────────────────────────────────────────────────

  /**
   * Signature of a step row: repaint only when one of these changed.
   * @param {Record<string, any>} row
   */
  function stepSig(row) {
    return `${row.status}|${row.durationMs}|${row.error ?? ""}|${row.kind ?? ""}|${row.label ?? ""}|${row.total ?? ""}|${row.expect?.status ?? ""}`;
  }

  /**
   * An expect step's verdict under its step row: what was asserted and,
   * when it failed, what the page said instead.
   * @param {Record<string, any>} expect
   */
  function expectLine(expect) {
    const passed = expect.status === "passed";
    return h(
      "div",
      {
        class: `expect-live expect-${passed ? "passed" : "failed"}${
          passed ? "" : " step-error inline-error"
        }`,
      },
      `expect ${expect.expectId}${expect.kind ? ` (${expect.kind})` : ""}: `,
      passed
        ? `${expect.actual ?? "ok"}`
        : `expected ${expect.expected ?? "?"}; got ${expect.actual ?? "?"}`,
      expect.attempts && expect.attempts > 1
        ? h("span", {
            class: "cell-dim",
            text: ` · ${expect.attempts} attempts`,
          })
        : null,
    );
  }

  /**
   * A verifier's latest progress line; a poll's `attempt N/~M: …` leads
   * with its position.
   * @param {string} message
   */
  function progressLine(message) {
    const parsed = Studio.events.parseAttemptProgress(message);
    if (!parsed) return h("div", { class: "outcome-progress", text: message });
    return h(
      "div",
      { class: "outcome-progress", title: message },
      h("span", {
        class: "tag tag-info attempt-pos",
        text: `attempt ${parsed.attempt}${parsed.of ? `/${parsed.of}` : ""}`,
      }),
      ` ${parsed.text}`,
    );
  }

  /**
   * @param {"app" | "detected"} kind
   * @param {string} key token or run id
   */
  function createRunCard(kind, key) {
    const getRecord = () =>
      kind === "app" ? state.live.get(key) : state.detected.get(key);
    const dot = h("span", { class: "dot dot-running" });
    const title = h("span", { class: "mono card-title" });
    const statusTag = Studio.tag("running", "info");
    const positionTag = h("span", { class: "tag hidden" });
    const livenessTag = h("span", { class: "tag hidden" });
    const badges = h("span", { class: "badges" });
    const elapsed = h("span", { class: "elapsed" });
    const activity = h("span", { class: "cell-dim activity" });
    const originSlot = h("span", { class: "origin-slot" });
    const actionsBox = h("div", { class: "card-actions" });
    // The banner always holds its line (idle text when there is no phase),
    // so a phase appearing or ending never shifts the card.
    const banner = h("div", { class: "phase-banner idle" });
    Studio.paintPhaseBanner(banner, null, "waiting for the first event…");
    const note = h("div", { class: "cell-dim card-note" });
    const failureBox = h("div", { class: "error-box hidden" });
    // A refused run is not a failure: its own (violet, dashed) box.
    const refusalSlot = h("div", { class: "refusal-slot hidden" });

    const prePanel = h("div", { class: "timeline" });
    const preTitle = h(
      "div",
      { class: "section-title" },
      "Preconditions & hooks",
    );
    const preSection = h(
      "div",
      { class: "hidden" },
      preTitle,
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-body tight" }, prePanel),
      ),
    );
    // F3b fixtures (fixture.* verbs) and F3a teardown items (teardown.*)
    const fixturesList = h("div", { class: "timeline fixtures-live" });
    const fixturesSection = h(
      "div",
      { class: "hidden" },
      h("div", { class: "section-title" }, "Fixtures"),
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-body tight" }, fixturesList),
      ),
    );
    const teardownTitle = h("div", { class: "section-title" }, "Teardown");
    const teardownList = h("div", { class: "timeline teardown-live" });
    const teardownSection = h(
      "div",
      { class: "hidden" },
      teardownTitle,
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-body tight" }, teardownList),
      ),
    );
    const stepsTitle = h(
      "div",
      { class: "section-title", style: { marginTop: "0" } },
      "Steps",
    );
    const stepsList = h("div", { class: "timeline steps-list" });
    const outcomesTitle = h("div", { class: "section-title" }, "Outcomes");
    const outcomesList = h("div", { class: "timeline" });
    const outcomesSection = h(
      "div",
      { class: "hidden" },
      outcomesTitle,
      h(
        "div",
        { class: "panel" },
        h("div", { class: "panel-body tight" }, outcomesList),
      ),
    );

    const shotImg = /** @type {HTMLImageElement} */ (
      h("img", { alt: "latest screenshot", class: "hidden" })
    );
    const shotEmpty = h("div", {
      class: "shot-empty",
      text: "no screenshot yet",
    });
    const shotCaption = h("figcaption", { text: "latest screenshot" });
    // A fixed-ratio frame from the start: the first screenshot, and every
    // later one whatever its size, lands without moving the output panes.
    const shotFigure = h(
      "figure",
      { class: "shot live-shot" },
      h("div", { class: "shot-frame" }, shotEmpty, shotImg),
      shotCaption,
    );

    const output = createOutputPanel();
    const eventsSource = output.addSource("events", "events");
    const cairnLogSource =
      kind === "app" ? output.addSource("cairn-log", "cairn log") : null;
    if (cairnLogSource) output.select("cairn-log");

    const commandLine = h("pre", { class: "code tight" });
    const commandDetails =
      kind === "app"
        ? h(
            "details",
            { class: "command-line" },
            h("summary", { class: "cell-dim", text: "command line" }),
            commandLine,
          )
        : null;

    const root = h(
      "section",
      { class: "panel live-card", dataset: { key: `${kind}:${key}` } },
      h(
        "div",
        { class: "panel-head" },
        dot,
        title,
        statusTag,
        positionTag,
        livenessTag,
        originSlot,
        badges,
        elapsed,
        activity,
        actionsBox,
      ),
      banner,
      h(
        "div",
        { class: "panel-body" },
        note,
        failureBox,
        refusalSlot,
        h(
          "div",
          { class: "live-grid" },
          h(
            "div",
            preSection,
            fixturesSection,
            stepsTitle,
            h(
              "div",
              { class: "panel" },
              h("div", { class: "panel-body tight steps-scroll" }, stepsList),
            ),
            outcomesSection,
            teardownSection,
          ),
          h("div", shotFigure, output.el),
        ),
        commandDetails,
      ),
    );

    /** @type {Map<string, { el: HTMLElement, sig: string }>} */
    const stepRows = new Map();
    /** @type {Map<string, { el: HTMLElement, sig: string }>} */
    const outcomeRows = new Map();
    let renderedEvents = 0;
    let renderedLogs = 0;
    let shotPath = null;
    let shotLoading = false;
    let lastActionsSig = "";

    function statusOf(record) {
      if (kind === "app") {
        const done = record.done;
        if (done) {
          if (record.model.status !== "running") return record.model.status;
          // before ok: a batch whose every spec was refused exits 0
          if (CairnPolicy.isRefusedOutcome(done.exitCode, done.payload))
            return "refused";
          return done.ok
            ? "passed"
            : done.exitCode === 1
              ? "failed"
              : "errored";
        }
        return record.model.terminal ? record.model.status : "running";
      }
      if (record.done) return record.done.status;
      if (record.model.terminal) return record.model.status;
      const live = record.liveness?.state;
      if (live === "dead") return "dead";
      if (record.stale) return "stale";
      return "running";
    }

    function startedMs(record) {
      if (kind === "app") return record.startedAt;
      return record.startedAtMs ?? ms(record.model.startedAt);
    }

    /**
     * What the banner says when no phase is open.
     * @param {Record<string, any>} record
     */
    function idleText(record) {
      const status = statusOf(record);
      if (record.done || record.model.terminal) return `finished · ${status}`;
      if (status === "dead") return "process gone — no further events";
      if (status === "stale") return "no longer detected";
      return record.model.eventCount
        ? "between phases…"
        : "waiting for the first event…";
    }

    /**
     * The owning invocation's journal, when the watcher reported it.
     * @param {Record<string, any>} record
     */
    function journalOf(record) {
      const id = (record.invocation ?? record.model.invocation)?.id;
      return id ? (state.invocations.get(id)?.journal ?? null) : null;
    }

    function paintStatus(record) {
      const status = statusOf(record);
      const running = status === "running";
      const tone =
        status === "dead" || status === "stale"
          ? "warn"
          : fmt.statusTone(status);
      dot.className = `dot dot-${running ? "running" : tone}`;
      statusTag.textContent = status;
      statusTag.className = `tag${
        running ? " tag-info" : tone && tone !== "muted" ? ` tag-${tone}` : ""
      }`;
      const spec =
        kind === "app"
          ? (record.specs ?? [])
              .map((entry) => entry.split("/").pop())
              .join(", ")
          : (record.model.spec ?? record.spec);
      title.textContent = `${spec || key}${
        record.runId ? ` · ${String(record.runId).slice(0, 24)}` : ""
      }`;
      title.title = record.runDir ?? "";
      const inv = record.invocation ?? record.model.invocation;
      const originSig =
        kind === "app" ? "app" : (journalOf(record)?.origin ?? "");
      if (originSlot.dataset.sig !== originSig) {
        originSlot.dataset.sig = originSig;
        Studio.clear(originSlot);
        const badge = Studio.originBadge(journalOf(record), {
          fromApp: kind === "app",
        });
        if (badge) originSlot.appendChild(badge);
      }
      if (inv?.index) {
        positionTag.textContent = `spec ${inv.index}${
          inv.total ? `/${inv.total}` : ""
        }`;
        positionTag.className = "tag tag-info";
      } else positionTag.className = "tag hidden";
      // The liveness signal, only where it adds to the status tag: a fresh
      // heartbeat, a quiet-but-alive process, or an mtime-only guess.
      const live = kind === "detected" && !record.done ? record.liveness : null;
      statusTag.title = live?.reason ?? "";
      const signal = !live
        ? null
        : live.state === "running"
          ? live.reason === "heartbeat"
            ? ["heartbeat", ""]
            : live.reason === "recent writes"
              ? ["no heartbeat · recent writes", ""]
              : ["pid alive", ""]
          : live.state === "quiet"
            ? ["quiet · pid alive", "tag-warn"]
            : null;
      if (signal) {
        livenessTag.textContent = signal[0];
        livenessTag.title = live?.reason ?? "";
        livenessTag.className = `tag ${signal[1]}`.trim();
      } else livenessTag.className = "tag hidden";

      // note line
      if (kind === "app") {
        const done = record.done;
        note.textContent = done
          ? `finished · exit ${done.exitCode ?? "—"} · ${done.meaning ?? ""}${
              record.launcher === "template" ? " · via launch template" : ""
            }`
          : record.runDir
            ? `tailing ${record.runDir}${
                record.pid ? ` · pid ${record.pid}` : ""
              }`
            : `waiting for the run directory to appear…${
                record.pid ? ` · pid ${record.pid}` : ""
              }`;
      } else {
        note.textContent = record.done
          ? `finished · ${record.done.status}${
              record.done.summary
                ? ` · ${fmt.oneLine(record.done.summary)}`
                : ""
            }`
          : record.liveness?.state === "dead"
            ? `process gone — ${record.liveness.reason} (a crashed run leaves no run.json)`
            : record.stale
              ? "no longer detected — quiet for a while, deleted, or its process died"
              : "started outside Studio (terminal or agent) — streaming the run's events.ndjson";
      }

      // A refusal (exit 7 / run.refused / run.json refusal) gets its own box.
      const refused = status === "refused";
      const refusal = refused ? refusalOf(record) : null;
      const refusalSig = refused ? JSON.stringify(refusal) : "";
      if (refusalSlot.dataset.sig !== refusalSig) {
        refusalSlot.dataset.sig = refusalSig;
        Studio.clear(refusalSlot);
        if (refused)
          refusalSlot.appendChild(
            Studio.refusalBox(refusal, {
              summary: record.done?.summary ?? record.done?.payload?.summary,
            }),
          );
        refusalSlot.classList.toggle("hidden", !refused);
      }

      // failure summary
      const failure = refused
        ? null
        : kind === "app"
          ? record.done && !record.done.ok
            ? (record.done.payload?.failure?.message ??
              record.done.payload?.summary ??
              record.done.error ??
              null)
            : null
          : record.done && !record.done.ok
            ? record.done.summary
            : null;
      if (failure) {
        Studio.clear(failureBox);
        failureBox.appendChild(h("strong", { text: "failure" }));
        failureBox.appendChild(h("pre", { text: String(failure) }));
        failureBox.classList.remove("hidden");
      } else failureBox.classList.add("hidden");

      paintActions(record, status);
      if (commandDetails)
        commandLine.textContent = `${record.command} ${(record.argv ?? []).join(" ")}`;
    }

    function paintActions(record, status) {
      const done = kind === "app" ? Boolean(record.done) : Boolean(record.done);
      const sig = `${done}|${record.runId ?? ""}|${record.runDir ?? ""}|${status}`;
      if (sig === lastActionsSig) return;
      lastActionsSig = sig;
      Studio.clear(actionsBox);
      // A refused run has no run directory: nothing to open.
      if (done && record.runId && status !== "refused")
        actionsBox.appendChild(
          h("button", {
            class: "btn btn-sm",
            type: "button",
            text: "Open evidence",
            onClick: () =>
              Studio.navigate("run", { runRef: record.runId, from: "live" }),
          }),
        );
      if (kind === "app") {
        if (done)
          actionsBox.appendChild(
            h("button", {
              class: "btn btn-sm btn-ghost",
              type: "button",
              text: "Re-run",
              // with the overrides it was started with (the Specs view's
              // "run on" environment, headed, cold start)
              onClick: () =>
                void actions
                  .startRun(record.specs, record.overrides ?? undefined)
                  .catch((error) =>
                    Studio.toast(
                      "Run failed to start",
                      String(error?.message ?? error),
                      "bad",
                    ),
                  ),
            }),
          );
        else
          actionsBox.appendChild(
            h("button", {
              class: "btn btn-sm btn-danger",
              type: "button",
              text: "Cancel",
              onClick: () => void actions.cancelRun(record.token),
            }),
          );
      } else {
        if (record.runDir)
          actionsBox.appendChild(
            h("button", {
              class: "btn btn-sm btn-ghost",
              type: "button",
              text: "Reveal",
              onClick: () =>
                void Studio.api
                  .call("fs:reveal", record.runDir)
                  .catch(() => {}),
            }),
          );
        actionsBox.appendChild(
          h("button", {
            class: "btn btn-sm btn-ghost",
            type: "button",
            text: "Hide",
            onClick: () => {
              Studio.hideDetected(record.runId);
              schedule();
            },
          }),
        );
      }
    }

    function paintBadges(record) {
      Studio.clear(badges);
      const stash = Studio.stashTag(record.model.stash);
      if (stash) badges.appendChild(stash);
      const publish = Studio.publishTag(record.model.publish);
      if (publish) badges.appendChild(publish);
      const retention = record.model.retention;
      if (retention)
        badges.appendChild(
          h("span", {
            class: `tag${retention.warning ? " tag-warn" : ""}`,
            title: retention.warning ?? retention.summary ?? "",
            text: retention.warning
              ? "retention warning"
              : `retention ${retention.action ?? ""}`.trim(),
          }),
        );
    }

    function paintSteps(record) {
      const model = record.model;
      const total = model.stepTotal;
      const done = model.steps.filter((row) => row.status !== "running").length;
      stepsTitle.textContent = `Steps (${
        total ? `${done}/${total}` : model.steps.length
      })`;
      const pinned = isNearBottom(stepsList.parentElement ?? stepsList);
      for (const row of model.steps) {
        const sig = stepSig(row);
        let entry = stepRows.get(row.stepId);
        if (entry && entry.sig === sig) continue;
        const what = Studio.events.stepWhat(row.kind, row.label);
        const el = h(
          "div",
          { class: `timeline-row step-live step-${row.status}` },
          h("span", {
            class: `dot dot-${
              row.status === "running" ? "running" : fmt.statusTone(row.status)
            }`,
          }),
          h(
            "span",
            { class: "label", title: row.stepId },
            h("span", {
              class: "step-pos",
              text: `${row.index}${row.total ? `/${row.total}` : ""}`,
            }),
            ` ${what || row.stepId}`,
            what
              ? h("span", { class: "cell-dim", text: ` · ${row.stepId}` })
              : null,
            row.when
              ? h("span", { class: "cell-dim", text: ` · when ${row.when}` })
              : null,
          ),
          h("span", {
            class: "ts",
            text:
              row.status === "running"
                ? "…"
                : row.status === "skipped"
                  ? "skipped"
                  : fmt.formatDuration(row.durationMs),
          }),
          row.expect ? expectLine(row.expect) : null,
          row.error && !(row.expect && row.expect.status === "failed")
            ? h("div", {
                class: `step-error inline-error${
                  row.kind === "run" ? " run-output" : ""
                }`,
                text: fmt.truncate(row.error, row.kind === "run" ? 1200 : 600),
              })
            : null,
        );
        if (entry) entry.el.replaceWith(el);
        else stepsList.appendChild(el);
        stepRows.set(row.stepId, { el, sig });
      }
      if (!model.steps.length && !stepsList.childElementCount)
        stepsList.appendChild(
          h(
            "div",
            { class: "timeline-row empty-row" },
            h("span", { class: "dot" }),
            h("span", { class: "label cell-dim", text: "no steps yet" }),
          ),
        );
      else if (model.steps.length)
        stepsList.querySelector(".empty-row")?.remove();
      const scroller = stepsList.parentElement;
      if (pinned && scroller) scroller.scrollTop = scroller.scrollHeight;
    }

    function paintOutcomes(record) {
      const model = record.model;
      outcomesSection.classList.toggle("hidden", model.outcomes.length === 0);
      outcomesTitle.textContent = `Outcomes (${model.outcomes.filter((row) => row.status === "passed").length}/${model.outcomes.length} passed)`;
      for (const row of model.outcomes) {
        const sig = `${row.status}|${row.progress.length}|${row.attempts ?? ""}`;
        const entry = outcomeRows.get(row.outcomeId);
        if (entry && entry.sig === sig) continue;
        const verifying = row.status === "verifying";
        const el = h(
          "div",
          { class: `timeline-row outcome-live` },
          h("span", {
            class: `dot dot-${
              verifying ? "running" : fmt.statusTone(row.status)
            }`,
          }),
          h(
            "span",
            { class: "label" },
            `${row.outcomeId}${row.kind ? ` (${row.kind})` : ""} `,
            h("span", {
              class: verifying ? "cell-dim" : "",
              text: verifying ? "verifying…" : row.status,
            }),
          ),
          h("span", {
            class: "ts",
            dataset:
              verifying && row.startedAt
                ? { since: row.startedAt, budget: row.timeoutMs ?? "" }
                : {},
            text: verifying ? "" : fmt.formatDuration(row.durationMs),
          }),
          verifying && row.progress.length
            ? progressLine(row.progress.at(-1))
            : null,
          !verifying && row.attempts
            ? h("div", {
                class: "outcome-progress outcome-attempts",
                text: `polled${Studio.events.attemptsText(row.attempts, row.polledMs)}${
                  row.status !== "passed" && row.progress.length
                    ? ` — last: ${row.progress.at(-1)}`
                    : ""
                }`,
              })
            : null,
        );
        if (entry) entry.el.replaceWith(el);
        else outcomesList.appendChild(el);
        outcomeRows.set(row.outcomeId, { el, sig });
      }
    }

    function paintPreconditions(record) {
      const model = record.model;
      const rows = [
        // F2: readiness gates are waited on before the precondition commands
        ...model.gates.map((gate) => ({
          key: `gate:${gate.name}:${gate.startedAt ?? ""}`,
          status:
            gate.status === "waiting"
              ? "running"
              : gate.status === "interrupted"
                ? "interrupted"
                : gate.status,
          label: `gate ${gate.name}${
            gate.scope ? ` (${Studio.events.gateScopeLabel(gate.scope)})` : ""
          }`,
          detail:
            gate.status === "waiting"
              ? `${gate.attempts ? `attempt ${gate.attempts}` : "waiting"}${
                  gate.lastDetail ? ` — ${gate.lastDetail}` : ""
                }`
              : gate.status === "passed"
                ? `ready after ${gate.attempts} attempt${
                    gate.attempts === 1 ? "" : "s"
                  }`
                : `${
                    gate.cancelled
                      ? "cancelled"
                      : gate.timedOut
                        ? "timed out"
                        : gate.status === "interrupted"
                          ? "cut off"
                          : "not ready"
                  } after ${gate.attempts} attempt${
                    gate.attempts === 1 ? "" : "s"
                  }${gate.lastDetail ? ` — ${gate.lastDetail}` : ""}`,
          durationMs: gate.durationMs,
          since: gate.status === "waiting" ? gate.startedAt : null,
          budgetMs: gate.budgetMs || null,
          kind: "gate",
        })),
        ...model.preconditions.map((row) => ({
          key: `pre:${row.name}`,
          status: row.status,
          label: `precondition ${row.name}`,
          detail:
            row.status === "running"
              ? (row.progress.at(-1) ??
                (row.timeoutMs
                  ? `timeout ${fmt.formatDuration(row.timeoutMs)}`
                  : ""))
              : `${row.timedOut ? "timed out" : `exit ${row.exitCode ?? "?"}`}${
                  row.status === "failed" && row.outputTail
                    ? ` — ${Studio.events.lastLine(row.outputTail)}`
                    : ""
                }`,
          durationMs: row.durationMs,
        })),
        ...model.hooks.map((row) => ({
          key: `hook:${row.hook}:${row.index}:${row.runId ?? ""}:${row.iteration ?? ""}`,
          status: row.status,
          // Parallel --after hooks share hook + index: name the run's spec.
          label: `${row.hook} hook #${row.index ?? "?"}${
            row.runId
              ? ` · ${/_(.+)_[0-9a-f]{6}$/.exec(row.runId)?.[1] ?? row.runId}`
              : row.iteration
                ? ` · iteration ${row.iteration}`
                : ""
          }${row.command ? ` · ${fmt.truncate(row.command, 80)}` : ""}`,
          detail: row.status === "running" ? "" : `exit ${row.exitCode ?? "?"}`,
          durationMs: row.durationMs,
        })),
      ];
      preSection.classList.toggle("hidden", rows.length === 0);
      const parts = [
        model.preconditions.length ? "preconditions" : null,
        model.gates.length ? "gates" : null,
        model.hooks.length ? "hooks" : null,
      ].filter(Boolean);
      const joined =
        parts.length > 1
          ? `${parts.slice(0, -1).join(", ")} & ${parts.at(-1)}`
          : (parts[0] ?? "");
      preTitle.textContent = joined.charAt(0).toUpperCase() + joined.slice(1);
      Studio.clear(prePanel);
      for (const row of /** @type {Array<Record<string, any>>} */ (rows))
        prePanel.appendChild(
          h(
            "div",
            {
              class: `timeline-row${row.kind === "gate" ? " gate-live" : ""}`,
            },
            h("span", {
              class: `dot dot-${
                row.status === "running"
                  ? "running"
                  : fmt.statusTone(row.status)
              }`,
            }),
            h(
              "span",
              { class: "label", title: row.label },
              row.label,
              row.detail
                ? h("span", { class: "cell-dim", text: ` · ${row.detail}` })
                : null,
            ),
            h("span", {
              class: "ts",
              dataset: row.since
                ? { since: row.since, budget: row.budgetMs ?? "" }
                : {},
              text:
                row.status === "running"
                  ? "…"
                  : fmt.formatDuration(row.durationMs),
            }),
          ),
        );
      // Without announced log files, show the event's output tail.
      for (const row of model.preconditions) {
        if (row.logPath || !row.outputTail) continue;
        const id = `pre-output:${row.name}`;
        if (output.sources.has(id)) continue;
        const source = output.addSource(id, `precondition ${row.name}`);
        source.pane.append(
          String(row.outputTail)
            .split(/\r?\n/)
            .map((text) => line(text)),
        );
      }
    }

    function paintTeardown(record) {
      const rows = record.model.teardown;
      teardownSection.classList.toggle("hidden", rows.length === 0);
      if (!rows.length) return;
      const failed = rows.filter((row) => row.status === "failed").length;
      const total = rows.find((row) => row.total)?.total ?? rows.length;
      teardownTitle.textContent = `Teardown (${
        rows.filter((row) => row.status !== "running").length
      }/${total}${failed ? ` · ${failed} failed` : ""})`;
      Studio.clear(teardownList);
      for (const row of rows) {
        const what = Studio.events.teardownWhat(row);
        teardownList.appendChild(
          h(
            "div",
            {
              class: `timeline-row teardown-live-row step-${row.status}`,
              dataset: { teardown: String(row.index) },
            },
            h("span", {
              class: `dot dot-${
                row.status === "running"
                  ? "running"
                  : fmt.statusTone(row.status)
              }`,
            }),
            h(
              "span",
              { class: "label", title: what },
              h("span", {
                class: "step-pos",
                text: `${row.index}${row.total ? `/${row.total}` : ""}`,
              }),
              ` ${what}`,
              row.signal
                ? h("span", { class: "cell-dim", text: ` · on ${row.signal}` })
                : row.runStatus
                  ? h("span", {
                      class: "cell-dim",
                      text: ` · run ${row.runStatus}`,
                    })
                  : null,
            ),
            h("span", {
              class: "ts",
              dataset:
                row.status === "running" && row.startedAt
                  ? { since: row.startedAt, budget: "" }
                  : {},
              text:
                row.status === "running"
                  ? "…"
                  : row.status === "skipped"
                    ? "skipped"
                    : fmt.formatDuration(row.durationMs),
            }),
            row.error
              ? h("div", {
                  class: `step-error inline-error${
                    row.kind === "run" ? " run-output" : ""
                  }`,
                  text: fmt.truncate(row.error, 1200),
                })
              : null,
          ),
        );
      }
    }

    function paintFixtures(record) {
      const rows = record.model.fixtures;
      fixturesSection.classList.toggle("hidden", rows.length === 0);
      Studio.clear(fixturesList);
      for (const row of rows) {
        const status = row.lastStatus ?? "unknown";
        fixturesList.appendChild(
          h(
            "div",
            { class: "timeline-row fixture-live", dataset: { name: row.name } },
            h("span", {
              class: `dot dot-${Studio.events.fixtureTone(status)}`,
            }),
            h(
              "span",
              { class: "label", title: row.name },
              `fixture ${row.name}`,
              row.adapter
                ? h("span", { class: "cell-dim", text: ` (${row.adapter})` })
                : null,
              " ",
              ...row.order.map((verb) =>
                h("span", {
                  class: `tag tag-${Studio.events.fixtureTone(
                    row.verbs[verb].status,
                  )}`.replace("tag-muted", "tag"),
                  title: row.verbs[verb].error ?? row.verbs[verb].reason ?? "",
                  text: `${verb} ${row.verbs[verb].status}`,
                }),
              ),
            ),
            h("span", {
              class: "ts",
              text: fmt.formatDuration(
                row.lastVerb ? row.verbs[row.lastVerb].durationMs : null,
              ),
            }),
            row.outputs?.length
              ? h("div", {
                  class: "outcome-progress fixture-outputs",
                  text: row.outputs
                    .map(([name, value]) => `${name}=${value}`)
                    .join("  "),
                })
              : null,
            row.lastVerb && row.verbs[row.lastVerb].error
              ? h("div", {
                  class: "step-error inline-error",
                  text: fmt.truncate(row.verbs[row.lastVerb].error, 600),
                })
              : null,
          ),
        );
      }
    }

    function paintLogs(record) {
      for (const entry of record.model.logs) {
        const id = `file:${entry.path}`;
        if (output.sources.has(id)) continue;
        output.addSource(
          id,
          `${entry.kind}${entry.name ? ` ${entry.name}` : ""}`,
          { file: entry.path },
        );
      }
      if (cairnLogSource) {
        const fresh = record.logTotal - renderedLogs;
        if (fresh > 0) {
          const slice = record.logs.slice(
            -Math.min(fresh, record.logs.length, MAX_PANE_LINES),
          );
          cairnLogSource.pane.append(slice.map(logLine));
          renderedLogs = record.logTotal;
        }
      }
    }

    function paintEvents(record) {
      const fresh = record.eventTotal - renderedEvents;
      if (fresh <= 0) return;
      const slice = record.events.slice(
        -Math.min(fresh, record.events.length, MAX_PANE_LINES),
      );
      eventsSource.pane.append(slice.map(eventLine));
      renderedEvents = record.eventTotal;
    }

    async function paintScreenshot(record) {
      const latest = record.model.latestScreenshot?.path ?? null;
      if (!latest || !record.runDir || latest === shotPath || shotLoading)
        return;
      shotLoading = true;
      const wanted = latest;
      try {
        let src = null;
        try {
          src =
            (
              await Studio.api.call("run:media-url", {
                runDir: record.runDir,
                path: wanted,
              })
            )?.url ?? null;
        } catch {
          const image = await Studio.api.call("run:artifact-image", {
            runDir: record.runDir,
            path: wanted,
          });
          src = image?.ok ? image.dataUrl : null;
        }
        if (src) {
          shotImg.src = src;
          shotImg.classList.remove("hidden");
          shotEmpty.classList.add("hidden");
          shotCaption.textContent = `${wanted}${
            record.model.latestScreenshot?.stepId
              ? ` · ${record.model.latestScreenshot.stepId}`
              : ""
          }`;
          shotPath = wanted;
        }
      } catch {
        // screenshot may not be flushed yet; the next event retries
      } finally {
        shotLoading = false;
        // A newer screenshot may have arrived while loading.
        if (record.model.latestScreenshot?.path !== shotPath)
          Studio.markDirty(record, ["screenshot"]);
      }
    }

    function tick(now) {
      const record = getRecord();
      if (!record) return;
      const start = startedMs(record);
      const end = kind === "app" ? record.done?.at : record.done?.at;
      elapsed.textContent = start
        ? fmt.formatDuration(Math.max(0, (end ?? now) - start))
        : "—";
      if (kind === "detected")
        activity.textContent = record.lastActivityMs
          ? `active ${fmt.relativeTime(record.lastActivityMs)}`
          : "";
      const phase = record.done
        ? null
        : Studio.events.currentPhase(record.model, now);
      Studio.paintPhaseBanner(banner, phase, phase ? "" : idleText(record));
      for (const node of [
        ...outcomesList.querySelectorAll("[data-since]"),
        ...prePanel.querySelectorAll("[data-since]"),
        ...teardownList.querySelectorAll("[data-since]"),
      ]) {
        const since = ms(node.getAttribute("data-since"));
        const budget = Number(node.getAttribute("data-budget")) || null;
        if (since !== null)
          node.textContent = `${fmt.formatDuration(now - since)}${
            budget ? ` / ${fmt.formatDuration(budget)}` : ""
          }`;
      }
    }

    function settled(record) {
      return Boolean(
        record.done && Date.now() - record.done.at > TAIL_SETTLE_MS,
      );
    }

    async function pollTails() {
      const record = getRecord();
      if (!record?.runDir) return;
      for (const source of output.sources.values()) {
        if (!source.file) continue;
        const visible = output.selected() === source.id;
        if (settled(record) && source.fetched && !visible) continue;
        if (settled(record) && source.fetched && source.final) continue;
        if (settled(record)) source.final = true;
        await pollFileSource(source, { runDir: record.runDir });
      }
    }

    return {
      root,
      kind,
      key,
      update() {
        const record = getRecord();
        if (!record) return;
        const dirty = record.dirty ?? new Set(["all"]);
        const all = dirty.has("all");
        record.dirty = new Set();
        if (all || dirty.has("status") || dirty.has("badges")) {
          paintStatus(record);
          paintBadges(record);
        }
        if (all || dirty.has("steps")) paintSteps(record);
        if (all || dirty.has("outcomes")) paintOutcomes(record);
        if (
          all ||
          dirty.has("preconditions") ||
          dirty.has("hooks") ||
          dirty.has("gates")
        )
          paintPreconditions(record);
        if (all || dirty.has("teardown")) paintTeardown(record);
        if (all || dirty.has("fixtures")) paintFixtures(record);
        if (all || dirty.has("logs")) paintLogs(record);
        if (all || dirty.has("events")) paintEvents(record);
        if (all || dirty.has("screenshot")) void paintScreenshot(record);
        tick(Date.now());
      },
      tick,
      pollTails,
    };
  }

  // ── invocation group ─────────────────────────────────────────────────────

  /** @param {string} invocationId */
  function createInvocationGroup(invocationId) {
    const getRecord = () => state.invocations.get(invocationId);
    const dot = h("span", { class: "dot dot-running" });
    const title = h("span", {
      class: "mono card-title",
      text: `invocation ${invocationId}`,
    });
    const statusTag = Studio.tag("running", "info");
    const positionTag = h("span", { class: "tag hidden" });
    const etaTag = h("span", { class: "tag hidden" });
    const pidTag = h("span", { class: "tag hidden" });
    const originSlot = h("span", { class: "origin-slot" });
    const livenessSlot = h("span", { class: "liveness-slot" });
    const elapsed = h("span", { class: "elapsed" });
    const details = h("button", {
      class: "btn btn-sm btn-ghost group-details",
      type: "button",
      text: "Details",
      ariaLabel: `open invocation ${invocationId} in the Invocations view`,
      title: "Plan, per-spec status, logs, and Stop",
      onClick: () => Studio.navigate("invocations", { invocationId }),
    });
    const banner = h("div", { class: "phase-banner idle" });
    Studio.paintPhaseBanner(
      banner,
      null,
      "waiting for the invocation's first event…",
    );
    const plannedList = h("ol", { class: "planned-list" });
    const planned = h(
      "details",
      { class: "planned hidden" },
      h("summary", { class: "cell-dim", text: "planned specs" }),
      plannedList,
    );
    const argvLine = h("div", { class: "cell-dim mono argv-line" });
    const output = createOutputPanel();
    const eventsSource = output.addSource("events", "events");
    output.el.classList.add("hidden");
    const members = h("div", { class: "group-members" });
    const root = h(
      "section",
      { class: "live-group", dataset: { key: `inv:${invocationId}` } },
      h(
        "div",
        { class: "group-head" },
        dot,
        title,
        statusTag,
        positionTag,
        etaTag,
        pidTag,
        originSlot,
        livenessSlot,
        elapsed,
        details,
      ),
      banner,
      h("div", { class: "group-body" }, argvLine, planned, output.el),
      members,
    );
    let renderedEvents = 0;
    let plannedSig = "";
    let badgeSig = "";

    function paint(record) {
      const journal = record?.journal ?? null;
      // "refused" when the policy refused every planned spec (or exit 7):
      // the journal itself says failed/passed.
      const status =
        (journal
          ? Studio.events.invocationStatus(
              journal,
              record?.model?.refusals ?? [],
            )
          : null) ??
        record?.model?.status ??
        "running";
      const running = status === "running";
      dot.className = `dot dot-${
        running
          ? "running"
          : status === "aborted"
            ? "warn"
            : fmt.statusTone(status)
      }`;
      statusTag.textContent = status;
      statusTag.className = `tag ${
        running
          ? "tag-info"
          : status === "aborted"
            ? "tag-warn"
            : `tag-${fmt.statusTone(status)}`
      }`;
      const fromApp = [...state.live.values()].some(
        (entry) => entry.pid && entry.pid === journal?.pid,
      );
      const nextBadgeSig = JSON.stringify([
        journal?.origin,
        journal?.client,
        fromApp,
        journal?.liveness?.state,
        journal?.liveness?.reason,
      ]);
      if (nextBadgeSig !== badgeSig) {
        badgeSig = nextBadgeSig;
        Studio.clear(originSlot);
        Studio.clear(livenessSlot);
        const origin = Studio.originBadge(journal, { fromApp });
        if (origin) originSlot.appendChild(origin);
        const liveness = Studio.livenessTag(journal?.liveness);
        if (liveness) livenessSlot.appendChild(liveness);
      }
      const total = journal?.planned?.length || record?.model?.planned || null;
      const index = journal?.current?.index ?? null;
      if (total) {
        positionTag.textContent = index
          ? `spec ${index}/${total}`
          : `${total} planned`;
        positionTag.className = "tag tag-info";
      } else positionTag.className = "tag hidden";
      const eta = journal?.eta;
      if (running && eta?.etaMs !== null && eta?.etaMs !== undefined) {
        etaTag.textContent = `~${fmt.formatDuration(eta.etaMs)} left`;
        etaTag.title = `p50 of ${eta.known} remaining spec(s) from local history${
          eta.unknown ? `; ${eta.unknown} without history` : ""
        }`;
        etaTag.className = "tag";
      } else etaTag.className = "tag hidden";
      if (journal?.pid) {
        pidTag.textContent = `pid ${journal.pid}${
          journal.pidAlive === false ? " (gone)" : ""
        }`;
        pidTag.className = `tag${
          journal.pidAlive === false ? " tag-warn" : ""
        }`;
      } else pidTag.className = "tag hidden";
      argvLine.textContent = journal?.argv?.length
        ? journal.argv.join(" ")
        : "";
      const refusals = record?.model?.refusals ?? [];
      const sig = JSON.stringify([
        journal?.planned,
        journal?.runs,
        journal?.current,
        refusals.length,
      ]);
      if (sig !== plannedSig) {
        plannedSig = sig;
        Studio.clear(plannedList);
        const runsByIndex = new Map(
          (journal?.runs ?? []).map((entry) => [entry.index, entry]),
        );
        for (const entry of journal?.planned ?? []) {
          const run = runsByIndex.get(entry.index);
          const isCurrent = journal?.current?.index === entry.index;
          // A refused spec has no run: its run.refused journal event says so.
          const refusedEvent = run
            ? null
            : Studio.events.plannedRefusal(refusals, entry);
          const itemState =
            run?.status ??
            (refusedEvent ? "refused" : isCurrent ? "running" : "pending");
          const refusal =
            itemState === "refused"
              ? CairnPolicy.normalizeRefusal(refusedEvent ?? run?.refusal)
              : null;
          plannedList.appendChild(
            h(
              "li",
              {
                class: `planned-item planned-${itemState}`,
                title: refusal ? CairnPolicy.refusalText(refusal) : null,
              },
              h("span", {
                class: `dot dot-${
                  itemState === "running"
                    ? "running"
                    : itemState === "pending"
                      ? "muted"
                      : fmt.statusTone(itemState)
                }`,
              }),
              h("span", { class: "mono", text: entry.spec }),
              entry.labels
                ? h("span", {
                    class: "cell-dim",
                    text: ` ${Object.entries(entry.labels)
                      .map(([k, v]) => `${k}=${v}`)
                      .join(" ")}`,
                  })
                : null,
            ),
          );
        }
        planned.classList.toggle("hidden", !(journal?.planned ?? []).length);
        if (running && (journal?.planned ?? []).length <= 12)
          /** @type {HTMLDetailsElement} */ (planned).open = true;
      }
    }

    function paintLogs(record) {
      for (const entry of record.model.logs) {
        const id = `file:${entry.path}`;
        if (output.sources.has(id)) continue;
        output.addSource(
          id,
          `${entry.kind}${entry.name ? ` ${entry.name}` : ""}`,
          { file: entry.path },
        );
        output.el.classList.remove("hidden");
      }
      const fresh = record.eventTotal - renderedEvents;
      if (fresh > 0) {
        const slice = record.events.slice(
          -Math.min(fresh, record.events.length, MAX_PANE_LINES),
        );
        eventsSource.pane.append(slice.map(eventLine));
        renderedEvents = record.eventTotal;
        output.el.classList.remove("hidden");
      }
    }

    function tick(now) {
      const record = getRecord();
      const started =
        ms(record?.journal?.startedAt) ?? ms(record?.model?.startedAt);
      const ended = ms(record?.journal?.endedAt);
      elapsed.textContent = started
        ? fmt.formatDuration(Math.max(0, (ended ?? now) - started))
        : "";
      const phase =
        record && record.journal?.alive !== false
          ? Studio.events.currentPhase(record.model, now)
          : null;
      const status = record?.journal?.status ?? "running";
      Studio.paintPhaseBanner(
        banner,
        phase,
        status === "running"
          ? record?.model?.eventCount
            ? "between phases…"
            : "waiting for the invocation's first event…"
          : `finished · ${status}`,
      );
    }

    return {
      root,
      members,
      key: `inv:${invocationId}`,
      update() {
        const record = getRecord();
        if (record) {
          record.dirty = new Set();
          paint(record);
          paintLogs(record);
        }
        tick(Date.now());
      },
      tick,
      async pollTails() {
        const record = getRecord();
        if (!record) return;
        const alive = record.journal?.alive !== false;
        for (const source of output.sources.values()) {
          if (!source.file) continue;
          if (!alive && source.fetched) continue;
          await pollFileSource(source, { invocationId });
        }
      },
    };
  }

  /**
   * @param {string} key
   * @param {string} label
   */
  function createSection(key, label) {
    const titleEl = h("div", {
      class: "section-title live-section-title",
      text: label,
    });
    const members = h("div", { class: "group-members" });
    const root = h(
      "section",
      { class: "live-section", dataset: { key } },
      titleEl,
      members,
    );
    return {
      root,
      members,
      key,
      /** @param {string} text */
      setTitle(text) {
        titleEl.textContent = text;
      },
      update() {},
      tick() {},
      async pollTails() {},
    };
  }

  // ── reconcile ────────────────────────────────────────────────────────────

  /**
   * Put `children` into `parent` in order, moving a node only when it is out
   * of place (moving resets the scroll of anything inside it).
   * @param {HTMLElement} parent
   * @param {HTMLElement[]} children
   */
  function placeInOrder(parent, children) {
    children.forEach((child, index) => {
      if (parent.children[index] !== child)
        parent.insertBefore(child, parent.children[index] ?? null);
    });
    while (parent.children.length > children.length)
      parent.removeChild(/** @type {Node} */ (parent.lastChild));
  }

  /**
   * @param {string} key
   * @param {() => any} create
   */
  function controllerFor(key, create) {
    let controller = controllers.get(key);
    if (!controller) {
      controller = create();
      controllers.set(key, controller);
    }
    return controller;
  }

  function reconcile() {
    if (!host) return;
    const layout = computeLiveLayout({
      live: [...state.live.values()],
      detected: [...state.detected.values()],
      invocations: [...state.invocations.values()],
    });
    const used = new Set();
    /** @type {HTMLElement[]} */
    const top = [];
    for (const group of layout) {
      let container;
      /** @type {string[]} */
      let memberKeys = [];
      if (group.type === "invocation") {
        container = controllerFor(`inv:${group.id}`, () =>
          createInvocationGroup(group.id),
        );
        memberKeys = [
          ...group.app.map((token) => `app:${token}`),
          ...group.detected.map((id) => `det:${id}`),
        ];
      } else if (group.type === "app") {
        container = controllerFor("section:app", () =>
          createSection("section:app", ""),
        );
        container.setTitle(`from this app (${group.keys.length})`);
        memberKeys = group.keys.map((token) => `app:${token}`);
      } else {
        container = controllerFor("section:detected", () =>
          createSection("section:detected", ""),
        );
        container.setTitle(`detected outside the app (${group.keys.length})`);
        memberKeys = group.keys.map((id) => `det:${id}`);
      }
      used.add(container.key);
      container.update();
      top.push(container.root);
      const memberRoots = [];
      for (const memberKey of memberKeys) {
        const [kind, ...rest] = memberKey.split(":");
        const id = rest.join(":");
        const card = controllerFor(memberKey, () =>
          createRunCard(kind === "app" ? "app" : "detected", id),
        );
        used.add(memberKey);
        const record =
          kind === "app" ? state.live.get(id) : state.detected.get(id);
        if (record?.dirty?.size || !card.painted) {
          card.update();
          card.painted = true;
        }
        memberRoots.push(card.root);
      }
      placeInOrder(container.members, memberRoots);
    }
    for (const key of controllers.keys())
      if (!used.has(key)) controllers.delete(key);

    if (!top.length) {
      const empty = controllerFor("empty", () => ({
        key: "empty",
        root: Studio.empty(
          "Nothing running",
          "Start a spec from the Specs view, or run `cairn run` in a terminal or through an agent: runs started outside the app appear here while they execute. Finished invocations stay in the Invocations view.",
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
              text: "Invocations",
              onClick: () => Studio.navigate("invocations"),
            }),
          ],
        ),
        update() {},
        tick() {},
        async pollTails() {},
      }));
      used.add("empty");
      top.push(empty.root);
    } else controllers.delete("empty");
    placeInOrder(host, top);
  }

  /** Coalesce pushes into one repaint per frame (250ms when hidden). */
  function schedule() {
    if (frame !== null || !host) return;
    const run = () => {
      frame = null;
      frameKind = null;
      try {
        reconcile();
      } catch (error) {
        console.error("live view repaint failed", error);
      }
    };
    if (typeof requestAnimationFrame === "function" && !document.hidden) {
      frameKind = "raf";
      frame = requestAnimationFrame(run);
    } else {
      frameKind = "timeout";
      frame = /** @type {any} */ (setTimeout(run, 250));
    }
  }

  /** @param {HTMLElement} root */
  function render(root) {
    destroy();
    viewRoot = root;
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
              schedule();
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
    const notice = Studio.setupNotice();
    if (notice) root.appendChild(notice);
    host = h("div", { id: "live-host" });
    root.appendChild(host);
    // Every record repaints fully once into fresh controllers.
    for (const record of [
      ...state.live.values(),
      ...state.detected.values(),
      ...state.invocations.values(),
    ])
      Studio.markDirty(record, ["all"]);
    reconcile();

    ticker = setInterval(() => {
      const now = Date.now();
      for (const controller of controllers.values()) controller.tick?.(now);
    }, 500);
    tailTimer = setInterval(() => {
      for (const controller of controllers.values())
        void controller.pollTails?.();
    }, 1000);

    return { destroy };
  }

  function destroy() {
    if (ticker) clearInterval(ticker);
    if (tailTimer) clearInterval(tailTimer);
    ticker = null;
    tailTimer = null;
    if (frame !== null) {
      if (frameKind === "raf") {
        if (typeof cancelAnimationFrame === "function")
          cancelAnimationFrame(frame);
      } else clearTimeout(/** @type {any} */ (frame));
    }
    frame = null;
    frameKind = null;
    controllers.clear();
    host = null;
    viewRoot = null;
  }

  function clearFinished() {
    for (const [token, record] of state.live.entries())
      if (record.done) state.live.delete(token);
    for (const [runId, record] of state.detected.entries())
      if (record.done || record.stale || record.liveness?.state === "dead")
        state.detected.delete(runId);
    for (const [id, record] of state.invocations.entries())
      if (record.journal && !record.journal.alive) state.invocations.delete(id);
  }

  /** Schedule a repaint if the live view is on screen. */
  function refreshIfVisible() {
    if (state.view !== "live" || !host || !viewRoot) return;
    schedule();
  }

  Studio.views = Studio.views || {};
  Studio.views.live = {
    id: "live",
    label: "Live",
    glyph: "▶",
    render,
    refresh: refreshIfVisible,
  };
  Studio.live = {
    refreshIfVisible,
    computeLiveLayout,
    isNearBottom,
    splitChunk,
    /** Repaint now and poll every log tail once (tests, focus regain). */
    async flush() {
      if (!host) return;
      reconcile();
      for (const controller of controllers.values())
        await controller.pollTails?.();
    },
  };
})();
