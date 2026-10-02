import { isAbsolute, relative, resolve, sep } from "node:path";
import {
  AuthoringConfigSchema,
  DEFAULT_DRAFTS_DIR,
  type AuthoringConfig,
} from "../schema/config.v1";

/**
 * The config `authoring:` block when present and valid, else `{}`. Read
 * leniently so authoring helpers never fail on a config another build wrote.
 */
export function authoringConfigOf(config: unknown): AuthoringConfig {
  const block =
    config && typeof config === "object"
      ? (config as Record<string, unknown>)["authoring"]
      : undefined;
  const parsed = AuthoringConfigSchema.safeParse(block ?? {});
  return parsed.success ? parsed.data : {};
}

/** Absolute drafts directory: `authoring.draftsDir` (default `flows/_drafts`) under the config dir. */
export function draftsDirFor(configDir: string, config: unknown): string {
  const dir = authoringConfigOf(config).draftsDir ?? DEFAULT_DRAFTS_DIR;
  return isAbsolute(dir) ? dir : resolve(configDir, dir);
}

/** True when `path` is `dir` itself or lies below it. */
export function isInside(path: string, dir: string): boolean {
  const rel = relative(resolve(dir), resolve(path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * True when a spec is a draft: inside the drafts dir, or any file or folder
 * on its path below `root` starts with `_` (what `cairn run <dir>` skips).
 */
export function isDraftSpec(
  path: string,
  opts: { draftsDir: string; root: string },
): boolean {
  if (isInside(path, opts.draftsDir)) return true;
  const rel = relative(resolve(opts.root), resolve(path));
  if (rel.startsWith("..") || isAbsolute(rel)) return false;
  return rel.split(sep).some((segment) => segment.startsWith("_"));
}

/** A path relative to `base` with `/` separators (`.` for `base` itself). */
export function relativePosix(base: string, path: string): string {
  return relative(base, path).split(sep).join("/") || ".";
}
