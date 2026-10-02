/**
 * Sessions view — discovery and accompany sessions, as an agent explores.
 *
 * `cairn discover` (CLI) and the `cairn_discover_*` MCP tools journal every
 * session at `<artifactRoot>/_sessions/<sessionId>/`: `session.json`
 * (identity, start URL, status, TTL), `events.ndjson` (action.performed,
 * step.recorded / step.removed, snapshot.captured, draft.updated,
 * export.written, session.closed), a screenshot, an accessibility snapshot
 * and a network log per action, and `draft.spec.yml`, regenerated after
 * every recorded step. The CLI redacts all of it before it reaches disk.
 *
 * Master/detail like Invocations. The list (an ARIA listbox) shows kind,
 * origin, status, start URL, age and liveness (pid + last activity + TTL,
 * judged by main). The detail tails the journal with the offset reader:
 * the action timeline (ok/error, URL changes, network mutations), a large
 * preview of the latest screenshot with clickable thumbnails, the selected
 * action's accessibility snapshot and network log (collapsible, loaded on
 * demand), the recorded steps, the draft with a diff since the previous
 * `draft.updated`, and the exports with their verify findings.
 *
 * Actions spawn the CLI: **Export draft** re-exports a session the agent
 * already exported (`cairn discover export --from-session <dir> --intent …
 * --outcomes … --json`, with the contract session.json kept from that
 * export), and **Promote** on an exported draft (`cairn spec promote <draft>
 * --json`, after a native dialog that shows the intent and every outcome
 * with its verify parameters). Nothing here edits a journal or a spec.
 */
(function bootSessionsView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, api, fmt, toast } = Studio;

  /** Journals listed (newest first). */
  const LIST_LIMIT = 50;
  /** How often the list re-reads session.json files. */
  const LIST_POLL_MS = 2500;
  /** How often the selected session's events are tailed. */
  const DETAIL_POLL_MS = 1000;
  /** Offset reads per poll before yielding (a long journal catches up). */
  const MAX_EVENT_READS = 8;
  /** Why Export draft waits for the agent's first export. */
  const EXPORT_FIRST_TITLE =
    "Not exported yet: the first export names the intent and outcomes, so it comes from the agent (cairn_discover_export, or cairn discover export --from-session … --intent … --outcomes …). Studio re-exports with that contract afterwards.";
  /** Thumbnails in the strip (the timeline reaches the older ones). */
  const MAX_THUMBS = 16;
  /** Screenshot URLs a detail keeps. */
  const MAX_IMAGE_CACHE = 200;
  /** Above this many LCS cells the diff shows a plain replace block. */
  const DIFF_CELL_LIMIT = 2_000_000;
  /** Unchanged lines kept around each change in the draft diff. */
  const DIFF_CONTEXT = 3;

  // ── pure helpers (exported for tests) ────────────────────────────────────

  /** @param {number} index */
  function pad3(index) {
    return String(index).padStart(3, "0");
  }

  /**
   * An empty reduced journal.
   * @returns {SessionModel}
   */
  function createSessionModel() {
    return {
      seq: 0,
      opened: null,
      actions: new Map(),
      steps: new Map(),
      removed: new Set(),
      snapshots: [],
      drafts: [],
      exports: [],
      closed: null,
      unknown: 0,
    };
  }

  /**
   * @typedef {{
   *   seq: number,
   *   opened: { ts: string | null, resumed: boolean } | null,
   *   actions: Map<number, Record<string, any>>,
   *   steps: Map<number, { index: number, step: Record<string, any>, origin: Record<string, any> | null, seq: number }>,
   *   removed: Set<number>,
   *   snapshots: Array<{ path: string, bytes: number | null, mode: string | null, elements: number | null }>,
   *   drafts: Array<{ path: string, steps: number | null, ts: string | null, seq: number }>,
   *   exports: Array<{ path: string, verify: { status: string, findings: string[] } | null, ts: string | null }>,
   *   closed: { reason: string | null, error: string | null, ts: string | null } | null,
   *   unknown: number,
   * }} SessionModel
   */

  /**
   * @param {unknown} value
   * @returns {string | null}
   */
  function str(value) {
    return typeof value === "string" && value ? value : null;
  }

  /**
   * @param {unknown} value
   * @returns {number | null}
   */
  function num(value) {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
  }

  /**
   * Fold session events into the model (the CLI's `journalSteps` rules: a
   * `step.removed` undoes the `step.recorded` of the same action index).
   * Unknown types are counted, never fatal.
   * @param {SessionModel} model
   * @param {Array<Record<string, any>>} events
   * @returns {SessionModel}
   */
  function applySessionEvents(model, events) {
    for (const event of events ?? []) {
      if (!event || typeof event !== "object") continue;
      model.seq += 1;
      const index = Number(event.index);
      const validIndex = Number.isInteger(index) && index > 0;
      switch (event.type) {
        case "session.opened":
          model.opened = { ts: str(event.ts), resumed: event.resumed === true };
          break;
        case "action.performed":
          if (!validIndex) break;
          model.actions.set(index, {
            index,
            ts: str(event.ts),
            action: str(event.action) ?? "action",
            locator:
              event.locator && typeof event.locator === "object"
                ? event.locator
                : null,
            ok: event.ok !== false,
            error: str(event.error),
            urlBefore:
              typeof event.urlBefore === "string" ? event.urlBefore : "",
            urlAfter: typeof event.urlAfter === "string" ? event.urlAfter : "",
            durationMs: num(event.durationMs),
            screenshot: str(event.screenshot),
            snapshot: str(event.snapshot),
            mutations: Array.isArray(event.network?.mutations)
              ? event.network.mutations.filter(
                  (/** @type {any} */ entry) => entry && entry.method,
                )
              : null,
            stepId: str(event.stepId),
          });
          break;
        case "step.recorded":
          if (!validIndex) break;
          model.steps.set(index, {
            index,
            step:
              event.step && typeof event.step === "object" ? event.step : {},
            origin:
              event.origin && typeof event.origin === "object"
                ? event.origin
                : null,
            seq: model.seq,
          });
          model.removed.delete(index);
          break;
        case "step.removed":
          if (!validIndex) break;
          model.steps.delete(index);
          model.removed.add(index);
          break;
        case "snapshot.captured":
          if (!str(event.path)) break;
          model.snapshots.push({
            path: event.path,
            bytes: num(event.bytes),
            mode: str(event.mode),
            elements: num(event.elements),
          });
          break;
        case "draft.updated":
          model.drafts.push({
            path: str(event.path) ?? "draft.spec.yml",
            steps: num(event.steps),
            ts: str(event.ts),
            seq: model.seq,
          });
          break;
        case "export.written":
          if (!str(event.path)) break;
          model.exports.push({
            path: event.path,
            verify:
              event.verify && typeof event.verify === "object"
                ? {
                    status: str(event.verify.status) ?? "unknown",
                    findings: Array.isArray(event.verify.findings)
                      ? event.verify.findings.map(String)
                      : [],
                  }
                : null,
            ts: str(event.ts),
          });
          break;
        case "session.closed":
          model.closed = {
            reason: str(event.reason),
            error: str(event.error),
            ts: str(event.ts),
          };
          break;
        default:
          model.unknown += 1;
      }
    }
    return model;
  }

  /** Keys of a spec step that are not its kind. */
  const STEP_META_KEYS = new Set([
    "id",
    "description",
    "when",
    "optional",
    "timeoutMs",
    "settleMs",
    "label",
  ]);

  /**
   * A value as compact flow text: `{role: button, name: "Save order"}`.
   * @param {unknown} value
   * @param {number} [depth]
   * @returns {string}
   */
  function compactValue(value, depth = 0) {
    if (value === null || value === undefined) return "null";
    if (typeof value === "string")
      return /^[\w./:@${}-]+$/.test(value) ? value : JSON.stringify(value);
    if (typeof value !== "object") return String(value);
    if (depth > 2) return "…";
    if (Array.isArray(value))
      return `[${value.map((entry) => compactValue(entry, depth + 1)).join(", ")}]`;
    return `{${Object.entries(value)
      .map(([key, entry]) => `${key}: ${compactValue(entry, depth + 1)}`)
      .join(", ")}}`;
  }

  /**
   * A recorded spec step as `kind` + one line.
   * @param {Record<string, any>} step
   * @returns {{ kind: string, text: string, id: string | null }}
   */
  function stepSummary(step) {
    const record = step && typeof step === "object" ? step : {};
    const kind =
      Object.keys(record).find((key) => !STEP_META_KEYS.has(key)) ?? "step";
    const value = record[kind];
    return {
      kind,
      text:
        value === undefined || value === null
          ? ""
          : fmt.truncate(compactValue(value), 200),
      id: str(record.id),
    };
  }

  /**
   * Steps recorded after the previous `draft.updated` (the ones the latest
   * draft added), for when Studio did not see the previous draft text.
   * @param {SessionModel} model
   * @returns {Array<{ index: number, step: Record<string, any> }>}
   */
  function stepsSinceDraft(model) {
    const last = model.drafts.at(-1);
    if (!last) return [];
    const previous = model.drafts.at(-2);
    const from = previous ? previous.seq : 0;
    return [...model.steps.values()]
      .filter((entry) => entry.seq > from && entry.seq <= last.seq)
      .toSorted((a, b) => a.index - b.index);
  }

  /**
   * @param {string | null | undefined} text
   * @returns {string[]}
   */
  function splitLines(text) {
    const value = String(text ?? "");
    if (!value) return [];
    const lines = value.split("\n");
    if (lines.at(-1) === "") lines.pop();
    return lines;
  }

  /**
   * LCS line ops over two (trimmed) line lists.
   * @param {string[]} a
   * @param {string[]} b
   * @returns {Array<{ op: " " | "+" | "-", text: string }>}
   */
  function lcsOps(a, b) {
    const n = a.length;
    const m = b.length;
    const width = m + 1;
    const table = new Uint32Array((n + 1) * width);
    for (let i = n - 1; i >= 0; i -= 1)
      for (let j = m - 1; j >= 0; j -= 1)
        table[i * width + j] =
          a[i] === b[j]
            ? table[(i + 1) * width + j + 1] + 1
            : Math.max(table[(i + 1) * width + j], table[i * width + j + 1]);
    /** @type {Array<{ op: " " | "+" | "-", text: string }>} */
    const out = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (a[i] === b[j]) {
        out.push({ op: " ", text: a[i] });
        i += 1;
        j += 1;
      } else if (table[(i + 1) * width + j] >= table[i * width + j + 1]) {
        out.push({ op: "-", text: a[i] });
        i += 1;
      } else {
        out.push({ op: "+", text: b[j] });
        j += 1;
      }
    }
    while (i < n) out.push({ op: "-", text: a[i++] });
    while (j < m) out.push({ op: "+", text: b[j++] });
    return out;
  }

  /**
   * A line diff (`before` → `after`): common prefix/suffix trimmed, LCS in
   * between (a plain replace block when that would be too large).
   * @param {string | null | undefined} before
   * @param {string | null | undefined} after
   * @returns {Array<{ op: " " | "+" | "-", text: string }>}
   */
  function lineDiff(before, after) {
    const a = splitLines(before);
    const b = splitLines(after);
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
      start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
      endA -= 1;
      endB -= 1;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    /** @type {Array<{ op: " " | "+" | "-", text: string }>} */
    const ops = [];
    for (const text of a.slice(0, start)) ops.push({ op: " ", text });
    if (midA.length * midB.length > DIFF_CELL_LIMIT) {
      for (const text of midA) ops.push({ op: "-", text });
      for (const text of midB) ops.push({ op: "+", text });
    } else ops.push(...lcsOps(midA, midB));
    for (const text of a.slice(endA)) ops.push({ op: " ", text });
    return ops;
  }

  /**
   * Diff ops as display rows: changes with `context` unchanged lines around
   * them, longer unchanged runs folded into `{ gap }`. Empty without changes.
   * @param {Array<{ op: " " | "+" | "-", text: string }>} ops
   * @param {number} [context]
   * @returns {Array<{ op: " " | "+" | "-", text: string } | { gap: number }>}
   */
  function diffRows(ops, context = DIFF_CONTEXT) {
    const changed = ops.map((entry) => entry.op !== " ");
    if (!changed.includes(true)) return [];
    const keep = ops.map((_, index) => {
      for (
        let probe = Math.max(0, index - context);
        probe <= Math.min(ops.length - 1, index + context);
        probe += 1
      )
        if (changed[probe]) return true;
      return false;
    });
    /** @type {Array<{ op: " " | "+" | "-", text: string } | { gap: number }>} */
    const rows = [];
    let gap = 0;
    ops.forEach((entry, index) => {
      if (keep[index]) {
        if (gap) rows.push({ gap });
        gap = 0;
        rows.push(entry);
      } else gap += 1;
    });
    if (gap) rows.push({ gap });
    return rows;
  }

  /**
   * @param {Array<{ op: string }>} ops
   * @returns {{ added: number, removed: number }}
   */
  function diffStats(ops) {
    let added = 0;
    let removed = 0;
    for (const entry of ops) {
      if (entry.op === "+") added += 1;
      else if (entry.op === "-") removed += 1;
    }
    return { added, removed };
  }

  /**
   * `setup` (session.json) as one line.
   * @param {any} setup
   * @returns {string | null}
   */
  function setupText(setup) {
    if (Array.isArray(setup) && setup.length)
      return setup
        .map(
          (entry) =>
            `use ${entry.use}${
              entry.vars?.length ? ` (vars: ${entry.vars.join(", ")})` : ""
            }`,
        )
        .join(" → ");
    if (setup && typeof setup === "object" && setup.fromSpec)
      return `steps of ${setup.fromSpec} through ${setup.untilStep}`;
    return null;
  }

  /**
   * The exported drafts of a session, newest first and one row per file:
   * `export.written` events (with their verify verdict), matched to the
   * absolute paths in session.json `exportedTo`, plus exports the events do
   * not mention.
   * @param {SessionModel} model
   * @param {Record<string, any> | null} session
   * @returns {Array<{ path: string, abs: string | null, verify: { status: string, findings: string[] } | null, ts: string | null }>}
   */
  function exportRows(model, session) {
    const exportedTo = Array.isArray(session?.exportedTo)
      ? session.exportedTo
      : [];
    /** @type {Map<string, { path: string, abs: string | null, verify: { status: string, findings: string[] } | null, ts: string | null }>} */
    const rows = new Map();
    for (const entry of model.exports) {
      const rel = entry.path.replace(/^\.\//, "");
      const abs = entry.path.startsWith("/")
        ? entry.path
        : (exportedTo.find(
            (/** @type {string} */ candidate) =>
              candidate === entry.path || candidate.endsWith(`/${rel}`),
          ) ?? null);
      const key = abs ?? entry.path;
      rows.delete(key);
      rows.set(key, {
        path: entry.path,
        abs,
        verify: entry.verify,
        ts: entry.ts,
      });
    }
    for (const candidate of exportedTo)
      if (!rows.has(candidate))
        rows.set(candidate, {
          path: candidate,
          abs: candidate,
          verify: null,
          ts: null,
        });
    return [...rows.values()].toReversed();
  }

  /**
   * @param {string | null | undefined} status session status
   * @returns {string | undefined} tag tone
   */
  function statusTone(status) {
    if (status === "open") return "info";
    if (status === "exported") return "ok";
    if (status === "expired") return "warn";
    return undefined;
  }

  /**
   * @param {string | null | undefined} status export verify status
   * @returns {string}
   */
  function verifyTone(status) {
    if (status === "ok") return "ok";
    if (status === "warnings") return "warn";
    if (status === "failed") return "bad";
    return "muted";
  }

  /**
   * The liveness verdict main computed (lib/authoring.js sessionLiveness).
   * @param {Record<string, any> | null | undefined} liveness
   * @returns {HTMLElement | null}
   */
  function livenessTag(liveness) {
    if (!liveness?.state || liveness.state === "ended") return null;
    /** @type {Record<string, [string, string]>} */
    const map = {
      live: ["live", "ok"],
      idle: ["idle past TTL", "warn"],
      dead: ["process gone", "bad"],
      stale: ["stale", "warn"],
    };
    const [text, tone] = map[liveness.state] ?? [liveness.state, "muted"];
    const node = Studio.tag(text, tone);
    node.classList.add("liveness-tag");
    node.title = [
      liveness.reason,
      liveness.ttlMs ? `TTL ${fmt.formatDuration(liveness.ttlMs)}` : null,
      liveness.idleMs !== null && liveness.idleMs !== undefined
        ? `idle ${fmt.formatDuration(liveness.idleMs)}`
        : null,
    ]
      .filter(Boolean)
      .join(" · ");
    return node;
  }

  /**
   * A short host + path for a start URL (placeholders kept as written).
   * @param {Record<string, any>} session
   * @returns {string}
   */
  function urlLabel(session) {
    return session?.currentUrl || session?.startUrl || "(no URL)";
  }

  // ── view state ───────────────────────────────────────────────────────────

  /** @type {HTMLElement | null} */
  let viewRoot = null;
  let renderSeq = 0;
  /** @type {HTMLElement | null} */
  let listHost = null;
  /** @type {HTMLElement | null} */
  let detailHost = null;
  /** @type {HTMLElement | null} */
  let subtitle = null;
  /** @type {Array<Record<string, any>>} */
  let sessions = [];
  /** @type {Map<string, { el: HTMLElement, sig: string }>} */
  const items = new Map();
  /** @type {string | null} */
  let selectedId = null;
  /** @type {ReturnType<typeof createDetail> | null} */
  let detail = null;
  /** @type {Array<ReturnType<typeof setInterval>>} */
  let timers = [];
  let listLoading = false;
  let listInFlight = false;
  /** @type {unknown} */
  let listError = null;

  // ── list ─────────────────────────────────────────────────────────────────

  /** @param {Record<string, any>} session */
  function itemSig(session) {
    return JSON.stringify([
      session.status,
      session.kind,
      session.origin,
      session.client,
      session.liveness?.state,
      session.currentUrl,
      session.startUrl,
      session.stepCount,
      session.actionCount,
      session.lastActivityAt,
      session.exportedTo?.length,
    ]);
  }

  /**
   * @param {HTMLElement} el
   * @param {Record<string, any>} session
   */
  function paintItem(el, session) {
    Studio.clear(el);
    const live = session.liveness?.state === "live";
    el.setAttribute(
      "aria-label",
      `${session.status} ${session.kind} session, ${urlLabel(session)}`,
    );
    el.appendChild(
      Studio.frag(
        h(
          "div",
          { class: "inv-item-head" },
          h("span", {
            class: `dot dot-${
              live ? "running" : fmt.statusTone(session.status)
            }`,
            ariaHidden: "true",
          }),
          Studio.tag(session.status, statusTone(session.status)),
          Studio.tag(session.kind),
          Studio.originBadge(session),
          livenessTag(session.liveness),
          h("span", { class: "inv-elapsed" }, Studio.relTime(session.openedAt)),
        ),
        h("div", {
          class: "inv-item-title mono",
          title: session.startUrl,
          text: urlLabel(session),
        }),
        h(
          "div",
          { class: "inv-item-meta cell-dim" },
          h("span", {
            text: [
              `${session.stepCount ?? 0} step${
                session.stepCount === 1 ? "" : "s"
              }`,
              session.actionCount !== null && session.actionCount !== undefined
                ? `${session.actionCount} action${
                    session.actionCount === 1 ? "" : "s"
                  }`
                : null,
              session.env ? `env ${session.env}` : null,
              session.exportedTo?.length
                ? `${session.exportedTo.length} export${
                    session.exportedTo.length === 1 ? "" : "s"
                  }`
                : null,
            ]
              .filter(Boolean)
              .join(" · "),
          }),
          session.lastActivityAt
            ? Studio.relTime(session.lastActivityAt, { prefix: "active " })
            : null,
        ),
      ),
    );
  }

  function paintList() {
    if (!listHost) return;
    if (!sessions.length) {
      items.clear();
      Studio.clear(listHost);
      listHost.appendChild(
        listError
          ? Studio.errorBox(listError, "sessions")
          : listLoading
            ? Studio.loading("reading session journals…")
            : Studio.empty(
                "No sessions yet",
                "An agent's discovery or accompany session journals itself under <artifact root>/_sessions/ (cairn discover, or the cairn_discover_* MCP tools). Open one and it appears here with every action, screenshot, recorded step and the draft spec it is writing.",
                [
                  h("button", {
                    class: "btn btn-primary",
                    type: "button",
                    text: "Open Catalog",
                    onClick: () => Studio.navigate("catalog"),
                  }),
                ],
              ),
      );
      return;
    }
    listHost.querySelector(".empty, .error-box, .loading")?.remove();
    const seen = new Set();
    /** @type {HTMLElement[]} */
    const ordered = [];
    for (const session of sessions) {
      const id = session.sessionId;
      seen.add(id);
      let entry = items.get(id);
      const sig = itemSig(session);
      if (!entry) {
        const el = h("div", {
          class: "inv-item ses-item",
          role: "option",
          tabindex: "-1",
          dataset: { id },
          onClick: () => select(id, { focus: true }),
        });
        entry = { el, sig: "" };
        items.set(id, entry);
      }
      if (entry.sig !== sig) {
        paintItem(entry.el, session);
        entry.sig = sig;
      }
      const on = id === selectedId;
      entry.el.classList.toggle("selected", on);
      entry.el.setAttribute("aria-selected", on ? "true" : "false");
      ordered.push(entry.el);
    }
    for (const id of items.keys()) if (!seen.has(id)) items.delete(id);
    ordered.forEach((el, index) => {
      if (listHost?.children[index] !== el)
        listHost?.insertBefore(el, listHost.children[index] ?? null);
    });
    while (listHost.children.length > ordered.length)
      listHost.removeChild(/** @type {Node} */ (listHost.lastChild));
    const current = selectedId ? items.get(selectedId)?.el : null;
    if (!ordered.some((el) => el.getAttribute("tabindex") === "0"))
      Studio.setRovingStop(ordered, current);
  }

  async function loadList() {
    if (listInFlight) return;
    listInFlight = true;
    listLoading = true;
    try {
      const result = await api.call("sessions:list", { limit: LIST_LIMIT });
      sessions = Array.isArray(result?.sessions) ? result.sessions : [];
      listError = null;
      if (subtitle)
        subtitle.textContent = `${sessions.length} newest from ${
          result?.sessionsDir ?? "<artifact root>/_sessions"
        }`;
    } catch (error) {
      listError = error;
    } finally {
      listLoading = false;
      listInFlight = false;
    }
    if (!viewRoot) return;
    paintList();
    const current = sessions.find((entry) => entry.sessionId === selectedId);
    if (current && detail?.id === selectedId) detail.setSession(current);
  }

  /**
   * @param {string} id
   * @param {{ focus?: boolean }} [options]
   */
  function select(id, options = {}) {
    if (!viewRoot || !detailHost) return;
    const changed = selectedId !== id;
    selectedId = id;
    state.viewParams = { ...state.viewParams, sessionId: id };
    for (const [key, entry] of items) {
      const on = key === id;
      entry.el.classList.toggle("selected", on);
      entry.el.setAttribute("aria-selected", on ? "true" : "false");
    }
    const el = items.get(id)?.el ?? null;
    if (el) {
      Studio.setRovingStop(
        [...items.values()].map((entry) => entry.el),
        el,
      );
      if (options.focus) el.focus();
    }
    if (!changed && detail) return;
    detail?.destroy();
    const session = sessions.find((entry) => entry.sessionId === id) ?? null;
    detail = createDetail(id, session);
    Studio.clear(detailHost);
    detailHost.appendChild(detail.root);
    if (!session)
      void api
        .call("session:get", { sessionId: id })
        .then((found) => {
          if (detail?.id !== id) return;
          if (found) detail.setSession(found);
          else detail.missing();
        })
        .catch(() => detail?.id === id && detail.missing());
    void detail.poll();
  }

  // ── detail ───────────────────────────────────────────────────────────────

  /**
   * @param {string} id
   * @param {Record<string, any> | null} initial
   */
  function createDetail(id, initial) {
    /** @type {Record<string, any> | null} */
    let session = initial;
    const model = createSessionModel();
    let eventsOffset = 0;
    let polling = false;
    let destroyed = false;
    /** Ended and drained: stop polling until the session changes. */
    let final = false;
    let headSig = "";
    /** The action whose screenshot / snapshot is shown; null = latest. */
    /** @type {number | null} */
    let pinnedIndex = null;
    /** Draft texts Studio read, oldest first (only what it saw). */
    /** @type {Array<{ text: string, steps: number | null, at: number }>} */
    const draftTexts = [];
    let draftsSeen = -1;
    let draftTab = "changes";
    /** @type {Map<number, { el: HTMLElement, sig: string }>} */
    const actionRows = new Map();
    /** path → URL (token or data URL) */
    /** @type {Map<string, string>} */
    const images = new Map();
    let previewSig = "";
    let stepsSig = "";
    let exportsSig = "";

    const dot = h("span", { class: "dot dot-running", ariaHidden: "true" });
    const statusSlot = h("span", { class: "status-slot" });
    const kindSlot = h("span", { class: "kind-slot" });
    const originSlot = h("span", { class: "origin-slot" });
    const livenessSlot = h("span", { class: "liveness-slot" });
    const exportButton = h("button", {
      class: "btn btn-sm btn-primary",
      type: "button",
      text: "Export draft",
      disabled: true,
      title: EXPORT_FIRST_TITLE,
      onClick: () => void exportDraft(),
    });
    let exporting = false;

    /** Export draft re-exports only with the contract of an earlier export. */
    function paintExportButton() {
      const ready = Boolean(session?.reexportable);
      exportButton.toggleAttribute("disabled", exporting || !ready);
      exportButton.title = ready
        ? "cairn discover export --from-session <journal> --intent … --outcomes … --json: rewrite the draft from the recorded steps, with the intent and outcomes of the last export (asks first when it replaces a file)"
        : session?.kind && session.kind !== "discovery"
          ? `only a discovery session exports as a spec (this one is ${session.kind})`
          : EXPORT_FIRST_TITLE;
    }
    const revealButton = h("button", {
      class: "btn btn-sm btn-ghost",
      type: "button",
      text: "Reveal",
      ariaLabel: "reveal the session journal folder in Finder",
      onClick: () => {
        if (session?.dir)
          void api
            .call("fs:reveal", session.dir)
            .catch((error) =>
              toast("Reveal failed", String(error?.message ?? error), "bad"),
            );
      },
    });
    const closedBox = h("div", { class: "error-box hidden" });
    const facts = h("div", { class: "inv-facts" });
    const resultHost = h("div", { class: "ses-result" });
    const timelineCount = h("span", { class: "count" });
    const timeline = h("ol", {
      class: "ses-timeline",
      ariaLabel: "actions, oldest first",
    });
    const previewTitle = h("div", { class: "section-title" }, "Screenshot");
    const shotFrame = h(
      "div",
      { class: "shot-frame ses-shot" },
      h("div", { class: "shot-empty", text: "no screenshot yet" }),
    );
    const followButton = h("button", {
      class: "btn btn-sm btn-ghost hidden",
      type: "button",
      text: "Follow latest",
      onClick: () => {
        pinnedIndex = null;
        paintPreview(true);
      },
    });
    const thumbs = h("div", {
      class: "ses-thumbs",
      role: "group",
      ariaLabel: "screenshots, oldest first",
    });
    const snapshotPre = h("pre", { class: "code tight ses-snapshot-text" });
    const snapshotSummary = h("summary", { text: "Accessibility snapshot" });
    const snapshotDetails = h(
      "details",
      { class: "ses-snapshot" },
      snapshotSummary,
      snapshotPre,
    );
    const networkPre = h("pre", { class: "code tight ses-network-text" });
    const networkSummary = h("summary", { text: "Network log" });
    const networkDetails = h(
      "details",
      { class: "ses-network hidden" },
      networkSummary,
      networkPre,
    );
    const stepsTitle = h("div", { class: "section-title" }, "Recorded steps");
    const stepsList = h("ol", {
      class: "ses-steps",
      ariaLabel: "recorded steps",
    });
    const draftTabs = h("div", {
      class: "tabs ses-draft-tabs",
      role: "tablist",
      ariaLabel: "draft",
    });
    const draftBody = h("div", { class: "ses-draft-body" });
    const exportsHost = h("div", { class: "ses-exports" });

    const root = h(
      "section",
      { class: "panel inv-detail ses-detail", ariaLabel: `session ${id}` },
      h(
        "div",
        { class: "panel-head inv-head" },
        dot,
        h("span", { class: "mono card-title", title: id, text: id }),
        statusSlot,
        kindSlot,
        originSlot,
        livenessSlot,
        h("div", { class: "card-actions" }, exportButton, revealButton),
      ),
      h(
        "div",
        { class: "panel-body" },
        closedBox,
        facts,
        resultHost,
        h(
          "div",
          { class: "ses-grid" },
          h(
            "div",
            { class: "ses-timeline-col" },
            h("div", { class: "section-title" }, "Actions", timelineCount),
            timeline,
          ),
          h(
            "div",
            { class: "ses-preview-col" },
            h("div", { class: "ses-preview-head" }, previewTitle, followButton),
            shotFrame,
            thumbs,
            snapshotDetails,
            networkDetails,
          ),
        ),
        h(
          "div",
          { class: "ses-grid" },
          h("div", { class: "ses-steps-col" }, stepsTitle, stepsList),
          h(
            "div",
            { class: "ses-draft-col" },
            h("div", { class: "section-title" }, "Draft"),
            draftTabs,
            draftBody,
          ),
        ),
        h("div", { class: "section-title" }, "Exports"),
        exportsHost,
      ),
    );

    // The snapshot and network log load when opened (they can be large).
    snapshotDetails.addEventListener("toggle", () => {
      if (/** @type {HTMLDetailsElement} */ (snapshotDetails).open)
        void loadText(snapshotDetails, snapshotPre);
    });
    networkDetails.addEventListener("toggle", () => {
      if (/** @type {HTMLDetailsElement} */ (networkDetails).open)
        void loadText(networkDetails, networkPre);
    });

    /**
     * @param {HTMLElement} details
     * @param {HTMLElement} pre
     */
    async function loadText(details, pre) {
      const file = details.dataset.path;
      if (!file || details.dataset.loaded === file) return;
      details.dataset.loaded = file;
      pre.textContent = "loading…";
      try {
        const result = await api.call("session:text", {
          sessionId: id,
          path: file,
        });
        if (details.dataset.path !== file) return;
        pre.textContent = result?.ok
          ? `${result.text}${result.truncated ? "\n… (truncated)" : ""}`
          : `not available: ${result?.error ?? "unreadable"}`;
      } catch (error) {
        if (details.dataset.path === file)
          pre.textContent = `not available: ${String(error?.message ?? error)}`;
      }
    }

    function paintHead() {
      if (!session) return;
      paintExportButton();
      const sig = JSON.stringify([
        session.status,
        session.kind,
        session.origin,
        session.client,
        session.liveness?.state,
        session.liveness?.reason,
        session.currentUrl,
        session.lastActivityAt,
        session.stepCount,
        session.actionCount,
        session.exportedTo,
        model.closed,
      ]);
      if (sig === headSig) return;
      headSig = sig;
      const live = session.liveness?.state === "live";
      dot.className = `dot dot-${
        live ? "running" : fmt.statusTone(session.status)
      }`;
      statusSlot.replaceChildren(
        Studio.tag(session.status, statusTone(session.status)),
      );
      kindSlot.replaceChildren(Studio.tag(session.kind));
      originSlot.replaceChildren(Studio.originBadge(session) ?? "");
      livenessSlot.replaceChildren(livenessTag(session.liveness) ?? "");
      const ttl = session.liveness?.ttlMs ?? session.ttlMs;
      facts.replaceChildren(
        Studio.keyValue([
          [
            "start URL",
            h("span", { class: "mono", text: session.startUrl || "—" }),
          ],
          [
            "current URL",
            h("span", { class: "mono", text: session.currentUrl ?? "—" }),
          ],
          [
            "environment",
            [session.env, session.backend, session.headed ? "headed" : null]
              .filter(Boolean)
              .join(" · ") || "—",
          ],
          ["opened", session.openedAt ? Studio.relTime(session.openedAt) : "—"],
          [
            "last activity",
            session.lastActivityAt
              ? Studio.relTime(session.lastActivityAt)
              : "—",
          ],
          [
            "TTL",
            ttl
              ? `${fmt.formatDuration(ttl)}${
                  // only while the process can still expire it
                  session.liveness?.expiresAt &&
                  (session.liveness.state === "live" ||
                    session.liveness.state === "idle")
                    ? ` · expires ${fmt.relativeTime(session.liveness.expiresAt)}`
                    : ""
                }`
              : "—",
          ],
          ...(setupText(session.setup)
            ? [["setup", setupText(session.setup)]]
            : []),
          ...(session.resume ? [["resume", session.resume]] : []),
          ...(session.specPath
            ? [["spec", h("span", { class: "mono", text: session.specPath })]]
            : []),
          ...(session.intent ? [["intent", session.intent]] : []),
          ["pid", session.pid ? String(session.pid) : "—"],
        ]),
      );
      const closed = model.closed;
      closedBox.classList.toggle("hidden", !closed?.error);
      closedBox.replaceChildren(
        closed?.error
          ? h("strong", {
              text: `session closed (${closed.reason ?? "?"}): ${closed.error}`,
            })
          : "",
      );
    }

    /** @returns {Array<Record<string, any>>} actions in index order */
    function orderedActions() {
      return [...model.actions.values()].toSorted((a, b) => a.index - b.index);
    }

    /** The action the preview shows: the pinned one, else the latest with a screenshot. */
    function shownAction() {
      if (pinnedIndex !== null && model.actions.has(pinnedIndex))
        return model.actions.get(pinnedIndex) ?? null;
      const list = orderedActions();
      return list.findLast((entry) => entry.screenshot) ?? list.at(-1) ?? null;
    }

    /** @param {number} index */
    function pin(index) {
      pinnedIndex = index;
      paintPreview(true);
    }

    /**
     * @param {Record<string, any>} action
     * @returns {HTMLElement}
     */
    function actionRow(action) {
      const recorded = model.steps.get(action.index);
      const urlChanged =
        action.urlAfter && action.urlBefore !== action.urlAfter;
      return h(
        "li",
        {
          class: `ses-action${action.ok ? "" : " failed"}`,
          dataset: { index: String(action.index) },
        },
        h(
          "div",
          { class: "ses-action-head" },
          h("span", {
            class: `dot dot-${action.ok ? "ok" : "bad"}`,
            ariaHidden: "true",
          }),
          h("span", {
            class: "mono ses-index",
            text: `#${pad3(action.index)}`,
          }),
          h("span", { class: "ses-action-kind", text: action.action }),
          action.locator
            ? h("span", {
                class: "mono cell-dim ses-locator",
                title: compactValue(action.locator),
                text: fmt.truncate(compactValue(action.locator), 90),
              })
            : null,
          recorded
            ? (() => {
                const node = Studio.tag("recorded", "ok");
                node.title = `step: ${stepSummary(recorded.step).kind} ${stepSummary(recorded.step).text}`;
                return node;
              })()
            : model.removed.has(action.index)
              ? Studio.tag("step removed", "warn")
              : null,
          action.durationMs !== null
            ? h("span", {
                class: "step-meta",
                text: fmt.formatDuration(action.durationMs),
              })
            : null,
        ),
        action.ok
          ? null
          : h("div", { class: "step-error", text: action.error ?? "failed" }),
        urlChanged
          ? h("div", {
              class: "mono cell-dim ses-url",
              title: `${action.urlBefore} → ${action.urlAfter}`,
              text: `${action.urlBefore || "∅"} → ${action.urlAfter}`,
            })
          : null,
        action.mutations?.length
          ? h(
              "div",
              { class: "ses-mutations" },
              action.mutations.map((/** @type {any} */ entry) =>
                h("span", {
                  class: `tag ses-mutation${
                    Number(entry.status) >= 400 ? " tag-bad" : ""
                  }`,
                  text: `${entry.method} ${entry.path}${
                    entry.status !== undefined ? ` ${entry.status}` : ""
                  }`,
                }),
              ),
            )
          : null,
        action.screenshot || action.snapshot
          ? h(
              "div",
              { class: "ses-action-links" },
              h("button", {
                class: "btn btn-sm btn-ghost",
                type: "button",
                text: action.screenshot ? "Screenshot" : "Snapshot",
                ariaLabel: `show action ${action.index}`,
                onClick: () => pin(action.index),
              }),
            )
          : null,
      );
    }

    function paintTimeline() {
      const list = orderedActions();
      const failed = list.filter((entry) => !entry.ok).length;
      timelineCount.textContent = list.length
        ? ` ${list.length}${failed ? ` · ${failed} failed` : ""}`
        : "";
      if (!list.length) {
        if (!timeline.querySelector(".empty-line"))
          timeline.replaceChildren(
            h("li", {
              class: "cell-dim empty-line",
              text: "no actions yet",
            }),
          );
        actionRows.clear();
        return;
      }
      timeline.querySelector(".empty-line")?.remove();
      list.forEach((action, position) => {
        const recorded = model.steps.has(action.index);
        const sig = JSON.stringify([
          action,
          recorded,
          model.removed.has(action.index),
        ]);
        let row = actionRows.get(action.index);
        if (!row || row.sig !== sig) {
          const el = actionRow(action);
          if (row) row.el.replaceWith(el);
          row = { el, sig };
          actionRows.set(action.index, row);
        }
        if (timeline.children[position] !== row.el)
          timeline.insertBefore(row.el, timeline.children[position] ?? null);
      });
      const shown = shownAction();
      for (const [index, row] of actionRows)
        row.el.classList.toggle("selected", index === shown?.index);
    }

    /**
     * Resolve a journal image to a URL (cached).
     * @param {string} file
     * @returns {Promise<string | null>}
     */
    async function imageUrl(file) {
      const hit = images.get(file);
      if (hit) return hit;
      try {
        const result = await api.call("session:image", {
          sessionId: id,
          path: file,
        });
        const url = result?.url ?? result?.dataUrl ?? null;
        if (url) {
          images.set(file, url);
          // bounded: the oldest entry goes first
          if (images.size > MAX_IMAGE_CACHE)
            images.delete(/** @type {string} */ (images.keys().next().value));
        }
        return url;
      } catch {
        return null;
      }
    }

    /**
     * Point an <img> at a journal screenshot. A URL that stopped resolving
     * (main's media registry evicts its oldest tokens) is fetched once more.
     * @param {HTMLElement} img
     * @param {string} file
     * @param {() => void} [onMissing] no URL could be had
     */
    function showImage(img, file, onMissing) {
      let retried = false;
      const load = () =>
        void imageUrl(file).then((url) => {
          if (destroyed) return;
          if (url) img.setAttribute("src", url);
          else onMissing?.();
        });
      img.addEventListener("error", () => {
        if (retried) return;
        retried = true;
        images.delete(file);
        load();
      });
      load();
    }

    /** @param {boolean} [force] */
    function paintPreview(force = false) {
      const shown = shownAction();
      const withShots = orderedActions().filter((entry) => entry.screenshot);
      const sig = JSON.stringify([
        shown?.index,
        shown?.screenshot,
        shown?.snapshot,
        pinnedIndex,
        withShots.length,
        model.snapshots.length,
      ]);
      if (!force && sig === previewSig) return;
      previewSig = sig;
      followButton.classList.toggle("hidden", pinnedIndex === null);
      previewTitle.textContent = shown
        ? `Screenshot · #${pad3(shown.index)} ${shown.action}${
            pinnedIndex === null ? " (latest)" : ""
          }`
        : "Screenshot";
      if (shown?.screenshot) {
        const file = shown.screenshot;
        const img = h("img", {
          alt: `page after action ${shown.index} (${shown.action})`,
        });
        shotFrame.replaceChildren(img);
        showImage(img, file, () => {
          if (shownAction()?.screenshot === file)
            shotFrame.replaceChildren(
              h("div", { class: "shot-empty", text: "screenshot unavailable" }),
            );
        });
      } else
        shotFrame.replaceChildren(
          h("div", {
            class: "shot-empty",
            text: shown ? "no screenshot for this action" : "no screenshot yet",
          }),
        );
      paintThumbs(withShots, shown);
      // Accessibility snapshot: the shown action's, else the latest captured.
      const snapshotPath =
        shown?.snapshot ?? model.snapshots.at(-1)?.path ?? null;
      snapshotDetails.classList.toggle("hidden", !snapshotPath);
      if (snapshotPath && snapshotDetails.dataset.path !== snapshotPath) {
        snapshotDetails.dataset.path = snapshotPath;
        snapshotSummary.textContent = `Accessibility snapshot · ${snapshotPath}`;
        snapshotPre.textContent = "";
        if (/** @type {HTMLDetailsElement} */ (snapshotDetails).open)
          void loadText(snapshotDetails, snapshotPre);
      }
      const networkPath =
        shown?.mutations !== null && shown?.mutations !== undefined
          ? `network/${pad3(shown.index)}.json`
          : null;
      networkDetails.classList.toggle("hidden", !networkPath);
      if (networkPath && networkDetails.dataset.path !== networkPath) {
        networkDetails.dataset.path = networkPath;
        networkSummary.textContent = `Network log · ${networkPath}`;
        networkPre.textContent = "";
        if (/** @type {HTMLDetailsElement} */ (networkDetails).open)
          void loadText(networkDetails, networkPre);
      }
      for (const [index, row] of actionRows)
        row.el.classList.toggle("selected", index === shown?.index);
    }

    /**
     * @param {Array<Record<string, any>>} withShots
     * @param {Record<string, any> | null} shown
     */
    function paintThumbs(withShots, shown) {
      const recent = withShots.slice(-MAX_THUMBS);
      thumbs.replaceChildren(
        ...recent.map((action) => {
          const img = h("img", { alt: "", loading: "lazy" });
          showImage(img, action.screenshot);
          return h(
            "button",
            {
              class: `ses-thumb${
                action.index === shown?.index ? " selected" : ""
              }`,
              type: "button",
              title: `#${pad3(action.index)} ${action.action}${
                action.ok ? "" : " (failed)"
              }`,
              ariaLabel: `screenshot after action ${action.index}, ${action.action}`,
              ariaPressed: action.index === shown?.index ? "true" : "false",
              onClick: () => pin(action.index),
            },
            img,
            h("span", {
              class: "ses-thumb-label mono",
              text: pad3(action.index),
            }),
          );
        }),
      );
    }

    function paintSteps() {
      const list = [...model.steps.values()].toSorted(
        (a, b) => a.index - b.index,
      );
      const sig = JSON.stringify([
        list.map((entry) => [entry.index, entry.step]),
        model.removed.size,
      ]);
      if (sig === stepsSig) return;
      stepsSig = sig;
      stepsTitle.replaceChildren(
        "Recorded steps",
        h("span", {
          class: "count",
          text: ` ${list.length}${
            model.removed.size ? ` · ${model.removed.size} removed` : ""
          }`,
        }),
      );
      stepsList.replaceChildren(
        ...(list.length
          ? list.map((entry) => {
              const summary = stepSummary(entry.step);
              return h(
                "li",
                {
                  class: "ses-step",
                  dataset: { index: String(entry.index) },
                },
                h("span", {
                  class: "mono ses-index",
                  text: `#${pad3(entry.index)}`,
                }),
                h("span", { class: "ses-step-kind", text: summary.kind }),
                h("span", {
                  class: "mono ses-step-text",
                  title: compactValue(entry.step),
                  text: summary.text,
                }),
                summary.id
                  ? h("span", { class: "cell-dim mono", text: summary.id })
                  : null,
                entry.origin?.file
                  ? h("span", {
                      class: "cell-dim",
                      text: `replaces ${String(entry.origin.file).split("/").pop()}${
                        entry.origin.stepId ? `#${entry.origin.stepId}` : ""
                      }`,
                    })
                  : null,
              );
            })
          : [h("li", { class: "cell-dim", text: "no recorded steps yet" })]),
      );
    }

    /** Read the draft again when a new `draft.updated` arrived. */
    async function refreshDraft() {
      // First poll: whatever draft is on disk; then once per draft.updated.
      const count = model.drafts.length;
      if (count <= draftsSeen) return;
      draftsSeen = count;
      const file = model.drafts.at(-1)?.path ?? "draft.spec.yml";
      try {
        const result = await api.call("session:text", {
          sessionId: id,
          path: file,
        });
        if (destroyed || !result?.ok) return;
        const text = String(result.text ?? "");
        if (draftTexts.at(-1)?.text === text) return;
        draftTexts.push({
          text,
          steps: model.drafts.at(-1)?.steps ?? null,
          at: Date.now(),
        });
        if (draftTexts.length > 20)
          draftTexts.splice(0, draftTexts.length - 20);
        paintDraft(true);
      } catch {
        // the next draft.updated retries
      }
    }

    /** @param {boolean} [force] */
    function paintDraft(force = false) {
      if (!force && draftTabs.childElementCount) return;
      const tabs = [
        { id: "changes", label: "Changes" },
        { id: "text", label: "draft.spec.yml" },
      ];
      draftTabs.replaceChildren(
        ...tabs.map((tab) =>
          h("button", {
            class: `tab${draftTab === tab.id ? " active" : ""}`,
            type: "button",
            role: "tab",
            ariaSelected: draftTab === tab.id ? "true" : "false",
            tabindex: draftTab === tab.id ? "0" : "-1",
            dataset: { tab: tab.id },
            text: tab.label,
            onClick: () => {
              draftTab = tab.id;
              paintDraft(true);
              /** @type {HTMLElement | null} */ (
                draftTabs.querySelector(`[data-tab="${tab.id}"]`)
              )?.focus();
            },
          }),
        ),
      );
      const latest = draftTexts.at(-1) ?? null;
      if (!latest) {
        draftBody.replaceChildren(
          h("p", {
            class: "cell-dim",
            text: "No draft yet: the session writes draft.spec.yml after its first recorded step.",
          }),
        );
        return;
      }
      if (draftTab === "text") {
        draftBody.replaceChildren(
          Studio.codeBlock(latest.text, { className: "ses-draft-text" }),
        );
        return;
      }
      const previous = draftTexts.at(-2) ?? null;
      if (!previous) {
        const added = stepsSinceDraft(model);
        draftBody.replaceChildren(
          h("p", {
            class: "cell-dim",
            text:
              model.drafts.length > 1
                ? "Studio did not see the previous draft (it was written before this view opened). Steps the latest draft.updated added:"
                : "First draft of this session. Its steps:",
          }),
          added.length
            ? h(
                "ul",
                { class: "ses-added-steps" },
                added.map((entry) => {
                  const summary = stepSummary(entry.step);
                  return h("li", {
                    class: "mono diff-add",
                    text: `+ #${pad3(entry.index)} ${summary.kind}: ${summary.text}`,
                  });
                }),
              )
            : h("p", { class: "cell-dim", text: "(none)" }),
        );
        return;
      }
      const ops = lineDiff(previous.text, latest.text);
      const stats = diffStats(ops);
      const rows = diffRows(ops);
      draftBody.replaceChildren(
        h("div", {
          class: "cell-dim ses-diff-stats",
          text: `since the previous draft.updated: +${stats.added} −${stats.removed} lines`,
        }),
        rows.length
          ? h(
              "pre",
              { class: "code tight ses-diff", ariaLabel: "draft diff" },
              rows.map((row) =>
                "gap" in row
                  ? h("div", {
                      class: "diff-gap",
                      text: `… ${row.gap} unchanged line${
                        row.gap === 1 ? "" : "s"
                      }`,
                    })
                  : h("div", {
                      class:
                        row.op === "+"
                          ? "diff-add"
                          : row.op === "-"
                            ? "diff-del"
                            : "diff-ctx",
                      text: `${row.op} ${row.text}`,
                    }),
              ),
            )
          : h("p", { class: "cell-dim", text: "no changes" }),
      );
    }

    // Left/Right move between the draft tabs.
    Studio.rovingKeys(draftTabs, {
      items: () => /** @type {HTMLElement[]} */ ([
        ...draftTabs.querySelectorAll(".tab"),
      ]),
      orientation: "horizontal",
      onMove: (tab) => tab.click(),
    });

    function paintExports() {
      const rows = exportRows(model, session);
      const missing = new Set(
        Array.isArray(session?.exportedMissing) ? session.exportedMissing : [],
      );
      const sig = JSON.stringify([rows, [...missing]]);
      if (sig === exportsSig) return;
      exportsSig = sig;
      if (!rows.length) {
        exportsHost.replaceChildren(
          h("p", {
            class: "cell-dim",
            text: "Not exported yet. The first export names the intent and outcomes, so it comes from the agent (cairn_discover_export); Export draft re-exports with that contract afterwards. Promote the draft once cairn spec finish is green.",
          }),
        );
        return;
      }
      exportsHost.replaceChildren(
        ...rows.map((row) =>
          h(
            "div",
            { class: "ses-export", dataset: { path: row.path } },
            h(
              "div",
              { class: "toolbar" },
              row.verify
                ? Studio.tag(
                    `verify ${row.verify.status}`,
                    verifyTone(row.verify.status),
                  )
                : Studio.tag("exported"),
              h("span", {
                class: "mono ses-export-path",
                title: row.abs ?? row.path,
                text: row.path,
              }),
              row.ts ? Studio.relTime(row.ts) : null,
              h("span", { class: "spacer" }),
              row.abs && missing.has(row.abs)
                ? h("span", {
                    class: "tag",
                    text: "moved",
                    title: `${row.abs} no longer exists (promoted, renamed or deleted)`,
                  })
                : null,
              row.abs && !missing.has(row.abs)
                ? h("button", {
                    class: "btn btn-sm",
                    type: "button",
                    text: "Open in Specs",
                    onClick: () => Studio.navigate("specs", { file: row.abs }),
                  })
                : null,
              row.abs && missing.has(row.abs)
                ? null
                : h("button", {
                    class: "btn btn-sm btn-primary",
                    type: "button",
                    text: "Promote…",
                    title:
                      "cairn spec promote <draft> --json: move it out of the drafts folder and stamp its contract (asks first, showing the intent and every outcome with its verify parameters)",
                    onClick: () => void promote(row.abs ?? row.path, false),
                  }),
            ),
            row.verify?.findings.length
              ? h(
                  "ul",
                  { class: "evidence-lines" },
                  row.verify.findings.map((finding) =>
                    h("li", {
                      class: row.verify?.status === "ok" ? "" : "warn",
                      text: finding,
                    }),
                  ),
                )
              : null,
          ),
        ),
      );
    }

    /**
     * A CLI refusal as the CLI wrote it (multi-line kept, no stack).
     * @param {string} context
     * @param {string} message
     */
    function refusalBox(context, message) {
      return h(
        "div",
        { class: "error-box ses-refusal" },
        h("strong", { text: context }),
        h("pre", { text: message }),
      );
    }

    /**
     * @param {string} text
     */
    function cliLine(text) {
      return h(
        "div",
        { class: "toolbar cli-line" },
        h("code", { class: "mono", text }),
        Studio.copyButton(() => text),
      );
    }

    async function exportDraft() {
      exporting = true;
      paintExportButton();
      exportButton.textContent = "Exporting…";
      const before = [...resultHost.childNodes];
      resultHost.replaceChildren(Studio.loading("cairn discover export…"));
      try {
        const result = await api.call("session:export", { sessionId: id });
        if (destroyed) return;
        if (result?.cancelled) {
          resultHost.replaceChildren(...before);
          return;
        }
        const payload = result?.payload ?? null;
        resultHost.replaceChildren(
          Studio.panel(
            result.ok ? "Draft exported" : "Export failed",
            [
              cliLine(result.cli),
              result.ok
                ? Studio.keyValue([
                    [
                      "path",
                      h("span", { class: "mono", text: payload?.path ?? "—" }),
                    ],
                    ["steps", String(payload?.stepCount ?? "—")],
                    [
                      "verify",
                      payload?.verifyOk === false ? "failed" : "parses OK",
                    ],
                    ...(payload?.skippedFailed
                      ? [
                          [
                            "left out",
                            `${payload.skippedFailed} failed action(s)`,
                          ],
                        ]
                      : []),
                  ])
                : refusalBox(
                    "cairn discover export",
                    result.unsupported
                      ? `this cairn does not know \`cairn discover export --from-session\` (${fmt.truncate(
                          result.stderr || result.meaning,
                          300,
                        )}). Update cairn, or ask the agent to export.`
                      : result.error ||
                          result.stderr ||
                          `cairn discover export exited ${result.exitCode} (${result.meaning})`,
                  ),
              [...(payload?.verifyErrors ?? []), ...(payload?.warnings ?? [])]
                .length
                ? Studio.evidenceLines([
                    ...(payload?.verifyErrors ?? []).map(
                      (/** @type {string} */ entry) => `error: ${entry}`,
                    ),
                    ...(payload?.warnings ?? []).map(
                      (/** @type {string} */ entry) => `warning: ${entry}`,
                    ),
                  ])
                : null,
            ],
            { className: "ses-export-result" },
          ),
        );
        if (result.ok) {
          toast("Draft exported", payload?.path ?? "", "ok", 4200);
          final = false;
          void poll();
          void loadList();
        }
      } catch (error) {
        resultHost.replaceChildren(
          Studio.errorBox(error, "cairn discover export"),
        );
      } finally {
        exporting = false;
        exportButton.textContent = "Export draft";
        paintExportButton();
      }
    }

    /**
     * @param {string} draft
     * @param {boolean} force
     */
    async function promote(draft, force) {
      try {
        const result = await api.call("spec:promote", {
          draft,
          sessionId: id,
          force,
        });
        if (destroyed || result?.cancelled) return;
        const payload = result.payload ?? {};
        if (result.promoted) {
          toast(
            "Draft promoted",
            `${payload.to ?? result.to ?? ""}${
              payload.contractHash ? ` · ${payload.contractHash}` : ""
            }`,
            "ok",
            6000,
          );
          resultHost.replaceChildren(
            Studio.panel("Draft promoted", [
              cliLine(result.cli),
              Studio.keyValue([
                [
                  "from",
                  h("span", {
                    class: "mono",
                    text: payload.from ?? result.draft,
                  }),
                ],
                [
                  "to",
                  h("span", {
                    class: "mono",
                    text: payload.to ?? result.to ?? "—",
                  }),
                ],
                ["intent", payload.intent ?? "—"],
                [
                  "outcomes",
                  Array.isArray(payload.outcomes)
                    ? payload.outcomes
                        .map((/** @type {any} */ entry) =>
                          typeof entry === "string" ? entry : entry?.id,
                        )
                        .filter(Boolean)
                        .join(", ") || "—"
                    : "—",
                ],
                [
                  "contract hash",
                  h("span", {
                    class: "mono",
                    text: payload.contractHash ?? "—",
                  }),
                ],
              ]),
              Array.isArray(result.warnings) && result.warnings.length
                ? Studio.evidenceLines(
                    result.warnings.map(
                      (/** @type {string} */ entry) => `warning: ${entry}`,
                    ),
                  )
                : null,
              result.to
                ? h(
                    "div",
                    { class: "toolbar" },
                    h("button", {
                      class: "btn btn-sm btn-primary",
                      type: "button",
                      text: "Open in Specs",
                      onClick: () =>
                        Studio.navigate("specs", { file: result.to }),
                    }),
                  )
                : null,
            ]),
          );
          void loadList();
          return;
        }
        resultHost.replaceChildren(
          Studio.panel(result.changed ? "Draft changed" : "Promote refused", [
            cliLine(result.cli),
            refusalBox(
              result.changed ? "not promoted" : "cairn spec promote",
              result.unsupported
                ? `this cairn has no \`cairn spec promote\` yet (${fmt.truncate(result.stderr || result.meaning, 200)})`
                : (result.error ??
                    `exit ${result.exitCode} (${result.meaning})`),
            ),
            // --force only lifts the green-finish gate: not "is not a
            // draft", "already exists", or a broken stamp/reference.
            !force && result.forceable === true
              ? h(
                  "div",
                  { class: "toolbar" },
                  h("button", {
                    class: "btn btn-sm btn-danger",
                    type: "button",
                    text: "Promote anyway (--force)…",
                    title:
                      "promote without a green cairn spec finish (asks again)",
                    onClick: () => void promote(draft, true),
                  }),
                )
              : null,
          ]),
        );
      } catch (error) {
        toast("Promote failed", String(error?.message ?? error), "bad", 9000);
      }
    }

    async function pollEvents() {
      for (let read = 0; read < MAX_EVENT_READS; read += 1) {
        const result = await api.call("session:events", {
          sessionId: id,
          offset: eventsOffset,
        });
        if (destroyed) return;
        eventsOffset = result?.offset ?? eventsOffset;
        const batch = Array.isArray(result?.events) ? result.events : [];
        applySessionEvents(model, batch);
        if (!batch.length) return;
      }
    }

    async function poll() {
      if (polling || destroyed || final) return;
      polling = true;
      try {
        await pollEvents();
        if (destroyed) return;
        paintHead();
        paintTimeline();
        paintPreview();
        paintSteps();
        paintExports();
        await refreshDraft();
        paintDraft();
        // An ended session's journal no longer grows: one drain is enough.
        if (session && session.status !== "open") final = true;
      } catch {
        // the next poll retries
      } finally {
        polling = false;
      }
    }

    if (session) paintHead();
    paintDraft(true);

    return {
      id,
      root,
      /** @param {Record<string, any>} next */
      setSession(next) {
        const reopened = session?.status !== next.status;
        session = next;
        if (reopened) final = false;
        paintHead();
        paintExports();
      },
      missing() {
        facts.replaceChildren(
          h("p", {
            class: "cell-dim",
            text: "This journal is gone (pruned by retention, which keeps the newest 50 sessions and any a draft references).",
          }),
        );
        final = true;
      },
      poll,
      destroy() {
        destroyed = true;
      },
    };
  }

  // ── view lifecycle ───────────────────────────────────────────────────────

  /**
   * @param {HTMLElement} root
   * @param {{ sessionId?: string }} [params]
   */
  async function render(root, params = {}) {
    destroy();
    const seq = ++renderSeq;
    viewRoot = root;
    Studio.clear(root);
    const header = Studio.pageHeader(
      "Sessions",
      "Discovery and accompany sessions: what an agent explores, records and exports",
      [
        h("button", {
          class: "btn",
          type: "button",
          text: "Refresh",
          onClick: () => void loadList(),
        }),
        h("button", {
          class: "btn",
          type: "button",
          text: "Catalog",
          onClick: () => Studio.navigate("catalog"),
        }),
      ],
    );
    subtitle = /** @type {HTMLElement | null} */ (header.querySelector(".sub"));
    root.appendChild(header);
    const notice = Studio.setupNotice();
    if (notice) root.appendChild(notice);
    listHost = h("div", {
      class: "inv-list",
      role: "listbox",
      ariaLabel: "sessions, newest first",
    });
    detailHost = h("div", { class: "inv-detail-host" });
    root.appendChild(
      h(
        "div",
        { class: "inv-layout" },
        h("div", { class: "panel inv-list-panel" }, listHost),
        detailHost,
      ),
    );
    Studio.rovingKeys(listHost, {
      items: () => [...items.values()].map((entry) => entry.el),
      roving: true,
      onMove: (item) => {
        const id = item.dataset.id;
        if (id) select(id);
      },
      onActivate: (item) => {
        const id = item.dataset.id;
        if (id) select(id);
        /** @type {HTMLElement | null | undefined} */ (
          detailHost?.querySelector("button:not(.hidden):not([disabled])")
        )?.focus();
      },
    });
    listLoading = true;
    paintList();
    await loadList();
    const handle = {
      destroy: () => {
        if (seq === renderSeq) destroy();
      },
    };
    if (seq !== renderSeq || viewRoot !== root) return { destroy() {} };
    if (state.view !== "sessions") {
      destroy();
      return { destroy() {} };
    }
    const wanted =
      typeof params?.sessionId === "string" && params.sessionId
        ? params.sessionId
        : (sessions.find((entry) => entry.liveness?.state === "live")
            ?.sessionId ??
          sessions[0]?.sessionId ??
          null);
    if (wanted) select(wanted);
    else if (detailHost)
      detailHost.appendChild(
        h(
          "div",
          { class: "panel inv-detail-empty" },
          h("p", {
            class: "cell-dim",
            text: "Select a session to follow its actions, screenshots and draft.",
          }),
        ),
      );
    timers = [
      setInterval(() => void loadList(), LIST_POLL_MS),
      setInterval(() => void detail?.poll(), DETAIL_POLL_MS),
    ];
    return handle;
  }

  function destroy() {
    for (const timer of timers) clearInterval(timer);
    timers = [];
    detail?.destroy();
    detail = null;
    items.clear();
    sessions = [];
    selectedId = null;
    viewRoot = null;
    listHost = null;
    detailHost = null;
    subtitle = null;
  }

  Studio.views = Studio.views || {};
  Studio.views.sessions = {
    id: "sessions",
    label: "Sessions",
    glyph: "◉",
    render,
  };
  Studio.sessionsView = {
    createSessionModel,
    applySessionEvents,
    stepSummary,
    stepsSinceDraft,
    lineDiff,
    diffRows,
    diffStats,
    setupText,
    exportRows,
  };
})();
