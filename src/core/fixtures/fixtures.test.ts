import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { MongoDriverModule } from "../datasources/mongo";
import { resolveEnvironmentDatasources } from "../datasources/resolve";
import { DatasourcesConfigSchema } from "../datasources/schema";
import { RunEventSchema, type FixtureEvent } from "../schema/events.v1";
import {
  fixtureStates,
  foldLedger,
  ledgerKey,
  projectLedgerPath,
  readProjectLedger,
  recordSeedRun,
} from "./ledger";
import {
  FixtureHost,
  FixtureRuntime,
  FixtureSetupError,
  fixtureWriteBlock,
  planFixtures,
  type FixtureRuntimeOptions,
} from "./runtime";
import {
  FixturesRegistrySchema,
  RunFixtureLedgerSchema,
  SpecFixturesSchema,
  type FixturesRegistry,
} from "./schema";
import { resolveFixturePlaceholders, resolveFixtureTemplate } from "./template";

/**
 * F3b fixtures registry: the exec adapter against real child processes, the
 * mongo adapter against an in-memory driver double and a fake mongosh, the
 * http adapter against a local server, plus the ledger, freshness, the
 * shared-environment dry-run and the invocation host.
 */

let dir: string;
const servers: Server[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "cairn-fixtures-"));
});

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await new Promise<void>((resolveClose) =>
      server.close(() => resolveClose()),
    );
  }
  await rm(dir, { recursive: true, force: true });
});

function registry(raw: unknown): FixturesRegistry {
  return FixturesRegistrySchema.parse(raw);
}

function runtime(
  reg: FixturesRegistry,
  extra: Partial<FixtureRuntimeOptions> = {},
): { rt: FixtureRuntime; events: FixtureEvent[] } {
  const events: FixtureEvent[] = [];
  const rt = new FixtureRuntime({
    project: "demo",
    envName: "local",
    registry: reg,
    configDir: dir,
    childEnv: { PATH: process.env["PATH"], HOME: process.env["HOME"] },
    origin: "run",
    ledgerRoot: join(dir, "ledger"),
    seedStateRoot: join(dir, "services"),
    onEvent: (event) => {
      RunEventSchema.parse(event);
      events.push(event);
    },
    ...extra,
  });
  return { rt, events };
}

/* ----- schema ----- */

describe("fixtures registry schema", () => {
  it("rejects unknown needs, cycles and a shorter-lived need", () => {
    const unknown = FixturesRegistrySchema.safeParse({
      a: { kind: "exec", ensure: "true", needs: ["missing"] },
    });
    expect(unknown.success).toBe(false);
    expect(JSON.stringify(unknown.error?.issues)).toContain(
      'unknown fixture \\"missing\\"',
    );

    const cycle = FixturesRegistrySchema.safeParse({
      a: { kind: "exec", ensure: "true", needs: ["b"] },
      b: { kind: "exec", ensure: "true", needs: ["a"] },
    });
    expect(JSON.stringify(cycle.error?.issues)).toContain(
      "fixture needs cycle: a → b → a",
    );

    const lifetime = FixturesRegistrySchema.safeParse({
      kit: { kind: "exec", scope: "seed", ensure: "true", needs: ["rows"] },
      rows: { kind: "exec", ensure: "true" },
    });
    expect(JSON.stringify(lifetime.error?.issues)).toContain(
      "a seed fixture cannot need the run fixture rows",
    );
  });

  it("needs ensure or reset, one mongo op per entry and exactly one of shell/node", () => {
    expect(
      FixturesRegistrySchema.safeParse({ a: { kind: "exec", verify: "true" } })
        .success,
    ).toBe(false);
    expect(
      FixturesRegistrySchema.safeParse({
        a: {
          kind: "mongo",
          datasource: "db",
          ensure: [
            {
              insertOne: { collection: "c", document: {} },
              count: { collection: "c", filter: {} },
            },
          ],
        },
      }).success,
    ).toBe(false);
    expect(
      FixturesRegistrySchema.safeParse({
        a: { kind: "exec", ensure: { shell: "true", node: "x.js" } },
      }).success,
    ).toBe(false);
    expect(
      FixturesRegistrySchema.safeParse({
        a: {
          kind: "http",
          baseUrl: "http://x",
          ensure: { create: { path: "/x" } },
        },
      }).success,
    ).toBe(false);
  });

  it("accepts spec refs (name, name.reset, {use, with, write}) and refuses duplicates", () => {
    expect(
      SpecFixturesSchema.parse([
        "kit",
        "rows.reset",
        { use: "fanout", with: { count: 3 }, write: true },
      ]),
    ).toHaveLength(3);
    expect(SpecFixturesSchema.safeParse(["kit", "kit.reset"]).success).toBe(
      false,
    );
    expect(SpecFixturesSchema.safeParse(["Kit"]).success).toBe(false);
  });

  it("plans needs first and inherits write through needs", () => {
    const reg = registry({
      base: { kind: "exec", ensure: "true" },
      mid: { kind: "exec", ensure: "true", needs: ["base"] },
      top: { kind: "exec", ensure: "true", needs: ["mid", "base"] },
    });
    const plan = planFixtures([{ use: "top", write: true }], reg);
    expect(
      plan.map((entry) => [entry.name, entry.direct, entry.write]),
    ).toEqual([
      ["base", false, true],
      ["mid", false, true],
      ["top", true, true],
    ]);
    expect(() => planFixtures(["nope"], reg)).toThrow(/unknown fixture "nope"/);
  });
});

/* ----- templates ----- */

describe("fixture templates", () => {
  const scope = {
    with: { name: "Demo Buyer", n: 3 },
    fixtures: { kit: { id: "k-1", doc: { a: 1 } } },
    vars: { tenant: "acme" },
    env: { API_TOKEN: "tok-secret-123" },
    baseUrl: "http://demo.test",
    runToken: "rt1",
    now: "2026-10-02T00:00:00.000Z",
  };

  it("keeps types for whole placeholders and interpolates the rest", () => {
    const secrets = new Set<string>();
    expect(
      resolveFixtureTemplate(
        {
          count: "${with.n}",
          doc: "${fixtures.kit.doc}",
          label: "${with.name} @ ${vars.tenant} ${run.token}",
          auth: "Bearer ${secrets.API_TOKEN}",
          at: { $date: "${now}" },
          url: "${baseUrl}/x",
          fallback: "${env.MISSING:-dflt}",
        },
        scope,
        secrets,
      ),
    ).toEqual({
      count: 3,
      doc: { a: 1 },
      label: "Demo Buyer @ acme rt1",
      auth: "Bearer tok-secret-123",
      at: { $date: "2026-10-02T00:00:00.000Z" },
      url: "http://demo.test/x",
      fallback: "dflt",
    });
    expect([...secrets]).toEqual(["tok-secret-123"]);
  });

  it("refuses unresolved references with the reason", () => {
    expect(() => resolveFixtureTemplate("${with.missing}", scope)).toThrow(
      "${with.missing} is not a parameter (with:)",
    );
    expect(() => resolveFixtureTemplate("${fixtures.other.id}", scope)).toThrow(
      /not ensured here \(add it to needs\)/,
    );
    expect(() => resolveFixtureTemplate("${fixtures.kit.nope}", scope)).toThrow(
      /is not an output of fixture kit \(outputs: id, doc\)/,
    );
  });

  it("splices step strings and leaves unknown references visible", () => {
    expect(
      resolveFixturePlaceholders(
        "/kits/${fixtures.kit.id}?x=${fixtures.no.id}",
        {
          kit: { id: "k-1" },
        },
      ),
    ).toBe("/kits/k-1?x=${fixtures.no.id}");
  });
});

/* ----- exec ----- */

describe("exec adapter", () => {
  it("runs ensure/teardown scripts, reads the last JSON line and passes context", async () => {
    const script = join(dir, "kit.js");
    const seen = join(dir, "seen.json");
    await writeFile(
      script,
      `const fs = require("node:fs");
const verb = process.env.CAIRN_FIXTURE_VERB;
const out = {
  verb,
  name: process.env.CAIRN_FIXTURE_NAME,
  scope: process.env.CAIRN_FIXTURE_SCOPE,
  with: JSON.parse(process.env.CAIRN_FIXTURE_WITH),
  outputs: JSON.parse(process.env.CAIRN_FIXTURE_OUTPUTS),
  marker: JSON.parse(process.env.CAIRN_FIXTURE_MARKER || "null"),
  status: process.env.CAIRN_RUN_STATUS || null,
  args: process.argv.slice(2),
};
fs.appendFileSync(${JSON.stringify(seen)}, JSON.stringify(out) + "\\n");
console.error("progress on stderr");
console.log("noise");
console.log(JSON.stringify({ kitId: "kit-" + process.argv[2], label: out.with.label }));
`,
    );
    const reg = registry({
      kit: {
        kind: "exec",
        with: { label: "Demo kit" },
        owner: { marker: { owner: "cairn-${run.token}" } },
        ensure: { node: "kit.js", args: ["${with.label}"] },
        teardown: { node: "kit.js", args: ["${fixtures.kit.kitId}"] },
        outputs: { kitId: "$.kitId", label: "${with.label}" },
      },
    });
    const { rt, events } = runtime(reg, { runToken: "tok9" });
    await rt.setup([{ use: "kit", with: { label: "Seeded" } }]);
    expect(rt.outputs()).toEqual({
      kit: { kitId: "kit-Seeded", label: "Seeded" },
    });
    expect(rt.pendingTeardowns).toBe(1);
    await rt.teardown("failed");
    const calls = (await readFile(seen, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(calls[0]).toMatchObject({
      verb: "ensure",
      name: "kit",
      scope: "run",
      with: { label: "Seeded" },
      outputs: {},
      marker: { owner: "cairn-tok9" },
      args: ["Seeded"],
    });
    expect(calls[1]).toMatchObject({
      verb: "teardown",
      outputs: { kitId: "kit-Seeded", label: "Seeded" },
      status: "failed",
      args: ["kit-Seeded"],
    });
    expect(events.map((e) => [e.type, e.status])).toEqual([
      ["fixture.ensure", "ok"],
      ["fixture.teardown", "ok"],
    ]);
    expect(events[0]).toMatchObject({
      name: "kit",
      adapter: "exec",
      scope: "run",
      outputs: { kitId: "kit-Seeded", label: "Seeded" },
    });
    const ledger = RunFixtureLedgerSchema.parse(rt.runLedger());
    expect(ledger.entries[0]).toMatchObject({
      name: "kit",
      adapter: "exec",
      scope: "run",
      status: "ok",
      outputs: { kitId: "kit-Seeded", label: "Seeded" },
      teardown: { status: "ok" },
    });
  });

  it("settles on the verb's exit when a background process it started holds stdout", async () => {
    const reg = registry({
      stub: {
        kind: "exec",
        ensure: `sleep 8 & echo '{"port":4321}'`,
        outputs: { port: "$.port" },
      },
    });
    const { rt } = runtime(reg);
    const startedAt = Date.now();
    await rt.setup(["stub"]);
    // Before: the verb waited for the pipes to close (8s), past its exit.
    expect(Date.now() - startedAt).toBeLessThan(4_000);
    expect(rt.outputs()).toEqual({ stub: { port: 4321 } });
    await rt.teardown("passed");
  });

  it("fails setup on a non-zero exit, keeps the stderr tail and still owes the teardown", async () => {
    const reg = registry({
      first: { kind: "exec", ensure: "echo '{}'", teardown: "echo bye" },
      broken: {
        kind: "exec",
        ensure: "echo boom-detail >&2; exit 3",
        needs: ["first"],
      },
    });
    const { rt, events } = runtime(reg);
    const failure = await rt.setup(["broken"]).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(FixtureSetupError);
    expect((failure as FixtureSetupError).fixture).toBe("broken");
    expect((failure as Error).message).toMatch(
      /failed \(exit 3\): boom-detail/,
    );
    const failed = events.find((e) => e.status === "failed");
    expect(failed).toMatchObject({ type: "fixture.ensure", name: "broken" });
    await rt.teardown("errored");
    expect(events.at(-1)).toMatchObject({
      type: "fixture.teardown",
      name: "first",
      status: "ok",
    });
  });

  it("kills a verb past its timeout", async () => {
    const reg = registry({
      slow: { kind: "exec", ensure: { shell: "sleep 5", timeoutMs: 300 } },
    });
    const { rt } = runtime(reg);
    const startedAt = Date.now();
    const failure = (await rt
      .setup(["slow"])
      .catch((e: unknown) => e)) as FixtureSetupError;
    expect(Date.now() - startedAt).toBeLessThan(4000);
    expect(failure.timedOut).toBe(true);
    expect(failure.message).toMatch(/timed out after 300ms/);
  });

  it("resets a reset-only fixture and runs .reset after ensure", async () => {
    const log = join(dir, "log.txt");
    const reg = registry({
      kit: {
        kind: "exec",
        ensure: `echo ensure >> ${log}; echo '{"id":"k1"}'`,
        reset: `echo "reset $CAIRN_FIXTURE_OUTPUTS" >> ${log}`,
        outputs: { id: "$.id" },
      },
      rows: {
        kind: "exec",
        needs: ["kit"],
        reset: `echo "rows \${fixtures.kit.id}" >> ${log}`,
      },
    });
    const { rt } = runtime(reg);
    await rt.setup(["kit.reset", "rows"]);
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "ensure",
      'reset {"id":"k1"}',
      "rows k1",
    ]);
  });
});

/* ----- mongo ----- */

type Doc = Record<string, unknown>;

function key(value: unknown): string {
  return JSON.stringify(value);
}

function matches(doc: Doc, filter: Doc): boolean {
  return Object.entries(filter).every(([path, want]) => {
    if (path === "$and") return (want as Doc[]).every((f) => matches(doc, f));
    let value: unknown = doc;
    for (const part of path.split(".")) {
      value =
        value !== null && typeof value === "object"
          ? (value as Doc)[part]
          : undefined;
    }
    return key(value) === key(want);
  });
}

function applyUpdate(doc: Doc, update: Doc, inserted: boolean): void {
  Object.assign(doc, (update["$set"] as Doc) ?? {});
  if (inserted) Object.assign(doc, (update["$setOnInsert"] as Doc) ?? {});
}

/** An in-memory stand-in for the optional `mongodb` driver. */
function memoryDriver(data: Record<string, Doc[]>): MongoDriverModule {
  const coll = (name: string) => {
    const docs = (data[name] ??= []);
    return {
      find(filter: Doc, options: { limit?: number } = {}) {
        const found = docs.filter((doc) => matches(doc, filter));
        return {
          toArray: async () =>
            (options.limit ? found.slice(0, options.limit) : found).map((d) =>
              structuredClone(d),
            ),
        };
      },
      async countDocuments(filter: Doc) {
        return docs.filter((doc) => matches(doc, filter)).length;
      },
      async insertOne(doc: Doc) {
        docs.push(structuredClone(doc));
        return { acknowledged: true, insertedId: doc["_id"] ?? "generated" };
      },
      async insertMany(list: Doc[]) {
        docs.push(...list.map((d) => structuredClone(d)));
        return { acknowledged: true, insertedCount: list.length };
      },
      async updateOne(
        filter: Doc,
        update: Doc,
        options: { upsert?: boolean } = {},
      ) {
        const doc = docs.find((d) => matches(d, filter));
        if (doc) {
          applyUpdate(doc, update, false);
          return {
            acknowledged: true,
            matchedCount: 1,
            modifiedCount: 1,
            upsertedCount: 0,
          };
        }
        if (options.upsert) {
          const created: Doc = { ...filter };
          applyUpdate(created, update, true);
          docs.push(created);
          return {
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 1,
            upsertedId: created["_id"] ?? "up",
          };
        }
        return {
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 0,
        };
      },
      async updateMany(filter: Doc, update: Doc) {
        const hit = docs.filter((d) => matches(d, filter));
        for (const doc of hit) applyUpdate(doc, update, false);
        return {
          acknowledged: true,
          matchedCount: hit.length,
          modifiedCount: hit.length,
        };
      },
      async replaceOne(
        filter: Doc,
        replacement: Doc,
        options: { upsert?: boolean } = {},
      ) {
        const index = docs.findIndex((d) => matches(d, filter));
        if (index >= 0) {
          docs[index] = structuredClone(replacement);
          return {
            acknowledged: true,
            matchedCount: 1,
            modifiedCount: 1,
            upsertedCount: 0,
          };
        }
        if (options.upsert) {
          docs.push(structuredClone(replacement));
          return {
            acknowledged: true,
            matchedCount: 0,
            modifiedCount: 0,
            upsertedCount: 1,
            upsertedId: replacement["_id"],
          };
        }
        return {
          acknowledged: true,
          matchedCount: 0,
          modifiedCount: 0,
          upsertedCount: 0,
        };
      },
      async deleteOne(filter: Doc) {
        const index = docs.findIndex((d) => matches(d, filter));
        if (index >= 0) docs.splice(index, 1);
        return { acknowledged: true, deletedCount: index >= 0 ? 1 : 0 };
      },
      async deleteMany(filter: Doc) {
        const keep = docs.filter((d) => !matches(d, filter));
        const deleted = docs.length - keep.length;
        docs.splice(0, docs.length, ...keep);
        return { acknowledged: true, deletedCount: deleted };
      },
    };
  };
  class Client {
    async connect() {}
    db() {
      return { collection: coll, command: async () => ({ ok: 1 }) };
    }
    async close() {}
  }
  return { MongoClient: Client as unknown as MongoDriverModule["MongoClient"] };
}

const MONGO_DATASOURCES = DatasourcesConfigSchema.parse({
  appdb: {
    kind: "mongo",
    uri: "mongodb://fixture_user:pw-s3cret@db.demo.test:27017/app",
    database: "app",
    transport: "driver",
  },
  readonly_db: {
    kind: "mongo",
    uri: "mongodb://db.demo.test:27017/app",
    database: "app",
    mode: "read-only",
    transport: "driver",
  },
});

function mongoRuntime(
  reg: FixturesRegistry,
  data: Record<string, Doc[]>,
  extra: Partial<FixtureRuntimeOptions> = {},
) {
  return runtime(reg, {
    datasourceSet: resolveEnvironmentDatasources(MONGO_DATASOURCES, undefined),
    loadMongoDriver: async () => memoryDriver(data),
    ...extra,
  });
}

describe("mongo adapter (in-memory driver)", () => {
  it("clones a source document onto a fixed target, stamps the marker and expects counts", async () => {
    const data: Record<string, Doc[]> = {
      kits: [
        {
          _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaaaa" },
          kind: "deliverable",
          program: "Demo",
          rows: [1],
          taskCounts: 4,
        },
      ],
    };
    const reg = registry({
      demo_kit: {
        kind: "mongo",
        datasource: "appdb",
        scope: "seed",
        with: { kitId: "bbbbbbbbbbbbbbbbbbbbbbbb" },
        owner: { exactlyOne: true, marker: { cairnFixture: "demo_kit" } },
        ensure: [
          {
            cloneDoc: {
              collection: "kits",
              from: [
                { _id: { $oid: "cccccccccccccccccccccccc" } },
                { kind: "deliverable" },
              ],
              to: { _id: { $oid: "${with.kitId}" } },
              set: { label: "Demo 2026", "meta.owner": "${with.kitId}" },
              unset: ["taskCounts"],
            },
            as: "clone",
          },
        ],
        verify: [
          {
            findOne: {
              collection: "kits",
              filter: { _id: { $oid: "${fixtures.demo_kit.kitId}" } },
            },
            expect: { found: true, fields: { label: "Demo 2026" } },
          },
        ],
        teardown: [
          {
            deleteMany: { collection: "kits", filter: {} },
            expect: { deleted: 1 },
          },
        ],
        outputs: { kitId: "$.clone.id", sourceId: "$.clone.sourceId" },
      },
    });
    const { rt, events } = mongoRuntime(reg, data);
    await rt.setup(["demo_kit"]);
    expect(rt.outputs()["demo_kit"]).toEqual({
      kitId: "bbbbbbbbbbbbbbbbbbbbbbbb",
      sourceId: "aaaaaaaaaaaaaaaaaaaaaaaa",
    });
    expect(data["kits"]).toHaveLength(2);
    expect(data["kits"]![1]).toEqual({
      _id: { $oid: "bbbbbbbbbbbbbbbbbbbbbbbb" },
      kind: "deliverable",
      program: "Demo",
      rows: [1],
      label: "Demo 2026",
      meta: { owner: "bbbbbbbbbbbbbbbbbbbbbbbb" },
      cairnFixture: "demo_kit",
    });
    expect(events.map((e) => `${e.type}:${e.status}`)).toEqual([
      "fixture.ensure:ok",
      "fixture.verify:ok",
    ]);
    // Seed fixtures are never torn down by a run.
    expect(rt.pendingTeardowns).toBe(0);
    // An explicit teardown only deletes what carries the marker.
    const { rt: cli } = mongoRuntime(reg, data, { origin: "cli" });
    expect(await cli.teardownRecorded("demo_kit")).toEqual({ status: "ok" });
    expect(data["kits"]).toEqual([
      expect.objectContaining({ _id: { $oid: "aaaaaaaaaaaaaaaaaaaaaaaa" } }),
    ]);
  });

  it("updates with expect matched, upserts with $setOnInsert marker and refuses exactlyOne violations", async () => {
    const data: Record<string, Doc[]> = {
      kits: [
        { _id: 1, list: [1, 2] },
        { _id: 2, group: "dup" },
        { _id: 3, group: "dup" },
      ],
    };
    const reg = registry({
      rows: {
        kind: "mongo",
        datasource: "appdb",
        reset: [
          {
            updateOne: {
              collection: "kits",
              filter: { _id: 1 },
              update: { $set: { list: [] } },
            },
            expect: { matched: 1 },
          },
        ],
      },
      missing: {
        kind: "mongo",
        datasource: "appdb",
        reset: [
          {
            updateOne: {
              collection: "kits",
              filter: { _id: 9 },
              update: { $set: { a: 1 } },
            },
            expect: { matched: 1 },
          },
        ],
      },
      upserted: {
        kind: "mongo",
        datasource: "appdb",
        owner: { marker: { cairnFixture: "up" } },
        ensure: [
          {
            updateOne: {
              collection: "kits",
              filter: { _id: 7 },
              update: { $set: { flag: true } },
              upsert: true,
            },
            as: "write",
          },
          {
            count: { collection: "kits", filter: { cairnFixture: "up" } },
            expect: { count: 1 },
            as: "owned",
          },
        ],
        outputs: { upsertedId: "$.write.upsertedId", owned: "$.owned.count" },
      },
      dup: {
        kind: "mongo",
        datasource: "appdb",
        owner: { exactlyOne: true },
        ensure: [
          {
            updateOne: {
              collection: "kits",
              filter: { group: "dup" },
              update: { $set: { x: 1 } },
            },
          },
        ],
      },
    });
    const { rt } = mongoRuntime(reg, data);
    await rt.setup(["rows", "upserted"]);
    expect(data["kits"]![0]).toEqual({ _id: 1, list: [] });
    expect(data["kits"]!.at(-1)).toEqual({
      _id: 7,
      flag: true,
      cairnFixture: "up",
    });
    expect(rt.outputs()["upserted"]).toEqual({ upsertedId: 7, owned: 1 });

    const missing = (await mongoRuntime(reg, data)
      .rt.setup(["missing"])
      .catch((e: unknown) => e)) as Error;
    expect(missing.message).toMatch(
      /updateOne \(op 1\) expectation failed: matched equals 1 \(was 0\)/,
    );

    const dup = (await mongoRuntime(reg, data)
      .rt.setup(["dup"])
      .catch((e: unknown) => e)) as Error;
    expect(dup.message).toMatch(
      /owner.exactlyOne — 2 documents match the filter/,
    );
    expect(data["kits"]!.filter((d) => d["x"] === 1)).toHaveLength(0);
  });

  it("refuses writes on a read-only datasource and never leaks the connection string", async () => {
    const reg = registry({
      blocked: {
        kind: "mongo",
        datasource: "readonly_db",
        ensure: [{ insertOne: { collection: "kits", document: { a: 1 } } }],
      },
    });
    const { rt, events } = mongoRuntime(reg, {});
    const error = (await rt
      .setup(["blocked"])
      .catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/read-only: refused insertOne on kits/);
    expect(JSON.stringify(events)).not.toContain("pw-s3cret");
  });

  it("runs the mongosh script escape hatch with EJSON args through a fake mongosh", async () => {
    const fake = join(dir, "fake-mongosh.js");
    const argvLog = join(dir, "mongosh-argv.json");
    // Records what it got and answers like the script would: the prelude
    // and the script arrive as two --eval arguments; args/uri in the env.
    await writeFile(
      fake,
      `#!/usr/bin/env node
const fs = require("node:fs");
fs.writeFileSync(${JSON.stringify(argvLog)}, JSON.stringify({
  argv: process.argv.slice(2),
  uri: process.env.CAIRN_MONGO_URI,
  database: process.env.CAIRN_MONGO_DATABASE,
  args: JSON.parse(process.env.CAIRN_FIXTURE_ARGS),
}));
console.log("Current Mongosh Log ID: x");
console.log(JSON.stringify({ ok: true, kitId: JSON.parse(process.env.CAIRN_FIXTURE_ARGS).id.$oid }));
`,
    );
    await chmod(fake, 0o755);
    await writeFile(
      join(dir, "ensure-kit.mongosh.js"),
      "print(JSON.stringify({ok: true}));\n",
    );
    const datasources = DatasourcesConfigSchema.parse({
      shelldb: {
        kind: "mongo",
        uri: "mongodb://script_user:pw-hidden@127.0.0.1:27017/app",
        database: "app",
        transport: "mongosh",
        guard: { hosts: ["127.0.0.1"] },
      },
    });
    const reg = registry({
      scripted: {
        kind: "mongo",
        datasource: "shelldb",
        with: { kitId: "dddddddddddddddddddddddd" },
        ensure: {
          script: "ensure-kit.mongosh.js",
          args: { id: { $oid: "${with.kitId}" } },
        },
        outputs: { kitId: "$.kitId" },
      },
    });
    const { rt } = runtime(reg, {
      datasourceSet: resolveEnvironmentDatasources(datasources, undefined),
      childEnv: { PATH: process.env["PATH"], CAIRN_MONGOSH_BIN: fake },
    });
    await rt.setup(["scripted"]);
    expect(rt.outputs()["scripted"]).toEqual({
      kitId: "dddddddddddddddddddddddd",
    });
    const seen = JSON.parse(await readFile(argvLog, "utf8"));
    expect(seen.argv[0]).toBe("--nodb");
    expect(seen.argv.filter((a: string) => a === "--eval")).toHaveLength(2);
    expect(seen.argv.at(-1)).toBe("print(JSON.stringify({ok: true}));\n");
    expect(seen.argv.join(" ")).not.toContain("pw-hidden");
    expect(seen).toMatchObject({
      uri: "mongodb://script_user:pw-hidden@127.0.0.1:27017/app",
      database: "app",
      args: { id: { $oid: "dddddddddddddddddddddddd" } },
    });
  });
});

/* ----- http ----- */

interface Entity {
  id: string;
  name: string;
  owner?: string;
}

async function entityServer(seed: Entity[] = []): Promise<{
  url: string;
  entities: Entity[];
  requests: string[];
}> {
  const entities = [...seed];
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(
        `${req.method} ${req.url} ${req.headers.authorization ?? "-"}`,
      );
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/login" && req.method === "POST") {
        const creds = JSON.parse(body) as { email: string; password: string };
        if (creds.password !== "pw-login") {
          res.statusCode = 401;
          res.end(JSON.stringify({ error: "bad credentials" }));
          return;
        }
        res.end(JSON.stringify({ token: "jwt-abc-123" }));
        return;
      }
      if (req.headers.authorization !== "Bearer jwt-abc-123") {
        res.statusCode = 401;
        res.end("{}");
        return;
      }
      if (req.url === "/api/entities" && req.method === "GET") {
        res.end(JSON.stringify({ entities }));
        return;
      }
      if (req.url === "/api/entities" && req.method === "POST") {
        const input = JSON.parse(body) as Omit<Entity, "id">;
        const created = { id: `e${entities.length + 1}`, ...input };
        entities.push(created);
        res.statusCode = 201;
        res.end(JSON.stringify({ entity: created }));
        return;
      }
      const del = /^\/api\/entities\/(\w+)$/.exec(req.url ?? "");
      if (del && req.method === "DELETE") {
        const index = entities.findIndex((e) => e.id === del[1]);
        if (index >= 0) entities.splice(index, 1);
        res.statusCode = index >= 0 ? 204 : 404;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, entities, requests };
}

const HTTP_FIXTURE = {
  buyer: {
    kind: "http",
    with: { name: "Demo Buyer" },
    owner: { exactlyOne: true, marker: { owner: "cairn" } },
    login: {
      path: "/api/login",
      body: {
        email: "fixture@demo.test",
        password: "${secrets.LOGIN_PASSWORD}",
      },
    },
    ensure: {
      find: {
        path: "/api/entities",
        items: "$.entities",
        where: { name: "${with.name}" },
      },
      create: {
        path: "/api/entities",
        body: { name: "${with.name}" },
        item: "$.entity",
      },
    },
    verify: {
      find: {
        path: "/api/entities",
        items: "$.entities",
        where: { id: "${fixtures.buyer.id}" },
      },
    },
    teardown: [
      {
        method: "DELETE",
        path: "/api/entities/${fixtures.buyer.id}",
        status: [204, 404],
      },
    ],
    outputs: { id: "$.item.id", created: "$.created" },
  },
};

describe("http adapter (local server)", () => {
  it("logs in, creates when the natural key is missing and finds it afterwards", async () => {
    const api = await entityServer();
    const reg = registry(HTTP_FIXTURE);
    const env = { PATH: process.env["PATH"], LOGIN_PASSWORD: "pw-login" };
    const first = runtime(reg, { baseUrl: api.url, childEnv: env });
    await first.rt.setup(["buyer"]);
    expect(first.rt.outputs()["buyer"]).toEqual({ id: "e1", created: true });
    expect(api.entities).toEqual([
      { id: "e1", name: "Demo Buyer", owner: "cairn" },
    ]);
    // The token never reaches the events.
    expect(JSON.stringify(first.events)).not.toContain("jwt-abc-123");

    const second = runtime(reg, { baseUrl: api.url, childEnv: env });
    await second.rt.setup(["buyer"]);
    expect(second.rt.outputs()["buyer"]).toEqual({ id: "e1", created: false });
    expect(api.entities).toHaveLength(1);

    await second.rt.teardown("passed");
    expect(api.entities).toEqual([]);
    expect(api.requests.at(-1)).toBe(
      "DELETE /api/entities/e1 Bearer jwt-abc-123",
    );
  });

  it("fails on duplicates under owner.exactlyOne and scrubs the login secret", async () => {
    const api = await entityServer([
      { id: "x1", name: "Demo Buyer" },
      { id: "x2", name: "Demo Buyer" },
    ]);
    const reg = registry(HTTP_FIXTURE);
    const { rt } = runtime(reg, {
      baseUrl: api.url,
      childEnv: { PATH: process.env["PATH"], LOGIN_PASSWORD: "pw-login" },
    });
    const error = (await rt.setup(["buyer"]).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(
      /owner.exactlyOne — 2 items match name="Demo Buyer"/,
    );

    const bad = runtime(reg, {
      baseUrl: api.url,
      childEnv: { PATH: process.env["PATH"], LOGIN_PASSWORD: "pw-wrong-1" },
    });
    const loginError = (await bad.rt
      .setup(["buyer"])
      .catch((e: unknown) => e)) as Error;
    expect(loginError.message).toMatch(/login: POST \/api\/login → 401/);
    expect(JSON.stringify(bad.events)).not.toContain("pw-wrong-1");
  });
});

/* ----- ledger, freshness, dry-run, host ----- */

describe("ledger and freshness", () => {
  it("reuses a fresh seed fixture (ledger + ttl + verify) and re-ensures when stale", async () => {
    const counter = join(dir, "ensures.txt");
    const marker = join(dir, "present.txt");
    const reg = registry({
      kit: {
        kind: "exec",
        scope: "seed",
        ttl: "1h",
        ensure: `echo x >> ${counter}; touch ${marker}; echo '{"id":"k7"}'`,
        verify: `test -f ${marker}`,
        outputs: { id: "$.id" },
      },
    });
    const first = runtime(reg);
    await first.rt.setup(["kit"]);
    const second = runtime(reg);
    await second.rt.setup(["kit"]);
    expect(second.events.at(-1)).toMatchObject({
      type: "fixture.ensure",
      status: "skipped",
      outputs: { id: "k7" },
      reason: expect.stringMatching(
        /^fresh: ensured .*ttl 3600s, no reseed since, verify ok\)$/,
      ),
    });
    expect(second.rt.outputs()).toEqual({ kit: { id: "k7" } });
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(
      1,
    );

    // The data disappeared: verify fails, ensure runs again.
    await rm(marker);
    const third = runtime(reg);
    await third.rt.setup(["kit"]);
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(
      2,
    );

    // A new seed run makes it stale too.
    await mkdir(join(dir, "services"), { recursive: true });
    await writeFile(
      join(dir, "services", "demo.seed.json"),
      JSON.stringify({
        project: "demo",
        fingerprint: "f",
        lastRunAt: new Date().toISOString(),
        lastRunExitCode: 0,
      }),
    );
    const fourth = runtime(reg);
    await fourth.rt.setup(["kit"]);
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(
      3,
    );

    // Past the ttl it is stale.
    const later = runtime(reg, {
      now: () => new Date(Date.now() + 2 * 3_600_000),
    });
    await later.rt.setup(["kit"]);
    expect((await readFile(counter, "utf8")).trim().split("\n")).toHaveLength(
      4,
    );

    const records = await readProjectLedger("demo", join(dir, "ledger"));
    expect(
      records.filter((r) => r.verb === "ensure" && r.status === "ok"),
    ).toHaveLength(4);
    expect(records.at(-1)).toMatchObject({
      seed: { lastRunAt: expect.any(String) },
      ttlMs: 3_600_000,
    });
    const state = foldLedger(records).get(ledgerKey("local", "kit"));
    expect(state).toMatchObject({ state: "live", outputs: { id: "k7" } });
  });

  it("folds ensure → teardown into torn-down and keeps failed ensures visible", async () => {
    const reg = registry({
      a: { kind: "exec", ensure: "echo '{}'", teardown: "true" },
      b: { kind: "exec", ensure: "exit 1", teardown: "true" },
    });
    const { rt } = runtime(reg);
    await rt.setup(["a"]);
    await rt.teardown("passed");
    await runtime(reg)
      .rt.setup(["b"])
      .catch(() => undefined);
    const states = foldLedger(
      await readProjectLedger("demo", join(dir, "ledger")),
    );
    expect(fixtureStates(states, "local", "a")[0]?.state).toBe("torn-down");
    expect(fixtureStates(states, "local", "b")[0]?.state).toBe("failed");
    const raw = await readFile(
      projectLedgerPath("demo", join(dir, "ledger")),
      "utf8",
    );
    expect(
      raw
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l).verb),
    ).toEqual(["ensure", "teardown", "ensure"]);
  });
});

describe("seed freshness and the invocation's seed", () => {
  it("keeps a seed fixture fresh when the invocation skipped the seed, and re-ensures after a seed run", async () => {
    const counter = join(dir, "seed-ensures.txt");
    const reg = registry({
      kit: {
        kind: "exec",
        scope: "seed",
        ensure: `echo x >> ${counter}; echo '{}'`,
      },
    });
    const count = async () =>
      (await readFile(counter, "utf8")).trim().split("\n").length;
    await runtime(reg).rt.setup(["kit"]);
    // A passing freshnessCheck moves the services seed state's timestamp...
    await mkdir(join(dir, "services"), { recursive: true });
    await writeFile(
      join(dir, "services", "demo.seed.json"),
      JSON.stringify({
        project: "demo",
        fingerprint: "f",
        lastRunAt: new Date(Date.now() + 1000).toISOString(),
        lastRunExitCode: 0,
      }),
    );
    // ...but the invocation saw the seed skipped: still fresh.
    const skipped = new FixtureHost();
    skipped.seed = { ran: false };
    await runtime(reg, { host: skipped }).rt.setup(["kit"]);
    expect(await count()).toBe(1);
    // Without that knowledge the moved timestamp is taken as a reseed.
    await runtime(reg).rt.setup(["kit"]);
    expect(await count()).toBe(2);
    // An invocation that watched the seed run records it for later ones.
    const ran = new FixtureHost();
    ran.seed = { ran: true, at: new Date(Date.now() + 2000).toISOString() };
    await runtime(reg, { host: ran }).rt.setup(["kit"]);
    expect(await count()).toBe(3);
    await recordSeedRun(
      "demo",
      new Date(Date.now() + 60_000).toISOString(),
      join(dir, "ledger"),
    );
    const later = new FixtureHost();
    later.seed = { ran: false };
    await runtime(reg, { host: later }).rt.setup(["kit"]);
    expect(await count()).toBe(4);
  });
});

describe("shared-environment dry-run", () => {
  const sharedReg = () =>
    registry({
      kit: {
        kind: "exec",
        ensure: `touch ${join(dir, "wrote")}; echo '{"id":"live"}'`,
        verify: `echo '{"id":"checked"}'`,
        reset: `touch ${join(dir, "reset")}`,
        teardown: `touch ${join(dir, "tore")}`,
        outputs: { id: "$.id" },
      },
    });

  it("dry-runs mutating verbs and reads outputs through the read-only verify", async () => {
    const { rt, events } = runtime(sharedReg(), { policyTrait: "shared" });
    await rt.setup(["kit.reset"]);
    await rt.teardown("passed");
    expect(events.map((e) => `${e.type}:${e.status}`)).toEqual([
      "fixture.verify:ok",
      "fixture.ensure:dry-run",
      "fixture.reset:dry-run",
    ]);
    expect(events[1]).toMatchObject({
      outputs: { id: "checked" },
      reason: expect.stringContaining("environment local is shared"),
    });
    await expect(readFile(join(dir, "wrote"))).rejects.toThrow();
    await expect(readFile(join(dir, "reset"))).rejects.toThrow();
    await expect(readFile(join(dir, "tore"))).rejects.toThrow();
  });

  it("writes with allowWrites or the ref's write: true", async () => {
    const allowed = runtime(sharedReg(), {
      policyTrait: "shared",
      allowWrites: true,
    });
    await allowed.rt.setup(["kit"]);
    expect(allowed.events[0]).toMatchObject({
      type: "fixture.ensure",
      status: "ok",
    });
    const opted = runtime(sharedReg(), { policyTrait: "shared" });
    await opted.rt.setup([{ use: "kit", write: true }]);
    expect(opted.events[0]).toMatchObject({
      type: "fixture.ensure",
      status: "ok",
    });
    await opted.rt.teardown("passed");
    expect(await readFile(join(dir, "tore"), "utf8")).toBe("");
  });

  it("fails when verify says the data is not there and writes are off", async () => {
    const reg = registry({
      kit: { kind: "exec", ensure: "true", verify: "echo missing >&2; exit 1" },
    });
    const { rt } = runtime(reg, { policyTrait: "shared" });
    const error = (await rt.setup(["kit"]).catch((e: unknown) => e)) as Error;
    expect(error.message).toMatch(/is not in place and writes are off/);
    expect(error.message).toMatch(/--allow-fixture-writes or write: true/);
  });
});

describe("invocation host (suite scope)", () => {
  it("ensures a suite fixture once for every run and tears it down at the end", async () => {
    const log = join(dir, "suite.txt");
    const reg = registry({
      tenant: {
        kind: "exec",
        scope: "suite",
        ensure: `echo ensure >> ${log}; echo '{"id":"t1"}'`,
        teardown: `echo teardown >> ${log}`,
        outputs: { id: "$.id" },
      },
    });
    const journal: FixtureEvent[] = [];
    const host = new FixtureHost({ onEvent: (event) => journal.push(event) });
    const runA = runtime(reg, { host });
    const runB = runtime(reg, { host });
    await Promise.all([runA.rt.setup(["tenant"]), runB.rt.setup(["tenant"])]);
    expect(runA.rt.outputs()).toEqual({ tenant: { id: "t1" } });
    expect(runB.rt.outputs()).toEqual({ tenant: { id: "t1" } });
    expect(
      [...runA.events, ...runB.events].map((e) => e.status).toSorted(),
    ).toEqual(["ok", "skipped"]);
    // Runs never tear a suite fixture down themselves.
    await runA.rt.teardown("passed");
    await runB.rt.teardown("passed");
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "ensure",
    ]);
    expect(host.pendingTeardowns).toBe(1);
    await host.teardownAll();
    expect((await readFile(log, "utf8")).trim().split("\n")).toEqual([
      "ensure",
      "teardown",
    ]);
    expect(journal.map((e) => `${e.type}:${e.status}`)).toEqual([
      "fixture.ensure:ok",
      "fixture.teardown:ok",
    ]);
  });
});

/* ----- the safety contract (review fixes) ----- */

describe("verify is read-only", () => {
  it("refuses a verify that could write, in the schema", () => {
    const mongo = FixturesRegistrySchema.safeParse({
      kit: {
        kind: "mongo",
        datasource: "appdb",
        ensure: [{ insertOne: { collection: "kits", document: {} } }],
        verify: [
          { findOne: { collection: "kits", filter: {} } },
          { insertOne: { collection: "kits", document: {} } },
        ],
      },
    });
    expect(mongo.success).toBe(false);
    expect(JSON.stringify(mongo.error?.issues)).toContain(
      "verify is read-only: insertOne is not allowed (use findOne or count)",
    );
    const http = FixturesRegistrySchema.safeParse({
      item: {
        kind: "http",
        ensure: { find: { path: "/api/items", where: { name: "x" } } },
        verify: {
          find: { path: "/api/items", where: { name: "x" } },
          create: { path: "/api/items", body: { name: "x" } },
          requests: [{ method: "POST", path: "/api/items" }],
        },
      },
    });
    expect(http.success).toBe(false);
    const messages = JSON.stringify(http.error?.issues);
    expect(messages).toContain("create is not allowed (find only)");
    expect(messages).toContain(
      "POST /api/items is not allowed (GET or HEAD only)",
    );
    expect(
      FixturesRegistrySchema.safeParse({
        item: {
          kind: "http",
          ensure: [{ method: "PUT", path: "/api/items/1" }],
          verify: [{ path: "/api/items/1" }, { method: "head", path: "/x" }],
        },
      }).success,
    ).toBe(true);
  });

  it("refuses writes at run time too, even past the schema", async () => {
    const api = await itemServer();
    // A registry built without the schema: the adapter is the last line.
    const reg = {
      item: {
        kind: "http",
        baseUrl: api.url,
        ensure: [{ path: "/api/items" }],
        verify: {
          find: { path: "/api/items", where: { name: "demo" } },
          create: { path: "/api/items", body: { name: "demo" } },
        },
      },
      posting: {
        kind: "http",
        baseUrl: api.url,
        ensure: [{ path: "/api/items" }],
        verify: [{ method: "POST", path: "/api/items", body: { name: "x" } }],
      },
    } as unknown as FixturesRegistry;
    for (const name of ["item", "posting"]) {
      const { rt } = runtime(reg, { policyTrait: "shared" });
      const error = (await rt.setup([name]).catch((e: unknown) => e)) as Error;
      expect(error.message).toMatch(/verify is read-only: refused/);
    }
    expect(api.requests.filter((r) => !r.startsWith("GET"))).toEqual([]);
    expect(api.items).toEqual([]);
  });

  it("never runs a mongosh verify script while writes are off, nor any script on a read-only datasource", async () => {
    const ran = join(dir, "script-ran");
    const fake = join(dir, "fake-mongosh.sh");
    await writeFile(fake, `#!/bin/sh\ntouch ${ran}\necho '{"id":"s1"}'\n`);
    await chmod(fake, 0o755);
    await writeFile(join(dir, "check.js"), "print('{}')\n");
    const datasources = DatasourcesConfigSchema.parse({
      shelldb: {
        kind: "mongo",
        uri: "mongodb://127.0.0.1:27017/app",
        database: "app",
        transport: "mongosh",
      },
      lockeddb: {
        kind: "mongo",
        uri: "mongodb://127.0.0.1:27017/app",
        database: "app",
        transport: "mongosh",
        mode: "read-only",
      },
    });
    const reg = registry({
      scripted: {
        kind: "mongo",
        datasource: "shelldb",
        ensure: { script: "check.js" },
        verify: { script: "check.js" },
        outputs: { id: "$.id" },
      },
      locked: {
        kind: "mongo",
        datasource: "lockeddb",
        ensure: [{ count: { collection: "kits", filter: {} } }],
        verify: { script: "check.js" },
      },
    });
    const extra = {
      datasourceSet: resolveEnvironmentDatasources(datasources, undefined),
      childEnv: { PATH: process.env["PATH"], CAIRN_MONGOSH_BIN: fake },
    };
    const dry = runtime(reg, { ...extra, policyTrait: "shared" });
    await dry.rt.setup(["scripted"]);
    expect(dry.events.at(-1)).toMatchObject({
      type: "fixture.ensure",
      status: "dry-run",
      reason: expect.stringContaining(
        "the verify script cannot run while writes are off",
      ),
    });
    await expect(readFile(ran)).rejects.toThrow();
    const status = await runtime(reg, {
      ...extra,
      policyTrait: "shared",
      origin: "cli",
    }).rt.verifyRecorded("scripted");
    expect(status).toMatchObject({ ok: true, skipped: true });
    await expect(readFile(ran)).rejects.toThrow();

    // Writes allowed, but the datasource is read-only: no script at all.
    const locked = await runtime(reg, {
      ...extra,
      origin: "cli",
    }).rt.verifyRecorded("locked");
    expect(locked.ok).toBe(false);
    expect(locked.error).toMatch(
      /lockeddb is read-only: refused the verify script/,
    );
    await expect(readFile(ran)).rejects.toThrow();
  });

  it("tells exec verify children they are read-only", async () => {
    const reg = registry({
      probe: {
        kind: "exec",
        ensure: "echo '{}'",
        verify: 'echo "{\\"ro\\":\\"$CAIRN_FIXTURE_READ_ONLY\\"}"',
        outputs: { ro: "$.ro" },
      },
    });
    const { rt } = runtime(reg, { policyTrait: "shared" });
    await rt.setup(["probe"]);
    expect(rt.outputs()["probe"]).toEqual({ ro: "1" });
  });
});

interface Item {
  id: string;
  name: string;
  cairnFixture?: string;
}

async function itemServer(seed: Item[] = []): Promise<{
  url: string;
  items: Item[];
  requests: string[];
}> {
  const items = [...seed];
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      requests.push(`${req.method} ${req.url}`);
      res.setHeader("content-type", "application/json");
      if (req.url === "/api/items" && req.method === "GET") {
        res.end(JSON.stringify(items));
        return;
      }
      if (req.url === "/api/items" && req.method === "POST") {
        const created = {
          id: `it${items.length + 1}`,
          ...(JSON.parse(body) as Omit<Item, "id">),
        };
        items.push(created);
        res.statusCode = 201;
        res.end(JSON.stringify(created));
        return;
      }
      const del = /^\/api\/items\/(\w+)$/.exec(req.url ?? "");
      if (del && req.method === "DELETE") {
        const index = items.findIndex((item) => item.id === del[1]);
        if (index >= 0) items.splice(index, 1);
        res.statusCode = index >= 0 ? 204 : 404;
        res.end();
        return;
      }
      res.statusCode = 404;
      res.end("{}");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as { port: number };
  return { url: `http://127.0.0.1:${port}`, items, requests };
}

function buyerRegistry(url: string, marker = true): FixturesRegistry {
  return registry({
    buyer: {
      kind: "http",
      baseUrl: url,
      with: { name: "Demo Buyer" },
      owner: {
        exactlyOne: true,
        ...(marker ? { marker: { cairnFixture: "buyer" } } : {}),
      },
      ensure: {
        find: { path: "/api/items", where: { name: "${with.name}" } },
        create: { path: "/api/items", body: { name: "${with.name}" } },
      },
      verify: {
        find: { path: "/api/items", where: { id: "${fixtures.buyer.id}" } },
      },
      teardown: [
        {
          method: "DELETE",
          path: "/api/items/${fixtures.buyer.id}",
          status: [204, 404],
        },
      ],
      outputs: { id: "$.item.id" },
    },
  });
}

describe("http teardown only removes what the fixture owns", () => {
  it("leaves a record it found but did not create, and releases it in the ledger", async () => {
    const api = await itemServer([{ id: "human1", name: "Demo Buyer" }]);
    const { rt, events } = runtime(buyerRegistry(api.url));
    await rt.setup(["buyer"]);
    expect(rt.outputs()["buyer"]).toEqual({ id: "human1" });
    await rt.teardown("passed");
    expect(api.items).toEqual([{ id: "human1", name: "Demo Buyer" }]);
    expect(api.requests.some((r) => r.startsWith("DELETE"))).toBe(false);
    expect(events.at(-1)).toMatchObject({
      type: "fixture.teardown",
      status: "skipped",
      reason: expect.stringContaining("did not create"),
    });
    const states = foldLedger(
      await readProjectLedger("demo", join(dir, "ledger")),
    );
    expect(fixtureStates(states, "local", "buyer")[0]).toMatchObject({
      state: "released",
      adopted: true,
    });
  });

  it("tears down what it created, and a found record that carries its marker", async () => {
    const api = await itemServer([
      { id: "human1", name: "Demo Buyer" },
      { id: "left1", name: "Demo Buyer", cairnFixture: "buyer" },
    ]);
    // Two match the natural key: the marked one is preferred, and owned.
    const reg = registry({
      buyer: {
        ...(buyerRegistry(api.url).buyer as Record<string, unknown>),
        owner: { marker: { cairnFixture: "buyer" } },
      },
    });
    const found = runtime(reg);
    await found.rt.setup(["buyer"]);
    expect(found.rt.outputs()["buyer"]).toEqual({ id: "left1" });
    await found.rt.teardown("passed");
    expect(api.items.map((item) => item.id)).toEqual(["human1"]);

    const created = runtime(buyerRegistry(api.url));
    await created.rt.setup([{ use: "buyer", with: { name: "Fresh" } }]);
    expect(api.items.at(-1)).toMatchObject({
      name: "Fresh",
      cairnFixture: "buyer",
    });
    await created.rt.teardown("passed");
    expect(api.items.map((item) => item.id)).toEqual(["human1"]);
  });
});

describe("environment policy keeps fixture writes off", () => {
  it("dry-runs on shared and protected (unless allowed) and always under mutations: deny", () => {
    expect(fixtureWriteBlock({ envName: "dev" })).toBeUndefined();
    expect(
      fixtureWriteBlock({ envName: "qa", policyTrait: "protected" }),
    ).toMatch(
      /environment qa is protected: writes need --allow-fixture-writes/,
    );
    expect(
      fixtureWriteBlock({
        envName: "qa",
        policyTrait: "protected",
        allowWrites: true,
      }),
    ).toBeUndefined();
    expect(
      fixtureWriteBlock({
        envName: "locked",
        policyTrait: "owned",
        policyMutations: "deny",
        allowWrites: true,
        write: true,
      }),
    ).toMatch(/denies mutations \(policy.mutations: deny\)/);
  });

  it("writes nothing on a mutations: deny environment, write opt-ins included", async () => {
    const wrote = join(dir, "wrote");
    const reg = registry({
      writer: {
        kind: "exec",
        ensure: `touch ${wrote}; echo '{"id":"w1"}'`,
        teardown: `touch ${wrote}`,
      },
    });
    const { rt, events } = runtime(reg, {
      policyTrait: "owned",
      policyMutations: "deny",
      allowWrites: true,
    });
    await rt.setup([{ use: "writer", write: true }]);
    await rt.teardown("passed");
    expect(events.map((e) => `${e.type}:${e.status}`)).toEqual([
      "fixture.ensure:dry-run",
    ]);
    await expect(readFile(wrote)).rejects.toThrow();
  });
});

describe("the ledger keeps run instances apart", () => {
  it("one run's teardown never hides another run's live instance", async () => {
    const reg = registry({
      writer: {
        kind: "exec",
        ensure: 'echo \'{"id":"w"}\'',
        teardown: "true",
        outputs: { id: "$.id" },
      },
    });
    const slow = runtime(reg, { runId: "run-slow" });
    const fast = runtime(reg, { runId: "run-fast" });
    await slow.rt.setup(["writer"]);
    await fast.rt.setup(["writer"]);
    await fast.rt.teardown("passed");
    // slow is killed: no teardown.
    const states = foldLedger(
      await readProjectLedger("demo", join(dir, "ledger")),
    );
    const instances = fixtureStates(states, "local", "writer");
    expect(
      instances.map((state) => [state.instance, state.state]).toSorted(),
    ).toEqual([
      ["run-fast", "torn-down"],
      ["run-slow", "live"],
    ]);
    expect(states.get(ledgerKey("local", "writer", "run-slow"))?.state).toBe(
      "live",
    );
    // A sweep-style teardown of that instance clears it.
    const cli = runtime(reg, { origin: "cli" });
    expect(
      await cli.rt.teardownRecorded("writer", {
        origin: "sweep",
        instance: "run-slow",
      }),
    ).toEqual({ status: "ok" });
    const after = foldLedger(
      await readProjectLedger("demo", join(dir, "ledger")),
    );
    expect(
      fixtureStates(after, "local", "writer").map((state) => state.state),
    ).toEqual(["torn-down", "torn-down"]);
  });
});

describe("secrets stay out of the ledger and events", () => {
  it("redacts outputs under sensitive keys and registers their values as secrets", async () => {
    const reg = registry({
      tok: {
        kind: "exec",
        ensure: 'echo \'{"id":"x1","apiToken":"tokSUPERSECRET123"}\'',
        teardown: "true",
      },
    });
    const { rt, events } = runtime(reg);
    await rt.setup(["tok"]);
    // The run still splices the real value...
    expect(rt.outputs()["tok"]).toEqual({
      id: "x1",
      apiToken: "tokSUPERSECRET123",
    });
    // ...but every record of it is redacted, and the runner scrubs it.
    expect(rt.secretValues()).toContain("tokSUPERSECRET123");
    expect(JSON.stringify(events)).not.toContain("tokSUPERSECRET123");
    expect(JSON.stringify(rt.runLedger())).not.toContain("tokSUPERSECRET123");
    const raw = await readFile(
      projectLedgerPath("demo", join(dir, "ledger")),
      "utf8",
    );
    expect(raw).not.toContain("tokSUPERSECRET123");
    expect(raw).toContain('"apiToken":"[redacted]"');
  });
});

describe("dry-run outputs must match the definition and parameters", () => {
  it("never hands one instance's ids to a spec asking for other parameters", async () => {
    // The ensure echoes its name parameter into the id.
    const withArgs = registry({
      buyer: {
        kind: "exec",
        with: { name: "Alpha" },
        ensure: {
          shell: 'echo "{\\"id\\":\\"id-$1\\"}"',
          args: ["${with.name}"],
        },
        outputs: { id: "$.id" },
      },
    });
    await runtime(withArgs, {
      policyTrait: "shared",
      allowWrites: true,
    }).rt.setup(["buyer"]);
    const same = runtime(withArgs, { policyTrait: "shared" });
    await same.rt.setup(["buyer"]);
    expect(same.rt.outputs()["buyer"]).toEqual({ id: "id-Alpha" });
    const other = runtime(withArgs, { policyTrait: "shared" });
    await other.rt.setup([{ use: "buyer", with: { name: "Beta" } }]);
    expect(other.rt.outputs()["buyer"]).toEqual({});
    expect(other.events.at(-1)).toMatchObject({
      status: "dry-run",
      reason: expect.stringContaining(
        "no ledger record of this definition and parameters: outputs unavailable",
      ),
    });
  });
});

describe("a teardown that needs outputs a failed ensure never recorded", () => {
  it("is skipped (not failed), and a sweep releases it", async () => {
    const reg = registry({
      broken: {
        kind: "exec",
        ensure: "exit 3",
        teardown: 'echo "${fixtures.broken.id}"',
        outputs: { id: "$.id" },
      },
    });
    const { rt, events } = runtime(reg, { runId: "run-1" });
    await rt.setup(["broken"]).catch(() => undefined);
    expect(await rt.teardown("errored")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "fixture.teardown",
      status: "skipped",
      reason: expect.stringContaining("no recorded outputs"),
    });
    let states = foldLedger(
      await readProjectLedger("demo", join(dir, "ledger")),
    );
    expect(fixtureStates(states, "local", "broken")[0]?.state).toBe("failed");
    const sweep = runtime(reg, { origin: "cli" });
    expect(
      await sweep.rt.teardownRecorded("broken", {
        origin: "sweep",
        instance: "run-1",
      }),
    ).toEqual({ status: "skipped" });
    states = foldLedger(await readProjectLedger("demo", join(dir, "ledger")));
    expect(fixtureStates(states, "local", "broken")[0]?.state).toBe("released");
  });
});
