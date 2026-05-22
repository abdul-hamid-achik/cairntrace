import { describe, expect, it } from "vitest";
import type { Spec } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";

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
    const src = exportPlaywright(baseSpec({}));
    expect(src).toContain(`import { expect, test } from "@playwright/test";`);
    expect(src).toContain(`test("exporter_smoke", async ({ page }) => {`);
    expect(src.trim().endsWith("});")).toBe(true);
  });

  it("translates open/click/hover/fill steps", () => {
    const src = exportPlaywright(
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
            id: "fill_email",
            fill: { by: "label", name: "Email", value: "a@b.c" },
          },
        ],
      }),
    );
    expect(src).toContain(`await page.goto("https://example.com/");`);
    expect(src).toContain(
      `await page.getByRole("button", { name: "Submit" }).click();`,
    );
    expect(src).toContain(
      `await page.locator(".question-table-wrap .table-title").hover();`,
    );
    expect(src).toContain(`await page.getByLabel("Email").fill("a@b.c");`);
  });

  it("translates text + url + count outcomes", () => {
    const src = exportPlaywright(
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
    expect(src).toContain(
      `await expect(page.locator("body")).toContainText("Welcome");`,
    );
    expect(src).toContain(`await expect(page).toHaveURL(new RegExp(`);
    expect(src).toContain(`await expect(page.locator(".row")).toHaveCount(3);`);
  });

  it("installs network + console listeners only when needed", () => {
    const noListeners = exportPlaywright(
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

    const withListeners = exportPlaywright(
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
    const src = exportPlaywright(
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
    expect(src).toContain(`const result = await page.evaluate(() => {`);
    expect(src).toContain(`expect(result.ok).toBe(true);`);
  });

  it("includes the spec intent + source as a header comment", () => {
    const src = exportPlaywright(baseSpec({ intent: "do the thing" }), {
      sourcePath: "/path/to/spec.yml",
    });
    expect(src).toContain(`Source: /path/to/spec.yml`);
    expect(src).toContain(`Intent: do the thing`);
  });
});
