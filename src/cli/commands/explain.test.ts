import { describe, expect, it } from "vitest";
import { buildExplain } from "./explain";
import { ExplainResultSchema } from "../../core/schema/explain.v1";
import { DOC_TOPICS } from "./docs";

describe("buildExplain", () => {
  const doc = buildExplain();

  it("validates against the v1 ExplainResult schema", () => {
    expect(() => ExplainResultSchema.parse(doc)).not.toThrow();
  });

  it("documents the `type` step (SPA keydown rationale vs fill)", () => {
    const typeStep = doc.steps.find((s) => s.id === "type");
    expect(typeStep).toBeDefined();
    expect(typeStep!.kind).toBe("interaction");
    expect(typeStep!.summary).toContain("fill");
    expect(typeStep!.yamlExample).toContain("type:");
    expect(typeStep!.yamlExample).toContain("value");
    expect(typeStep!.yamlExample).toContain("delayMs");
  });

  it("includes the clip command with its label flag", () => {
    const clip = doc.commands.find((c) => c.name === "clip");
    expect(clip).toBeDefined();
    expect(clip!.synopsis).toContain("cairn clip <run-ref>");
    expect(clip!.flags.map((f) => f.name)).toContain("--label");
  });

  it("builds the docs synopsis from every DOC_TOPICS entry", () => {
    const docsCmd = doc.commands.find((c) => c.name === "docs");
    expect(docsCmd).toBeDefined();
    expect(docsCmd!.synopsis).toBe(
      `cairn docs [${DOC_TOPICS.join("|")}] [--format json|yaml|md]`,
    );
    // The stale 9-topic synopsis omitted these authoring-central topics.
    expect(docsCmd!.synopsis).toContain("discovery");
    expect(docsCmd!.synopsis).toContain("export");
  });
});
