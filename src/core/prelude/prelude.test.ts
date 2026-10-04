import { createContext, runInContext, type Context } from "node:vm";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { InvocationResult } from "../../adapters/browserBackend";
import { WaitStepConditionSchema } from "../schema/spec.v1";
import { BrowserConfigSchema } from "../schema/config.v1";
import { runRunnerDrivenWait } from "../runner/waitGroups";
import {
  appCheckExpression,
  appHandleSyntaxError,
  parseAppCheckResult,
  preludeInstallExpression,
  usesCairnPrelude,
  withCairnPrelude,
} from "./prelude";

/**
 * The prelude against a fake page: a vm context whose global is `window`
 * and a fake app store (no DOM — the DOM helpers run in real Chromium in
 * prelude.chromium.test.ts).
 */

interface FakeStore {
  state: { user: { id: number; roles: string[] } | null; ready: boolean };
  getters: Record<string, unknown>;
}

function fakePage(): { context: Context; store: FakeStore } {
  const store: FakeStore = {
    state: { user: null, ready: false },
    getters: {},
  };
  Object.defineProperty(store.getters, "auth/isLoggedIn", {
    enumerable: true,
    get: () => store.state.user !== null,
  });
  const sandbox: Record<string, unknown> = { appStore: store };
  sandbox["window"] = sandbox;
  return { context: createContext(sandbox), store };
}

const HANDLES = {
  store: "window.appStore",
  user: "window.appStore.state.user",
  broken: "window.missing.deep",
};

describe("prelude source handling", () => {
  it("only touches sources that mention __cairn", () => {
    const plain = "return document.title;";
    expect(usesCairnPrelude(plain)).toBe(false);
    expect(withCairnPrelude(plain, HANDLES)).toBe(plain);
    expect(usesCairnPrelude("const x = window.__cairnCustom;")).toBe(false);
    const uses = "return __cairn.text('h1');";
    const wrapped = withCairnPrelude(uses, HANDLES);
    expect(wrapped.endsWith(`;\n${uses}`)).toBe(true);
    expect(wrapped).toContain("function cairnPreludeInstall");
    expect(wrapped).toContain(
      '"store": function () { return (window.appStore\n); }',
    );
    // Comments and indentation are dropped from the shipped page source.
    expect(wrapped).not.toMatch(/^\s*\/\/ /m);
  });

  it("reports app handle expressions that do not parse", () => {
    expect(appHandleSyntaxError("window.app.$store.getters['a/b']")).toBe(
      undefined,
    );
    expect(appHandleSyntaxError("window.app.(")).toMatch(/Unexpected/);
    const parsed = BrowserConfigSchema.safeParse({
      appHandle: { store: "window.app.(", "bad-name": "x" },
    });
    expect(parsed.success).toBe(false);
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "browser.appHandle expression does not parse",
    );
    expect(JSON.stringify(parsed.error?.issues)).toContain(
      "browser.appHandle names are identifiers",
    );
  });
});

describe("window.__cairn install", () => {
  it("installs once, read-only and namespaced, and refreshes app handles", () => {
    const { context, store } = fakePage();
    const first = runInContext(preludeInstallExpression(HANDLES), context);
    const second = runInContext(
      preludeInstallExpression({ ...HANDLES, extra: "1 + 1" }),
      context,
    );
    expect(second).toBe(first);
    expect(
      runInContext("Object.keys(window).includes('__cairn')", context),
    ).toBe(false);
    expect(runInContext("typeof window.__cairn.waitFor", context)).toBe(
      "function",
    );
    expect(runInContext("window.__cairn.app.extra", context)).toBe(2);
    store.state.user = { id: 7, roles: ["admin"] };
    expect(runInContext("window.__cairn.app.user.id", context)).toBe(7);
    // Accessors and the namespace are read-only.
    expect(() =>
      runInContext('"use strict"; window.__cairn.app.user = null;', context),
    ).toThrow(/Cannot (set|assign|redefine)|read.only/);
    expect(() =>
      runInContext('"use strict"; window.__cairn = {};', context),
    ).toThrow(/Cannot (set|assign|redefine)|read.only/);
    expect(() =>
      runInContext('"use strict"; window.__cairn.sleep = null;', context),
    ).toThrow(/Cannot (set|assign|redefine)|read.only/);
    expect(() => runInContext("window.__cairn.app.broken", context)).toThrow(
      /__cairn\.app\.broken: /,
    );
  });

  it("never overwrites a page-owned window.__cairn", () => {
    const { context } = fakePage();
    runInContext("window.__cairn = { mine: true };", context);
    expect(() =>
      runInContext(preludeInstallExpression(HANDLES), context),
    ).toThrow(/already defined by the page/);
    expect(runInContext("window.__cairn.mine", context)).toBe(true);
  });
});

describe("app checks", () => {
  const check = (
    context: Context,
    path: string,
    c: Parameters<typeof appCheckExpression>[1],
  ) =>
    parseAppCheckResult(
      JSON.stringify(
        runInContext(appCheckExpression(path, c, HANDLES), context),
      ),
    );

  it("compares paths with equals / in / exists and keeps the value in the page", () => {
    const { context, store } = fakePage();
    expect(check(context, "user.id", { equals: 7 })).toMatchObject({
      ok: false,
      found: false,
    });
    expect(check(context, "user.id", { exists: false }).ok).toBe(true);
    store.state.user = { id: 7, roles: ["admin", "editor"] };
    expect(check(context, "user.id", { equals: 7 })).toEqual({
      ok: true,
      found: true,
      preview: "7",
    });
    expect(
      check(context, "store.state.user", {
        equals: { id: 7, roles: ["admin", "editor"] },
      }).ok,
    ).toBe(true);
    expect(
      check(context, "user.roles[1]", { in: ["viewer", "editor"] }).ok,
    ).toBe(true);
    expect(
      check(context, "store.getters.auth/isLoggedIn", { equals: true }).ok,
    ).toBe(true);
    expect(check(context, "store.state.ready", { exists: true }).ok).toBe(true);
    expect(check(context, "nope.x", { exists: true })).toMatchObject({
      ok: false,
      error: 'no app handle "nope"',
    });
    expect(check(context, "broken", { exists: true }).error).toMatch(
      /^__cairn\.app\.broken: /,
    );
  });

  it("masks credentials in a preview and never cuts inside a string", () => {
    const { context, store } = fakePage();
    // Token-shaped values built at runtime (no secret-shaped literal).
    const token = `eyJ${"h".repeat(20)}.${"p1".repeat(60)}.${"s".repeat(20)}`;
    const opaque = Array.from({ length: 30 }, (_, i) => `k${i % 10}`).join("");
    const state = store.state as unknown as Record<string, unknown>;
    state["auth"] = { token, user: "ada", sessionId: opaque };
    state["note"] = "x".repeat(300);
    const whole = check(context, "store.state.auth", { exists: false });
    expect(whole.ok).toBe(false);
    expect(whole.preview).toBe(
      '{"token":"[redacted]","user":"ada","sessionId":"<string, 60 chars>"}',
    );
    // A credential-like path shows only type and length.
    const path = check(context, "store.state.auth.token", { exists: false });
    expect(path.preview).toBe(`<string, ${token.length} chars>`);
    const long = check(context, "store.state.note", { equals: "y" });
    expect(long.preview).toBe('"<string, 300 chars>"');
    for (const result of [whole, path, long]) {
      expect(result.preview).not.toContain(token.slice(0, 12));
      expect(result.preview).not.toContain(opaque.slice(0, 12));
    }
  });

  it("previews circular and large values without throwing", () => {
    const { context, store } = fakePage();
    const loop: Record<string, unknown> = { name: "x".repeat(500) };
    loop["self"] = loop;
    (store.state as unknown as Record<string, unknown>)["loop"] = loop;
    const result = check(context, "store.state.loop", { exists: true });
    expect(result.ok).toBe(true);
    expect(result.preview!.length).toBeLessThanOrEqual(201);
  });
});

/** A backend whose evaluate runs the expression in the fake page. */
function vmBackend(context: Context): MockBrowserBackend {
  const backend = new MockBrowserBackend();
  backend.evaluate = async (js: string): Promise<InvocationResult> => {
    try {
      const value: unknown = runInContext(js, context);
      return {
        ok: true,
        stdout: JSON.stringify(value ?? null),
        stderr: "",
        exitCode: 0,
        durationMs: 0,
        argv: ["eval"],
      };
    } catch (error) {
      return {
        ok: false,
        stdout: "",
        stderr: (error as Error).message,
        exitCode: 1,
        durationMs: 0,
        argv: ["eval"],
      };
    }
  };
  return backend;
}

describe("wait: { app }", () => {
  it("polls the store until the value holds", async () => {
    const { context, store } = fakePage();
    const backend = vmBackend(context);
    let polls = 0;
    const evaluate = backend.evaluate.bind(backend);
    backend.evaluate = async (js, opts) => {
      polls++;
      if (polls === 3) store.state.user = { id: 42, roles: [] };
      return evaluate(js, opts);
    };
    const wait = WaitStepConditionSchema.parse({
      app: { path: "user.id", equals: 42 },
      timeoutMs: 5000,
    });
    const result = await runRunnerDrivenWait(wait, backend, {
      appHandles: HANDLES,
    });
    expect(result).toMatchObject({ ok: true, matched: true });
    expect(polls).toBe(3);
  });

  it("reports the last value seen when it never holds, and passes when optional", async () => {
    const { context, store } = fakePage();
    store.state.user = { id: 1, roles: [] };
    const backend = vmBackend(context);
    const wait = WaitStepConditionSchema.parse({
      app: { path: "user.id", equals: 2 },
      timeoutMs: 600,
    });
    const missed = await runRunnerDrivenWait(wait, backend, {
      appHandles: HANDLES,
    });
    expect(missed.ok).toBe(false);
    expect(missed.detail).toBe(
      "wait: app user.id equals 2 did not hold within 600ms (app user.id equals 2: value was 1)",
    );
    const optional = await runRunnerDrivenWait(
      WaitStepConditionSchema.parse({
        app: { path: "user.id", equals: 2 },
        timeoutMs: 300,
        optional: true,
        assign: "seen",
      }),
      backend,
      { appHandles: HANDLES },
    );
    expect(optional).toMatchObject({ ok: true, matched: false });
  });

  it("fails at once when the handle is not configured", async () => {
    const { context } = fakePage();
    const backend = vmBackend(context);
    let polls = 0;
    const evaluate = backend.evaluate.bind(backend);
    backend.evaluate = async (js, opts) => {
      polls++;
      return evaluate(js, opts);
    };
    const result = await runRunnerDrivenWait(
      WaitStepConditionSchema.parse({
        any: [{ text: "Saved" }, { app: { path: "cart.count", exists: true } }],
        timeoutMs: 30_000,
      }),
      backend,
      { appHandles: HANDLES },
    );
    expect(result.ok).toBe(false);
    expect(result.detail).toBe(
      'wait.app: no browser.appHandle named "cart" (configured: store, user, broken)',
    );
    expect(polls).toBe(0);
  });

  it("validates the step shape", () => {
    expect(
      WaitStepConditionSchema.safeParse({
        app: { path: "store.user", equals: 1, exists: true },
      }).success,
    ).toBe(false);
    expect(
      WaitStepConditionSchema.safeParse({ app: { path: "1bad", exists: true } })
        .success,
    ).toBe(false);
    expect(
      WaitStepConditionSchema.safeParse({
        app: { path: "store.items[0].status", in: ["done"] },
      }).success,
    ).toBe(true);
  });
});
