import type { BrowserBackend } from "../../adapters/browserBackend";

/**
 * Tiny DSL for step-level `when:` predicates. Specs use these to skip steps
 * that don't apply to the current state — e.g., skip `login_admin` if already
 * authenticated.
 *
 * Syntax:  `<kind>:<arg>`
 *
 * Supported kinds:
 *   - urlContains:<substring>
 *   - urlNotContains:<substring>
 *   - urlMatches:<regex>
 *   - text:<substring>          ← matches against body text
 *   - notText:<substring>
 */

export type WhenCondition =
  | { kind: "urlContains"; arg: string }
  | { kind: "urlNotContains"; arg: string }
  | { kind: "urlMatches"; arg: string }
  | { kind: "text"; arg: string }
  | { kind: "notText"; arg: string };

const KIND_PATTERN = /^(urlContains|urlNotContains|urlMatches|text|notText):/;

export function parseWhen(when: string): WhenCondition {
  const m = KIND_PATTERN.exec(when);
  if (!m) {
    throw new Error(
      `invalid when: "${when}" — expected one of urlContains|urlNotContains|urlMatches|text|notText followed by ":<arg>"`,
    );
  }
  const kind = m[1] as WhenCondition["kind"];
  const arg = when.slice(m[0].length);
  if (arg.length === 0) {
    throw new Error(
      `invalid when: "${when}" — empty argument after "${kind}:"`,
    );
  }
  return { kind, arg } as WhenCondition;
}

export async function evaluateWhen(
  when: string,
  backend: BrowserBackend,
): Promise<boolean> {
  const cond = parseWhen(when);
  switch (cond.kind) {
    case "urlContains": {
      const url = await backend.getUrl();
      return url.includes(cond.arg);
    }
    case "urlNotContains": {
      const url = await backend.getUrl();
      return !url.includes(cond.arg);
    }
    case "urlMatches": {
      const url = await backend.getUrl();
      return new RegExp(cond.arg).test(url);
    }
    case "text": {
      const body = await backend.getText("page");
      return body.includes(cond.arg);
    }
    case "notText": {
      const body = await backend.getText("page");
      return !body.includes(cond.arg);
    }
  }
}
