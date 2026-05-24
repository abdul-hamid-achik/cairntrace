import { z } from "zod";
import { BackendSchema, ContractHashSchema } from "./shared";
import { VerifierSchema } from "./verifier.v1";

/**
 * Behavioral spec format v1 (plan §10).
 * Intent + outcomes are the contract; steps are repairable hints.
 *
 * The contractHash (sha256 of intent + outcomes) is stamped by `cairn spec scaffold`
 * and validated by `cairn spec heal` to enforce contract immutability.
 */

/* ----- locators (used by click / hover / fill / upload / count) ----- */

export const RoleLocatorSchema = z
  .object({
    by: z.literal("role"),
    role: z.string().min(1),
    name: z.string().optional(),
  })
  .strict();
export const LabelLocatorSchema = z
  .object({
    by: z.literal("label"),
    name: z.string().min(1),
  })
  .strict();
export const TextLocatorSchema = z
  .object({
    by: z.literal("text"),
    text: z.string().min(1),
  })
  .strict();
export const SelectorLocatorSchema = z
  .object({
    by: z.literal("selector"),
    selector: z.string().min(1),
  })
  .strict();

export const LocatorSchema = z.union([
  RoleLocatorSchema,
  LabelLocatorSchema,
  TextLocatorSchema,
  SelectorLocatorSchema,
]);
export type Locator = z.infer<typeof LocatorSchema>;

const fillTargetSchema = z.union([
  RoleLocatorSchema.extend({ value: z.string() }).strict(),
  LabelLocatorSchema.extend({ value: z.string() }).strict(),
  TextLocatorSchema.extend({ value: z.string() }).strict(),
  SelectorLocatorSchema.extend({ value: z.string() }).strict(),
]);

const uploadTargetSchema = z.union([
  RoleLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  LabelLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  TextLocatorSchema.extend({ path: z.string().min(1) }).strict(),
  SelectorLocatorSchema.extend({ path: z.string().min(1) }).strict(),
]);

const downloadTargetSchema = z.union([
  RoleLocatorSchema.extend({
    saveAs: z.string().min(1),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  LabelLocatorSchema.extend({
    saveAs: z.string().min(1),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  TextLocatorSchema.extend({
    saveAs: z.string().min(1),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
  SelectorLocatorSchema.extend({
    saveAs: z.string().min(1),
    assign: z
      .string()
      .min(1)
      .regex(/^[a-z][A-Za-z0-9_]*$/)
      .optional(),
    timeoutMs: z.number().int().positive().optional(),
  }).strict(),
]);

const artifactAssignSchema = z
  .string()
  .min(1)
  .regex(/^[a-z][A-Za-z0-9_]*$/);

const transformTargetSchema = z
  .object({
    runtime: z.literal("node").optional(),
    file: z.string().min(1),
    input: z.string().min(1),
    saveAs: z.string().min(1),
    assign: artifactAssignSchema.optional(),
    fixtures: z.record(z.string(), z.string()).optional(),
  })
  .strict();

/* ----- wait conditions ----- */

export const WaitConditionSchema = z.union([
  z
    .object({
      text: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      notText: z.string().min(1),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
  z
    .object({
      load: z.enum(["networkidle", "load", "domcontentloaded"]),
      timeoutMs: z.number().int().positive().optional(),
    })
    .strict(),
]);
export type WaitCondition = z.infer<typeof WaitConditionSchema>;

/* ----- step variants (discriminated by which key is present) ----- */

const stepCommon = {
  id: z.string().min(1).optional(),
  when: z.string().optional(), // simple condition string, e.g. "notAuthenticated"
};

export const OpenStepSchema = z
  .object({ ...stepCommon, open: z.string().min(1) })
  .strict();
export type OpenStep = z.infer<typeof OpenStepSchema>;

export const ClickStepSchema = z
  .object({ ...stepCommon, click: LocatorSchema })
  .strict();
export type ClickStep = z.infer<typeof ClickStepSchema>;

export const HoverStepSchema = z
  .object({ ...stepCommon, hover: LocatorSchema })
  .strict();
export type HoverStep = z.infer<typeof HoverStepSchema>;

export const FillStepSchema = z
  .object({
    ...stepCommon,
    fill: fillTargetSchema,
  })
  .strict();
export type FillStep = z.infer<typeof FillStepSchema>;

export const UploadStepSchema = z
  .object({
    ...stepCommon,
    upload: uploadTargetSchema,
  })
  .strict();
export type UploadStep = z.infer<typeof UploadStepSchema>;

export const DownloadStepSchema = z
  .object({
    ...stepCommon,
    download: downloadTargetSchema,
  })
  .strict();
export type DownloadStep = z.infer<typeof DownloadStepSchema>;

export const TransformStepSchema = z
  .object({
    ...stepCommon,
    transform: transformTargetSchema,
  })
  .strict();
export type TransformStep = z.infer<typeof TransformStepSchema>;

export const WaitStepSchema = z
  .object({ ...stepCommon, wait: WaitConditionSchema })
  .strict();
export type WaitStep = z.infer<typeof WaitStepSchema>;

export const SnapshotStepSchema = z
  .object({
    ...stepCommon,
    snapshot: z
      .object({
        interactive: z.boolean().default(false),
        label: z.string().optional(),
      })
      .strict(),
  })
  .strict();
export type SnapshotStep = z.infer<typeof SnapshotStepSchema>;

/** Reusable action invocation, e.g. `use: login_admin`. */
export const UseStepSchema = z
  .object({ ...stepCommon, use: z.string().min(1) })
  .strict();
export type UseStep = z.infer<typeof UseStepSchema>;

export const StepSchema = z.union([
  OpenStepSchema,
  ClickStepSchema,
  HoverStepSchema,
  FillStepSchema,
  UploadStepSchema,
  DownloadStepSchema,
  TransformStepSchema,
  WaitStepSchema,
  SnapshotStepSchema,
  UseStepSchema,
]);
export type Step = z.infer<typeof StepSchema>;

/* ----- outcome (the contract) ----- */

export const OutcomeSchema = z
  .object({
    id: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "id must be snake_case starting with a letter",
      ),
    description: z.string().min(1),
    verify: VerifierSchema,
  })
  .strict();
export type Outcome = z.infer<typeof OutcomeSchema>;

/* ----- preconditions / session / artifacts / redaction ----- */

export const PreconditionsSchema = z
  .object({
    env: z
      .record(z.string(), z.union([z.string(), z.boolean(), z.number()]))
      .optional(),
    commands: z
      .array(
        z
          .object({
            name: z.string().optional(),
            run: z.string().min(1),
            cwd: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type Preconditions = z.infer<typeof PreconditionsSchema>;

export const SessionSchema = z
  .object({
    profile: z.string().optional(),
    reuseAuth: z.boolean().optional(),
    /** Restore a captured checkpoint before running steps. */
    resume: z.string().optional(),
  })
  .strict();
export type Session = z.infer<typeof SessionSchema>;

export const CapturePolicySchema = z.enum(["always", "on-failure", "never"]);
export type CapturePolicy = z.infer<typeof CapturePolicySchema>;

export const ArtifactsConfigSchema = z
  .object({
    capture: z
      .object({
        screenshots: CapturePolicySchema.default("on-failure"),
        snapshots: CapturePolicySchema.default("always"),
        console: CapturePolicySchema.default("always"),
        network: CapturePolicySchema.default("always"),
        storage: CapturePolicySchema.default("on-failure"),
        trace: CapturePolicySchema.default("on-failure"),
        agentContext: CapturePolicySchema.default("always"),
      })
      .strict()
      .partial(),
  })
  .strict();
export type ArtifactsConfig = z.infer<typeof ArtifactsConfigSchema>;

export const RedactionConfigSchema = z
  .object({
    headers: z.array(z.string()).optional(),
    queryParams: z.array(z.string()).optional(),
    storageKeys: z.array(z.string()).optional(),
    values: z.array(z.string()).optional(),
  })
  .strict();
export type RedactionConfig = z.infer<typeof RedactionConfigSchema>;

export const SpecMetadataSchema = z
  .object({
    feature: z.string().optional(),
    owner: z.string().optional(),
    priority: z.enum(["low", "normal", "high", "critical"]).optional(),
    tags: z.array(z.string()).optional(),
  })
  .strict();
export type SpecMetadata = z.infer<typeof SpecMetadataSchema>;

/* ----- the spec itself ----- */

export const SpecSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .regex(
        /^[a-z][a-z0-9_]*$/,
        "name must be snake_case starting with a letter",
      ),
    intent: z.string().min(1),

    environment: z.string().optional(),
    backend: BackendSchema.optional(),
    mode: z.enum(["normal", "debug"]).default("normal"),

    metadata: SpecMetadataSchema.optional(),
    imports: z.array(z.string()).optional(),
    preconditions: PreconditionsSchema.optional(),
    session: SessionSchema.optional(),

    outcomes: z.array(OutcomeSchema).min(1),
    steps: z.array(StepSchema).optional(),

    artifacts: ArtifactsConfigSchema.optional(),
    redaction: RedactionConfigSchema.optional(),

    /**
     * sha256 over canonical-JSON(intent + outcomes). Stamped at scaffold time;
     * heal refuses writes that would change it. `cairn run` warns when missing
     * or stale and exits 6 if mismatch is detected at lint time.
     */
    contractHash: ContractHashSchema.optional(),
  })
  .strict();
export type Spec = z.infer<typeof SpecSchema>;

/* ----- reusable action (action YAML files) ----- */

/**
 * A reusable action lives in `actions/<name>.yml` and is imported by specs.
 * It has steps but no outcomes — it's a fragment, not a spec.
 */
export const ReusableActionSchema = z
  .object({
    version: z.literal(1),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z][a-z0-9_]*$/),
    steps: z.array(StepSchema).min(1),
  })
  .strict();
export type ReusableAction = z.infer<typeof ReusableActionSchema>;
