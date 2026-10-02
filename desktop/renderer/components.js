/**
 * Shared view components.
 *
 * Small building blocks the views compose: page chrome, panels, status tags,
 * the artifact viewer (text / JSON / NDJSON / image), and a few formatters
 * bound to the shared `CairnFormat` helpers.
 */
(function bootComponents() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, api, fmt, toast } = Studio;

  /**
   * @param {string} title
   * @param {string | null} subtitle
   * @param {Array<Node | null> | null} [actions]
   */
  function pageHeader(title, subtitle, actions = []) {
    // `null` means "no actions" too (the Cohorts view passed it, and
    // `null.filter` crashed that view on open).
    const buttons = (actions ?? []).filter(Boolean);
    return h(
      "div",
      { class: "detail-head" },
      h(
        "div",
        { class: "title-block" },
        h("h1", { class: "view-title", text: title }),
        subtitle ? h("div", { class: "sub", text: subtitle }) : null,
      ),
      buttons.length ? h("div", { class: "detail-actions" }, buttons) : null,
    );
  }

  /**
   * @param {string} title
   * @param {Node | Node[] | string} body
   * @param {{ actions?: Array<Node | null>, tight?: boolean, className?: string }} [options]
   */
  function panel(title, body, options = {}) {
    return h(
      "section",
      { class: `panel ${options.className ?? ""}`.trim() },
      title || options.actions?.length
        ? h(
            "div",
            { class: "panel-head" },
            h("span", { class: "panel-title", text: title }),
            h(
              "div",
              { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
              (options.actions ?? []).filter(Boolean),
            ),
          )
        : null,
      h(
        "div",
        { class: `panel-body${options.tight ? " tight" : ""}` },
        Array.isArray(body) ? body : [body],
      ),
    );
  }

  /**
   * Paint a `.phase-banner` (Live cards, the Invocations detail). The phase
   * and item shorten with an ellipsis when the line is narrow, while the
   * elapsed time against the budget and a missing heartbeat stay visible;
   * the full line is the tooltip. Over budget and stale each get a class.
   * @param {HTMLElement} banner
   * @param {{ head?: string, detail?: string, text: string, stale?: boolean, budgetMs?: number | null, elapsedMs?: number | null } | null} phase
   *   `Studio.events.currentPhase(…)`, or null for the idle line
   * @param {string} [idleText] shown (dimmed) when there is no phase
   */
  function paintPhaseBanner(banner, phase, idleText = "") {
    let head = /** @type {HTMLElement | null} */ (
      banner.querySelector(":scope > .phase-head")
    );
    let detail = /** @type {HTMLElement | null} */ (
      banner.querySelector(":scope > .phase-detail")
    );
    if (!head || !detail) {
      head = h("span", { class: "phase-head" });
      detail = h("span", { class: "phase-detail" });
      banner.replaceChildren(head, detail);
    }
    const text = phase ? phase.text : idleText;
    head.textContent = phase ? (phase.head ?? phase.text) : idleText;
    detail.textContent = phase ? (phase.detail ?? "") : "";
    banner.title = text;
    const over = Boolean(
      phase?.budgetMs &&
        phase.elapsedMs !== null &&
        phase.elapsedMs !== undefined &&
        phase.elapsedMs > phase.budgetMs,
    );
    banner.classList.toggle("idle", !phase);
    banner.classList.toggle("over-budget", over);
    banner.classList.toggle("stale", Boolean(phase?.stale));
  }

  /**
   * @param {string | null | undefined} status
   */
  function statusTag(status) {
    const tone = fmt.statusTone(status);
    return h(
      "span",
      {
        class: `tag tag-${tone === "muted" ? "muted" : tone}`.replace(
          "tag-muted",
          "tag",
        ),
      },
      h("span", { class: `dot dot-${tone}` }),
      String(status ?? "unknown"),
    );
  }

  /**
   * @param {string} text
   * @param {{ tight?: boolean, className?: string }} [options]
   */
  function codeBlock(text, options = {}) {
    return h("pre", {
      class: `code${
        options.tight ? " tight" : ""
      } ${options.className ?? ""}`.trim(),
      text: String(text ?? ""),
    });
  }

  /**
   * A <video> streamed through the cairn-artifact:// protocol (range
   * requests, no data URLs). The URL is an opaque token main issued after
   * validating the path.
   * @param {string} runDir
   * @param {string} relativePath
   * @returns {Promise<Node>}
   */
  async function videoViewer(runDir, relativePath) {
    let media;
    try {
      media = await api.call("run:media-url", { runDir, path: relativePath });
    } catch (error) {
      return Studio.errorBox(error, relativePath);
    }
    return h(
      "figure",
      { class: "video-figure" },
      h("video", {
        src: media.url,
        controls: "controls",
        preload: "metadata",
      }),
      h(
        "figcaption",
        relativePath,
        h("div", { class: "spacer" }),
        revealButton(runDir, relativePath),
      ),
    );
  }

  /**
   * Trace artifacts are binary (Playwright zip) or Chrome trace JSON that
   * agent-browser may write under a .zip name — or empty. Never read as text.
   * @param {string} runDir
   * @param {string} relativePath
   * @param {string | null} [sensitivity] the manifest's label for it
   * @returns {Promise<Node>}
   */
  async function traceViewer(runDir, relativePath, sensitivity = null) {
    let info;
    try {
      info = await api.call("run:trace-info", { runDir, path: relativePath });
    } catch (error) {
      return Studio.errorBox(error, relativePath);
    }
    const openTrace = h("button", {
      class: "btn btn-sm btn-primary",
      type: "button",
      text: info.canShowTrace ? "Open trace" : "Reveal trace",
      title: info.canShowTrace
        ? "bunx playwright show-trace <file>"
        : "Show the file in Finder",
      onClick: async () => {
        try {
          const result = await api.call("run:open-trace", {
            runDir,
            path: relativePath,
          });
          toast(
            result.mode === "show-trace"
              ? "Opening Playwright trace viewer…"
              : "Trace revealed in Finder",
            null,
            "ok",
            2600,
          );
        } catch (error) {
          toast("Open trace failed", String(error?.message ?? error), "bad");
        }
      },
    });
    const hints = {
      "playwright-zip": info.canShowTrace
        ? "Playwright trace archive — opens in the Playwright trace viewer."
        : "Playwright trace archive — install Bun (bunx) to open it with playwright show-trace, or reveal it.",
      "chrome-trace-json":
        "Chrome trace JSON (agent-browser) — load it in Perfetto (ui.perfetto.dev) or chrome://tracing.",
      empty: "The trace file is empty: the backend recorded nothing.",
      unknown: "Unrecognized binary trace format.",
      missing: "Trace file is missing.",
    };
    return h(
      "div",
      { class: "trace-card" },
      h(
        "div",
        { class: "toolbar" },
        h("span", { class: "mono", text: relativePath }),
        Studio.tag(
          info.kind,
          info.kind === "empty" || info.kind === "missing" ? "warn" : "info",
        ),
        h("span", { class: "cell-dim", text: fmt.formatBytes(info.bytes) }),
        sensitivity ? sensitivityTag(sensitivity) : null,
        h("div", { class: "spacer" }),
        info.kind === "chrome-trace-json"
          ? h("button", {
              class: "btn btn-sm",
              type: "button",
              text: "Open Perfetto",
              onClick: () =>
                void api
                  .call("shell:open-external", "https://ui.perfetto.dev/")
                  .catch(() => {}),
            })
          : null,
        info.kind === "empty" || info.kind === "missing" ? null : openTrace,
        info.kind === "missing" ? null : revealButton(runDir, relativePath),
      ),
      h("p", { class: "cell-dim", text: hints[info.kind] ?? hints.unknown }),
    );
  }

  /**
   * A manifest `sensitivity` tag (sanitized trace, secret-bearing file)
   * whose tooltip says whether it is stashed or published.
   * @param {string} sensitivity
   * @returns {HTMLElement}
   */
  function sensitivityTag(sensitivity) {
    const known = Studio.events.SENSITIVITY[sensitivity];
    const node = Studio.tag(sensitivity, known?.tone ?? "muted");
    if (known) node.title = known.meaning;
    return node;
  }

  /**
   * A binary artifact: size + reveal, never decoded as text.
   * @param {string} runDir
   * @param {string} relativePath
   * @param {number} bytes
   * @param {string | null} [reason]
   */
  function binaryNotice(runDir, relativePath, bytes, reason) {
    return h(
      "div",
      { class: "toolbar binary-notice" },
      h("span", { class: "mono", text: relativePath }),
      Studio.tag("binary", "muted"),
      h("span", { class: "cell-dim", text: fmt.formatBytes(bytes) }),
      reason ? h("span", { class: "cell-dim", text: reason }) : null,
      h("div", { class: "spacer" }),
      revealButton(runDir, relativePath),
    );
  }

  /**
   * Per-spec history strip: the last N runs, oldest → newest, as status
   * cells whose height tracks duration. A first flakiness signal.
   * @param {Array<{ runId: string, status: string, durationMs: number | null, startedAt: string | null }>} entries newest first
   * @param {string | null} currentRunId
   * @param {(runId: string) => void} onOpen
   */
  function historyStrip(entries, currentRunId, onOpen) {
    const list = (entries ?? []).toReversed();
    const max = Math.max(1, ...list.map((entry) => entry.durationMs ?? 0));
    const passed = list.filter((entry) => entry.status === "passed").length;
    // A refused run never ran: it is not a flakiness signal.
    const refused = list.filter((entry) => entry.status === "refused").length;
    return h(
      "div",
      { class: "history" },
      h(
        "div",
        { class: "history-strip" },
        list.map((entry) =>
          h("button", {
            class: `history-cell history-${fmt.statusTone(entry.status)}${
              entry.runId === currentRunId ? " current" : ""
            }`,
            type: "button",
            title: `${entry.status} · ${fmt.formatDuration(entry.durationMs)} · ${fmt.formatTimestamp(entry.startedAt)}`,
            ariaLabel: `open run: ${entry.status}, ${fmt.formatDuration(entry.durationMs)}, ${fmt.formatTimestamp(entry.startedAt)}`,
            style: {
              height: `${Math.max(6, Math.round(((entry.durationMs ?? 0) / max) * 26))}px`,
            },
            onClick: () => onOpen(entry.runId),
          }),
        ),
      ),
      h("span", {
        class: "cell-dim",
        text: !list.length
          ? "no history"
          : list.length > refused
            ? `${passed}/${list.length - refused} passed${
                refused ? `, ${refused} refused` : ""
              } in the last ${list.length} runs`
            : `${refused} refused in the last ${list.length} runs`,
      }),
    );
  }

  /**
   * Render any artifact from a run directory, choosing the viewer by extension.
   * `journal: true` reads a text log from the run's invocation journal
   * instead (hook logs; the path is relative to the journal folder).
   * @param {string} runDir
   * @param {string} relativePath
   * @param {{ maxBytes?: number, journal?: boolean }} [options]
   * @returns {Promise<Node>}
   */
  async function artifactViewer(runDir, relativePath, options = {}) {
    const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
    if (options.journal)
      return textArtifact(runDir, relativePath, ext, options);
    if (ext === "webm" || ext === "mp4")
      return videoViewer(runDir, relativePath);
    if (ext === "zip" || relativePath.startsWith("traces/"))
      return traceViewer(runDir, relativePath);
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
      const image = await api.call("run:artifact-image", {
        runDir,
        path: relativePath,
      });
      if (!image?.ok)
        return Studio.errorBox(
          new Error(image?.error ?? "unreadable image"),
          relativePath,
        );
      return h(
        "figure",
        { class: "shot", style: { maxWidth: "100%", margin: "0" } },
        h("img", { src: image.dataUrl, alt: relativePath }),
        h(
          "figcaption",
          relativePath,
          h("span", {
            style: { marginLeft: "auto" },
            text: fmt.formatBytes(image.bytes),
          }),
        ),
      );
    }

    return textArtifact(runDir, relativePath, ext, options);
  }

  /**
   * @param {string} runDir
   * @param {string} relativePath
   * @param {string} ext
   * @param {{ maxBytes?: number, journal?: boolean }} options
   * @returns {Promise<Node>}
   */
  async function textArtifact(runDir, relativePath, ext, options) {
    const result = await api.call(
      options.journal ? "run:journal-text" : "run:artifact-text",
      { runDir, path: relativePath, maxBytes: options.maxBytes },
    );
    if (!result?.ok) {
      if (result?.binary)
        return binaryNotice(runDir, relativePath, result.bytes, result.error);
      return Studio.errorBox(
        new Error(result?.error ?? "unreadable artifact"),
        relativePath,
      );
    }

    const header = h(
      "div",
      { class: "toolbar", style: { marginBottom: "8px" } },
      h("span", {
        class: "mono",
        style: { fontSize: "11px", color: "var(--text-dim)" },
        text: relativePath,
      }),
      h("span", { class: "cell-dim", text: fmt.formatBytes(result.bytes) }),
      result.truncated ? Studio.tag("truncated", "warn") : null,
      h("div", { class: "spacer" }),
      copyButton(() => result.text ?? ""),
      // Reveal resolves inside the run folder; a journal log lives outside it.
      options.journal ? null : revealButton(runDir, relativePath),
    );

    if (ext === "json") {
      try {
        return h(
          "div",
          header,
          h("div", { class: "tree" }, Studio.jsonTree(JSON.parse(result.text))),
        );
      } catch {
        // fall through to the raw text view
      }
    }
    if (ext === "ndjson") return h("div", header, ndjsonView(result.text));
    if (ext === "md")
      return h("div", header, Studio.markdown.render(result.text));
    return h("div", header, codeBlock(result.text));
  }

  /**
   * @param {string} text
   */
  function ndjsonView(text) {
    const lines = String(text ?? "")
      .split("\n")
      .filter((line) => line.trim());
    const capped = lines.slice(-2000);
    return h(
      "div",
      { class: "log-pane", style: { maxHeight: "56vh" } },
      capped.map((line) => {
        let level = "info";
        let label = line;
        try {
          const parsed = JSON.parse(line);
          level = String(parsed.level ?? parsed.type ?? "info");
          label = formatNdjsonEntry(parsed);
        } catch {
          // keep the raw line
        }
        return h(
          "div",
          { class: `log-line level-${level.toLowerCase()}` },
          h("span", { class: "lvl", text: level.slice(0, 6) }),
          label,
        );
      }),
      lines.length > capped.length
        ? h("div", {
            class: "log-line",
            style: { color: "var(--text-faint)" },
            text: `… ${lines.length - capped.length} earlier lines hidden`,
          })
        : null,
    );
  }

  /**
   * @param {Record<string, any>} entry
   */
  function formatNdjsonEntry(entry) {
    const stamp = entry.ts ?? entry.timestamp ?? "";
    const scope = entry.scope ? `${entry.scope} › ` : "";
    const message = entry.msg ?? entry.message ?? JSON.stringify(entry);
    const time = stamp ? `${String(stamp).slice(11, 23)} ` : "";
    return `${time}${scope}${fmt.oneLine(String(message))}`;
  }

  /**
   * @param {() => string} getText
   */
  function copyButton(getText) {
    return h("button", {
      class: "btn btn-sm btn-ghost",
      type: "button",
      text: "Copy",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(getText());
          toast("Copied to clipboard", null, "ok", 1800);
        } catch (error) {
          toast("Copy failed", String(error?.message ?? error), "bad");
        }
      },
    });
  }

  /**
   * @param {string} runDir
   * @param {string} [relativePath]
   */
  function revealButton(runDir, relativePath) {
    return h("button", {
      class: "btn btn-sm btn-ghost",
      type: "button",
      text: "Reveal",
      title: "Show in Finder",
      onClick: () =>
        api
          .call("run:reveal", runDir, relativePath ?? null)
          .catch((error) =>
            toast("Reveal failed", String(error?.message ?? error), "bad"),
          ),
    });
  }

  /**
   * A labeled checkbox bound to a settings path.
   * @param {string} label
   * @param {boolean} checked
   * @param {(checked: boolean) => void} onChange
   * @param {string} [title]
   */
  function checkbox(label, checked, onChange, title) {
    return h(
      "label",
      { class: "check", title: title ?? null },
      h("input", {
        type: "checkbox",
        checked: Boolean(checked),
        onChange: (event) =>
          onChange(/** @type {HTMLInputElement} */ (event.target).checked),
      }),
      label,
    );
  }

  // ── keyboard, time, and status helpers shared by the views ───────────────

  /**
   * Arrow-key navigation inside a composite widget (nav, tab strip, list,
   * table body). `items()` returns the focusable items in order; Up/Down
   * (Left/Right when horizontal) move focus, Home/End jump to the ends, and
   * Enter/Space on an item itself call `onActivate`. With `roving`, only the
   * focused item stays in the Tab order (tabindex 0, the rest -1), so Tab
   * leaves the widget instead of walking every row.
   * @param {HTMLElement} container
   * @param {{
   *   items: () => HTMLElement[],
   *   orientation?: "vertical" | "horizontal",
   *   roving?: boolean,
   *   onMove?: (item: HTMLElement) => void,
   *   onActivate?: (item: HTMLElement) => void,
   * }} options
   */
  function rovingKeys(container, options) {
    const horizontal = options.orientation === "horizontal";
    container.addEventListener("keydown", (event) => {
      const items = options
        .items()
        .filter(
          (item) =>
            !item.hasAttribute("disabled") &&
            !item.classList.contains("hidden"),
        );
      if (!items.length) return;
      const active = document.activeElement;
      const current = items.findIndex(
        (item) => item === active || (active && item.contains(active)),
      );
      if (current < 0) return;
      const onItem = items[current] === event.target;
      if ((event.key === "Enter" || event.key === " ") && onItem) {
        if (!options.onActivate) return;
        event.preventDefault();
        options.onActivate(items[current]);
        return;
      }
      /** @type {HTMLElement | undefined} */
      let target;
      if (event.key === (horizontal ? "ArrowLeft" : "ArrowUp"))
        target = items[Math.max(0, current - 1)];
      else if (event.key === (horizontal ? "ArrowRight" : "ArrowDown"))
        target = items[Math.min(items.length - 1, current + 1)];
      else if (event.key === "Home") target = items[0];
      else if (event.key === "End") target = items.at(-1);
      else return;
      // Arrow keys inside a text field belong to the field.
      const tagName = /** @type {HTMLElement} */ (event.target)?.tagName;
      if (!onItem && /^(INPUT|SELECT|TEXTAREA)$/.test(tagName ?? "")) return;
      event.preventDefault();
      if (!target || target === items[current]) return;
      if (options.roving) {
        for (const item of items) item.setAttribute("tabindex", "-1");
        target.setAttribute("tabindex", "0");
      }
      target.focus();
      options.onMove?.(target);
    });
  }

  /**
   * Make one item of a roving list the Tab stop (the selected one, else the
   * first), so keyboard users land on the current row.
   * @param {HTMLElement[]} items
   * @param {HTMLElement | null | undefined} [preferred]
   */
  function setRovingStop(items, preferred) {
    const stop = preferred ?? items[0] ?? null;
    for (const item of items)
      item.setAttribute("tabindex", item === stop ? "0" : "-1");
  }

  /**
   * A relative timestamp ("3m ago") with the absolute time as its tooltip.
   * Every `time.rel-time` in the document is refreshed by app.js, so the
   * same moment reads the same in every view and never goes stale.
   * @param {string | number | Date | null | undefined} value
   * @param {{ prefix?: string, className?: string }} [options]
   * @returns {HTMLElement}
   */
  function relTime(value, options = {}) {
    const ms =
      value instanceof Date
        ? value.getTime()
        : typeof value === "number"
          ? value
          : Date.parse(String(value ?? ""));
    if (!Number.isFinite(ms))
      return h("span", { class: options.className ?? "cell-dim", text: "—" });
    const iso = new Date(ms).toISOString();
    return h("time", {
      class: `rel-time ${options.className ?? ""}`.trim(),
      datetime: iso,
      title: fmt.formatTimestamp(iso),
      dataset: { rel: String(ms), prefix: options.prefix ?? "" },
      text: `${options.prefix ?? ""}${fmt.relativeTime(ms)}`,
    });
  }

  /**
   * Refresh every relative timestamp under `root`.
   * @param {ParentNode} [root]
   * @param {number} [now]
   */
  function refreshRelativeTimes(root = document, now = Date.now()) {
    const date = new Date(now);
    for (const node of root.querySelectorAll("time.rel-time[data-rel]")) {
      const element = /** @type {HTMLElement} */ (node);
      const ms = Number(element.dataset.rel);
      if (!Number.isFinite(ms)) continue;
      const text = `${element.dataset.prefix ?? ""}${fmt.relativeTime(ms, date)}`;
      if (element.textContent !== text) element.textContent = text;
    }
  }

  /**
   * Who launched an invocation: "CLI" (a terminal or a launcher), "MCP" with
   * the agent's client name, or Studio when one of this app's runs owns the
   * pid. Null when the journal predates the field and nothing else says.
   * @param {{ origin?: string | null, client?: string | null } | null | undefined} journal
   * @param {{ fromApp?: boolean }} [options]
   * @returns {HTMLElement | null}
   */
  function originBadge(journal, options = {}) {
    const origin = journal?.origin ?? null;
    const client = journal?.client ?? null;
    if (!origin && !options.fromApp) return null;
    const label =
      origin === "mcp"
        ? `MCP agent${client ? ` · ${client}` : ""}`
        : origin === "cli" || !origin
          ? options.fromApp
            ? "Studio"
            : "CLI"
          : `${origin}${client ? ` · ${client}` : ""}`;
    return h("span", {
      class: `tag origin-tag origin-${
        origin === "mcp" ? "mcp" : options.fromApp ? "app" : "cli"
      }`,
      title:
        origin === "mcp"
          ? `started by an agent through the cairn MCP server${
              client ? ` (client: ${client})` : ""
            }`
          : options.fromApp
            ? "started from this app"
            : origin === "cli"
              ? "started with the cairn CLI (terminal, script, or launcher)"
              : `origin: ${origin}`,
      text: label,
    });
  }

  /**
   * A liveness verdict (lib/events.js classifyLiveness) as a short tag, or
   * null when it adds nothing (finished).
   * @param {{ state?: string, reason?: string, heartbeatAgeMs?: number | null } | null | undefined} liveness
   * @returns {HTMLElement | null}
   */
  function livenessTag(liveness) {
    if (!liveness?.state || liveness.state === "finished") return null;
    /** @type {Record<string, [string, string]>} */
    const map = {
      running: [
        liveness.reason === "heartbeat"
          ? "alive · heartbeat"
          : liveness.reason === "recent writes"
            ? "recent writes · no heartbeat"
            : "alive · pid",
        "ok",
      ],
      quiet: ["quiet · pid alive", "warn"],
      dead: ["process gone", "bad"],
      interrupted: ["no recent activity", "warn"],
      stale: ["stale", "warn"],
    };
    const [text, tone] = map[liveness.state] ?? [liveness.state, "muted"];
    const node = Studio.tag(text, tone);
    node.title = liveness.reason ?? "";
    return node;
  }

  /**
   * The "what to do next" banner when Studio cannot work yet: no cairn
   * binary resolved, or no project open. Null when both are fine.
   * @returns {HTMLElement | null}
   */
  function setupNotice() {
    const state = Studio.state;
    if (!state?.booted && !state?.info) return null;
    const noCairn = state.info && !state.info.cairn?.command;
    // Without an explicit project Studio falls back to its own checkout (or
    // home); only that fallback without a cairntrace config counts as "none".
    const noProject =
      !state.project?.dir ||
      (!state.settings?.activeProject && !state.project?.configPath);
    if (!noCairn && !noProject) return null;
    return h(
      "div",
      { class: "setup-notice", role: "status" },
      noCairn
        ? h(
            "div",
            { class: "setup-row" },
            h("strong", { text: "cairn binary not found." }),
            h("span", {
              text: " Install cairn (it must be on PATH, or in this checkout's bin/), or point Studio at it.",
            }),
            h("button", {
              class: "btn btn-sm btn-primary",
              type: "button",
              text: "Set cairn binary…",
              onClick: () => Studio.navigate("settings"),
            }),
          )
        : null,
      noProject
        ? h(
            "div",
            { class: "setup-row" },
            h("strong", { text: "No project open." }),
            h("span", {
              text: " Open the folder that holds cairntrace.config.yml and your specs.",
            }),
            h("button", {
              class: "btn btn-sm btn-primary",
              type: "button",
              text: "Open project…",
              onClick: () => Studio.emit("menu:open-project"),
            }),
          )
        : null,
    );
  }

  // ── evidence: stash, publish, pin, refusal ───────────────────────────────

  /**
   * A run's stash state as a tag (status, reason code, secret findings), with
   * every fact in its tooltip (lib/events.js stashLines). Null without one.
   * @param {Record<string, any> | null | undefined} stash
   * @returns {HTMLElement | null}
   */
  function stashTag(stash) {
    const badge = Studio.events.stashBadge(stash);
    if (!badge) return null;
    return h("span", {
      class: `tag tag-${badge.tone} stash-tag`,
      title: badge.title,
      text: badge.text,
    });
  }

  /**
   * A run's publish state (receipt or `artifact.publish`) as a tag.
   * @param {Record<string, any> | null | undefined} publish
   * @returns {HTMLElement | null}
   */
  function publishTag(publish) {
    const badge = Studio.events.publishBadge(publish);
    if (!badge) return null;
    return h("span", {
      class: `tag tag-${badge.tone} publish-tag`,
      title: badge.title,
      text: badge.text,
    });
  }

  /**
   * "pinned" (retention keeps the run), with when and why in the tooltip.
   * @param {{ at?: string | null, reason?: string | null } | null | undefined} pinned
   * @returns {HTMLElement | null}
   */
  function pinTag(pinned) {
    if (!pinned) return null;
    return h("span", {
      class: "tag tag-pin",
      title: [
        "pinned: retention never prunes this run (cairn unpin to release it)",
        pinned.at ? `since ${fmt.formatTimestamp(pinned.at)}` : null,
        pinned.reason ? `reason: ${pinned.reason}` : null,
      ]
        .filter(Boolean)
        .join("\n"),
      text: "pinned",
    });
  }

  /**
   * Facts as a compact list (the evidence panel's stash/publish lines).
   * @param {string[]} lines
   * @returns {HTMLElement}
   */
  function evidenceLines(lines) {
    return h(
      "ul",
      { class: "evidence-lines" },
      (lines ?? []).map((line) => {
        const warn = /^(secrets found|left out|reason|message):/.test(line);
        return h("li", { class: warn ? "warn" : null, text: line });
      }),
    );
  }

  /**
   * Why the environment policy refused a run: environment, reason, and the
   * spec's `requires`. Styled apart from failures (nothing ran).
   * @param {{ reason?: string | null, env?: string | null, requiresText?: string | null } | null | undefined} refusal
   * @param {{ summary?: string | null }} [options]
   * @returns {HTMLElement}
   */
  function refusalBox(refusal, options = {}) {
    return h(
      "div",
      { class: "refusal-box", role: "note" },
      h("strong", {
        text: `refused by the environment policy${
          refusal?.env ? ` on ${refusal.env}` : ""
        }`,
      }),
      h("div", {
        class: "refusal-reason",
        text:
          refusal?.reason ??
          options.summary ??
          "the run record names no reason",
      }),
      refusal?.requiresText
        ? h("div", {
            class: "mono refusal-requires",
            text: `requires: ${refusal.requiresText}`,
          })
        : null,
      h("div", {
        class: "cell-dim",
        text: "Nothing ran: no services, preconditions, or browser started. Pick an environment the spec allows (Specs view) or change requires / the environment policy.",
      }),
    );
  }

  // ── wave 4: structured evidence (datasources, polls, gates, fixtures) ────

  /**
   * What a bounded evidence table left out: rows past the bound, fields past
   * the column cap. Studio's own display cap (`cutBy: "studio"`) is told
   * apart from the runner's evidence bound.
   * @param {StudioTable} table
   * @returns {string | null}
   */
  function tableNote(table) {
    const parts = [];
    const unit = table.unit || "rows";
    const byStudio = table.cutBy === "studio";
    if (
      table.total !== null &&
      table.total !== undefined &&
      table.total > table.shown
    )
      parts.push(
        byStudio
          ? `showing the first ${table.shown} of ${table.total} ${unit} (Studio lists at most ${table.shown}; see the raw file)`
          : `showing ${table.shown} of ${table.total} ${unit} (evidence keeps at most 20)`,
      );
    else if (table.truncated)
      parts.push(
        byStudio
          ? `showing the first ${table.shown} ${unit} (Studio's display cap)`
          : `truncated: the evidence keeps at most 20 ${unit} of at most 4KB each`,
      );
    if (table.hiddenColumns)
      parts.push(
        `+${table.hiddenColumns} more field${
          table.hiddenColumns === 1 ? "" : "s"
        } not shown (see the raw sidecar)`,
      );
    return parts.length ? parts.join(" · ") : null;
  }

  /**
   * A bounded evidence table: datasource rows, a captured or probed table,
   * matching requests. Cells are one line; the full cell is its tooltip.
   * @param {StudioTable | null | undefined} table
   * @returns {HTMLElement | null}
   */
  function dataTable(table) {
    if (!table || !Array.isArray(table.columns) || !table.columns.length)
      return null;
    const note = tableNote(table);
    return h(
      "div",
      { class: "data-table-wrap" },
      h(
        "div",
        { class: "data-table-scroll" },
        h(
          "table",
          { class: "grid data-table" },
          h(
            "thead",
            h(
              "tr",
              table.columns.map((column) => h("th", { text: column })),
            ),
          ),
          h(
            "tbody",
            table.rows.length
              ? table.rows.map((row) =>
                  h(
                    "tr",
                    row.map((value) =>
                      h("td", { class: "mono", title: value, text: value }),
                    ),
                  ),
                )
              : h(
                  "tr",
                  h("td", {
                    class: "cell-dim",
                    colSpan: table.columns.length,
                    text: `no ${table.unit || "rows"}`,
                  }),
                ),
          ),
        ),
      ),
      note ? h("div", { class: "cell-dim data-note", text: note }) : null,
    );
  }

  /**
   * A poll's attempt log: each attempt's verdict, offset and summary. The
   * runner keeps the first 5 and the last 15 attempts; when the count says
   * more ran, the gap is marked where they were dropped.
   * @param {Array<{ ok: boolean, summary: string, offsetMs?: number | null, at?: string | null }> | null | undefined} attempts
   * @param {{ count?: number | null, polledMs?: number | null, title?: string }} [options]
   * @returns {HTMLElement | null}
   */
  function attemptsTimeline(attempts, options = {}) {
    const list = Array.isArray(attempts) ? attempts : [];
    const count = options.count ?? null;
    if (!list.length && !count) return null;
    const omitted =
      count !== null && count > list.length ? count - list.length : 0;
    const gapAt = omitted ? Math.min(5, list.length) : -1;
    const rows = [];
    list.forEach((attempt, index) => {
      if (index === gapAt)
        rows.push(
          h("div", {
            class: "attempt-row attempt-gap cell-dim",
            text: `… ${omitted} attempt${
              omitted === 1 ? "" : "s"
            } not kept (the evidence keeps the first 5 and the last 15)`,
          }),
        );
      const number = index + 1 + (gapAt >= 0 && index >= gapAt ? omitted : 0);
      rows.push(
        h(
          "div",
          {
            class: `attempt-row attempt-${attempt.ok ? "ok" : "bad"}`,
            title: attempt.at ?? "",
          },
          h("span", { class: `dot dot-${attempt.ok ? "ok" : "bad"}` }),
          h("span", { class: "attempt-n mono", text: `#${number}` }),
          h("span", {
            class: "attempt-at cell-dim mono",
            text:
              attempt.offsetMs === null || attempt.offsetMs === undefined
                ? ""
                : `+${fmt.formatDuration(attempt.offsetMs)}`,
          }),
          h("span", { class: "attempt-summary", text: attempt.summary || "" }),
        ),
      );
    });
    if (gapAt === list.length && omitted)
      rows.push(
        h("div", {
          class: "attempt-row attempt-gap cell-dim",
          text: `… ${omitted} attempt${omitted === 1 ? "" : "s"} not kept`,
        }),
      );
    const total = count ?? list.length;
    return h(
      "div",
      { class: "attempts" },
      h("div", {
        class: "section-title attempts-title",
        text: `${options.title ?? "Poll attempts"} · ${total} attempt${
          total === 1 ? "" : "s"
        }${
          options.polledMs === null || options.polledMs === undefined
            ? ""
            : ` over ${fmt.formatDuration(options.polledMs)}`
        }`,
      }),
      rows.length ? h("div", { class: "attempt-list" }, rows) : null,
    );
  }

  /**
   * Structured verifier evidence (lib/dataEvidence.js `normalizeRawEvidence`):
   * the source it read (never a connection string), key facts, the observed
   * rows as a table or the observed value, the request, and the attempts.
   * @param {StudioDataEvidence | null | undefined} data
   * @param {{ count?: number | null, polledMs?: number | null }} [options]
   *   attempts / polledMs from the outcome's events, when the raw file has none
   * @returns {HTMLElement | null}
   */
  function dataEvidenceView(data, options = {}) {
    if (!data) return null;
    const facts = data.facts ?? [];
    const count = data.attemptCount ?? options.count ?? null;
    // The kind tag already names the kind: the source line starts at its name.
    const sourceText = data.source
      ? data.source.text.startsWith(`${data.kind} `)
        ? data.source.text.slice(data.kind.length + 1)
        : data.source.text
      : null;
    const polledMs = data.polledMs ?? options.polledMs ?? null;
    return h(
      "div",
      { class: "data-evidence", dataset: { kind: data.kind } },
      h(
        "div",
        {
          class: "data-source",
          title: (data.source?.facts ?? [])
            .map(([key, value]) => `${key}: ${value}`)
            .join("\n"),
        },
        Studio.tag(data.kind, "info"),
        sourceText ? h("span", { class: "mono", text: sourceText }) : null,
        data.truncated ? Studio.tag("truncated", "warn") : null,
      ),
      facts.length ? Studio.keyValue(facts) : null,
      data.note
        ? h("p", { class: "cell-dim data-note", text: data.note })
        : null,
      dataTable(data.table),
      data.value ? codeBlock(data.value, { tight: true }) : null,
      data.request
        ? h(
            "details",
            { class: "data-request" },
            h("summary", { class: "cell-dim", text: "request" }),
            codeBlock(data.request, { tight: true }),
          )
        : null,
      attemptsTimeline(data.attempts, { count, polledMs }),
    );
  }

  /**
   * `[key, value]` outputs (fixture outputs; masked by main and the
   * reducer) as a compact key/value list.
   * @param {Array<[string, string]> | null | undefined} entries
   * @returns {HTMLElement | null}
   */
  function outputsList(entries) {
    if (!Array.isArray(entries) || !entries.length) return null;
    return h(
      "dl",
      { class: "outputs-list" },
      entries.flatMap(([key, value]) => [
        h("dt", { class: "mono", text: key }),
        h("dd", { class: "mono", title: value, text: value }),
      ]),
    );
  }

  // Typed against globals.d.ts: a member missing there, or one whose
  // signature drifted from its declaration, fails the renderer typecheck.
  /** @type {Partial<StudioGlobal>} */
  const published = {
    dataTable,
    attemptsTimeline,
    dataEvidenceView,
    outputsList,
    stashTag,
    publishTag,
    pinTag,
    evidenceLines,
    refusalBox,
    rovingKeys,
    setRovingStop,
    relTime,
    refreshRelativeTimes,
    originBadge,
    livenessTag,
    setupNotice,
    pageHeader,
    panel,
    paintPhaseBanner,
    statusTag,
    codeBlock,
    artifactViewer,
    videoViewer,
    traceViewer,
    sensitivityTag,
    binaryNotice,
    historyStrip,
    ndjsonView,
    copyButton,
    revealButton,
    checkbox,
  };
  Object.assign(Studio, published);
})();
