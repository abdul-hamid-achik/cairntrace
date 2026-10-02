import {
  datasourceHeaders,
  httpCall,
  httpDatasourceSecrets,
  isAbsoluteUrl,
  joinBaseUrl,
  urlOrigin,
  type HttpReply,
} from "./http";
import {
  DatasourceError,
  openMongoSource,
  type MongoDriverModule,
  type MongoSource,
} from "./mongo";
import { displayUrl } from "./redact";
import {
  resolveDatasourcePlaceholders,
  type EnvironmentDatasourceSet,
} from "./resolve";
import type { Datasource, DatasourceKind } from "./schema";
import { openTemporalSource, type TemporalSource } from "./temporal";

export type {
  MongoFindRequest,
  MongoSourceDescriptor,
  MongoWriteRequest,
} from "./mongo";
export type { HttpReply } from "./http";
export type { EnvironmentDatasourceSet } from "./resolve";
export { ejsonToPlain } from "./ejson";

export interface HttpSourceDescriptor {
  name: string;
  kind: "http";
  baseUrl: string;
}

export interface HttpSource {
  readonly descriptor: HttpSourceDescriptor;
  /** Literal secret values to scrub from evidence (auth, header values). */
  readonly secrets: readonly string[];
  call(
    req: {
      path: string;
      method?: string;
      headers?: Record<string, string>;
      body?: unknown;
    },
    opts: { deadline: number; signal?: AbortSignal },
  ): Promise<HttpReply>;
}

export interface DatasourceSessionOptions {
  /** Run environment: `${secrets.X}` / `${env.X}` and CLI binaries. */
  env?: Record<string, string | undefined>;
  vars?: Record<string, string | number | boolean>;
  /** Test seam: the optional `mongodb` driver. */
  loadMongoDriver?: () => Promise<MongoDriverModule | undefined>;
  /**
   * Where the optional `mongodb` package is resolved from first (spec /
   * config directory); the working directory is always tried next.
   */
  projectDirs?: readonly string[];
  /** Environment name, for error messages. */
  envName?: string;
}

/**
 * Opens configured datasources by name for one verifier evaluation (or one
 * fixture verb). Sources are opened lazily and cached; `close()` releases
 * driver connections.
 */
export interface DatasourceSession {
  mongo(name: string): Promise<MongoSource>;
  temporal(name: string): TemporalSource;
  http(name: string): HttpSource;
  close(): Promise<void>;
}

export function createDatasourceSession(
  set: EnvironmentDatasourceSet | undefined,
  opts: DatasourceSessionOptions = {},
): DatasourceSession {
  const mongoSources = new Map<string, Promise<MongoSource>>();
  const lookup = <K extends DatasourceKind>(
    name: string,
    kind: K,
  ): Extract<Datasource, { kind: K }> => {
    const where = opts.envName ? ` for environment "${opts.envName}"` : "";
    if (set?.errors[name] !== undefined) {
      throw new DatasourceError(
        `datasource ${name} is invalid${where}: ${set.errors[name]}`,
        { permanent: true },
      );
    }
    if (set?.disabled.includes(name)) {
      throw new DatasourceError(`datasource ${name} is disabled${where}`, {
        permanent: true,
      });
    }
    const ds = set?.datasources[name];
    if (!ds) {
      const known = Object.keys(set?.datasources ?? {});
      throw new DatasourceError(
        `unknown datasource "${name}"${where}; config datasources: ${
          known.length > 0 ? known.join(", ") : "(none)"
        }`,
        { permanent: true },
      );
    }
    if (ds.kind !== kind) {
      throw new DatasourceError(
        `datasource ${name} is kind ${ds.kind}; this needs kind ${kind}`,
        { permanent: true },
      );
    }
    return resolveDatasourcePlaceholders(name, ds, {
      ...(opts.env ? { env: opts.env } : {}),
      ...(opts.vars ? { vars: opts.vars } : {}),
    }) as Extract<Datasource, { kind: K }>;
  };

  return {
    mongo(name) {
      let source = mongoSources.get(name);
      if (!source) {
        source = Promise.resolve().then(() =>
          openMongoSource(name, lookup(name, "mongo"), {
            ...(opts.env ? { env: opts.env } : {}),
            ...(opts.loadMongoDriver
              ? { loadDriver: opts.loadMongoDriver }
              : {}),
            ...(opts.projectDirs ? { driverSearchDirs: opts.projectDirs } : {}),
          }),
        );
        mongoSources.set(name, source);
        source.catch(() => mongoSources.delete(name));
      }
      return source;
    },
    temporal(name) {
      return openTemporalSource(name, lookup(name, "temporal"));
    },
    http(name) {
      const ds = lookup(name, "http");
      const secrets = httpDatasourceSecrets(ds);
      const headers = datasourceHeaders(ds);
      return {
        descriptor: { name, kind: "http", baseUrl: displayUrl(ds.baseUrl) },
        secrets,
        async call(req, callOpts) {
          // Datasource credentials only ever go to the datasource's origin:
          // an absolute URL (written or spliced from ${captures.*}) must
          // stay on baseUrl's origin.
          if (isAbsoluteUrl(req.path)) {
            const origin = urlOrigin(ds.baseUrl);
            if (origin === undefined || urlOrigin(req.path) !== origin) {
              throw new DatasourceError(
                `datasource ${name}: refused a call to ${
                  urlOrigin(req.path) ?? "an unparseable URL"
                } — an absolute URL must stay on baseUrl's origin ${
                  origin ? displayUrl(origin) : "(unparseable baseUrl)"
                }; use a path relative to baseUrl, or drop source: to call another host without the datasource's credentials`,
                { permanent: true },
              );
            }
          }
          return httpCall(
            {
              url: joinBaseUrl(ds.baseUrl, req.path),
              ...(req.method ? { method: req.method } : {}),
              headers: { ...headers, ...req.headers },
              ...(req.body !== undefined ? { body: req.body } : {}),
              deadline: callOpts.deadline,
              ...(callOpts.signal ? { signal: callOpts.signal } : {}),
            },
            secrets,
          );
        },
      };
    },
    async close() {
      const sources = [...mongoSources.values()];
      mongoSources.clear();
      for (const source of sources) {
        await source.then((s) => s.close()).catch(() => undefined);
      }
    },
  };
}
