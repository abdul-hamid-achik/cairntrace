/* oxlint-disable unicorn/consistent-function-scoping, eslint/no-underscore-dangle, eslint/preserve-caught-error -- the prelude ships to the page as ONE self-contained function, so every helper lives inside it */
// window.__cairn — F20 page helpers for eval steps and browser script
// verifiers.
//
// Runs in the PAGE (Playwright page.evaluate / agent-browser eval), never on
// the host. Cairntrace prepends `(<this function>)(<app handle getters>);`
// to an eval / browser-verifier source that mentions `__cairn`, and to the
// probe of a `wait: { app: … }` step. Installation is idempotent per
// document and namespaced: only `window.__cairn` is defined (non-enumerable,
// read-only), and a page that already owns `window.__cairn` is never
// overwritten (the step fails with a clear error instead).
//
// Plain ES5-ish JavaScript: no imports, no host closures, no `new Function`
// (pages with a strict CSP still run it, because the backends evaluate it
// through the DevTools protocol).

// oxlint-disable-next-line no-unused-vars
function cairnPreludeInstall(appDefs) {
  "use strict";
  var VERSION = "1";
  var w = window;
  var existing = w.__cairn;
  if (existing !== undefined && !(existing && existing.__cairnPrelude)) {
    throw new Error(
      "window.__cairn is already defined by the page; Cairntrace does not overwrite page globals",
    );
  }
  if (existing && existing.__cairnPrelude === VERSION) {
    existing.__setApp(appDefs || {});
    return existing;
  }

  var MAX_WAIT_MS = 600000;

  function norm(s) {
    return String(s == null ? "" : s)
      .replace(/\s+/g, " ")
      .trim();
  }

  function el(target) {
    if (target == null) return null;
    if (typeof target === "string") return document.querySelector(target);
    if (target.nodeType === 1) return target;
    return null;
  }

  function sleep(ms) {
    var n = Math.max(0, Math.min(Number(ms) || 0, MAX_WAIT_MS));
    return new Promise(function (resolve) {
      setTimeout(resolve, n);
    });
  }

  // Rendered: connected, not visibility:hidden, with a non-empty box.
  function visible(target) {
    var e = el(target);
    if (!e || !e.isConnected) return false;
    var style = w.getComputedStyle(e);
    if (style.visibility === "hidden" || style.display === "none") return false;
    var rect = e.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  // Whitespace-normalized rendered text ("" when there is no element).
  function text(target) {
    var e = el(target);
    if (!e) return "";
    return norm(e.innerText !== undefined ? e.innerText : e.textContent);
  }

  // The accessible-ish label of a control: aria-label, aria-labelledby,
  // <label for> / wrapping label, then placeholder and title.
  function labelOf(target) {
    var e = el(target);
    if (!e) return "";
    var aria = e.getAttribute("aria-label");
    if (aria && norm(aria)) return norm(aria);
    var by = e.getAttribute("aria-labelledby");
    if (by) {
      var parts = by
        .split(/\s+/)
        .map(function (id) {
          var ref = document.getElementById(id);
          return ref ? norm(ref.textContent) : "";
        })
        .filter(Boolean);
      if (parts.length) return parts.join(" ");
    }
    if (e.labels && e.labels.length) {
      var labels = [];
      for (var i = 0; i < e.labels.length; i++) {
        var t = norm(e.labels[i].textContent);
        if (t) labels.push(t);
      }
      if (labels.length) return labels.join(" ");
    }
    var wrap = e.closest ? e.closest("label") : null;
    if (wrap && norm(wrap.textContent)) return norm(wrap.textContent);
    return norm(e.getAttribute("placeholder") || e.getAttribute("title") || "");
  }

  // Write a form control through the prototype's native setter (so
  // framework value trackers see a real change), then fire input + change.
  // A boolean on a checkbox / radio sets `checked`. Returns the read-back.
  function nativeSet(target, value) {
    var e = el(target);
    if (!e)
      throw new Error("__cairn.nativeSet: no element for " + String(target));
    var tag = e.tagName;
    var proto =
      tag === "TEXTAREA"
        ? w.HTMLTextAreaElement.prototype
        : tag === "SELECT"
          ? w.HTMLSelectElement.prototype
          : tag === "INPUT"
            ? w.HTMLInputElement.prototype
            : null;
    if (!proto) {
      throw new Error(
        "__cairn.nativeSet: <" + tag.toLowerCase() + "> is not a form control",
      );
    }
    var checkable =
      tag === "INPUT" && (e.type === "checkbox" || e.type === "radio");
    var prop = checkable && typeof value === "boolean" ? "checked" : "value";
    var descriptor = Object.getOwnPropertyDescriptor(proto, prop);
    var next = prop === "checked" ? value : value == null ? "" : String(value);
    if (descriptor && descriptor.set) descriptor.set.call(e, next);
    else e[prop] = next;
    e.dispatchEvent(new Event("input", { bubbles: true }));
    e.dispatchEvent(new Event("change", { bubbles: true }));
    return prop === "checked" ? e.checked : e.value;
  }

  var MOUSE =
    /^(click|dblclick|mousedown|mouseup|mouseover|mouseout|mouseenter|mouseleave|mousemove|contextmenu)$/;
  var NO_BUBBLE =
    /^(focus|blur|mouseenter|mouseleave|pointerenter|pointerleave)$/;

  // Dispatch a DOM event of the right class; returns dispatchEvent's result.
  function fire(target, type, init) {
    var e = el(target);
    if (!e) throw new Error("__cairn.fire: no element for " + String(target));
    var options = {
      bubbles: !NO_BUBBLE.test(type),
      cancelable: true,
      composed: true,
    };
    if (init) for (var k in init) options[k] = init[k];
    var Ctor = Event;
    if (type.startsWith("pointer") && typeof w.PointerEvent === "function")
      Ctor = w.PointerEvent;
    else if (MOUSE.test(type)) Ctor = w.MouseEvent;
    else if (type.startsWith("key")) Ctor = w.KeyboardEvent;
    else if (/^(focus|blur|focusin|focusout)$/.test(type)) Ctor = w.FocusEvent;
    else if (
      /^(input|beforeinput)$/.test(type) &&
      typeof w.InputEvent === "function"
    )
      Ctor = w.InputEvent;
    return e.dispatchEvent(new Ctor(type, options));
  }

  // A rendered table as records keyed by header text (`columnN` for an
  // empty header). <table>, or role table/grid with row/cell roles. Hidden
  // rows are skipped.
  function rows(target) {
    var t = el(target);
    if (!t) throw new Error("__cairn.rows: no table for " + String(target));
    var isNative = t.tagName === "TABLE";
    var allRows = isNative
      ? Array.prototype.slice.call(t.rows)
      : Array.prototype.slice.call(t.querySelectorAll('[role="row"]'));
    var cellsOf = function (row) {
      return isNative
        ? Array.prototype.slice.call(row.cells)
        : Array.prototype.slice.call(
            row.querySelectorAll(
              '[role="cell"],[role="gridcell"],[role="columnheader"],[role="rowheader"]',
            ),
          );
    };
    var headerRow = null;
    for (var i = 0; i < allRows.length; i++) {
      var r = allRows[i];
      var inHead = r.parentElement && r.parentElement.tagName === "THEAD";
      var allHeaders = cellsOf(r).every(function (c) {
        return c.tagName === "TH" || c.getAttribute("role") === "columnheader";
      });
      if (inHead || (allHeaders && cellsOf(r).length > 0)) headerRow = r;
      else if (headerRow) break;
    }
    var headers = headerRow
      ? cellsOf(headerRow).map(function (c, index) {
          return (
            norm(c.innerText !== undefined ? c.innerText : c.textContent) ||
            "column" + (index + 1)
          );
        })
      : [];
    var out = [];
    for (var j = 0; j < allRows.length; j++) {
      var row = allRows[j];
      if (row === headerRow) continue;
      if (row.parentElement && row.parentElement.tagName === "THEAD") continue;
      if (!visible(row)) continue;
      var record = {};
      cellsOf(row).forEach(function (c, index) {
        record[headers[index] || "column" + (index + 1)] = norm(
          c.innerText !== undefined ? c.innerText : c.textContent,
        );
      });
      out.push(record);
    }
    return out;
  }

  // Poll `predicate` (a function, or a selector that must be visible) until
  // it returns something truthy; resolves with that value. Rejects after
  // `timeoutMs` (default 5000) naming the last error the predicate threw.
  function waitFor(predicate, options) {
    var opts = options || {};
    var timeoutMs = Math.max(
      0,
      Math.min(Number(opts.timeoutMs) || 5000, MAX_WAIT_MS),
    );
    var intervalMs = Math.max(10, Number(opts.intervalMs) || 50);
    var probe =
      typeof predicate === "string"
        ? function () {
            var found = document.querySelector(predicate);
            return found && visible(found) ? found : null;
          }
        : predicate;
    if (typeof probe !== "function") {
      return Promise.reject(
        new Error(
          "__cairn.waitFor: predicate must be a function or a selector",
        ),
      );
    }
    var started = Date.now();
    var lastError = "";
    return new Promise(function (resolve, reject) {
      (function tick() {
        Promise.resolve()
          .then(function () {
            return probe();
          })
          .then(
            function (value) {
              return value;
            },
            function (error) {
              lastError =
                error && error.message ? error.message : String(error);
              return null;
            },
          )
          .then(function (value) {
            if (value) return resolve(value);
            if (Date.now() - started >= timeoutMs) {
              return reject(
                new Error(
                  "__cairn.waitFor: timed out after " +
                    timeoutMs +
                    "ms" +
                    (typeof predicate === "string"
                      ? " waiting for " + predicate
                      : "") +
                    (lastError ? " (last error: " + lastError + ")" : ""),
                ),
              );
            }
            setTimeout(tick, intervalMs);
          });
      })();
    });
  }

  // ----- app handles (config browser.appHandle) -----
  var handles = Object.freeze({});
  function setApp(defs) {
    var next = {};
    Object.keys(defs).forEach(function (name) {
      var read = defs[name];
      Object.defineProperty(next, name, {
        enumerable: true,
        get: function () {
          try {
            return read();
          } catch (error) {
            throw new Error(
              "__cairn.app." +
                name +
                ": " +
                (error && error.message ? error.message : String(error)),
            );
          }
        },
      });
    });
    handles = Object.freeze(next);
  }

  function pathParts(path) {
    return String(path)
      .replace(/\[(\d+)\]/g, ".$1")
      .split(".")
      .filter(function (part) {
        return part !== "";
      });
  }

  function same(a, b) {
    if (a === b) return true;
    if (typeof a === "number" && typeof b === "number")
      return a !== a && b !== b;
    if (
      a === null ||
      b === null ||
      typeof a !== "object" ||
      typeof b !== "object"
    )
      return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;
    if (Array.isArray(a)) {
      if (a.length !== b.length) return false;
      for (var i = 0; i < a.length; i++) if (!same(a[i], b[i])) return false;
      return true;
    }
    var ka = Object.keys(a);
    var kb = Object.keys(b);
    if (ka.length !== kb.length) return false;
    for (var j = 0; j < kb.length; j++) {
      if (
        !Object.prototype.hasOwnProperty.call(a, kb[j]) ||
        !same(a[kb[j]], b[kb[j]])
      )
        return false;
    }
    return true;
  }

  // A preview reaches the step error (run.json, events, report): values
  // under credential-like keys are masked, long or token-shaped strings are
  // shown by length, and the cut never lands inside a string, so a token's
  // prefix can never survive the artifact redactor.
  var SENSITIVE_KEY =
    /authorization|cookie|token|secret|passw(?:or)?d|pwd|passphrase|passcode|api[_-]?key|credential|otp|jwt|bearer|assertion|code[_-]?verifier|private[_-]?key/i;
  var PREVIEW_MAX = 200;
  var PREVIEW_STRING_MAX = 64;

  function looksLikeToken(s) {
    if (/^eyJ[\w-]+\.[\w-]+\./.test(s)) return true;
    return (
      /^[A-Za-z0-9_\-+/=.~]{24,}$/.test(s) &&
      /[0-9]/.test(s) &&
      /[A-Za-z]/.test(s)
    );
  }

  function shapeOf(value) {
    if (typeof value === "string")
      return "<string, " + value.length + " chars>";
    if (Array.isArray(value)) return "<array, " + value.length + " items>";
    if (value === null) return "null";
    return "<" + typeof value + ">";
  }

  function cutOutsideStrings(json, max) {
    if (json.length <= max) return json;
    var inString = false;
    var escaped = false;
    var safe = 0;
    for (var i = 0; i < max; i++) {
      var ch = json.charAt(i);
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === '"') {
          inString = false;
          safe = i + 1;
        }
      } else if (ch === '"') inString = true;
      else safe = i + 1;
    }
    return json.slice(0, safe) + "…";
  }

  function preview(value, sensitivePath) {
    // A credential-like path (`auth.token`) shows only type and length.
    if (sensitivePath) return shapeOf(value);
    var seen = [];
    var json;
    try {
      json = JSON.stringify(value, function (key, v) {
        if (typeof v === "function") return "[function]";
        if (key !== "" && SENSITIVE_KEY.test(key) && v != null)
          return "[redacted]";
        if (
          typeof v === "string" &&
          (v.length > PREVIEW_STRING_MAX || looksLikeToken(v))
        )
          return "<string, " + v.length + " chars>";
        if (v && typeof v === "object") {
          if (seen.indexOf(v) !== -1) return "[circular]";
          seen.push(v);
        }
        return v;
      });
    } catch {
      json = undefined;
    }
    if (json === undefined) return shapeOf(value);
    return cutOutsideStrings(json, PREVIEW_MAX);
  }

  // Read `<handle>.<path…>` and test it; never returns the live value (a
  // store object can be huge or circular), only a bounded preview.
  function appCheck(path, check) {
    var parts = pathParts(path);
    var name = parts[0];
    if (!name || !Object.prototype.hasOwnProperty.call(handles, name)) {
      return {
        ok: false,
        found: false,
        error: "no app handle " + JSON.stringify(name || ""),
      };
    }
    var value;
    try {
      value = handles[name];
    } catch (error) {
      return {
        ok: false,
        found: false,
        error: error && error.message ? error.message : String(error),
      };
    }
    for (var i = 1; i < parts.length; i++) {
      if (value === null || value === undefined) {
        return {
          ok: Boolean(check && check.exists === false),
          found: false,
          preview: "undefined",
        };
      }
      value = value[parts[i]];
    }
    var found = value !== undefined;
    var c = check || {};
    var ok;
    if (Object.prototype.hasOwnProperty.call(c, "exists"))
      ok = found === c.exists;
    else if (Object.prototype.hasOwnProperty.call(c, "in")) {
      ok =
        found &&
        c["in"].some(function (candidate) {
          return same(value, candidate);
        });
    } else ok = found && same(value, c.equals);
    return {
      ok: ok,
      found: found,
      preview: found
        ? preview(
            value,
            parts.some(function (part) {
              return SENSITIVE_KEY.test(part);
            }),
          )
        : "undefined",
    };
  }

  var api = {
    sleep: sleep,
    visible: visible,
    text: text,
    labelOf: labelOf,
    nativeSet: nativeSet,
    fire: fire,
    rows: rows,
    waitFor: waitFor,
  };
  Object.defineProperty(api, "app", {
    enumerable: true,
    get: function () {
      return handles;
    },
  });
  Object.defineProperty(api, "version", { value: VERSION, enumerable: true });
  Object.defineProperty(api, "__cairnPrelude", { value: VERSION });
  Object.defineProperty(api, "__setApp", { value: setApp });
  Object.defineProperty(api, "__appCheck", { value: appCheck });
  Object.freeze(api);
  setApp(appDefs || {});
  Object.defineProperty(w, "__cairn", {
    value: api,
    configurable: true,
    enumerable: false,
    writable: false,
  });
  return api;
}
