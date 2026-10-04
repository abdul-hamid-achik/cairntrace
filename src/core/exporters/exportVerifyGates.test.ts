import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildExportManifest,
  EXPORT_MANIFEST_FILE,
  renderExportManifest,
  type ExportManifestMode,
  type ExportManifestV1,
} from "./exportManifest";
import {
  chooseVerifyProject,
  freshnessGate,
  lintGate,
  listContext,
  listGate,
  listedTestsFromJson,
  sentinelsGate,
  typecheckGate,
  type ExportTarget,
} from "./exportVerifyGates";

const REPO_NODE_MODULES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "node_modules",
);

const roots: string[] = [];
function tmpRoot(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "cairn-verify-gates-")));
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

interface FixtureInput {
  /** Export root relative to the temp root ("" = the root itself). */
  at?: string;
  files: Record<string, string>;
  mode?: ExportManifestMode;
  lang?: "ts" | "js";
  specs?: string[];
  /** Files outside the export root (a host tree), relative to the temp root. */
  host?: Record<string, string>;
  /** Link the repo's node_modules (tsc, playwright, @types/node) at the temp root. */
  tools?: boolean;
  /** Extra manifest `source` fields (a host profile's `hostConfig`). */
  source?: Partial<ExportManifestV1["source"]>;
}

function fixture(input: FixtureInput): { root: string; target: ExportTarget } {
  const root = tmpRoot();
  const dir = input.at ? join(root, input.at) : root;
  for (const [rel, content] of Object.entries(input.host ?? {})) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  for (const [rel, content] of Object.entries(input.files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), content);
  }
  if (input.tools) symlinkSync(REPO_NODE_MODULES, join(root, "node_modules"));
  const manifest = buildExportManifest({
    exporterVersion: "0.0.0-test",
    mode: input.mode ?? "project",
    lang: input.lang ?? "ts",
    source: { input: "specs", varKeys: [], ...input.source },
    specs: (input.specs ?? []).map((testFile) => ({
      spec: `specs/${testFile}.yml`,
      contractHash: "sha256:x",
      testFile,
      sourceDigest: "sha256:y",
    })),
    files: Object.entries(input.files).map(([relPath, content]) => ({
      relPath,
      content,
    })),
  });
  writeFileSync(
    join(dir, EXPORT_MANIFEST_FILE),
    renderExportManifest(manifest),
  );
  return { root, target: { dir, manifest } };
}

const STRICT_TSCONFIG = JSON.stringify({
  compilerOptions: {
    target: "ES2022",
    module: "ESNext",
    moduleResolution: "Bundler",
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    types: [],
  },
  include: ["**/*.ts"],
});

describe("sentinelsGate", () => {
  it("passes a clean export", async () => {
    const { target } = fixture({
      files: { "tests/a.spec.ts": "export const a = 1;\n" },
    });
    const gate = await sentinelsGate(target);
    expect(gate).toMatchObject({ id: "sentinels", status: "passed" });
    expect(gate.summary).toContain("2 files");
  });

  it("fails on a leaked late-bound sentinel, case-insensitively, naming file and line", async () => {
    const { target } = fixture({
      files: {
        "tests/a.spec.ts":
          "const ok = 1;\nconst t = `${__cairn_run_token__}`;\n",
        "lib/b.ts": "const s = '__CAIRN_SECRET_REF__NAME__';\n",
        "lib/c.ts": "export const fine = 2;\n",
      },
    });
    const gate = await sentinelsGate(target);
    expect(gate.status).toBe("failed");
    expect(gate.findings).toEqual([
      "lib/b.ts:1: __CAIRN_SECRET_REF__NAME__",
      "tests/a.spec.ts:2: __cairn_run_token__",
    ]);
  });
});

describe("freshnessGate", () => {
  const base = { files: { stale: [], missing: [], orphaned: [] }, specs: [] };
  it("maps the check report: fresh passes, stale fails with the drift, error is skipped", () => {
    expect(freshnessGate({ ...base, status: "fresh" }, Date.now()).status).toBe(
      "passed",
    );
    const stale = freshnessGate(
      {
        status: "stale",
        files: {
          stale: ["tests/a.spec.ts"],
          missing: ["lib/x.ts"],
          orphaned: ["tests/old.spec.ts"],
        },
        specs: [{ spec: "specs/a.yml", status: "changed" }],
        preconditionsStale: true,
      },
      Date.now(),
    );
    expect(stale.status).toBe("failed");
    expect(stale.findings).toEqual([
      "stale: tests/a.spec.ts",
      "missing: lib/x.ts",
      "orphaned: tests/old.spec.ts",
      "spec specs/a.yml: changed",
      "preconditions: changed",
    ]);
    const error = freshnessGate(
      { ...base, status: "error", error: "sources gone" },
      Date.now(),
    );
    expect(error.status).toBe("skipped");
    expect(error.reason).toContain("sources gone");
  });
});

function fakeTsc(root: string, script: string): void {
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  const bin = join(root, "node_modules", ".bin", "tsc");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
}

describe("typecheckGate: a tsc that checked nothing is never a pass", () => {
  it("is skipped when tsc exits non-zero without a diagnostic (with and without a tsconfig)", async () => {
    for (const withConfig of [true, false]) {
      const crash = fixture({
        files: {
          ...(withConfig ? { "tsconfig.json": STRICT_TSCONFIG } : {}),
          "tests/a.ts": "export const a = 1;\n",
        },
      });
      fakeTsc(
        crash.root,
        "echo 'FATAL ERROR: heap out of memory' >&2\nexit 134",
      );
      const gate = await typecheckGate(crash.target);
      expect(gate.status, String(withConfig)).toBe("skipped");
      expect(gate.reason).toContain("without a diagnostic");
    }
  });

  it("is skipped when the strict fallback rejects its options", async () => {
    const odd = fixture({
      files: { "tests/a.ts": "export const a = 1;\n" },
    });
    fakeTsc(
      odd.root,
      "echo \"error TS5023: Unknown compiler option '--noUncheckedSideEffectImports'.\"\nexit 1",
    );
    const gate = await typecheckGate(odd.target);
    expect(gate.status).toBe("skipped");
    expect(gate.reason).toContain("rejected its options");
  });
});

describe("typecheckGate", () => {
  it("passes with the export's own tsconfig (strict) and fails on a type error, naming file and line", async () => {
    const good = fixture({
      tools: true,
      files: {
        "tsconfig.json": STRICT_TSCONFIG,
        "tests/a.ts": "export const a: number = 1;\n",
      },
    });
    expect(await typecheckGate(good.target)).toMatchObject({
      id: "typecheck",
      status: "passed",
    });
    const bad = fixture({
      tools: true,
      files: {
        "tsconfig.json": STRICT_TSCONFIG,
        "tests/a.ts": "export const ok = 1;\nexport const a: number = 'no';\n",
      },
    });
    const gate = await typecheckGate(bad.target);
    expect(gate.status).toBe("failed");
    expect(gate.findings?.[0]).toMatch(/^tests\/a\.ts:2: TS2322 /);
  }, 60_000);

  it("holds a generated project to noUnusedLocals even when its tsconfig does not", async () => {
    const files = {
      "tsconfig.json": STRICT_TSCONFIG,
      "tests/a.ts": "const unused = 1;\nexport {};\n",
    };
    const project = fixture({ tools: true, files, mode: "project" });
    const gate = await typecheckGate(project.target);
    expect(gate.status).toBe("failed");
    expect(gate.findings?.[0]).toContain("TS6133");
    // a host tsconfig is the host's bar: used as is
    const host = fixture({ tools: true, files, mode: "into" });
    expect((await typecheckGate(host.target)).status).toBe("passed");
  }, 60_000);

  it("falls back to strict + noUnusedLocals without a tsconfig", async () => {
    const good = fixture({
      tools: true,
      files: { "a.ts": "export const a: number = 1;\n" },
    });
    const pass = await typecheckGate(good.target);
    expect(pass.status).toBe("passed");
    expect(pass.summary).toContain("no tsconfig found");
    const bad = fixture({
      tools: true,
      files: { "a.ts": "const unused = 1;\nexport {};\n" },
    });
    expect((await typecheckGate(bad.target)).status).toBe("failed");
  }, 60_000);

  it("compiles export files a host tsconfig does not include, and ignores host errors", async () => {
    const { target } = fixture({
      tools: true,
      at: "e2e/export",
      mode: "into",
      files: {
        "tests/a.ts": "export const a: number = 'outside the host include';\n",
      },
      host: {
        "tsconfig.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          include: ["host/**/*.ts"],
        }),
        "host/broken.ts": "export const h: number = 'host problem';\n",
      },
    });
    const gate = await typecheckGate(target);
    expect(gate.status).toBe("failed");
    expect(gate.findings).toHaveLength(1);
    expect(gate.findings?.[0]).toMatch(/^tests\/a\.ts:1: TS2322 /);
    expect(gate.summary).toContain(
      "strict fallback for 1 file(s) outside its include",
    );
  }, 60_000);

  it("is skipped, never passed, when this tsc rejects the tsconfig (it then checks nothing)", async () => {
    const { target } = fixture({
      tools: true,
      at: "e2e/export",
      mode: "into",
      files: { "a.ts": "export const a: number = 'a real type error';\n" },
      host: {
        "e2e/tsconfig.json": JSON.stringify({
          compilerOptions: {
            // Not a valid pair for the repo's tsc: an option error, and tsc
            // then skips the semantic check.
            module: "commonjs",
            moduleResolution: "bundler",
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          include: ["**/*.ts"],
        }),
      },
    });
    const gate = await typecheckGate(target);
    expect(gate.status).toBe("skipped");
    expect(gate.reason).toContain("this tsc rejects the tsconfig");
    expect(gate.reason).toContain("TS5095");
  }, 60_000);

  it("takes the tsconfig the host profile names (Playwright's `tsconfig` option)", async () => {
    const { target } = fixture({
      tools: true,
      at: "e2e/export",
      mode: "into",
      source: { hostConfig: "../playwright.config.ts" },
      files: { "a.ts": "export const a: number = 'type error';\n" },
      host: {
        "e2e/playwright.config.ts": `export default { tsconfig: "./tsconfig.e2e.json" };\n`,
        // The nearest tsconfig.json would accept the file; the named one does not.
        "e2e/tsconfig.json": JSON.stringify({
          compilerOptions: { noEmit: true, types: [] },
          include: ["**/*.ts"],
        }),
        "e2e/tsconfig.e2e.json": JSON.stringify({
          compilerOptions: {
            strict: true,
            noEmit: true,
            skipLibCheck: true,
            types: [],
          },
          include: ["**/*.ts"],
        }),
      },
    });
    const gate = await typecheckGate(target);
    expect(gate.status).toBe("failed");
    expect(gate.summary).toContain("tsconfig.e2e.json");
    expect(gate.findings?.[0]).toMatch(/^a\.ts:1: TS2322 /);
  }, 60_000);

  it("is skipped, never passed, for a JavaScript export or without a local tsc", async () => {
    const js = fixture({
      files: { "a.js": "export const a = 1;\n" },
      lang: "js",
    });
    expect(await typecheckGate(js.target)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("JavaScript"),
    });
    const none = fixture({ files: { "a.ts": "export const a = 1;\n" } });
    expect(await typecheckGate(none.target)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("never installs"),
    });
  });
});

function fakeEslint(root: string, script: string): void {
  mkdirSync(join(root, "node_modules", ".bin"), { recursive: true });
  const bin = join(root, "node_modules", ".bin", "eslint");
  writeFileSync(bin, `#!/bin/sh\n${script}\n`);
  chmodSync(bin, 0o755);
}
/** An eslint JSON entry for a file it ignored instead of linting. */
function ignoredMessage(file: string, text: string): string {
  return `{"filePath":"${file}","errorCount":0,"warningCount":1,"messages":[{"ruleId":null,"severity":1,"message":"${text}"}]}`;
}

describe("lintGate", () => {
  const files = { "tests/a.ts": "export const a = 1;\n" };

  it("is skipped without an eslint config, and without a local binary", async () => {
    const none = fixture({ files });
    expect(await lintGate(none.target)).toMatchObject({
      status: "skipped",
      reason: "no eslint config in or above the export directory",
    });
    const noBin = fixture({
      files: { ...files, "eslint.config.js": "export default [];\n" },
    });
    expect(await lintGate(noBin.target)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("no local eslint binary"),
    });
  });

  it("passes and fails on the host's eslint JSON (errors fail, warnings do not)", async () => {
    const pass = fixture({
      files: { ...files, "eslint.config.js": "export default [];\n" },
    });
    fakeEslint(
      pass.root,
      `echo '[{"filePath":"${join(pass.target.dir, "tests/a.ts")}","errorCount":0,"warningCount":1,"messages":[{"ruleId":"x","severity":1,"message":"w","line":1}]},{"filePath":"${join(pass.target.dir, "eslint.config.js")}","errorCount":0,"warningCount":0,"messages":[]}]'`,
    );
    const ok = await lintGate(pass.target);
    expect(ok.status).toBe("passed");
    expect(ok.summary).toContain("1 warning(s)");

    const fail = fixture({ files: { ...files, ".eslintrc.json": "{}" } });
    fakeEslint(
      fail.root,
      `echo '[{"filePath":"${join(fail.target.dir, "tests/a.ts")}","errorCount":1,"warningCount":0,"messages":[{"ruleId":"no-undef","severity":2,"message":"x is not defined","line":3}]}]'\nexit 1`,
    );
    const bad = await lintGate(fail.target);
    expect(bad.status).toBe("failed");
    expect(bad.findings).toEqual(["tests/a.ts:3: no-undef x is not defined"]);
  });

  it("does not pass files the eslint config ignores (they were never linted)", async () => {
    const two = {
      "tests/a.ts": "export const a = 1;\n",
      "tests/b.ts": "export const b = 1;\n",
    };
    const all = fixture({ files: { ...two, ".eslintrc.json": "{}" } });
    fakeEslint(
      all.root,
      `echo '[${ignoredMessage(join(all.target.dir, "tests/a.ts"), "File ignored because of a matching ignore pattern. Use --no-ignore to override.")},${ignoredMessage(join(all.target.dir, "tests/b.ts"), "File ignored because no matching configuration was supplied.")}]'`,
    );
    const none = await lintGate(all.target);
    expect(none.status).toBe("skipped");
    expect(none.reason).toContain("ignores every export file(s)");
    expect(none.findings).toEqual([
      "tests/a.ts: not linted (ignored by the eslint config)",
      "tests/b.ts: not linted (ignored by the eslint config)",
    ]);

    const some = fixture({ files: { ...two, ".eslintrc.json": "{}" } });
    fakeEslint(
      some.root,
      `echo '[{"filePath":"${join(some.target.dir, "tests/a.ts")}","errorCount":0,"warningCount":0,"messages":[]},${ignoredMessage(join(some.target.dir, "tests/b.ts"), "File ignored because of a matching ignore pattern.")}]'`,
    );
    const partial = await lintGate(some.target);
    expect(partial.status).toBe("skipped");
    expect(partial.reason).toContain("ignores 1 of 2 export file(s)");
  });

  it("is skipped when eslint prints no JSON report (a crash is not a pass)", async () => {
    const crash = fixture({
      files: { ...files, "eslint.config.js": "export default [];\n" },
    });
    fakeEslint(crash.root, `echo 'Oops! Something went wrong' >&2\nexit 2`);
    const gate = await lintGate(crash.target);
    expect(gate.status).toBe("skipped");
    expect(gate.reason).toContain("no JSON report");
  });

  it("never hands eslint the vendored runtime (a host config without .js coverage no longer skips the gate forever)", async () => {
    const host = fixture({
      files: {
        "eslint.config.mjs": "export default [];\n",
        "tests/a.spec.ts": "export const a = 1;\n",
        "actions/login.ts": "export const b = 1;\n",
        "lib/pages/LoginPage.ts": "export const c = 1;\n",
        "lib/runtime/matchers.ts": "export const d = 1;\n",
        "lib/runtime/workbook.js": "export const e = 1;\n",
        "lib/runtime/workbook.d.ts": "export declare const e: number;\n",
        "preconditions.ts": "export const f = 1;\n",
      },
    });
    // Like a host config that only covers TypeScript: a .js file is ignored.
    // The fake records the files it was given.
    fakeEslint(
      host.root,
      `log="${join(host.root, "eslint-args.txt")}"; out="["; sep=""
for f in "$@"; do
  case "$f" in --format|json) continue;; esac
  echo "$f" >> "$log"
  case "$f" in
    *.js) entry='{"filePath":"'"$PWD/$f"'","errorCount":0,"warningCount":1,"messages":[{"ruleId":null,"severity":1,"message":"File ignored because no matching configuration was supplied."}]}';;
    *) entry='{"filePath":"'"$PWD/$f"'","errorCount":0,"warningCount":0,"messages":[]}';;
  esac
  out="$out$sep$entry"; sep=","
done
echo "$out]"`,
    );
    const gate = await lintGate(host.target);
    expect(gate.status).toBe("passed");
    expect(gate.summary).toContain(
      "4 vendored runtime file(s) not linted (copies of the runner's modules)",
    );
    expect(
      readFileSync(join(host.root, "eslint-args.txt"), "utf8")
        .trim()
        .split("\n")
        .toSorted(),
    ).toEqual([
      "actions/login.ts",
      "eslint.config.mjs",
      "lib/pages/LoginPage.ts",
      "tests/a.spec.ts",
    ]);
  });
});

const one = (title: string, fixme = false) =>
  `import { test } from "@playwright/test";\n${
    fixme ? "test.fixme" : "test"
  }("${title}", async () => {});\n`;

describe("listGate", () => {
  const CONFIG = `import { defineConfig } from "@playwright/test";\nexport default defineConfig({ testDir: "./tests" });\n`;
  it("passes when every exported spec is listed as exactly one test, reporting deliberate fixme skips", async () => {
    const { target } = fixture({
      tools: true,
      files: {
        "playwright.config.ts": CONFIG,
        "tests/a.spec.ts": one("a"),
        "tests/b.spec.ts": one("b", true),
      },
      specs: ["tests/a.spec.ts", "tests/b.spec.ts"],
    });
    const gate = await listGate(target);
    expect(gate).toMatchObject({ id: "list", status: "passed" });
    expect(gate.summary).toContain("2 of 2 exported specs");
    expect(gate.summary).toContain("1 deliberate test.fixme");
  }, 60_000);

  it("lists with the host config the manifest names, whatever it is called", async () => {
    const { target } = fixture({
      tools: true,
      at: "e2e/specs",
      mode: "into",
      source: { hostConfig: "../e2e.playwright.config.ts" },
      files: { "a.spec.ts": one("a") },
      specs: ["a.spec.ts"],
      host: {
        // Not a name Playwright (or a name search) finds on its own.
        "e2e/e2e.playwright.config.ts": CONFIG.replace(
          '"./tests"',
          '"./specs"',
        ),
      },
    });
    const gate = await listGate(target);
    expect(gate).toMatchObject({ id: "list", status: "passed" });
  }, 60_000);

  it("fails on a spec Playwright does not list and on an extra test in a file", async () => {
    const { target } = fixture({
      tools: true,
      files: {
        "playwright.config.ts": CONFIG,
        "tests/a.spec.ts": one("a") + `test("again", async () => {});\n`,
        "tests/b.spec.ts": one("b"),
      },
      specs: ["tests/a.spec.ts", "tests/b.spec.ts", "tests/gone.spec.ts"],
    });
    const gate = await listGate(target);
    expect(gate.status).toBe("failed");
    expect(gate.findings).toEqual([
      "tests/a.spec.ts: 2 tests listed, expected 1",
      "tests/gone.spec.ts: not listed by playwright test --list",
    ]);
    expect(gate.summary).toContain("1 of 3 exported specs listed correctly");
  }, 60_000);

  it("fails with the load error (relative to the export) when a test file does not compile", async () => {
    const { target } = fixture({
      tools: true,
      files: {
        "playwright.config.ts": CONFIG,
        "tests/broken.spec.ts": "this is not typescript(\n",
      },
      specs: ["tests/broken.spec.ts"],
    });
    const gate = await listGate(target);
    expect(gate.status).toBe("failed");
    expect(gate.findings?.[0]).toMatch(
      /^load error: SyntaxError: tests\/broken\.spec\.ts: /,
    );
    expect(gate.findings).toContain(
      "tests/broken.spec.ts: not listed by playwright test --list",
    );
  }, 60_000);

  it("is skipped for a standalone export, without a config, and without a local binary", async () => {
    const files = fixture({
      mode: "files",
      files: { "a.spec.ts": one("a") },
      specs: ["a.spec.ts"],
    });
    expect(await listGate(files.target)).toMatchObject({
      status: "skipped",
      reason: expect.stringContaining("standalone"),
    });
    const noConfig = fixture({
      files: { "tests/a.spec.ts": one("a") },
      specs: ["tests/a.spec.ts"],
    });
    expect((await listGate(noConfig.target)).reason).toContain(
      "no playwright.config",
    );
    const noBin = fixture({
      files: { "playwright.config.ts": CONFIG, "tests/a.spec.ts": one("a") },
      specs: ["tests/a.spec.ts"],
    });
    expect((await listGate(noBin.target)).reason).toContain("never installs");
  });
});

describe("listGate on a multi-project host", () => {
  // `npm init playwright`'s default: one project per browser.
  const BROWSERS = `import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  projects: [
    { name: "firefox", use: { ...devices["Desktop Firefox"] } },
    { name: "chromium", use: { ...devices["Desktop Chrome"] } },
    { name: "webkit", use: { ...devices["Desktop Safari"] } },
  ],
});
`;
  // Devices + a setup project the browser projects depend on.
  const SETUP = `import { defineConfig, devices } from "@playwright/test";
export default defineConfig({
  testDir: "./tests",
  projects: [
    { name: "setup", testMatch: /.*\\.setup\\.ts/ },
    { name: "desktop", use: { ...devices["Desktop Chrome"], storageState: "state.json" }, dependencies: ["setup"] },
    { name: "mobile", use: devices["iPhone 12"], dependencies: ["setup"] },
  ],
});
`;
  function host(config: string) {
    return fixture({
      tools: true,
      at: "tests/cairn",
      mode: "into",
      source: { hostConfig: "../../playwright.config.ts" },
      files: { "a.spec.ts": one("a"), "b.spec.ts": one("b", true) },
      specs: ["a.spec.ts", "b.spec.ts"],
      host: {
        "playwright.config.ts": config,
        "tests/auth.setup.ts": one("authenticate"),
      },
    });
  }

  it("lists one test per spec in the Chromium project the default browser trio runs (not one per browser)", async () => {
    const { target } = host(BROWSERS);
    const ctx = await listContext(target);
    expect(ctx.project).toMatchObject({
      name: "chromium",
      source: "auto",
      projects: ["firefox", "chromium", "webkit"],
      discovering: ["firefox", "chromium", "webkit"],
    });
    expect(ctx.project?.reason).toContain("because it runs Chromium");
    const gate = await listGate(target, ctx);
    expect(gate).toMatchObject({ id: "list", status: "passed" });
    expect(gate.summary).toBe(
      "2 of 2 exported specs listed as one test each in project chromium (--project) (1 deliberate test.fixme skip(s), not run)",
    );
  }, 60_000);

  it("keeps a setup dependency out of the count and honors a requested project", async () => {
    const { target } = host(SETUP);
    const auto = await listContext(target);
    expect(auto.project).toMatchObject({
      name: "desktop",
      discovering: ["desktop", "mobile"],
    });
    expect((await listGate(target, auto)).status).toBe("passed");

    const mobile = await listContext(target, {
      name: "mobile",
      source: "flag",
    });
    expect(mobile.project).toMatchObject({ name: "mobile", source: "flag" });
    const gate = await listGate(target, mobile);
    expect(gate.status).toBe("passed");
    expect(gate.summary).toContain("in project mobile (--project)");

    // The setup project discovers no exported test: listing under it fails.
    const setup = await listGate(
      target,
      await listContext(target, { name: "setup", source: "manifest" }),
    );
    expect(setup.status).toBe("failed");
    expect(setup.findings).toContain(
      "a.spec.ts: not listed by playwright test --list --project setup",
    );

    const unknown = await listContext(target, {
      name: "nope",
      source: "flag",
    });
    expect(unknown.error).toBe(
      '--verify-project "nope": the Playwright config has no such project (setup, desktop, mobile)',
    );
  }, 90_000);
});

/** A `--list` JSON: config projects and which project lists each file. */
const listing = (projects: string[], files: Record<string, string[]>) => ({
  config: {
    rootDir: "/h/tests",
    projects: projects.map((name) => ({ name })),
  },
  suites: Object.entries(files).map(([file, names]) => ({
    file,
    specs: [
      {
        title: file,
        file,
        tests: names.map((projectName) => ({ projectName })),
      },
    ],
  })),
});

describe("chooseVerifyProject", () => {
  const exported = ["/h/tests/a.spec.ts", "/h/tests/b.spec.ts"];

  it("needs no filter for one project", () => {
    expect(
      chooseVerifyProject(
        listing(["only"], { "a.spec.ts": ["only"] }),
        exported,
        new Map(),
      ),
    ).toEqual({});
  });

  it("prefers the projects discovering the most exported tests, then Chromium by browser, then by name, then config order", () => {
    const files = {
      "a.spec.ts": ["web", "full", "chrome-ish", "other"],
      "b.spec.ts": ["full", "chrome-ish", "other"],
      "auth.setup.ts": ["setup"],
    };
    const projects = ["setup", "web", "other", "chrome-ish", "full"];
    const pick = (browsers: Record<string, string>) =>
      chooseVerifyProject(
        listing(projects, files),
        exported,
        new Map(Object.entries(browsers)),
      ).project?.name;
    // web discovers one file only; full runs Chromium
    expect(pick({ web: "chromium", full: "chromium", other: "firefox" })).toBe(
      "full",
    );
    // no static browser: the name decides
    expect(pick({})).toBe("chrome-ish");
    // nothing says Chromium: config order among the best
    expect(
      chooseVerifyProject(
        listing(["x", "y"], { "a.spec.ts": ["y", "x"] }),
        exported,
        new Map([
          ["x", "webkit"],
          ["y", "firefox"],
        ]),
      ).project,
    ).toMatchObject({ name: "x", discovering: ["x", "y"] });
  });
});

describe("listedTestsFromJson", () => {
  it("flattens nested suites and flags fixme / skipped tests", () => {
    const tests = listedTestsFromJson({
      config: { rootDir: "/proj/tests" },
      suites: [
        {
          file: "a.spec.ts",
          specs: [
            {
              title: "t1",
              file: "a.spec.ts",
              tests: [{ expectedStatus: "passed", annotations: [] }],
            },
          ],
          suites: [
            {
              specs: [
                {
                  title: "t2",
                  file: "sub/b.spec.ts",
                  tests: [
                    {
                      expectedStatus: "skipped",
                      annotations: [{ type: "fixme" }],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(tests).toEqual([
      { file: "/proj/tests/a.spec.ts", title: "t1", fixme: false, skip: false },
      {
        file: "/proj/tests/sub/b.spec.ts",
        title: "t2",
        fixme: true,
        skip: true,
      },
    ]);
  });
});
