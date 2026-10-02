import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import { beforeAll, describe, expect, it } from "vitest";
import { parse as parseYaml } from "yaml";
import { CatalogResultSchema } from "../../core/catalog/catalog.v1";
import { ReusableActionSchema } from "../../core/schema/spec.v1";
import { parseCatalogKinds } from "./catalog";
import { buildDocs } from "./docs";
import { buildExplain } from "./explain";

const BIN = join(import.meta.dirname, "..", "..", "..", "bin", "cairn");

let dir: string;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-catalog-cli-"));
  await mkdir(join(dir, "actions"), { recursive: true });
  await mkdir(join(dir, "flows"), { recursive: true });
  await writeFile(
    join(dir, "cairntrace.config.yml"),
    `version: 1
artifactRoot: ${join(dir, "runs")}
environments:
  local:
    baseUrl: http://localhost:4100
    vars:
      # Where the search box lives
      searchSelector: "#search"
`,
  );
  await writeFile(
    join(dir, "actions", "run_search.yml"),
    `version: 1
name: run_search
description: Type a query into the search box and submit it.
vars: { query: shoes }
inputs:
  query: { description: what to search for, default: shoes }
steps:
  - fill: { by: selector, selector: "\${vars.searchSelector}", value: "\${vars.query}" }
`,
  );
  await writeFile(
    join(dir, "flows", "search.yml"),
    `version: 1
name: search_results
intent: a search returns matching products
coldStart: guest
imports: [../actions/run_search.yml]
steps:
  - use: run_search
outcomes:
  - id: results
    description: results are listed
    verify: { text: { contains: Results } }
`,
  );
});

// Spawns bin/cairn; vitest's 5s default is too tight under full-suite load.
describe("cairn catalog CLI", { timeout: 30_000 }, () => {
  const cairn = (args: string[]) =>
    execa(BIN, ["catalog", ...args], {
      cwd: dir,
      reject: false,
      timeout: 20_000,
      env: { CAIRN_LOG_LEVEL: "silent", NO_COLOR: "1" },
    });

  it("prints the catalog as JSON, YAML and markdown", async () => {
    const json = await cairn(["--json", "--query", "search box"]);
    expect(json.exitCode).toBe(0);
    const doc = CatalogResultSchema.parse(JSON.parse(json.stdout));
    expect(doc.actions![0]).toMatchObject({
      name: "run_search",
      file: "actions/run_search.yml",
      usedBy: [{ kind: "spec", name: "search_results" }],
    });
    expect(doc.vars![0]).toMatchObject({
      name: "searchSelector",
      comment: "Where the search box lives",
    });

    const yaml = await cairn(["--yaml", "--kind", "flows"]);
    expect(yaml.exitCode).toBe(0);
    const parsed = CatalogResultSchema.parse(parseYaml(yaml.stdout));
    expect(parsed.kinds).toEqual(["flows"]);
    expect(parsed.flows![0]!.name).toBe("search_results");

    const md = await cairn(["--kind", "actions,envs"]);
    expect(md.exitCode).toBe(0);
    expect(md.stdout).toContain("## Actions (1)");
    expect(md.stdout).toContain("## Environments (1)");
    expect(md.stdout).not.toContain("## Flows");
  });

  it("exits 2 on a usage error and 4 on an unknown environment", async () => {
    const badKind = await cairn(["--kind", "widgets", "--json"]);
    expect(badKind.exitCode).toBe(2);
    expect(badKind.stderr).toContain('unknown --kind "widgets"');
    expect(badKind.stdout).toBe("");

    const badLimit = await cairn(["--limit", "0", "--json"]);
    expect(badLimit.exitCode).toBe(2);

    const badEnv = await cairn(["--env", "nope", "--json"]);
    expect(badEnv.exitCode).toBe(4);
    expect(badEnv.stderr).toContain('unknown environment "nope"');
  });
});

describe("parseCatalogKinds", () => {
  it("accepts repeatable and comma-separated kinds", () => {
    expect(parseCatalogKinds(undefined)).toBeUndefined();
    expect(parseCatalogKinds(["actions,vars", "vars", " flows "])).toEqual([
      "actions",
      "vars",
      "flows",
    ]);
    expect(() => parseCatalogKinds(["actions,nope"])).toThrow(
      /unknown --kind "nope"/,
    );
  });
});

describe("catalog docs", () => {
  it("documents an action example the schema accepts", () => {
    const doc = buildDocs("catalog");
    const example = doc.examples.find((e) => e.language === "yaml")!;
    expect(
      ReusableActionSchema.safeParse(parseYaml(example.code)).success,
    ).toBe(true);
  });

  it("is listed by cairn explain with the catalog schema", () => {
    const entry = buildExplain().commands.find((c) => c.name === "catalog");
    expect(entry).toMatchObject({
      outputSchema: "urn:cairntrace.dev:catalog:v1",
    });
  });
});
