import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { parseSpec } from "../parser/parseSpec";
import { SpecSchema } from "../schema/spec.v1";
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
        verify: { count: { text: "Saved", atLeast: 1 } },
      },
    ]);

    const dir = await mkdtemp(join(tmpdir(), "cairntrace-import-pw-"));
    const specPath = join(dir, "admin_saves_settings.yml");
    await writeFile(specPath, imported.yaml);
    const parsed = await parseSpec(specPath);
    expect(parsed.spec.name).toBe("admin_saves_settings");
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
        verify: { count: { text: "Roshan", atLeast: 1 } },
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
});
