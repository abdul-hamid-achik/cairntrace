import { describe, expect, it } from "vitest";
import type { HostEmit } from "./hostProfile";
import { isVendoredExportFile, postprocessHostFile } from "./hostPostprocess";

const OUT = "/host/e2e/tests/cairn";

const HOST: HostEmit = {
  moduleSystem: "cjs",
  moduleReason: "test",
  importExt: "",
  tsExtensions: false,
  testTimeoutMs: 30_000,
  testIdAttribute: "data-testid",
  testsDir: "",
  testSuffix: ".spec",
  bypassCsp: true,
  bypassCspDynamic: false,
  lintDisableVendored: true,
  notes: [],
};

const run = (
  relPath: string,
  source: string,
  host: Partial<HostEmit> = {},
): string =>
  postprocessHostFile(relPath, source, {
    host: { ...HOST, ...host },
    outDir: OUT,
  });

describe("postprocessHostFile imports", () => {
  it("drops named imports nothing uses and whole imports left empty", () => {
    const source = [
      `// Generated`,
      ``,
      `import { expect, test } from "@playwright/test";`,
      `import { cairnPoll, cairnCapture } from "../lib/poll";`,
      `import { nothing } from "../lib/unused";`,
      ``,
      `test("a", async ({ page }) => {`,
      `  await cairnCapture(page);`,
      `  // cairnPoll is only named in this comment`,
      `});`,
      ``,
    ].join("\n");
    const out = run("a.spec.ts", source);
    expect(out).toContain(`import { test } from "@playwright/test";`);
    expect(out).toContain(`import { cairnCapture } from "../lib/poll";`);
    expect(out).not.toContain("cairnPoll,");
    expect(out).not.toContain("unused");
    expect(out).not.toContain("expect,");
  });

  it("orders packages before relative paths, alphabetically, and specifiers case-insensitively", () => {
    const source = [
      `import { zeta } from "../lib/zeta";`,
      `import { b, A, c } from "../lib/alpha";`,
      `import { test } from "@playwright/test";`,
      `import { join } from "node:path";`,
      ``,
      `test("a", () => { zeta(b, A, c, join); });`,
      ``,
    ].join("\n");
    const lines = run("a.spec.ts", source).split("\n");
    expect(lines.slice(0, 4)).toEqual([
      `import { test } from "@playwright/test";`,
      `import { join } from "node:path";`,
      `import { A, b, c } from "../lib/alpha";`,
      `import { zeta } from "../lib/zeta";`,
    ]);
  });

  it("sorts type specifiers by name, not by the type keyword", () => {
    const source = [
      `import { type Page, expect, test } from "@playwright/test";`,
      ``,
      `test("a", async ({ page }: { page: Page }) => { expect(page).toBeTruthy(); });`,
      ``,
    ].join("\n");
    expect(run("a.spec.ts", source)).toContain(
      `import { expect, type Page, test } from "@playwright/test";`,
    );
  });

  it("leaves a file alone when its import block is not plain single-line imports", () => {
    const source = [
      `import {`,
      `  b,`,
      `  a,`,
      `} from "x";`,
      `import { c } from "a";`,
      `export const v = [a, b, c];`,
      ``,
    ].join("\n");
    expect(run("a.spec.ts", source)).toBe(source);
  });
});

describe("postprocessHostFile specifiers", () => {
  it("imports generated modules through the tsconfig alias that covers the export", () => {
    const source = [
      `import { cairnPoll } from "../lib/poll";`,
      `import { x } from "../../../util/testutils";`,
      ``,
      `export const v = [cairnPoll, x];`,
      ``,
    ].join("\n");
    const out = run("tests/a.spec.ts", source, {
      alias: { prefix: "@e2e/", dir: "/host/e2e" },
    });
    // Inside the export root: through the alias. Outside it: untouched.
    expect(out).toContain(`from "@e2e/tests/cairn/lib/poll"`);
    expect(out).toContain(`from "../../../util/testutils"`);
  });

  it("adds .js to relative imports of generated modules when the host needs extensions", () => {
    const source = [
      `import { a } from "../lib/a";`,
      `import { b } from "./b.js";`,
      `export const v = [a, b, await import("./verifiers/v")];`,
      ``,
    ].join("\n");
    const out = run("tests/a.spec.ts", source, { importExt: ".js" });
    expect(out).toContain(`from "../lib/a.js"`);
    expect(out).toContain(`from "./b.js"`);
    expect(out).toContain(`import("./verifiers/v.js")`);
  });

  it("rewrites a .ts specifier unless the host allows ts extensions", () => {
    const source = `export const v = await import("./verifiers/v.ts");\n`;
    expect(run("a.spec.ts", source)).toContain(`import("./verifiers/v")`);
    expect(run("a.spec.ts", source, { importExt: ".js" })).toContain(
      `import("./verifiers/v.js")`,
    );
    expect(run("a.spec.ts", source, { tsExtensions: true })).toContain(
      `import("./verifiers/v.ts")`,
    );
  });
});

describe("postprocessHostFile lint banner", () => {
  it("marks vendored runtime files, not tests or actions, when the host lints", () => {
    const source = `export const v = 1;\n`;
    for (const vendored of [
      "lib/probe.ts",
      "lib/runtime/refs.ts",
      "preconditions.ts",
      "global-setup.ts",
    ]) {
      expect(isVendoredExportFile(vendored)).toBe(true);
      expect(run(vendored, source).startsWith("/* eslint-disable")).toBe(true);
    }
    for (const own of ["tests/a.spec.ts", "a.spec.ts", "actions/login.ts"]) {
      expect(isVendoredExportFile(own)).toBe(false);
      expect(run(own, source)).toBe(source);
    }
  });

  it("adds no banner when the host has no eslint config", () => {
    expect(
      run("lib/probe.ts", "export const v = 1;\n", {
        lintDisableVendored: false,
      }),
    ).toBe("export const v = 1;\n");
  });

  it("passes non-code files and declarations through", () => {
    for (const rel of ["README.md", "lib/runtime/workbook.d.ts", "x.json"]) {
      expect(run(rel, "text\n")).toBe("text\n");
    }
  });
});
