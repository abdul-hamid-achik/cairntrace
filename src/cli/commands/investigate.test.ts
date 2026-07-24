import { describe, expect, it } from "vitest";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execa } from "execa";
import {
  type CodeMatch,
  annotateCallPath,
  auditResultExitCode,
  buildFcheapConnectArgs,
  gatherFailureContext,
  parseCodeMatches,
  pathIsWithin,
  rankCodeMatches,
  redactVidtraceTextArtifacts,
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

  it("normalizes the file.cheap v0.30 connect envelope", () => {
    expect(
      parseCodeMatches(
        JSON.stringify({
          stash_id: "stash-123",
          codebase: "/workspace/app",
          query: "login failure",
          index_status: "indexed",
          matches: [
            {
              stash_id: "stash-123",
              file: "src/auth/login.ts",
              line: 42,
              score: 0.89,
              text: "handleSubmit",
            },
          ],
        }),
      ),
    ).toEqual([
      {
        file: "src/auth/login.ts",
        line: 42,
        score: 0.89,
        snippet: "handleSubmit",
      },
    ]);
  });

  it("rejects malformed file.cheap connect output", () => {
    expect(() => parseCodeMatches('{"matches":[{"score":0.9}]}')).toThrow(
      /Invalid fcheap connect JSON/,
    );
  });

  it("forwards an explicit query to file.cheap connect", () => {
    expect(
      buildFcheapConnectArgs("stash-123", "/workspace/app", {
        mode: "keyword",
        limit: 5,
        query: "parseFcheapConnectOutput",
        index: true,
      }),
    ).toEqual([
      "connect",
      "stash-123",
      "/workspace/app",
      "--json",
      "--mode",
      "keyword",
      "--limit",
      "5",
      "--query",
      "parseFcheapConnectOutput",
      "--index",
    ]);
  });

  it("maps audit verdicts to stable process and MCP exit semantics", () => {
    const base = {
      $schema: "urn:cairntrace.dev:audit:v1" as const,
      version: "1" as const,
      specPath: "flows/login.yml",
      codeMatches: [],
    };
    expect(
      auditResultExitCode({
        ...base,
        status: "passed",
        exitCode: 0,
      }),
    ).toBe(0);
    expect(
      auditResultExitCode({
        ...base,
        status: "failed",
        exitCode: 1,
      }),
    ).toBe(1);
    expect(
      auditResultExitCode({
        ...base,
        status: "passed",
        exitCode: 0,
        error: "file.cheap contract failed",
      }),
    ).toBe(2);
  });

  it("keeps vidtrace bundles inside the run and redacts their text artifacts", async () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-vidtrace-redaction-"));
    const bundle = join(root, "videos", "vidtrace", "bundle");
    const nested = join(bundle, "transcript");
    const outside = join(root, "outside");
    const previousSecret = process.env.CAIRN_TEST_API_KEY;
    process.env.CAIRN_TEST_API_KEY = "vidtrace-secret-value";
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(bundle, "timeline.json"),
      '{"text":"vidtrace-secret-value"}',
    );
    writeFileSync(join(nested, "audio.txt"), "heard vidtrace-secret-value");
    writeFileSync(join(bundle, "frame.png"), "vidtrace-secret-value");

    try {
      expect(pathIsWithin(join(root, "videos", "vidtrace"), bundle)).toBe(true);
      expect(pathIsWithin(join(root, "videos", "vidtrace"), outside)).toBe(
        false,
      );
      await redactVidtraceTextArtifacts(bundle);
      expect(readFileSync(join(bundle, "timeline.json"), "utf8")).toContain(
        "[redacted]",
      );
      expect(readFileSync(join(nested, "audio.txt"), "utf8")).toContain(
        "[redacted]",
      );
      expect(readFileSync(join(bundle, "frame.png"), "utf8")).toContain(
        "vidtrace-secret-value",
      );
    } finally {
      if (previousSecret === undefined) {
        delete process.env.CAIRN_TEST_API_KEY;
      } else {
        process.env.CAIRN_TEST_API_KEY = previousSecret;
      }
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("cairn investigate CLI contract", () => {
  it("uses config defaults, forwards --query, and lets --codebase/--connect select connection", async () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-investigate-cli-"));
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run-smoke");
    const codebase = join(root, "codebase");
    const binDir = join(root, "bin");
    const argsFile = join(root, "fcheap-args.txt");
    const configPath = join(root, "cairntrace.config.yml");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(codebase, { recursive: true });
    mkdirSync(binDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), '{"status":"failed"}');
    writeFileSync(join(runDir, "agent_context.md"), "# Existing context\n");
    writeFileSync(
      configPath,
      [
        "version: 1",
        "environments: {}",
        "investigate:",
        "  codebaseDir: ./codebase",
        "  mode: keyword",
        "  limit: 7",
        "  index: true",
        "",
      ].join("\n"),
    );
    const fakeFcheap = join(binDir, "fcheap");
    writeFileSync(
      fakeFcheap,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FCHEAP_ARGS_FILE"
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'fcheap 0.30.0'
  exit 0
fi
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"stash-cli","status":"saved"}'
  exit 0
fi
if [ "$1" = "connect" ]; then
  printf '%s\\n' '{"stash_id":"stash-cli","codebase":"${codebase}","query":"custom query","matches":[{"stash_id":"stash-cli","file":"src/auth.ts","line":12,"score":0.9,"text":"auth failure"}]}'
  exit 0
fi
exit 2
`,
    );
    chmodSync(fakeFcheap, 0o755);

    try {
      const command = await execa(
        join(process.cwd(), "bin", "cairn"),
        [
          "investigate",
          "latest",
          "--artifact-root",
          runsRoot,
          "--config",
          configPath,
          "--connect",
          "--query",
          "custom query",
          "--json",
        ],
        {
          reject: false,
          env: {
            ...process.env,
            FCHEAP_BIN: fakeFcheap,
            FCHEAP_ARGS_FILE: argsFile,
            CAIRN_TEST_API_KEY: "auth failure",
          },
        },
      );

      expect(command.exitCode).toBe(0);
      expect(JSON.parse(command.stdout)).toMatchObject({
        runId: "run-smoke",
        stashId: "stash-cli",
        query: "custom query",
        mode: "keyword",
        codeMatches: [
          {
            file: "src/auth.ts",
            line: 12,
            score: 0.9,
            snippet: "[redacted]",
          },
        ],
      });
      expect(command.stdout).not.toContain("auth failure");
      const calls = readFileSync(argsFile, "utf8");
      expect(calls).toContain(
        `connect stash-cli ${codebase} --json --mode keyword --limit 7 --query custom query --index`,
      );
      expect(readFileSync(join(runDir, "investigate.json"), "utf8")).toContain(
        '"stashId": "stash-cli"',
      );
      expect(
        readFileSync(join(runDir, "investigate.json"), "utf8"),
      ).not.toContain("auth failure");
      const context = readFileSync(join(runDir, "agent_context.md"), "utf8");
      expect(context).toContain("## Code Matches");
      expect(context).toContain("src/auth.ts:12 (score: 0.90)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns exit 2 when file.cheap connect violates its JSON contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-investigate-invalid-"));
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run-invalid");
    const fakeFcheap = join(root, "fcheap");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), '{"status":"failed"}');
    writeFileSync(
      fakeFcheap,
      `#!/bin/sh
if [ "$1" = "--version" ]; then exit 0; fi
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"stash-invalid","status":"saved"}'
  exit 0
fi
if [ "$1" = "connect" ]; then
  printf '%s\\n' '{"matches":[{"stash_id":"stash-invalid","score":0.9,"text":"missing file"}]}'
  exit 0
fi
exit 2
`,
    );
    chmodSync(fakeFcheap, 0o755);

    try {
      const command = await execa(
        join(process.cwd(), "bin", "cairn"),
        [
          "investigate",
          "latest",
          "--artifact-root",
          runsRoot,
          "--codebase",
          root,
          "--json",
        ],
        {
          reject: false,
          env: { ...process.env, FCHEAP_BIN: fakeFcheap },
        },
      );
      expect(command.exitCode).toBe(2);
      expect(JSON.parse(command.stdout).error).toMatch(
        /Invalid fcheap connect JSON/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns an actionable exit 2 result when the codebase index is missing", async () => {
    const root = mkdtempSync(
      join(tmpdir(), "cairn-investigate-index-missing-"),
    );
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run-index-missing");
    const codebase = join(root, "codebase");
    const argsFile = join(root, "fcheap-args.txt");
    const fakeFcheap = join(root, "fcheap");
    mkdirSync(runDir, { recursive: true });
    mkdirSync(codebase, { recursive: true });
    writeFileSync(join(runDir, "run.json"), '{"status":"failed"}');
    writeFileSync(
      fakeFcheap,
      `#!/bin/sh
printf '%s\\n' "$*" >> "$FCHEAP_ARGS_FILE"
if [ "$1" = "--version" ]; then
  printf '%s\\n' 'fcheap 0.30.0'
  exit 0
fi
if [ "$1" = "save" ]; then
  printf '%s\\n' '{"id":"stash-index-missing","status":"saved"}'
  exit 0
fi
if [ "$1" = "connect" ]; then
  printf '%s\\n' '{"stash_id":"stash-index-missing","codebase":"${codebase}","query":"failed run","index_status":"missing","matches":[]}'
  exit 0
fi
exit 2
`,
    );
    chmodSync(fakeFcheap, 0o755);

    try {
      const command = await execa(
        join(process.cwd(), "bin", "cairn"),
        [
          "investigate",
          "latest",
          "--artifact-root",
          runsRoot,
          "--codebase",
          codebase,
          "--json",
        ],
        {
          reject: false,
          env: {
            ...process.env,
            FCHEAP_BIN: fakeFcheap,
            FCHEAP_ARGS_FILE: argsFile,
          },
        },
      );

      expect(command.exitCode).toBe(2);
      expect(JSON.parse(command.stdout)).toMatchObject({
        runId: "run-index-missing",
        stashId: "stash-index-missing",
        indexStatus: "missing",
        codeMatches: [],
        error: expect.stringContaining("rerun with --index"),
      });
      expect(command.stderr).toContain("rerun with --index");
      expect(readFileSync(argsFile, "utf8")).toContain(
        `connect stash-index-missing ${codebase} --json --mode hybrid --limit 10`,
      );
      expect(readFileSync(argsFile, "utf8")).not.toContain("--index");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns structured exit 2 results when investigate or audit setup fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "cairn-investigate-setup-error-"));
    const runsRoot = join(root, "runs");
    const runDir = join(runsRoot, "run-invalid-config");
    const invalidConfig = join(root, "cairntrace.config.yml");
    const missingSpec = join(root, "missing-spec.yml");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "run.json"), '{"status":"failed"}');
    writeFileSync(invalidConfig, "investigate:\n  mode: hybrid\n");

    try {
      const investigate = await execa(
        join(process.cwd(), "bin", "cairn"),
        [
          "investigate",
          "latest",
          "--artifact-root",
          runsRoot,
          "--config",
          invalidConfig,
          "--json",
        ],
        { reject: false },
      );
      expect(investigate.exitCode).toBe(2);
      expect(JSON.parse(investigate.stdout)).toMatchObject({
        runId: "latest",
        codeMatches: [],
        error: expect.stringContaining("Invalid literal value"),
      });
      rmSync(invalidConfig);

      const audit = await execa(
        join(process.cwd(), "bin", "cairn"),
        ["audit", missingSpec, "--json"],
        { reject: false },
      );
      expect(audit.exitCode).toBe(2);
      expect(JSON.parse(audit.stdout)).toMatchObject({
        specPath: missingSpec,
        codeMatches: [],
        error: expect.stringContaining("no such file or directory"),
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
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
    // Item 8: default risk is 0 for every symbol so the item-3 codemapScore
    // ranking (apiPost first) is unchanged; the item-8 test uses a risk-heavy fake.
    risk: (args) => ({
      symbol: args[1] ?? "",
      found: true,
      score: 0,
      level: "low",
      callers: 0,
      covering_tests: 0,
      factors: [],
    }),
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
 * rankByRisk — change-risk ranking (FEATURES item 8)
 *
 * `codemap risk` per candidate re-ranks so a load-bearing, untested hub floats
 * above the failing-call-path hit (which item 3 ranks first by centrality).
 * ------------------------------------------------------------------------- */
describe("rankCodeMatches — risk ranking (item 8)", () => {
  const matches: CodeMatch[] = [
    { file: "src/auth/login.ts", line: 42, score: 0.9 }, // untested hub
    { file: "src/api/client.ts", line: 10, score: 0.7 }, // failing call path
    { file: "src/ui/button.ts", line: 3, score: 0.5 },
  ];

  /** Fake codemap where `login` is a high-risk untested hub (risk 0.93). */
  function riskHeavyCodemap(): CodemapDeps {
    const base = fakeCodemap();
    const riskBySymbol: Record<
      string,
      { score: number; level: string; tests: number }
    > = {
      login: { score: 0.93, level: "high", tests: 0 },
      apiPost: { score: 0.4, level: "medium", tests: 2 },
      Button: { score: 0.1, level: "low", tests: 1 },
    };
    return {
      isAvailable: async () => true,
      async exec(args) {
        if (args[0] === "risk") {
          const sym = args[1] ?? "";
          const r = riskBySymbol[sym] ?? { score: 0, level: "low", tests: 0 };
          return {
            exitCode: 0,
            stdout: JSON.stringify({
              symbol: sym,
              found: true,
              score: r.score,
              level: r.level,
              callers: 0,
              covering_tests: r.tests,
              factors: [{ factor: "untested", severity: r.score, detail: "" }],
            }),
            stderr: "",
          };
        }
        return base.exec(args);
      },
    };
  }

  it("ranks a high-risk untested hub first, ahead of the failing call path", async () => {
    const ranked = await rankCodeMatches(
      matches,
      {
        failingText: "redirect failed",
        failingUrls: ["https://app.test/api/inventory"],
      },
      riskHeavyCodemap(),
    );
    // login (risk 0.93, high) floats above apiPost (risk 0.4) despite apiPost's
    // higher codemapScore — risk is the primary sort key.
    expect(ranked[0]!.symbol).toBe("login");
    expect(ranked[0]!.riskScore).toBeCloseTo(0.93, 5);
    expect(ranked[0]!.riskLevel).toBe("high");
    expect(ranked[1]!.symbol).toBe("apiPost");
    expect((ranked[1]!.riskScore ?? 0) < (ranked[0]!.riskScore ?? 0)).toBe(
      true,
    );
    // Every resolved match carries risk fields.
    for (const m of ranked) {
      if (m.symbol) expect(typeof m.riskScore).toBe("number");
    }
  });

  it("leaves risk fields undefined when codemap is absent (no regression)", async () => {
    const absent: CodemapDeps = {
      isAvailable: async () => false,
      async exec() {
        return { exitCode: 1, stdout: "", stderr: "" };
      },
    };
    const ranked = await rankCodeMatches(
      matches,
      { failingText: "", failingUrls: [] },
      absent,
    );
    for (const m of ranked) {
      expect(m.riskScore).toBeUndefined();
      expect(m.riskLevel).toBeUndefined();
    }
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
