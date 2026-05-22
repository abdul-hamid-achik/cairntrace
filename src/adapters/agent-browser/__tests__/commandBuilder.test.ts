import { describe, expect, it } from "vitest";
import type { Step } from "../../../core/schema/spec.v1";
import {
  locatorToArgv,
  stepToArgv,
  waitConditionToArgv,
} from "../commandBuilder";

describe("locatorToArgv", () => {
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
      locatorToArgv(
        { by: "selector", selector: "[data-testid=email]" },
        "fill",
        "x@y.z",
      ),
    ).toEqual(["fill", "[data-testid=email]", "x@y.z"]);
  });
});

describe("waitConditionToArgv", () => {
  it("text wait", () => {
    expect(waitConditionToArgv({ text: "Welcome" })).toEqual([
      "wait",
      "--text",
      "Welcome",
    ]);
  });

  it("text wait with timeout", () => {
    expect(waitConditionToArgv({ text: "Welcome", timeoutMs: 5000 })).toEqual([
      "wait",
      "--text",
      "Welcome",
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

  it("notText synthesized as --fn predicate (agent-browser has no native --notText)", () => {
    const argv = waitConditionToArgv({ notText: "Loading..." });
    expect(argv[0]).toBe("wait");
    expect(argv[1]).toBe("--fn");
    expect(argv[2]).toContain("!document.body.innerText.includes");
    // String must be JSON-escaped so it survives shell + JS parsing.
    expect(argv[2]).toContain('"Loading..."');
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

  it("download with role locator", () => {
    expect(
      stepToArgv({
        download: {
          by: "role",
          role: "button",
          name: "Download template",
          saveAs: "/tmp/template.xlsx",
          assign: "template",
        },
      }),
    ).toEqual([
      "find",
      "role",
      "button",
      "download",
      "/tmp/template.xlsx",
      "--name",
      "Download template",
    ]);
  });

  it("wait with text", () => {
    expect(
      stepToArgv({ wait: { text: "Imported", timeoutMs: 30000 } }),
    ).toEqual(["wait", "--text", "Imported", "--timeout", "30000"]);
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
});
