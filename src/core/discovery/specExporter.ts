import { stringify as yamlStringify } from "yaml";
import type { DiscoveryExportInput } from "../schema/discovery.v1";

/**
 * Export recorded discovery steps + intent + outcomes into a valid spec YAML.
 *
 * The YAML follows the standard spec v1 shape: version, name, intent,
 * outcomes, steps. The agent provides outcomes as plain objects (they get
 * stringified as-is). Steps are the recorded step objects from DiscoverySession.
 */

export interface ExportSpecInput {
  name: string;
  intent: string;
  outcomes: DiscoveryExportInput["outcomes"];
  steps: Record<string, unknown>[];
}

export interface ExportSpecResult {
  yaml: string;
  stepCount: number;
}

const SPEC_HEADER = [
  "# Cairntrace behavioral spec — discovered via cairn_discover_export",
  "#",
  "# COLD START CONTRACT (plan §10.6):",
  "#   This spec must be replayable from a fresh browser session.",
  "#   Satisfy via ONE of:",
  "#     1. imports: [actions/login_admin.yml] + steps: [{ use: login_admin }]",
  "#     2. session: { resume: <checkpoint-name> }  # from `cairn checkpoint capture-from-session`",
  "#     3. preconditions: { commands: [{ run: 'pnpm db:seed ...' }] }",
  "#",
  "# Outcomes are the contract. Steps are repairable hints.",
  "# Run `cairn spec verify <file> --stamp` after editing to lock the contractHash.",
  "#",
].join("\n");

export function buildSpecYaml(input: ExportSpecInput): ExportSpecResult {
  const spec: Record<string, unknown> = {
    version: 1,
    name: input.name,
    intent: input.intent,
    outcomes: input.outcomes,
    steps: input.steps,
  };
  const yaml = yamlStringify(spec);
  return {
    yaml: SPEC_HEADER + "\n" + yaml,
    stepCount: input.steps.length,
  };
}

/**
 * Derive a snake_case spec name from a path like "flows/login-flow.yml"
 * → "login_flow". Falls back to "discovered_spec" if the path has no
 * usable stem.
 */
export function deriveSpecName(path: string): string {
  const lastSep = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  const basename = lastSep >= 0 ? path.slice(lastSep + 1) : path;
  const dot = basename.lastIndexOf(".");
  const stem = dot > 0 ? basename.slice(0, dot) : basename;
  const cleaned = stem.replace(/[^a-zA-Z0-9_]/g, "_").toLowerCase();
  // Strip leading/trailing underscores; fall back to default when nothing remains
  const stripped = cleaned.replace(/^_+|_+$/g, "");
  return stripped || "discovered_spec";
}
