/**
 * E9 through the CLI code paths: an export map binds cairn actions to a host
 * tree's fixtures and page objects, in a CommonJS and an ES module host
 * (proved with the host's own tsc and `--verify`), unmapped actions become
 * generated page objects over the host's base page, and a request-based login
 * becomes a storageState with no secret in anything generated.
 */
import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPORT_MANIFEST_FILE,
  type ExportManifestV1,
} from "../../core/exporters/exportManifest";
import {
  linkHostToolchain,
  writeCjsHost,
  writeEsmHost,
  type HostTree,
} from "../../testing/hostTrees";
import {
  checkPlaywrightExport,
  writeProjectExport,
  type ExportPlaywrightOptions,
} from "./export";
import { assertMapFlags } from "./exportHost";
import { verifyPlaywrightExport } from "./exportVerify";
import { expandSpecArgs } from "./run";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cairn-map-export-")));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const LOGIN_MEMBER = `version: 1
name: login_member
description: sign in as a member of a tenant
vars:
  role: member
  tenant: acme
steps:
  - id: open_login
    open: "http://localhost:8787/login.html?tenant=\${vars.tenant}"
  - id: submit
    click: { by: testid, testid: "login-\${vars.role}" }
`;

const OPEN_ORDER = `version: 1
name: open_order
vars:
  orderId: "1001"
  tab: summary
steps:
  - id: open_it
    open: "http://localhost:8787/orders/\${vars.orderId}.html?tab=\${vars.tab}"
`;

const PICK_FILTER = `version: 1
name: pick_filter
vars:
  label: open
steps:
  - id: choose
    click: { by: testid, testid: "filter-\${vars.label}" }
`;

/** Request-only and auth-like: an API login. */
const SIGN_IN_API = `version: 1
name: sign_in_api
vars:
  email: casey@example.test
steps:
  - id: post_login
    request:
      method: POST
      url: /api/login
      headers: { content-type: application/json }
      body: { email: "\${vars.email}", password: "\${secrets.CAIRN_TEST_API_PASSWORD}" }
      expectStatus: 200
      capture: { token: $.token }
      assign: session
  - id: touch_profile
    request:
      url: /api/profile
      headers: { authorization: "Bearer \${requests.session.captures.token}" }
      expectStatus: 200
`;

/** Drives the page and uses an unmapped action that itself calls a mapped one. */
const NESTED = `version: 1
name: open_and_filter
imports:
  - open_order.yml
  - pick_filter.yml
steps:
  - use:
      action: open_order
      vars: { orderId: "3003" }
  - use: pick_filter
`;

const OUTCOME = `outcomes:
  - id: on_order
    description: the order page shows
    verify:
      url: { matches: /orders/ }
`;

const ORDERS_SPEC = `version: 1
name: orders_flow
intent: a signed-in member opens an order and filters its lines
coldStart: guest
imports:
  - ../actions/login_member.yml
  - ../actions/open_order.yml
  - ../actions/pick_filter.yml
${OUTCOME}steps:
  - use: login_member
  - use:
      action: open_order
      vars: { orderId: "2002", tab: details }
  - use: pick_filter
`;

const API_SPEC = `version: 1
name: api_orders_flow
intent: an API-signed-in member opens an order
coldStart: guest
imports:
  - ../actions/sign_in_api.yml
  - ../actions/open_order.yml
${OUTCOME}steps:
  - use: sign_in_api
  - use: open_order
`;

const BASE_MAP = `version: 1
test:
  import: ./fixtures
basePage:
  import: ./pom/base-page
  name: BasePage
actions:
  login_member:
    note: the host's session fixture signs the member in
    fixture:
      name: memberSession
      type: "{ user: string }"
      vars:
        role: { const: member }
        tenant: { option: tenant }
  open_order:
    method:
      import: ./pom/orders-page
      class: OrdersPage
      call: openOrder
      args:
        - { var: orderId }
        - { var: tab }
`;

interface Scenario {
  tree: HostTree;
  flows: string;
  source: string;
  mapPath: string;
  prettierLog: string;
}

function scenario(
  kind: "cjs" | "esm",
  files: { actions?: Record<string, string>; specs: Record<string, string> },
  map: string | undefined = BASE_MAP,
): Scenario {
  const root = tmpRoot();
  const hostRoot = join(root, "host");
  const tree = kind === "cjs" ? writeCjsHost(hostRoot) : writeEsmHost(hostRoot);
  linkHostToolchain(hostRoot, { eslint: true });
  const source = join(root, "src");
  const flows = join(source, "flows");
  mkdirSync(flows, { recursive: true });
  mkdirSync(join(source, "actions"), { recursive: true });
  for (const [name, text] of Object.entries(files.actions ?? {})) {
    writeFileSync(join(source, "actions", `${name}.yml`), text);
  }
  for (const [name, text] of Object.entries(files.specs)) {
    writeFileSync(join(flows, `${name}.yml`), text);
  }
  // The map sits in the host package, like the host's own fixtures.
  const mapPath = join(tree.e2e, "export.map.yml");
  if (map !== undefined) writeFileSync(mapPath, map);
  return { tree, flows, source, mapPath, prettierLog: join(root, "p.log") };
}

const ACTIONS = {
  login_member: LOGIN_MEMBER,
  open_order: OPEN_ORDER,
  pick_filter: PICK_FILTER,
  sign_in_api: SIGN_IN_API,
};

async function exportInto(
  s: Scenario,
  extra: Record<string, unknown> = {},
  map: string | undefined = s.mapPath,
) {
  const paths = await expandSpecArgs([s.flows]);
  return writeProjectExport(
    paths,
    "ts",
    {
      into: s.tree.into,
      outDir: s.tree.into,
      hostConfig: s.tree.config,
      ...(map !== undefined ? { mapFile: map } : {}),
      ...extra,
    },
    s.flows,
  );
}

const text = (path: string): string => readFileSync(path, "utf8");

function listFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const name of readdirSync(current)) {
      const full = join(current, name);
      if (statSync(full).isDirectory()) walk(full);
      else out.push(relative(dir, full));
    }
  };
  walk(dir);
  return out.toSorted();
}

async function tsc(
  host: HostTree,
  project: string,
): Promise<{ exitCode: number; output: string }> {
  const run = await execa(
    join(host.root, "node_modules", ".bin", "tsc"),
    ["--noEmit", "--pretty", "false", "-p", project],
    { cwd: dirname(project), reject: false, timeout: 120_000 },
  );
  return {
    exitCode: run.exitCode ?? 1,
    output: `${run.stdout}\n${run.stderr}`,
  };
}

describe("fixture and method mappings (CommonJS host)", () => {
  it("destructures the fixture, calls the page object, and compiles under the host's tsc", async () => {
    const s = scenario("cjs", {
      actions: ACTIONS,
      specs: { orders_flow: ORDERS_SPEC },
    });
    const report = await exportInto(s);
    const spec = text(join(s.tree.into, "orders_flow.spec.ts"));

    // The host's `test`, re-based from the map's directory; expect stays Playwright's.
    expect(spec).toContain(`import { test } from "@e2e/fixtures";`);
    expect(spec).toContain(`import { expect } from "@playwright/test";`);
    expect(spec).not.toContain(`import { test } from "@playwright/test"`);
    // The fixture is in the signature and the login steps are not inlined.
    expect(spec).toContain("async ({ page, memberSession }) => {");
    expect(spec).toContain("void memberSession;");
    expect(spec).not.toContain("login-member");
    expect(spec).not.toContain("/login.html");
    // The method call, arguments mapped from the action's vars.
    expect(spec).toContain(
      `import { OrdersPage } from "@e2e/pom/orders-page";`,
    );
    expect(spec).toContain(
      `await new OrdersPage(page).openOrder("2002", "details");`,
    );
    // The unmapped action: a generated class over the host's base page.
    expect(spec).toContain(
      `import { PickFilterPage } from "@e2e/tests/cairn/lib/pages/pick-filter-page";`,
    );
    expect(spec).toContain(`await new PickFilterPage(page).pickFilter();`);
    const page = text(join(s.tree.into, "lib", "pages", "pick-filter-page.ts"));
    expect(page).toContain(`import { BasePage } from "@e2e/pom/base-page";`);
    expect(page).toContain("export class PickFilterPage extends BasePage {");
    expect(page).toContain("async pickFilter(vars: { label?: string } = {}");
    expect(page).toContain("const page = this.page;");
    // No actions/ modules: every action is bound or a page object.
    expect(
      listFiles(s.tree.into).some((file) => file.startsWith("actions/")),
    ).toBe(false);

    expect(report.map).toMatchObject({
      file: "../../export.map.yml",
      strict: false,
    });
    expect(
      report.map?.actions.map((entry) => [
        entry.action,
        entry.treatment,
        entry.target,
      ]),
    ).toEqual([
      ["login_member", "fixture", "memberSession"],
      ["open_order", "method", "OrdersPage.openOrder"],
      ["pick_filter", "generated", "PickFilterPage.pickFilter"],
    ]);
    expect(report.map?.actions[0]).toMatchObject({
      type: "{ user: string }",
      note: "the host's session fixture signs the member in",
      specs: ["orders_flow"],
    });
    expect(report.specs[0]?.coverage.fixme).toBe(false);

    const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);

  it("maps a var to a fixture option and uses a fixture-provided instance", async () => {
    const s = scenario(
      "cjs",
      {
        actions: ACTIONS,
        specs: {
          orders_flow: ORDERS_SPEC.replace(
            "  - use: login_member",
            "  - use:\n      action: login_member\n      vars: { tenant: globex }",
          ),
        },
      },
      BASE_MAP.replace(
        "      import: ./pom/orders-page\n      class: OrdersPage\n      call: openOrder\n",
        "      import: ./pom/orders-page\n      class: OrdersPage\n      call: openOrder\n      instance: { fixture: ordersPage }\n",
      ),
    );
    await exportInto(s);
    const spec = text(join(s.tree.into, "orders_flow.spec.ts"));
    expect(spec).toContain('test.use({ tenant: "globex" });');
    expect(spec).toContain("async ({ page, memberSession, ordersPage }) => {");
    expect(spec).toContain(`await ordersPage.openOrder("2002", "details");`);
    expect(spec).not.toContain("new OrdersPage");
    const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);

  it("verifies a mapped export statically (host tsc + eslint + --list) and checks it fresh", async () => {
    const s = scenario("cjs", {
      actions: ACTIONS,
      specs: { orders_flow: ORDERS_SPEC },
    });
    await exportInto(s);
    const { report, exitCode } = await verifyPlaywrightExport({
      exportDir: s.tree.into,
    });
    const gates = Object.fromEntries(report.gates.map((g) => [g.id, g]));
    expect(gates["sentinels"]?.status).toBe("passed");
    expect(gates["freshness"]?.status, gates["freshness"]?.summary).toBe(
      "passed",
    );
    expect(gates["typecheck"]?.status, gates["typecheck"]?.summary).toBe(
      "passed",
    );
    expect(gates["lint"]).toMatchObject({ status: "passed" });
    expect(gates["list"]?.status, gates["list"]?.summary).toBe("passed");
    expect(exitCode).toBe(0);

    // The manifest records the map; --check regenerates identically from it.
    const manifest = JSON.parse(
      text(join(s.tree.into, EXPORT_MANIFEST_FILE)),
    ) as ExportManifestV1;
    expect(manifest.source.map?.file).toBe("../../export.map.yml");
    expect(manifest.source.map?.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    const check = await checkPlaywrightExport(s.tree.into, undefined, {});
    expect(check.report.status).toBe("fresh");
    expect(check.report.warnings).toEqual([]);

    // A map edit that changes the output makes the export stale, and says why.
    writeFileSync(
      s.mapPath,
      BASE_MAP.replace("call: openOrder", "call: openOrderTab"),
    );
    const stale = await checkPlaywrightExport(s.tree.into, undefined, {});
    expect(stale.exitCode).toBe(1);
    expect(stale.report.files.stale).toContain("orders_flow.spec.ts");
    expect(stale.report.warnings.join("\n")).toContain(
      "the export map changed",
    );
  }, 300_000);

  it("fails the typecheck gate when the host's fixture does not exist (the map is checked against real types)", async () => {
    const s = scenario(
      "cjs",
      { actions: ACTIONS, specs: { orders_flow: ORDERS_SPEC } },
      BASE_MAP.replace("name: memberSession", "name: noSuchSession"),
    );
    await exportInto(s);
    const { report } = await verifyPlaywrightExport({
      exportDir: s.tree.into,
      write: false,
    });
    const typecheck = report.gates.find((gate) => gate.id === "typecheck");
    expect(typecheck?.status).toBe("failed");
    expect(typecheck?.findings?.join("\n")).toContain("noSuchSession");
  }, 240_000);
});

describe("fixture and method mappings (ES module host)", () => {
  it("adds .js to host imports and compiles under nodenext", async () => {
    const s = scenario("esm", {
      actions: ACTIONS,
      specs: { orders_flow: ORDERS_SPEC },
    });
    await exportInto(s);
    const spec = text(join(s.tree.into, "orders_flow.e2e.ts"));
    expect(spec).toContain(`import { test } from "../../fixtures.js";`);
    expect(spec).toContain(
      `import { OrdersPage } from "../../pom/orders-page.js";`,
    );
    expect(spec).toContain("./lib/pages/pick-filter-page.js");
    const page = text(join(s.tree.into, "lib", "pages", "pick-filter-page.ts"));
    expect(page).toContain(`from "../../../../pom/base-page.js"`);
    const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);

  it("verifies statically on the ES module host", async () => {
    const s = scenario("esm", {
      actions: ACTIONS,
      specs: { orders_flow: ORDERS_SPEC },
    });
    await exportInto(s);
    const { report } = await verifyPlaywrightExport({
      exportDir: s.tree.into,
      write: false,
    });
    const gates = Object.fromEntries(report.gates.map((g) => [g.id, g]));
    expect(gates["typecheck"]?.status, gates["typecheck"]?.summary).toBe(
      "passed",
    );
    expect(gates["freshness"]?.status).toBe("passed");
    expect(gates["list"]?.status, gates["list"]?.summary).toBe("passed");
  }, 240_000);
});

describe("unmapped actions", () => {
  it("become page objects over a minimal generated base when the map names none", async () => {
    const s = scenario(
      "cjs",
      { actions: ACTIONS, specs: { orders_flow: ORDERS_SPEC } },
      "version: 1\n",
    );
    await exportInto(s);
    const dir = join(s.tree.into, "lib", "pages");
    expect(readdirSync(dir).toSorted()).toEqual([
      "base-page.ts",
      "login-member-page.ts",
      "open-order-page.ts",
      "pick-filter-page.ts",
    ]);
    expect(text(join(dir, "base-page.ts"))).toContain(
      "protected readonly page: Page;",
    );
    const login = text(join(dir, "login-member-page.ts"));
    expect(login).toContain(
      `import { BasePage } from "@e2e/tests/cairn/lib/pages/base-page";`,
    );
    expect(login).toContain("export class LoginMemberPage extends BasePage {");
    const spec = text(join(s.tree.into, "orders_flow.spec.ts"));
    // Without a map `test`, the test keeps Playwright's.
    expect(spec).toContain(`from "@playwright/test"`);
    expect(spec).toContain("await new LoginMemberPage(page).loginMember();");
    const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);

  it("groups actions into one class with generate.class and names methods", async () => {
    const s = scenario(
      "cjs",
      { actions: ACTIONS, specs: { orders_flow: ORDERS_SPEC } },
      `version: 1
basePage: { import: ./pom/base-page, name: BasePage }
actions:
  login_member:
    generate: { class: SessionPage, method: signIn }
  open_order:
    generate: { class: SessionPage, method: goToOrder }
  pick_filter:
    generate: { class: SessionPage }
`,
    );
    await exportInto(s);
    expect(readdirSync(join(s.tree.into, "lib", "pages"))).toEqual([
      "session-page.ts",
    ]);
    const page = text(join(s.tree.into, "lib", "pages", "session-page.ts"));
    expect(page).toContain("export class SessionPage extends BasePage {");
    for (const method of ["signIn(", "goToOrder(", "pickFilter("]) {
      expect(page).toContain(`async ${method}`);
    }
    // One import of the host base, one of Playwright's expect/test if needed.
    expect(page.match(/pom\/base-page/g)).toHaveLength(1);
    const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);

  it("calls a mapped action from inside a generated page object", async () => {
    const s = scenario("cjs", {
      actions: {
        ...ACTIONS,
        open_and_filter: NESTED.replace(
          "name: open_and_filter",
          "name: open_and_filter\ndescription: nested",
        ),
      },
      specs: {
        nested_flow: `version: 1
name: nested_flow
intent: an unmapped action calls a mapped one
coldStart: guest
imports:
  - ../actions/open_and_filter.yml
${OUTCOME}steps:
  - use: open_and_filter
`,
      },
    });
    await exportInto(s);
    const page = text(
      join(s.tree.into, "lib", "pages", "open-and-filter-page.ts"),
    );
    expect(page).toContain(
      `import { OrdersPage } from "@e2e/pom/orders-page";`,
    );
    expect(page).toContain(
      `await new OrdersPage(page).openOrder("3003", "summary");`,
    );
    expect(page).toContain(
      `import { PickFilterPage } from "@e2e/tests/cairn/lib/pages/pick-filter-page";`,
    );
    expect(page).toContain("await new PickFilterPage(page).pickFilter();");
    const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);
});

describe("map errors", () => {
  const failing = async (
    map: string,
    specs: Record<string, string> = { orders_flow: ORDERS_SPEC },
  ): Promise<string> => {
    const s = scenario("cjs", { actions: ACTIONS, specs }, map);
    try {
      await exportInto(s);
    } catch (e) {
      return (e as Error).message;
    }
    return "";
  };

  it("strict: an unmapped action that a spec uses is an error, naming every one", async () => {
    const message = await failing(
      BASE_MAP.replace("version: 1\n", "version: 1\nstrict: true\n"),
    );
    expect(message).toContain("export map is strict");
    expect(message).toContain("action pick_filter");
    expect(message).not.toContain("action open_order");
  });

  it("strict: a mapped export passes", async () => {
    const s = scenario(
      "cjs",
      {
        actions: ACTIONS,
        specs: { orders_flow: ORDERS_SPEC },
      },
      `${BASE_MAP.replace("version: 1\n", "version: 1\nstrict: true\n")}  pick_filter:
    generate: {}
`,
    );
    const report = await exportInto(s);
    expect(report.map?.strict).toBe(true);
  }, 120_000);

  it("a var the call passes needs a rule on the fixture", async () => {
    const message = await failing(
      BASE_MAP.replace("        tenant: { option: tenant }\n", ""),
      {
        orders_flow: ORDERS_SPEC.replace(
          "  - use: login_member",
          "  - use:\n      action: login_member\n      vars: { tenant: globex }",
        ),
      },
    );
    expect(message).toContain("passes var tenant");
    expect(message).toContain("fixture memberSession has no rule for it");
  });

  it("a constant the fixture is pinned to must match the call", async () => {
    const message = await failing(BASE_MAP, {
      orders_flow: ORDERS_SPEC.replace(
        "  - use: login_member",
        "  - use:\n      action: login_member\n      vars: { role: admin }",
      ),
    });
    expect(message).toContain('sets role to "admin"');
    expect(message).toContain('pinned to "member"');
  });

  it("a var the page-object method takes no argument for is an error (or ignored on purpose)", async () => {
    const dropped = BASE_MAP.replace("        - { var: tab }\n", "");
    expect(await failing(dropped)).toContain(
      "passes var tab, but method OrdersPage.openOrder takes no argument from it",
    );
    const s = scenario(
      "cjs",
      { actions: ACTIONS, specs: { orders_flow: ORDERS_SPEC } },
      dropped.replace(
        "      call: openOrder\n",
        "      call: openOrder\n      ignoreVars: [tab]\n",
      ),
    );
    await exportInto(s);
    expect(text(join(s.tree.into, "orders_flow.spec.ts"))).toContain(
      `openOrder("2002")`,
    );
  }, 120_000);

  it("a fixture-bound action cannot be nested, retried or conditional", async () => {
    expect(
      await failing(BASE_MAP, {
        nested_flow: `version: 1
name: nested_flow
intent: x
coldStart: guest
imports:
  - ../actions/login_member.yml
${OUTCOME}steps:
  - repeat:
      max: 1
      steps:
        - use: login_member
`,
      }),
    ).toContain("which runs before the test body");
    expect(
      await failing(BASE_MAP, {
        retry_flow: ORDERS_SPEC.replace(
          "  - use: login_member",
          "  - use:\n      action: login_member\n      retry: { times: 2 }",
        ),
      }),
    ).toContain("called with `retry`");
  });

  it("a fixture after a real step is exported, with a mappedOrdering risk", async () => {
    const s = scenario("cjs", {
      actions: ACTIONS,
      specs: {
        late_login: ORDERS_SPEC.replace(
          "  - use: login_member\n  - use:",
          "  - use:",
        ).concat("  - use: login_member\n"),
      },
    });
    const report = await exportInto(s);
    const risks = report.specs[0]?.coverage.semanticRisks ?? [];
    expect(risks.map((risk) => risk.kind)).toContain("mappedOrdering");
  }, 120_000);

  it("when picks the mapping by the call's var; none holding is an error", async () => {
    const map = `version: 1
test: { import: ./fixtures }
actions:
  login_member:
    - when: { var: role, equals: member }
      fixture:
        name: memberSession
        vars: { role: { ignore: true }, tenant: { option: tenant } }
    - when: { var: role, in: [admin, owner] }
      generate: { class: AdminSessionPage, method: signInAdmin }
`;
    const ok = scenario(
      "cjs",
      {
        actions: ACTIONS,
        specs: {
          orders_flow: ORDERS_SPEC.replace(
            "  - use: login_member",
            "  - use:\n      action: login_member\n      vars: { role: admin }",
          ),
        },
      },
      map,
    );
    await exportInto(ok);
    const spec = text(join(ok.tree.into, "orders_flow.spec.ts"));
    expect(spec).toContain(
      `await new AdminSessionPage(page).signInAdmin({ "role": "admin" });`,
    );
    expect(spec).not.toContain("memberSession");

    const none = await failing(map, {
      orders_flow: ORDERS_SPEC.replace(
        "  - use: login_member",
        "  - use:\n      action: login_member\n      vars: { role: guest }",
      ),
    });
    expect(none).toContain("no mapping's `when` holds");
  }, 120_000);

  it("rejects an invalid map with the field named, a relative import that names no file, and --map outside a structured export", async () => {
    expect(
      await failing(
        "version: 1\nactions:\n  login_member:\n    fixture: { name: 3 }\n",
      ),
    ).toContain("actions.login_member");
    expect(
      await failing(
        "version: 1\ntest: { import: ./no-such-fixtures }\nactions: {}\n",
      ),
    ).toContain("test.import: ./no-such-fixtures does not name a file");
    expect(() => assertMapFlags({ mapFile: "x.yml" })).toThrow(
      "use it with --into",
    );
    expect(() =>
      assertMapFlags({ mapFile: "x.yml", into: "out" }),
    ).not.toThrow();
  }, 120_000);
});

/** A secret-looking value, built at run time (never a literal in the repo). */
function secretValue(): string {
  return ["pw", Math.random().toString(36).slice(2), Date.now()].join("-");
}

/** A tiny auth server: records the password it was sent, sets a session cookie, wants the captured bearer. */
async function authServer(): Promise<{
  server: Server;
  url: string;
  passwords: string[];
  profileStatuses: number[];
}> {
  const passwords: string[] = [];
  const profileStatuses: number[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/login" && req.method === "POST") {
        passwords.push((JSON.parse(body) as { password: string }).password);
        res.setHeader("set-cookie", "sid=session-cookie; Path=/; HttpOnly");
        res.end(JSON.stringify({ token: "tok-1" }));
      } else if (req.url === "/api/profile") {
        const ok = req.headers.authorization === "Bearer tok-1";
        profileStatuses.push(ok ? 200 : 401);
        res.statusCode = ok ? 200 : 401;
        res.end("{}");
      } else {
        res.statusCode = 404;
        res.end("{}");
      }
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const { port } = server.address() as AddressInfo;
  return {
    server,
    url: `http://127.0.0.1:${port}`,
    passwords,
    profileStatuses,
  };
}

describe("API login as a storageState", () => {
  const PASSWORD_ENV = "CAIRN_TEST_API_PASSWORD";

  /** Every file under `dir` whose text holds `needle`. */
  function filesContaining(dir: string, needle: string): string[] {
    return listFiles(dir).filter((file) =>
      readFileSync(join(dir, file)).includes(needle),
    );
  }

  it("signs in through request.newContext + storageState, with no secret in the generated tree", async () => {
    const secret = secretValue();
    const previous = process.env[PASSWORD_ENV];
    process.env[PASSWORD_ENV] = secret;
    try {
      const s = scenario("cjs", {
        actions: ACTIONS,
        specs: { api_orders_flow: API_SPEC },
      });
      const report = await exportInto(s);
      const spec = text(join(s.tree.into, "api_orders_flow.spec.ts"));
      // Auth-like + request-only: detected without a mapping.
      expect(spec).toContain(
        `test.use({ storageState: cairnStatePath("sign_in_api") });`,
      );
      expect(spec).toContain("test.beforeAll(async ({}, testInfo) => {");
      expect(spec).toContain(
        `await cairnEnsureState("sign_in_api", testInfo.project.use.baseURL);`,
      );
      expect(spec).toContain("// eslint-disable-next-line no-empty-pattern");
      // No page.evaluate with the login, and no inlined request steps.
      expect(spec).not.toContain("page.evaluate");
      expect(spec).not.toContain("/api/login");

      const state = text(join(s.tree.into, "lib", "authState.ts"));
      expect(state).toContain("cairnLoginState");
      expect(state).toContain(`"sign_in_api": {`);
      expect(state).toContain('file: ".auth/sign_in_api.json"');
      // Credentials are read from the environment when the sign-in runs.
      expect(state).toContain("process.env.CAIRN_TEST_API_PASSWORD");
      expect(state).toContain(`required: ["CAIRN_TEST_API_PASSWORD"]`);
      // The token capture feeds the follow-up request in the same context.
      expect(state).toContain("requests.login.captures.token");
      expect(state).not.toContain("requests.session");
      expect(text(join(s.tree.into, ".auth", ".gitignore"))).toContain("*");

      // The secret is nowhere in the tree, the manifest or the reports.
      expect(filesContaining(s.tree.into, secret)).toEqual([]);
      expect(JSON.stringify(report)).not.toContain(secret);
      expect(report.requiredEnv).toContain(PASSWORD_ENV);
      expect(
        report.map?.actions.find((entry) => entry.action === "sign_in_api"),
      ).toMatchObject({
        treatment: "storageState",
        target: ".auth/sign_in_api.json",
      });

      const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
      expect(compiled.exitCode, compiled.output).toBe(0);
    } finally {
      if (previous === undefined) delete process.env[PASSWORD_ENV];
      else process.env[PASSWORD_ENV] = previous;
    }
  }, 180_000);

  for (const kind of ["cjs", "esm"] as const) {
    it(`runs the generated sign-in against a server and writes the storageState (${kind}, no browser)`, async () => {
      const secret = secretValue();
      const auth = await authServer();
      try {
        const s = scenario(kind, {
          actions: ACTIONS,
          specs: { api_orders_flow: API_SPEC },
        });
        await exportInto(s);
        // The generated sign-in, called from a hand-written spec of the host.
        const checkName =
          kind === "cjs" ? "state.check.spec.ts" : "state.check.e2e.ts";
        const importExt = kind === "cjs" ? "" : ".js";
        writeFileSync(
          join(s.tree.into, checkName),
          `import {expect, test} from "@playwright/test";
import {cairnEnsureState} from "./lib/authState${importExt}";

test("writes the storage state", async () => {
  const path = await cairnEnsureState("sign_in_api", process.env.CHECK_BASE_URL);
  expect(path).toContain(".auth");
});
`,
        );
        const run = (env: Record<string, string>) =>
          execa(
            join(s.tree.root, "node_modules", ".bin", "playwright"),
            ["test", "--config", s.tree.config, checkName],
            {
              cwd: dirname(s.tree.config),
              reject: false,
              timeout: 120_000,
              env: { ...env, CHECK_BASE_URL: auth.url },
              extendEnv: true,
            },
          );
        // Credentials come from the environment when the sign-in runs.
        const missing = await run({ [PASSWORD_ENV]: "" });
        expect(missing.exitCode).not.toBe(0);
        expect(`${missing.stdout}${missing.stderr}`).toContain(
          `${PASSWORD_ENV} is not set`,
        );
        const ran = await run({ [PASSWORD_ENV]: secret });
        expect(ran.exitCode, `${ran.stdout}\n${ran.stderr}`).toBe(0);
        expect(auth.passwords).toEqual([secret]);
        // The captured token reached the follow-up request in the same context.
        expect(auth.profileStatuses).toEqual([200]);
        const stateFile = join(s.tree.into, ".auth", "sign_in_api.json");
        expect(text(stateFile)).toContain("session-cookie");
        // The secret is in the request only: not in the saved state, not in the tree.
        expect(text(stateFile)).not.toContain(secret);
        expect(filesContaining(s.tree.into, secret)).toEqual([]);
      } finally {
        auth.server.close();
      }
    }, 240_000);
  }

  it("writes the state once for the suite under --preconditions global", async () => {
    const s = scenario("cjs", {
      actions: ACTIONS,
      specs: { api_orders_flow: API_SPEC },
    });
    await exportInto(s, { preconditions: "global" });
    const spec = text(join(s.tree.into, "api_orders_flow.spec.ts"));
    expect(spec).toContain("test.use({ storageState: cairnStatePath(");
    expect(spec).not.toContain("beforeAll");
    expect(spec).not.toContain("cairnEnsureState");
    const setup = text(join(s.tree.into, "global-setup.ts"));
    expect(setup).toContain("config: FullConfig");
    expect(setup).toContain(
      `await cairnWriteState("sign_in_api", authBaseURL);`,
    );
    const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(compiled.exitCode, compiled.output).toBe(0);
  }, 180_000);

  it("uses the host's own setup project when the map points to one (nothing generated)", async () => {
    const s = scenario(
      "cjs",
      { actions: ACTIONS, specs: { api_orders_flow: API_SPEC } },
      `version: 1
actions:
  sign_in_api:
    apiLogin:
      storageState: playwright/.auth/member.json
      setupProject: setup
`,
    );
    // The host config names its projects.
    writeFileSync(
      s.tree.config,
      text(s.tree.config).replace(
        '  reporter: [["list"]],',
        '  reporter: [["list"]],\n  projects: [{name: "setup"}, {name: "chromium", dependencies: ["setup"]}],',
      ),
    );
    await exportInto(s);
    const spec = text(join(s.tree.into, "api_orders_flow.spec.ts"));
    expect(spec).toContain(
      `test.use({ storageState: "playwright/.auth/member.json" });`,
    );
    expect(spec).not.toContain("beforeAll");
    expect(
      listFiles(s.tree.into).some((file) => file.includes("authState")),
    ).toBe(false);

    // A setup project the host does not have is an error.
    const wrong = scenario(
      "cjs",
      { actions: ACTIONS, specs: { api_orders_flow: API_SPEC } },
      `version: 1
actions:
  sign_in_api:
    apiLogin: { storageState: x.json, setupProject: nope }
`,
    );
    writeFileSync(
      wrong.tree.config,
      text(wrong.tree.config).replace(
        '  reporter: [["list"]],',
        '  reporter: [["list"]],\n  projects: [{name: "setup"}],',
      ),
    );
    await expect(exportInto(wrong)).rejects.toThrow(
      'setupProject "nope" is not a project of the host Playwright config',
    );
  }, 180_000);

  it("refuses an API login that uses the run token", async () => {
    const s = scenario("cjs", {
      actions: {
        ...ACTIONS,
        sign_in_api: SIGN_IN_API.replace(
          "email: casey@example.test",
          'email: casey@example.test\n  nonce: "n-${run.token}"',
        ).replace(
          'email: "${vars.email}"',
          'email: "${vars.email}", nonce: "${vars.nonce}"',
        ),
      },
      specs: { api_orders_flow: API_SPEC },
    });
    await expect(exportInto(s)).rejects.toThrow(
      "an API login cannot use ${run.token}",
    );
  }, 120_000);

  it("refuses an action that is not request-only, or that sends credentials: omit", async () => {
    const s = scenario(
      "cjs",
      { actions: ACTIONS, specs: { orders_flow: ORDERS_SPEC } },
      `version: 1\nactions:\n  login_member:\n    apiLogin: {}\n`,
    );
    await expect(exportInto(s)).rejects.toThrow(
      'cannot be an API login: step "open_login" is not a request',
    );
  }, 120_000);
});

describe("ES module host: API login, README, check", () => {
  it("compiles under nodenext and verifies statically", async () => {
    const s = scenario("esm", {
      actions: ACTIONS,
      specs: { api_orders_flow: API_SPEC },
    });
    await exportInto(s);
    const state = text(join(s.tree.into, "lib", "authState.ts"));
    expect(state).toContain("import.meta.url");
    expect(state).not.toContain("__dirname");
    expect(state).toContain('from "./request.js"');
    const compiled = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(compiled.exitCode, compiled.output).toBe(0);
    const { report } = await verifyPlaywrightExport({
      exportDir: s.tree.into,
      write: false,
    });
    const gates = Object.fromEntries(report.gates.map((g) => [g.id, g]));
    expect(gates["typecheck"]?.status, gates["typecheck"]?.summary).toBe(
      "passed",
    );
    expect(gates["freshness"]?.status).toBe("passed");
  }, 240_000);

  it("lists the bindings in the README, with no absolute path", async () => {
    const s = scenario("cjs", {
      actions: ACTIONS,
      specs: { orders_flow: ORDERS_SPEC, api_orders_flow: API_SPEC },
    });
    await exportInto(s);
    const readme = text(join(s.tree.into, "README.md"));
    expect(readme).toContain("## Export map");
    expect(readme).toContain("../../export.map.yml");
    expect(readme).toContain("`login_member` → host fixture `memberSession`");
    expect(readme).toContain(
      "`open_order` → host page object `OrdersPage.openOrder`",
    );
    expect(readme).toContain(
      "`sign_in_api` → storageState `.auth/sign_in_api.json`",
    );
    expect(readme).toContain(
      "`pick_filter` → generated page object `PickFilterPage.pickFilter`",
    );
    expect(readme).toContain(".auth/.gitignore");
    expect(readme).not.toContain(s.tree.root);
    // The generated page objects are not listed as action modules.
    expect(readme).not.toContain("lib/pages/pick-filter-page.ts` → ");
  }, 120_000);

  it("--check says a missing map is an error (the export cannot regenerate without it)", async () => {
    const s = scenario("cjs", {
      actions: ACTIONS,
      specs: { orders_flow: ORDERS_SPEC },
    });
    await exportInto(s);
    rmSync(s.mapPath);
    const check = await checkPlaywrightExport(s.tree.into, undefined, {});
    expect(check.exitCode).toBe(2);
    expect(check.report.error).toContain("export map");
    expect(check.report.error).toContain("does not exist");
  }, 120_000);

  it("--map outside --into / --project is refused up front", () => {
    expect(() => assertMapFlags({ mapFile: "m.yml" })).toThrow(
      "--map binds actions",
    );
  });
});

describe("--project without a host profile", () => {
  it("keeps package imports as written and re-bases relative ones; JavaScript gets .js", async () => {
    const s = scenario(
      "cjs",
      { actions: ACTIONS, specs: { orders_flow: ORDERS_SPEC } },
      `version: 1
test: { import: "@acme/fixtures" }
basePage: { import: ./pom/base-page, name: BasePage }
actions:
  login_member:
    fixture: { name: memberSession, vars: { role: { ignore: true }, tenant: { ignore: true } } }
  open_order:
    method: { import: ./pom/orders-page, class: OrdersPage, call: openOrder, args: [{ var: orderId }, { var: tab }] }
`,
    );
    const paths = await expandSpecArgs([s.flows]);
    const out = join(tmpRoot(), "project");
    const { ...ts } = await writeProjectExport(
      paths,
      "ts",
      { project: true, outDir: out, mapFile: s.mapPath },
      s.flows,
    );
    expect(ts.map?.actions.map((entry) => entry.treatment)).toEqual([
      "fixture",
      "method",
      "generated",
    ]);
    const spec = text(join(out, "tests", "orders_flow.spec.ts"));
    expect(spec).toContain(`import { test } from "@acme/fixtures";`);
    expect(spec).toContain(
      `import { PickFilterPage } from "../lib/pages/pick-filter-page";`,
    );
    // The map sits beside the host's modules, outside this project: re-based from the file.
    expect(spec).toMatch(
      /import \{ OrdersPage \} from "(?:\.\.\/)+[^"]*pom\/orders-page";/,
    );

    const jsOut = join(tmpRoot(), "project-js");
    await writeProjectExport(
      paths,
      "js",
      { project: true, outDir: jsOut, mapFile: s.mapPath },
      s.flows,
    );
    const js = text(join(jsOut, "tests", "orders_flow.spec.js"));
    expect(js).toContain(`import { test } from "@acme/fixtures";`);
    expect(js).toContain('from "../lib/pages/pick-filter-page.js"');
    expect(js).toMatch(/pom\/orders-page\.js"/);
    const page = text(join(jsOut, "lib", "pages", "pick-filter-page.js"));
    expect(page).toContain("export class PickFilterPage extends BasePage {");
    expect(page).not.toContain(": Promise");
  }, 120_000);
});

describe("export --target with a mapFile profile", () => {
  it("passes the map through the profile (path relative to the config)", async () => {
    const { applyExportTarget } = await import("./exportHost");
    const root = tmpRoot();
    writeFileSync(
      join(root, "cairntrace.config.yml"),
      `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
export:
  targets:
    ui:
      into: host/tests/cairn
      mapFile: host/export.map.yml
`,
    );
    const applied = await applyExportTarget<ExportPlaywrightOptions>(
      { target: "ui" },
      join(root, "flows"),
      root,
    );
    expect(applied.opts.mapFile).toBe(join(root, "host", "export.map.yml"));
    expect(resolve(applied.opts.into ?? "")).toBe(
      join(root, "host", "tests", "cairn"),
    );
  });
});

/** A one-step action that opens a page named after it. */
function openAction(name: string): string {
  return `version: 1
name: ${name}
steps:
  - id: go_${name}
    open: "http://localhost:8787/${name}"
`;
}

describe("map fixes (review 7B)", () => {
  const ORDERS = `version: 1
name: orders
steps:
  - id: open_list
    open: "http://localhost:8787/orders.html"
`;
  const BASE = `version: 1
name: base
steps:
  - id: open_home
    open: "http://localhost:8787/"
`;
  const REVOKE_TOKEN = `version: 1
name: revoke_token
steps:
  - id: revoke
    request:
      method: POST
      url: /api/token/revoke
      expectStatus: 200
`;
  const flow = (name: string, imports: string[], steps: string) =>
    `version: 1
name: ${name}
intent: ${name}
coldStart: guest
imports:
${imports.map((i) => `  - ../actions/${i}.yml`).join("\n")}
${OUTCOME}steps:
${steps}`;

  it("never gives a generated page object a host class name (M3): suffixed, and it compiles", async () => {
    const s = scenario("cjs", {
      actions: { ...ACTIONS, orders: ORDERS, base: BASE },
      specs: {
        collide: flow(
          "collide",
          ["orders", "base", "open_order"],
          "  - use: orders\n  - use: base\n  - use: open_order\n",
        ),
      },
    });
    await exportInto(s);
    const spec = text(join(s.tree.into, "collide.spec.ts"));
    expect(spec).toContain(
      `import { OrdersPage } from "@e2e/pom/orders-page";`,
    );
    expect(spec).toContain("await new OrdersPage2(page).orders();");
    expect(spec).toContain("await new BasePage2(page).base();");
    const base = text(join(s.tree.into, "lib", "pages", "base-page2.ts"));
    expect(base).toContain("export class BasePage2 extends BasePage {");
    const result = await tsc(s.tree, join(s.tree.e2e, "tsconfig.json"));
    expect(result.output).not.toContain("error TS");
    expect(result.exitCode).toBe(0);
  }, 120_000);

  it("auto-detects an API login only for a leading login-named call (M4)", async () => {
    const s = scenario("cjs", {
      actions: { ...ACTIONS, revoke_token: REVOKE_TOKEN },
      specs: {
        late_login: flow(
          "late_login",
          ["open_order", "sign_in_api"],
          "  - use: open_order\n  - use: sign_in_api\n",
        ),
        revoke: flow("revoke", ["revoke_token"], "  - use: revoke_token\n"),
      },
    });
    const report = await exportInto(s);
    const treatments = Object.fromEntries(
      (report.map?.actions ?? []).map((a) => [a.action, a.treatment]),
    );
    // after a real step, a login stays where it was (a page object)
    expect(treatments["sign_in_api"]).toBe("generated");
    // revoke_token is never a login, leading or not
    expect(treatments["revoke_token"]).toBe("generated");
    expect(listFiles(s.tree.into).some((f) => f.startsWith(".auth/"))).toBe(
      false,
    );
  }, 120_000);

  it("sets an option fixture from the action's default too (M5), and flags a page fixture under a storageState (L7)", async () => {
    const map = `${BASE_MAP.replace(
      '      type: "{ user: string }"\n',
      '      type: "{ user: string }"\n      providesPage: true\n',
    )}`;
    const s = scenario(
      "cjs",
      {
        actions: ACTIONS,
        specs: {
          defaults: flow(
            "defaults",
            ["login_member", "sign_in_api", "open_order"],
            "  - use: login_member\n  - use: sign_in_api\n  - use: open_order\n",
          ),
        },
      },
      map,
    );
    const report = await exportInto(s);
    const spec = text(join(s.tree.into, "defaults.spec.ts"));
    // the call passes no tenant: the action default (acme) still reaches the fixture
    expect(spec).toMatch(
      /test\.use\(\{ tenant: "acme", storageState: cairnStatePath\("sign_in_api"\) \}\);/,
    );
    const risks = report.specs[0]?.coverage.semanticRisks ?? [];
    expect(risks.map((risk) => risk.kind)).toContain("mappedStorageState");
  }, 120_000);

  it("refuses two different host `test` objects through a fixture instance (L12)", async () => {
    const map = `version: 1
test:
  import: ./fixtures
actions:
  login_member:
    fixture:
      name: memberSession
      import: ./other-fixtures
      vars:
        role: { const: member }
        tenant: { ignore: true }
  open_order:
    method:
      import: ./pom/orders-page
      class: OrdersPage
      call: openOrder
      instance: { fixture: ordersPage }
      args:
        - { var: orderId }
        - { var: tab }
`;
    const s = scenario(
      "cjs",
      {
        actions: ACTIONS,
        specs: {
          two_tests: flow(
            "two_tests",
            ["login_member", "open_order"],
            "  - use: login_member\n  - use: open_order\n",
          ),
        },
      },
      map,
    );
    writeFileSync(
      join(s.tree.e2e, "other-fixtures.ts"),
      `export { test } from "./fixtures";\n`,
    );
    await expect(exportInto(s)).rejects.toThrow(
      /uses fixtures from two different `test` objects/,
    );
  }, 120_000);

  it("never names an action function after a binding the test uses (L11: page, expect, test, join)", async () => {
    const names = ["page", "expect", "test", "join"];
    const s = scenario(
      "cjs",
      {
        actions: Object.fromEntries(names.map((n) => [n, openAction(n)])),
        specs: {
          idents: flow(
            "idents",
            names,
            names.map((n) => `  - use: ${n}\n`).join(""),
          ),
        },
      },
      undefined,
    );
    const out = join(tmpRoot(), "project");
    await writeProjectExport(
      await expandSpecArgs([s.flows]),
      "ts",
      { project: true, outDir: out },
      s.flows,
    );
    const spec = text(join(out, "tests", "idents.spec.ts"));
    for (const n of names) {
      expect(spec).toContain(`import { ${n}Action } from "../actions/${n}";`);
      expect(spec).toContain(`await ${n}Action(page);`);
    }
    expect(spec).toContain(`import { expect, test } from "@playwright/test";`);
    expect(spec).not.toContain("await page(page)");
  }, 120_000);

  it("resets a signed-in host's storageState for a coldStart: guest spec (L8)", async () => {
    const s = scenario("cjs", {
      actions: ACTIONS,
      specs: { guest: flow("guest", ["open_order"], "  - use: open_order\n") },
    });
    writeFileSync(
      s.tree.config,
      text(s.tree.config).replace(
        "    bypassCSP: true,\n",
        '    bypassCSP: true,\n    storageState: ".auth/user.json",\n',
      ),
    );
    const report = await exportInto(s);
    const spec = text(join(s.tree.into, "guest.spec.ts"));
    expect(spec).toContain(
      "test.use({ storageState: { cookies: [], origins: [] } });",
    );
    expect(report.host?.notes.join("\n")).toContain(
      "coldStart: guest specs reset it",
    );
  }, 120_000);
});
