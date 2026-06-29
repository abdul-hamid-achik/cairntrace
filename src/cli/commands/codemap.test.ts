import { describe, expect, it } from "vitest";
import {
  codemapOrphans,
  codemapProjects,
  codemapSemantic,
  expandSymbolQuery,
  parseJsonArray,
  parseJsonObject,
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
