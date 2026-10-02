import { createRequire } from "node:module";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { execa } from "execa";
import { nativeToRelaxedEjson } from "./ejson";
import { hostNames, mongoUriHosts, scrubDatasourceText } from "./redact";
import { datasourceSecretValues } from "./resolve";
import type { MongoDatasource } from "./schema";

/**
 * Mongo access for datasource verifiers and fixtures. Three transports,
 * same request/response contract (requests and results are extended JSON):
 *
 * - `driver`: the official `mongodb` package, an OPTIONAL peer dependency
 *   loaded dynamically (never bundled, never required).
 * - `mongosh`: `mongosh --nodb --quiet --eval <constant script>` on the host.
 * - `docker`: the same script through `docker exec -i <container> mongosh`,
 *   the container resolved from its compose service label (or named).
 *
 * The mongosh script is a constant: the request travels as EJSON on stdin
 * (`docker exec -i` forwards it; no environment-size ceiling) and the
 * connection string in `CAIRN_MONGO_URI` (`docker exec -e NAME` forwards it
 * without putting it on a command line). No JavaScript is ever built from
 * user values.
 */

export type MongoTransport = "driver" | "mongosh" | "docker";

export interface MongoFindRequest {
  database?: string;
  collection: string;
  filter?: Record<string, unknown>;
  projection?: Record<string, unknown>;
  sort?: Record<string, 1 | -1>;
  limit?: number;
  /** Also return countDocuments(filter). */
  count?: boolean;
}

/** Result documents are relaxed extended JSON. */
export interface MongoFindResult {
  docs: unknown[];
  count?: number;
}

type MongoWriteTarget = { database?: string; collection: string };
export type MongoWriteRequest = MongoWriteTarget &
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

/** Driver/mongosh write result (relaxed EJSON). */
export type MongoWriteResult = Record<string, unknown>;

/** How evidence names a source: never by its connection string. */
export interface MongoSourceDescriptor {
  name: string;
  kind: "mongo";
  transport: MongoTransport;
  database: string;
  hosts?: string[];
  container?: string;
  service?: string;
  mode: "read-write" | "read-only";
}

export interface MongoCallOptions {
  /** Epoch ms after which the call is abandoned. */
  deadline: number;
  signal?: AbortSignal;
}

export interface MongoSource {
  readonly descriptor: MongoSourceDescriptor;
  find(req: MongoFindRequest, opts: MongoCallOptions): Promise<MongoFindResult>;
  write(
    req: MongoWriteRequest,
    opts: MongoCallOptions,
  ): Promise<MongoWriteResult>;
  ping(opts: MongoCallOptions): Promise<void>;
  close(): Promise<void>;
}

/* ----- the optional driver, as far as cairntrace uses it ----- */

interface DriverCursor {
  toArray(): Promise<unknown[]>;
}
interface DriverCollection {
  find(filter: unknown, options?: Record<string, unknown>): DriverCursor;
  countDocuments(
    filter: unknown,
    options?: Record<string, unknown>,
  ): Promise<number>;
  insertOne(doc: unknown): Promise<unknown>;
  insertMany(docs: unknown[]): Promise<unknown>;
  updateOne(
    filter: unknown,
    update: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  updateMany(
    filter: unknown,
    update: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  replaceOne(
    filter: unknown,
    doc: unknown,
    options?: Record<string, unknown>,
  ): Promise<unknown>;
  deleteOne(filter: unknown): Promise<unknown>;
  deleteMany(filter: unknown): Promise<unknown>;
}
interface DriverDb {
  collection(name: string): DriverCollection;
  command(command: Record<string, unknown>): Promise<unknown>;
}
interface DriverClient {
  connect(): Promise<unknown>;
  db(name: string): DriverDb;
  close(force?: boolean): Promise<void>;
}
export interface MongoDriverModule {
  MongoClient: new (
    uri: string,
    options?: Record<string, unknown>,
  ) => DriverClient;
  BSON?: {
    EJSON?: {
      deserialize(value: unknown, options?: { relaxed?: boolean }): unknown;
      serialize(value: unknown, options?: { relaxed?: boolean }): unknown;
    };
  };
}

export interface MongoSourceDeps {
  /** Run environment: PATH, CAIRN_MONGOSH_BIN, CAIRN_DOCKER_BIN. */
  env?: Record<string, string | undefined>;
  /** Override driver discovery (tests inject an in-memory double). */
  loadDriver?: () => Promise<MongoDriverModule | undefined>;
  /**
   * Directories the optional `mongodb` package is resolved from, in order
   * (the spec / config directory); the working directory and cairntrace's
   * own install are tried after them.
   */
  driverSearchDirs?: readonly string[];
}

/**
 * A datasource failure. `permanent` marks configuration problems (unknown
 * or invalid source, guard refusal, missing secret, missing driver or CLI
 * binary, auth refusal) that a
 * poll loop must not wait out; transport failures are transient.
 */
export class DatasourceError extends Error {
  readonly permanent: boolean;
  constructor(message: string, opts: { permanent?: boolean } = {}) {
    super(message);
    this.name = "DatasourceError";
    this.permanent = opts.permanent === true;
  }
}

const MONGO_SENTINEL = "__CAIRN_MONGO__";
const DEFAULT_CONTAINER_URI = "mongodb://127.0.0.1:27017";
const MAX_SERVER_SELECTION_MS = 15_000;

/**
 * Constant mongosh program. Reads the EJSON request from stdin and the
 * connection string from the environment, prints one sentinel-prefixed
 * relaxed-EJSON line. Exported for tests.
 */
export const MONGOSH_SCRIPT = `(function () {
  // stdin may be a non-blocking pipe (EAGAIN until the parent writes):
  // read it to EOF, waiting briefly instead of failing.
  function readStdin() {
    var fs = require("fs");
    var chunks = [];
    var buf = Buffer.alloc(65536);
    var nap = new Int32Array(new SharedArrayBuffer(4));
    for (;;) {
      var n;
      try {
        n = fs.readSync(0, buf, 0, buf.length, null);
      } catch (e) {
        if (e && e.code === "EAGAIN") {
          Atomics.wait(nap, 0, 0, 5);
          continue;
        }
        throw e;
      }
      if (n === 0) break;
      chunks.push(Buffer.from(buf.subarray(0, n)));
    }
    return Buffer.concat(chunks).toString("utf8");
  }
  var out;
  try {
    var req = EJSON.parse(readStdin() || "{}", { relaxed: true });
    var conn = new Mongo(process.env.CAIRN_MONGO_URI);
    var target = conn.getDB(req.database);
    var coll = target.getCollection(req.collection || "_");
    var maxTimeMS = req.maxTimeMS;
    var result;
    switch (req.op) {
      case "ping":
        result = target.runCommand({ ping: 1 });
        break;
      case "find": {
        var cursor = coll.find(req.filter || {}, req.projection || undefined);
        if (req.sort) cursor = cursor.sort(req.sort);
        cursor = cursor.limit(req.limit || 20);
        if (maxTimeMS) cursor = cursor.maxTimeMS(maxTimeMS);
        result = { docs: cursor.toArray() };
        if (req.count) {
          result.count = coll.countDocuments(req.filter || {}, maxTimeMS ? { maxTimeMS: maxTimeMS } : {});
        }
        break;
      }
      case "insertOne":
        result = coll.insertOne(req.document);
        break;
      case "insertMany":
        result = coll.insertMany(req.documents);
        break;
      case "updateOne":
        result = coll.updateOne(req.filter, req.update, { upsert: !!req.upsert });
        break;
      case "updateMany":
        result = coll.updateMany(req.filter, req.update, { upsert: !!req.upsert });
        break;
      case "replaceOne":
        result = coll.replaceOne(req.filter, req.replacement, { upsert: !!req.upsert });
        break;
      case "deleteOne":
        result = coll.deleteOne(req.filter);
        break;
      case "deleteMany":
        result = coll.deleteMany(req.filter);
        break;
      default:
        throw new Error("unsupported op " + req.op);
    }
    out = { ok: true, result: result };
  } catch (e) {
    out = { ok: false, error: String((e && e.message) || e) };
  }
  print("${MONGO_SENTINEL}" + EJSON.stringify(out, { relaxed: true }));
})();`;

/**
 * Load the optional `mongodb` package. It is resolved from the user's
 * project first (`searchDirs`, then the working directory) — a global or
 * Homebrew cairntrace never sees the project's node_modules through its own
 * module location — and only then from cairntrace's own install.
 */
export async function loadInstalledMongoDriver(
  searchDirs: readonly string[] = [],
): Promise<MongoDriverModule | undefined> {
  const tried = new Set<string>();
  for (const dir of [...searchDirs, process.cwd()]) {
    let resolved: string;
    try {
      resolved = createRequire(join(dir, "package.json")).resolve("mongodb");
    } catch {
      continue;
    }
    if (tried.has(resolved)) continue;
    tried.add(resolved);
    const mod = await importDriver(pathToFileURL(resolved).href);
    if (mod) return mod;
  }
  // A variable specifier keeps bundlers/type-checkers from requiring it.
  return importDriver("mongodb");
}

async function importDriver(
  specifier: string,
): Promise<MongoDriverModule | undefined> {
  try {
    const mod = (await import(specifier)) as Partial<MongoDriverModule> & {
      default?: Partial<MongoDriverModule>;
    };
    if (typeof mod.MongoClient === "function") return mod as MongoDriverModule;
    if (typeof mod.default?.MongoClient === "function") {
      return mod.default as MongoDriverModule;
    }
    return undefined;
  } catch {
    return undefined;
  }
}

export async function openMongoSource(
  name: string,
  ds: MongoDatasource,
  deps: MongoSourceDeps = {},
): Promise<MongoSource> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const secrets = datasourceSecretValues(ds);
  const scrub = (text: string): string => scrubDatasourceText(text, secrets);
  const mode = ds.mode ?? "read-write";

  let transport: MongoTransport;
  let driver: MongoDriverModule | undefined;
  if (ds.transport === "docker" || (!ds.transport && !ds.uri)) {
    transport = "docker";
  } else if (ds.transport === "mongosh") {
    transport = "mongosh";
  } else {
    driver = await (deps.loadDriver
      ? deps.loadDriver()
      : loadInstalledMongoDriver(deps.driverSearchDirs));
    if (driver) {
      transport = "driver";
    } else if (ds.transport === "driver") {
      throw new DatasourceError(
        `datasource ${name}: transport driver needs the optional "mongodb" package installed in the project (bun add mongodb, then run cairn from that project), or drop transport to fall back to mongosh`,
        { permanent: true },
      );
    } else {
      transport = "mongosh";
    }
  }

  // Hosts the transport connects to. docker: the in-container URI (its
  // default is the container's own mongod, which the guard does not judge).
  const guardedUri = transport === "docker" ? ds.docker?.uri : (ds.uri ?? "");
  const hosts = guardedUri === undefined ? [] : mongoUriHosts(guardedUri);
  if (guardedUri !== undefined && ds.guard?.hosts) {
    const allowed = ds.guard.hosts.map((host) => host.toLowerCase());
    const offending = hosts.filter((host) => {
      const bare = hostNames([host])[0]!;
      return !allowed.includes(host.toLowerCase()) && !allowed.includes(bare);
    });
    if (hosts.length === 0 || offending.length > 0) {
      throw new DatasourceError(
        `datasource ${name}: refused host ${offending.join(", ") || "(none)"} — not in guard.hosts [${ds.guard.hosts.join(", ")}]`,
        { permanent: true },
      );
    }
  }

  const descriptor: MongoSourceDescriptor = {
    name,
    kind: "mongo",
    transport,
    database: ds.database,
    mode,
    ...(hosts.length > 0 ? { hosts } : {}),
    ...(transport === "docker" && ds.docker?.service
      ? { service: ds.docker.service }
      : {}),
    ...(transport === "docker" && ds.docker?.container
      ? { container: ds.docker.container }
      : {}),
  };

  const databaseFor = (requested: string | undefined): string => {
    const database = requested ?? ds.database;
    if (ds.guard?.databases && !ds.guard.databases.includes(database)) {
      throw new DatasourceError(
        `datasource ${name}: refused database "${database}" — not in guard.databases [${ds.guard.databases.join(", ")}]`,
        { permanent: true },
      );
    }
    return database;
  };

  const shell =
    transport === "driver"
      ? undefined
      : new MongoshRunner(name, ds, transport, env, scrub);
  const driverRunner =
    transport === "driver" && driver
      ? new DriverRunner(name, ds.uri!, driver, scrub)
      : undefined;

  return {
    descriptor,
    async find(req, opts) {
      const database = databaseFor(req.database);
      const request = {
        op: "find",
        database,
        collection: req.collection,
        filter: req.filter ?? {},
        ...(req.projection ? { projection: req.projection } : {}),
        ...(req.sort ? { sort: req.sort } : {}),
        limit: req.limit ?? 20,
        count: req.count === true,
      };
      const result = driverRunner
        ? await driverRunner.run(request, opts)
        : await shell!.run(request, opts);
      return normalizeFindResult(result, scrub);
    },
    async write(req, opts) {
      if (mode === "read-only") {
        throw new DatasourceError(
          `datasource ${name} is read-only: refused ${req.op} on ${req.collection}`,
          { permanent: true },
        );
      }
      const request = { ...req, database: databaseFor(req.database) };
      const result = driverRunner
        ? await driverRunner.run(request, opts)
        : await shell!.run(request, opts);
      return (result ?? {}) as MongoWriteResult;
    },
    async ping(opts) {
      const request = { op: "ping", database: databaseFor(undefined) };
      if (driverRunner) await driverRunner.run(request, opts);
      else await shell!.run(request, opts);
    },
    async close() {
      await driverRunner?.close();
    },
  };
}

function normalizeFindResult(
  result: unknown,
  scrub: (text: string) => string,
): MongoFindResult {
  if (result === null || typeof result !== "object") {
    throw new DatasourceError(
      scrub(`mongo find returned ${JSON.stringify(result)?.slice(0, 200)}`),
    );
  }
  const record = result as { docs?: unknown; count?: unknown };
  const docs = Array.isArray(record.docs) ? record.docs : [];
  const count =
    typeof record.count === "number"
      ? record.count
      : typeof record.count === "string" && /^\d+$/.test(record.count)
        ? Number(record.count)
        : record.count !== null &&
            typeof record.count === "object" &&
            typeof (record.count as { $numberLong?: unknown }).$numberLong ===
              "string"
          ? Number((record.count as { $numberLong: string }).$numberLong)
          : undefined;
  return { docs, ...(count !== undefined ? { count } : {}) };
}

function remainingMs(deadline: number): number {
  return Math.max(0, deadline - Date.now());
}

/* ----- mongosh / docker exec ----- */

class MongoshRunner {
  private container: string | undefined;

  constructor(
    private readonly name: string,
    private readonly ds: MongoDatasource,
    private readonly transport: "mongosh" | "docker",
    private readonly env: Record<string, string | undefined>,
    private readonly scrub: (text: string) => string,
  ) {}

  async run(
    request: Record<string, unknown>,
    opts: MongoCallOptions,
  ): Promise<unknown> {
    const remaining = remainingMs(opts.deadline);
    if (remaining <= 0) {
      throw new DatasourceError(
        `datasource ${this.name}: deadline exhausted before the query`,
      );
    }
    const payload = JSON.stringify({ ...request, maxTimeMS: remaining });
    let bin: string;
    let args: string[];
    let uri: string;
    if (this.transport === "docker") {
      const container = await this.resolveContainer(opts);
      bin = this.env["CAIRN_DOCKER_BIN"] || "docker";
      args = [
        "exec",
        "-i",
        "-e",
        "CAIRN_MONGO_URI",
        container,
        "mongosh",
        "--nodb",
        "--quiet",
        "--eval",
        MONGOSH_SCRIPT,
      ];
      uri = this.ds.docker?.uri ?? DEFAULT_CONTAINER_URI;
    } else {
      bin = this.env["CAIRN_MONGOSH_BIN"] || "mongosh";
      args = ["--nodb", "--quiet", "--eval", MONGOSH_SCRIPT];
      uri = withServerSelectionTimeout(this.ds.uri!, remaining);
    }
    let child;
    try {
      child = await execa(bin, args, {
        env: { ...this.env, CAIRN_MONGO_URI: uri },
        extendEnv: false,
        reject: false,
        // The request goes in on stdin: no argv/env size ceiling.
        input: payload,
        timeout: remaining,
        maxBuffer: 32 * 1024 * 1024,
        ...(opts.signal ? { cancelSignal: opts.signal } : {}),
      });
    } catch (error) {
      throw new DatasourceError(
        this.scrub(
          `datasource ${this.name}: could not start ${bin}: ${(error as Error).message}`,
        ),
        { permanent: true },
      );
    }
    if (isSpawnFailure(child)) throw this.spawnError(bin, child);
    if (child.timedOut) {
      throw new DatasourceError(
        `datasource ${this.name}: ${this.transport} query timed out after ${remaining}ms`,
      );
    }
    const line = String(child.stdout ?? "")
      .split(/\r?\n/)
      .toReversed()
      .find((candidate) => candidate.startsWith(MONGO_SENTINEL));
    if (!line) {
      const detail = this.scrub(
        tail(`${child.stderr ?? ""}\n${child.stdout ?? ""}`.trim(), 600),
      );
      throw new DatasourceError(
        `datasource ${this.name}: ${this.transport} exited ${child.exitCode ?? "?"} without a result${
          detail ? `: ${detail}` : ""
        }`,
      );
    }
    let parsed: { ok?: unknown; result?: unknown; error?: unknown };
    try {
      parsed = JSON.parse(line.slice(MONGO_SENTINEL.length));
    } catch {
      throw new DatasourceError(
        `datasource ${this.name}: ${this.transport} printed an unreadable result`,
      );
    }
    if (parsed.ok !== true) {
      throw new DatasourceError(
        this.scrub(
          `datasource ${this.name}: ${String(parsed.error ?? "query failed")}`,
        ),
      );
    }
    return parsed.result;
  }

  private async resolveContainer(opts: MongoCallOptions): Promise<string> {
    if (this.container) return this.container;
    const docker = this.ds.docker!;
    if (docker.container) {
      this.container = docker.container;
      return docker.container;
    }
    const bin = this.env["CAIRN_DOCKER_BIN"] || "docker";
    const args = [
      "ps",
      "--filter",
      `label=com.docker.compose.service=${docker.service}`,
      ...(docker.project
        ? ["--filter", `label=com.docker.compose.project=${docker.project}`]
        : []),
      "--format",
      "{{.Names}}",
    ];
    const child = await execa(bin, args, {
      env: this.env,
      extendEnv: false,
      reject: false,
      stdin: "ignore",
      timeout: Math.max(1, Math.min(10_000, remainingMs(opts.deadline))),
      ...(opts.signal ? { cancelSignal: opts.signal } : {}),
    });
    if (isSpawnFailure(child)) throw this.spawnError(bin, child);
    if (child.exitCode !== 0) {
      throw new DatasourceError(
        `datasource ${this.name}: could not list containers for compose service "${docker.service}": ${this.scrub(tail(String(child.stderr || child.message || ""), 300))}`,
      );
    }
    const names = String(child.stdout ?? "")
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    if (names.length === 0) {
      throw new DatasourceError(
        `datasource ${this.name}: no running container has compose service label "${docker.service}"${
          docker.project ? ` in project "${docker.project}"` : ""
        }`,
      );
    }
    if (names.length > 1) {
      throw new DatasourceError(
        `datasource ${this.name}: ${names.length} containers run compose service "${docker.service}" (${names.join(", ")}); set docker.project`,
        { permanent: true },
      );
    }
    this.container = names[0]!;
    return this.container;
  }

  /** The binary could not be started (missing, not executable): permanent. */
  private spawnError(
    bin: string,
    child: { code?: unknown; message?: unknown },
  ): DatasourceError {
    const variable =
      this.transport === "docker" ? "CAIRN_DOCKER_BIN" : "CAIRN_MONGOSH_BIN";
    const code = typeof child.code === "string" ? child.code : "";
    return new DatasourceError(
      code === "ENOENT"
        ? `datasource ${this.name}: ${bin} is not installed or not on PATH (set ${variable})`
        : this.scrub(
            `datasource ${this.name}: could not start ${bin} (${code || "spawn failed"}): ${tail(String(child.message ?? ""), 300)}`,
          ),
      { permanent: true },
    );
  }
}

/** execa's result for a child that never ran (ENOENT, EACCES, E2BIG, …). */
function isSpawnFailure(child: {
  exitCode?: number;
  code?: unknown;
  timedOut?: boolean;
  isCanceled?: boolean;
}): boolean {
  return (
    child.exitCode === undefined &&
    child.timedOut !== true &&
    child.isCanceled !== true &&
    typeof child.code === "string" &&
    /^E[A-Z0-9]+$/.test(child.code)
  );
}

function withServerSelectionTimeout(uri: string, remaining: number): string {
  if (/serverSelectionTimeoutMS=/i.test(uri)) return uri;
  const timeout = Math.max(1000, Math.min(MAX_SERVER_SELECTION_MS, remaining));
  const [base, hash] = uri.split("#", 2) as [string, string | undefined];
  const joined = `${base}${
    base.includes("?") ? "&" : "?"
  }serverSelectionTimeoutMS=${timeout}`;
  return hash === undefined ? joined : `${joined}#${hash}`;
}

function tail(text: string, max: number): string {
  return text.length <= max ? text : text.slice(text.length - max);
}

/* ----- driver ----- */

class DriverRunner {
  private client: DriverClient | undefined;
  private connecting: Promise<DriverClient> | undefined;

  constructor(
    private readonly name: string,
    private readonly uri: string,
    private readonly driver: MongoDriverModule,
    private readonly scrub: (text: string) => string,
  ) {}

  async run(
    request: Record<string, unknown>,
    opts: MongoCallOptions,
  ): Promise<unknown> {
    const remaining = remainingMs(opts.deadline);
    if (remaining <= 0) {
      throw new DatasourceError(
        `datasource ${this.name}: deadline exhausted before the query`,
      );
    }
    try {
      return await withDeadline(
        this.execute(request, remaining),
        remaining,
        `datasource ${this.name}: driver query timed out after ${remaining}ms`,
        opts.signal,
      );
    } catch (error) {
      if (error instanceof DatasourceError) throw error;
      throw new DatasourceError(
        this.scrub(`datasource ${this.name}: ${(error as Error).message}`),
      );
    }
  }

  private async connect(remaining: number): Promise<DriverClient> {
    if (this.client) return this.client;
    if (!this.connecting) {
      const timeout = Math.max(
        1000,
        Math.min(MAX_SERVER_SELECTION_MS, remaining),
      );
      const client = new this.driver.MongoClient(this.uri, {
        serverSelectionTimeoutMS: timeout,
        connectTimeoutMS: timeout,
      });
      this.connecting = client
        .connect()
        .then(() => {
          this.client = client;
          return client;
        })
        .catch((error: unknown) => {
          this.connecting = undefined;
          throw error;
        });
    }
    return this.connecting;
  }

  private async execute(
    request: Record<string, unknown>,
    remaining: number,
  ): Promise<unknown> {
    const client = await this.connect(remaining);
    const db = client.db(String(request["database"]));
    const ejson = this.driver.BSON?.EJSON;
    const decode = (value: unknown): unknown =>
      ejson ? ejson.deserialize(value, { relaxed: true }) : value;
    const encode = (value: unknown): unknown =>
      ejson
        ? ejson.serialize(value, { relaxed: true })
        : nativeToRelaxedEjson(value);
    const op = String(request["op"]);
    if (op === "ping") return encode(await db.command({ ping: 1 }));
    const coll = db.collection(String(request["collection"]));
    const filter = decode(request["filter"] ?? {});
    const maxTimeMS = Math.max(1, remaining);
    switch (op) {
      case "find": {
        const docs = await coll
          .find(filter, {
            ...(request["projection"]
              ? { projection: decode(request["projection"]) }
              : {}),
            ...(request["sort"] ? { sort: request["sort"] } : {}),
            limit: Number(request["limit"] ?? 20),
            maxTimeMS,
          })
          .toArray();
        const out: Record<string, unknown> = { docs: encode(docs) };
        if (request["count"]) {
          out["count"] = await coll.countDocuments(filter, { maxTimeMS });
        }
        return out;
      }
      case "insertOne":
        return encode(await coll.insertOne(decode(request["document"])));
      case "insertMany":
        return encode(
          await coll.insertMany(decode(request["documents"]) as unknown[]),
        );
      case "updateOne":
      case "updateMany":
        return encode(
          await coll[op](filter, decode(request["update"]), {
            upsert: request["upsert"] === true,
          }),
        );
      case "replaceOne":
        return encode(
          await coll.replaceOne(filter, decode(request["replacement"]), {
            upsert: request["upsert"] === true,
          }),
        );
      case "deleteOne":
      case "deleteMany":
        return encode(await coll[op](filter));
      default:
        throw new DatasourceError(`unsupported op ${op}`);
    }
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = undefined;
    this.connecting = undefined;
    await client?.close(true).catch(() => undefined);
  }
}

async function withDeadline<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
  signal?: AbortSignal,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new DatasourceError(message)), ms);
        if (signal) {
          onAbort = () => reject(new DatasourceError("cancelled"));
          if (signal.aborted) onAbort();
          else signal.addEventListener("abort", onAbort, { once: true });
        }
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  }
}
