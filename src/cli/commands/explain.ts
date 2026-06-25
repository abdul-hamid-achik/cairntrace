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
        summary: "Run behavioral specs; emit machine-readable result",
        synopsis:
          "cairn run <spec-path-or-dir...> [--env <name>] [--cold-start] [--headed] [--mock] [--backend agent-browser|playwright|mock] [--parallel N] [--junit <file>] [--stamp-if-green] [--no-web-server] [--no-services] [--format json|yaml|md]",
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
            name: "--backend",
            type: "enum",
            values: ["agent-browser", "playwright", "mock"],
            default: "agent-browser",
            description: "Browser backend",
          },
          {
            name: "--parallel",
            type: "number",
            default: 1,
            description:
              "Run N specs concurrently, each in its own browser session",
          },
          {
            name: "--junit",
            type: "string",
            description:
              "Write a JUnit XML report for CI. Directory inputs expand recursively, skipping actions/ and _*.yml drafts.",
          },
          {
            name: "--stamp-if-green",
            type: "boolean",
            default: false,
            description:
              "Write fresh contractHash values only after every requested spec passes",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override the artifact root directory",
          },
          {
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value); repeatable, wins over config env vars",
          },
          {
            name: "--no-web-server",
            type: "boolean",
            default: false,
            description:
              "Skip the config `webServer` block (build/boot/ready/teardown) when you manage the server yourself. Otherwise cairn starts it once for the whole invocation, reusing an already-running one unless --cold-start/CI forces a fresh boot.",
          },
          {
            name: "--no-services",
            type: "boolean",
            default: false,
            description:
              "Skip the config `services` block (docker/seed/tmux lifecycle) when you manage the environment yourself.",
          },
          {
            name: "--services-dry-run",
            type: "boolean",
            default: false,
            description:
              "Preview the services lifecycle (docker/seed/tmux) without executing any commands. Prints the plan and returns a no-op handle.",
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
          "2": "errored (browser crash, spec parse failure, webServer boot/setup failure)",
          "3": "cold-start gate not satisfied",
          "6": "contract hash mismatch",
        },
        outputSchema: "urn:cairntrace.dev:run:v1",
      },
      {
        name: "snapshot",
        summary: "Inspect a page and return agent-facing locator inventory",
        synopsis:
          "cairn snapshot <url> [--roles] [--testids] [--env <name>] [--backend agent-browser|playwright|mock] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--roles",
            type: "boolean",
            default: false,
            description:
              "Include accessibility role locators. If neither --roles nor --testids is set, both are included.",
          },
          {
            name: "--testids",
            type: "boolean",
            default: false,
            description:
              "Include data-testid locators. If neither --roles nor --testids is set, both are included.",
          },
          {
            name: "--env",
            type: "string",
            description: "Environment override for config baseUrl",
          },
          {
            name: "--backend",
            type: "enum",
            values: ["agent-browser", "playwright", "mock"],
            default: "agent-browser",
            description: "Browser backend",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml for resolving relative URLs",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "navigation or backend error" },
      },
      {
        name: "clean",
        summary: "Prune old run directories from the artifact root",
        synopsis:
          "cairn clean [--keep <n>] [--all] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--keep",
            type: "number",
            description:
              "Keep the newest N runs per spec (default: config retention.keepRuns, else 10)",
          },
          {
            name: "--all",
            type: "boolean",
            default: false,
            description: "Remove ALL run directories",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Artifact root to clean",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
        ],
        exitCodes: { "0": "success", "2": "bad arguments" },
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
        synopsis:
          "cairn context <run-id|latest> [--path] [--artifact-root <path>] [--config <path>]",
        flags: [
          {
            name: "--path",
            type: "boolean",
            default: false,
            description: "Print the file path instead of contents",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
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
        name: "diff",
        summary:
          "Structurally compare two runs by outcomes, steps, console, and network",
        synopsis:
          "cairn diff <runA> <runB> [--artifact-root <path>] [--config <path>] [--format json|yaml|md] (each arg: run id, absolute path, or 'latest'/'previous')",
        flags: [
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "run not found" },
        outputSchema: "urn:cairntrace.dev:diff:v1",
      },
      {
        name: "checkpoint list",
        summary: "List saved browser-state checkpoints",
        synopsis: "cairn checkpoint list [--format json|yaml|md]",
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
      },
      {
        name: "checkpoint show",
        summary: "Inspect a saved checkpoint",
        synopsis: "cairn checkpoint show <name> [--format json|yaml|md]",
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "no such checkpoint" },
      },
      {
        name: "checkpoint delete",
        summary: "Remove a saved checkpoint",
        synopsis: "cairn checkpoint delete <name>",
        flags: [],
        exitCodes: { "0": "success", "2": "no such checkpoint" },
      },
      {
        name: "checkpoint capture-from-session",
        summary:
          "Save the current state of an existing agent-browser session as a named checkpoint (for spec session.resume)",
        synopsis:
          "cairn checkpoint capture-from-session <name> --session <ab-session>",
        flags: [
          {
            name: "--session",
            type: "string",
            description: "agent-browser --session value to read state from",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
      },
      {
        name: "login",
        summary:
          "Open a headed browser, let a human log in, then capture state into a checkpoint",
        synopsis:
          "cairn login <name> --url <url> [--wait-for text:<...>|url:<...>] [--timeout <ms>]",
        flags: [
          {
            name: "--url",
            type: "string",
            description: "Page to load in the headed browser",
          },
          {
            name: "--wait-for",
            type: "string",
            description:
              "Wait for text:<...> or url:<...> instead of an ENTER keypress",
          },
        ],
        exitCodes: { "0": "checkpoint saved", "2": "error" },
      },
      {
        name: "export playwright",
        summary: "Emit a @playwright/test .spec.ts from a Cairntrace spec",
        synopsis: "cairn export playwright <spec> [--out <file>] [--stdout]",
        flags: [
          {
            name: "--out",
            type: "string",
            description:
              "Where to write (defaults to <spec-dir>/<name>.spec.ts)",
          },
          {
            name: "--stdout",
            type: "boolean",
            default: false,
            description: "Print to stdout instead of writing",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
      },
      {
        name: "import playwright",
        summary:
          "Convert a @playwright/test file into reviewable Cairntrace YAML",
        synopsis:
          "cairn import playwright <file> [--out <file>] [--stdout] [--format json|yaml|md]",
        flags: [
          {
            name: "--out",
            type: "string",
            description:
              "Where to write (defaults to <source-dir>/<test-title>.yml)",
          },
          {
            name: "--stdout",
            type: "boolean",
            default: false,
            description: "Print generated YAML to stdout instead of writing",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Report output format when writing a file",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
      },
      {
        name: "mcp",
        summary:
          "Start the Cairntrace MCP server on stdio (tools mirror this CLI surface)",
        synopsis: "cairn mcp",
        flags: [],
        exitCodes: { "0": "clean shutdown" },
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
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value); repeatable, wins over config env vars",
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
      {
        name: "stash save",
        summary: "Stash a run directory to the fcheap vault",
        synopsis:
          "cairn stash save <run-id> [--tag <tag>] [--tool <name>] [--source <path>] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--tag",
            type: "string",
            description: "Tag for this stash; repeatable",
          },
          {
            name: "--tool",
            type: "string",
            default: "cairntrace",
            description: "Tool name recorded in the stash manifest",
          },
          {
            name: "--source",
            type: "string",
            description: "Source artifact path",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
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
          "0": "success",
          "2": "fcheap not installed or run not found",
        },
      },
      {
        name: "stash list",
        summary: "List stashes in the fcheap vault",
        synopsis:
          "cairn stash list [--tag <tag>] [--tool <name>] [--format json|yaml|md]",
        flags: [
          {
            name: "--tag",
            type: "string",
            description: "Filter by tag",
          },
          {
            name: "--tool",
            type: "string",
            description: "Filter by tool name",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "fcheap not installed" },
      },
      {
        name: "stash info",
        summary: "Get detailed info about a stash",
        synopsis: "cairn stash info <stash-id> [--format json|yaml|md]",
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
          "0": "success",
          "2": "fcheap not installed or stash not found",
        },
      },
      {
        name: "stash restore",
        summary: "Restore a stash to a directory",
        synopsis:
          "cairn stash restore <stash-id> [--to <dir>] [--format json|yaml|md]",
        flags: [
          {
            name: "--to",
            type: "string",
            description: "Target directory (default: a fresh temp dir)",
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
          "0": "success",
          "2": "fcheap not installed or restore failed",
        },
      },
      {
        name: "stash search",
        summary: "Search across all stashed run artifacts",
        synopsis:
          "cairn stash search <query> [--mode keyword|semantic|hybrid] [--limit <n>] [--format json|yaml|md]",
        flags: [
          {
            name: "--mode",
            type: "string",
            description: "Search mode: keyword | semantic | hybrid",
          },
          {
            name: "--limit",
            type: "number",
            default: 20,
            description: "Max results",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "fcheap not installed" },
      },
      {
        name: "investigate",
        summary:
          "Stash a run to fcheap and find code responsible for failures via vecgrep",
        synopsis:
          "cairn investigate <run-id> [--codebase <dir>] [--connect] [--query <q>] [--mode semantic|keyword|hybrid] [--limit <n>] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--codebase",
            type: "string",
            description:
              "Codebase directory to search with fcheap connect (vecgrep)",
          },
          {
            name: "--connect",
            type: "boolean",
            default: false,
            description:
              "Run fcheap connect to find code matches after stashing",
          },
          {
            name: "--query",
            type: "string",
            description: "Override the auto-extracted search query for vecgrep",
          },
          {
            name: "--mode",
            type: "string",
            description: "vecgrep search mode: semantic | keyword | hybrid",
          },
          {
            name: "--limit",
            type: "number",
            default: 10,
            description: "Max code matches to return",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
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
          "0": "success (code matches returned or run stashed without --connect)",
          "2": "fcheap/vecgrep not installed or run not found",
        },
      },
      {
        name: "audit",
        summary:
          "Run a spec with video, extract vidtrace evidence, and find code matches",
        synopsis:
          "cairn audit <spec> [--codebase <dir>] [--connect] [--speed <0.25-4.0>] [--slow-mo <ms>] [--mode semantic|keyword|hybrid] [--limit <n>] [--env <name>] [--cold-start] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--codebase",
            type: "string",
            description:
              "Codebase directory to search with fcheap connect (vecgrep)",
          },
          {
            name: "--connect",
            type: "boolean",
            default: false,
            description:
              "Run fcheap connect to find code matches after stashing",
          },
          {
            name: "--speed",
            type: "number",
            description:
              "Video playback speed multiplier (0.25–4.0; <1 slows, >1 speeds up)",
          },
          {
            name: "--slow-mo",
            type: "number",
            description:
              "Delay in ms between Playwright actions during recording (0–5000)",
          },
          {
            name: "--mode",
            type: "string",
            description: "vecgrep search mode: semantic | keyword | hybrid",
          },
          {
            name: "--limit",
            type: "number",
            default: 10,
            description: "Max code matches to return",
          },
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
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
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
          "0": "success",
          "2": "run failed or fcheap/vecgrep/vidtrace not installed",
        },
      },
      {
        name: "annotate",
        summary: "Pin a note and/or data to a code symbol via codemap annotate",
        synopsis:
          "cairn annotate <symbol> [--note <text>] [--data <json>] [--source <label>] [--from <sym>] [--to <sym>] [--format json|yaml|md]",
        flags: [
          {
            name: "--note",
            type: "string",
            description: "Free-form note text to attach to the symbol",
          },
          {
            name: "--data",
            type: "string",
            description:
              "Opaque data payload (e.g. JSON from a cairntrace run)",
          },
          {
            name: "--source",
            type: "string",
            default: "cairntrace",
            description: "Annotation source label",
          },
          {
            name: "--from",
            type: "string",
            description:
              "Annotate a call path from→to instead of a single symbol",
          },
          {
            name: "--to",
            type: "string",
            description: "Call path end symbol (use with --from)",
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
          "0": "success",
          "2": "codemap not installed or annotation failed",
        },
      },
      {
        name: "secrets",
        summary: "Check TinyVault secrets provider status and available keys",
        synopsis:
          "cairn secrets [--project <name>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--project",
            type: "string",
            description: "TinyVault project name to list keys for",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
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
          "0": "success",
          "2": "tvault not installed or project not found",
        },
      },
      {
        name: "services status",
        summary:
          "Check the status of the services environment (docker, seed freshness, tmux session)",
        synopsis:
          "cairn services status [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
      },
      {
        name: "config validate",
        summary:
          "Validate a cairntrace.config.yml file (structure + cross-field rules)",
        synopsis:
          "cairn config validate [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
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
          "0": "config is valid",
          "4": "config is invalid (schema or cross-field violation)",
        },
      },
    ],
    steps: [
      {
        id: "open",
        kind: "navigation",
        summary:
          "Navigate to a URL or config-resolved path; the object form waits for a load state to beat SPA hydration races",
        yamlExample:
          "steps:\n  - open: /settings\n  - open: { path: /admin, waitUntil: networkidle, timeoutMs: 45000 }",
      },
      {
        id: "click",
        kind: "interaction",
        summary:
          "Activate a locator. Semantic locators match accessible names (whole-name, case-insensitive; `exact: true` for case-sensitive), scroll into view first, fail loudly on zero or ambiguous matches (`nth` picks among several)",
        yamlExample:
          "steps:\n  - click: { by: role, role: button, name: Save }\n  - click: { by: role, role: button, name: Cobrar, nth: 1 }",
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
        id: "request",
        kind: "network",
        summary:
          "Authenticated API call with browser-session cookies and a hard timeout; Playwright runs it out of page with browser-context cookie sharing and an isolated Bun bridge, while backends without native request support use a bounded page-fetch fallback; assign captures the response for ${requests.<name>.body.<field>} splicing into later steps",
        yamlExample:
          "steps:\n  - request: { method: POST, url: /api/qr-token, body: { memberId: 42 }, timeoutMs: 15000, expectStatus: 200, assign: qr }\n  - fill: { by: label, name: Scanner code, value: '${requests.qr.body.token}' }",
      },
      {
        id: "wait",
        kind: "wait",
        summary: "Wait for text, notText, or load state",
        yamlExample: "steps:\n  - wait: { text: Saved, timeoutMs: 10000 }",
      },
      {
        id: "press",
        kind: "interaction",
        summary: "Keyboard key press (e.g. Enter to submit, Control+a)",
        yamlExample: "steps:\n  - press: Enter",
      },
      {
        id: "scroll",
        kind: "interaction",
        summary:
          "Scroll the page by direction/pixels, or bring a locator into view",
        yamlExample:
          "steps:\n  - scroll: { direction: down, px: 600 }\n  - scroll: { to: { by: role, role: button, name: Submit } }",
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
      {
        id: "batch",
        kind: "interaction",
        summary:
          "Run a chain of selector interactions in ONE backend invocation (agent-browser `batch --bail`), so transient UI state (a hover popover, focus) survives long enough to act on it. Sub-steps are selector-only (no semantic locators); the first failing sub-step fails the step",
        yamlExample:
          'steps:\n  - batch:\n      - hover: { by: selector, selector: "#row-actions" }\n      - click: { by: selector, selector: \'button[aria-label="Upload data"]\' }',
      },
    ],
    verifiers: [
      {
        id: "text",
        kind: "ui",
        summary: "Text appears on the page",
        yamlExample:
          "verify:\n  text:\n    contains: dead\n    region: '[data-testid=\"objective-ticker\"]'",
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
            description:
              "optional selector or 'page'; nested under text (legacy sibling region is still accepted)",
          },
        ],
      },
      {
        id: "notText",
        kind: "ui",
        summary: "Text does NOT appear on the page",
        yamlExample:
          'verify:\n  notText:\n    contains: "Something went wrong"\n    region: page',
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
            description:
              "optional selector or 'page'; nested under notText (legacy sibling region is still accepted)",
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
        id: "file",
        kind: "file",
        summary:
          "Poll for a file on disk (file-based test doubles, e.g. local email captures), optionally requiring contained text",
        yamlExample:
          "verify:\n  file:\n    glob: ./mail-captures/*-welcome-*.json\n    contains: Your QR code\n    timeoutMs: 5000",
        parameters: [
          {
            name: "glob",
            type: "string",
            description:
              "Relative to the spec dir; * and ? in the filename only",
          },
          {
            name: "contains",
            type: "string",
            description: "Text the file must contain",
          },
          {
            name: "timeoutMs",
            type: "number",
            default: 10000,
            description: "Poll deadline",
          },
        ],
      },
      {
        id: "httpJson",
        kind: "network",
        summary:
          "Fetch app JSON in the browser session and assert a simple JSON path without a script verifier",
        yamlExample:
          'verify:\n  httpJson:\n    url: /api/test/state?gameId=${requests.game.body.gameId}\n    jsonPath: "$.roshan.alive"\n    equals: false',
        parameters: [
          {
            name: "url",
            type: "string",
            description:
              "URL to fetch; relative paths use config baseUrl or the current page origin",
          },
          {
            name: "jsonPath",
            type: "string",
            default: "$",
            description: "Simple dotted path, e.g. $.game.score",
          },
          { name: "equals", type: "string", oneOfGroup: "matcher" },
          { name: "contains", type: "string", oneOfGroup: "matcher" },
          { name: "matches", type: "regex", oneOfGroup: "matcher" },
          { name: "atLeast", type: "number", oneOfGroup: "matcher" },
          { name: "atMost", type: "number", oneOfGroup: "matcher" },
          { name: "exists", type: "boolean", oneOfGroup: "matcher" },
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
      stepTimeouts: {
        summary:
          "Cairn enforces hard deadlines on backend invocations; request and Playwright wait steps default to 30000ms, Playwright's Bun request bridge plus wait/evaluate paths are parent-bounded, and real Chromium waits/evaluates use an external browser-kill watchdog so hung browser commands fail instead of wedging the run",
        defaultMs: 60_000,
        graceMs: 5_000,
      },
      blockedOutcomes: {
        summary:
          "Outcomes referencing ${artifacts.<name>.…} / ${requests.<name>.…} that a failed step never produced report status `skipped` with blocked evidence, not `failed`",
      },
    },
    config: {
      artifactRoot: join(homedir(), ".cairntrace", "runs"),
      workflowRoots: ["./flows"],
      defaultEnvironment: "local",
      defaultBackend: "agent-browser",
      report: {
        defaultTheme: "cairn",
        themes: ["cairn", "graphite", "midnight", "contrast"],
        artifacts: ["report.html", "report.json"],
      },
      capture: {
        trace: {
          default: "on-failure",
          values: ["always", "on-failure", "never"],
          summary:
            "Playwright trace zip (screenshots + snapshots + sources); on-failure deletes the trace on passing runs",
        },
        video: {
          default: "never",
          values: ["always", "on-failure", "never"],
          summary:
            "Watchable .webm recording (Playwright only); opt in with always or on-failure for audit-grade recordings. Feed to vidtrace for timestamped evidence extraction.",
          slowMo:
            "Delay in ms between Playwright actions (0–5000) so fast clicks are visible in the recording",
          speed:
            "Playback speed multiplier (0.25–4.0); values < 1 slow down via ffmpeg atempo post-processing",
        },
      },
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
    ...(e.rules.stepTimeouts
      ? [`- step timeouts: ${e.rules.stepTimeouts.summary}`]
      : []),
    ...(e.rules.blockedOutcomes
      ? [`- blocked outcomes: ${e.rules.blockedOutcomes.summary}`]
      : []),
    "",
    "## Config",
    `- artifactRoot: ${e.config.artifactRoot}`,
    `- defaultEnvironment: ${e.config.defaultEnvironment}`,
    `- defaultBackend: ${e.config.defaultBackend}`,
    ...(e.config.report
      ? [
          `- reports: ${e.config.report.artifacts.join(", ")} (default theme: ${e.config.report.defaultTheme})`,
        ]
      : []),
    ...(e.config.capture?.trace
      ? [
          `- trace capture: ${e.config.capture.trace.default} (${e.config.capture.trace.values.join(" | ")})`,
        ]
      : []),
    ...(e.config.capture?.video
      ? [
          `- video capture: ${e.config.capture.video.default} (${e.config.capture.video.values.join(" | ")}); slowMo: ${e.config.capture.video.slowMo ?? "n/a"}, speed: ${e.config.capture.video.speed ?? "n/a"}`,
        ]
      : []),
    "",
    "## Agent Docs",
    `- topics: ${DOC_TOPICS.join(", ")}`,
    "- use `cairn docs <topic> --json` or MCP `cairn_docs` for focused guidance",
  ];
  return lines.join("\n");
}
