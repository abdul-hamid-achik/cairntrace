/**
 * Docs view — the authoring reference, sourced from the CLI itself.
 *
 * `cairn docs <topic>` and `cairn explain` are the authority on the current
 * step/verifier vocabulary, so this view renders their payloads rather than
 * embedding a copy that could go stale. Results are cached in the main
 * process for five minutes.
 */
(function bootDocsView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, api, fmt } = Studio;

  const TOPICS = [
    "overview",
    "authoring",
    "steps",
    "verifiers",
    "downloads",
    "scripts",
    "artifacts",
    "mcp",
    "backends",
    "stash",
    "investigate",
    "clip",
    "annotate",
    "secrets",
    "services",
    "discovery",
    "export",
    "brief",
    "catalog",
    "author-flow",
  ];

  let mode = "topic";
  let topic = "authoring";
  let surfaceFilter = "";

  /** @param {HTMLElement} root */
  async function render(root) {
    Studio.clear(root);
    root.appendChild(
      Studio.pageHeader(
        "Docs",
        "Step + verifier vocabulary and topic guides, read live from the cairn binary",
        [
          h("button", {
            class: "btn",
            type: "button",
            text: mode === "topic" ? "Show surface" : "Show topic guide",
            onClick: () => {
              mode = mode === "topic" ? "surface" : "topic";
              void render(root);
            },
          }),
        ],
      ),
    );

    const nav = h("div", { class: "panel" });
    const content = h("div", { id: "docs-content" });
    root.appendChild(h("div", { class: "doc-grid" }, nav, content));

    if (mode === "topic") {
      paintTopicNav(nav, root);
      await showTopic(content, topic);
    } else {
      paintSurfaceNav(nav, root);
      await showSurface(content);
    }
  }

  /**
   * @param {HTMLElement} nav
   * @param {HTMLElement} root
   */
  function paintTopicNav(nav, root) {
    Studio.clear(nav);
    nav.appendChild(
      h(
        "div",
        { class: "panel-head" },
        h("span", { class: "panel-title", text: "topics" }),
      ),
    );
    nav.appendChild(
      h(
        "div",
        { class: "panel-body tight" },
        TOPICS.map((name) =>
          h(
            "div",
            {
              class: `list-row${name === topic ? " selected" : ""}`,
              onClick: () => {
                topic = name;
                void render(root);
              },
            },
            h("span", {
              class: "mono",
              style: { fontSize: "11.5px" },
              text: name,
            }),
          ),
        ),
      ),
    );
    nav.appendChild(
      h(
        "div",
        { class: "panel-body" },
        h("p", {
          class: "cell-dim",
          style: { margin: 0 },
          text: "cairn docs <topic> --format json",
        }),
      ),
    );
  }

  /**
   * @param {HTMLElement} nav
   * @param {HTMLElement} root
   */
  function paintSurfaceNav(nav, root) {
    Studio.clear(nav);
    nav.appendChild(
      h(
        "div",
        { class: "panel-head" },
        h("span", { class: "panel-title", text: "surface" }),
      ),
    );
    const filter = Studio.input({
      type: "search",
      placeholder: "filter commands / steps / verifiers…",
      value: surfaceFilter,
      style: { width: "100%" },
      onInput: (event) => {
        surfaceFilter = event.target.value;
        void render(root);
      },
    });
    nav.appendChild(h("div", { class: "panel-body" }, filter));
    nav.appendChild(
      h(
        "div",
        { class: "panel-body" },
        h("p", {
          class: "cell-dim",
          style: { margin: 0 },
          text: "cairn explain --format json",
        }),
        h("button", {
          class: "btn btn-sm",
          type: "button",
          style: { marginTop: "8px" },
          text: "Reload surface",
          onClick: () => void render(root),
        }),
      ),
    );
  }

  /**
   * @param {HTMLElement} host
   * @param {string} name
   */
  async function showTopic(host, name) {
    Studio.clear(host);
    host.appendChild(Studio.loading(`loading docs topic “${name}”…`));
    try {
      const result = await api.call("docs:get", name);
      Studio.clear(host);
      if (!result?.ok) {
        host.appendChild(
          Studio.errorBox(
            new Error(
              result?.stderr || `cairn docs exited ${result?.exitCode}`,
            ),
            "docs",
          ),
        );
        return;
      }
      const payload = result.payload ?? {};
      host.appendChild(
        h("h1", { class: "view-title", text: payload.title ?? name }),
      );
      if (payload.summary)
        host.appendChild(Studio.markdown.render(payload.summary));
      const sections = Array.isArray(payload.sections) ? payload.sections : [];
      for (const section of sections) {
        host.appendChild(
          h("div", { class: "section-title" }, section.title ?? ""),
        );
        host.appendChild(
          h(
            "div",
            { class: "panel", style: { marginBottom: "10px" } },
            h(
              "div",
              { class: "panel-body" },
              section.body
                ? Studio.markdown.render(section.body)
                : Studio.jsonTree(section),
            ),
          ),
        );
      }
      if (!sections.length)
        host.appendChild(h("div", { class: "tree" }, Studio.jsonTree(payload)));
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, "docs:get"));
    }
  }

  /** @param {HTMLElement} host */
  async function showSurface(host) {
    Studio.clear(host);
    host.appendChild(Studio.loading("reading the agent-facing surface…"));
    try {
      const result = await api.call("explain:get");
      Studio.clear(host);
      if (!result?.ok) {
        host.appendChild(
          Studio.errorBox(
            new Error(
              result?.stderr || `cairn explain exited ${result?.exitCode}`,
            ),
            "explain",
          ),
        );
        return;
      }
      const payload = result.payload ?? {};
      const needle = surfaceFilter.trim().toLowerCase();
      const matches = (text) =>
        !needle ||
        String(text ?? "")
          .toLowerCase()
          .includes(needle);

      host.appendChild(
        h("div", { class: "stat-cards" }, [
          card(
            "commands",
            String((payload.commands ?? []).length),
            `cairntrace ${payload.cairntrace?.version ?? ""}`,
          ),
          card(
            "step kinds",
            String((payload.steps ?? []).length),
            "typed authoring vocabulary",
          ),
          card(
            "verifiers",
            String((payload.verifiers ?? []).length),
            "outcome vocabulary",
          ),
          card(
            "report themes",
            String((payload.config?.report?.themes ?? []).length),
            payload.config?.report?.defaultTheme ?? "",
          ),
        ]),
      );

      const filter = (items, fields) =>
        (items ?? []).filter((item) =>
          fields.some((field) =>
            matches(typeof field === "function" ? field(item) : item[field]),
          ),
        );

      const steps = filter(payload.steps, [
        (item) => `${item.id} ${item.kind} ${item.summary}`,
      ]);
      const verifiers = filter(payload.verifiers, [
        (item) => `${item.id} ${item.kind} ${item.summary}`,
      ]);
      const commands = filter(payload.commands, [
        (item) => `${item.name} ${item.summary} ${item.synopsis}`,
      ]);

      host.appendChild(
        h("div", { class: "section-title" }, `Verifiers (${verifiers.length})`),
      );
      host.appendChild(
        h(
          "div",
          null,
          verifiers.map((verifier) =>
            refCard(
              verifier.id,
              verifier.kind,
              verifier.summary,
              verifier.yamlExample,
              verifier.parameters,
            ),
          ),
        ),
      );

      host.appendChild(
        h("div", { class: "section-title" }, `Step kinds (${steps.length})`),
      );
      host.appendChild(
        h(
          "div",
          null,
          steps.map((step) =>
            refCard(
              step.id,
              step.kind,
              step.summary,
              step.yamlExample,
              step.parameters,
            ),
          ),
        ),
      );

      host.appendChild(
        h("div", { class: "section-title" }, `Commands (${commands.length})`),
      );
      host.appendChild(
        h(
          "div",
          commands.map((command) =>
            h(
              "details",
              { class: "ref-card" },
              h(
                "summary",
                { style: { cursor: "pointer" } },
                h(
                  "div",
                  { class: "ref-head" },
                  h("span", { class: "ref-id", text: `cairn ${command.name}` }),
                ),
                h("div", { class: "ref-summary", text: command.summary ?? "" }),
              ),
              command.synopsis
                ? h("pre", {
                    class: "code",
                    style: { whiteSpace: "pre-wrap" },
                    text: command.synopsis,
                  })
                : null,
              Array.isArray(command.flags) && command.flags.length
                ? h(
                    "ul",
                    command.flags.map((flag) =>
                      h("li", {
                        class: "mono",
                        style: { fontSize: "11.5px" },
                        text: String(flag),
                      }),
                    ),
                  )
                : null,
            ),
          ),
        ),
      );

      if (payload.rules) {
        host.appendChild(h("div", { class: "section-title" }, "Rules"));
        host.appendChild(
          Studio.panel(
            "",
            Studio.keyValue(
              Object.entries(payload.rules).flatMap(([name, rule]) => {
                const value = /** @type {any} */ (rule);
                const rows = [["", h("strong", { text: name })]];
                for (const [key, item] of Object.entries(value ?? {}))
                  rows.push([
                    key,
                    Array.isArray(item)
                      ? item.join(" · ")
                      : typeof item === "object" && item
                        ? JSON.stringify(item)
                        : String(item),
                  ]);
                return rows;
              }),
            ),
          ),
        );
      }
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, "explain:get"));
    }
  }

  /**
   * @param {string} id
   * @param {string} kind
   * @param {string} summary
   * @param {string} [example]
   * @param {Array<Record<string, any>>} [parameters]
   */
  function refCard(id, kind, summary, example, parameters) {
    return h(
      "details",
      { class: "ref-card" },
      h(
        "summary",
        { style: { cursor: "pointer", listStyle: "none" } },
        h(
          "div",
          { class: "ref-head" },
          h("span", { class: "ref-id", text: id }),
          h("span", { class: "ref-kind", text: kind ?? "" }),
        ),
        h("div", { class: "ref-summary", text: summary ?? "" }),
      ),
      Array.isArray(parameters) && parameters.length
        ? h(
            "table",
            { class: "grid", style: { marginTop: "8px" } },
            h(
              "thead",
              h(
                "tr",
                h("th", { text: "parameter" }),
                h("th", { text: "type" }),
                h("th", { text: "notes" }),
              ),
            ),
            h(
              "tbody",
              parameters.map((parameter) =>
                h(
                  "tr",
                  { style: { cursor: "default" } },
                  h("td", {
                    class: "mono",
                    style: { fontSize: "11.5px" },
                    text: parameter.name,
                  }),
                  h("td", { class: "cell-dim", text: parameter.type ?? "" }),
                  h("td", {
                    class: "cell-summary",
                    text: [
                      parameter.description,
                      parameter.oneOfGroup
                        ? `one-of: ${parameter.oneOfGroup}`
                        : null,
                    ]
                      .filter(Boolean)
                      .join(" — "),
                  }),
                ),
              ),
            ),
          )
        : null,
      example ? h("pre", { class: "code", text: example }) : null,
    );
  }

  /**
   * @param {string} label
   * @param {string} value
   * @param {string} [note]
   */
  function card(label, value, note) {
    return h(
      "div",
      { class: "stat-card" },
      h("div", { class: "k", text: label }),
      h("div", { class: "v", style: { fontSize: "17px" }, text: value }),
      note
        ? h("div", { class: "n", text: fmt.truncate(String(note), 60) })
        : null,
    );
  }

  Studio.views = Studio.views || {};
  Studio.views.docs = { id: "docs", label: "Docs", glyph: "?", render };
})();
