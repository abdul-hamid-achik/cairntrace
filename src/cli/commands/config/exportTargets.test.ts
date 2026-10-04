import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigSchema } from "../../../core/schema/config.v1";
import { writeCjsHost, writeEsmHost } from "../../../testing/hostTrees";
import { validateConfigFile } from "./validate";

const roots: string[] = [];
function tmpRoot(): string {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), "cairn-export-targets-")),
  );
  roots.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of roots.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

function configWith(root: string, targets: string): string {
  const path = join(root, "cairntrace.config.yml");
  writeFileSync(
    path,
    `version: 1
environments:
  local:
    baseUrl: http://localhost:8080
export:
  targets:
${targets}`,
  );
  return path;
}

describe("export.targets schema", () => {
  const base = {
    version: 1,
    environments: { local: { baseUrl: "http://localhost:8080" } },
  };

  it("accepts every profile field", () => {
    const parsed = ConfigSchema.parse({
      ...base,
      export: {
        targets: {
          ui: {
            input: "flows",
            into: "../e2e/tests/cairn",
            hostConfig: "../e2e/playwright.config.ts",
            preconditions: "inline",
            verifiers: "gate",
            gateEnv: ["MONGO_URI"],
            lang: "ts",
            env: "local",
            mapFile: "export.map.json",
            maxEvalRatio: 0.25,
            allowEvalWithoutBypass: false,
          },
        },
      },
    });
    expect(parsed.export?.targets?.["ui"]?.maxEvalRatio).toBe(0.25);
  });

  it("rejects unknown fields, a bad ratio, a bad mode and a bad target name", () => {
    const bad = (target: Record<string, unknown>, name = "ui") =>
      ConfigSchema.safeParse({
        ...base,
        export: { targets: { [name]: target } },
      });
    expect(bad({ nope: 1 }).success).toBe(false);
    expect(bad({ maxEvalRatio: 1.5 }).success).toBe(false);
    expect(bad({ maxEvalRatio: -1 }).success).toBe(false);
    expect(bad({ preconditions: "later" }).success).toBe(false);
    expect(bad({ gateEnv: ["not a name"] }).success).toBe(false);
    expect(bad({}, "has space").success).toBe(false);
    expect(bad({ lang: "py" }).success).toBe(false);
  });
});

describe("config validate — export targets", () => {
  it("accepts a target whose host config reads statically and discovers the tree", async () => {
    const root = tmpRoot();
    const tree = writeCjsHost(join(root, "host"));
    mkdirSync(join(root, "flows"));
    const path = configWith(
      root,
      `    ui:
      input: flows
      into: host/e2e/tests/cairn
      hostConfig: host/e2e/playwright.config.ts
      maxEvalRatio: 0.3
`,
    );
    const { result, exitCode } = await validateConfigFile(path);
    expect(result.errors).toEqual([]);
    expect(exitCode).toBe(0);
    expect(result.exportTargets).toEqual([
      {
        name: "ui",
        input: "flows",
        into: "host/e2e/tests/cairn",
        hostConfig: "host/e2e/playwright.config.ts",
        maxEvalRatio: 0.3,
      },
    ]);
    expect(tree.config).toContain("playwright.config.ts");
  });

  it("reports a missing input and a missing host config, with the target's path", async () => {
    const root = tmpRoot();
    const path = configWith(
      root,
      `    ui:
      input: no-flows
      into: out
      hostConfig: nowhere/playwright.config.ts
`,
    );
    const { result, exitCode } = await validateConfigFile(path);
    expect(exitCode).toBe(4);
    expect(result.errors).toEqual([
      "export.targets.ui.input: no-flows does not exist (relative to the config directory)",
      "export.targets.ui.hostConfig: nowhere/playwright.config.ts does not exist (relative to the config directory)",
    ]);
  });

  it("checks a target's mapFile: it exists, parses, and its relative imports name files", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "host"), { recursive: true });
    writeFileSync(
      join(root, "host", "good.map.yml"),
      "version: 1\ntest: { import: ./fixtures }\n",
    );
    writeFileSync(
      join(root, "host", "fixtures.ts"),
      "export const test = 1;\n",
    );
    writeFileSync(
      join(root, "host", "bad.map.yml"),
      "version: 1\ntest: { import: ./missing }\nactions:\n  login: { fixture: { name: 3 } }\n",
    );
    const path = configWith(
      root,
      `    ok:
      into: out
      mapFile: host/good.map.yml
    gone:
      into: out
      mapFile: host/none.map.yml
    broken:
      into: out
      mapFile: host/bad.map.yml
`,
    );
    const { result } = await validateConfigFile(path);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toBe(
      "export.targets.gone.mapFile: host/none.map.yml does not exist (relative to the config directory)",
    );
    expect(result.errors[1]).toContain("export.targets.broken.mapFile:");
    expect(result.errors[1]).toContain("actions.login.fixture.name");
  });

  it("lists a target's mapFile", async () => {
    const root = tmpRoot();
    writeFileSync(join(root, "m.map.yml"), "version: 1\n");
    const path = configWith(
      root,
      `    ui:
      into: out
      mapFile: m.map.yml
`,
    );
    const { result, exitCode } = await validateConfigFile(path);
    expect(exitCode).toBe(0);
    expect(result.exportTargets).toEqual([
      { name: "ui", into: "out", mapFile: "m.map.yml" },
    ]);
  });

  it("reports a host config without into, and modes that cannot combine", async () => {
    const root = tmpRoot();
    writeCjsHost(join(root, "host"));
    const path = configWith(
      root,
      `    needs_into:
      hostConfig: host/e2e/playwright.config.ts
    gate_env_only:
      into: out
      gateEnv: [MONGO_URI]
    global_without_into:
      preconditions: global
`,
    );
    const { result } = await validateConfigFile(path);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "export.targets.needs_into.hostConfig: --host-config adapts",
        ),
        "export.targets.gate_env_only: --gate-env only applies with --verifiers gate",
        expect.stringContaining(
          "export.targets.global_without_into: --preconditions global needs --project or --into",
        ),
      ]),
    );
  });

  it("reports a host config that cannot be read statically, and an into the host would never discover", async () => {
    const root = tmpRoot();
    const tree = writeCjsHost(join(root, "host"));
    writeFileSync(
      join(tree.e2e, "computed.config.ts"),
      "import {build} from './build';\nexport default build();\n",
    );
    const path = configWith(
      root,
      `    computed:
      into: host/e2e/tests/cairn
      hostConfig: host/e2e/computed.config.ts
    undiscovered:
      into: host/elsewhere
      hostConfig: host/e2e/playwright.config.ts
`,
    );
    const { result } = await validateConfigFile(path);
    expect(result.errors).toEqual(
      expect.arrayContaining([
        expect.stringContaining(
          "export.targets.computed.hostConfig: --host-config",
        ),
        expect.stringContaining("neither contains nor sits inside"),
      ]),
    );
    expect(result.errors.join("\n")).toContain("computed");
  });

  it("checks an ES module host the same way", async () => {
    const root = tmpRoot();
    writeEsmHost(join(root, "esm"));
    const path = configWith(
      root,
      `    esm:
      into: esm/specs/cairn
      hostConfig: esm/playwright.config.ts
      lang: ts
`,
    );
    const { result, exitCode } = await validateConfigFile(path);
    expect(result.errors).toEqual([]);
    expect(exitCode).toBe(0);
  });
});
