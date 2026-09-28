/**
 * Shared view components.
 *
 * Small building blocks the views compose: page chrome, panels, status tags,
 * the artifact viewer (text / JSON / NDJSON / image), and a few formatters
 * bound to the shared `CairnFormat` helpers.
 */
(function bootComponents() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h, api, fmt, toast } = Studio;

  /**
   * @param {string} title
   * @param {string | null} subtitle
   * @param {Array<Node | null>} [actions]
   */
  function pageHeader(title, subtitle, actions = []) {
    return h(
      "div",
      { class: "detail-head" },
      h(
        "div",
        { class: "title-block" },
        h("h1", { class: "view-title", text: title }),
        subtitle ? h("div", { class: "sub", text: subtitle }) : null,
      ),
      actions.filter(Boolean).length
        ? h("div", { class: "detail-actions" }, actions.filter(Boolean))
        : null,
    );
  }

  /**
   * @param {string} title
   * @param {Node | Node[] | string} body
   * @param {{ actions?: Array<Node | null>, tight?: boolean, className?: string }} [options]
   */
  function panel(title, body, options = {}) {
    return h(
      "section",
      { class: `panel ${options.className ?? ""}`.trim() },
      title || options.actions?.length
        ? h(
            "div",
            { class: "panel-head" },
            h("span", { class: "panel-title", text: title }),
            h(
              "div",
              { style: { marginLeft: "auto", display: "flex", gap: "6px" } },
              (options.actions ?? []).filter(Boolean),
            ),
          )
        : null,
      h(
        "div",
        { class: `panel-body${options.tight ? " tight" : ""}` },
        Array.isArray(body) ? body : [body],
      ),
    );
  }

  /**
   * @param {string | null | undefined} status
   */
  function statusTag(status) {
    const tone = fmt.statusTone(status);
    return h(
      "span",
      {
        class: `tag tag-${tone === "muted" ? "muted" : tone}`.replace(
          "tag-muted",
          "tag",
        ),
      },
      h("span", { class: `dot dot-${tone}` }),
      String(status ?? "unknown"),
    );
  }

  /**
   * @param {string} text
   * @param {{ tight?: boolean, className?: string }} [options]
   */
  function codeBlock(text, options = {}) {
    return h("pre", {
      class: `code${
        options.tight ? " tight" : ""
      } ${options.className ?? ""}`.trim(),
      text: String(text ?? ""),
    });
  }

  /**
   * Render any artifact from a run directory, choosing the viewer by extension.
   * @param {string} runDir
   * @param {string} relativePath
   * @param {{ maxBytes?: number }} [options]
   * @returns {Promise<Node>}
   */
  async function artifactViewer(runDir, relativePath, options = {}) {
    const ext = relativePath.split(".").pop()?.toLowerCase() ?? "";
    if (["png", "jpg", "jpeg", "gif", "webp"].includes(ext)) {
      const image = await api.call("run:artifact-image", {
        runDir,
        path: relativePath,
      });
      if (!image?.ok)
        return Studio.errorBox(
          new Error(image?.error ?? "unreadable image"),
          relativePath,
        );
      return h(
        "figure",
        { class: "shot", style: { maxWidth: "100%", margin: "0" } },
        h("img", { src: image.dataUrl, alt: relativePath }),
        h(
          "figcaption",
          relativePath,
          h("span", {
            style: { marginLeft: "auto" },
            text: fmt.formatBytes(image.bytes),
          }),
        ),
      );
    }

    const result = await api.call("run:artifact-text", {
      runDir,
      path: relativePath,
      maxBytes: options.maxBytes,
    });
    if (!result?.ok)
      return Studio.errorBox(
        new Error(result?.error ?? "unreadable artifact"),
        relativePath,
      );

    const header = h(
      "div",
      { class: "toolbar", style: { marginBottom: "8px" } },
      h("span", {
        class: "mono",
        style: { fontSize: "11px", color: "var(--text-dim)" },
        text: relativePath,
      }),
      h("span", { class: "cell-dim", text: fmt.formatBytes(result.bytes) }),
      result.truncated ? Studio.tag("truncated", "warn") : null,
      h("div", { class: "spacer" }),
      copyButton(() => result.text ?? ""),
      revealButton(runDir, relativePath),
    );

    if (ext === "json") {
      try {
        return h(
          "div",
          header,
          h("div", { class: "tree" }, Studio.jsonTree(JSON.parse(result.text))),
        );
      } catch {
        // fall through to the raw text view
      }
    }
    if (ext === "ndjson") return h("div", header, ndjsonView(result.text));
    if (ext === "md")
      return h("div", header, Studio.markdown.render(result.text));
    return h("div", header, codeBlock(result.text));
  }

  /**
   * @param {string} text
   */
  function ndjsonView(text) {
    const lines = String(text ?? "")
      .split("\n")
      .filter((line) => line.trim());
    const capped = lines.slice(-2000);
    return h(
      "div",
      { class: "log-pane", style: { maxHeight: "56vh" } },
      capped.map((line) => {
        let level = "info";
        let label = line;
        try {
          const parsed = JSON.parse(line);
          level = String(parsed.level ?? parsed.type ?? "info");
          label = formatNdjsonEntry(parsed);
        } catch {
          // keep the raw line
        }
        return h(
          "div",
          { class: `log-line level-${level.toLowerCase()}` },
          h("span", { class: "lvl", text: level.slice(0, 6) }),
          label,
        );
      }),
      lines.length > capped.length
        ? h("div", {
            class: "log-line",
            style: { color: "var(--text-faint)" },
            text: `… ${lines.length - capped.length} earlier lines hidden`,
          })
        : null,
    );
  }

  /**
   * @param {Record<string, any>} entry
   */
  function formatNdjsonEntry(entry) {
    const stamp = entry.ts ?? entry.timestamp ?? "";
    const scope = entry.scope ? `${entry.scope} › ` : "";
    const message = entry.msg ?? entry.message ?? JSON.stringify(entry);
    const time = stamp ? `${String(stamp).slice(11, 23)} ` : "";
    return `${time}${scope}${fmt.oneLine(String(message))}`;
  }

  /**
   * @param {() => string} getText
   */
  function copyButton(getText) {
    return h("button", {
      class: "btn btn-sm btn-ghost",
      type: "button",
      text: "Copy",
      onClick: async () => {
        try {
          await navigator.clipboard.writeText(getText());
          toast("Copied to clipboard", null, "ok", 1800);
        } catch (error) {
          toast("Copy failed", String(error?.message ?? error), "bad");
        }
      },
    });
  }

  /**
   * @param {string} runDir
   * @param {string} [relativePath]
   */
  function revealButton(runDir, relativePath) {
    return h("button", {
      class: "btn btn-sm btn-ghost",
      type: "button",
      text: "Reveal",
      title: "Show in Finder",
      onClick: () =>
        api
          .call("run:reveal", runDir, relativePath ?? null)
          .catch((error) =>
            toast("Reveal failed", String(error?.message ?? error), "bad"),
          ),
    });
  }

  /**
   * A labeled checkbox bound to a settings path.
   * @param {string} label
   * @param {boolean} checked
   * @param {(checked: boolean) => void} onChange
   * @param {string} [title]
   */
  function checkbox(label, checked, onChange, title) {
    return h(
      "label",
      { class: "check", title: title ?? null },
      h("input", {
        type: "checkbox",
        checked: Boolean(checked),
        onChange: (event) =>
          onChange(/** @type {HTMLInputElement} */ (event.target).checked),
      }),
      label,
    );
  }

  Object.assign(Studio, {
    pageHeader,
    panel,
    statusTag,
    codeBlock,
    artifactViewer,
    ndjsonView,
    copyButton,
    revealButton,
    checkbox,
  });
})();
