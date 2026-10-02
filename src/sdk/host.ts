import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import {
  createDatasourceSession,
  type DatasourceSessionOptions,
  type EnvironmentDatasourceSet,
  type MongoFindRequest,
  type MongoWriteRequest,
} from "../core/datasources";

/**
 * Runner side of `ctx.datasources` for SDK verifiers.
 *
 * A node verifier runs in a child process; the datasource clients (and the
 * connection strings/credentials behind them) stay in the runner. The child
 * calls `ctx.datasources.<name>.<method>(...args)`, which POSTs to a
 * loopback-only, bearer-token endpoint that lives for one outcome; the host
 * forwards the call to the configured client and returns its JSON result.
 */
export interface VerifierDatasourceHost {
  /** Configured datasources (names and kinds only — never connection details). */
  list(): Array<{ name: string; kind?: string }>;
  call(
    name: string,
    method: string,
    args: unknown[],
    opts: { signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Per-call budget when the verifier itself is unbounded. */
const DEFAULT_CALL_BUDGET_MS = 60_000;

/**
 * The SDK's datasource surface over the configured datasources of the run's
 * environment (`createDatasourceSession`). Per kind:
 *
 * - mongo: `find(collection, filter?, { projection, sort, limit, database })`
 *   → documents; `findOne(…)` → document | null; `count(collection, filter?)`
 *   → number; `query(request)` → `{ docs, count? }`; `write(request)`
 *   (refused on `mode: read-only`); `ping()`.
 * - temporal: `describe(workflowId, runId?)`, `list(query, { pageSize }?)`,
 *   `count(query)`, `history(workflowId, runId)`.
 * - http: `request({ path, method?, headers?, body? })`, `get(path, headers?)`,
 *   `post|put|patch(path, body?, headers?)`, `delete(path, headers?)` → reply
 *   `{ status, headers, body, json, bytes, truncated }`.
 *
 * Every call is bounded by the verifier's deadline (or 60s).
 */
export function createSdkDatasourceHost(
  set: EnvironmentDatasourceSet,
  opts: DatasourceSessionOptions & { deadline?: number } = {},
): VerifierDatasourceHost & { close(): Promise<void> } {
  const { deadline: verifierDeadline, ...sessionOpts } = opts;
  const session = createDatasourceSession(set, sessionOpts);
  const names = [
    ...new Set([
      ...Object.keys(set.datasources),
      ...Object.keys(set.errors),
      ...set.disabled,
    ]),
  ];
  const callDeadline = (): number =>
    Math.min(
      Date.now() + DEFAULT_CALL_BUDGET_MS,
      verifierDeadline ?? Number.POSITIVE_INFINITY,
    );
  return {
    list: () =>
      names.map((name) => {
        const kind = set.datasources[name]?.kind;
        return { name, ...(kind ? { kind } : {}) };
      }),
    async call(name, method, args, { signal }) {
      const kind = set.datasources[name]?.kind;
      // Unknown, invalid or disabled: let the session say which.
      if (!kind) session.temporal(name);
      const callOpts = {
        deadline: callDeadline(),
        ...(signal ? { signal } : {}),
      };
      const arg = (i: number): unknown => args[i];
      const record = (i: number): Record<string, unknown> | undefined => {
        const value = args[i];
        return value !== null &&
          typeof value === "object" &&
          !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : undefined;
      };
      if (kind === "mongo") {
        const source = await session.mongo(name);
        const findRequest = (): MongoFindRequest => {
          const options = record(2) ?? {};
          return {
            collection: String(arg(0)),
            ...(record(1) ? { filter: record(1) } : {}),
            ...(options as Omit<MongoFindRequest, "collection" | "filter">),
          };
        };
        switch (method) {
          case "find":
            return (await source.find(findRequest(), callOpts)).docs;
          case "findOne":
            return (
              (await source.find({ ...findRequest(), limit: 1 }, callOpts))
                .docs[0] ?? null
            );
          case "count":
            return (
              (
                await source.find(
                  { ...findRequest(), limit: 1, count: true },
                  callOpts,
                )
              ).count ?? 0
            );
          case "query":
            return await source.find(
              (record(0) ?? {}) as unknown as MongoFindRequest,
              callOpts,
            );
          case "write":
            return await source.write(
              (record(0) ?? {}) as unknown as MongoWriteRequest,
              callOpts,
            );
          case "ping":
            await source.ping(callOpts);
            return true;
        }
      } else if (kind === "temporal") {
        const source = session.temporal(name);
        switch (method) {
          case "describe":
            return await source.describe(
              String(arg(0)),
              typeof arg(1) === "string" ? (arg(1) as string) : undefined,
              callOpts,
            );
          case "list": {
            const pageSize = record(1)?.["pageSize"];
            return await source.list(String(arg(0)), {
              ...callOpts,
              ...(typeof pageSize === "number" ? { pageSize } : {}),
            });
          }
          case "count":
            return await source.count(String(arg(0)), callOpts);
          case "history":
            return await source.history(
              String(arg(0)),
              String(arg(1) ?? ""),
              callOpts,
            );
        }
      } else if (kind === "http") {
        const source = session.http(name);
        const headers = (i: number): Record<string, string> | undefined =>
          record(i) as Record<string, string> | undefined;
        const send = (req: {
          path: string;
          method?: string;
          headers?: Record<string, string>;
          body?: unknown;
        }): Promise<unknown> => source.call(req, callOpts);
        switch (method) {
          case "request": {
            const req = record(0) ?? {};
            return await send({
              path: String(req["path"] ?? "/"),
              ...(typeof req["method"] === "string"
                ? { method: req["method"] }
                : {}),
              ...(record(0)?.["headers"]
                ? { headers: req["headers"] as Record<string, string> }
                : {}),
              ...(req["body"] !== undefined ? { body: req["body"] } : {}),
            });
          }
          case "get":
          case "delete":
            return await send({
              path: String(arg(0)),
              method: method.toUpperCase(),
              ...(headers(1) ? { headers: headers(1) } : {}),
            });
          case "post":
          case "put":
          case "patch":
            return await send({
              path: String(arg(0)),
              method: method.toUpperCase(),
              ...(arg(1) !== undefined ? { body: arg(1) } : {}),
              ...(headers(2) ? { headers: headers(2) } : {}),
            });
        }
      }
      throw new Error(
        `datasource ${name} (${kind ?? "unknown kind"}) has no method "${method}"`,
      );
    },
    close: () => session.close(),
  };
}

export interface DatasourceCallRecord {
  name: string;
  method: string;
  ok: boolean;
  durationMs: number;
  /** Array results: their length. */
  rows?: number;
  error?: string;
}

export interface VerifierChannel {
  url: string;
  token: string;
  close(): Promise<void>;
}

const MAX_REQUEST_BYTES = 1 << 20;
const MAX_RESPONSE_BYTES = 32 << 20;

/** Start the loopback channel for one verifier invocation. */
export async function startVerifierChannel(
  host: VerifierDatasourceHost,
  opts: {
    signal?: AbortSignal;
    onCall?: (record: DatasourceCallRecord) => void;
  } = {},
): Promise<VerifierChannel> {
  const token = randomBytes(24).toString("hex");
  const expected = Buffer.from(`Bearer ${token}`);
  const inflight = new Set<AbortController>();
  const server: Server = createServer((req, res) => {
    const send = (status: number, body: unknown): void => {
      let text = JSON.stringify(body);
      if (Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
        status = 413;
        text = JSON.stringify({
          ok: false,
          error: {
            message: `result exceeds ${MAX_RESPONSE_BYTES} bytes; narrow the query`,
          },
        });
      }
      res.writeHead(status, {
        "content-type": "application/json",
        connection: "close",
      });
      res.end(text);
    };
    const auth = Buffer.from(String(req.headers.authorization ?? ""));
    if (
      req.method !== "POST" ||
      auth.length !== expected.length ||
      !timingSafeEqual(auth, expected)
    ) {
      send(403, { ok: false, error: { message: "forbidden" } });
      return;
    }
    void handle(req).then(
      (value) => send(200, { ok: true, value: value ?? null }),
      (error: unknown) =>
        send(200, {
          ok: false,
          error: { message: (error as Error)?.message ?? String(error) },
        }),
    );
  });

  async function handle(req: IncomingMessage): Promise<unknown> {
    const body = await readBody(req);
    const parsed = JSON.parse(body) as {
      op?: unknown;
      name?: unknown;
      method?: unknown;
      args?: unknown;
    };
    if (
      parsed.op !== "datasource" ||
      typeof parsed.name !== "string" ||
      typeof parsed.method !== "string"
    ) {
      throw new Error("unsupported verifier channel request");
    }
    const args = Array.isArray(parsed.args) ? parsed.args : [];
    const controller = new AbortController();
    inflight.add(controller);
    const started = Date.now();
    try {
      const value = await host.call(parsed.name, parsed.method, args, {
        signal: controller.signal,
      });
      opts.onCall?.({
        name: parsed.name,
        method: parsed.method,
        ok: true,
        durationMs: Date.now() - started,
        ...(Array.isArray(value) ? { rows: value.length } : {}),
      });
      return value;
    } catch (error) {
      opts.onCall?.({
        name: parsed.name,
        method: parsed.method,
        ok: false,
        durationMs: Date.now() - started,
        error: (error as Error)?.message ?? String(error),
      });
      throw error;
    } finally {
      inflight.delete(controller);
    }
  }

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const { port } = server.address() as AddressInfo;
  let closed = false;
  const close = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    for (const controller of inflight) controller.abort();
    opts.signal?.removeEventListener("abort", onAbort);
    server.closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  const onAbort = (): void => void close();
  opts.signal?.addEventListener("abort", onAbort, { once: true });
  return { url: `http://127.0.0.1:${port}/rpc`, token, close };
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_REQUEST_BYTES) {
        reject(new Error(`request exceeds ${MAX_REQUEST_BYTES} bytes`));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
