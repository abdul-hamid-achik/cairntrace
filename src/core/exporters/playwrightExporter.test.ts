import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";

const srcOf = (...args: Parameters<typeof exportPlaywright>) =>
  exportPlaywright(...args).source;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

const baseSpec = (overrides: Partial<Spec>): Spec =>
  ({
    version: 1,
    name: "exporter_smoke",
    intent: "smoke test the exporter",
    mode: "normal",
    outcomes: [
      {
        id: "ok",
        description: "ok",
        verify: { text: { contains: "hello" }, region: "page" },
      },
    ],
    steps: [],
    ...overrides,
  }) as Spec;

describe("exportPlaywright", () => {
  it("emits a runnable @playwright/test scaffold", () => {
    const src = srcOf(baseSpec({}));
    expect(src).toContain(`import { expect, test } from "@playwright/test";`);
    expect(src).toContain(`test("exporter_smoke", async ({ page }) => {`);
    expect(src).toContain(`test.setTimeout(1800000);`);
    expect(src.trim().endsWith("});")).toBe(true);
  });

  it("embeds an external browser verifier and passes fixtures as page data", () => {
    const directory = mkdtempSync(join(tmpdir(), "cairn-browser-verifier-"));
    temporaryDirectories.push(directory);
    const verifier = join(directory, "check-field.js");
    writeFileSync(
      verifier,
      `return { ok: document.title === fixtures.title, evidence: { title: document.title } };`,
    );

    const result = exportPlaywright(
      baseSpec({
        outcomes: [
          {
            id: "external_browser_verifier",
            description: "external browser verifier passes",
            verify: {
              script: {
                runtime: "browser",
                file: "../check-field.js",
                fixtures: { title: "Expected" },
              },
            },
          },
        ],
      }),
      { sourcePath: join(directory, "flows", "external.yml") },
    );

    expect(result.coverage.outcomesExported).toBe(1);
    expect(result.coverage.skips).toEqual([]);
    expect(result.source).toContain(
      `const result = await page.evaluate(async ({ source, scriptContext }) => {`,
    );
    expect(result.source).toContain(`new AsyncFunction(`);
    expect(result.source).toContain(
      `document.title === fixtures.title, evidence`,
    );
    expect(result.source).toContain(`"title": "Expected"`);
  });

  it("keeps an unreadable external browser verifier as an explicit skip", () => {
    const result = exportPlaywright(
      baseSpec({
        outcomes: [
          {
            id: "missing_browser_verifier",
            description: "missing verifier is visible",
            verify: {
              script: {
                runtime: "browser",
                file: "../missing.ts",
              },
            },
          },
        ],
      }),
      { sourcePath: "/tmp/flows/missing.yml" },
    );

    expect(result.coverage.outcomesExported).toBe(0);
    expect(result.coverage.skips[0]?.reason).toContain(
      "script.file ../missing.ts not inlined",
    );
  });

  it("warns when an authored budget reaches the four-hour ceiling", () => {
    const src = srcOf(
      baseSpec({
        outcomes: [
          {
            id: "slow",
            description: "slow verifier completes",
            verify: {
              script: {
                runtime: "node",
                file: "../verifiers/slow.ts",
                timeoutMs: 5 * 60 * 60 * 1000,
              },
            },
          },
        ],
      }),
      { sourcePath: "/tmp/flows/slow.yml" },
    );

    expect(src).toContain(`test.setTimeout(14400000);`);
    expect(src).toContain(`authored budgets exceed the 4h export ceiling`);
  });

  it("translates open/click/hover/focus/fill steps", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          { id: "go", open: "https://example.com/" },
          {
            id: "click",
            click: { by: "role", role: "button", name: "Submit" },
          },
          {
            id: "hover",
            hover: {
              by: "selector",
              selector: ".question-table-wrap .table-title",
            },
          },
          {
            id: "focus",
            focus: { by: "selector", selector: "#country" },
          },
          {
            id: "fill_email",
            fill: { by: "label", name: "Email", value: "a@b.c" },
          },
        ],
      }),
    );
    expect(src).toContain(`await page.goto("https://example.com/");`);
    expect(src).toContain(
      `await page.getByRole("button", { name: "Submit" }).first().click();`,
    );
    expect(src).toContain(
      `await page.locator(".question-table-wrap .table-title").hover();`,
    );
    expect(src).toContain(`await page.locator("#country").focus();`);
    expect(src).toContain(
      `await page.getByLabel("Email").first().fill("a@b.c");`,
    );
    expect(src).toContain(
      `await expect(page.getByLabel("Email").first()).toHaveValue("a@b.c", { timeout: 500 });`,
    );
  });

  it("arms network postconditions before upload without emitting mutation retries", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            id: "upload_w9",
            upload: {
              by: "selector",
              selector: "input[type=file]",
              path: "./fixtures/w9.pdf",
            },
            postcondition: {
              network: {
                method: "POST",
                urlContains: "/api/files/extract-content-by-package",
                status: { in: [200, 201] },
                timeoutMs: 45_000,
              },
            },
          },
        ],
      }),
    );

    const arm = src.indexOf("page.waitForResponse");
    const upload = src.indexOf("setInputFiles");
    expect(arm).toBeGreaterThan(-1);
    expect(upload).toBeGreaterThan(arm);
    expect(src).toContain(
      `response.request().method() === "POST" && response.url().includes("/api/files/extract-content-by-package")`,
    );
    expect(src).toContain(`[200, 201].includes(response.status())`);
    expect(src).toContain(
      `void networkPostconditionResponse1.catch(() => undefined);`,
    );
    expect(src).toContain(`await networkPostconditionResponse1;`);
    expect(src).not.toContain("fillAttempt");
  });

  it("suppresses fill retries when a network postcondition owns completion", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            fill: { by: "selector", selector: "#name", value: "Ada" },
            postcondition: {
              network: {
                urlContains: "/api/answers",
                status: { equals: 204 },
              },
            },
          },
        ],
      }),
    );

    expect(src).toContain(`await page.locator("#name").fill("Ada");`);
    expect(src).not.toContain("fillAttempt");
  });

  it("exports wait.value as a bounded value assertion", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            wait: {
              value: {
                by: "label",
                name: "Country",
                equals: "United States",
              },
              timeoutMs: 40_000,
            },
          },
        ],
      }),
    );

    expect(src).toContain(
      `await expect(page.getByLabel("Country").first()).toHaveValue("United States", { timeout: 40000 });`,
    );
  });

  it("exports verified fill/type retries and the per-step opt-out", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            fill: { by: "selector", selector: "#name", value: "Ada" },
          },
          {
            type: {
              by: "selector",
              selector: "#slug",
              value: "ada",
              delayMs: 10,
            },
          },
          {
            fill: { by: "selector", selector: "#masked", value: "1234" },
            verifyFill: false,
          },
        ],
      }),
    );

    expect(
      src.match(/for \(let fillAttempt = 0; ; fillAttempt\+\+\)/g),
    ).toHaveLength(2);
    expect(src).toContain(
      `if (fillAttempt > 0) await page.locator("#slug").fill("");`,
    );
    expect(src).toContain(
      `await page.locator("#slug").pressSequentially("ada", { delay: 10 });`,
    );
    expect(src).toContain(`hydration wiped value after 4 attempts`);
    expect(src).toContain(`await page.locator("#masked").fill("1234");`);
  });

  it("exports click.until as a bounded retry loop", () => {
    const src = srcOf(
      baseSpec({
        settleMs: 2_000,
        steps: [
          {
            click: {
              by: "role",
              role: "button",
              name: "Save",
              until: { selectorGone: "#editor", timeoutMs: 12_000 },
            },
          },
        ],
      }),
    );

    expect(src).toContain(
      `const clickTarget = page.getByRole("button", { name: "Save" }).first();`,
    );
    expect(src).toContain(`const clickUntilDeadline = Date.now() + 12000;`);
    expect(src).toContain(`for (let clickAttempt = 0; ; clickAttempt++) {`);
    expect(src).toContain(
      `await page.waitForLoadState("networkidle", { timeout: 2000 });`,
    );
    expect(src).toContain(
      `await expect(page.locator("#editor")).toHaveCount(0, { timeout: clickUntilAttemptTimeout });`,
    );
  });

  it("translates select steps to selectOption by value or label", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            id: "pick_plan",
            select: { by: "label", name: "Plan", value: "pro" },
          },
          {
            id: "pick_plan_by_label",
            select: { by: "selector", selector: "#plan", label: "Pro plan" },
          },
        ],
      }),
    );
    expect(src).toContain(
      `await page.getByLabel("Plan").first().selectOption({ value: "pro" });`,
    );
    expect(src).toContain(
      `await page.locator("#plan").selectOption({ label: "Pro plan" });`,
    );
  });

  it("translates text + url + count outcomes", () => {
    const src = srcOf(
      baseSpec({
        outcomes: [
          {
            id: "t",
            description: "t",
            verify: { text: { contains: "Welcome" }, region: "page" },
          },
          {
            id: "u",
            description: "u",
            verify: { url: { endsWith: "/dashboard" } },
          },
          {
            id: "c",
            description: "c",
            verify: { count: { selector: ".row", equals: 3 } },
          },
        ],
      }),
    );
    // Native retrying assertion (auto-waits for async renders) with the
    // default case-insensitive + innerText matching cairntrace uses at runtime.
    expect(src).toContain(
      `await expect(page.locator("body")).toContainText("Welcome", { ignoreCase: true, useInnerText: true });`,
    );
    expect(src).toContain(`await expect(page).toHaveURL(new RegExp(`);
    expect(src).toContain(`await expect(page.locator(".row")).toHaveCount(3);`);
  });

  it("renders retrying text assertions and honors the case-sensitive opt-out", () => {
    const src = srcOf(
      baseSpec({
        outcomes: [
          {
            id: "equals-default",
            description: "equals-default",
            verify: { text: { equals: "Order Saved" }, region: ".status" },
          },
          {
            id: "contains-cs",
            description: "contains-cs",
            verify: {
              text: { contains: "SKU-42", caseSensitive: true },
              region: ".sku",
            },
          },
          {
            id: "absent",
            description: "absent",
            verify: { notText: { contains: "Error" }, region: "page" },
          },
        ],
      }),
    );
    expect(src).toContain(
      `await expect(page.locator(".status")).toHaveText("Order Saved", { ignoreCase: true, useInnerText: true });`,
    );
    expect(src).toContain(
      `await expect(page.locator(".sku")).toContainText("SKU-42", { ignoreCase: false, useInnerText: true });`,
    );
    expect(src).toContain(
      `await expect(page.locator("body")).not.toContainText("Error", { ignoreCase: true, useInnerText: true });`,
    );
    // The one-shot innerText() read is gone — no manual normalize/toBe pattern.
    expect(src).not.toContain(`.innerText();`);
  });

  it("installs network + console listeners only when needed", () => {
    const noListeners = srcOf(
      baseSpec({
        outcomes: [
          {
            id: "x",
            description: "x",
            verify: { url: { endsWith: "/x" } },
          },
        ],
      }),
    );
    expect(noListeners).not.toContain(`requests.push`);
    expect(noListeners).not.toContain(`consoleErrors`);

    const withListeners = srcOf(
      baseSpec({
        outcomes: [
          {
            id: "net",
            description: "net",
            verify: {
              network: {
                method: "POST",
                urlContains: "/api/x",
                status: { in: [200, 201] },
              },
            },
          },
          {
            id: "con",
            description: "con",
            verify: { console: { errorsMax: 0 } },
          },
        ],
      }),
    );
    expect(withListeners).toContain(`page.on("response"`);
    expect(withListeners).toContain(`page.on("console"`);
    expect(withListeners).toContain(`expect(requests.some(`);
    expect(withListeners).toContain(
      `expect(consoleErrors.length).toBeLessThanOrEqual(0);`,
    );
  });

  it("emits a page.evaluate block for the script verifier", () => {
    const src = srcOf(
      baseSpec({
        outcomes: [
          {
            id: "s",
            description: "s",
            verify: {
              script: {
                run: "return { ok: document.title === 'X', evidence: null };",
              },
            },
          },
        ],
      }),
    );
    expect(src).toContain(
      `const result = await page.evaluate(async ({ source, scriptContext }) => {`,
    );
    expect(src).toContain(`expect(result.ok).toBe(true);`);
  });

  it("translates selector wait steps", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            id: "wait_visible",
            wait: {
              selector: "#element_69d53d5dabbab17b1fede24f",
              timeoutMs: 30000,
            },
          },
          {
            id: "wait_hidden",
            wait: {
              selector: ".loading-overlay",
              state: "hidden",
              timeoutMs: 15000,
            },
          },
          { id: "wait_load", wait: { load: "networkidle" } },
        ],
      }),
    );
    expect(src).toContain(
      `await page.waitForSelector("#element_69d53d5dabbab17b1fede24f", { timeout: 30000, state: "visible" });`,
    );
    expect(src).toContain(
      `await page.waitForSelector(".loading-overlay", { timeout: 15000, state: "hidden" });`,
    );
    expect(src).toContain(
      `await page.waitForLoadState("networkidle", { timeout: 30000 });`,
    );
  });

  it("exports normalized text waits and preserves the case-sensitive opt-out", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          { wait: { text: "Order Saved" } },
          {
            wait: {
              notText: "Loading",
              caseSensitive: true,
            },
          },
        ],
      }),
    );
    expect(src).toContain(`trim().toLowerCase().includes(\\"order saved\\")`);
    expect(src).toContain(`trim().includes(\\"Loading\\")`);
  });

  it("exports step and spec click settle overrides", () => {
    const src = srcOf(
      baseSpec({
        settleMs: 1_200,
        steps: [
          { click: { by: "selector", selector: "#inherits" } },
          {
            click: { by: "selector", selector: "#skips" },
            settleMs: 0,
          },
        ],
      }),
    );

    expect(src).toContain(
      `page.waitForLoadState("networkidle", { timeout: 1200 })`,
    );
    expect(src.match(/waitForLoadState/g)).toHaveLength(1);
  });

  it("includes the spec intent + source as a header comment", () => {
    const src = srcOf(baseSpec({ intent: "do the thing" }), {
      sourcePath: "/path/to/spec.yml",
    });
    expect(src).toContain(`Source: /path/to/spec.yml`);
    expect(src).toContain(`Intent: do the thing`);
  });

  it("emits JS without type annotations when lang is js", () => {
    const src = srcOf(
      baseSpec({
        outcomes: [
          {
            id: "con",
            description: "con",
            verify: { console: { errorsMax: 0 } },
          },
        ],
      }),
      { lang: "js" },
    );
    expect(src).toContain(`// Lang: js`);
    expect(src).toContain(`const consoleErrors = [];`);
    expect(src).not.toContain(`: string[]`);
  });

  it("exports inline eval steps", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            id: "seed",
            eval: { js: "return window.__X = 1;", assign: "seeded" },
          },
        ],
      }),
    );
    expect(src).toContain(
      `const seeded = await page.evaluate(async ({ source, args }) => {`,
    );
    expect(src).toContain(`source: "return window.__X = 1;"`);
    expect(src).toContain(`new AsyncFunction("args", source)`);
  });

  it("flattens batch sub-steps", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            id: "hover_then_click",
            batch: [
              { hover: { by: "selector", selector: ".menu" } },
              { click: { by: "selector", selector: ".menu-item" } },
            ],
          },
        ],
      }),
    );
    expect(src).toContain(`// batch: expanded sequentially`);
    expect(src).toContain(`await page.locator(".menu").hover();`);
    expect(src).toContain(`await page.locator(".menu-item").click();`);
  });

  it("wraps when: urlContains in a real if", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            id: "maybe",
            when: "urlContains:/login",
            click: { by: "role", role: "button", name: "OK" },
          },
        ],
      }),
    );
    expect(src).toContain(`if (page.url().includes("/login")) {`);
    expect(src).toContain(
      `await page.getByRole("button", { name: "OK" }).first().click();`,
    );
  });

  it("exports request with body headers and expectStatus", () => {
    const src = srcOf(
      baseSpec({
        steps: [
          {
            id: "post",
            request: {
              method: "POST",
              url: "/api/x",
              body: { a: 1 },
              expectStatus: 201,
              assign: "created",
            },
          },
        ],
      }),
    );
    expect(src).toContain(`page.request.fetch("/api/x"`);
    expect(src).toContain(`"Content-Type": "application/json"`);
    expect(src).toContain(`expect(created.status()).toBe(201);`);
  });

  it("reports coverage skips for monitor and node script", () => {
    const result = exportPlaywright(
      baseSpec({
        steps: [
          {
            id: "prof",
            monitor: { action: "snapshot", type: "sample" },
          } as never,
        ],
        outcomes: [
          {
            id: "nodey",
            description: "node",
            verify: {
              script: { runtime: "node", file: "./check.ts" },
            },
          },
        ],
      }),
    );
    expect(result.coverage.skips.length).toBeGreaterThan(0);
    expect(result.coverage.skips.some((s) => s.kind === "step")).toBe(true);
    expect(result.coverage.skips.some((s) => s.kind === "outcome")).toBe(true);
  });
});
