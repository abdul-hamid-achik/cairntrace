/**
 * Suites view — the config's `suites:` registry (`cairn suites list --json`).
 *
 * Each suite with the specs it resolves to per environment (or why it does
 * not), its hooks (counts and var names; the commands never reach Studio),
 * and a Run button that spawns `cairn run --suite <name> [--env <env>]`
 * through the same launch path as every other Run: refused while a suite or
 * run lock is held, with an environment picker. Older cairn without suites
 * says so instead of failing.
 */
(function bootSuitesView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, api, state, actions, toast } = Studio;

  /** The environment picked for Run ("" = what the CLI resolves). */
  let pickedEnv = "";
  /** @type {(() => void) | null} */
  let offLocks = null;

  /**
   * The environment a suite would run on: the pick, the Settings
   * environment, the config default (the CLI's order; `local` last).
   * @returns {string | null}
   */
  function effectiveEnv() {
    return (
      pickedEnv ||
      state.settings?.run?.env ||
      state.project?.config?.defaultEnvironment ||
      null
    );
  }

  /** @param {HTMLElement} root */
  async function render(root) {
    Studio.clear(root);
    root.appendChild(Studio.loading("reading suites…"));
    if (!state.project) await actions.loadProject();
    await actions.loadLocks();
    /** @type {any} */
    let result = null;
    /** @type {unknown} */
    let failure = null;
    try {
      result = await api.call("suites:list", {}, state.project?.dir ?? null);
    } catch (error) {
      failure = error;
    }
    Studio.clear(root);
    root.appendChild(
      Studio.pageHeader(
        "Suites",
        result?.suites?.project
          ? `config suites: of ${result.suites.project}`
          : "named, ordered spec sets from the config (`cairn run --suite`)",
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
      root.appendChild(Studio.errorBox(failure, "suites"));
      return;
    }
    if (!result?.suites) {
      root.appendChild(unavailable(result));
      return;
    }
    const host = h("div", { class: "suites-host" });
    const envNames = (state.project?.config?.environments ?? []).map(
      (/** @type {{ name: string }} */ env) => env.name,
    );
    const picker = h(
      "select",
      {
        id: "suite-env",
        ariaLabel: "environment to run suites on",
        onChange: (/** @type {Event} */ event) => {
          pickedEnv = /** @type {HTMLSelectElement} */ (event.target).value;
          paint(host, result.suites);
        },
      },
      h("option", { value: "", text: "default (what the CLI resolves)" }),
      envNames.map((/** @type {string} */ name) =>
        h("option", { value: name, text: name }),
      ),
    );
    /** @type {HTMLSelectElement} */ (picker).value = envNames.includes(
      pickedEnv,
    )
      ? pickedEnv
      : "";
    if (!envNames.includes(pickedEnv)) pickedEnv = "";
    root.appendChild(
      h(
        "div",
        { class: "toolbar" },
        h("label", { class: "field", for: "suite-env" }, "run on", picker),
        h("div", { class: "spacer" }),
        result.cli
          ? h("code", { class: "cell-dim mono", text: result.cli })
          : null,
      ),
    );
    root.appendChild(host);
    paint(host, result.suites);
    offLocks?.();
    offLocks = Studio.on("locks", () => applyLockState(host));
    applyLockState(host);
    return {
      destroy() {
        offLocks?.();
        offLocks = null;
      },
    };
  }

  /**
   * Why there is nothing to show: an older cairn, a config error, or no
   * suites at all.
   * @param {any} result
   */
  function unavailable(result) {
    if (result?.unsupported)
      return Studio.empty(
        "This cairn has no suites",
        "`cairn suites list` is newer than the cairn binary Studio drives. Update cairn, or point Studio at a newer binary in Settings.",
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
      h("strong", { text: "cairn suites list failed" }),
      h("pre", {
        text:
          result?.error ||
          result?.stderr ||
          "no suites document came back (is a cairntrace.config.yml open?)",
      }),
    );
  }

  /**
   * @param {HTMLElement} host
   * @param {any} doc normalized `suites:list`
   */
  function paint(host, doc) {
    Studio.clear(host);
    for (const warning of doc.warnings ?? [])
      if (warning)
        host.appendChild(
          h("div", { class: "notice notice-warn", text: warning }),
        );
    if (!doc.suites.length) {
      host.appendChild(
        Studio.empty(
          "No suites",
          "The config defines no `suites:`. A suite names an ordered set of specs (paths, directories, globs, tags) with its own vars and once-per-run before/after hooks: see `cairn docs services`.",
        ),
      );
      return;
    }
    for (const suite of doc.suites) host.appendChild(suiteCard(suite));
    applyLockState(host);
  }

  /**
   * @param {any} suite
   * @returns {HTMLElement}
   */
  function suiteCard(suite) {
    const env = effectiveEnv();
    const forEnv = env
      ? (suite.envs.find((/** @type {any} */ entry) => entry.env === env) ??
        null)
      : null;
    const knobs = [
      suite.parallel ? `parallel ${suite.parallel}` : null,
      suite.bail ? "bail" : null,
      suite.tags.length ? `tags ${suite.tags.join(" + ")}` : null,
      suite.requiresEnv.length ? `env ${suite.requiresEnv.join(" | ")}` : null,
      suite.requiresVars.length
        ? `needs vars ${suite.requiresVars.join(", ")}`
        : null,
    ].filter(Boolean);
    const blocked = forEnv?.problem ?? null;
    const run = h("button", {
      class: "btn btn-primary btn-sm",
      type: "button",
      text: env ? `Run on ${env}` : "Run",
      dataset: { runSuite: suite.name },
      ariaLabel: `run suite ${suite.name}${env ? ` on ${env}` : ""}`,
      disabled: Boolean(blocked),
      title: blocked
        ? `cannot run on ${env}: ${blocked}`
        : `cairn run --suite=${suite.name}${env ? ` --env ${env}` : ""}`,
      onClick: () =>
        void start(suite.name, /** @type {HTMLButtonElement} */ (run)),
    });
    run.dataset.blocked = blocked ? "1" : "";
    run.dataset.titleOriginal = run.title;
    const specsFor =
      forEnv ?? suite.envs.find((/** @type {any} */ e) => !e.problem);
    return h(
      "section",
      {
        class: "panel suite-card",
        dataset: { suite: suite.name },
        ariaLabel: `suite ${suite.name}`,
      },
      h(
        "div",
        { class: "panel-head" },
        h("span", { class: "mono card-title", text: suite.name }),
        knobs.map((/** @type {string} */ knob) => Studio.tag(knob)),
        h("div", { style: { marginLeft: "auto" } }, run),
      ),
      h(
        "div",
        { class: "panel-body" },
        suite.description
          ? h("p", {
              class: "cell-dim",
              style: { marginTop: "0" },
              text: suite.description,
            })
          : null,
        suite.seedSkip.length
          ? h("p", {
              class: "cell-dim",
              text: `skips seed post-commands: ${suite.seedSkip.join(", ")}`,
            })
          : null,
        envTable(suite, env),
        specsFor && specsFor.specs.length
          ? h(
              "details",
              { class: "suite-specs" },
              h("summary", {
                class: "cell-dim",
                text: `${specsFor.specs.length} spec(s) on ${specsFor.env}, in run order`,
              }),
              h(
                "ol",
                { class: "planned-list" },
                specsFor.specs.map((/** @type {string} */ spec) =>
                  h(
                    "li",
                    { class: "planned-item" },
                    h("span", { class: "mono", text: spec }),
                  ),
                ),
              ),
            )
          : null,
      ),
    );
  }

  /**
   * One row per environment: how many specs, the hooks, the var names (never
   * values), and the problem when the suite does not resolve there.
   * @param {any} suite
   * @param {string | null} picked
   */
  function envTable(suite, picked) {
    if (!suite.envs.length)
      return h("p", { class: "cell-dim", text: "no environment resolves it" });
    return h(
      "div",
      { class: "data-table-scroll" },
      h(
        "table",
        {
          class: "grid suite-envs",
          ariaLabel: `${suite.name} per environment`,
        },
        h(
          "thead",
          h(
            "tr",
            ["environment", "specs", "hooks", "vars", "status"].map((label) =>
              h("th", { text: label }),
            ),
          ),
        ),
        h(
          "tbody",
          suite.envs.map((/** @type {any} */ entry) =>
            h(
              "tr",
              {
                class: `suite-env${
                  entry.env === picked ? " suite-env-picked" : ""
                }${entry.problem ? " suite-env-problem" : ""}`,
                ariaCurrent: entry.env === picked ? "true" : null,
              },
              h("td", { class: "mono", text: entry.env }),
              h("td", { class: "mono", text: String(entry.specs.length) }),
              h("td", {
                class: "mono cell-dim",
                text:
                  entry.before + entry.after
                    ? `${entry.before} before / ${entry.after} after${
                        entry.hookTimeoutMs
                          ? ` · ${Studio.fmt.formatDuration(entry.hookTimeoutMs)} each`
                          : ""
                      }`
                    : "—",
              }),
              h("td", {
                class: "mono cell-dim",
                title: "names only; values never leave the config",
                text: entry.vars.length ? entry.vars.join(", ") : "—",
              }),
              h(
                "td",
                entry.problem
                  ? h(
                      "span",
                      { class: "ops-inline ops-inline-warn" },
                      h("span", { ariaHidden: "true", text: "⚠ " }),
                      `cannot run: ${entry.problem}`,
                    )
                  : h(
                      "span",
                      { class: "ops-inline ops-inline-ok" },
                      h("span", { ariaHidden: "true", text: "✓ " }),
                      "ready",
                    ),
              ),
            ),
          ),
        ),
      ),
    );
  }

  /**
   * Disable every Run button while a suite or run lock is held (the owner
   * is in the tooltip), or the project runs through a launch template.
   * @param {HTMLElement} host
   */
  function applyLockState(host) {
    const active = state.locks?.active ?? [];
    const templated = Boolean(state.locks?.launchTemplate);
    const locked = active.length > 0;
    for (const node of host.querySelectorAll("button[data-run-suite]")) {
      const button = /** @type {HTMLButtonElement} */ (node);
      const blocked = button.dataset.blocked === "1";
      button.disabled = blocked || locked || templated;
      button.title = locked
        ? `${Studio.ops.lockHeadline(active)}: ${Studio.ops.lockSentence(active[0])} — Run is disabled while the lock exists`
        : templated
          ? "this project runs specs through a launch template (one spec at a time); run suites from a terminal or clear the template in Settings"
          : (button.dataset.titleOriginal ?? "");
    }
  }

  /**
   * @param {string} name
   * @param {HTMLButtonElement} button
   */
  async function start(name, button) {
    const label = button.textContent ?? "";
    button.disabled = true;
    button.textContent = "Starting…";
    try {
      await actions.startSuite(
        name,
        pickedEnv ? { env: pickedEnv } : undefined,
      );
      Studio.navigate("live");
    } catch (error) {
      toast(
        "Suite failed to start",
        String(error?.message ?? error),
        "bad",
        9000,
      );
    } finally {
      button.textContent = label;
      button.disabled = false;
      const host = button.closest(".suites-host");
      if (host) applyLockState(/** @type {HTMLElement} */ (host));
    }
  }

  Studio.views = Studio.views || {};
  Studio.views.suites = { id: "suites", label: "Suites", glyph: "☰", render };
  Studio.suitesView = { render, effectiveEnv };
})();
