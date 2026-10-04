import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { execa } from "execa";
import { afterEach, describe, expect, it } from "vitest";
import {
  EXPORT_MANIFEST_FILE,
  type ExportManifestV1,
} from "../../core/exporters/exportManifest";
import { exportPlaywright } from "../../core/exporters/playwrightExporter";
import { SpecSchema } from "../../core/schema/spec.v1";
import { checkPlaywrightExport, writeProjectExport } from "./export";
import { expandSpecArgs } from "./run";

/**
 * `--strict-locators` (and the `export.targets.<name>.strictLocators` field):
 * no `.first()` on a locator without `nth`, so Playwright's strict mode fails
 * an ambiguous locator the way `cairn run --backend playwright` does. The
 * default keeps `.first()`.
 */
const CAIRN = join(
  resolve(dirname(new URL(import.meta.url).pathname), "../../.."),
  "bin",
  "cairn",
);
const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function tempDir(): Promise<string> {
  const directory = await realpath(
    await mkdtemp(join(tmpdir(), "cairn-export-strict-")),
  );
  directories.push(directory);
  return directory;
}

const SPEC = `version: 1
name: strict_flow
intent: a flow with ambiguous-able locators
coldStart: guest
steps:
  - id: open
    open: http://localhost:8787/form.html
  - id: submit
    click: { by: role, role: button, name: Save }
  - id: second
    click: { by: role, role: button, name: Save, nth: 1 }
  - id: email
    fill: { by: label, name: Email, value: a@b.c }
  - id: raw
    click: { by: selector, selector: "#plain" }
outcomes:
  - id: saved
    description: the toast reads Saved
    verify:
      text: { contains: Saved }
`;

const ACTION = `version: 1
name: pick_plan
steps:
  - id: choose
    click: { by: text, text: Pro plan }
`;

describe("exportPlaywright strictLocators", () => {
  const spec = SpecSchema.parse({
    version: 1,
    name: "strict_single",
    intent: "i",
    coldStart: "guest",
    steps: [
      { id: "a", click: { by: "role", role: "button", name: "Save" } },
      { id: "b", click: { by: "role", role: "button", name: "Save", nth: 2 } },
      { id: "c", fill: { by: "label", name: "Email", value: "a@b.c" } },
      { id: "d", click: { by: "selector", selector: "#plain" } },
    ],
    outcomes: [
      {
        id: "o",
        description: "d",
        verify: { text: { contains: "Saved" } },
      },
    ],
  });

  it("keeps .first() by default", () => {
    const { source } = exportPlaywright(spec, {});
    expect(source).toContain(
      `await page.getByRole("button", { name: "Save" }).first().click();`,
    );
    expect(source).toContain(`.nth(2)`);
  });

  it("omits .first() under strictLocators and leaves nth and raw selectors alone", () => {
    const { source } = exportPlaywright(spec, { strictLocators: true });
    expect(source).not.toContain(".first()");
    expect(source).toContain(
      `await page.getByRole("button", { name: "Save" }).click();`,
    );
    expect(source).toContain(
      `await page.getByRole("button", { name: "Save" }).nth(2).click();`,
    );
    expect(source).toContain(`await page.getByLabel("Email").fill("a@b.c");`);
    expect(source).toContain(`await page.locator("#plain").click();`);
  });
});

async function allSources(outDir: string): Promise<string> {
  const files = [
    "tests/strict_flow.spec.ts",
    "tests/uses_action.spec.ts",
    "actions/pick_plan.ts",
  ];
  return (
    await Promise.all(files.map((f) => readFile(join(outDir, f), "utf8")))
  ).join("\n");
}

describe("strict locators through the project export and --check", () => {
  async function tree(): Promise<{ root: string; flows: string }> {
    const root = await tempDir();
    const flows = join(root, "flows");
    await mkdir(flows, { recursive: true });
    await mkdir(join(root, "actions"), { recursive: true });
    await writeFile(join(flows, "strict.yml"), SPEC);
    await writeFile(join(root, "actions", "pick_plan.yml"), ACTION);
    await writeFile(
      join(flows, "uses.yml"),
      `version: 1
name: uses_action
intent: calls an action
coldStart: guest
imports:
  - ../actions/pick_plan.yml
steps:
  - id: open
    open: http://localhost:8787/plans.html
  - use: pick_plan
outcomes:
  - id: ok
    description: ok
    verify:
      text: { contains: Pro }
`,
    );
    return { root, flows };
  }

  it("emits no .first() in tests or action modules, records the mode, and --check regenerates it", async () => {
    const { root, flows } = await tree();
    const strictDir = join(root, "strict-out");
    await writeProjectExport(
      await expandSpecArgs([flows]),
      "ts",
      { project: true, outDir: strictDir, strictLocators: true },
      flows,
    );
    const strictSources = await allSources(strictDir);
    expect(strictSources).not.toContain(".first()");
    expect(strictSources).toContain(
      `getByRole("button", { name: "Save" }).nth(1)`,
    );
    const manifest = JSON.parse(
      await readFile(join(strictDir, EXPORT_MANIFEST_FILE), "utf8"),
    ) as ExportManifestV1;
    expect(manifest.source.strictLocators).toBe(true);
    // No flags on the check: the manifest's locator mode applies.
    expect(
      (await checkPlaywrightExport(strictDir, undefined, {})).exitCode,
    ).toBe(0);
    // Asking for the other mode regenerates different files: stale.
    const flipped = await checkPlaywrightExport(strictDir, undefined, {
      strictLocators: false,
    });
    expect(flipped.exitCode).toBe(1);

    const defaultDir = join(root, "default-out");
    await writeProjectExport(
      await expandSpecArgs([flows]),
      "ts",
      { project: true, outDir: defaultDir },
      flows,
    );
    const defaultSources = await allSources(defaultDir);
    expect(defaultSources).toContain(`.first()`);
    const defaultManifest = JSON.parse(
      await readFile(join(defaultDir, EXPORT_MANIFEST_FILE), "utf8"),
    ) as ExportManifestV1;
    expect(defaultManifest.source.strictLocators).toBeUndefined();
  });

  it("is set by the CLI flag and by an export.targets profile; --no-strict-locators wins over the profile", async () => {
    const { root, flows } = await tree();
    await writeFile(
      join(root, "cairntrace.config.yml"),
      `version: 1
environments:
  local: { baseUrl: "http://localhost:8787" }
export:
  targets:
    strict: { input: flows, strictLocators: true }
`,
    );
    const run = async (args: string[]) =>
      execa(CAIRN, ["export", "playwright", ...args], {
        cwd: root,
        reject: false,
        timeout: 60_000,
        env: { CAIRN_LOG_LEVEL: "silent", NO_COLOR: "1" },
      });
    const viaFlag = await run([
      flows,
      "--project",
      "--out-dir",
      join(root, "flag-out"),
      "--strict-locators",
      "--json",
    ]);
    expect(viaFlag.exitCode, viaFlag.stderr).toBe(0);
    expect(await allSources(join(root, "flag-out"))).not.toContain(".first()");

    const viaProfile = await run([
      "--target",
      "strict",
      "--project",
      "--out-dir",
      join(root, "profile-out"),
      "--json",
    ]);
    expect(viaProfile.exitCode, viaProfile.stderr).toBe(0);
    expect(await allSources(join(root, "profile-out"))).not.toContain(
      ".first()",
    );

    const overridden = await run([
      "--target",
      "strict",
      "--no-strict-locators",
      "--project",
      "--out-dir",
      join(root, "override-out"),
      "--json",
    ]);
    expect(overridden.exitCode, overridden.stderr).toBe(0);
    expect(await allSources(join(root, "override-out"))).toContain(".first()");
  }, 120_000);
});
