import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { exportPlaywright } from "../exporters/playwrightExporter";
import { exportPlaywrightProject } from "../exporters/playwrightProject";
import { parseSpec } from "../parser/parseSpec";
import { SpecSchema, type Spec } from "../schema/spec.v1";
import { importPlaywright } from "./playwrightImporter";

describe("importPlaywright", () => {
  it("maps common Playwright steps and assertions to a parseable spec", async () => {
    const imported = importPlaywright(
      [
        "import { test, expect } from '@playwright/test';",
        "",
        "test('Admin saves settings', async ({ page }) => {",
        "  await page.goto('/settings');",
        "  await page.getByRole('button', { name: 'Edit' }).click();",
        "  await page.getByLabel('Display name').fill('Acme');",
        "  await page.request.post('/api/settings', { data: { enabled: true } });",
        "  await expect(page).toHaveURL(/\\/settings$/);",
        "  await expect(page.getByText('Saved')).toBeVisible();",
        "});",
      ].join("\n"),
      { sourcePath: "settings.spec.ts" },
    );

    const raw = parseYaml(imported.yaml);
    const spec = SpecSchema.parse(raw);
    expect(spec.name).toBe("admin_saves_settings");
    expect(spec.steps).toEqual([
      { open: "/settings" },
      { click: { by: "role", role: "button", name: "Edit" } },
      { fill: { by: "label", name: "Display name", value: "Acme" } },
      {
        request: {
          method: "POST",
          url: "/api/settings",
          body: { enabled: true },
        },
      },
    ]);
    expect(spec.outcomes).toEqual([
      {
        id: "url_matches",
        description: "page URL matches",
        verify: { url: { matches: "\\/settings$" } },
      },
      {
        id: "text_visible_2",
        description: "expected text is visible",
        verify: { text: { contains: "Saved" } },
      },
    ]);

    const dir = await mkdtemp(join(tmpdir(), "cairntrace-import-pw-"));
    const specPath = join(dir, "admin_saves_settings.yml");
    await writeFile(specPath, imported.yaml);
    const parsed = await parseSpec(specPath);
    expect(parsed.spec.name).toBe("admin_saves_settings");
  });

  it("imports type, focus, selector/value waits, and .nth", () => {
    const imported = importPlaywright(
      [
        "test('Search flow', async ({ page }) => {",
        "  await page.goto('/search');",
        "  await page.getByLabel('Query').pressSequentially('hello', { delay: 20 });",
        "  await page.getByLabel('Query').focus();",
        "  await page.waitForSelector('#results', { timeout: 5000, state: 'visible' });",
        "  await expect(page.getByLabel('Query')).toHaveValue('hello', { timeout: 4000 });",
        "  await page.getByRole('button', { name: 'Result' }).nth(2).click();",
        "});",
      ].join("\n"),
      { sourcePath: "search.spec.ts" },
    );
    expect(imported.spec.steps).toEqual([
      { open: "/search" },
      { type: { by: "label", name: "Query", value: "hello", delayMs: 20 } },
      { focus: { by: "label", name: "Query" } },
      { wait: { selector: "#results", state: "visible", timeoutMs: 5000 } },
      {
        wait: {
          value: { by: "label", name: "Query", equals: "hello" },
          timeoutMs: 4000,
        },
      },
      {
        click: { by: "role", role: "button", name: "Result", nth: 2 },
      },
    ]);
    // Every step line mapped — no step was dropped to a TODO comment.
    expect(imported.todos.some((t) => t.includes("page."))).toBe(false);
  });

  it("leaves TODO comments for unmapped lines and inserts a placeholder outcome", () => {
    const imported = importPlaywright(
      [
        "test('Custom assertion', async ({ page }) => {",
        "  await page.goto('/dashboard');",
        "  await expect.poll(async () => 42).toBe(42);",
        "});",
      ].join("\n"),
    );

    expect(imported.todos).toEqual([
      "await expect.poll(async () => 42).toBe(42);",
      "No Playwright expect() assertion mapped; replace placeholder outcome.",
    ]);
    expect(imported.yaml).toContain("# TODO: await expect.poll");
    expect(imported.spec.outcomes[0]).toMatchObject({
      id: "todo_assertion",
      verify: { text: { contains: "TODO_replace_me" } },
    });
  });

  it("uses the nested test title and maps fixture locator assertions", async () => {
    const imported = importPlaywright(
      [
        "import { test, expect } from '@playwright/test';",
        "",
        "test.describe('Game Screen', () => {",
        "  test('game screen renders objective state', async ({ gamePage }) => {",
        "    await expect(gamePage.getByTestId('objective-ticker')).toBeVisible();",
        "    await expect(gamePage.getByRole('button', { name: 'Start' })).toBeVisible();",
        "    await expect(getByText('Roshan')).toBeVisible();",
        "    await expect(gamePage.getByTestId('objective-ticker')).toContainText('dead');",
        "  });",
        "});",
      ].join("\n"),
    );

    expect(imported.spec.intent).toBe("game screen renders objective state");
    expect(imported.spec.name).toBe("game_screen_renders_objective_state");
    expect(imported.todos).toEqual([]);
    expect(imported.spec.outcomes).toEqual([
      {
        id: "element_visible",
        description: "expected element is visible",
        verify: {
          count: {
            selector: '[data-testid="objective-ticker"]',
            atLeast: 1,
          },
        },
      },
      {
        id: "role_visible_2",
        description: "expected role is visible",
        verify: { count: { role: "button", atLeast: 1 } },
      },
      {
        id: "text_visible_3",
        description: "expected text is visible",
        verify: { text: { contains: "Roshan" } },
      },
      {
        id: "text_contains_4",
        description: "expected text is present",
        verify: {
          text: {
            contains: "dead",
            region: '[data-testid="objective-ticker"]',
          },
        },
      },
    ]);

    const dir = await mkdtemp(join(tmpdir(), "cairntrace-import-pw-fixture-"));
    const specPath = join(dir, "game_screen_renders_objective_state.yml");
    await writeFile(specPath, imported.yaml);
    await expect(parseSpec(specPath)).resolves.toMatchObject({
      spec: { name: "game_screen_renders_objective_state" },
    });
  });

  it("imports the first test and emits a TODO naming skipped tests", () => {
    const imported = importPlaywright(
      [
        "test('first case', async ({ page }) => {",
        "  await page.goto('/one');",
        "});",
        "test('second case', async ({ page }) => {",
        "  await page.goto('/two');",
        "});",
      ].join("\n"),
    );

    // First test imported as before…
    expect(imported.spec.intent).toBe("first case");
    expect(imported.spec.steps).toEqual([{ open: "/one" }]);
    // …and the second is named in a TODO instead of vanishing silently.
    expect(imported.todos.some((t) => t.includes("second case"))).toBe(true);
    expect(imported.yaml).toContain("# TODO:");
    expect(imported.yaml).toContain("second case");
  });

  it("drops .nth(N) on a selector locator with an explicit TODO", () => {
    const imported = importPlaywright(
      [
        "test('Rows', async ({ page }) => {",
        "  await page.locator('.row').nth(2).click();",
        "});",
      ].join("\n"),
    );

    // SelectorLocatorSchema doesn't support nth, so the locator stays valid
    // (no nth) and the dropped position is surfaced loudly instead of silently
    // retargeting the element.
    expect(imported.spec.steps).toEqual([
      { click: { by: "selector", selector: ".row" } },
    ]);
    expect(
      imported.todos.some((t) => t.includes(".nth(2)") && t.includes(".row")),
    ).toBe(true);
  });

  it("imports page.request.fetch with an explicit method", () => {
    const imported = importPlaywright(
      [
        "test('api', async ({ page }) => {",
        "  const res = await page.request.fetch('/api/items', { method: 'POST', data: { name: 'x' } });",
        "});",
      ].join("\n"),
    );

    expect(imported.spec.steps).toEqual([
      { request: { method: "POST", url: "/api/items", body: { name: "x" } } },
    ]);
  });

  it("imports toHaveURL(new RegExp(...)) as a url-matches outcome", () => {
    const imported = importPlaywright(
      [
        "test('nav', async ({ page }) => {",
        "  await expect(page).toHaveURL(new RegExp('/done$'));",
        "});",
      ].join("\n"),
    );

    expect(imported.spec.outcomes[0]).toMatchObject({
      verify: { url: { matches: "/done$" } },
    });
  });

  it("imports toContainText(text, options) as a text-contains outcome", () => {
    const imported = importPlaywright(
      [
        "test('text', async ({ page }) => {",
        "  await expect(page.locator('body')).toContainText('Saved', { ignoreCase: true, useInnerText: true });",
        "});",
      ].join("\n"),
    );

    expect(imported.spec.outcomes[0]).toMatchObject({
      verify: { text: { contains: "Saved" } },
    });
  });

  it("round-trips a spec through exportPlaywright and back", () => {
    const spec: Spec = {
      version: 1,
      name: "round_trip",
      intent: "Round trip the contract",
      mode: "normal",
      steps: [
        { open: "/start" },
        { request: { method: "POST", url: "/api/save", body: { ok: true } } },
      ],
      outcomes: [
        {
          id: "url_matches",
          description: "url matches",
          verify: { url: { matches: "/done$" } },
        },
        {
          id: "text_contains",
          description: "saved text",
          verify: { text: { contains: "Saved" } },
        },
      ],
    };

    const exported = exportPlaywright(spec);
    const imported = importPlaywright(exported.source);

    // request method + url survive the round trip
    const requestStep = imported.spec.steps?.find((s) => "request" in s);
    expect(requestStep).toMatchObject({
      request: { method: "POST", url: "/api/save" },
    });

    // url match survives
    expect(
      imported.spec.outcomes.some(
        (o) =>
          "url" in o.verify &&
          (o.verify.url as { matches?: string }).matches === "/done$",
      ),
    ).toBe(true);

    // text contains survives
    expect(
      imported.spec.outcomes.some(
        (o) =>
          "text" in o.verify &&
          (o.verify.text as { contains?: string }).contains === "Saved",
      ),
    ).toBe(true);
  });

  it("never treats test.step / hooks / test.use as tests and accepts test(title, options, fn)", () => {
    const source = [
      `import { expect, test } from "@playwright/test";`,
      ``,
      `test.use({ viewport: { width: 1280, height: 720 } });`,
      `test.beforeAll(async () => {});`,
      `test.beforeEach(async ({ page }) => { await page.goto("/warmup"); });`,
      ``,
      `async function openSettings(page) {`,
      `  await test.step("open settings", async () => {`,
      `    await page.getByRole("link", { name: "Settings" }).click();`,
      `  });`,
      `}`,
      ``,
      `test("checkout succeeds", { tag: ["@smoke"], annotation: { type: "issue", description: "x" } }, async ({ page }) => {`,
      `  await page.goto("/cart");`,
      `  await page.getByRole("button", { name: "Pay" }).click();`,
      `  await expect(page.getByText("Thanks")).toBeVisible();`,
      `});`,
      ``,
      `test.afterEach(async () => {});`,
    ].join("\n");

    const imported = importPlaywright(source);
    expect(imported.spec.name).toBe("checkout_succeeds");
    expect(imported.spec.steps).toEqual([
      { open: "/cart" },
      { click: { by: "role", role: "button", name: "Pay" } },
    ]);
    expect(imported.todos.some((todo) => todo.includes("Skipped test"))).toBe(
      false,
    );
  });

  it("imports a --project export: step ids from test.step, helpers, no scaffolding TODOs", () => {
    const spec: Spec = {
      version: 1,
      name: "project_round_trip",
      intent: "project exports import back with ids",
      mode: "normal",
      steps: [
        { id: "open_form", open: "/form" },
        {
          id: "fill_name",
          fill: { by: "label", name: "Name", value: "Ada" },
        },
        {
          id: "save",
          click: { by: "role", role: "button", name: "Save" },
        },
      ],
      outcomes: [
        {
          id: "saved_visible",
          description: "saved",
          verify: { text: { contains: "Saved" } },
        },
        {
          id: "console_clean",
          description: "no console errors",
          verify: { console: { errorsMax: 0 } },
        },
      ],
    };
    const project = exportPlaywrightProject([
      {
        spec,
        resolved: spec,
        path: "/tmp/flows/project_round_trip.yml",
        contractHashValid: true,
        origins: [],
        actionsByName: new Map(),
      },
    ]);
    const testSource = project.files.find(
      (file) => file.relPath === "tests/project_round_trip.spec.ts",
    )!.source;

    const imported = importPlaywright(testSource);
    expect(imported.spec.name).toBe("project_round_trip");
    expect(imported.spec.steps).toEqual([
      { id: "open_form", open: "/form" },
      {
        id: "fill_name",
        fill: { by: "label", name: "Name", value: "Ada" },
      },
      { id: "save", click: { by: "role", role: "button", name: "Save" } },
    ]);
    expect(imported.spec.outcomes).toEqual([
      {
        id: "saved_visible",
        description: "expected text is present",
        verify: { text: { contains: "Saved" } },
      },
      {
        id: "console_clean",
        description: "console errors stay within budget",
        verify: { console: { errorsMax: 0 } },
      },
    ]);
    expect(imported.todos).toEqual([]);
    expect(SpecSchema.safeParse(imported.spec).success).toBe(true);
  });

  it("imports a POM-style test: real title, expect mapped, page-object calls left as TODOs", () => {
    const source = [
      `import { expect, test, type Page } from "@playwright/test";`,
      ``,
      `class LoginPage {`,
      `  constructor(private readonly page: Page) {}`,
      `  async login(user: string, password: string) {`,
      `    await test.step("log in", async () => {`,
      `      await this.page.getByLabel("Email").fill(user);`,
      `      await this.page.getByLabel("Password").fill(password);`,
      `    });`,
      `  }`,
      `}`,
      ``,
      `test.describe("account", () => {`,
      `  test("user sees the dashboard after login", async ({ page }) => {`,
      `    const loginPage = new LoginPage(page);`,
      `    await page.goto("/login");`,
      `    await loginPage.login("demo@example.test", "pw");`,
      `    await expect(page.getByText("Dashboard")).toBeVisible();`,
      `  });`,
      `});`,
    ].join("\n");

    const imported = importPlaywright(source);
    expect(imported.spec.name).toBe("user_sees_the_dashboard_after_login");
    expect(imported.spec.steps).toEqual([{ open: "/login" }]);
    expect(imported.spec.outcomes).toEqual([
      {
        id: "text_visible",
        description: "expected text is visible",
        verify: { text: { contains: "Dashboard" } },
      },
    ]);
    expect(imported.todos).toContain(
      `await loginPage.login("demo@example.test", "pw");`,
    );
    expect(imported.todos.some((todo) => todo.includes("Skipped test"))).toBe(
      false,
    );
  });
});
