/**
 * Environment view — everything that decides whether a run can succeed.
 *
 * `cairn doctor` checks, the project config cairn discovered (with each
 * environment's policy: trait, mutations, description, and — when the config
 * declares services — its `services up` lock with Services up / Services
 * down buttons that run `cairn services up|down --env`), services and
 * checkpoint state (env / baseUrl scope, expiry, health when the CLI reports
 * them), the config registries (datasources per environment with their kind
 * and a redacted target, readiness gates, fixtures with the project
 * ledger's last state), and the retention/clean controls for the artifact
 * root.
 * When a spec fails for environmental reasons, this is the first place to look.
 */
(function bootEnvironmentView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, api, fmt, toast } = Studio;

  /** @param {HTMLElement} root */
  async function render(root) {
    Studio.clear(root);
    root.appendChild(Studio.loading("checking environment…"));

    const registries = state.project?.config?.registries ?? null;
    const [info, doctor, services, checkpoints, ledger] =
      await Promise.allSettled([
        api.call("app:info"),
        api.call("cairn:doctor"),
        api.call("services:status"),
        api.call("checkpoints:list"),
        // the fixture ledger only matters when the config declares fixtures
        (registries?.fixtures ?? []).length
          ? api.call("fixtures:ledger")
          : Promise.resolve(null),
      ]);

    Studio.clear(root);
    const appInfo = info.status === "fulfilled" ? info.value : null;
    root.appendChild(
      Studio.pageHeader(
        "Environment",
        appInfo?.cairn?.command
          ? `${appInfo.cairn.command} (${appInfo.cairn.source})`
          : "no cairn binary resolved — set one in Settings",
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "Re-check",
            onClick: () => void render(root),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Settings",
            onClick: () => Studio.navigate("settings"),
          }),
        ],
      ),
    );

    if (!appInfo?.cairn?.command) {
      root.appendChild(
        Studio.empty(
          "cairn not found",
          "Install the CLI (`npm i -g @thelacanians/cairntrace` or `brew install abdul-hamid-achik/tap/cairntrace`), or point Studio at a checkout's bin/cairn in Settings.",
          [
            h("button", {
              class: "btn btn-primary",
              type: "button",
              text: "Open Settings",
              onClick: () => Studio.navigate("settings"),
            }),
          ],
        ),
      );
      return;
    }

    root.appendChild(versionCards(appInfo));

    if (doctor.status === "fulfilled")
      root.appendChild(doctorPanel(doctor.value));
    else root.appendChild(Studio.errorBox(doctor.reason, "cairn doctor"));

    root.appendChild(orphansPanel());
    root.appendChild(projectPanel(appInfo));
    root.appendChild(environmentsPanel());
    const registryPanel = registriesPanel(
      registries,
      ledger.status === "fulfilled" ? ledger.value : null,
    );
    if (registryPanel) root.appendChild(registryPanel);

    if (services.status === "fulfilled")
      root.appendChild(servicesPanel(services.value));
    const windowsPanel = serviceWindowsPanel();
    if (windowsPanel) root.appendChild(windowsPanel);
    if (checkpoints.status === "fulfilled")
      root.appendChild(checkpointsPanel(checkpoints.value));

    root.appendChild(retentionPanel(appInfo, root));
  }

  /** @param {any} info */
  function versionCards(info) {
    return h("div", { class: "stat-cards" }, [
      card(
        "Studio",
        `v${info.appVersion}`,
        `electron ${info.electronVersion} · node ${info.nodeVersion}`,
      ),
      card(
        "cairn",
        info.cairn?.source ?? "—",
        info.cairn?.command ?? "unresolved",
      ),
      card(
        "platform",
        `${info.platform}/${info.arch}`,
        "renderer chrome " + (info.chromeVersion ?? ""),
      ),
      card(
        "artifact root",
        String(info.runsRoot?.runsRoot ?? "—")
          .split("/")
          .slice(-2)
          .join("/"),
        `source: ${info.runsRoot?.source ?? "?"}`,
      ),
    ]);
  }

  /** @param {any} result */
  function doctorPanel(result) {
    const payload = result?.payload ?? {};
    const checks = Array.isArray(payload.checks) ? payload.checks : [];
    const failed = checks.filter((check) => !check.ok);
    return Studio.panel(
      `cairn doctor · ${checks.length - failed.length}/${checks.length} passing`,
      [
        failed.length
          ? h(
              "div",
              { class: "error-box" },
              h("strong", { text: `${failed.length} check(s) failing` }),
              h("pre", {
                text: failed
                  .map((check) => `${check.name}: ${check.detail}`)
                  .join("\n"),
              }),
            )
          : h("p", {
              class: "cell-dim",
              style: { marginTop: 0 },
              text: "every dependency cairn needs is present and executable",
            }),
        h(
          "div",
          { class: "panel", style: { marginTop: "10px" } },
          h(
            "div",
            { class: "panel-body tight" },
            checks.map((check) =>
              h(
                "div",
                { class: "list-row", style: { cursor: "default" } },
                h("span", { class: `dot dot-${check.ok ? "ok" : "bad"}` }),
                h("span", {
                  class: "mono",
                  style: { fontSize: "11.5px", minWidth: "150px" },
                  text: check.name,
                }),
                h("span", {
                  class: "cell-summary",
                  style: { whiteSpace: "pre-wrap", maxWidth: "none" },
                  text: fmt.truncate(String(check.detail ?? ""), 400),
                }),
              ),
            ),
          ),
        ),
        result?.stderr
          ? h("pre", {
              class: "code tight",
              style: { marginTop: "8px" },
              text: fmt.truncate(result.stderr, 2000),
            })
          : null,
      ],
      {
        actions: [
          h("span", {
            class: `tag ${failed.length ? "tag-bad" : "tag-ok"}`,
            text: payload.ok ? "ok" : "not ok",
          }),
        ],
      },
    );
  }

  /** @param {any} info */
  function projectPanel(info) {
    const project = state.project;
    const config = project?.config ?? null;
    const rows = [
      ["project dir", project?.dir ?? "—"],
      ["config file", config?.path ?? "not found (cairn will use defaults)"],
      ["project name", config?.project ?? "—"],
      ["default environment", config?.defaultEnvironment ?? "—"],
      [
        "environments",
        (config?.environments ?? []).map((env) => env.name).join(", ") || "—",
      ],
      ["artifactRoot (config)", config?.artifactRoot ?? "—"],
      ["browser backend", config?.backend ?? "agent-browser (default)"],
      ["testIdAttribute", config?.testIdAttribute ?? "data-testid (default)"],
      ["webServer", config?.hasWebServer ? "declared" : "—"],
      [
        "services",
        config?.hasServices
          ? "declared (provisioner/tunnels/docker/files/seed/tmux)"
          : "—",
      ],
      [
        "retention",
        config?.retention
          ? JSON.stringify(config.retention)
          : "keepRuns 3 (default)",
      ],
    ];
    return Studio.panel(
      "discovered project config",
      [
        Studio.keyValue(rows),
        config?.parseError
          ? h(
              "div",
              { class: "error-box", style: { marginTop: "8px" } },
              h("strong", { text: `config parse error: ${config.parseError}` }),
            )
          : null,
        h(
          "div",
          { class: "toolbar", style: { marginTop: "10px" } },
          h("button", {
            class: "btn btn-sm",
            type: "button",
            text: "Reveal project",
            onClick: () =>
              api
                .call("fs:reveal", project?.dir)
                .catch(() => toast("Reveal failed", null, "bad")),
          }),
          config?.path
            ? h("button", {
                class: "btn btn-sm",
                type: "button",
                text: "Reveal config",
                onClick: () =>
                  api
                    .call("fs:reveal", config.path)
                    .catch(() => toast("Reveal failed", null, "bad")),
              })
            : null,
          h("span", {
            class: "cell-dim",
            text: `cairn ${info.cairn?.command ?? ""} runs with cwd = project dir`,
          }),
        ),
      ],
      {
        actions: [
          h("button", {
            class: "btn btn-sm",
            type: "button",
            text: "Change project…",
            onClick: () => Studio.emit("menu:open-project"),
          }),
        ],
      },
    );
  }

  /** @param {any} result */
  function servicesPanel(result) {
    const payload = result?.payload ?? null;
    return Studio.panel("services lifecycle", [
      payload
        ? h("div", { class: "tree" }, Studio.jsonTree(payload))
        : h("pre", {
            class: "code tight",
            text: fmt.truncate(
              result?.stdout ||
                result?.stderr ||
                "no services declared for this project",
              3000,
            ),
          }),
      h("p", {
        class: "cell-dim",
        text: "cairn owns docker/seed/tmux around a run; tmux sessions are reused between runs by design.",
      }),
    ]);
  }

  /**
   * A `services status` lock report (owner, age, staleness) in its cell.
   * @param {HTMLElement} cell
   * @param {Record<string, any> | null} result `services:lock`
   */
  function paintLock(cell, result) {
    const report = result?.lock ?? null;
    if (!report) {
      const node = h("span", {
        class: "cell-dim",
        text: result?.ok === false ? "status failed" : "unknown",
      });
      node.title = fmt.truncate(String(result?.stderr ?? ""), 400);
      cell.replaceChildren(node);
      return;
    }
    if (report.state === "absent") {
      const node = Studio.tag("no lock");
      node.title = `no services-up lock (${report.path ?? ""}): services start and stop with each run`;
      cell.replaceChildren(node);
      return;
    }
    if (report.state === "unreadable") {
      const node = Studio.tag("unreadable lock", "bad");
      node.title = `${report.path ?? ""}${
        report.reason ? `\n${report.reason}` : ""
      }`;
      cell.replaceChildren(node);
      return;
    }
    const lock = report.lock ?? {};
    const tag = Studio.tag(
      report.stale ? "held · stale" : "held",
      report.stale ? "warn" : "info",
    );
    tag.title = [
      report.path,
      lock.configPath ? `config ${lock.configPath}` : null,
      ...(Array.isArray(report.problems) ? report.problems : []),
      "runs on this environment need --reuse-services while it is held",
    ]
      .filter(Boolean)
      .join("\n");
    cell.replaceChildren(
      tag,
      h("span", {
        class: "cell-dim services-owner",
        text: ` ${[lock.by, lock.pid ? `pid ${lock.pid}` : null]
          .filter(Boolean)
          .join(" · ")} `,
      }),
      lock.startedAt
        ? Studio.relTime(lock.startedAt, { prefix: "since " })
        : typeof report.ageSeconds === "number"
          ? h("span", {
              class: "cell-dim",
              text: `${fmt.formatDuration(report.ageSeconds * 1000)} old`,
            })
          : "",
    );
  }

  /**
   * Read one environment's services-up lock into its cell; while Studio
   * runs `services up|down` for it, its buttons stay disabled.
   * @param {string} env
   * @param {HTMLElement} cell
   * @param {HTMLButtonElement[]} buttons
   */
  async function refreshLock(env, cell, buttons) {
    try {
      const result = await api.call("services:lock", { env });
      paintLock(cell, result);
      for (const button of buttons)
        button.toggleAttribute("disabled", Boolean(result?.busy));
      if (result?.busy)
        cell.appendChild(
          h("span", {
            class: "cell-dim",
            text: ` · services ${result.busy} running`,
          }),
        );
    } catch (error) {
      const node = h("span", { class: "cell-dim", text: "unknown" });
      node.title = String(error?.message ?? error);
      cell.replaceChildren(node);
    }
  }

  /**
   * The one-line summary of a `services up|down --json` result.
   * @param {"up" | "down"} action
   * @param {Record<string, any> | null} payload
   * @returns {string}
   */
  function servicesSummary(action, payload) {
    if (!payload) return "";
    const parts =
      action === "up"
        ? Object.entries(payload.phases ?? {}).map(
            ([phase, what]) => `${phase} ${what}`,
          )
        : [
            `${(payload.teardown ?? []).length} teardown command(s)`,
            payload.tmuxKilled ? "tmux session killed" : null,
            payload.removedLock ? "lock removed" : null,
          ];
    if (typeof payload.durationMs === "number")
      parts.push(fmt.formatDuration(payload.durationMs));
    for (const warning of payload.warnings ?? [])
      parts.push(`warning: ${warning}`);
    return parts.filter(Boolean).join(" · ");
  }

  /**
   * Run `cairn services up|down --env <env>` (main asks natively first).
   * @param {"up" | "down"} action
   * @param {string} env
   * @param {HTMLElement} cell
   * @param {HTMLButtonElement[]} buttons
   */
  async function runServices(action, env, cell, buttons) {
    const button = buttons.find((entry) => entry.dataset.action === action);
    const label = button?.textContent ?? "";
    for (const entry of buttons) entry.toggleAttribute("disabled", true);
    if (button)
      button.textContent = action === "up" ? "Starting…" : "Stopping…";
    try {
      const result = await api.call(`services:${action}`, { env });
      if (result?.cancelled) return;
      toast(
        result?.ok
          ? `Services ${action} · ${env}`
          : `services ${action} failed · ${env}`,
        result?.ok
          ? servicesSummary(action, result.payload)
          : fmt.truncate(
              result?.unsupported
                ? `this cairn has no \`cairn services ${action}\` (${result.stderr ?? ""})`
                : String(
                    result?.error ?? result?.stderr ?? result?.meaning ?? "",
                  ),
              260,
            ),
        result?.ok ? "ok" : "bad",
        result?.ok ? 6000 : 12000,
      );
    } catch (error) {
      toast(
        `services ${action} not started · ${env}`,
        String(error?.message ?? error),
        "bad",
        9000,
      );
    } finally {
      if (button) button.textContent = label;
      for (const entry of buttons) entry.toggleAttribute("disabled", false);
      void refreshLock(env, cell, buttons);
    }
  }

  /**
   * Every environment the config defines, with its policy (trait,
   * mutations, description): what `cairn run` checks before it refuses a
   * spec. Specs declare what they need with `requires:`. When the config
   * declares services, each environment shows its `services up` lock
   * (owner, age) and Services up / Services down buttons.
   * @returns {HTMLElement}
   */
  function environmentsPanel() {
    const config = state.project?.config ?? null;
    const environments = config?.environments ?? [];
    if (!environments.length)
      return Studio.panel("environments & policy", [
        h("p", {
          class: "cell-dim",
          style: { marginTop: 0 },
          text: config?.path
            ? "The config defines no environments: runs use the local fallback with no baseUrl."
            : "No cairntrace.config.yml found for this project.",
        }),
      ]);
    const servicesDeclared = Boolean(config?.hasServices);
    const body = h("tbody");
    for (const env of environments) {
      const policy = env.policy ?? null;
      // `services: false` (an environment without any in a config that
      // declares them per environment) has no lock to check.
      const withServices =
        servicesDeclared && !env.disabled && env.services !== false;
      const lockCell = h(
        "td",
        { class: "services-lock", dataset: { env: env.name } },
        withServices
          ? h("span", { class: "cell-dim", text: "checking…" })
          : h("span", {
              class: "cell-dim",
              text: env.disabled ? "services off" : "—",
            }),
      );
      /** @type {HTMLButtonElement[]} */
      const buttons = [];
      if (withServices) {
        for (const action of /** @type {Array<"up" | "down">} */ ([
          "up",
          "down",
        ]))
          buttons.push(
            /** @type {HTMLButtonElement} */ (
              h("button", {
                class: `btn btn-sm${action === "down" ? " btn-ghost" : ""}`,
                type: "button",
                text: action === "up" ? "Services up" : "Services down",
                title:
                  action === "up"
                    ? `cairn services up --env ${env.name}: start docker → seed → tmux and keep them running (asks first)`
                    : `cairn services down --env ${env.name}: tear the services down and remove the lock (asks first)`,
                ariaLabel: `services ${action} for ${env.name}`,
                dataset: { action, env: env.name },
                onClick: () =>
                  void runServices(action, env.name, lockCell, buttons),
              })
            ),
          );
        void refreshLock(env.name, lockCell, buttons);
      }
      body.appendChild(
        h(
          "tr",
          {
            class: "env-row",
            dataset: { env: env.name },
            style: { cursor: "default" },
          },
          h(
            "td",
            { class: "mono" },
            env.name,
            env.name === config?.defaultEnvironment
              ? h("span", { class: "cell-dim", text: " (default)" })
              : null,
          ),
          h("td", { class: "cell-dim mono", text: env.baseUrl ?? "—" }),
          h(
            "td",
            null,
            policy?.trait
              ? Studio.tag(
                  policy.trait,
                  policy.trait === "protected"
                    ? "refused"
                    : policy.trait === "shared"
                      ? "warn"
                      : "ok",
                )
              : h("span", { class: "cell-dim", text: "—" }),
          ),
          h(
            "td",
            null,
            policy?.mutations
              ? Studio.tag(
                  policy.mutations === "deny"
                    ? "mutations denied"
                    : "mutations allowed",
                  policy.mutations === "deny" ? "warn" : "ok",
                )
              : h("span", { class: "cell-dim", text: "—" }),
          ),
          h("td", {
            class: "cell-summary",
            title: policy?.description ?? "",
            text: policy?.description ?? "",
          }),
          lockCell,
          h("td", { class: "row-actions" }, buttons),
        ),
      );
    }
    return Studio.panel("environments & policy", [
      h(
        "table",
        { class: "grid env-policy" },
        h(
          "thead",
          h(
            "tr",
            h("th", { text: "environment" }),
            h("th", { text: "baseUrl" }),
            h("th", { text: "trait" }),
            h("th", { text: "mutations" }),
            h("th", { text: "description" }),
            h("th", { text: "services lock" }),
            h("th", { text: "" }),
          ),
        ),
        body,
      ),
      servicesDeclared
        ? h("p", {
            class: "cell-dim",
            text: "Services up starts the config services for an environment and keeps them running behind an owner lock (runs then need --reuse-services); Services down tears them down and removes the lock. Both ask first, and both are refused while a suite lock is held.",
          })
        : null,
      h("p", {
        class: "cell-dim",
        text: "cairn run refuses a spec (status refused, exit 7) when its requires.env does not list the environment (or its opt-in variable is not 1/true), when it mutates and the environment denies mutations, or when the environment is protected and the spec does not list it. Nothing starts for a refused spec.",
      }),
    ]);
  }

  /**
   * `datasources:` (per environment), `gates:` and `fixtures:` from the
   * config, as main summarized them (redacted: references stay references,
   * literal URIs are masked, credentials are only named by kind).
   * @param {any} registries
   * @param {any} ledger `fixtures:ledger` (newest state per fixture) or null
   * @returns {HTMLElement | null}
   */
  function registriesPanel(registries, ledger) {
    if (!registries) return null;
    const topLevel = registries.datasources?.topLevel ?? [];
    const perEnv = registries.datasources?.environments ?? [];
    const gates = registries.gates ?? [];
    const fixtures = registries.fixtures ?? [];
    if (
      !topLevel.length &&
      !gates.length &&
      !fixtures.length &&
      !perEnv.some((env) => env.datasources.length)
    )
      return null;
    const nodes = [];

    // datasources: one row per environment × datasource (or the top level
    // when the config has no environments)
    const dsRows = perEnv.length
      ? perEnv.flatMap((/** @type {any} */ env) =>
          env.datasources.map((/** @type {any} */ ds) => ({
            env: env.env,
            ...ds,
          })),
        )
      : topLevel.map((/** @type {any} */ ds) => ({
          env: "(every)",
          state: "inherited",
          ...ds,
        }));
    if (dsRows.length)
      nodes.push(
        h(
          "div",
          { class: "section-title", style: { marginTop: "0" } },
          `Datasources (${topLevel.length || dsRows.length})`,
        ),
        h(
          "table",
          { class: "grid datasources-table" },
          h(
            "thead",
            h(
              "tr",
              [
                "environment",
                "datasource",
                "kind",
                "target",
                "details",
                "state",
              ].map((label) => h("th", { text: label })),
            ),
          ),
          h(
            "tbody",
            dsRows.map((/** @type {any} */ ds) =>
              h(
                "tr",
                {
                  class: `datasource-row ds-${ds.state}`,
                  dataset: { env: ds.env, name: ds.name },
                },
                h("td", { class: "mono", text: ds.env }),
                h("td", { class: "mono", text: ds.name }),
                h("td", null, Studio.tag(ds.kind, ds.known ? "info" : "warn")),
                h("td", {
                  class: "mono cell-dim ds-target",
                  title: ds.target ?? "",
                  text: ds.state === "disabled" ? "—" : (ds.target ?? "—"),
                }),
                h("td", {
                  class: "cell-dim",
                  text: (ds.facts ?? [])
                    .map(
                      (/** @type {[string, string]} */ [k, v]) => `${k}: ${v}`,
                    )
                    .join(" · "),
                }),
                h(
                  "td",
                  null,
                  Studio.tag(
                    ds.state === "env-only" ? "this env only" : ds.state,
                    ds.state === "disabled"
                      ? "warn"
                      : ds.state === "override" || ds.state === "env-only"
                        ? "info"
                        : "muted",
                  ),
                ),
              ),
            ),
          ),
        ),
      );

    if (gates.length)
      nodes.push(
        h(
          "div",
          { class: "section-title" },
          `Readiness gates (${gates.length})`,
        ),
        h(
          "table",
          { class: "grid gates-table" },
          h(
            "thead",
            h(
              "tr",
              ["gate", "probe", "target", "policy", "waited by"].map((label) =>
                h("th", { text: label }),
              ),
            ),
          ),
          h(
            "tbody",
            gates.map((/** @type {any} */ gate) =>
              h(
                "tr",
                { class: "gate-row", dataset: { name: gate.name } },
                h(
                  "td",
                  { class: "mono", title: gate.description ?? "" },
                  gate.name,
                ),
                h("td", null, Studio.tag(gate.probe, "info")),
                h("td", {
                  class: "mono cell-dim",
                  title: [
                    gate.target,
                    ...(gate.facts ?? []).map(
                      (/** @type {[string, string]} */ [k, v]) => `${k}: ${v}`,
                    ),
                  ]
                    .filter(Boolean)
                    .join("\n"),
                  text: gate.target ?? "—",
                }),
                h("td", {
                  class: "cell-dim",
                  text:
                    [
                      gate.timeout ? `timeout ${gate.timeout}` : null,
                      gate.every ? `every ${gate.every}` : null,
                      gate.stable ? `stable ×${gate.stable}` : null,
                      ...(gate.facts ?? []).map(
                        (/** @type {[string, string]} */ [k, v]) => `${k} ${v}`,
                      ),
                    ]
                      .filter(Boolean)
                      .join(" · ") || "defaults (60s, every 1s)",
                }),
                h("td", {
                  class: "cell-dim",
                  text: gateUsers(gate).join(", ") || "—",
                }),
              ),
            ),
          ),
        ),
      );

    if (fixtures.length) {
      /** @type {Map<string, any[]>} live state per environment, by fixture */
      const latest = new Map();
      for (const entry of ledger?.entries ?? []) {
        const list = latest.get(entry.name) ?? [];
        list.push(entry);
        latest.set(entry.name, list);
      }
      nodes.push(
        h("div", { class: "section-title" }, `Fixtures (${fixtures.length})`),
        h(
          "table",
          { class: "grid fixtures-registry" },
          h(
            "thead",
            h(
              "tr",
              [
                "fixture",
                "kind",
                "scope",
                "verbs",
                "ownership",
                "outputs",
                "live state (ledger)",
              ].map((label) => h("th", { text: label })),
            ),
          ),
          h(
            "tbody",
            fixtures.map((/** @type {any} */ fixture) => {
              const states = latest.get(fixture.name) ?? [];
              return h(
                "tr",
                {
                  class: "fixture-registry-row",
                  dataset: { name: fixture.name },
                },
                h(
                  "td",
                  { class: "mono", title: fixture.description ?? "" },
                  fixture.name,
                  fixture.needs?.length
                    ? h("span", {
                        class: "cell-dim",
                        text: ` needs ${fixture.needs.join(", ")}`,
                      })
                    : null,
                ),
                h("td", null, Studio.tag(fixture.kind, "info")),
                h("td", { class: "cell-dim", text: fixture.scope }),
                h("td", {
                  class: "cell-dim",
                  text: fixture.verbs.join(" · ") || "—",
                }),
                h("td", {
                  class: "cell-dim",
                  text:
                    [
                      fixture.owner ? `owner ${fixture.owner}` : null,
                      fixture.ttl ? `ttl ${fixture.ttl}` : null,
                    ]
                      .filter(Boolean)
                      .join(" · ") || "—",
                }),
                h("td", {
                  class: "mono cell-dim",
                  text: fixture.outputs.length
                    ? fixture.outputs.join(", ")
                    : "—",
                }),
                h(
                  "td",
                  { class: "cell-dim fixture-live-state" },
                  states.length
                    ? states.map((/** @type {any} */ entry) =>
                        h(
                          "div",
                          {
                            class: `ledger-state ledger-${entry.state}`,
                            title: [
                              entry.instance
                                ? `instance ${entry.instance}`
                                : null,
                              entry.fromReset
                                ? "live by its reset (a reset-only fixture)"
                                : null,
                              entry.state === "released"
                                ? "released: cairn owes it no teardown"
                                : null,
                              entry.lastVerb && entry.lastStatus
                                ? `last: ${entry.lastVerb} ${entry.lastStatus}`
                                : null,
                              entry.lastError,
                              entry.expiresAt
                                ? `fresh until ${fmt.formatTimestamp(entry.expiresAt)}`
                                : null,
                              entry.runId ? `run ${entry.runId}` : null,
                            ]
                              .filter(Boolean)
                              .join("\n"),
                          },
                          Studio.tag(
                            `${entry.env}: ${entry.state}`,
                            entry.state === "live"
                              ? "ok"
                              : entry.state === "failed"
                                ? "bad"
                                : "muted",
                          ),
                          " ",
                          entry.ensuredAt || entry.lastAt
                            ? Studio.relTime(entry.ensuredAt ?? entry.lastAt)
                            : null,
                        ),
                      )
                    : "—",
                ),
              );
            }),
          ),
        ),
        ledger?.exists
          ? h("p", {
              class: "cell-dim",
              text: `last state from ${ledger.path}${
                ledger.partial ? " (newest part only)" : ""
              }`,
            })
          : null,
      );
    }

    nodes.push(
      h("p", {
        class: "cell-dim",
        text: "${env.X} / ${secrets.X} values stay references (a :-default is redacted), literal URIs are masked, auth is named only by its kind, and gate commands lose the credential flags and headers Studio recognizes. Verifier evidence names a source the same way.",
      }),
    );
    return Studio.panel("datasources, gates & fixtures", nodes, {
      className: "registries-panel",
    });
  }

  /**
   * Who waits on a gate: config places (services, web server) and the
   * specs whose preconditions.wait names it.
   * @param {any} gate
   * @returns {string[]}
   */
  function gateUsers(gate) {
    const specs = (state.project?.specs ?? [])
      .filter((/** @type {any} */ spec) =>
        (spec?.summary?.wait ?? []).includes(gate.name),
      )
      .map(
        (/** @type {any} */ spec) =>
          spec.summary?.name ?? spec.rel ?? spec.path,
      );
    return [
      ...(gate.usedBy ?? []),
      ...specs.slice(0, 8),
      ...(specs.length > 8 ? [`+${specs.length - 8} specs`] : []),
    ];
  }

  /**
   * The first non-empty string among `values`, or null.
   * @param {...unknown} values
   * @returns {string | null}
   */
  function stringOf(...values) {
    return (
      /** @type {string | null} */ (
        values.find((value) => typeof value === "string" && value) ?? null
      )
    );
  }

  /**
   * One checkpoint row's facts. `cairn checkpoint list --json` reports name,
   * path, sizeBytes and modifiedAt today; the env / baseUrl scope, expiry and
   * health are read when the CLI provides them (several spellings).
   * @param {Record<string, any>} checkpoint
   */
  function checkpointFacts(checkpoint) {
    const scope =
      checkpoint.scope && typeof checkpoint.scope === "object"
        ? checkpoint.scope
        : {};
    const expiresAt = stringOf(
      checkpoint.expiresAt,
      checkpoint.expiry,
      scope.expiresAt,
    );
    const expired =
      checkpoint.expired === true ||
      (expiresAt !== null && Date.parse(expiresAt) < Date.now());
    const rawHealth =
      checkpoint.health && typeof checkpoint.health === "object"
        ? checkpoint.health
        : null;
    let health = stringOf(
      typeof checkpoint.health === "string" ? checkpoint.health : null,
      rawHealth?.status,
      checkpoint.status,
    );
    if (!health && typeof checkpoint.healthy === "boolean")
      health = checkpoint.healthy ? "healthy" : "unhealthy";
    if (expired && (!health || health === "healthy" || health === "ok"))
      health = "expired";
    return {
      name: stringOf(checkpoint.name, checkpoint.id) ?? "?",
      env: stringOf(checkpoint.env, checkpoint.environment, scope.env),
      baseUrl: stringOf(checkpoint.baseUrl, scope.baseUrl),
      createdAt: stringOf(
        checkpoint.createdAt,
        checkpoint.capturedAt,
        checkpoint.modifiedAt,
      ),
      expiresAt,
      health,
      healthDetail:
        stringOf(
          rawHealth?.reason,
          rawHealth?.detail,
          checkpoint.healthReason,
        ) ??
        HEALTH_HINTS[String(health ?? "").toLowerCase()] ??
        null,
      ttl: stringOf(checkpoint.ttl, scope.ttl),
      sizeBytes:
        typeof checkpoint.sizeBytes === "number" ? checkpoint.sizeBytes : null,
    };
  }

  /** What `cairn checkpoint list` health words mean (tooltips). */
  const HEALTH_HINTS = {
    ok: "scoped (env/baseUrl recorded) and not expired",
    expired: "past its TTL: session.resume refuses it — recapture it",
    unscoped:
      "captured before checkpoints recorded env/baseUrl/ttl — still resumable, unchecked",
    missing: "the state file is gone",
  };

  /** @param {string | null} health */
  function healthTone(health) {
    if (!health) return "muted";
    if (/^(healthy|ok|valid|fresh)$/i.test(health)) return "ok";
    if (/^(expired|stale)$/i.test(health)) return "warn";
    if (/^(unscoped|unknown)$/i.test(health)) return "muted";
    return "bad";
  }

  /** @param {any} result */
  function checkpointsPanel(result) {
    const payload = result?.payload ?? null;
    const list = Array.isArray(payload?.checkpoints)
      ? payload.checkpoints
      : Array.isArray(payload)
        ? payload
        : null;
    if (!list)
      return Studio.panel("browser-state checkpoints", [
        h("pre", {
          class: "code tight",
          text: fmt.truncate(
            result?.stdout || result?.stderr || "checkpoint list unavailable",
            2000,
          ),
        }),
      ]);
    if (!list.length)
      return Studio.panel("browser-state checkpoints", [
        h("p", {
          class: "cell-dim",
          text: "none captured — use `cairn login <name> --url <url>` to create one for session.resume specs",
        }),
      ]);
    const facts = list.map((checkpoint) =>
      checkpointFacts(
        checkpoint && typeof checkpoint === "object" ? checkpoint : {},
      ),
    );
    const body = h("tbody");
    for (const fact of facts)
      body.appendChild(
        h(
          "tr",
          {
            class: "checkpoint-row",
            dataset: { checkpoint: fact.name },
            style: { cursor: "default" },
          },
          h("td", { class: "mono", text: fact.name }),
          h("td", { class: "mono", text: fact.env ?? "—" }),
          h("td", {
            class: "cell-dim mono",
            title: fact.baseUrl ?? "",
            text: fact.baseUrl ?? "—",
          }),
          h(
            "td",
            { class: "cell-dim" },
            fact.createdAt ? Studio.relTime(fact.createdAt) : "—",
          ),
          h(
            "td",
            { class: "cell-dim", title: fact.ttl ? `ttl ${fact.ttl}` : "" },
            fact.expiresAt ? Studio.relTime(fact.expiresAt) : "never",
          ),
          h(
            "td",
            null,
            fact.health
              ? (() => {
                  const node = Studio.tag(fact.health, healthTone(fact.health));
                  node.title = fact.healthDetail ?? "";
                  return node;
                })()
              : h("span", { class: "cell-dim", text: "—" }),
          ),
          h("td", {
            class: "num",
            text:
              fact.sizeBytes === null ? "—" : fmt.formatBytes(fact.sizeBytes),
          }),
        ),
      );
    return Studio.panel("browser-state checkpoints", [
      h(
        "table",
        { class: "grid checkpoints" },
        h(
          "thead",
          h(
            "tr",
            h("th", { text: "checkpoint" }),
            h("th", { text: "env" }),
            h("th", { text: "baseUrl" }),
            h("th", { text: "created" }),
            h("th", { text: "expires" }),
            h("th", { text: "health" }),
            h("th", { class: "num", text: "size" }),
          ),
        ),
        body,
      ),
      facts.some((fact) => fact.env || fact.baseUrl)
        ? null
        : h("p", {
            class: "cell-dim",
            text: "This cairn reports no env/baseUrl scope for checkpoints yet; a checkpoint resumes wherever a spec names it.",
          }),
    ]);
  }

  /**
   * @param {any} info
   * @param {HTMLElement} root
   */
  function retentionPanel(info, root) {
    const keepRuns = Studio.input({
      type: "number",
      value: "3",
      style: { width: "90px" },
    });
    return Studio.panel("artifact retention", [
      h("p", {
        class: "cell-dim",
        style: { marginTop: 0 },
        text: `cairn prunes to the newest N runs per spec after every run (default 3; failed runs keep 10; pinned runs are never pruned). Artifact root: ${info.runsRoot?.runsRoot ?? "—"}`,
      }),
      h(
        "div",
        { class: "toolbar" },
        h("label", { class: "field" }, "keep newest N per spec", keepRuns),
        h("button", {
          class: "btn",
          type: "button",
          text: "Prune now",
          onClick: async () => {
            const upload = pruneUploadText();
            const proceed = await Studio.confirm({
              title: upload
                ? "Prune old runs and upload them?"
                : "Prune old runs?",
              body: `Runs beyond the retention window are deleted from the artifact root. Failed runs keep their carve-out, and pinned runs (cairn pin) are always kept; only cairn clean --include-pinned removes them.${
                upload ? `\n\n${upload}` : ""
              }`,
              confirmLabel: "Prune",
              danger: true,
            });
            if (!proceed) return;
            try {
              const result = await api.call("clean:runs", {
                keepRuns: Number(keepRuns.value) || 0,
              });
              if (result?.cancelled) return;
              toast(
                "Prune finished",
                result?.ok
                  ? `exit ${result.exitCode}`
                  : result?.stderr?.slice(0, 160),
                result?.ok ? "ok" : "bad",
              );
              await Studio.actions.loadRuns();
              void root;
            } catch (error) {
              toast("Prune failed", String(error?.message ?? error), "bad");
            }
          },
        }),
        h("button", {
          class: "btn btn-danger",
          type: "button",
          text: "Remove everything…",
          onClick: async () => {
            const upload = pruneUploadText();
            const proceed = await Studio.confirm({
              title: "Delete the whole artifact root?",
              body: `\`cairn clean --all\` removes every run directory, including failures. Pinned runs are kept (only cairn clean --include-pinned removes them). This cannot be undone.${
                upload ? `\n\n${upload}` : ""
              }`,
              confirmLabel: "Delete all runs",
              danger: true,
            });
            if (!proceed) return;
            try {
              const result = await api.call("clean:runs", { all: true });
              if (result?.cancelled) return;
              toast(
                "Artifact root cleared",
                result?.ok ? null : result?.stderr?.slice(0, 160),
                result?.ok ? "ok" : "bad",
              );
              await Studio.actions.loadRuns();
            } catch (error) {
              toast("Clean failed", String(error?.message ?? error), "bad");
            }
          },
        }),
      ),
    ]);
  }

  /**
   * What pruning uploads (the project's `retention.archiveToStash` /
   * `retention.publish`), as one sentence for the prune dialogs, or null.
   * Main asks again natively before an uploading clean.
   * @returns {string | null}
   */
  function pruneUploadText() {
    const retention = state.project?.config?.retention ?? null;
    const archive = retention?.archiveToStash === true;
    const publish = retention?.publish?.enabled === true;
    if (!archive && !publish) return null;
    const rawDays = retention?.publish?.retentionDays;
    const days =
      Number.isInteger(rawDays) && rawDays >= 1 && rawDays <= 31 ? rawDays : 7;
    const what = [
      archive ? "archives it to your file.cheap stash" : null,
      publish
        ? `publishes it to file.cheap (kept ${days} day${
            days === 1 ? "" : "s"
          })`
        : null,
    ]
      .filter(Boolean)
      .join(" and ");
    return `Uploads: before deleting each pruned run, cairn clean ${what}, per the project's retention config. You will be asked to confirm the upload.`;
  }

  // ── wave 6: service windows (restart / logs), tunnels, orphan sessions ────

  /**
   * Service windows of one environment: health, restart and logs per window,
   * the tunnels cairn supervises, and the names the provisioner exports.
   * Everything comes from `cairn services status --env <name> --json`; a
   * restart spawns `cairn services restart <window>` after a native
   * confirmation (main refuses while a suite or run lock is held, or a run
   * Studio started uses the environment).
   * @returns {HTMLElement | null}
   */
  function serviceWindowsPanel() {
    const config = state.project?.config ?? null;
    if (!config?.hasServices) return null;
    const envs = (config.environments ?? []).filter(
      (/** @type {{ disabled?: boolean, services?: boolean }} */ env) =>
        !env.disabled && env.services !== false,
    );
    if (!envs.length) return null;
    const names = envs.map((/** @type {{ name: string }} */ env) => env.name);
    let env =
      config.defaultEnvironment && names.includes(config.defaultEnvironment)
        ? config.defaultEnvironment
        : names[0];
    const body = h("div", { class: "svc-ops-body" });
    const logHost = h("div", { class: "svc-logs-host" });
    const picker = h(
      "select",
      {
        id: "svc-env",
        ariaLabel: "environment whose service windows to show",
        onChange: (/** @type {Event} */ event) => {
          env = /** @type {HTMLSelectElement} */ (event.target).value;
          Studio.clear(logHost);
          void refresh();
        },
      },
      names.map((/** @type {string} */ name) =>
        h("option", { value: name, text: name }),
      ),
    );
    /** @type {HTMLSelectElement} */ (picker).value = env;
    const panel = Studio.panel("service windows, tunnels & provisioner", [
      h(
        "div",
        { class: "toolbar" },
        h("label", { class: "field", for: "svc-env" }, "environment", picker),
        h("button", {
          class: "btn btn-sm",
          type: "button",
          text: "Refresh",
          onClick: () => void refresh(),
        }),
      ),
      body,
      logHost,
    ]);
    panel.dataset.panel = "service-windows";

    async function refresh() {
      Studio.clear(body);
      body.appendChild(Studio.loading("reading services status…"));
      /** @type {any} */
      let result;
      try {
        result = await api.call("services:windows", { env });
      } catch (error) {
        Studio.clear(body);
        body.appendChild(Studio.errorBox(error, "services status"));
        return;
      }
      Studio.clear(body);
      const status = result?.status ?? null;
      if (!status) {
        body.appendChild(
          h(
            "div",
            { class: "error-box" },
            h("strong", { text: "cairn services status gave no document" }),
            h("pre", { text: result?.error || "(no output)" }),
          ),
        );
        return;
      }
      paintStatus(result, status);
    }

    /**
     * @param {any} result
     * @param {any} status
     */
    function paintStatus(result, status) {
      const lockCell = h("span", { class: "services-lock-cell" });
      paintLock(lockCell, result);
      body.appendChild(
        h(
          "div",
          { class: "svc-facts" },
          h("span", { class: "cell-dim", text: "services-up lock: " }),
          lockCell,
          status.tmux.configured
            ? Studio.tag(
                status.tmux.sessionExists
                  ? `tmux ${status.tmux.session ?? ""} running`
                  : `tmux ${status.tmux.session ?? ""} not running`,
                status.tmux.sessionExists ? "ok" : "warn",
              )
            : null,
          status.docker.configured
            ? Studio.tag(
                status.docker.running ? "docker up" : "docker down",
                status.docker.running ? "ok" : "warn",
              )
            : null,
          status.seed.configured
            ? Studio.tag(
                status.seed.expired ? "seed stale" : "seed fresh",
                status.seed.expired ? "warn" : "ok",
              )
            : null,
        ),
      );
      for (const error of status.errors)
        if (error)
          body.appendChild(
            h("div", { class: "notice notice-warn", text: error }),
          );

      // windows
      if (status.tmux.windows.length) {
        const rows = status.tmux.windows.map(
          (/** @type {{ name: string, healthy: boolean | null }} */ win) => {
            const restart = h("button", {
              class: "btn btn-sm",
              type: "button",
              text: "Restart…",
              dataset: { action: "restart", window: win.name },
              ariaLabel: `restart service window ${win.name} (asks first)`,
              disabled: Boolean(result.busy) || !status.tmux.sessionExists,
              title: status.tmux.sessionExists
                ? "cairn services restart: Ctrl-C, wait for exit, resend the command (asks first)"
                : "the tmux session is not running",
              onClick: () =>
                void restartWindow(
                  win.name,
                  /** @type {HTMLButtonElement} */ (restart),
                ),
            });
            return h(
              "tr",
              { class: "svc-window", dataset: { window: win.name } },
              h("td", { class: "mono", text: win.name }),
              h(
                "td",
                win.healthy === null
                  ? h("span", { class: "cell-dim", text: "— no healthcheck" })
                  : h(
                      "span",
                      {
                        class: `ops-inline ops-inline-${
                          win.healthy ? "ok" : "bad"
                        }`,
                      },
                      h("span", {
                        ariaHidden: "true",
                        text: win.healthy ? "✓ " : "✗ ",
                      }),
                      win.healthy ? "healthy" : "unhealthy",
                    ),
              ),
              h(
                "td",
                { class: "svc-actions" },
                h("button", {
                  class: "btn btn-sm btn-ghost",
                  type: "button",
                  text: "Logs",
                  dataset: { action: "logs", window: win.name },
                  ariaLabel: `show the log of service window ${win.name}`,
                  onClick: () => void showLogs(win.name, false),
                }),
                restart,
              ),
            );
          },
        );
        body.appendChild(
          h(
            "div",
            { class: "data-table-scroll" },
            h(
              "table",
              { class: "grid svc-windows", ariaLabel: "service windows" },
              h(
                "thead",
                h(
                  "tr",
                  ["window", "health", ""].map((label) =>
                    h("th", { text: label }),
                  ),
                ),
              ),
              h("tbody", rows),
            ),
          ),
        );
      } else
        body.appendChild(
          h("p", {
            class: "cell-dim",
            text: status.tmux.configured
              ? "the tmux session has no windows"
              : "this environment declares no tmux windows",
          }),
        );

      // tunnels
      if (status.tunnels.length)
        body.appendChild(
          h(
            "div",
            { class: "data-table-scroll" },
            h(
              "table",
              { class: "grid svc-tunnels", ariaLabel: "tunnels" },
              h(
                "thead",
                h(
                  "tr",
                  ["tunnel", "state", "running", "pid", "restarts"].map(
                    (label) => h("th", { text: label }),
                  ),
                ),
              ),
              h(
                "tbody",
                status.tunnels.map(
                  (/** @type {Record<string, any>} */ tunnel) =>
                    h(
                      "tr",
                      { class: "svc-tunnel", dataset: { tunnel: tunnel.name } },
                      h("td", { class: "mono", text: tunnel.name }),
                      h("td", { class: "mono", text: tunnel.state }),
                      h(
                        "td",
                        h(
                          "span",
                          {
                            class: `ops-inline ops-inline-${
                              tunnel.running ? "ok" : "warn"
                            }`,
                          },
                          h("span", {
                            ariaHidden: "true",
                            text: tunnel.running ? "✓ " : "⚠ ",
                          }),
                          tunnel.running ? "running" : "not running",
                        ),
                      ),
                      h("td", {
                        class: "mono",
                        text: tunnel.pid === null ? "—" : String(tunnel.pid),
                      }),
                      h("td", { class: "mono", text: String(tunnel.restarts) }),
                    ),
                ),
              ),
            ),
          ),
        );

      // provisioner: names only, never values
      if (status.provisioner)
        body.appendChild(
          h(
            "div",
            { class: "svc-provisioner" },
            h("span", {
              class: "cell-dim",
              text: "provisioner exports (names only): ",
            }),
            status.provisioner.exports.length
              ? status.provisioner.exports.map((/** @type {string} */ name) =>
                  h("code", { class: "tag mono", text: name }),
                )
              : h("span", { class: "cell-dim", text: "none yet" }),
          ),
        );
    }

    /**
     * @param {string} window
     * @param {HTMLButtonElement} button
     */
    async function restartWindow(window, button) {
      const label = button.textContent ?? "";
      button.disabled = true;
      button.textContent = "Restarting…";
      try {
        const result = await api.call("services:restart", { env, window });
        if (result?.cancelled) return;
        const row = result?.restart?.windows?.find(
          (/** @type {{ window: string }} */ entry) => entry.window === window,
        );
        toast(
          result?.ok
            ? `Restarted ${window} · ${env}`
            : `Restart failed · ${window}`,
          result?.ok
            ? row?.alreadyStopped
              ? "the process had already stopped; its command was started again"
              : fmt.formatDuration(
                  row?.durationMs ?? result?.restart?.durationMs,
                )
            : fmt.truncate(
                result?.unsupported
                  ? "this cairn has no `cairn services restart`"
                  : String(
                      result?.error ?? result?.stderr ?? result?.meaning ?? "",
                    ),
                260,
              ),
          result?.ok ? "ok" : "bad",
          result?.ok ? 6000 : 12000,
        );
        if (result?.ok) void showLogs(window, true);
      } catch (error) {
        toast(
          `Restart not started · ${window}`,
          String(error?.message ?? error),
          "bad",
          9000,
        );
      } finally {
        button.textContent = label;
        button.disabled = false;
        void refresh();
      }
    }

    /**
     * @param {string} window
     * @param {boolean} sinceRestart
     */
    async function showLogs(window, sinceRestart) {
      Studio.clear(logHost);
      logHost.appendChild(Studio.loading(`reading ${window} log…`));
      /** @type {any} */
      let result;
      try {
        result = await api.call("services:logs", {
          env,
          window,
          sinceRestart,
          lines: 200,
        });
      } catch (error) {
        Studio.clear(logHost);
        logHost.appendChild(Studio.errorBox(error, `${window} log`));
        return;
      }
      Studio.clear(logHost);
      const logs = result?.logs ?? null;
      if (!logs?.ok) {
        logHost.appendChild(
          h(
            "div",
            { class: "error-box" },
            h("strong", {
              text: result?.unsupported
                ? "this cairn has no `cairn services logs`"
                : `could not read the ${window} log`,
            }),
            h("pre", {
              text: result?.error || result?.stderr || "(no output)",
            }),
          ),
        );
        return;
      }
      const since = h("input", {
        type: "checkbox",
        id: "svc-since",
        checked: sinceRestart,
        onChange: (/** @type {Event} */ event) =>
          void showLogs(
            window,
            /** @type {HTMLInputElement} */ (event.target).checked,
          ),
      });
      logHost.appendChild(
        h(
          "section",
          { class: "svc-log", dataset: { window } },
          h(
            "div",
            { class: "svc-log-head" },
            h("strong", {
              class: "mono",
              text: `${window} · last ${logs.lines.length} of ${logs.totalLines} line(s)`,
            }),
            h(
              "label",
              { class: "field", for: "svc-since" },
              since,
              " since last restart",
            ),
            logs.sinceRestart.requested && !logs.sinceRestart.found
              ? h("span", {
                  class: "tag tag-warn",
                  text: "no restart marker found: showing the whole pane",
                })
              : null,
            h("button", {
              class: "btn btn-sm btn-ghost",
              type: "button",
              text: "Reload",
              onClick: () =>
                void showLogs(
                  window,
                  /** @type {HTMLInputElement} */ (since).checked,
                ),
            }),
            h("button", {
              class: "btn btn-sm btn-ghost",
              type: "button",
              text: "Close",
              onClick: () => Studio.clear(logHost),
            }),
          ),
          h("pre", {
            class: "log-pane svc-log-pane",
            role: "log",
            tabindex: "0",
            ariaLabel: `${window} service log`,
            text: logs.lines.length ? logs.lines.join("\n") : "(empty)",
          }),
          logs.warnings.length
            ? h("div", { class: "cell-dim", text: logs.warnings.join(" · ") })
            : null,
        ),
      );
    }

    void refresh();
    return panel;
  }

  /**
   * Browser sessions cairn started whose run is gone but whose processes
   * survive (`cairn doctor --orphans --json`, found through the owned
   * session ledger). Ending them is `--kill --yes` after a native
   * confirmation listing every session and process.
   * @returns {HTMLElement}
   */
  function orphansPanel() {
    const body = h("div", { class: "orphans-body" });
    const panel = Studio.panel("orphan browser sessions", body, {
      actions: [
        h("button", {
          class: "btn btn-sm",
          type: "button",
          text: "Re-scan",
          onClick: () => void scan(),
        }),
      ],
    });
    panel.dataset.panel = "orphans";

    async function scan() {
      Studio.clear(body);
      body.appendChild(Studio.loading("checking the browser-session ledger…"));
      /** @type {any} */
      let result;
      try {
        result = await api.call("orphans:list");
      } catch (error) {
        Studio.clear(body);
        body.appendChild(Studio.errorBox(error, "doctor --orphans"));
        return;
      }
      paint(result);
    }

    /** @param {any} result */
    function paint(result) {
      Studio.clear(body);
      const doc = result?.orphans ?? null;
      if (!doc) {
        body.appendChild(
          result?.unsupported
            ? h("p", {
                class: "cell-dim",
                text: "this cairn has no `cairn doctor --orphans` (the owned browser-session ledger is newer than this binary)",
              })
            : h(
                "div",
                { class: "error-box" },
                h("strong", { text: "cairn doctor --orphans failed" }),
                h("pre", {
                  text: result?.error || result?.stderr || "(no output)",
                }),
              ),
        );
        return;
      }
      if (doc.error)
        body.appendChild(
          h("div", { class: "notice notice-warn", text: doc.error }),
        );
      const count = doc.orphans.length;
      body.appendChild(
        h(
          "p",
          { class: "orphans-summary", dataset: { orphans: String(count) } },
          h("span", {
            ariaHidden: "true",
            text: count ? "⚠ " : "✓ ",
          }),
          count
            ? `${count} orphaned session(s): the cairn run that started them is gone, their browsers are not`
            : "no orphaned browser sessions",
          h("span", {
            class: "cell-dim",
            text: ` · ${doc.liveSessions} live session(s) of running runs are never touched${
              doc.staleEntriesRemoved
                ? ` · ${doc.staleEntriesRemoved} stale ledger entr${
                    doc.staleEntriesRemoved === 1 ? "y" : "ies"
                  } removed`
                : ""
            }`,
          }),
        ),
      );
      if (doc.killRequested)
        body.appendChild(
          h("p", {
            class: `ops-inline ops-inline-${
              doc.remaining.length ? "bad" : "ok"
            }`,
            text: doc.remaining.length
              ? `ended ${doc.killed} process(es); ${doc.remaining.length} still alive: ${doc.remaining.join(", ")}`
              : `ended ${doc.killed} process(es)`,
          }),
        );
      if (!count) return;
      body.appendChild(
        h(
          "div",
          { class: "data-table-scroll" },
          h(
            "table",
            { class: "grid orphans-table", ariaLabel: "orphan sessions" },
            h(
              "thead",
              h(
                "tr",
                [
                  "session",
                  "backend",
                  "invocation",
                  "owner pid",
                  "started",
                  "processes",
                ].map((label) => h("th", { text: label })),
              ),
            ),
            h(
              "tbody",
              doc.orphans.map((/** @type {Record<string, any>} */ orphan) =>
                h(
                  "tr",
                  { class: "orphan-row", dataset: { session: orphan.session } },
                  h("td", { class: "mono", text: orphan.session }),
                  h("td", { class: "mono", text: orphan.backend }),
                  h("td", {
                    class: "mono cell-dim",
                    title: orphan.projectDir ?? "",
                    text: fmt.truncate(orphan.invocationId, 30),
                  }),
                  h("td", {
                    class: "mono",
                    text:
                      orphan.ownerPid === null
                        ? "—"
                        : `${orphan.ownerPid} (gone)`,
                  }),
                  h(
                    "td",
                    orphan.startedAt
                      ? Studio.relTime(orphan.startedAt)
                      : h("span", { class: "cell-dim", text: "—" }),
                  ),
                  h(
                    "td",
                    { class: "mono" },
                    orphan.processes.map(
                      (/** @type {{ pid: number, command: string }} */ proc) =>
                        h("div", {
                          class: "cell-dim",
                          title: proc.command,
                          text: `${proc.pid} ${fmt.truncate(proc.command, 70)}`,
                        }),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      );
      const kill = h("button", {
        class: "btn btn-danger",
        type: "button",
        text: "End these processes…",
        dataset: { action: "kill-orphans" },
        title:
          "cairn doctor --orphans --kill --yes, after a confirmation that lists them",
        onClick: () =>
          void endProcesses(/** @type {HTMLButtonElement} */ (kill)),
      });
      body.appendChild(h("div", { class: "toolbar" }, kill));
    }

    /** @param {HTMLButtonElement} button */
    async function endProcesses(button) {
      button.disabled = true;
      const label = button.textContent ?? "";
      button.textContent = "Ending…";
      try {
        const result = await api.call("orphans:kill");
        if (result?.cancelled) return;
        if (result?.nothing) {
          toast("No orphaned sessions", "nothing to end", "info", 4000);
          return;
        }
        const doc = result?.orphans ?? null;
        toast(
          result?.ok && doc && !doc.remaining.length
            ? "Orphaned browsers ended"
            : "Some processes survived",
          doc
            ? `ended ${doc.killed} process(es)${
                doc.remaining.length
                  ? `; still alive: ${doc.remaining.join(", ")}`
                  : ""
              }`
            : fmt.truncate(String(result?.error ?? result?.stderr ?? ""), 240),
          result?.ok && doc && !doc.remaining.length ? "ok" : "bad",
          7000,
        );
        if (doc) paint(result);
      } catch (error) {
        toast(
          "Could not end the processes",
          String(error?.message ?? error),
          "bad",
          9000,
        );
      } finally {
        if (button.isConnected) {
          button.textContent = label;
          button.disabled = false;
        }
      }
    }

    void scan();
    return panel;
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
      h("div", {
        class: "v",
        style: { fontSize: "15px" },
        text: fmt.truncate(value, 34),
      }),
      note
        ? h("div", { class: "n", text: fmt.truncate(String(note), 70) })
        : null,
    );
  }

  Studio.views = Studio.views || {};
  Studio.views.doctor = {
    id: "doctor",
    label: "Environment",
    glyph: "⚕",
    render,
  };
})();
