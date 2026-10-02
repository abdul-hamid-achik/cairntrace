import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MockBrowserBackend } from "../../adapters/mock/MockBrowserBackend";
import { evaluateOutcomes } from "../runner/OutcomeEvaluator";
import type { VerifierContext } from "../runner/verifiers/types";
import { OutcomeSchema, type Outcome } from "../schema/spec.v1";
import {
  loadInstalledMongoDriver,
  MONGOSH_SCRIPT,
  openMongoSource,
  type MongoDriverModule,
} from "./mongo";
import { resolveEnvironmentDatasources } from "./resolve";
import { DatasourcesConfigSchema, type MongoDatasource } from "./schema";

/* ----- an in-memory stand-in for the optional `mongodb` driver ----- */

type Doc = Record<string, unknown>;

function comparable(value: unknown): unknown {
  if (value instanceof Date) return value.getTime();
  if (
    value !== null &&
    typeof value === "object" &&
    typeof (value as { $date?: unknown }).$date === "string"
  ) {
    return Date.parse((value as { $date: string }).$date);
  }
  return value;
}

function getPath(doc: Doc, path: string): unknown {
  let value: unknown = doc;
  for (const key of path.split(".")) {
    if (value === null || typeof value !== "object") return undefined;
    value = (value as Doc)[key];
  }
  return value;
}

function matchesFilter(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([path, condition]) => {
    const actual = comparable(getPath(doc, path));
    if (
      condition !== null &&
      typeof condition === "object" &&
      Object.keys(condition).some((key) => key.startsWith("$")) &&
      !("$date" in condition) &&
      !("$oid" in condition)
    ) {
      return Object.entries(condition as Doc).every(([op, raw]) => {
        const want = comparable(raw);
        switch (op) {
          case "$gte":
            return (actual as number) >= (want as number);
          case "$gt":
            return (actual as number) > (want as number);
          case "$lte":
            return (actual as number) <= (want as number);
          case "$ne":
            return JSON.stringify(actual) !== JSON.stringify(want);
          case "$in":
            return (raw as unknown[]).some(
              (item) =>
                JSON.stringify(comparable(item)) === JSON.stringify(actual),
            );
          default:
            throw new Error(`memory mongo: unsupported operator ${op}`);
        }
      });
    }
    return JSON.stringify(actual) === JSON.stringify(comparable(condition));
  });
}

class MemoryCollection {
  constructor(private readonly docs: Doc[]) {}
  find(
    filter: Doc,
    options: {
      sort?: Record<string, 1 | -1>;
      limit?: number;
      projection?: Doc;
    } = {},
  ) {
    let out = this.docs.filter((doc) => matchesFilter(doc, filter));
    const sort = options.sort;
    if (sort) {
      out = out.toSorted((a, b) => {
        for (const [key, dir] of Object.entries(sort)) {
          const av = comparable(getPath(a, key)) as number;
          const bv = comparable(getPath(b, key)) as number;
          if (av !== bv) return av < bv ? -dir : dir;
        }
        return 0;
      });
    }
    if (options.limit) out = out.slice(0, options.limit);
    if (options.projection) {
      const keys = Object.keys(options.projection);
      out = out.map((doc) => {
        const projected: Doc = { _id: doc["_id"] };
        for (const key of keys) projected[key] = doc[key];
        return projected;
      });
    }
    return { toArray: async () => out.map((doc) => ({ ...doc })) };
  }
  async countDocuments(filter: Doc) {
    return this.docs.filter((doc) => matchesFilter(doc, filter)).length;
  }
  async insertOne(doc: Doc) {
    this.docs.push(doc);
    return { acknowledged: true, insertedId: doc["_id"] };
  }
  async insertMany(docs: Doc[]) {
    this.docs.push(...docs);
    return { acknowledged: true, insertedCount: docs.length };
  }
  async updateOne(filter: Doc, update: Doc) {
    const doc = this.docs.find((candidate) => matchesFilter(candidate, filter));
    if (doc) Object.assign(doc, update["$set"] as Doc);
    return {
      acknowledged: true,
      matchedCount: doc ? 1 : 0,
      modifiedCount: doc ? 1 : 0,
    };
  }
  async updateMany(filter: Doc, update: Doc) {
    return this.updateOne(filter, update);
  }
  async replaceOne() {
    return { acknowledged: true };
  }
  async deleteOne() {
    return { acknowledged: true, deletedCount: 0 };
  }
  async deleteMany(filter: Doc) {
    const before = this.docs.length;
    const keep = this.docs.filter((doc) => !matchesFilter(doc, filter));
    this.docs.splice(0, this.docs.length, ...keep);
    return { acknowledged: true, deletedCount: before - keep.length };
  }
}

function memoryDriver(
  data: Record<string, Record<string, Doc[]>>,
  log: string[] = [],
): MongoDriverModule {
  class MemoryClient {
    constructor(uri: string, options?: Record<string, unknown>) {
      log.push(`new ${uri} ${JSON.stringify(options)}`);
    }
    async connect() {
      log.push("connect");
    }
    db(name: string) {
      const database = (data[name] ??= {});
      return {
        collection: (collection: string) =>
          new MemoryCollection((database[collection] ??= [])),
        command: async () => ({ ok: 1 }),
      };
    }
    async close() {
      log.push("close");
    }
  }
  return {
    MongoClient: MemoryClient as unknown as MongoDriverModule["MongoClient"],
  };
}

const URI = "mongodb://app_user:s3cr3t-pw@db.example.test:27017/shop";

function mongoDs(overrides: Partial<MongoDatasource> = {}): MongoDatasource {
  return { kind: "mongo", uri: URI, database: "shop", ...overrides };
}

const soon = () => ({ deadline: Date.now() + 5000 });

describe("mongo datasource: driver transport (in-memory double)", () => {
  it("finds, counts, sorts and limits through the optional driver", async () => {
    const log: string[] = [];
    const data = {
      shop: {
        orders: [
          {
            _id: { $oid: "a1" },
            status: "open",
            total: 5,
            updatedAt: new Date("2026-01-01T00:00:00Z"),
          },
          {
            _id: { $oid: "a2" },
            status: "open",
            total: 9,
            updatedAt: new Date("2026-01-03T00:00:00Z"),
          },
          {
            _id: { $oid: "a3" },
            status: "closed",
            total: 1,
            updatedAt: new Date("2026-01-02T00:00:00Z"),
          },
        ],
      },
    };
    const source = await openMongoSource("app", mongoDs(), {
      loadDriver: async () => memoryDriver(data, log),
    });
    expect(source.descriptor).toMatchObject({
      name: "app",
      transport: "driver",
      database: "shop",
      hosts: ["db.example.test:27017"],
      mode: "read-write",
    });
    expect(JSON.stringify(source.descriptor)).not.toContain("s3cr3t");
    const result = await source.find(
      {
        collection: "orders",
        filter: { status: "open" },
        sort: { updatedAt: -1 },
        limit: 1,
        count: true,
      },
      soon(),
    );
    expect(result.count).toBe(2);
    expect(result.docs).toEqual([
      expect.objectContaining({
        _id: { $oid: "a2" },
        updatedAt: { $date: "2026-01-03T00:00:00.000Z" },
      }),
    ]);
    await source.close();
    expect(log).toContain("connect");
    expect(log.at(-1)).toBe("close");
  });

  it("refuses writes on a read-only source and databases outside the guard", async () => {
    const data = { shop: { orders: [] as Doc[] } };
    const readOnly = await openMongoSource(
      "ro",
      mongoDs({ mode: "read-only" }),
      {
        loadDriver: async () => memoryDriver(data),
      },
    );
    await expect(
      readOnly.write(
        { op: "insertOne", collection: "orders", document: { _id: 1 } },
        soon(),
      ),
    ).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining("read-only"),
    });

    const guarded = await openMongoSource(
      "app",
      mongoDs({ guard: { databases: ["shop"] } }),
      { loadDriver: async () => memoryDriver(data) },
    );
    await expect(
      guarded.find({ database: "admin", collection: "users" }, soon()),
    ).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining("guard.databases"),
    });
    const written = await guarded.write(
      { op: "insertOne", collection: "orders", document: { _id: 7 } },
      soon(),
    );
    expect(written).toMatchObject({ acknowledged: true, insertedId: 7 });
    expect(data.shop.orders).toHaveLength(1);
  });

  it("refuses a URI whose host is outside guard.hosts before connecting", async () => {
    const log: string[] = [];
    await expect(
      openMongoSource(
        "app",
        mongoDs({ guard: { hosts: ["127.0.0.1", "localhost"] } }),
        {
          loadDriver: async () => memoryDriver({}, log),
        },
      ),
    ).rejects.toThrow(/refused host db\.example\.test:27017/);
    expect(log).toEqual([]);
  });

  it("applies guard.hosts to the in-container URI of the docker transport", async () => {
    const remote = openMongoSource(
      "app",
      {
        kind: "mongo",
        docker: {
          container: "c1",
          uri: "mongodb://ops:pw@prod-db.example.test:27017",
        },
        database: "shop",
        guard: { hosts: ["localhost", "127.0.0.1"] },
      },
      { env: {} },
    );
    await expect(remote).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining(
        "refused host prod-db.example.test:27017",
      ),
    });
    await expect(remote).rejects.not.toThrow(/pw@/);
    // The default in-container URI is the container's own mongod.
    const local = await openMongoSource(
      "app",
      {
        kind: "mongo",
        docker: { container: "c1" },
        database: "shop",
        guard: { hosts: ["localhost"] },
      },
      { env: {} },
    );
    expect(local.descriptor.transport).toBe("docker");
    const listed = await openMongoSource(
      "app",
      {
        kind: "mongo",
        docker: { container: "c1", uri: "mongodb://127.0.0.1:27018" },
        database: "shop",
        guard: { hosts: ["127.0.0.1"] },
      },
      { env: {} },
    );
    expect(listed.descriptor).toMatchObject({
      transport: "docker",
      hosts: ["127.0.0.1:27018"],
    });
  });

  it("resolves the optional driver from the project directory before its own install", async () => {
    const project = await mkdtemp(join(tmpdir(), "cairn-driver-project-"));
    const pkg = join(project, "node_modules", "mongodb");
    await mkdir(pkg, { recursive: true });
    await writeFile(
      join(pkg, "package.json"),
      JSON.stringify({ name: "mongodb", version: "6.99.0", main: "index.js" }),
    );
    await writeFile(
      join(pkg, "index.js"),
      "class MongoClient { constructor(uri) { this.uri = uri; } }\nmodule.exports = { MongoClient, FROM_PROJECT: true };\n",
    );
    const nested = join(project, "specs", "orders");
    await mkdir(nested, { recursive: true });
    const driver = (await loadInstalledMongoDriver([nested])) as
      | (MongoDriverModule & { FROM_PROJECT?: boolean })
      | undefined;
    expect(typeof driver?.MongoClient).toBe("function");
    expect(driver?.FROM_PROJECT).toBe(true);
  });

  it("falls back to mongosh when the driver is not installed, and requires it when forced", async () => {
    const auto = await openMongoSource("app", mongoDs(), {
      loadDriver: async () => undefined,
    });
    expect(auto.descriptor.transport).toBe("mongosh");
    await expect(
      openMongoSource("app", mongoDs({ transport: "driver" }), {
        loadDriver: async () => undefined,
      }),
    ).rejects.toThrow(/optional "mongodb" package/);
  });
});

/* ----- CLI transports: a fake mongosh and a fake docker ----- */

async function fakeBin(
  dir: string,
  name: string,
  body: string,
): Promise<string> {
  const path = join(dir, name);
  await writeFile(path, `#!${process.execPath}\n${body}\n`);
  await chmod(path, 0o755);
  return path;
}

/** Answers like MONGOSH_SCRIPT would, from a JSON dataset; logs every call. */
const FAKE_MONGOSH = String.raw`
const fs = require("node:fs");
const env = process.env;
const stdin = fs.readFileSync(0, "utf8");
const req = JSON.parse(stdin);
fs.appendFileSync(env.FAKE_LOG, JSON.stringify({
  argv: process.argv.slice(2),
  uri: env.CAIRN_MONGO_URI,
  envNames: Object.keys(env).filter((name) => name.startsWith("CAIRN_MONGO_")),
  stdinBytes: stdin.length,
  op: req.op,
  collection: req.collection,
}) + "\n");
console.log("Current Mongosh Log ID: noise");
if (env.FAKE_FAIL) {
  console.log("__CAIRN_MONGO__" + JSON.stringify({ ok: false, error: "auth failed for " + env.CAIRN_MONGO_URI }));
  process.exit(0);
}
const data = JSON.parse(fs.readFileSync(env.FAKE_DATA, "utf8"));
const docs = (data[req.collection] || []).filter((d) =>
  Object.entries(req.filter || {}).every(([k, v]) => JSON.stringify(d[k]) === JSON.stringify(v)));
console.log("__CAIRN_MONGO__" + JSON.stringify({ ok: true, result: { docs: docs.slice(0, req.limit), count: docs.length } }));
`;

describe("mongo datasource: mongosh and docker transports", () => {
  it("passes the request on stdin and the URI through the environment, never argv, and parses the sentinel line", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-fake-mongosh-"));
    const bin = await fakeBin(dir, "mongosh", FAKE_MONGOSH);
    const dataPath = join(dir, "data.json");
    await writeFile(
      dataPath,
      JSON.stringify({
        tasks: [{ _id: { $oid: "t1" }, title: "Review", done: true }],
      }),
    );
    const logPath = join(dir, "calls.ndjson");
    const env = {
      PATH: process.env["PATH"],
      CAIRN_MONGOSH_BIN: bin,
      FAKE_DATA: dataPath,
      FAKE_LOG: logPath,
    };
    const source = await openMongoSource(
      "app",
      mongoDs({ transport: "mongosh" }),
      { env },
    );
    const result = await source.find(
      { collection: "tasks", filter: { title: "Review" }, count: true },
      soon(),
    );
    expect(result).toEqual({
      docs: [{ _id: { $oid: "t1" }, title: "Review", done: true }],
      count: 1,
    });
    const call = JSON.parse((await readFile(logPath, "utf8")).trim());
    expect(call.argv.slice(0, 3)).toEqual(["--nodb", "--quiet", "--eval"]);
    expect(call.argv[3]).toBe(MONGOSH_SCRIPT);
    expect(call.argv.join(" ")).not.toContain("s3cr3t");
    expect(call.argv.join(" ")).not.toContain("Review");
    expect(call.uri).toContain("serverSelectionTimeoutMS=");
    expect(call.envNames).toEqual(["CAIRN_MONGO_URI"]);
    expect(call).toMatchObject({ op: "find", collection: "tasks" });
  });

  it("sends requests far above the environment-size ceiling (stdin, not env)", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-fake-mongosh-"));
    const bin = await fakeBin(dir, "mongosh", FAKE_MONGOSH);
    const logPath = join(dir, "calls.ndjson");
    await writeFile(join(dir, "data.json"), "{}");
    const source = await openMongoSource(
      "app",
      mongoDs({ transport: "mongosh" }),
      {
        env: {
          PATH: process.env["PATH"],
          CAIRN_MONGOSH_BIN: bin,
          FAKE_DATA: join(dir, "data.json"),
          FAKE_LOG: logPath,
        },
      },
    );
    // ~2.6MB: over Linux MAX_ARG_STRLEN (128KiB) and macOS ARG_MAX (1MiB).
    const ids = Array.from(
      { length: 60_000 },
      (_, i) => `id-${i}-${"x".repeat(30)}`,
    );
    await source.find(
      { collection: "tasks", filter: { _id: { $in: ids } } },
      soon(),
    );
    const call = JSON.parse((await readFile(logPath, "utf8")).trim());
    expect(call.stdinBytes).toBeGreaterThan(2_000_000);
  });

  it("fails permanently, without retrying, when the mongosh binary is missing", async () => {
    const source = await openMongoSource(
      "app",
      mongoDs({ transport: "mongosh" }),
      {
        env: {
          PATH: process.env["PATH"],
          CAIRN_MONGOSH_BIN: "/nonexistent/cairn-mongosh",
        },
      },
    );
    await expect(
      source.find({ collection: "tasks" }, soon()),
    ).rejects.toMatchObject({
      permanent: true,
      message: expect.stringContaining(
        "/nonexistent/cairn-mongosh is not installed or not on PATH (set CAIRN_MONGOSH_BIN)",
      ),
    });
  });

  it("scrubs the connection string out of a transport error", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-fake-mongosh-"));
    const bin = await fakeBin(dir, "mongosh", FAKE_MONGOSH);
    const env = {
      PATH: process.env["PATH"],
      CAIRN_MONGOSH_BIN: bin,
      FAKE_LOG: join(dir, "calls.ndjson"),
      FAKE_FAIL: "1",
    };
    const source = await openMongoSource(
      "app",
      mongoDs({ transport: "mongosh" }),
      { env },
    );
    const error = await source
      .find({ collection: "tasks" }, soon())
      .catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("auth failed");
    expect((error as Error).message).not.toContain("s3cr3t");
    expect((error as Error).message).toContain(
      "mongodb://***@db.example.test:27017/shop",
    );
  });

  it("resolves the container from its compose service label, pipes the request with docker exec -i and forwards the URI with -e", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cairn-fake-docker-"));
    const dataPath = join(dir, "data.json");
    await writeFile(
      dataPath,
      JSON.stringify({ kits: [{ _id: "k1", name: "Demo kit" }] }),
    );
    const logPath = join(dir, "calls.ndjson");
    const docker = await fakeBin(
      dir,
      "docker",
      String.raw`
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.FAKE_LOG, JSON.stringify({ args }) + "\n");
if (args[0] === "ps") { console.log("demo-mongo-1"); process.exit(0); }
if (args[0] === "exec") {
  const req = JSON.parse(fs.readFileSync(0, "utf8"));
  const data = JSON.parse(fs.readFileSync(process.env.FAKE_DATA, "utf8"));
  const docs = (data[req.collection] || []);
  console.log("__CAIRN_MONGO__" + JSON.stringify({ ok: true, result: { docs, count: docs.length, uri: process.env.CAIRN_MONGO_URI } }));
  process.exit(0);
}
process.exit(3);
`,
    );
    const env = {
      PATH: process.env["PATH"],
      CAIRN_DOCKER_BIN: docker,
      FAKE_DATA: dataPath,
      FAKE_LOG: logPath,
    };
    const source = await openMongoSource(
      "app",
      {
        kind: "mongo",
        docker: { service: "mongo", project: "demo" },
        database: "shop",
      },
      { env },
    );
    expect(source.descriptor).toMatchObject({
      transport: "docker",
      service: "mongo",
    });
    const result = await source.find(
      { collection: "kits", count: true },
      soon(),
    );
    expect(result.count).toBe(1);
    const calls = (await readFile(logPath, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line).args as string[]);
    expect(calls[0]).toEqual([
      "ps",
      "--filter",
      "label=com.docker.compose.service=mongo",
      "--filter",
      "label=com.docker.compose.project=demo",
      "--format",
      "{{.Names}}",
    ]);
    expect(calls[1]!.slice(0, 9)).toEqual([
      "exec",
      "-i",
      "-e",
      "CAIRN_MONGO_URI",
      "demo-mongo-1",
      "mongosh",
      "--nodb",
      "--quiet",
      "--eval",
    ]);
    // The container is resolved once per source.
    await source.find({ collection: "kits" }, soon());
    const after = (await readFile(logPath, "utf8")).trim().split("\n");
    expect(after.filter((line) => line.includes('"ps"'))).toHaveLength(1);
  });
});

/** Run MONGOSH_SCRIPT against shimmed mongosh globals. */
type Run = { output: string[]; calls: string[] };
function execute(request: unknown, opts: { failConnect?: boolean } = {}): Run {
  const output: string[] = [];
  const calls: string[] = [];
  const docs = [
    { _id: 1, title: "A" },
    { _id: 2, title: "B" },
  ];
  const collection = {
    find(filter: unknown, projection: unknown) {
      calls.push(
        `find ${JSON.stringify(filter)} ${JSON.stringify(projection)}`,
      );
      const cursor = {
        sort(spec: unknown) {
          calls.push(`sort ${JSON.stringify(spec)}`);
          return cursor;
        },
        limit(n: number) {
          calls.push(`limit ${n}`);
          return cursor;
        },
        maxTimeMS(ms: number) {
          calls.push(`maxTimeMS ${ms > 0}`);
          return cursor;
        },
        toArray: () => docs,
      };
      return cursor;
    },
    countDocuments: () => 2,
    updateOne: (f: unknown, u: unknown, o: unknown) => ({
      matchedCount: 1,
      args: [f, u, o],
    }),
  };
  class Mongo {
    constructor(uri: string) {
      calls.push(`connect ${uri}`);
      if (opts.failConnect) throw new Error(`no server at ${uri}`);
    }
    getDB(name: string) {
      calls.push(`db ${name}`);
      return {
        getCollection: () => collection,
        runCommand: () => ({ ok: 1 }),
      };
    }
  }
  const EJSON = {
    parse: (text: string) => JSON.parse(text),
    stringify: (value: unknown) => JSON.stringify(value),
  };
  const fn = new Function(
    "EJSON",
    "Mongo",
    "print",
    "process",
    "require",
    MONGOSH_SCRIPT,
  );
  // stdin as a non-blocking pipe: EAGAIN first, then the request in two
  // chunks, then EOF.
  const stdin = Buffer.from(JSON.stringify(request), "utf8");
  let offset = 0;
  let eagain = true;
  const require = (name: string) => {
    if (name !== "fs") throw new Error(`unexpected require ${name}`);
    return {
      readSync: (fd: number, buf: Buffer, off: number, len: number) => {
        if (fd !== 0) throw new Error(`unexpected read of fd ${fd}`);
        if (eagain) {
          eagain = false;
          throw Object.assign(new Error("EAGAIN"), { code: "EAGAIN" });
        }
        const n = Math.min(
          len,
          Math.ceil(stdin.length / 2),
          stdin.length - offset,
        );
        stdin.copy(buf, off, offset, offset + n);
        offset += n;
        return n;
      },
    };
  };
  fn(
    EJSON,
    Mongo,
    (line: string) => output.push(line),
    { env: { CAIRN_MONGO_URI: "mongodb://127.0.0.1:27017" } },
    require,
  );
  return { output, calls };
}

describe("MONGOSH_SCRIPT", () => {
  it("runs find + count from the stdin request and prints one sentinel line", () => {
    const run = execute({
      op: "find",
      database: "shop",
      collection: "tasks",
      filter: { done: true },
      projection: { title: 1 },
      sort: { _id: -1 },
      limit: 5,
      count: true,
      maxTimeMS: 1000,
    });
    expect(run.calls).toEqual([
      "connect mongodb://127.0.0.1:27017",
      "db shop",
      'find {"done":true} {"title":1}',
      'sort {"_id":-1}',
      "limit 5",
      "maxTimeMS true",
    ]);
    expect(run.output).toHaveLength(1);
    expect(JSON.parse(run.output[0]!.replace("__CAIRN_MONGO__", ""))).toEqual({
      ok: true,
      result: {
        docs: [
          { _id: 1, title: "A" },
          { _id: 2, title: "B" },
        ],
        count: 2,
      },
    });
  });

  it("passes write options and reports errors and unknown ops as ok:false", () => {
    const write = execute({
      op: "updateOne",
      database: "shop",
      collection: "tasks",
      filter: { _id: 1 },
      update: { $set: { done: true } },
      upsert: true,
    });
    expect(write.output[0]).toContain('"upsert":true');
    const unknown = execute({ op: "dropDatabase", database: "shop" });
    expect(unknown.output[0]).toContain('"ok":false');
    expect(unknown.output[0]).toContain("unsupported op dropDatabase");
    const failed = execute(
      { op: "ping", database: "shop" },
      { failConnect: true },
    );
    expect(failed.output[0]).toContain('"ok":false');
  });
});

/* ----- the mongo verifier, end to end through evaluateOutcomes ----- */

function outcome(raw: unknown): Outcome {
  return OutcomeSchema.parse(raw);
}

function verifierContext(
  data: Record<string, Record<string, Doc[]>>,
  extra: Partial<VerifierContext> = {},
): VerifierContext {
  const datasources = DatasourcesConfigSchema.parse({
    app: {
      kind: "mongo",
      uri: "mongodb://${secrets.APP_MONGO_PASS}@127.0.0.1:27017/shop",
      database: "shop",
    },
  });
  return {
    datasources: resolveEnvironmentDatasources(datasources, undefined),
    childEnv: { APP_MONGO_PASS: "user:hunter22" },
    loadMongoDriver: async () => memoryDriver(data),
    ...extra,
  };
}

describe("mongo verifier", () => {
  it("checks count and first-document fields, assigns {count, docs} for later outcomes", async () => {
    const data = {
      shop: {
        tasks: [
          {
            _id: { $oid: "64aa" },
            title: "Ship order",
            completed: true,
            deleted: false,
            updatedAt: new Date("2026-02-02T10:00:00Z"),
          },
          {
            _id: { $oid: "64ab" },
            title: "Ship order",
            completed: false,
            deleted: false,
            updatedAt: new Date("2026-02-01T10:00:00Z"),
          },
        ],
      },
    };
    const ctx = verifierContext(data);
    const [first, second] = await evaluateOutcomes(
      [
        outcome({
          id: "latest_task_completed",
          description: "the latest task with the title is completed",
          verify: {
            mongo: {
              source: "app",
              collection: "tasks",
              filter: { title: "Ship order" },
              sort: { updatedAt: -1 },
              assign: "task",
              expect: {
                count: { atLeast: 1 },
                fields: {
                  completed: true,
                  deleted: { equals: false },
                  updatedAt: { matches: "^2026-02-02" },
                },
              },
            },
          },
        }),
        outcome({
          id: "task_id_reused",
          description: "a later outcome reads the assigned id",
          verify: {
            mongo: {
              source: "app",
              collection: "tasks",
              filter: { _id: { $oid: "${captures.task.docs.0._id}" } },
              expect: { count: 1 },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx,
    );
    expect(first!.evaluation.passed).toBe(true);
    expect(first!.evaluation.actual).toBe("count=2");
    expect(ctx.captures?.["task"]).toMatchObject({ count: 2 });
    expect(
      (ctx.captures!["task"] as { docs: unknown[] }).docs[0],
    ).toMatchObject({
      _id: "64aa",
      updatedAt: "2026-02-02T10:00:00.000Z",
    });
    expect(first!.evaluation.raw).toMatchObject({
      kind: "mongo",
      source: {
        name: "app",
        kind: "mongo",
        transport: "driver",
        database: "shop",
      },
      request: {
        collection: "tasks",
        filter: { title: "Ship order" },
        limit: 20,
      },
      observed: { count: 2, truncated: false },
    });
    expect(JSON.stringify(first!.evaluation.raw)).not.toContain("hunter22");
    expect(second!.evaluation).toMatchObject({
      passed: true,
      actual: "count=1",
    });
  });

  it("polls until a document appears and reports attempts, polledMs and progress", async () => {
    const data = { shop: { events: [] as Doc[] } };
    const ctx = verifierContext(data);
    const progress: string[] = [];
    setTimeout(
      () => data.shop.events.push({ _id: 1, type: "ORDER_SHIPPED" }),
      150,
    );
    const [result] = await evaluateOutcomes(
      [
        outcome({
          id: "event_logged",
          description: "the event is logged",
          verify: {
            mongo: {
              source: "app",
              collection: "events",
              filter: { type: "ORDER_SHIPPED" },
              expect: { exists: true },
            },
            poll: { timeoutMs: 3000, everyMs: 50 },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx,
      { onProgress: (_o, message) => progress.push(message) },
    );
    expect(result!.evaluation.passed).toBe(true);
    expect(result!.evaluation.attempts).toBeGreaterThan(1);
    expect(result!.evaluation.polledMs).toBeGreaterThanOrEqual(100);
    expect(progress[0]).toMatch(
      /^attempt 1\/~60: count=0 \(want at least one matching document in app\.events\)$/,
    );
    const raw = result!.evaluation.raw as { attempts: Array<{ ok: boolean }> };
    expect(raw.attempts.at(-1)?.ok).toBe(true);
    expect(raw.attempts[0]?.ok).toBe(false);
  });

  it("stays absent for stableMs and fails when a document shows up inside the window", async () => {
    const data = { shop: { events: [] as Doc[] } };
    const ctx = verifierContext(data);
    const verify = {
      mongo: {
        source: "app",
        collection: "events",
        filter: { type: "GAVE_UP" },
        expect: { exists: false },
      },
      poll: { timeoutMs: 1000, everyMs: 50, stableMs: 200 },
    };
    const [quiet] = await evaluateOutcomes(
      [outcome({ id: "no_give_up", description: "no give-up event", verify })],
      new MockBrowserBackend(),
      ctx,
    );
    expect(quiet!.evaluation.passed).toBe(true);
    expect(quiet!.evaluation.actual).toMatch(/held for \d+ms/);

    setTimeout(() => data.shop.events.push({ _id: 9, type: "GAVE_UP" }), 60);
    const [noisy] = await evaluateOutcomes(
      [
        outcome({
          id: "no_give_up",
          description: "no give-up event",
          verify: {
            ...verify,
            poll: { timeoutMs: 400, everyMs: 50, stableMs: 300 },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx,
    );
    expect(noisy!.evaluation.passed).toBe(false);
  });

  it("fails without waiting on configuration errors and on unresolved references", async () => {
    const ctx = verifierContext({});
    const started = Date.now();
    const [unknown, unresolved] = await evaluateOutcomes(
      [
        outcome({
          id: "unknown_source",
          description: "a source that is not configured",
          verify: {
            mongo: { source: "nope", collection: "x" },
            poll: { timeoutMs: 5000 },
          },
        }),
        outcome({
          id: "unresolved_ref",
          description: "a filter with an unknown capture",
          verify: {
            mongo: {
              source: "app",
              collection: "x",
              filter: { id: "${captures.missing.id}" },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx,
    );
    expect(Date.now() - started).toBeLessThan(2000);
    expect(unknown!.evaluation.passed).toBe(false);
    expect(unknown!.evaluation.actual).toMatch(
      /unknown datasource "nope"; config datasources: app/,
    );
    expect(unknown!.evaluation.attempts).toBe(1);
    expect(unresolved!.evaluation).toMatchObject({
      passed: false,
      actual: "unresolved ${captures.missing.id}",
    });
  });

  it("is blocked, not failed, when a failed step never produced the referenced capture", async () => {
    const ctx = verifierContext({}, { failedStep: "save" });
    const [blocked] = await evaluateOutcomes(
      [
        outcome({
          id: "saved_row",
          description: "the saved row exists",
          verify: {
            mongo: {
              source: "app",
              collection: "rows",
              filter: { id: "${captures.row.id}" },
            },
          },
        }),
      ],
      new MockBrowserBackend(),
      ctx,
    );
    expect(blocked!.evaluation).toMatchObject({ passed: false, skipped: true });
    expect(blocked!.evaluation.actual).toContain("captures.row");
  });
});
