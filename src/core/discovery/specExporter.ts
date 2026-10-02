import { Document, isScalar, Scalar, visit } from "yaml";
import type { DiscoveryExportInput } from "../schema/discovery.v1";

/**
 * Export recorded discovery steps + intent + outcomes into a valid spec YAML.
 *
 * The YAML follows the standard spec v1 shape: version, name, intent,
 * outcomes, steps. The agent provides outcomes as plain objects (they get
 * stringified as-is). Steps are the recorded step objects from DiscoverySession.
 * A session's setup is written as it was given — `imports:` + `use:` steps
 * (or a source spec's own steps through `untilStep`) — never expanded.
 */

export interface ExportSpecInput {
  name: string;
  intent: string;
  outcomes: DiscoveryExportInput["outcomes"];
  steps: Record<string, unknown>[];
  /**
   * Checkpoint name to resume from. When set, the exported spec carries
   * `session: { resume: <name> }`, satisfying the cold-start contract for an
   * authenticated flow captured via cairn_checkpoint_capture.
   */
  resume?: string;
  /** `imports:` (already relative to the written spec). */
  imports?: string[];
  /** Setup steps written before the recorded ones (`use:` steps, …). */
  setupSteps?: Record<string, unknown>[];
  /** Spec-level `vars:` (a fromSpec setup carries its source's). */
  vars?: Record<string, unknown>;
  /** `requires:` (a fromSpec setup carries its source's). */
  requires?: unknown;
  /** `coldStart: guest` (a fromSpec setup carries its source's). */
  coldStart?: "guest";
  /** Discovery session the spec came from (header comment). */
  sessionId?: string;
  /** The session's live draft rather than an export (header wording). */
  draft?: boolean;
  /** `metadata:` (convention exports: `authoring.template.metadata.tags`). */
  metadata?: { tags?: string[] };
  /**
   * Extra header lines (without `# `) after the cold-start block — a
   * convention export says what it reused and what to run next.
   */
  notes?: string[];
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
  "#     2. session: { resume: <checkpoint-name> }  # from cairn_checkpoint_capture (MCP) or `cairn checkpoint capture-from-session`",
  "#     3. preconditions: { commands: [{ run: 'pnpm db:seed ...' }] }",
  "#     4. coldStart: guest  # intentionally public/sessionless flow",
  "#",
  "# Outcomes are the contract. Steps are repairable hints.",
  "# Run `cairn spec verify <file> --stamp` after editing to lock the contractHash.",
  "#",
].join("\n");

function header(input: ExportSpecInput): string {
  if (input.draft) {
    return [
      "# Cairntrace discovery DRAFT — regenerated after every recorded step.",
      `# Discovery session: ${input.sessionId ?? "(unknown)"}`,
      "# Export it with cairn_discover_export (or `cairn discover export --from-session`);",
      "# outcomes are the contract and are authored at export time.",
      "#",
    ].join("\n");
  }
  const notes = (input.notes ?? []).map((line) => (line ? `# ${line}` : "#"));
  return [
    SPEC_HEADER,
    ...(input.sessionId
      ? [`# Discovery session: ${input.sessionId}`, "#"]
      : []),
    ...(notes.length > 0 ? [...notes, "#"] : []),
  ].join("\n");
}

/**
 * YAML for a spec object. Strings holding a `${…}` placeholder are double
 * quoted: a plain whole-value placeholder takes its value's YAML type after
 * substitution (`value: ${vars.price}` with price 12.50 would become a
 * number and fail a string field), a quoted one stays a string.
 */
function specYaml(spec: Record<string, unknown>): string {
  const doc = new Document(spec);
  visit(doc, {
    Scalar(_key, node) {
      if (
        isScalar(node) &&
        typeof node.value === "string" &&
        node.value.includes("${")
      ) {
        node.type = Scalar.QUOTE_DOUBLE;
      }
    },
  });
  return doc.toString();
}

export function buildSpecYaml(input: ExportSpecInput): ExportSpecResult {
  const steps = [...(input.setupSteps ?? []), ...input.steps];
  const spec: Record<string, unknown> = {
    version: 1,
    name: input.name,
    intent: input.intent,
    ...(input.requires !== undefined ? { requires: input.requires } : {}),
    ...(input.coldStart ? { coldStart: input.coldStart } : {}),
    ...(input.metadata?.tags && input.metadata.tags.length > 0
      ? { metadata: { tags: input.metadata.tags } }
      : {}),
    ...(input.vars && Object.keys(input.vars).length > 0
      ? { vars: input.vars }
      : {}),
    ...(input.imports && input.imports.length > 0
      ? { imports: input.imports }
      : {}),
    // Resuming a captured checkpoint satisfies the cold-start contract for an
    // authenticated flow (coldStartLint sees session.resume).
    ...(input.resume ? { session: { resume: input.resume } } : {}),
    outcomes: input.outcomes,
    steps,
  };
  const yaml = specYaml(spec);
  return {
    yaml: header(input) + "\n" + yaml,
    stepCount: steps.length,
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
  if (!stripped) return "discovered_spec";
  // spec.v1 requires `name` to start with a lowercase letter; a numeric stem
  // (e.g. "456.yml") would otherwise yield an invalid spec name. Prefix rather
  // than discard so distinct sources don't all collapse to the fallback.
  return /^[a-z]/.test(stripped) ? stripped : `spec_${stripped}`;
}
