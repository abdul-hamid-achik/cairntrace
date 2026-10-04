/* oxlint-disable unicorn/consistent-function-scoping, eslint/no-underscore-dangle, unicorn/no-array-sort -- the runtime ships to the page as ONE self-contained function, so every helper lives inside it */
// Cairntrace widget runtime (F15). Runs IN THE PAGE: the host sends this
// function's source through `backend.evaluate` (agent-browser `eval`,
// Playwright `page.evaluate`) and exported Playwright tests embed the same
// text. It must stay a single self-contained function expression: no
// imports, no closures over module scope, no template-literal interpolation
// of host data (input arrives as a JSON literal).
//
// `lib` comes from the shared locator resolver (domProbe.ts
// LOCATOR_RESOLVER_JS); `customDrivers` holds the project's driver modules
// (config `browser.widgets[].file`), already evaluated in the page.
//
// oxlint-disable-next-line no-unused-vars
async function cairnWidgetRuntime(request, customDrivers, lib) {
  "use strict";
  const started = Date.now();
  const { resolveLocator, isVisible, norm, lower, textOf } = lib;
  const notes = [];
  const budgetMs = Math.max(1, Number(request.timeoutMs) || 10000);
  const deadline = started + budgetMs;
  const remaining = () => Math.max(0, deadline - Date.now());
  const sleep = (ms) =>
    new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
  const config = request.config || {};
  const testIdAttribute = config.testIdAttribute || "data-testid";

  /** Poll `fn` until it returns a truthy value or `ms` (capped by the op deadline) runs out. */
  const waitFor = async (fn, ms, every) => {
    const budget =
      ms === undefined || ms === null ? remaining() : Math.min(ms, remaining());
    const until = Date.now() + Math.max(0, budget);
    for (;;) {
      let value;
      try {
        value = await fn();
      } catch {
        value = undefined;
      }
      if (value) return value;
      if (Date.now() >= until) return value;
      await sleep(Math.min(every || 50, Math.max(0, until - Date.now())));
    }
  };

  /* ----- DOM helpers (also handed to custom drivers through ctx) ----- */

  const describeEl = (el) => {
    if (!el || !el.tagName) return String(el);
    let out = el.tagName.toLowerCase();
    if (el.id) out += "#" + el.id;
    const classes = String(el.getAttribute("class") || "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 3);
    if (classes.length) out += "." + classes.join(".");
    for (const attr of [testIdAttribute, "name", "role", "aria-label"]) {
      const value = el.getAttribute(attr);
      if (value) {
        out += "[" + attr + '="' + value.slice(0, 60) + '"]';
        break;
      }
    }
    return out;
  };
  const centerOf = (el) => {
    const rect = el.getBoundingClientRect();
    return {
      x: Math.round(rect.left + Math.max(rect.width / 2, 1)),
      y: Math.round(rect.top + Math.max(rect.height / 2, 1)),
    };
  };
  const KEY_CODES = {
    Enter: 13,
    Tab: 9,
    Escape: 27,
    ArrowDown: 40,
    ArrowUp: 38,
    Backspace: 8,
    " ": 32,
  };
  const fire = (el, type, init) => {
    const opts = Object.assign(
      { bubbles: true, cancelable: true, composed: true },
      init || {},
    );
    let event;
    if (type.startsWith("pointer")) {
      const c = centerOf(el);
      event = new PointerEvent(
        type,
        Object.assign(
          {
            view: window,
            clientX: c.x,
            clientY: c.y,
            pointerId: 1,
            pointerType: "mouse",
            isPrimary: true,
          },
          opts,
        ),
      );
    } else if (/^(mouse|click|dblclick|contextmenu)/.test(type)) {
      const c = centerOf(el);
      event = new MouseEvent(
        type,
        Object.assign(
          { view: window, clientX: c.x, clientY: c.y, detail: 1 },
          opts,
        ),
      );
    } else if (type.startsWith("key")) {
      const key = opts.key || "Enter";
      const code =
        opts.code || (key.length === 1 ? "Key" + key.toUpperCase() : key);
      const keyCode =
        opts.keyCode ||
        KEY_CODES[key] ||
        (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0);
      event = new KeyboardEvent(
        type,
        Object.assign(
          {
            view: window,
            key,
            code,
            keyCode,
            which: keyCode,
            charCode: type === "keypress" ? keyCode : 0,
          },
          opts,
        ),
      );
    } else if (type === "input" || type === "beforeinput") {
      event = new InputEvent(
        type,
        Object.assign({ inputType: "insertText" }, opts),
      );
    } else if (type.startsWith("focus") || type === "blur") {
      event = new FocusEvent(type, Object.assign({ view: window }, opts));
    } else {
      event = new Event(type, opts);
    }
    el.dispatchEvent(event);
    return event;
  };
  /** The full pointer sequence a real click produces (Vue / PrimeVue listen on several of these). */
  const pointer = (el) => {
    el.scrollIntoView({ block: "center", inline: "nearest" });
    fire(el, "pointerover");
    fire(el, "mouseover");
    fire(el, "pointerdown");
    fire(el, "mousedown");
    fire(el, "pointerup");
    fire(el, "mouseup");
    fire(el, "click");
  };
  const press = (el, key) => {
    fire(el, "keydown", { key });
    if (key === "Enter" || key.length === 1) fire(el, "keypress", { key });
    fire(el, "keyup", { key });
  };
  /** Native value setter: frameworks that wrap `value` (React, Vue) still see the change. */
  const nativeSet = (el, value) => {
    const proto =
      el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : el instanceof HTMLSelectElement
          ? HTMLSelectElement.prototype
          : HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
    if (descriptor && descriptor.set) descriptor.set.call(el, value);
    else el.value = value;
  };
  /** Set a text control's value and announce it the way typing would (input event). */
  const typeText = (el, text) => {
    if (typeof el.focus === "function") el.focus();
    nativeSet(el, text);
    fire(el, "input", { data: text });
  };
  const isControl = (el) =>
    !!el &&
    (/^(INPUT|TEXTAREA|SELECT|BUTTON|LI|SPAN)$/.test(el.tagName) ||
      /^(option|combobox|textbox|radio|checkbox|switch)$/.test(
        String(el.getAttribute("role") || ""),
      ));
  /** `sel` at the root, inside it, or (for an inner control the locator hit) around it. */
  const pickWithin = (root, sel) => {
    if (!root || !root.matches) return null;
    if (root.matches(sel)) return root;
    const inside =
      Array.from(root.querySelectorAll(sel)).find((el) => isVisible(el)) ||
      root.querySelector(sel);
    if (inside) return inside;
    return isControl(root) ? root.closest(sel) : null;
  };
  const labelOfOption = (el) => {
    const desc = el.querySelector && el.querySelector("[aria-label]");
    return norm(
      (desc && desc.getAttribute("aria-label")) ||
        el.getAttribute("aria-label") ||
        el.textContent ||
        "",
    );
  };
  /** Pick the item whose label matches: exact first, then one unique contains. */
  const matchOption = (items, wanted, labelFn) => {
    const want = lower(wanted);
    const labeled = items.map((el) => ({ el, label: norm(labelFn(el)) }));
    const exact = labeled.filter((o) => lower(o.label) === want);
    if (exact.length > 0) return { hit: exact[0], exact: true };
    const contains = labeled.filter(
      (o) => want && lower(o.label).includes(want),
    );
    if (contains.length === 1) return { hit: contains[0] };
    if (contains.length > 1) {
      const starts = contains.filter((o) => lower(o.label).startsWith(want));
      if (starts.length === 1) return { hit: starts[0] };
      return { ambiguous: contains.map((o) => o.label).slice(0, 10) };
    }
    return { none: true, options: labeled.map((o) => o.label).slice(0, 20) };
  };
  const optionError = (_field, wanted, picked) =>
    picked.ambiguous
      ? "option " +
        JSON.stringify(wanted) +
        " is ambiguous: " +
        JSON.stringify(picked.ambiguous)
      : "option " +
        JSON.stringify(wanted) +
        " not found; options: " +
        JSON.stringify(picked.options || []);
  const wantedParts = (item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? {
          query: String(item.query),
          want: String(item.option !== undefined ? item.option : item.query),
        }
      : { query: String(item), want: String(item) };

  /* ----- value comparison ----- */

  const MONTHS = [
    "january",
    "february",
    "march",
    "april",
    "may",
    "june",
    "july",
    "august",
    "september",
    "october",
    "november",
    "december",
  ];
  const localMonthNames = (() => {
    const names = [];
    try {
      const locale =
        document.documentElement.lang || navigator.language || "en";
      const long = new Intl.DateTimeFormat(locale, { month: "long" });
      const short = new Intl.DateTimeFormat(locale, { month: "short" });
      for (let m = 0; m < 12; m++) {
        const date = new Date(2000, m, 15);
        names.push([
          lower(long.format(date)),
          lower(short.format(date)).replace(/\.$/, ""),
        ]);
      }
    } catch {
      // English names below still apply.
    }
    return names;
  })();
  const monthIndex = (text) => {
    const t = lower(text).replace(/\.$/, "");
    if (!t) return -1;
    if (/^\d{1,2}$/.test(t)) return Number(t) - 1;
    for (let m = 0; m < 12; m++) {
      if (MONTHS[m] === t || MONTHS[m].slice(0, 3) === t) return m;
      const local = localMonthNames[m];
      if (local && (local[0] === t || local[1] === t)) return m;
    }
    return -1;
  };
  const todayParts = () => {
    const now = new Date();
    return { y: now.getFullYear(), m: now.getMonth() + 1, d: now.getDate() };
  };
  const isoParts = (text) => {
    const m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(String(text).trim());
    return m ? { y: Number(m[1]), m: Number(m[2]), d: Number(m[3]) } : null;
  };
  const pad2 = (n) => (n < 10 ? "0" + n : String(n));
  const dateMatches = (actual, expected) => {
    const exp = lower(expected) === "today" ? todayParts() : isoParts(expected);
    if (!exp) return lower(actual) === lower(expected);
    const text = norm(actual);
    if (!text) return false;
    if (isoParts(text)) {
      const got = isoParts(text);
      return got.y === exp.y && got.m === exp.m && got.d === exp.d;
    }
    let month = -1;
    for (const word of text.split(/[^A-Za-zÀ-ɏ]+/).filter(Boolean)) {
      const index = monthIndex(word);
      if (index >= 0) {
        month = index + 1;
        break;
      }
    }
    const numbers = (text.match(/\d+/g) || []).map(Number);
    const yearAt = numbers.findIndex(
      (n) => n === exp.y || (n < 100 && n === exp.y % 100),
    );
    if (yearAt < 0) return false;
    const rest = numbers.filter((_, i) => i !== yearAt);
    if (month > 0)
      return month === exp.m && rest.length === 1 && rest[0] === exp.d;
    if (rest.length !== 2) return false;
    const want = [exp.m, exp.d].sort((a, b) => a - b).join(",");
    return (
      rest
        .slice()
        .sort((a, b) => a - b)
        .join(",") === want
    );
  };
  const isEmptyValue = (v) =>
    v === undefined ||
    v === null ||
    v === "" ||
    (Array.isArray(v) && v.length === 0);
  const asList = (v) => (Array.isArray(v) ? v : isEmptyValue(v) ? [] : [v]);
  const expectedLabel = (expected) =>
    Array.isArray(expected)
      ? expected.map((item) => wantedParts(item).want)
      : expected !== null && typeof expected === "object"
        ? wantedParts(expected).want
        : expected;
  const sameValue = (driver, actual, expected, ctx) => {
    if (driver && typeof driver.equals === "function")
      return !!driver.equals(actual, expected, ctx);
    const want = expectedLabel(expected);
    if (typeof want === "boolean" || typeof actual === "boolean") {
      const toBool = (v) =>
        v === true || v === "true"
          ? true
          : v === false || v === "false"
            ? false
            : v;
      return toBool(actual) === toBool(want);
    }
    if (Array.isArray(want) || Array.isArray(actual)) {
      const a = asList(actual).map((v) => lower(v));
      const b = asList(want).map((v) => lower(v));
      return a.length === b.length && b.every((v) => a.includes(v));
    }
    if (isEmptyValue(actual) && isEmptyValue(want)) return true;
    return lower(actual) === lower(want);
  };

  /* ----- built-in drivers ----- */

  // vue-multiselect (2.x / 3.x markup): .multiselect > .multiselect__select (caret),
  // .multiselect__tags (> .multiselect__tags-wrap > .multiselect__tag, input.multiselect__input,
  // .multiselect__single | .multiselect__placeholder), .multiselect__content-wrapper >
  // ul.multiselect__content > li.multiselect__element > span.multiselect__option.
  const VMS = ".multiselect";
  const vmsTags = (ms) =>
    Array.from(ms.querySelectorAll(".multiselect__tags-wrap .multiselect__tag"))
      .filter((tag) => isVisible(tag))
      .map((tag) => norm((tag.querySelector("span") || tag).textContent));
  const vmsActive = (ms) => ms.classList.contains("multiselect--active");
  const vmsOptions = (ms) =>
    Array.from(
      ms.querySelectorAll("li.multiselect__element .multiselect__option"),
    ).filter(
      (el) =>
        !el.classList.contains("multiselect__option--disabled") &&
        !el.classList.contains("multiselect__option--group"),
    );
  const vmsOpen = async (ms) => {
    if (vmsActive(ms)) return true;
    ms.scrollIntoView({ block: "center", inline: "nearest" });
    const handle =
      ms.querySelector(".multiselect__select") ||
      ms.querySelector(".multiselect__placeholder") ||
      ms.querySelector(".multiselect__single") ||
      ms.querySelector(".multiselect__tags") ||
      ms;
    fire(handle, "mousedown");
    if (await waitFor(() => vmsActive(ms), 1000)) return true;
    // The component also activates on focus (root @focus / input @focus).
    const input = ms.querySelector("input.multiselect__input");
    const focusable = input || ms;
    if (typeof focusable.focus === "function") focusable.focus();
    fire(focusable, "focus", { bubbles: false });
    fire(focusable, "focusin");
    return !!(await waitFor(() => vmsActive(ms), 1000));
  };
  const vmsClose = async (ms) => {
    if (!vmsActive(ms)) return;
    const input = ms.querySelector("input.multiselect__input");
    if (input) {
      fire(input, "keyup", { key: "Escape" });
      if (typeof input.blur === "function") input.blur();
      fire(input, "blur", { bubbles: false });
    }
    if (await waitFor(() => !vmsActive(ms), 500)) return;
    fire(ms, "keyup", { key: "Escape" });
    if (typeof ms.blur === "function") ms.blur();
    fire(ms, "blur", { bubbles: false });
    await waitFor(() => !vmsActive(ms), 500);
  };
  const vueMultiselect = {
    name: "vue-multiselect",
    match: (root) => !!pickWithin(root, VMS),
    read(root) {
      const ms = pickWithin(root, VMS);
      if (!ms) return null;
      const tags = vmsTags(ms);
      if (tags.length > 0) return tags;
      const single = ms.querySelector(".multiselect__single");
      return single ? norm(single.textContent) : "";
    },
    async write(root, value, ctx) {
      const ms = pickWithin(root, VMS);
      const multiple = Array.isArray(value);
      const items = multiple ? value : [value];
      const picked = [];
      if (multiple) {
        const wants = items.map((item) => lower(wantedParts(item).want));
        for (const tag of Array.from(
          ms.querySelectorAll(".multiselect__tags-wrap .multiselect__tag"),
        )) {
          const label = lower((tag.querySelector("span") || tag).textContent);
          const icon = tag.querySelector(".multiselect__tag-icon");
          if (!wants.includes(label) && icon) {
            fire(icon, "mousedown");
            await sleep(60);
          }
        }
      }
      for (const item of items) {
        const { query, want } = wantedParts(item);
        if (multiple && vmsTags(ms).some((tag) => lower(tag) === lower(want))) {
          picked.push(want);
          continue;
        }
        if (!(await vmsOpen(ms)))
          throw new Error(
            "vue-multiselect did not open (.multiselect--active never appeared)",
          );
        // Remote lists load after activation.
        await waitFor(
          () => vmsOptions(ms).length > 0,
          Math.min(3000, remaining()),
        );
        let choice = matchOption(vmsOptions(ms), want, labelOfOption);
        const input = ms.querySelector("input.multiselect__input");
        if (!(choice.hit && choice.exact) && input) {
          // A contains hit on the unsearched list (often only the first page
          // of a remote list) is not trusted: search, then prefer an exact
          // match; a contains / ambiguous result counts once the list has
          // changed after typing and stayed put briefly.
          const signature = () =>
            vmsOptions(ms)
              .map((el) => labelOfOption(el))
              .join("\n");
          const initial = signature();
          let last = initial;
          let stableSince = Date.now();
          typeText(input, query);
          choice = await waitFor(
            () => {
              const now = signature();
              if (now !== last) {
                last = now;
                stableSince = Date.now();
              }
              const next = matchOption(vmsOptions(ms), want, labelOfOption);
              if (next.hit && next.exact) return next;
              if (
                (next.hit || next.ambiguous) &&
                now !== initial &&
                Date.now() - stableSince >= 300
              )
                return next;
              return undefined;
            },
            Math.min(4000, remaining()),
            100,
          );
          choice = choice || matchOption(vmsOptions(ms), want, labelOfOption);
          if (!choice.hit && query !== "") {
            typeText(input, "");
            await sleep(150);
            choice = matchOption(vmsOptions(ms), want, labelOfOption);
          }
        }
        if (!choice.hit) {
          const why = optionError("vue-multiselect", want, choice);
          await vmsClose(ms);
          throw new Error(why);
        }
        const option = choice.hit.el;
        option.scrollIntoView({ block: "nearest" });
        fire(option, "mouseenter", { bubbles: false });
        fire(option, "mousedown");
        fire(option, "mouseup");
        fire(option, "click");
        // An open single-select hides .multiselect__single; the option's --selected class
        // still shows the commit (never re-click a selected option: allowEmpty deselects).
        const committed = () =>
          multiple
            ? vmsTags(ms).some((tag) => lower(tag) === lower(choice.hit.label))
            : lower(vueMultiselect.read(ms)) === lower(choice.hit.label) ||
              vmsOptions(ms).some(
                (el) =>
                  el.classList.contains("multiselect__option--selected") &&
                  lower(labelOfOption(el)) === lower(choice.hit.label),
              );
        if (!(await waitFor(committed, Math.min(1500, remaining())))) {
          // The click did not reach select(): drive the component's own pointer + Enter.
          ctx.note("option click did not commit; retried with pointer + Enter");
          if (option.isConnected)
            fire(option, "mouseenter", { bubbles: false });
          const target = input || ms;
          fire(target, "keypress", { key: "Enter" });
          await waitFor(committed, Math.min(1500, remaining()));
        }
        picked.push(choice.hit.label);
      }
      await vmsClose(ms);
      return { label: multiple ? picked : picked[0] };
    },
  };

  // PrimeVue AutoComplete (v3 .p-autocomplete-panel / v4 .p-autocomplete-overlay); the
  // overlay is portaled to <body>, found through the input's aria-controls listbox id.
  const PAC = ".p-autocomplete, [data-pc-name='autocomplete']";
  const pacInput = (ac) =>
    ac.querySelector(
      "input.p-autocomplete-input, input[role='combobox'], input:not([type='hidden'])",
    );
  const pacMultiple = (ac) =>
    ac.classList.contains("p-autocomplete-multiple") ||
    !!ac.querySelector(
      ".p-autocomplete-multiple-container, .p-autocomplete-input-multiple, .p-autocomplete-chip-item, .p-autocomplete-token",
    );
  const pacChips = (ac) =>
    Array.from(
      ac.querySelectorAll(
        ".p-autocomplete-token-label, .p-autocomplete-chip-item .p-chip-label, .p-autocomplete-chip .p-chip-label",
      ),
    ).map((el) => norm(el.textContent));
  const pacOptions = (ac) => {
    const input = pacInput(ac);
    const id =
      input &&
      (input.getAttribute("aria-controls") || input.getAttribute("aria-owns"));
    const list = id ? document.getElementById(id) : null;
    const scopes = list
      ? [list]
      : Array.from(
          document.querySelectorAll(
            ".p-autocomplete-panel, .p-autocomplete-overlay",
          ),
        ).filter((el) => isVisible(el));
    const out = [];
    for (const scope of scopes) {
      for (const li of scope.querySelectorAll(
        "li[role='option'], li.p-autocomplete-item, li.p-autocomplete-option",
      )) {
        if (
          isVisible(li) &&
          !li.classList.contains("p-disabled") &&
          li.getAttribute("aria-disabled") !== "true"
        )
          out.push(li);
      }
    }
    return out;
  };
  /** The suggestion list is showing (typing in progress, nothing selected yet). */
  const pacOverlayOpen = (ac) => {
    const input = pacInput(ac);
    if (input && input.getAttribute("aria-expanded") === "true") return true;
    return pacOptions(ac).length > 0;
  };
  const primevueAutocomplete = {
    name: "primevue-autocomplete",
    match: (root) => !!pickWithin(root, PAC),
    read(root) {
      const ac = pickWithin(root, PAC);
      if (!ac) return null;
      if (pacMultiple(ac)) return pacChips(ac);
      const input = pacInput(ac);
      // While the suggestions show, the input holds typed text, not a
      // selection: it never reads as a committed value.
      if (!input || pacOverlayOpen(ac)) return "";
      return norm(input.value);
    },
    async write(root, value, ctx) {
      const ac = pickWithin(root, PAC);
      const input = pacInput(ac);
      if (!input) throw new Error("primevue-autocomplete has no input");
      const multiple = Array.isArray(value) || pacMultiple(ac);
      const items = Array.isArray(value) ? value : [value];
      const picked = [];
      for (const item of items) {
        const { query, want } = wantedParts(item);
        if (
          multiple &&
          pacChips(ac).some((chip) => lower(chip) === lower(want))
        ) {
          picked.push(want);
          continue;
        }
        input.scrollIntoView({ block: "center", inline: "nearest" });
        typeText(input, query);
        fire(input, "keyup", { key: query.slice(-1) || "a" });
        let choice = await waitFor(
          () => {
            const next = matchOption(pacOptions(ac), want, labelOfOption);
            return next.hit || next.ambiguous ? next : undefined;
          },
          Math.min(5000, remaining()),
          100,
        );
        choice = choice || matchOption(pacOptions(ac), want, labelOfOption);
        if (!choice.hit) {
          throw new Error(
            pacOptions(ac).length === 0
              ? "primevue-autocomplete showed no suggestions for " +
                  JSON.stringify(query)
              : optionError("primevue-autocomplete", want, choice),
          );
        }
        const hit = choice.hit.el;
        pointer(hit);
        const label = choice.hit.label;
        // The commit signal never comes from the typed text alone: a single
        // autocomplete must also close its suggestion list (a selection
        // hides it), and a multiple one must show a chip.
        const committed = () =>
          multiple
            ? pacChips(ac).some((chip) => lower(chip) === lower(label))
            : !pacOverlayOpen(ac) && lower(input.value) === lower(label);
        let ok = await waitFor(committed, Math.min(2000, remaining()));
        if (!ok && !multiple && pacOverlayOpen(ac) && hit.isConnected) {
          ctx.note("suggestion click did not close the list; clicked it again");
          hit.click();
          ok = await waitFor(committed, Math.min(1000, remaining()));
        }
        if (!ok && !multiple && pacOverlayOpen(ac)) {
          throw new Error(
            "the suggestion " +
              JSON.stringify(label) +
              " was clicked but not selected (the suggestion list stayed open)",
          );
        }
        if (!ok)
          ctx.note("suggestion clicked but the input did not show it yet");
        picked.push(label);
      }
      return { label: Array.isArray(value) ? picked : picked[0] };
    },
  };

  // PrimeVue Calendar (v3 .p-calendar) / DatePicker (v4 span.p-datepicker). ISO dates
  // (YYYY-MM-DD) and "today" go through the picker; anything else is typed.
  const PCAL =
    "[data-pc-name='calendar'], [data-pc-name='datepicker'], .p-calendar, span.p-datepicker";
  const calInput = (cal) => cal.querySelector("input:not([type='hidden'])");
  const calPanel = (cal) => {
    const input = calInput(cal);
    const id = input && input.getAttribute("aria-controls");
    const byId = id ? document.getElementById(id) : null;
    if (byId && isVisible(byId)) return byId;
    const inline = cal.querySelector(
      ".p-datepicker-inline, .p-datepicker-panel, div.p-datepicker",
    );
    if (inline && isVisible(inline)) return inline;
    const open = Array.from(
      document.querySelectorAll(
        ".p-datepicker-panel, div.p-datepicker[role='dialog'], div.p-datepicker",
      ),
    ).filter((el) => isVisible(el));
    return open.length ? open[open.length - 1] : null;
  };
  const calOpen = async (cal) => {
    const existing = calPanel(cal);
    if (existing) return existing;
    const trigger = cal.querySelector(
      ".p-datepicker-trigger, .p-datepicker-dropdown, [data-pc-name='dropdownbutton'], [data-pc-section='dropdown'], button[aria-label='Choose Date']",
    );
    const input = calInput(cal);
    if (trigger) pointer(trigger);
    else if (input) {
      input.focus();
      pointer(input);
    }
    let panel = await waitFor(() => calPanel(cal), Math.min(2000, remaining()));
    if (!panel && input) {
      input.focus();
      fire(input, "focus", { bubbles: false });
      pointer(input);
      panel = await waitFor(() => calPanel(cal), Math.min(1500, remaining()));
    }
    return panel || null;
  };
  const calMonthYear = (panel) => {
    const read = (sel) => {
      const el = panel.querySelector(sel);
      if (!el) return "";
      if (el instanceof HTMLSelectElement) {
        const option = el.options[el.selectedIndex];
        return option
          ? norm(option.textContent || option.value)
          : norm(el.value);
      }
      return norm(el.textContent);
    };
    let month = monthIndex(
      read(".p-datepicker-month, .p-datepicker-select-month"),
    );
    let year = Number.parseInt(
      read(".p-datepicker-year, .p-datepicker-select-year"),
      10,
    );
    if (month < 0 || !Number.isFinite(year)) {
      const title = read(".p-datepicker-title");
      for (const word of title.split(/\s+/)) {
        if (month < 0 && monthIndex(word) >= 0) month = monthIndex(word);
        if (/^\d{4}$/.test(word)) year = Number(word);
      }
    }
    return month >= 0 && Number.isFinite(year)
      ? { m: month + 1, y: year }
      : null;
  };
  const calPick = async (cal, parts) => {
    const panel = await calOpen(cal);
    if (!panel) throw new Error("primevue-calendar picker did not open");
    for (let step = 0; step < 240; step++) {
      const current = calMonthYear(panel);
      if (!current)
        throw new Error("primevue-calendar: cannot read the shown month/year");
      const diff = (parts.y - current.y) * 12 + (parts.m - current.m);
      if (diff === 0) break;
      const button = panel.querySelector(
        diff > 0
          ? ".p-datepicker-next, .p-datepicker-next-button, button[aria-label='Next Month']"
          : ".p-datepicker-prev, .p-datepicker-prev-button, button[aria-label='Previous Month']",
      );
      if (!button)
        throw new Error(
          "primevue-calendar: no " +
            (diff > 0 ? "next" : "previous") +
            " month button",
        );
      const before = current.y * 12 + current.m;
      pointer(button);
      const moved = await waitFor(
        () => {
          const now = calMonthYear(panel);
          return now && now.y * 12 + now.m !== before;
        },
        Math.min(1500, remaining()),
      );
      if (!moved)
        throw new Error("primevue-calendar: month navigation did not move");
      if (step === 239)
        throw new Error(
          "primevue-calendar: date is more than 20 years away; type it instead",
        );
    }
    const table = panel.querySelector(
      "table.p-datepicker-calendar, table.p-datepicker-day-view, table",
    );
    const cells = table ? Array.from(table.querySelectorAll("td")) : [];
    const cell = cells.find(
      (td) =>
        !td.classList.contains("p-datepicker-other-month") &&
        norm(td.textContent) === String(parts.d),
    );
    if (!cell)
      throw new Error("primevue-calendar: day " + parts.d + " not shown");
    const day = cell.querySelector("span, .p-datepicker-day") || cell;
    if (
      day.classList.contains("p-disabled") ||
      day.getAttribute("data-p-disabled") === "true"
    ) {
      throw new Error("primevue-calendar: day " + parts.d + " is disabled");
    }
    pointer(day);
  };
  const primevueCalendar = {
    name: "primevue-calendar",
    match: (root) => !!pickWithin(root, PCAL),
    read(root) {
      const cal = pickWithin(root, PCAL);
      const input = cal && calInput(cal);
      return input ? norm(input.value) : null;
    },
    equals: (actual, expected) => dateMatches(actual, expected),
    async write(root, value, ctx) {
      const cal = pickWithin(root, PCAL);
      const input = calInput(cal);
      const text = String(value).trim();
      const before = input ? input.value : "";
      if (lower(text) === "today") {
        const panel = await calOpen(cal);
        const today =
          panel &&
          (panel.querySelector(
            "[data-pc-name='todaybutton'], [data-pc-section='todaybutton']",
          ) ||
            Array.from(panel.querySelectorAll("button")).find(
              (b) => lower(b.textContent) === "today",
            ));
        if (today) {
          pointer(today);
          ctx.note("picked via the Today button");
        } else {
          const t = todayParts();
          await calPick(cal, t);
          ctx.note("no Today button; picked today's day cell");
        }
      } else if (isoParts(text)) {
        await calPick(cal, isoParts(text));
      } else {
        if (!input) throw new Error("primevue-calendar has no input");
        if (input.readOnly) {
          throw new Error(
            "the date input is read-only (manualInput: false); pass an ISO date (YYYY-MM-DD) or today to use the picker",
          );
        }
        typeText(input, text);
        fire(input, "change");
        if (typeof input.blur === "function") input.blur();
        fire(input, "blur", { bubbles: false });
        fire(input, "focusout");
      }
      await waitFor(
        () => input && input.value !== before && input.value !== "",
        Math.min(2000, remaining()),
      );
      if (calPanel(cal) && !cal.querySelector(".p-datepicker-inline")) {
        // Single-date pickers hide on select; close a lingering overlay with an outside press.
        fire(document.body, "mousedown");
        fire(document.body, "click");
      }
      return {
        via: lower(text) === "today" || isoParts(text) ? "picker" : "typed",
      };
    },
  };

  // Pills / chips / multi-text: PrimeVue Chips (.p-chips, .p-inputchips) add on Enter;
  // a "+Add" list (button.add-item) reveals a new input committed on Tab / blur.
  const PILLS = ".p-chips, .p-inputchips, .multitext, [data-widget='pills']";
  const pillAddButton = (scope) =>
    scope.querySelector("button.add-item, .add-item") ||
    Array.from(scope.querySelectorAll("button, [role='button']")).find((b) =>
      /^\+\s?add$/i.test(norm(b.textContent)),
    );
  const pillScope = (root) => pickWithin(root, PILLS) || root;
  const pillChipInput = (scope) =>
    scope.querySelector(
      ".p-chips-input-token input, .p-inputchips-input-item input, .p-chips input, .p-inputchips input",
    );
  const pillTextInputs = (scope) =>
    Array.from(
      scope.querySelectorAll(
        "input:not([type]), input[type='text'], input[type='email'], input[type='url'], textarea",
      ),
    ).filter((el) => isVisible(el) && el !== pillChipInput(scope));
  const INVALID_CLASS = /(?:^|\s)(?:[\w-]*-)?invalid(?:\s|$)/i;
  /** An input the app rejected (marked invalid) or one still being typed in holds no committed item. */
  const pillUncommitted = (el) =>
    el === document.activeElement ||
    el.getAttribute("aria-invalid") === "true" ||
    INVALID_CLASS.test(String(el.getAttribute("class") || "")) ||
    (!!el.parentElement &&
      INVALID_CLASS.test(
        String(el.parentElement.getAttribute("class") || ""),
      )) ||
    (!!el.validity && el.validity.valid === false);
  const pills = {
    name: "pills",
    match: (root) =>
      !!pickWithin(root, PILLS) ||
      (!!root.querySelector && !!pillAddButton(root)),
    read(root) {
      const scope = pillScope(root);
      const out = [];
      const add = (text) => {
        const t = norm(text);
        if (t && !out.some((v) => lower(v) === lower(t))) out.push(t);
      };
      const labels = scope.querySelectorAll(
        ".p-chips-token-label, .p-inputchips-chip-item .p-chip-label, .p-chip-label, .p-chip-text, .chip-label, .pill-label",
      );
      if (labels.length) for (const el of labels) add(el.textContent);
      else
        for (const el of scope.querySelectorAll(".p-chip, .chip, .pill"))
          add(el.textContent);
      for (const el of pillTextInputs(scope))
        if (!pillUncommitted(el)) add(el.value);
      return out;
    },
    equals(actual, expected) {
      const have = asList(actual).map((v) => lower(v));
      return asList(expectedLabel(expected)).every((v) =>
        have.includes(lower(v)),
      );
    },
    async write(root, value, ctx) {
      const scope = pillScope(root);
      for (const raw of asList(value)) {
        const item = String(raw);
        const present = () =>
          pills.read(root).some((v) => lower(v) === lower(item));
        if (present()) continue;
        const chipInput = pillChipInput(scope);
        if (chipInput) {
          typeText(chipInput, item);
          press(chipInput, "Enter");
        } else {
          let target = pillTextInputs(scope).find((el) => el.value === "");
          if (!target) {
            const add = pillAddButton(scope) || pillAddButton(root);
            if (!add)
              throw new Error("pills: no empty input and no +Add button");
            const known = pillTextInputs(scope);
            pointer(add);
            target = await waitFor(
              () =>
                pillTextInputs(scope).find(
                  (el) => !known.includes(el) || el.value === "",
                ),
              Math.min(2000, remaining()),
            );
            if (!target) throw new Error("pills: +Add did not reveal an input");
          }
          typeText(target, item);
          fire(target, "change");
          press(target, "Tab");
          if (typeof target.blur === "function") target.blur();
          fire(target, "blur", { bubbles: false });
          fire(target, "focusout");
          // Let the app validate on blur before the item is read back.
          await sleep(Math.min(200, remaining()));
        }
        if (!(await waitFor(present, Math.min(2000, remaining())))) {
          ctx.note(
            "pill " + JSON.stringify(item) + " not visible after adding",
          );
        }
      }
      return {};
    },
  };

  // Native and ARIA radio / checkbox groups. Clicks are idempotent: an option already in
  // the wanted state is never clicked (allow-unset radios clear on a second click).
  const choiceOptions = (root, kind, ctx, includeHidden) => {
    const roleSel =
      kind === "radio"
        ? "[role='radio']"
        : "[role='checkbox'], [role='switch']";
    const sel = "input[type='" + kind + "'], " + roleSel;
    let els = root.matches(sel)
      ? [root]
      : Array.from(root.querySelectorAll(sel));
    if (ctx && ctx.groupName) {
      els = els.filter(
        (el) => !(el instanceof HTMLInputElement) || el.name === ctx.groupName,
      );
    }
    els = els.filter((el) => {
      if (!(el instanceof HTMLInputElement)) return true;
      const holder = el.closest(roleSel);
      return !holder || holder === el;
    });
    return els
      .map((el) => {
        const input =
          el instanceof HTMLInputElement
            ? el
            : el.querySelector("input[type='" + kind + "']");
        const labelEl =
          (input && input.labels && input.labels[0]) ||
          (el.closest && el.closest("label")) ||
          null;
        let label = "";
        if (!(el instanceof HTMLInputElement))
          label = norm(el.getAttribute("aria-label") || textOf(el));
        if (!label && labelEl) label = textOf(labelEl);
        if (!label && input)
          label = norm(input.getAttribute("aria-label") || "");
        if (!label && input) {
          const wrap = input.closest(
            ".radio-label, .checkbox-label, .p-radiobutton, .p-checkbox",
          );
          const next = wrap && wrap.nextElementSibling;
          if (next && next.tagName === "LABEL") label = textOf(next);
          else if (wrap) label = textOf(wrap);
        }
        if (!label && input) label = norm(input.value);
        const visibleTarget = [
          labelEl,
          el,
          input &&
            input.closest(
              ".p-radiobutton, .p-checkbox, .radio-label, .checkbox-label",
            ),
          input && input.parentElement,
        ].find((candidate) => candidate && isVisible(candidate));
        return {
          el,
          input,
          labelEl,
          label,
          value: input ? input.value : el.getAttribute("data-value") || "",
          visible: !!visibleTarget,
          disabled:
            !!(input && input.disabled) ||
            el.getAttribute("aria-disabled") === "true",
          checked: () =>
            input && el === input
              ? input.checked
              : el.getAttribute("aria-checked") === "true" ||
                (!!input && input.checked),
        };
      })
      .filter((o) => includeHidden || o.visible);
  };
  const toggleChoice = async (option, want, ctx) => {
    if (option.checked() === want) return;
    if (option.disabled)
      throw new Error(
        "option " + JSON.stringify(option.label) + " is disabled",
      );
    const clickOnce = () => {
      if (option.input && option.el === option.input) option.input.click();
      else option.el.click();
    };
    clickOnce();
    if (
      await waitFor(() => option.checked() === want, Math.min(500, remaining()))
    )
      return;
    // One recovery click with the full pointer sequence on the visible control, then settle.
    ctx.note(
      "option " +
        JSON.stringify(option.label) +
        " did not change after a click; one recovery click",
    );
    const visible = [
      option.labelEl,
      option.el,
      option.input && option.input.closest(".p-radiobutton, .p-checkbox"),
    ].find((candidate) => candidate && isVisible(candidate));
    pointer(visible || option.el);
    await sleep(Math.min(500, remaining()));
    if (option.checked() !== want) {
      throw new Error(
        "option " +
          JSON.stringify(option.label) +
          " did not " +
          (want ? "check" : "uncheck"),
      );
    }
  };
  const findChoice = (options, wanted, kind) => {
    const picked = matchOption(
      options.map((o) => o.el),
      wanted,
      (el) => options.find((o) => o.el === el).label,
    );
    if (picked.hit) return options.find((o) => o.el === picked.hit.el);
    const byValue = options.filter(
      (o) => o.value !== "" && o.value === String(wanted),
    );
    if (byValue.length === 1) return byValue[0];
    throw new Error(optionError(kind, wanted, picked));
  };
  const radioGroup = {
    name: "radio-group",
    match: (root) =>
      (root.matches &&
        root.matches(
          "input[type='radio'], [role='radio'], [role='radiogroup']",
        )) ||
      !!root.querySelector("input[type='radio'], [role='radio']"),
    read(root, ctx) {
      const checked = choiceOptions(root, "radio", ctx).find((o) =>
        o.checked(),
      );
      return checked ? checked.label : "";
    },
    async write(root, value, ctx) {
      const options = choiceOptions(root, "radio", ctx);
      if (!options.length)
        throw new Error("radio-group: no visible radio options");
      const option = findChoice(options, String(value), "radio-group");
      await toggleChoice(option, true, ctx);
      return { label: option.label };
    },
  };
  const checkboxGroup = {
    name: "checkbox-group",
    match: (root) =>
      (root.matches &&
        root.matches(
          "input[type='checkbox'], [role='checkbox'], [role='switch']",
        )) ||
      !!root.querySelector(
        "input[type='checkbox'], [role='checkbox'], [role='switch']",
      ),
    read(root, ctx) {
      const options = choiceOptions(root, "checkbox", ctx);
      if (options.length === 1) return options[0].checked();
      return options.filter((o) => o.checked()).map((o) => o.label);
    },
    async write(root, value, ctx) {
      const options = choiceOptions(root, "checkbox", ctx);
      if (!options.length)
        throw new Error("checkbox-group: no visible checkboxes");
      if (typeof value === "boolean" || value === "true" || value === "false") {
        if (options.length !== 1) {
          throw new Error(
            "checkbox-group has " +
              options.length +
              " checkboxes; pass a list of labels (or option: <label>)",
          );
        }
        await toggleChoice(options[0], value === true || value === "true", ctx);
        return {};
      }
      const wanted = asList(value).map((item) =>
        findChoice(options, String(item), "checkbox-group"),
      );
      for (const option of options)
        await toggleChoice(option, wanted.includes(option), ctx);
      return { label: wanted.map((o) => o.label) };
    },
  };

  const selectIn = (root) => {
    if (root.matches && root.matches("select")) return root;
    const all = Array.from(root.querySelectorAll("select")).filter((el) =>
      isVisible(el),
    );
    return all.length === 1 ? all[0] : null;
  };
  const nativeSelect = {
    name: "native-select",
    match: (root) => !!selectIn(root),
    read(root) {
      const select = selectIn(root);
      if (!select) return null;
      const chosen = Array.from(select.options)
        .filter((o) => o.selected)
        .map((o) => norm(o.textContent));
      return select.multiple ? chosen : chosen[0] || "";
    },
    async write(root, value) {
      const select = selectIn(root);
      const options = Array.from(select.options);
      const pick = (wanted) => {
        const picked = matchOption(options, wanted, (o) => o.textContent);
        if (picked.hit) return picked.hit.el;
        const byValue = options.find((o) => o.value === String(wanted));
        if (byValue) return byValue;
        throw new Error(optionError("native-select", wanted, picked));
      };
      const wanted = asList(value).map((item) => pick(String(item)));
      if (select.multiple) {
        for (const option of options) option.selected = wanted.includes(option);
      } else {
        if (wanted.length !== 1)
          throw new Error("native-select takes one option");
        nativeSet(select, wanted[0].value);
      }
      fire(select, "input");
      fire(select, "change");
      const labels = wanted.map((o) => norm(o.textContent));
      return { label: select.multiple ? labels : labels[0] };
    },
  };

  const TEXTLIKE =
    "input:not([type]), input[type='text'], input[type='email'], input[type='number'], input[type='tel'], input[type='url'], input[type='search'], input[type='password'], input[type='date'], input[type='time'], input[type='datetime-local'], input[type='month'], input[type='week'], input[type='color'], input[type='range'], textarea, [contenteditable=''], [contenteditable='true']";
  const textControl = (root) => {
    if (root.matches && root.matches(TEXTLIKE)) return root;
    const all = Array.from(root.querySelectorAll(TEXTLIKE)).filter((el) =>
      isVisible(el),
    );
    return all.length === 1 ? all[0] : null;
  };
  const isEditable = (el) => el.isContentEditable && !("value" in el);
  const nativeInput = {
    name: "native-input",
    match: (root) => !!textControl(root),
    read(root) {
      const el = textControl(root);
      if (!el) return null;
      return isEditable(el) ? norm(el.innerText) : String(el.value);
    },
    async write(root, value) {
      const el = textControl(root);
      let text = value === null || value === undefined ? "" : String(value);
      if (el.type === "date" && lower(text) === "today") {
        const t = todayParts();
        text = t.y + "-" + pad2(t.m) + "-" + pad2(t.d);
      }
      if (isEditable(el)) {
        el.textContent = text;
        fire(el, "input", { data: text });
      } else {
        nativeSet(el, text);
        fire(el, "input", { data: text });
        fire(el, "change");
      }
      return { label: text };
    },
  };

  const BUILTINS = {
    "vue-multiselect": vueMultiselect,
    "primevue-autocomplete": primevueAutocomplete,
    "primevue-calendar": primevueCalendar,
    pills,
    "radio-group": radioGroup,
    "checkbox-group": checkboxGroup,
    "native-select": nativeSelect,
    "native-input": nativeInput,
  };
  const DEFAULT_ORDER = Object.keys(BUILTINS);
  const NATIVE_TAIL = [
    "radio-group",
    "checkbox-group",
    "native-select",
    "native-input",
  ];

  /* ----- driver registry (config order, natives appended) ----- */

  const drivers = [];
  const registryErrors = [];
  const entries =
    Array.isArray(config.drivers) && config.drivers.length
      ? config.drivers
      : DEFAULT_ORDER.map((use) => ({ use }));
  for (const entry of entries) {
    if (entry.use) {
      if (BUILTINS[entry.use] && !drivers.includes(BUILTINS[entry.use]))
        drivers.push(BUILTINS[entry.use]);
      continue;
    }
    const loaded = customDrivers[entry.custom];
    const file = entry.file || "custom driver";
    if (!loaded || loaded.__loadError) {
      registryErrors.push(
        file + " failed to load: " + (loaded ? loaded.__loadError : "missing"),
      );
      continue;
    }
    const driver =
      loaded && loaded.default && !loaded.name ? loaded.default : loaded;
    if (
      !driver ||
      typeof driver.name !== "string" ||
      typeof driver.match !== "function" ||
      typeof driver.read !== "function" ||
      typeof driver.write !== "function"
    ) {
      registryErrors.push(
        file +
          " must export { name, match(root), read(root), write(root, value, ctx) }",
      );
      continue;
    }
    drivers.push(driver);
  }
  for (const name of NATIVE_TAIL)
    if (!drivers.includes(BUILTINS[name])) drivers.push(BUILTINS[name]);
  const driverByName = (name) =>
    drivers.find((d) => d.name === name) || BUILTINS[name];

  /* ----- target resolution ----- */

  const templates = () =>
    Array.isArray(config.fieldRoot) && config.fieldRoot.length
      ? config.fieldRoot
      : ["[" + testIdAttribute + '="{key}"]', '[name="{key}"]'];
  const fillTemplate = (template, key) =>
    template.replace(/(["']?)\{key\}/g, (_m, quote) =>
      quote
        ? quote +
          String(key)
            .replace(/\\/g, "\\\\")
            .split(quote)
            .join("\\" + quote)
        : CSS.escape(String(key)),
    );
  const commonAncestor = (els) => {
    let node = els[0].parentElement;
    while (node && !els.every((el) => node.contains(el)))
      node = node.parentElement;
    return node || document.body;
  };
  const locateField = (key) => {
    const hidden = [];
    for (const template of templates()) {
      const selector = fillTemplate(template, key);
      let all;
      try {
        all = Array.from(document.querySelectorAll(selector));
      } catch (e) {
        return {
          error:
            "invalid fieldRoot selector " +
            JSON.stringify(selector) +
            ": " +
            (e && e.message),
        };
      }
      if (!all.length) continue;
      const shown = all.filter((el) => isVisible(el));
      if (!shown.length) {
        hidden.push(selector);
        continue;
      }
      const outer = shown.filter(
        (el) => !shown.some((other) => other !== el && other.contains(el)),
      );
      if (outer.length === 1) return { root: outer[0], selector };
      const names = new Set(
        outer.map((el) =>
          el instanceof HTMLInputElement &&
          (el.type === "radio" || el.type === "checkbox")
            ? el.name
            : null,
        ),
      );
      if (names.size === 1 && !names.has(null) && !names.has("")) {
        return {
          root: commonAncestor(outer),
          selector,
          groupName: Array.from(names)[0],
        };
      }
      return {
        error:
          outer.length +
          " visible elements match field " +
          JSON.stringify(key) +
          " (" +
          selector +
          "); make browser.fieldRoot more specific",
      };
    }
    return { missing: true, hidden };
  };
  const locateTarget = (loc) => {
    const resolved = resolveLocator(loc, testIdAttribute);
    if (resolved.error) return { error: resolved.error };
    const pool =
      loc.visible === false
        ? resolved.found
        : resolved.found.filter((el) => isVisible(el));
    if (typeof loc.nth === "number") {
      if (pool[loc.nth]) return { root: pool[loc.nth] };
      return pool.length
        ? {
            error:
              "nth " +
              loc.nth +
              " is out of range: " +
              pool.length +
              " match(es)",
          }
        : { missing: true };
    }
    if (!pool.length)
      return {
        missing: true,
        hidden: resolved.found.length ? ["(hidden matches)"] : [],
      };
    if (pool.length === 1) return { root: pool[0] };
    return {
      error:
        pool.length +
        " visible elements match the locator; add nth (0-based) or a more specific locator",
    };
  };
  const targetName = () =>
    request.target && request.target.field !== undefined
      ? "field " + JSON.stringify(request.target.field)
      : "locator " + JSON.stringify(request.target && request.target.locator);
  const acquire = async (ms) => {
    const until = Date.now() + Math.max(0, Math.min(ms, remaining()));
    for (;;) {
      const got =
        request.target.field !== undefined
          ? locateField(request.target.field)
          : locateTarget(request.target.locator);
      if (got.root || got.error) return got;
      if (Date.now() >= until) return got;
      await sleep(100);
    }
  };
  const missingMessage = (got) =>
    targetName() +
    " not found" +
    (got.hidden && got.hidden.length
      ? " (present but hidden: " + got.hidden.join(", ") + ")"
      : "") +
    " within " +
    Math.round(Number(request.mountMs) || 0) +
    "ms";
  const BUILTIN_DRIVERS = Object.values(BUILTINS);
  const pickDriver = (root, forced, ctx) => {
    if (forced) {
      const driver = driverByName(forced);
      if (!driver)
        return { error: "unknown widget driver " + JSON.stringify(forced) };
      return { driver };
    }
    for (const driver of drivers) {
      let claimed;
      try {
        claimed = driver.match(root, ctx);
      } catch {
        // A throwing match() never claims the root.
        continue;
      }
      if (!BUILTIN_DRIVERS.includes(driver) && typeof claimed !== "boolean") {
        // An async match() returns a Promise, which is always truthy: it
        // would claim every field.
        return {
          error:
            "widget driver " +
            JSON.stringify(driver.name) +
            ": match() must synchronously return true or false (got " +
            (claimed && typeof claimed.then === "function"
              ? "a Promise"
              : typeof claimed) +
            ")",
        };
      }
      if (claimed) return { driver };
    }
    return {
      error:
        "no widget driver matches " +
        targetName() +
        " (" +
        describeEl(root) +
        "); tried " +
        drivers.map((d) => d.name).join(", ") +
        " — set driver:, or add a custom driver under browser.widgets",
    };
  };
  const makeCtx = (root, got) => ({
    option: request.option,
    groupName: got.groupName,
    deadline,
    remaining,
    sleep,
    waitFor,
    fire,
    pointer,
    press,
    nativeSet,
    typeText,
    norm,
    lower,
    textOf,
    isVisible,
    matchOption,
    note: (message) => notes.push(String(message).slice(0, 300)),
    root,
  });
  const rootText = (root) =>
    root && root.isConnected ? textOf(root).slice(0, 400) : "";
  const sensitiveRoot = (root) =>
    !!root &&
    ((root.matches && root.matches("input[type='password']")) ||
      !!(root.querySelector && root.querySelector("input[type='password']")));
  const finish = (out, root) =>
    Object.assign(
      {
        durationMs: Date.now() - started,
        ...(root ? { root: describeEl(root), rootText: rootText(root) } : {}),
        ...(notes.length ? { notes } : {}),
        ...(sensitiveRoot(root) ? { sensitive: true } : {}),
      },
      out,
    );
  const fail = (error, root, extra) =>
    finish(
      Object.assign({ ok: false, status: "failed", error }, extra || {}),
      root,
    );
  const errorText = (e) => String((e && e.message) || e).slice(0, 500);
  /**
   * A driver call (project drivers especially) never outlives the op: a
   * promise that never settles would otherwise run into the evaluate
   * timeout, which stops the browser on Playwright.
   */
  const bounded = (value, what) => {
    if (!value || typeof value.then !== "function") return value;
    let timer;
    const expired = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = new Error(
          what + " did not settle within the step budget",
        );
        error.cairnBudget = true;
        reject(error);
      }, Math.max(1, remaining()) + 1000);
    });
    return Promise.race([value, expired]).finally(() => clearTimeout(timer));
  };
  const driverRead = (driver, root, ctx) =>
    bounded(driver.read(root, ctx), driver.name + ".read()");

  /* ----- operations ----- */

  const live = async (root) => {
    if (root.isConnected) return root;
    const again = await acquire(Math.min(1000, remaining()));
    return again.root || root;
  };

  const opSet = async (expectedValue, mode) => {
    if (registryErrors.length) return fail(registryErrors.join("; "));
    const got = await acquire(Number(request.mountMs) || 0);
    if (got.error) return fail(got.error);
    if (!got.root) {
      return request.optional
        ? finish({ ok: true, status: "skipped", reason: "absent" })
        : fail(missingMessage(got), undefined, { reason: "absent" });
    }
    let root = got.root;
    const ctx = makeCtx(root, got);
    const picked = pickDriver(root, request.driver, ctx);
    if (picked.error) return fail(picked.error, root);
    const driver = picked.driver;
    const readNow = async () => driverRead(driver, await live(root), ctx);
    let before;
    try {
      before = await readNow();
    } catch (e) {
      // A driver that never answers has spent the whole budget: stop here.
      if (e && e.cairnBudget)
        return fail(errorText(e), root, { driver: driver.name });
      before = undefined;
      notes.push("read before write failed: " + errorText(e));
    }
    let expected = expectedValue;
    if (mode === "check" || mode === "uncheck") {
      const on = mode === "check";
      // Toggling one option rewrites the whole group: never from an unknown state.
      if (before === undefined) {
        return fail(
          mode + ": could not read " + targetName() + " before changing it",
          root,
          {
            driver: driver.name,
          },
        );
      }
      if (request.option !== undefined && request.option !== null) {
        let option = String(request.option);
        // Resolve the option the way write does (exact label, one unique
        // contains, the value attribute): a partial label or a typo never
        // passes as "already", and a single visible checkbox is never
        // toggled for an option it is not.
        if (driver === checkboxGroup || driver === radioGroup) {
          const kind = driver === radioGroup ? "radio" : "checkbox";
          const current = await live(root);
          const options = choiceOptions(current, kind, ctx);
          try {
            option = findChoice(options, option, driver.name).label;
          } catch (e) {
            const hidden =
              choiceOptions(current, kind, ctx, true).length - options.length;
            return fail(
              errorText(e) +
                (hidden > 0
                  ? " (" + hidden + " hidden option(s) not considered)"
                  : ""),
              root,
              { driver: driver.name },
            );
          }
        } else if (Array.isArray(before)) {
          const current = matchOption(
            before.map((v) => String(v)),
            option,
            (v) => v,
          );
          if (current.hit) option = current.hit.label;
          else if (current.ambiguous)
            return fail(optionError(driver.name, option, current), root, {
              driver: driver.name,
            });
        }
        if (Array.isArray(before)) {
          const has = before.some((v) => lower(v) === lower(option));
          expected = on
            ? has
              ? before
              : before.concat([option])
            : before.filter((v) => lower(v) !== lower(option));
        } else if (typeof before === "boolean") {
          expected = on;
        } else if (on) {
          expected = option;
        } else if (lower(before) === lower(option)) {
          return fail(
            "cannot uncheck " +
              JSON.stringify(option) +
              ": " +
              driver.name +
              " is single-choice (no unchecked state)",
            root,
            { driver: driver.name },
          );
        } else {
          return finish(
            {
              ok: true,
              status: "already",
              driver: driver.name,
              actual: before,
            },
            root,
          );
        }
      } else {
        if (typeof before !== "boolean") {
          return fail(
            mode +
              " without option needs a single checkbox; " +
              targetName() +
              " (" +
              driver.name +
              ") reads " +
              JSON.stringify(before) +
              " — add option:",
            root,
            { driver: driver.name },
          );
        }
        expected = on;
      }
    }
    if (
      mode === "choose" &&
      (Array.isArray(before) || typeof before === "boolean")
    ) {
      return fail(
        "choose picks one option, but " +
          targetName() +
          " (" +
          driver.name +
          ") holds " +
          (Array.isArray(before) ? "a list" : "a checkbox") +
          "; use set with a list or check",
        root,
        { driver: driver.name },
      );
    }
    if (before !== undefined && sameValue(driver, before, expected, ctx)) {
      return finish(
        {
          ok: true,
          status: "already",
          driver: driver.name,
          expected,
          actual: before,
        },
        root,
      );
    }
    let written;
    try {
      written = await bounded(
        driver.write(root, expected, ctx),
        driver.name + ".write()",
      );
    } catch (e) {
      let actual;
      try {
        actual = await readNow();
      } catch {
        actual = undefined;
      }
      return fail(driver.name + ": " + errorText(e), root, {
        driver: driver.name,
        expected,
        actual,
      });
    }
    root = await live(root);
    const label =
      written && written.label !== undefined ? written.label : undefined;
    const via = written && written.via ? String(written.via) : undefined;
    if (request.verify === false) {
      return finish(
        {
          ok: true,
          status: "written",
          driver: driver.name,
          expected,
          ...(via ? { via } : {}),
        },
        root,
      );
    }
    let actual;
    const matches = () =>
      sameValue(driver, actual, expected, ctx) ||
      (label !== undefined &&
        !driver.equals &&
        sameValue(null, actual, label, ctx));
    const committed = await waitFor(
      async () => {
        actual = await readNow();
        return matches();
      },
      Math.max(250, Math.min(Number(request.readBackMs) || 2000, remaining())),
      100,
    );
    if (!committed) {
      return fail(
        driver.name +
          " did not commit " +
          JSON.stringify(expectedLabel(expected)) +
          "; field shows " +
          JSON.stringify(actual),
        root,
        {
          driver: driver.name,
          expected,
          actual,
          ...(label !== undefined ? { label } : {}),
        },
      );
    }
    // Committed through the driver's chosen label only (a partial-label
    // pick): say so, so a substituted record never passes silently.
    const substituted =
      label !== undefined && !sameValue(driver, actual, expected, ctx);
    if (substituted) {
      notes.push(
        "committed " +
          JSON.stringify(label) +
          " for " +
          JSON.stringify(expectedLabel(expected)) +
          " (partial-label match)",
      );
    }
    return finish(
      {
        ok: true,
        status: "committed",
        driver: driver.name,
        expected,
        actual,
        ...(via ? { via } : {}),
        ...(label !== undefined ? { label } : {}),
        ...(substituted ? { substituted: true } : {}),
      },
      root,
    );
  };

  const opRead = async () => {
    const got = await acquire(Number(request.mountMs) || 0);
    if (got.error) return fail(got.error);
    if (!got.root) return finish({ ok: true, status: "absent" });
    const ctx = makeCtx(got.root, got);
    const picked = pickDriver(got.root, request.driver, ctx);
    if (picked.error) return fail(picked.error, got.root);
    try {
      const value = await driverRead(picked.driver, got.root, ctx);
      const expected = request.value;
      return finish(
        {
          ok: true,
          status: "present",
          driver: picked.driver.name,
          actual: value,
          ...(expected !== undefined
            ? {
                expected,
                matches: sameValue(picked.driver, value, expected, ctx),
              }
            : {}),
        },
        got.root,
      );
    } catch (e) {
      return fail(
        picked.driver.name + " read failed: " + errorText(e),
        got.root,
      );
    }
  };

  /** Re-read several fields at once (form verify pass); never waits for a mount. */
  const opReadMany = async () => {
    const out = [];
    for (const item of Array.isArray(request.targets) ? request.targets : []) {
      const got =
        item.target.field !== undefined
          ? locateField(item.target.field)
          : locateTarget(item.target.locator);
      if (got.error) {
        out.push({ ok: false, status: "failed", error: got.error });
        continue;
      }
      if (!got.root) {
        out.push({ ok: true, status: "absent" });
        continue;
      }
      const ctx = makeCtx(got.root, got);
      const picked = pickDriver(got.root, item.driver, ctx);
      if (picked.error) {
        out.push({ ok: false, status: "failed", error: picked.error });
        continue;
      }
      try {
        const actual = await driverRead(picked.driver, got.root, ctx);
        let matches = sameValue(picked.driver, actual, item.value, ctx);
        if (!matches && item.label !== undefined && !picked.driver.equals) {
          matches = sameValue(null, actual, item.label, ctx);
        }
        out.push({
          ok: true,
          status: "present",
          driver: picked.driver.name,
          actual,
          matches,
          ...(sensitiveRoot(got.root) ? { sensitive: true } : {}),
        });
      } catch (e) {
        out.push({
          ok: false,
          status: "failed",
          error: picked.driver.name + " read failed: " + errorText(e),
        });
      }
    }
    return finish({ ok: true, status: "read", results: out });
  };

  const parseTemplate = (template) => {
    const m =
      /^\[\s*([^\]~|^$*=\s]+)\s*([~|^$*]?=)\s*(["'])(.*)\{key\}(.*)\3\s*\]$/.exec(
        template.trim(),
      );
    return m ? { attr: m[1], before: m[4], after: m[5] } : null;
  };
  const opDump = async () => {
    const seen = new Set();
    const fields = [];
    let total = 0;
    for (const template of templates()) {
      const parsed = parseTemplate(template);
      if (!parsed) continue;
      let all;
      try {
        all = Array.from(
          document.querySelectorAll("[" + CSS.escape(parsed.attr) + "]"),
        );
      } catch {
        continue;
      }
      const shown = all.filter((el) => isVisible(el));
      const outer = shown.filter(
        (el) => !shown.some((other) => other !== el && other.contains(el)),
      );
      for (const root of outer) {
        if (seen.has(root)) continue;
        seen.add(root);
        let key = root.getAttribute(parsed.attr) || "";
        if (parsed.before) {
          const at = key.lastIndexOf(parsed.before);
          if (at < 0) continue;
          key = key.slice(at + parsed.before.length);
        }
        if (parsed.after) {
          if (!key.endsWith(parsed.after)) continue;
          key = key.slice(0, key.length - parsed.after.length);
        }
        total += 1;
        const ctx = makeCtx(root, {});
        const picked = pickDriver(root, undefined, ctx);
        let value;
        try {
          value = picked.driver
            ? await driverRead(picked.driver, root, ctx)
            : undefined;
        } catch {
          value = undefined;
        }
        const empty = isEmptyValue(value) || value === false;
        if (!empty || fields.length >= (Number(request.limit) || 50)) continue;
        const required =
          !!root.querySelector(
            "[required], [aria-required='true'], .required, .p-required",
          ) ||
          /\*\s*$/.test(
            norm(
              (root.querySelector("label, .question-label, legend") || {})
                .textContent || "",
            ),
          );
        fields.push({
          key,
          driver: picked.driver ? picked.driver.name : null,
          required,
          label: norm(
            (root.querySelector("label, .question-label, legend") || {})
              .textContent || "",
          ).slice(0, 160),
        });
      }
    }
    return finish({ ok: true, status: "dumped", total, unanswered: fields });
  };

  const opClick = async () => {
    const got = await acquire(Number(request.mountMs) || 0);
    if (got.error) return fail(got.error);
    if (!got.root) {
      return request.optional
        ? finish({ ok: true, status: "skipped", reason: "absent" })
        : fail(missingMessage(got), undefined, { reason: "absent" });
    }
    const el = got.root;
    if (request.op === "probe")
      return finish({ ok: true, status: "present" }, el);
    el.scrollIntoView({ block: "center", inline: "center" });
    const c = centerOf(el);
    const hit = document.elementFromPoint(c.x, c.y);
    const blockedBy =
      hit && hit !== el && !el.contains(hit) && !hit.contains(el)
        ? describeEl(hit)
        : undefined;
    if (request.mode === "hit") {
      return finish(
        { ok: true, status: "present", ...(blockedBy ? { blockedBy } : {}) },
        el,
      );
    }
    const disabled =
      el.disabled === true ||
      el.getAttribute("aria-disabled") === "true" ||
      !!(el.closest && el.closest("fieldset[disabled]"));
    if (disabled)
      return fail(
        describeEl(el) + " is disabled; a DOM click would do nothing",
        el,
      );
    if (typeof el.click === "function") el.click();
    else fire(el, "click");
    return finish(
      {
        ok: true,
        status: "clicked",
        via: "dispatch",
        ...(blockedBy ? { blockedBy } : {}),
      },
      el,
    );
  };

  const opFill = async () => {
    const got = await acquire(Number(request.mountMs) || 0);
    if (got.error) return fail(got.error);
    if (!got.root) {
      return request.optional
        ? finish({ ok: true, status: "skipped", reason: "absent" })
        : fail(missingMessage(got), undefined, { reason: "absent" });
    }
    let el = got.root;
    const control =
      el.matches(TEXTLIKE) || el instanceof HTMLSelectElement
        ? el
        : textControl(el);
    if (!control)
      return fail(
        describeEl(el) + " is not a text control (fill mode: set)",
        el,
      );
    el = control;
    const text =
      request.value === null || request.value === undefined
        ? ""
        : String(request.value);
    const attempts =
      request.verify === false ? 1 : Math.max(1, Number(request.attempts) || 4);
    const settle = Math.max(0, Number(request.settleMs) || 0);
    let actual = "";
    for (let attempt = 0; attempt < attempts; attempt++) {
      if (isEditable(el)) {
        el.textContent = text;
        fire(el, "input", { data: text });
      } else {
        nativeSet(el, text);
        fire(el, "input", { data: text });
        fire(el, "change");
      }
      if (request.verify === false)
        return finish({ ok: true, status: "written", via: "set" }, el);
      await sleep(Math.min(settle, remaining()));
      if (!el.isConnected) {
        const again = await acquire(Math.min(1000, remaining()));
        if (again.root)
          el = again.root.matches(TEXTLIKE)
            ? again.root
            : textControl(again.root) || again.root;
      }
      actual = isEditable(el) ? norm(el.innerText) : String(el.value);
      if (actual === text) {
        if (attempt > 0)
          notes.push("value survived after " + (attempt + 1) + " attempts");
        return finish(
          { ok: true, status: "committed", via: "set", actual },
          el,
        );
      }
    }
    return fail("value did not stick after " + attempts + " attempts", el, {
      expected: text,
      actual,
      via: "set",
    });
  };

  try {
    switch (request.op) {
      case "set":
        return await opSet(request.value, "set");
      case "choose":
        return await opSet(request.option, "choose");
      case "check":
        return await opSet(true, "check");
      case "uncheck":
        return await opSet(false, "uncheck");
      case "read":
        return await opRead();
      case "readMany":
        return await opReadMany();
      case "probe":
        return await opClick();
      case "dump":
        return await opDump();
      case "click":
        return await opClick();
      case "fill":
        return await opFill();
      default:
        return fail("unknown widget op " + JSON.stringify(request.op));
    }
  } catch (e) {
    return fail("widget runtime error: " + errorText(e));
  }
}
