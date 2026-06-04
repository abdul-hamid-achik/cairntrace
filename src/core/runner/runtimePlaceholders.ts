import { isAbsolute, resolve } from "node:path";
import type { ArtifactRef } from "../../adapters/browserBackend";

export function resolveArtifactPlaceholders(
  input: string,
  artifacts: Record<string, ArtifactRef> = {},
): string {
  return input
    .replace(
      /\$\{artifacts\.([a-z][A-Za-z0-9_]*)\.path\}/g,
      (_match, name: string) => artifacts[name]?.path ?? "",
    )
    .replace(
      /\$\{artifacts\.([a-z][A-Za-z0-9_]*)\.relativePath\}/g,
      (_match, name: string) => artifacts[name]?.relativePath ?? "",
    );
}

/**
 * Splice captured `request` step responses into a string:
 *   ${requests.qr.status}        → "200"
 *   ${requests.qr.body.token}    → the token string
 *   ${requests.qr.body.items.0}  → first array element
 * Objects/arrays render as JSON; unknown names/paths render as "".
 */
export function resolveResponsePlaceholders(
  input: string,
  responses: Record<string, unknown> = {},
): string {
  return input.replace(
    /\$\{requests\.([a-z][A-Za-z0-9_]*)((?:\.[A-Za-z0-9_]+)*)\}/g,
    (_match, name: string, pathStr: string) => {
      let value: unknown = responses[name];
      if (value === undefined) return "";
      const path = pathStr ? pathStr.slice(1).split(".") : [];
      for (const key of path) {
        if (value !== null && typeof value === "object" && key in value) {
          value = (value as Record<string, unknown>)[key];
        } else {
          return "";
        }
      }
      if (value === undefined || value === null) return "";
      return typeof value === "object" ? JSON.stringify(value) : String(value);
    },
  );
}

/** Apply `fn` to every string anywhere inside a JSON-ish value. */
export function deepMapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === "string") return fn(value) as unknown as T;
  if (Array.isArray(value)) {
    return value.map((v) => deepMapStrings(v, fn)) as unknown as T;
  }
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = deepMapStrings(v, fn);
    }
    return out as unknown as T;
  }
  return value;
}

export function resolveFixtureMap(
  input: Record<string, string> | undefined,
  artifacts: Record<string, ArtifactRef> = {},
  responses: Record<string, unknown> = {},
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    output[key] = resolveResponsePlaceholders(
      resolveArtifactPlaceholders(value, artifacts),
      responses,
    );
  }
  return output;
}

export function resolveRuntimeFilePath(
  input: string,
  opts: {
    artifacts?: Record<string, ArtifactRef>;
    runDir?: string;
    specDir?: string;
  },
): string {
  const usedArtifactPlaceholder =
    /\$\{artifacts\.[a-z][A-Za-z0-9_]*\.(?:path|relativePath)\}/.test(input);
  const resolved = resolveArtifactPlaceholders(input, opts.artifacts);
  if (isAbsolute(resolved)) return resolved;
  if (usedArtifactPlaceholder && opts.runDir)
    return resolve(opts.runDir, resolved);
  if (opts.specDir) return resolve(opts.specDir, resolved);
  return resolved;
}
