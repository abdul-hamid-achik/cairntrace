/**
 * Stashes view — file.cheap evidence archives, through `cairn stash`.
 *
 * Lists `cairn stash list --format json` (tool cairntrace by default, tag
 * filters), shows `cairn stash info` for one stash, and "Restore & open"
 * restores it into a fresh temp directory (`cairn stash restore <id> --to
 * <tmp>`) and opens the run inside it in the normal Run detail / Compare.
 * Every action shows the equivalent CLI line with a copy button, because the
 * CLI is the interface agents use.
 *
 * A stash whose run is still in the artifact root is linked back to it
 * through that run's `stash-receipt.json`: the receipt's excluded members,
 * secret findings, TTL/expiry and tags show next to fcheap's own metadata
 * (whose `custom.secrets_found` flag also counts as a secret warning).
 */
(function bootStashesView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, api, fmt, toast } = Studio;

  const filters = { tool: "cairntrace", tags: "" };
  /** stashId → the local run that carries its receipt (this render). */
  /** @type {Map<string, Record<string, any>>} */
  let receipts = new Map();

  /**
   * Secret findings for a stash: the local receipt's count, else fcheap's
   * `custom.secrets_found` flag (a count or "true").
   * @param {Record<string, any>} item fcheap list/info item
   * @param {Record<string, any> | undefined} local
   * @returns {number | null} null when nothing says
   */
  function secretsOf(item, local) {
    const counted = local?.receipt?.secretsFound;
    if (typeof counted === "number") return counted;
    const flag = item?.custom?.secrets_found;
    if (flag === undefined || flag === null || flag === "") return null;
    const value = Number(flag);
    if (Number.isFinite(value)) return value;
    return /^(true|yes)$/i.test(String(flag)) ? 1 : 0;
  }

  /**
   * Warning/info tags for one stash row.
   * @param {Record<string, any>} item
   * @param {Record<string, any> | undefined} local
   * @returns {HTMLElement[]}
   */
  function evidenceTags(item, local) {
    const tags = [];
    const secrets = secretsOf(item, local);
    if (secrets && secrets > 0) {
      const node = Studio.tag(
        typeof local?.receipt?.secretsFound === "number"
          ? `${secrets} secret finding(s)`
          : "secrets found",
        "warn",
      );
      node.title =
        "fcheap flagged secret-looking content in this stash; review before sharing";
      tags.push(node);
    }
    const excluded = local?.receipt?.excluded ?? [];
    if (excluded.length) {
      const node = Studio.tag(`${excluded.length} left out`, "info");
      node.title = `left out: ${excluded.join(", ")} — opt in with stash.include`;
      tags.push(node);
    }
    if (local?.pinned) {
      const pin = Studio.pinTag({ at: null, reason: null });
      if (pin) tags.push(pin);
    }
    return tags;
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

  /** @param {HTMLElement} root */
  async function render(root) {
    Studio.clear(root);
    const toolInput = Studio.input({
      value: filters.tool,
      placeholder: "tool (blank = every tool)",
      style: { width: "170px" },
    });
    const tagsInput = Studio.input({
      value: filters.tags,
      placeholder: "tags (space separated; a stash must have every tag)",
      style: { minWidth: "300px" },
    });
    const listHost = h("div", { class: "panel" });
    const detailHost = h("div", { id: "stash-detail" });
    const reload = () => {
      filters.tool = toolInput.value.trim();
      filters.tags = tagsInput.value.trim();
      void loadList(listHost, detailHost);
    };
    toolInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") reload();
    });
    tagsInput.addEventListener("keydown", (event) => {
      if (event.key === "Enter") reload();
    });

    root.appendChild(
      Studio.pageHeader(
        "Stashes",
        "file.cheap archives of run directories — list, inspect, and restore into Run detail",
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "Refresh",
            onClick: reload,
          }),
        ],
      ),
    );
    root.appendChild(
      h(
        "div",
        { class: "toolbar" },
        h("label", { class: "field" }, "tool", toolInput),
        h(
          "label",
          { class: "field", style: { flex: "1 1 300px" } },
          "tags",
          tagsInput,
        ),
        h("button", {
          class: "btn btn-primary",
          type: "button",
          text: "Filter",
          onClick: reload,
        }),
      ),
    );
    root.appendChild(listHost);
    root.appendChild(detailHost);
    await loadList(listHost, detailHost);
  }

  /** @returns {string[]} */
  function tagList() {
    return filters.tags.split(/\s+/).filter(Boolean);
  }

  /**
   * @param {HTMLElement} host
   * @param {HTMLElement} detailHost
   */
  async function loadList(host, detailHost) {
    Studio.clear(host);
    host.appendChild(Studio.loading("cairn stash list…"));
    let result;
    try {
      const [listed, local] = await Promise.all([
        api.call("stash:list", {
          tool: filters.tool || null,
          tags: tagList(),
        }),
        // Best effort: the link back to local runs is a nicety.
        api.call("stash:receipts").catch(() => []),
      ]);
      result = listed;
      receipts = new Map(
        (Array.isArray(local) ? local : []).map((entry) => [
          entry.stashId,
          entry,
        ]),
      );
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, "cairn stash list"));
      return;
    }
    Studio.clear(host);
    const body = h("div", { class: "panel-body" });
    host.appendChild(body);
    body.appendChild(cliLine(result.cli));
    if (!result.ok) {
      body.appendChild(
        Studio.errorBox(
          new Error(
            result.stderr ||
              `cairn stash list exited ${result.exitCode} — is fcheap installed?`,
          ),
          "cairn stash list",
        ),
      );
      return;
    }
    const stashes = Array.isArray(result.payload?.stashes)
      ? result.payload.stashes
      : [];
    if (!stashes.length) {
      body.appendChild(
        Studio.empty(
          "No stashes",
          "Runs are stashed with `cairn stash save <run>`, `cairn run --stash-on-failure`, or retention archiving. Widen the tool/tag filters if you expected some.",
        ),
      );
      return;
    }
    const table = h(
      "table",
      { class: "grid" },
      h(
        "thead",
        h(
          "tr",
          h("th", { text: "stash" }),
          h("th", { text: "tags" }),
          h("th", { class: "num", text: "files" }),
          h("th", { class: "num", text: "size" }),
          h("th", { text: "created" }),
          h("th", { text: "expires" }),
          h("th", { text: "evidence" }),
          h("th", { text: "" }),
        ),
      ),
    );
    const tbody = h("tbody");
    for (const item of stashes) {
      const local = receipts.get(item.id);
      tbody.appendChild(
        h(
          "tr",
          { class: "stash-row", dataset: { stashId: String(item.id ?? "") } },
          h(
            "td",
            { class: "cell-spec" },
            h("span", { class: "mono", text: item.id }),
            item.name ? h("div", { class: "cell-dim", text: item.name }) : null,
          ),
          h(
            "td",
            { class: "cell-labels" },
            (item.tags ?? []).map((tag) =>
              h("span", { class: "tag label-tag", text: tag }),
            ),
          ),
          h("td", { class: "num", text: String(item.fileCount ?? "—") }),
          h("td", { class: "num", text: fmt.formatBytes(item.sizeBytes) }),
          h("td", { class: "cell-dim" }, Studio.relTime(item.createdAt)),
          h(
            "td",
            { class: "cell-dim" },
            item.expiresAt ? Studio.relTime(item.expiresAt) : "never",
          ),
          h(
            "td",
            { class: "cell-labels" },
            evidenceTags(item, local),
            local
              ? h("button", {
                  class: "btn btn-sm btn-ghost",
                  type: "button",
                  text: `run · ${local.spec}`,
                  title: `the local run this stash came from: ${local.runId}`,
                  onClick: () =>
                    Studio.navigate("run", { runRef: local.runId }),
                })
              : null,
          ),
          h(
            "td",
            { class: "row-actions" },
            h("button", {
              class: "btn btn-sm",
              type: "button",
              text: "Info",
              onClick: () => void showInfo(item.id, detailHost),
            }),
            h("button", {
              class: "btn btn-sm btn-primary",
              type: "button",
              text: "Restore & open",
              onClick: () => void restore(item.id, detailHost),
            }),
          ),
        ),
      );
    }
    table.appendChild(tbody);
    body.appendChild(table);
  }

  /**
   * @param {string} stashId
   * @param {HTMLElement} host
   */
  async function showInfo(stashId, host) {
    Studio.clear(host);
    host.appendChild(Studio.loading(`cairn stash info ${stashId}…`));
    let result;
    try {
      result = await api.call("stash:info", stashId);
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, "cairn stash info"));
      return;
    }
    Studio.clear(host);
    const info = result.payload ?? {};
    host.appendChild(
      Studio.panel(
        `Stash ${stashId}`,
        [
          cliLine(result.cli),
          result.ok
            ? Studio.keyValue([
                ["name", info.name ?? "—"],
                ["tool", info.tool ?? "—"],
                ["tags", (info.tags ?? []).join(", ") || "—"],
                ["created", fmt.formatTimestamp(info.createdAt)],
                ["files", String(info.fileCount ?? "—")],
                ["size", fmt.formatBytes(info.sizeBytes)],
                [
                  "expires",
                  info.expiresAt
                    ? fmt.formatTimestamp(info.expiresAt)
                    : "never",
                ],
                ["content hash", info.contentHash ?? "—"],
                ...(secretsOf(info, receipts.get(stashId)) !== null
                  ? [
                      [
                        "secrets found",
                        String(secretsOf(info, receipts.get(stashId))),
                      ],
                    ]
                  : []),
              ])
            : Studio.errorBox(
                new Error(result.stderr || `exit ${result.exitCode}`),
                "cairn stash info",
              ),
          (info.files ?? []).length
            ? h(
                "details",
                { style: { marginTop: "10px" } },
                h("summary", {
                  class: "cell-dim",
                  text: `${info.files.length} files`,
                }),
                h(
                  "div",
                  { class: "log-pane", style: { maxHeight: "40vh" } },
                  info.files.slice(0, 2000).map((file) =>
                    h("div", {
                      class: "log-line",
                      text: `${file.path}  (${fmt.formatBytes(file.size)})`,
                    }),
                  ),
                ),
              )
            : null,
          receiptBlock(stashId),
          cliLine(`cairn stash restore ${stashId} --to <dir>`),
          h(
            "div",
            { class: "toolbar" },
            h("button", {
              class: "btn btn-primary",
              type: "button",
              text: "Restore & open",
              onClick: () => void restore(stashId, host),
            }),
          ),
        ],
        { className: "stash-info" },
      ),
    );
  }

  /**
   * The local run's `stash-receipt.json` for this stash: excluded members,
   * secret findings, TTL/expiry, tags — and a link to the run.
   * @param {string} stashId
   * @returns {HTMLElement}
   */
  function receiptBlock(stashId) {
    const local = receipts.get(stashId);
    if (!local)
      return h("p", {
        class: "cell-dim",
        text: "No local run in the artifact root carries a receipt for this stash (it may have been pruned, or saved elsewhere).",
      });
    const badge = Studio.events.stashBadge({ ok: true, ...local.receipt });
    return h(
      "div",
      { class: "evidence-block stash-receipt" },
      h(
        "div",
        { class: "toolbar" },
        h("strong", { text: "local receipt" }),
        Studio.stashTag({ ok: true, ...local.receipt }),
        Studio.pinTag(local.pinned ? { at: null, reason: null } : null),
        h("button", {
          class: "btn btn-sm",
          type: "button",
          text: `Open run · ${local.spec}`,
          onClick: () => Studio.navigate("run", { runRef: local.runId }),
        }),
      ),
      Studio.evidenceLines(badge?.lines ?? []),
    );
  }

  /**
   * @param {string} stashId
   * @param {HTMLElement} host
   */
  async function restore(stashId, host) {
    Studio.clear(host);
    host.appendChild(Studio.loading(`restoring ${stashId}…`));
    let result;
    try {
      result = await api.call("stash:restore", stashId);
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, "cairn stash restore"));
      return;
    }
    if (result.runDir) {
      toast("Stash restored", result.runDir, "ok", 3200);
      Studio.navigate("run", { runRef: result.runDir });
      return;
    }
    Studio.clear(host);
    host.appendChild(
      Studio.panel(`Restore ${stashId}`, [
        cliLine(result.cli),
        result.ok
          ? h("p", {
              class: "cell-dim",
              text: `Restored to ${result.restoredTo}, but no run.json was found inside — this stash is not a run directory.`,
            })
          : Studio.errorBox(
              new Error(result.stderr || `exit ${result.exitCode}`),
              "cairn stash restore",
            ),
        result.payload
          ? h("div", { class: "tree" }, Studio.jsonTree(result.payload))
          : null,
      ]),
    );
  }

  Studio.views = Studio.views || {};
  Studio.views.stashes = {
    id: "stashes",
    label: "Stashes",
    glyph: "⧉",
    render,
  };
})();
