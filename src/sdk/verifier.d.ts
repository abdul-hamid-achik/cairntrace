import type { z, ZodTypeAny } from "zod";

export { z } from "zod";

/** Wire protocol between the runner and the SDK. */
export declare const SDK_PROTOCOL: 1;

/** One captured browser request (the run's network/requests.ndjson snapshot). */
export interface NetworkEntry {
  id?: string;
  url: string;
  method: string;
  status?: number;
  resourceType?: string;
  durationMs?: number;
  /** Epoch milliseconds when the request started. */
  timestamp?: number;
  responseTimestamp?: number;
  /** Bounded request body text, when the backend could observe it. */
  postData?: string;
  postDataTruncated?: boolean;
  startedAt?: string;
  [extra: string]: unknown;
}

export type NetworkFilter =
  | ((entry: NetworkEntry) => boolean)
  | {
      /** Case-insensitive HTTP method. */
      method?: string;
      /** Substring of the URL, or a RegExp tested against it. */
      url?: string | RegExp;
      urlContains?: string;
      /** Exact URL pathname (`/api/orders`). */
      path?: string;
      status?: number | number[] | { atLeast?: number; below?: number };
      resourceType?: string;
      /** Only requests that started at/after this instant. */
      since?: number | string | Date;
      where?: (entry: NetworkEntry) => boolean;
    };

export interface VerifierNetwork {
  readonly entries: readonly NetworkEntry[];
  find(filter?: NetworkFilter): NetworkEntry[];
  /** Exactly one match, else the verifier fails with the candidates as evidence. */
  findOne(filter: NetworkFilter): NetworkEntry;
  /** The request body parsed as JSON, or undefined. */
  json<T = unknown>(entry: NetworkEntry): T | undefined;
}

export interface PollAttempt {
  at: string;
  ok: boolean;
  summary: string;
}

export interface PollOptions<T> {
  /** Done when this holds (default: truthy, or a non-empty array). */
  until?: (observation: T) => unknown;
  /** A terminal state: return a message to fail at once instead of waiting. */
  failWhen?: (observation: T) => string | false | null | undefined;
  /**
   * Budget in ms (default 30000, never past ctx.deadline). An attempt still
   * running when it runs out is abandoned (its signal aborts), though each
   * attempt gets at least max(every, 1000) ms.
   */
  within?: number;
  /** Interval between attempts in ms (default 1000, at least 50). */
  every?: number;
  /** `until` must hold continuously this long before the poll succeeds. */
  stableFor?: number;
  /** One-line summary for progress and evidence. */
  describe?: (observation: T) => string;
  /** Appended to progress lines: "attempt 3/30: count=0 (want 1)". */
  want?: string;
  /** Prefix for progress lines and messages (default "poll"). */
  label?: string;
  /**
   * Treat a throwing attempt as "not yet" (default true). A VerifierFailure
   * (ctx.fail, network.findOne, a nested poll's timeout) always ends the poll.
   */
  retryOnError?: boolean;
  /** Fail without attempting when a spec step already failed. */
  failFastOnStepFailure?: boolean;
}

export interface VerifierRun {
  id?: string;
  /** The run's uniqueness token (`${run.token}`). */
  token?: string;
  startedAt?: string;
  /** The run's `--label key=value` pairs (empty when the run has none). */
  labels: Readonly<Record<string, string>>;
  failedStep: string | null;
  lastSuccessfulStep: string | null;
  dir?: string;
}

/** A Mongo document as relaxed extended JSON (`{ $oid }`, `{ $date }`). */
export type EJsonDocument = Record<string, unknown>;

export interface MongoFindOptions {
  projection?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  /** Another database than the datasource's own. */
  database?: string;
}

export interface MongoQuery extends MongoFindOptions {
  collection: string;
  filter?: Record<string, unknown>;
  /** Also return countDocuments(filter). */
  count?: boolean;
}

type MongoWriteTarget = { database?: string; collection: string };
export type MongoWrite = MongoWriteTarget &
  (
    | { op: "insertOne"; document: Record<string, unknown> }
    | { op: "insertMany"; documents: Record<string, unknown>[] }
    | {
        op: "updateOne" | "updateMany";
        filter: Record<string, unknown>;
        update: Record<string, unknown> | Record<string, unknown>[];
        upsert?: boolean;
      }
    | {
        op: "replaceOne";
        filter: Record<string, unknown>;
        replacement: Record<string, unknown>;
        upsert?: boolean;
      }
    | { op: "deleteOne" | "deleteMany"; filter: Record<string, unknown> }
  );

/** `kind: mongo` — refused writes on `mode: read-only`, `guard:` rules apply. */
export interface MongoDatasource {
  find<T = EJsonDocument>(
    collection: string,
    filter?: Record<string, unknown>,
    options?: MongoFindOptions,
  ): Promise<T[]>;
  findOne<T = EJsonDocument>(
    collection: string,
    filter?: Record<string, unknown>,
    options?: MongoFindOptions,
  ): Promise<T | null>;
  count(collection: string, filter?: Record<string, unknown>): Promise<number>;
  query<T = EJsonDocument>(
    request: MongoQuery,
  ): Promise<{ docs: T[]; count?: number }>;
  write(request: MongoWrite): Promise<Record<string, unknown>>;
  ping(): Promise<true>;
}

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
  /** Describe only: highest attempt per pending activity type. */
  pendingActivityAttempts?: Record<string, number>;
  pendingChildren?: number;
}

export interface WorkflowHistory {
  /** Runs read, oldest first (more than one after continue-as-new). */
  runs: Array<{ runId: string; events: number; pages: number }>;
  events: Array<Record<string, unknown>>;
}

/** `kind: temporal` — the Temporal HTTP API. */
export interface TemporalDatasource {
  /** null when the workflow does not exist. */
  describe(workflowId: string, runId?: string): Promise<WorkflowSummary | null>;
  list(
    query: string,
    options?: { pageSize?: number },
  ): Promise<WorkflowSummary[]>;
  count(query: string): Promise<number>;
  /** Every page, following continue-as-new. */
  history(workflowId: string, runId: string): Promise<WorkflowHistory>;
}

export interface HttpReply<T = unknown> {
  status: number;
  headers: Record<string, string>;
  /** Parsed JSON when the body is JSON, else the (bounded) text. */
  body: T;
  json: boolean;
  bytes: number;
  truncated: boolean;
}

export interface HttpRequest {
  /** Relative to the datasource's baseUrl; an absolute URL must stay on its origin. */
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

/** `kind: http` — the datasource's auth and headers are added by the runner. */
export interface HttpDatasource {
  request<T = unknown>(request: HttpRequest): Promise<HttpReply<T>>;
  get<T = unknown>(
    path: string,
    headers?: Record<string, string>,
  ): Promise<HttpReply<T>>;
  delete<T = unknown>(
    path: string,
    headers?: Record<string, string>,
  ): Promise<HttpReply<T>>;
  post<T = unknown>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpReply<T>>;
  put<T = unknown>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpReply<T>>;
  patch<T = unknown>(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpReply<T>>;
}

/**
 * A datasource whose kind is not declared: the methods of every kind, with
 * untyped results. Declare `Datasources` for the per-kind types.
 */
export interface AnyDatasource {
  find(
    collection: string,
    filter?: Record<string, unknown>,
    options?: MongoFindOptions,
  ): Promise<any[]>;
  findOne(
    collection: string,
    filter?: Record<string, unknown>,
    options?: MongoFindOptions,
  ): Promise<any>;
  /** mongo: count(collection, filter?); temporal: count(query). */
  count(
    collectionOrQuery: string,
    filter?: Record<string, unknown>,
  ): Promise<number>;
  query(request: MongoQuery): Promise<{ docs: any[]; count?: number }>;
  write(request: MongoWrite): Promise<Record<string, unknown>>;
  ping(): Promise<true>;
  describe(workflowId: string, runId?: string): Promise<WorkflowSummary | null>;
  list(
    query: string,
    options?: { pageSize?: number },
  ): Promise<WorkflowSummary[]>;
  history(workflowId: string, runId: string): Promise<WorkflowHistory>;
  request(request: HttpRequest): Promise<HttpReply<any>>;
  get(path: string, headers?: Record<string, string>): Promise<HttpReply<any>>;
  delete(
    path: string,
    headers?: Record<string, string>,
  ): Promise<HttpReply<any>>;
  post(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpReply<any>>;
  put(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpReply<any>>;
  patch(
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<HttpReply<any>>;
}

/** @deprecated Use AnyDatasource, or declare Datasources. */
export type DatasourceClient = AnyDatasource;

/**
 * The environment's datasources by name. Declare yours once for typed,
 * always-defined access (also under `noUncheckedIndexedAccess`):
 *
 *   declare module "@thelacanians/cairntrace/verifier" {
 *     interface Datasources {
 *       app: MongoDatasource;
 *       workflows: TemporalDatasource;
 *     }
 *   }
 */
// oxlint-disable-next-line typescript/no-empty-interface, typescript/no-empty-object-type -- augmented by verifiers
export interface Datasources {}

export type DatasourceMap = Datasources & {
  readonly [name: string]: AnyDatasource;
};

export interface WorkbookSheet {
  name: string;
  /** rows[r][c], 0-based, empty cells "". */
  rows: string[][];
  validations: Array<{ type?: string; sqref: string }>;
  /** Value of an A1 reference, or undefined when empty. */
  cell(ref: string): string | undefined;
  /** Rows after the header row as objects keyed by header text. */
  records(options?: { headerRow?: number }): Array<Record<string, string>>;
}

export interface Workbook {
  path: string;
  sheetNames: string[];
  sheets: WorkbookSheet[];
  sheet(name: string): WorkbookSheet | undefined;
}

export interface VerifierResult {
  ok: boolean;
  evidence?: unknown;
  message?: string;
}

export interface ArtifactRef {
  path: string;
  relativePath?: string;
  [extra: string]: unknown;
}

export interface VerifierContext<F> {
  /** Fixtures parsed by the contract: typed, defaults applied. */
  fixtures: F;
  vars: Record<string, string | number | boolean>;
  run: VerifierRun;
  specDir?: string;
  runDir?: string;
  network: VerifierNetwork;
  /** `eval` step results by `assign:` name. */
  evals: Record<string, unknown>;
  /** `request` step responses by `assign:` name. */
  requests: Record<string, unknown>;
  /** `capture:` step values (and verifier `assign`s) by name. */
  captures: Record<string, unknown>;
  /** `run:` step outputs by `assign:` name (`${runs.<name>…}`). */
  runs: Record<string, unknown>;
  /** Outputs of the spec's fixtures (`${fixtures.<name>.<key>}`). */
  fixturesOutputs: Record<string, Record<string, unknown>>;
  artifacts: Record<string, ArtifactRef>;
  /** `ctx.datasources.<name>.<method>()`, run by the runner (credentials stay there). */
  datasources: DatasourceMap;
  /**
   * Poll until a condition holds; throws with the last observation as
   * evidence. `signal` aborts when the attempt is abandoned, at the deadline
   * and on cancel.
   */
  poll<T>(
    fn: (attempt: { attempt: number; signal: AbortSignal }) => T | Promise<T>,
    options?: PollOptions<Awaited<T>>,
  ): Promise<Awaited<T>>;
  /** Epoch ms by which run(ctx) must return (a margin before script.timeoutMs); undefined when unbounded. */
  deadline: number | undefined;
  /** Milliseconds left before `deadline` (Infinity when unbounded). */
  remainingMs(): number;
  /** Aborted at the deadline and when the run is cancelled. */
  signal: AbortSignal;
  /** One progress line (an `outcome.progress` event while the verifier runs). */
  progress(message: string): void;
  /** Read an .xlsx file (relative paths: run dir, then spec dir). */
  xlsx(path: string): Promise<Workbook>;
  /** A line in the outcome log (stderr). */
  log(...args: unknown[]): void;
  /** Fail now with this message and details as evidence. */
  fail(message: string, details?: unknown): never;
  result: {
    ok(details?: unknown): VerifierResult;
    fail(message: string, details?: unknown): VerifierResult;
  };
}

type RunReturn = VerifierResult | boolean | Promise<VerifierResult | boolean>;

/** The function defineVerifier returns: `verify(ctx)` for the node runtime. */
export interface DefinedVerifier {
  (ctx: unknown): Promise<VerifierResult>;
}

export interface FixtureKeyContract {
  name: string;
  type: string;
  /** False when the key may be left out (optional, a default, or accepts undefined). */
  required: boolean;
  default?: unknown;
  description?: string;
  values?: Array<string | number | boolean>;
}

export interface FixturesContract {
  /** Unknown fixture keys are rejected. */
  strict: boolean;
  /** Keys could not be listed. */
  dynamic: boolean;
  keys: FixtureKeyContract[];
  reason?: string;
}

export declare function defineVerifier<S extends ZodTypeAny>(definition: {
  description?: string;
  fixtures: S;
  run(ctx: VerifierContext<z.output<S>>): RunReturn;
}): DefinedVerifier;
export declare function defineVerifier(definition: {
  description?: string;
  fixtures?: undefined;
  run(ctx: VerifierContext<Record<string, unknown>>): RunReturn;
}): DefinedVerifier;

export declare function inspectVerifier(value: unknown): {
  protocol: number;
  description?: string;
  fixtures: FixturesContract;
} | null;

export declare function describeFixtures(
  schema: ZodTypeAny | undefined,
): FixturesContract;

export declare class VerifierFailure extends Error {
  constructor(message: string, details?: unknown);
  details: unknown;
}

export declare class PollTimeoutError extends VerifierFailure {
  observation: unknown;
  attempts: number;
  polledMs: number;
}
