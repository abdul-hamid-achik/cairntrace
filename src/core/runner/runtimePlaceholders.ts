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

export function resolveFixtureMap(
  input: Record<string, string> | undefined,
  artifacts: Record<string, ArtifactRef> = {},
): Record<string, string> {
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(input ?? {})) {
    output[key] = resolveArtifactPlaceholders(value, artifacts);
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
