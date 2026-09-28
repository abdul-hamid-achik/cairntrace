/**
 * Environment view — everything that decides whether a run can succeed.
 *
 * `cairn doctor` checks, the project config cairn discovered, services and
 * checkpoint state, and the retention/clean controls for the artifact root.
 * When a spec fails for environmental reasons, this is the first place to look.
 */
(function bootEnvironmentView() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h, state, api, fmt, toast } = Studio;

  /** @param {HTMLElement} root */
  async function render(root) {
    Studio.clear(root);
    root.appendChild(Studio.loading("checking environment…"));

    const [info, doctor, services, checkpoints] = await Promise.allSettled([
      api.call("app:info"),
      api.call("cairn:doctor"),
      api.call("services:status"),
      api.call("checkpoints:list"),
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

    root.appendChild(projectPanel(appInfo));

    if (services.status === "fulfilled")
      root.appendChild(servicesPanel(services.value));
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
        (config?.environments ?? [])
          .map(
            (env) =>
              `${env.name}${env.baseUrl ? ` (${env.baseUrl})` : ""}${
                env.disabled ? " [services off]" : ""
              }`,
          )
          .join(", ") || "—",
      ],
      ["artifactRoot (config)", config?.artifactRoot ?? "—"],
      ["browser backend", config?.backend ?? "agent-browser (default)"],
      ["testIdAttribute", config?.testIdAttribute ?? "data-testid (default)"],
      ["webServer", config?.hasWebServer ? "declared" : "—"],
      ["services", config?.hasServices ? "declared (docker/seed/tmux)" : "—"],
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

  /** @param {any} result */
  function checkpointsPanel(result) {
    const payload = result?.payload ?? null;
    const list = Array.isArray(payload?.checkpoints)
      ? payload.checkpoints
      : Array.isArray(payload)
        ? payload
        : null;
    return Studio.panel("browser-state checkpoints", [
      list
        ? list.length
          ? h(
              "div",
              { class: "panel" },
              h(
                "div",
                { class: "panel-body tight" },
                list.map((checkpoint) =>
                  h(
                    "div",
                    { class: "list-row", style: { cursor: "default" } },
                    h("span", {
                      class: "mono",
                      style: { fontSize: "11.5px" },
                      text:
                        checkpoint.name ??
                        checkpoint.id ??
                        JSON.stringify(checkpoint).slice(0, 60),
                    }),
                    h("span", {
                      class: "cell-dim",
                      style: { marginLeft: "auto" },
                      text: checkpoint.createdAt
                        ? fmt.relativeTime(checkpoint.createdAt)
                        : "",
                    }),
                  ),
                ),
              ),
            )
          : h("p", {
              class: "cell-dim",
              text: "none captured — use `cairn login <name> --url <url>` to create one for session.resume specs",
            })
        : h("pre", {
            class: "code tight",
            text: fmt.truncate(
              result?.stdout || result?.stderr || "checkpoint list unavailable",
              2000,
            ),
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
        text: `cairn prunes to the newest N runs per spec after every run (default 3; failed runs keep 10). Artifact root: ${info.runsRoot?.runsRoot ?? "—"}`,
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
            const proceed = await Studio.confirm({
              title: "Prune old runs?",
              body: "Runs beyond the retention window are deleted from the artifact root. Failed runs keep their carve-out.",
              confirmLabel: "Prune",
              danger: true,
            });
            if (!proceed) return;
            try {
              const result = await api.call("clean:runs", {
                keepRuns: Number(keepRuns.value) || 0,
              });
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
            const proceed = await Studio.confirm({
              title: "Delete the whole artifact root?",
              body: "`cairn clean --all` removes every run directory, including failures. This cannot be undone.",
              confirmLabel: "Delete all runs",
              danger: true,
            });
            if (!proceed) return;
            try {
              const result = await api.call("clean:runs", { all: true });
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
