/**
 * Minimal Markdown → DOM renderer.
 *
 * Cairn evidence files (`outcomes/<id>.md`), `agent_context.md`, and
 * `cairn docs` sections are Markdown. Rendering them as DOM nodes (never as
 * HTML strings) keeps the UI free of injection risk while still giving the
 * operator readable evidence instead of a wall of raw text.
 *
 * Supported: ATX headings, fenced code, unordered/ordered lists, tables,
 * blockquotes, horizontal rules, paragraphs, and inline code / bold / italic /
 * links. Anything unrecognised is emitted as literal text.
 */
(function bootMarkdown() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  const { h } = Studio;

  const LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

  /**
   * @param {string} text
   * @returns {Array<Node>}
   */
  function inline(text) {
    const nodes = [];
    const pattern =
      /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*\n]+\*)|(\[[^\]]+\]\([^)\s]+\))|(https?:\/\/[^\s)<]+)/g;
    let cursor = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      if (match.index > cursor)
        nodes.push(document.createTextNode(text.slice(cursor, match.index)));
      const token = match[0];
      if (token.startsWith("`")) {
        nodes.push(h("code", { text: token.slice(1, -1) }));
      } else if (token.startsWith("**")) {
        nodes.push(h("strong", { text: token.slice(2, -2) }));
      } else if (token.startsWith("*")) {
        nodes.push(h("em", { text: token.slice(1, -1) }));
      } else if (token.startsWith("[")) {
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(token);
        const href = link?.[2] ?? "";
        if (isSafeHref(href))
          nodes.push(
            h("a", {
              href,
              text: link?.[1] ?? href,
              onClick: (event) => openExternal(event, href),
            }),
          );
        else nodes.push(document.createTextNode(token));
      } else {
        nodes.push(
          h("a", {
            href: token,
            text: token,
            onClick: (event) => openExternal(event, token),
          }),
        );
      }
      cursor = match.index + token.length;
    }
    if (cursor < text.length)
      nodes.push(document.createTextNode(text.slice(cursor)));
    return nodes;
  }

  /**
   * @param {string} href
   * @returns {boolean}
   */
  function isSafeHref(href) {
    try {
      return LINK_PROTOCOLS.has(
        new URL(href, "https://example.invalid").protocol,
      );
    } catch {
      return false;
    }
  }

  /**
   * Links go to the system browser; the renderer never navigates.
   * @param {Event} event
   * @param {string} href
   */
  function openExternal(event, href) {
    event.preventDefault();
    Studio.api
      ?.call("shell:open-external", href)
      .catch((error) =>
        Studio.toast?.(
          "Could not open link",
          String(error?.message ?? error),
          "bad",
        ),
      );
  }

  /**
   * @param {string} line
   * @returns {string[]}
   */
  function splitRow(line) {
    return line
      .replace(/^\s*\|/, "")
      .replace(/\|\s*$/, "")
      .split("|")
      .map((cell) => cell.trim());
  }

  /**
   * @param {string[]} lines
   * @param {number} start
   * @returns {{ cells: string[][], next: number, align: string[] }}
   */
  function readTable(lines, start) {
    const header = splitRow(lines[start]);
    const alignLine = lines[start + 1] ?? "";
    const align = /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(alignLine)
      ? splitRow(alignLine).map((cell) => {
          if (cell.startsWith(":") && cell.endsWith(":")) return "center";
          if (cell.endsWith(":")) return "right";
          return "left";
        })
      : [];
    const cells = [header];
    let index = align.length ? start + 2 : start + 1;
    while (
      index < lines.length &&
      /\|/.test(lines[index]) &&
      lines[index].trim()
    ) {
      cells.push(splitRow(lines[index]));
      index += 1;
    }
    return { cells, next: index, align };
  }

  /**
   * @param {string} source
   * @returns {HTMLElement}
   */
  function render(source) {
    const root = h("div", { class: "md" });
    const lines = String(source ?? "")
      .replace(/\r\n/g, "\n")
      .split("\n");
    let index = 0;
    let paragraph = [];

    const flushParagraph = () => {
      if (!paragraph.length) return;
      root.appendChild(h("p", inline(paragraph.join(" "))));
      paragraph = [];
    };

    while (index < lines.length) {
      const line = lines[index];
      const trimmed = line.trim();

      if (!trimmed) {
        flushParagraph();
        index += 1;
        continue;
      }

      const fence = /^```(\w*)/.exec(trimmed);
      if (fence) {
        flushParagraph();
        const body = [];
        index += 1;
        while (index < lines.length && !lines[index].trim().startsWith("```")) {
          body.push(lines[index]);
          index += 1;
        }
        index += 1;
        root.appendChild(
          h(
            "pre",
            h("code", {
              class: fence[1] ? `lang-${fence[1]}` : "",
              text: body.join("\n"),
            }),
          ),
        );
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(trimmed);
      if (heading) {
        flushParagraph();
        const level = Math.min(heading[1].length, 4);
        root.appendChild(h(`h${level}`, inline(heading[2])));
        index += 1;
        continue;
      }

      if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
        flushParagraph();
        root.appendChild(h("hr"));
        index += 1;
        continue;
      }

      if (trimmed.startsWith(">")) {
        flushParagraph();
        const quoted = [];
        while (index < lines.length && lines[index].trim().startsWith(">")) {
          quoted.push(lines[index].trim().replace(/^>\s?/, ""));
          index += 1;
        }
        root.appendChild(h("blockquote", inline(quoted.join(" "))));
        continue;
      }

      const bullet = /^([-*+]|\d+\.)\s+(.*)$/.exec(trimmed);
      if (bullet) {
        flushParagraph();
        const ordered = /\d+\./.test(bullet[1]);
        const list = h(ordered ? "ol" : "ul");
        while (index < lines.length) {
          const item = /^([-*+]|\d+\.)\s+(.*)$/.exec(lines[index].trim());
          if (!item) break;
          list.appendChild(h("li", inline(item[2])));
          index += 1;
        }
        root.appendChild(list);
        continue;
      }

      if (
        /\|/.test(trimmed) &&
        index + 1 < lines.length &&
        /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(lines[index + 1])
      ) {
        flushParagraph();
        const table = readTable(lines, index);
        index = table.next;
        const element = h("table");
        const head = h("thead");
        const headRow = h("tr");
        (table.cells[0] ?? []).forEach((cell, cellIndex) =>
          headRow.appendChild(
            h(
              "th",
              { style: { textAlign: table.align[cellIndex] ?? "left" } },
              inline(cell),
            ),
          ),
        );
        head.appendChild(headRow);
        element.appendChild(head);
        const body = h("tbody");
        for (const row of table.cells.slice(1)) {
          const rowElement = h("tr");
          row.forEach((cell, cellIndex) =>
            rowElement.appendChild(
              h(
                "td",
                { style: { textAlign: table.align[cellIndex] ?? "left" } },
                inline(cell),
              ),
            ),
          );
          body.appendChild(rowElement);
        }
        element.appendChild(body);
        root.appendChild(element);
        continue;
      }

      paragraph.push(trimmed);
      index += 1;
    }

    flushParagraph();
    return root;
  }

  Studio.markdown = { render, inline };
})();
