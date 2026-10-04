import {
  cp,
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runImportPlaywright } from "../../cli/commands/import";
import { importPlaywright } from "./playwrightImporter";

/**
 * The shape real consumer suites have (neutral copy in
 * `__fixtures__/consumer-shape`, stored as `.ts.txt` so the repo's own
 * typecheck / lint / knip leave it alone): page objects behind an
 * `export *` barrel and an `export { A as B } from` alias, the legacy
 * selector-first page API (`page.fill(sel, v)`, `waitForSelector("css=… >>
 * text=…")`), a fixtures module re-exported by a barrel whose fixture builds
 * its page with `browser.newContext()`, a `test.use` option and a page-object
 * flag passed as a literal. Counts are asserted exactly so a regression in
 * any of those shows.
 */

let root: string;

async function renameTsTxt(dir: string): Promise<void> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) await renameTsTxt(path);
    else if (entry.name.endsWith(".ts.txt"))
      await rename(path, path.slice(0, -".txt".length));
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-consumer-shape-"));
  await cp(join(import.meta.dirname, "__fixtures__", "consumer-shape"), root, {
    recursive: true,
  });
  await renameTsTxt(root);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

async function importFile(rel: string, test?: string) {
  const sourcePath = join(root, rel);
  return importPlaywright(await readFile(sourcePath, "utf8"), {
    sourcePath,
    ...(test ? { test } : {}),
  });
}

describe("AST importer over the consumer shape", () => {
  it("follows barrels into page objects and a util fixture that builds its own context", async () => {
    const r = await importFile("e2e/specs/account/sign-in.spec.ts");
    expect(r.coverage).toEqual({
      mapped: 7,
      approximated: 4,
      unmapped: 1,
      total: 12,
    });
    expect(r.spec.steps).toEqual([
      // fixture: option from test.use, page from browser.newContext()
      { open: "/accounts/A100002/regular" },
      // page object found through `export *` from ../../pages
      { open: "/signin" },
      // legacy page.fill(`css=[…] >> input`, value) inside the base class
      {
        fill: {
          by: "selector",
          selector: '[data-field-key="email"] input',
          value: "regular+A100002@example.test",
        },
      },
      {
        fill: {
          by: "selector",
          selector: '[data-field-key="password"] input',
          value: "${secrets.ACCOUNT_PASSWORD}",
        },
      },
      { click: { by: "role", role: "button", name: "Sign In" } },
      // `if (expectCode)` with a literal false: no verify-code fill
      { wait: { text: "Get Started" } },
      { click: { by: "role", role: "link", name: "Customers" } },
    ]);
    expect(r.approximations.join("\n")).toContain(
      "browser.newContext() became the spec's own browser context",
    );
    expect(r.approximations.join("\n")).toContain(
      "if condition is false for this call",
    );
    // the one TODO left is the negated URL assertion
    expect(r.todos.filter((t) => !t.startsWith("Skipped test"))).toEqual([
      expect.stringContaining("not.toHaveURL"),
    ]);
  });

  it("maps the legacy selector-first page API and an aliased named re-export", async () => {
    const r = await importFile("e2e/specs/account/sign-in.spec.ts", "2");
    expect(r.coverage).toEqual({
      mapped: 8,
      approximated: 2,
      unmapped: 0,
      total: 10,
    });
    expect(r.spec.steps).toEqual([
      { open: "/signin" },
      {
        fill: { by: "selector", selector: "#email", value: "ada@example.test" },
      },
      { check: { by: "selector", selector: "#remember" } },
      { type: { by: "selector", selector: "#note", value: "hello" } },
      { click: { by: "text", text: "Continue" } },
      { wait: { text: "Welcome back" } },
      // `.modal >> button:has-text("Continue")` keeps its text filter
      {
        click: {
          by: "selector",
          selector: ".modal button",
          hasText: "Continue",
        },
      },
    ]);
    expect(r.spec.outcomes.map((o) => o.verify)).toEqual([
      { text: { equals: "Welcome", region: ".heading .text" } },
      { url: { endsWith: "/dashboard" } },
    ]);
  });

  it("refuses to write a draft that maps nothing unless --allow-empty", async () => {
    const out = join(root, "opaque.yml");
    const refused = await runImportPlaywright(
      join(root, "e2e/specs/opaque.spec.ts"),
      { out },
    );
    expect(refused.status).toBe("refused");
    expect(refused.warnings[0]).toMatch(/^nothing was mapped/);
    expect(refused.todos.join("\n")).toContain("seedEverything");
    await expect(readFile(out, "utf8")).rejects.toThrow();
    const allowed = await runImportPlaywright(
      join(root, "e2e/specs/opaque.spec.ts"),
      { out, allowEmpty: true },
    );
    expect(allowed.status).toBe("written");
  });

  it("refuses to overwrite an existing file unless --force", async () => {
    const out = join(root, "existing.yml");
    await writeFile(out, "# mine\n");
    await expect(
      runImportPlaywright(join(root, "e2e/specs/account/sign-in.spec.ts"), {
        out,
      }),
    ).rejects.toThrow(/already exists; pass --force/);
    expect(await readFile(out, "utf8")).toBe("# mine\n");
    const forced = await runImportPlaywright(
      join(root, "e2e/specs/account/sign-in.spec.ts"),
      { out, force: true },
    );
    expect(forced.status).toBe("written");
    expect(await readFile(out, "utf8")).toContain("name: member_signs_in");
  });
});
