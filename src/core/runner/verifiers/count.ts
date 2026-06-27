import type { BrowserBackend } from "../../../adapters/browserBackend";
import type { CountVerifier } from "../../schema/verifier.v1";
import type { VerifierEvaluation } from "./types";

/**
 * Counts elements matching role/selector in an optional in_region.
 *
 * `role` is translated to a CSS selector list covering both the explicit
 * `[role=X]` attribute AND the native elements that carry that role implicitly
 * (`role: row` → `[role=row], tr`), so a normal `<table>` is counted. This is a
 * heuristic: it doesn't account for `role` overrides on native elements (an
 * `<a role="button">` is matched by both the link and button mappings). For
 * exact ARIA semantics use a `selector`. `in_region` is prepended as an
 * ancestor. Text-based counting is rejected by the schema — use the `text`
 * verifier for presence or the `script` escape hatch.
 */
export async function evaluateCount(
  verifier: CountVerifier,
  backend: BrowserBackend,
): Promise<VerifierEvaluation> {
  const c = verifier.count;
  const selector = buildSelector(c);
  const count = await backend.getCount(selector);

  let expected: string;
  let passed: boolean;

  if (c.equals !== undefined) {
    expected = `exactly ${c.equals} element(s) matching ${JSON.stringify(selector)}`;
    passed = count === c.equals;
  } else if (c.atLeast !== undefined) {
    expected = `at least ${c.atLeast} element(s) matching ${JSON.stringify(selector)}`;
    passed = count >= c.atLeast;
  } else if (c.atMost !== undefined) {
    expected = `at most ${c.atMost} element(s) matching ${JSON.stringify(selector)}`;
    passed = count <= c.atMost;
  } else if (c.between !== undefined) {
    const [lo, hi] = c.between;
    expected = `between ${lo} and ${hi} element(s) matching ${JSON.stringify(selector)}`;
    passed = count >= lo && count <= hi;
  } else {
    expected = "<invalid count matcher>";
    passed = false;
  }

  return {
    passed,
    expected,
    actual: `observed ${count} element(s)`,
  };
}

function buildSelector(c: CountVerifier["count"]): string {
  if (c.selector) {
    return c.in_region ? `${c.in_region} ${c.selector}` : c.selector;
  }
  if (c.role) {
    const alts = roleSelectors(c.role);
    const scoped = c.in_region ? alts.map((a) => `${c.in_region} ${a}`) : alts;
    return scoped.join(", ");
  }
  // Schema guarantees role or selector is present; this is an unreachable guard.
  return c.in_region ?? "*:not(*)";
}

/**
 * Native HTML elements that carry an ARIA role implicitly, so `count: { role }`
 * matches semantic markup, not just elements with an explicit `role` attribute.
 */
const IMPLICIT_ROLE_NATIVES: Record<string, string[]> = {
  row: ["tr"],
  cell: ["td"],
  gridcell: ["td"],
  columnheader: ["th"],
  rowheader: ["th"],
  table: ["table"],
  button: [
    "button",
    "input[type=button]",
    "input[type=submit]",
    "input[type=reset]",
  ],
  link: ["a[href]"],
  list: ["ul", "ol"],
  listitem: ["li"],
  heading: ["h1", "h2", "h3", "h4", "h5", "h6"],
  textbox: ["input:not([type])", "input[type=text]", "textarea"],
  checkbox: ["input[type=checkbox]"],
  radio: ["input[type=radio]"],
  img: ["img"],
  navigation: ["nav"],
  banner: ["header"],
  contentinfo: ["footer"],
  main: ["main"],
  article: ["article"],
  complementary: ["aside"],
  combobox: ["select"],
  option: ["option"],
  region: ["section"],
};

function roleSelectors(role: string): string[] {
  const natives = IMPLICIT_ROLE_NATIVES[role.toLowerCase()] ?? [];
  return [`[role=${cssEscape(role)}]`, ...natives];
}

function cssEscape(s: string): string {
  // Minimal CSS attribute-value escape (no quotes; simple alphanumerics common for role names).
  return /^[a-zA-Z0-9_-]+$/.test(s) ? s : `"${s.replace(/"/g, '\\"')}"`;
}
