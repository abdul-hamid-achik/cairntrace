import { readFile } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { execa } from "execa";
import { ejsonToPlain } from "../datasources/ejson";
import type { MongoSource } from "../datasources/mongo";
import {
  hostNames,
  mongoUriHosts,
  scrubDatasourceText,
} from "../datasources/redact";
import {
  datasourceSecretValues,
  resolveDatasourcePlaceholders,
} from "../datasources/resolve";
import type { MongoDatasource } from "../datasources/schema";
import {
  matchPaths,
  matchValue,
  summarizeReport,
} from "../runner/verifiers/matchers";
import type { ValueMatcher } from "../schema/verifier.v1";
import { lastJsonLine } from "./exec";
import {
  MONGO_FIXTURE_OPS,
  MONGO_READ_OPS,
  type MongoFixture,
  type MongoFixtureOp,
  type MongoFixtureOpName,
  type MongoVerb,
} from "./schema";
import {
  FixtureVerbError,
  remainingMs,
  type FixtureVerbContext,
  type FixtureVerbOutcome,
} from "./types";

/**
 * `kind: mongo` fixtures: declarative operations on a `datasources:` entry
 * (any transport: the optional driver, mongosh or docker exec), or a mongosh
 * `script:` with EJSON `args` for what the operations cannot express.
 *
 * Results are normalized to `{matched, modified, upserted, deleted,
 * inserted, upsertedId?, insertedId?}` (driver and mongosh name these
 * differently) and exposed to `outputs` as `$.ops[i]` and `$.<as>`, with
 * ObjectIds as hex strings and dates as ISO strings.
 */

type Doc = Record<string, unknown>;

interface OpResult {
  name: MongoFixtureOpName;
  /** Plain view for outputs and matchers. */
  value: unknown;
  summary: string;
}

function isPlainObject(value: unknown): value is Doc {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function opName(op: MongoFixtureOp): MongoFixtureOpName {
  return MONGO_FIXTURE_OPS.find((key) => op[key] !== undefined)!;
}

function toNumber(value: unknown): number | undefined {
  const plain = ejsonToPlain(value);
  return typeof plain === "number" && Number.isFinite(plain)
    ? plain
    : undefined;
}

/** Driver and mongosh write results → one shape (plain values). */
export function normalizeWriteResult(raw: unknown): Doc {
  const result = isPlainObject(raw) ? raw : {};
  const out: Doc = {};
  const set = (key: string, value: number | undefined): void => {
    if (value !== undefined) out[key] = value;
  };
  set("matched", toNumber(result["matchedCount"]));
  set("modified", toNumber(result["modifiedCount"]));
  set("deleted", toNumber(result["deletedCount"]));
  const upserted = toNumber(result["upsertedCount"]);
  // mongosh reports the upserted _id as `insertedId`; the driver as `upsertedId`.
  const upsertedId =
    result["upsertedId"] ??
    (upserted !== undefined && upserted > 0 ? result["insertedId"] : undefined);
  if (upserted !== undefined) out["upserted"] = upserted;
  else if (upsertedId !== undefined && upsertedId !== null) out["upserted"] = 1;
  if (upsertedId !== undefined && upsertedId !== null) {
    out["upsertedId"] = ejsonToPlain(upsertedId);
  }
  const insertedCount = toNumber(result["insertedCount"]);
  if (insertedCount !== undefined) {
    out["inserted"] = insertedCount;
  } else if (
    upserted === undefined &&
    result["insertedId"] !== undefined &&
    result["insertedId"] !== null
  ) {
    out["inserted"] = 1;
    out["insertedId"] = ejsonToPlain(result["insertedId"]);
  }
  if (
    Array.isArray(result["insertedIds"]) ||
    isPlainObject(result["insertedIds"])
  ) {
    out["insertedIds"] = ejsonToPlain(
      Array.isArray(result["insertedIds"])
        ? result["insertedIds"]
        : Object.values(result["insertedIds"] as Doc),
    );
  }
  return out;
}

function andFilter(filter: Doc, marker: Doc | undefined): Doc {
  if (!marker) return filter;
  if (Object.keys(filter).length === 0) return { ...marker };
  return { $and: [filter, marker] };
}

function setPath(doc: Doc, path: string, value: unknown): void {
  const parts = path.split(".");
  let node: Doc = doc;
  for (const part of parts.slice(0, -1)) {
    const next = node[part];
    if (!isPlainObject(next)) node[part] = {};
    node = node[part] as Doc;
  }
  node[parts.at(-1)!] = value;
}

function unsetPath(doc: Doc, path: string): void {
  const parts = path.split(".");
  let node: unknown = doc;
  for (const part of parts.slice(0, -1)) {
    if (!isPlainObject(node)) return;
    node = node[part];
  }
  if (isPlainObject(node)) delete node[parts.at(-1)!];
}

/** Add the marker to an update: `$setOnInsert` for operator updates. */
function stampUpdate(update: unknown, marker: Doc | undefined): unknown {
  if (!marker || !isPlainObject(update)) return update;
  const operators = Object.keys(update).some((key) => key.startsWith("$"));
  if (!operators) return { ...update, ...marker };
  const existing = isPlainObject(update["$setOnInsert"])
    ? (update["$setOnInsert"] as Doc)
    : {};
  // A key `$set` writes must not also be in $setOnInsert (path conflict).
  const setKeys = new Set(
    isPlainObject(update["$set"]) ? Object.keys(update["$set"] as Doc) : [],
  );
  const stamp = Object.fromEntries(
    Object.entries(marker).filter(([key]) => !setKeys.has(key)),
  );
  return { ...update, $setOnInsert: { ...existing, ...stamp } };
}

function checkExpect(
  op: MongoFixtureOp,
  name: MongoFixtureOpName,
  value: unknown,
  index: number,
): void {
  const expect = op.expect;
  if (!expect) return;
  const failures: string[] = [];
  const counts = isPlainObject(value) ? value : {};
  const numeric: Array<[keyof typeof expect, string]> = [
    ["matched", "matched"],
    ["modified", "modified"],
    ["upserted", "upserted"],
    ["deleted", "deleted"],
    ["inserted", "inserted"],
  ];
  for (const [key, field] of numeric) {
    const matcher = expect[key] as ValueMatcher | undefined;
    if (matcher === undefined) continue;
    const actual = counts[field] ?? 0;
    const outcome = matchValue(actual, true, matcher, field);
    if (!outcome.passed)
      failures.push(`${outcome.expected} (was ${outcome.actual})`);
  }
  if (expect.count !== undefined) {
    const count =
      name === "findOne"
        ? value === null
          ? 0
          : 1
        : (counts["count"] as number | undefined);
    const outcome = matchValue(
      count,
      count !== undefined,
      expect.count,
      "count",
    );
    if (!outcome.passed)
      failures.push(`${outcome.expected} (was ${outcome.actual})`);
  }
  if (expect.found !== undefined) {
    const found =
      name === "cloneDoc" ? counts["sourceId"] !== undefined : value !== null;
    if (found !== expect.found) {
      failures.push(`found ${expect.found} (was ${found})`);
    }
  }
  if (expect.fields !== undefined) {
    const report = matchPaths(value ?? {}, expect.fields);
    if (!report.passed) {
      const summary = summarizeReport(report);
      failures.push(`${summary.expected} (was ${summary.actual})`);
    }
  }
  if (failures.length > 0) {
    throw new FixtureVerbError(
      `${name} (op ${index + 1}) expectation failed: ${failures.join("; ")}`,
    );
  }
}

function describeCounts(value: unknown): string {
  if (!isPlainObject(value)) return value === null ? "not found" : "found";
  const parts = [
    "matched",
    "modified",
    "upserted",
    "deleted",
    "inserted",
    "count",
  ]
    .filter((key) => typeof value[key] === "number")
    .map((key) => `${key} ${value[key] as number}`);
  return parts.join(", ") || "ok";
}

async function countMatching(
  source: MongoSource,
  collection: string,
  database: string | undefined,
  filter: Doc,
  ctx: FixtureVerbContext,
): Promise<number> {
  const found = await source.find(
    {
      collection,
      ...(database ? { database } : {}),
      filter,
      limit: 1,
      count: true,
    },
    callOpts(ctx),
  );
  return found.count ?? found.docs.length;
}

function callOpts(ctx: FixtureVerbContext): {
  deadline: number;
  signal?: AbortSignal;
} {
  return {
    deadline: ctx.deadline,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  };
}

async function assertExactlyOne(
  source: MongoSource,
  name: string,
  target: { collection: string; database?: string },
  filter: Doc,
  ctx: FixtureVerbContext,
): Promise<void> {
  if (!ctx.exactlyOne) return;
  const count = await countMatching(
    source,
    target.collection,
    target.database,
    filter,
    ctx,
  );
  if (count > 1) {
    throw new FixtureVerbError(
      `${name} on ${target.collection}: owner.exactlyOne — ${count} documents match the filter`,
    );
  }
}

function dbOf(spec: { database?: string }): { database?: string } {
  return spec.database ? { database: spec.database } : {};
}

async function runOp(
  source: MongoSource,
  op: MongoFixtureOp,
  index: number,
  ctx: FixtureVerbContext,
): Promise<OpResult> {
  const name = opName(op);
  // verify is read-only wherever it runs (a dry-run, a freshness check):
  // the schema refuses a write there, and so does the adapter.
  if (ctx.verb === "verify" && !MONGO_READ_OPS.includes(name)) {
    throw new FixtureVerbError(
      `verify is read-only: refused ${name} (op ${index + 1}); use ${MONGO_READ_OPS.join(" or ")}`,
    );
  }
  const marker = ctx.marker as Doc | undefined;
  const ownWrites = ctx.verb === "teardown" ? marker : undefined;
  const opts = callOpts(ctx);
  let value: unknown;
  switch (name) {
    case "insertOne": {
      const spec = op.insertOne!;
      value = normalizeWriteResult(
        await source.write(
          {
            op: "insertOne",
            collection: spec.collection,
            ...dbOf(spec),
            document: { ...spec.document, ...marker },
          },
          opts,
        ),
      );
      break;
    }
    case "insertMany": {
      const spec = op.insertMany!;
      value = normalizeWriteResult(
        await source.write(
          {
            op: "insertMany",
            collection: spec.collection,
            ...dbOf(spec),
            documents: spec.documents.map((doc) => ({ ...doc, ...marker })),
          },
          opts,
        ),
      );
      break;
    }
    case "updateOne":
    case "updateMany": {
      const spec = op[name]!;
      const filter = andFilter(spec.filter, ownWrites);
      if (name === "updateOne") {
        await assertExactlyOne(source, name, spec, filter, ctx);
      }
      value = normalizeWriteResult(
        await source.write(
          {
            op: name,
            collection: spec.collection,
            ...dbOf(spec),
            filter,
            update: (spec.upsert
              ? stampUpdate(spec.update, marker)
              : spec.update) as Doc | Doc[],
            ...(spec.upsert ? { upsert: true } : {}),
          },
          opts,
        ),
      );
      break;
    }
    case "replaceOne": {
      const spec = op.replaceOne!;
      const filter = andFilter(spec.filter, ownWrites);
      await assertExactlyOne(source, name, spec, filter, ctx);
      value = normalizeWriteResult(
        await source.write(
          {
            op: "replaceOne",
            collection: spec.collection,
            ...dbOf(spec),
            filter,
            replacement: { ...spec.replacement, ...marker },
            ...(spec.upsert ? { upsert: true } : {}),
          },
          opts,
        ),
      );
      break;
    }
    case "deleteOne":
    case "deleteMany": {
      const spec = op[name]!;
      // A fixture with a marker only deletes what it owns.
      const filter = andFilter(spec.filter, marker);
      if (name === "deleteOne") {
        await assertExactlyOne(source, name, spec, filter, ctx);
      }
      value = normalizeWriteResult(
        await source.write(
          { op: name, collection: spec.collection, ...dbOf(spec), filter },
          opts,
        ),
      );
      break;
    }
    case "cloneDoc": {
      const spec = op.cloneDoc!;
      const sources = Array.isArray(spec.from) ? spec.from : [spec.from];
      let original: Doc | undefined;
      for (const filter of sources) {
        const found = await source.find(
          {
            collection: spec.fromCollection ?? spec.collection,
            ...dbOf(spec),
            filter,
            limit: 1,
          },
          opts,
        );
        const doc = found.docs[0];
        if (isPlainObject(doc)) {
          original = doc;
          break;
        }
      }
      if (!original) {
        if (op.expect?.found === false) {
          value = { found: false };
          break;
        }
        throw new FixtureVerbError(
          `cloneDoc (op ${index + 1}): no source document in ${
            spec.fromCollection ?? spec.collection
          } matched ${
            sources.length === 1
              ? "the from filter"
              : `any of the ${sources.length} from filters`
          }`,
        );
      }
      const to = andFilter(spec.to, ownWrites);
      await assertExactlyOne(source, name, spec, to, ctx);
      const copy: Doc = structuredClone(original);
      const sourceId = ejsonToPlain(copy["_id"]);
      delete copy["_id"];
      for (const [path, item] of Object.entries(spec.set ?? {})) {
        setPath(copy, path, item);
      }
      for (const path of spec.unset ?? []) unsetPath(copy, path);
      if (spec.to["_id"] !== undefined) copy["_id"] = spec.to["_id"];
      Object.assign(copy, marker);
      const written = normalizeWriteResult(
        await source.write(
          {
            op: "replaceOne",
            collection: spec.collection,
            ...dbOf(spec),
            filter: to,
            replacement: copy,
            upsert: true,
          },
          opts,
        ),
      );
      value = {
        ...written,
        found: true,
        ...(sourceId !== undefined ? { sourceId } : {}),
        ...(spec.to["_id"] !== undefined
          ? { id: ejsonToPlain(spec.to["_id"]) }
          : {}),
      };
      break;
    }
    case "findOne": {
      const spec = op.findOne!;
      await assertExactlyOne(source, name, spec, spec.filter, ctx);
      const found = await source.find(
        {
          collection: spec.collection,
          ...dbOf(spec),
          filter: spec.filter,
          ...(spec.projection ? { projection: spec.projection } : {}),
          limit: 1,
        },
        opts,
      );
      value = found.docs[0] === undefined ? null : ejsonToPlain(found.docs[0]);
      break;
    }
    case "count": {
      const spec = op.count!;
      value = {
        count: await countMatching(
          source,
          spec.collection,
          spec.database,
          spec.filter,
          ctx,
        ),
      };
      break;
    }
  }
  checkExpect(op, name, value, index);
  return { name, value, summary: `${name} ${describeCounts(value)}` };
}

function verbOps(verb: MongoVerb): MongoFixtureOp[] | undefined {
  if (Array.isArray(verb)) return verb;
  if ("ops" in verb) return verb.ops;
  return undefined;
}

function verbTimeout(verb: MongoVerb): number | undefined {
  return Array.isArray(verb) ? undefined : verb.timeoutMs;
}

export async function runMongoVerb(
  ctx: FixtureVerbContext,
): Promise<FixtureVerbOutcome> {
  const fixture = ctx.fixture as MongoFixture;
  const verb = ctx.verbDef as MongoVerb;
  const own = verbTimeout(verb);
  const bounded: FixtureVerbContext =
    own !== undefined
      ? { ...ctx, deadline: Math.min(ctx.deadline, Date.now() + own) }
      : ctx;
  const ops = verbOps(verb);
  if (!ops) {
    return runMongoScript(bounded, fixture, verb as { script: string });
  }
  let source: MongoSource;
  try {
    source = await ctx.datasources.mongo(fixture.datasource);
  } catch (error) {
    throw new FixtureVerbError(
      scrubDatasourceText((error as Error).message, [...ctx.secrets]),
    );
  }
  const results: unknown[] = [];
  const named: Doc = {};
  const summaries: string[] = [];
  for (const [index, op] of ops.entries()) {
    if (ctx.signal?.aborted) throw new FixtureVerbError("cancelled");
    let ran: OpResult;
    try {
      ran = await runOp(source, op, index, bounded);
    } catch (error) {
      if (error instanceof FixtureVerbError) throw error;
      const timedOut = remainingMs(bounded.deadline) <= 0;
      throw new FixtureVerbError(
        scrubDatasourceText(
          `${opName(op)} (op ${index + 1}): ${(error as Error).message}`,
          [...ctx.secrets],
        ),
        timedOut,
      );
    }
    results.push(ran.value);
    if (op.as) named[op.as] = ran.value;
    summaries.push(ran.summary);
  }
  return {
    result: { ...named, ops: results, last: results.at(-1) },
    detail: summaries.join("; "),
  };
}

/* ----- the mongosh script escape hatch ----- */

/**
 * Prelude of a fixture script. The script itself is a second `--eval`, so
 * mongosh's async rewriter applies to it (`eval()` of the text would not,
 * and every collection call would return a pending Promise).
 */
const SCRIPT_PRELUDE =
  'db = new Mongo(process.env.CAIRN_MONGO_URI).getDB(process.env.CAIRN_MONGO_DATABASE); args = EJSON.parse(process.env.CAIRN_FIXTURE_ARGS || "{}", { relaxed: true });';
const DEFAULT_CONTAINER_URI = "mongodb://127.0.0.1:27017";

function scriptDatasource(
  ctx: FixtureVerbContext,
  name: string,
): MongoDatasource {
  const set = ctx.datasourceSet;
  const where = ` for environment "${ctx.envName}"`;
  if (set?.errors[name] !== undefined) {
    throw new FixtureVerbError(
      `datasource ${name} is invalid${where}: ${set.errors[name]}`,
    );
  }
  if (set?.disabled.includes(name)) {
    throw new FixtureVerbError(`datasource ${name} is disabled${where}`);
  }
  const ds = set?.datasources[name];
  if (!ds) {
    throw new FixtureVerbError(`unknown datasource "${name}"${where}`);
  }
  if (ds.kind !== "mongo") {
    throw new FixtureVerbError(
      `datasource ${name} is kind ${ds.kind}; a mongo fixture needs kind mongo`,
    );
  }
  try {
    return resolveDatasourcePlaceholders(name, ds, {
      env: ctx.childEnv,
      vars: ctx.vars,
    });
  } catch (error) {
    throw new FixtureVerbError((error as Error).message);
  }
}

async function resolveContainer(
  ds: MongoDatasource,
  env: Readonly<Record<string, string | undefined>>,
  deadline: number,
  name: string,
): Promise<string> {
  const docker = ds.docker!;
  if (docker.container) return docker.container;
  const bin = env["CAIRN_DOCKER_BIN"] || "docker";
  const child = await execa(
    bin,
    [
      "ps",
      "--filter",
      `label=com.docker.compose.service=${docker.service}`,
      ...(docker.project
        ? ["--filter", `label=com.docker.compose.project=${docker.project}`]
        : []),
      "--format",
      "{{.Names}}",
    ],
    {
      env: { ...env },
      extendEnv: false,
      reject: false,
      stdin: "ignore",
      timeout: Math.max(1, Math.min(10_000, remainingMs(deadline))),
    },
  );
  const names = String(child.stdout ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (child.exitCode !== 0 || names.length !== 1) {
    throw new FixtureVerbError(
      names.length > 1
        ? `datasource ${name}: ${names.length} containers run compose service "${docker.service}"; set docker.project`
        : `datasource ${name}: no running container has compose service label "${docker.service}"`,
    );
  }
  return names[0]!;
}

async function runMongoScript(
  ctx: FixtureVerbContext,
  fixture: MongoFixture,
  verb: { script: string; args?: Record<string, unknown> },
): Promise<FixtureVerbOutcome> {
  const ds = scriptDatasource(ctx, fixture.datasource);
  for (const secret of datasourceSecretValues(ds)) ctx.secrets.add(secret);
  const scrub = (text: string): string =>
    scrubDatasourceText(text, [...ctx.secrets]);
  // A script cannot be proven read-only: a read-only datasource refuses
  // every one (verify included), and a verify script only runs while this
  // consumer may write (never in a shared environment's dry-run).
  if ((ds.mode ?? "read-write") === "read-only") {
    throw new FixtureVerbError(
      `datasource ${fixture.datasource} is read-only: refused the ${ctx.verb} script (a script cannot be proven read-only)`,
    );
  }
  if (ctx.verb === "verify" && !ctx.writesAllowed) {
    throw new FixtureVerbError(
      `verify is read-only: refused the script ${verb.script} while writes are off (a script cannot be proven read-only; use findOne/count)`,
    );
  }
  if (ds.transport === "driver") {
    throw new FixtureVerbError(
      `datasource ${fixture.datasource}: a mongo fixture script needs mongosh (transport driver cannot run scripts)`,
    );
  }
  const docker =
    ds.transport === "docker" || (ds.transport === undefined && !ds.uri);
  if (!docker && ds.guard?.hosts) {
    const allowed = ds.guard.hosts.map((host) => host.toLowerCase());
    const hosts = mongoUriHosts(ds.uri ?? "");
    const offending = hosts.filter(
      (host) =>
        !allowed.includes(host.toLowerCase()) &&
        !allowed.includes(hostNames([host])[0]!),
    );
    if (hosts.length === 0 || offending.length > 0) {
      throw new FixtureVerbError(
        `datasource ${fixture.datasource}: refused host ${offending.join(", ") || "(none)"} — not in guard.hosts`,
      );
    }
  }
  const scriptPath = isAbsolute(verb.script)
    ? verb.script
    : resolve(ctx.configDir, verb.script);
  let script: string;
  try {
    script = await readFile(scriptPath, "utf8");
  } catch (error) {
    throw new FixtureVerbError(
      `mongo script ${verb.script}: ${(error as Error).message}`,
    );
  }
  const remaining = remainingMs(ctx.deadline);
  if (remaining <= 0) {
    throw new FixtureVerbError("deadline exhausted before the script", true);
  }
  const env: Record<string, string | undefined> = {
    ...ctx.childEnv,
    CAIRN_MONGO_URI: docker
      ? (ds.docker?.uri ?? DEFAULT_CONTAINER_URI)
      : ds.uri!,
    CAIRN_MONGO_DATABASE: ds.database,
    CAIRN_FIXTURE_ARGS: JSON.stringify(verb.args ?? {}),
    CAIRN_FIXTURE_NAME: ctx.name,
    CAIRN_FIXTURE_VERB: ctx.verb,
  };
  const evalArgs = [
    "--nodb",
    "--quiet",
    "--eval",
    SCRIPT_PRELUDE,
    "--eval",
    script,
  ];
  let bin: string;
  let args: string[];
  if (docker) {
    const container = await resolveContainer(
      ds,
      ctx.childEnv,
      ctx.deadline,
      fixture.datasource,
    ).catch((error: unknown) => {
      throw new FixtureVerbError(scrub((error as Error).message));
    });
    bin = ctx.childEnv["CAIRN_DOCKER_BIN"] || "docker";
    args = [
      "exec",
      "-e",
      "CAIRN_MONGO_URI",
      "-e",
      "CAIRN_MONGO_DATABASE",
      "-e",
      "CAIRN_FIXTURE_ARGS",
      "-e",
      "CAIRN_FIXTURE_NAME",
      "-e",
      "CAIRN_FIXTURE_VERB",
      container,
      "mongosh",
      ...evalArgs,
    ];
  } else {
    bin = ctx.childEnv["CAIRN_MONGOSH_BIN"] || "mongosh";
    args = evalArgs;
  }
  const child = await execa(bin, args, {
    env,
    extendEnv: false,
    reject: false,
    stdin: "ignore",
    all: true,
    timeout: remaining,
    maxBuffer: 16 * 1024 * 1024,
    ...(ctx.signal ? { cancelSignal: ctx.signal } : {}),
  });
  if (child.timedOut) {
    throw new FixtureVerbError(
      `mongo script ${verb.script} timed out after ${remaining}ms`,
      true,
    );
  }
  if (child.exitCode !== 0) {
    const output = String(child.all ?? child.message ?? "").trim();
    const tail = output.split("\n").slice(-5).join("\n").slice(-500);
    throw new FixtureVerbError(
      scrub(
        `mongo script ${verb.script} failed (exit ${child.exitCode ?? "?"})${
          tail ? `: ${tail}` : ""
        }`,
      ),
    );
  }
  const result = lastJsonLine(String(child.stdout ?? ""));
  return { result, detail: `script ${verb.script}` };
}
