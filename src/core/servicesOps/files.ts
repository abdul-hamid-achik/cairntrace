import { createHmac, randomBytes } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import type { ServiceFile } from "./schema";

/**
 * `services.files`: atomic, validated writes with before/after fingerprints.
 * Content never leaves this module; only fingerprints do.
 */

export class ServiceFileError extends Error {
  override name = "ServiceFileError";
}

export interface FileFingerprint {
  /**
   * `hmac-sha256:` + the first 16 hex chars, keyed per process: before and
   * after compare within a run, but a short secret in the content cannot be
   * guessed from the journal. Absent file → undefined.
   */
  sha: string;
  bytes: number;
}

/** A new file's mode unless the entry sets `mode`: its content may hold exports or secrets. */
const NEW_FILE_MODE = 0o600;

let fingerprintKey: Buffer | undefined;

export interface ServiceFileResult {
  /** The configured path (what the journal shows). */
  path: string;
  absolutePath: string;
  /** Existed before the write. */
  existed: boolean;
  /** The content changed (a write happened). */
  changed: boolean;
  before?: FileFingerprint;
  after: FileFingerprint;
  restart: string[];
}

export function fingerprintContent(content: string | Buffer): FileFingerprint {
  const buffer =
    typeof content === "string" ? Buffer.from(content, "utf8") : content;
  fingerprintKey ??= randomBytes(32);
  return {
    sha: `hmac-sha256:${createHmac("sha256", fingerprintKey).update(buffer).digest("hex").slice(0, 16)}`,
    bytes: buffer.byteLength,
  };
}

/**
 * Where the content goes: the path itself, or — for a symlink — the file it
 * points at (a rename onto the link would replace the link with a regular
 * file and leave its target stale). A link whose target is missing is
 * refused.
 */
async function writeTarget(
  absolutePath: string,
  where: string,
): Promise<string> {
  let link = false;
  try {
    link = (await lstat(absolutePath)).isSymbolicLink();
  } catch {
    return absolutePath;
  }
  if (!link) return absolutePath;
  try {
    return await realpath(absolutePath);
  } catch (error) {
    throw new ServiceFileError(
      `${where}: the path is a symlink whose target cannot be resolved (${(error as NodeJS.ErrnoException).code ?? (error as Error).message}); not written`,
    );
  }
}

/** The names a file value may splice (`${env.NAME}`, `${exports.NAME}`). */
interface Substitutions {
  env: Record<string, string | undefined>;
  exports: Record<string, string | undefined>;
}

/**
 * `${env.NAME}` (the invocation env) and `${exports.NAME}` (what the
 * provisioner exported) in strings; an unset or empty name is an error.
 * (`${env.X}` of a config is also substituted when the config loads, from
 * the process env: only `${exports.X}` reaches this late.)
 */
function substitute(text: string, names: Substitutions, where: string): string {
  return text.replace(
    /\$\{(env|exports)\.([A-Za-z_][A-Za-z0-9_]*)\}/g,
    (_match, space: "env" | "exports", name: string) => {
      const value = names[space][name];
      if (value === undefined || value === "") {
        throw new ServiceFileError(
          `${where}: \${${space}.${name}} is not set${
            space === "exports"
              ? " (the provisioner exports no such name)"
              : " (export it from the provisioner, or set it before the run)"
          }`,
        );
      }
      return value;
    },
  );
}

function substituteDeep(
  value: unknown,
  names: Substitutions,
  where: string,
): unknown {
  if (typeof value === "string") return substitute(value, names, where);
  if (Array.isArray(value)) {
    return value.map((item) => substituteDeep(item, names, where));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        substituteDeep(item, names, where),
      ]),
    );
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Deep merge: objects merge, everything else replaces, `null` removes a key. */
export function mergeJson(
  target: Record<string, unknown>,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete out[key];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeJson(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = isPlainObject(value) ? mergeJson({}, value) : value;
    }
  }
  return out;
}

/** The indentation of an existing JSON document (2 spaces when unknown). */
function detectIndent(text: string): string | number {
  const match = /^\{\r?\n([ \t]+)"/.exec(text);
  if (!match) return 2;
  return match[1]!.startsWith("\t") ? "\t" : match[1]!.length;
}

/**
 * Resolve, validate and write one file. JSON: the final document is built in
 * memory, re-parsed, and written (temp file + rename, mode kept; a new file is
 * 0600 unless `mode` says otherwise) only when it differs from what is on
 * disk; an existing file that is not a JSON object is never overwritten.
 * Text: written when different. A symlink is written through to its target.
 */
export async function applyServiceFile(
  file: ServiceFile,
  input: {
    configDir: string;
    env: Record<string, string | undefined>;
    /** What the provisioner exported (`${exports.NAME}`). */
    exports?: Record<string, string | undefined>;
  },
): Promise<ServiceFileResult> {
  const names: Substitutions = { env: input.env, exports: input.exports ?? {} };
  const absolutePath = isAbsolute(file.path)
    ? file.path
    : resolve(input.configDir, file.path);
  const where = `services.files ${file.path}`;
  const target = await writeTarget(absolutePath, where);
  let existing: string | undefined;
  let mode: number | undefined;
  try {
    existing = await readFile(target, "utf8");
    mode = (await stat(target)).mode & 0o777;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ServiceFileError(
        `${where}: cannot read the existing file (${(error as Error).message})`,
      );
    }
  }
  let next: string;
  let semanticallyEqual = false;
  if (file.json !== undefined) {
    let base: Record<string, unknown> = {};
    if (existing !== undefined && existing.trim() !== "") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(existing);
      } catch (error) {
        throw new ServiceFileError(
          `${where}: the existing file is not valid JSON (${(error as Error).message}); not overwritten`,
        );
      }
      if (!isPlainObject(parsed)) {
        throw new ServiceFileError(
          `${where}: the existing file is not a JSON object; not overwritten`,
        );
      }
      base = parsed;
    }
    const patch = substituteDeep(file.json, names, where) as Record<
      string,
      unknown
    >;
    const merged = mergeJson(base, patch);
    next = `${JSON.stringify(merged, null, existing ? detectIndent(existing) : 2)}\n`;
    // Validate what is about to be written.
    try {
      JSON.parse(next);
    } catch (error) {
      throw new ServiceFileError(
        `${where}: the merged document does not serialize (${(error as Error).message})`,
      );
    }
    semanticallyEqual =
      existing !== undefined &&
      JSON.stringify(sortKeys(base)) === JSON.stringify(sortKeys(merged));
  } else {
    next = substitute(file.text ?? "", names, where);
    semanticallyEqual = existing === next;
  }
  const before =
    existing === undefined ? undefined : fingerprintContent(existing);
  if (semanticallyEqual && before) {
    return {
      path: file.path,
      absolutePath,
      existed: true,
      changed: false,
      before,
      after: before,
      restart: file.restart ?? [],
    };
  }
  await mkdir(dirname(target), { recursive: true });
  const temp = `${target}.cairn-${process.pid}-${randomBytes(3).toString("hex")}.tmp`;
  // An explicit `mode` wins; an existing file keeps its mode; a new one is
  // private (it may hold an export or a secret the config spliced in).
  const finalMode =
    file.mode !== undefined
      ? Number.parseInt(file.mode, 8)
      : (mode ?? NEW_FILE_MODE);
  try {
    await writeFile(temp, next, { encoding: "utf8", mode: finalMode });
    await chmod(temp, finalMode);
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw new ServiceFileError(
      `${where}: write failed (${(error as Error).message})`,
    );
  }
  return {
    path: file.path,
    absolutePath,
    existed: existing !== undefined,
    changed: true,
    ...(before ? { before } : {}),
    after: fingerprintContent(next),
    restart: file.restart ?? [],
  };
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value)
        .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => [key, sortKeys(item)]),
    );
  }
  return value;
}
