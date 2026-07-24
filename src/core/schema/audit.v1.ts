import { z } from "zod";
import { CodeMatchSchema } from "./investigate.v1";
import { ExitCodeSchema, RunStatusSchema } from "./shared";

/**
 * Wire schema for `cairn audit --json` and MCP `cairn_audit`.
 * Treat this as a v1 contract: CLI and MCP must emit the same parsed value.
 */
export const AuditResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:audit:v1")
      .default("urn:cairntrace.dev:audit:v1"),
    version: z.literal("1"),
    specPath: z.string().min(1),
    runId: z.string().min(1).optional(),
    runDir: z.string().min(1).optional(),
    status: RunStatusSchema.optional(),
    exitCode: ExitCodeSchema.optional(),
    videoPath: z.string().min(1).optional(),
    vidtraceBundle: z.string().min(1).optional(),
    stashId: z.string().min(1).optional(),
    evidenceStashId: z.string().min(1).optional(),
    codeMatches: z.array(CodeMatchSchema),
    warnings: z.array(z.string().min(1)).optional(),
    error: z.string().min(1).optional(),
  })
  .strict();
export type AuditResult = z.infer<typeof AuditResultSchema>;
