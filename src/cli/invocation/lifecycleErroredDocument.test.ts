import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RunResultSchema } from "../../core/schema/run.v1";
import { BatchRunResultSchema } from "../../core/schema/runBatch.v1";
import { runToolResult } from "../../mcp/runTools";
import {
  executeRunInvocation,
  type RunDocument,
  type RunDocumentMeta,
} from "./executeRunInvocation";

/**
 * An invocation the services/webServer lifecycle stops before any spec
 * (a `cairn services up` lock refusal, a services or webServer boot
 * failure) still hands structured consumers a schema-valid errored
 * document — single or batch, like an unknown --env — and JUnit when asked.
 */

const CAIRN = join(process.cwd(), "bin", "cairn");
/** CLI tests spawn bin/cairn; vitest's 5s default is too tight under load. */
const E2E_TIMEOUT_MS = 30_000;

/** A value the boot failure prints; never allowed into a document. */
const SECRET = "demo-leak-4f1c9a2b7e";

const SPEC = (name: string, extra = "") => `version: 1
name: ${name}
intent: A mock run the lifecycle never lets start.
coldStart: guest
${extra}steps:
  - open: https://demo.example.test/home
outcomes:
  - id: home
    description: home is open
    verify: { url: { matches: "/home" } }
`;

let root: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "cairn-lifecycle-doc-"));
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

let counter = 0;

/** A project whose config carries `block`, with specs a and b. */
async function project(block: string): Promise<{
  dir: string;
  config: string;
  a: string;
  b: string;
}> {
  const dir = join(root, `p${++counter}`);
  await mkdir(dir, { recursive: true });
  const config = join(dir, "cairntrace.config.yml");
  await writeFile(
    config,
    `version: 1
artifactRoot: ${JSON.stringify(join(dir, "runs"))}
defaultEnvironment: local
environments:
  local: { baseUrl: https://demo.example.test }
  dev:
    baseUrl: https://demo.example.test
    policy: { trait: shared, mutations: deny }
${block}`,
  );
  const a = join(dir, "a.yml");
  const b = join(dir, "b.yml");
  await writeFile(
    a,
    SPEC("lifecycle_a", `redaction:\n  values: [${JSON.stringify(SECRET)}]\n`),
  );
  await writeFile(b, SPEC("lifecycle_b"));
  return { dir, config, a, b };
}

/** The config block of a webServer that exits during startup. */
const BROKEN_WEB_SERVER = `webServer:
  command: ${JSON.stringify(`echo "boot token ${SECRET}"; sleep 0.3; exit 3`)}
  waitForText: never-ready
  reuseExisting: false
`;

const BROKEN_SEED = `services:
  seed:
    command: "exit 5"
`;

const SEED_ONLY = `services:
  seed:
    command: "true"
`;

async function invoke(
  specs: string[],
  options: Record<string, unknown>,
  cwd: string,
): Promise<{
  result: Awaited<ReturnType<typeof executeRunInvocation>>;
  emitted: Array<{ document: RunDocument; meta: RunDocumentMeta }>;
}> {
  const emitted: Array<{ document: RunDocument; meta: RunDocumentMeta }> = [];
  const result = await executeRunInvocation(
    { specs, options: { mock: true, ...options }, cwd },
    {
      origin: "cli",
      onDocument: (document, meta) => {
        emitted.push({ document, meta });
      },
    },
  );
  return { result, emitted };
}

describe("lifecycle failures emit an errored document", () => {
  it("webServer boot failure: single errored RunResult (exit 2), redacted, JUnit written", async () => {
    const p = await project(BROKEN_WEB_SERVER);
    const junit = join(p.dir, "out", "junit.xml");
    const { result, emitted } = await invoke(
      [p.a],
      { config: p.config, junit },
      p.dir,
    );

    expect(result).toMatchObject({
      kind: "errored",
      fatal: true,
      exitCode: 2,
      runDirs: [],
    });
    expect(result.error).toContain("web server exited (code 3)");
    expect(emitted).toHaveLength(1);
    expect(emitted[0]!.meta).toMatchObject({
      kind: "preflight",
      errored: true,
    });
    const doc = RunResultSchema.parse(emitted[0]!.document);
    expect(result.document).toEqual(doc);
    expect(doc).toMatchObject({
      status: "errored",
      exitCode: 2,
      synthetic: true,
      environment: "local",
      backend: "mock",
      steps: [],
      failure: { phase: "invocation" },
    });
    expect(doc.summary).toMatch(/^errored before the spec ran: web server/);
    expect(doc.failure?.message).toContain("web server exited (code 3)");
    // The boot log tail reaches stderr as-is, never the document or JUnit.
    expect(result.error).toContain(SECRET);
    expect(doc.failure?.message).toContain("boot token");
    expect(JSON.stringify(doc)).not.toContain(SECRET);
    const xml = await readFile(junit, "utf8");
    expect(xml).toContain(
      '<testsuite name="a" tests="1" failures="0" errors="1"',
    );
    // The JUnit case names the reason, not just "run errored".
    expect(xml).toContain("web server exited (code 3)");
    expect(xml).not.toContain(SECRET);
  }, 30_000);

  it("an MCP invocation's error text is redacted like its document", async () => {
    const p = await project(BROKEN_WEB_SERVER);
    const result = await executeRunInvocation(
      { specs: [p.a], options: { mock: true, config: p.config }, cwd: p.dir },
      { origin: "mcp" },
    );

    expect(result).toMatchObject({ kind: "errored", exitCode: 2 });
    expect(result.error).toContain("web server exited (code 3)");
    expect(result.error).toContain("boot token");
    expect(result.error).not.toContain(SECRET);
    // cairn_run puts result.error ahead of the summary in its text content.
    const tool = runToolResult(result, { specs: [p.a], labels: [] });
    const text = tool.content
      .map((c) => ("text" in c ? c.text : ""))
      .join("\n");
    expect(text).toContain("web server exited (code 3)");
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(tool.structuredContent)).not.toContain(SECRET);
  }, 30_000);

  it("services boot failure: batch of errored results (exit 2), policy refusals kept", async () => {
    const p = await project(BROKEN_SEED);
    const localOnly = join(p.dir, "local-only.yml");
    await writeFile(
      localOnly,
      SPEC("lifecycle_local_only", "requires: { env: [local] }\n"),
    );
    const { result, emitted } = await invoke(
      [p.a, localOnly, p.b],
      { config: p.config, env: "dev" },
      p.dir,
    );

    expect(result).toMatchObject({ kind: "errored", exitCode: 2 });
    expect(emitted).toHaveLength(1);
    const batch = BatchRunResultSchema.parse(emitted[0]!.document);
    expect(batch.exitCode).toBe(2);
    expect(batch.summary).toEqual({
      total: 3,
      passed: 0,
      failed: 0,
      errored: 2,
      refused: 1,
    });
    expect(batch.results.map((r) => [r.spec.name, r.status])).toEqual([
      // Like the unknown --env document: errored results carry the file
      // stem (the spec is never parsed); refusals carry the spec name.
      ["a", "errored"],
      ["lifecycle_local_only", "refused"],
      ["b", "errored"],
    ]);
    const errored = batch.results.filter((r) => r.status === "errored");
    for (const entry of errored) {
      expect(entry).toMatchObject({ exitCode: 2, environment: "dev" });
      expect(entry.failure?.phase).toBe("invocation");
    }
  }, 30_000);

  it("services lock refusal: errored document with exit 4", async () => {
    const p = await project(SEED_ONLY);
    const { result, emitted } = await invoke(
      [p.a],
      { config: p.config, reuseServices: true },
      p.dir,
    );

    expect(result).toMatchObject({ kind: "errored", exitCode: 4 });
    expect(result.error).toContain("no `cairn services up` lock");
    const doc = RunResultSchema.parse(emitted[0]!.document);
    expect(doc).toMatchObject({ status: "errored", exitCode: 4 });
    expect(doc.failure?.message).toContain("no `cairn services up` lock");
  }, 30_000);

  it("a cancel while services boot emits no document", async () => {
    const p = await project(`services:
  seed:
    command: "sleep 5"
`);
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 300);
    const emitted: RunDocument[] = [];
    const result = await executeRunInvocation(
      { specs: [p.a], options: { mock: true, config: p.config }, cwd: p.dir },
      {
        origin: "cli",
        signal: controller.signal,
        onDocument: (document) => {
          emitted.push(document);
        },
      },
    );
    expect(result).toMatchObject({ kind: "errored", exitCode: 2 });
    expect(result.error).toContain("cancelled");
    expect(emitted).toEqual([]);
  }, 30_000);
});

function cairn(args: string[], cwd: string) {
  return execa(CAIRN, args, {
    cwd,
    reject: false,
    timeout: 25_000,
    env: { CAIRN_LOG_LEVEL: "warn", NO_COLOR: "1" },
  });
}

describe("cairn run --json on a lifecycle failure", () => {
  it(
    "prints the errored RunResult on stdout (webServer boot, exit 2)",
    async () => {
      const p = await project(BROKEN_WEB_SERVER);
      const run = await cairn(
        ["run", p.a, "--mock", "--config", p.config, "--json"],
        p.dir,
      );
      expect(run.exitCode, run.stderr).toBe(2);
      const doc = RunResultSchema.parse(JSON.parse(run.stdout));
      expect(doc).toMatchObject({ status: "errored", exitCode: 2 });
      expect(doc.failure?.message).toContain("web server exited (code 3)");
      expect(run.stdout).not.toContain(SECRET);
      expect(run.stderr).toContain("web server exited (code 3)");
    },
    E2E_TIMEOUT_MS,
  );

  it(
    "prints a batch on stdout for a services lock refusal (exit 4); md prints nothing",
    async () => {
      const p = await project(SEED_ONLY);
      const run = await cairn(
        [
          "run",
          p.a,
          p.b,
          "--mock",
          "--config",
          p.config,
          "--reuse-services",
          "--format",
          "json",
        ],
        p.dir,
      );
      expect(run.exitCode, run.stderr).toBe(4);
      const batch = BatchRunResultSchema.parse(JSON.parse(run.stdout));
      expect(batch.exitCode).toBe(4);
      expect(batch.summary).toEqual({
        total: 2,
        passed: 0,
        failed: 0,
        errored: 2,
      });
      expect(batch.results.map((r) => r.exitCode)).toEqual([4, 4]);

      const md = await cairn(
        ["run", p.a, "--mock", "--config", p.config, "--reuse-services"],
        p.dir,
      );
      expect(md.exitCode).toBe(4);
      expect(md.stdout).toBe("");
      expect(md.stderr).toContain("no `cairn services up` lock");
      expect(existsSync(join(p.dir, "runs", "_invocations"))).toBe(true);
    },
    E2E_TIMEOUT_MS,
  );
});
