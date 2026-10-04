/**
 * E9: the export map as data — schema, canonical digest, which mapping a call
 * gets, how host imports are re-based — and the small renderers around it.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  camelCase,
  exportMapDigest,
  exportMapProblems,
  importSpecifier,
  kebabCase,
  loadExportMap,
  parseExportMap,
  pascalCase,
  selectMapping,
} from "./exportMap";
import {
  apiLoginBlocker,
  effectiveVars,
  mergeImports,
  renderAuthStateModule,
  type MapCall,
} from "./exportMapEmit";
import { SpecSchema } from "../schema/spec.v1";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "cairn-export-map-"));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

const MAP = `version: 1
strict: true
test: { import: ./fixtures }
basePage: { import: ./pom/base-page, name: BasePage, pageProperty: page }
actions:
  login:
    - when: { var: role, equals: admin }
      fixture: { name: adminSession, vars: { role: { const: admin } } }
    - fixture: { name: memberSession, providesPage: true, type: Member }
  open_order:
    method:
      import: ./pom/orders-page
      class: OrdersPage
      call: openOrder
      args: [{ var: id }, { const: details }]
`;

const bad = (text: string): string => {
  try {
    parseExportMap(text, "m.yml");
  } catch (e) {
    return (e as Error).message;
  }
  return "";
};

describe("parseExportMap", () => {
  it("accepts every construct", () => {
    const map = parseExportMap(MAP, "export.map.yml");
    expect(map.strict).toBe(true);
    expect(Object.keys(map.actions ?? {})).toEqual(["login", "open_order"]);
  });

  it("names the field of an invalid map", () => {
    expect(bad("version: 2\n")).toContain("version");
    expect(bad("version: 1\nunknown: true\n")).toContain("unknown");
    expect(
      bad("version: 1\nactions:\n  Login: { fixture: { name: x } }\n"),
    ).toContain("actions");
    expect(
      bad(
        "version: 1\nactions:\n  login: { fixture: { name: x }, generate: {} }\n",
      ),
    ).toContain("exactly one of fixture / method / apiLogin / generate");
    expect(
      bad(
        "version: 1\nactions:\n  login: { apiLogin: { setupProject: setup } }\n",
      ),
    ).toContain("setupProject needs the storageState path it writes");
    // A mapping without `when` ends the list.
    expect(
      bad(
        "version: 1\nactions:\n  login:\n    - fixture: { name: a }\n    - when: { var: r, equals: x }\n      fixture: { name: b }\n",
      ),
    ).toContain("must be the last one of the list");
    expect(
      bad(
        "version: 1\nactions:\n  login: { when: { var: r }, fixture: { name: a } }\n",
      ),
    ).toContain("exactly one of equals / in");
    expect(bad(": not yaml: [")).toContain("not valid YAML");
  });
});

describe("digest", () => {
  it("is the content of the map: comments, key order and layout do not move it", () => {
    const a = parseExportMap(MAP, "a");
    const b = parseExportMap(
      `# a comment\nactions:\n  open_order:\n    method:\n      args: [{ var: id }, { const: details }]\n      call: openOrder\n      class: OrdersPage\n      import: ./pom/orders-page\n  login:\n    - when: { equals: admin, var: role }\n      fixture: { vars: { role: { const: admin } }, name: adminSession }\n    - fixture: { type: Member, providesPage: true, name: memberSession }\nbasePage: { pageProperty: page, name: BasePage, import: ./pom/base-page }\ntest: { import: ./fixtures }\nstrict: true\nversion: 1\n`,
      "b",
    );
    expect(exportMapDigest(a)).toBe(exportMapDigest(b));
    expect(exportMapDigest(a)).toMatch(/^sha256:[0-9a-f]{64}$/);
    const c = parseExportMap(MAP.replace("call: openOrder", "call: open"), "c");
    expect(exportMapDigest(c)).not.toBe(exportMapDigest(a));
  });
});

describe("selectMapping", () => {
  const map = parseExportMap(MAP, "m");
  it("takes the first mapping whose when holds, then the one without when", () => {
    expect(
      selectMapping(map, "login", { role: "admin" })?.mapping.fixture?.name,
    ).toBe("adminSession");
    expect(
      selectMapping(map, "login", { role: "member" })?.mapping.fixture?.name,
    ).toBe("memberSession");
    expect(selectMapping(map, "nope", {})).toBeUndefined();
  });

  it("refuses to decide on a value that is not plain data", () => {
    expect(() => selectMapping(map, "login", { role: "${vars.who}" })).toThrow(
      "not a plain value",
    );
  });
});

describe("importSpecifier", () => {
  const loaded = { dir: "/host/e2e" };
  it("re-bases a relative import from the map to the importing file", () => {
    expect(
      importSpecifier("./pom/base-page", loaded, {
        fromFile: "/host/e2e/tests/cairn/lib/pages/x.ts",
        ext: "",
      }),
    ).toBe("../../../../pom/base-page");
    expect(
      importSpecifier("./fixtures", loaded, {
        fromFile: "/host/e2e/tests/cairn/a.spec.ts",
        ext: ".js",
      }),
    ).toBe("../../fixtures.js");
  });

  it("goes through the host's path alias when it covers the target", () => {
    expect(
      importSpecifier("./pom/base-page", loaded, {
        fromFile: "/host/e2e/tests/cairn/lib/pages/x.ts",
        ext: "",
        alias: { prefix: "@e2e/", dir: "/host/e2e" },
      }),
    ).toBe("@e2e/pom/base-page");
  });

  it("under ESM .js imports names the file Node loads: a barrel keeps /index, .mts / .cts map to .mjs / .cjs (M2)", () => {
    const dir = tmpRoot();
    for (const rel of [
      "pom/index.ts",
      "pom/orders-page.ts",
      "lib/m.mts",
      "lib/c.cts",
    ]) {
      mkdirSync(join(dir, rel, ".."), { recursive: true });
      writeFileSync(join(dir, rel), "export {};\n");
    }
    const at = { dir };
    const from = join(dir, "tests", "cairn", "a.spec.ts");
    expect(importSpecifier("./pom", at, { fromFile: from, ext: ".js" })).toBe(
      "../../pom/index.js",
    );
    expect(
      importSpecifier("./pom/orders-page", at, { fromFile: from, ext: ".js" }),
    ).toBe("../../pom/orders-page.js");
    expect(importSpecifier("./lib/m", at, { fromFile: from, ext: ".js" })).toBe(
      "../../lib/m.mjs",
    );
    expect(importSpecifier("./lib/c", at, { fromFile: from, ext: ".js" })).toBe(
      "../../lib/c.cjs",
    );
    // without explicit extensions the barrel stays a directory import
    expect(importSpecifier("./pom", at, { fromFile: from, ext: "" })).toBe(
      "../../pom",
    );
  });

  it("keeps a package or alias specifier as written", () => {
    expect(
      importSpecifier("@acme/fixtures", loaded, {
        fromFile: "/host/e2e/a.ts",
        ext: ".js",
      }),
    ).toBe("@acme/fixtures");
  });
});

describe("names and imports", () => {
  it("spells class, method and file names", () => {
    expect(pascalCase("login_demo_app")).toBe("LoginDemoApp");
    expect(camelCase("login_demo_app")).toBe("loginDemoApp");
    expect(kebabCase("LoginDemoAppPage")).toBe("login-demo-app-page");
    expect(kebabCase("HTMLPage")).toBe("html-page");
  });

  it("merges named imports of one module so no binding is imported twice", () => {
    expect(
      mergeImports([
        `import { cairnRequest } from "../request";`,
        `import { cairnRequest, cairnLogin } from "../request";`,
        `import { type CairnAuth } from "../request";`,
        `import { BasePage } from "../../../pom/base-page";`,
        `import { expect } from "@playwright/test";`,
      ]),
    ).toEqual([
      `import { expect } from "@playwright/test";`,
      `import { BasePage } from "../../../pom/base-page";`,
      `import { cairnLogin, cairnRequest, type CairnAuth } from "../request";`,
    ]);
  });
});

describe("loading and problems", () => {
  it("loads a map and reports a relative import that names no file", () => {
    const root = tmpRoot();
    mkdirSync(join(root, "pom"), { recursive: true });
    writeFileSync(
      join(root, "pom", "base-page.ts"),
      "export class BasePage {}\n",
    );
    writeFileSync(join(root, "fixtures.ts"), "export const test = 1;\n");
    writeFileSync(join(root, "export.map.yml"), MAP);
    const loaded = loadExportMap(join(root, "export.map.yml"));
    expect(loaded.dir).toBe(root);
    expect(exportMapProblems(loaded)).toEqual([
      "actions.open_order.method.import: ./pom/orders-page does not name a file (relative imports resolve from the map's directory)",
    ]);
    writeFileSync(
      join(root, "pom", "orders-page.ts"),
      "export class OrdersPage {}\n",
    );
    expect(exportMapProblems(loaded)).toEqual([]);
    expect(() => loadExportMap(join(root, "nope.yml"))).toThrow(
      "does not exist",
    );
  });
});

const steps = (raw: unknown[]) =>
  SpecSchema.parse({
    version: 1,
    name: "x",
    intent: "x",
    outcomes: [
      { id: "ok", description: "x", verify: { text: { contains: "x" } } },
    ],
    steps: raw,
  }).steps ?? [];

describe("API login detection", () => {
  it("accepts request-only steps and says why a login is not one", () => {
    expect(
      apiLoginBlocker(
        steps([
          { id: "a", request: { method: "POST", url: "/login" } },
          { id: "b", request: { url: "/me" } },
        ]),
      ),
    ).toBeUndefined();
    expect(
      apiLoginBlocker(
        steps([
          { id: "a", request: { url: "/login" } },
          { id: "b", open: "/" },
        ]),
      ),
    ).toContain('step "b" is not a request');
    expect(
      apiLoginBlocker(
        steps([{ id: "a", request: { url: "/login", credentials: "omit" } }]),
      ),
    ).toContain("credentials: omit");
    expect(
      apiLoginBlocker(
        steps([
          {
            id: "a",
            request: { url: "/p", until: { status: 200 } },
          },
        ]),
      ),
    ).toContain("request.matrix / until");
  });

  it("effective vars: call vars over spec vars over the action's defaults", () => {
    const call = {
      action: "open_order",
      loaded: { actionDefaults: { id: "1", tab: "a" } },
      callVars: { id: "9" },
      specVars: { tab: "b" },
    } as unknown as MapCall;
    expect(effectiveVars(call)).toEqual({ id: "9", tab: "b" });
  });
});

describe("authState module", () => {
  const states = [
    {
      name: "member_login",
      file: ".auth/member_login.json",
      literal: '{ "login": { "method": "POST", "url": "/api/login" } }',
      requiredEnv: ["API_PASSWORD"],
    },
  ];

  it("reads credentials at run time and writes the state under .auth", () => {
    const source = renderAuthStateModule("ts", "cjs", states);
    expect(source).toContain('resolve(__dirname, "..")');
    expect(source).toContain('required: ["API_PASSWORD"]');
    expect(source).toContain("await cairnLoginState(state.auth(), {");
    expect(source).toContain(
      'import { cairnLoginState, type CairnAuth } from "./request";',
    );
    expect(source).not.toContain("import.meta");
  });

  it("ES modules find their directory from import.meta.url; JavaScript has no types", () => {
    const esm = renderAuthStateModule("ts", "esm", states);
    expect(esm).toContain('fileURLToPath(new URL("..", import.meta.url))');
    expect(esm).not.toContain("__dirname");
    const js = renderAuthStateModule("js", "esm", states);
    expect(js).toContain('from "./request.js"');
    expect(js).not.toContain(": string");
    expect(js).not.toContain("interface");
  });
});
