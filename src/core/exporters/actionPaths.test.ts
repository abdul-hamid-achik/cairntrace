import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseSpec } from "../parser/parseSpec";
import { exportPlaywright } from "./playwrightExporter";

/**
 * F13 in the single-file exporter: an imported action's relative
 * `eval.file` / `upload.path` resolve against the action's directory, like
 * the runner — the deprecated spec-relative fallback included.
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-export-action-paths-"));
  await mkdir(join(dir, "flows", "sub"), { recursive: true });
  await mkdir(join(dir, "flows", "actions"), { recursive: true });
  await writeFile(
    join(dir, "flows", "actions", "helper.yml"),
    `version: 1
name: helper
steps:
  - eval: { file: ./helper.js }
  - upload: { by: selector, selector: "#file", path: ./fixture.csv }
`,
  );
  await writeFile(
    join(dir, "flows", "sub", "spec.yml"),
    `version: 1
name: uses_helper
intent: Uses an action whose files sit next to it.
coldStart: guest
imports: [../actions/helper.yml]
steps:
  - open: https://demo.example.test/upload
  - use: helper
outcomes:
  - id: page
    description: upload page is open
    verify: { url: { matches: "/upload" } }
`,
  );
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function exportSpec() {
  const parsed = await parseSpec(join(dir, "flows", "sub", "spec.yml"));
  return exportPlaywright(parsed.resolved, {
    sourcePath: parsed.path,
    stepOrigins: parsed,
  });
}

describe("export: action-relative step files", () => {
  it("reads eval.file and upload.path next to the action", async () => {
    await writeFile(
      join(dir, "flows", "actions", "helper.js"),
      "window.__fromActionDir = true;",
    );
    await writeFile(join(dir, "flows", "actions", "fixture.csv"), "a,b\n");
    const { source, coverage } = await exportSpec();
    expect(source).toContain("__fromActionDir");
    expect(source).toContain(
      JSON.stringify(join(dir, "flows", "actions", "fixture.csv")),
    );
    expect(coverage.skips).toEqual([]);
  });

  it("keeps the deprecated spec-relative fallback for action steps", async () => {
    await writeFile(
      join(dir, "flows", "sub", "helper.js"),
      "window.__fromSpecDir = true;",
    );
    await writeFile(join(dir, "flows", "sub", "fixture.csv"), "a,b\n");
    const { source, coverage } = await exportSpec();
    expect(source).toContain("__fromSpecDir");
    expect(source).toContain(
      JSON.stringify(join(dir, "flows", "sub", "fixture.csv")),
    );
    expect(coverage.skips).toEqual([]);
  });
});
