/**
 * Settings view — cairn binary, artifact root, and the default run options
 * every Run button in the app applies.
 */
(function bootSettingsView() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h, state, api, fmt, toast } = Studio;

  const BACKENDS = [
    ["", "config default"],
    ["agent-browser", "agent-browser"],
    ["playwright", "playwright"],
    ["mock", "mock (offline)"],
  ];
  const LOG_LEVELS = ["debug", "info", "warn", "error"];

  /** @param {HTMLElement} root */
  async function render(root) {
    Studio.clear(root);
    const settings = state.settings ?? (await api.call("settings:get"));
    const info = state.info ?? (await api.call("app:info"));
    const run = settings.run ?? {};
    const project = state.project;
    const environments = (project?.config?.environments ?? []).map(
      (env) => env.name,
    );

    root.appendChild(
      Studio.pageHeader(
        "Settings",
        `stored at ${info?.userData ?? "?"}/settings.json`,
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "Reveal settings file",
            onClick: () =>
              api
                .call("settings:reveal")
                .catch(() => toast("Reveal failed", null, "bad")),
          }),
          h("button", {
            class: "btn btn-danger",
            type: "button",
            text: "Reset to defaults",
            onClick: async () => {
              const proceed = await Studio.confirm({
                title: "Reset Studio settings?",
                body: "Recent projects, run defaults, and the cairn binary override are cleared.",
                confirmLabel: "Reset",
                danger: true,
              });
              if (!proceed) return;
              await api.call("settings:reset");
              await Studio.actions.loadInfo();
              await Studio.actions.loadProject();
              toast("Settings reset", null, "ok");
              void render(root);
            },
          }),
        ],
      ),
    );

    // ── cairn binary ────────────────────────────────────────────────────────
    const cairnInput = Studio.input({
      value: settings.cairnBin ?? "",
      placeholder: "auto-detect from PATH",
      style: { width: "100%" },
    });
    root.appendChild(
      Studio.panel("cairn binary", [
        Studio.keyValue([
          ["resolved", info?.cairn?.command ?? "not found"],
          ["source", info?.cairn?.source ?? "—"],
          [
            "candidates tried",
            (info?.cairn?.candidates ?? []).join(", ") || "—",
          ],
        ]),
        h("div", { class: "toolbar", style: { marginTop: "10px" } }, [
          h(
            "label",
            { class: "field", style: { flex: "1 1 320px" } },
            "explicit path (blank = auto-detect)",
            cairnInput,
          ),
          h("button", {
            class: "btn",
            type: "button",
            text: "Browse…",
            onClick: async () => {
              const chosen = await api.call("cairn:choose-binary");
              if (chosen) {
                await Studio.actions.loadInfo();
                toast("cairn binary set", chosen, "ok");
                void render(root);
              }
            },
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Check version",
            onClick: async () => {
              const result = await api.call("cairn:version");
              toast(
                "cairn version",
                result?.version ?? result?.error ?? "unknown",
                result?.version ? "ok" : "bad",
              );
            },
          }),
          h("button", {
            class: "btn btn-primary",
            type: "button",
            text: "Save path",
            onClick: async () => {
              await Studio.actions.saveSettings({
                cairnBin: cairnInput.value.trim() || null,
              });
              await Studio.actions.loadInfo();
              toast("Saved", "cairn binary override updated", "ok", 2200);
              void render(root);
            },
          }),
        ]),
        h("p", {
          class: "cell-dim",
          text: "Studio spawns this binary for every action. macOS GUI apps get a minimal PATH, so Studio also searches /opt/homebrew/bin, /usr/local/bin, ~/.bun/bin, ~/.local/bin, and ~/.volta/bin.",
        }),
      ]),
    );

    // ── artifact root ───────────────────────────────────────────────────────
    const rootInput = Studio.input({
      value: settings.artifactRoot ?? "",
      placeholder: info?.runsRoot?.runsRoot ?? "~/.cairntrace/runs",
      style: { width: "100%" },
    });
    root.appendChild(
      h(
        "div",
        { style: { marginTop: "14px" } },
        Studio.panel("artifact root", [
          Studio.keyValue([
            ["in use", info?.runsRoot?.runsRoot ?? "—"],
            ["source", info?.runsRoot?.source ?? "—"],
            ["from config", project?.config?.artifactRoot ?? "—"],
          ]),
          h("div", { class: "toolbar", style: { marginTop: "10px" } }, [
            h(
              "label",
              { class: "field", style: { flex: "1 1 320px" } },
              "override (blank = config or ~/.cairntrace/runs)",
              rootInput,
            ),
            h("button", {
              class: "btn",
              type: "button",
              text: "Browse…",
              onClick: async () => {
                const dir = await api.call("dialog:open-directory");
                if (dir) {
                  rootInput.value = dir;
                }
              },
            }),
            h("button", {
              class: "btn btn-primary",
              type: "button",
              text: "Save",
              onClick: async () => {
                await Studio.actions.saveSettings({
                  artifactRoot: rootInput.value.trim() || null,
                });
                await Studio.actions.loadInfo();
                await Studio.actions.loadRuns();
                toast("Saved", "artifact root updated", "ok", 2200);
                void render(root);
              },
            }),
          ]),
        ]),
      ),
    );

    // ── run defaults ────────────────────────────────────────────────────────
    const envSelect = Studio.select(
      [["", "config default"], ...environments.map((name) => [name, name])],
      { value: run.env ?? "" },
    );
    const backendSelect = Studio.select(BACKENDS, { value: run.backend ?? "" });
    const levelSelect = Studio.select(LOG_LEVELS, {
      value: run.logLevel ?? "info",
    });
    const parallelInput = Studio.input({
      type: "number",
      value: String(run.parallel ?? 1),
      style: { width: "80px" },
    });
    const labelsInput = Studio.input({
      value: (run.labels ?? []).join(" "),
      placeholder: "path=legacy cohort=next",
      style: { width: "100%" },
    });
    const varsInput = Studio.input({
      value: (run.vars ?? []).join(" "),
      placeholder: "key=value key=value",
      style: { width: "100%" },
    });

    const toggles = [
      ["headed", "headed (show the browser)", "run with --headed"],
      ["coldStart", "cold start", "fresh browser profile: --cold-start"],
      ["monitor", "monitor", "sample browser CPU/RSS: --monitor"],
      ["noWebServer", "skip webServer", "--no-web-server"],
      ["noServices", "skip services", "--no-services (docker/seed/tmux)"],
      ["stashOnFailure", "stash on failure", "--stash-on-failure (fcheap)"],
    ];

    const saveRunDefaults = async () => {
      await Studio.actions.saveSettings({
        run: {
          ...run,
          env: envSelect.value || null,
          backend: backendSelect.value || null,
          logLevel: levelSelect.value || "info",
          parallel: Number(parallelInput.value) || 1,
          labels: splitPairs(labelsInput.value),
          vars: splitPairs(varsInput.value),
          headed: toggleState.headed,
          coldStart: toggleState.coldStart,
          monitor: toggleState.monitor,
          noWebServer: toggleState.noWebServer,
          noServices: toggleState.noServices,
          stashOnFailure: toggleState.stashOnFailure,
        },
      });
      toast("Run defaults saved", null, "ok", 2200);
    };

    const toggleState = {
      headed: Boolean(run.headed),
      coldStart: Boolean(run.coldStart),
      monitor: Boolean(run.monitor),
      noWebServer: Boolean(run.noWebServer),
      noServices: Boolean(run.noServices),
      stashOnFailure: Boolean(run.stashOnFailure),
    };

    root.appendChild(
      h(
        "div",
        { style: { marginTop: "14px" } },
        Studio.panel(
          "run defaults",
          [
            h(
              "div",
              { class: "toolbar" },
              h("label", { class: "field" }, "environment", envSelect),
              h("label", { class: "field" }, "backend", backendSelect),
              h("label", { class: "field" }, "log level", levelSelect),
              h("label", { class: "field" }, "parallel", parallelInput),
            ),
            h(
              "div",
              { class: "toolbar", style: { marginTop: "4px" } },
              toggles.map(([key, label, title]) =>
                Studio.checkbox(
                  label,
                  toggleState[key],
                  (value) => (toggleState[key] = value),
                  title,
                ),
              ),
            ),
            h(
              "div",
              { class: "toolbar" },
              h(
                "label",
                { class: "field", style: { flex: "1 1 300px" } },
                "labels (--label key=value, space separated)",
                labelsInput,
              ),
            ),
            h(
              "div",
              { class: "toolbar" },
              h(
                "label",
                { class: "field", style: { flex: "1 1 300px" } },
                "vars (--var key=value, space separated)",
                varsInput,
              ),
            ),
            h(
              "div",
              { class: "toolbar" },
              h("div", { class: "spacer" }),
              h("button", {
                class: "btn btn-primary",
                type: "button",
                text: "Save run defaults",
                onClick: () => void saveRunDefaults(),
              }),
            ),
            h("p", {
              class: "cell-dim",
              text: "Every Run button in Studio applies these. Per-run overrides (Run headed, Cold-start run) win for that run only.",
            }),
          ],
          {
            actions: [
              Studio.tag(
                `mock: ${run.mock ? "on" : "off"}`,
                run.mock ? "warn" : "muted",
              ),
            ],
          },
        ),
      ),
    );

    // ── projects ────────────────────────────────────────────────────────────
    const projects = settings.projects ?? [];
    root.appendChild(
      h(
        "div",
        { style: { marginTop: "14px" } },
        Studio.panel("recent projects", [
          projects.length
            ? h(
                "div",
                { class: "panel" },
                h(
                  "div",
                  { class: "panel-body tight" },
                  projects.map((entry) =>
                    h(
                      "div",
                      { class: "list-row" },
                      h("span", {
                        class: `dot dot-${
                          entry.path === settings.activeProject ? "ok" : "muted"
                        }`,
                      }),
                      h("span", {
                        class: "mono",
                        style: { fontSize: "11.5px" },
                        text: entry.name ?? entry.path,
                      }),
                      h("span", { class: "cell-dim", text: entry.path }),
                      h("span", {
                        class: "cell-dim",
                        style: { marginLeft: "auto" },
                        text: `${entry.openedCount ?? 1}× · ${fmt.relativeTime(entry.lastOpenedAt)}`,
                      }),
                      h("button", {
                        class: "btn btn-sm",
                        type: "button",
                        text: "Open",
                        onClick: async () => {
                          await Studio.actions.loadProject(entry.path);
                          await Studio.actions.loadRuns();
                          toast("Project opened", entry.path, "ok", 2200);
                          Studio.navigate("runs");
                        },
                      }),
                      h("button", {
                        class: "btn btn-sm btn-ghost",
                        type: "button",
                        text: "Forget",
                        onClick: async () => {
                          await api.call("projects:forget", entry.path);
                          await Studio.actions.loadInfo();
                          void render(root);
                        },
                      }),
                    ),
                  ),
                ),
              )
            : h("p", { class: "cell-dim", text: "no recent projects yet" }),
          h(
            "div",
            { class: "toolbar", style: { marginTop: "10px" } },
            h("button", {
              class: "btn",
              type: "button",
              text: "Open project…",
              onClick: () => Studio.emit("menu:open-project"),
            }),
          ),
        ]),
      ),
    );

    // ── about ───────────────────────────────────────────────────────────────
    root.appendChild(
      h(
        "div",
        { style: { marginTop: "14px" } },
        Studio.panel("about", [
          Studio.keyValue([
            ["Cairntrace Studio", `v${info?.appVersion ?? "?"}`],
            ["electron", info?.electronVersion ?? "?"],
            ["node", info?.nodeVersion ?? "?"],
            ["chromium", info?.chromeVersion ?? "?"],
            ["repo root", info?.repoRoot ?? "—"],
          ]),
          h("p", {
            class: "cell-dim",
            text: "Studio is a thin console over the cairn CLI: it spawns the same commands an agent would, and renders the artifacts those commands already write. Nothing here re-implements runner behaviour.",
          }),
        ]),
      ),
    );
  }

  /**
   * @param {string} value
   * @returns {string[]}
   */
  function splitPairs(value) {
    return String(value ?? "")
      .split(/\s+/)
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  Studio.views = Studio.views || {};
  Studio.views.settings = {
    id: "settings",
    label: "Settings",
    glyph: "⚙",
    render,
  };
})();
