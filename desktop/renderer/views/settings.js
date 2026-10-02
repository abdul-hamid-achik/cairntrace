/**
 * Settings view — cairn binary, artifact root, and the default run options
 * every Run button in the app applies.
 */
(function bootSettingsView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
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
              try {
                // Main asks again, natively, if a suite lock is held.
                await api.call("settings:reset");
              } catch (error) {
                toast("Not reset", String(error?.message ?? error), "bad");
                return;
              }
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
              try {
                await Studio.actions.setCairnBin(
                  cairnInput.value.trim() || null,
                );
              } catch (error) {
                toast("Not saved", String(error?.message ?? error), "bad");
                return;
              }
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
                try {
                  await Studio.actions.setArtifactRoot(
                    rootInput.value.trim() || null,
                  );
                } catch (error) {
                  toast("Not saved", String(error?.message ?? error), "bad");
                  return;
                }
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
      try {
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
      } catch (error) {
        // e.g. a label or var that starts with "-" (it would read as a flag)
        toast("Not saved", String(error?.message ?? error), "bad");
        return;
      }
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

    // ── launch safety (per project) ─────────────────────────────────────────
    if (project?.dir) root.appendChild(await launchPanel(project.dir, root));

    // ── interface ───────────────────────────────────────────────────────────
    const ui = settings.ui ?? {};
    const densitySelect = Studio.select(
      [
        ["comfortable", "comfortable"],
        ["compact", "compact"],
      ],
      { value: ui.density ?? "comfortable" },
    );
    const shotInput = Studio.input({
      type: "number",
      value: String(ui.screenshotMaxWidth ?? 720),
      style: { width: "90px" },
    });
    const pollInput = Studio.input({
      type: "number",
      value: String(ui.livePollMs ?? 400),
      style: { width: "90px" },
    });
    let autoRefresh = ui.autoRefreshRuns !== false;
    root.appendChild(
      h(
        "div",
        { style: { marginTop: "14px" } },
        Studio.panel("interface", [
          h(
            "div",
            { class: "toolbar" },
            h("label", { class: "field" }, "density", densitySelect),
            h(
              "label",
              { class: "field" },
              "screenshot max width (px)",
              shotInput,
            ),
            h("label", { class: "field" }, "live tail poll (ms)", pollInput),
            Studio.checkbox(
              "refresh Runs when a run finishes",
              autoRefresh,
              (value) => (autoRefresh = value),
            ),
            h("div", { class: "spacer" }),
            h("button", {
              class: "btn btn-primary",
              type: "button",
              text: "Save interface",
              onClick: async () => {
                await Studio.actions.saveSettings({
                  ui: {
                    density:
                      densitySelect.value === "compact"
                        ? "compact"
                        : "comfortable",
                    screenshotMaxWidth: Math.max(
                      160,
                      Math.min(4000, Number(shotInput.value) || 720),
                    ),
                    livePollMs: Math.max(
                      150,
                      Math.min(5000, Number(pollInput.value) || 400),
                    ),
                    autoRefreshRuns: autoRefresh,
                  },
                });
                toast("Interface saved", null, "ok", 2200);
              },
            }),
          ),
        ]),
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
                      h(
                        "span",
                        { class: "cell-dim", style: { marginLeft: "auto" } },
                        `${entry.openedCount ?? 1}× · `,
                        Studio.relTime(entry.lastOpenedAt),
                      ),
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
   * Per-project launch template + lock files.
   * @param {string} projectDir
   * @param {HTMLElement} root
   */
  async function launchPanel(projectDir, root) {
    let status = null;
    try {
      status = await api.call("project:locks", projectDir);
    } catch {
      // shown as empty settings
    }
    const templateInput = Studio.input({
      value: status?.launchTemplate ?? "",
      placeholder:
        "blank = spawn cairn run directly · e.g. task run FLOW={spec} ENV={env} -- {cairnArgs}",
      style: { width: "100%" },
    });
    const locksInput = /** @type {HTMLTextAreaElement} */ (
      h("textarea", {
        class: "editor small-editor",
        spellcheck: "false",
        placeholder:
          "one lock file or directory per line, relative to the project (e.g. runs/.suite.lock)",
        value: (status?.lockFiles ?? []).join("\n"),
      })
    );
    const preview = h("pre", { class: "code tight hidden" });
    const showPreview = async () => {
      const template = templateInput.value.trim();
      if (!template) {
        preview.classList.add("hidden");
        return;
      }
      try {
        const built = await api.call(
          "launch:preview",
          { template },
          projectDir,
        );
        preview.textContent = [built.command, ...(built.args ?? [])].join(" ");
        preview.classList.remove("hidden");
      } catch (error) {
        preview.textContent = String(error?.message ?? error);
        preview.classList.remove("hidden");
      }
    };
    const lockRows = (status?.locks ?? []).map((lock) =>
      h(
        "div",
        { class: "list-row" },
        h("span", {
          class: `dot dot-${lock.exists ? "warn" : lock.error ? "bad" : "ok"}`,
        }),
        h("span", { class: "mono", text: lock.path }),
        h("span", {
          class: "cell-dim",
          text: lock.error
            ? lock.error
            : lock.exists
              ? `held${
                  lock.owner ? ` by ${lock.owner}` : ""
                } · ${fmt.formatDuration(lock.ageMs)} old`
              : "free",
        }),
      ),
    );
    return h(
      "div",
      { style: { marginTop: "14px" } },
      Studio.panel(`launch safety · ${projectDir.split("/").pop()}`, [
        h(
          "label",
          { class: "field", style: { width: "100%" } },
          "launch template (placeholders: {spec} {specs} {specName} {env} {cairnArgs} {projectDir}; no shell)",
          templateInput,
        ),
        preview,
        h(
          "label",
          { class: "field", style: { width: "100%", marginTop: "8px" } },
          "suite lock files — Run is disabled while any exists",
          locksInput,
        ),
        lockRows.length
          ? h(
              "div",
              { class: "panel", style: { marginTop: "8px" } },
              h("div", { class: "panel-body tight" }, lockRows),
            )
          : null,
        h(
          "div",
          { class: "toolbar", style: { marginTop: "8px" } },
          h("button", {
            class: "btn",
            type: "button",
            text: "Preview command",
            onClick: () => void showPreview(),
          }),
          h("div", { class: "spacer" }),
          h("button", {
            class: "btn btn-primary",
            type: "button",
            text: "Save launch settings",
            onClick: async () => {
              try {
                await api.call(
                  "project:launch-update",
                  {
                    launchTemplate: templateInput.value.trim() || null,
                    lockFiles: locksInput.value
                      .split(/\r?\n/)
                      .map((entry) => entry.trim())
                      .filter(Boolean),
                  },
                  projectDir,
                );
                await Studio.actions.loadInfo();
                await Studio.actions.loadLocks();
                toast("Launch settings saved", null, "ok", 2200);
                void render(root);
              } catch (error) {
                toast("Not saved", String(error?.message ?? error), "bad");
              }
            },
          }),
        ),
        h("p", {
          class: "cell-dim",
          text: "When a template is set, every Run button spawns it (tokenized, no shell) instead of cairn run; {cairnArgs} carries Studio's run flags (--format json, --log-format json, labels, vars…). Studio still tails the artifact root, so Live works the same.",
        }),
      ]),
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
