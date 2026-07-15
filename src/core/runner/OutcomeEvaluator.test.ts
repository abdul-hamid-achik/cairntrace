import { describe, expect, it } from "vitest";
import type {
  BrowserBackend,
  InvocationResult,
} from "../../adapters/browserBackend";
import type { Outcome } from "../schema/spec.v1";
import { evaluateOutcomes, type EvaluatedOutcome } from "./OutcomeEvaluator";
import type { VerifierContext } from "./verifiers/types";

/**
 * OutcomeEvaluator is the dispatch hub: each outcome's verifier is routed to
 * its evaluator, with two dispatcher-specific behaviors on top of routing —
 * the failed-step "blocked" short-circuit and the throw-catch guard. These
 * tests cover the dispatcher contract; each evaluator's matcher logic is
 * exercised in verifiers.test.ts and the per-verifier suites.
 */
describe("evaluateOutcomes (dispatcher)", () => {
  function mockBackend(
    overrides: Partial<BrowserBackend> = {},
  ): BrowserBackend {
    const base: BrowserBackend = {
      name: "mock",
      runStep: async () => ok(),
      snapshot: async () => ({ ok: true, text: "", durationMs: 0 }),
      screenshot: async () => ({ ok: true, path: "", durationMs: 0 }),
      getUrl: async () => "https://app.example.com/dashboard",
      getTitle: async () => "Dashboard",
      getText: async () => "Welcome back, Ada",
      getCount: async () => 3,
      getNetworkRequests: async () => [
        {
          method: "POST",
          url: "https://app.example.com/api/save",
          status: 200,
          requestHeaders: {},
          responseHeaders: {},
          responseBody: "",
        },
      ],
      clearNetworkLog: async () => undefined,
      getConsole: async () => [],
      clearConsole: async () => undefined,
      getErrors: async () => [],
      evaluate: async (js: string) => {
        // httpJson fetches via evaluate; the fetch script returns
        // { status, ok, body }. The script verifier returns { ok, evidence }.
        if (js.includes("credentials")) {
          return okWithStdout(
            JSON.stringify({ status: 200, ok: true, body: { score: 42 } }),
          );
        }
        return okWithStdout(
          JSON.stringify({ ok: true, evidence: { score: 42 } }),
        );
      },
      saveState: async () => ok(),
      loadState: async () => ok(),
      clearBrowserState: async () => undefined,
      close: async () => ok(),
      ...overrides,
    };
    return base as BrowserBackend;
  }

  it("routes text → evaluateText (passed when the needle is present)", async () => {
    const r = await eval1(
      [outcome("t", { text: { contains: "Ada" } })],
      mockBackend(),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(true);
    expect(r.evaluation.actual).toContain("match found");
  });

  it("routes notText → evaluateNotText (passed when the needle is absent)", async () => {
    const r = await eval1(
      [outcome("nt", { notText: { contains: "Error" } })],
      mockBackend({ getText: async () => "All good" }),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(true);
  });

  it("routes url → evaluateUrl", async () => {
    const r = await eval1(
      [outcome("u", { url: { endsWith: "/dashboard" } })],
      mockBackend(),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(true);
    expect(r.evaluation.expected).toContain("endsWith");
  });

  /**
   * A backend that cannot read the page must never produce a passing outcome.
   * Every verifier below asserts the ABSENCE of something (no errors, no text,
   * no matching elements), so a backend that degrades a failed read to a falsy
   * value ("" / 0 / []) satisfies the assertion vacuously. These outcomes are
   * evaluated after the steps already succeeded, so nothing else in the run
   * would flag the lie — the green would be the only thing the user sees.
   */
  it("console.errorsMax does not pass when the backend cannot read errors", async () => {
    const r = await eval1(
      [outcome("c", { console: { errorsMax: 0 } })],
      mockBackend({
        getErrors: async () => {
          throw new Error("could not read page errors: daemon unreachable");
        },
      }),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(false);
    expect(r.evaluation.actual).toContain("daemon unreachable");
  });

  it("notText does not report 'confirmed absent' when the backend cannot read text", async () => {
    const r = await eval1(
      [outcome("nt", { notText: { contains: "Error" } })],
      mockBackend({
        getText: async () => {
          throw new Error('could not read text from "page": timeout');
        },
      }),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(false);
    expect(r.evaluation.actual).not.toContain("confirmed absent");
  });

  it("count.equals:0 does not pass when the backend cannot count", async () => {
    const r = await eval1(
      [outcome("ct", { count: { selector: ".row", equals: 0 } })],
      mockBackend({
        getCount: async () => {
          throw new Error('could not count elements matching ".row": timeout');
        },
      }),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(false);
    expect(r.evaluation.actual).not.toContain("observed 0 element");
  });

  it("noFailedRequests does not pass when the backend cannot read the network log", async () => {
    const r = await eval1(
      [outcome("nf", { noFailedRequests: { urlContains: "/api/" } })],
      mockBackend({
        getNetworkRequests: async () => {
          throw new Error(
            "could not read network requests: daemon unreachable",
          );
        },
      }),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(false);
    expect(r.evaluation.actual).not.toContain("no matching requests observed");
  });

  it("routes console → evaluateConsole (errorsMax budget)", async () => {
    const good = await eval1(
      [outcome("c", { console: { errorsMax: 0 } })],
      mockBackend(),
      ctx(),
    );
    expect(good.evaluation.passed).toBe(true);

    const bad = await eval1(
      [outcome("c", { console: { errorsMax: 0 } })],
      mockBackend({ getErrors: async () => [{ type: "error", text: "boom" }] }),
      ctx(),
    );
    expect(bad.evaluation.passed).toBe(false);
    expect(bad.evaluation.actual).toContain("1 error");
  });

  it("routes count → evaluateCount", async () => {
    const r = await eval1(
      [outcome("n", { count: { selector: "tr", equals: 3 } })],
      mockBackend(),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(true);
  });

  it("routes network → evaluateNetwork", async () => {
    const r = await eval1(
      [
        outcome("net", {
          network: {
            method: "POST",
            urlContains: "/api/save",
            status: { in: [200, 201] },
          },
        }),
      ],
      mockBackend(),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(true);
  });

  it("routes noFailedRequests → evaluateNoFailedRequests", async () => {
    const r = await eval1(
      [outcome("nfr", { noFailedRequests: { urlContains: "/api/" } })],
      mockBackend(),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(true);
  });

  it("routes httpJson → evaluateHttpJson (fetches via backend.evaluate)", async () => {
    const r = await eval1(
      [
        outcome("hj", {
          httpJson: { url: "/api/score", jsonPath: "$.score", equals: 42 },
        }),
      ],
      mockBackend(),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(true);
  });

  it("routes script → evaluateScript", async () => {
    const r = await eval1(
      [
        outcome("s", {
          script: { run: "return cairn.run.assert(true, { ok: true });" },
        }),
      ],
      mockBackend(),
      ctx(),
    );
    // The mock evaluate returns { ok: true, evidence: { score: 42 } }.
    expect(r.evaluation.passed).toBe(true);
  });

  it("routes process → evaluateProcess (skipped when no sampler ran)", async () => {
    const r = await eval1(
      [outcome("p", { process: { peakRss: { below: 500 } } })],
      mockBackend(),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(false);
    expect(r.evaluation.skipped).toBe(true);
    expect(r.evaluation.actual).toMatch(/no sampler ran|--monitor/i);
  });

  it("process verifier passes when metrics satisfy the budget", async () => {
    const r = await eval1(
      [outcome("p", { process: { peakRss: { below: 500 } } })],
      mockBackend(),
      ctx({
        processMetrics: {
          pid: 1234,
          samples: [],
          peakRssBytes: 100 * 1024 * 1024,
          meanRssBytes: 80 * 1024 * 1024,
          finalRssBytes: 70 * 1024 * 1024,
          peakCpuPercent: 10,
          meanCpuPercent: 5,
          tree: [],
          durationMs: 1000,
          startedAt: "2026-01-01T00:00:00.000Z",
          endedAt: "2026-01-01T00:00:01.000Z",
        },
      }),
    );
    expect(r.evaluation.passed).toBe(true);
  });

  it("short-circuits to skipped when a failed step blocked the artifact a verifier references", async () => {
    const r = await eval1(
      [
        outcome("dl", {
          // References an artifact that the failed step never produced.
          xlsx: {
            path: "${artifacts.template.path}",
            sheets: [{ name: "Sheet1", contains: ["x"] }],
          },
        }),
      ],
      mockBackend(),
      ctx({ failedStep: "download_template" }),
    );
    expect(r.evaluation.passed).toBe(false);
    expect(r.evaluation.skipped).toBe(true);
    expect(r.evaluation.expected).toMatch(/artifacts\.template/);
  });

  it("catches a verifier that throws and returns a failure (not a crash)", async () => {
    const r = await eval1(
      [outcome("boom", { text: { contains: "x" } })],
      mockBackend({
        getText: async () => {
          throw new Error("backend exploded");
        },
      }),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(false);
    expect(r.evaluation.actual).toContain("verifier threw");
    expect(r.evaluation.actual).toContain("backend exploded");
  });

  it("returns an unrecognized-shape failure for a verifier the union does not cover", async () => {
    // Bypass the schema by casting — the dispatcher must defend against this.
    const r = await eval1(
      [outcome("???", { bogusKey: {} } as unknown as Outcome["verify"])],
      mockBackend(),
      ctx(),
    );
    expect(r.evaluation.passed).toBe(false);
    expect(r.evaluation.actual).toContain("unrecognized verifier shape");
    expect(r.evaluation.actual).toContain("bogusKey");
  });
});

/* ----- test helpers (module scope — no describe captures) ----- */
function ctx(overrides: Partial<VerifierContext> = {}): VerifierContext {
  return { ...overrides };
}

function outcome(id: string, verify: unknown): Outcome {
  return { id, description: id, verify: verify as Outcome["verify"] };
}

/** Run a single-outcome evaluation and return its (defined) result. */
async function eval1(
  outcomes: Outcome[],
  backend: BrowserBackend,
  c: VerifierContext,
): Promise<EvaluatedOutcome> {
  const results = await evaluateOutcomes(outcomes, backend, c);
  expect(results).toHaveLength(outcomes.length);
  // noUncheckedIndexedAccess: assert the first element is present.
  return results[0] as EvaluatedOutcome;
}

function ok(): InvocationResult {
  return {
    ok: true,
    stdout: "",
    stderr: "",
    exitCode: 0,
    durationMs: 0,
    argv: [],
  };
}

function okWithStdout(stdout: string): InvocationResult {
  return { ...ok(), stdout };
}
