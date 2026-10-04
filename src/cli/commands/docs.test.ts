import { describe, expect, it } from "vitest";
import { buildDocs, DOC_TOPICS } from "./docs";
import { DocsResultSchema } from "../../core/schema/docs.v1";
import { ConfigSchema } from "../../core/schema/config.v1";
import { SpecSchema } from "../../core/schema/spec.v1";
import { parse as parseYaml } from "yaml";
import { parseExportMap } from "../../core/exporters/exportMap";
import { readFileSync } from "node:fs";

describe("buildDocs", () => {
  it("mcp topic documents journey brief tools", () => {
    const doc = buildDocs("mcp");
    const text = JSON.stringify(doc);
    expect(text).toContain("cairn_export_brief");
    expect(text).toContain("cairn_accompany_open");
    expect(doc.relatedTopics).toContain("brief");
  });

  it("services topic documents the run policy and critical teardown", () => {
    const text = JSON.stringify(buildDocs("services"));
    expect(text).toContain(
      "Run Policy (lock, preflight, verifyClean, finally, --bail)",
    );
    expect(text).toContain("critical: true");
    expect(text).toContain("exit 8");
    expect(text).toContain("CAIRN_EXIT_CODE");
    expect(text).toContain("doctor --orphans");
    expect(text).toContain("invocation.bailed");
  });

  it("exposes all 25 docs topics including discovery, export, import, brief, catalog, fixtures, author-flow, widgets, run-policy and delegate", () => {
    expect(DOC_TOPICS).toHaveLength(25);
    expect(DOC_TOPICS).toContain("run-policy");
    expect(DOC_TOPICS).toContain("delegate");
    expect(DOC_TOPICS).toContain("widgets");
    expect(DOC_TOPICS).toContain("fixtures");
    expect(DOC_TOPICS).toContain("discovery");
    expect(DOC_TOPICS).toContain("export");
    expect(DOC_TOPICS).toContain("import");
    expect(DOC_TOPICS).toContain("brief");
    expect(DOC_TOPICS).toContain("catalog");
    expect(DOC_TOPICS).toContain("author-flow");
  });

  it("delegate topic documents the runner config, the contract and the relay", () => {
    const doc = buildDocs("delegate");
    expect(() => DocsResultSchema.parse(doc)).not.toThrow();
    const text = JSON.stringify(doc);
    for (const needle of [
      "urn:cairntrace.dev:delegate:v1",
      "CAIRN_DELEGATE_REQUEST",
      "CAIRN_DELEGATE_EVENTS",
      "--relay",
      "cancelGraceMs",
      "missing-run-dir",
      "cairn.delegate",
    ]) {
      expect(text).toContain(needle);
    }
    const yaml = doc.examples.find((example) => example.language === "yaml");
    expect(() =>
      ConfigSchema.parse({
        version: 1,
        ...(parseYaml(yaml!.code) as Record<string, unknown>),
      }),
    ).not.toThrow();
  });

  it("import topic documents both importers and the author-flow place", () => {
    const doc = buildDocs("import");
    expect(() => DocsResultSchema.parse(doc)).not.toThrow();
    const text = JSON.stringify(doc);
    for (const needle of [
      "cairn import playwright",
      "cairn import playwright-trace",
      "cairn_import_playwright_trace",
      "coverage",
      "secrets",
      "DRAFT",
    ]) {
      expect(text).toContain(needle);
    }
    expect(JSON.stringify(buildDocs("author-flow"))).toContain(
      "cairn import playwright-trace",
    );
  });

  it("author-flow topic carries the recipe the MCP prompt uses", () => {
    const doc = buildDocs("author-flow");
    expect(() => DocsResultSchema.parse(doc)).not.toThrow();
    const text = JSON.stringify(doc);
    for (const tool of [
      "cairn_catalog",
      "cairn_discover_open",
      "cairn_discover_export",
      "cairn_spec_finish",
      "cairn_spec_promote",
      "cairn spec lint",
      "cairn init agent-kit",
    ]) {
      expect(text).toContain(tool);
    }
    expect(doc.relatedTopics).toEqual(
      expect.arrayContaining(["discovery", "catalog", "authoring"]),
    );
  });

  it("steps topic documents the `type` step", () => {
    const doc = buildDocs("steps");
    expect(() => DocsResultSchema.parse(doc)).not.toThrow();
    const supported = doc.sections.find((s) => s.title === "Supported Steps");
    expect(supported).toBeDefined();
    expect(supported!.body).toContain("`type`");
    expect(supported!.body).toContain("delayMs");
  });

  it("keeps investigate documentation aligned with the public CLI and config", () => {
    const doc = buildDocs("investigate");
    expect(() => DocsResultSchema.parse(doc)).not.toThrow();
    const text = JSON.stringify(doc);

    for (const supported of [
      "--codebase",
      "--connect",
      "--query",
      "--clips",
      "--speed",
      "--slow-mo",
      "--no-cold-start",
      "--index",
      "codebaseDir",
      "index: false",
      "autoInvestigate",
    ]) {
      expect(text).toContain(supported);
    }

    for (const nonexistent of [
      "--keep-stash",
      "--use-clips",
      "--no-use-clips",
      '"keepStash"',
      '"useClips"',
    ]) {
      expect(text).not.toContain(nonexistent);
    }
  });

  it("keeps integration config examples valid under the strict schema", () => {
    for (const topic of [
      "stash",
      "investigate",
      "annotate",
      "secrets",
    ] as const) {
      const configSection = buildDocs(topic).sections.find(
        (section) => section.title === "Config",
      );
      expect(configSection, `${topic} Config section`).toBeDefined();
      const yaml = configSection!.body.match(/```yaml\n([\s\S]*?)\n```/)?.[1];
      expect(yaml, `${topic} YAML example`).toBeDefined();
      expect(() => ConfigSchema.parse(parseYaml(yaml!)), topic).not.toThrow();
    }
  });

  it("keeps complete config examples valid under the strict schema", () => {
    const examples = [
      buildDocs("authoring").examples.find(
        (example) => example.title === "config variables for the spec",
      ),
      buildDocs("backends").examples.find(
        (example) =>
          example.title === "webServer block (cairntrace.config.yml)",
      ),
      ...buildDocs("services").examples.filter(
        (example) => example.language === "yaml",
      ),
    ];

    for (const example of examples) {
      expect(example).toBeDefined();
      expect(
        () => ConfigSchema.parse(parseYaml(example!.code)),
        example!.title,
      ).not.toThrow();
    }

    const servicesSection = buildDocs("services").sections.find(
      (section) => section.title === "Per-Environment Services",
    );
    const yaml = servicesSection?.body.match(/```yaml\n([\s\S]*?)\n```/)?.[1];
    expect(yaml).toBeDefined();
    expect(() => ConfigSchema.parse(parseYaml(yaml!))).not.toThrow();
  });

  it("keeps the fixtures topic examples valid", () => {
    const doc = buildDocs("fixtures");
    const config = doc.examples.find((e) =>
      e.title.startsWith("fixtures registry"),
    );
    const spec = doc.examples.find(
      (e) => e.title === "a spec that uses fixtures",
    );
    expect(() => ConfigSchema.parse(parseYaml(config!.code))).not.toThrow();
    expect(() => SpecSchema.parse(parseYaml(spec!.code))).not.toThrow();
  });

  it("keeps complete authoring spec examples valid", () => {
    for (const title of ["minimal spec shape", "config-backed spec"]) {
      const example = buildDocs("authoring").examples.find(
        (candidate) => candidate.title === title,
      );
      expect(example).toBeDefined();
      expect(
        () => SpecSchema.parse(parseYaml(example!.code)),
        title,
      ).not.toThrow();
    }
  });

  it("keeps public documentation config blocks valid", () => {
    const files = [
      "docs/configuration.md",
      "docs/investigate.md",
      "docs/stash.md",
      "docs/annotate.md",
      "docs/secrets.md",
      "docs/services.md",
    ];

    for (const file of files) {
      const markdown = readFileSync(file, "utf8");
      const blocks = [...markdown.matchAll(/```yaml\n([\s\S]*?)\n```/g)];
      expect(blocks.length, file).toBeGreaterThan(0);
      for (const [, yaml] of blocks) {
        expect(
          // Same YAML options loadConfig uses (merge keys enabled).
          () => ConfigSchema.parse(parseYaml(yaml!, { merge: true })),
          `${file} config block`,
        ).not.toThrow();
      }
    }
  });

  it("keeps the export page's config and export map examples valid", () => {
    const markdown = readFileSync("docs/export.md", "utf8");
    const blocks = [...markdown.matchAll(/```yaml\n([\s\S]*?)\n```/g)].map(
      (m) => m[1]!,
    );
    expect(blocks.length).toBeGreaterThanOrEqual(2);
    let maps = 0;
    let configs = 0;
    for (const yaml of blocks) {
      const parsed = parseYaml(yaml, { merge: true }) as Record<
        string,
        unknown
      >;
      if ("export" in parsed) {
        configs += 1;
        expect(() =>
          ConfigSchema.parse({ version: 1, environments: {}, ...parsed }),
        ).not.toThrow();
      } else {
        maps += 1;
        expect(() => parseExportMap(yaml, "docs/export.md")).not.toThrow();
      }
    }
    expect(configs).toBeGreaterThan(0);
    expect(maps).toBeGreaterThan(0);
  });

  it("documents the text redaction boundary without exposing source snippets", () => {
    const artifacts = JSON.stringify(buildDocs("artifacts"));
    expect(artifacts).toContain("Cairntrace-authored text");
    expect(artifacts).toContain("downloads/transforms/traces");
    expect(artifacts).toContain("frames/images remain uninspected");
    expect(artifacts).toContain("vidtrace");

    const investigate = JSON.stringify(buildDocs("investigate"));
    expect(investigate).toContain("not raw source snippets");
    expect(investigate).toContain("current working directory");
    expect(investigate).toContain("config file");
  });

  it("keeps post-click settling opt-in across generated and public docs", () => {
    const generated = JSON.stringify([
      buildDocs("steps"),
      buildDocs("backends"),
    ]);
    const publicDocs = [
      "AGENTS.md",
      "README.md",
      "docs/steps.md",
      "docs/configuration.md",
    ]
      .map((file) => readFileSync(file, "utf8"))
      .join("\n");
    const text = `${generated}\n${publicDocs}`;

    expect(text).toContain("without an implicit network-idle wait");
    expect(text).toContain("link-delivery probe");
    expect(text).not.toMatch(/network-idle settl\w+ by default/i);
    expect(text).not.toMatch(/post-click[^.\n]*5000\s*ms default/i);
    expect(text).not.toContain("→ 5000");
  });
});
