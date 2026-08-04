import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import type { ParseResult } from "../parser/parseSpec";
import type { Spec } from "../schema/spec.v1";
import { exportPlaywrightProject } from "./playwrightProject";
import { playwrightTestTimeoutBudget } from "./playwrightTimeout";

describe("exportPlaywrightProject timeout emission", () => {
  it("emits an installable strict TypeScript Playwright project", () => {
    const parsed: ParseResult = {
      spec: baseSpec({}),
      resolved: baseSpec({}),
      path: "/tmp/project/flows/example.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };

    const result = exportPlaywrightProject([parsed]);
    const packageJson = JSON.parse(
      result.files.find((file) => file.relPath === "package.json")!.source,
    ) as {
      type: string;
      scripts: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const tsconfig = JSON.parse(
      result.files.find((file) => file.relPath === "tsconfig.json")!.source,
    ) as { compilerOptions: Record<string, unknown> };
    const readme = result.files.find(
      (file) => file.relPath === "README.md",
    )?.source;

    expect(packageJson).toMatchObject({
      type: "module",
      scripts: { test: "playwright test", typecheck: "tsc --noEmit" },
    });
    expect(packageJson.devDependencies).toHaveProperty("@playwright/test");
    expect(packageJson.devDependencies).toHaveProperty("@types/node");
    expect(packageJson.devDependencies).toHaveProperty("typescript");
    expect(tsconfig.compilerOptions).toMatchObject({
      strict: true,
      noEmit: true,
      allowImportingTsExtensions: true,
      moduleResolution: "Bundler",
    });
    expect(readme).toContain("npm install");
    expect(readme).toContain("npm run typecheck");
    expect(readme).toContain("npm test");

    const javascript = exportPlaywrightProject([parsed], { lang: "js" });
    expect(
      javascript.files.some((file) => file.relPath === "tsconfig.json"),
    ).toBe(false);
    expect(
      javascript.files.find((file) => file.relPath === "playwright.config.js")
        ?.source,
    ).toContain(`import { defineConfig } from "@playwright/test";`);
    expect(
      javascript.files.find((file) => file.relPath === "global-setup.js")
        ?.source,
    ).not.toContain("Promise<void>");
  });

  it("copies the bounded relative dependency closure of node verifiers", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cairn-verifier-graph-"));
    try {
      const flowsDir = join(directory, "flows");
      const verifierDir = join(directory, "verifiers");
      await mkdir(flowsDir, { recursive: true });
      await mkdir(join(verifierDir, "support"), { recursive: true });
      await writeFile(
        join(verifierDir, "entry.ts"),
        `import { check } from "./support/check.ts";\nexport default async function verify() { return { ok: check() }; }\n`,
      );
      await writeFile(
        join(verifierDir, "support", "check.ts"),
        `export function check(): boolean { return true; }\n`,
      );
      const spec = baseSpec({
        outcomes: [
          {
            id: "node_verifier",
            description: "node verifier passes",
            verify: {
              script: { runtime: "node", file: "../verifiers/entry.ts" },
            },
          },
        ],
      });
      const parsed: ParseResult = {
        spec,
        resolved: spec,
        path: join(flowsDir, "example.yml"),
        contractHashValid: true,
        origins: [],
        actionsByName: new Map(),
      };

      const result = exportPlaywrightProject([parsed]);
      expect(result.verifierFiles).toEqual([
        {
          sourcePath: join(verifierDir, "entry.ts"),
          relPath: "verifiers/entry.ts",
        },
        {
          sourcePath: join(verifierDir, "support", "check.ts"),
          relPath: "verifiers/support/check.ts",
        },
      ]);
      const testSource = result.files.find(
        (file) => file.relPath === "tests/timeout_project.spec.ts",
      )?.source;
      expect(testSource).toContain(`import("../verifiers/entry.ts")`);
      expect(testSource).toContain(
        `const verifierNamespace = importedVerifier as unknown as`,
      );
      expect(testSource).toContain(`if (typeof verify !== "function")`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects verifier dependencies that escape the entry directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "cairn-verifier-escape-"));
    try {
      const flowsDir = join(directory, "flows");
      const verifierDir = join(directory, "verifiers");
      await mkdir(flowsDir, { recursive: true });
      await mkdir(verifierDir, { recursive: true });
      await writeFile(
        join(verifierDir, "entry.ts"),
        `export { unsafe } from "../outside.ts";\n`,
      );
      await writeFile(
        join(directory, "outside.ts"),
        `export const unsafe = 1;\n`,
      );
      const spec = baseSpec({
        outcomes: [
          {
            id: "node_verifier",
            description: "node verifier passes",
            verify: {
              script: { runtime: "node", file: "../verifiers/entry.ts" },
            },
          },
        ],
      });
      const parsed: ParseResult = {
        spec,
        resolved: spec,
        path: join(flowsDir, "example.yml"),
        contractHashValid: true,
        origins: [],
        actionsByName: new Map(),
      };

      expect(() => exportPlaywrightProject([parsed])).toThrow(
        /dependency escapes its module directory/,
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("budgets imported action steps from the resolved spec", () => {
    const authored = baseSpec({ steps: [{ use: "slow_login" }] });
    const resolved = baseSpec({
      steps: [{ wait: { load: "networkidle", timeoutMs: 3_600_000 } }],
    });
    const parsed: ParseResult = {
      spec: authored,
      resolved,
      path: "/tmp/flows/timeout_project.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map([
        [
          "slow_login",
          {
            path: "/tmp/actions/slow_login.yml",
            action: {
              version: 1,
              name: "slow_login",
              steps: [{ wait: { load: "networkidle", timeoutMs: 3_600_000 } }],
            },
          },
        ],
      ]),
    };

    const expected = playwrightTestTimeoutBudget(resolved).timeoutMs;
    const result = exportPlaywrightProject([parsed]);
    const testFile = result.files.find(
      (file) => file.relPath === "tests/timeout_project.spec.ts",
    );
    const config = result.files.find(
      (file) => file.relPath === "playwright.config.ts",
    );
    const readme = result.files.find((file) => file.relPath === "README.md");

    expect(testFile?.source).toContain(`test.setTimeout(${expected});`);
    expect(config?.source).toContain(`timeout: ${expected},`);
    expect(readme?.source).toContain(`test timeout: 66.5m`);
    expect(result.specs[0]?.testTimeoutMs).toBe(expected);
  });

  it("preserves precondition cwd, timeout, and late-bound environment", () => {
    const authored = baseSpec({
      preconditions: {
        env: {
          SAFE_FLAG: true,
          API_TOKEN: "__CAIRN_SECRET_REF__API_TOKEN__",
        },
        commands: [
          {
            name: "seed",
            run: "bun run seed",
            cwd: "../tools",
            timeoutMs: 45_000,
          },
          { name: "verify", run: "bun run verify" },
        ],
      },
    });
    const parsed: ParseResult = {
      spec: authored,
      resolved: authored,
      path: "/tmp/project/flows/example.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };

    const result = exportPlaywrightProject([parsed]);
    const source = result.files.find(
      (file) => file.relPath === "tests/timeout_project.spec.ts",
    )?.source;
    const readme = result.files.find(
      (file) => file.relPath === "README.md",
    )?.source;
    const runtime = result.files.find(
      (file) => file.relPath === "preconditions.ts",
    )?.source;

    expect(source).toContain(
      'await runPrecondition("bun run seed", { cwd: "/tmp/project/tools", timeoutMs: 45000',
    );
    expect(source).toContain(
      'await runPrecondition("bun run verify", { cwd: "/tmp/project/flows", timeoutMs: 120000',
    );
    expect(source).toContain(
      'import { runPrecondition } from "../preconditions";',
    );
    expect(source).toContain('"SAFE_FLAG": String(true)');
    expect(source).toContain(
      '"API_TOKEN": String(`${process.env.API_TOKEN ?? ""}`)',
    );
    expect(result.requiredEnv).toContain("API_TOKEN");
    expect(readme).toContain("cwd: /tmp/project/tools; timeout: 45000ms");
    expect(readme).toContain("cwd: /tmp/project/flows; timeout: 120000ms");
    expect(runtime).toContain('new Set(["FILECHEAP_INGEST_TOKEN"])');
    expect(runtime).toContain('const TVAULT_CONTROL_PREFIX = "TVAULT_"');
    expect(runtime).toContain("killProcessTreeSync(child.pid)");
  });

  it("gives every node file verifier the same sanitized per-test runDir", () => {
    const authored = baseSpec({
      redaction: { values: ["never-persist-this"] },
      steps: [
        {
          request: {
            method: "PATCH",
            url: "/api/answers",
            body: { answer: "exact-value" },
            assign: "patch",
          },
        },
      ],
      outcomes: [
        {
          id: "first",
          description: "first verifier",
          verify: {
            script: { runtime: "node", file: "../verifiers/first.ts" },
          },
        },
        {
          id: "second",
          description: "second verifier",
          verify: {
            script: { runtime: "node", file: "../verifiers/second.ts" },
          },
        },
      ],
    });
    const parsed: ParseResult = {
      spec: authored,
      resolved: authored,
      path: "/tmp/project/flows/exact_patch.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };

    const result = exportPlaywrightProject([parsed]);
    const source = result.files.find(
      (file) => file.relPath === "tests/timeout_project.spec.ts",
    )?.source;

    expect(source).toContain(`async ({ page }, testInfo) => {`);
    expect(source).toContain(
      `const cairnRunDir = testInfo.outputPath("cairn-run");`,
    );
    expect(source).toContain(
      `cairnNetworkEvidence.recordApiRequest({ url: patch.url(), method: "PATCH", status: patch.status(), timestamp: patchCairnRequestTimestamp, body: { "answer": "exact-value" }, contentType: "application/json" });`,
    );
    expect(source?.match(/runDir: cairnRunDir,/g)).toHaveLength(2);
    expect(
      source?.match(/await cairnNetworkEvidence\.persist\(cairnRunDir\);/g),
    ).toHaveLength(2);
    expect(source).not.toContain("CAIRN_RUN_START_FLOOR_MS");
  });

  it("installs listener evidence for network outcomes without node verifiers", () => {
    const authored = baseSpec({
      outcomes: [
        {
          id: "request_completed",
          description: "the target request completed",
          verify: {
            network: {
              method: "GET",
              urlContains: "/api/questions/kit/deliverable/kit-1",
              status: { equals: 200 },
            },
          },
        },
        {
          id: "request_did_not_fail",
          description: "the target request had no failed response",
          verify: {
            noFailedRequests: {
              method: "GET",
              urlContains: "/api/questions/kit/deliverable/kit-1",
            },
          },
        },
      ],
    });
    const parsed: ParseResult = {
      spec: authored,
      resolved: authored,
      path: "/tmp/project/flows/network_only.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map(),
    };

    const source = exportPlaywrightProject([parsed]).files.find(
      (file) => file.relPath === "tests/timeout_project.spec.ts",
    )?.source;

    expect(source).toContain(`async ({ page }) => {`);
    expect(source).not.toContain("testInfo");
    expect(source).toContain(
      `const requests: Array<{ url: string; method: string; status?: number }> = [];`,
    );
    expect(source).toContain(`page.on("response"`);
    expect(source).toContain(`expect(requests.some(`);
    expect(source).toContain(`expect(requests.filter(`);
    expect(source?.indexOf("const requests")).toBeLessThan(
      source?.indexOf("expect(requests.some") ?? -1,
    );
  });

  it("shares run tokens and secret redaction values with imported actions", () => {
    const authored = baseSpec({
      steps: [{ use: "mutate" }],
      outcomes: [
        {
          id: "durable",
          description: "durable verifier",
          verify: {
            script: {
              runtime: "node",
              file: "../verifiers/check.ts",
              fixtures: { token: "__CAIRN_RUN_TOKEN__" },
            },
          },
        },
      ],
    });
    const parsed: ParseResult = {
      spec: authored,
      resolved: authored,
      path: "/tmp/project/flows/action_patch.yml",
      contractHashValid: true,
      origins: [],
      actionsByName: new Map([
        [
          "mutate",
          {
            path: "/tmp/project/actions/mutate.yml",
            action: {
              version: 1,
              name: "mutate",
              steps: [
                {
                  fill: {
                    by: "selector",
                    selector: "#answer",
                    value:
                      "__CAIRN_SECRET_REF__SHORT_SECRET__-__CAIRN_RUN_TOKEN__",
                  },
                },
              ],
            },
          },
        ],
      ]),
    };

    const result = exportPlaywrightProject([parsed]);
    const action = result.files.find(
      (file) => file.relPath === "actions/mutate.ts",
    )?.source;
    const source = result.files.find(
      (file) => file.relPath === "tests/timeout_project.spec.ts",
    )?.source;

    expect(action).toContain(
      `export async function mutate(page: Page, runToken: string): Promise<void>`,
    );
    expect(action).toContain(`const RUN_TOKEN = runToken;`);
    expect(source).toContain(`await mutate(page, RUN_TOKEN);`);
    expect(source).toContain(
      `values: [...[], process.env["SHORT_SECRET"] ?? ""]`,
    );
    expect(result.requiredEnv).toContain("SHORT_SECRET");
  });

  it.skipIf(process.platform === "win32")(
    "filters control credentials and kills the full precondition tree",
    async () => {
      const authored = baseSpec({
        preconditions: { commands: [{ run: "true", timeoutMs: 100 }] },
      });
      const parsed: ParseResult = {
        spec: authored,
        resolved: authored,
        path: "/tmp/project/flows/example.yml",
        contractHashValid: true,
        origins: [],
        actionsByName: new Map(),
      };
      const result = exportPlaywrightProject([parsed], { lang: "js" });
      const runtime = result.files.find(
        (file) => file.relPath === "preconditions.js",
      )?.source;
      expect(runtime).toBeDefined();

      const directory = await mkdtemp(
        join(tmpdir(), "cairn-export-preconditions-"),
      );
      try {
        const modulePath = join(directory, "preconditions.mjs");
        const pidPath = join(directory, "child.pid");
        await writeFile(modulePath, runtime!);
        const module = (await import(
          `${pathToFileURL(modulePath).href}?t=${Date.now()}`
        )) as {
          runPrecondition(
            command: string,
            options: { cwd: string; timeoutMs: number },
          ): Promise<void>;
          targetPreconditionEnv(
            overrides?: Record<string, string>,
          ): Record<string, string>;
        };

        expect(
          module.targetPreconditionEnv({
            SAFE_FLAG: "kept",
            FILECHEAP_INGEST_TOKEN: "publisher-only",
            CAIRN_TVAULT_ENV: "control",
            TVAULT_SELECTED: "explicit-target-value",
          }),
        ).toMatchObject({
          SAFE_FLAG: "kept",
          TVAULT_SELECTED: "explicit-target-value",
        });
        const filtered = module.targetPreconditionEnv({
          FILECHEAP_INGEST_TOKEN: "publisher-only",
          CAIRN_TVAULT_ENV: "control",
        });
        expect(filtered).not.toHaveProperty("FILECHEAP_INGEST_TOKEN");
        expect(filtered).not.toHaveProperty("CAIRN_TVAULT_ENV");
        const ambientTvaultKey = "TVAULT_UNSELECTED_EXPORT_TEST";
        const previousAmbientTvault = process.env[ambientTvaultKey];
        try {
          process.env[ambientTvaultKey] = "must-not-cross-boundary";
          expect(module.targetPreconditionEnv()).not.toHaveProperty(
            ambientTvaultKey,
          );
          expect(
            module.targetPreconditionEnv({
              [ambientTvaultKey]: "explicit-target-value",
            }),
          ).toHaveProperty(ambientTvaultKey, "explicit-target-value");
        } finally {
          if (previousAmbientTvault === undefined) {
            delete process.env[ambientTvaultKey];
          } else {
            process.env[ambientTvaultKey] = previousAmbientTvault;
          }
        }

        const command = `sleep 60 & echo $! > ${JSON.stringify(pidPath)}; wait`;
        await expect(
          module.runPrecondition(command, {
            cwd: directory,
            timeoutMs: 100,
          }),
        ).rejects.toThrow(/timed out.*killed/i);
        const childPid = Number((await readFile(pidPath, "utf8")).trim());
        expect(Number.isInteger(childPid)).toBe(true);
        await expectProcessDead(childPid);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

async function expectProcessDead(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`generated precondition child ${pid} remained alive`);
}

function baseSpec(overrides: Partial<Spec>): Spec {
  return {
    version: 1,
    name: "timeout_project",
    intent: "export a project with a sufficient timeout",
    mode: "normal",
    outcomes: [
      {
        id: "visible",
        description: "page is visible",
        verify: { text: { contains: "ready" }, region: "page" },
      },
    ],
    steps: [],
    ...overrides,
  } as Spec;
}
