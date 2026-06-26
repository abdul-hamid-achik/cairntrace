import { z } from "zod";
import { LocatorSchema } from "./spec.v1";

/**
 * Discovery session schemas (v1).
 *
 * Discovery lets an agent explore a live page through the harness — navigate,
 * interact, snapshot — while recording each interaction as a spec-compatible
 * step. The agent then exports the recorded steps as a spec YAML.
 *
 * Only the types consumed by DiscoverySession.ts, stepRecorder.ts, and
 * specExporter.ts are exported here. The MCP server defines its own inline
 * Zod schemas for tool input validation (with richer .describe() strings).
 */

/* ----- action enum (shared by stepRecorder + DiscoverySession) ----- */

export const DiscoveryActionSchema = z.enum([
  "click",
  "fill",
  "hover",
  "type",
  "scroll",
  "press",
]);
export type DiscoveryAction = z.infer<typeof DiscoveryActionSchema>;

/* ----- interact result (returned by DiscoverySession.interact) ----- */

export interface DiscoveryInteractResult {
  ok: boolean;
  resolvedElement?: {
    role: string;
    name?: string;
    ref?: string;
  };
  url: string;
  snapshot: Array<{
    role: string;
    name?: string;
    level: number;
    ref?: string;
    attrs?: Record<string, string>;
  }>;
  recordedStep?: Record<string, unknown>;
  error?: string;
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
