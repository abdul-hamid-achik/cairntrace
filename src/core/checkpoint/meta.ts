import { z } from "zod";

/**
 * Checkpoint scope metadata (A10): `<name>.meta.json` next to the browser
 * state file `<name>.json` that agent-browser / Playwright write. The state
 * file stays exactly what the backend loads; cairn keeps where and when it
 * was captured beside it so a resume can refuse a checkpoint captured for
 * another origin or one that expired.
 *
 * The sidecar is bound to the state it describes by `stateSha256`. Anything
 * that rewrites the state file without rewriting the sidecar (`agent-browser
 * state save`, a precondition that mints a fresh state) leaves a sidecar that
 * no longer matches: it is stale and ignored, and the checkpoint reads as
 * `unscoped`. `cairn login`, `checkpoint capture-from-session` and MCP
 * `cairn_checkpoint_capture` write a fresh, bound sidecar.
 *
 * Never holds cookies, storage or credentials — only the scope.
 */
export const CheckpointMetaSchema = z
  .object({
    version: z.literal(1),
    /** Checkpoint name (absent for path-style checkpoints). */
    name: z.string().min(1).optional(),
    /** Base URL the state belongs to (the environment baseUrl, else the origin of the page the session ended on). */
    baseUrl: z.string().min(1).optional(),
    /** Environment the checkpoint was captured for. */
    env: z.string().min(1).optional(),
    createdAt: z.string().datetime({ offset: true }),
    /** Authored lifetime, e.g. `12h`, `7d`. */
    ttl: z.string().min(1).optional(),
    /** createdAt + ttl. Absent = never expires. */
    expiresAt: z.string().datetime({ offset: true }).optional(),
    /**
     * Which command wrote it: `cairn login`, `cairn checkpoint
     * capture-from-session`, or MCP `cairn_checkpoint_capture` (discovery).
     */
    capturedBy: z
      .enum(["login", "capture-from-session", "discovery"])
      .optional(),
    /**
     * sha256 (hex) of the state file this metadata describes, stamped by
     * `CheckpointStore.writeMeta`. Absent or different from the state file
     * on disk = stale metadata, ignored.
     */
    stateSha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/)
      .optional(),
  })
  .strict();
export type CheckpointMeta = z.infer<typeof CheckpointMetaSchema>;

/** Health of a checkpoint as `cairn checkpoint list` and resume see it. */
export type CheckpointHealth =
  /** Scoped and not expired. */
  | "ok"
  /** Past `expiresAt`. */
  | "expired"
  /**
   * No usable metadata: captured before scoping or by another tool, or the
   * sidecar is stale (the state file was rewritten after it).
   */
  | "unscoped"
  /** The state file does not exist. */
  | "missing";

const UNIT_MS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
};

/**
 * Parse a checkpoint TTL: a positive integer and a unit — `s`, `m`, `h`,
 * `d` or `w` (`30m`, `12h`, `7d`). Throws a message naming the format.
 */
export function parseTtlMs(ttl: string): number {
  const match = /^\s*(\d+)\s*([smhdw])\s*$/i.exec(ttl);
  const value = match ? Number(match[1]) : Number.NaN;
  const unit = match?.[2]?.toLowerCase();
  if (!match || !unit || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `invalid ttl "${ttl}": use a positive number and a unit s|m|h|d|w (e.g. 30m, 12h, 7d)`,
    );
  }
  return value * UNIT_MS[unit]!;
}

/** Build the metadata a capture records. `ttl` is validated here. */
export function buildCheckpointMeta(input: {
  name?: string;
  baseUrl?: string;
  env?: string;
  ttl?: string;
  capturedBy?: CheckpointMeta["capturedBy"];
  now?: Date;
}): CheckpointMeta {
  const now = input.now ?? new Date();
  const ttlMs = input.ttl !== undefined ? parseTtlMs(input.ttl) : undefined;
  return {
    version: 1,
    ...(input.name ? { name: input.name } : {}),
    ...(input.baseUrl ? { baseUrl: input.baseUrl } : {}),
    ...(input.env ? { env: input.env } : {}),
    createdAt: now.toISOString(),
    ...(input.ttl !== undefined && ttlMs !== undefined
      ? {
          ttl: input.ttl.trim(),
          expiresAt: new Date(now.getTime() + ttlMs).toISOString(),
        }
      : {}),
    ...(input.capturedBy ? { capturedBy: input.capturedBy } : {}),
  };
}

/** `scheme://host[:port]` of a URL, or undefined when it does not parse. */
export function urlOrigin(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    const origin = new URL(url).origin;
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
}

/** True when the metadata says the checkpoint expired at `now`. */
export function isExpired(
  meta: CheckpointMeta,
  now: Date = new Date(),
): boolean {
  return (
    meta.expiresAt !== undefined && Date.parse(meta.expiresAt) <= now.getTime()
  );
}
