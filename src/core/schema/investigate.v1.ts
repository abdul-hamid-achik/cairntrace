import { z } from "zod";

/**
 * One ranked source candidate returned by the file.cheap/codemap
 * investigation pipeline.
 */
export const CodeMatchSchema = z
  .object({
    file: z.string().min(1),
    line: z.number().int().nonnegative(),
    score: z.number().finite(),
    snippet: z.string().optional(),
    symbol: z.string().min(1).optional(),
    callers: z.number().int().nonnegative().optional(),
    blastRadius: z.number().int().nonnegative().optional(),
    codemapScore: z.number().min(0).max(1).optional(),
    riskScore: z.number().min(0).max(1).optional(),
    riskLevel: z.enum(["low", "medium", "high", "unknown"]).optional(),
    riskFactors: z
      .array(
        z
          .object({
            factor: z.string().optional(),
            severity: z.string().optional(),
            detail: z.string().optional(),
          })
          .strict(),
      )
      .optional(),
  })
  .strict();
export type CodeMatch = z.infer<typeof CodeMatchSchema>;

/**
 * Wire schema for `cairn investigate --json` and MCP `cairn_investigate`.
 * Treat this as a v1 contract: CLI and MCP must emit the same parsed value.
 *
 * `runDir` may be empty only on setup/resolution errors because the command
 * still returns a structured result when no run directory could be resolved.
 */
export const InvestigateResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:investigate:v1")
      .default("urn:cairntrace.dev:investigate:v1"),
    version: z.literal("1"),
    runId: z.string().min(1),
    runDir: z.string(),
    stashId: z.string().min(1).optional(),
    codeMatches: z.array(CodeMatchSchema),
    query: z.string().optional(),
    mode: z.enum(["semantic", "keyword", "hybrid"]).optional(),
    indexStatus: z.string().min(1).optional(),
    failureTrace: z.array(z.string().min(1)).optional(),
    pathAnnotations: z.number().int().nonnegative().optional(),
    warnings: z.array(z.string().min(1)).optional(),
    error: z.string().min(1).optional(),
  })
  .strict();
export type InvestigateResult = z.infer<typeof InvestigateResultSchema>;
