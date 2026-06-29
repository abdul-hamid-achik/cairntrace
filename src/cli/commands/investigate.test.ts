import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type CodeMatch,
  annotateCallPath,
  gatherFailureContext,
  rankCodeMatches,
  reconstructFailureTrace,
} from "./investigate";
import type { CodemapDeps } from "./annotate.js";

describe("investigate module", () => {
  it("CodeMatch interface is structurally correct", () => {
    const match: CodeMatch = {
      file: "src/auth/login.ts",
      line: 42,
      score: 0.89,
      snippet: "handleSubmit",
    };
    expect(match.file).toBe("src/auth/login.ts");
    expect(match.line).toBe(42);
    expect(match.score).toBe(0.89);
    expect(match.snippet).toBe("handleSubmit");
  });

  it("CodeMatch without snippet is valid", () => {
    const match: CodeMatch = {
      file: "src/router.ts",
      line: 15,
      score: 0.72,
    };
    expect(match.snippet).toBeUndefined();
  });

  it("CodeMatch carries the codemap ranking fields (item 3)", () => {
    const match: CodeMatch = {
      file: "src/api/client.ts",
      line: 10,
      score: 0.7,
      symbol: "apiPost",
      callers: 8,
      blastRadius: 12,
      codemapScore: 1.0,
    };
    expect(match.symbol).toBe("apiPost");
    expect(match.callers).toBe(8);
    expect(match.blastRadius).toBe(12);
    expect(match.codemapScore).toBe(1.0);
  });
});

/* ---------------------------------------------------------------------------
 * gatherFailureContext + rankCodeMatches — codemap structural re-ranking
 * (FEATURES item 3)
 *
 * A fake `CodemapDeps` substitutes for the `codemap` subprocess so the
 * re-ranking and graceful degradation are verified deterministically — no
 * dependency on codemap being installed.
 * ------------------------------------------------------------------------- */

describe("gatherFailureContext", () => {
  it("reads failed-outcome evidence + failing network URLs from a run dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-investigate-ctx-"));
    try {
      writeFileSync(
        join(dir, "run.json"),
        JSON.stringify({
          $schema: "urn:cairntrace.dev:run:v1",
          version: "1",
          runId: "r1",
          runDir: dir,
          spec: { name: "login", path: "/tmp/login.yml", contractHash: "h1" },
          environment: "local",
          backend: "agent-browser",
          coldStart: false,
          status: "failed",
          startedAt: "2026-06-25T00:00:00.000Z",
          endedAt: "2026-06-25T00:00:05.000Z",
          durationMs: 5000,
          outcomes: [
            { id: "page-loads", status: "passed" },
            {
              id: "redirect-check",
              status: "failed",
              evidence: "outcomes/redirect-check.md",
            },
          ],
          steps: [],
          artifacts: {
            agentContext: "agent_context.md",
            events: "events.ndjson",
          },
          exitCode: 1,
        }),
      );
      mkdirSync(join(dir, "outcomes"), { recursive: true });
      writeFileSync(
        join(dir, "outcomes/redirect-check.md"),
        "expected redirect to /dashboard but stayed on /login",
      );
      // ndjson: one failed request + one passing (only failed file is read).
      mkdirSync(join(dir, "network"), { recursive: true });
      writeFileSync(
        join(dir, "network/failed_requests.ndjson"),
        [
          JSON.stringify({
            url: "https://app.test/api/inventory",
            status: 500,
          }),
          JSON.stringify({ url: "https://app.test/api/users", status: 502 }),
        ].join("\n") + "\n",
      );

      const ctx = await gatherFailureContext(dir);
      expect(ctx.failingText).toContain("/dashboard");
      expect(ctx.failingText).toContain("/login");
      expect(ctx.failingUrls).toEqual([
        "https://app.test/api/inventory",
        "https://app.test/api/users",
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns empty context when run.json is missing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cairn-investigate-empty-"));
    try {
      const ctx = await gatherFailureContext(dir);
      expect(ctx.failingText).toBe("");
      expect(ctx.failingUrls).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/** A fake codemap that knows about three symbols across three files. */
function fakeCodemap(): CodemapDeps {
  const symbolByFile: Record<string, string> = {
    "src/auth/login.ts": "login",
    "src/api/client.ts": "apiPost",
    "src/ui/button.ts": "Button",
  };
  const centrality: Record<string, number> = {
    login: 0.2,
    apiPost: 0.95,
    Button: 0.1,
  };
  const callers: Record<string, number> = { login: 1, apiPost: 8, Button: 0 };
  const blast: Record<string, number> = { login: 2, apiPost: 12, Button: 1 };

  const dispatch: Record<string, (args: string[]) => unknown> = {
    hotspots: () => [
      { symbol: "login", file: "src/auth/login.ts", score: centrality.login },
      {
        symbol: "apiPost",
        file: "src/api/client.ts",
        score: centrality.apiPost,
      },
      { symbol: "Button", file: "src/ui/button.ts", score: centrality.Button },
    ],
    "symbol-at": (args) => {
      const loc = args[1] ?? "";
      const file = loc.split(":")[0]!;
      return { symbol: symbolByFile[file] };
    },
    callers: (args) => ({ depth: callers[args[1] ?? ""] ?? 0, callers: [] }),
    impact: (args) => ({ blastRadius: blast[args[1] ?? ""] ?? 0 }),
    // semantic + find only surface the failing-call-path symbol.
    semantic: () => [
      { symbol: "apiPost", file: "src/api/client.ts", line: 10 },
    ],
    find: () => [{ symbol: "apiPost", file: "src/api/client.ts", line: 10 }],
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

describe("rankCodeMatches", () => {
  const fcheapMatches: CodeMatch[] = [
    { file: "src/auth/login.ts", line: 42, score: 0.9 }, // high search score, low centrality
    { file: "src/api/client.ts", line: 10, score: 0.7 }, // the failing call path
    { file: "src/ui/button.ts", line: 3, score: 0.5 }, // low everything
  ];

  it("re-ranks by codemapScore so the failing-call-path hit floats to the top", async () => {
    const ctx = {
      failingText: "redirect failed",
      failingUrls: ["https://app.test/api/inventory"],
    };
    const ranked = await rankCodeMatches(fcheapMatches, ctx, fakeCodemap());

    // Sorted by codemapScore desc.
    const scores = ranked.map((m) => m.codemapScore);
    expect(scores).toHaveLength(3);
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]!);
    }

    // Top hit is the failing call path (apiPost), not the highest search score.
    expect(ranked[0]!.file).toBe("src/api/client.ts");
    expect(ranked[0]!.line).toBe(10);
    expect(ranked[0]!.symbol).toBe("apiPost");
    expect(ranked[0]!.callers).toBe(8);
    expect(ranked[0]!.blastRadius).toBe(12);
    expect(ranked[0]!.codemapScore).toBeCloseTo(1.0, 5);

    // Every match carries the codemap ranking fields.
    for (const m of ranked) {
      expect(m.symbol).toBeDefined();
      expect(typeof m.callers).toBe("number");
      expect(typeof m.blastRadius).toBe("number");
      expect(typeof m.codemapScore).toBe("number");
    }

    // Original search score is preserved untouched.
    expect(ranked.find((m) => m.file === "src/auth/login.ts")!.score).toBe(0.9);
  });

  it("falls back to the original ranking when codemap is absent (no regression)", async () => {
    const missing: CodemapDeps = {
      isAvailable: async () => false,
      exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
    };
    const ctx = { failingText: "x", failingUrls: [] };
    const ranked = await rankCodeMatches(fcheapMatches, ctx, missing);
    // Unchanged order + no codemap fields attached.
    expect(ranked.map((m) => `${m.file}:${m.line}`)).toEqual([
      "src/auth/login.ts:42",
      "src/api/client.ts:10",
      "src/ui/button.ts:3",
    ]);
    for (const m of ranked) {
      expect(m.codemapScore).toBeUndefined();
      expect(m.symbol).toBeUndefined();
    }
  });

  it("returns empty input unchanged", async () => {
    const ranked = await rankCodeMatches(
      [],
      { failingText: "", failingUrls: [] },
      fakeCodemap(),
    );
    expect(ranked).toEqual([]);
  });
});

/* ---------------------------------------------------------------------------
 * reconstructFailureTrace + annotateCallPath — call-path annotations
 * (FEATURES item 4)
 *
 * A failing run yields a 3-symbol trace (handleSubmit → validateEmail →
 * api.post). `reconstructFailureTrace` derives the chain from `codemap callers`
 * edges among the ranked matches; `annotateCallPath` emits one codemap path
 * annotation per edge via the CodemapDeps seam. Best-effort: codemap absent →
 * graceful skip, no crash.
 * ------------------------------------------------------------------------- */

/** Fake codemap whose `callers` returns the inbound caller symbol names. */
function fakeCodemapWithTrace(): CodemapDeps {
  // Call graph: handleSubmit → validateEmail → apiPost.
  const callersOf: Record<string, string[]> = {
    handleSubmit: [],
    validateEmail: ["handleSubmit"],
    apiPost: ["validateEmail"],
  };
  const dispatch: Record<string, (args: string[]) => unknown> = {
    callers: (args) =>
      (callersOf[args[1] ?? ""] ?? []).map((c) => ({ symbol: c })),
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

const traceMatches: CodeMatch[] = [
  {
    file: "src/forms/handler.ts",
    line: 22,
    score: 0.7,
    symbol: "handleSubmit",
  },
  {
    file: "src/forms/validate.ts",
    line: 8,
    score: 0.6,
    symbol: "validateEmail",
  },
  { file: "src/api/client.ts", line: 40, score: 0.5, symbol: "apiPost" },
];

describe("reconstructFailureTrace", () => {
  it("builds the entry→failure chain from codemap callers edges", async () => {
    const trace = await reconstructFailureTrace(
      traceMatches,
      fakeCodemapWithTrace(),
    );
    // 3 symbols → a 3-node chain.
    expect(trace).toEqual(["handleSubmit", "validateEmail", "apiPost"]);
  });

  it("returns [] when fewer than two matches have resolved symbols", async () => {
    const trace = await reconstructFailureTrace(
      [{ file: "a.ts", line: 1, score: 1, symbol: "onlyOne" }],
      fakeCodemapWithTrace(),
    );
    expect(trace).toEqual([]);
  });

  it("returns [] when codemap is absent (graceful, no crash)", async () => {
    const missing: CodemapDeps = {
      isAvailable: async () => false,
      exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
    };
    const trace = await reconstructFailureTrace(traceMatches, missing);
    expect(trace).toEqual([]);
  });

  it("returns [] when no edges connect the candidates", async () => {
    // callers never reference another candidate → no chain.
    const noEdges: CodemapDeps = {
      isAvailable: async () => true,
      async exec(args) {
        if (args[0] === "callers")
          return { exitCode: 0, stdout: "[]", stderr: "" };
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    };
    const trace = await reconstructFailureTrace(traceMatches, noEdges);
    expect(trace).toEqual([]);
  });
});

describe("annotateCallPath", () => {
  it("emits one path annotation per edge with stashId in the data payload", async () => {
    const calls: string[][] = [];
    const fake: CodemapDeps = {
      isAvailable: async () => true,
      async exec(args) {
        calls.push(args);
        return { exitCode: 0, stdout: JSON.stringify({ id: 1 }), stderr: "" };
      },
    };
    const trace = ["handleSubmit", "validateEmail", "apiPost"];
    const out = await annotateCallPath(
      trace,
      "run-abc",
      { stashId: "stash-123" },
      fake,
    );

    // 3 symbols → 2 edges → 2 path annotations.
    expect(out.annotated).toBe(2);
    expect(out.skipped).toBe(0);
    expect(calls).toHaveLength(2);

    // First edge: handleSubmit → validateEmail.
    const a0 = calls[0]!;
    expect(a0[0]).toBe("annotate");
    expect(a0[1]).toBe("handleSubmit");
    expect(a0[2]).toBe("validateEmail");
    expect(a0).toContain("cairntrace");
    const d0 = JSON.parse(a0[a0.indexOf("--data") + 1]!);
    expect(d0).toMatchObject({
      runId: "run-abc",
      stashId: "stash-123",
      from: "handleSubmit",
      to: "validateEmail",
      edge: "handleSubmit->validateEmail",
      traceLength: 3,
    });

    // Second edge: validateEmail → apiPost.
    const a1 = calls[1]!;
    expect(a1[1]).toBe("validateEmail");
    expect(a1[2]).toBe("apiPost");
  });

  it("is a graceful no-op when codemap is absent (no crash)", async () => {
    const missing: CodemapDeps = {
      isAvailable: async () => false,
      exec: async () => ({ exitCode: 127, stdout: "", stderr: "not found" }),
    };
    const out = await annotateCallPath(
      ["handleSubmit", "validateEmail", "apiPost"],
      "run-abc",
      {},
      missing,
    );
    expect(out.annotated).toBe(0);
    expect(out.skipped).toBe(1);
  });

  it("does nothing for a sub-2-symbol trace", async () => {
    const fake: CodemapDeps = {
      isAvailable: async () => true,
      exec: async () => ({ exitCode: 0, stdout: "{}", stderr: "" }),
    };
    const out = await annotateCallPath(["onlyOne"], "run-abc", {}, fake);
    expect(out.annotated).toBe(0);
  });
});
