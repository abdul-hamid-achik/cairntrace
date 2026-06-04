import { homedir } from "node:os";
import { join } from "node:path";
import type { ExplainResult } from "../../core/schema/explain.v1";
import { DOC_TOPICS } from "./docs";
import { emit, resolveFormat } from "../format";
import { CAIRN_VERSION } from "../version";

export interface ExplainOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function explainCommand(opts: ExplainOptions): Promise<void> {
  const format = resolveFormat(opts, "md");
  const doc = buildExplain();
  process.stdout.write(emit(format, doc, explainToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

/**
 * Build the canonical ExplainResult. Exported so the MCP server's
 * `cairn_explain` tool returns the exact same structuredContent as
 * `cairn explain --json` — agents bootstrapping via MCP get the same surface
 * as agents shelling out, no schema drift.
 */
export function buildExplain(): ExplainResult {
  return {
    $schema: "urn:cairntrace.dev:explain:v1",
    version: "1",
    cairntrace: { version: CAIRN_VERSION, binary: "/usr/local/bin/cairn" },
    commands: [
      {
        name: "run",
        summary: "Run a behavioral spec; emit machine-readable result",
        synopsis:
          "cairn run <spec-path> [--env <name>] [--cold-start] [--headed] [--mock] [--backend agent-browser|playwright|mock] [--format json|yaml|md]",
        flags: [
          {
            name: "--env",
            type: "string",
            description: "Environment override",
          },
          {
            name: "--cold-start",
            type: "boolean",
            default: false,
            description: "Force fresh browser profile",
          },
          {
            name: "--headed",
            type: "boolean",
            default: false,
            description: "Show the browser window",
          },
          {
            name: "--mock",
            type: "boolean",
            default: false,
            description: "Use the in-memory mock backend",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "all outcomes passed",
          "1": "one or more outcomes failed",
          "2": "errored (browser crash, spec parse failure)",
          "3": "cold-start gate not satisfied",
          "6": "contract hash mismatch",
        },
        outputSchema: "urn:cairntrace.dev:run:v1",
      },
      {
        name: "spec heal",
        summary: "Run a spec and propose selector-drift fixes",
        synopsis:
          "cairn spec heal <spec-path> [--apply] [--backend agent-browser|playwright|mock] [--format json|yaml|md]",
        flags: [
          {
            name: "--apply",
            type: "boolean",
            default: false,
            description: "Write the proposed patch in place",
          },
          {
            name: "--backend",
            type: "string",
            description: "Backend override",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "patch proposed or applied",
          "2": "error",
          "5": "no heal possible",
          "6": "contract hash mismatch",
        },
        outputSchema: "urn:cairntrace.dev:heal:v1",
      },
      {
        name: "docs",
        summary:
          "Return focused agent documentation for a topic as structured data",
        synopsis:
          "cairn docs [overview|authoring|steps|verifiers|downloads|scripts|artifacts|mcp|backends] [--format json|yaml|md]",
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "unknown topic" },
        outputSchema: "urn:cairntrace.dev:docs:v1",
      },
      {
        name: "doctor",
        summary: "Check environment for cairn dependencies",
        synopsis: "cairn doctor [--format json|yaml|md]",
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "all checks passed",
          "2": "one or more checks failed",
        },
      },
      {
        name: "explain",
        summary: "Return the full agent-facing surface as structured data",
        synopsis: "cairn explain [--format json|yaml|md]",
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success" },
        outputSchema: "urn:cairntrace.dev:explain:v1",
      },
      {
        name: "context",
        summary: "Print or locate the agent_context.md for a run",
        synopsis: "cairn context <run-id|latest> [--path]",
        flags: [
          {
            name: "--path",
            type: "boolean",
            default: false,
            description: "Print the file path instead of contents",
          },
        ],
        exitCodes: { "0": "success", "2": "no such run" },
      },
      {
        name: "spec scaffold",
        summary: "Write a starter behavioral spec YAML",
        synopsis: "cairn spec scaffold <name> --intent <text> [--out <dir>]",
        flags: [
          {
            name: "--intent",
            type: "string",
            description: "One-line intent for the spec",
          },
          {
            name: "--out",
            type: "string",
            default: "./flows",
            description: "Output directory",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
      },
      {
        name: "spec verify",
        summary: "Lint and (optionally) stamp the contract hash on a spec",
        synopsis:
          "cairn spec verify <spec-path> [--stamp] [--env <name>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--stamp",
            type: "boolean",
            default: false,
            description: "Write a fresh contractHash into the file",
          },
          {
            name: "--env",
            type: "string",
            description: "Environment override",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit config path",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "valid",
          "4": "lint failed",
          "6": "contract hash mismatch",
        },
      },
    ],
    steps: [
      {
        id: "open",
        kind: "navigation",
        summary: "Navigate to a URL or config-resolved path",
        yamlExample: "steps:\n  - open: /settings",
      },
      {
        id: "click",
        kind: "interaction",
        summary: "Activate a locator with click",
        yamlExample:
          "steps:\n  - click: { by: role, role: button, name: Save }",
      },
      {
        id: "hover",
        kind: "interaction",
        summary: "Move the pointer over a locator to reveal hover-only UI",
        yamlExample:
          'steps:\n  - hover: { by: selector, selector: ".question-table-wrap .table-title" }',
      },
      {
        id: "fill",
        kind: "interaction",
        summary: "Fill a locator with a string value",
        yamlExample:
          "steps:\n  - fill: { by: label, name: Email, value: user@example.com }",
      },
      {
        id: "upload",
        kind: "file",
        summary: "Set a file input from a local path",
        yamlExample:
          "steps:\n  - upload: { by: label, name: File, path: ./fixtures/sample.xlsx }",
      },
      {
        id: "download",
        kind: "file",
        summary: "Click a locator and capture the resulting download artifact",
        yamlExample:
          "steps:\n  - download: { by: role, role: button, name: Download template, saveAs: template.xlsx, assign: template }",
      },
      {
        id: "transform",
        kind: "file",
        summary: "Run a Node transform that writes a new named file artifact",
        yamlExample:
          "steps:\n  - transform: { runtime: node, file: ./transforms/make-invalid-template.ts, input: ${artifacts.template.path}, saveAs: invalid-template.xlsx, assign: invalidTemplate }",
      },
      {
        id: "wait",
        kind: "wait",
        summary: "Wait for text, notText, or load state",
        yamlExample: "steps:\n  - wait: { text: Saved, timeoutMs: 10000 }",
      },
      {
        id: "snapshot",
        kind: "artifact",
        summary: "Capture an accessibility snapshot for evidence or healing",
        yamlExample: "steps:\n  - snapshot: { interactive: true }",
      },
      {
        id: "use",
        kind: "interaction",
        summary: "Invoke an imported reusable action",
        yamlExample: "steps:\n  - use: login_admin",
      },
    ],
    verifiers: [
      {
        id: "text",
        kind: "ui",
        summary: "Text appears on the page",
        yamlExample: 'verify:\n  text: { equals: "Coupon applied" }',
        parameters: [
          {
            name: "equals",
            type: "string",
            description: "exact match",
            oneOfGroup: "matcher",
          },
          {
            name: "contains",
            type: "string",
            description: "substring",
            oneOfGroup: "matcher",
          },
          {
            name: "matches",
            type: "regex",
            description: "regex source",
            oneOfGroup: "matcher",
          },
          {
            name: "region",
            type: "string",
            default: "page",
            description: "selector or 'page'",
          },
        ],
      },
      {
        id: "notText",
        kind: "ui",
        summary: "Text does NOT appear on the page",
        yamlExample: 'verify:\n  notText: { contains: "Something went wrong" }',
        parameters: [
          {
            name: "equals",
            type: "string",
            description: "exact match",
            oneOfGroup: "matcher",
          },
          {
            name: "contains",
            type: "string",
            description: "substring",
            oneOfGroup: "matcher",
          },
          {
            name: "matches",
            type: "regex",
            description: "regex source",
            oneOfGroup: "matcher",
          },
        ],
      },
      {
        id: "url",
        kind: "navigation",
        summary: "URL post-condition",
        yamlExample: 'verify:\n  url: { endsWith: "/invoices?imported=42" }',
        parameters: [
          { name: "equals", type: "string", oneOfGroup: "matcher" },
          { name: "startsWith", type: "string", oneOfGroup: "matcher" },
          { name: "endsWith", type: "string", oneOfGroup: "matcher" },
          { name: "matches", type: "regex", oneOfGroup: "matcher" },
        ],
      },
      {
        id: "network",
        kind: "network",
        summary: "At least one matching request happened",
        yamlExample:
          "verify:\n  network:\n    method: POST\n    urlContains: /api/invoices/import\n    status: { in: [200, 201] }",
        parameters: [
          {
            name: "method",
            type: "enum",
            values: [
              "GET",
              "POST",
              "PUT",
              "PATCH",
              "DELETE",
              "HEAD",
              "OPTIONS",
            ],
          },
          { name: "urlContains", type: "string" },
          {
            name: "status",
            type: "string",
            description: "{ equals | below | atLeast | in }",
          },
        ],
      },
      {
        id: "noFailedRequests",
        kind: "network",
        summary: "No matching request failed (4xx/5xx)",
        yamlExample: "verify:\n  noFailedRequests:\n    urlContains: /api/",
        parameters: [
          { name: "urlContains", type: "string" },
          {
            name: "method",
            type: "enum",
            values: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          },
        ],
      },
      {
        id: "console",
        kind: "console",
        summary: "Bounded console errors",
        yamlExample: "verify:\n  console: { errorsMax: 0 }",
        parameters: [{ name: "errorsMax", type: "number" }],
      },
      {
        id: "count",
        kind: "ui",
        summary: "N elements match a role/selector in an optional region",
        yamlExample:
          "verify:\n  count:\n    role: row\n    in_region: 'table[name=\"Invoices\"]'\n    equals: 42",
        parameters: [
          { name: "role", type: "string" },
          { name: "selector", type: "string" },
          { name: "in_region", type: "string" },
          { name: "equals", type: "number", oneOfGroup: "matcher" },
          { name: "atLeast", type: "number", oneOfGroup: "matcher" },
          { name: "atMost", type: "number", oneOfGroup: "matcher" },
          { name: "between", type: "tuple", oneOfGroup: "matcher" },
        ],
      },
      {
        id: "script",
        kind: "escape-hatch",
        summary:
          "Browser or Node JS returning { ok, evidence }; use run inline or file for external JS/TS",
        yamlExample:
          "verify:\n  script:\n    runtime: node\n    file: ./verifiers/check-template.ts\n    fixtures:\n      templatePath: ${artifacts.template.path}",
        parameters: [
          {
            name: "runtime",
            type: "enum",
            values: ["browser", "node"],
            default: "browser",
            description:
              "browser runs in page context; node runs in a Node process with fs/import access",
          },
          {
            name: "fixtures",
            type: "string",
            description: "fixture name → path (object)",
          },
          { name: "run", type: "string", description: "JS body" },
          {
            name: "file",
            type: "string",
            description:
              "Path to JS/TS verifier body, resolved relative to the spec file",
          },
        ],
      },
      {
        id: "xlsx",
        kind: "file",
        summary: "Inspect workbook text and Excel data validations",
        yamlExample:
          "verify:\n  xlsx:\n    path: ${artifacts.template.path}\n    sheets:\n      - name: Template Guide\n        contains: [Help Text, Allowed Values, Examples]\n    validations:\n      - sheet: RBA Academy Training\n        column: Email\n        type: textLength",
        parameters: [
          {
            name: "path",
            type: "string",
            description: "Workbook path; artifact placeholders are supported",
          },
          {
            name: "sheets",
            type: "array",
            description: "sheet name plus contains text checks",
          },
          {
            name: "validations",
            type: "array",
            description: "sheet, column header, and optional validation type",
          },
        ],
      },
    ],
    rules: {
      coldStart: {
        summary: "Every spec must run from a clean browser session",
        satisfyVia: [
          "imports of a setup action",
          "session.resume: <checkpoint>",
          "preconditions.commands",
        ],
        authoringGate:
          "Run `cairn run --cold-start --json` once before declaring a spec done",
      },
      contractImmutability: {
        summary: "intent and outcomes are immutable without human review",
        enforcedBy:
          "contractHash (sha256 of intent + outcomes) stamped at scaffold; heal refuses writes that would change it",
      },
      evidenceBudget: {
        maxLines: 80,
        maxListItems: 20,
        deepDataLocation: "outcomes/<id>.raw.json",
      },
    },
    config: {
      artifactRoot: join(homedir(), ".cairntrace", "runs"),
      workflowRoots: ["./flows"],
      defaultEnvironment: "local",
      defaultBackend: "agent-browser",
    },
  };
}

/** Markdown renderer for the explain doc. Exported for MCP reuse. */
export function explainToMarkdown(e: ExplainResult): string {
  const lines: string[] = [
    `# Cairntrace ${e.cairntrace.version}`,
    "",
    "## Commands",
    ...e.commands.map(
      (c) => `- **${c.name}** — ${c.summary}\n  \`${c.synopsis}\``,
    ),
    "",
    "## Verifier vocabulary (v0)",
    ...e.verifiers.map((v) => `- **${v.id}** *(${v.kind})* — ${v.summary}`),
    "",
    "## Step vocabulary",
    ...e.steps.map((s) => `- **${s.id}** *(${s.kind})* — ${s.summary}`),
    "",
    "## Rules",
    `- cold-start: ${e.rules.coldStart.summary}`,
    `- contract immutability: ${e.rules.contractImmutability.summary}`,
    `- evidence budget: ≤${e.rules.evidenceBudget.maxLines} lines, ≤${e.rules.evidenceBudget.maxListItems} list items`,
    "",
    "## Config",
    `- artifactRoot: ${e.config.artifactRoot}`,
    `- defaultEnvironment: ${e.config.defaultEnvironment}`,
    `- defaultBackend: ${e.config.defaultBackend}`,
    "",
    "## Agent Docs",
    `- topics: ${DOC_TOPICS.join(", ")}`,
    "- use `cairn docs <topic> --json` or MCP `cairn_docs` for focused guidance",
  ];
  return lines.join("\n");
}
