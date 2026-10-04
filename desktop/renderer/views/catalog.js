/**
 * Catalog view — what the project already has, for people authoring specs.
 *
 * Renders `cairn catalog --json [--query=…] [--env=…]` (the same catalog an
 * agent reads through MCP `cairn_catalog`): reusable actions with their
 * inputs and last green run, config vars per environment (credentials come
 * back masked), script verifiers with their fixture contracts, environments
 * with their policy and services, flows with their last run, and browser
 * checkpoints with their health. A search box ranks rows with `--query`;
 * tabs switch kinds; files reveal in Finder (flows open in Specs) and runs
 * open in Run detail. Snippet buttons copy `use:` / `${vars.…}` lines.
 *
 * Datasources, gates and fixtures come from the catalog payload when the CLI
 * reports them, else from the config summary main sends with the project
 * (redacted: references stay references, literal URIs are masked), filtered
 * by the search text here; they render even when `cairn catalog` fails.
 * So do the F15 widget drivers (`browser.widgets`, field roots, F20 app
 * handles) when the config declares them. Environments gain an auth column
 * (F18 `environments.<n>.auth`: requests by method and path, secret names)
 * and Actions the built-in `login` when an environment declares auth and
 * no imported action is named login (an imported one wins).
 */
(function bootCatalogView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, api, fmt, toast } = Studio;

  const KINDS = [
    { id: "actions", label: "Actions" },
    { id: "vars", label: "Vars" },
    { id: "verifiers", label: "Verifiers" },
    { id: "envs", label: "Environments" },
    { id: "flows", label: "Flows" },
    { id: "checkpoints", label: "Checkpoints" },
    { id: "datasources", label: "Datasources" },
    { id: "gates", label: "Gates" },
    { id: "fixtures", label: "Fixtures" },
    { id: "widgets", label: "Widgets" },
  ];
  /** Kinds Studio can read from the config when the catalog has none. */
  const CONFIG_KINDS = new Set(["datasources", "gates", "fixtures", "widgets"]);
  /** The built-in action `use: login` runs (environment auth, F18). */
  const BUILTIN_LOGIN = "login";
  /** Rows per kind with a query (the CLI's default is 10). */
  const QUERY_LIMIT = 50;
  /** Typing pause before the search runs. */
  const DEBOUNCE_MS = 350;

  /** Kept across renders: the reader's search, environment and tab. */
  const filters = { query: "", env: "", tab: "actions" };
  /** @type {Record<string, any> | null} */
  let result = null;
  /** @type {unknown} */
  let loadError = null;
  let loading = false;
  /** Bumped per search: a slow answer to an older query is dropped. */
  let loadSeq = 0;
  /** @type {{ tabs: HTMLElement, body: HTMLElement, cli: HTMLElement, warnings: HTMLElement } | null} */
  let dom = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let debounce = null;

  // ── small pieces ─────────────────────────────────────────────────────────

  /**
   * A catalog `file` (relative to the catalog root) as an absolute path.
   * @param {string | null | undefined} file
   * @returns {string | null}
   */
  function absPath(file) {
    if (!file) return null;
    if (file.startsWith("/")) return file;
    const root = String(result?.payload?.root ?? state.project?.dir ?? "");
    return root ? `${root.replace(/\/+$/, "")}/${file}` : null;
  }

  /**
   * @param {string | null | undefined} file
   * @returns {HTMLElement}
   */
  function fileButton(file) {
    if (!file) return h("span", { class: "cell-dim", text: "—" });
    return h("button", {
      class: "btn btn-sm btn-ghost mono catalog-file",
      type: "button",
      title: `Reveal ${file} in Finder`,
      text: file,
      onClick: () =>
        void api
          .call("fs:reveal", absPath(file))
          .catch((error) =>
            toast("Reveal failed", String(error?.message ?? error), "bad"),
          ),
    });
  }

  /**
   * A catalog run reference as a click-through to Run detail.
   * @param {Record<string, any> | null | undefined} run
   * @returns {HTMLElement}
   */
  function runButton(run) {
    if (!run?.runId) return h("span", { class: "cell-dim", text: "—" });
    return h(
      "button",
      {
        class: "btn btn-sm btn-ghost catalog-run",
        type: "button",
        title: [
          run.runId,
          run.environment ? `env ${run.environment}` : null,
          run.durationMs !== undefined
            ? fmt.formatDuration(run.durationMs)
            : null,
        ]
          .filter(Boolean)
          .join(" · "),
        ariaLabel: `open run ${run.runId}`,
        onClick: () => Studio.navigate("run", { runRef: run.runId }),
      },
      Studio.statusTag(run.status),
      run.startedAt ? Studio.relTime(run.startedAt) : null,
    );
  }

  /**
   * @param {Array<Record<string, any>> | undefined} usedBy
   * @returns {HTMLElement}
   */
  function usedByCell(usedBy) {
    const list = Array.isArray(usedBy) ? usedBy : [];
    if (!list.length) return h("span", { class: "cell-dim", text: "unused" });
    return h("span", {
      class: "catalog-used",
      title: list
        .map((entry) =>
          entry.spec
            ? `${entry.spec} · ${entry.outcome ?? ""} (${entry.file})`
            : `${entry.kind ?? ""} ${entry.name ?? ""} (${entry.file ?? ""})`,
        )
        .join("\n"),
      text: `${list.length} use${list.length === 1 ? "" : "s"}`,
    });
  }

  /**
   * A copy-to-clipboard button for an authoring snippet.
   * @param {string} label
   * @param {string} snippet
   * @returns {HTMLElement}
   */
  function snippetButton(label, snippet) {
    return h("button", {
      class: "btn btn-sm btn-ghost catalog-snippet",
      type: "button",
      title: `Copy:\n${snippet}`,
      text: label,
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(snippet);
          toast("Copied", snippet.split("\n")[0], "ok", 1600);
        } catch (error) {
          toast("Copy failed", String(error?.message ?? error), "bad");
        }
      },
    });
  }

  /**
   * Why a row matched `--query` (tooltip).
   * @param {Record<string, any>} row
   * @returns {string | null}
   */
  function matchTitle(row) {
    const matched = Array.isArray(row?.matched) ? row.matched : [];
    if (!matched.length) return null;
    return `matched: ${matched
      .map((entry) => `${entry.token} in ${entry.field}`)
      .join(", ")}`;
  }

  /**
   * @param {string[]} headings
   * @param {HTMLElement[]} rows
   * @param {string} className
   */
  function table(headings, rows, className) {
    return h(
      "table",
      { class: `grid catalog-table ${className}` },
      h(
        "thead",
        h(
          "tr",
          headings.map((label) => h("th", { text: label })),
        ),
      ),
      h("tbody", rows),
    );
  }

  /**
   * @param {string} kind
   * @returns {HTMLElement}
   */
  function emptyKind(kind) {
    const label =
      KINDS.find((entry) => entry.id === kind)?.label.toLowerCase() ?? kind;
    return Studio.empty(
      filters.query ? `Nothing matches “${filters.query}”` : `No ${label}`,
      filters.query
        ? `No ${label} match this search. Clear it to see everything.`
        : `This project has no ${label} cairn could find.`,
      filters.query
        ? [
            h("button", {
              class: "btn",
              type: "button",
              text: "Clear search",
              onClick: () => {
                filters.query = "";
                const input =
                  /** @type {HTMLInputElement | null} */ (
                    document.querySelector(".catalog-search")
                  );
                if (input) input.value = "";
                void load();
              },
            }),
          ]
        : [],
    );
  }

  // ── one renderer per kind ────────────────────────────────────────────────

  /**
   * F18: environments whose config declares `auth:` (redacted summary).
   * @returns {Array<Record<string, any>>}
   */
  function authEnvironments() {
    const list = state.project?.config?.registries?.auth;
    return Array.isArray(list) ? list : [];
  }

  /**
   * The built-in `login` action as a catalog row, when an environment
   * declares `auth:` and the catalog has no action named login (an
   * imported one wins over the built-in). Null otherwise, or when the
   * search text does not match it.
   * @param {Array<Record<string, any>>} actions the catalog's rows
   * @returns {Record<string, any> | null}
   */
  function builtinLoginRow(actions) {
    const envs = authEnvironments();
    if (!envs.length) return null;
    if (actions.some((action) => action?.name === BUILTIN_LOGIN)) return null;
    const row = {
      name: BUILTIN_LOGIN,
      builtin: true,
      description: `Built-in: signs in through the API with environments.<env>.auth (${envs
        .map((entry) => entry.env)
        .join(", ")}); credentials come from the secrets provider`,
      inputs: [],
      steps: null,
      usedBy: [],
    };
    const tokens = filters.query.toLowerCase().split(/\s+/).filter(Boolean);
    const haystack =
      `${row.name} ${row.description} sign in auth`.toLowerCase();
    return tokens.every((token) => haystack.includes(token)) ? row : null;
  }

  /** @param {Array<Record<string, any>>} rows */
  function actionsTable(rows) {
    const authEnvs = authEnvironments();
    return table(
      [
        "action",
        "description",
        "inputs",
        "steps",
        "used by",
        "last green",
        "file",
      ],
      rows.map((action) => {
        const inputs = Array.isArray(action.inputs) ? action.inputs : [];
        const required = inputs.filter((input) => input.required);
        const snippet = [
          `- use: ${action.name}`,
          ...(required.length
            ? ["  vars:", ...required.map((input) => `    ${input.name}: `)]
            : []),
        ].join("\n");
        return h(
          "tr",
          {
            class: "catalog-row",
            dataset: { name: action.name },
            title: matchTitle(action),
          },
          h(
            "td",
            { class: "cell-spec" },
            h("span", { class: "mono", text: action.name }),
            action.builtin
              ? (() => {
                  const node = Studio.tag("built-in", "info");
                  node.title =
                    "runs the environment's auth: block; import an action named login to replace it";
                  return node;
                })()
              : action.name === BUILTIN_LOGIN && authEnvs.length
                ? (() => {
                    const node = Studio.tag("overrides built-in", "warn");
                    node.title = `use: login runs this action, not environments.<env>.auth (${authEnvs
                      .map((entry) => entry.env)
                      .join(", ")})`;
                    return node;
                  })()
                : null,
            snippetButton("use:", snippet),
          ),
          h(
            "td",
            { class: "cell-summary" },
            action.description ?? "",
            (action.problems ?? []).map((/** @type {string} */ problem) =>
              (() => {
                const node = Studio.tag("problem", "warn");
                node.title = problem;
                return node;
              })(),
            ),
          ),
          h(
            "td",
            { class: "cell-labels" },
            inputs.map((input) =>
              h("span", {
                class: `tag catalog-input${input.required ? " required" : ""}`,
                title: [
                  input.description,
                  input.required ? "required" : "optional",
                  input.default !== undefined
                    ? `default ${input.default}`
                    : null,
                  input.configEnvs?.length
                    ? `config vars in ${input.configEnvs.join(", ")}`
                    : null,
                ]
                  .filter(Boolean)
                  .join(" · "),
                text: `${input.name}${input.required ? "*" : ""}`,
              }),
            ),
          ),
          h("td", { class: "num", text: String(action.steps ?? "—") }),
          h("td", null, usedByCell(action.usedBy)),
          h("td", null, runButton(action.lastGreenRun)),
          h(
            "td",
            null,
            action.builtin
              ? h("span", { class: "cell-dim", text: "config auth:" })
              : fileButton(action.file),
          ),
        );
      }),
      "catalog-actions",
    );
  }

  /** @param {Array<Record<string, any>>} rows */
  function varsTable(rows) {
    /** @type {Map<string, Array<Record<string, any>>>} */
    const byEnv = new Map();
    for (const row of rows) {
      const list = byEnv.get(row.env) ?? [];
      list.push(row);
      byEnv.set(row.env, list);
    }
    /** @type {HTMLElement[]} */
    const body = [];
    for (const [env, list] of byEnv) {
      body.push(
        h(
          "tr",
          { class: "catalog-group", dataset: { env } },
          h(
            "td",
            { colspan: "5" },
            h("strong", { class: "mono", text: env }),
            h("span", {
              class: "cell-dim",
              text: ` · ${list.length} var${list.length === 1 ? "" : "s"}`,
            }),
          ),
        ),
      );
      for (const row of list)
        body.push(
          h(
            "tr",
            {
              class: "catalog-row",
              dataset: { name: row.name, env },
              title: matchTitle(row),
            },
            h(
              "td",
              { class: "cell-spec" },
              h("span", { class: "mono", text: row.name }),
              snippetButton("${vars}", `\${vars.${row.name}}`),
            ),
            h(
              "td",
              { class: "mono" },
              row.masked
                ? (() => {
                    const node = Studio.tag("masked", "warn");
                    node.title =
                      "looks like a credential: cairn never shows its value";
                    return node;
                  })()
                : row.value === undefined
                  ? h("span", { class: "cell-dim", text: "—" })
                  : String(row.value),
            ),
            h("td", { class: "cell-summary", text: row.comment ?? "" }),
            h("td", {
              class: "cell-dim",
              text:
                row.definedIn === "inherited"
                  ? `inherited${
                      row.inheritedFrom ? ` from ${row.inheritedFrom}` : ""
                    }`
                  : "environment",
            }),
            h("td", null, usedByCell(row.usedBy)),
          ),
        );
    }
    return table(
      ["var", "value", "comment", "defined", "used by"],
      body,
      "catalog-vars",
    );
  }

  /** @param {Array<Record<string, any>>} rows */
  function verifiersTable(rows) {
    return table(
      ["script", "description", "fixtures", "used by"],
      rows.map((verifier) => {
        const keys = verifier.fixtures?.keys ?? [];
        const uses = Array.isArray(verifier.usedBy) ? verifier.usedBy : [];
        return h(
          "tr",
          {
            class: "catalog-row",
            dataset: { name: verifier.file },
            title: matchTitle(verifier),
          },
          h(
            "td",
            { class: "cell-spec" },
            fileButton(verifier.file),
            verifier.exists === false ? Studio.tag("missing", "bad") : null,
          ),
          h("td", { class: "cell-summary", text: verifier.description ?? "" }),
          h(
            "td",
            { class: "cell-labels" },
            h("span", {
              class: "cell-dim",
              title: verifier.fixtures?.dynamic
                ? "the script reads fixtures dynamically: unknown keys are not flagged"
                : "",
              text: `${verifier.fixtures?.source ?? "none"}${
                verifier.fixtures?.dynamic ? " · dynamic" : ""
              } `,
            }),
            keys.map((/** @type {any} */ key) =>
              h("span", {
                class: `tag catalog-input${key.required ? " required" : ""}`,
                title: [key.description, key.source]
                  .filter(Boolean)
                  .join(" · "),
                text: `${key.name}${key.required ? "*" : ""}`,
              }),
            ),
          ),
          h(
            "td",
            null,
            uses.length
              ? h(
                  "ul",
                  { class: "catalog-uses" },
                  uses.map((use) =>
                    h(
                      "li",
                      null,
                      h("span", {
                        class: "mono",
                        title: use.file,
                        text: `${use.spec} · ${use.outcome}`,
                      }),
                      h("span", {
                        class: "cell-dim",
                        text: ` (${use.runtime})`,
                      }),
                      use.missingKeys?.length
                        ? Studio.tag(
                            `missing ${use.missingKeys.join(", ")}`,
                            "bad",
                          )
                        : null,
                      use.unknownKeys?.length
                        ? Studio.tag(
                            `unknown ${use.unknownKeys.join(", ")}`,
                            "warn",
                          )
                        : null,
                    ),
                  ),
                )
              : h("span", { class: "cell-dim", text: "unused" }),
          ),
        );
      }),
      "catalog-verifiers",
    );
  }

  /**
   * One environment's auth summary (F18): the requests `use: login` sends
   * by method and path, and the secret names it reads; never values.
   * @param {Record<string, any> | undefined} auth
   * @returns {HTMLElement}
   */
  function authCell(auth) {
    if (!auth) return h("td", { class: "cell-dim", text: "—" });
    const calls = [
      auth.alreadyAuthenticated
        ? `probe ${auth.alreadyAuthenticated.method} ${auth.alreadyAuthenticated.path}`
        : null,
      auth.login ? `login ${auth.login.method} ${auth.login.path}` : null,
      ...(auth.after ?? []).map(
        (/** @type {any} */ entry) =>
          `${entry.id} ${entry.method} ${entry.path}${
            entry.when ? ` (when ${entry.when})` : ""
          }`,
      ),
      auth.hydrate ? `hydrate: ${auth.hydrate}` : null,
    ].filter(Boolean);
    return h(
      "td",
      { class: "cell-labels catalog-auth", title: calls.join("\n") },
      (() => {
        const node = Studio.tag("use: login", "ok");
        node.title = calls.join("\n");
        return node;
      })(),
      h("span", {
        class: "cell-dim mono",
        text: ` ${auth.login ? `${auth.login.method} ${auth.login.path}` : ""}${
          (auth.after ?? []).length
            ? ` +${auth.after.length} follow-up${
                auth.after.length === 1 ? "" : "s"
              }`
            : ""
        }${auth.hydrate ? " · hydrate" : ""}`,
      }),
      (auth.secrets ?? []).length
        ? h("div", {
            class: "cell-dim",
            title: "secret names the auth block reads (values never shown)",
            text: `secrets: ${auth.secrets.join(", ")}`,
          })
        : null,
    );
  }

  /** @param {Array<Record<string, any>>} rows */
  function envsTable(rows) {
    const authByEnv = new Map(
      authEnvironments().map((entry) => [entry.env, entry]),
    );
    const withAuth = authByEnv.size > 0;
    return table(
      [
        "environment",
        "baseUrl",
        "policy",
        "services",
        "secrets",
        "vars",
        ...(withAuth ? ["auth"] : []),
      ],
      rows.map((env) =>
        h(
          "tr",
          {
            class: "catalog-row",
            dataset: { name: env.name },
            title: matchTitle(env),
          },
          h(
            "td",
            { class: "mono" },
            env.name,
            env.default
              ? h("span", { class: "cell-dim", text: " (default)" })
              : null,
          ),
          h("td", { class: "cell-dim mono", text: env.baseUrl ?? "—" }),
          h(
            "td",
            { class: "cell-labels" },
            env.policy?.trait
              ? Studio.tag(
                  env.policy.trait,
                  env.policy.trait === "protected"
                    ? "refused"
                    : env.policy.trait === "shared"
                      ? "warn"
                      : "ok",
                )
              : null,
            env.policy?.mutations
              ? Studio.tag(
                  env.policy.mutations === "deny"
                    ? "mutations denied"
                    : "mutations allowed",
                  env.policy.mutations === "deny" ? "warn" : "ok",
                )
              : null,
            env.policy?.description
              ? h("span", { class: "cell-dim", text: env.policy.description })
              : null,
            !env.policy ? h("span", { class: "cell-dim", text: "—" }) : null,
          ),
          h("td", {
            class: "cell-dim",
            text: env.services?.enabled
              ? env.services.phases?.join(" → ") || "enabled"
              : "off",
          }),
          h("td", {
            class: "cell-dim",
            title: [
              ...(env.secrets?.required ?? []).map(
                (/** @type {string} */ key) => `${key} (required)`,
              ),
              ...(env.secrets?.keys ?? []),
            ].join("\n"),
            text: env.secrets
              ? `${env.secrets.provider} · ${
                  (env.secrets.keys ?? []).length +
                  (env.secrets.required ?? []).length
                } key(s)`
              : "—",
          }),
          h("td", { class: "num", text: String(env.vars ?? 0) }),
          withAuth ? authCell(authByEnv.get(env.name)) : null,
        ),
      ),
      "catalog-envs",
    );
  }

  /** @param {Array<Record<string, any>>} rows */
  function flowsTable(rows) {
    return table(
      ["flow", "intent", "env / requires", "actions", "last run", "file"],
      rows.map((flow) => {
        const abs = absPath(flow.file);
        return h(
          "tr",
          {
            class: "catalog-row",
            dataset: { name: flow.name },
            title: matchTitle(flow),
          },
          h(
            "td",
            { class: "cell-spec" },
            h("span", { class: "mono", text: flow.name }),
            flow.draft
              ? (() => {
                  const node = Studio.tag("draft", "info");
                  node.title =
                    "the file or a folder above it starts with _: cairn run <dir> skips it";
                  return node;
                })()
              : null,
            (flow.tags ?? []).map((/** @type {string} */ tag) =>
              h("span", { class: "tag label-tag", text: tag }),
            ),
          ),
          h("td", {
            class: "cell-summary",
            title: flow.intent,
            text: flow.intent,
          }),
          h(
            "td",
            { class: "cell-dim" },
            [
              flow.environment ? `env ${flow.environment}` : null,
              flow.requires
                ? CairnPolicy.describeRequires(
                    CairnPolicy.normalizeRequires(flow.requires),
                  )
                : null,
              flow.checkpoint ? `resume ${flow.checkpoint}` : null,
            ]
              .filter(Boolean)
              .join(" · ") || "—",
          ),
          h(
            "td",
            { class: "cell-labels" },
            (flow.actions ?? []).map((/** @type {string} */ name) =>
              h("span", { class: "tag", text: name }),
            ),
          ),
          h("td", null, runButton(flow.lastRun)),
          h(
            "td",
            { class: "row-actions" },
            abs
              ? h("button", {
                  class: "btn btn-sm",
                  type: "button",
                  text: "Open",
                  title: `Open ${flow.file} in Specs`,
                  onClick: () => Studio.navigate("specs", { file: abs }),
                })
              : null,
            fileButton(flow.file),
          ),
        );
      }),
      "catalog-flows",
    );
  }

  /** @param {string | null | undefined} health */
  function healthTone(health) {
    if (health === "ok") return "ok";
    if (health === "expired") return "warn";
    if (health === "missing") return "bad";
    return "muted";
  }

  /** @param {Array<Record<string, any>>} rows */
  function checkpointsTable(rows) {
    return table(
      ["checkpoint", "health", "scope", "expires", "used by"],
      rows.map((checkpoint) =>
        h(
          "tr",
          {
            class: "catalog-row",
            dataset: { name: checkpoint.name },
            title: matchTitle(checkpoint),
          },
          h("td", { class: "mono", text: checkpoint.name }),
          h(
            "td",
            null,
            (() => {
              const node = Studio.tag(
                checkpoint.health,
                healthTone(checkpoint.health),
              );
              node.title = checkpoint.problem?.message ?? "";
              return node;
            })(),
            checkpoint.problem
              ? h("div", {
                  class: "cell-dim",
                  text: `${checkpoint.problem.code}: ${checkpoint.problem.message}`,
                })
              : null,
          ),
          h("td", {
            class: "cell-dim mono",
            text:
              [checkpoint.scope?.env, checkpoint.scope?.baseUrl]
                .filter(Boolean)
                .join(" · ") || "unscoped",
          }),
          h(
            "td",
            {
              class: "cell-dim",
              title: checkpoint.scope?.ttl ? `ttl ${checkpoint.scope.ttl}` : "",
            },
            checkpoint.scope?.expiresAt
              ? Studio.relTime(checkpoint.scope.expiresAt)
              : "never",
          ),
          h("td", null, usedByCell(checkpoint.usedBy)),
        ),
      ),
      "catalog-checkpoints",
    );
  }

  /** @type {Record<string, (rows: Array<Record<string, any>>) => HTMLElement>} */
  const RENDERERS = {
    actions: actionsTable,
    vars: varsTable,
    verifiers: verifiersTable,
    envs: envsTable,
    flows: flowsTable,
    checkpoints: checkpointsTable,
    datasources: datasourcesTable,
    gates: gatesTable,
    fixtures: fixturesTable,
    widgets: widgetsTable,
  };

  // ── painting ─────────────────────────────────────────────────────────────

  /**
   * Rows of one kind, and how many matched before the limit.
   * @param {string} kind
   * @returns {{ rows: Array<Record<string, any>>, total: number | null }}
   */
  function rowsOf(kind) {
    const payload = result?.payload ?? null;
    if (fromConfig(kind)) {
      const rows = configRows(kind);
      return { rows, total: rows.length };
    }
    const rows = Array.isArray(payload?.[kind]) ? payload[kind] : [];
    const total =
      typeof payload?.totals?.[kind] === "number" ? payload.totals[kind] : null;
    if (kind === "actions" && payload) {
      const login = builtinLoginRow(rows);
      if (login)
        return {
          rows: [...rows, login],
          total: total === null ? null : total + 1,
        };
    }
    return { rows, total };
  }

  /**
   * Does this tab come from the config summary (the catalog has no rows of
   * that kind)?
   * @param {string} kind
   * @returns {boolean}
   */
  function fromConfig(kind) {
    return CONFIG_KINDS.has(kind) && !Array.isArray(result?.payload?.[kind]);
  }

  /**
   * Is a kind's tab shown? Config kinds only when the catalog reports them,
   * the config declares some, or the reader is on that tab.
   * @param {string} kind
   * @returns {boolean}
   */
  function tabShown(kind) {
    if (!CONFIG_KINDS.has(kind) || !fromConfig(kind)) return true;
    if (filters.tab === kind) return true;
    const registries = state.project?.config?.registries ?? null;
    if (kind === "widgets") return Boolean(registries?.widgets?.declared);
    if (kind === "datasources")
      return (
        (registries?.datasources?.topLevel ?? []).length > 0 ||
        (registries?.datasources?.environments ?? []).some(
          (/** @type {any} */ env) => env.datasources.length > 0,
        )
      );
    return (registries?.[kind] ?? []).length > 0;
  }

  /**
   * Config registry rows (state.project.config.registries), filtered by the
   * search text and, for datasources, resolved for the picked environment.
   * @param {string} kind
   * @returns {Array<Record<string, any>>}
   */
  function configRows(kind) {
    const registries = state.project?.config?.registries ?? null;
    if (!registries) return [];
    /** @type {Array<Record<string, any>>} */
    let rows = [];
    if (kind === "datasources") {
      const environments = registries.datasources?.environments ?? [];
      const picked = filters.env
        ? environments.find((/** @type {any} */ env) => env.env === filters.env)
        : null;
      if (picked)
        rows = picked.datasources.map((/** @type {any} */ ds) => ({
          ...ds,
          envs: [],
        }));
      else {
        const names = new Set();
        rows = [];
        for (const ds of registries.datasources?.topLevel ?? []) {
          names.add(ds.name);
          rows.push({ ...ds, state: "top-level" });
        }
        for (const env of environments)
          for (const ds of env.datasources)
            if (!names.has(ds.name)) {
              names.add(ds.name);
              rows.push({ ...ds, state: "env-only" });
            }
        rows = rows.map((row) => ({
          ...row,
          envs: environments
            .map((/** @type {any} */ env) => {
              const entry = env.datasources.find(
                (/** @type {any} */ ds) => ds.name === row.name,
              );
              return entry && entry.state !== "inherited"
                ? `${env.env}: ${
                    entry.state === "env-only" ? "declared" : entry.state
                  }`
                : null;
            })
            .filter(Boolean),
        }));
      }
    } else if (kind === "gates") rows = registries.gates ?? [];
    else if (kind === "fixtures") rows = registries.fixtures ?? [];
    else if (kind === "widgets") {
      const widgets = registries.widgets ?? null;
      rows = widgets
        ? [
            ...(widgets.drivers ?? []).map(
              (/** @type {any} */ driver, /** @type {number} */ index) => ({
                section: "driver",
                order: index + 1,
                defaulted: widgets.driversDefaulted,
                ...driver,
              }),
            ),
            ...(widgets.fieldRoot ?? []).map((/** @type {string} */ name) => ({
              section: "fieldRoot",
              name,
              defaulted: widgets.fieldRootDefaulted,
            })),
            ...(widgets.appHandles ?? []).map((/** @type {string} */ name) => ({
              section: "appHandle",
              name,
            })),
          ]
        : [];
    }
    const tokens = filters.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!tokens.length) return rows;
    return rows.filter((row) => {
      const haystack = JSON.stringify(row).toLowerCase();
      return tokens.every((token) => haystack.includes(token));
    });
  }

  /** @param {Array<Record<string, any>>} rows */
  function datasourcesTable(rows) {
    return table(
      ["datasource", "kind", "target", "details", "environments", "use"],
      rows.map((ds) =>
        h(
          "tr",
          { class: "catalog-row", dataset: { name: ds.name } },
          h("td", { class: "mono" }, ds.name),
          h(
            "td",
            null,
            Studio.tag(ds.kind, ds.known === false ? "warn" : "info"),
          ),
          h("td", {
            class: "mono cell-dim",
            title: ds.target ?? "",
            text:
              ds.state === "disabled" ? "disabled here" : (ds.target ?? "—"),
          }),
          h("td", {
            class: "cell-dim",
            text: (ds.facts ?? [])
              .map((/** @type {[string, string]} */ [k, v]) => `${k}: ${v}`)
              .join(" · "),
          }),
          h("td", {
            class: "cell-dim",
            text: (ds.envs ?? []).length
              ? ds.envs.join(", ")
              : ds.state === "top-level"
                ? "every environment"
                : (ds.state ?? "—"),
          }),
          h("td", null, snippetButton("verify", datasourceSnippet(ds))),
        ),
      ),
      "catalog-datasources",
    );
  }

  /**
   * A starter `verify:` block for a datasource.
   * @param {Record<string, any>} ds
   * @returns {string}
   */
  function datasourceSnippet(ds) {
    if (ds.kind === "mongo")
      return `mongo:\n  source: ${ds.name}\n  collection: <collection>\n  filter: {}\n  expect:\n    exists: true`;
    if (ds.kind === "temporal")
      return `temporal:\n  source: ${ds.name}\n  workflowId: <workflow id>\n  expect:\n    status: COMPLETED`;
    return `http:\n  source: ${ds.name}\n  url: /\n  expect:\n    status: 200`;
  }

  /** @param {Array<Record<string, any>>} rows */
  function gatesTable(rows) {
    return table(
      ["gate", "probe", "target", "policy", "waited by", "use"],
      rows.map((gate) =>
        h(
          "tr",
          {
            class: "catalog-row",
            dataset: { name: gate.name },
            title: gate.description ?? null,
          },
          h("td", { class: "mono" }, gate.name),
          h("td", null, Studio.tag(gate.probe, "info")),
          h("td", {
            class: "mono cell-dim",
            title: gate.target ?? "",
            text: gate.target ?? "—",
          }),
          h("td", {
            class: "cell-dim",
            text:
              [
                gate.timeout ? `timeout ${gate.timeout}` : null,
                gate.every ? `every ${gate.every}` : null,
                gate.stable ? `stable ×${gate.stable}` : null,
              ]
                .filter(Boolean)
                .join(" · ") || "defaults",
          }),
          h("td", {
            class: "cell-dim",
            text: (gate.usedBy ?? []).join(", ") || "—",
          }),
          h(
            "td",
            null,
            snippetButton("wait", `preconditions:\n  wait: [${gate.name}]`),
          ),
        ),
      ),
      "catalog-gates",
    );
  }

  /** @param {Array<Record<string, any>>} rows */
  function fixturesTable(rows) {
    return table(
      ["fixture", "kind", "scope", "verbs", "outputs", "use"],
      rows.map((fixture) =>
        h(
          "tr",
          {
            class: "catalog-row",
            dataset: { name: fixture.name },
            title: fixture.description ?? null,
          },
          h(
            "td",
            { class: "mono" },
            fixture.name,
            (fixture.needs ?? []).length
              ? h("span", {
                  class: "cell-dim",
                  text: ` needs ${fixture.needs.join(", ")}`,
                })
              : null,
          ),
          h("td", null, Studio.tag(fixture.kind, "info")),
          h("td", { class: "cell-dim", text: fixture.scope ?? "—" }),
          h("td", {
            class: "cell-dim",
            text: (fixture.verbs ?? []).join(" · ") || "—",
          }),
          h("td", {
            class: "mono cell-dim",
            text:
              (fixture.outputs ?? [])
                .map(
                  (/** @type {string} */ key) =>
                    `\${fixtures.${fixture.name}.${key}}`,
                )
                .join(" ") || "—",
          }),
          h(
            "td",
            null,
            snippetButton("fixtures", `fixtures: [${fixture.name}]`),
          ),
        ),
      ),
      "catalog-fixtures",
    );
  }

  /** Widget registry sections, in the order the runner uses them. */
  const WIDGET_SECTIONS = [
    {
      id: "driver",
      label: "drivers",
      note: "tried in this order by match(root); set / check / choose / form use the first that matches",
    },
    {
      id: "fieldRoot",
      label: "field roots",
      note: "{key} → the field container; the first template with a visible match wins",
    },
    {
      id: "appHandle",
      label: "app handles",
      note: "window.__cairn.app.<name> for eval, script verifiers and wait: { app }",
    },
  ];

  /** @param {Array<Record<string, any>>} rows */
  function widgetsTable(rows) {
    /** @type {HTMLElement[]} */
    const body = [];
    for (const section of WIDGET_SECTIONS) {
      const list = rows.filter((row) => row.section === section.id);
      if (!list.length) continue;
      body.push(
        h(
          "tr",
          { class: "catalog-group", dataset: { section: section.id } },
          h(
            "td",
            { colspan: "4" },
            h("strong", { text: section.label }),
            h("span", { class: "cell-dim", text: ` · ${section.note}` }),
            list[0].defaulted
              ? h("span", {
                  class: "cell-dim",
                  text: " · default (the config does not set it)",
                })
              : null,
          ),
        ),
      );
      for (const row of list)
        body.push(
          h(
            "tr",
            {
              class: "catalog-row",
              dataset: { name: row.name, section: section.id },
            },
            h(
              "td",
              { class: "cell-spec" },
              row.order
                ? h("span", { class: "cell-dim", text: `${row.order}. ` })
                : null,
              h("span", { class: "mono", text: row.name }),
            ),
            h(
              "td",
              null,
              section.id === "driver"
                ? Studio.tag(
                    row.source === "project" ? "project driver" : "built-in",
                    row.source === "project" ? "warn" : "info",
                  )
                : null,
              row.appended
                ? h("span", {
                    class: "cell-dim",
                    text: " appended (native)",
                  })
                : null,
            ),
            h("td", {
              class: "mono cell-dim",
              title:
                row.source === "project"
                  ? "project code: it runs in the page, like an eval file"
                  : "",
              text: row.file ?? "",
            }),
            h(
              "td",
              null,
              section.id === "driver"
                ? snippetButton(
                    "set",
                    // a project driver is named by its module's `name`
                    // export, which the config does not show
                    row.source === "project"
                      ? "- set: { field: <key>, value: <value>, driver: <the module's name> }"
                      : `- set: { field: <key>, value: <value>, driver: ${row.name} }`,
                  )
                : section.id === "appHandle"
                  ? snippetButton(
                      "wait",
                      `- wait: { app: { path: ${row.name}, exists: true } }`,
                    )
                  : null,
            ),
          ),
        );
    }
    return table(["name", "kind", "file", "use"], body, "catalog-widgets");
  }

  function paintTabs() {
    if (!dom) return;
    const { tabs } = dom;
    tabs.replaceChildren(
      ...KINDS.filter((kind) => tabShown(kind.id)).map((kind) => {
        const { rows, total } = rowsOf(kind.id);
        const selected = filters.tab === kind.id;
        const count =
          result?.payload || fromConfig(kind.id)
            ? (total ?? rows.length)
            : null;
        return h(
          "button",
          {
            class: `tab${selected ? " active" : ""}`,
            type: "button",
            role: "tab",
            id: `catalog-tab-${kind.id}`,
            ariaSelected: selected ? "true" : "false",
            ariaControls: "catalog-panel",
            tabindex: selected ? "0" : "-1",
            dataset: { tab: kind.id },
            onClick: () => {
              filters.tab = kind.id;
              paint();
              /** @type {HTMLElement | null} */ (
                tabs.querySelector(`[data-tab="${kind.id}"]`)
              )?.focus();
            },
          },
          kind.label,
          count === null
            ? null
            : h("span", { class: "count", text: String(count) }),
        );
      }),
    );
  }

  function paint() {
    if (!dom) return;
    paintTabs();
    const { body, cli, warnings } = dom;
    cli.replaceChildren(
      result?.cli
        ? h(
            "div",
            { class: "toolbar cli-line" },
            h("code", { class: "mono", text: result.cli }),
            Studio.copyButton(() => String(result?.cli ?? "")),
          )
        : "",
    );
    body.setAttribute("aria-labelledby", `catalog-tab-${filters.tab}`);
    // Config registries render whatever the catalog command answered.
    if (fromConfig(filters.tab)) {
      const { rows } = rowsOf(filters.tab);
      body.replaceChildren(
        rows.length ? RENDERERS[filters.tab](rows) : emptyKind(filters.tab),
        h("p", {
          class: "cell-dim",
          text: "From the project config (redacted: ${env.X} / ${secrets.X} stay references, literal connection strings are masked).",
        }),
      );
      warnings.replaceChildren();
      return;
    }
    if (loading && !result) {
      body.replaceChildren(Studio.loading("cairn catalog…"));
      warnings.replaceChildren();
      return;
    }
    if (loadError) {
      body.replaceChildren(Studio.errorBox(loadError, "cairn catalog"));
      warnings.replaceChildren();
      return;
    }
    if (result && !result.ok) {
      body.replaceChildren(
        result.unsupported
          ? Studio.empty(
              "This cairn has no catalog",
              `\`cairn catalog\` lists what a project already has (actions, vars, verifiers, environments, flows, checkpoints). The resolved binary does not know it: update cairn, or point Studio at a newer one. (${fmt.truncate(
                result.stderr || result.meaning || "",
                160,
              )})`,
              [
                h("button", {
                  class: "btn btn-primary",
                  type: "button",
                  text: "Open Settings",
                  onClick: () => Studio.navigate("settings"),
                }),
              ],
            )
          : Studio.errorBox(
              new Error(
                result.stderr ||
                  `cairn catalog exited ${result.exitCode} (${result.meaning})`,
              ),
              "cairn catalog",
            ),
      );
      warnings.replaceChildren();
      return;
    }
    const { rows, total } = rowsOf(filters.tab);
    body.replaceChildren(
      rows.length ? RENDERERS[filters.tab](rows) : emptyKind(filters.tab),
      total !== null && total > rows.length
        ? h("p", {
            class: "cell-dim",
            text: `showing ${rows.length} of ${total}; refine the search to narrow it`,
          })
        : "",
    );
    const notes = [
      ...(Array.isArray(result?.payload?.warnings)
        ? result.payload.warnings
        : []),
      result?.payload?.scan?.truncated
        ? "the file walk stopped at its bound: some files were not read"
        : null,
    ].filter(Boolean);
    warnings.replaceChildren(
      notes.length ? Studio.evidenceLines(notes.map(String)) : "",
    );
  }

  async function load() {
    const seq = ++loadSeq;
    loading = true;
    paint();
    try {
      const answer = await api.call("catalog:get", {
        query: filters.query,
        env: filters.env || null,
        limit: filters.query ? QUERY_LIMIT : null,
      });
      if (seq !== loadSeq) return;
      result = answer;
      loadError = null;
    } catch (error) {
      if (seq !== loadSeq) return;
      loadError = error;
    } finally {
      if (seq === loadSeq) loading = false;
    }
    paint();
  }

  // ── view lifecycle ───────────────────────────────────────────────────────

  /**
   * @param {HTMLElement} root
   * @param {{ query?: string, tab?: string }} [params]
   */
  async function render(root, params = {}) {
    if (typeof params?.query === "string") filters.query = params.query;
    if (typeof params?.tab === "string" && RENDERERS[params.tab])
      filters.tab = params.tab;
    Studio.clear(root);
    root.appendChild(
      Studio.pageHeader(
        "Catalog",
        "What this project already has: reuse its actions, vars, verifiers and checkpoints when you author a spec",
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "Refresh",
            onClick: () => void load(),
          }),
        ],
      ),
    );
    const notice = Studio.setupNotice();
    if (notice) root.appendChild(notice);
    const search = Studio.input({
      type: "search",
      class: "catalog-search",
      value: filters.query,
      placeholder:
        "search actions, vars, verifiers, flows… (ranked by cairn catalog --query)",
      ariaLabel: "search the catalog",
      style: { minWidth: "360px" },
    });
    const environments = state.project?.config?.environments ?? [];
    // Filters outlive a project switch: an environment of another project
    // would reach cairn as an unknown --env (exit 4).
    if (
      filters.env &&
      !environments.some((/** @type {any} */ env) => env?.name === filters.env)
    )
      filters.env = "";
    const envSelect = Studio.select(
      [
        ["", "every environment"],
        ...environments.map((/** @type {any} */ env) => [env.name, env.name]),
      ],
      { value: filters.env, ariaLabel: "environment for vars and last runs" },
    );
    search.addEventListener("input", () => {
      filters.query = search.value.trim();
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => {
        debounce = null;
        void load();
      }, DEBOUNCE_MS);
    });
    search.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") return;
      if (debounce) clearTimeout(debounce);
      debounce = null;
      filters.query = search.value.trim();
      void load();
    });
    envSelect.addEventListener("change", () => {
      filters.env = envSelect.value;
      void load();
    });
    root.appendChild(
      h(
        "div",
        { class: "toolbar" },
        h(
          "label",
          { class: "field", style: { flex: "1 1 360px" } },
          "search",
          search,
        ),
        h("label", { class: "field" }, "environment", envSelect),
      ),
    );
    const tabs = h("div", {
      class: "tabs catalog-tabs",
      role: "tablist",
      ariaLabel: "catalog kinds",
    });
    Studio.rovingKeys(tabs, {
      items: () => /** @type {HTMLElement[]} */ ([
        ...tabs.querySelectorAll(".tab"),
      ]),
      orientation: "horizontal",
      onMove: (tab) => tab.click(),
    });
    const cli = h("div", { class: "catalog-cli" });
    const body = h("div", {
      class: "catalog-body",
      id: "catalog-panel",
      role: "tabpanel",
    });
    const warnings = h("div", { class: "catalog-warnings" });
    root.appendChild(cli);
    root.appendChild(tabs);
    root.appendChild(body);
    root.appendChild(warnings);
    dom = { tabs, body, cli, warnings };
    const mine = dom;
    await load();
    return {
      destroy() {
        if (debounce) clearTimeout(debounce);
        debounce = null;
        if (dom === mine) dom = null;
      },
    };
  }

  Studio.views = Studio.views || {};
  Studio.views.catalog = {
    id: "catalog",
    label: "Catalog",
    glyph: "⊞",
    render,
  };
  Studio.catalogView = { filters };
})();
