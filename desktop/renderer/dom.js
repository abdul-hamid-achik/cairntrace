/**
 * Tiny DOM builder shared by every view.
 *
 * No framework and no `innerHTML` anywhere in the renderer: everything is
 * built from `document.createElement` + `createTextNode`, so a spec name,
 * an artifact path, or a log line can never inject markup into the UI.
 */
(function bootDom() {
  const Studio = (globalThis.Studio = globalThis.Studio || {});
  Studio.fmt = globalThis.CairnFormat;

  const BOOLEAN_PROPS = new Set([
    "disabled",
    "checked",
    "selected",
    "readOnly",
    "open",
    "hidden",
    "multiple",
  ]);

  /**
   * A props bag is a plain object. Nodes, arrays, and primitives in the props
   * slot are children — silently dropping them made whole panels render empty,
   * so `h` accepts both shapes.
   * @param {any} value
   * @returns {boolean}
   */
  function isProps(value) {
    if (value === null || typeof value !== "object") return false;
    if (Array.isArray(value)) return false;
    if (typeof Node !== "undefined" && value instanceof Node) return false;
    return true;
  }

  /**
   * @param {string} tag
   * @param {Record<string, any> | Node | any[] | string | null | undefined} [props]
   * @param {...any} children nodes, strings, arrays, null/undefined, or false
   * @returns {HTMLElement}
   */
  function h(tagName, props, ...children) {
    const element = document.createElement(tagName);
    if (isProps(props)) {
      applyProps(element, /** @type {Record<string, any>} */ (props));
      append(element, children);
    } else {
      append(element, [props, ...children]);
    }
    return element;
  }

  /**
   * @param {HTMLElement} element
   * @param {Record<string, any>} props
   */
  function applyProps(element, props) {
    for (const [key, value] of Object.entries(props)) {
      if (value === undefined || value === null || value === false) continue;
      if (key === "class" || key === "className") {
        element.className = String(value);
        continue;
      }
      if (key === "text") {
        element.textContent = String(value);
        continue;
      }
      if (key === "style" && typeof value === "object") {
        Object.assign(element.style, value);
        continue;
      }
      if (key === "dataset" && typeof value === "object") {
        for (const [dataKey, dataValue] of Object.entries(value))
          element.dataset[dataKey] = String(dataValue);
        continue;
      }
      if (key.startsWith("on") && typeof value === "function") {
        element.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }
      if (key === "value") {
        /** @type {any} */ (element).value = value;
        continue;
      }
      if (BOOLEAN_PROPS.has(key)) {
        /** @type {any} */ (element)[key] = Boolean(value);
        continue;
      }
      if (key.startsWith("aria") || key === "role" || key === "tabindex") {
        element.setAttribute(
          key === "tabindex"
            ? "tabindex"
            : key.replace(/^aria([A-Z])/, "aria-$1").toLowerCase(),
          String(value),
        );
        continue;
      }
      element.setAttribute(key, String(value));
    }
  }

  /**
   * @param {HTMLElement} element
   * @param {any[]} children
   */
  function append(element, children) {
    for (const child of children) {
      if (
        child === null ||
        child === undefined ||
        child === false ||
        child === true
      )
        continue;
      if (Array.isArray(child)) {
        append(element, child);
        continue;
      }
      element.appendChild(
        child instanceof Node ? child : document.createTextNode(String(child)),
      );
    }
  }

  /**
   * Remove every child and return the node, for cheap re-renders.
   * @param {HTMLElement} node
   * @returns {HTMLElement}
   */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  /**
   * @param {...any} children
   * @returns {DocumentFragment}
   */
  function frag(...children) {
    const fragment = document.createDocumentFragment();
    const holder = { appendChild: (node) => fragment.appendChild(node) };
    append(/** @type {any} */ (holder), children);
    return fragment;
  }

  /**
   * @param {string} className
   * @param {string} [tone]
   * @returns {HTMLElement}
   */
  function dot(className = "", tone) {
    return h("span", {
      class: ["dot", tone ? `dot-${tone}` : "", className]
        .filter(Boolean)
        .join(" "),
    });
  }

  /**
   * @param {string} label
   * @param {string} [tone] ok | bad | warn | info | muted
   * @returns {HTMLElement}
   */
  function tag(label, tone) {
    return h("span", {
      class: `tag${tone && tone !== "muted" ? ` tag-${tone}` : ""}`,
      text: label,
    });
  }

  /**
   * @param {string} label
   * @param {Record<string, any>} [props]
   * @returns {HTMLButtonElement}
   */
  function button(label, props = {}) {
    return /** @type {HTMLButtonElement} */ (
      h("button", { type: "button", class: "btn", ...props }, label)
    );
  }

  /**
   * @param {Record<string, any>} props
   * @returns {HTMLInputElement}
   */
  function input(props = {}) {
    return /** @type {HTMLInputElement} */ (
      h("input", { type: "text", ...props })
    );
  }

  /**
   * @param {string[]} options
   * @param {Record<string, any>} [props]
   * @returns {HTMLSelectElement}
   */
  function select(options, props = {}) {
    const element = /** @type {HTMLSelectElement} */ (h("select", props));
    for (const option of options) {
      const [value, label] = Array.isArray(option) ? option : [option, option];
      element.appendChild(
        h("option", { value: String(value), text: String(label ?? value) }),
      );
    }
    if (props.value !== undefined) element.value = String(props.value ?? "");
    return element;
  }

  /**
   * Definition-list key/value block.
   * @param {Array<[string, any]>} rows
   * @returns {HTMLElement}
   */
  function keyValue(rows) {
    const list = h("dl", { class: "kv" });
    for (const [key, value] of rows) {
      list.appendChild(h("dt", { text: key }));
      list.appendChild(
        value instanceof Node
          ? h("dd", value)
          : h("dd", { text: String(value ?? "—") }),
      );
    }
    return list;
  }

  /**
   * @param {string} [message]
   * @returns {HTMLElement}
   */
  function loading(message = "working…") {
    return h(
      "div",
      { class: "loading" },
      h("span", { class: "spinner" }),
      message,
    );
  }

  /**
   * @param {string} title
   * @param {string} [body]
   * @param {Array<HTMLElement>} [actions]
   * @returns {HTMLElement}
   */
  function empty(title, body, actions = []) {
    return h(
      "div",
      { class: "empty" },
      h("h3", { text: title }),
      body ? h("p", { text: body }) : null,
      actions.length
        ? h(
            "div",
            { class: "toolbar", style: { justifyContent: "center" } },
            actions,
          )
        : null,
    );
  }

  /**
   * @param {unknown} error
   * @param {string} [context]
   * @returns {HTMLElement}
   */
  function errorBox(error, context) {
    const message =
      error instanceof Error
        ? error.message
        : String(error?.message ?? error ?? "unknown error");
    const stack = error instanceof Error && error.stack ? error.stack : null;
    return h(
      "div",
      { class: "error-box" },
      h("strong", { text: context ? `${context}: ${message}` : message }),
      stack
        ? h("pre", { text: stack.split("\n").slice(0, 5).join("\n") })
        : null,
    );
  }

  /**
   * Collapsible JSON tree — used for CLI payloads we don't have a bespoke
   * view for (`cairn diff`, `cairn spec heal`, raw outcome sidecars).
   * @param {unknown} value
   * @param {number} [depth]
   * @returns {HTMLElement}
   */
  function jsonTree(value, depth = 0) {
    if (value === null) return h("span", { class: "tree-null", text: "null" });
    const type = typeof value;
    if (type === "string")
      return h("span", { class: "tree-str", text: JSON.stringify(value) });
    if (type === "number")
      return h("span", { class: "tree-num", text: String(value) });
    if (type === "boolean")
      return h("span", { class: "tree-bool", text: String(value) });
    if (type !== "object") return h("span", { text: String(value) });

    const entries = Array.isArray(value)
      ? value.map((item, index) => [String(index), item])
      : Object.entries(/** @type {Record<string, unknown>} */ (value));
    const collapsed = depth > 1;
    const children = h("div", {
      class: `tree-children${collapsed ? " collapsed" : ""}`,
    });
    const toggle = h("span", {
      class: "tree-toggle",
      text: collapsed ? "▸" : "▾",
    });
    toggle.addEventListener("click", () => {
      const isCollapsed = children.classList.toggle("collapsed");
      toggle.textContent = isCollapsed ? "▸" : "▾";
    });
    for (const [key, item] of entries) {
      children.appendChild(
        h(
          "div",
          { class: "tree-row" },
          h("span", { class: "tree-key", text: `${key}: ` }),
          jsonTree(item, depth + 1),
        ),
      );
    }
    const summary = Array.isArray(value)
      ? `[${value.length}]`
      : `{${entries.length}}`;
    return h(
      "span",
      { class: "tree-node" },
      toggle,
      h("span", { class: "tree-null", text: collapsed ? summary : "" }),
      children,
    );
  }

  Object.assign(Studio, {
    h,
    isProps,
    clear,
    frag,
    dot,
    tag,
    button,
    input,
    select,
    keyValue,
    loading,
    empty,
    errorBox,
    jsonTree,
  });
})();
