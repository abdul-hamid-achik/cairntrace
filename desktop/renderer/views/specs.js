/**
 * Specs view — the authoring workspace.
 *
 * List, read, edit, verify, heal, and run specs without leaving the app. The
 * editor is deliberately plain: cairn's `spec verify` is the authority on
 * whether a spec is valid, so this view saves the file and immediately shows
 * what the CLI says, including contract-hash refusals (exit 6).
 *
 * Environment policy: each spec shows its `requires:` (env list, mutates),
 * and the detail lets the user pick the environment to run on. When the
 * environment policy would refuse the spec there, a warning says why and Run
 * asks once — it never blocks: `cairn run` is the authority, and a refused
 * run simply ends with status "refused" (exit 7).
 */
(function bootSpecsView() {
  const Studio = (globalThis.Studio =
    globalThis.Studio || /** @type {StudioGlobal} */ ({}));
  const { h, state, actions, api, fmt, toast } = Studio;

  /**
   * @param {HTMLElement} root
   * @param {{ file?: string | null }} [params]
   */
  async function render(root, params) {
    Studio.clear(root);
    root.appendChild(Studio.loading("scanning project for specs…"));
    if (!state.project) await actions.loadProject();
    state.specs =
      (await api.call("specs:list", state.project?.dir ?? null)) ?? [];
    if (params?.file) state.selectedSpec = params.file;
    if (!state.selectedSpec && state.specs.length)
      state.selectedSpec = state.specs[0].path;
    paint(root);
    if (state.selectedSpec) await loadSelected(root);
    // Suite locks come and go while the view is open (app.js polls them).
    // Internal re-renders (Rescan) replace the listener instead of stacking.
    offLocks?.();
    offLocks = Studio.on("locks", () => applyLockState());
    applyLockState();
    return {
      destroy() {
        offLocks?.();
        offLocks = null;
      },
    };
  }

  /** @type {(() => void) | null} */
  let offLocks = null;

  /**
   * The environment picked in the detail toolbar ("" = the run settings /
   * the spec's own environment / the config default, like the CLI).
   */
  let runEnv = "";
  /**
   * Opt-in states (name → granted?) for the open spec, from spec:read and
   * spec:write; `optInsPath` is the spec they answer for.
   */
  /** @type {Record<string, boolean>} */
  let optIns = {};
  /** @type {string | null} */
  let optInsPath = null;

  /**
   * Would `cairn run` refuse this spec on the environment it resolves to?
   * Same rules as the CLI (lib/policy.js); a warning, never a block.
   * @param {any} summary
   */
  function policyVerdict(summary) {
    const config = state.project?.config ?? null;
    const resolved = CairnPolicy.resolveEnvironment({
      override: runEnv || state.settings?.run?.env || null,
      specEnvironment: summary?.environment ?? null,
      defaultEnvironment: config?.defaultEnvironment ?? null,
    });
    const envConfig = (config?.environments ?? []).find(
      (/** @type {any} */ entry) => entry.name === resolved.name,
    );
    return {
      ...CairnPolicy.evaluateRequires({
        requires: summary?.requires ?? null,
        env: resolved.name,
        policy: envConfig?.policy ?? null,
        optIns,
      }),
      source: resolved.source,
    };
  }

  /**
   * Paint the policy warning under the toolbar for the open spec.
   * @param {any} summary
   */
  function paintPolicyWarning(summary) {
    const node = document.getElementById("spec-policy-warning");
    if (!node) return;
    const verdict = policyVerdict(summary);
    node.classList.toggle("hidden", !verdict.refused);
    node.textContent = verdict.refused
      ? `cairn would refuse this spec on "${verdict.env}": ${verdict.summary}. Run still starts it — the CLI decides, and a refused run ends with status refused (exit 7) before anything starts.`
      : "";
  }

  /**
   * Disable every Run button while a configured suite lock exists, and say
   * who holds it (launch safety: the task runner's lock is the authority).
   */
  function applyLockState() {
    const active = state.locks?.active ?? [];
    const locked = active.length > 0;
    for (const node of document.querySelectorAll("[data-run-button]")) {
      const button = /** @type {HTMLButtonElement} */ (node);
      if (button.dataset.titleOriginal === undefined)
        button.dataset.titleOriginal = button.title ?? "";
      button.disabled = locked;
      button.title = locked
        ? `suite in progress (${active[0].path}) — Run is disabled while the lock exists`
        : button.dataset.titleOriginal;
    }
    const banner = document.getElementById("spec-lock-banner");
    if (!banner) return;
    banner.classList.toggle("hidden", !locked);
    banner.textContent = locked
      ? `Suite in progress: ${active
          .map(
            (lock) =>
              `${lock.path}${lock.owner ? ` (owner: ${lock.owner})` : ""}`,
          )
          .join(", ")} — Run is disabled until the lock is released.`
      : "";
  }

  /** @param {HTMLElement} root */
  function paint(root) {
    Studio.clear(root);
    const project = state.project;

    root.appendChild(
      Studio.pageHeader(
        "Specs",
        project
          ? `${state.specs.length} spec file${
              state.specs.length === 1 ? "" : "s"
            } under ${project.dir}`
          : "no project open",
        [
          h("button", {
            class: "btn",
            type: "button",
            text: "New spec…",
            onClick: () => void scaffoldDialog(root),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Add spec file…",
            onClick: () => void addSpecFile(root),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Rescan",
            onClick: () => void render(root),
          }),
        ],
      ),
    );

    const notice = Studio.setupNotice();
    if (notice) root.appendChild(notice);

    if (!state.specs.length) {
      root.appendChild(
        Studio.empty(
          "No specs found",
          "Cairntrace looks for YAML files declaring `steps:` plus `intent:` or `outcomes:`. Open a project that contains them, or scaffold a first spec here.",
          [
            h("button", {
              class: "btn btn-primary",
              type: "button",
              text: "Open project…",
              onClick: () => Studio.emit("menu:open-project"),
            }),
            h("button", {
              class: "btn",
              type: "button",
              text: "New spec…",
              onClick: () => void scaffoldDialog(root),
            }),
          ],
        ),
      );
      return;
    }

    const search = Studio.input({
      type: "search",
      placeholder: "filter specs…",
      style: { minWidth: "220px" },
      onInput: (event) => filterList(event.target.value),
    });

    const listHost = h("div", {
      class: "panel spec-list",
      role: "listbox",
      ariaLabel: "specs",
    });
    // Arrows move between specs, Enter/Space opens one; one Tab stop.
    Studio.rovingKeys(listHost, {
      items: () => /** @type {HTMLElement[]} */ ([
        ...listHost.querySelectorAll(".spec-item"),
      ]),
      roving: true,
      onActivate: (item) => item.click(),
    });
    const detailHost = h("div", { id: "spec-detail" });

    root.appendChild(
      h(
        "div",
        { class: "specs-grid" },
        h(
          "div",
          h(
            "div",
            { class: "toolbar", style: { marginBottom: "8px" } },
            search,
          ),
          listHost,
        ),
        detailHost,
      ),
    );

    paintList(listHost, "");
    /** @param {string} query */
    function filterList(query) {
      paintList(listHost, query);
    }
  }

  /**
   * @param {HTMLElement} host
   * @param {string} query
   */
  function paintList(host, query) {
    Studio.clear(host);
    const needle = query.trim().toLowerCase();
    const items = state.specs.filter((spec) => {
      if (!needle) return true;
      const summary = spec.summary ?? {};
      return `${spec.rel} ${summary.intent ?? ""} ${summary.name ?? ""}`
        .toLowerCase()
        .includes(needle);
    });
    if (!items.length) {
      host.appendChild(
        h(
          "div",
          { class: "panel-body" },
          h("p", { class: "cell-dim", text: "no spec matches that filter" }),
        ),
      );
      return;
    }
    for (const spec of items) {
      const summary = spec.summary ?? {};
      const selected = state.selectedSpec === spec.path;
      host.appendChild(
        h(
          "div",
          {
            class: `spec-item${selected ? " selected" : ""}`,
            role: "option",
            ariaSelected: selected ? "true" : "false",
            tabindex: "-1",
            dataset: { path: spec.path },
            onClick: () => {
              state.selectedSpec = spec.path;
              paintList(host, needle);
              // The list was rebuilt: keep keyboard focus on the choice.
              /** @type {HTMLElement | undefined} */ (
                [...host.querySelectorAll(".spec-item")].find(
                  (item) =>
                    /** @type {HTMLElement} */ (item).dataset.path ===
                    spec.path,
                )
              )?.focus();
              void loadSelected(document.getElementById("view"));
            },
          },
          h(
            "div",
            { class: "name" },
            h("span", {
              class: `dot dot-${
                summary.parseError ? "bad" : selected ? "ok" : "muted"
              }`,
            }),
            summary.name ?? spec.name,
            summary.contractHash ? Studio.tag("hashed", "ok") : null,
            summary.parseError ? Studio.tag("yaml error", "bad") : null,
          ),
          summary.requires
            ? h("div", {
                class: "path requires-line",
                title: "requires (environment policy)",
                text: `requires ${CairnPolicy.describeRequires(summary.requires) ?? "—"}`,
              })
            : null,
          summary.intent
            ? h("div", {
                class: "intent",
                text: fmt.truncate(summary.intent, 90),
              })
            : null,
          h("div", { class: "path", text: spec.rel }),
          h(
            "div",
            { class: "path" },
            `${(summary.outcomes ?? []).length} outcomes · ${(summary.steps ?? []).length} steps · `,
            Studio.relTime(spec.mtimeMs, { prefix: "edited " }),
          ),
        ),
      );
    }
    const rows = /** @type {HTMLElement[]} */ ([
      ...host.querySelectorAll(".spec-item"),
    ]);
    Studio.setRovingStop(
      rows,
      rows.find((row) => row.dataset.path === state.selectedSpec),
    );
  }

  /**
   * @param {HTMLElement | null} root
   */
  async function loadSelected(root) {
    const host = document.getElementById("spec-detail");
    if (!host) return;
    Studio.clear(host);
    host.appendChild(Studio.loading("reading spec…"));
    let spec;
    try {
      spec = await api.call("spec:read", state.selectedSpec);
    } catch (error) {
      Studio.clear(host);
      host.appendChild(Studio.errorBox(error, "spec:read"));
      return;
    }
    state.specText = spec.text;
    state.specSummary = spec.summary;
    state.specDirty = false;
    optIns = spec.optIns ?? {};
    optInsPath = spec.path ?? state.selectedSpec;
    paintDetail(host, spec, root);
    applyLockState();
  }

  /**
   * @param {HTMLElement} host
   * @param {any} spec
   * @param {HTMLElement | null} root
   */
  function paintDetail(host, spec, root) {
    Studio.clear(host);
    const summary = spec.summary ?? {};
    const editor = /** @type {HTMLTextAreaElement} */ (
      h("textarea", {
        class: "editor",
        spellcheck: "false",
        value: spec.text,
        onInput: (event) => {
          state.specText = event.target.value;
          state.specDirty = true;
          editor.classList.add("dirty");
          dirtyTag.textContent = "unsaved";
        },
        onKeydown: (event) => onEditorKey(event, editor),
      })
    );
    const dirtyTag = Studio.tag("saved", "muted");

    const findingsHost = h("div", { id: "spec-findings" });
    if (state.specFindings && state.specFindings.path === spec.path)
      findingsHost.appendChild(renderFindings(state.specFindings));

    const coldStart = coldStartStatus(summary, spec.text);

    host.appendChild(
      h("div", {
        id: "spec-lock-banner",
        class: "lock-banner hidden",
      }),
    );
    host.appendChild(
      h(
        "div",
        { class: "editor-wrap" },
        h(
          "div",
          { class: "toolbar" },
          h("span", {
            class: "mono",
            style: { fontSize: "12px" },
            text: summary.name ?? spec.path.split("/").pop(),
          }),
          dirtyTag,
          summary.contractHash
            ? Studio.tag(
                `contractHash ${summary.contractHash.slice(0, 18)}…`,
                "ok",
              )
            : Studio.tag("no contractHash", "warn"),
          Studio.tag(coldStart.label, coldStart.tone),
          h("div", { class: "spacer" }),
          envPicker(summary),
          h("button", {
            class: "btn",
            type: "button",
            text: "Save",
            title: "⌘S — writes the file, then runs cairn spec verify",
            onClick: () => void save(spec.path, editor, findingsHost),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Verify",
            onClick: () => void verify(spec.path, findingsHost, false),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Stamp hash",
            title: "cairn spec verify --stamp (writes contractHash)",
            onClick: () => void stamp(spec.path, findingsHost, editor),
          }),
          h("button", {
            class: "btn btn-primary",
            type: "button",
            text: "Run",
            title: "cairn run with the current run settings",
            dataset: { runButton: "1" },
            onClick: () => void runSpec(spec.path, false),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Run headed",
            dataset: { runButton: "1" },
            onClick: () => void runSpec(spec.path, false, { headed: true }),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Cold-start run",
            title: "cairn run --cold-start",
            dataset: { runButton: "1" },
            onClick: () => void runSpec(spec.path, false, { coldStart: true }),
          }),
          h("button", {
            class: "btn",
            type: "button",
            text: "Heal…",
            title: "cairn spec heal re-runs the spec (preconditions included)",
            dataset: { runButton: "1" },
            onClick: () => void healDialog(spec.path),
          }),
          h("button", {
            class: "btn btn-ghost",
            type: "button",
            text: "Reveal",
            onClick: () =>
              api
                .call("fs:reveal", spec.path)
                .catch(() => toast("Reveal failed", spec.path, "bad")),
          }),
        ),
        h("div", {
          class: "cell-dim",
          style: { marginBottom: "8px" },
          text: spec.path,
        }),
        h("div", {
          id: "spec-policy-warning",
          class: "policy-warning hidden",
          role: "status",
        }),
        editor,
        findingsHost,
        h("div", { class: "section-title" }, "Contract"),
        Studio.panel(
          "",
          h(
            "div",
            {},
            Studio.keyValue([
              ["intent", summary.intent ?? "—"],
              ["environment", summary.environment ?? "(config default)"],
              [
                "requires",
                h("span", {
                  id: "spec-requires-value",
                  text: requiresText(summary.requires),
                }),
              ],
              ["imports", (summary.imports ?? []).join(", ") || "—"],
              ["session.resume", summary.session?.resume ?? "—"],
              ["coldStart", summary.coldStart ?? "—"],
              ["tags", (summary.tags ?? []).join(", ") || "—"],
              ...((summary.fixtures ?? []).length
                ? [["fixtures", summary.fixtures.join(", ")]]
                : []),
              ...((summary.wait ?? []).length
                ? [["preconditions.wait", summary.wait.join(" → ")]]
                : []),
            ]),
            h(
              "div",
              { class: "section-title" },
              `Outcomes (${(summary.outcomes ?? []).length})`,
            ),
            (summary.outcomes ?? []).length
              ? h(
                  "div",
                  { class: "panel" },
                  h(
                    "div",
                    { class: "panel-body tight" },
                    summary.outcomes.map((outcome) =>
                      h(
                        "div",
                        { class: "list-row" },
                        h("span", {
                          class: "mono",
                          style: { fontSize: "11.5px" },
                          text: outcome.id,
                        }),
                        h("span", {
                          class: "cell-summary",
                          text: outcome.description ?? "",
                        }),
                        ...(outcome.verifiers ?? []).map((verifier) =>
                          Studio.tag(verifier, "info"),
                        ),
                        outcome.polled ? Studio.tag("poll", "muted") : null,
                      ),
                    ),
                  ),
                )
              : h("p", {
                  class: "cell-dim",
                  text: "no outcomes declared — cairn will fail verify",
                }),
            h(
              "div",
              { class: "section-title" },
              `Steps (${(summary.steps ?? []).length})`,
            ),
            (summary.steps ?? []).length
              ? h(
                  "div",
                  { class: "panel" },
                  h(
                    "div",
                    { class: "panel-body tight" },
                    summary.steps.map((step) =>
                      h(
                        "div",
                        { class: "list-row" },
                        h("span", {
                          class: "mono",
                          style: { fontSize: "11.5px" },
                          text: step.id,
                        }),
                        Studio.tag(step.kind, "muted"),
                        step.when
                          ? Studio.tag(`when: ${step.when}`, "warn")
                          : null,
                        step.optional ? Studio.tag("optional", "muted") : null,
                        step.description
                          ? h("span", {
                              class: "cell-summary",
                              text: step.description,
                            })
                          : null,
                      ),
                    ),
                  ),
                )
              : h("p", { class: "cell-dim", text: "no steps declared" }),
            (summary.teardown ?? []).length
              ? h(
                  "div",
                  h(
                    "div",
                    { class: "section-title" },
                    `Teardown (${summary.teardown.length})${
                      summary.teardownFailsRun ? " · failRun" : ""
                    }`,
                  ),
                  h(
                    "div",
                    { class: "panel" },
                    h(
                      "div",
                      { class: "panel-body tight" },
                      summary.teardown.map((step) =>
                        h(
                          "div",
                          { class: "list-row" },
                          h("span", {
                            class: "mono",
                            style: { fontSize: "11.5px" },
                            text: step.id,
                          }),
                          Studio.tag(step.kind, "muted"),
                        ),
                      ),
                    ),
                  ),
                )
              : null,
            summary.parseError
              ? h(
                  "div",
                  { class: "error-box", style: { marginTop: "10px" } },
                  h("strong", {
                    text: `YAML parse error: ${summary.parseError}`,
                  }),
                )
              : null,
          ),
        ),
      ),
    );

    paintPolicyWarning(summary);
    if (root) void root;
  }

  /** @param {any} requires */
  function requiresText(requires) {
    return (
      CairnPolicy.describeRequires(requires) ??
      "— (any environment the policy allows)"
    );
  }

  /**
   * A save changed the spec on disk: everything the policy warning and the
   * pre-Run check read (`requires`, opt-ins) follows it, and so do the
   * Contract panel's requires and the list row's requires line.
   * @param {string} file
   * @param {any} result spec:write's answer
   */
  function adoptSaved(file, result) {
    if (!result?.summary) return;
    state.specSummary = result.summary;
    optIns = result.optIns ?? {};
    optInsPath = file;
    const entry = (state.specs ?? []).find((spec) => spec.path === file);
    if (entry) entry.summary = { ...entry.summary, ...result.summary };
    const value = document.getElementById("spec-requires-value");
    if (value) value.textContent = requiresText(result.summary.requires);
    const row = /** @type {HTMLElement | undefined} */ (
      [...document.querySelectorAll(".spec-item")].find(
        (item) => /** @type {HTMLElement} */ (item).dataset.path === file,
      )
    );
    if (row) {
      const described = CairnPolicy.describeRequires(result.summary.requires);
      let line =
        /** @type {HTMLElement | null} */ (row.querySelector(".requires-line"));
      if (!described) line?.remove();
      else {
        if (!line) {
          line = h("div", {
            class: "path requires-line",
            title: "requires (environment policy)",
          });
          row.querySelector(".name")?.after(line);
        }
        line.textContent = `requires ${described}`;
      }
    }
    paintPolicyWarning(result.summary);
  }

  /**
   * "run on" environment select: the default (what the CLI would resolve)
   * plus every environment the config defines, with its policy.
   * @param {any} summary
   * @returns {HTMLElement}
   */
  function envPicker(summary) {
    const config = state.project?.config ?? null;
    const fallback = CairnPolicy.resolveEnvironment({
      override: state.settings?.run?.env || null,
      specEnvironment: summary?.environment ?? null,
      defaultEnvironment: config?.defaultEnvironment ?? null,
    });
    const names = (config?.environments ?? []).map(
      (/** @type {any} */ env) => env.name,
    );
    if (runEnv && !names.includes(runEnv)) runEnv = "";
    const select = Studio.select(
      [
        ["", `default (${fallback.name})`],
        ...(config?.environments ?? []).map((/** @type {any} */ env) => {
          const policy = CairnPolicy.describePolicy(env.policy);
          return [env.name, policy ? `${env.name} · ${policy}` : env.name];
        }),
      ],
      {
        value: runEnv,
        ariaLabel: "environment to run on",
        title: "the environment Run, Run headed, Cold-start run and Heal use",
        onChange: (/** @type {Event} */ event) => {
          runEnv = /** @type {HTMLSelectElement} */ (event.target).value;
          paintPolicyWarning(state.specSummary ?? summary);
        },
      },
    );
    return h("label", { class: "env-picker" }, "run on", select);
  }

  /**
   * Which cold-start contract clause this spec satisfies (AGENTS.md rule).
   * @param {any} summary
   * @param {string} text
   */
  function coldStartStatus(summary, text) {
    if ((summary.imports ?? []).length)
      return { label: "cold-start: imports", tone: "ok" };
    if (summary.session?.resume)
      return {
        label: `cold-start: resume ${summary.session.resume}`,
        tone: "ok",
      };
    if (/^\s*preconditions\s*:/m.test(text))
      return { label: "cold-start: preconditions", tone: "ok" };
    if (String(summary.coldStart ?? "") === "guest")
      return { label: "cold-start: guest", tone: "ok" };
    return { label: "cold-start contract NOT satisfied", tone: "bad" };
  }

  /**
   * @param {KeyboardEvent} event
   * @param {HTMLTextAreaElement} editor
   */
  function onEditorKey(event, editor) {
    const mod = event.metaKey || event.ctrlKey;
    if (mod && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save(
        state.selectedSpec,
        editor,
        document.getElementById("spec-findings"),
      );
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const start = editor.selectionStart;
      const end = editor.selectionEnd;
      editor.value = `${editor.value.slice(0, start)}  ${editor.value.slice(end)}`;
      editor.selectionStart = editor.selectionEnd = start + 2;
      state.specText = editor.value;
      state.specDirty = true;
    }
  }

  /**
   * @param {string} file
   * @param {HTMLTextAreaElement} editor
   * @param {HTMLElement | null} findingsHost
   */
  async function save(file, editor, findingsHost) {
    if (!file) return;
    try {
      const written = await api.call("spec:write", file, editor.value);
      adoptSaved(file, written);
      state.specDirty = false;
      editor.classList.remove("dirty");
      toast("Spec saved", file.split("/").pop(), "ok", 2200);
      // Verify straight away: a contract-hash mismatch (exit 6) is exactly the
      // thing an author must see before they run the spec.
      await verify(file, findingsHost, true);
    } catch (error) {
      toast("Save failed", String(error?.message ?? error), "bad");
    }
  }

  /**
   * @param {string} file
   * @param {HTMLElement | null} findingsHost
   * @param {boolean} quietOnSuccess
   */
  async function verify(file, findingsHost, quietOnSuccess) {
    if (!file) return;
    const host = findingsHost ?? document.getElementById("spec-findings");
    if (host) {
      Studio.clear(host);
      host.appendChild(Studio.loading("cairn spec verify…"));
    }
    try {
      const result = await api.call("spec:verify", { spec: file });
      const findings = { ...result, path: file };
      state.specFindings = findings;
      if (host) {
        Studio.clear(host);
        host.appendChild(renderFindings(findings));
      }
      if (!quietOnSuccess || !result.ok)
        toast(
          result.ok ? "Spec valid" : `Spec verify: ${result.meaning}`,
          result.ok ? null : findingsMessage(result),
          result.ok ? "ok" : "bad",
        );
    } catch (error) {
      if (host) {
        Studio.clear(host);
        host.appendChild(Studio.errorBox(error, "spec:verify"));
      }
    }
  }

  /**
   * @param {any} result
   */
  function findingsMessage(result) {
    const payload = result?.payload ?? {};
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    if (errors.length) return String(errors[0]?.message ?? errors[0]);
    return result?.stderr
      ? fmt.truncate(result.stderr, 200)
      : `exit ${result?.exitCode} (${result?.meaning})`;
  }

  /**
   * @param {any} findings
   */
  function renderFindings(findings) {
    const payload = findings?.payload ?? {};
    const errors = Array.isArray(payload.errors) ? payload.errors : [];
    const warnings = Array.isArray(payload.warnings) ? payload.warnings : [];
    const nodes = [
      h(
        "div",
        { class: "toolbar", style: { marginTop: "12px" } },
        h(
          "span",
          { class: "section-title", style: { margin: "0" } },
          "cairn spec verify",
        ),
        Studio.tag(
          String(payload.status ?? (findings.ok ? "valid" : "invalid")),
          findings.ok ? "ok" : "bad",
        ),
        findings.exitCode === 6
          ? Studio.tag("contract-hash mismatch", "bad")
          : null,
        h("span", {
          class: "cell-dim",
          text: `exit ${findings.exitCode} · ${findings.meaning}`,
        }),
        payload.referenceFindings !== undefined
          ? h("span", {
              class: "cell-dim",
              text: `${payload.referenceFindings} placeholder finding(s)`,
            })
          : null,
      ),
    ];
    if (!errors.length && !warnings.length && findings.ok)
      nodes.push(
        h("p", {
          class: "cell-dim",
          text: "lint clean — this spec parses and its placeholder references resolve.",
        }),
      );
    for (const error of errors) nodes.push(findingRow(error, "bad"));
    for (const warning of warnings) nodes.push(findingRow(warning, "warn"));
    if (!findings.ok && (!errors.length || findings.stderr))
      nodes.push(
        h("pre", {
          class: "code tight",
          text: fmt.truncate(findings.stderr || findings.stdout || "", 4000),
        }),
      );
    return h("div", { class: "findings" }, nodes);
  }

  /**
   * @param {any} finding
   * @param {"bad" | "warn"} tone
   */
  function findingRow(finding, tone) {
    const message =
      typeof finding === "string"
        ? finding
        : (finding?.message ?? JSON.stringify(finding));
    const where =
      typeof finding === "object" && finding
        ? [finding.path, finding.step, finding.outcome, finding.line]
            .filter(Boolean)
            .join(" · ")
        : "";
    return h(
      "div",
      { class: `finding ${tone}` },
      h("span", { class: `dot dot-${tone}` }),
      h("span", { text: message }),
      where
        ? h("span", {
            class: "where",
            style: { marginLeft: "auto" },
            text: where,
          })
        : null,
    );
  }

  /**
   * @param {string} file
   * @param {boolean} _stamp
   * @param {Record<string, any>} [overrides]
   */
  async function runSpec(file, _stamp, overrides) {
    // Opt-ins answer for one spec: re-read when they belong to another
    // (⌘R can fire for a spec this view never opened).
    if (optInsPath !== file || !state.specSummary) {
      try {
        const spec = await api.call("spec:read", file);
        state.specSummary = spec.summary;
        optIns = spec.optIns ?? {};
        optInsPath = file;
      } catch {
        // cairn run is the authority; an unreadable spec is its to report
      }
    }
    const verdict = policyVerdict(state.specSummary);
    if (verdict.refused) {
      const proceed = await Studio.confirm({
        title: `cairn would refuse this spec on "${verdict.env}"`,
        body: `${verdict.summary}.\n\nRun anyway? The CLI decides: a refused run ends with status refused (exit 7) before any service, precondition or browser starts.`,
        confirmLabel: "Run anyway",
      });
      if (!proceed) return;
    }
    if (runEnv) overrides = { ...overrides, env: runEnv };
    if (state.specDirty) {
      const proceed = await Studio.confirm({
        title: "Run with unsaved changes?",
        body: "The editor has unsaved edits. Cairn will run the file on disk, not what you see.",
        confirmLabel: "Run file on disk",
      });
      if (!proceed) return;
    }
    try {
      await actions.startRun([file], overrides);
      Studio.navigate("live");
    } catch (error) {
      toast("Run failed to start", String(error?.message ?? error), "bad");
    }
  }

  /**
   * @param {string} file
   * @param {HTMLElement | null} findingsHost
   * @param {HTMLTextAreaElement} editor
   */
  async function stamp(file, findingsHost, editor) {
    const proceed = await Studio.confirm({
      title: "Stamp contract hash?",
      body: "This writes a fresh contractHash over the current intent + outcomes. Only do this after surfacing the contract diff to whoever owns the spec.",
      confirmLabel: "Stamp",
      danger: true,
    });
    if (!proceed) return;
    try {
      const result = await api.call("spec:verify", { spec: file, stamp: true });
      state.specFindings = { ...result, path: file };
      if (findingsHost) {
        Studio.clear(findingsHost);
        findingsHost.appendChild(renderFindings(state.specFindings));
      }
      const reloaded = await api.call("spec:read", file);
      editor.value = reloaded.text;
      state.specText = reloaded.text;
      state.specSummary = reloaded.summary;
      optIns = reloaded.optIns ?? {};
      optInsPath = file;
      state.specDirty = false;
      editor.classList.remove("dirty");
      toast(
        result.ok ? "contractHash stamped" : `Stamp failed: ${result.meaning}`,
        null,
        result.ok ? "ok" : "bad",
      );
    } catch (error) {
      toast("Stamp failed", String(error?.message ?? error), "bad");
    }
  }

  /** @param {string} file */
  async function healDialog(file) {
    const backend = state.settings?.run?.backend ?? "";
    const apply = await Studio.confirm({
      title: "Heal this spec?",
      body: `cairn spec heal re-runs ${file.split("/").pop()} and proposes selector-drift fixes from the live snapshot.\n\nOK = --apply (write the patch back). Cancel = dry run (show proposals only).`,
      confirmLabel: "Apply fixes",
    });
    const dryRun = !apply;
    try {
      toast(
        "Heal started",
        dryRun ? "dry run — proposals only" : "applying patched selectors",
        "info",
        2600,
      );
      const result = await api.call("spec:heal", {
        spec: file,
        backend: backend || null,
        apply: !dryRun,
        ...(runEnv ? { env: runEnv } : {}),
      });
      state.specFindings = null;
      const reloaded = await api.call("spec:read", file);
      state.specText = reloaded.text;
      state.specSummary = reloaded.summary;
      await loadSelected(document.getElementById("view"));
      showHealResult(result, dryRun);
    } catch (error) {
      toast("Heal failed", String(error?.message ?? error), "bad");
    }
  }

  /**
   * @param {any} result
   * @param {boolean} dryRun
   */
  function showHealResult(result, dryRun) {
    const payload = result?.payload ?? {};
    const patches = payload.patches ?? payload.proposals ?? [];
    const host = document.getElementById("spec-findings");
    if (!host) return;
    Studio.clear(host);
    host.appendChild(
      Studio.panel(
        `cairn spec heal · ${
          dryRun ? "dry run" : "applied"
        } · exit ${result?.exitCode} (${result?.meaning})`,
        [
          Array.isArray(patches) && patches.length
            ? h(
                "div",
                { class: "findings" },
                patches.map((patch) =>
                  h(
                    "div",
                    { class: "finding warn" },
                    h("span", {
                      class: "mono",
                      style: { fontSize: "11px" },
                      text: patch.stepId ?? patch.step ?? "step",
                    }),
                    h("span", {
                      text: fmt.truncate(
                        patch.reason ?? patch.message ?? JSON.stringify(patch),
                        240,
                      ),
                    }),
                  ),
                ),
              )
            : h("p", {
                class: "cell-dim",
                text: payload.status
                  ? `status: ${payload.status}`
                  : "no patches proposed",
              }),
          h(
            "details",
            { style: { marginTop: "8px" } },
            h("summary", { class: "cell-dim", text: "raw heal payload" }),
            h("div", { class: "tree" }, Studio.jsonTree(payload)),
          ),
          result?.stderr
            ? h("pre", {
                class: "code tight",
                style: { marginTop: "8px" },
                text: fmt.truncate(result.stderr, 4000),
              })
            : null,
        ],
      ),
    );
  }

  /** @param {HTMLElement} root */
  async function scaffoldDialog(root) {
    const nameInput = Studio.input({
      placeholder: "checkout_happy_path",
      style: { width: "100%" },
    });
    const intentInput = Studio.input({
      placeholder: "one-line intent for the spec",
      style: { width: "100%" },
    });
    const outInput = Studio.input({ value: "flows", style: { width: "100%" } });
    const dialog =
      /** @type {HTMLDialogElement} */ (document.getElementById("modal"));
    dialog.textContent = "";
    dialog.appendChild(
      h(
        "div",
        { class: "modal-body" },
        h("h3", { text: "Scaffold a new spec" }),
        h("p", {
          class: "cell-dim",
          style: { marginTop: "0" },
          text: "Runs `cairn spec scaffold <name> --out <dir>` inside the open project.",
        }),
        h("label", { class: "field" }, "name", nameInput),
        h(
          "label",
          { class: "field", style: { marginTop: "8px" } },
          "intent",
          intentInput,
        ),
        h(
          "label",
          { class: "field", style: { marginTop: "8px" } },
          "output directory (relative to project)",
          outInput,
        ),
      ),
    );
    dialog.appendChild(
      h(
        "div",
        { class: "modal-actions" },
        h("button", {
          class: "btn",
          type: "button",
          text: "Cancel",
          onClick: () => dialog.close(),
        }),
        h("button", {
          class: "btn btn-primary",
          type: "button",
          text: "Scaffold",
          onClick: async () => {
            const name = nameInput.value.trim();
            if (!name) {
              toast("Name required", "Give the spec a name.", "bad");
              return;
            }
            dialog.close();
            try {
              const result = await api.call("spec:scaffold", {
                name,
                intent: intentInput.value.trim() || null,
                out: outInput.value.trim() || "flows",
              });
              toast("Spec scaffolded", result.path, "ok");
              await render(root, { file: result.path });
            } catch (error) {
              toast("Scaffold failed", String(error?.message ?? error), "bad");
            }
          },
        }),
      ),
    );
    dialog.showModal();
  }

  /** @param {HTMLElement} root */
  async function addSpecFile(root) {
    try {
      const files = await api.call("dialog:open-spec");
      if (!files?.length) return;
      state.selectedSpec = files[0];
      await render(root, { file: files[0] });
    } catch (error) {
      toast("Could not open spec", String(error?.message ?? error), "bad");
    }
  }

  Studio.views = Studio.views || {};
  Studio.views.specs = { id: "specs", label: "Specs", glyph: "≡", render };
  /**
   * ⌘R (menu "Run Focused Spec"): the Run button's path for the focused
   * spec — the "run on" environment, the policy warning, the unsaved-edits
   * question — from any view.
   */
  Studio.specsView = {
    runFocused: () =>
      state.selectedSpec
        ? runSpec(state.selectedSpec, false)
        : Promise.resolve(),
  };
})();
