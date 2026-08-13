import { describe, expect, it } from "vitest";
import type { Step } from "../schema/spec.v1";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { PlaywrightAdapter } from "../../adapters/playwright/PlaywrightAdapter";
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

  it("waits until a control has the expected value", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueValue("");
    backend.enqueueValue("United States");

    const result = await runResilientBrowserStep(
      {
        wait: {
          value: {
            by: "selector",
            selector: "#country",
            equals: "United States",
          },
          timeoutMs: 500,
        },
      },
      backend,
      1,
    );

    expect(result).toMatchObject({ ok: true, stdout: "United States" });
    expect(backend.stepLog).toHaveLength(0);
  });

  it("waits until the page URL includes a path", async () => {
    const backend = new MockBrowserBackend();
    backend.setUrl("http://localhost:8080/connection/abc");
    const result = await runResilientBrowserStep(
      {
        wait: { url: { includes: "/connection/" }, timeoutMs: 500 },
      },
      backend,
      1,
    );
    expect(result).toMatchObject({
      ok: true,
      stdout: "http://localhost:8080/connection/abc",
    });
    expect(backend.stepLog).toHaveLength(0);
  });

  it("fails wait.url with the last observed URL", async () => {
    const backend = new MockBrowserBackend();
    backend.setUrl("http://localhost:8080/dash");

    const result = await runResilientBrowserStep(
      {
        wait: { url: { includes: "/connection/" }, timeoutMs: 200 },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain('includes "/connection/"');
    expect(result.stderr).toContain("http://localhost:8080/dash");
  });

  it("fails wait.value with the last observed value", async () => {
    const backend = new MockBrowserBackend();
    backend.enqueueValue("Canada");

    const result = await runResilientBrowserStep(
      {
        wait: {
          value: {
            by: "label",
            name: "Country",
            equals: "United States",
          },
          timeoutMs: 200,
        },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(
      'expected "United States", got "" after 200ms',
    );
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

  it("retries Enter until a selector appears", async () => {
    const backend = new PressEffectBackend(1, () =>
      backend.setCount(".company-link", 1),
    );

    const result = await runResilientBrowserStep(
      {
        press: "Enter",
        until: { selector: ".company-link", timeoutMs: 200 },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(true);
    expect(backend.presses).toBe(1);
  });

  it("wait.ms sleeps without touching the backend", async () => {
    const backend = new PressEffectBackend();
    const started = Date.now();
    const result = await runResilientBrowserStep(
      { wait: { ms: 40 } },
      backend,
      1,
    );
    expect(result.ok).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(35);
    expect(backend.stepLog).toEqual([]);
  });

  it("retries a targeted Enter until a selector appears", async () => {
    const backend = new PressEffectBackend(1, () =>
      backend.setCount(".company-link", 1),
    );

    const result = await runResilientBrowserStep(
      {
        press: "Enter",
        target: { by: "selector", selector: "#search" },
        until: { selector: ".company-link", timeoutMs: 200 },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(true);
    expect(backend.stepLog[0]).toEqual({
      press: "Enter",
      target: { by: "selector", selector: "#search" },
    });
  });

  it("retries click until the page URL matches", async () => {
    const backend = new ClickEffectBackend(2, () =>
      backend.setUrl("http://localhost:8080/connection/abc"),
    );
    backend.setUrl("http://localhost:8080/connections/companies-seller");

    const result = await runResilientBrowserStep(
      {
        click: {
          by: "selector",
          selector: ".company-link",
          until: { url: { includes: "/connection/" }, timeoutMs: 50 },
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

  it("arms a network postcondition before one upload and never retries it", async () => {
    const backend = new UploadResponseBackend();

    const result = await runResilientBrowserStep(
      {
        upload: { by: "selector", selector: "#document", path: "./w9.pdf" },
        postcondition: {
          network: {
            method: "POST",
            urlContains: "/api/files/extract-content-by-package",
            status: { equals: 200 },
            timeoutMs: 100,
          },
        },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(true);
    expect(backend.stepLog).toHaveLength(1);
    expect(backend.mutations).toBe(1);
  });

  it("does not retry a mutation when the postcondition times out", async () => {
    const backend = new MockBrowserBackend();
    let mutations = 0;
    const original = backend.runStep.bind(backend);
    backend.runStep = async (step) => {
      mutations++;
      return original(step);
    };

    const result = await runResilientBrowserStep(
      {
        upload: { by: "selector", selector: "#document", path: "./w9.pdf" },
        postcondition: {
          network: {
            method: "POST",
            urlContains: "/api/files/extract-content-by-package",
            status: { equals: 200 },
            timeoutMs: 5,
          },
        },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain("network postcondition timed out");
    expect(mutations).toBe(1);
  });

  it("reports a request-log failure after the mutation without retrying it", async () => {
    const backend = new MockBrowserBackend();
    let reads = 0;
    let mutations = 0;
    const originalRunStep = backend.runStep.bind(backend);
    backend.runStep = async (step) => {
      mutations++;
      return originalRunStep(step);
    };
    backend.getNetworkRequests = async () => {
      reads++;
      if (reads === 1) return [];
      throw new Error("daemon unavailable");
    };

    const result = await runResilientBrowserStep(
      {
        upload: { by: "selector", selector: "#document", path: "./w9.pdf" },
        postcondition: {
          network: {
            method: "POST",
            urlContains: "/api/files/signup",
            status: { equals: 200 },
            timeoutMs: 100,
          },
        },
      },
      backend,
      1,
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toContain(
      "could not observe network postcondition after the action: daemon unavailable",
    );
    expect(mutations).toBe(1);
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
      applyWaitScale(
        {
          wait: {
            value: {
              by: "selector",
              selector: "#country",
              equals: "US",
            },
            timeoutMs: 1_000,
          },
        },
        3,
      ),
    ).toEqual({
      wait: {
        value: { by: "selector", selector: "#country", equals: "US" },
        timeoutMs: 3_000,
      },
    });
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

describe("latency resilience in real Chromium", () => {
  it("combines scaled hydration verification with delayed click delivery", async () => {
    const backend = new PlaywrightAdapter({ defaultTimeoutMs: 5_000 });
    backend.setWaitScale(2);
    const page = encodeURIComponent(`<!doctype html>
        <html>
          <body>
            <label>Name <input id="name" /></label>
            <section id="editor">Editor</section>
            <button id="save">Save</button>
            <script>
              const input = document.querySelector("#name");
              const save = document.querySelector("#save");
              let hydrationWipeScheduled = false;
              input.addEventListener("input", () => {
                if (hydrationWipeScheduled) return;
                hydrationWipeScheduled = true;
                setTimeout(() => { input.value = ""; }, 650);
              });
              let deliveryScheduled = false;
              save.addEventListener("click", () => {
                if (deliveryScheduled) return;
                deliveryScheduled = true;
                setTimeout(() => document.querySelector("#editor")?.remove(), 700);
              });
            </script>
          </body>
        </html>`);

    try {
      expect(
        await backend.runStep({
          open: `data:text/html;charset=utf-8,${page}`,
        }),
      ).toMatchObject({ ok: true });

      const fill = await runResilientBrowserStep(
        {
          fill: { by: "selector", selector: "#name", value: "Ada" },
        },
        backend,
        2,
      );
      expect(fill).toMatchObject({ ok: true });
      expect(fill.stderr).toContain(
        "input value survived hydration after 2 attempts",
      );
      await expect(
        backend.getValue({ by: "selector", selector: "#name" }),
      ).resolves.toBe("Ada");

      const click = await runResilientBrowserStep(
        {
          click: {
            by: "selector",
            selector: "#save",
            until: { selectorGone: "#editor", timeoutMs: 2_000 },
          },
        },
        backend,
        2,
      );
      expect(click).toMatchObject({ ok: true });
      expect(click.stderr).toContain(
        "click.until satisfied after 2 click attempts",
      );
      await expect(backend.getCount("#editor")).resolves.toBe(0);
    } finally {
      await backend.close();
    }
  }, 20_000);
});

class PressEffectBackend extends MockBrowserBackend {
  presses = 0;

  constructor(
    private readonly triggerAt = Number.POSITIVE_INFINITY,
    private readonly effect: () => void = () => {},
  ) {
    super();
  }

  override async runStep(step: Step) {
    const result = await super.runStep(step);
    if ("press" in step) {
      this.presses++;
      if (this.presses === this.triggerAt) this.effect();
    }
    return result;
  }
}

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

class UploadResponseBackend extends MockBrowserBackend {
  mutations = 0;

  override async runStep(step: Step) {
    const result = await super.runStep(step);
    if ("upload" in step) {
      this.mutations++;
      this.pushNetworkEntry({
        url: "http://localhost/api/files/extract-content-by-package",
        method: "POST",
        status: 200,
        timestamp: Date.now(),
      });
    }
    return result;
  }
}
