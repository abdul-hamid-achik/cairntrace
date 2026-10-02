import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { exportPlaywrightProject } from "../exporters/playwrightProject";
import { stepFileScopeAt } from "../runner/stepFiles";
import {
  ActionImportCycleError,
  DuplicateActionNameError,
  parseSpec,
  UnresolvedActionError,
} from "./parseSpec";

/**
 * A11: reusable actions may declare `imports:` (relative to the action file)
 * and `use:` other actions. Expansion is recursive, origins point at the
 * innermost file (heal and step-file scopes), cycles are parse errors, and
 * the Playwright project export calls the nested action's module.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-action-imports-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function write(rel: string, text: string): Promise<string> {
  const path = join(dir, rel);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
  return path;
}

const LOGIN_BASE = `version: 1
name: login_base
vars:
  user: viewer@demo.test
steps:
  - id: open_login
    open: /login
  - id: fill_email
    fill: { by: label, name: Email, value: "\${vars.user}" }
  - id: submit
    click: { by: role, role: button, name: Sign in }
`;

const LOGIN_AS_SUPPLIER = `version: 1
name: login_as_supplier
imports:
  - ../shared/login_base.yml
steps:
  - id: base_login
    use:
      action: login_base
      vars: { user: supplier@demo.test }
  - id: switch_role
    click: { by: role, role: button, name: Supplier view }
`;

function spec(body: string): string {
  return `version: 1
name: nested_actions
intent: A spec that reuses an action which reuses another.
outcomes:
  - id: ok
    description: ok
    verify: { url: { matches: "/home" } }
${body}`;
}

describe("imports inside reusable actions", () => {
  it("expands nested actions with their vars and tracks origins to the innermost file", async () => {
    const base = await write("actions/shared/login_base.yml", LOGIN_BASE);
    const supplier = await write(
      "actions/roles/login_as_supplier.yml",
      LOGIN_AS_SUPPLIER,
    );
    const specPath = await write(
      "flows/nested.yml",
      spec(`imports:
  - ../actions/roles/login_as_supplier.yml
steps:
  - use: login_as_supplier
  - open: /home
`),
    );
    const parsed = await parseSpec(specPath, { baseUrl: "https://demo.test" });
    expect(parsed.resolved.steps).toEqual([
      { id: "open_login", open: "https://demo.test/login" },
      {
        id: "fill_email",
        fill: { by: "label", name: "Email", value: "supplier@demo.test" },
      },
      { id: "submit", click: { by: "role", role: "button", name: "Sign in" } },
      {
        id: "switch_role",
        click: { by: "role", role: "button", name: "Supplier view" },
      },
      { open: "https://demo.test/home" },
    ]);
    expect(
      parsed.origins.map((origin) => [origin.filePath, origin.fileStepIdx]),
    ).toEqual([
      [base, 0],
      [base, 1],
      [base, 2],
      [supplier, 1],
      [specPath, 1],
    ]);
    expect([...parsed.actionsByName.keys()].toSorted()).toEqual([
      "login_as_supplier",
      "login_base",
    ]);
    expect(
      parsed.actionsByName.get("login_as_supplier")?.expandedStepCount,
    ).toBe(4);
    // Heal / step-file scopes find the nested action by path.
    expect(stepFileScopeAt(parsed, 1)).toMatchObject({
      declaringDir: dirname(base),
      action: { name: "login_base", path: base, stepIndex: 1 },
    });
    expect(stepFileScopeAt(parsed, 3)).toMatchObject({
      declaringDir: dirname(supplier),
      action: { name: "login_as_supplier", stepIndex: 1 },
    });
  });

  it("lets a nested action's defaults beat inherited vars; explicit call vars beat both", async () => {
    await write(
      "actions/fill_form.yml",
      `version: 1
name: fill_form
vars:
  name: Default
steps:
  - id: fill_name
    fill: { by: label, name: Name, value: "\${vars.name}" }
  - id: fill_note
    fill: { by: label, name: Note, value: "\${vars.note}" }
`,
    );
    await write(
      "actions/outer.yml",
      `version: 1
name: outer
imports:
  - fill_form.yml
steps:
  - use: fill_form
  - use:
      action: fill_form
      vars: { name: Explicit }
`,
    );
    const specPath = await write(
      "flows/scoped.yml",
      spec(`vars:
  note: from spec
imports:
  - ../actions/outer.yml
steps:
  - use:
      action: outer
      vars: { name: Outer, note: Called }
`),
    );
    const parsed = await parseSpec(specPath, { baseUrl: "https://demo.test" });
    const values = (parsed.resolved.steps ?? []).map(
      (step) => (step as { fill: { value: string } }).fill.value,
    );
    // fill_form defaults name: the outer call's name does not leak in;
    // note has no default there: the outer call's value beats the spec var.
    expect(values).toEqual(["Default", "Called", "Explicit", "Called"]);
  });

  it("resolves an action's use: against its importer's imports as a fallback", async () => {
    await write("actions/login_base.yml", LOGIN_BASE);
    await write(
      "actions/open_dashboard.yml",
      `version: 1
name: open_dashboard
steps:
  - use: login_base
  - open: /dashboard
`,
    );
    const specPath = await write(
      "flows/fallback.yml",
      spec(`imports:
  - ../actions/login_base.yml
  - ../actions/open_dashboard.yml
steps:
  - use: open_dashboard
`),
    );
    const parsed = await parseSpec(specPath);
    expect(parsed.resolved.steps).toHaveLength(4);
    expect(parsed.resolved.steps?.[1]).toMatchObject({
      fill: { value: "viewer@demo.test" },
    });
  });

  it("reports an action use: that no scope imports", async () => {
    await write(
      "actions/lonely.yml",
      `version: 1
name: lonely
steps:
  - use: nowhere
`,
    );
    const specPath = await write(
      "flows/lonely.yml",
      spec(`imports: [../actions/lonely.yml]
steps:
  - use: lonely
`),
    );
    await expect(parseSpec(specPath)).rejects.toBeInstanceOf(
      UnresolvedActionError,
    );
  });

  it("rejects an import cycle with the chain of files", async () => {
    await write(
      "actions/a.yml",
      `version: 1
name: a
imports: [./b.yml]
steps:
  - open: /a
`,
    );
    await write(
      "actions/b.yml",
      `version: 1
name: b
imports: [./a.yml]
steps:
  - open: /b
`,
    );
    const specPath = await write(
      "flows/cycle.yml",
      spec(`imports: [../actions/a.yml]
steps:
  - use: a
`),
    );
    const error = await parseSpec(specPath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionImportCycleError);
    expect((error as Error).message).toMatch(
      /^action import cycle: cycle\.yml → a\.yml → b\.yml → a\.yml/,
    );
  });

  it("rejects a use: cycle reached through the importer's scope", async () => {
    await write(
      "actions/ping.yml",
      `version: 1
name: ping
steps:
  - use: pong
`,
    );
    await write(
      "actions/pong.yml",
      `version: 1
name: pong
steps:
  - use: ping
`,
    );
    const specPath = await write(
      "flows/pingpong.yml",
      spec(`imports: [../actions/ping.yml, ../actions/pong.yml]
steps:
  - use: ping
`),
    );
    const error = await parseSpec(specPath).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ActionImportCycleError);
    expect((error as Error).message).toMatch(
      /^action use cycle: ping\.yml → pong\.yml → ping\.yml/,
    );
  });

  it("rejects two files that declare the same action name", async () => {
    await write("actions/one/login_base.yml", LOGIN_BASE);
    await write("actions/two/login_base.yml", LOGIN_BASE);
    const specPath = await write(
      "flows/dupes.yml",
      spec(`imports: [../actions/one/login_base.yml, ../actions/two/login_base.yml]
steps:
  - use: login_base
`),
    );
    await expect(parseSpec(specPath)).rejects.toBeInstanceOf(
      DuplicateActionNameError,
    );
  });

  it("exports a nested action as a call to its own module", async () => {
    await write("actions/shared/login_base.yml", LOGIN_BASE);
    await write("actions/roles/login_as_supplier.yml", LOGIN_AS_SUPPLIER);
    const specPath = await write(
      "flows/nested_export.yml",
      spec(`imports:
  - ../actions/roles/login_as_supplier.yml
steps:
  - use: login_as_supplier
  - id: go_home
    open: https://demo.test/home
`),
    );
    const parsed = await parseSpec(specPath);
    const result = exportPlaywrightProject([parsed]);
    const supplier = result.files.find(
      (file) => file.relPath === "actions/login_as_supplier.ts",
    )?.source;
    const base = result.files.find(
      (file) => file.relPath === "actions/login_base.ts",
    )?.source;
    expect(base).toContain("export async function login_base(page: Page");
    expect(supplier).toContain(`import { login_base } from "./login_base";`);
    expect(supplier).toContain(
      `await login_base(page, { "user": "supplier@demo.test" });`,
    );
    expect(supplier).not.toContain("not expanded");
    const testSource = result.files.find((file) =>
      file.relPath.startsWith("tests/"),
    )?.source;
    expect(testSource).toContain("await login_as_supplier(page);");
    expect(testSource).toContain('await page.goto("https://demo.test/home"');
  });
});
