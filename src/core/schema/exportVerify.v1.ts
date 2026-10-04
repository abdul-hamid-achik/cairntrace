import { z } from "zod";
import { IsoTimestampSchema } from "./shared";

/**
 * `cairn export playwright --verify` report (E5), written next to the export
 * as `.cairn-export-verify.json` and summarized in `.cairn-export.json`'s
 * `verify` field. Additive: new optional fields may appear, existing ones
 * keep their meaning. Nothing in it is a secret: paths are relative to the
 * export root, evidence is ids, counts and verdicts (never request or
 * response bodies), and failure details are bounded tails of tool output.
 */
export const EXPORT_VERIFY_SCHEMA_ID = "urn:cairntrace.dev:export-verify:v1";

/** A skipped gate proves nothing: it is never a pass. */
export const ExportVerifyGateStatusSchema = z.enum([
  "passed",
  "failed",
  "skipped",
]);
export type ExportVerifyGateStatus = z.infer<
  typeof ExportVerifyGateStatusSchema
>;

export const EXPORT_VERIFY_GATE_IDS = [
  "sentinels",
  "freshness",
  "typecheck",
  "lint",
  "list",
] as const;
export const ExportVerifyGateIdSchema = z.enum(EXPORT_VERIFY_GATE_IDS);
export type ExportVerifyGateId = z.infer<typeof ExportVerifyGateIdSchema>;

export const ExportVerifyGateSchema = z
  .object({
    id: ExportVerifyGateIdSchema,
    status: ExportVerifyGateStatusSchema,
    /** Why the gate was skipped (always present when `status` is skipped). */
    reason: z.string().min(1).optional(),
    /** One line saying what was checked / what failed. */
    summary: z.string(),
    /** Bounded findings (file:line messages, stale files, …). */
    findings: z.array(z.string()).optional(),
    durationMs: z.number().int().nonnegative(),
  })
  .strict();
export type ExportVerifyGate = z.infer<typeof ExportVerifyGateSchema>;

/** The verdict both sides can be reduced to. */
export const ExportVerifyVerdictSchema = z.enum([
  "passed",
  "failed",
  "skipped",
]);
export type ExportVerifyVerdict = z.infer<typeof ExportVerifyVerdictSchema>;

export const ExportVerifyMismatchKindSchema = z.enum([
  /** The whole run passed on one side and failed on the other. */
  "verdict",
  /** A spec step id has a different verdict on the two sides. */
  "step",
  /** A spec outcome id has a different verdict on the two sides. */
  "outcome",
  /** A network outcome matched requests on one side and none on the other. */
  "network",
  /** The runner has an outcome the export never evaluated. */
  "missing-outcome",
]);
export type ExportVerifyMismatchKind = z.infer<
  typeof ExportVerifyMismatchKindSchema
>;

export const ExportVerifyMismatchSchema = z
  .object({
    kind: ExportVerifyMismatchKindSchema,
    /** Step or outcome id (absent for the whole-run verdict). */
    id: z.string().min(1).optional(),
    cairn: z.string(),
    export: z.string(),
    detail: z.string(),
  })
  .strict();
export type ExportVerifyMismatch = z.infer<typeof ExportVerifyMismatchSchema>;

export const ExportVerifyNetworkEvidenceSchema = z
  .object({
    outcome: z.string().min(1),
    /** Requests matching the outcome's method + URL in the runner's log. */
    cairn: z.number().int().nonnegative(),
    /** The same count the exported test recorded. */
    export: z.number().int().nonnegative(),
  })
  .strict();

export const ExportVerifyDifferentialSpecStatusSchema = z.enum([
  /** Both sides agree on every compared verdict. */
  "match",
  /** At least one verdict (or the network evidence) differs. */
  "mismatch",
  /**
   * The baseline (`cairn run`) did not pass, so agreement proves little:
   * the app or the spec is unhealthy. Never counted as a match.
   */
  "inconclusive",
  /** Not compared (a test.fixme export, a gated test), with the reason. */
  "skipped",
  /** A side could not run (no JSON, spawn failure, timeout). */
  "error",
]);
export type ExportVerifyDifferentialSpecStatus = z.infer<
  typeof ExportVerifyDifferentialSpecStatusSchema
>;

export const ExportVerifyDifferentialSpecSchema = z
  .object({
    spec: z.string().min(1),
    testFile: z.string().min(1),
    status: ExportVerifyDifferentialSpecStatusSchema,
    reason: z.string().optional(),
    cairn: z
      .object({
        status: z.string(),
        exitCode: z.number().int().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        /** Run directory relative to the artifact root used for the run. */
        runDir: z.string().optional(),
      })
      .strict()
      .optional(),
    export: z
      .object({
        status: z.string(),
        durationMs: z.number().int().nonnegative().optional(),
      })
      .strict()
      .optional(),
    /** Verdicts compared (ids present on both sides). */
    compared: z
      .object({
        steps: z.number().int().nonnegative(),
        outcomes: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    /** Ids only one side reports (informational: actions, branches, …). */
    unmapped: z
      .object({
        cairnSteps: z.number().int().nonnegative(),
        exportSteps: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    mismatches: z.array(ExportVerifyMismatchSchema),
    network: z.array(ExportVerifyNetworkEvidenceSchema).optional(),
    /** export duration / cairn duration, when both are long enough to compare. */
    durationRatio: z.number().positive().optional(),
    warnings: z.array(z.string()),
  })
  .strict();
export type ExportVerifyDifferentialSpec = z.infer<
  typeof ExportVerifyDifferentialSpecSchema
>;

export const ExportVerifyDifferentialSchema = z
  .object({
    status: z.enum(["passed", "failed", "inconclusive"]),
    /** The `CAIRN_RUN_TOKEN` both sides ran with (per spec: this prefix + index). */
    runTokenPrefix: z.string().min(1),
    /** Warn when max(a, b) / min(a, b) exceeds this. */
    durationRatioThreshold: z.number().positive(),
    /** The `--preconditions` mode the export was written with. */
    preconditionsMode: z.string(),
    /**
     * The export was written with `--strict-locators`: its locators are as
     * strict as the `cairn run --backend playwright` side. Absent for the
     * default `.first()` export, where an ambiguous locator can pass the
     * exported test and fail the run. Additive.
     */
    strictLocators: z.literal(true).optional(),
    /** Both sides ran sequentially, cairn first; see `cairn docs export`. */
    order: z.literal("cairn-then-export"),
    specs: z.array(ExportVerifyDifferentialSpecSchema),
    summary: z
      .object({
        match: z.number().int().nonnegative(),
        mismatch: z.number().int().nonnegative(),
        inconclusive: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
        error: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ExportVerifyDifferential = z.infer<
  typeof ExportVerifyDifferentialSchema
>;

export const ExportVerifyMutantStatusSchema = z.enum([
  /** The exported test failed at the flipped outcome: the assertion works. */
  "killed",
  /** The mutant still passed: "assertion not effective". */
  "survived",
  /** The mutant failed somewhere else (or the run broke): proves nothing. */
  "invalid",
  /** The outcome has no assertion this operator can invert. */
  "not-applicable",
]);
export type ExportVerifyMutantStatus = z.infer<
  typeof ExportVerifyMutantStatusSchema
>;

export const ExportVerifyMutantSchema = z
  .object({
    outcome: z.string().min(1),
    status: ExportVerifyMutantStatusSchema,
    /** What was flipped, e.g. `toContainText -> not.toContainText`. */
    operator: z.string().optional(),
    detail: z.string().optional(),
  })
  .strict();

export const ExportVerifyMutationSpecSchema = z
  .object({
    spec: z.string().min(1),
    testFile: z.string().min(1),
    status: z.enum(["effective", "ineffective", "inconclusive", "skipped"]),
    reason: z.string().optional(),
    mutants: z.array(ExportVerifyMutantSchema),
  })
  .strict();
export type ExportVerifyMutationSpec = z.infer<
  typeof ExportVerifyMutationSpecSchema
>;

export const ExportVerifyMutationSchema = z
  .object({
    status: z.enum(["passed", "failed", "inconclusive"]),
    scope: z.enum(["one", "all"]),
    specs: z.array(ExportVerifyMutationSpecSchema),
    summary: z
      .object({
        killed: z.number().int().nonnegative(),
        survived: z.number().int().nonnegative(),
        invalid: z.number().int().nonnegative(),
        notApplicable: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();
export type ExportVerifyMutation = z.infer<typeof ExportVerifyMutationSchema>;

/**
 * The Playwright project the list gate, the differential and the mutants ran
 * under (`--project`), present when the host config has several projects or
 * one was requested. Playwright still runs that project's dependencies.
 */
export const ExportVerifyPlaywrightProjectSchema = z
  .object({
    name: z.string(),
    /** flag: --verify-project / MCP verifyProject; manifest: recorded at export time; auto: chosen (Chromium first, then config order). */
    source: z.enum(["flag", "manifest", "auto"]),
    reason: z.string(),
    /** Every project of the config, in config order. */
    projects: z.array(z.string()),
    /** The projects that discover at least one exported test. */
    discovering: z.array(z.string()),
  })
  .strict();
export type ExportVerifyPlaywrightProject = z.infer<
  typeof ExportVerifyPlaywrightProjectSchema
>;

export const ExportVerifyReportSchema = z
  .object({
    $schema: z.literal(EXPORT_VERIFY_SCHEMA_ID),
    version: z.literal("1"),
    /**
     * failed: a gate, the differential or a mutant failed; error: could not
     * verify; inconclusive: what was requested proved nothing (no toolchain
     * gate ran, no differential spec matched, no mutant was killed or
     * survived) — never a pass.
     */
    status: z.enum(["passed", "failed", "error", "inconclusive"]),
    /** The process exit code of `--verify` for this report: 0, 1, 2 or 3 (inconclusive). */
    exitCode: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(3)]),
    exportDir: z.string().min(1),
    exporterVersion: z.string().min(1),
    /** The cairntrace that generated the export (the manifest's value). */
    manifest: z
      .object({
        exporterVersion: z.string(),
        mode: z.enum(["project", "into", "files"]),
        lang: z.enum(["ts", "js"]),
        specs: z.number().int().nonnegative(),
      })
      .strict()
      .optional(),
    verifiedAt: IsoTimestampSchema,
    /** sha256 of the manifest's file hashes: which export content this verified. */
    filesDigest: z.string().optional(),
    /** Multi-project hosts: the project every Playwright run used. */
    playwrightProject: ExportVerifyPlaywrightProjectSchema.optional(),
    gates: z.array(ExportVerifyGateSchema),
    differential: ExportVerifyDifferentialSchema.optional(),
    mutation: ExportVerifyMutationSchema.optional(),
    summary: z
      .object({
        gates: z
          .object({
            passed: z.number().int().nonnegative(),
            failed: z.number().int().nonnegative(),
            skipped: z.number().int().nonnegative(),
          })
          .strict(),
      })
      .strict(),
    warnings: z.array(z.string()),
    /** Where the report was written (relative to the export root). */
    reportFile: z.string().optional(),
    error: z.string().optional(),
  })
  .strict();
export type ExportVerifyReport = z.infer<typeof ExportVerifyReportSchema>;

/** The `.cairn-export.json` `verify` field: a summary + where the full report is. */
export const ExportManifestVerifySchema = z
  .object({
    verifiedAt: IsoTimestampSchema,
    exporterVersion: z.string().min(1),
    status: z.enum(["passed", "failed", "error", "inconclusive"]),
    /** Hash of the export files this verified (a stale result no longer matches). */
    filesDigest: z.string().min(1),
    gates: z.record(z.string(), ExportVerifyGateStatusSchema),
    differential: z.enum(["passed", "failed", "inconclusive"]).optional(),
    mutation: z.enum(["passed", "failed", "inconclusive"]).optional(),
    report: z.string().min(1),
  })
  .strict();
export type ExportManifestVerify = z.infer<typeof ExportManifestVerifySchema>;
