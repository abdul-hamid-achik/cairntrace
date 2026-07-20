import { describe, expect, it } from "vitest";
import { buildDocs, DOC_TOPICS } from "./docs";
import { DocsResultSchema } from "../../core/schema/docs.v1";

describe("buildDocs", () => {
  it("exposes all 17 docs topics including discovery and export", () => {
    expect(DOC_TOPICS).toHaveLength(17);
    expect(DOC_TOPICS).toContain("discovery");
    expect(DOC_TOPICS).toContain("export");
  });

  it("steps topic documents the `type` step", () => {
    const doc = buildDocs("steps");
    expect(() => DocsResultSchema.parse(doc)).not.toThrow();
    const supported = doc.sections.find((s) => s.title === "Supported Steps");
    expect(supported).toBeDefined();
    expect(supported!.body).toContain("`type`");
    expect(supported!.body).toContain("delayMs");
  });
});
