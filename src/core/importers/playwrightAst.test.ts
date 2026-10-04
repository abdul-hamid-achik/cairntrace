import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { writeCjsHost } from "../../testing/hostTrees";
import { SpecSchema } from "../schema/spec.v1";
import { importPlaywright } from "./playwrightImporter";
import { loadTypescript, TypescriptUnavailableError } from "./typescriptLoader";

/**
 * The AST importer over representative `.spec.ts` shapes: call chains over
 * several lines, `test.step`, locator filters, page objects (fields, getters,
 * a base class, across files), custom fixtures read from the test file's own
 * imports, helpers, and constructs that must become TODOs, not silent drops.
 * Trees are written to a temp dir (no stray TypeScript in the repo).
 */

let root: string;
beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "cairn-import-ast-"));
});
afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(root, "t-"));
  for (const [rel, text] of Object.entries(files)) {
    const path = join(dir, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, text);
  }
  return dir;
}

function importFile(dir: string, rel: string, test?: string) {
  const path = join(dir, rel);
  const source = readFileSync(path, "utf8");
  return importPlaywright(source, {
    sourcePath: path,
    ...(test ? { test } : {}),
  });
}

describe("AST importer: call shapes", () => {
  it("maps multi-line chains, role+name, testid, filter, nth/first, test.step and locator assertions", () => {
    const imported = importPlaywright(`
import { test, expect } from "@playwright/test";

test("browse orders", async ({ page }) => {
  await test.step("open the list", async () => {
    await page.goto("/orders", { waitUntil: "networkidle" });
    await page
      .getByRole("link", { name: "Orders", exact: true })
      .first()
      .click();
  });
  await page.getByTestId("search").fill("widget");
  await page.locator(".row").filter({ hasText: "Widget" }).nth(1).click();
  await page.getByPlaceholder("Filter").press("Enter");
  await page.keyboard.press("Tab");
  await page.getByLabel("Accept").check();
  await page.getByLabel("Color").selectOption({ label: "Blue" });
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(250);
  await page.waitForURL("**/orders/*");
  await expect(page.getByTestId("banner")).toHaveText("Welcome");
  await expect(page.locator("#items li")).toHaveCount(2);
  await expect(page).toHaveURL(/orders$/);
  await expect(page.getByText("Done")).toBeVisible();
  await expect(page.getByText("Error")).toBeHidden();
  await expect(page.locator("#save")).toBeDisabled();
});
`);
    const spec = SpecSchema.parse(parseYaml(imported.yaml));
    expect(spec.steps).toEqual([
      {
        id: "open_the_list",
        open: { path: "/orders", waitUntil: "networkidle" },
      },
      {
        click: {
          by: "role",
          role: "link",
          name: "Orders",
          exact: true,
          nth: 0,
        },
      },
      { fill: { by: "testid", testid: "search", value: "widget" } },
      {
        click: { by: "selector", selector: ".row", hasText: "Widget", nth: 1 },
      },
      {
        press: "Enter",
        target: { by: "selector", selector: '[placeholder="Filter"]' },
      },
      { press: "Tab" },
      { check: { by: "label", name: "Accept" } },
      { select: { by: "label", name: "Color", label: "Blue" } },
      { wait: { load: "networkidle" } },
      { wait: { ms: 250 } },
      { wait: { url: { pattern: "^.*/orders/[^/]*$" } } },
      { expect: { by: "selector", selector: "#save", enabled: false } },
    ]);
    expect(spec.outcomes.map((o) => o.verify)).toEqual([
      { text: { equals: "Welcome", region: '[data-testid="banner"]' } },
      { count: { selector: "#items li", equals: 2 } },
      { url: { matches: "orders$" } },
      { text: { contains: "Done" } },
      { notText: { contains: "Error" } },
    ]);
    expect(imported.todos).toEqual([]);
    // approximations are reported, not hidden
    expect(imported.coverage.approximated).toBeGreaterThan(0);
    expect(imported.yaml).toContain("# APPROXIMATED:");
    expect(imported.coverage.total).toBe(
      imported.coverage.mapped +
        imported.coverage.approximated +
        imported.coverage.unmapped,
    );
  });

  it("reports unmapped constructs inline and in the coverage, never dropping them", () => {
    const imported = importPlaywright(`
test("odd", async ({ page }) => {
  await page.goto("/x");
  if (process.env.FLAG) {
    await page.getByText("Maybe").click();
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.getByRole("row").and(page.getByText("x")).click();
  await page.locator("//div[@id='x']").click();
  await page.locator("div:visible").click();
  await expect.poll(async () => 1).toBe(1);
  await expect(page.getByRole("checkbox")).toBeChecked();
  await expect(page.getByText("ok")).toBeVisible();
});
`);
    expect(imported.coverage.unmapped).toBe(7);
    expect(imported.coverage.mapped).toBe(2);
    expect(imported.todos).toHaveLength(7);
    // each TODO names the construct and the reason
    expect(imported.todos[0]).toContain("If control flow is not imported");
    expect(imported.todos.join("\n")).toContain("XPath selector");
    expect(imported.todos.join("\n")).toContain("Playwright-only CSS");
    expect(imported.todos.join("\n")).toContain("toBeChecked");
    // inline TODO comments land before the step they precede in the YAML
    expect(imported.yaml).toMatch(/# TODO: await page\.evaluate/);
    expect(SpecSchema.safeParse(parseYaml(imported.yaml)).success).toBe(true);
  });

  it("imports the chosen test with --test and names the others", () => {
    const source = `
test("first case", async ({ page }) => { await page.goto("/one"); });
test("second case", async ({ page }) => { await page.goto("/two"); });
test("third case", async ({ page }) => { await page.goto("/three"); });
`;
    const byTitle = importPlaywright(source, { test: "second" });
    expect(byTitle.spec.steps).toEqual([{ open: "/two" }]);
    expect(byTitle.todos.some((t) => t.includes("first case"))).toBe(true);
    expect(byTitle.todos.some((t) => t.includes("third case"))).toBe(true);
    expect(importPlaywright(source, { test: "3" }).spec.steps).toEqual([
      { open: "/three" },
    ]);
    const none = importPlaywright(source, { test: "nope" });
    expect(none.todos.some((t) => t.includes("No test matches"))).toBe(true);
  });

  it("maps request fixtures, with credential headers and secret-named body keys as placeholders", () => {
    const token = ["tok", "en-", String(Date.now())].join("");
    const imported = importPlaywright(`
test("api", async ({ request }) => {
  await request.post("/api/session", {
    data: { user: "ada", password: "${token}" },
    headers: { Authorization: "Bearer ${token}", "x-trace": "1" },
  });
});
`);
    expect(imported.spec.steps).toEqual([
      {
        request: {
          method: "POST",
          url: "/api/session",
          headers: {
            Authorization: "${secrets.AUTHORIZATION}",
            "x-trace": "1",
          },
          body: { user: "ada", password: "${secrets.PASSWORD}" },
        },
      },
    ]);
    expect(imported.yaml).not.toContain(token);
  });

  it("never writes a typed password literal; env values keep their placeholder", () => {
    const literal = ["pw", String(process.pid), "x"].join("-");
    const imported = importPlaywright(`
test("login", async ({ page }) => {
  await page.getByLabel("Password").fill("${literal}");
  await page.getByTestId("api-key").fill("${literal}");
  await page.locator('input[type="password"]').fill("${literal}");
  await page.getByLabel("Email").fill(process.env.LOGIN_EMAIL!);
  await page.getByLabel("Pin code").fill(process.env.PIN_CODE!);
});
`);
    expect(imported.yaml).not.toContain(literal);
    expect(imported.spec.steps).toEqual([
      { fill: { by: "label", name: "Password", value: "${secrets.PASSWORD}" } },
      {
        fill: { by: "testid", testid: "api-key", value: "${secrets.API_KEY}" },
      },
      {
        fill: {
          by: "selector",
          selector: 'input[type="password"]',
          value: "${secrets.PASSWORD}",
        },
      },
      { fill: { by: "label", name: "Email", value: "${env.LOGIN_EMAIL}" } },
      { fill: { by: "label", name: "Pin code", value: "${secrets.PIN_CODE}" } },
    ]);
  });
});

describe("AST importer: page objects and fixtures", () => {
  const files = {
    "pages/base.ts": `
import type { Page } from "@playwright/test";
export class BasePage {
  constructor(protected readonly page: Page) {}
  async open(path: string) {
    await this.page.goto(path);
  }
}
`,
    "pages/login.ts": `
import type { Page } from "@playwright/test";
import { BasePage } from "./base";

export class LoginPage extends BasePage {
  readonly email = this.page.getByLabel("Email");
  get submit() {
    return this.page.getByRole("button", { name: "Sign in" });
  }
  constructor(page: Page) {
    super(page);
  }
  async signIn(user: string, password: string) {
    await this.open("/login");
    await this.email.fill(user);
    await this.page.getByLabel("Password").fill(password);
    await this.submit.click();
  }
}
`,
    "fixtures.ts": `
import { test as base } from "@playwright/test";
import { LoginPage } from "./pages/login";

export const test = base.extend<{ loginPage: LoginPage; tenant: string; ordersPage: unknown }>({
  tenant: ["acme", { option: true }],
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },
  ordersPage: async ({ page, tenant }, use) => {
    await page.goto("/orders?tenant=" + tenant);
    await use({ rows: page.locator(".order-row") });
    await page.goto("/logout");
  },
});
export { expect } from "@playwright/test";
`,
  };

  it("inlines a page-object method defined across files (base class, field, getter)", () => {
    const dir = tree({
      ...files,
      "a.spec.ts": `
import { test, expect } from "@playwright/test";
import { LoginPage } from "./pages/login";

test("signs in", async ({ page }) => {
  const login = new LoginPage(page);
  await login.signIn("ada@example.test", "hunter2");
  await expect(page.getByText("Welcome")).toBeVisible();
});
`,
    });
    const imported = importFile(dir, "a.spec.ts");
    expect(imported.todos).toEqual([]);
    expect(imported.spec.steps).toEqual([
      { open: "/login" },
      { fill: { by: "label", name: "Email", value: "ada@example.test" } },
      { fill: { by: "label", name: "Password", value: "${secrets.PASSWORD}" } },
      { click: { by: "role", role: "button", name: "Sign in" } },
    ]);
    expect(imported.yaml).not.toContain("hunter2");
  });

  it("resolves fixtures in the test signature from the fixtures module (setup runs, teardown is a TODO)", () => {
    const dir = tree({
      ...files,
      "b.spec.ts": `
import { test, expect } from "./fixtures";

test("lists orders", async ({ page, loginPage, ordersPage }) => {
  await loginPage.signIn("ada@example.test", "pw");
  await page.getByRole("tab", { name: "Open" }).click();
  await expect(page.locator(".order-row")).toHaveCount(3);
});
`,
    });
    const imported = importFile(dir, "b.spec.ts");
    // Fixture setup runs before the test body, in signature order: ordersPage's
    // setup (tenant option default "acme") comes first, then the body.
    expect(imported.spec.steps?.[0]).toEqual({ open: "/orders?tenant=acme" });
    expect(imported.spec.steps?.[1]).toEqual({ open: "/login" });
    expect(imported.spec.outcomes[0]?.verify).toEqual({
      count: { selector: ".order-row", equals: 3 },
    });
    // the fixture teardown after use() is named, not dropped
    expect(imported.todos.join("\n")).toContain("fixture teardown");
  });

  it("names a host fixture it cannot resolve instead of guessing", () => {
    const imported = importPlaywright(`
test("uses a fixture", async ({ page, adminSession }) => {
  await adminSession.login();
  await page.goto("/admin");
});
`);
    expect(imported.spec.steps).toEqual([{ open: "/admin" }]);
    expect(imported.todos[0]).toContain(
      "fixture adminSession is defined outside this file",
    );
  });

  it("inlines same-file helper functions and beforeEach hooks, and TODOs the other hooks", () => {
    const imported = importPlaywright(`
import { test, expect } from "@playwright/test";

async function openSettings(page, tab: string) {
  await page.getByRole("link", { name: "Settings" }).click();
  await page.getByRole("tab", { name: tab }).click();
}

test.beforeEach(async ({ page }) => {
  await page.goto("/home");
});
test.afterEach(async ({ page }) => {
  await page.goto("/logout");
});

test("changes settings", async ({ page }) => {
  await openSettings(page, "Profile");
  await expect(page.getByLabel("Name")).toHaveValue("Ada");
});
`);
    expect(imported.spec.steps).toEqual([
      { open: "/home" },
      { click: { by: "role", role: "link", name: "Settings" } },
      { click: { by: "role", role: "tab", name: "Profile" } },
      { wait: { value: { by: "label", name: "Name", equals: "Ada" } } },
    ]);
    expect(imported.todos.join("\n")).toContain(
      "test.afterEach hook is not imported",
    );
  });
});

describe("AST importer: host trees (the shape of a real e2e package)", () => {
  it("imports a spec that uses the host's fixtures module and page object", () => {
    const hostRoot = mkdtempSync(join(root, "host-"));
    const host = writeCjsHost(hostRoot);
    mkdirSync(join(host.e2e, "tests"), { recursive: true });
    const spec = join(host.e2e, "tests", "orders.spec.ts");
    const source = `import { expect } from "@playwright/test";
import { test } from "../fixtures";

test.describe("orders", () => {
  test("member opens an order", async ({ memberSession, ordersPage, page }) => {
    await ordersPage.openOrder("42", "items");
    await ordersPage.openOrder("43");
    await expect(page.getByRole("heading", { name: "Order 42" })).toBeVisible();
  });
});
`;
    writeFileSync(spec, source);
    const imported = importPlaywright(source, { sourcePath: spec });
    expect(imported.spec.steps).toEqual([
      // memberSession's setup (tenant option default "acme"), in signature order
      { open: "/login?tenant=acme" },
      // OrdersPage.openOrder through the BasePage-derived POM; an omitted argument is falsy
      { open: "/orders/42?tab=items" },
      { open: "/orders/43" },
    ]);
    expect(imported.todos).toEqual([]);
    expect(imported.spec.outcomes[0]?.verify).toEqual({
      text: { contains: "Order 42" },
    });
    expect(SpecSchema.safeParse(parseYaml(imported.yaml)).success).toBe(true);
  });
});

describe("typescript resolution", () => {
  it("prefers the project's own typescript, and fails clearly when none is found", () => {
    const dir = mkdtempSync(join(root, "ts-"));
    mkdirSync(join(dir, "node_modules", "typescript"), { recursive: true });
    writeFileSync(
      join(dir, "node_modules", "typescript", "package.json"),
      JSON.stringify({
        name: "typescript",
        version: "0.0.0",
        main: "index.js",
      }),
    );
    writeFileSync(
      join(dir, "node_modules", "typescript", "index.js"),
      "module.exports = { createSourceFile() {}, marker: 'host' };",
    );
    const host = loadTypescript(dir) as unknown as { marker?: string };
    expect(host.marker).toBe("host");

    const bare = mkdtempSync(join(root, "bare-"));
    expect(() => loadTypescript(bare, { own: false })).toThrow(
      TypescriptUnavailableError,
    );
    expect(() => loadTypescript(bare, { own: false })).toThrow(
      /no `typescript` package in or above/,
    );
    // cairntrace's own copy is the fallback
    expect(typeof loadTypescript(bare).createSourceFile).toBe("function");

    // A TypeScript with no JavaScript API (the native TS 7 compiler): skipped
    // for cairntrace's own, and named precisely when nothing else is left.
    const native = mkdtempSync(join(root, "native-"));
    mkdirSync(join(native, "node_modules", "typescript"), { recursive: true });
    writeFileSync(
      join(native, "node_modules", "typescript", "package.json"),
      JSON.stringify({
        name: "typescript",
        version: "7.0.0",
        main: "index.js",
      }),
    );
    writeFileSync(
      join(native, "node_modules", "typescript", "index.js"),
      "module.exports = { version: '7.0.0' };",
    );
    expect(typeof loadTypescript(native).createSourceFile).toBe("function");
    expect(() => loadTypescript(native, { own: false })).toThrow(
      /the project's typescript 7\.0\.0 \(.*\): it has no JavaScript API \(no createSourceFile/,
    );
    expect(() => loadTypescript(native, { own: false })).not.toThrow(
      /npm i -D/,
    );
  });
});
