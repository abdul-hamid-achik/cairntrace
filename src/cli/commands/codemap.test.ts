import { describe, expect, it } from "vitest";
import {
  codemapOrphans,
  codemapProjects,
  codemapReadOrder,
  codemapReview,
  codemapRisk,
  codemapSemantic,
  emptyRiskReport,
  expandSymbolQuery,
  parseJsonArray,
  parseJsonObject,
  parseReadOrderReport,
  parseReviewReport,
  parseRiskReport,
  pickBoolean,
  pickNumber,
  pickString,
  resolveCodemapSymbolForScaffold,
  toCodemapSymbol,
  type CodemapSymbol,
} from "./codemap.js";
import type { CodemapDeps } from "./annotate.js";

/* ---------------------------------------------------------------------------
 * Defensive parsers — tolerate alias field names, bare-array vs object-wrapped
 * output, and non-JSON input (never throw).
 * ------------------------------------------------------------------------- */

describe("codemap defensive parsers", () => {
  it("parseJsonArray handles bare arrays, { symbols: [...] }, and bad input", () => {
    expect(parseJsonArray('["a","b"]')).toEqual(["a", "b"]);
    expect(parseJsonArray('{"symbols":[{"x":1}]}')).toEqual([{ x: 1 }]);
    expect(parseJsonArray('{"orphans":[]}')).toEqual([]);
    expect(parseJsonArray("not json")).toEqual([]);
    expect(parseJsonArray("")).toEqual([]);
  });

  it("parseJsonObject returns {} on non-object / bad input", () => {
    expect(parseJsonObject('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonObject("[1,2]")).toEqual({});
    expect(parseJsonObject("nope")).toEqual({});
  });

  it("pickString / pickNumber find the first value under candidate keys", () => {
    expect(pickString({ name: "login" }, ["symbol", "name"])).toBe("login");
    expect(pickString({ symbol: "login" }, ["symbol", "name"])).toBe("login");
    expect(pickString({ x: "" }, ["symbol", "name"])).toBeUndefined();
    expect(pickNumber({ score: 0.9 }, ["centrality", "score"])).toBe(0.9);
    expect(pickNumber({ score: NaN }, ["score"])).toBeUndefined();
  });

  it("toCodemapSymbol coerces a row and drops it when no name is present", () => {
    expect(
      toCodemapSymbol({ symbol: "login", file: "a.ts", line: 12 }),
    ).toEqual({ symbol: "login", file: "a.ts", line: 12 });
    expect(toCodemapSymbol({ file: "a.ts" })).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * A fake codemap registry for items 5/6/7. Mirrors the CodemapDeps seam used
 * by merged items 2/3 — no dependence on codemap being on $PATH.
 * ------------------------------------------------------------------------- */

function fakeCodemap(): CodemapDeps {
  const symbols: CodemapSymbol[] = [
    {
      symbol: "handleSubmit",
      file: "src/forms/handler.ts",
      line: 22,
      signature: "handleSubmit(e: Event): Promise<void>",
      docstring: "Validate then post the form entry to the API.",
      kind: "handler",
    },
    {
      symbol: "validateEmail",
      file: "src/forms/validate.ts",
      line: 8,
      signature: "validateEmail(v: string): boolean",
      docstring: "RFC-ish email check used before submit.",
      kind: "function",
    },
    {
      symbol: "apiPost",
      file: "src/api/client.ts",
      line: 40,
      signature: "apiPost(url: string, body: unknown): Promise<Response>",
      docstring: "Thin fetch wrapper; throws on >= 400.",
      kind: "function",
    },
  ];

  // `orphans` reports the untested entrypoints — handleSubmit is uncovered.
  const orphans = [symbols[0]!];

  const dispatch: Record<string, (args: string[]) => unknown> = {
    semantic: (args) => {
      const q = (args[1] ?? "").toLowerCase();
      return symbols.filter((s) => s.symbol.toLowerCase().includes(q));
    },
    find: (args) => {
      const q = (args[1] ?? "").toLowerCase();
      return symbols.filter((s) => s.symbol.toLowerCase().includes(q));
    },
    orphans: () => orphans,
    projects: () => [
      {
        name: "myapp",
        path: "/repo/myapp",
        symbols: 4522,
        indexedAt: "2026-06-29T00:00:00Z",
      },
    ],
  };

  return {
    isAvailable: async () => true,
    async exec(args) {
      const cmd = args[0]!;
      const handler = dispatch[cmd];
      if (!handler)
        return { exitCode: 1, stdout: "", stderr: `unknown cmd ${cmd}` };
      return { exitCode: 0, stdout: JSON.stringify(handler(args)), stderr: "" };
    },
  };
}

const unavailable: CodemapDeps = {
  isAvailable: async () => false,
  exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
};

describe("codemapSemantic / orphans / projects", () => {
  it("semantic returns matching symbols (defensively parsed)", async () => {
    const syms = await codemapSemantic("apiPost", fakeCodemap());
    expect(syms).toHaveLength(1);
    expect(syms[0]!.symbol).toBe("apiPost");
    expect(syms[0]!.file).toBe("src/api/client.ts");
    expect(syms[0]!.signature).toContain("apiPost");
  });

  it("semantic returns [] when codemap is absent (graceful)", async () => {
    expect(await codemapSemantic("apiPost", unavailable)).toEqual([]);
  });

  it("orphans returns untested entrypoints", async () => {
    const orphans = await codemapOrphans(fakeCodemap());
    expect(orphans.map((o) => o.symbol)).toEqual(["handleSubmit"]);
  });

  it("projects returns the registry with symbol counts", async () => {
    const projects = await codemapProjects(fakeCodemap());
    expect(projects).toHaveLength(1);
    expect(projects[0]!.name).toBe("myapp");
    expect(projects[0]!.path).toBe("/repo/myapp");
    expect(projects[0]!.symbols).toBe(4522);
  });

  it("projects returns [] when codemap is absent", async () => {
    expect(await codemapProjects(unavailable)).toEqual([]);
  });
});

describe("expandSymbolQuery (feature 5)", () => {
  it("expands a symbol with file + signature + docstring excerpt", async () => {
    const terms = await expandSymbolQuery("apiPost", fakeCodemap());
    // Always includes the symbol itself.
    expect(terms).toContain("apiPost");
    // Plus the file and signature and a short docstring excerpt.
    expect(terms).toContain("src/api/client.ts");
    expect(terms.some((t) => t.includes("apiPost(url"))).toBe(true);
  });

  it("falls back to [symbol] when codemap is absent (no regression)", async () => {
    expect(await expandSymbolQuery("apiPost", unavailable)).toEqual([
      "apiPost",
    ]);
  });

  it("returns [] for an empty symbol", async () => {
    expect(await expandSymbolQuery("", fakeCodemap())).toEqual([]);
  });
});

describe("resolveCodemapSymbolForScaffold (feature 6)", () => {
  it("prefers an untested entrypoint (orphan) matching the query", async () => {
    const sym = await resolveCodemapSymbolForScaffold(
      "handleSubmit",
      fakeCodemap(),
    );
    expect(sym).toBeDefined();
    expect(sym!.symbol).toBe("handleSubmit");
    expect(sym!.signature).toContain("handleSubmit");
    expect(sym!.docstring).toContain("Validate then post");
  });

  it("falls back to a semantic match when no orphan matches", async () => {
    const sym = await resolveCodemapSymbolForScaffold("apiPost", fakeCodemap());
    expect(sym!.symbol).toBe("apiPost");
  });

  it("returns undefined when codemap is absent (best-effort)", async () => {
    expect(
      await resolveCodemapSymbolForScaffold("handleSubmit", unavailable),
    ).toBeUndefined();
  });
});

/* ---------------------------------------------------------------------------
 * codemapReview / codemapRisk / codemapReadOrder (FEATURES items 1, 8, 9)
 *
 * A fake codemap exercising the v0.19.0 review/risk/read-order JSON shapes
 * (alias field names + bare-array vs object-wrapped tolerated by the parsers).
 * ------------------------------------------------------------------------- */

function fakeReviewCodemap(): CodemapDeps {
  const review = {
    project: "myapp",
    mode: "since",
    since: "HEAD~1",
    indexed: true,
    is_repo: true,
    stale: false,
    changed_files: [
      {
        path: "src/forms/handler.ts",
        status: "modified",
        symbols: ["handleSubmit"],
      },
    ],
    changed_symbols: [{ symbol: "handleSubmit", file: "src/forms/handler.ts" }],
    blast_radius: [
      { symbol: "handleSubmit", file: "src/forms/handler.ts" },
      { symbol: "validateEmail", file: "src/forms/validate.ts" },
    ],
    covering_tests: [],
    untested: [{ symbol: "handleSubmit", file: "src/forms/handler.ts" }],
    hotspots: [],
  };
  const risk: Record<string, unknown> = {
    handleSubmit: {
      symbol: "handleSubmit",
      found: true,
      score: 0.93,
      level: "high",
      callers: 12,
      covering_tests: 0,
      factors: [
        { factor: "untested", severity: "high", detail: "no covering tests" },
      ],
    },
    validateEmail: {
      symbol: "validateEmail",
      found: true,
      score: 0.4,
      level: "medium",
      callers: 3,
      covering_tests: 2,
      factors: [],
    },
  };
  const readOrder = {
    project: "myapp",
    indexed: true,
    entries: [
      {
        rank: 1,
        symbol: "handleSubmit",
        kind: "handler",
        file: "src/forms/handler.ts",
        start_line: 22,
        score: 0.9,
        in_degree: 12,
        entrypoint: true,
        reason: "top entrypoint",
      },
      {
        rank: 2,
        symbol: "validateEmail",
        kind: "function",
        file: "src/forms/validate.ts",
        start_line: 8,
        score: 0.6,
        in_degree: 3,
        entrypoint: true,
        reason: "called by submit",
      },
      {
        rank: 3,
        symbol: "internal",
        kind: "function",
        file: "src/util.ts",
        start_line: 1,
        score: 0.1,
        in_degree: 1,
        entrypoint: false,
      },
    ],
  };
  return {
    isAvailable: async () => true,
    async exec(args) {
      const cmd = args[0]!;
      if (cmd === "review")
        return { exitCode: 0, stdout: JSON.stringify(review), stderr: "" };
      if (cmd === "risk")
        return {
          exitCode: 0,
          stdout: JSON.stringify(risk[args[1] ?? ""] ?? { found: false }),
          stderr: "",
        };
      if (cmd === "read-order")
        return { exitCode: 0, stdout: JSON.stringify(readOrder), stderr: "" };
      return { exitCode: 1, stdout: "", stderr: `unknown ${cmd}` };
    },
  };
}

describe("pickBoolean", () => {
  it("returns the first boolean under candidate keys", () => {
    expect(pickBoolean({ entrypoint: true }, ["entrypoint"])).toBe(true);
    expect(pickBoolean({ is_entry: false }, ["entrypoint", "is_entry"])).toBe(
      false,
    );
  });
  it("returns undefined when no boolean key matches", () => {
    expect(pickBoolean({ entrypoint: "yes" }, ["entrypoint"])).toBeUndefined();
    expect(pickBoolean(null, ["entrypoint"])).toBeUndefined();
  });
});

describe("parseReviewReport / codemapReview (feature 1)", () => {
  it("extracts blast-radius files + symbols from the v0.19.0 shape", () => {
    const r = parseReviewReport(
      JSON.stringify({
        blast_radius: [
          { symbol: "handleSubmit", file: "src/forms/handler.ts" },
          { symbol: "validateEmail", path: "src/forms/validate.ts" },
        ],
        changed_files: [{ path: "src/forms/handler.ts" }, "src/index.css"],
        changed_symbols: [{ name: "handleSubmit" }],
        indexed: true,
        stale: false,
      }),
    );
    expect(r.blastRadiusFiles).toEqual([
      "src/forms/handler.ts",
      "src/forms/validate.ts",
    ]);
    expect(r.blastRadiusSymbols).toEqual(["handleSubmit", "validateEmail"]);
    expect(r.changedFiles).toEqual(["src/forms/handler.ts", "src/index.css"]);
    expect(r.changedSymbols).toEqual(["handleSubmit"]);
    expect(r.indexed).toBe(true);
    expect(r.stale).toBe(false);
  });

  it("returns an empty report on non-JSON input", () => {
    const r = parseReviewReport("not json");
    expect(r.blastRadiusFiles).toEqual([]);
    expect(r.indexed).toBe(false);
  });

  it("codemapReview returns the report via the deps seam", async () => {
    const r = await codemapReview("HEAD~1", fakeReviewCodemap());
    expect(r.blastRadiusFiles).toContain("src/forms/handler.ts");
    expect(r.blastRadiusSymbols).toContain("handleSubmit");
    expect(r.indexed).toBe(true);
  });

  it("codemapReview degrades to empty when codemap is absent", async () => {
    const r = await codemapReview("HEAD~1", unavailable);
    expect(r.blastRadiusFiles).toEqual([]);
    expect(r.indexed).toBe(false);
  });

  it("codemapReview degrades to empty for a blank ref", async () => {
    const r = await codemapReview("", fakeReviewCodemap());
    expect(r.blastRadiusFiles).toEqual([]);
  });
});

describe("parseRiskReport / codemapRisk (feature 8)", () => {
  it("parses the v0.19.0 risk shape with alias field names", () => {
    const r = parseRiskReport(
      JSON.stringify({
        symbol: "handleSubmit",
        found: true,
        risk_score: 0.93,
        risk_level: "high",
        caller_count: 12,
        coveringTests: 0,
        factors: [{ name: "untested", severity: "high", description: "none" }],
        note: "hub",
      }),
      "handleSubmit",
    );
    expect(r.found).toBe(true);
    expect(r.score).toBeCloseTo(0.93, 5);
    expect(r.level).toBe("high");
    expect(r.callers).toBe(12);
    expect(r.coveringTests).toBe(0);
    expect(r.factors[0]!.factor).toBe("untested");
    expect(r.factors[0]!.detail).toBe("none");
    expect(r.note).toBe("hub");
  });

  it("maps an unknown level to 'unknown'", () => {
    const r = parseRiskReport(
      JSON.stringify({ found: true, score: 0.5, level: "critical" }),
      "x",
    );
    expect(r.level).toBe("unknown");
    expect(r.score).toBe(0.5);
  });

  it("returns an empty report on non-JSON input", () => {
    const r = parseRiskReport("oops", "handleSubmit");
    expect(r).toEqual(emptyRiskReport("handleSubmit"));
  });

  it("codemapRisk returns the report via the deps seam", async () => {
    const r = await codemapRisk("handleSubmit", fakeReviewCodemap());
    expect(r.found).toBe(true);
    expect(r.score).toBeCloseTo(0.93, 5);
    expect(r.level).toBe("high");
    expect(r.coveringTests).toBe(0);
  });

  it("codemapRisk degrades to an empty report when codemap is absent", async () => {
    const r = await codemapRisk("handleSubmit", unavailable);
    expect(r.found).toBe(false);
    expect(r.score).toBe(0);
    expect(r.level).toBe("unknown");
  });
});

describe("parseReadOrderReport / codemapReadOrder (feature 9)", () => {
  it("parses the v0.19.0 read-order shape, tolerating a bare array", () => {
    const r = parseReadOrderReport(
      JSON.stringify([
        {
          rank: 1,
          symbol: "handleSubmit",
          entrypoint: true,
          score: 0.9,
          in_degree: 5,
          file: "a.ts",
          start_line: 22,
        },
        { name: "internal", entrypoint: false },
      ]),
    );
    expect(r.entries).toHaveLength(2);
    expect(r.entries[0]!.symbol).toBe("handleSubmit");
    expect(r.entries[0]!.entrypoint).toBe(true);
    expect(r.entries[0]!.startLine).toBe(22);
    expect(r.entries[1]!.symbol).toBe("internal");
    expect(r.entries[1]!.entrypoint).toBe(false);
  });

  it("parses the object-wrapped form with entries[]", () => {
    const r = parseReadOrderReport(
      JSON.stringify({
        indexed: true,
        entries: [{ symbol: "handleSubmit", rank: 1, entrypoint: true }],
      }),
    );
    expect(r.entries).toHaveLength(1);
    expect(r.indexed).toBe(true);
  });

  it("returns empty on non-JSON input", () => {
    const r = parseReadOrderReport("nope");
    expect(r.entries).toEqual([]);
  });

  it("codemapReadOrder returns ranked entries via the deps seam", async () => {
    const r = await codemapReadOrder(fakeReviewCodemap());
    expect(r.entries).toHaveLength(3);
    expect(r.entries[0]!.symbol).toBe("handleSubmit");
    expect(r.entries[0]!.entrypoint).toBe(true);
    expect(r.entries.filter((e) => e.entrypoint)).toHaveLength(2);
  });

  it("codemapReadOrder degrades to empty when codemap is absent", async () => {
    const r = await codemapReadOrder(unavailable);
    expect(r.entries).toEqual([]);
  });
});
