import {
  DatasourceSchema,
  type Datasource,
  type DatasourceOverride,
  type DatasourcesConfig,
  type EnvironmentDatasources,
} from "./schema";
import { lookupVar, renderVarValue } from "../config/varValue";

/**
 * The datasources of one environment: the top-level `datasources:` with
 * `environments.<env>.datasources` merged over them. Entries are validated
 * after the merge; a broken entry is reported in `errors` and only fails the
 * verifiers that use it.
 */
export interface EnvironmentDatasourceSet {
  datasources: Record<string, Datasource>;
  /** Names disabled for this environment (`<name>: false`). */
  disabled: string[];
  /** Name → why the merged entry is unusable. */
  errors: Record<string, string>;
}

export function resolveEnvironmentDatasources(
  topLevel: DatasourcesConfig | undefined,
  overrides: EnvironmentDatasources | undefined,
): EnvironmentDatasourceSet {
  const out: EnvironmentDatasourceSet = {
    datasources: {},
    disabled: [],
    errors: {},
  };
  const names = new Set([
    ...Object.keys(topLevel ?? {}),
    ...Object.keys(overrides ?? {}),
  ]);
  for (const name of names) {
    const base = topLevel?.[name];
    const override = overrides?.[name];
    if (override === false) {
      out.disabled.push(name);
      continue;
    }
    const merged = mergeDatasource(base, override);
    const parsed = DatasourceSchema.safeParse(merged);
    if (parsed.success) {
      out.datasources[name] = parsed.data;
    } else {
      out.errors[name] = parsed.error.issues
        .map((issue) =>
          issue.path.length > 0
            ? `${issue.path.join(".")}: ${issue.message}`
            : issue.message,
        )
        .join("; ");
    }
  }
  return out;
}

function mergeDatasource(
  base: Datasource | undefined,
  override: Exclude<DatasourceOverride, false> | undefined,
): unknown {
  if (!override) return base;
  if (!base) return override;
  // A different kind replaces the entry instead of mixing two shapes.
  if (override.kind !== undefined && override.kind !== base.kind) {
    return override;
  }
  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    const previous = merged[key];
    merged[key] =
      isPlainObject(previous) && isPlainObject(value)
        ? { ...previous, ...value }
        : value;
  }
  // An environment that points at a URI talks to it directly: drop an
  // inherited docker transport unless the override names one itself.
  if (
    base.kind === "mongo" &&
    override.uri !== undefined &&
    override.docker === undefined &&
    override.transport === undefined
  ) {
    delete merged["docker"];
  }
  return merged;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Placeholder sources a datasource string may reference. */
export interface DatasourcePlaceholderScope {
  /** Run environment (process env + injected secrets). */
  env?: Record<string, string | undefined>;
  vars?: Record<string, unknown>;
}

export class DatasourcePlaceholderError extends Error {
  /** A missing secret does not appear by waiting: polling stops. */
  readonly permanent = true;
  constructor(
    readonly datasource: string,
    readonly reference: string,
  ) {
    super(
      `datasource ${datasource}: \${${reference}} is not set — export it or add it to the environment's secrets`,
    );
    this.name = "DatasourcePlaceholderError";
  }
}

/**
 * Resolve `${secrets.X}`, `${env.X}` / `${env.X:-default}` and `${vars.X}`
 * in every string of a datasource entry. An unset reference without a
 * default throws: connecting to "" (or to the default localhost) instead of
 * the intended server would be worse than failing.
 */
export function resolveDatasourcePlaceholders<T extends Datasource>(
  name: string,
  ds: T,
  scope: DatasourcePlaceholderScope,
): T {
  const env = scope.env ?? {};
  const vars = scope.vars ?? {};
  const resolveString = (text: string): string =>
    text.replace(
      /\$\{(secrets|env|vars)\.([A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z0-9_-]+)*)(?::-([^}]*))?\}/g,
      (match, ns: string, key: string, fallback: string | undefined) => {
        if (ns === "vars") {
          // F7: `${vars.name.key}` reads inside a typed var; a list or
          // object renders as compact JSON (datasource fields are strings).
          const hit = lookupVar(vars, key);
          if (!hit.found) {
            if (fallback !== undefined) return fallback;
            throw new DatasourcePlaceholderError(name, `vars.${key}`);
          }
          return renderVarValue(hit.value);
        }
        // Env and secret names never contain dots.
        if (key.includes(".")) return match;
        const value = env[key];
        if (value === undefined || value === "") {
          if (fallback !== undefined) return fallback;
          throw new DatasourcePlaceholderError(name, `${ns}.${key}`);
        }
        return value;
      },
    );
  return mapStrings(ds, resolveString) as T;
}

function mapStrings(value: unknown, fn: (s: string) => string): unknown {
  if (typeof value === "string") return fn(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, fn));
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = mapStrings(item, fn);
    }
    return out;
  }
  return value;
}

/**
 * Every literal secret-bearing value of a resolved datasource (URIs, auth
 * values, header values), for scrubbing transport errors before they reach
 * evidence.
 */
export function datasourceSecretValues(ds: Datasource): string[] {
  const values: string[] = [];
  if (ds.kind === "mongo") {
    if (ds.uri) values.push(ds.uri);
    if (ds.docker?.uri) values.push(ds.docker.uri);
  } else {
    if (ds.auth?.basic) values.push(ds.auth.basic);
    if (ds.auth?.bearer) values.push(ds.auth.bearer);
    if (ds.kind === "http") {
      for (const value of Object.values(ds.headers ?? {})) values.push(value);
    }
  }
  return values.filter((value) => value.length >= 4);
}
