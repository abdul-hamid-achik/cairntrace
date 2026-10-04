import { HttpCallError, httpCallWithRetry } from "./http";
import { authorizationHeader, joinBaseUrl, type HttpReply } from "./httpWire";
import { DatasourceError } from "./mongo";
import { displayUrl } from "./redact";
import { datasourceSecretValues } from "./resolve";
import type { TemporalDatasource } from "./schema";

/**
 * Temporal through its HTTP API (the Temporal UI server's `/api/v1/…`
 * gateway, or a frontend with the HTTP API enabled). Describe, list, count
 * and full history (every page, following continue-as-new). 5xx and
 * transport failures are retried within the deadline; describe's 404 is
 * absence, not an error.
 */

export interface WorkflowSummary {
  workflowId: string;
  runId?: string;
  /** Without the WORKFLOW_EXECUTION_STATUS_ prefix (COMPLETED, RUNNING, …). */
  status: string;
  type?: string;
  startTime?: string;
  closeTime?: string;
  historyLength?: number;
  firstRunId?: string;
  pendingActivities?: number;
  /**
   * Describe only: highest `attempt` per activity type among the pending
   * (running, retrying or backing-off) activities — retries that history
   * does not show yet.
   */
  pendingActivityAttempts?: Record<string, number>;
  pendingChildren?: number;
}

export interface WorkflowHistory {
  /** Runs read, oldest first (more than one after continue-as-new). */
  runs: Array<{ runId: string; events: number; pages: number }>;
  events: Array<Record<string, unknown>>;
}

export interface TemporalSourceDescriptor {
  name: string;
  kind: "temporal";
  namespace: string;
  api: string;
}

export interface TemporalCallOptions {
  deadline: number;
  signal?: AbortSignal;
}

export interface TemporalSource {
  readonly descriptor: TemporalSourceDescriptor;
  describe(
    workflowId: string,
    runId: string | undefined,
    opts: TemporalCallOptions,
  ): Promise<WorkflowSummary | null>;
  list(
    query: string,
    opts: TemporalCallOptions & { pageSize?: number },
  ): Promise<WorkflowSummary[]>;
  count(query: string, opts: TemporalCallOptions): Promise<number>;
  history(
    workflowId: string,
    runId: string,
    opts: TemporalCallOptions,
  ): Promise<WorkflowHistory>;
}

const STATUS_BY_NUMBER: Record<number, string> = {
  0: "UNSPECIFIED",
  1: "RUNNING",
  2: "COMPLETED",
  3: "FAILED",
  4: "CANCELED",
  5: "TERMINATED",
  6: "CONTINUED_AS_NEW",
  7: "TIMED_OUT",
};

export function normalizeWorkflowStatus(raw: unknown): string {
  if (typeof raw === "number") return STATUS_BY_NUMBER[raw] ?? String(raw);
  return String(raw ?? "UNSPECIFIED")
    .replace(/^WORKFLOW_EXECUTION_STATUS_/, "")
    .toUpperCase();
}

const MAX_HISTORY_PAGES = 100;
const MAX_CONTINUED_RUNS = 10;

export function openTemporalSource(
  name: string,
  ds: TemporalDatasource,
): TemporalSource {
  const authorization = authorizationHeader(ds.auth);
  const secrets = datasourceSecretValues(ds);
  if (authorization) secrets.push(authorization.replace(/^\w+ /, ""));
  const headers: Record<string, string> = authorization
    ? { Authorization: authorization }
    : {};
  const ns = encodeURIComponent(ds.namespace);
  const url = (path: string, query: Record<string, string> = {}): string => {
    const search = new URLSearchParams(query).toString();
    return joinBaseUrl(
      ds.api,
      `/api/v1/namespaces/${ns}${path}${search ? `?${search}` : ""}`,
    );
  };
  const get = async (
    target: string,
    opts: TemporalCallOptions,
  ): Promise<HttpReply> =>
    httpCallWithRetry(
      {
        url: target,
        headers,
        deadline: opts.deadline,
        ...(opts.signal ? { signal: opts.signal } : {}),
      },
      secrets,
    );
  const fail = (what: string, reply: HttpReply): never => {
    // Auth and bad-request replies do not change by waiting: poll stops.
    const permanent = [400, 401, 403].includes(reply.status);
    throw new HttpCallError(
      `datasource ${name}: ${what} → HTTP ${reply.status}${describeBody(reply)}${
        reply.status === 401 || reply.status === 403
          ? " (check the datasource's auth)"
          : ""
      }`,
      reply.status,
      reply.status >= 500,
      permanent,
    );
  };

  return {
    descriptor: {
      name,
      kind: "temporal",
      namespace: ds.namespace,
      api: displayUrl(ds.api),
    },
    async describe(workflowId, runId, opts) {
      const reply = await get(
        url(
          `/workflows/${encodeURIComponent(workflowId)}`,
          runId ? { "execution.runId": runId } : {},
        ),
        opts,
      );
      if (reply.status === 404) return null;
      if (reply.status < 200 || reply.status >= 300) {
        fail(`describe ${workflowId}`, reply);
      }
      return summarizeDescription(workflowId, reply.body);
    },
    async list(query, opts) {
      const reply = await get(
        url("/workflows", {
          query,
          pageSize: String(Math.min(100, Math.max(1, opts.pageSize ?? 20))),
        }),
        opts,
      );
      if (reply.status < 200 || reply.status >= 300) fail("list", reply);
      const executions = (reply.body as { executions?: unknown })?.executions;
      return Array.isArray(executions)
        ? executions.map((execution) => summarizeExecution(execution))
        : [];
    },
    async count(query, opts) {
      const reply = await get(url("/workflow-count", { query }), opts);
      if (reply.status < 200 || reply.status >= 300) fail("count", reply);
      const raw = (reply.body as { count?: unknown })?.count;
      const n = typeof raw === "number" ? raw : Number(raw ?? 0);
      if (!Number.isFinite(n)) {
        throw new DatasourceError(
          `datasource ${name}: count returned ${JSON.stringify(raw)}`,
        );
      }
      return n;
    },
    async history(workflowId, runId, opts) {
      const runs: WorkflowHistory["runs"] = [];
      const events: Array<Record<string, unknown>> = [];
      let currentRun: string | undefined = runId;
      const seenRuns = new Set<string>();
      while (currentRun) {
        if (seenRuns.has(currentRun)) break;
        if (runs.length >= MAX_CONTINUED_RUNS) {
          throw new DatasourceError(
            `datasource ${name}: workflow ${workflowId} continued-as-new more than ${MAX_CONTINUED_RUNS} times; history read stopped`,
          );
        }
        seenRuns.add(currentRun);
        const page = await readRunHistory(workflowId, currentRun, opts);
        runs.push({
          runId: currentRun,
          events: page.events.length,
          pages: page.pages,
        });
        events.push(...page.events);
        currentRun = continuedAsNewRunId(page.events);
      }
      return { runs, events };
    },
  };

  async function readRunHistory(
    workflowId: string,
    runId: string,
    opts: TemporalCallOptions,
  ): Promise<{ events: Array<Record<string, unknown>>; pages: number }> {
    const events: Array<Record<string, unknown>> = [];
    const seenTokens = new Set<string>();
    let token: string | undefined;
    let pages = 0;
    for (;;) {
      const query: Record<string, string> = {
        "execution.runId": runId,
        maximumPageSize: "1000",
      };
      if (token) query["nextPageToken"] = token;
      const reply = await get(
        url(`/workflows/${encodeURIComponent(workflowId)}/history`, query),
        opts,
      );
      if (reply.status < 200 || reply.status >= 300) {
        fail(`history ${workflowId}/${runId}`, reply);
      }
      const body = record(reply.body);
      const pageEvents = record(body["history"])["events"] ?? body["events"];
      if (!Array.isArray(pageEvents)) {
        throw new DatasourceError(
          `datasource ${name}: history ${workflowId}/${runId} has no events array`,
        );
      }
      events.push(...pageEvents.map(record));
      pages++;
      const next = pageToken(reply.body);
      if (!next) break;
      if (seenTokens.has(next)) {
        throw new DatasourceError(
          `datasource ${name}: history pagination repeated a page token`,
        );
      }
      if (pages >= MAX_HISTORY_PAGES) {
        throw new DatasourceError(
          `datasource ${name}: history exceeded ${MAX_HISTORY_PAGES} pages`,
        );
      }
      seenTokens.add(next);
      token = next;
    }
    return { events, pages };
  }
}

function describeBody(reply: HttpReply): string {
  if (reply.body === undefined || reply.body === "") return "";
  const text =
    typeof reply.body === "string" ? reply.body : JSON.stringify(reply.body);
  return `: ${text.slice(0, 200)}`;
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pendingCount(value: unknown): number | undefined {
  if (Array.isArray(value)) return value.length;
  return typeof value === "number" ? value : undefined;
}

function typeName(info: Record<string, unknown>): string | undefined {
  for (const key of ["type", "workflowType"]) {
    const value = info[key];
    if (typeof value === "string") return value;
    const name = record(value)["name"];
    if (typeof name === "string") return name;
  }
  return undefined;
}

function summarizeExecution(raw: unknown): WorkflowSummary {
  const info = record(raw);
  const execution = record(info["execution"]);
  return {
    workflowId: String(execution["workflowId"] ?? ""),
    ...(typeof execution["runId"] === "string"
      ? { runId: execution["runId"] }
      : {}),
    status: normalizeWorkflowStatus(info["status"]),
    ...optionalString("type", typeName(info)),
    ...optionalString("startTime", info["startTime"]),
    ...optionalString("closeTime", info["closeTime"]),
    ...optionalString("firstRunId", info["firstRunId"]),
    ...(numberish(info["historyLength"]) !== undefined
      ? { historyLength: numberish(info["historyLength"])! }
      : {}),
  };
}

function summarizeDescription(
  workflowId: string,
  body: unknown,
): WorkflowSummary {
  const root = record(body);
  const info = record(root["workflowExecutionInfo"] ?? root["executionInfo"]);
  const summary = summarizeExecution(info);
  const pendingActivities = pendingCount(root["pendingActivities"]);
  const pendingAttempts = pendingActivityAttempts(root["pendingActivities"]);
  const pendingChildren = pendingCount(root["pendingChildren"]);
  return {
    ...summary,
    workflowId: summary.workflowId || workflowId,
    ...(pendingActivities !== undefined ? { pendingActivities } : {}),
    ...(pendingAttempts ? { pendingActivityAttempts: pendingAttempts } : {}),
    ...(pendingChildren !== undefined ? { pendingChildren } : {}),
  };
}

function pendingActivityAttempts(
  value: unknown,
): Record<string, number> | undefined {
  if (!Array.isArray(value)) return undefined;
  const attempts: Record<string, number> = {};
  for (const item of value) {
    const pending = record(item);
    const type = pending["activityType"];
    const name = typeof type === "string" ? type : record(type)["name"];
    const attempt = numberish(pending["attempt"]);
    if (typeof name !== "string" || attempt === undefined) continue;
    attempts[name] = Math.max(attempts[name] ?? 0, attempt);
  }
  return Object.keys(attempts).length > 0 ? attempts : undefined;
}

/** Fold a describe's pending-activity attempts into history facts. */
export function withPendingAttempts(
  facts: HistoryFacts,
  pending: Record<string, number> | undefined,
): HistoryFacts {
  if (!pending) return facts;
  const maxAttempts = { ...facts.maxAttempts };
  for (const [name, attempt] of Object.entries(pending)) {
    maxAttempts[name] = Math.max(maxAttempts[name] ?? 0, attempt);
  }
  return { ...facts, maxAttempts };
}

function optionalString(key: string, value: unknown): Record<string, string> {
  return typeof value === "string" && value.length > 0 ? { [key]: value } : {};
}

function numberish(value: unknown): number | undefined {
  if (typeof value === "number") return value;
  if (typeof value === "string" && /^\d+$/.test(value)) return Number(value);
  return undefined;
}

/** `newExecutionRunId` of a trailing continue-as-new event, if any. */
export function continuedAsNewRunId(
  events: Array<Record<string, unknown>>,
): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const attrs = record(
      events[i]!["workflowExecutionContinuedAsNewEventAttributes"],
    );
    const next = attrs["newExecutionRunId"];
    if (typeof next === "string" && next.length > 0) return next;
  }
  return undefined;
}

/** Opaque page token in its two wire shapes (`"…"` or `{ data: "…" }`). */
export function pageToken(body: unknown): string | undefined {
  const root = record(body);
  const raw = root["nextPageToken"] ?? record(root["history"])["nextPageToken"];
  if (typeof raw === "string" && raw.length > 0) return raw;
  const data = record(raw)["data"];
  return typeof data === "string" && data.length > 0 ? data : undefined;
}

/** What a run's history says about activities and the workflow input. */
export interface HistoryFacts {
  /** Activity types with an ActivityTaskCompleted for their scheduled event. */
  completedActivities: string[];
  scheduledActivities: string[];
  /** Activity types whose final attempt failed / timed out / was canceled. */
  unsuccessfulActivities: string[];
  /**
   * Highest `attempt` seen on ActivityTaskStarted, per activity type (the
   * temporal verifier also folds in describe's pending-activity attempts).
   */
  maxAttempts: Record<string, number>;
  /** Decoded byte size of the first run's workflow input payloads. */
  inputBytes?: number;
}

export function historyFacts(
  events: Array<Record<string, unknown>>,
): HistoryFacts {
  const scheduled = new Map<string, string>();
  const completed = new Set<string>();
  const unsuccessful = new Set<string>();
  const maxAttempts: Record<string, number> = {};
  let inputBytes: number | undefined;
  for (const event of events) {
    const eventId = String(event["eventId"] ?? "");
    const started = record(event["workflowExecutionStartedEventAttributes"]);
    if (inputBytes === undefined && Object.keys(started).length > 0) {
      inputBytes = payloadBytes(record(started["input"])["payloads"]);
    }
    const sched = record(event["activityTaskScheduledEventAttributes"]);
    const schedName = record(sched["activityType"])["name"];
    if (typeof schedName === "string") scheduled.set(eventId, schedName);
    const startedAttrs = record(event["activityTaskStartedEventAttributes"]);
    const startedFor = scheduled.get(
      String(startedAttrs["scheduledEventId"] ?? ""),
    );
    if (startedFor !== undefined) {
      const attempt = Number(startedAttrs["attempt"] ?? 1);
      if (Number.isFinite(attempt)) {
        maxAttempts[startedFor] = Math.max(
          maxAttempts[startedFor] ?? 0,
          attempt,
        );
      }
    }
    const done = record(event["activityTaskCompletedEventAttributes"]);
    const doneFor = scheduled.get(String(done["scheduledEventId"] ?? ""));
    if (doneFor !== undefined) completed.add(doneFor);
    for (const key of [
      "activityTaskFailedEventAttributes",
      "activityTaskTimedOutEventAttributes",
      "activityTaskCanceledEventAttributes",
    ]) {
      const failed = record(event[key]);
      const failedFor = scheduled.get(String(failed["scheduledEventId"] ?? ""));
      if (failedFor !== undefined) unsuccessful.add(failedFor);
    }
  }
  return {
    completedActivities: [...completed],
    scheduledActivities: [...new Set(scheduled.values())],
    unsuccessfulActivities: [...unsuccessful].filter(
      (name) => !completed.has(name),
    ),
    maxAttempts,
    ...(inputBytes !== undefined ? { inputBytes } : {}),
  };
}

function payloadBytes(payloads: unknown): number {
  if (!Array.isArray(payloads)) return 0;
  let total = 0;
  for (const payload of payloads) {
    const data = record(payload)["data"];
    if (typeof data === "string") {
      total += Buffer.from(data, "base64").byteLength;
    }
  }
  return total;
}
