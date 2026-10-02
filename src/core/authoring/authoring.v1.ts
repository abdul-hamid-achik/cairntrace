import { z } from "zod";

/**
 * Wire schemas of the authoring commands (`cairn spec lint`, `cairn spec
 * finish`, `cairn spec promote`, `cairn init agent-kit`) and their MCP
 * tools. Additive only: new optional fields may appear.
 */

const LintFindingSchema = z
  .object({
    rule: z.string().min(1),
    severity: z.enum(["error", "warning"]),
    message: z.string().min(1),
    line: z.number().int().positive().optional(),
    where: z.string().optional(),
    env: z.string().optional(),
    file: z.string().optional(),
    fix: z
      .object({
        description: z.string().min(1),
        safe: z.boolean(),
        applied: z.boolean().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

const FileLintResultSchema = z
  .object({
    path: z.string().min(1),
    kind: z.enum(["spec", "action", "unknown"]),
    status: z.enum(["ok", "warnings", "errors"]),
    findings: z.array(LintFindingSchema),
    fixed: z.number().int().nonnegative(),
    envs: z.array(z.string()),
  })
  .strict();

export const SpecLintResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:spec-lint:v1"),
    version: z.literal("1"),
    files: z.array(FileLintResultSchema),
    summary: z
      .object({
        files: z.number().int().nonnegative(),
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        fixed: z.number().int().nonnegative(),
      })
      .strict(),
  })
  .strict();

export const FinishStatusSchema = z.enum([
  "green",
  "red",
  "lint-failed",
  "errored",
  "refused",
]);
export type FinishStatus = z.infer<typeof FinishStatusSchema>;

export const SpecFinishResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:spec-finish:v1"),
    version: z.literal("1"),
    path: z.string().min(1),
    /** green = lint clean of errors, cold-start run passed, contract stamped. */
    status: FinishStatusSchema,
    exitCode: z.number().int().nonnegative(),
    /** Inside the drafts dir (or a `_` folder): promote it when green. */
    draft: z.boolean(),
    lint: z
      .object({
        status: z.enum(["ok", "warnings", "errors"]),
        errors: z.number().int().nonnegative(),
        warnings: z.number().int().nonnegative(),
        findings: z.array(LintFindingSchema),
      })
      .strict(),
    run: z
      .object({
        status: z.string().min(1),
        exitCode: z.number().int().nonnegative(),
        invocationId: z.string().optional(),
        runId: z.string().optional(),
        runDir: z.string().optional(),
        /** report.html (absolute). */
        report: z.string().optional(),
        environment: z.string().optional(),
        backend: z.string().optional(),
        coldStart: z.boolean().optional(),
        durationMs: z.number().int().nonnegative().optional(),
        /** Services a `cairn services up` lock owns were reused. */
        reusedServices: z.boolean().optional(),
        error: z.string().optional(),
      })
      .strict()
      .optional(),
    contractHash: z.string().optional(),
    /** The contract hash was (re)written by this finish. */
    stamped: z.boolean().optional(),
    /** agent_context.md of the run: outcome results and suggested next steps. */
    context: z
      .object({ path: z.string().min(1), summary: z.string() })
      .strict()
      .optional(),
    nextActions: z.array(z.string()),
  })
  .strict();
export type SpecFinishResult = z.infer<typeof SpecFinishResultSchema>;

export const SpecPromoteResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:spec-promote:v1"),
    version: z.literal("1"),
    from: z.string().min(1),
    to: z.string().min(1),
    intent: z.string(),
    outcomes: z.array(z.record(z.string(), z.unknown())),
    contractHash: z.string().min(1),
    /** Promoted without a green finish of this exact content (--force). */
    forced: z.boolean().optional(),
    /**
     * The green finish of this content (also under --force when that finish
     * ran on the mock backend, which promote does not accept on its own).
     */
    finish: z
      .object({
        runId: z.string().optional(),
        runDir: z.string().optional(),
        /** Backend the finish ran on (`mock` never touched the app). */
        backend: z.string().optional(),
        finishedAt: z.string(),
      })
      .strict()
      .optional(),
    /** Relative paths rewritten to keep pointing at the same files. */
    rebased: z
      .array(
        z
          .object({ where: z.string(), from: z.string(), to: z.string() })
          .strict(),
      )
      .optional(),
    warnings: z.array(z.string()),
  })
  .strict();
export type SpecPromoteResult = z.infer<typeof SpecPromoteResultSchema>;

export const AgentKitResultSchema = z
  .object({
    $schema: z.literal("urn:cairntrace.dev:agent-kit:v1"),
    version: z.literal("1"),
    /** The snippet (markdown) for the project's AGENTS.md. */
    snippet: z.string().min(1),
    /** `--write`: what happened to AGENTS.md. */
    written: z
      .object({
        path: z.string().min(1),
        action: z.enum(["created", "appended", "replaced", "unchanged"]),
      })
      .strict()
      .optional(),
    configPath: z.string().optional(),
  })
  .strict();
export type AgentKitResult = z.infer<typeof AgentKitResultSchema>;
