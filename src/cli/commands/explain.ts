import { homedir } from "node:os";
import { join } from "node:path";
import type { ExplainResult } from "../../core/schema/explain.v1";
import { emit, resolveFormat } from "../format";

export interface ExplainOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function explainCommand(opts: ExplainOptions): Promise<void> {
  const format = resolveFormat(opts, "md");
  const doc = buildExplain();
  process.stdout.write(emit(format, doc, toMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function buildExplain(): ExplainResult {
  return {
    $schema: "https://cairntrace.dev/schemas/explain.v1.json",
    version: "1",
    cairntrace: { version: "0.0.1", binary: "/usr/local/bin/cairn" },
    commands: [
      {
        name: "run",
        summary: "Run a behavioral spec; emit machine-readable result",
        synopsis:
          "cairn run <spec-path> [--env <name>] [--cold-start] [--headed] [--mock] [--format json|yaml|md]",
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
        outputSchema: "https://cairntrace.dev/schemas/run.v1.json",
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
        outputSchema: "https://cairntrace.dev/schemas/explain.v1.json",
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
          "cairn spec verify <spec-path> [--stamp] [--format json|yaml|md]",
        flags: [
          {
            name: "--stamp",
            type: "boolean",
            default: false,
            description: "Write a fresh contractHash into the file",
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
        summary: "Page-evaluated JS returning { ok, evidence }",
        yamlExample:
          "verify:\n  script:\n    run: |\n      const ok = window.someInvariant();\n      return { ok, evidence: null };",
        parameters: [
          {
            name: "fixtures",
            type: "string",
            description: "fixture name → path (object)",
          },
          { name: "run", type: "string", description: "JS body" },
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

function toMarkdown(e: ExplainResult): string {
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
    "## Rules",
    `- cold-start: ${e.rules.coldStart.summary}`,
    `- contract immutability: ${e.rules.contractImmutability.summary}`,
    `- evidence budget: ≤${e.rules.evidenceBudget.maxLines} lines, ≤${e.rules.evidenceBudget.maxListItems} list items`,
    "",
    "## Config",
    `- artifactRoot: ${e.config.artifactRoot}`,
    `- defaultEnvironment: ${e.config.defaultEnvironment}`,
    `- defaultBackend: ${e.config.defaultBackend}`,
  ];
  return lines.join("\n");
}
