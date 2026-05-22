import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execa } from "execa";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve as resolvePath } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { AgentBrowserAdapter } from "../adapters/agent-browser/AgentBrowserAdapter";
import { MockBrowserBackend } from "../adapters/mock/MockBrowserBackend";
import { buildDocs, docsToMarkdown } from "../cli/commands/docs";
import { buildExplain } from "../cli/commands/explain";
import { CheckpointStore } from "../core/checkpoint/CheckpointStore";
import { resolveSpecRuntimeContext } from "../core/config/runtimeContext";
import { computeContractHash } from "../core/contractHash";
import { healSpec } from "../core/healer/Healer";
import { parseSpec } from "../core/parser/parseSpec";
import { runSpec } from "../core/runner/Runner";
import { DocsTopicSchema } from "../core/schema/docs.v1";
import type { RunResult } from "../core/schema/run.v1";
import { SpecSchema } from "../core/schema/spec.v1";

const VERSION = "1.2.0";

/**
 * Build a Cairntrace MCP server. The CLI's `cairn mcp` subcommand connects this
 * to an stdio transport so MCP-aware agents (Claude Code, Cursor, Windsurf) can
 * invoke Cairntrace tools natively without shelling out and parsing stdout.
 *
 * Tools mirror the CLI surface but return JSON-typed `structuredContent`
 * alongside short text summaries for the agent's chat-side rendering.
 */
export function buildMcpServer(): McpServer {
  const server = new McpServer({ name: "cairntrace", version: VERSION });

  server.registerTool(
    "cairn_explain",
    {
      title: "Explain Cairntrace surface",
      description:
        "Returns the agent-facing surface: full command list with flags and " +
        "exit codes, step and verifier vocabulary, rules, and config. " +
        "Call this once at session start. Output matches the v1 ExplainResult " +
        "schema (same as `cairn explain --json`).",
      inputSchema: {},
    },
    async () => {
      // Use the same canonical doc the CLI emits so MCP and shell agents
      // bootstrap with identical surface info.
      const doc = buildExplain();
      return {
        content: [
          {
            type: "text",
            text:
              `Cairntrace ${doc.cairntrace.version}\n` +
              `Commands: ${doc.commands.map((c) => c.name).join(", ")}\n` +
              `Steps: ${doc.steps.map((s) => s.id).join(", ")}\n` +
              `Verifiers: ${doc.verifiers.map((v) => v.id).join(", ")}`,
          },
        ],
        structuredContent: doc as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "cairn_docs",
    {
      title: "Read Cairntrace docs",
      description:
        "Return focused agent documentation for one topic. Use this after " +
        "`cairn_explain` when authoring specs, choosing steps/verifiers, " +
        "or understanding artifacts, MCP, and backends.",
      inputSchema: {
        topic: DocsTopicSchema.optional().describe(
          "Docs topic; defaults to overview",
        ),
      },
    },
    async ({ topic }) => {
      const doc = buildDocs(topic ?? "overview");
      return {
        content: [{ type: "text", text: docsToMarkdown(doc) }],
        structuredContent: doc as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "cairn_doctor",
    {
      title: "Health check",
      description: "Verify node, bun, agent-browser, and artifact root.",
      inputSchema: {},
    },
    async () => {
      const checks = await runDoctorChecks();
      const ok = checks.every((c) => c.ok);
      return {
        content: [
          {
            type: "text",
            text:
              `doctor: ${ok ? "OK" : "issues"}\n` +
              checks
                .map((c) => `${c.ok ? "✓" : "✗"} ${c.name}: ${c.detail}`)
                .join("\n"),
          },
        ],
        structuredContent: { ok, checks },
        isError: !ok,
      };
    },
  );

  server.registerTool(
    "cairn_run",
    {
      title: "Run a behavioral spec",
      description:
        "Execute a Cairntrace spec end-to-end. Returns the structured RunResult " +
        "(v1 schema). When mock=true, uses the in-memory backend (fast smoke).",
      inputSchema: {
        path: z.string().describe("Path to the spec YAML"),
        env: z.string().optional().describe("Environment name override"),
        mock: z.boolean().optional().describe("Use mock backend"),
        coldStart: z
          .boolean()
          .optional()
          .describe("Wipe browser state before steps"),
        artifactRoot: z
          .string()
          .optional()
          .describe("Override run artifact root directory"),
      },
    },
    async ({ path, env, mock, coldStart, artifactRoot }) => {
      const backend = mock
        ? new MockBrowserBackend()
        : new AgentBrowserAdapter({
            session: `cairntrace-mcp-${process.pid}`,
          });
      try {
        const result = await runSpec({
          specPath: path,
          backend,
          ...(env !== undefined ? { environmentOverride: env } : {}),
          ...(coldStart !== undefined ? { coldStart } : {}),
          ...(artifactRoot !== undefined ? { artifactRoot } : {}),
        });
        return {
          content: [{ type: "text", text: summarizeRun(result) }],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: result.status !== "passed",
        };
      } finally {
        await backend.close().catch(() => undefined);
      }
    },
  );

  server.registerTool(
    "cairn_context",
    {
      title: "Get agent_context.md for a run",
      description:
        "Return the agent_context.md markdown for the given run id, or 'latest'.",
      inputSchema: {
        runId: z
          .string()
          // Reject `..` and other separators so the runId can't escape the
          // ~/.cairntrace/runs/ root via path traversal. Real run ids are
          // produced by generateRunId() and match this pattern.
          .regex(
            /^(?:latest|[A-Za-z0-9._-]+)$/,
            "runId must be 'latest' or contain only letters, digits, dot, hyphen, underscore",
          )
          .optional()
          .describe("Run id; defaults to 'latest'"),
      },
    },
    async ({ runId }) => {
      const resolved = await resolveRunDir(runId ?? "latest");
      if (!resolved) {
        return {
          content: [{ type: "text", text: "no runs found" }],
          isError: true,
        };
      }
      const text = await readFile(
        `${resolved.runDir}/agent_context.md`,
        "utf8",
      );
      return {
        content: [{ type: "text", text }],
        structuredContent: {
          runId: resolved.runId,
          runDir: resolved.runDir,
          agentContextPath: `${resolved.runDir}/agent_context.md`,
        },
      };
    },
  );

  server.registerTool(
    "cairn_spec_scaffold",
    {
      title: "Scaffold a starter spec",
      description:
        "Write a new behavioral spec YAML at <out>/<name>.yml with intent + a placeholder outcome.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .describe("snake_case spec name"),
        intent: z.string().min(1).describe("One-line intent statement"),
        out: z.string().optional().describe("Output dir (default ./flows)"),
      },
    },
    async ({ name, intent, out }) => {
      const path = await writeScaffold(name, intent, out);
      return {
        content: [{ type: "text", text: `Wrote scaffold: ${path}` }],
        structuredContent: { path, name },
      };
    },
  );

  server.registerTool(
    "cairn_spec_verify",
    {
      title: "Verify a spec",
      description:
        "Lint the spec. With stamp=true, write a fresh contractHash into the file.",
      inputSchema: {
        path: z.string(),
        stamp: z.boolean().optional(),
        env: z.string().optional().describe("Environment name override"),
        config: z.string().optional().describe("Explicit config path"),
      },
    },
    async ({ path, stamp, env, config }) => {
      try {
        if (stamp) {
          const hash = await stampContractHash(path);
          return {
            content: [{ type: "text", text: `Stamped contractHash: ${hash}` }],
            structuredContent: { status: "stamped", contractHash: hash, path },
          };
        }
        const runtime = await resolveSpecRuntimeContext(path, {
          ...(env !== undefined ? { envOverride: env } : {}),
          ...(config !== undefined ? { configPath: config } : {}),
        });
        const r = await parseSpec(path, {
          vars: runtime.vars,
          ...(runtime.baseUrl ? { baseUrl: runtime.baseUrl } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text:
                `valid: ${path}\n` +
                `contractHash: ${r.spec.contractHash ?? "(not stamped)"}`,
            },
          ],
          structuredContent: {
            status: "valid",
            path,
            contractHash: r.spec.contractHash,
          },
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `invalid: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "cairn_spec_heal",
    {
      title: "Heal selector drift in a spec",
      description:
        "Run the spec, parse the snapshot, propose JSON-Pointer ops for role+name drift. With apply=true, write the fix back (comments preserved).",
      inputSchema: {
        path: z.string(),
        apply: z.boolean().optional(),
        mock: z.boolean().optional(),
      },
    },
    async ({ path, apply, mock }) => {
      const backend = mock
        ? new MockBrowserBackend()
        : new AgentBrowserAdapter({
            session: `cairntrace-mcp-heal-${process.pid}`,
          });
      try {
        const out = await healSpec({
          specPath: path,
          backend,
          ...(apply !== undefined ? { apply } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text:
                `${out.status}: ${out.summary}\n` +
                out.ops
                  .map(
                    (op) =>
                      `  ${op.op} ${op.path} → ${JSON.stringify(
                        (op as { to?: unknown }).to ??
                          (op as { value?: unknown }).value,
                      )}`,
                  )
                  .join("\n"),
            },
          ],
          structuredContent: out as unknown as Record<string, unknown>,
          isError: out.status === "no-heal-possible",
        };
      } finally {
        await backend.close().catch(() => undefined);
      }
    },
  );

  server.registerTool(
    "cairn_checkpoint_list",
    {
      title: "List saved checkpoints",
      description:
        "Returns named checkpoints at ~/.cairntrace/checkpoints/ (sorted by mtime desc).",
      inputSchema: {},
    },
    async () => {
      const store = new CheckpointStore();
      const list = await store.list();
      return {
        content: [
          {
            type: "text",
            text:
              list.length === 0
                ? "(no checkpoints)"
                : list
                    .map(
                      (c) =>
                        `- ${c.name} — ${(c.sizeBytes / 1024).toFixed(1)} KB — ${c.modifiedAt.toISOString()}`,
                    )
                    .join("\n"),
          },
        ],
        structuredContent: {
          root: store.root,
          checkpoints: list.map((c) => ({
            name: c.name,
            path: c.path,
            sizeBytes: c.sizeBytes,
            modifiedAt: c.modifiedAt.toISOString(),
          })),
        },
      };
    },
  );

  server.registerTool(
    "cairn_checkpoint_show",
    {
      title: "Inspect a saved checkpoint",
      description:
        "Return the metadata + first 400 bytes of a named checkpoint file.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-_]*$/i)
          .describe("checkpoint name (letters, digits, hyphen, underscore)"),
      },
    },
    async ({ name }) => {
      const store = new CheckpointStore();
      const summary = await store.show(name);
      if (!summary) {
        return {
          content: [{ type: "text", text: `no checkpoint named "${name}"` }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `${summary.name} — ${(summary.sizeBytes / 1024).toFixed(1)} KB — ${summary.modifiedAt.toISOString()}\n` +
              `${summary.path}\n\n${summary.preview}`,
          },
        ],
        structuredContent: {
          name: summary.name,
          path: summary.path,
          sizeBytes: summary.sizeBytes,
          modifiedAt: summary.modifiedAt.toISOString(),
          preview: summary.preview,
        },
      };
    },
  );

  server.registerTool(
    "cairn_checkpoint_delete",
    {
      title: "Delete a saved checkpoint",
      description:
        "Remove a checkpoint by name from ~/.cairntrace/checkpoints/.",
      inputSchema: {
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-_]*$/i)
          .describe("checkpoint name"),
      },
    },
    async ({ name }) => {
      const store = new CheckpointStore();
      const ok = await store.delete(name);
      return {
        content: [
          {
            type: "text",
            text: ok ? `deleted ${name}` : `no checkpoint named "${name}"`,
          },
        ],
        structuredContent: { name, deleted: ok },
        isError: !ok,
      };
    },
  );

  return server;
}

/* ----- helpers (inlined from CLI counterparts) ----- */

async function runDoctorChecks(): Promise<
  Array<{ name: string; ok: boolean; detail: string }>
> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    { name: "node", ok: true, detail: `node ${process.versions.node}` },
  ];
  for (const [name, args] of [
    ["bun", ["--version"]],
    ["agent-browser", ["--version"]],
  ] as const) {
    try {
      const r = await execa(name, args, { reject: false });
      checks.push({
        name,
        ok: r.exitCode === 0,
        detail:
          r.exitCode === 0
            ? `${name} ${typeof r.stdout === "string" ? r.stdout.trim() : ""}`
            : `${name} not on $PATH`,
      });
    } catch {
      checks.push({ name, ok: false, detail: `${name} not on $PATH` });
    }
  }
  return checks;
}

async function resolveRunDir(
  ref: string,
): Promise<{ runId: string; runDir: string } | undefined> {
  const root = join(homedir(), ".cairntrace", "runs");
  if (ref === "latest") {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch {
      return undefined;
    }
    const dirs = await Promise.all(
      entries.map(async (name) => {
        try {
          const s = await stat(join(root, name));
          return { name, mtime: s.mtimeMs, isDir: s.isDirectory() };
        } catch {
          return { name, mtime: 0, isDir: false };
        }
      }),
    );
    const latest = dirs
      .filter((d) => d.isDir)
      .toSorted((a, b) => b.mtime - a.mtime)[0];
    if (!latest) return undefined;
    return { runId: latest.name, runDir: join(root, latest.name) };
  }
  return { runId: ref, runDir: join(root, ref) };
}

async function writeScaffold(
  name: string,
  intent: string,
  out: string | undefined,
): Promise<string> {
  const outDir = out
    ? isAbsolute(out)
      ? out
      : resolvePath(process.cwd(), out)
    : resolvePath(process.cwd(), "flows");
  const path = join(outDir, `${name}.yml`);
  await mkdir(outDir, { recursive: true });
  const spec = {
    version: 1,
    name,
    intent: intent.trim(),
    outcomes: [
      {
        id: "placeholder",
        description:
          "TODO — replace this with a real behavioral outcome before running.",
        verify: { text: { contains: "TODO_replace_me" } },
      },
    ],
    steps: [],
  };
  const header =
    [
      "# Cairntrace behavioral spec (scaffolded via MCP).",
      "# Outcomes are the contract; steps are repairable hints.",
      "# Run `cairn spec verify <file> --stamp` after editing to lock the contractHash.",
    ].join("\n") + "\n";
  await writeFile(
    path,
    header + yamlStringify(spec, { indent: 2, lineWidth: 100 }),
  );
  return path;
}

async function stampContractHash(path: string): Promise<string> {
  const text = await readFile(path, "utf8");
  const raw = parseYaml(text);
  const spec = SpecSchema.parse(raw);
  const hash = computeContractHash(spec);
  const updated = { ...spec, contractHash: hash };
  // Preserve any leading comment lines so stamping doesn't strip docs.
  const header = extractLeadingComments(text);
  await writeFile(
    path,
    header + yamlStringify(updated, { indent: 2, lineWidth: 100 }),
  );
  return hash;
}

function extractLeadingComments(text: string): string {
  const lines = text.split("\n");
  const keep: string[] = [];
  for (const line of lines) {
    if (line.startsWith("#") || line.trim() === "") keep.push(line);
    else break;
  }
  return keep.length > 0 ? keep.join("\n") + "\n" : "";
}

function summarizeRun(r: RunResult): string {
  const passed = r.outcomes.filter((o) => o.status === "passed").length;
  return [
    `${r.status.toUpperCase()}: ${r.spec.name} (${passed}/${r.outcomes.length} outcomes, ${r.durationMs}ms)`,
    ...r.outcomes.map(
      (o) =>
        `  ${
          o.status === "passed" ? "✓" : o.status === "failed" ? "✗" : "·"
        } ${o.id}${o.evidence ? ` (${o.evidence})` : ""}`,
    ),
    `Run dir: ${r.runDir}`,
  ].join("\n");
}
