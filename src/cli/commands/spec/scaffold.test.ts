import { mkdtemp, rm, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { scaffoldCommand, selectRiskyUntestedEntrypoints } from "./scaffold.js";
import type { CodemapDeps } from "../annotate.js";

/* ---------------------------------------------------------------------------
 * scaffoldCommand — `cairn spec scaffold --from-codemap` (FEATURES item 6)
 *
 * `--from-codemap` consults `codemap semantic` + `codemap orphans` for untested
 * entrypoints and pre-fills the spec's `coversSymbol` binding from the symbol's
 * signature/docstring. A fake codemap verifies the binding without codemap on
 * $PATH. Uses semantic + orphans ONLY — `codemap read-order` is not yet shipped
 * here (noted as a future enhancement in FEATURES.md).
 * ------------------------------------------------------------------------- */

let outDir: string;

beforeAll(async () => {
  outDir = await mkdtemp(join(tmpdir(), "cairntrace-scaffold-test-"));
});

afterAll(async () => {
  await rm(outDir, { recursive: true, force: true });
});

/** Fake codemap: one untested entrypoint (orphan) + its semantic signature. */
function fakeCodemap(): CodemapDeps {
  const orphan = {
    symbol: "handleSubmit",
    file: "src/forms/handler.ts",
    line: 22,
    signature: "handleSubmit(e: Event): Promise<void>",
    docstring: "Validate then post the form entry to the API.",
    kind: "handler",
  };
  return {
    isAvailable: async () => true,
    async exec(args) {
      if (args[0] === "orphans")
        return { exitCode: 0, stdout: JSON.stringify([orphan]), stderr: "" };
      if (args[0] === "semantic" || args[0] === "find")
        return { exitCode: 0, stdout: JSON.stringify([orphan]), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: `unknown ${args[0]}` };
    },
  };
}

const unavailable: CodemapDeps = {
  isAvailable: async () => false,
  exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
};

describe("scaffoldCommand --from-codemap (feature 6)", () => {
  it("pre-fills coversSymbol from an untested codemap entrypoint", async () => {
    const name = `form_submit_${Date.now()}`;
    await scaffoldCommand(
      name,
      {
        intent: "the form submit handler posts valid entries",
        out: outDir,
        fromCodemap: "handleSubmit",
      },
      fakeCodemap(),
    );

    const yaml = await readFile(join(outDir, `${name}.yml`), "utf8");
    // The spec stub is already bound to coversSymbol.
    expect(yaml).toMatch(/coversSymbol:\s*handleSubmit/);
    // The header comment carries the signature + docstring provenance.
    expect(yaml).toContain("handleSubmit(e: Event): Promise<void>");
    expect(yaml).toContain("Validate then post the form entry to the API.");
    expect(yaml).toContain("src/forms/handler.ts:22");
  });

  it("uses the spec name as the query when --from-codemap has no value", async () => {
    // spec name "handleSubmit"-ish is snake_case-invalid, so use a name the
    // fake matches via the explicit query fallback path instead.
    const name = `entry_${Date.now()}`;
    await scaffoldCommand(
      name,
      {
        intent: "covers an untested entrypoint",
        out: outDir,
        fromCodemap: true,
      },
      fakeCodemap(),
    );
    const yaml = await readFile(join(outDir, `${name}.yml`), "utf8");
    // Orphans are returned regardless of query, so the first orphan binds.
    expect(yaml).toMatch(/coversSymbol:\s*handleSubmit/);
  });

  it("scaffolds without a binding when codemap is absent (best-effort)", async () => {
    const name = `no_codemap_${Date.now()}`;
    await scaffoldCommand(
      name,
      { intent: "no codemap available", out: outDir, fromCodemap: "login" },
      unavailable,
    );
    const yaml = await readFile(join(outDir, `${name}.yml`), "utf8");
    expect(yaml).not.toMatch(/coversSymbol:/);
  });

  it("scaffolds without a binding when --from-codemap is omitted", async () => {
    const name = `plain_${Date.now()}`;
    await scaffoldCommand(
      name,
      { intent: "plain scaffold", out: outDir },
      fakeCodemap(),
    );
    const yaml = await readFile(join(outDir, `${name}.yml`), "utf8");
    expect(yaml).not.toMatch(/coversSymbol:/);
  });
});

/* ---------------------------------------------------------------------------
 * scaffoldCommand `--from-risk` + selectRiskyUntestedEntrypoints (FEATURES item 9)
 *
 * `codemap read-order` ranks entrypoints; `codemap risk` flags which are
 * untested + load-bearing. `--from-risk --top N` scaffolds N stubs bound to
 * the highest-risk untested entrypoints.
 * ------------------------------------------------------------------------- */
function riskFakeCodemap(): CodemapDeps {
  // read-order returns 3 entrypoints; risk makes handleSubmit the riskiest untested one.
  const entries = [
    {
      rank: 1,
      symbol: "handleSubmit",
      kind: "handler",
      file: "src/forms.ts",
      start_line: 5,
      score: 0.9,
      in_degree: 6,
      entrypoint: true,
      reason: "central",
    },
    {
      rank: 2,
      symbol: "renderPage",
      kind: "view",
      file: "src/view.ts",
      start_line: 1,
      score: 0.5,
      in_degree: 2,
      entrypoint: true,
      reason: "leaf",
    },
    {
      rank: 3,
      symbol: "util",
      kind: "helper",
      file: "src/util.ts",
      start_line: 1,
      score: 0.1,
      in_degree: 0,
      entrypoint: false,
      reason: "",
    },
  ];
  const risk: Record<string, { score: number; level: string; tests: number }> =
    {
      handleSubmit: { score: 0.93, level: "high", tests: 0 },
      renderPage: { score: 0.3, level: "medium", tests: 2 }, // has covering tests -> filtered out
      util: { score: 0.05, level: "low", tests: 0 },
    };
  return {
    isAvailable: async () => true,
    async exec(args) {
      if (args[0] === "read-order")
        return {
          exitCode: 0,
          stdout: JSON.stringify({ entries, indexed: true }),
          stderr: "",
        };
      if (args[0] === "risk") {
        const sym = args[1] ?? "";
        const r = risk[sym] ?? { score: 0, level: "low", tests: 0 };
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            symbol: sym,
            found: true,
            score: r.score,
            level: r.level,
            callers: 0,
            covering_tests: r.tests,
            factors: [],
          }),
          stderr: "",
        };
      }
      return { exitCode: 1, stdout: "", stderr: `unknown ${args[0]}` };
    },
  };
}

describe("selectRiskyUntestedEntrypoints (item 9)", () => {
  it("returns entrypoints with no covering tests, sorted by risk desc", async () => {
    const sel = await selectRiskyUntestedEntrypoints(riskFakeCodemap(), 3);
    // renderPage is tested (covering_tests=2) -> excluded; util is not an entrypoint -> excluded.
    const syms = sel.map((e) => e.symbol);
    expect(syms).toEqual(["handleSubmit"]);
    expect(sel[0]!.riskScore).toBeCloseTo(0.93, 5);
    expect(sel[0]!.riskLevel).toBe("high");
    expect(sel[0]!.coveringTests).toBe(0);
  });

  it("returns [] when codemap is absent", async () => {
    const sel = await selectRiskyUntestedEntrypoints(unavailable, 3);
    expect(sel).toEqual([]);
  });
});

describe("scaffoldCommand --from-risk (item 9)", () => {
  it("writes a stub per risky untested entrypoint, bound to coversSymbol", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairntrace-risk-scaffold-"));
    try {
      await scaffoldCommand(
        "ignored_name",
        {
          intent: "cover the riskiest untested entrypoints",
          out: dir,
          fromRisk: true,
          top: 3,
        },
        riskFakeCodemap(),
      );
      const files = (await readdir(dir)).filter((f) => f.endsWith(".yml"));
      expect(files).toContain("handle_submit.yml");
      // renderPage was tested -> no stub for it.
      expect(files).not.toContain("render_page.yml");
      const yaml = await readFile(join(dir, "handle_submit.yml"), "utf8");
      expect(yaml).toMatch(/coversSymbol:\s*handleSubmit/);
      expect(yaml).toContain("risk high");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("writes nothing and reports when no untested entrypoints are found", async () => {
    const dir = await mkdtemp(
      join(tmpdir(), "cairntrace-risk-scaffold-empty-"),
    );
    try {
      await scaffoldCommand(
        "x",
        { intent: "none", out: dir, fromRisk: true, top: 3 },
        unavailable,
      );
      const files = (await readdir(dir)).filter((f) => f.endsWith(".yml"));
      expect(files).toEqual([]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
