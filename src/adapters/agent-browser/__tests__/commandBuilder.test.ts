import { describe, expect, it } from "vitest";
import type { Step } from "../../../core/schema/spec.v1";
import {
  batchSubStepToArgv,
  locatorToArgv,
  openReadinessArgv,
  stepToArgv,
  waitConditionToArgv,
} from "../commandBuilder";

describe("locatorToArgv", () => {
  it("focuses selector and semantic locators", () => {
    expect(
      stepToArgv({ focus: { by: "selector", selector: "#country" } }),
    ).toEqual(["focus", "#country"]);
    expect(stepToArgv({ focus: { by: "label", name: "Country" } })).toEqual([
      "find",
      "label",
      "Country",
      "focus",
    ]);
  });

  it("role with name → find role <role> <action> --name <name>", () => {
    expect(
      locatorToArgv({ by: "role", role: "button", name: "Apply" }, "click"),
    ).toEqual(["find", "role", "button", "click", "--name", "Apply"]);
  });

  it("role without name → omits --name", () => {
    expect(locatorToArgv({ by: "role", role: "main" }, "click")).toEqual([
      "find",
      "role",
      "main",
      "click",
    ]);
  });

  it("label → find label <name> <action>", () => {
    expect(
      locatorToArgv({ by: "label", name: "Email" }, "fill", "x@y.z"),
    ).toEqual(["find", "label", "Email", "fill", "x@y.z"]);
  });

  it("text → find text <text> <action>", () => {
    expect(locatorToArgv({ by: "text", text: "Sign in" }, "click")).toEqual([
      "find",
      "text",
      "Sign in",
      "click",
    ]);
  });

  it("role with exact → appends --exact", () => {
    expect(
      locatorToArgv(
        { by: "role", role: "button", name: "Apply", exact: true },
        "click",
      ),
    ).toEqual([
      "find",
      "role",
      "button",
      "click",
      "--name",
      "Apply",
      "--exact",
    ]);
  });

  it("label with exact → appends --exact", () => {
    expect(
      locatorToArgv({ by: "label", name: "Email", exact: true }, "fill", "x"),
    ).toEqual(["find", "label", "Email", "fill", "x", "--exact"]);
  });

  it("selector → falls back to raw <action> <selector>", () => {
    expect(
      locatorToArgv({ by: "selector", selector: "#submit" }, "click"),
    ).toEqual(["click", "#submit"]);
  });

  it("selector hover → raw hover <selector>", () => {
    expect(
      locatorToArgv(
        { by: "selector", selector: ".question-table-wrap .table-title" },
        "hover",
      ),
    ).toEqual(["hover", ".question-table-wrap .table-title"]);
  });

  it("selector + value → <action> <selector> <value>", () => {
    expect(
      locatorToArgv({ by: "testid", testid: "email" }, "fill", "x@y.z"),
    ).toEqual(["fill", '[data-testid="email"]', "x@y.z"]);
    expect(
      locatorToArgv(
        { by: "selector", selector: "[data-testid=email]" },
        "fill",
        "x@y.z",
      ),
    ).toEqual(["fill", "[data-testid=email]", "x@y.z"]);
  });
});

describe("waitConditionToArgv", () => {
  it("refuses runner-owned value waits", () => {
    expect(() =>
      waitConditionToArgv({
        value: { by: "selector", selector: "#country", equals: "US" },
      }),
    ).toThrow(/cross-backend runner/);
  });

  it("refuses runner-owned url waits", () => {
    expect(() =>
      waitConditionToArgv({ url: { includes: "/connection/" } }),
    ).toThrow(/cross-backend runner/);
  });

  it("text wait", () => {
    expect(waitConditionToArgv({ text: "Welcome" })).toEqual([
      "wait",
      "--fn",
      expect.stringContaining('includes("welcome")'),
    ]);
  });

  it("text wait with timeout", () => {
    expect(waitConditionToArgv({ text: "Welcome", timeoutMs: 5000 })).toEqual([
      "wait",
      "--fn",
      expect.stringContaining('includes("welcome")'),
      "--timeout",
      "5000",
    ]);
  });

  it("load wait", () => {
    expect(waitConditionToArgv({ load: "networkidle" })).toEqual([
      "wait",
      "--load",
      "networkidle",
    ]);
  });

  it("selector wait", () => {
    expect(
      waitConditionToArgv({ selector: "#element_69d53d5dabbab17b1fede24f" }),
    ).toEqual(["wait", "#element_69d53d5dabbab17b1fede24f"]);
  });

  it("selector wait omits the redundant unsupported visible state", () => {
    expect(
      waitConditionToArgv({
        selector: "#ready",
        state: "visible",
        timeoutMs: 30000,
      }),
    ).toEqual(["wait", "#ready", "--timeout", "30000"]);
  });

  it("implements attached as a live DOM predicate", () => {
    expect(
      waitConditionToArgv({
        selector: '[data-answer-key="Tax_US_W9"] input[type="file"]',
        state: "attached",
        timeoutMs: 25000,
      }),
    ).toEqual([
      "wait",
      "--fn",
      'document.querySelector("[data-answer-key=\\\"Tax_US_W9\\\"] input[type=\\\"file\\\"]") !== null',
      "--timeout",
      "25000",
    ]);
  });

  it("selector wait with state and timeout", () => {
    expect(
      waitConditionToArgv({
        selector: ".loading-overlay",
        state: "hidden",
        timeoutMs: 15000,
      }),
    ).toEqual([
      "wait",
      ".loading-overlay",
      "--state",
      "hidden",
      "--timeout",
      "15000",
    ]);
  });

  it("text/notText use normalized case-insensitive --fn predicates", () => {
    const textArgv = waitConditionToArgv({ text: "Order  Saved" });
    expect(textArgv[0]).toBe("wait");
    expect(textArgv[1]).toBe("--fn");
    expect(textArgv[2]).toContain("replace(/\\s+/g");
    expect(textArgv[2]).toContain("toLowerCase");
    expect(textArgv[2]).toContain('includes("order saved")');

    const argv = waitConditionToArgv({ notText: "Loading..." });
    expect(argv[0]).toBe("wait");
    expect(argv[1]).toBe("--fn");
    expect(argv[2]).toContain("!(String(document.body?.innerText");
    // String must be JSON-escaped so it survives shell + JS parsing.
    expect(argv[2]).toContain('"loading..."');
  });

  it("caseSensitive text wait opts out of case folding", () => {
    const argv = waitConditionToArgv({
      text: "Saved",
      caseSensitive: true,
    });
    expect(argv[2]).not.toContain("toLowerCase");
    expect(argv[2]).toContain('includes("Saved")');
  });

  // Regression: every --fn payload used to be wrapped in `() => …`.
  // agent-browser EVALUATES the string and tests the result for truthiness, so
  // it received a function object — always truthy — and the wait resolved on
  // its first poll. Text/notText waits and both open.waitUntil readiness waits
  // silently became no-ops: a wait for text that was nowhere on the page
  // "passed" in ~13ms. Asserting on the string's shape would not catch a
  // re-wrap, so evaluate it and check the RESULT type.
  it("emits --fn payloads that EVALUATE to a boolean, never to a function", () => {
    const argvs = [
      waitConditionToArgv({ text: "Welcome" }),
      waitConditionToArgv({ notText: "Loading..." }),
      waitConditionToArgv({ text: "Saved", caseSensitive: true }),
      openReadinessArgv("domcontentloaded"),
      openReadinessArgv("load"),
    ];

    for (const argv of argvs) {
      const index = argv.indexOf("--fn");
      expect(index).toBeGreaterThanOrEqual(0);
      const expression = argv[index + 1]!;
      const evaluate = new Function("document", `return (${expression});`) as (
        doc: unknown,
      ) => unknown;
      const value = evaluate({
        body: { innerText: "" },
        readyState: "complete",
      });
      expect(typeof value).toBe("boolean");
    }
  });

  it("the text predicate actually discriminates on body content", () => {
    const argv = waitConditionToArgv({ text: "Order  Saved" });
    const expression = argv[argv.indexOf("--fn") + 1]!;
    const evaluate = new Function("document", `return (${expression});`) as (
      doc: unknown,
    ) => boolean;

    expect(evaluate({ body: { innerText: "The ORDER   saved fine" } })).toBe(
      true,
    );
    expect(evaluate({ body: { innerText: "Nothing to see" } })).toBe(false);
  });

  it("the notText predicate is true only while the text is absent", () => {
    const argv = waitConditionToArgv({ notText: "Loading..." });
    const expression = argv[argv.indexOf("--fn") + 1]!;
    const evaluate = new Function("document", `return (${expression});`) as (
      doc: unknown,
    ) => boolean;

    expect(evaluate({ body: { innerText: "Still loading..." } })).toBe(false);
    expect(evaluate({ body: { innerText: "Done" } })).toBe(true);
  });
});

describe("openReadinessArgv", () => {
  it("domcontentloaded → readyState predicate via --fn (resolves immediately on an already-loaded page)", () => {
    expect(openReadinessArgv("domcontentloaded")).toEqual([
      "wait",
      "--fn",
      "document.readyState !== 'loading'",
    ]);
  });

  it("load → complete-state predicate via --fn", () => {
    expect(openReadinessArgv("load")).toEqual([
      "wait",
      "--fn",
      "document.readyState === 'complete'",
    ]);
  });

  it("networkidle → stays on --load (no readyState equivalent)", () => {
    expect(openReadinessArgv("networkidle")).toEqual([
      "wait",
      "--load",
      "networkidle",
    ]);
  });

  it("appends --timeout when timeoutMs is provided", () => {
    expect(openReadinessArgv("domcontentloaded", 45000)).toEqual([
      "wait",
      "--fn",
      "document.readyState !== 'loading'",
      "--timeout",
      "45000",
    ]);
    expect(openReadinessArgv("networkidle", 45000)).toEqual([
      "wait",
      "--load",
      "networkidle",
      "--timeout",
      "45000",
    ]);
  });

  it("omits --timeout when timeoutMs is undefined", () => {
    expect(openReadinessArgv("load")).not.toContain("--timeout");
  });
});

describe("stepToArgv", () => {
  it("open → navigate <url>", () => {
    expect(stepToArgv({ open: "/checkout" })).toEqual([
      "navigate",
      "/checkout",
    ]);
  });

  it("click with role locator", () => {
    expect(
      stepToArgv({
        id: "submit",
        click: { by: "role", role: "button", name: "Submit" },
      }),
    ).toEqual(["find", "role", "button", "click", "--name", "Submit"]);
  });

  it("hover with role locator", () => {
    expect(
      stepToArgv({
        hover: { by: "role", role: "button", name: "More actions" },
      }),
    ).toEqual(["find", "role", "button", "hover", "--name", "More actions"]);
  });

  it("hover with selector locator", () => {
    expect(
      stepToArgv({
        hover: {
          by: "selector",
          selector: ".question-table-wrap .table-title",
        },
      }),
    ).toEqual(["hover", ".question-table-wrap .table-title"]);
  });

  it("fill with label locator", () => {
    expect(
      stepToArgv({
        fill: { by: "label", name: "Email", value: "a@b.c" },
      }),
    ).toEqual(["find", "label", "Email", "fill", "a@b.c"]);
  });

  it("select with selector locator passes the value as trailing arg", () => {
    expect(
      stepToArgv({
        select: { by: "selector", selector: "#plan", value: "pro" },
      }),
    ).toEqual(["select", "#plan", "pro"]);
  });

  it("select passes label as the same trailing arg (agent-browser matches value OR label)", () => {
    expect(
      stepToArgv({
        select: { by: "selector", selector: "#plan", label: "Pro plan" },
      }),
    ).toEqual(["select", "#plan", "Pro plan"]);
  });

  it("select with label locator uses the find family fallback", () => {
    expect(
      stepToArgv({
        select: { by: "label", name: "Plan", value: "pro" },
      }),
    ).toEqual(["find", "label", "Plan", "select", "pro"]);
  });

  it("upload with selector locator", () => {
    expect(
      stepToArgv({
        upload: {
          by: "selector",
          selector: "input[type=file]",
          path: "./fixtures/sample.xlsx",
        },
      }),
    ).toEqual(["upload", "input[type=file]", "./fixtures/sample.xlsx"]);
  });

  it("download with selector locator", () => {
    expect(
      stepToArgv({
        download: {
          by: "selector",
          selector: "button[aria-label='Download template']",
          saveAs: "/tmp/template.xlsx",
          assign: "template",
        },
      }),
    ).toEqual([
      "download",
      "button[aria-label='Download template']",
      "/tmp/template.xlsx",
    ]);
  });

  it("semantic download locators must be resolved by the adapter", () => {
    expect(() =>
      stepToArgv({
        download: {
          by: "role",
          role: "button",
          name: "Download template",
          saveAs: "/tmp/template.xlsx",
          assign: "template",
        },
      }),
    ).toThrow(/resolved by AgentBrowserAdapter/);
  });

  it("wait with text", () => {
    expect(
      stepToArgv({ wait: { text: "Imported", timeoutMs: 30000 } }),
    ).toEqual([
      "wait",
      "--fn",
      expect.stringContaining('includes("imported")'),
      "--timeout",
      "30000",
    ]);
  });

  it("press → press <key>", () => {
    expect(stepToArgv({ press: "Enter" })).toEqual(["press", "Enter"]);
    expect(stepToArgv({ press: "Control+a" })).toEqual(["press", "Control+a"]);
  });

  it("scroll by direction → scroll <dir> [px]", () => {
    expect(stepToArgv({ scroll: { direction: "down" } })).toEqual([
      "scroll",
      "down",
    ]);
    expect(stepToArgv({ scroll: { direction: "down", px: 600 } })).toEqual([
      "scroll",
      "down",
      "600",
    ]);
  });

  it("scroll to selector → scrollintoview <selector>", () => {
    expect(
      stepToArgv({ scroll: { to: { by: "selector", selector: "#footer" } } }),
    ).toEqual(["scrollintoview", "#footer"]);
  });

  it("scroll to semantic locator must be resolved by the adapter", () => {
    expect(() =>
      stepToArgv({
        scroll: { to: { by: "role", role: "button", name: "Submit" } },
      }),
    ).toThrow(/resolved by AgentBrowserAdapter/);
  });

  it("snapshot interactive", () => {
    expect(stepToArgv({ snapshot: { interactive: true } })).toEqual([
      "snapshot",
      "-i",
    ]);
  });

  it("snapshot non-interactive", () => {
    expect(stepToArgv({ snapshot: { interactive: false } })).toEqual([
      "snapshot",
    ]);
  });

  it("use: throws — must be expanded by the runner before adapter dispatch", () => {
    const step = { use: "login_admin" } as Step;
    expect(() => stepToArgv(step)).toThrow(/must be expanded/);
  });

  it("batch: throws — handled by AgentBrowserAdapter.batch, not stepToArgv", () => {
    const step = {
      batch: [
        { hover: { by: "selector", selector: "#a" } },
        { click: { by: "selector", selector: "#b" } },
      ],
    } as Step;
    expect(() => stepToArgv(step)).toThrow(/handled by AgentBrowserAdapter/);
  });
});

describe("batchSubStepToArgv", () => {
  it("maps each selector sub-step to a single command", () => {
    expect(
      batchSubStepToArgv({ click: { by: "selector", selector: "#go" } }),
    ).toEqual(["click", "#go"]);
    expect(
      batchSubStepToArgv({ hover: { by: "selector", selector: ".row" } }),
    ).toEqual(["hover", ".row"]);
    expect(
      batchSubStepToArgv({
        fill: { by: "selector", selector: "#name", value: "Acme" },
      }),
    ).toEqual(["fill", "#name", "Acme"]);
    expect(
      batchSubStepToArgv({
        upload: {
          by: "selector",
          selector: "input[type=file]",
          path: "./a.xlsx",
        },
      }),
    ).toEqual(["upload", "input[type=file]", "./a.xlsx"]);
    expect(batchSubStepToArgv({ press: "Enter" })).toEqual(["press", "Enter"]);
  });

  it("maps scroll (direction + to) and wait sub-steps", () => {
    expect(
      batchSubStepToArgv({ scroll: { direction: "down", px: 200 } }),
    ).toEqual(["scroll", "down", "200"]);
    expect(
      batchSubStepToArgv({
        scroll: { to: { by: "selector", selector: "#end" } },
      }),
    ).toEqual(["scrollintoview", "#end"]);
    expect(
      batchSubStepToArgv({ wait: { text: "Saved", timeoutMs: 5000 } }),
    ).toEqual([
      "wait",
      "--fn",
      expect.stringContaining('includes("saved")'),
      "--timeout",
      "5000",
    ]);
  });
});
