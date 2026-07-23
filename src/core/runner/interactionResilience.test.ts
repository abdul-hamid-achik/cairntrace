import { describe, expect, it } from "vitest";
import type { Step } from "../schema/spec.v1";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import {
  applyWaitScale,
  resolveWaitScale,
  runResilientBrowserStep,
} from "./interactionResilience";

describe("runResilientBrowserStep", () => {
  it("passes a fill whose value survives the settle", async () => {
    const backend = new MockBrowserBackend();
    const result = await runResilientBrowserStep(
      {
        fill: { by: "label", name: "Name", value: "Ada" },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(true);
    expect(backend.stepLog).toHaveLength(1);
  });

  it("refills a value wiped by hydration", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueValue("");
    backend.enqueueValue("Ada");

    const result = await runResilientBrowserStep(
      {
        fill: { by: "selector", selector: "#name", value: "Ada" },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(true);
    expect(result.stderr).toContain(
      "input value survived hydration after 2 attempts",
    );
    expect(backend.stepLog).toHaveLength(2);
  });

  it("fails with hydration diagnostics after three retries", async () => {
    const backend = new MockBrowserBackend();
    for (let i = 0; i < 4; i++) backend.enqueueValue("");

    const result = await runResilientBrowserStep(
      {
        fill: { by: "selector", selector: "#name", value: "Ada" },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("hydration wiped value after 4 attempts");
    expect(result.stderr).toContain('expected "Ada", got ""');
    expect(backend.stepLog).toHaveLength(4);
  });

  it("clears before retrying character-by-character type", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueValue("A");
    backend.enqueueValue("Ada");

    const result = await runResilientBrowserStep(
      {
        type: { by: "selector", selector: "#name", value: "Ada" },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(true);
    expect(backend.stepLog).toEqual([
      { type: { by: "selector", selector: "#name", value: "Ada" } },
      {
        fill: { by: "selector", selector: "#name", value: "" },
        verifyFill: false,
      },
      { type: { by: "selector", selector: "#name", value: "Ada" } },
    ]);
  });

  it("honors verifyFill: false", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueValue(new Error("must not read"));

    const result = await runResilientBrowserStep(
      {
        fill: { by: "selector", selector: "#masked", value: "1234" },
        verifyFill: false,
      },
      backend,
      1,
    );

    expect(result.ok).toBe(true);
    expect(backend.stepLog).toHaveLength(1);
  });

  it("retries click until a selector disappears", async () => {
    const backend = new ClickEffectBackend(2, () =>
      backend.setCount("#editor", 0),
    );
    backend.setCount("#editor", 1);

    const result = await runResilientBrowserStep(
      {
        click: {
          by: "role",
          role: "button",
          name: "Save",
          until: { selectorGone: "#editor", timeoutMs: 50 },
        },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(true);
    expect(result.stderr).toContain(
      "click.until satisfied after 2 click attempts",
    );
    expect(backend.clicks).toBe(2);
    expect(backend.stepLog[0]).toEqual({
      click: { by: "role", role: "button", name: "Save" },
    });
  });

  it("fails click.until after at most four click attempts", async () => {
    const backend = new ClickEffectBackend();

    const result = await runResilientBrowserStep(
      {
        click: {
          by: "selector",
          selector: "#save",
          until: { text: "Saved", timeoutMs: 10 },
        },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(
      "was not satisfied after 4 click attempts within 10ms",
    );
    expect(backend.clicks).toBe(4);
  });
});

describe("wait scaling", () => {
  it("uses CAIRN_WAIT_SCALE over config", () => {
    expect(resolveWaitScale(2, "3")).toBe(3);
    expect(resolveWaitScale(2, undefined)).toBe(2);
    expect(resolveWaitScale(undefined, undefined)).toBe(1);
    expect(() => resolveWaitScale(2, "0")).toThrow(/CAIRN_WAIT_SCALE/);
  });

  it("scales wait, open, settle, and batch wait budgets", () => {
    expect(
      applyWaitScale({ wait: { text: "Ready", timeoutMs: 1_000 } }, 3),
    ).toEqual({ wait: { text: "Ready", timeoutMs: 3_000 } });
    expect(
      applyWaitScale({ open: { path: "/slow", waitUntil: "networkidle" } }, 3),
    ).toEqual({
      open: {
        path: "/slow",
        waitUntil: "networkidle",
        timeoutMs: 90_000,
      },
    });
    expect(
      applyWaitScale(
        {
          click: { by: "selector", selector: "#save" },
          settleMs: 2_000,
        },
        3,
      ),
    ).toMatchObject({ settleMs: 6_000 });
    expect(
      applyWaitScale(
        { batch: [{ wait: { selector: "#ready", timeoutMs: 500 } }] },
        3,
      ),
    ).toEqual({
      batch: [{ wait: { selector: "#ready", timeoutMs: 1_500 } }],
    });
  });

  it("preserves authored timing at scale 1", () => {
    const step: Step = { wait: { text: "Ready" } };
    expect(applyWaitScale(step, 1)).toBe(step);
  });
});

class ClickEffectBackend extends MockBrowserBackend {
  clicks = 0;

  constructor(
    private readonly triggerAt = Number.POSITIVE_INFINITY,
    private readonly effect: () => void = () => {},
  ) {
    super();
  }

  override async runStep(step: Step) {
    const result = await super.runStep(step);
    if ("click" in step) {
      this.clicks++;
      if (this.clicks === this.triggerAt) this.effect();
    }
    return result;
  }
}
