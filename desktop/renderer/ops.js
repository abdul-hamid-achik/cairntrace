/**
 * Run-policy and metrics components, shared by Live, Invocations and Run
 * detail: the policy badges (critical teardown, dirty state, preflight, lock,
 * bail), the run-policy panel (lock, preflight, cleanliness, finally, suite
 * hooks), the metrics table with a sparkline per metric, and the lock
 * wording the topbar and Specs use.
 *
 * Accessibility rules the components keep: state is always a glyph *and* a
 * word (never colour alone), the two exit codes the run policy added read
 * differently by shape as well as colour (8: heavy solid border and a stop
 * sign; 9: dashed border and a warning sign), a sparkline is an `img` with
 * a full text label, labelled axes and a values table one click away, and
 * every colour comes from the theme's CSS variables.
 */
(function bootOps() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, fmt } = Studio;
  const SVG_NS = "http://www.w3.org/2000/svg";

  /**
   * @param {string} tagName
   * @param {Record<string, string | number>} [attrs]
   * @param {...any} children
   * @returns {SVGElement}
   */
  function svg(tagName, attrs = {}, ...children) {
    const node = document.createElementNS(SVG_NS, tagName);
    for (const [key, value] of Object.entries(attrs))
      node.setAttribute(key, String(value));
    for (const child of children.flat()) {
      if (child === null || child === undefined || child === false) continue;
      node.appendChild(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
    }
    return /** @type {SVGElement} */ (node);
  }

  const GLYPHS = { ok: "✓", bad: "✗", warn: "⚠", info: "•", muted: "·" };

  /**
   * A number as a short label, with its unit.
   * @param {number | null | undefined} value
   * @param {string | null | undefined} [unit]
   * @param {{ signed?: boolean }} [options]
   * @returns {string}
   */
  function formatMetric(value, unit, options = {}) {
    if (value === null || value === undefined || !Number.isFinite(value))
      return "—";
    const text = Number.isInteger(value)
      ? String(value)
      : String(Number(value.toFixed(3)));
    const signed = options.signed && value > 0 ? `+${text}` : text;
    return unit ? `${signed} ${unit}` : signed;
  }

  // ── badges ────────────────────────────────────────────────────────────────

  /**
   * One policy badge: glyph + words, shaped by what it means.
   * @param {{ key: string, label: string, tone: string, glyph: string, title: string }} item
   * @returns {HTMLElement}
   */
  function badge(item) {
    return h(
      "span",
      {
        class: `tag tag-${item.tone} ops-badge ops-badge-${item.key}`,
        title: item.title,
        dataset: { badge: item.key },
      },
      h("span", { class: "ops-glyph", ariaHidden: "true", text: item.glyph }),
      item.label,
    );
  }

  /**
   * The badge row for what the run policy did (null when it did nothing
   * notable).
   * @param {Record<string, any> | null | undefined} model events model (`policy`, `services`)
   * @param {Record<string, any> | null | undefined} [summary] invocation.json summary
   * @returns {HTMLElement | null}
   */
  function badges(model, summary) {
    const list = Studio.events.policyBadges(model, summary);
    if (!list.length) return null;
    return h(
      "div",
      { class: "badges ops-badges", ariaLabel: "run policy" },
      list.map(badge),
    );
  }

  /**
   * The badge for a process exit code the run policy added (8, 9), or null.
   * @param {number | null | undefined} code
   * @returns {HTMLElement | null}
   */
  function exitBadge(code) {
    const found = Studio.events.exitBadge(code);
    return found ? badge(found) : null;
  }

  // ── lock wording ──────────────────────────────────────────────────────────

  /**
   * "run in progress" for the config run lock, "suite in progress" for a
   * configured suite lock file.
   * @param {Array<Record<string, any>>} active
   * @returns {string}
   */
  function lockHeadline(active) {
    return active[0]?.kind === "run-lock"
      ? "run in progress"
      : "suite in progress";
  }

  /**
   * One held lock as a sentence: who holds it, and for how long.
   * @param {Record<string, any>} lock
   * @returns {string}
   */
  function lockSentence(lock) {
    if (lock?.kind === "run-lock")
      return `a cairn run holds the run lock: ${lock.owner ?? "owner unknown"}${
        lock.command ? ` — ${lock.command}` : ""
      }`;
    return `${lock?.path ?? "lock"}${
      lock?.owner ? ` (owner: ${lock.owner})` : ""
    }`;
  }

  // ── run-policy panel ──────────────────────────────────────────────────────

  /**
   * @param {string} tone
   * @param {string} word the visible state
   * @param {string} text what it is about
   * @param {string | null} [detail]
   * @param {string} [key]
   * @returns {HTMLElement}
   */
  function policyRow(tone, word, text, detail = null, key = "") {
    return h(
      "li",
      {
        class: `ops-row ops-row-${tone}`,
        dataset: key ? { row: key } : undefined,
      },
      h("span", {
        class: "ops-mark",
        ariaHidden: "true",
        text: GLYPHS[/** @type {keyof typeof GLYPHS} */ (tone)] ?? "·",
      }),
      h("span", { class: "ops-status", text: word }),
      h("span", { class: "ops-text", text }),
      detail ? h("div", { class: "ops-detail mono", text: detail }) : null,
    );
  }

  /**
   * @param {string} title
   * @param {HTMLElement[]} rows
   * @returns {HTMLElement | null}
   */
  function policySection(title, rows) {
    if (!rows.length) return null;
    return h(
      "div",
      { class: "ops-section" },
      h("div", { class: "section-title", text: title }),
      h("ul", { class: "ops-list", ariaLabel: title }, rows),
    );
  }

  /**
   * What the run policy did to one invocation: the lock, preflight checks,
   * cleanliness findings, `finally` hooks, critical teardown failures,
   * suite and its hooks, and `--bail`. Reads the events model's `policy`
   * and the journal summary; null when there is nothing to show.
   * @param {{ policy?: Record<string, any> | null, summary?: Record<string, any> | null, services?: Array<Record<string, any>> | null }} input
   * @returns {HTMLElement | null}
   */
  function policyPanel(input) {
    const policy = input.policy ?? null;
    const summary = input.summary ?? null;
    const run = summary?.runPolicy ?? null;
    const sections = [];

    /** @type {HTMLElement[]} */
    const exits = [];
    const critical = Array.isArray(run?.criticalTeardown)
      ? run.criticalTeardown
      : [];
    for (const entry of critical)
      exits.push(
        policyRow(
          "bad",
          "critical teardown failed",
          `services.teardown[${entry.index}] (${entry.command ?? "?"}) ${
            entry.timedOut
              ? "timed out"
              : entry.exitCode !== undefined && entry.exitCode !== null
                ? `exit ${entry.exitCode}`
                : (entry.error ?? "failed")
          }${entry.path === "signal" ? " on a signal" : ""}`,
          entry.error ?? null,
          "critical",
        ),
      );
    if (!critical.length)
      for (const row of input.services ?? [])
        if (row.data?.critical || row.data?.provisioner)
          exits.push(
            policyRow(
              "bad",
              row.data?.provisioner
                ? "provisioner down failed"
                : "critical teardown failed",
              row.message ?? "teardown failed",
              null,
              "critical",
            ),
          );
    const exitSection = policySection(
      "Critical teardown (exit 8 outranks every verdict)",
      exits,
    );
    if (exitSection) sections.push(exitSection);

    /** @type {HTMLElement[]} */
    const lockRows = [];
    const lock = policy?.lock ?? null;
    if (lock) {
      const owner = lock.owner ? Studio.events.lockOwnerText(lock.owner) : null;
      lockRows.push(
        policyRow(
          lock.state === "refused"
            ? "bad"
            : lock.state === "reclaimed"
              ? "warn"
              : "ok",
          lock.state === "refused"
            ? `refused (${lock.reason ?? "held"})`
            : lock.state,
          `run lock · ${lock.scope ?? "config"} scope${
            lock.heldMs !== null && lock.heldMs !== undefined
              ? ` · held ${fmt.formatDuration(lock.heldMs)}`
              : ""
          }`,
          [owner ? `owner ${owner}` : null, lock.message]
            .filter(Boolean)
            .join(" — ") || null,
          "lock",
        ),
      );
    }
    const lockSection = policySection("Run lock", lockRows);
    if (lockSection) sections.push(lockSection);

    const checks = policy?.preflight?.checks ?? [];
    const preflightSection = policySection(
      `Preflight${
        policy?.preflight?.total
          ? ` (${checks.length}/${policy.preflight.total})`
          : ""
      }`,
      checks.map((/** @type {Record<string, any>} */ check) =>
        policyRow(
          check.status === "passed" ? "ok" : "bad",
          check.status === "passed" ? "passed" : "FAILED",
          `${check.index} · ${check.check}${
            check.name ? ` ${check.name}` : ""
          }${
            check.durationMs === null || check.durationMs === undefined
              ? ""
              : ` · ${fmt.formatDuration(check.durationMs)}`
          }`,
          check.reason,
          "preflight",
        ),
      ),
    );
    if (preflightSection) sections.push(preflightSection);

    const cleanRows = [];
    const seen = new Set();
    for (const row of policy?.cleanliness ?? []) {
      seen.add(`${row.phase}|${row.kind}|${row.name ?? ""}`);
      cleanRows.push(
        policyRow(
          row.status === "clean"
            ? "ok"
            : row.phase === "after"
              ? "warn"
              : "bad",
          row.status === "clean"
            ? "clean"
            : row.phase === "after"
              ? "dirty (exit 9)"
              : "dirty (refused)",
          `${row.phase} the run · ${row.kind}${row.name ? ` ${row.name}` : ""}`,
          row.survivors?.length ? row.survivors.join("\n") : null,
          "cleanliness",
        ),
      );
    }
    // a settled journal's findings, when the events did not carry them
    for (const row of Array.isArray(run?.dirty) ? run.dirty : []) {
      if (seen.has(`${row.phase}|${row.kind}|${row.name ?? ""}`)) continue;
      cleanRows.push(
        policyRow(
          row.phase === "after" ? "warn" : "bad",
          row.phase === "after" ? "dirty (exit 9)" : "dirty (refused)",
          `${row.phase} the run · ${row.kind}${row.name ? ` ${row.name}` : ""}`,
          Array.isArray(row.survivors) ? row.survivors.join("\n") : null,
          "cleanliness",
        ),
      );
    }
    const cleanSection = policySection("Cleanliness (verifyClean)", cleanRows);
    if (cleanSection) sections.push(cleanSection);

    const finallySection = policySection(
      "Finally",
      (policy?.finally ?? []).map((/** @type {Record<string, any>} */ row) =>
        policyRow(
          row.status === "passed"
            ? "ok"
            : row.status === "running"
              ? "info"
              : "warn",
          row.status === "failed" || row.status === "timed out"
            ? `${row.status} (non-fatal)`
            : row.status,
          `${row.index}${row.total ? `/${row.total}` : ""}${
            row.exitCode === null || row.exitCode === undefined
              ? ""
              : ` · exit ${row.exitCode}`
          }${
            row.durationMs === null || row.durationMs === undefined
              ? ""
              : ` · ${fmt.formatDuration(row.durationMs)}`
          }`,
          row.outputTail ? Studio.events.lastLine(row.outputTail) : null,
          "finally",
        ),
      ),
    );
    if (finallySection) sections.push(finallySection);

    /** @type {HTMLElement[]} */
    const suiteRows = [];
    const suite = policy?.suite ?? null;
    if (suite)
      suiteRows.push(
        policyRow(
          suite.status === "passed"
            ? "ok"
            : suite.status === "running"
              ? "info"
              : suite.status === "refused"
                ? "muted"
                : "bad",
          suite.status,
          `suite ${suite.name}${suite.env ? ` · env ${suite.env}` : ""}${
            suite.specs === null ? "" : ` · ${suite.specs} spec(s)`
          }${suite.parallel ? ` · parallel ${suite.parallel}` : ""}${
            suite.bail ? " · bail" : ""
          }${suite.exitCode === null ? "" : ` · exit ${suite.exitCode}`}`,
          suite.hooksFailed
            ? `${suite.hooksFailed} suite hook(s) failed`
            : null,
          "suite",
        ),
      );
    for (const hook of policy?.suiteHooks ?? [])
      suiteRows.push(
        policyRow(
          hook.status === "passed"
            ? "ok"
            : hook.status === "running"
              ? "info"
              : hook.hook === "after"
                ? "warn"
                : "bad",
          hook.status,
          `${hook.hook} hook ${hook.index}${
            hook.total ? `/${hook.total}` : ""
          }${
            hook.durationMs === null || hook.durationMs === undefined
              ? ""
              : ` · ${fmt.formatDuration(hook.durationMs)}`
          }`,
          [
            hook.command,
            hook.outputTail ? Studio.events.lastLine(hook.outputTail) : null,
          ]
            .filter(Boolean)
            .join("\n") || null,
          "suite-hook",
        ),
      );
    const suiteSection = policySection("Suite", suiteRows);
    if (suiteSection) sections.push(suiteSection);

    const skipped = summary?.skipped ?? policy?.bailed?.skipped ?? null;
    if (policy?.bailed || skipped) {
      const bailSection = policySection("Bail", [
        policyRow(
          "warn",
          "bailed",
          `${skipped ?? 0} spec(s) skipped${
            policy?.bailed?.spec
              ? ` after ${policy.bailed.spec} failed (exit ${policy.bailed.exitCode ?? "?"})`
              : ""
          }`,
          "--bail stops scheduling at the first failed or errored spec; specs already running finish and teardown runs as usual.",
          "bail",
        ),
      ]);
      if (bailSection) sections.push(bailSection);
    }

    // metric probe samples (the newest before / after of each metric); the
    // full values and history are in the run's Metrics tab
    /** @type {Map<string, { name: string, scope: string | null, before: number | null, after: number | null, error: string | null }>} */
    const samples = new Map();
    for (const sample of policy?.metrics ?? []) {
      const key = `${sample.scope}|${sample.name}`;
      const entry = samples.get(key) ?? {
        name: sample.name,
        scope: sample.scope,
        before: null,
        after: null,
        error: null,
      };
      if (sample.phase === "before") entry.before = sample.value;
      else entry.after = sample.value;
      if (sample.error) entry.error = sample.error;
      samples.set(key, entry);
    }
    const metricSection = policySection(
      "Metric samples (latest)",
      [...samples.values()].map((entry) =>
        policyRow(
          entry.error ? "warn" : "muted",
          entry.error ? "sample failed" : "sampled",
          `${entry.name}${
            entry.scope === "invocation" ? " (invocation)" : ""
          }: before ${formatMetric(
            entry.before,
          )} → after ${formatMetric(entry.after)}${
            entry.before !== null && entry.after !== null
              ? ` (Δ ${formatMetric(entry.after - entry.before, null, { signed: true })})`
              : ""
          }`,
          entry.error,
          "metric",
        ),
      ),
    );
    if (metricSection) sections.push(metricSection);

    if (!sections.length) return null;
    const headBadges = badges({ policy, services: input.services }, summary);
    return h("div", { class: "ops-policy" }, headBadges, sections);
  }

  // ── metrics ───────────────────────────────────────────────────────────────

  /**
   * @param {number} n
   * @returns {string}
   */
  function pad(n) {
    return String(n).padStart(2, "0");
  }

  /**
   * "MM-DD HH:mm" in local time, for an axis label.
   * @param {string | null | undefined} iso
   * @returns {string}
   */
  function shortTime(iso) {
    const date = new Date(String(iso ?? ""));
    if (Number.isNaN(date.getTime())) return "?";
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(
      date.getHours(),
    )}:${pad(date.getMinutes())}`;
  }

  /**
   * A small line chart of one metric across runs: oldest on the left, the
   * newest point last, y axis labelled with its min and max, x axis with the
   * first and last run's time, the current run ringed. It is an image with a
   * complete text label, and the values are listed in a table beneath.
   * @param {Array<{ runId: string, at: string | null, value: number }>} points oldest first
   * @param {{ name: string, unit?: string | null, basis?: string, currentRunId?: string | null, onOpen?: ((runId: string) => void) | null }} options
   * @returns {HTMLElement}
   */
  function sparkline(points, options) {
    const unit = options.unit ?? null;
    const values = points.map((point) => point.value);
    const min = Math.min(...values);
    const max = Math.max(...values);
    const width = 260;
    const height = 76;
    const left = 44;
    const right = 8;
    const top = 8;
    const bottom = 20;
    const plotW = width - left - right;
    const plotH = height - top - bottom;
    const xOf = (/** @type {number} */ index) =>
      left +
      (points.length === 1 ? plotW / 2 : (index / (points.length - 1)) * plotW);
    const yOf = (/** @type {number} */ value) =>
      top +
      (max === min ? plotH / 2 : (1 - (value - min) / (max - min)) * plotH);
    const latest = points.at(-1);
    const summary = `${options.name}${
      options.basis ? ` (${options.basis})` : ""
    } across ${points.length} run${
      points.length === 1 ? "" : "s"
    }: min ${formatMetric(
      min,
      unit,
    )}, max ${formatMetric(max, unit)}, latest ${formatMetric(latest?.value, unit)}`;
    const chart = svg(
      "svg",
      {
        class: "spark",
        viewBox: `0 0 ${width} ${height}`,
        width,
        height,
        role: "img",
        "aria-label": summary,
      },
      svg("title", {}, summary),
      // axes
      svg("line", {
        class: "spark-axis",
        x1: left,
        y1: top,
        x2: left,
        y2: top + plotH,
      }),
      svg("line", {
        class: "spark-axis",
        x1: left,
        y1: top + plotH,
        x2: left + plotW,
        y2: top + plotH,
      }),
      svg(
        "text",
        { class: "spark-label", x: left - 4, y: top + 4, "text-anchor": "end" },
        formatMetric(max),
      ),
      svg(
        "text",
        {
          class: "spark-label",
          x: left - 4,
          y: top + plotH,
          "text-anchor": "end",
        },
        formatMetric(min),
      ),
      svg(
        "text",
        {
          class: "spark-label",
          x: left,
          y: height - 4,
          "text-anchor": "start",
        },
        shortTime(points[0]?.at),
      ),
      points.length > 1
        ? svg(
            "text",
            {
              class: "spark-label",
              x: left + plotW,
              y: height - 4,
              "text-anchor": "end",
            },
            shortTime(latest?.at),
          )
        : null,
      points.length > 1
        ? svg("polyline", {
            class: "spark-line",
            fill: "none",
            points: points
              .map(
                (point, index) =>
                  `${xOf(index).toFixed(1)},${yOf(point.value).toFixed(1)}`,
              )
              .join(" "),
          })
        : null,
      points.map((point, index) => {
        const current = point.runId === options.currentRunId;
        return svg(
          "circle",
          {
            class: `spark-dot${current ? " spark-current" : ""}`,
            cx: xOf(index).toFixed(1),
            cy: yOf(point.value).toFixed(1),
            r: current ? 3.6 : 2.2,
          },
          svg(
            "title",
            {},
            `${point.runId}: ${formatMetric(point.value, unit)}${
              current ? " (this run)" : ""
            }`,
          ),
        );
      }),
    );
    const rows = points.toReversed().map((point) =>
      h(
        "tr",
        {
          class:
            point.runId === options.currentRunId ? "spark-current-row" : "",
        },
        h("td", { class: "mono", text: shortTime(point.at) }),
        h(
          "td",
          { class: "mono" },
          options.onOpen && point.runId !== options.currentRunId
            ? h("button", {
                class: "btn btn-sm btn-ghost",
                type: "button",
                text: fmt.truncate(point.runId, 34),
                ariaLabel: `open run ${point.runId}`,
                onClick: () => options.onOpen?.(point.runId),
              })
            : fmt.truncate(point.runId, 34),
          point.runId === options.currentRunId ? " (this run)" : "",
        ),
        h("td", { class: "mono", text: formatMetric(point.value, unit) }),
      ),
    );
    return h(
      "figure",
      { class: "spark-figure", dataset: { metric: options.name } },
      /** @type {any} */ (chart),
      h("figcaption", {
        class: "cell-dim",
        text: `${points.length} run${
          points.length === 1 ? "" : "s"
        } · min ${formatMetric(
          min,
          unit,
        )} · max ${formatMetric(max, unit)} · latest ${formatMetric(latest?.value, unit)}`,
      }),
      h(
        "details",
        { class: "spark-values" },
        h("summary", { class: "cell-dim", text: "values" }),
        h(
          "table",
          { class: "grid spark-table" },
          h(
            "thead",
            h(
              "tr",
              h("th", { text: "run time" }),
              h("th", { text: "run" }),
              h("th", {
                text: `${options.basis ?? "value"}${unit ? ` (${unit})` : ""}`,
              }),
            ),
          ),
          h("tbody", rows),
        ),
      ),
    );
  }

  /**
   * A run's probe results: before / after / delta (and min / max / mean for
   * `every:` probes), failed samples named, and, where the runs before it
   * have the same metric, a sparkline of its history.
   * @param {Record<string, any> | null} doc `detail.metrics`
   * @param {{ history?: Record<string, any> | null, currentRunId?: string | null, onOpen?: ((runId: string) => void) | null }} [options]
   * @returns {HTMLElement}
   */
  function metricsView(doc, options = {}) {
    const rows = doc?.metrics ?? [];
    const history = options.history?.metrics ?? {};
    const body = h("tbody");
    for (const row of rows) {
      const unit = row.unit ?? null;
      const delta = row.delta;
      const trend =
        delta === null || delta === undefined
          ? null
          : h("span", {
              class: `ops-delta ops-delta-${
                delta > 0 ? "up" : delta < 0 ? "down" : "flat"
              }`,
              text: `${
                delta > 0 ? "▲ " : delta < 0 ? "▼ " : "= "
              }${formatMetric(delta, unit, { signed: true })}`,
              title:
                delta > 0
                  ? "increased between before and after"
                  : delta < 0
                    ? "decreased between before and after"
                    : "unchanged",
            });
      const series = row.series;
      // Own keys only: a metric named `constructor` is not Object's.
      const past = Object.hasOwn(history, row.name)
        ? history[row.name]
        : undefined;
      const pastRuns = past?.points ?? [];
      body.appendChild(
        h(
          "tr",
          { class: "metric-row", dataset: { metric: row.name } },
          h(
            "td",
            { class: "mono" },
            row.name,
            row.scope === "invocation"
              ? h("span", {
                  class: "tag ops-scope",
                  text: row.iteration
                    ? `invocation · #${row.iteration}`
                    : "invocation",
                  title: "sampled once for the whole invocation",
                })
              : null,
          ),
          h("td", {
            class: "mono",
            text: formatMetric(row.before?.value, unit),
          }),
          h("td", {
            class: "mono",
            text: formatMetric(row.after?.value, unit),
          }),
          h("td", { class: "mono" }, trend ?? "—"),
          h("td", {
            class: "mono cell-dim",
            text: series
              ? `min ${formatMetric(series.min, unit)} · max ${formatMetric(
                  series.max,
                  unit,
                )} · mean ${formatMetric(series.mean, unit)} · ${series.count} sample${
                  series.count === 1 ? "" : "s"
                }`
              : row.mode === "every"
                ? "—"
                : "",
          }),
          h(
            "td",
            row.failures
              ? h("span", {
                  class: "tag tag-warn",
                  title: row.error ?? "a sample failed",
                  text: `⚠ ${row.failures} sample${
                    row.failures === 1 ? "" : "s"
                  } failed`,
                })
              : h("span", { class: "cell-dim", text: "ok" }),
            row.failures && row.error
              ? h("div", { class: "cell-dim mono ops-detail", text: row.error })
              : null,
          ),
          h(
            "td",
            { class: "metric-history" },
            pastRuns.length > 0
              ? sparkline(pastRuns, {
                  name: row.name,
                  unit,
                  basis: past?.basis,
                  currentRunId: options.currentRunId,
                  onOpen: options.onOpen,
                })
              : h("span", {
                  class: "cell-dim",
                  text: options.history
                    ? "no earlier runs with this metric"
                    : "…",
                }),
          ),
        ),
      );
    }
    return h(
      "div",
      { class: "metrics-view" },
      h("p", {
        class: "cell-dim",
        style: { marginTop: "0" },
        text: `What the config metrics: probes measured${
          doc?.environment ? ` on ${doc.environment}` : ""
        }. delta is after − before (for an every: probe, the last sample − the first). The chart plots the same value across this spec's runs, oldest first.`,
      }),
      h(
        "div",
        { class: "data-table-scroll" },
        h(
          "table",
          { class: "grid metrics-table" },
          h(
            "thead",
            h(
              "tr",
              [
                "metric",
                "before",
                "after",
                "delta",
                "series",
                "samples",
                "history",
              ].map((label) => h("th", { text: label })),
            ),
          ),
          body,
        ),
      ),
    );
  }

  /** @type {Partial<StudioGlobal>} */
  const published = {
    ops: {
      svg,
      formatMetric,
      badge,
      badges,
      exitBadge,
      lockHeadline,
      lockSentence,
      policyPanel,
      sparkline,
      metricsView,
    },
  };
  Object.assign(Studio, published);
})();
