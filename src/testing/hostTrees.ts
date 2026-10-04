/**
 * Neutral host Playwright trees for the export tests (E8). Each is modeled on
 * the SHAPE of a real monorepo e2e package — a playwright config with its
 * timeouts / testIdAttribute / bypassCSP, a tsconfig that extends a base and
 * declares path aliases, util fixtures, page objects over a base class, an
 * eslint config and a prettier config — with invented names throughout.
 *
 * Trees are written into a temp directory at test time (no stray TypeScript
 * in the repo's own typecheck). `linkHostToolchain` gives the tree the repo's
 * own tsc / playwright through a `node_modules` of symlinks, plus tiny fake
 * `eslint` and `prettier` binaries that stand in for the host's (a real
 * eslint is not a dependency here).
 */
import {
  chmodSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { dirname, join } from "node:path";

const REPO_NODE_MODULES = join(import.meta.dirname, "..", "..", "node_modules");

export interface HostTree {
  /** Repo-like root (the base tsconfig and prettier config live here). */
  root: string;
  /** The e2e package: playwright.config, tsconfig, package.json. */
  e2e: string;
  /** The Playwright config file. */
  config: string;
  /** A good `--into` directory inside the host's testDir. */
  into: string;
}

function put(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  }
}

const BASE_TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node10",
      strict: true,
      noImplicitReturns: true,
      noUnusedLocals: true,
      noUnusedParameters: true,
      esModuleInterop: true,
      resolveJsonModule: true,
      skipLibCheck: true,
      noEmit: true,
    },
  },
  null,
  2,
);

/**
 * What a host keeps around its tests that an export map binds to (E9): a
 * Playwright fixtures module with a typed session fixture (the "login"), an
 * option fixture and a page object instance, plus a page object over the base
 * page. `ext` is the import extension the host's module resolution needs.
 */
function mapTargets(ext: "" | ".js"): Record<string, string> {
  return {
    "pom/orders-page.ts": `import {BasePage} from "./base-page${ext}";

export class OrdersPage extends BasePage {
  async openOrder(id: string, tab?: string): Promise<void> {
    await this.page.goto("/orders/" + id + (tab ? "?tab=" + tab : ""));
  }
}
`,
    "fixtures.ts": `import {test as base} from "@playwright/test";
import {OrdersPage} from "./pom/orders-page${ext}";

export type SessionFixtures = {
  memberSession: {user: string};
  tenant: string;
  ordersPage: OrdersPage;
};

export const test = base.extend<SessionFixtures>({
  tenant: ["acme", {option: true}],
  memberSession: async ({page, tenant}, use) => {
    await page.goto("/login?tenant=" + tenant);
    await use({user: "member"});
  },
  ordersPage: async ({page}, use) => {
    await use(new OrdersPage(page));
  },
});
`,
  };
}

/**
 * CommonJS host: no `"type": "module"`, tsconfig `module: commonjs` with a
 * `@e2e/*` alias, `testDir: ./tests`, default test match, `bypassCSP` set,
 * a custom test id attribute, timeouts built from a constant.
 */
export function writeCjsHost(root: string): HostTree {
  put(root, {
    "package.json": JSON.stringify({ name: "acme-monorepo", private: true }),
    "tsconfig.base.json": BASE_TSCONFIG,
    ".prettierrc": JSON.stringify({
      printWidth: 120,
      bracketSpacing: false,
      trailingComma: "all",
    }),
    "e2e/package.json": JSON.stringify({
      name: "acme-e2e",
      version: "1.0.0",
      scripts: { test: "playwright test" },
    }),
    "e2e/tsconfig.json": JSON.stringify(
      {
        extends: "../tsconfig.base.json",
        compilerOptions: {
          lib: ["ES2023", "DOM"],
          types: ["node"],
          baseUrl: ".",
          paths: { "@e2e/*": ["./*"] },
        },
        include: ["**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2,
    ),
    "e2e/eslint.config.cjs": "module.exports = [];\n",
    "e2e/playwright.config.ts": `import {PlaywrightTestConfig} from "@playwright/test";

const THIRTY_SECONDS = 30 * 1000;

const config: PlaywrightTestConfig = {
  globalSetup: require.resolve("./global-setup"),
  testDir: "./tests",
  use: {
    baseURL: process.env.E2E_URL || process.env.BASE_URL || "http://localhost:8080",
    actionTimeout: THIRTY_SECONDS,
    navigationTimeout: 15000,
    testIdAttribute: "data-qa-key",
    bypassCSP: true,
  },
  expect: {timeout: THIRTY_SECONDS},
  // The longest a test may run before it is killed.
  timeout: 120000,
  reporter: [["list"]],
};

export default config;
`,
    "e2e/global-setup.ts": `import {FullConfig} from "@playwright/test";

async function globalSetup(config: FullConfig): Promise<void> {
  const baseURL = config.projects[0]?.use.baseURL;
  if (!baseURL) {
    throw new Error("no baseURL");
  }
}

export default globalSetup;
`,
    "e2e/util/testutils.ts": `export function randomString(length = 8): string {
  return Math.random().toString(36).slice(2, 2 + length);
}
`,
    "e2e/pom/base-page.ts": `import {Page} from "@playwright/test";

export class BasePage {
  constructor(public page: Page) {}

  async click(selector: string): Promise<void> {
    await this.page.click(selector);
  }
}
`,
    "e2e/pom/home-page.ts": `import {BasePage} from "./base-page";

export class HomePage extends BasePage {
  async open(): Promise<void> {
    await this.page.goto("/");
  }
}
`,
    "e2e/pom/index.ts": `export * from "./base-page";
export * from "./home-page";
`,
    ...Object.fromEntries(
      Object.entries(mapTargets("")).map(([path, text]) => [
        `e2e/${path}`,
        text,
      ]),
    ),
  });
  return {
    root,
    e2e: join(root, "e2e"),
    config: join(root, "e2e", "playwright.config.ts"),
    into: join(root, "e2e", "tests", "cairn"),
  };
}

/**
 * ES module host: `"type": "module"`, `nodenext` resolution (relative imports
 * need `.js`), `defineConfig` with a `projects` list that carries `bypassCSP`,
 * `testDir: ./specs` and a regex `testMatch` (`*.e2e.ts`), plain-number
 * timeouts, a different test id attribute.
 */
export function writeEsmHost(root: string): HostTree {
  put(root, {
    "package.json": JSON.stringify({
      name: "acme-esm-e2e",
      private: true,
      type: "module",
    }),
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: {
          target: "ES2022",
          module: "nodenext",
          moduleResolution: "nodenext",
          lib: ["ES2023", "DOM"],
          types: ["node"],
          strict: true,
          noUnusedLocals: true,
          skipLibCheck: true,
          noEmit: true,
        },
        include: ["**/*.ts"],
        exclude: ["node_modules"],
      },
      null,
      2,
    ),
    "eslint.config.js": "export default [];\n",
    "playwright.config.ts": `import {defineConfig} from "@playwright/test";

export default defineConfig({
  testDir: "./specs",
  testMatch: /.*\\.e2e\\.ts$/,
  timeout: 45_000,
  expect: {timeout: 10_000},
  use: {
    baseURL: "http://127.0.0.1:4173",
    testIdAttribute: "data-test",
  },
  projects: [{name: "chromium", use: {bypassCSP: true}}],
});
`,
  });
  put(root, {
    "pom/base-page.ts": `import {Page} from "@playwright/test";

export class BasePage {
  constructor(public page: Page) {}
}
`,
    ...mapTargets(".js"),
  });
  mkdirSync(join(root, "specs"), { recursive: true });
  return {
    root,
    e2e: root,
    config: join(root, "playwright.config.ts"),
    into: join(root, "specs", "cairn"),
  };
}

/**
 * Link the repo's tsc, typescript, @types and Playwright into the tree
 * (a `node_modules` of symlinks at `root`) and add the fake eslint and
 * prettier binaries. `prettierLog` collects the file path of every prettier
 * call.
 */
export function linkHostToolchain(
  root: string,
  options: { eslint?: boolean; prettier?: boolean; prettierLog?: string } = {},
): void {
  const nm = join(root, "node_modules");
  mkdirSync(join(nm, ".bin"), { recursive: true });
  for (const name of [
    "typescript",
    "@types",
    "@playwright",
    "playwright",
    "playwright-core",
  ]) {
    const target = join(REPO_NODE_MODULES, name);
    if (existsSync(target) && !existsSync(join(nm, name))) {
      symlinkSync(target, join(nm, name));
    }
  }
  for (const bin of ["tsc", "playwright"]) {
    const target = join(REPO_NODE_MODULES, ".bin", bin);
    if (existsSync(target) && !existsSync(join(nm, ".bin", bin))) {
      symlinkSync(target, join(nm, ".bin", bin));
    }
  }
  if (options.eslint) writeBin(nm, "eslint", FAKE_ESLINT);
  if (options.prettier) {
    writeBin(
      nm,
      "prettier",
      FAKE_PRETTIER.replace(
        "__LOG__",
        JSON.stringify(options.prettierLog ?? ""),
      ),
    );
  }
}

function writeBin(nm: string, name: string, source: string): void {
  const path = join(nm, ".bin", name);
  writeFileSync(path, source);
  chmodSync(path, 0o755);
}

/**
 * A stand-in for the host's eslint: `curly` (an `if` / `else` / `for` /
 * `while` body needs braces) and `ordered-imports` (packages before
 * relative paths, each alphabetical, named specifiers alphabetical) on every
 * file that does not start with an `eslint-disable` banner. Prints eslint's
 * `--format json` shape.
 */
export const FAKE_ESLINT = `#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");
const files = process.argv.slice(2).filter((arg) => !arg.startsWith("--") && arg !== "json");
const rel = (s) => s.startsWith(".") || s.startsWith("/");
const cmp = (a, b) => (a.toLowerCase() < b.toLowerCase() ? -1 : a.toLowerCase() > b.toLowerCase() ? 1 : a < b ? -1 : a > b ? 1 : 0);
const out = [];
for (const file of files) {
  const abs = path.resolve(file);
  const text = fs.readFileSync(abs, "utf8");
  const messages = [];
  if (!text.startsWith("/* eslint-disable")) {
    const lines = text.split("\\n");
    lines.forEach((line, i) => {
      if (/^\\s*(?:\\} else )?(?:if|for|while) \\(.*\\) [^{\\s].*;\\s*$/.test(line) || /^\\s*else [^{i\\s]/.test(line)) {
        messages.push({ ruleId: "curly", severity: 2, message: "Expected { after condition", line: i + 1 });
      }
    });
    const imports = [];
    lines.forEach((line, i) => {
      const m = /^import (?:type )?\\{([^}]*)\\} from "([^"]+)";$/.exec(line) || /^import .* from "([^"]+)";$/.exec(line);
      if (m) imports.push({ source: m[m.length - 1], named: m.length === 3 ? m[1] : "", line: i + 1 });
    });
    for (let i = 1; i < imports.length; i += 1) {
      const a = imports[i - 1];
      const b = imports[i];
      const bad = rel(a.source) !== rel(b.source) ? rel(a.source) && !rel(b.source) : cmp(a.source, b.source) > 0;
      if (bad) messages.push({ ruleId: "local/ordered-imports", severity: 2, message: "Import source " + b.source + " should come before " + a.source, line: b.line });
    }
    for (const imp of imports) {
      const names = imp.named.split(",").map((s) => s.trim().replace(/^type /, "")).filter(Boolean);
      for (let i = 1; i < names.length; i += 1) {
        if (cmp(names[i - 1], names[i]) > 0) messages.push({ ruleId: "local/ordered-imports", severity: 2, message: "Named import " + names[i] + " should come before " + names[i - 1], line: imp.line });
      }
    }
  }
  out.push({ filePath: abs, errorCount: messages.length, warningCount: 0, messages });
}
process.stdout.write(JSON.stringify(out));
`;

/**
 * A stand-in for the host's prettier: `--stdin-filepath <file>` reads the
 * file text from stdin and writes it back with trailing whitespace trimmed and,
 * for code files, a marker line — so a test can tell the formatter ran and
 * that formatting is a fixed point (the marker is never added twice).
 */
export const FAKE_PRETTIER = `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const at = args.indexOf("--stdin-filepath");
const file = at >= 0 ? args[at + 1] : "";
const log = __LOG__;
if (log) fs.appendFileSync(log, file + "\\n");
let text = fs.readFileSync(0, "utf8");
text = text.split("\\n").map((line) => line.replace(/\\s+$/, "")).join("\\n").replace(/\\n+$/, "") + "\\n";
if (/\\.(?:[cm]?[jt]sx?)$/.test(file) && !text.includes("// formatted by host prettier")) {
  text += "// formatted by host prettier\\n";
}
process.stdout.write(text);
`;
