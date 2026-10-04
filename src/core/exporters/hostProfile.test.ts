import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  linkHostToolchain,
  writeCjsHost,
  writeEsmHost,
} from "../../testing/hostTrees";
import {
  globToRegExp,
  HostProfileError,
  readHostProfile,
  resolveHostEmit,
} from "./hostProfile";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cairn-host-")));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function write(root: string, rel: string, content: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("readHostProfile (CommonJS host)", () => {
  it("reads timeouts, testIdAttribute, bypassCSP, baseURL and testDir statically", async () => {
    const tree = writeCjsHost(tmpRoot());
    const profile = await readHostProfile({
      configPath: tree.config,
      into: tree.into,
    });
    expect(profile).toMatchObject({
      timeout: 120000,
      expectTimeout: 30000,
      actionTimeout: 30000,
      navigationTimeout: 15000,
      testIdAttribute: "data-qa-key",
      bypassCSP: true,
      baseURL: {
        literal: "http://localhost:8080",
        env: ["BASE_URL", "E2E_URL"],
      },
      testDir: join(tree.e2e, "tests"),
      moduleSystem: "cjs",
    });
    expect(profile.dynamic).toEqual([]);
    expect(profile.moduleReason).toContain('no "type": "module"');
  });

  it("reads the tsconfig through its extends chain, with path aliases", async () => {
    const tree = writeCjsHost(tmpRoot());
    const profile = await readHostProfile({
      configPath: tree.config,
      into: tree.into,
    });
    expect(profile.tsconfig).toMatchObject({
      module: "commonjs",
      allowImportingTsExtensions: false,
    });
    expect(profile.tsconfig?.aliases).toEqual([
      { pattern: "@e2e/*", prefix: "@e2e/", dir: tree.e2e },
    ]);
  });

  it("finds the prettier config and its local binary only when both exist", async () => {
    const tree = writeCjsHost(tmpRoot());
    const without = await readHostProfile({
      configPath: tree.config,
      into: tree.into,
    });
    expect(without.prettier).toMatchObject({
      config: join(tree.root, ".prettierrc"),
    });
    expect(without.prettier?.bin).toBeUndefined();
    expect(
      resolveHostEmit(without, { into: tree.into, lang: "ts" }).notes.join(
        "\n",
      ),
    ).toContain("no local node_modules/.bin/prettier");

    linkHostToolchain(tree.root, { prettier: true });
    const withBin = await readHostProfile({
      configPath: tree.config,
      into: tree.into,
    });
    expect(withBin.prettier?.bin).toBe(
      join(tree.root, "node_modules", ".bin", "prettier"),
    );
    expect(withBin.eslintConfig).toBe(join(tree.e2e, "eslint.config.cjs"));
  });

  it("never executes the host's code", async () => {
    const root = tmpRoot();
    const marker = join(root, "executed.txt");
    const config = write(
      root,
      "playwright.config.ts",
      `import {writeFileSync} from "node:fs";
writeFileSync(${JSON.stringify(marker)}, "ran");
process.exit(9);
export default { timeout: 5000, use: { testIdAttribute: "data-x" } };
`,
    );
    const profile = await readHostProfile({ configPath: config });
    expect(profile.timeout).toBe(5000);
    expect(profile.testIdAttribute).toBe("data-x");
    expect(() => realpathSync(marker)).toThrow();
  });
});

describe("readHostProfile (ESM host)", () => {
  it("reads defineConfig, a projects list, a regex testMatch and ESM from package.json", async () => {
    const tree = writeEsmHost(tmpRoot());
    const profile = await readHostProfile({
      configPath: tree.config,
      into: tree.into,
    });
    expect(profile).toMatchObject({
      moduleSystem: "esm",
      timeout: 45000,
      expectTimeout: 10000,
      testIdAttribute: "data-test",
      // Set only in the one project: every project agrees, so it counts.
      bypassCSP: true,
      baseURL: { literal: "http://127.0.0.1:4173", env: [] },
      testDir: join(tree.root, "specs"),
      projects: ["chromium"],
      testMatch: [{ kind: "regex", source: "/.*\\.e2e\\.ts$/" }],
    });
    expect(profile.moduleReason).toContain('"type": "module"');
    expect(profile.tsconfig).toMatchObject({
      module: "nodenext",
      moduleResolution: "nodenext",
    });
  });

  it("does not assume an option the projects disagree on", async () => {
    const root = tmpRoot();
    const config = write(
      root,
      "playwright.config.ts",
      `export default {
  projects: [
    {name: "a", use: {bypassCSP: true}, timeout: 1000},
    {name: "b", use: {bypassCSP: false}, timeout: 2000},
  ],
};
`,
    );
    const profile = await readHostProfile({ configPath: config });
    expect(profile.bypassCSP).toBeUndefined();
    expect(profile.timeout).toBeUndefined();
    // both projects run the generated tests: neither value is assumed
    const emit = resolveHostEmit(profile, { into: root, lang: "ts" });
    expect(emit.testTimeoutMs).toBeUndefined();
    expect(emit.bypassCsp).toBe(false);
    expect(emit.bypassCspDynamic).toBe(true);
    expect(emit.notes.join("\n")).toContain(
      "differs between the projects that run the generated tests (a: 1000, b: 2000)",
    );
  });
});

describe("readHostProfile (what cannot be read statically)", () => {
  it("records a computed option as dynamic and keeps the rest", async () => {
    const root = tmpRoot();
    const config = write(
      root,
      "playwright.config.ts",
      `import {defineConfig, devices} from "@playwright/test";
const slow = process.env.CI ? 90_000 : 30_000;
export default defineConfig({
  timeout: slow,
  use: {
    ...devices["Desktop Chrome"],
    bypassCSP: process.env.CI ? true : false,
    baseURL: process.env.APP_URL,
    testIdAttribute: "data-qa",
  },
});
`,
    );
    const profile = await readHostProfile({ configPath: config });
    expect(profile.dynamic).toEqual(
      expect.arrayContaining(["timeout", "use.bypassCSP"]),
    );
    expect(profile.timeout).toBeUndefined();
    expect(profile.testIdAttribute).toBe("data-qa");
    expect(profile.baseURL).toEqual({ env: ["APP_URL"] });
    const emit = resolveHostEmit(profile, { into: root, lang: "ts" });
    // No static timeout: never a guessed default — each test sets its budget.
    expect(emit.testTimeoutMs).toBeUndefined();
    expect(emit.notes.join("\n")).toContain(
      "the host's test timeout is not statically readable (process.env.CI ? 90_000 : 30_000)",
    );
    expect(emit.bypassCsp).toBe(false);
    expect(emit.bypassCspDynamic).toBe(true);
  });

  it("follows const objects, spreads and `module.exports =`", async () => {
    const root = tmpRoot();
    const config = write(
      root,
      "playwright.config.js",
      `const use = { testIdAttribute: "data-from-const", actionTimeout: 4 * 1000 };
module.exports = { timeout: 60 * 1000, use: { ...use, baseURL: "http://x.test" } };
`,
    );
    const profile = await readHostProfile({ configPath: config });
    expect(profile).toMatchObject({
      timeout: 60000,
      actionTimeout: 4000,
      testIdAttribute: "data-from-const",
      baseURL: { literal: "http://x.test", env: [] },
      moduleSystem: "cjs",
    });
  });

  it("names the problem for a missing file, a missing export and a computed config", async () => {
    const root = tmpRoot();
    await expect(
      readHostProfile({ configPath: join(root, "nope.config.ts") }),
    ).rejects.toThrow(HostProfileError);
    const noExport = write(root, "a.config.ts", "export const x = 1;\n");
    await expect(readHostProfile({ configPath: noExport })).rejects.toThrow(
      /no default export/,
    );
    const computed = write(
      root,
      "b.config.ts",
      "import {build} from './build';\nexport default build();\n",
    );
    await expect(readHostProfile({ configPath: computed })).rejects.toThrow(
      /computed/,
    );
  });
});

describe("resolveHostEmit", () => {
  it("puts tests flat in an --into folder under testDir and names them *.spec", async () => {
    const tree = writeCjsHost(tmpRoot());
    const profile = await readHostProfile({
      configPath: tree.config,
      into: tree.into,
    });
    const emit = resolveHostEmit(profile, { into: tree.into, lang: "ts" });
    expect(emit).toMatchObject({
      moduleSystem: "cjs",
      testsDir: "",
      testSuffix: ".spec",
      testTimeoutMs: 120000,
      testIdAttribute: "data-qa-key",
      bypassCsp: true,
      importExt: "",
      tsExtensions: false,
      alias: { prefix: "@e2e/", dir: tree.e2e },
    });
  });

  it("compares real paths, for an --into that does not exist yet under a symlinked path", async () => {
    const base = tmpRoot();
    const tree = writeCjsHost(join(base, "real", "host"));
    symlinkSync(join(base, "real"), join(base, "link"));
    const into = join(base, "link", "host", "e2e", "tests", "not-yet");
    const profile = await readHostProfile({ configPath: tree.config, into });
    const emit = resolveHostEmit(profile, { into, lang: "ts" });
    expect(emit.testsDir).toBe("");
    expect(emit.alias).toMatchObject({ prefix: "@e2e/" });
  });

  it("keeps a tests/ subfolder when the host's testDir sits inside --into", async () => {
    const tree = writeCjsHost(tmpRoot());
    const profile = await readHostProfile({
      configPath: tree.config,
      into: tree.e2e,
    });
    expect(
      resolveHostEmit(profile, { into: tree.e2e, lang: "ts" }).testsDir,
    ).toBe("tests");
  });

  it("refuses an --into the host's testDir would never discover", async () => {
    const tree = writeCjsHost(tmpRoot());
    const profile = await readHostProfile({
      configPath: tree.config,
      into: join(tree.e2e, "elsewhere"),
    });
    expect(() =>
      resolveHostEmit(profile, {
        into: join(tree.e2e, "elsewhere"),
        lang: "ts",
      }),
    ).toThrow(/neither contains nor sits inside/);
  });

  it("names tests after the host's testMatch (and refuses when none matches)", async () => {
    const tree = writeEsmHost(tmpRoot());
    const profile = await readHostProfile({
      configPath: tree.config,
      into: tree.into,
    });
    const emit = resolveHostEmit(profile, { into: tree.into, lang: "ts" });
    expect(emit).toMatchObject({
      testSuffix: ".e2e",
      importExt: ".js",
      moduleSystem: "esm",
      testTimeoutMs: 45000,
    });
    expect(emit.notes.join("\n")).toContain("*.e2e.ts");
    expect(emit.notes.join("\n")).toContain("moduleResolution nodenext");

    const root = tmpRoot();
    const config = write(
      root,
      "playwright.config.ts",
      `export default { testMatch: "**/*.acceptance.ts" };\n`,
    );
    const odd = await readHostProfile({ configPath: config });
    expect(() => resolveHostEmit(odd, { into: root, lang: "ts" })).toThrow(
      /match the host's testMatch/,
    );
  });

  it("honors testIgnore", async () => {
    const root = tmpRoot();
    const config = write(
      root,
      "playwright.config.ts",
      `export default { testIgnore: ["**/generated/**"] };\n`,
    );
    const profile = await readHostProfile({ configPath: config });
    expect(() =>
      resolveHostEmit(profile, { into: join(root, "generated"), lang: "ts" }),
    ).toThrow(/testIgnore/);
  });

  it("uses Playwright's own 30s default when the host sets no timeout", async () => {
    const root = tmpRoot();
    const config = write(root, "playwright.config.ts", "export default {};\n");
    const profile = await readHostProfile({ configPath: config });
    const emit = resolveHostEmit(profile, { into: root, lang: "ts" });
    expect(emit.testTimeoutMs).toBe(30_000);
    expect(emit.testIdAttribute).toBe("data-testid");
    expect(emit.bypassCsp).toBe(false);
    expect(emit.lintDisableVendored).toBe(false);
  });
});

describe("Playwright's own resolution (project over top level, discovery, unread options)", () => {
  async function emitFor(files: Record<string, string>, into = "tests/cairn") {
    const root = tmpRoot();
    for (const [rel, content] of Object.entries(files))
      write(root, rel, content);
    if (!files["package.json"]) write(root, "package.json", '{"name":"h"}');
    const profile = await readHostProfile({
      configPath: join(root, "playwright.config.ts"),
      into: join(root, into),
    });
    return {
      root,
      profile,
      emit: () =>
        resolveHostEmit(profile, { into: join(root, into), lang: "ts" }),
    };
  }

  it("a project's timeout and use win over the top level (takeFirst / mergeObjects)", async () => {
    const { emit } = await emitFor({
      "playwright.config.ts": `import { defineConfig } from "@playwright/test";
export default defineConfig({ timeout: 30000, use: { testIdAttribute: "data-testid", bypassCSP: false },
  projects: [{ name: "chromium", timeout: 180000, use: { testIdAttribute: "data-qa", bypassCSP: true } }] });`,
    });
    expect(emit()).toMatchObject({
      testTimeoutMs: 180000,
      testIdAttribute: "data-qa",
      bypassCsp: true,
      projects: ["chromium"],
    });
  });

  it("only the projects that discover the generated tests count", async () => {
    const { emit } = await emitFor({
      "playwright.config.ts": `export default { projects: [
  { name: "app", use: { bypassCSP: true, testIdAttribute: "data-qa" } },
  { name: "setup", testMatch: /setup\\.ts/, use: { testIdAttribute: "data-other" } },
] };`,
    });
    const e = emit();
    expect(e).toMatchObject({
      bypassCsp: true,
      testIdAttribute: "data-qa",
      projects: ["app"],
    });
    expect(e.notes.join("\n")).toContain("setup do not discover them");
  });

  it("reads each project's browser; a bare `use: devices[...]` is read like its spread (sets none of the read options)", async () => {
    const { profile, emit } = await emitFor({
      "playwright.config.ts": `import { defineConfig, devices } from "@playwright/test";
export default defineConfig({ use: { testIdAttribute: "data-qa" }, projects: [
  { name: "setup", testMatch: /.*\\.setup\\.ts/ },
  { name: "desktop", use: { ...devices["Desktop Firefox"] } },
  { name: "phone", use: devices["iPhone 12"] },
  { name: "forced", use: { ...devices["Desktop Chrome"], browserName: "webkit" } },
  { name: "picked", use: { ...devices[pick()] } },
] });`,
    });
    expect(
      Object.fromEntries(
        profile.projectOptions.map((p) => [p.name, p.browserName]),
      ),
    ).toEqual({
      setup: "chromium",
      desktop: "firefox",
      phone: "webkit",
      forced: "webkit",
      picked: { unread: expect.stringContaining("devices[pick()]") },
    });
    // The bare form used to make `use` unreadable (testIdAttribute unknown).
    expect(profile.dynamic).toEqual([]);
    expect(emit().testIdAttribute).toBe("data-qa");
  });

  it("takes a device's browser from the host's own playwright-core descriptors", async () => {
    const root = tmpRoot();
    write(root, "package.json", '{"name":"h"}');
    linkHostToolchain(root);
    const config = write(
      root,
      "playwright.config.ts",
      `import { defineConfig, devices } from "@playwright/test";
export default defineConfig({ projects: [{ name: "mobile", use: { ...devices["Moto G4"] } }] });`,
    );
    const profile = await readHostProfile({ configPath: config });
    // No name heuristic says so: only the descriptor table knows.
    expect(profile.projectOptions[0]?.browserName).toBe("chromium");
  });

  it("an unread timeout or testIdAttribute is never replaced by a default", async () => {
    const { emit, profile } = await emitFor({
      "playwright.config.ts": `export default { timeout: process.env.CI ? 180000 : 120000, use: { testIdAttribute: pick() } };`,
    });
    const e = emit();
    expect(e.testTimeoutMs).toBeUndefined();
    expect(e.testIdAttribute).toBeUndefined();
    expect(profile.dynamic).toEqual(["timeout", "use.testIdAttribute"]);
    expect(e.notes.join("\n")).toContain(
      "use.testIdAttribute is not statically readable (pick()); testid locators are emitted as explicit attribute selectors",
    );
  });

  it("a ?? / || literal fallback for testIdAttribute is used and said", async () => {
    const { emit } = await emitFor({
      "playwright.config.ts": `export default { use: { testIdAttribute: process.env.TID ?? "data-qa" } };`,
    });
    const e = emit();
    expect(e.testIdAttribute).toBe("data-qa");
    expect(e.notes.join("\n")).toContain('assumes its fallback "data-qa"');
  });

  it("|| / ?? on a literal follow JavaScript truthiness", async () => {
    const { emit } = await emitFor({
      "playwright.config.ts": `const T = 0;
const U = undefined;
export default { timeout: T || 90000, expect: { timeout: U ?? 7000 }, use: { actionTimeout: T ?? 5 } };`,
    });
    const e = emit();
    expect(e.testTimeoutMs).toBe(90000);
  });

  it("reads path.join / path.resolve(__dirname, …), templates and a relative base config", async () => {
    const joined = await emitFor(
      {
        "playwright.config.ts": `import path from "node:path";
export default { testDir: path.join(__dirname, "e2e") };`,
      },
      "e2e/cairn",
    );
    expect(joined.profile.testDir).toBe(join(joined.root, "e2e"));
    expect(joined.emit().testsDir).toBe("");
    // the old silent fallback put a folder outside testDir through
    const outside = await emitFor({
      "playwright.config.ts": `import { resolve as resolvePath } from "path";
export default { testDir: resolvePath(__dirname, "e2e") };`,
    });
    expect(() => outside.emit()).toThrow(/neither contains nor sits inside/);
    const based = await emitFor(
      {
        "playwright.base.ts": `import { defineConfig } from "@playwright/test";
export default defineConfig({ timeout: 90000, testDir: \`\${__dirname}/suite\`, use: { testIdAttribute: "data-qa" } });`,
        "playwright.config.ts": `import base from "./playwright.base";
import { defineConfig } from "@playwright/test";
export default defineConfig(base, { use: { baseURL: "http://x.test" } });`,
      },
      "suite/cairn",
    );
    expect(based.emit()).toMatchObject({
      testTimeoutMs: 90000,
      testIdAttribute: "data-qa",
    });
    expect(based.profile.baseURL).toEqual({
      literal: "http://x.test",
      env: [],
    });
  });

  it("refuses when discovery cannot be read (testDir, an unreadable base config)", async () => {
    const dynamicDir = await emitFor({
      "playwright.config.ts": `export default { testDir: process.env.E2E_DIR };`,
    });
    expect(() => dynamicDir.emit()).toThrow(
      /`testDir` is not statically readable \(process\.env\.E2E_DIR\)/,
    );
    const missingBase = await emitFor({
      "playwright.config.ts": `import base from "./not-there";
import { defineConfig } from "@playwright/test";
export default defineConfig(base, { use: { baseURL: "http://x" } });`,
    });
    expect(() => missingBase.emit()).toThrow(/not statically readable/);
    expect(missingBase.profile.notes.join("\n")).toContain(
      "cannot be read statically",
    );
  });

  it("matches testMatch like Playwright's createFileMatcher (globs get **/, regexes see the absolute path)", async () => {
    const glob = await emitFor({
      "playwright.config.ts": `export default { testDir: "./tests", testMatch: "tests/**/*.spec.ts" };`,
    });
    expect(glob.emit().testSuffix).toBe(".spec");
    const anchored = await emitFor({
      "playwright.config.ts": `export default { testDir: "./tests", testMatch: /^cairn\\/.*\\.spec\\.ts$/ };`,
    });
    expect(() => anchored.emit()).toThrow(/match the host's testMatch/);
  });

  it("infers module resolution from module: nodenext (M1)", async () => {
    const { emit, profile } = await emitFor({
      "package.json": '{"name":"h","type":"module"}',
      "tsconfig.json": JSON.stringify({
        compilerOptions: { module: "nodenext", strict: true },
      }),
      "playwright.config.ts": "export default {};",
    });
    expect(profile.tsconfig?.moduleResolution).toBe("nodenext");
    expect(emit().importExt).toBe(".js");
  });

  it("notes a signed-in host (use.storageState) for coldStart: guest specs", async () => {
    const { emit } = await emitFor({
      "playwright.config.ts": `export default { use: { storageState: ".auth/user.json" } };`,
    });
    const e = emit();
    expect(e.storageState).toMatch(/\.auth\/user\.json$/);
    expect(e.notes.join("\n")).toContain("coldStart: guest specs reset it");
  });

  it("stops config and binary lookups at the host boundary (no stray ~/.prettierrc)", async () => {
    const outer = tmpRoot();
    // a prettier config and binary ABOVE the host's repository root
    write(outer, ".prettierrc", "{}");
    write(outer, "node_modules/.bin/prettier", "#!/bin/sh\nexit 0\n");
    const host = join(outer, "host");
    write(host, ".git/HEAD", "ref: refs/heads/main\n");
    write(host, "package.json", '{"name":"h"}');
    write(host, "playwright.config.ts", "export default {};");
    const profile = await readHostProfile({
      configPath: join(host, "playwright.config.ts"),
      into: join(host, "tests"),
    });
    expect(profile.prettier).toBeUndefined();
  });
});

describe("globToRegExp", () => {
  it("handles the shapes Playwright's testMatch uses", () => {
    const def = globToRegExp("**/*.@(spec|test).?(c|m)[jt]s?(x)");
    expect(def.test("a/b/login.spec.ts")).toBe(true);
    expect(def.test("login.test.tsx")).toBe(true);
    expect(def.test("login.mjs")).toBe(false);
    expect(def.test("login.e2e.ts")).toBe(false);
    expect(globToRegExp("*.e2e.ts").test("x.e2e.ts")).toBe(true);
    expect(globToRegExp("*.e2e.ts").test("dir/x.e2e.ts")).toBe(false);
    expect(globToRegExp("**/*.{a,b}.ts").test("p/q/z.b.ts")).toBe(true);
  });
});
