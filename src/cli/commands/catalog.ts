import {
  buildCatalog,
  CatalogConfigError,
  type CatalogOptions,
} from "../../core/catalog/buildCatalog";
import { CATALOG_KINDS, type CatalogKind } from "../../core/catalog/catalog.v1";
import { renderCatalogMarkdown } from "../../core/catalog/markdown";
import { emit, resolveFormat } from "../format";

export interface CatalogCommandOptions {
  config?: string;
  env?: string;
  query?: string;
  /** Repeatable and/or comma-separated kinds. */
  kind?: string[];
  limit?: string;
  artifactRoot?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * Parse `--kind` values (repeatable, comma-separated). Throws on an unknown
 * kind; undefined when none were given (= every kind).
 */
export function parseCatalogKinds(
  values: readonly string[] | undefined,
): CatalogKind[] | undefined {
  const kinds = (values ?? [])
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  if (kinds.length === 0) return undefined;
  for (const kind of kinds) {
    if (!(CATALOG_KINDS as readonly string[]).includes(kind)) {
      throw new Error(
        `unknown --kind "${kind}" (expected ${CATALOG_KINDS.join(" | ")})`,
      );
    }
  }
  return [...new Set(kinds)] as CatalogKind[];
}

/**
 * `cairn catalog [--config] [--env] [--query] [--kind] [--limit N]`: what
 * the project already has — reusable actions, config vars per environment,
 * script verifiers and their fixture contracts, environments, flows and
 * checkpoints — so an agent reuses them instead of re-recording literals.
 * Exit 0 on success, 2 on a usage error, 4 on a config error.
 */
export async function catalogCommand(
  opts: CatalogCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let kinds: CatalogKind[] | undefined;
  let limit: number | undefined;
  try {
    kinds = parseCatalogKinds(opts.kind);
    if (opts.limit !== undefined) {
      limit = Number(opts.limit);
      if (!Number.isInteger(limit) || limit < 1) {
        throw new Error("--limit must be a positive integer");
      }
    }
  } catch (e) {
    process.stderr.write(`cairn catalog: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  const options: CatalogOptions = {
    ...(opts.config ? { config: opts.config } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    ...(opts.query?.trim() ? { query: opts.query.trim() } : {}),
    ...(kinds ? { kinds } : {}),
    ...(limit !== undefined ? { limit } : {}),
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
  };
  let catalog;
  try {
    catalog = await buildCatalog(options);
  } catch (e) {
    process.stderr.write(`cairn catalog: ${(e as Error).message}\n`);
    process.exitCode = e instanceof CatalogConfigError ? 4 : 2;
    return;
  }
  process.stdout.write(emit(format, catalog, renderCatalogMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}
