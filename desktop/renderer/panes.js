/**
 * Streaming panes shared by the Live and Invocations views.
 *
 * - `createFollowPane` — a scrollable line pane that follows the bottom while
 *   the reader is there, keeps a bounded number of line nodes, and offers
 *   "jump to latest" once they scroll up (no re-render, so scroll survives).
 * - `createOutputPanel` — a tab strip of such panes (events, announced log
 *   files, fallbacks), keyboard-navigable as an ARIA tablist.
 * - `pollFileSource` — appends what a log file grew by since the last poll,
 *   through the main process's offset readers (`run:tail-text` for a run
 *   directory, `invocation:tail-text` for an invocation journal).
 *
 * Everything is built with `Studio.h`; no markup is ever parsed.
 */
(function bootPanes() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, fmt } = Studio;

  /** Lines kept in a windowed pane; older ones are dropped from the DOM. */
  const MAX_PANE_LINES = 500;
  /** Characters of a partial (unterminated) log line kept per source. */
  const MAX_TAIL_CHARS = 64 * 1024;

  let paneCounter = 0;

  /**
   * Is a scroll container (within slack) at its bottom?
   * @param {{ scrollTop: number, scrollHeight: number, clientHeight: number }} metrics
   * @param {number} [slack]
   */
  function isNearBottom(metrics, slack = 24) {
    return (
      metrics.scrollHeight - metrics.scrollTop - metrics.clientHeight <= slack
    );
  }

  /**
   * Split appended log text into lines, carrying a partial last line.
   * @param {string} carry
   * @param {string} chunk
   * @returns {{ lines: string[], carry: string }}
   */
  function splitChunk(carry, chunk) {
    const text = `${carry}${chunk}`;
    const parts = text.split(/\r?\n/);
    const rest = parts.pop() ?? "";
    return { lines: parts, carry: rest };
  }

  /**
   * @param {string} text
   * @param {string} [className]
   * @returns {HTMLElement}
   */
  function line(text, className = "") {
    return h("div", { class: `log-line ${className}`.trim(), text });
  }

  /**
   * One described event as a pane line.
   * @param {Record<string, any>} event
   * @returns {HTMLElement}
   */
  function eventLine(event) {
    const described = Studio.events.describeEvent(event);
    const tone =
      described.tone === "bad"
        ? "level-error"
        : described.tone === "warn"
          ? "level-warn"
          : described.tone === "muted"
            ? "level-debug"
            : described.tone === "refused"
              ? "level-refused"
              : "";
    return h(
      "div",
      { class: `log-line ${tone}`.trim() },
      h("span", { class: "lvl", text: described.category.slice(0, 6) }),
      event?.ts ? `${String(event.ts).slice(11, 23)} ` : "",
      described.label,
      described.detail
        ? h("span", { class: "detail", text: ` — ${described.detail}` })
        : null,
    );
  }

  /**
   * One cairn NDJSON stderr log entry as a pane line.
   * @param {Record<string, any>} entry
   * @returns {HTMLElement}
   */
  function logLine(entry) {
    return h(
      "div",
      {
        class: `log-line level-${String(entry?.level ?? "info").toLowerCase()}`,
      },
      h("span", {
        class: "lvl",
        text: String(entry?.level ?? "log").slice(0, 6),
      }),
      entry?.ts ? `${String(entry.ts).slice(11, 23)} ` : "",
      entry?.scope ? `${entry.scope} › ` : "",
      fmt.oneLine(String(entry?.msg ?? JSON.stringify(entry))),
    );
  }

  /**
   * @typedef {{
   *   el: HTMLElement,
   *   pane: HTMLElement,
   *   append: (nodes: Node[]) => void,
   *   reset: () => void,
   *   setVisible: (visible: boolean) => void,
   * }} FollowPane
   */

  /**
   * A scrollable line pane that auto-follows at the bottom, keeps at most
   * MAX_PANE_LINES nodes, and shows "jump to latest" when scrolled up.
   * @param {{ className?: string, empty?: string, label?: string }} [options]
   * @returns {FollowPane}
   */
  function createFollowPane(options = {}) {
    const pane = h("div", {
      class: `log-pane ${options.className ?? ""}`.trim(),
      // A log region the reader can scroll with the keyboard; announcing
      // every appended line would drown a screen reader, so it stays quiet.
      role: "log",
      ariaLive: "off",
      ariaLabel: options.label ?? "output",
      tabindex: "0",
    });
    const placeholder = h("div", {
      class: "log-line log-empty",
      text: options.empty ?? "nothing yet",
    });
    pane.appendChild(placeholder);
    const jump = h("button", {
      class: "btn btn-sm jump-latest hidden",
      type: "button",
      ariaLabel: "jump to the latest output",
      text: "↓ jump to latest",
    });
    const wrap = h("div", { class: "follow-wrap" }, pane, jump);
    let pinned = true;
    let unseen = 0;
    const hideJump = () => {
      unseen = 0;
      jump.classList.add("hidden");
    };
    pane.addEventListener("scroll", () => {
      pinned = isNearBottom(pane);
      if (pinned) hideJump();
    });
    jump.addEventListener("click", () => {
      pane.scrollTop = pane.scrollHeight;
      pinned = true;
      hideJump();
      pane.focus();
    });
    return {
      el: wrap,
      pane,
      append(nodes) {
        if (!nodes.length) return;
        if (placeholder.parentNode) placeholder.remove();
        const fragment = document.createDocumentFragment();
        for (const node of nodes) fragment.appendChild(node);
        pane.appendChild(fragment);
        if (pane.childElementCount > MAX_PANE_LINES) {
          const before = pane.scrollHeight;
          while (pane.childElementCount > MAX_PANE_LINES)
            pane.removeChild(/** @type {Node} */ (pane.firstChild));
          // Keep the reader's place when lines above them were dropped.
          if (!pinned) pane.scrollTop -= before - pane.scrollHeight;
        }
        if (pinned) pane.scrollTop = pane.scrollHeight;
        else {
          unseen += nodes.length;
          jump.textContent = `↓ ${unseen} new — jump to latest`;
          jump.classList.remove("hidden");
        }
      },
      reset() {
        Studio.clear(pane);
        pane.appendChild(placeholder);
        pinned = true;
        hideJump();
      },
      setVisible(visible) {
        wrap.classList.toggle("hidden", !visible);
        if (visible && pinned) pane.scrollTop = pane.scrollHeight;
      },
    };
  }

  /**
   * @typedef {{
   *   id: string,
   *   label: string,
   *   pane: FollowPane,
   *   tab: HTMLElement,
   *   offset: number,
   *   carry: string,
   *   fetched: boolean,
   *   file?: string,
   *   inFlight?: boolean,
   *   errorShown?: boolean,
   *   final?: boolean,
   * }} OutputSource
   */

  /**
   * A tabbed output panel: one tab + follow pane per source (events, a log
   * file, a static fallback). The tab strip is an ARIA tablist: arrow keys
   * move between tabs, Home/End jump to the ends.
   * @param {{ title?: string | null }} [options]
   * @returns {{ el: HTMLElement, sources: Map<string, OutputSource>, addSource: (id: string, label: string, extra?: Record<string, any>) => OutputSource, select: (id: string) => void, selected: () => string | null }}
   */
  function createOutputPanel(options = {}) {
    paneCounter += 1;
    const prefix = `out${paneCounter}`;
    const tabs = h("div", {
      class: "mini-tabs",
      role: "tablist",
      ariaLabel: options.title ?? "output",
    });
    const panes = h("div", { class: "output-panes" });
    const root = h(
      "div",
      { class: "output-panel" },
      options.title === null
        ? null
        : h(
            "div",
            { class: "section-title", style: { marginTop: "0" } },
            options.title ?? "Output",
          ),
      tabs,
      panes,
    );
    /** @type {Map<string, OutputSource>} */
    const sources = new Map();
    /** @type {string | null} */
    let selected = null;

    /**
     * @param {string} id
     * @param {string} label
     * @param {Record<string, any>} [extra]
     * @returns {OutputSource}
     */
    function addSource(id, label, extra = {}) {
      const existing = sources.get(id);
      if (existing) return existing;
      const index = sources.size;
      const pane = createFollowPane({
        empty: extra.file ? "waiting for output…" : "nothing yet",
        label: `${label} output`,
      });
      pane.setVisible(false);
      pane.el.id = `${prefix}-panel-${index}`;
      pane.el.setAttribute("role", "tabpanel");
      const tab = h("button", {
        class: "mini-tab",
        type: "button",
        role: "tab",
        id: `${prefix}-tab-${index}`,
        ariaSelected: "false",
        ariaControls: pane.el.id,
        tabindex: "-1",
        text: label,
        title: extra.file ?? label,
        onClick: () => select(id),
      });
      pane.el.setAttribute("aria-labelledby", tab.id);
      /** @type {OutputSource} */
      const source = {
        id,
        label,
        pane,
        tab,
        offset: 0,
        carry: "",
        fetched: false,
        ...extra,
      };
      sources.set(id, source);
      tabs.appendChild(tab);
      panes.appendChild(pane.el);
      if (!selected) select(id);
      return source;
    }

    /** @param {string} id */
    function select(id) {
      selected = id;
      for (const source of sources.values()) {
        const on = source.id === id;
        source.tab.classList.toggle("active", on);
        source.tab.setAttribute("aria-selected", on ? "true" : "false");
        source.tab.setAttribute("tabindex", on ? "0" : "-1");
        source.pane.setVisible(on);
      }
    }

    Studio.rovingKeys(tabs, {
      items: () => [...sources.values()].map((source) => source.tab),
      orientation: "horizontal",
      onMove: (/** @type {HTMLElement} */ tab) => {
        const source = [...sources.values()].find((entry) => entry.tab === tab);
        if (source) select(source.id);
      },
    });

    return {
      el: root,
      sources,
      addSource,
      select,
      selected: () => selected,
    };
  }

  /**
   * Fetch what a log file grew by since the last poll.
   * @param {OutputSource} source
   * @param {{ runDir?: string | null, invocationId?: string | null }} where
   * @returns {Promise<void>}
   */
  async function pollFileSource(source, where) {
    if (source.inFlight) return;
    source.inFlight = true;
    try {
      const result = where.invocationId
        ? await Studio.api.call("invocation:tail-text", {
            invocationId: where.invocationId,
            path: source.file,
            offset: source.offset,
          })
        : await Studio.api.call("run:tail-text", {
            runDir: where.runDir,
            path: source.file,
            offset: source.offset,
          });
      source.fetched = true;
      if (!result?.ok) {
        if (result?.error && !source.errorShown) {
          source.errorShown = true;
          source.pane.append([line(result.error, "level-warn")]);
        }
        return;
      }
      if (result.reset || (result.skipped && source.offset > 0)) {
        source.pane.append([
          line(
            result.reset ? "— log restarted —" : "— earlier output skipped —",
            "level-debug",
          ),
        ]);
        source.carry = "";
      }
      source.offset = result.offset;
      if (!result.text) return;
      const split = splitChunk(source.carry, result.text);
      source.carry =
        split.carry.length > MAX_TAIL_CHARS
          ? split.carry.slice(-MAX_TAIL_CHARS)
          : split.carry;
      source.pane.append(split.lines.map((text) => line(text)));
    } catch {
      // the next poll retries
    } finally {
      source.inFlight = false;
    }
  }

  /**
   * Flush a source's carried partial line (a finished log that does not end
   * with a newline still shows its last line).
   * @param {OutputSource} source
   */
  function flushCarry(source) {
    if (!source.carry) return;
    source.pane.append([line(source.carry)]);
    source.carry = "";
  }

  Studio.panes = {
    MAX_PANE_LINES,
    isNearBottom,
    splitChunk,
    line,
    eventLine,
    logLine,
    createFollowPane,
    createOutputPanel,
    pollFileSource,
    flushCarry,
  };
})();
