import { createHash } from "node:crypto";
import {
  access,
  mkdir,
  readdir,
  readFile,
  rename,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  type CheckpointHealth,
  type CheckpointMeta,
  CheckpointMetaSchema,
  isExpired,
  urlOrigin,
} from "./meta";

export interface CheckpointInfo {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
  /** Scope metadata (`<name>.meta.json`), when the capture recorded it. */
  meta?: CheckpointMeta;
  health: CheckpointHealth;
  /**
   * A sidecar exists but no longer describes the state file (rewritten by
   * another tool since): ignored, so the checkpoint is `unscoped`.
   */
  staleMeta?: true;
}

export interface CheckpointSummary {
  name: string;
  path: string;
  sizeBytes: number;
  modifiedAt: Date;
  /** First ~400 bytes of the file as text for human inspection. */
  preview: string;
  meta?: CheckpointMeta;
  health: CheckpointHealth;
  staleMeta?: true;
}

/** Why a `session.resume` checkpoint cannot be used. */
export type CheckpointProblemCode = "missing" | "expired" | "base-url-mismatch";

export interface CheckpointResumeCheck {
  /** The value as authored in `session.resume`. */
  resume: string;
  /** Absolute state file path the backend would load. */
  path: string;
  meta?: CheckpointMeta;
  health: CheckpointHealth;
  staleMeta?: true;
  problem?: { code: CheckpointProblemCode; message: string };
}

const META_SUFFIX = ".meta.json";

/**
 * Resolves checkpoint names to filesystem paths under `~/.cairntrace/checkpoints/`.
 * Cairntrace doesn't write the checkpoint state itself — agent-browser does via
 * `state save <path>`. CheckpointStore owns the path layout, the scope
 * metadata sidecar (`<name>.meta.json`: baseUrl, env, createdAt, ttl) and the
 * read-side ops.
 */
export class CheckpointStore {
  readonly root: string;

  constructor(root?: string) {
    this.root = root ?? join(homedir(), ".cairntrace", "checkpoints");
  }

  /** Absolute path where the checkpoint with `name` should live. */
  pathFor(name: string): string {
    if (!/^[a-z][a-z0-9-_]*$/i.test(name)) {
      throw new Error(
        `invalid checkpoint name "${name}" — use letters, digits, hyphen, underscore (must start with a letter)`,
      );
    }
    return join(this.root, `${name}.json`);
  }

  /** The metadata sidecar of a state file: `x.json` → `x.meta.json`. */
  metaPathFor(statePath: string): string {
    return `${statePath.replace(/\.json$/i, "")}${META_SUFFIX}`;
  }

  /**
   * Resolve a `spec.session.resume:` value to a path.
   * If the value contains a path separator or is already absolute, pass through.
   * Otherwise treat it as a name and look it up in the store.
   */
  resolveResume(value: string): string {
    if (isAbsolute(value)) return value;
    if (value.includes("/")) return value;
    return this.pathFor(value);
  }

  async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true });
  }

  async exists(name: string): Promise<boolean> {
    try {
      await access(this.pathFor(name));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a state file's scope metadata. Undefined when absent, invalid, or
   * stale (not bound to the state file's current content).
   */
  async readMeta(statePath: string): Promise<CheckpointMeta | undefined> {
    return (await this.readBoundMeta(statePath)).meta;
  }

  /**
   * The sidecar of `statePath`, checked against the state file's sha256:
   * `meta` when it describes the current state, `stale` when a sidecar
   * exists but the state was rewritten without it (or it predates binding).
   */
  private async readBoundMeta(
    statePath: string,
  ): Promise<{ meta?: CheckpointMeta; stale?: true }> {
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(this.metaPathFor(statePath), "utf8"));
    } catch {
      return {};
    }
    const parsed = CheckpointMetaSchema.safeParse(raw);
    if (!parsed.success) return {};
    const digest = await sha256File(statePath);
    if (
      digest === undefined ||
      parsed.data.stateSha256 === undefined ||
      parsed.data.stateSha256 !== digest
    ) {
      return { stale: true };
    }
    return { meta: parsed.data };
  }

  /**
   * Write (atomically) the scope metadata next to a state file, bound to
   * the state file's current sha256 (`stateSha256`). Call it after the
   * state is saved; a state file that does not exist is an error.
   */
  async writeMeta(statePath: string, meta: CheckpointMeta): Promise<string> {
    const digest = await sha256File(statePath);
    if (digest === undefined) {
      throw new Error(
        `cannot scope checkpoint: state file ${statePath} is not readable`,
      );
    }
    const metaPath = this.metaPathFor(statePath);
    const tmp = `${metaPath}.${process.pid}.tmp`;
    await writeFile(
      tmp,
      `${JSON.stringify(
        CheckpointMetaSchema.parse({ ...meta, stateSha256: digest }),
        null,
        2,
      )}\n`,
      { mode: 0o600 },
    );
    await rename(tmp, metaPath);
    return metaPath;
  }

  async list(now: Date = new Date()): Promise<CheckpointInfo[]> {
    try {
      const entries = await readdir(this.root);
      const checkpoints: CheckpointInfo[] = [];
      for (const entry of entries) {
        if (!entry.endsWith(".json") || entry.endsWith(META_SUFFIX)) continue;
        const name = entry.slice(0, -".json".length);
        const path = join(this.root, entry);
        const s = await stat(path);
        const { meta, stale } = await this.readBoundMeta(path);
        checkpoints.push({
          name,
          path,
          sizeBytes: s.size,
          modifiedAt: s.mtime,
          ...(meta ? { meta } : {}),
          health: healthOf(meta, true, now),
          ...(stale ? { staleMeta: true as const } : {}),
        });
      }
      return checkpoints.toSorted(
        (a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime(),
      );
    } catch {
      return [];
    }
  }

  async show(
    name: string,
    now: Date = new Date(),
  ): Promise<CheckpointSummary | undefined> {
    const path = this.pathFor(name);
    let s;
    try {
      s = await stat(path);
    } catch {
      return undefined;
    }
    const preview = await readFile(path, "utf8")
      .then((t) => t.slice(0, 400))
      .catch(() => "");
    const { meta, stale } = await this.readBoundMeta(path);
    return {
      name,
      path,
      sizeBytes: s.size,
      modifiedAt: s.mtime,
      preview,
      ...(meta ? { meta } : {}),
      health: healthOf(meta, true, now),
      ...(stale ? { staleMeta: true as const } : {}),
    };
  }

  async delete(name: string): Promise<boolean> {
    const path = this.pathFor(name);
    try {
      await unlink(path);
      await unlink(this.metaPathFor(path)).catch(() => undefined);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * May `session.resume: <value>` be restored for a run whose environment
   * resolves to `baseUrl`? Refuses a missing state file, an expired
   * checkpoint, and one captured for another origin. A checkpoint without
   * usable metadata (captured before scoping, by another tool, or rewritten
   * since its sidecar was written) is `unscoped` and allowed. Relative path
   * values resolve against `cwd` (what the backend loads).
   */
  async checkResume(
    value: string,
    opts: { baseUrl?: string; now?: Date; cwd?: string } = {},
  ): Promise<CheckpointResumeCheck> {
    const now = opts.now ?? new Date();
    let path: string;
    try {
      path = resolve(opts.cwd ?? process.cwd(), this.resolveResume(value));
    } catch (e) {
      return {
        resume: value,
        path: value,
        health: "missing",
        problem: { code: "missing", message: (e as Error).message },
      };
    }
    const exists = await stat(path)
      .then((s) => s.isFile())
      .catch(() => false);
    const { meta, stale } = exists ? await this.readBoundMeta(path) : {};
    const base = {
      resume: value,
      path,
      ...(meta ? { meta } : {}),
      health: healthOf(meta, exists, now),
      ...(stale ? { staleMeta: true as const } : {}),
    };
    if (!exists) {
      return {
        ...base,
        problem: {
          code: "missing",
          message: `checkpoint "${value}" does not exist (${path}); capture it with \`cairn login ${checkpointName(value)} --url <login-url>\``,
        },
      };
    }
    if (meta && isExpired(meta, now)) {
      return {
        ...base,
        problem: {
          code: "expired",
          message: `checkpoint "${value}" expired at ${meta.expiresAt} (ttl ${meta.ttl ?? "?"}, captured ${meta.createdAt}); recapture it`,
        },
      };
    }
    const captured = urlOrigin(meta?.baseUrl);
    const target = urlOrigin(opts.baseUrl);
    if (captured && target && captured !== target) {
      return {
        ...base,
        problem: {
          code: "base-url-mismatch",
          message: `checkpoint "${value}" was captured for ${captured}${
            meta?.env ? ` (env "${meta.env}")` : ""
          } but this run targets ${target}; capture one for this environment`,
        },
      };
    }
    return base;
  }
}

function healthOf(
  meta: CheckpointMeta | undefined,
  exists: boolean,
  now: Date,
): CheckpointHealth {
  if (!exists) return "missing";
  if (!meta) return "unscoped";
  return isExpired(meta, now) ? "expired" : "ok";
}

/** Hex sha256 of a file's bytes; undefined when it cannot be read. */
async function sha256File(path: string): Promise<string | undefined> {
  try {
    return createHash("sha256")
      .update(await readFile(path))
      .digest("hex");
  } catch {
    return undefined;
  }
}

/** A name for hints: the value itself, or `<name>` for a path. */
function checkpointName(value: string): string {
  return /^[a-z][a-z0-9-_]*$/i.test(value) ? value : "<name>";
}
