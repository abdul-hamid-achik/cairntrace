import type { BrowserBackend } from "../../adapters/browserBackend";
import type { WhenObject } from "../schema/spec.v1";
import {
  textContains,
  visibleSelectorHasTextExpression,
} from "../textMatching";

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
 *   - text:<substring>          ← body text, whitespace-normalized + case-insensitive
 *   - notText:<substring>       ← same normalization as text:
 *   - selector:<css>            ← document.querySelector is non-null
 *   - notSelector:<css>         ← document.querySelector is null
 *
 * `urlContains`/`urlNotContains` stay raw (URLs are case- and
 * whitespace-significant); `text`/`notText` share the rendered-text
 * normalization used by the `text`/`notText` verifiers so a `when:` gate and an
 * outcome assertion on the same copy agree. `urlMatches` regex stays raw.
 * `selector`/`notSelector` are live DOM checks — use them when the same copy
 * also lives in a card concat (body `text:` false-positives).
 */

export type WhenCondition =
  | { kind: "urlContains"; arg: string }
  | { kind: "urlNotContains"; arg: string }
  | { kind: "urlMatches"; arg: string }
  | { kind: "text"; arg: string }
  | { kind: "notText"; arg: string }
  | { kind: "selector"; arg: string }
  | { kind: "notSelector"; arg: string };

const KIND_PATTERN =
  /^(urlContains|urlNotContains|urlMatches|text|notText|selector|notSelector):/;

export function parseWhen(when: string): WhenCondition {
  const m = KIND_PATTERN.exec(when);
  if (!m) {
    throw new Error(
      `invalid when: "${when}" — expected one of urlContains|urlNotContains|urlMatches|text|notText|selector|notSelector followed by ":<arg>"`,
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

export function formatWhen(when: string | WhenObject): string {
  if (typeof when === "string") return when;
  return Object.entries(when)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}:${value}`)
    .join(" ");
}

export async function evaluateWhen(
  when: string | WhenObject,
  backend: BrowserBackend,
): Promise<boolean> {
  if (typeof when !== "string") {
    return evaluateWhenObject(when, backend);
  }
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
      return textContains(body, cond.arg);
    }
    case "notText": {
      const body = await backend.getText("page");
      return !textContains(body, cond.arg);
    }
    case "selector":
      return evalDocumentPredicate(
        backend,
        `document.querySelector(${JSON.stringify(cond.arg)}) !== null`,
      );
    case "notSelector":
      return !(await evalDocumentPredicate(
        backend,
        `document.querySelector(${JSON.stringify(cond.arg)}) !== null`,
      ));
  }
}

async function evaluateWhenObject(
  when: WhenObject,
  backend: BrowserBackend,
): Promise<boolean> {
  if (when.urlContains !== undefined) {
    return (await backend.getUrl()).includes(when.urlContains);
  }
  if (when.urlNotContains !== undefined) {
    return !(await backend.getUrl()).includes(when.urlNotContains);
  }
  if (when.urlMatches !== undefined) {
    return new RegExp(when.urlMatches).test(await backend.getUrl());
  }
  if (when.text !== undefined) {
    return textContains(await backend.getText("page"), when.text);
  }
  if (when.notText !== undefined) {
    return !textContains(await backend.getText("page"), when.notText);
  }
  if (when.selector !== undefined) {
    const expression = when.hasText
      ? visibleSelectorHasTextExpression(when.selector, when.hasText)
      : `document.querySelector(${JSON.stringify(when.selector)}) !== null`;
    return evalDocumentPredicate(backend, expression);
  }
  if (when.notSelector !== undefined) {
    return !(await evalDocumentPredicate(
      backend,
      `document.querySelector(${JSON.stringify(when.notSelector)}) !== null`,
    ));
  }
  return false;
}

async function evalDocumentPredicate(
  backend: BrowserBackend,
  expression: string,
): Promise<boolean> {
  const result = await backend.evaluate(expression);
  if (!result.ok) return false;
  const trimmed = (result.stdout || "").trim();
  if (trimmed === "true") return true;
  if (trimmed === "false" || trimmed === "") return false;
  try {
    const parsed = JSON.parse(trimmed) as {
      data?: { result?: unknown };
      result?: unknown;
    };
    const value = parsed.data?.result ?? parsed.result ?? parsed;
    return value === true;
  } catch {
    return false;
  }
}
