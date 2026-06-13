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
        verify: { text: { contains: "Saved" }, region: "page" },
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
      verify: { text: { contains: "TODO_replace_me" }, region: "page" },
    });
  });
});
