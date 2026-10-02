import { z } from "zod";

/**
 * Config `datasources:` (plan F4): named connections the typed `mongo`,
 * `temporal` and `http` verifiers (and the fixtures registry) read through,
 * so specs stop hand-rolling `docker exec … mongosh` and Temporal fetch glue.
 *
 * Strings may carry `${secrets.X}` / `${env.X}` / `${vars.X}`; they are
 * resolved against the run environment when a verifier opens the source,
 * never written to artifacts (connection strings and credentials are always
 * redacted in evidence).
 *
 * `environments.<name>.datasources` overrides entries per environment: a
 * partial entry is merged field-by-field over the top-level entry of the same
 * name, `false` disables it there, and an entry that exists only in the
 * environment must be complete.
 */

const MongoDockerSchema = z
  .object({
    /** docker compose service label (`com.docker.compose.service`); preferred. */
    service: z.string().min(1).optional(),
    /** Container name or id, when there is no compose label to resolve. */
    container: z.string().min(1).optional(),
    /** compose project label, to pick between stacks running the same service. */
    project: z.string().min(1).optional(),
    /** URI mongosh uses INSIDE the container (default mongodb://127.0.0.1:27017). */
    uri: z.string().min(1).optional(),
  })
  .strict();

const MongoGuardSchema = z
  .object({
    /** The only databases this source may touch. */
    databases: z.array(z.string().min(1)).nonempty().optional(),
    /** The only hosts a `uri` may point at (every host of a seed list). */
    hosts: z.array(z.string().min(1)).nonempty().optional(),
  })
  .strict();

const HttpAuthSchema = z
  .object({
    /** `user:password` (usually `${secrets.X}`); sent as HTTP Basic. */
    basic: z.string().min(1).optional(),
    /** Token sent as `Authorization: Bearer …`. */
    bearer: z.string().min(1).optional(),
  })
  .strict();

const mongoShape = {
  kind: z.literal("mongo"),
  /** Connection string; may be `${secrets.MONGO_URI}`. */
  uri: z.string().min(1).optional(),
  /** Reach mongod through `docker exec <container> mongosh`. */
  docker: MongoDockerSchema.optional(),
  database: z.string().min(1),
  guard: MongoGuardSchema.optional(),
  /** `read-only` refuses every write (fixtures included). Default read-write. */
  mode: z.enum(["read-write", "read-only"]).optional(),
  /**
   * Force a transport. Default: `uri` → the optional `mongodb` driver when
   * installed, else `mongosh <uri>`; no `uri` → `docker`.
   */
  transport: z.enum(["driver", "mongosh", "docker"]).optional(),
};

const temporalShape = {
  kind: z.literal("temporal"),
  /** Temporal UI / HTTP API base (e.g. http://localhost:8080). */
  api: z.string().min(1),
  namespace: z.string().min(1),
  auth: HttpAuthSchema.optional(),
};

const httpShape = {
  kind: z.literal("http"),
  baseUrl: z.string().min(1),
  headers: z.record(z.string(), z.string()).optional(),
  auth: HttpAuthSchema.optional(),
};

export const MongoDatasourceSchema = z.object(mongoShape).strict();
export const TemporalDatasourceSchema = z.object(temporalShape).strict();
export const HttpDatasourceSchema = z.object(httpShape).strict();

export const DatasourceSchema = z
  .discriminatedUnion("kind", [
    MongoDatasourceSchema,
    TemporalDatasourceSchema,
    HttpDatasourceSchema,
  ])
  .superRefine((ds, ctx) => {
    for (const problem of datasourceProblems(ds)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: problem.path,
        message: problem.message,
      });
    }
  });
export type Datasource = z.infer<typeof DatasourceSchema>;
export type MongoDatasource = z.infer<typeof MongoDatasourceSchema>;
export type TemporalDatasource = z.infer<typeof TemporalDatasourceSchema>;
export type HttpDatasource = z.infer<typeof HttpDatasourceSchema>;
export type DatasourceKind = Datasource["kind"];

const DATASOURCE_NAME = /^[a-z][A-Za-z0-9_-]*$/;
const DatasourceNameSchema = z
  .string()
  .regex(
    DATASOURCE_NAME,
    "datasource names start with a lowercase letter (letters, digits, _ or -)",
  );

/** Top-level `datasources:` block. */
export const DatasourcesConfigSchema = z.record(
  DatasourceNameSchema,
  DatasourceSchema,
);
export type DatasourcesConfig = z.infer<typeof DatasourcesConfigSchema>;

/**
 * One `environments.<name>.datasources` entry: `false` (disabled here) or a
 * partial entry merged over the top-level one. Validated as a whole datasource
 * after the merge (see resolveDatasources).
 */
export const DatasourceOverrideSchema = z.union([
  z.literal(false),
  z
    .object({
      kind: z.enum(["mongo", "temporal", "http"]).optional(),
      uri: mongoShape.uri,
      docker: mongoShape.docker,
      database: mongoShape.database.optional(),
      guard: mongoShape.guard,
      mode: mongoShape.mode,
      transport: mongoShape.transport,
      api: temporalShape.api.optional(),
      namespace: temporalShape.namespace.optional(),
      auth: HttpAuthSchema.optional(),
      baseUrl: httpShape.baseUrl.optional(),
      headers: httpShape.headers,
    })
    .strict(),
]);
export type DatasourceOverride = z.infer<typeof DatasourceOverrideSchema>;

export const EnvironmentDatasourcesSchema = z.record(
  DatasourceNameSchema,
  DatasourceOverrideSchema,
);
export type EnvironmentDatasources = z.infer<
  typeof EnvironmentDatasourcesSchema
>;

/** Cross-field rules shared by the schema and the post-merge validation. */
function datasourceProblems(
  ds: Datasource,
): Array<{ path: string[]; message: string }> {
  const problems: Array<{ path: string[]; message: string }> = [];
  if (ds.kind === "mongo") {
    if (ds.uri === undefined && ds.docker === undefined) {
      problems.push({
        path: ["uri"],
        message: "a mongo datasource needs uri or docker",
      });
    }
    if (
      ds.docker !== undefined &&
      (ds.docker.service === undefined) === (ds.docker.container === undefined)
    ) {
      problems.push({
        path: ["docker"],
        message: "docker needs exactly one of: service, container",
      });
    }
    if (ds.transport === "docker" && ds.docker === undefined) {
      problems.push({
        path: ["transport"],
        message: "transport docker needs a docker block",
      });
    }
    if (
      (ds.transport === "driver" || ds.transport === "mongosh") &&
      ds.uri === undefined
    ) {
      problems.push({
        path: ["transport"],
        message: `transport ${ds.transport} needs uri`,
      });
    }
    if (
      ds.guard?.databases !== undefined &&
      !ds.guard.databases.includes(ds.database)
    ) {
      problems.push({
        path: ["guard", "databases"],
        message: `database "${ds.database}" is not in guard.databases`,
      });
    }
  }
  if (ds.kind !== "mongo" && "auth" in ds && ds.auth) {
    if (ds.auth.basic !== undefined && ds.auth.bearer !== undefined) {
      problems.push({
        path: ["auth"],
        message: "auth takes one of: basic, bearer",
      });
    }
  }
  return problems;
}
