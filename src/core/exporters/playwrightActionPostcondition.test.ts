import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import type {
  BrowserBackend,
  InvocationResult,
} from "../../adapters/browserBackend";
import { parseSpec } from "../parser/parseSpec";
import type { NetworkPostcondition, Step } from "../schema/spec.v1";
import { runResilientBrowserStep } from "../runner/interactionResilience";
import { exportPlaywright } from "./playwrightExporter";
import { exportPlaywrightProject } from "./playwrightProject";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  for (const directory of temporaryDirectories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe("imported action network postconditions", () => {
  it("preserves upload completion through parse, runner, and both Playwright exports", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "cairn-action-postcondition-"),
    );
    temporaryDirectories.push(directory);
    const actionPath = join(directory, "upload_w9.yml");
    await writeFile(
      actionPath,
      `version: 1
name: upload_w9
steps:
  - id: upload_w9
    upload:
      by: selector
      selector: 'input[type="file"]'
      path: ./fixtures/w9.pdf
    postcondition:
      network:
        method: POST
        urlContains: /api/files/extract-content-by-package
        status: { in: [200, 201] }
        timeoutMs: 45000
`,
    );
    const specPath = join(directory, "uses_upload.yml");
    await writeFile(
      specPath,
      `version: 1
name: imported_upload_postcondition
intent: imported upload keeps its completion boundary
imports: [./upload_w9.yml]
outcomes:
  - id: upload_completed
    description: upload response completed
    verify:
      text: { contains: Uploaded }
steps:
  - use: upload_w9
`,
    );

    const parsed = await parseSpec(specPath);
    expect(parsed.resolved.steps).toHaveLength(1);
    const resolvedUpload = parsed.resolved.steps![0]!;
    expect(resolvedUpload).toMatchObject({
      upload: {
        by: "selector",
        selector: 'input[type="file"]',
        path: "./fixtures/w9.pdf",
      },
      postcondition: {
        network: {
          method: "POST",
          urlContains: "/api/files/extract-content-by-package",
          status: { in: [200, 201] },
          timeoutMs: 45_000,
        },
      },
    });

    const backend = new ImportedActionPostconditionBackend();
    await expect(
      runResilientBrowserStep(resolvedUpload, backend, 1),
    ).resolves.toMatchObject({ ok: true });
    expect(backend.observed).toEqual([
      "armed:/api/files/extract-content-by-package",
      "upload:./fixtures/w9.pdf",
    ]);

    const standalone = exportPlaywright(parsed.resolved, {
      sourcePath: parsed.path,
    }).source;
    expectArmBeforeUpload(standalone);

    const project = exportPlaywrightProject([parsed]);
    const action = project.files.find(
      (file) => file.relPath === "actions/upload_w9.ts",
    )?.source;
    expect(action).toBeDefined();
    expectArmBeforeUpload(action!);
    expect(
      project.files.find(
        (file) =>
          file.relPath === "tests/imported_upload_postcondition.spec.ts",
      )?.source,
    ).toContain(`await upload_w9(page);`);
  });
});

class ImportedActionPostconditionBackend
  extends MockBrowserBackend
  implements BrowserBackend
{
  readonly observed: string[] = [];

  async runStepWithNetworkPostcondition(
    step: Step,
    postcondition: NetworkPostcondition,
  ): Promise<InvocationResult> {
    this.observed.push(`armed:${postcondition.urlContains}`);
    expect(step).not.toHaveProperty("postcondition");
    if ("upload" in step) this.observed.push(`upload:${step.upload.path}`);
    return {
      ok: true,
      stdout: "matched",
      stderr: "",
      exitCode: 0,
      durationMs: 1,
      argv: ["upload"],
    };
  }
}

function expectArmBeforeUpload(source: string): void {
  const armIndex = source.indexOf("page.waitForResponse");
  const uploadIndex = source.indexOf("setInputFiles");
  expect(armIndex).toBeGreaterThan(-1);
  expect(uploadIndex).toBeGreaterThan(armIndex);
  expect(source.match(/setInputFiles/g)).toHaveLength(1);
}
