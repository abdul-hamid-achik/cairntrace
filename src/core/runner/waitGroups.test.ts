import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { InvocationResult } from "../../adapters/browserBackend";
import { evaluateWhen, formatWhen, whenForEvidence } from "./conditions";
import {
  probeWaitCondition,
  runRunnerDrivenWait,
  runnerWaitInvocation,
  selectorStateExpression,
} from "./waitGroups";
import { runResilientBrowserStep } from "./interactionResilience";

interface FakeElement {
  textContent: string;
  display?: string;
  width?: number;
}

/** Evaluate a selector-state expression against a fake DOM. */
function evalAgainst(expression: string, elements: FakeElement[]): unknown {
  const document = { querySelectorAll: () => elements };
  const window = {
    getComputedStyle: (el: FakeElement) => ({
      display: el.display ?? "block",
      visibility: "visible",
    }),
  };
  for (const el of elements) {
    (
      el as FakeElement & { getBoundingClientRect: () => object }
    ).getBoundingClientRect = () => ({ width: el.width ?? 10, height: 10 });
  }
  return new Function("document", "window", `return ${expression};`)(
    document,
    window,
  );
}

describe("selectorStateExpression", () => {
  it("implements attached / detached / visible / hidden and hasText", () => {
    const shown = [{ textContent: "Upload  data" }];
    const hidden = [{ textContent: "Upload data", display: "none" }];
    expect(evalAgainst(selectorStateExpression(".x", "visible"), shown)).toBe(
      true,
    );
    expect(evalAgainst(selectorStateExpression(".x", "visible"), hidden)).toBe(
      false,
    );
    expect(evalAgainst(selectorStateExpression(".x", "hidden"), hidden)).toBe(
      true,
    );
    expect(evalAgainst(selectorStateExpression(".x", "attached"), hidden)).toBe(
      true,
    );
    expect(evalAgainst(selectorStateExpression(".x", "detached"), [])).toBe(
      true,
    );
    expect(evalAgainst(selectorStateExpression(".x", "hidden"), [])).toBe(true);
    expect(
      evalAgainst(
        selectorStateExpression(".x", "visible", "upload DATA"),
        shown,
      ),
    ).toBe(true);
    expect(
      evalAgainst(selectorStateExpression(".x", "visible", "other"), shown),
    ).toBe(false);
  });
});

/** A mock whose evaluate answers a fixed boolean (DOM predicates). */
class PredicateBackend extends MockBrowserBackend {
  constructor(private readonly answer: boolean) {
    super();
  }
  override async evaluate(): Promise<InvocationResult> {
    return {
      ok: true,
      stdout: JSON.stringify(this.answer),
      stderr: "",
      exitCode: 0,
      durationMs: 0,
      argv: ["eval"],
    };
  }
}

describe("runner-driven waits", () => {
  it("probes text, url, ms, selector and load", async () => {
    const backend = new MockBrowserBackend();
    backend.setPageText("Order SAVED");
    backend.setUrl("http://app.test/orders/7");
    expect((await probeWaitCondition({ text: "saved" }, backend, 0)).ok).toBe(
      true,
    );
    expect(
      (
        await probeWaitCondition(
          { text: "saved", caseSensitive: true },
          backend,
          0,
        )
      ).ok,
    ).toBe(false);
    expect(
      (await probeWaitCondition({ notText: "Draft" }, backend, 0)).ok,
    ).toBe(true);
    expect(
      (
        await probeWaitCondition(
          { url: { pattern: "/orders/\\d+$" } },
          backend,
          0,
        )
      ).ok,
    ).toBe(true);
    expect((await probeWaitCondition({ ms: 500 }, backend, 499)).ok).toBe(
      false,
    );
    expect((await probeWaitCondition({ ms: 500 }, backend, 500)).ok).toBe(true);
    const dom = new PredicateBackend(true);
    expect((await probeWaitCondition({ selector: ".row" }, dom, 0)).ok).toBe(
      true,
    );
    expect((await probeWaitCondition({ load: "networkidle" }, dom, 0)).ok).toBe(
      true,
    );
  });

  it("any returns the first condition that held; all needs every one", async () => {
    const backend = new MockBrowserBackend();
    backend.setPageText("Already exists");
    const any = await runRunnerDrivenWait(
      { any: [{ text: "Saved" }, { text: "Already exists" }], timeoutMs: 500 },
      backend,
    );
    expect(any).toMatchObject({ ok: true, matched: true, index: 1 });
    const all = await runRunnerDrivenWait(
      { all: [{ text: "Already" }, { text: "Saved" }], timeoutMs: 500 },
      backend,
    );
    expect(all).toMatchObject({ ok: false, matched: false });
    expect(all.detail).toContain(
      "wait.all: not all of 2 condition(s) held within 500ms",
    );
  });

  it("an any can hold on a timer branch (ms) once its time has passed", async () => {
    const backend = new MockBrowserBackend();
    const raced = await runRunnerDrivenWait(
      { any: [{ text: "Never" }, { ms: 750 }], timeoutMs: 5000 },
      backend,
    );
    expect(raced).toMatchObject({ ok: true, index: 1 });
  });

  it("an optional miss passes; a failing read is reported, not thrown", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueValue(new Error("no element matches label Country"));
    const missed = await runRunnerDrivenWait(
      {
        value: { by: "label", name: "Country", equals: "Peru" },
        timeoutMs: 100,
        optional: true,
      },
      backend,
    );
    expect(missed).toMatchObject({ ok: true, matched: false });
    expect(missed.detail).toContain("optional");
    expect(runnerWaitInvocation(missed)).toMatchObject({
      ok: true,
      stdout: JSON.stringify({ matched: false }),
    });
  });

  it("reads a value condition with one bounded page probe, never the backend's locator wait", async () => {
    const backend = new MockBrowserBackend();
    backend.setPageText("Hello there");
    let getValueCalls = 0;
    // A backend getValue blocks for its locator timeout on an absent element.
    backend.getValue = async () => {
      getValueCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      return "";
    };
    const started = Date.now();
    const raced = await runRunnerDrivenWait(
      {
        any: [
          { value: { by: "selector", selector: "#missing", equals: "x" } },
          { text: "Hello" },
        ],
        timeoutMs: 2000,
      },
      backend,
    );
    expect(raced).toMatchObject({ ok: true, matched: true, index: 1 });
    const optional = await runRunnerDrivenWait(
      {
        value: { by: "selector", selector: "#missing", equals: "x" },
        timeoutMs: 300,
        optional: true,
      },
      backend,
    );
    expect(optional).toMatchObject({ ok: true, matched: false });
    expect(optional.detail).toContain("no element matches #missing");
    expect(Date.now() - started).toBeLessThan(3000);
    expect(getValueCalls).toBe(0);

    // A present control is compared through the same probe.
    backend.enqueueEvalResult({
      total: 1,
      visibleCount: 1,
      poolCount: 1,
      matches: [
        {
          visible: true,
          text: "",
          value: "Peru",
          attribute: null,
          hasAttribute: false,
          enabled: true,
          tag: "input",
        },
      ],
    });
    const held = await runRunnerDrivenWait(
      {
        value: { by: "label", name: "Country", equals: "Peru" },
        timeoutMs: 1000,
      },
      backend,
      { testIdAttribute: "data-qa" },
    );
    expect(held).toMatchObject({ ok: true, matched: true });
  });

  it("runResilientBrowserStep polls groups itself and strips step keys from plain waits", async () => {
    const backend = new MockBrowserBackend();
    backend.setStrictStepValidation();
    backend.setPageText("ready");
    const grouped = await runResilientBrowserStep(
      { wait: { any: [{ text: "ready" }], timeoutMs: 100 } },
      backend,
      1,
    );
    expect(grouped.ok).toBe(true);
    expect(backend.stepLog).toEqual([]);
    const plain = await runResilientBrowserStep(
      { wait: { text: "ready", assign: "seen" } },
      backend,
      1,
    );
    expect(plain.ok).toBe(true);
    expect(backend.stepLog).toEqual([{ wait: { text: "ready" } }]);
  });
});

describe("when: url and var predicates", () => {
  it("evaluates url matchers and var predicates (resolved value wins for plain names)", async () => {
    const backend = new MockBrowserBackend();
    backend.setUrl("http://app.test/done");
    expect(await evaluateWhen({ url: { includes: "/done" } }, backend)).toBe(
      true,
    );
    expect(await evaluateWhen({ url: { equals: "/done" } }, backend)).toBe(
      false,
    );
    const ctx = {
      lookupVar: (name: string) =>
        ({ mode: "slow", "waits.banner.matched": "true" })[name],
    };
    expect(
      await evaluateWhen(
        { var: "mode", equals: "fast", resolved: "fast" },
        backend,
        ctx,
      ),
    ).toBe(true);
    expect(
      await evaluateWhen({ var: "mode", equals: "slow" }, backend, ctx),
    ).toBe(true);
    expect(
      await evaluateWhen(
        { var: "waits.banner.matched", equals: true },
        backend,
        ctx,
      ),
    ).toBe(true);
    expect(
      await evaluateWhen({ var: "region", exists: false }, backend, ctx),
    ).toBe(true);
    expect(
      await evaluateWhen({ var: "region", in: ["eu"] }, backend, ctx),
    ).toBe(false);
  });

  it("never narrates or records the parser-resolved value", () => {
    const when = { var: "token", exists: true, resolved: "s3cr3t-value" };
    expect(formatWhen(when)).toBe("var:token exists:true");
    expect(whenForEvidence(when)).toEqual({ var: "token", exists: true });
    expect(formatWhen({ url: { includes: "/x" } })).toBe('url includes "/x"');
  });
});
