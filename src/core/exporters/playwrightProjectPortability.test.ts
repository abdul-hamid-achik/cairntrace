/**
 * `--project` portability and honesty: relocatable project root (E7),
 * copied upload fixtures (E7), action coverage propagated into callers (E3),
 * beforeAll budgets (timeouts), and the sentinel guard for action modules (E1).
 */
import {
  mkdir,
  mkdtemp,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LoadedAction, ParseResult } from "../parser/parseSpec";
import type { Spec } from "../schema/spec.v1";
import { MAX_FIXTURE_BYTES } from "./playwrightExporter";
import {
  exportPlaywrightProject,
  relativeFromExportRootToProject,
  specSourceDigest,
} from "./playwrightProject";
import { renderProjectRootRuntime } from "./playwrightRuntime";
import { LateBoundLeakError } from "./templateValue";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

async function tempDir(prefix: string): Promise<string> {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  directories.push(directory);
  return directory;
}

function spec(overrides: Partial<Spec>): Spec {
  return {
    version: 1,
    name: "portable",
    intent: "export portably",
    mode: "normal",
    outcomes: [
      {
        id: "visible",
        description: "visible",
        verify: { text: { contains: "ready" }, region: "page" },
      },
    ],
    steps: [],
    ...overrides,
  } as Spec;
}

function parsedAt(
  path: string,
  authored: Spec,
  actions: Array<[string, LoadedAction]> = [],
): ParseResult {
  return {
    spec: authored,
    resolved: authored,
    path,
    contractHashValid: true,
    origins: [],
    actionsByName: new Map(actions),
  };
}

function fileOf(
  result: ReturnType<typeof exportPlaywrightProject>,
  relPath: string,
): string {
  const file = result.files.find((candidate) => candidate.relPath === relPath);
  if (!file) throw new Error(`missing ${relPath}`);
  return file.source;
}

describe("E7: relocatable project root", () => {
  it("resolves the project root relative to the export root, never as a baked absolute path", async () => {
    const root = await tempDir("cairn-export-root-");
    await mkdir(join(root, "flows"), { recursive: true });
    const result = exportPlaywrightProject(
      [
        parsedAt(
          join(root, "flows", "portable.yml"),
          spec({
            preconditions: {
              commands: [
                { name: "seed", run: "bun run seed", cwd: "../tools" },
              ],
            },
          }),
        ),
      ],
      { projectRoot: root, outDir: join(root, "exports", "pw") },
    );
    const projectRoot = fileOf(result, "lib/projectRoot.ts");
    const test = fileOf(result, "tests/portable.spec.ts");
    const runtime = fileOf(result, "preconditions.ts");

    expect(projectRoot).toContain(
      `resolve(fileURLToPath(new URL("..", import.meta.url)), "../..")`,
    );
    expect(projectRoot).not.toContain(root);
    expect(projectRoot).toContain("Set CAIRN_PROJECT_ROOT");
    expect(projectRoot).toContain("if (!existsSync(root))");
    expect(test).toContain(
      `await runPrecondition("bun run seed", { cwd: join(cairnProjectRoot(), "tools"), timeoutMs: 120000 });`,
    );
    expect(test).toContain(
      `import { cairnProjectRoot } from "../lib/projectRoot";`,
    );
    expect(test).toContain(`Source: flows/portable.yml`);
    expect(runtime).toContain("if (!existsSync(options.cwd))");
    expect(runtime).toContain("Set CAIRN_PROJECT_ROOT");
  });

  it("computes the export→project path on real paths (symlinked out dirs)", async () => {
    const root = await tempDir("cairn-export-real-");
    const linkParent = await tempDir("cairn-export-link-");
    await mkdir(join(root, "deep", "nested", "out"), { recursive: true });
    const link = join(linkParent, "out-link");
    await symlink(join(root, "deep", "nested", "out"), link);

    // Lexically the link is two levels from linkParent; really it is three
    // below root. The emitted relative path must follow the REAL location.
    expect(relativeFromExportRootToProject(link, root)).toBe("../../..");
    expect(relativeFromExportRootToProject(join(root, "exports"), root)).toBe(
      "..",
    );
    expect(relativeFromExportRootToProject(undefined, root)).toBeUndefined();
  });

  it("falls back to process.cwd() only when no export root is known", () => {
    const runtime = renderProjectRootRuntime("js", undefined);
    expect(runtime).toContain(
      "const root = override ? resolve(override) : process.cwd();",
    );
    expect(runtime).not.toContain("import.meta.url");
  });

  it("passes node verifiers a project-relative specDir", async () => {
    const root = await tempDir("cairn-export-verifier-dir-");
    const authored = spec({
      outcomes: [
        {
          id: "durable",
          description: "durable",
          verify: {
            script: { runtime: "node", file: "../verifiers/check.ts" },
          },
        },
      ],
    });
    const result = exportPlaywrightProject(
      [parsedAt(join(root, "flows", "portable.yml"), authored)],
      { projectRoot: root, outDir: join(root, "pw") },
    );
    const test = fileOf(result, "tests/portable.spec.ts");
    expect(test).toContain(`specDir: cairnProjectPath("flows"),`);
    expect(test).toContain(
      `import { cairnProjectPath } from "../lib/projectRoot";`,
    );
    expect(test).not.toContain(`specDir: "${root}`);
  });
});

describe("E7: upload fixtures are copied into the export", () => {
  it("copies spec-relative upload files to fixtures/ and rewrites the path", async () => {
    const root = await tempDir("cairn-export-fixtures-");
    await mkdir(join(root, "flows"), { recursive: true });
    await mkdir(join(root, "fixtures"), { recursive: true });
    await mkdir(join(root, "other"), { recursive: true });
    await writeFile(join(root, "fixtures", "invoice.pdf"), "%PDF-1.4");
    await writeFile(join(root, "other", "invoice.pdf"), "%PDF-other");
    const result = exportPlaywrightProject(
      [
        parsedAt(
          join(root, "flows", "portable.yml"),
          spec({
            steps: [
              {
                id: "attach",
                upload: {
                  by: "label",
                  name: "File",
                  path: "../fixtures/invoice.pdf",
                },
              },
              {
                id: "attach_other",
                upload: {
                  by: "label",
                  name: "Other",
                  path: "../other/invoice.pdf",
                },
              },
            ],
          }),
        ),
      ],
      { projectRoot: root, outDir: join(root, "pw"), copyFixtures: true },
    );
    const test = fileOf(result, "tests/portable.spec.ts");
    expect(test).toContain(`setInputFiles(cairnFixturePath("invoice.pdf"));`);
    expect(test).toContain(
      `setInputFiles(cairnFixturePath("other-invoice.pdf"));`,
    );
    expect(test).toContain(
      `import { cairnFixturePath } from "../lib/fixtures";`,
    );
    expect(result.fixtureFiles).toEqual([
      {
        sourcePath: join(root, "fixtures", "invoice.pdf"),
        relPath: "fixtures/invoice.pdf",
      },
      {
        sourcePath: join(root, "other", "invoice.pdf"),
        relPath: "fixtures/other-invoice.pdf",
      },
    ]);
    expect(fileOf(result, "lib/fixtures.ts")).toContain(
      `new URL("../fixtures/" + encodeURIComponent(name), import.meta.url)`,
    );
    expect(result.specs[0]?.coverage.semanticRisks).toEqual([]);
  });
});

function uploadStep(id: string, path: string) {
  return {
    id,
    upload: { by: "label", name: id, path },
  };
}

/** A `login` action loaded from `path` (same name and content). */
function loginActionAt(path: string): LoadedAction {
  return {
    path,
    rawSource: "version: 1\nname: login\nsteps:\n  - open: /login\n",
    actionDefaults: {},
    action: {
      version: 1,
      name: "login",
      steps: [{ open: "/login" }],
    } as unknown as LoadedAction["action"],
  };
}

describe("E7: fixture copies are bounded like verifier copies", () => {
  it("copies only regular files inside the project root, under the size cap", async () => {
    const outside = await tempDir("cairn-export-personal-");
    const root = await tempDir("cairn-export-bounded-");
    await mkdir(join(root, "flows"), { recursive: true });
    await mkdir(join(root, "fixtures"), { recursive: true });
    await writeFile(join(root, "fixtures", "ok.txt"), "ok");
    await writeFile(join(outside, "personal.txt"), "do not copy");
    await symlink(
      join(outside, "personal.txt"),
      join(root, "fixtures", "linked.txt"),
    );
    await writeFile(join(root, "fixtures", "huge.bin"), "");
    await truncate(join(root, "fixtures", "huge.bin"), MAX_FIXTURE_BYTES + 1);
    const result = exportPlaywrightProject(
      [
        parsedAt(
          join(root, "flows", "portable.yml"),
          spec({
            steps: [
              uploadStep("inside", "../fixtures/ok.txt"),
              uploadStep("outside", join(outside, "personal.txt")),
              uploadStep("linked", "../fixtures/linked.txt"),
              uploadStep("huge", "../fixtures/huge.bin"),
            ] as Spec["steps"],
          }),
        ),
      ],
      { projectRoot: root, outDir: join(root, "pw"), copyFixtures: true },
    );
    expect(result.fixtureFiles).toEqual([
      {
        sourcePath: join(root, "fixtures", "ok.txt"),
        relPath: "fixtures/ok.txt",
      },
    ]);
    const test = fileOf(result, "tests/portable.spec.ts");
    expect(test).toContain(`setInputFiles(cairnFixturePath("ok.txt"));`);
    expect(test).toContain(
      `setInputFiles(${JSON.stringify(join(outside, "personal.txt"))});`,
    );
    const risks = (result.specs[0]?.coverage.semanticRisks ?? []).filter(
      (risk) => risk.kind === "absolutePath",
    );
    expect(risks.map((risk) => risk.detail)).toEqual([
      expect.stringContaining("outside the project root"),
      expect.stringContaining("symlink"),
      expect.stringContaining(`larger than ${MAX_FIXTURE_BYTES} bytes`),
    ]);
  });
});

describe("relocatable sources: digests and header paths", () => {
  it("digests action sources by name and content, never by absolute path", () => {
    const authored = spec({});
    const here = parsedAt("/nonexistent/a/flows/portable.yml", authored, [
      ["login", loginActionAt("/nonexistent/a/actions/login.yml")],
    ]);
    const moved = parsedAt("/nonexistent/b/flows/portable.yml", authored, [
      ["login", loginActionAt("/nonexistent/b/actions/login.yml")],
    ]);
    expect(specSourceDigest(here)).toBe(specSourceDigest(moved));
    const edited = parsedAt("/nonexistent/b/flows/portable.yml", authored, [
      [
        "login",
        {
          ...loginActionAt("/nonexistent/b/actions/login.yml"),
          rawSource: "version: 1\nname: login\nsteps:\n  - open: /signin\n",
        },
      ],
    ]);
    expect(specSourceDigest(edited)).not.toBe(specSourceDigest(here));
  });

  it("renders an action outside the project root relative to it in the header", async () => {
    const root = await tempDir("cairn-export-header-");
    const specsDir = join(root, "specs");
    await mkdir(specsDir, { recursive: true });
    const result = exportPlaywrightProject(
      [
        parsedAt(
          join(specsDir, "portable.yml"),
          spec({ steps: [{ id: "grab", use: "grab" }] as Spec["steps"] }),
          [
            [
              "grab",
              {
                path: join(root, "actions", "grab.yml"),
                rawSource: "",
                actionDefaults: {},
                action: {
                  version: 1,
                  name: "grab",
                  steps: [{ open: "/grab" }],
                } as unknown as LoadedAction["action"],
              },
            ],
          ],
        ),
      ],
      { projectRoot: specsDir, outDir: join(root, "pw") },
    );
    const header = fileOf(result, "actions/grab.ts").split("\n")[0]!;
    expect(header).toBe(
      `// Generated from reusable action "grab" (../actions/grab.yml).`,
    );
    for (const file of result.files) {
      expect(file.source, file.relPath).not.toContain(root);
    }
  });
});

describe("E3: action coverage propagates into every calling test", () => {
  it("marks callers test.fixme when an action has a hard skip and lists the reason", () => {
    const action: LoadedAction = {
      path: "/tmp/project/actions/prepare.yml",
      rawSource: "",
      actionDefaults: {},
      action: {
        version: 1,
        name: "prepare",
        steps: [
          { id: "go", open: "/prepare" },
          {
            id: "convert",
            transform: {
              file: "convert.ts",
              input: "a.xlsx",
              saveAs: "b.xlsx",
            },
          },
          { id: "snap", snapshot: {} },
        ],
      } as LoadedAction["action"],
    };
    const result = exportPlaywrightProject([
      parsedAt(
        "/tmp/project/flows/caller.yml",
        spec({ name: "caller", steps: [{ id: "prep", use: "prepare" }] }),
        [["prepare", action]],
      ),
    ]);
    const test = fileOf(result, "tests/caller.spec.ts");
    const coverage = result.specs[0]!.coverage;
    expect(test).toContain(`test.fixme("caller"`);
    expect(coverage.fixme).toBe(true);
    expect(coverage.skips).toContainEqual(
      expect.objectContaining({
        id: "prep",
        reason: expect.stringContaining(
          "action prepare (convert): transform step not exportable",
        ),
      }),
    );
    expect(coverage.diagnosticSkips).toContainEqual(
      expect.objectContaining({ id: "prep", soft: true }),
    );
    const readme = fileOf(result, "README.md");
    expect(readme).toContain("**test.fixme**");
    expect(readme).toContain("skipped (marks test.fixme):");
  });

  it("refuses an action module that would still carry a sentinel", () => {
    const action: LoadedAction = {
      path: "/tmp/project/actions/odd.yml",
      rawSource: "",
      actionDefaults: {},
      action: {
        version: 1,
        name: "odd",
        steps: [
          {
            id: "odd_click",
            click: { by: "role", role: "__CAIRN_RUN_TOKEN__" },
          },
        ],
      } as LoadedAction["action"],
    };
    expect(() =>
      exportPlaywrightProject([
        parsedAt(
          "/tmp/project/flows/caller.yml",
          spec({ steps: [{ use: "odd" }] }),
          [["odd", action]],
        ),
      ]),
    ).toThrow(LateBoundLeakError);
  });
});

describe("timeouts: precondition hooks set their own budget", () => {
  it("emits test.setTimeout in beforeAll and keeps UI tests off the 30m floor", () => {
    const result = exportPlaywrightProject([
      parsedAt(
        "/tmp/project/flows/portable.yml",
        spec({
          preconditions: {
            commands: [
              { run: "echo docs only" },
              { run: "bun run reset", timeoutMs: 600_000 },
            ],
          },
        }),
      ),
    ]);
    const test = fileOf(result, "tests/portable.spec.ts");
    expect(test).toContain(
      `test.setTimeout(1800000);\n  await runPrecondition("bun run reset"`,
    );
    expect(test).toContain(`  test.setTimeout(90000);`);
    expect(test).not.toContain(`runPrecondition("echo docs only"`);
    const config = fileOf(result, "playwright.config.ts");
    expect(config).toContain(`timeout: 1800000,`);
    expect(config).toContain(`actionTimeout: 30_000,`);
  });
});

describe("E1: action vars stay parameters through a real parse", () => {
  it("never lowercases ${vars.X} sentinels in wait.text / when.text / eval / fill", async () => {
    const root = await tempDir("cairn-export-action-vars-");
    await mkdir(join(root, "actions"), { recursive: true });
    await mkdir(join(root, "flows"), { recursive: true });
    await writeFile(
      join(root, "actions", "pick_entity.yml"),
      [
        "version: 1",
        "name: pick_entity",
        "vars:",
        "  entityName: Demo Entity",
        "steps:",
        "  - id: wait_entity",
        "    wait:",
        '      text: "${vars.entityName}"',
        "      timeoutMs: 5000",
        "  - id: maybe_open",
        '    when: "text:Open ${vars.entityName}"',
        "    click: { by: role, role: button, name: Open }",
        "  - id: mark",
        "    eval:",
        "      js: \"window.__picked = '${vars.entityName}-${run.token}'; return 1;\"",
        "  - id: type_name",
        "    fill:",
        "      by: label",
        "      name: Entity",
        '      value: "${vars.entityName} (${run.token})"',
        "",
      ].join("\n"),
    );
    await writeFile(
      join(root, "flows", "pick.yml"),
      [
        "version: 1",
        "name: pick",
        "intent: pick an entity by name",
        "coldStart: guest",
        "imports:",
        "  - ../actions/pick_entity.yml",
        "outcomes:",
        "  - id: picked",
        "    description: picked",
        "    verify:",
        "      text: { contains: Picked }",
        "steps:",
        "  - id: pick_supplier",
        "    use:",
        "      action: pick_entity",
        "      vars:",
        "        entityName: Supplier Alpha",
        "",
      ].join("\n"),
    );
    const { parseSpec } = await import("../parser/parseSpec");
    const parsed = await parseSpec(join(root, "flows", "pick.yml"), {
      secretRef: (name) => `__CAIRN_SECRET_REF__${name}__`,
      runtime: { runToken: "__CAIRN_RUN_TOKEN__" },
    });
    const result = exportPlaywrightProject([parsed], {
      projectRoot: root,
      outDir: join(root, "pw"),
    });
    const action = fileOf(result, "actions/pick_entity.ts");
    const test = fileOf(result, "tests/pick.spec.ts");
    for (const file of result.files) {
      expect(file.source, file.relPath).not.toMatch(/__CAIRN_[A-Z_]+__/i);
    }
    expect(action).toContain(
      `const entityName = vars.entityName ?? "Demo Entity";`,
    );
    expect(action).toContain(
      `.includes(String(entityName).replace(/\\s+/g, " ").trim().toLowerCase())`,
    );
    expect(action).toContain(
      'includes(needle), String(`Open ${entityName}`).replace(/\\s+/g, " ").trim().toLowerCase())',
    );
    expect(action).toContain(
      "source: `window.__picked = '${entityName}-${RUN_TOKEN}'; return 1;`",
    );
    expect(action).toContain(
      'await verifiedFill(page, page.getByLabel("Entity").first(), `${entityName} (${RUN_TOKEN})`);',
    );
    expect(test).toContain(
      `await pick_entity(page, { "entityName": "Supplier Alpha" }, RUN_TOKEN);`,
    );
  });
});
