import { z } from "zod";
import { DiscoveryConfigSchema, type DiscoveryConfig } from "./config.v1";
import {
  EvalStepSchema,
  LocatorSchema,
  RequestStepSchema,
  WaitConditionSchema,
} from "./spec.v1";

/**
 * Discovery session schemas (v1).
 *
 * Discovery lets an agent explore a live page through the harness — navigate,
 * interact, snapshot — while recording each interaction as a spec-compatible
 * step. The agent then exports the recorded steps as a spec YAML. Every
 * session keeps a journal on disk (`<artifactRoot>/_sessions/<id>/`, see
 * {@link SessionJournalSchema}) that outlives its browser.
 */

/* ----- action enum (shared by stepRecorder + DiscoverySession) ----- */

export const DiscoveryActionSchema = z.enum([
  "click",
  "fill",
  "hover",
  "type",
  "select",
  "upload",
  "scroll",
  "press",
  "focus",
  "eval",
  "wait",
  "request",
  "assert",
]);
export type DiscoveryAction = z.infer<typeof DiscoveryActionSchema>;

/* ----- interact payloads (validated with the spec step schemas) ----- */

/** `eval` interaction: the spec `eval` step body (`js` | `file`, args, assign). */
export const DiscoveryEvalInputSchema = EvalStepSchema.shape.eval;
/** `request` interaction: the spec `request` step body. */
export const DiscoveryRequestInputSchema = RequestStepSchema.shape.request;
/** `wait` interaction: any spec wait condition. */
export const DiscoveryWaitInputSchema = WaitConditionSchema;
/**
 * `assert` interaction: a wait condition that must already hold (or hold
 * within `timeoutMs`). Recorded as a `wait` step so the spec replays it.
 */
export const DiscoveryAssertInputSchema = WaitConditionSchema;

/* ----- context economy ----- */

export const SnapshotModeSchema = z.enum(["none", "diff", "compact", "full"]);
export type SnapshotMode = z.infer<typeof SnapshotModeSchema>;
/** Default byte budget of the snapshot returned to the caller. */
export const DEFAULT_SNAPSHOT_MAX_BYTES = 16_384;

/** What a tool answered about the snapshot it captured. */
export interface SnapshotInfo {
  mode: SnapshotMode;
  /** Full snapshot text in the session journal (relative to its dir). */
  path?: string;
  /** Bytes of the full snapshot text. */
  bytes: number;
  /** Elements on the page. */
  elements: number;
  /** Elements returned in `snapshot`. */
  returned: number;
  /** `snapshot` was cut to `maxBytes`. */
  truncated: boolean;
  /** diff: elements unchanged since the previous snapshot. */
  unchanged?: number;
  /** diff: elements gone since the previous snapshot. */
  removed?: Array<{ key: string; role: string; name?: string }>;
}

/* ----- setup before exploring ----- */

const VarValueSchema = z.union([z.string(), z.number(), z.boolean()]);

/** `{ use: <action>, vars? }` — run an imported reusable action. */
export const DiscoverySetupUseSchema = z
  .object({
    use: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/, "use: an action name (snake_case)"),
    vars: z.record(z.string(), VarValueSchema).optional(),
  })
  .strict();
export type DiscoverySetupUse = z.infer<typeof DiscoverySetupUseSchema>;

/** `{ fromSpec, untilStep }` — replay a spec's steps through `untilStep`. */
export const DiscoverySetupFromSpecSchema = z
  .object({
    fromSpec: z.string().min(1),
    /** A spec-level step `id`, or its 1-based position. */
    untilStep: z.union([z.string().min(1), z.number().int().positive()]),
  })
  .strict();
export type DiscoverySetupFromSpec = z.infer<
  typeof DiscoverySetupFromSpecSchema
>;

export const DiscoverySetupSchema = z.union([
  z.array(DiscoverySetupUseSchema).min(1),
  DiscoverySetupFromSpecSchema,
]);
export type DiscoverySetup = z.infer<typeof DiscoverySetupSchema>;

/** Default idle TTL of a discovery session's browser. */
export const DEFAULT_DISCOVERY_SESSION_TTL_MS = 30 * 60 * 1000;
/** Session journals kept by retention (plus open and draft-referenced ones). */
export const DEFAULT_KEEP_SESSIONS = 50;

/**
 * The config `discovery:` block (`ConfigSchema.discovery`) when present and
 * valid, else `{}`. Lenient so a caller holding an unvalidated config object
 * never throws here; the loader and `cairn config validate` report errors.
 */
export function discoveryConfigOf(config: unknown): DiscoveryConfig {
  const block =
    config && typeof config === "object"
      ? (config as Record<string, unknown>)["discovery"]
      : undefined;
  const parsed = DiscoveryConfigSchema.safeParse(block ?? {});
  return parsed.success ? parsed.data : {};
}

/* ----- session journal (`_sessions/<id>/session.json`) ----- */

export const SessionKindSchema = z.enum(["discovery", "accompany"]);
export type SessionKind = z.infer<typeof SessionKindSchema>;

export const SessionStatusSchema = z.enum([
  "open",
  "expired",
  "closed",
  "exported",
]);
export type SessionStatus = z.infer<typeof SessionStatusSchema>;

/**
 * `session.json`, rewritten atomically (temp file + rename) on every change.
 * Contract fields first; the rest are additive and optional. A journal is
 * everything `cairn discover export --from-session` and
 * `cairn_discover_resume` need: no browser, no live server state.
 */
export const SessionJournalSchema = z
  .object({
    version: z.literal(1),
    sessionId: z.string().min(1),
    kind: SessionKindSchema,
    pid: z.number().int().positive(),
    origin: z.enum(["cli", "mcp"]),
    /** MCP client `name/version`. */
    client: z.string().min(1).optional(),
    /** URL as requested: placeholders kept, secrets redacted. */
    startUrl: z.string(),
    backend: z.string().min(1),
    headed: z.boolean(),
    env: z.string().min(1).optional(),
    configPath: z.string().min(1).optional(),
    status: SessionStatusSchema,
    openedAt: z.string().min(1),
    lastActivityAt: z.string().min(1),
    ttlMs: z.number().int().nonnegative(),
    setup: DiscoverySetupSchema.optional(),
    /** Spec paths written by exports (absolute). */
    exportedTo: z.array(z.string().min(1)).optional(),
    /* --- additive --- */
    closedAt: z.string().min(1).optional(),
    /** Checkpoint restored before setup (`resume`). */
    resume: z.string().min(1).optional(),
    /** Absolute action files `setup` resolved `use:` against. */
    imports: z.array(z.string().min(1)).optional(),
    /** `var` inputs (values of secret-like keys are redacted). */
    vars: z.record(z.string(), VarValueSchema).optional(),
    waitUntil: z.enum(["networkidle", "load", "domcontentloaded"]).optional(),
    mock: z.boolean().optional(),
    /** Current page URL, without query string or fragment. */
    currentUrl: z.string().optional(),
    /** Recorded (exportable) steps / performed actions so far. */
    stepCount: z.number().int().nonnegative().optional(),
    actionCount: z.number().int().nonnegative().optional(),
    /** Accompany: the spec being played (absolute). */
    specPath: z.string().min(1).optional(),
    /** Draft copy (relative to the session dir, or absolute when outside). */
    draftPath: z.string().min(1).optional(),
    /** Last export's intent + outcomes (the draft reuses them). */
    intent: z.string().min(1).optional(),
    outcomes: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();
export type SessionJournalFile = z.infer<typeof SessionJournalSchema>;

/** Lenient read schema: a newer cairn's extra fields are not fatal. */
export const SessionJournalReadSchema = SessionJournalSchema.passthrough();

/* ----- interact result (returned by DiscoverySession.interact) ----- */

export interface DiscoverySnapshotElement {
  role: string;
  name?: string;
  level: number;
  ref?: string;
  attrs?: Record<string, string>;
  /** Stable identity across snapshots (diff/compact modes). */
  key?: string;
  /** diff mode: why the element is listed. */
  change?: "added" | "changed";
}

export interface DiscoveryInteractResult {
  ok: boolean;
  /** 1-based action number in the session journal. */
  index?: number;
  resolvedElement?: {
    role: string;
    name?: string;
    ref?: string;
  };
  url: string;
  snapshot: DiscoverySnapshotElement[];
  snapshotInfo?: SnapshotInfo;
  recordedStep?: Record<string, unknown>;
  error?: string;
  durationMs?: number;
  /** Screenshot of the page after the action (relative to the journal). */
  screenshot?: string;
  network?: {
    mutations: Array<{ method: string; path: string; status?: number }>;
  };
  /** eval → `{ value }`; request → `{ status, body }` (redacted, bounded). */
  result?: Record<string, unknown>;
  /**
   * Non-fatal notes about this action (additive). E.g. a screenshot capture
   * timed out, so the session stopped taking screenshots.
   */
  warnings?: string[];
}

/* ----- export input (used by specExporter for outcome typing) ----- */

export interface DiscoveryExportInput {
  sessionId: string;
  path: string;
  intent: string;
  outcomes: Array<{
    id: string;
    description: string;
    verify: Record<string, unknown>;
  }>;
}

/* ----- re-export LocatorSchema for convenience ----- */

export { LocatorSchema };
