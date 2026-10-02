import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { VerifierSchemaReportSchema } from "../../sdk/contract";
import {
  buildVerifierSchemaReport,
  renderVerifierSchemaMarkdown,
} from "./verifier";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");
let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-verifier-schema-"));
  await writeFile(
    join(dir, "static.ts"),
    `import { defineVerifier, z } from "@thelacanians/cairntrace/verifier";
export default defineVerifier({
  description: "Orders are shipped",
  fixtures: z.object({
    orderId: z.string().describe("the order"),
    owners: z.array(z.string()).default([]),
  }),
  run: (ctx) => ctx.result.ok(),
});
`,
  );
  await writeFile(
    join(dir, "shared.ts"),
    `import { z } from "@thelacanians/cairntrace/verifier";
export const Shared = z.object({ taskTitle: z.string(), pollMs: z.number().default(45000) });
`,
  );
  await writeFile(
    join(dir, "dynamic.ts"),
    `import { defineVerifier } from "@thelacanians/cairntrace/verifier";
import { Shared } from "./shared.ts";
export default defineVerifier({ fixtures: Shared, run: () => true });
`,
  );
  await writeFile(
    join(dir, "legacy.mjs"),
    `/**
 * Checks a task.
 *
 * Fixtures:
 *   taskTitle - REQUIRED title
 */
export default async function verify(ctx) {
  return { ok: Boolean(ctx.fixtures.taskTitle) };
}
`,
  );
  await writeFile(
    join(dir, "throws.ts"),
    `import { defineVerifier } from "@thelacanians/cairntrace/verifier";
throw new Error("import-time failure");
export default defineVerifier({ run: () => true });
`,
  );
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("cairn verifier schema", () => {
  it("reads an SDK contract statically", async () => {
    const { report, exitCode } = await buildVerifierSchemaReport("static.ts", {
      cwd: dir,
    });
    expect(exitCode).toBe(0);
    expect(VerifierSchemaReportSchema.parse(report)).toEqual({
      file: "static.ts",
      exists: true,
      sdk: true,
      mode: "static",
      description: "Orders are shipped",
      fixtures: {
        source: "sdk",
        strict: true,
        keys: [
          {
            name: "orderId",
            type: "string",
            required: true,
            description: "the order",
          },
          { name: "owners", type: "string[]", required: false, default: [] },
        ],
      },
    });
    const md = renderVerifierSchemaMarkdown(report);
    expect(md).toContain("- contract: SDK, static · unknown keys rejected");
    expect(md).toContain("| orderId | string | yes |  | the order |");
    expect(md).toContain("| owners | string[] | no | [] |  |");
  });

  it("reports an imported schema as dynamic, and --load reads it", async () => {
    const statics = await buildVerifierSchemaReport("dynamic.ts", { cwd: dir });
    expect(statics.report).toMatchObject({
      mode: "dynamic",
      fixtures: { source: "sdk", dynamic: true, keys: [] },
    });
    expect(statics.report.reason).toContain("--load");

    const loaded = await buildVerifierSchemaReport("dynamic.ts", {
      cwd: dir,
      load: true,
      timeoutMs: 20_000,
    });
    expect(loaded.exitCode).toBe(0);
    expect(VerifierSchemaReportSchema.parse(loaded.report)).toMatchObject({
      sdk: true,
      mode: "loaded",
      fixtures: {
        source: "sdk",
        strict: true,
        keys: [
          { name: "taskTitle", type: "string", required: true },
          { name: "pollMs", type: "number", required: false, default: 45000 },
        ],
      },
    });
  }, 30_000);

  it("falls back to the legacy reader for plain scripts", async () => {
    const { report } = await buildVerifierSchemaReport("legacy.mjs", {
      cwd: dir,
    });
    expect(report).toMatchObject({
      sdk: false,
      mode: "legacy",
      description: "Checks a task.",
      fixtures: { source: "header", keys: [{ name: "taskTitle" }] },
    });
  });

  it("exits 2 when the file is missing or --load fails", async () => {
    const missing = await buildVerifierSchemaReport("nope.ts", { cwd: dir });
    expect(missing.exitCode).toBe(2);
    expect(missing.report).toMatchObject({ exists: false, mode: "none" });
    const failing = await buildVerifierSchemaReport("throws.ts", {
      cwd: dir,
      load: true,
      timeoutMs: 20_000,
    });
    expect(failing.exitCode).toBe(2);
    expect(failing.report.error).toContain("import-time failure");
  }, 30_000);

  it("is registered on the CLI with --format json", () => {
    const r = spawnSync(
      "bun",
      [BIN, "verifier", "schema", "static.ts", "--json"],
      {
        cwd: dir,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1", CAIRN_LOG_LEVEL: "silent" },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(JSON.parse(r.stdout)).toMatchObject({ mode: "static", sdk: true });
  }, 30_000);
});
