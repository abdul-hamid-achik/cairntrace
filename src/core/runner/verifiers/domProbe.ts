import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { VerifierLocator } from "../../schema/verifier.v1";

/**
 * One page-side probe for `expect` / `capture` steps and the `table`
 * verifier, through `backend.evaluate` (agent-browser, Playwright, mock).
 *
 * Resolution follows the authoring rules for semantic locators —
 * accessible name, whole-name, whitespace-normalized, case-insensitive
 * (`exact: true` for case-sensitive), visible-only unless the caller asks
 * for hidden matches; `near` keeps the matches whose nearest ancestor
 * containing that text is closest, `hasText` keeps matches whose text
 * contains it. Roles and names are computed in the page (explicit `role`,
 * then the implicit HTML role; aria-labelledby → aria-label → labels / alt /
 * title / placeholder → content), so they can differ from a backend's
 * snapshot in edge cases; prefer `by: testid` / `by: selector` when exact
 * DOM identity matters.
 *
 * The locator travels into the page as a JSON literal (data), never as
 * spliced source.
 */

export interface ProbeMatch {
  visible: boolean;
  text: string;
  value: string | null;
  attribute: string | null;
  hasAttribute: boolean;
  enabled: boolean;
  tag: string;
}

export interface ProbeTable {
  headers: string[];
  rows: string[][];
  rowCount: number;
}

export interface ProbeResult {
  /** Matches after near/hasText, hidden ones included. */
  total: number;
  visibleCount: number;
  /** The pool (visible-only for semantic locators unless includeHidden). */
  poolCount: number;
  /** Details of the first 50 pool matches, document order. */
  matches: ProbeMatch[];
  /** Details of pool[nth] when the locator carries `nth`. */
  nthMatch?: ProbeMatch | null;
  /** Table extracted from the single target (pool[nth ?? 0]). */
  table?: ProbeTable | null;
  error?: string;
}

export interface ProbeOptions {
  testIdAttribute?: string;
  /** Attribute value to read from every match. */
  attribute?: string;
  /** Extract a table from the target. */
  table?: boolean;
  /** Pool includes hidden matches even for semantic locators. */
  includeHidden?: boolean;
}

/** Locator fields the probe understands (spec and verifier locators). */
export type ProbeLocator = VerifierLocator;

export function isSemanticLocator(locator: ProbeLocator): boolean {
  return (
    locator.by === "role" || locator.by === "label" || locator.by === "text"
  );
}

export function describeProbeLocator(locator: ProbeLocator): string {
  const extra = [
    "nth" in locator && locator.nth !== undefined ? `nth ${locator.nth}` : "",
    locator.near ? `near ${JSON.stringify(locator.near)}` : "",
    locator.hasText ? `hasText ${JSON.stringify(locator.hasText)}` : "",
  ].filter(Boolean);
  let base: string;
  switch (locator.by) {
    case "role":
      base = `role=${locator.role}${
        locator.name !== undefined ? ` "${locator.name}"` : ""
      }`;
      break;
    case "label":
      base = `label "${locator.name}"`;
      break;
    case "text":
      base = `text "${locator.text}"`;
      break;
    case "selector":
      base = locator.selector;
      break;
    case "testid":
      base = `testid ${locator.testid}`;
      break;
  }
  return extra.length > 0 ? `${base} (${extra.join(", ")})` : base;
}

export function buildProbeScript(
  locator: ProbeLocator,
  opts: ProbeOptions = {},
): string {
  const config = {
    locator,
    testIdAttribute: opts.testIdAttribute ?? "data-testid",
    attribute: opts.attribute ?? null,
    table: opts.table === true,
    includeHidden:
      opts.includeHidden === true ||
      !isSemanticLocator(locator) ||
      ("visible" in locator && locator.visible === false),
  };
  return `(() => {\n  const cfg = ${JSON.stringify(config)};\n${PROBE_BODY}\n})()`;
}

export async function runProbe(
  backend: BrowserBackend,
  locator: ProbeLocator,
  opts: ProbeOptions = {},
  timeoutMs?: number,
): Promise<ProbeResult> {
  const result = await backend.evaluate(
    buildProbeScript(locator, opts),
    timeoutMs !== undefined ? { timeoutMs } : {},
  );
  if (!result.ok) {
    throw new Error(
      `page probe failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new Error(
      `page probe returned non-JSON output: ${result.stdout.slice(0, 200)}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new Error(`page probe returned ${result.stdout.slice(0, 200)}`);
  }
  const probe = parsed as Partial<ProbeResult>;
  if (typeof probe.error === "string") throw new Error(probe.error);
  return {
    total: Number(probe.total ?? 0),
    visibleCount: Number(probe.visibleCount ?? 0),
    poolCount: Number(probe.poolCount ?? 0),
    matches: Array.isArray(probe.matches) ? probe.matches : [],
    ...(probe.nthMatch !== undefined ? { nthMatch: probe.nthMatch } : {}),
    ...(probe.table !== undefined ? { table: probe.table } : {}),
  };
}

/**
 * The single target of a locator for value-style assertions: pool[nth], or
 * the only pool match; several matches narrow to the visible ones first.
 */
export function singleTarget(
  probe: ProbeResult,
  locator: ProbeLocator,
): { match?: ProbeMatch; error?: string } {
  const nth = "nth" in locator ? locator.nth : undefined;
  if (nth !== undefined) {
    return probe.nthMatch
      ? { match: probe.nthMatch }
      : {
          error: `nth ${nth} is out of range: ${probe.poolCount} match(es) for ${describeProbeLocator(locator)}`,
        };
  }
  if (probe.poolCount === 0) {
    return { error: `no element matches ${describeProbeLocator(locator)}` };
  }
  if (probe.poolCount === 1) return { match: probe.matches[0]! };
  const visible = probe.matches.filter((match) => match.visible);
  if (visible.length === 1 && probe.poolCount <= probe.matches.length) {
    return { match: visible[0]! };
  }
  return {
    error: `${probe.poolCount} elements match ${describeProbeLocator(locator)}; add nth (0-based) or a more specific locator`,
  };
}

const PROBE_BODY = String.raw`
  const norm = (s) => String(s == null ? "" : s).replace(/\s+/g, " ").trim();
  const lower = (s) => norm(s).toLowerCase();
  const same = (a, b, exact) => (exact ? norm(a) === norm(b) : lower(a) === lower(b));
  const cap = (s, n) => (s.length > n ? s.slice(0, n) : s);
  const isVisible = (el) => {
    if (!el || !el.isConnected) return false;
    if (typeof el.checkVisibility === "function") {
      if (!el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true })) return false;
    } else {
      const style = getComputedStyle(el);
      if (style.display === "none" || style.visibility === "hidden") return false;
    }
    const rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0 || el.getClientRects().length > 0;
  };
  const textOf = (el) => norm(el.innerText != null ? el.innerText : el.textContent);
  const byIds = (ids) =>
    norm(String(ids).split(/\s+/).map((id) => document.getElementById(id)).filter(Boolean).map(textOf).join(" "));
  const labelsOf = (el) => (el.labels ? Array.from(el.labels).map(textOf).filter(Boolean) : []);
  const implicitRole = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (/^h[1-6]$/.test(tag)) return "heading";
    switch (tag) {
      case "button": case "summary": return "button";
      case "a": case "area": return el.hasAttribute("href") ? "link" : null;
      case "input":
        if (type === "hidden") return null;
        if (["button", "submit", "reset", "image"].includes(type)) return "button";
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "range") return "slider";
        if (type === "number") return "spinbutton";
        if (type === "search") return el.hasAttribute("list") ? "combobox" : "searchbox";
        return el.hasAttribute("list") ? "combobox" : "textbox";
      case "textarea": return "textbox";
      case "select": return el.multiple || el.size > 1 ? "listbox" : "combobox";
      case "option": return "option";
      case "img": return el.getAttribute("alt") === "" ? "presentation" : "img";
      case "ul": case "ol": case "menu": return "list";
      case "li": return "listitem";
      case "table": return "table";
      case "thead": case "tbody": case "tfoot": return "rowgroup";
      case "tr": return "row";
      case "td": return "cell";
      case "th": return el.getAttribute("scope") === "row" ? "rowheader" : "columnheader";
      case "nav": return "navigation";
      case "main": return "main";
      case "header": return "banner";
      case "footer": return "contentinfo";
      case "aside": return "complementary";
      case "form": return "form";
      case "dialog": return "dialog";
      case "progress": return "progressbar";
      case "fieldset": return "group";
      case "article": return "article";
      case "section":
        return el.hasAttribute("aria-label") || el.hasAttribute("aria-labelledby") ? "region" : null;
      default: return null;
    }
  };
  const roleOf = (el) => {
    const explicit = (el.getAttribute("role") || "").trim().split(/\s+/)[0];
    return (explicit || implicitRole(el) || "").toLowerCase();
  };
  const NAME_FROM_CONTENT = ["button", "link", "heading", "cell", "gridcell", "columnheader", "rowheader",
    "option", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "checkbox", "radio", "switch",
    "treeitem", "listitem", "row", "tooltip"];
  const accName = (el) => {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) { const t = byIds(labelledBy); if (t) return t; }
    const ariaLabel = norm(el.getAttribute("aria-label"));
    if (ariaLabel) return ariaLabel;
    const tag = el.tagName.toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") {
      const type = (el.getAttribute("type") || "").toLowerCase();
      if (["button", "submit", "reset"].includes(type)) {
        return norm(el.value || (type === "submit" ? "Submit" : type === "reset" ? "Reset" : ""));
      }
      if (type === "image") return norm(el.getAttribute("alt"));
      const labels = labelsOf(el);
      if (labels.length > 0) return norm(labels.join(" "));
      return norm(el.getAttribute("title") || el.getAttribute("placeholder"));
    }
    if (tag === "img") return norm(el.getAttribute("alt") || el.getAttribute("title"));
    if (tag === "table") { const c = el.querySelector("caption"); if (c) return textOf(c); }
    if (tag === "fieldset") { const l = el.querySelector("legend"); if (l) return textOf(l); }
    if (NAME_FROM_CONTENT.includes(roleOf(el))) { const t = textOf(el); if (t) return t; }
    return norm(el.getAttribute("title"));
  };
  const labelNames = (el) => {
    const names = [];
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) names.push(byIds(labelledBy));
    names.push(norm(el.getAttribute("aria-label")));
    for (const l of labelsOf(el)) names.push(l);
    return names.filter(Boolean);
  };
  const loc = cfg.locator;
  const all = () => Array.from(document.body ? document.body.querySelectorAll("*") : []);
  let found;
  if (loc.by === "selector") {
    try { found = Array.from(document.querySelectorAll(loc.selector)); }
    catch (e) { return { error: "invalid selector " + JSON.stringify(loc.selector) + ": " + String(e && e.message || e) }; }
  } else if (loc.by === "testid") {
    const attr = cfg.testIdAttribute;
    found = Array.from(document.querySelectorAll("[" + CSS.escape(attr) + "]"))
      .filter((el) => el.getAttribute(attr) === loc.testid);
  } else if (loc.by === "role") {
    const role = String(loc.role).toLowerCase();
    found = all().filter((el) => roleOf(el) === role && (loc.name === undefined || same(accName(el), loc.name, loc.exact)));
  } else if (loc.by === "label") {
    found = all().filter((el) => labelNames(el).some((n) => same(n, loc.name, loc.exact)));
  } else {
    const hits = all().filter((el) => same(textOf(el), loc.text, loc.exact));
    found = hits.filter((el) => !hits.some((other) => other !== el && el.contains(other)));
  }
  if (loc.hasText) {
    const needle = lower(loc.hasText);
    found = found.filter((el) => lower(textOf(el)).includes(needle));
  }
  if (loc.near) {
    const needle = lower(loc.near);
    const distance = (el) => {
      let depth = 0;
      for (let node = el; node; node = node.parentElement, depth++) {
        if (lower(textOf(node)).includes(needle)) return depth;
      }
      return Infinity;
    };
    const scored = found.map((el) => [el, distance(el)]);
    const best = Math.min(...scored.map((pair) => pair[1]));
    found = best === Infinity ? [] : scored.filter((pair) => pair[1] === best).map((pair) => pair[0]);
  }
  const visibility = found.map(isVisible);
  const pool = cfg.includeHidden ? found : found.filter((_, i) => visibility[i]);
  const describe = (el) => {
    const isFormValue = "value" in el && ["INPUT", "TEXTAREA", "SELECT", "OPTION", "BUTTON"].includes(el.tagName);
    const disabled = el.disabled === true ||
      el.getAttribute("aria-disabled") === "true" ||
      Boolean(el.closest("fieldset[disabled]"));
    return {
      visible: isVisible(el),
      text: cap(textOf(el), 2000),
      value: isFormValue ? String(el.value) : el.isContentEditable ? cap(textOf(el), 2000) : null,
      attribute: cfg.attribute ? el.getAttribute(cfg.attribute) : null,
      hasAttribute: cfg.attribute ? el.hasAttribute(cfg.attribute) : false,
      enabled: !disabled,
      tag: el.tagName.toLowerCase(),
    };
  };
  const nth = typeof loc.nth === "number" ? loc.nth : undefined;
  const out = {
    total: found.length,
    visibleCount: visibility.filter(Boolean).length,
    poolCount: pool.length,
    matches: pool.slice(0, 50).map(describe),
  };
  if (nth !== undefined) out.nthMatch = pool[nth] ? describe(pool[nth]) : null;
  if (cfg.table) {
    const target = nth !== undefined ? pool[nth] : pool.length === 1 ? pool[0] : pool.find(isVisible);
    if (!target) {
      out.table = null;
    } else {
      const isTable = (el) => el.tagName === "TABLE" ||
        ["table", "grid", "treegrid"].includes((el.getAttribute("role") || "").toLowerCase());
      const table = isTable(target) ? target :
        (target.querySelector("table, [role=table], [role=grid], [role=treegrid]") || target);
      const rows = table.tagName === "TABLE" ? Array.from(table.rows) : Array.from(table.querySelectorAll("[role=row]"));
      const cellsOf = (row) => row.tagName === "TR" ? Array.from(row.cells) :
        Array.from(row.querySelectorAll("[role=cell], [role=gridcell], [role=columnheader], [role=rowheader]"));
      const isHeaderCell = (c) => c.tagName === "TH" || (c.getAttribute("role") || "") === "columnheader";
      let headerIndex = -1;
      for (let i = 0; i < rows.length; i++) {
        const cells = cellsOf(rows[i]);
        if (cells.length === 0) continue;
        const inHead = rows[i].parentElement && rows[i].parentElement.tagName === "THEAD";
        if (inHead || cells.every(isHeaderCell)) { headerIndex = i; break; }
        break;
      }
      const headers = headerIndex >= 0 ? cellsOf(rows[headerIndex]).map((c) => cap(textOf(c), 500)) : [];
      const data = rows
        .filter((row, i) => i !== headerIndex &&
          !(row.parentElement && row.parentElement.tagName === "THEAD") &&
          cellsOf(row).length > 0 && isVisible(row))
        .map((row) => cellsOf(row).map((c) => cap(textOf(c), 500)));
      out.table = { headers, rows: data.slice(0, 500), rowCount: data.length };
    }
  }
  return out;
`;
