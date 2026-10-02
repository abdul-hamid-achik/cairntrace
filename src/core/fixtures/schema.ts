import { z } from "zod";
import { HttpStatusMatchSchema } from "../gates/schema";
import { PathMatchersSchema, ValueMatcherSchema } from "../schema/verifier.v1";

/**
 * Config `fixtures:` registry (plan F3b): named, declarative test data that
 * specs reference with `fixtures: [name | name.reset | {use, with, write}]`
 * instead of hand-rolled ensure/clear/provision scripts in preconditions.
 *
 * A fixture has one adapter (`kind`):
 *
 * - `exec`: a shell command or node script per verb; the last stdout line,
 *   when it is JSON, is the verb's result.
 * - `mongo`: declarative operations on a `datasources:` entry (insertOne,
 *   updateOne, replaceOne, deleteMany, cloneDoc, findOne, count, … with
 *   `expect` on matched/modified/deleted counts), or a `script:` run through
 *   mongosh with EJSON `args` (the escape hatch).
 * - `http`: find-or-create by natural key against an `http` datasource or a
 *   base URL, with an optional login helper; outputs come from JSONPath.
 *
 * Verbs: `ensure` (make it exist; idempotent), `reset` (put it back to its
 * initial state), `verify` (read-only presence check; also the freshness
 * check of a seed/suite fixture with `ttl`), `teardown` (remove it; runs in
 * reverse ensure order on every exit path). `verify` runs where writes are
 * off (a shared environment's dry-run), so it is held to reads: mongo
 * `findOne` / `count`, http `find` and GET/HEAD requests (no `create`), a
 * mongosh `script` only while writes are allowed, and exec children get
 * `CAIRN_FIXTURE_READ_ONLY=1` (their contract: read, never write).
 *
 * Scopes: `run` (default: ensured per run, torn down at the end of the run),
 * `suite` (once per `cairn run` invocation, torn down when it ends) and
 * `seed` (once per services seed: re-ensured after the seed runs again or
 * when `ttl`/`verify` say it is stale; never torn down automatically).
 *
 * Strings may use `${with.X}` (fixture parameters), `${fixtures.<name>.<key>}`
 * (outputs of a fixture it needs, or its own in reset/verify/teardown),
 * `${vars.X}`, `${secrets.X}` / `${env.X}`, `${baseUrl}`, `${run.token}` and
 * `${now}`; they are resolved when the verb runs.
 */

export const FIXTURE_NAME_PATTERN = /^[a-z][A-Za-z0-9_]*$/;
export const FixtureNameSchema = z
  .string()
  .regex(
    FIXTURE_NAME_PATTERN,
    "fixture names start with a lowercase letter (letters, digits, _)",
  );

export const FIXTURE_SCOPES = ["run", "suite", "seed"] as const;
export const FixtureScopeSchema = z.enum(FIXTURE_SCOPES);
export type FixtureScope = z.infer<typeof FixtureScopeSchema>;

export const FIXTURE_VERBS = ["ensure", "reset", "verify", "teardown"] as const;
export const FixtureVerbNameSchema = z.enum(FIXTURE_VERBS);
export type FixtureVerbName = z.infer<typeof FixtureVerbNameSchema>;

export const FIXTURE_ADAPTERS = ["exec", "mongo", "http"] as const;
export const FixtureAdapterSchema = z.enum(FIXTURE_ADAPTERS);
export type FixtureAdapter = z.infer<typeof FixtureAdapterSchema>;

/** Lifetime rank: a fixture may only need fixtures that live as long. */
export const SCOPE_RANK: Record<FixtureScope, number> = {
  run: 0,
  suite: 1,
  seed: 2,
};

const DURATION_PATTERN = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/;
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Milliseconds, or `500ms` / `30s` / `5m` / `6h` / `2d`. */
export const FixtureDurationSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(
      DURATION_PATTERN,
      'duration must be milliseconds or a number with ms|s|m|h|d (e.g. "6h")',
    ),
]);
export type FixtureDuration = z.infer<typeof FixtureDurationSchema>;

/** Duration → milliseconds. Throws on an unreadable value. */
export function fixtureDurationMs(value: FixtureDuration): number {
  if (typeof value === "number") return value;
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) throw new Error(`invalid duration "${value}"`);
  return Math.round(Number(match[1]) * UNIT_MS[match[2]!]!);
}

const ParamsSchema = z.record(z.string(), z.unknown());
const DocumentSchema = z.record(z.string(), z.unknown());
const OUTPUT_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const AS_PATTERN = /^[a-z][A-Za-z0-9_]*$/;

/* ----- exec ----- */

const ScalarArgSchema = z.union([z.string(), z.number(), z.boolean()]);

const ExecVerbObjectSchema = z
  .object({
    /** Shell command (`/bin/sh -c`); `args` become `$1…$n`. */
    shell: z.string().min(1).optional(),
    /** Node script, relative to the config directory. */
    node: z.string().min(1).optional(),
    args: z.array(ScalarArgSchema).optional(),
    /** Working directory (default: the config directory). */
    cwd: z.string().min(1).optional(),
    env: z.record(z.string(), ScalarArgSchema).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .refine((verb) => (verb.shell === undefined) !== (verb.node === undefined), {
    message: "an exec verb needs exactly one of shell or node",
  });

/** A shell string, or `{shell | node, args, cwd, env, timeoutMs}`. */
export const ExecVerbSchema = z.union([
  z.string().min(1),
  ExecVerbObjectSchema,
]);
export type ExecVerb = z.infer<typeof ExecVerbSchema>;

/* ----- mongo ----- */

const mongoTarget = {
  collection: z.string().min(1),
  /** Defaults to the datasource's database. */
  database: z.string().min(1).optional(),
};

const MongoInsertOneSchema = z
  .object({ ...mongoTarget, document: DocumentSchema })
  .strict();
const MongoInsertManySchema = z
  .object({ ...mongoTarget, documents: z.array(DocumentSchema).min(1) })
  .strict();
const MongoUpdateSchema = z
  .object({
    ...mongoTarget,
    filter: DocumentSchema,
    update: z.union([DocumentSchema, z.array(DocumentSchema).min(1)]),
    upsert: z.boolean().optional(),
  })
  .strict();
const MongoReplaceOneSchema = z
  .object({
    ...mongoTarget,
    filter: DocumentSchema,
    replacement: DocumentSchema,
    upsert: z.boolean().optional(),
  })
  .strict();
const MongoDeleteSchema = z
  .object({ ...mongoTarget, filter: DocumentSchema })
  .strict();
/**
 * Copy a source document onto a fixed target: the first `from` filter that
 * matches (in order) is read, `set` / `unset` are applied, and the result is
 * written with `replaceOne(to, …, {upsert: true})` keeping `to._id`.
 */
const MongoCloneDocSchema = z
  .object({
    ...mongoTarget,
    /** Source filter, or fallbacks tried in order. */
    from: z.union([DocumentSchema, z.array(DocumentSchema).min(1)]),
    /** Read the source from another collection (default: `collection`). */
    fromCollection: z.string().min(1).optional(),
    /** The target's identity (usually `{_id: …}`). */
    to: DocumentSchema,
    /** Fields to set on the copy (dotted paths allowed). */
    set: DocumentSchema.optional(),
    /** Fields to drop from the copy (dotted paths allowed). */
    unset: z.array(z.string().min(1)).optional(),
  })
  .strict();
const MongoFindOneSchema = z
  .object({
    ...mongoTarget,
    filter: DocumentSchema,
    projection: DocumentSchema.optional(),
  })
  .strict();
const MongoCountSchema = z
  .object({ ...mongoTarget, filter: DocumentSchema })
  .strict();

/** Expectations on one operation's result (a number means `equals`). */
const MongoExpectSchema = z
  .object({
    matched: ValueMatcherSchema.optional(),
    modified: ValueMatcherSchema.optional(),
    upserted: ValueMatcherSchema.optional(),
    deleted: ValueMatcherSchema.optional(),
    inserted: ValueMatcherSchema.optional(),
    /** `count`: the count; `findOne`: 1 or 0. */
    count: ValueMatcherSchema.optional(),
    /** `findOne` / `cloneDoc`: whether a document was found. */
    found: z.boolean().optional(),
    /** `findOne`: path → matcher on the found document. */
    fields: PathMatchersSchema.optional(),
  })
  .strict();

export const MONGO_FIXTURE_OPS = [
  "insertOne",
  "insertMany",
  "updateOne",
  "updateMany",
  "replaceOne",
  "deleteOne",
  "deleteMany",
  "cloneDoc",
  "findOne",
  "count",
] as const;
export type MongoFixtureOpName = (typeof MONGO_FIXTURE_OPS)[number];

export const MongoFixtureOpSchema = z
  .object({
    insertOne: MongoInsertOneSchema.optional(),
    insertMany: MongoInsertManySchema.optional(),
    updateOne: MongoUpdateSchema.optional(),
    updateMany: MongoUpdateSchema.optional(),
    replaceOne: MongoReplaceOneSchema.optional(),
    deleteOne: MongoDeleteSchema.optional(),
    deleteMany: MongoDeleteSchema.optional(),
    cloneDoc: MongoCloneDocSchema.optional(),
    findOne: MongoFindOneSchema.optional(),
    count: MongoCountSchema.optional(),
    expect: MongoExpectSchema.optional(),
    /** Name of this operation's result in the verb result (`$.<as>…`). */
    as: z.string().regex(AS_PATTERN).optional(),
  })
  .strict()
  .superRefine((op, ctx) => {
    const present = MONGO_FIXTURE_OPS.filter((key) => op[key] !== undefined);
    if (present.length !== 1) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `a mongo operation needs exactly one of ${MONGO_FIXTURE_OPS.join(", ")}${
          present.length > 1 ? ` (found ${present.join(", ")})` : ""
        }`,
      });
    }
  });
export type MongoFixtureOp = z.infer<typeof MongoFixtureOpSchema>;

/** mongosh escape hatch: a script file run against the datasource. */
const MongoScriptVerbSchema = z
  .object({
    /** mongosh script, relative to the config directory. */
    script: z.string().min(1),
    /** Arguments, available to the script as `args` (EJSON). */
    args: ParamsSchema.optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

const MongoOpsVerbSchema = z
  .object({
    ops: z.array(MongoFixtureOpSchema).min(1),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict();

/** A list of operations, `{ops, timeoutMs}`, or `{script, args}`. */
export const MongoVerbSchema = z.union([
  z.array(MongoFixtureOpSchema).min(1),
  MongoOpsVerbSchema,
  MongoScriptVerbSchema,
]);
export type MongoVerb = z.infer<typeof MongoVerbSchema>;

/* ----- http ----- */

const HttpRequestSchema = z
  .object({
    method: z.string().min(1).optional(),
    /** Path under the base URL (or an absolute URL). */
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    /** Accepted statuses (default 2xx). */
    status: HttpStatusMatchSchema.optional(),
    /** path → matcher on the response body. */
    expect: PathMatchersSchema.optional(),
    /** Name of the response body in the verb result (`$.<as>…`). */
    as: z.string().regex(AS_PATTERN).optional(),
  })
  .strict();

/** Look up an existing item by its natural key. */
const HttpFindSchema = z
  .object({
    method: z.string().min(1).optional(),
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    status: HttpStatusMatchSchema.optional(),
    /** JSONPath of the candidate list (default: the body when it is a list). */
    items: z.string().min(1).optional(),
    /** The natural key: path → matcher on each candidate. */
    where: PathMatchersSchema,
  })
  .strict();

const HttpCreateSchema = HttpRequestSchema.extend({
  /** JSONPath of the created item in the response (default: the body). */
  item: z.string().min(1).optional(),
}).strict();

const HttpVerbObjectSchema = z
  .object({
    find: HttpFindSchema.optional(),
    /** Create when `find` matched nothing. */
    create: HttpCreateSchema.optional(),
    /** Repeat `find` after a create (the canonical item, ids included). */
    refind: z.boolean().optional(),
    /** Requests run in order after find/create. */
    requests: z.array(HttpRequestSchema).min(1).optional(),
    timeoutMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((verb, ctx) => {
    if (verb.find === undefined && verb.requests === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "an http verb needs find (find-or-create) or requests",
      });
    }
    if (verb.create !== undefined && verb.find === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["create"],
        message: "create needs find (the natural-key lookup)",
      });
    }
    if (verb.refind === true && verb.create === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["refind"],
        message: "refind needs create",
      });
    }
  });

/** `{find, create, refind, requests}`, or a list of requests. */
export const HttpVerbSchema = z.union([
  z.array(HttpRequestSchema).min(1),
  HttpVerbObjectSchema,
]);
export type HttpVerb = z.infer<typeof HttpVerbSchema>;
export type HttpFixtureRequest = z.infer<typeof HttpRequestSchema>;

/** Log in once per verb; the token is sent on every later request. */
const HttpLoginSchema = z
  .object({
    method: z.string().min(1).optional(),
    path: z.string().min(1),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
    status: HttpStatusMatchSchema.optional(),
    /** JSONPath of the token in the response body (default `$.token`). */
    token: z.string().min(1).optional(),
    /** Header that carries it (default `Authorization`). */
    header: z.string().min(1).optional(),
    /** Prefix (default `Bearer`; "" sends the raw token). */
    scheme: z.string().optional(),
  })
  .strict();

/* ----- the fixture ----- */

const FixtureOwnerSchema = z
  .object({
    /**
     * The natural key matches at most one record: an http `find` or a mongo
     * update/replace/delete/clone target that matches more fails instead of
     * picking one.
     */
    exactlyOne: z.boolean().optional(),
    /**
     * Fields stamped on everything the fixture creates (mongo inserts,
     * clones, replacements and upserts; merged into an http `create.body`;
     * `CAIRN_FIXTURE_MARKER` for exec). Mongo deletes, and every mongo write
     * of `teardown`, only touch documents that carry it.
     */
    marker: z
      .record(z.string(), z.unknown())
      .refine((marker) => Object.keys(marker).length > 0, {
        message: "marker needs at least one field",
      })
      .optional(),
  })
  .strict();

/** An output: a JSONPath into the verb result (`$…`) or a template. */
export const FixtureOutputSchema = z.union([
  z.string(),
  z
    .object({
      from: z.string().min(1),
      /** Usable as `${fixtures.x.key}` but never written to evidence. */
      secret: z.boolean().optional(),
    })
    .strict(),
]);

const fixtureCommon = {
  description: z.string().min(1).optional(),
  /** run (default) | suite | seed. */
  scope: FixtureScopeSchema.optional(),
  /** Default parameters (`${with.X}`); a spec's `with:` overrides them. */
  with: ParamsSchema.optional(),
  /** Outputs read as `${fixtures.<name>.<key>}`. */
  outputs: z
    .record(z.string().regex(OUTPUT_KEY_PATTERN), FixtureOutputSchema)
    .optional(),
  owner: FixtureOwnerSchema.optional(),
  /**
   * Freshness of a seed/suite fixture: an ensure recorded in the ledger
   * within `ttl` (and a passing `verify`, when declared) is reused instead
   * of running `ensure` again.
   */
  ttl: FixtureDurationSchema.optional(),
  /** Fixtures ensured first (they must live at least as long). */
  needs: z.array(FixtureNameSchema).optional(),
  /** Default budget of each verb in ms (default 120000). */
  timeoutMs: z.number().int().positive().optional(),
};

export const ExecFixtureSchema = z
  .object({
    kind: z.literal("exec"),
    ...fixtureCommon,
    ensure: ExecVerbSchema.optional(),
    reset: ExecVerbSchema.optional(),
    verify: ExecVerbSchema.optional(),
    teardown: ExecVerbSchema.optional(),
  })
  .strict();

export const MongoFixtureSchema = z
  .object({
    kind: z.literal("mongo"),
    ...fixtureCommon,
    /** A `datasources:` entry of kind mongo. */
    datasource: z.string().min(1),
    ensure: MongoVerbSchema.optional(),
    reset: MongoVerbSchema.optional(),
    verify: MongoVerbSchema.optional(),
    teardown: MongoVerbSchema.optional(),
  })
  .strict();

export const HttpFixtureSchema = z
  .object({
    kind: z.literal("http"),
    ...fixtureCommon,
    /** A `datasources:` entry of kind http (base URL, headers, auth). */
    datasource: z.string().min(1).optional(),
    /** Base URL when there is no datasource (default: the env's baseUrl). */
    baseUrl: z.string().min(1).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    login: HttpLoginSchema.optional(),
    ensure: HttpVerbSchema.optional(),
    reset: HttpVerbSchema.optional(),
    verify: HttpVerbSchema.optional(),
    teardown: HttpVerbSchema.optional(),
  })
  .strict();

export const FixtureDefinitionSchema = z
  .discriminatedUnion("kind", [
    ExecFixtureSchema,
    MongoFixtureSchema,
    HttpFixtureSchema,
  ])
  .superRefine((fixture, ctx) => {
    if (fixture.ensure === undefined && fixture.reset === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "a fixture needs ensure or reset",
      });
    }
    if (
      fixture.kind === "http" &&
      fixture.datasource !== undefined &&
      fixture.baseUrl !== undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["baseUrl"],
        message: "an http fixture takes one of: datasource, baseUrl",
      });
    }
    for (const problem of verifyWriteProblems(fixture)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["verify", ...problem.path],
        message: problem.message,
      });
    }
  });
export type FixtureDefinition = z.infer<typeof FixtureDefinitionSchema>;

/** Mongo operations a `verify` may run (it must never write). */
export const MONGO_READ_OPS: readonly MongoFixtureOpName[] = [
  "findOne",
  "count",
];
/** HTTP methods a `verify` may send (the login helper aside). */
export const HTTP_READ_METHODS: readonly string[] = ["GET", "HEAD"];

function httpMethod(raw: string | undefined): string {
  return (raw ?? "GET").toUpperCase();
}

/**
 * `verify` is the read-only check that runs where writes are off (a shared
 * environment's dry-run, freshness checks, `cairn fixtures status
 * --verify`): a verify that could write is a config error.
 */
function verifyWriteProblems(
  fixture: z.infer<typeof ExecFixtureSchema> | MongoFixture | HttpFixture,
): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  if (fixture.kind === "mongo" && fixture.verify !== undefined) {
    const verify = fixture.verify;
    const ops = Array.isArray(verify)
      ? verify
      : "ops" in verify
        ? verify.ops
        : [];
    const prefix = Array.isArray(verify) ? [] : ["ops"];
    ops.forEach((op, index) => {
      const name = MONGO_FIXTURE_OPS.find((key) => op[key] !== undefined);
      if (name && !MONGO_READ_OPS.includes(name)) {
        problems.push({
          path: [...prefix, index, name],
          message: `verify is read-only: ${name} is not allowed (use ${MONGO_READ_OPS.join(" or ")})`,
        });
      }
    });
  }
  if (fixture.kind === "http" && fixture.verify !== undefined) {
    const listed = Array.isArray(fixture.verify);
    const verify = Array.isArray(fixture.verify)
      ? { requests: fixture.verify }
      : fixture.verify;
    if ("create" in verify && verify.create !== undefined) {
      problems.push({
        path: ["create"],
        message: "verify is read-only: create is not allowed (find only)",
      });
    }
    if ("find" in verify && verify.find !== undefined) {
      const used = httpMethod(verify.find.method);
      if (!HTTP_READ_METHODS.includes(used)) {
        problems.push({
          path: ["find", "method"],
          message: `verify is read-only: find uses ${used} (${HTTP_READ_METHODS.join(" or ")} only)`,
        });
      }
    }
    (verify.requests ?? []).forEach((request, index) => {
      const used = httpMethod(request.method);
      if (!HTTP_READ_METHODS.includes(used)) {
        problems.push({
          path: [...(listed ? [] : ["requests"]), index, "method"],
          message: `verify is read-only: ${used} ${request.path} is not allowed (${HTTP_READ_METHODS.join(" or ")} only)`,
        });
      }
    });
  }
  return problems;
}
export type MongoFixture = z.infer<typeof MongoFixtureSchema>;
export type HttpFixture = z.infer<typeof HttpFixtureSchema>;

/** Top-level `fixtures:` block. */
export const FixturesRegistrySchema = z
  .record(FixtureNameSchema, FixtureDefinitionSchema)
  .superRefine((registry, ctx) => {
    for (const problem of registryProblems(registry)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: problem.path,
        message: problem.message,
      });
    }
  });
export type FixturesRegistry = z.infer<typeof FixturesRegistrySchema>;

export function fixtureScope(fixture: { scope?: FixtureScope }): FixtureScope {
  return fixture.scope ?? "run";
}

/** Unknown `needs`, self-needs, cycles and lifetime mismatches. */
export function registryProblems(
  registry: Readonly<Record<string, FixtureDefinition>>,
): Array<{ path: Array<string | number>; message: string }> {
  const problems: Array<{ path: Array<string | number>; message: string }> = [];
  for (const [name, fixture] of Object.entries(registry)) {
    for (const [index, need] of (fixture.needs ?? []).entries()) {
      const path = [name, "needs", index];
      if (need === name) {
        problems.push({ path, message: `fixture ${name} needs itself` });
        continue;
      }
      const needed = registry[need];
      if (!needed) {
        problems.push({
          path,
          message: `unknown fixture "${need}"; fixtures: ${Object.keys(registry).join(", ")}`,
        });
        continue;
      }
      if (
        SCOPE_RANK[fixtureScope(needed)] < SCOPE_RANK[fixtureScope(fixture)]
      ) {
        problems.push({
          path,
          message: `a ${fixtureScope(fixture)} fixture cannot need the ${fixtureScope(
            needed,
          )} fixture ${need} (it would be torn down first)`,
        });
      }
    }
  }
  const cycle = findNeedsCycle(registry);
  if (cycle) {
    problems.push({
      path: [cycle[0]!, "needs"],
      message: `fixture needs cycle: ${cycle.join(" → ")}`,
    });
  }
  return problems;
}

function findNeedsCycle(
  registry: Readonly<Record<string, FixtureDefinition>>,
): string[] | undefined {
  const state = new Map<string, "visiting" | "done">();
  const stack: string[] = [];
  const visit = (name: string): string[] | undefined => {
    const seen = state.get(name);
    if (seen === "done") return undefined;
    if (seen === "visiting") {
      return [...stack.slice(stack.indexOf(name)), name];
    }
    state.set(name, "visiting");
    stack.push(name);
    for (const need of registry[name]?.needs ?? []) {
      if (!registry[need] || need === name) continue;
      const cycle = visit(need);
      if (cycle) return cycle;
    }
    stack.pop();
    state.set(name, "done");
    return undefined;
  };
  for (const name of Object.keys(registry)) {
    const cycle = visit(name);
    if (cycle) return cycle;
  }
  return undefined;
}

/* ----- spec references ----- */

const SPEC_REF_PATTERN = /^[a-z][A-Za-z0-9_]*(?:\.reset)?$/;
const SpecRefNameSchema = z
  .string()
  .regex(
    SPEC_REF_PATTERN,
    "a fixture reference is a fixture name, or <name>.reset",
  );

/**
 * One entry of a spec's `fixtures:` list: `name` (ensure), `name.reset`
 * (ensure what it needs, then run its reset verb before the steps), or
 * `{use: name | name.reset, with: {…}, write: true}` (`with` overrides the
 * fixture's parameters; `write: true` lets mutating verbs run on an
 * environment whose policy trait is shared or protected — never under
 * `policy.mutations: deny`).
 */
export const SpecFixtureRefSchema = z.union([
  SpecRefNameSchema,
  z
    .object({
      use: SpecRefNameSchema,
      with: ParamsSchema.optional(),
      write: z.boolean().optional(),
    })
    .strict(),
]);
export type SpecFixtureRef = z.infer<typeof SpecFixtureRefSchema>;

export const SpecFixturesSchema = z
  .array(SpecFixtureRefSchema)
  .min(1)
  .superRefine((refs, ctx) => {
    const seen = new Set<string>();
    refs.forEach((ref, index) => {
      const name = specFixtureRefParts(ref).name;
      if (seen.has(name)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [index],
          message: `fixture ${name} is listed twice`,
        });
      }
      seen.add(name);
    });
  });

/** Name, whether `.reset` was asked, params and the write opt-in of a ref. */
export function specFixtureRefParts(ref: SpecFixtureRef): {
  name: string;
  reset: boolean;
  with?: Record<string, unknown>;
  write: boolean;
} {
  const raw = typeof ref === "string" ? ref : ref.use;
  const reset = raw.endsWith(".reset");
  const name = reset ? raw.slice(0, -".reset".length) : raw;
  return {
    name,
    reset,
    ...(typeof ref !== "string" && ref.with !== undefined
      ? { with: ref.with }
      : {}),
    write: typeof ref !== "string" && ref.write === true,
  };
}

/* ----- evidence: events, the run ledger, the project ledger ----- */

export const FixtureEventStatusSchema = z.enum([
  "ok",
  "failed",
  "skipped",
  "dry-run",
]);
export type FixtureEventStatus = z.infer<typeof FixtureEventStatusSchema>;

const RunLedgerVerbSchema = z
  .object({
    status: FixtureEventStatusSchema,
    at: z.string().min(1),
    error: z.string().optional(),
  })
  .strict();

/** One fixture this run used (`<runDir>/fixtures.json`). */
export const RunFixtureLedgerEntrySchema = z
  .object({
    name: z.string().min(1),
    adapter: FixtureAdapterSchema,
    scope: FixtureScopeSchema,
    /** When it was ensured (by this run, the invocation, or an earlier seed). */
    ensuredAt: z.string().min(1).optional(),
    /** Non-secret outputs (`${fixtures.<name>.<key>}`). */
    outputs: z.record(z.string(), z.unknown()),
    /** ok | skipped (fresh, or ensured by the invocation) | dry-run | failed. */
    status: FixtureEventStatusSchema.optional(),
    /** Why it was skipped or dry-run. */
    reason: z.string().optional(),
    reset: RunLedgerVerbSchema.optional(),
    teardown: RunLedgerVerbSchema.optional(),
  })
  .strict();
export type RunFixtureLedgerEntry = z.infer<typeof RunFixtureLedgerEntrySchema>;

export const RunFixtureLedgerSchema = z
  .object({
    version: z.literal(1),
    entries: z.array(RunFixtureLedgerEntrySchema),
  })
  .strict();
export type RunFixtureLedger = z.infer<typeof RunFixtureLedgerSchema>;

/**
 * One line of `~/.cairntrace/fixtures/<project>.ledger.jsonl`: every verb
 * that ran (or was dry-run) anywhere. `cairn fixtures status|sweep` folds
 * these into the live state per environment and fixture.
 */
export const ProjectLedgerRecordSchema = z
  .object({
    v: z.literal(1),
    ts: z.string().min(1),
    project: z.string().min(1),
    env: z.string().min(1),
    name: z.string().min(1),
    adapter: FixtureAdapterSchema,
    scope: FixtureScopeSchema,
    verb: FixtureVerbNameSchema,
    status: FixtureEventStatusSchema,
    /** Hash of the definition + parameters (a changed fixture is stale). */
    defHash: z.string().min(1),
    outputs: z.record(z.string(), z.unknown()).optional(),
    /** Parameters, redacted. */
    with: z.record(z.string(), z.unknown()).optional(),
    ttlMs: z.number().int().positive().optional(),
    /** The services seed this ensure belongs to (seed scope). */
    seed: z
      .object({ lastRunAt: z.string().min(1) })
      .strict()
      .optional(),
    origin: z.enum(["run", "invocation", "cli", "sweep"]),
    /**
     * A run-scoped fixture's instance (the run id, or the CLI's token):
     * parallel runs each own one, folded and swept separately.
     */
    instance: z.string().min(1).optional(),
    /**
     * ensure: the record was found by its natural key, not created, and
     * carries no owner.marker — no run or sweep tears it down.
     */
    adopted: z.literal(true).optional(),
    /**
     * teardown (status skipped): cairn owes no teardown any more — the
     * record was adopted, or nothing was recorded to tear it down with.
     */
    released: z.literal(true).optional(),
    runId: z.string().optional(),
    invocationId: z.string().optional(),
    pid: z.number().int().optional(),
    host: z.string().optional(),
    error: z.string().optional(),
    reason: z.string().optional(),
  })
  .strict();
export type ProjectLedgerRecord = z.infer<typeof ProjectLedgerRecordSchema>;
