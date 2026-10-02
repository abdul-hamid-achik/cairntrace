import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type { UploadStep } from "../schema/spec.v1";
import { runSpec } from "./Runner";

/**
 * F13: files a step of an imported action references resolve against the
 * ACTION file's directory. The old spec-relative location still works, with
 * a deprecation warning naming the action and step (listener once per
 * process, run.log every run).
 */

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-action-paths-"));
  await mkdir(join(dir, "flows"), { recursive: true });
  await mkdir(join(dir, "shared", "actions"), { recursive: true });
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function writeAction(steps: string): Promise<void> {
  await writeFile(
    join(dir, "shared", "actions", "attach.yml"),
    `version: 1
name: attach_report
steps:
${steps}`,
  );
}

async function writeFlow(name: string): Promise<string> {
  const specPath = join(dir, "flows", `${name}.yml`);
  await writeFile(
    specPath,
    `version: 1
name: ${name}
intent: Uses a shared action that references files next to it.
coldStart: guest
imports: [../shared/actions/attach.yml]
steps:
  - open: https://demo.example.test/upload
  - use: attach_report
outcomes:
  - id: page
    description: upload page is open
    verify: { url: { matches: "/upload" } }
`,
  );
  return specPath;
}

function uploads(backend: MockBrowserBackend): string[] {
  return backend.stepLog
    .filter((step): step is UploadStep => "upload" in step)
    .map((step) => step.upload.path);
}

describe("action-relative file resolution", () => {
  it("resolves upload, eval.file and ${file.dir} against the action's directory", async () => {
    await writeFile(join(dir, "shared", "actions", "report.csv"), "a,b\n");
    await writeFile(
      join(dir, "shared", "actions", "probe.js"),
      "return { ok: true };",
    );
    await writeAction(`  - upload: { by: selector, selector: "#file", path: report.csv }
  - upload: { by: selector, selector: "#file2", path: "\${file.dir}/report.csv" }
  - eval: { file: probe.js, assign: probe }
`);
    const backend = new MockBrowserBackend();
    const warnings: string[] = [];
    const result = await runSpec({
      specPath: await writeFlow("action_relative"),
      backend,
      artifactRoot: join(dir, "runs"),
      heartbeatIntervalMs: 0,
      listener: { onWarning: (message) => warnings.push(message) },
    });
    expect(result.status).toBe("passed");
    const csv = join(dir, "shared", "actions", "report.csv");
    expect(uploads(backend)).toEqual([csv, csv]);
    expect(warnings).toEqual([]);
    expect(await readFile(join(result.runDir, "run.log"), "utf8")).not.toMatch(
      /deprecated/,
    );
  });

  it("falls back to the old spec-relative path with a one-time deprecation warning", async () => {
    // Only next to the SPEC: the pre-F13 resolution.
    await writeFile(join(dir, "flows", "legacy.csv"), "a,b\n");
    await writeAction(
      `  - upload: { by: selector, selector: "#file", path: legacy.csv }\n`,
    );
    const warnings: string[] = [];
    const first = new MockBrowserBackend();
    const run1 = await runSpec({
      specPath: await writeFlow("legacy_one"),
      backend: first,
      artifactRoot: join(dir, "runs"),
      heartbeatIntervalMs: 0,
      listener: { onWarning: (message) => warnings.push(message) },
    });
    expect(run1.status).toBe("passed");
    expect(uploads(first)).toEqual([join(dir, "flows", "legacy.csv")]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('upload.path "legacy.csv"');
    expect(warnings[0]).toContain('action "attach_report"');
    expect(warnings[0]).toContain("step 1 of attach.yml");
    expect(await readFile(join(run1.runDir, "run.log"), "utf8")).toContain(
      "warning: deprecated: upload.path",
    );

    // Same action step again in this process: run.log still records it,
    // the listener is not told twice.
    const run2 = await runSpec({
      specPath: await writeFlow("legacy_two"),
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      heartbeatIntervalMs: 0,
      listener: { onWarning: (message) => warnings.push(message) },
    });
    expect(warnings).toHaveLength(1);
    expect(await readFile(join(run2.runDir, "run.log"), "utf8")).toContain(
      "deprecated: upload.path",
    );
  });

  it("fails a step whose action file is missing, naming the action-relative path", async () => {
    await writeAction(`  - eval: { file: missing.js }\n`);
    const result = await runSpec({
      specPath: await writeFlow("missing_eval"),
      backend: new MockBrowserBackend(),
      artifactRoot: join(dir, "runs"),
      heartbeatIntervalMs: 0,
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.message).toContain(
      join(dir, "shared", "actions", "missing.js"),
    );
  });
});
