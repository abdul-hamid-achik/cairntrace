import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execa } from "execa";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { parse as parseYaml, stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { AgentBrowserAdapter } from "../adapters/agent-browser/AgentBrowserAdapter";
import { MockBrowserBackend } from "../adapters/mock/MockBrowserBackend";
import { type ClipOptions } from "../cli/commands/clip";
import { buildDocs, docsToMarkdown } from "../cli/commands/docs";
import { buildExplain } from "../cli/commands/explain";
import { validateConfigFile } from "../cli/commands/config/validate";
import { isFcheapAvailable } from "../cli/commands/stash";
import {
  resolveArtifactRoot,
  resolveRunRef,
  type ArtifactRootOptions,
} from "../cli/runRefs";
import { CheckpointStore } from "../core/checkpoint/CheckpointStore";
import { resolveSpecRuntimeContext } from "../core/config/runtimeContext";
import { computeContractHash } from "../core/contractHash";
import { healSpec } from "../core/healer/Healer";
import { parseSpec } from "../core/parser/parseSpec";
import { runSpec } from "../core/runner/Runner";
import { DocsTopicSchema } from "../core/schema/docs.v1";
import type { RunResult } from "../core/schema/run.v1";
import { SpecSchema } from "../core/schema/spec.v1";
import { CAIRN_VERSION as VERSION } from "../cli/version";

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
        artifactRoot: z
          .string()
          .optional()
          .describe("Override run artifact root directory"),
        config: z
          .string()
          .optional()
          .describe("Explicit cairntrace.config.yml"),
      },
    },
    async ({ runId, artifactRoot, config }) => {
      const resolved = await resolveRunDir(runId ?? "latest", {
        ...(artifactRoot !== undefined ? { artifactRoot } : {}),
        ...(config !== undefined ? { config } : {}),
      });
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

  server.registerTool(
    "cairn_config_validate",
    {
      title: "Validate a cairntrace config file",
      description:
        "Validate the cairntrace.config.yml structure (zod schema) and cross-field rules. " +
        "Returns ok, errors, keys, and a services summary. Exit code 0 = valid, 4 = invalid.",
      inputSchema: {
        config: z
          .string()
          .optional()
          .describe(
            "Path to cairntrace.config.yml (auto-discovers if omitted)",
          ),
      },
    },
    async ({ config }) => {
      try {
        const { result } = await validateConfigFile(config);
        return {
          content: [
            {
              type: "text",
              text: result.ok
                ? `valid: ${result.path}\n` +
                  (result.services
                    ? `services: docker=${result.services.docker} seed=${result.services.seed} tmux=${result.services.tmux} windows=${result.services.tmuxWindows} teardown=${result.services.teardown}`
                    : "")
                : `invalid: ${result.path}\n` +
                  result.errors.map((e) => `  - ${e}`).join("\n"),
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
          isError: !result.ok,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "cairn_services_status",
    {
      title: "Check services environment status",
      description:
        "Check the status of the services environment configured in cairntrace.config.yml: " +
        "docker containers, tmux session windows, and seed freshness. " +
        "Returns a ServicesStatusResult with phase statuses and readiness.",
      inputSchema: {
        config: z
          .string()
          .optional()
          .describe(
            "Path to cairntrace.config.yml (auto-discovers if omitted)",
          ),
      },
    },
    async ({ config }) => {
      try {
        const { getServicesStatus } = await import(
          "../cli/commands/services/status"
        );
        const result = await getServicesStatus({ config });
        return {
          content: [
            {
              type: "text",
              text: result.docker
                ? result.tmux?.session
                  ? `docker: ${
                      result.docker.running ? "running" : "stopped"
                    }\ntmux: session=${result.tmux.session} windows=${result.tmux.windows.length} healthy=${result.tmux.windows.every((w: { healthy?: boolean }) => w.healthy !== false)}`
                  : `docker: ${result.docker.running ? "running" : "stopped"}`
                : result.tmux?.session
                  ? `tmux: session=${result.tmux.session} windows=${result.tmux.windows.length}`
                  : "no services configured",
            },
          ],
          structuredContent: result as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "cairn_stash_save",
    {
      title: "Stash a run to fcheap",
      description:
        "Save a run directory to the fcheap stash vault for persistence, " +
        "sharing, and cross-run search. Requires fcheap on $PATH.",
      inputSchema: {
        runId: z.string().describe("Run id, 'latest', or 'previous'"),
        artifactRoot: z
          .string()
          .optional()
          .describe("Override run artifact root directory"),
        tag: z.array(z.string()).optional().describe("Tags for this stash"),
      },
    },
    async ({ runId, artifactRoot, tag }) => {
      const available = await isFcheapAvailable();
      if (!available) {
        return {
          content: [
            {
              type: "text",
              text: "fcheap not on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/fcheap",
            },
          ],
          isError: true,
        };
      }
      const root = await resolveArtifactRoot(
        artifactRoot ? { artifactRoot } : {},
      );
      const runDir = await resolveRunRef(runId, root);
      // Capture stdout from the stash command by calling the function directly
      const r = await execa(
        "fcheap",
        [
          "save",
          runDir,
          "--tool",
          "cairntrace",
          ...(tag ?? []).flatMap((t) => ["--tag", t]),
          "--json",
        ],
        { reject: false, timeout: 60_000 },
      );
      if (r.exitCode !== 0) {
        return {
          content: [{ type: "text", text: `fcheap save failed: ${r.stderr}` }],
          isError: true,
        };
      }
      const data = JSON.parse(r.stdout);
      return {
        content: [
          {
            type: "text",
            text: `Stashed run ${runId} → ${data.stashId ?? data.id ?? "(unknown)"}`,
          },
        ],
        structuredContent: {
          stashId: data.stashId ?? data.id,
          runId,
          runDir,
          tags: tag ?? [],
        },
      };
    },
  );

  server.registerTool(
    "cairn_stash_list",
    {
      title: "List stashed runs",
      description:
        "List stashes in the fcheap vault, optionally filtered by tag or tool.",
      inputSchema: {
        tag: z.string().optional().describe("Filter by tag"),
        tool: z.string().optional().describe("Filter by tool name"),
      },
    },
    async ({ tag, tool }) => {
      const available = await isFcheapAvailable();
      if (!available) {
        return {
          content: [
            {
              type: "text",
              text: "fcheap not on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/fcheap",
            },
          ],
          isError: true,
        };
      }
      const args = ["list", "--json"];
      if (tag) args.push("--tag", tag);
      if (tool) args.push("--tool", tool);
      const r = await execa("fcheap", args, {
        reject: false,
        timeout: 60_000,
      });
      if (r.exitCode !== 0) {
        return {
          content: [{ type: "text", text: `fcheap list failed: ${r.stderr}` }],
          isError: true,
        };
      }
      const stashes = JSON.parse(r.stdout);
      return {
        content: [
          {
            type: "text",
            text:
              Array.isArray(stashes) && stashes.length > 0
                ? stashes
                    .map(
                      (s: { id: string; tool?: string; tags?: string[] }) =>
                        `- ${s.id}${s.tool ? ` (${s.tool})` : ""}${
                          s.tags?.length ? ` [${s.tags.join(", ")}]` : ""
                        }`,
                    )
                    .join("\n")
                : "(no stashes)",
          },
        ],
        structuredContent: { stashes },
      };
    },
  );

  server.registerTool(
    "cairn_stash_search",
    {
      title: "Search stashed runs",
      description:
        "Search across all stashed run artifacts in the fcheap vault. " +
        "Supports keyword (default), semantic, and hybrid search modes.",
      inputSchema: {
        query: z.string().describe("Search query"),
        mode: z
          .string()
          .optional()
          .describe(
            "Search mode: keyword | semantic | hybrid (default: hybrid)",
          ),
        limit: z.number().optional().describe("Max results (default 20)"),
      },
    },
    async ({ query, mode, limit }) => {
      const available = await isFcheapAvailable();
      if (!available) {
        return {
          content: [
            {
              type: "text",
              text: "fcheap not on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/fcheap",
            },
          ],
          isError: true,
        };
      }
      const args = ["search", query, "--json"];
      if (mode) args.push("--mode", mode);
      if (limit) args.push("--limit", String(limit));
      const r = await execa("fcheap", args, {
        reject: false,
        timeout: 60_000,
      });
      if (r.exitCode !== 0) {
        return {
          content: [
            { type: "text", text: `fcheap search failed: ${r.stderr}` },
          ],
          isError: true,
        };
      }
      const results = JSON.parse(r.stdout);
      return {
        content: [
          {
            type: "text",
            text:
              Array.isArray(results) && results.length > 0
                ? results
                    .map(
                      (s: {
                        stashId: string;
                        snippet: string;
                        score?: number;
                      }) =>
                        `- ${s.stashId}${
                          s.score ? ` (${s.score.toFixed(2)})` : ""
                        }: ${s.snippet}`,
                    )
                    .join("\n")
                : `(no results for "${query}")`,
          },
        ],
        structuredContent: { query, results },
      };
    },
  );

  /* ----- clip ----- */

  server.registerTool(
    "cairn_clip",
    {
      title: "Cut video clips from a run",
      description:
        "Resolve a run directory, find the recorded video, and use vidtrace " +
        "to cut named clips. Clips are moved into the run directory so they " +
        "are relative to run artifacts. Requires vidtrace on $PATH.",
      inputSchema: {
        runId: z.string().describe("Run id, 'latest', or 'previous'"),
        labels: z
          .array(z.string())
          .describe("Clip labels as name=start-end (e.g. 'issue=0:18-3:40')"),
        out: z.string().optional().describe("Clip output directory"),
        name: z.string().optional().describe("Clip filename prefix"),
        stash: z
          .boolean()
          .optional()
          .describe("Stash the run directory to fcheap after cutting clips"),
        tags: z.array(z.string()).optional().describe("Stash tags"),
        reencode: z
          .boolean()
          .optional()
          .describe("Re-encode clips instead of stream-copy"),
      },
    },
    async (args) => {
      const opts: ClipOptions = {
        labels: args.labels as string[],
        ...(args.out !== undefined ? { out: args.out as string } : {}),
        ...(args.name !== undefined ? { name: args.name as string } : {}),
        ...(args.stash !== undefined ? { stash: args.stash as boolean } : {}),
        ...(args.tags !== undefined ? { tags: args.tags as string[] } : {}),
        ...(args.reencode !== undefined
          ? { reencode: args.reencode as boolean }
          : {}),
      };
      // clipCommand writes to stdout; capturing process output isn't
      // feasible here, so we re-implement the minimal clip flow using the same
      // core helpers as the CLI command.
      const {
        resolveArtifactRoot: resolveArtifactRootForClip,
        resolveRunRef: resolveRunRefForClip,
      } = await import("../cli/runRefs");
      const root = await resolveArtifactRootForClip();
      const runDir = await resolveRunRefForClip(args.runId as string, root);
      const runId =
        args.runId === "latest" || args.runId === "previous"
          ? (runDir.split("/").pop() ?? (args.runId as string))
          : (args.runId as string);

      const { existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      const videoCandidates = [
        resolve(runDir, "videos", "playwright-video.webm"),
        resolve(runDir, "videos", "agent-browser-video.webm"),
      ];
      const sourceVideo = videoCandidates.find((p) => existsSync(p));
      if (!sourceVideo) {
        return {
          content: [{ type: "text", text: "no run video found in videos/" }],
          isError: true,
        };
      }

      const {
        cutClipsWithVidtrace,
        isVidtraceAvailable,
        moveClipsIntoRunDir,
        parseClipLabel,
      } = await import("../core/clip/vidtraceClip");
      const vidtrace = await isVidtraceAvailable();
      if (!vidtrace.available) {
        return {
          content: [
            {
              type: "text",
              text: "vidtrace not found on $PATH. Install: brew install --no-quarantine abdul-hamid-achik/tap/vidtrace",
            },
          ],
          isError: true,
        };
      }

      const labels = (args.labels as string[])
        .map((l) => parseClipLabel(l))
        .filter(Boolean) as Array<{
        label: string;
        start: string;
        end: string;
      }>;
      if (labels.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: "no valid labels provided (expected name=start-end)",
            },
          ],
          isError: true,
        };
      }

      const cutResult = await cutClipsWithVidtrace(sourceVideo, labels, {
        outputDir: opts.out ? resolve(opts.out) : undefined,
        name: opts.name,
        stash: opts.stash,
        tags: opts.tags,
        reencode: opts.reencode,
      });
      if (!cutResult.ok) {
        return {
          content: [{ type: "text", text: cutResult.error ?? "clip failed" }],
          isError: true,
        };
      }

      const clips = await moveClipsIntoRunDir(runDir, cutResult);

      let stashId: string | undefined;
      if (opts.stash) {
        const { stashDirectory } = await import("../cli/commands/stash");
        const stashResult = await stashDirectory(runDir, {
          tags: [...(opts.tags ?? []), "vidtrace-clip", "mcp"],
          tool: "cairntrace",
          source: sourceVideo,
        });
        if (stashResult?.ok && stashResult.stashId) {
          stashId = stashResult.stashId;
        }
      }

      return {
        content: [
          {
            type: "text",
            text:
              `Cut ${Object.keys(clips).length} clip(s) from ${runId}\n` +
              Object.entries(clips)
                .map(([label, path]) => `- ${label}: ${path}`)
                .join("\n") +
              (stashId ? `\nStash: ${stashId}` : ""),
          },
        ],
        structuredContent: { runId, runDir, clips, stashId },
      };
    },
  );

  /* ----- investigate ----- */

  server.registerTool(
    "cairn_investigate",
    {
      title: "Investigate a run for code matches",
      description:
        "Stash a run directory to fcheap and run fcheap connect (vecgrep) to " +
        "find file:line code candidates responsible for the failure. " +
        "Requires fcheap + vecgrep on $PATH.",
      inputSchema: {
        runId: z.string().describe("Run id, 'latest', or 'previous'"),
        codebase: z
          .string()
          .describe("Absolute path to the codebase to search"),
        mode: z
          .string()
          .optional()
          .describe("vecgrep mode: semantic, keyword, or hybrid (default)"),
        limit: z.number().optional().describe("Max code matches (default 10)"),
      },
    },
    async (args) => {
      const { runId, codebase } = args as {
        runId: string;
        codebase: string;
        mode?: string;
        limit?: number;
      };

      const root = await resolveArtifactRoot();
      let runDir: string;
      try {
        runDir = await resolveRunRef(runId, root);
      } catch {
        return {
          content: [{ type: "text", text: `Run "${runId}" not found` }],
          isError: true,
        };
      }

      // Stash the run
      const stashR = await execa(
        "fcheap",
        ["save", runDir, "--tool", "cairntrace", "--json"],
        { reject: false, timeout: 60_000 },
      );
      if (stashR.exitCode !== 0) {
        return {
          content: [
            { type: "text", text: `fcheap save failed: ${stashR.stderr}` },
          ],
          isError: true,
        };
      }

      const stashData = JSON.parse(stashR.stdout);
      const stashId = stashData.stashId ?? stashData.id ?? stashData.path;

      // Connect to codebase
      const connectArgs = ["connect", stashId, codebase, "--json"];
      if (args.mode) connectArgs.push("--mode", args.mode);
      if (args.limit) connectArgs.push("--limit", String(args.limit));

      const connectR = await execa("fcheap", connectArgs, {
        reject: false,
        timeout: 120_000,
      });
      if (connectR.exitCode !== 0) {
        return {
          content: [
            { type: "text", text: `fcheap connect failed: ${connectR.stderr}` },
          ],
          isError: true,
        };
      }

      const matches = JSON.parse(connectR.stdout);
      const codeMatches = Array.isArray(matches)
        ? matches
        : (matches?.matches ?? []);

      return {
        content: [
          {
            type: "text",
            text:
              codeMatches.length > 0
                ? codeMatches
                    .map(
                      (m: { file?: string; line?: number; score?: number }) =>
                        `- ${m.file ?? "?"}:${m.line ?? 0}${
                          m.score ? ` (${m.score.toFixed(2)})` : ""
                        }`,
                    )
                    .join("\n")
                : "(no code matches found)",
          },
        ],
        structuredContent: {
          runId,
          stashId,
          codeMatches: codeMatches,
        },
      };
    },
  );

  /* ----- audit ----- */

  server.registerTool(
    "cairn_audit",
    {
      title: "Audit a spec end-to-end (run + video + vidtrace + code matches)",
      description:
        "Run a spec with video recording, extract vidtrace evidence from " +
        "the recording, stash to fcheap, and run fcheap connect to find " +
        "code responsible for failures. Requires playwright + fcheap + vecgrep. " +
        "vidtrace is optional (skipped if not installed).",
      inputSchema: {
        specPath: z.string().describe("Path to the spec YAML file"),
        codebase: z
          .string()
          .describe("Absolute path to the codebase to search"),
        speed: z
          .number()
          .optional()
          .describe("Video playback speed 0.25-4.0 (default: none)"),
        slowMo: z
          .number()
          .optional()
          .describe("Delay in ms between actions during recording (0-5000)"),
        mode: z
          .string()
          .optional()
          .describe("vecgrep mode: semantic, keyword, or hybrid (default)"),
        limit: z.number().optional().describe("Max code matches (default 10)"),
        env: z.string().optional().describe("Environment name override"),
        coldStart: z
          .boolean()
          .optional()
          .describe("Clear browser state before running (default: true)"),
      },
    },
    async (args) => {
      const specPath = args.specPath as string;
      const codebase = args.codebase as string;

      const { auditCommand } = await import("../cli/commands/investigate");
      const opts: Record<string, unknown> = {
        codebase,
        connect: true,
        coldStart: args.coldStart ?? true,
      };
      if (args.speed !== undefined) opts.speed = args.speed;
      if (args.slowMo !== undefined) opts.slowMo = args.slowMo;
      if (args.mode !== undefined) opts.mode = args.mode;
      if (args.limit !== undefined) opts.limit = args.limit;
      if (args.env !== undefined) opts.env = args.env;

      // The audit command writes to stdout; we capture it by running with json format
      opts.json = true;

      await auditCommand(specPath, opts as never);
      return {
        content: [
          {
            type: "text",
            text: "Audit complete. See run artifacts for video, vidtrace evidence, and code matches.",
          },
        ],
      };
    },
  );

  /* ----- annotate (codemap) ----- */

  server.registerTool(
    "cairn_annotate",
    {
      title: "Annotate a code symbol with cairntrace findings",
      description:
        "Pin a note and/or external data (e.g. a cairntrace run finding) " +
        "to a code symbol via codemap annotate. Requires codemap on $PATH. " +
        "Persists across reindex — builds a knowledge layer over the code graph.",
      inputSchema: {
        symbol: z
          .string()
          .describe("Symbol name (FQN) or file:line to annotate"),
        note: z.string().describe("Free-form note text"),
        source: z
          .string()
          .optional()
          .describe("Source label (default: cairntrace)"),
        data: z
          .string()
          .optional()
          .describe("Opaque data payload (e.g. JSON from a cairntrace run)"),
      },
    },
    async (args) => {
      const symbol = args.symbol as string;
      const note = args.note as string;
      const source = (args.source as string | undefined) ?? "cairntrace";
      const data = args.data as string | undefined;

      // Check codemap availability
      let codemapOk = false;
      try {
        const r = await execa("codemap", ["version"], { reject: false });
        codemapOk = r.exitCode === 0;
      } catch {
        // not installed
      }

      if (!codemapOk) {
        return {
          content: [
            {
              type: "text",
              text: "codemap not on $PATH. Install: brew install abdul-hamid-achik/tap/codemap",
            },
          ],
          isError: true,
        };
      }

      const annotateArgs = [
        "annotate",
        symbol,
        "--source",
        source,
        "--note",
        note,
        ...(data ? ["--data", data] : []),
        "--json",
      ];

      try {
        const r = await execa("codemap", annotateArgs, {
          reject: false,
          timeout: 30_000,
        });
        if (r.exitCode !== 0) {
          return {
            content: [
              { type: "text", text: `codemap annotate failed: ${r.stderr}` },
            ],
            isError: true,
          };
        }
        const result = JSON.parse(r.stdout);
        return {
          content: [
            {
              type: "text",
              text: `Annotated ${symbol} (id: ${result.id ?? "?"})${
                result.matched === false
                  ? " — symbol not indexed, saved for later"
                  : ""
              }`,
            },
          ],
          structuredContent: {
            symbol,
            source,
            note,
            ...(data ? { data } : {}),
            annotationId: result.id,
            matched: result.matched ?? true,
          },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `codemap annotate error: ${(e as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  /* ----- secrets (TinyVault) ----- */

  server.registerTool(
    "cairn_secrets_status",
    {
      title: "Check TinyVault secrets provider status",
      description:
        "Check if tvault is installed and list available secret keys from " +
        "a TinyVault project or environment group. Returns metadata only — " +
        "secret values are never returned to the AI context. Use " +
        "vault_run_with_secrets for actual secret injection.",
      inputSchema: {
        project: z
          .string()
          .optional()
          .describe("TinyVault project name (direct mode)"),
        group: z
          .string()
          .optional()
          .describe(
            "TinyVault environment group name (inheritance mode; requires env)",
          ),
        env: z
          .string()
          .optional()
          .describe("Environment name within the group (requires group)"),
      },
    },
    async (args) => {
      const project = args.project as string | undefined;
      const group = args.group as string | undefined;
      const env = args.env as string | undefined;

      let tvaultOk = false;
      try {
        const r = await execa("tvault", ["--version"], { reject: false });
        tvaultOk = r.exitCode === 0;
      } catch {
        // not installed
      }

      const result: {
        provider: string;
        tvaultInstalled: boolean;
        target?: string;
        keys: string[];
        error?: string;
      } = {
        provider: tvaultOk ? "tvault" : "env",
        tvaultInstalled: tvaultOk,
        keys: [],
      };

      const hasProject = !!project;
      const hasGroup = !!group;
      const hasEnv = !!env;

      if (tvaultOk && hasProject && !hasGroup && !hasEnv) {
        try {
          const r = await execa(
            "tvault",
            ["list", "--project", project, "--json"],
            { reject: false, timeout: 10_000 },
          );
          if (r.exitCode === 0) {
            const data = JSON.parse(r.stdout);
            result.target = project;
            result.keys = Array.isArray(data)
              ? data
                  .map((k: string | { key?: string }) =>
                    typeof k === "string" ? k : (k.key ?? ""),
                  )
                  .filter(Boolean)
              : (data?.secrets?.map((s: { key: string }) => s.key) ?? []);
          } else {
            result.error = r.stderr || "tvault list failed";
          }
        } catch (e) {
          result.error = (e as Error).message;
        }
      } else if (tvaultOk && hasGroup && hasEnv && !hasProject) {
        // Group mode: tvault list doesn't support --group/--env.
        // Use tvault env to get resolved keys (values discarded).
        try {
          const r = await execa(
            "tvault",
            ["env", "--group", group, "--env", env, "--format", "json"],
            { reject: false, timeout: 10_000 },
          );
          if (r.exitCode === 0) {
            const data = JSON.parse(r.stdout);
            result.target = `${group}/${env}`;
            result.keys = Object.keys(data).toSorted();
          } else {
            result.error = r.stderr || "tvault env failed";
          }
        } catch (e) {
          result.error = (e as Error).message;
        }
      } else if (tvaultOk && (hasProject || hasGroup || hasEnv)) {
        result.error = "specify either project or both group+env — not both";
      } else if (tvaultOk) {
        result.error = "pass project or group+env to list keys";
      }

      const textLines = [
        `secrets: ${result.provider}`,
        `tvault: ${result.tvaultInstalled ? "installed" : "not on $PATH"}`,
        ...(result.target ? [`target: ${result.target}`] : []),
        `keys: ${
          result.keys.length > 0
            ? result.keys.join(", ")
            : "(none or not checked)"
        }`,
        ...(result.error ? [`error: ${result.error}`] : []),
      ];

      return {
        content: [
          {
            type: "text",
            text: textLines.join("\n"),
          },
        ],
        structuredContent: result,
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
    ["fcheap", ["--version"]],
    ["vecgrep", ["version"]],
    ["vidtrace", ["version"]],
    ["codemap", ["version"]],
    ["tvault", ["--version"]],
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
  opts: ArtifactRootOptions = {},
): Promise<{ runId: string; runDir: string } | undefined> {
  const root = await resolveArtifactRoot(opts);
  try {
    const runDir = await resolveRunRef(ref, root);
    return { runId: basename(runDir), runDir };
  } catch {
    return undefined;
  }
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
