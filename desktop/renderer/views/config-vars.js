/**
 * Config vars browser — `cairn config vars --json`.
 *
 * Every var the config composes (top-level `vars:`, environment `vars:`,
 * `extends`, `include:`): its kind, effective value per environment, where it
 * is defined (`file:line`), what overrides it, what uses it, and whether
 * nothing does. A value the CLI masked stays masked: the main process masks
 * again by name, and this view never asks for an unmasked one.
 */
(function bootConfigVarsView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, api, state, actions } = Studio;

  /** Rows drawn at most (a config with thousands of vars is filtered). */
  const MAX_ROWS = 500;
  const filters = { env: "", unused: false, text: "" };
  /** @type {any} */
  let lastResult = null;

  /** @param {HTMLElement} root */
  async function render(root) {
    Studio.clear(root);
    root.appendChild(Studio.loading("reading config vars…"));
    if (!state.project) await actions.loadProject();
    /** @type {unknown} */
    let failure = null;
    try {
      lastResult = await api.call(
        "config:vars",
        { env: filters.env || null, unused: filters.unused },
        state.project?.dir ?? null,
      );
    } catch (error) {
      failure = error;
      lastResult = null;
    }
    Studio.clear(root);
    const doc = lastResult?.vars ?? null;
    root.appendChild(
      Studio.pageHeader(
        "Config vars",
        doc
          ? `${doc.totals.vars ?? doc.vars.length} var(s) · ${doc.totals.unused ?? 0} unused · ${
              doc.totals.differing ?? 0
            } differ by environment`
          : "values per environment, where they are defined, what uses them",
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "Refresh",
            onClick: () => void render(root),
          }),
        ],
      ),
    );
    if (failure) {
      root.appendChild(Studio.errorBox(failure, "config vars"));
      return;
    }
    if (!doc) {
      root.appendChild(unavailable(lastResult));
      return;
    }
    const envNames = (state.project?.config?.environments ?? []).map(
      (/** @type {{ name: string }} */ env) => env.name,
    );
    const known = new Set([...envNames, ...doc.environments]);
    if (filters.env && !known.has(filters.env)) filters.env = "";
    const host = h("div", { class: "config-vars-host" });
    root.appendChild(toolbar(root, [...known], host, doc));
    root.appendChild(summary(doc));
    root.appendChild(host);
    paint(host, doc);
  }

  /**
   * @param {any} result
   * @returns {HTMLElement}
   */
  function unavailable(result) {
    if (result?.unsupported)
      return Studio.empty(
        "This cairn has no config vars",
        "`cairn config vars` is newer than the cairn binary Studio drives. Update cairn, or point Studio at a newer binary in Settings.",
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "Open Settings",
            onClick: () => Studio.navigate("settings"),
          }),
        ],
      );
    return h(
      "div",
      { class: "error-box" },
      h("strong", { text: "cairn config vars failed" }),
      h("pre", {
        text:
          result?.error ||
          result?.stderr ||
          "no config vars document came back (is a cairntrace.config.yml open?)",
      }),
    );
  }

  /**
   * @param {HTMLElement} root
   * @param {string[]} envs
   * @param {HTMLElement} host
   * @param {any} doc
   */
  function toolbar(root, envs, host, doc) {
    const envPick = h(
      "select",
      {
        id: "cv-env",
        ariaLabel: "environment",
        onChange: (/** @type {Event} */ event) => {
          filters.env = /** @type {HTMLSelectElement} */ (event.target).value;
          void render(root);
        },
      },
      h("option", { value: "", text: "all environments" }),
      envs.map((name) => h("option", { value: name, text: name })),
    );
    /** @type {HTMLSelectElement} */ (envPick).value = filters.env;
    const text = Studio.input({
      type: "search",
      id: "cv-search",
      placeholder: "filter by name…",
      ariaLabel: "filter vars by name",
      value: filters.text,
      onInput: (/** @type {any} */ event) => {
        filters.text = event.target.value;
        paint(host, doc);
      },
    });
    return h(
      "div",
      { class: "toolbar" },
      h("label", { class: "field", for: "cv-env" }, "environment", envPick),
      Studio.checkbox(
        "unused only",
        filters.unused,
        (checked) => {
          filters.unused = checked;
          void render(root);
        },
        "vars no spec, action, script, fixture, datasource, gate, suite or config value uses",
      ),
      h("label", { class: "field", for: "cv-search" }, "name", text),
      h("div", { class: "spacer" }),
      lastResult?.cli
        ? h("code", { class: "cell-dim mono", text: lastResult.cli })
        : null,
    );
  }

  /**
   * Errors, warnings and findings (include overrides, dead vars) above the
   * table.
   * @param {any} doc
   * @returns {HTMLElement}
   */
  function summary(doc) {
    const box = h("div", { class: "cv-summary" });
    if (doc.errors.length || doc.ok === false)
      box.appendChild(
        h(
          "div",
          { class: "error-box" },
          h("strong", { text: "the config does not compose cleanly" }),
          h("pre", {
            text: doc.errors.join("\n") || "cairn reported ok: false",
          }),
        ),
      );
    for (const warning of doc.warnings)
      if (warning)
        box.appendChild(
          h("div", { class: "notice notice-warn", text: warning }),
        );
    const findings = doc.findings.filter(
      (/** @type {any} */ finding) => finding.code !== "unused-var",
    );
    if (findings.length)
      box.appendChild(
        h(
          "details",
          { class: "cv-findings" },
          h("summary", {
            class: "cell-dim",
            text: `${findings.length} finding(s): include overrides, var references`,
          }),
          h(
            "ul",
            { class: "ops-list", ariaLabel: "config findings" },
            findings.map((/** @type {any} */ finding) =>
              h(
                "li",
                {
                  class: `ops-row ops-row-${
                    finding.level === "error"
                      ? "bad"
                      : finding.level === "warning"
                        ? "warn"
                        : "info"
                  }`,
                },
                h("span", {
                  class: "ops-mark",
                  ariaHidden: "true",
                  text:
                    finding.level === "error"
                      ? "✗"
                      : finding.level === "warning"
                        ? "⚠"
                        : "•",
                }),
                h("span", { class: "ops-status", text: finding.level }),
                h("span", { class: "ops-text", text: finding.message }),
                finding.at
                  ? h("div", { class: "ops-detail mono", text: finding.at })
                  : null,
              ),
            ),
          ),
        ),
      );
    if (doc.files.length > 1)
      box.appendChild(
        h("div", {
          class: "cell-dim",
          text: `read ${doc.files.length} config files: ${doc.files.join(", ")}`,
        }),
      );
    return box;
  }

  /**
   * @param {HTMLElement} host
   * @param {any} doc
   */
  function paint(host, doc) {
    Studio.clear(host);
    const needle = filters.text.trim().toLowerCase();
    const rows = doc.vars.filter(
      (/** @type {any} */ row) =>
        !needle || row.name.toLowerCase().includes(needle),
    );
    if (!rows.length) {
      host.appendChild(
        Studio.empty(
          doc.vars.length ? "No vars match" : "No vars",
          doc.vars.length
            ? "Clear the name filter to see every var."
            : filters.unused
              ? "Every var is used by something."
              : "The config defines no vars:.",
        ),
      );
      return;
    }
    const shown = rows.slice(0, MAX_ROWS);
    const body = h("tbody");
    for (const row of shown) body.appendChild(varRow(row));
    host.appendChild(
      h(
        "div",
        { class: "data-table-scroll" },
        h(
          "table",
          { class: "grid cv-table", ariaLabel: "config vars" },
          h(
            "thead",
            h(
              "tr",
              ["var", "value per environment", "defined", "used by"].map(
                (label) => h("th", { text: label }),
              ),
            ),
          ),
          body,
        ),
      ),
    );
    if (rows.length > shown.length)
      host.appendChild(
        h("div", {
          class: "cell-dim data-note",
          text: `showing the first ${shown.length} of ${rows.length} vars; filter by name to narrow`,
        }),
      );
  }

  /**
   * @param {any} row
   * @returns {HTMLElement}
   */
  function varRow(row) {
    return h(
      "tr",
      {
        class: `cv-row${row.unused ? " cv-row-unused" : ""}`,
        dataset: { var: row.name },
      },
      h(
        "td",
        { class: "cv-name" },
        h("span", { class: "mono", text: row.name }),
        h("div", { class: "cv-tags" }, [
          Studio.tag(row.kind),
          row.unused
            ? h(
                "span",
                {
                  class: "tag tag-warn cv-unused",
                  title: "nothing in the project reads this var",
                },
                h("span", { ariaHidden: "true", text: "⚠ " }),
                "unused",
              )
            : null,
          row.sameInAllEnvironments
            ? h("span", {
                class: "tag",
                title: "every environment has the same value",
                text: "same everywhere",
              })
            : null,
        ]),
      ),
      h(
        "td",
        { class: "cv-values" },
        row.values.length
          ? row.values.map((/** @type {any} */ value) => valueLine(value))
          : h("span", { class: "cell-dim", text: "—" }),
      ),
      h(
        "td",
        { class: "cv-defined" },
        row.definedAt.map((/** @type {any} */ at) =>
          h(
            "div",
            { class: "mono cell-dim" },
            `${at.scope} · ${at.at}`,
            at.inheritedFrom ? ` (via ${at.inheritedFrom})` : "",
          ),
        ),
        row.overriddenBy.length
          ? h(
              "div",
              { class: "cv-overrides" },
              row.overriddenBy.map((/** @type {any} */ over) =>
                h("div", { class: "mono cell-dim" }, [
                  h("span", { ariaHidden: "true", text: "↳ " }),
                  `overridden by ${over.scope} · ${over.at}${
                    over.envs.length ? ` (${over.envs.join(", ")})` : ""
                  }`,
                ]),
              ),
            )
          : null,
      ),
      h(
        "td",
        { class: "cv-used" },
        row.usedBy.length
          ? h(
              "details",
              h("summary", {
                class: "cell-dim",
                text: `${row.usedBy.length} use${
                  row.usedBy.length === 1 ? "" : "s"
                }`,
              }),
              h(
                "ul",
                { class: "cv-used-list" },
                row.usedBy.map((/** @type {any} */ use) =>
                  h(
                    "li",
                    { class: "mono" },
                    `${use.kind} ${use.name}`,
                    h("span", { class: "cell-dim", text: ` · ${use.file}` }),
                  ),
                ),
              ),
            )
          : h("span", { class: "cell-dim", text: "nothing" }),
      ),
    );
  }

  /**
   * One environment's effective value: bullets and a `masked` tag when the
   * value is a credential, never the value.
   * @param {any} value
   * @returns {HTMLElement}
   */
  function valueLine(value) {
    return h(
      "div",
      { class: "cv-value", dataset: { env: value.env } },
      h("span", { class: "cv-env mono cell-dim", text: value.env }),
      h("code", {
        class: `cv-display${value.masked ? " cv-masked" : ""}`,
        title: value.template ? `authored: ${value.template}` : value.at,
        text: value.display,
      }),
      value.masked
        ? h("span", {
            class: "tag tag-info",
            title: "a credential: Studio never shows it",
            text: "masked",
          })
        : null,
      h("span", {
        class: "cell-dim mono cv-from",
        text: `${value.scope} · ${value.at}`,
      }),
    );
  }

  Studio.views = Studio.views || {};
  Studio.views["config-vars"] = {
    id: "config-vars",
    label: "Config vars",
    glyph: "≔",
    render,
  };
  Studio.configVarsView = { render };
})();
