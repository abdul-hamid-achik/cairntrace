import { createDatasourceSession } from "../../datasources";
import {
  historyFacts,
  withPendingAttempts,
  type HistoryFacts,
  type TemporalSource,
  type WorkflowSummary,
} from "../../datasources/temporal";
import type { TemporalVerifier } from "../../schema/verifier.v1";
import { boundRows } from "./evidence";
import { matchValue, type MatchOutcome } from "./matchers";
import type { PollRunner } from "./mongo";
import { resolveRefsDeep } from "./refs";
import type { VerifierContext, VerifierEvaluation } from "./types";

const DEFAULT_REQUEST_TIMEOUT_MS = 15_000;

type TemporalSpec = TemporalVerifier["temporal"];

/**
 * `temporal` verifier: describe one workflow (404 = absent) or a visibility
 * query, plus history facts (activities, attempts, input size) when asked.
 */
export async function evaluateTemporal(
  verifier: TemporalVerifier,
  ctx: VerifierContext,
  run: PollRunner,
): Promise<VerifierEvaluation> {
  const spec = verifier.temporal;
  const refs = resolveRefsDeep(
    {
      ...(spec.workflowId !== undefined ? { workflowId: spec.workflowId } : {}),
      ...(spec.runId !== undefined ? { runId: spec.runId } : {}),
      ...(spec.query !== undefined ? { query: spec.query } : {}),
    },
    ctx,
  );
  const target = {
    workflowId: asOptionalString(refs.value.workflowId),
    runId: asOptionalString(refs.value.runId),
    query: asOptionalString(refs.value.query),
  };
  const request = {
    ...(target.workflowId ? { workflowId: target.workflowId } : {}),
    ...(target.runId ? { runId: target.runId } : {}),
    ...(target.query ? { query: target.query } : {}),
    expect: spec.expect,
  };
  if (refs.missing.length > 0) {
    return {
      passed: false,
      expected: `temporal ${spec.source} lookup with resolved references`,
      actual: `unresolved ${refs.missing.join(", ")}`,
      raw: { kind: "temporal", source: { name: spec.source }, request },
    };
  }

  const session = createDatasourceSession(ctx.datasources, {
    ...(ctx.childEnv ? { env: ctx.childEnv } : {}),
    ...(ctx.vars ? { vars: ctx.vars } : {}),
    ...(ctx.envName ? { envName: ctx.envName } : {}),
  });
  let descriptor: TemporalSource["descriptor"] | undefined;
  let observed: Record<string, unknown> | undefined;
  try {
    const polled = await run(async ({ deadline }) => {
      const source = session.temporal(spec.source);
      descriptor = source.descriptor;
      const opts = {
        deadline: Math.min(
          deadline,
          Date.now() + (spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
        ),
        ...(ctx.signal ? { signal: ctx.signal } : {}),
      };
      if (target.workflowId) {
        const workflow = await source.describe(
          target.workflowId,
          target.runId,
          opts,
        );
        const facts =
          workflow && needsHistory(spec)
            ? await source.history(
                workflow.workflowId,
                target.runId ?? workflow.firstRunId ?? workflow.runId ?? "",
                opts,
              )
            : undefined;
        // Retrying / backing-off attempts live only in describe's
        // pendingActivities until they start: fold them into maxAttempts.
        const summary = facts
          ? withPendingAttempts(
              historyFacts(facts.events),
              workflow?.pendingActivityAttempts,
            )
          : undefined;
        observed = {
          workflow: workflow ?? null,
          ...(facts && summary
            ? { history: { runs: facts.runs, ...summary } }
            : {}),
        };
        return judgeWorkflow(spec, target.workflowId, workflow, summary);
      }
      const query = target.query!;
      const [count, executions] = await Promise.all([
        source.count(query, opts),
        source.list(query, { ...opts, pageSize: 20 }),
      ]);
      const first = executions[0];
      const facts =
        first && needsHistory(spec)
          ? await source.history(
              first.workflowId,
              first.runId ?? first.firstRunId ?? "",
              opts,
            )
          : undefined;
      const summary = facts ? historyFacts(facts.events) : undefined;
      observed = {
        count,
        executions,
        ...(facts && summary
          ? {
              history: {
                workflowId: first!.workflowId,
                runs: facts.runs,
                ...summary,
              },
            }
          : {}),
      };
      return judgeQuery(spec, count, executions, summary);
    });
    if (spec.assign && observed) {
      ctx.captures ??= {};
      ctx.captures[spec.assign] = observed["workflow"] ?? observed;
    }
    return {
      ...polled,
      raw: {
        kind: "temporal",
        source: descriptor ?? { name: spec.source, kind: "temporal" },
        request,
        ...(observed ? { observed: boundObserved(observed) } : {}),
        ...(polled.attemptLog ? { attempts: polled.attemptLog } : {}),
        ...(polled.polledMs !== undefined ? { polledMs: polled.polledMs } : {}),
      },
    };
  } finally {
    await session.close();
  }
}

function asOptionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" ? value : JSON.stringify(value);
}

function needsHistory(spec: TemporalSpec): boolean {
  return (
    spec.expect.activities !== undefined || spec.expect.inputBytes !== undefined
  );
}

function boundObserved(observed: Record<string, unknown>): unknown {
  const executions = observed["executions"];
  if (!Array.isArray(executions)) return observed;
  const bounded = boundRows(executions);
  return {
    ...observed,
    executions: bounded.rows,
    truncated: bounded.truncated,
  };
}

function statusList(spec: TemporalSpec): string[] | undefined {
  const status = spec.expect.status;
  if (status === undefined) return undefined;
  return (Array.isArray(status) ? status : [status]).map((s) =>
    s.toUpperCase().replace(/^WORKFLOW_EXECUTION_STATUS_/, ""),
  );
}

function historyChecks(
  spec: TemporalSpec,
  facts: HistoryFacts | undefined,
): MatchOutcome[] {
  const checks: MatchOutcome[] = [];
  const activities = spec.expect.activities;
  const completed = facts?.completedActivities ?? [];
  const completedText = completed.length > 0 ? completed.join(", ") : "none";
  if (activities?.includeAnyOf) {
    checks.push({
      passed: activities.includeAnyOf.some((name) => completed.includes(name)),
      expected: `a completed activity among [${activities.includeAnyOf.join(", ")}]`,
      actual: `completed activities: ${completedText}`,
    });
  }
  if (activities?.includeAll) {
    const missing = activities.includeAll.filter(
      (name) => !completed.includes(name),
    );
    checks.push({
      passed: missing.length === 0,
      expected: `completed activities [${activities.includeAll.join(", ")}]`,
      actual:
        missing.length === 0
          ? `completed activities: ${completedText}`
          : `missing ${missing.join(", ")} (completed: ${completedText})`,
    });
  }
  if (activities?.maxAttempts !== undefined) {
    const attempts = Object.entries(facts?.maxAttempts ?? {});
    const over = attempts.filter(
      ([, attempt]) => attempt > activities.maxAttempts!,
    );
    checks.push({
      passed: over.length === 0,
      expected: `every activity within ${activities.maxAttempts} attempt(s)`,
      actual:
        over.length === 0
          ? `max attempts ${Math.max(0, ...attempts.map(([, a]) => a))}`
          : over.map(([name, attempt]) => `${name}=${attempt}`).join(", "),
    });
  }
  if (spec.expect.inputBytes) {
    const bytes = facts?.inputBytes;
    checks.push({
      passed: bytes !== undefined && bytes <= spec.expect.inputBytes.atMost,
      expected: `workflow input <= ${spec.expect.inputBytes.atMost} bytes`,
      actual:
        bytes === undefined ? "no workflow input found" : `${bytes} bytes`,
    });
  }
  return checks;
}

function verdict(checks: MatchOutcome[], lead: string): VerifierEvaluation {
  const failing = checks.filter((check) => !check.passed);
  return {
    passed: failing.length === 0,
    expected: checks.map((check) => check.expected).join("; "),
    actual: [lead, ...failing.map((check) => check.actual)].join("; "),
  };
}

function judgeWorkflow(
  spec: TemporalSpec,
  workflowId: string,
  workflow: WorkflowSummary | null,
  facts: HistoryFacts | undefined,
): VerifierEvaluation {
  const absent = spec.expect.absent;
  if (absent !== undefined && absent !== false) {
    return {
      passed: workflow === null,
      expected: `no workflow ${workflowId}`,
      actual:
        workflow === null
          ? "absent (404)"
          : `found ${workflow.status} run ${workflow.runId ?? "?"}`,
    };
  }
  if (workflow === null) {
    return {
      passed: false,
      expected: describeExpectations(spec, workflowId),
      actual: `workflow ${workflowId} not found (404)`,
    };
  }
  const checks: MatchOutcome[] = [];
  if (absent === false) {
    checks.push({
      passed: true,
      expected: `workflow ${workflowId} exists`,
      actual: "found",
    });
  }
  const statuses = statusList(spec);
  if (statuses) {
    checks.push({
      passed: statuses.includes(workflow.status),
      expected: `status ${
        statuses.length === 1 ? statuses[0] : `one of ${statuses.join("|")}`
      }`,
      actual: `status ${workflow.status}`,
    });
  }
  checks.push(...historyChecks(spec, facts));
  return verdict(checks, `${workflow.status} run ${workflow.runId ?? "?"}`);
}

function judgeQuery(
  spec: TemporalSpec,
  count: number,
  executions: WorkflowSummary[],
  facts: HistoryFacts | undefined,
): VerifierEvaluation {
  const absent = spec.expect.absent;
  if (absent !== undefined && absent !== false) {
    return {
      passed: count === 0,
      expected: `no workflow matching ${spec.query}`,
      actual: `count=${count}`,
    };
  }
  const checks: MatchOutcome[] = [];
  if (absent === false) {
    checks.push({
      passed: count > 0,
      expected: `a workflow matching ${spec.query}`,
      actual: `count=${count}`,
    });
  }
  if (spec.expect.count !== undefined) {
    checks.push({
      ...matchValue(count, true, spec.expect.count, "count"),
      actual: `count=${count}`,
    });
  }
  const statuses = statusList(spec);
  if (statuses) {
    const off = executions.filter((e) => !statuses.includes(e.status));
    checks.push({
      passed: executions.length > 0 && off.length === 0,
      expected: `every listed execution ${
        statuses.length === 1 ? statuses[0] : `one of ${statuses.join("|")}`
      }`,
      actual:
        executions.length === 0
          ? "no executions"
          : off.length === 0
            ? `${executions.length} execution(s) ok`
            : off
                .slice(0, 5)
                .map((e) => `${e.workflowId}=${e.status}`)
                .join(", "),
    });
  }
  if (needsHistory(spec)) {
    if (executions.length === 0) {
      checks.push({
        passed: false,
        expected: "history of the first matching execution",
        actual: "no executions",
      });
    } else {
      checks.push(...historyChecks(spec, facts));
    }
  }
  return verdict(checks, `count=${count}`);
}

function describeExpectations(spec: TemporalSpec, workflowId: string): string {
  const parts = [`workflow ${workflowId}`];
  const statuses = statusList(spec);
  if (statuses) parts.push(`status ${statuses.join("|")}`);
  if (spec.expect.activities) parts.push("activities");
  if (spec.expect.inputBytes) parts.push("input size");
  return parts.join(" with ");
}
