/**
 * Semantic validation of exporter output — two properties stronger than
 * "it parses":
 *
 *  1. TYPE-CHECK: every golden type-checks against the REAL @playwright/test
 *     types (devDependency), so an emitted call that drifts from Playwright's
 *     API fails here, not in the user's CI. Environment-dependent dynamic
 *     imports (absolute verifier paths that only exist on the exporting
 *     machine) are the one filtered diagnostic.
 *
 *  2. ROUND-TRIP: `cairn import playwright` over exported output maps the
 *     core actions back to Cairntrace steps. The importer is best-effort, so
 *     this asserts a floor (basic steps survive), not isomorphism.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import ts from "typescript";
import { importPlaywright } from "../importers/playwrightImporter";
import { SpecSchema } from "../schema/spec.v1";
import { exportPlaywright } from "./playwrightExporter";

const HERE = dirname(new URL(import.meta.url).pathname);
const GOLDEN_DIR = join(HERE, "goldens");
// Inside the repo so `import "@playwright/test"` resolves via node_modules.
const TMP_DIR = join(GOLDEN_DIR, ".typecheck-tmp");

afterAll(() => {
  rmSync(TMP_DIR, { recursive: true, force: true });
});

describe("exporter output type-checks against @playwright/test", () => {
  const goldens = readdirSync(GOLDEN_DIR).filter((f) =>
    f.endsWith(".golden.ts.txt"),
  );
  expect(goldens.length).toBeGreaterThan(0);

  for (const golden of goldens) {
    it(golden, () => {
      const source = readFileSync(join(GOLDEN_DIR, golden), "utf8");
      mkdirSync(TMP_DIR, { recursive: true });
      const file = join(TMP_DIR, golden.replace(".golden.ts.txt", ".spec.ts"));
      writeFileSync(file, source);

      const program = ts.createProgram([file], {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict: false,
        noEmit: true,
        skipLibCheck: true,
      });
      const diagnostics = ts
        .getPreEmitDiagnostics(program)
        .filter((d) => d.file?.fileName === file.replaceAll("\\", "/"))
        // Dynamic imports of verifier PATHS (absolute or relative) point at
        // files that only exist in the exporting project, not this repo —
        // every unresolved BARE module (e.g. @playwright/test) is a bug.
        .filter(
          (d) =>
            !(
              d.code === 2307 &&
              /['"][./]/.test(
                ts.flattenDiagnosticMessageText(d.messageText, " "),
              )
            ),
        );
      expect(
        diagnostics.map(
          (d) =>
            `TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, " ")}`,
        ),
      ).toEqual([]);
    });
  }
});

describe("export → import round-trip floor", () => {
  it("core actions survive the round trip", () => {
    const s = SpecSchema.parse({
      version: 1,
      name: "roundtrip_basics",
      intent: "basic actions must survive export → import",
      steps: [
        { id: "go", open: "https://example.com/app" },
        {
          id: "click_btn",
          click: { by: "role", role: "button", name: "Save" },
        },
        {
          id: "fill_name",
          fill: { by: "selector", selector: "#name", value: "Ada" },
        },
      ],
      outcomes: [
        {
          id: "saved",
          description: "confirmation shows",
          verify: { text: { contains: "Saved" } },
        },
      ],
    });
    const exported = exportPlaywright(s).source;
    const imported = importPlaywright(exported);

    const kinds = imported.spec.steps?.map((st) => {
      if ("open" in st) return "open";
      if ("click" in st) return "click";
      if ("fill" in st) return "fill";
      return "other";
    });
    expect(kinds).toContain("open");
    expect(kinds).toContain("click");
    expect(kinds).toContain("fill");
    // The text outcome must survive as a contains matcher.
    const outcomeJson = JSON.stringify(imported.spec.outcomes ?? []);
    expect(outcomeJson).toContain("Saved");
  });
});
