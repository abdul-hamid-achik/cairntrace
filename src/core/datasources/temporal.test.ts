import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { evaluateOutcomes } from "../runner/OutcomeEvaluator";
import { OutcomeSchema, type Outcome } from "../schema/spec.v1";
import { resolveEnvironmentDatasources } from "./resolve";
import { DatasourcesConfigSchema } from "./schema";
import { historyFacts, openTemporalSource } from "./temporal";

/* ----- a fake Temporal UI / HTTP API ----- */

const b64 = (value: unknown): string =>
  Buffer.from(JSON.stringify(value)).toString("base64");

const RUN1 = "run-1";
const RUN2 = "run-2";

/** order-42: run-1 (two history pages) continued as new into run-2. */
const HISTORY: Record<string, Array<{ events: unknown[]; next?: string }>> = {
  [RUN1]: [
    {
      events: [
        {
          eventId: "1",
          workflowExecutionStartedEventAttributes: {
            input: {
              payloads: [{ data: b64({ orderId: 42, items: [1, 2] }) }],
            },
          },
        },
        {
          eventId: "5",
          activityTaskScheduledEventAttributes: {
            activityType: { name: "reserveStock" },
          },
        },
        {
          eventId: "6",
          activityTaskStartedEventAttributes: {
            scheduledEventId: "5",
            attempt: 2,
          },
        },
      ],
      next: "page-2",
    },
    {
      events: [
        {
          eventId: "7",
          activityTaskCompletedEventAttributes: { scheduledEventId: "5" },
        },
        {
          eventId: "8",
          workflowExecutionContinuedAsNewEventAttributes: {
            newExecutionRunId: RUN2,
          },
        },
      ],
    },
  ],
  [RUN2]: [
    {
      events: [
        {
          eventId: "1",
          workflowExecutionStartedEventAttributes: { input: { payloads: [] } },
        },
        {
          eventId: "5",
          activityTaskScheduledEventAttributes: {
            activityType: { name: "chargeCard" },
          },
        },
        {
          eventId: "6",
          activityTaskStartedEventAttributes: {
            scheduledEventId: "5",
            attempt: 1,
          },
        },
        {
          eventId: "7",
          activityTaskCompletedEventAttributes: { scheduledEventId: "5" },
        },
        {
          eventId: "8",
          activityTaskScheduledEventAttributes: {
            activityType: { name: "notify" },
          },
        },
        {
          eventId: "9",
          activityTaskFailedEventAttributes: { scheduledEventId: "8" },
        },
      ],
    },
  ],
};

interface FakeState {
  requests: Array<{ path: string; auth?: string }>;
  failNext: number;
  status: string;
  sweeperAppearsAt?: number;
}

function startFakeTemporal(state: FakeState): Promise<Server> {
  const server = createServer((req: IncomingMessage, res) => {
    const url = new URL(req.url ?? "/", "http://fake");
    state.requests.push({
      path: `${url.pathname}${url.search}`,
      ...(req.headers.authorization ? { auth: req.headers.authorization } : {}),
    });
    const send = (status: number, body: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    if (
      req.headers.authorization !==
      `Basic ${Buffer.from("ops:pa55").toString("base64")}`
    ) {
      return send(401, { message: "unauthorized" });
    }
    if (state.failNext > 0) {
      state.failNext--;
      return send(503, { message: "busy" });
    }
    const prefix = "/api/v1/namespaces/shop-ns";
    const path = url.pathname;
    if (path === `${prefix}/workflows/order-42`) {
      return send(200, {
        workflowExecutionInfo: {
          execution: { workflowId: "order-42", runId: RUN2 },
          type: { name: "OrderWorkflow" },
          status: `WORKFLOW_EXECUTION_STATUS_${state.status}`,
          firstRunId: RUN1,
          historyLength: "9",
        },
        pendingActivities: [],
      });
    }
    if (path === `${prefix}/workflows/order-42/history`) {
      const run = url.searchParams.get("execution.runId") ?? "";
      const pages = HISTORY[run] ?? [];
      const token = url.searchParams.get("nextPageToken");
      const page = token === "page-2" ? pages[1] : pages[0];
      return send(200, {
        history: { events: page?.events ?? [] },
        ...(page?.next ? { nextPageToken: page.next } : {}),
      });
    }
    // A RUNNING workflow whose activity is retrying: the attempt count only
    // shows in describe's pendingActivities (history has no Started event yet).
    if (path === `${prefix}/workflows/retrying-1`) {
      return send(200, {
        workflowExecutionInfo: {
          execution: { workflowId: "retrying-1", runId: "rr1" },
          status: "WORKFLOW_EXECUTION_STATUS_RUNNING",
        },
        pendingActivities: [
          { activityType: { name: "sendEmail" }, attempt: 5 },
          { activityType: { name: "audit" }, attempt: 1 },
        ],
      });
    }
    if (path === `${prefix}/workflows/retrying-1/history`) {
      return send(200, {
        history: {
          events: [
            {
              eventId: "5",
              activityTaskScheduledEventAttributes: {
                activityType: { name: "sendEmail" },
              },
            },
          ],
        },
      });
    }
    if (path.startsWith(`${prefix}/workflows/`) && !path.endsWith("/history")) {
      if (
        path.endsWith("/sweeper") &&
        state.sweeperAppearsAt !== undefined &&
        Date.now() >= state.sweeperAppearsAt
      ) {
        return send(200, {
          workflowExecutionInfo: {
            execution: { workflowId: "sweeper", runId: "s1" },
            status: "WORKFLOW_EXECUTION_STATUS_RUNNING",
          },
        });
      }
      return send(404, { message: "workflow not found" });
    }
    if (path === `${prefix}/workflows`) {
      const query = url.searchParams.get("query") ?? "";
      const executions = query.includes("OrderWorkflow")
        ? [
            {
              execution: { workflowId: "order-42", runId: RUN2 },
              type: { name: "OrderWorkflow" },
              status: "WORKFLOW_EXECUTION_STATUS_COMPLETED",
            },
            {
              execution: { workflowId: "order-41", runId: "r41" },
              type: { name: "OrderWorkflow" },
              status: "WORKFLOW_EXECUTION_STATUS_COMPLETED",
            },
          ]
        : [];
      return send(200, { executions });
    }
    if (path === `${prefix}/workflow-count`) {
      const query = url.searchParams.get("query") ?? "";
      return send(200, { count: query.includes("OrderWorkflow") ? "2" : "0" });
    }
    return send(404, { message: "no route" });
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve(server)),
  );
}

const state: FakeState = { requests: [], failNext: 0, status: "COMPLETED" };
let server: Server;
let api: string;

beforeAll(async () => {
  server = await startFakeTemporal(state);
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

function source() {
  return openTemporalSource("temporal", {
    kind: "temporal",
    api,
    namespace: "shop-ns",
    auth: { basic: "ops:pa55" },
  });
}

const soon = () => ({ deadline: Date.now() + 5000 });

describe("temporal datasource (HTTP API)", () => {
  it("describes a workflow with basic auth and treats 404 as absence", async () => {
    const workflow = await source().describe("order-42", undefined, soon());
    expect(workflow).toMatchObject({
      workflowId: "order-42",
      runId: RUN2,
      status: "COMPLETED",
      type: "OrderWorkflow",
      firstRunId: RUN1,
      historyLength: 9,
      pendingActivities: 0,
    });
    expect(await source().describe("missing-wf", undefined, soon())).toBeNull();
    expect(state.requests.at(-1)?.auth).toMatch(/^Basic /);
  });

  it("retries 5xx within the deadline", async () => {
    state.failNext = 2;
    const workflow = await source().describe("order-42", undefined, soon());
    expect(workflow?.status).toBe("COMPLETED");
    expect(state.failNext).toBe(0);
  });

  it("reads every history page and follows continue-as-new", async () => {
    const history = await source().history("order-42", RUN1, soon());
    expect(history.runs).toEqual([
      { runId: RUN1, events: 5, pages: 2 },
      { runId: RUN2, events: 6, pages: 1 },
    ]);
    const facts = historyFacts(history.events);
    expect(facts.completedActivities.toSorted()).toEqual([
      "chargeCard",
      "reserveStock",
    ]);
    expect(facts.unsuccessfulActivities).toEqual(["notify"]);
    expect(facts.maxAttempts).toEqual({ reserveStock: 2, chargeCard: 1 });
    expect(facts.inputBytes).toBe(
      JSON.stringify({ orderId: 42, items: [1, 2] }).length,
    );
  });

  it("lists and counts with a visibility query", async () => {
    const query = "WorkflowType='OrderWorkflow'";
    expect(await source().count(query, soon())).toBe(2);
    const listed = await source().list(query, soon());
    expect(listed.map((w) => w.workflowId)).toEqual(["order-42", "order-41"]);
    expect(state.requests.at(-1)?.path).toContain(
      new URLSearchParams({ query }).toString(),
    );
  });
});

/* ----- the temporal verifier ----- */

function outcome(raw: unknown): Outcome {
  return OutcomeSchema.parse(raw);
}

function ctx() {
  return {
    datasources: resolveEnvironmentDatasources(
      DatasourcesConfigSchema.parse({
        temporal: {
          kind: "temporal",
          api,
          namespace: "shop-ns",
          auth: { basic: "${secrets.TEMPORAL_BASIC}" },
        },
      }),
      undefined,
    ),
    childEnv: { TEMPORAL_BASIC: "ops:pa55" },
  };
}

describe("temporal verifier", () => {
  it("checks status, completed activities, attempts and input size across continue-as-new", async () => {
    const [ok, tooManyAttempts] = await evaluateOutcomes(
      [
        outcome({
          id: "order_workflow_done",
          description: "the order workflow completed every step",
          verify: {
            temporal: {
              source: "temporal",
              workflowId: "order-42",
              assign: "orderWorkflow",
              expect: {
                status: ["COMPLETED", "CONTINUED_AS_NEW"],
                activities: {
                  includeAll: ["reserveStock", "chargeCard"],
                  includeAnyOf: ["chargeCard", "refund"],
                },
                inputBytes: { atMost: 1024 },
              },
            },
          },
        }),
        outcome({
          id: "no_retries",
          description: "no activity retried",
          verify: {
            temporal: {
              source: "temporal",
              workflowId: "order-42",
              expect: { activities: { maxAttempts: 1 } },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx(),
    );
    expect(ok!.evaluation).toMatchObject({ passed: true });
    expect(ok!.evaluation.raw).toMatchObject({
      kind: "temporal",
      source: { name: "temporal", kind: "temporal", namespace: "shop-ns" },
      request: { workflowId: "order-42" },
      observed: {
        workflow: { status: "COMPLETED" },
        history: { runs: [{ runId: RUN1 }, { runId: RUN2 }] },
      },
    });
    expect(JSON.stringify(ok!.evaluation.raw)).not.toContain("pa55");
    expect(tooManyAttempts!.evaluation).toMatchObject({
      passed: false,
      actual: expect.stringContaining("reserveStock=2"),
    });
  });

  it("counts a retrying activity's pending attempt against maxAttempts", async () => {
    const workflow = await source().describe("retrying-1", undefined, soon());
    expect(workflow).toMatchObject({
      status: "RUNNING",
      pendingActivities: 2,
      pendingActivityAttempts: { sendEmail: 5, audit: 1 },
    });
    const [retrying] = await evaluateOutcomes(
      [
        outcome({
          id: "no_retries",
          description: "no activity retried",
          verify: {
            temporal: {
              source: "temporal",
              workflowId: "retrying-1",
              expect: {
                status: ["RUNNING", "COMPLETED"],
                activities: { maxAttempts: 1 },
              },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx(),
    );
    expect(retrying!.evaluation).toMatchObject({
      passed: false,
      actual: expect.stringContaining("sendEmail=5"),
    });
  });

  it("stops polling at once on an auth failure", async () => {
    const before = state.requests.length;
    const [denied] = await evaluateOutcomes(
      [
        outcome({
          id: "order_workflow_done",
          description: "the order workflow completed",
          verify: {
            temporal: {
              source: "temporal",
              workflowId: "order-42",
              expect: { status: "COMPLETED" },
            },
            poll: { timeoutMs: 3000, everyMs: 50 },
          },
        }),
      ],
      new MockBrowserBackend(),
      { ...ctx(), childEnv: { TEMPORAL_BASIC: "ops:wrong" } },
    );
    expect(denied!.evaluation).toMatchObject({ passed: false, attempts: 1 });
    expect(denied!.evaluation.actual).toContain("HTTP 401");
    expect(denied!.evaluation.actual).toContain("not retried");
    expect(state.requests.length - before).toBe(1);
  });

  it("asserts absence (404) that must hold for stableMs, and fails when the workflow appears", async () => {
    const [absent] = await evaluateOutcomes(
      [
        outcome({
          id: "no_compensation",
          description: "no compensation workflow was started",
          verify: {
            temporal: {
              source: "temporal",
              workflowId: "compensate-42",
              expect: { absent: { stableMs: 200 } },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx(),
    );
    expect(absent!.evaluation.passed).toBe(true);
    expect(absent!.evaluation.attempts).toBeGreaterThanOrEqual(2);

    state.sweeperAppearsAt = Date.now() + 100;
    const [appeared] = await evaluateOutcomes(
      [
        outcome({
          id: "no_sweeper",
          description: "the sweeper did not start",
          verify: {
            temporal: {
              source: "temporal",
              workflowId: "sweeper",
              expect: { absent: { stableMs: 400 } },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx(),
    );
    expect(appeared!.evaluation.passed).toBe(false);
  });

  it("counts a visibility query and checks every listed status", async () => {
    const [counted, none] = await evaluateOutcomes(
      [
        outcome({
          id: "two_orders",
          description: "two order workflows completed",
          verify: {
            temporal: {
              source: "temporal",
              query: "WorkflowType='OrderWorkflow'",
              expect: { count: 2, status: "COMPLETED" },
            },
          },
        }),
        outcome({
          id: "no_failed_orders",
          description: "no failed order workflow",
          verify: {
            temporal: {
              source: "temporal",
              query: "ExecutionStatus='Failed'",
              expect: { absent: true },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx(),
    );
    expect(counted!.evaluation).toMatchObject({
      passed: true,
      actual: "count=2",
    });
    expect(none!.evaluation).toMatchObject({ passed: true, actual: "count=0" });
  });
});
