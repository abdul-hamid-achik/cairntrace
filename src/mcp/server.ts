import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { execa } from "execa";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, isAbsolute, join, resolve as resolvePath } from "node:path";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { type ClipOptions, stashClipRun } from "../cli/commands/clip";
import { resolveSnapshotTarget } from "../cli/commands/snapshot";
import { redactBrowseUrl } from "../core/discovery/browseTarget";
import { buildDocs, docsToMarkdown } from "../cli/commands/docs";
import {
  resolveFcheapChecks,
  resolvePlaywrightChecks,
} from "../cli/commands/doctor";
import { buildExplain } from "../cli/commands/explain";
import {
  auditResultExitCode,
  auditSpec,
  investigateRunRef,
} from "../cli/commands/investigate";
import { validateConfigFile } from "../cli/commands/config/validate";
import {
  isFcheapAvailable,
  loadStashConfig,
  parseIncludeFlag,
  stashRunDirectory,
  stashTagsForRun,
} from "../cli/commands/stash";
import { pinRunRef, unpinRunRef } from "../cli/commands/pin";
import { runWait } from "../cli/commands/wait";
import {
  fixturesMarkdown,
  runFixtures,
  type FixturesAction,
  type FixturesRequest,
} from "../cli/commands/fixtures";
import { publishRunRef } from "../cli/commands/publishCommand";
import { EvidenceCategorySchema } from "../core/schema/config.v1";
import {
  parseFcheapInfoOutput,
  parseFcheapListOutput,
  parseFcheapRestoreOutput,
  parseFcheapSearchOutput,
} from "../cli/commands/fcheapContract";
import { runFcheap } from "../cli/commands/fcheapClient";
import { getTvaultKeys } from "../cli/commands/secrets";
import { backendOpts, parseVarFlags } from "../cli/commands/run";
import { RunInvocationRegistry } from "../cli/invocation/registry";
import { environmentLockKey } from "../cli/invocation/lifecycle";
import { resolveServicesConfigPath } from "../cli/commands/services/target";
import { registerRunTools } from "./runTools";
import { registerCatalogTools } from "./catalogTools";
import { registerAuthoringTools } from "./authoringTools";
import { randomUUID } from "node:crypto";
import {
  resolveArtifactRoot,
  resolveRunRef,
  type ArtifactRootOptions,
} from "../cli/runRefs";
import { checkpointRow } from "../cli/commands/checkpoint/list";
import { checkpointMetaFor } from "../cli/commands/checkpoint/scope";
import { CheckpointStore } from "../core/checkpoint/CheckpointStore";
import { parseTtlMs } from "../core/checkpoint/meta";
import {
  captureCheckpoint,
  closeAllSessions,
  endAllJournalsSync,
  sweepSessions,
  type SessionRegistry,
} from "../core/discovery/DiscoverySession";
import { registerDiscoveryTools } from "./discoveryTools";
import {
  healErrorExitCode,
  resolveHealRuntime,
  toHealResult,
} from "../cli/commands/spec/heal";
import { stampSpecContractHash, verifySpec } from "../cli/commands/spec/verify";
import { createBackend } from "../cli/backendFactory";
import {
  closeAllAccompany,
  sweepExpiredAccompany,
  terminateAllAccompanySync,
} from "../core/accompany/AccompanySession";
import { exportOneBrief } from "../cli/commands/exportBrief";
import { healSpec, healVerify } from "../core/healer/Healer";
import { collectLocatorInventory } from "../core/snapshot/locatorInventory";
import { createArtifactRedactor } from "../core/artifacts/redaction";
import { DocsResultSchema, DocsTopicSchema } from "../core/schema/docs.v1";
import { ExplainResultSchema } from "../core/schema/explain.v1";
import { HealResultSchema } from "../core/schema/heal.v1";
import { AuditResultSchema } from "../core/schema/audit.v1";
import { InvestigateResultSchema } from "../core/schema/investigate.v1";
import {
  ConfigValidateResultSchema,
  ServicesStatusResultSchema,
  StashInfoResultSchema,
  StashRestoreResultSchema,
  StashToolErrorSchema,
} from "../core/schema/mcp.v1";
import { SafeStashIdSchema } from "../core/schema/stash.v1";
import {
  ServicesDownResultSchema,
  ServicesUpResultSchema,
} from "../core/schema/services.v1";
import { CAIRN_VERSION as VERSION } from "../cli/version";

function stashMcpError(input: z.input<typeof StashToolErrorSchema>): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  const redactor = createArtifactRedactor(undefined);
  const error = StashToolErrorSchema.parse(redactor.value(input));
  return {
    content: [
      {
        type: "text",
        text: `${error.message}\nNext: ${error.hint}`,
      },
    ],
    structuredContent: error,
    isError: true,
  };
}

/**
 * Build a Cairntrace MCP server. The CLI's `cairn mcp` subcommand connects this
 * to an stdio transport so MCP-aware agents (Claude Code, Cursor, Windsurf) can
 * invoke Cairntrace tools natively without shelling out and parsing stdout.
 *
 * Tools mirror the CLI surface but return JSON-typed `structuredContent`
 * alongside short text summaries for the agent's chat-side rendering.
 */
export interface McpServerOptions {
  /**
   * Accept `cairn_run` before/after hooks (arbitrary shell). Off unless
   * `cairn mcp --allow-hooks` or `CAIRN_MCP_ALLOW_HOOKS=1`.
   */
  allowHooks?: boolean;
  /**
   * Let MCP tools start config services (docker/seed/tmux) and run their
   * teardown: cairn_run, cairn_spec_finish and cairn_audit without
   * noServices / reuseServices, cairn_services_up and cairn_services_down.
   * Off unless `cairn mcp --allow-services` or `CAIRN_MCP_ALLOW_SERVICES=1`.
   */
  allowServices?: boolean;
}

/** A services tool this server may not run, and how to get past it. */
function servicesToolRefusal(
  tool: string,
  action: string,
): { content: Array<{ type: "text"; text: string }>; isError: true } {
  return {
    content: [
      {
        type: "text",
        text:
          `${tool} refused: this MCP server does not ${action} config services ` +
          "(they can be remote or billable, and their teardown runs shell). " +
          "Run `cairn services up|down` from a shell, or restart the server as " +
          "`cairn mcp --allow-services` (or with CAIRN_MCP_ALLOW_SERVICES=1).",
      },
    ],
    isError: true,
  };
}

/** MCP result of a `cairn fixtures` action (F3b). */
function fixturesToolResult(result: Awaited<ReturnType<typeof runFixtures>>) {
  return {
    content: [{ type: "text" as const, text: fixturesMarkdown(result) }],
    structuredContent: { ...result },
    ...(result.ok ? {} : { isError: true }),
  };
}

const FIXTURES_SCHEMA_NOTE =
  "Returns urn:cairntrace.dev:fixtures:v1 {action, ok, exitCode (0 ok incl. dry-run, 1 a verb failed, 2 error, 4 invalid input), project, env, writes (allowed | dry-run), writesReason?, …, warnings, error?}.";

function runFixturesTool(
  action: FixturesAction,
  input: Omit<FixturesRequest, "action">,
  signal: AbortSignal,
): ReturnType<typeof runFixtures> {
  return runFixtures({ ...input, action, signal });
}

export function buildMcpServer(options: McpServerOptions = {}): McpServer {
  const server = new McpServer({ name: "cairntrace", version: VERSION });
  const allowHooks =
    options.allowHooks === true || process.env.CAIRN_MCP_ALLOW_HOOKS === "1";
  const allowServices =
    options.allowServices === true ||
    process.env.CAIRN_MCP_ALLOW_SERVICES === "1";
  // cairn_run invocations (sync and background) outlive single tool calls;
  // shutdown aborts them gracefully, process exit kills them synchronously.
  const runInvocations = new RunInvocationRegistry();

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
        structuredContent: ExplainResultSchema.parse(doc) as unknown as Record<
          string,
          unknown
        >,
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
        structuredContent: DocsResultSchema.parse(doc) as unknown as Record<
          string,
          unknown
        >,
      };
    },
  );

  server.registerTool(
    "cairn_doctor",
    {
      title: "Health check",
      description:
        "Verify runtimes, browser backends, and optional local integrations.",
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

  registerRunTools(server, {
    allowHooks,
    allowServices,
    registry: runInvocations,
  });
  // cairn_catalog + the cairn://catalog resource (A4).
  registerCatalogTools(server);
  // cairn_spec_lint / _finish / _promote + the author-flow prompt (A7/A8).
  registerAuthoringTools(server, {
    allowServices,
    registry: runInvocations,
  });

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
    "cairn_snapshot",
    {
      title: "One-shot locator inventory for a page",
      description:
        "Open a URL statelessly (no session) and return the role + test-id locator " +
        "inventory for agent-friendly step authoring. Test ids are scanned on the " +
        "config's browser.testIdAttribute (default data-testid). Use waitUntil for SPAs " +
        "so the tree isn't captured pre-hydration. The stateless counterpart to the " +
        "cairn_discover_* session tools — use this for a single-page inventory, " +
        "discovery for multi-step exploration.",
      inputSchema: {
        url: z
          .string()
          .min(1)
          .describe(
            "Page URL (absolute, or relative to config baseUrl; ${vars.X} placeholders resolve)",
          ),
        roles: z
          .boolean()
          .optional()
          .describe(
            "Include role locators (default when neither roles nor testids is set)",
          ),
        testids: z
          .boolean()
          .optional()
          .describe(
            "Include test-id locators (browser.testIdAttribute, default data-testid)",
          ),
        waitUntil: z
          .enum(["networkidle", "load", "domcontentloaded"])
          .optional()
          .describe("Wait for SPA hydration before capturing the inventory"),
        env: z
          .string()
          .optional()
          .describe("Environment override for config baseUrl"),
        mock: z.boolean().optional().describe("Use the in-memory mock backend"),
        backend: z
          .enum(["agent-browser", "playwright", "mock"])
          .optional()
          .describe("Browser backend (default agent-browser)"),
        config: z
          .string()
          .optional()
          .describe("Explicit cairntrace.config.yml"),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X} in the URL"),
      },
    },
    async ({
      url,
      roles,
      testids,
      waitUntil,
      env,
      mock,
      backend: backendChoice,
      config,
      var: varFlags,
    }) => {
      let target: Awaited<ReturnType<typeof resolveSnapshotTarget>>;
      try {
        target = await resolveSnapshotTarget(url, {
          ...(env !== undefined ? { env } : {}),
          ...(config !== undefined ? { config } : {}),
          ...(varFlags !== undefined ? { var: varFlags } : {}),
        });
      } catch (e) {
        return {
          content: [
            { type: "text", text: `snapshot failed: ${(e as Error).message}` },
          ],
          isError: true,
        };
      }
      const be = createBackend({
        ...backendOpts(
          {
            ...(mock !== undefined ? { mock } : {}),
            ...(backendChoice !== undefined ? { backend: backendChoice } : {}),
          },
          target.browser,
        ),
        session: `cairntrace-snapshot-${process.pid}`,
      });
      try {
        const resolvedUrl = target.url;
        const openStep =
          waitUntil !== undefined
            ? { open: { path: resolvedUrl, waitUntil } }
            : { open: resolvedUrl };
        const opened = await be.runStep(openStep);
        if (!opened.ok) {
          return {
            content: [
              {
                type: "text",
                text: `snapshot open failed: ${redactBrowseUrl(target, opened.stderr || opened.stdout || "unknown error")}`,
              },
            ],
            isError: true,
          };
        }
        const includeRoles = roles || (!roles && !testids);
        const includeTestIds = testids || (!roles && !testids);
        const inventory = await collectLocatorInventory(be, {
          roles: includeRoles,
          testids: includeTestIds,
          ...(target.testIdAttribute
            ? { testIdAttribute: target.testIdAttribute }
            : {}),
        });
        // The page URL can still carry a secret the opened URL had.
        const finalUrl = redactBrowseUrl(
          target,
          await be.getUrl().catch(() => resolvedUrl),
        );
        return {
          content: [
            {
              type: "text",
              text:
                `Snapshot of ${finalUrl}: ${inventory.roles?.length ?? 0} role locators, ` +
                `${inventory.testids?.length ?? 0} testids` +
                (inventory.truncated ? " (truncated to limit)" : ""),
            },
          ],
          structuredContent: {
            url: finalUrl,
            backend: be.name,
            ...inventory,
            ...(target.warnings.length > 0
              ? { warnings: target.warnings }
              : {}),
          },
        };
      } catch (e) {
        return {
          content: [
            { type: "text", text: `snapshot failed: ${(e as Error).message}` },
          ],
          isError: true,
        };
      } finally {
        await be.close().catch(() => undefined);
      }
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
        "Lint the spec exactly like `cairn spec verify`: resolve config/env/vars, " +
        "parse + validate (imports included), report stamp and cold-start " +
        "warnings, and run the static placeholder reference audit (an " +
        "`${env.X}` without a default or a `${secrets.X}` outside " +
        "secrets.required makes the spec invalid, exit 4). " +
        "With stamp=true, write a fresh contractHash into the file.",
      inputSchema: {
        path: z.string(),
        stamp: z.boolean().optional(),
        env: z.string().optional().describe("Environment name override"),
        config: z.string().optional().describe("Explicit config path"),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X}"),
      },
    },
    async ({ path, stamp, env, config, var: varFlags }) => {
      if (stamp) {
        try {
          // Route through the same Document-API stamp the CLI uses so inline
          // comments/quoting are preserved (a full re-serialize strips them).
          const hash = await stampSpecContractHash(path);
          return {
            content: [{ type: "text", text: `Stamped contractHash: ${hash}` }],
            structuredContent: { status: "stamped", contractHash: hash, path },
          };
        } catch (e) {
          return {
            content: [
              { type: "text", text: `invalid: ${(e as Error).message}` },
            ],
            isError: true,
          };
        }
      }
      let vars: Record<string, string>;
      try {
        vars = parseVarFlags(varFlags);
      } catch (e) {
        return {
          content: [{ type: "text", text: `invalid: ${(e as Error).message}` }],
          isError: true,
        };
      }
      // The one verify code path shared with `cairn spec verify`, so MCP and
      // CLI agree on validity (reference audit included).
      const { result, exitCode } = await verifySpec(path, {
        ...(env !== undefined ? { env } : {}),
        ...(config !== undefined ? { config } : {}),
        vars,
        stampHint: "call with stamp=true",
      });
      const structuredContent = {
        status: result.status,
        path,
        contractHash: result.contractHash,
        ...(result.coldStartSatisfied !== undefined
          ? { coldStartSatisfied: result.coldStartSatisfied }
          : {}),
        ...(result.referenceFindings !== undefined
          ? { referenceFindings: result.referenceFindings }
          : {}),
        // Same structured fields as `cairn spec verify --json`: env-policy,
        // file-reference and checkpoint findings, and where the spec may run.
        ...(result.findings !== undefined ? { findings: result.findings } : {}),
        ...(result.environment !== undefined
          ? { environment: result.environment }
          : {}),
        ...(result.environments !== undefined
          ? { environments: result.environments }
          : {}),
        ...(result.warnings.length > 0 ? { warnings: result.warnings } : {}),
        ...(result.errors.length > 0 ? { errors: result.errors } : {}),
        exitCode,
      };
      if (exitCode !== 0) {
        return {
          content: [
            {
              type: "text",
              text: `invalid: ${result.errors.join("; ")}`,
            },
          ],
          structuredContent,
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              `valid: ${path}\n` +
              `contractHash: ${result.contractHash ?? "(not stamped)"}` +
              (result.warnings.length > 0
                ? `\nwarnings: ${result.warnings.join("; ")}`
                : ""),
          },
        ],
        structuredContent,
      };
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
        verify: z
          .boolean()
          .optional()
          .describe(
            "Transactionally verify: apply to the file, cold-start rerun, accept only if green (else rollback)",
          ),
        mock: z.boolean().optional(),
        backend: z
          .enum(["agent-browser", "playwright", "mock"])
          .optional()
          .describe("Browser backend (default agent-browser)"),
        env: z
          .string()
          .optional()
          .describe("Environment name override (same as `cairn run --env`)"),
        config: z.string().optional().describe("Explicit config path"),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X}"),
      },
    },
    async ({
      path,
      apply,
      verify,
      mock,
      backend: backendChoice,
      env,
      config,
      var: varFlags,
    }) => {
      // Same config/env/var resolution as `cairn spec heal` / `cairn run`;
      // an unknown explicit env fails here, before a browser starts.
      let resolved: Awaited<ReturnType<typeof resolveHealRuntime>>;
      try {
        resolved = await resolveHealRuntime(path, {
          ...(env !== undefined ? { env } : {}),
          ...(config !== undefined ? { config } : {}),
          ...(varFlags !== undefined ? { var: varFlags } : {}),
        });
      } catch (e) {
        return healFailure(e as Error);
      }
      const backend = createBackend({
        ...backendOpts(
          {
            ...(mock !== undefined ? { mock } : {}),
            ...(backendChoice !== undefined ? { backend: backendChoice } : {}),
          },
          resolved.browser,
        ),
        session: `cairntrace-mcp-heal-${process.pid}`,
      });
      try {
        if (verify) {
          const vr = await healVerify({
            specPath: path,
            backend,
            ...resolved.runtime,
          });
          return {
            content: [
              {
                type: "text",
                text:
                  `${
                    vr.verified ? "verified" : "not verified"
                  } (${vr.confidence} confidence): ${vr.reason ?? `${vr.ops.length} op(s)`}\n` +
                  vr.ops
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
            structuredContent: vr as unknown as Record<string, unknown>,
            isError: !vr.verified,
          };
        }
        const out = await healSpec({
          specPath: path,
          backend,
          ...(apply !== undefined ? { apply } : {}),
          ...resolved.runtime,
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
          structuredContent: HealResultSchema.parse(
            toHealResult(out),
          ) as unknown as Record<string, unknown>,
          isError: out.status === "no-heal-possible",
        };
      } catch (e) {
        // Same exit codes as `cairn spec heal`: a spec the environment
        // policy refuses is exit 7 (heal never ran it), a changed contract 6.
        return healFailure(e as Error);
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
        "Returns named checkpoints at ~/.cairntrace/checkpoints/ (sorted by mtime desc), like `cairn checkpoint list --json`: each with health (ok | expired | unscoped), staleMeta when the scope sidecar no longer matches the state file, and env/baseUrl/createdAt/ttl/expiresAt when the capture recorded them. A run refuses a missing, expired or other-origin checkpoint (failure.phase session).",
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
                    .map((c) => {
                      const scope = [
                        c.meta?.env ? `env ${c.meta.env}` : undefined,
                        c.meta?.baseUrl,
                        c.meta?.expiresAt
                          ? `expires ${c.meta.expiresAt}`
                          : undefined,
                      ]
                        .filter(Boolean)
                        .join(", ");
                      return `- ${c.name} — ${c.health}${
                        c.staleMeta ? " (stale scope ignored)" : ""
                      } — ${(c.sizeBytes / 1024).toFixed(1)} KB — ${c.modifiedAt.toISOString()}${
                        scope ? ` — ${scope}` : ""
                      }`;
                    })
                    .join("\n"),
          },
        ],
        // The same rows as `cairn checkpoint list --json`.
        structuredContent: {
          root: store.root,
          checkpoints: list.map(checkpointRow),
        },
      };
    },
  );

  server.registerTool(
    "cairn_checkpoint_show",
    {
      title: "Inspect a saved checkpoint",
      description:
        "Return the metadata (health, staleMeta, scope meta) + first 400 bytes of a named checkpoint file, like `cairn checkpoint show --json`.",
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
              `${summary.name} — ${summary.health}${
                summary.staleMeta
                  ? " (stale scope ignored: the state was rewritten after it)"
                  : ""
              } — ${(summary.sizeBytes / 1024).toFixed(1)} KB — ${summary.modifiedAt.toISOString()}\n` +
              `${summary.path}\n` +
              (summary.meta
                ? `scope: ${summary.meta.baseUrl ?? "(no baseUrl)"}${
                    summary.meta.env ? ` env ${summary.meta.env}` : ""
                  }${
                    summary.meta.expiresAt
                      ? `, expires ${summary.meta.expiresAt}`
                      : ""
                  }\n`
                : "") +
              `\n${summary.preview}`,
          },
        ],
        // The same document as `cairn checkpoint show --json`.
        structuredContent: {
          name: summary.name,
          path: summary.path,
          sizeBytes: summary.sizeBytes,
          modifiedAt: summary.modifiedAt.toISOString(),
          health: summary.health,
          ...(summary.staleMeta ? { staleMeta: true } : {}),
          ...(summary.meta ? { meta: summary.meta } : {}),
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
    "cairn_checkpoint_capture",
    {
      title: "Capture the discovery session's logged-in state as a checkpoint",
      description:
        "Save the live discovery session's browser state (cookies/localStorage/IndexedDB) " +
        "as a named checkpoint at ~/.cairntrace/checkpoints/<name>.json. Log in during " +
        "discovery first, then call this, then reference the checkpoint in the exported " +
        "spec via `session: { resume: <name> }` to satisfy the cold-start contract. " +
        "Writes scope metadata (<name>.meta.json, like `cairn checkpoint capture-from-session`): the session's environment baseUrl, else the origin of the page it is on, the env when cairn_discover_open named one, and an optional ttl. A run refuses the checkpoint for another origin or once expired. " +
        "Requires a real (non-mock) session.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        name: z
          .string()
          .regex(/^[a-z][a-z0-9-_]*$/i)
          .describe("checkpoint name (letters, digits, hyphen, underscore)"),
        ttl: z
          .string()
          .optional()
          .describe(
            "Lifetime such as 30m, 12h or 7d; a run refuses the checkpoint afterwards",
          ),
      },
    },
    async ({ sessionId, name, ttl }) => {
      if (ttl !== undefined) {
        try {
          parseTtlMs(ttl);
        } catch (e) {
          return {
            content: [{ type: "text", text: (e as Error).message }],
            isError: true,
          };
        }
      }
      const handle = sessions.get(sessionId);
      if (!handle) {
        return {
          content: [{ type: "text", text: `session not found: ${sessionId}` }],
          isError: true,
        };
      }
      if (handle.backend.name === "mock") {
        return {
          content: [
            {
              type: "text",
              text: "checkpoint capture needs a real browser session; reopen with cairn_discover_open without mock:true",
            },
          ],
          isError: true,
        };
      }
      try {
        const store = new CheckpointStore();
        const outPath = store.pathFor(name);
        await store.ensureRoot();
        const r = await captureCheckpoint(handle, outPath);
        if (!r.ok) {
          return {
            content: [
              {
                type: "text",
                text: `checkpoint capture failed: ${r.stderr || r.stdout || "unknown error"}`,
              },
            ],
            isError: true,
          };
        }
        // Scope it like `cairn checkpoint capture-from-session`: the session's
        // environment baseUrl, else the origin of the page it is on. Without
        // this a fresh state would sit next to an older sidecar (stale, so
        // `unscoped`) or none at all.
        let meta: ReturnType<typeof checkpointMetaFor> | undefined;
        let scopeWarning: string | undefined;
        try {
          const pageUrl = handle.baseUrl
            ? undefined
            : await handle.backend
                .getUrl()
                .catch(() => handle.session.currentUrl);
          const env = handle.runtimeInputs?.env;
          meta = checkpointMetaFor(
            name,
            {
              ...(env ? { env } : {}),
              ...(handle.baseUrl ? { envBaseUrl: handle.baseUrl } : {}),
              ...(ttl !== undefined ? { ttl } : {}),
            },
            {
              ...(pageUrl ? { pageUrl } : {}),
              capturedBy: "discovery",
            },
          );
          await store.writeMeta(outPath, meta);
        } catch (e) {
          meta = undefined;
          scopeWarning = `checkpoint saved without scope metadata (unscoped): ${
            (e as Error).message
          }`;
        }
        return {
          content: [
            {
              type: "text",
              text:
                `Checkpoint saved: ${outPath}\n` +
                (meta
                  ? `Scope: ${meta.baseUrl ?? "(no baseUrl)"}${
                      meta.env ? ` env ${meta.env}` : ""
                    }${meta.expiresAt ? `, expires ${meta.expiresAt}` : ""}\n`
                  : "") +
                (scopeWarning ? `Warning: ${scopeWarning}\n` : "") +
                `Reference it with: session: { resume: ${name} }`,
            },
          ],
          structuredContent: {
            name,
            path: outPath,
            ok: true,
            resumeHint: `session: { resume: ${name} }`,
            ...(meta
              ? {
                  scope: {
                    ...(meta.baseUrl ? { baseUrl: meta.baseUrl } : {}),
                    ...(meta.env ? { env: meta.env } : {}),
                    createdAt: meta.createdAt,
                    ...(meta.ttl ? { ttl: meta.ttl } : {}),
                    ...(meta.expiresAt ? { expiresAt: meta.expiresAt } : {}),
                  },
                }
              : {}),
            ...(scopeWarning ? { warning: scopeWarning } : {}),
          },
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `checkpoint capture failed: ${(e as Error).message}`,
            },
          ],
          isError: true,
        };
      }
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
          structuredContent: ConfigValidateResultSchema.parse(
            result,
          ) as unknown as Record<string, unknown>,
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
        "docker containers, tmux session windows, seed freshness, and the `cairn services up` " +
        "owner lock of the config (owner, env, age, stale for a lock held for this env). " +
        "Returns a ServicesStatusResult with phase statuses and readiness.",
      inputSchema: {
        config: z
          .string()
          .optional()
          .describe(
            "Path to cairntrace.config.yml (auto-discovers if omitted)",
          ),
        env: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Environment (default: config defaultEnvironment, else local)",
          ),
      },
    },
    async ({ config, env }) => {
      try {
        const { describeLockReport, getServicesStatus } = await import(
          "../cli/commands/services/status"
        );
        const result = await getServicesStatus({
          ...(config !== undefined ? { config } : {}),
          ...(env !== undefined ? { env } : {}),
        });
        const phases = result.docker
          ? result.tmux?.session
            ? `docker: ${
                result.docker.running ? "running" : "stopped"
              }\ntmux: session=${result.tmux.session} windows=${result.tmux.windows.length} healthy=${result.tmux.windows.every((w: { healthy?: boolean }) => w.healthy !== false)}`
            : `docker: ${result.docker.running ? "running" : "stopped"}`
          : result.tmux?.session
            ? `tmux: session=${result.tmux.session} windows=${result.tmux.windows.length}`
            : "no services configured";
        return {
          content: [
            {
              type: "text",
              text: result.lock
                ? `${phases}\nlock: ${describeLockReport(result.lock, result.env)}`
                : phases,
            },
          ],
          structuredContent: ServicesStatusResultSchema.parse(
            result,
          ) as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return {
          content: [{ type: "text", text: `error: ${(e as Error).message}` }],
          isError: true,
        };
      }
    },
  );

  // `services up` / `down` run under the same per-config environment lock
  // as cairn_run, so they never fight a run of this server over one stack.
  const withServicesEnvironment = async <T>(
    config: string | undefined,
    signal: AbortSignal | undefined,
    work: () => Promise<T>,
  ): Promise<T> => {
    const configPath = await resolveServicesConfigPath(
      config !== undefined ? { config } : {},
    );
    if (!configPath) return work();
    const release = await runInvocations.environmentLock.acquire(
      environmentLockKey(configPath, process.cwd()),
      `services-${randomUUID()}`,
      signal ? { signal } : {},
    );
    try {
      return await work();
    } finally {
      release();
    }
  };

  server.registerTool(
    "cairn_services_up",
    {
      title: "Start the services environment and keep it running",
      description:
        "Start the config services (docker → seed → tmux) through the same code path as cairn_run, " +
        "leave them running, and write the config's owner lock (one per config file, by: mcp). While it exists, " +
        "cairn_run for that env refuses (exit 4) unless it passes reuseServices: true (readiness check, no " +
        "start, no teardown, cold browser), and cairn_run of another env of the config refuses. Stop them " +
        "with cairn_services_down. Waits for a cairn_run of this server that holds the same config. " +
        "Needs a server started as `cairn mcp --allow-services` (or CAIRN_MCP_ALLOW_SERVICES=1); without it the tool refuses and starts nothing. " +
        "Returns the services-up v1 result (phases, lock, redacted events); exit 4 when no config is found, " +
        "for an unknown env, no services block, or a lock held for another env; 2 for a boot failure or a " +
        "config path that does not exist.",
      inputSchema: {
        config: z
          .string()
          .optional()
          .describe(
            "Path to cairntrace.config.yml (auto-discovers if omitted)",
          ),
        env: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Environment (default: config defaultEnvironment, else local)",
          ),
      },
    },
    async ({ config, env }, extra) => {
      if (!allowServices) {
        return servicesToolRefusal("cairn_services_up", "start");
      }
      try {
        const { servicesUp } = await import("../cli/commands/services/up");
        const result = await withServicesEnvironment(config, extra.signal, () =>
          servicesUp({
            ...(config !== undefined ? { config } : {}),
            ...(env !== undefined ? { env } : {}),
            by: "mcp",
            signal: extra.signal,
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: result.ok
                ? `services up: project=${result.project} env=${result.env} ` +
                  `${Object.entries(result.phases)
                    .map(([phase, what]) => `${phase}=${what}`)
                    .join(" ")}\nlock: ${result.lockPath}`
                : `services up failed (exit ${result.exitCode}): ${result.error ?? "unknown error"}`,
            },
          ],
          structuredContent: ServicesUpResultSchema.parse(
            result,
          ) as unknown as Record<string, unknown>,
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
    "cairn_services_down",
    {
      title: "Tear the services environment down",
      description:
        "Full teardown of the config services: the configured teardown commands in order (docker compose " +
        "down and tmux kill-session when the config lists them; a docker phase no command stops is warned " +
        "about), then the tmux session if it is still running, and removal of the config's `cairn services " +
        "up` owner lock. Works without a lock (a stack a run left alive for reuse); exit 4 with nothing torn " +
        "down while the lock is held for another env. Returns the services-down v1 result; exit 2 when a " +
        "teardown command failed (the lock is still removed). Needs a server started as " +
        "`cairn mcp --allow-services` (or CAIRN_MCP_ALLOW_SERVICES=1); without it the tool refuses and runs no teardown.",
      inputSchema: {
        config: z
          .string()
          .optional()
          .describe(
            "Path to cairntrace.config.yml (auto-discovers if omitted)",
          ),
        env: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Environment (default: config defaultEnvironment, else local)",
          ),
      },
    },
    async ({ config, env }, extra) => {
      if (!allowServices) {
        return servicesToolRefusal("cairn_services_down", "tear down");
      }
      try {
        const { servicesDown } = await import("../cli/commands/services/down");
        const result = await withServicesEnvironment(config, extra.signal, () =>
          servicesDown({
            ...(config !== undefined ? { config } : {}),
            ...(env !== undefined ? { env } : {}),
          }),
        );
        return {
          content: [
            {
              type: "text",
              text: result.ok
                ? `services down: project=${result.project} env=${result.env} ` +
                  `teardown=${result.teardown.length} tmuxKilled=${result.tmuxKilled} lock=${
                    result.removedLock
                      ? "removed"
                      : (result.lockState ?? "none")
                  }`
                : `services down incomplete (exit ${result.exitCode}): ${result.error ?? "unknown error"}`,
            },
          ],
          structuredContent: ServicesDownResultSchema.parse(
            result,
          ) as unknown as Record<string, unknown>,
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
    "cairn_stash_save",
    {
      title: "Stash a run to fcheap",
      description:
        "Save a run directory to the local file.cheap vault for persistence " +
        "beyond Cairntrace retention and cross-run search. Requires fcheap on $PATH. " +
        "Same evidence gate as `cairn stash save`: traces, videos and downloads " +
        "stay local unless `include` (or config stash.include) lists them; the run " +
        "gains stash-receipt.json and an artifact.stash event (action manual).",
      inputSchema: {
        runId: z.string().min(1).describe("Run id, 'latest', or 'previous'"),
        artifactRoot: z
          .string()
          .optional()
          .describe("Override run artifact root directory"),
        config: z
          .string()
          .optional()
          .describe(
            "Explicit cairntrace.config.yml (stash.include / meta defaults)",
          ),
        tag: z.array(z.string()).optional().describe("Tags for this stash"),
        labelsAsTags: z
          .boolean()
          .optional()
          .describe(
            "Also tag the stash with every run.json label as key=value (cairn run --label)",
          ),
        ttl: z
          .string()
          .regex(/^[0-9A-Za-z-]+$/)
          .optional()
          .describe(
            "file.cheap time-to-live, e.g. 30d; omitted = never expires",
          ),
        include: z
          .array(EvidenceCategorySchema)
          .optional()
          .describe(
            "Evidence categories (text, screenshots, traces, videos, downloads); default config stash.include, else text + screenshots",
          ),
      },
    },
    async ({
      runId,
      artifactRoot,
      config,
      tag,
      labelsAsTags,
      ttl,
      include,
    }) => {
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
      const root = await resolveArtifactRoot({
        ...(artifactRoot ? { artifactRoot } : {}),
        ...(config ? { config } : {}),
      });
      const runDir = await resolveRunRef(runId, root);
      const resolvedRunId = basename(runDir);
      const stashConfig = await loadStashConfig(config);
      const effectiveInclude =
        parseIncludeFlag(include) ?? stashConfig?.include;
      const saved = await stashRunDirectory(runDir, {
        action: "manual",
        tool: "cairntrace",
        tags: await stashTagsForRun(runDir, tag, labelsAsTags),
        ...(ttl ? { ttl } : {}),
        ...(effectiveInclude ? { include: effectiveInclude } : {}),
        ...(stashConfig?.unsafeIncludeRawTraces
          ? { unsafeIncludeRawTraces: true }
          : {}),
        meta: stashConfig?.meta !== false,
      });
      if (!saved.ok || !saved.stashId) {
        return {
          content: [
            {
              type: "text",
              text: `fcheap save failed: ${saved.error ?? "missing stash id"}`,
            },
          ],
          structuredContent: {
            runId: resolvedRunId,
            runDir,
            tags: tag ?? [],
            ...(saved.stashId ? { stashId: saved.stashId } : {}),
            ...(saved.status ? { status: saved.status } : {}),
            ...(saved.failures?.length ? { failures: saved.failures } : {}),
            ...(saved.reason ? { reason: saved.reason } : {}),
            ...(saved.excluded.length > 0 ? { excluded: saved.excluded } : {}),
            error: saved.error ?? "missing stash id",
          },
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: saved.warning
              ? `Stashed run ${resolvedRunId} → ${saved.stashId} with post-save failures: ${saved.warning}`
              : `Stashed run ${resolvedRunId} → ${saved.stashId}${
                  saved.excluded.length > 0
                    ? ` (left out: ${saved.excluded.join(", ")})`
                    : ""
                }`,
          },
        ],
        structuredContent: {
          stashId: saved.stashId,
          runId: resolvedRunId,
          runDir,
          tags: tag ?? [],
          ...(saved.status ? { status: saved.status } : {}),
          ...(saved.failures?.length ? { failures: saved.failures } : {}),
          ...(saved.warning ? { warning: saved.warning } : {}),
          ...(saved.excluded.length > 0 ? { excluded: saved.excluded } : {}),
          ...(saved.secretsFound !== undefined
            ? { secretsFound: saved.secretsFound }
            : {}),
          ...(saved.ttl ? { ttl: saved.ttl } : {}),
          ...(saved.expiresAt ? { expiresAt: saved.expiresAt } : {}),
          ...(saved.receipt ? { receipt: saved.receipt } : {}),
        },
        ...(saved.warning ? { isError: true } : {}),
      };
    },
  );

  server.registerTool(
    "cairn_pin",
    {
      title: "Pin (or unpin) a run",
      description:
        "Keep a run past retention: writes run.json pinned {at, reason?}; " +
        "retention never prunes a pinned run (cairn clean --include-pinned " +
        "overrides). `stash: true` also saves it to file.cheap with the keep " +
        "tag and no TTL. `unpin: true` removes the pin. Mirrors cairn pin / cairn unpin.",
      inputSchema: {
        runId: z.string().min(1).describe("Run id, 'latest', or 'previous'"),
        reason: z.string().max(500).optional().describe("Why the run is kept"),
        stash: z
          .boolean()
          .optional()
          .describe("Also stash it (tag keep, no TTL)"),
        unpin: z.boolean().optional().describe("Remove the pin instead"),
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
    async ({ runId, reason, stash, unpin, artifactRoot, config }) => {
      const where = {
        ...(artifactRoot ? { artifactRoot } : {}),
        ...(config ? { config } : {}),
      };
      try {
        const outcome = unpin
          ? await unpinRunRef(runId, where)
          : await pinRunRef(runId, {
              ...where,
              ...(reason ? { reason } : {}),
              ...(stash ? { stash: true } : {}),
            });
        const stashFailed = outcome.stash !== undefined && !outcome.stash.ok;
        return {
          content: [
            {
              type: "text",
              text: outcome.pinned
                ? `Pinned ${outcome.runId}${
                    outcome.stash?.ok
                      ? ` and stashed it → ${outcome.stash.stashId}`
                      : stashFailed
                        ? ` (stash failed: ${outcome.stash?.error ?? "unknown"})`
                        : ""
                  }`
                : `${
                    outcome.changed ? "Unpinned" : "Was not pinned:"
                  } ${outcome.runId}`,
            },
          ],
          structuredContent: { ...outcome },
          ...(stashFailed ? { isError: true } : {}),
        };
      } catch (error) {
        return toolError(`cairn_pin: ${(error as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_wait",
    {
      title: "Wait for readiness gates",
      description:
        "Wait for typed readiness gates in order, stopping at the first that " +
        "is not ready — config gates: names (tcp / http with status, json and " +
        "auth / command; all/any; stable; every; timeout), http(s):// URLs " +
        "(2xx/3xx unless status or anyResponse) or tcp://host:port. Returns " +
        "urn:cairntrace.dev:wait:v1 {ok, gates[{name, ok, attempts, " +
        "durationMs, budgetMs, lastDetail, timedOut?, cancelled?}], exitCode " +
        "(0 ready, 1 not ready, 2 error, 4 invalid input), error?}. Mirrors " +
        "cairn wait. Cancelling the request stops the wait; keep timeoutMs " +
        "below your client's tool timeout.",
      inputSchema: {
        targets: z
          .array(z.string().min(1))
          .min(1)
          .describe("Gate names, http(s):// URLs or tcp://host:port, in order"),
        config: z
          .string()
          .optional()
          .describe("Explicit cairntrace.config.yml (its gates: registry)"),
        env: z
          .string()
          .optional()
          .describe("Environment whose scoped secrets gates may reference"),
        status: z
          .string()
          .optional()
          .describe("Accepted statuses for URL targets, e.g. 2xx,401,200-299"),
        anyResponse: z
          .boolean()
          .optional()
          .describe("URL targets accept any HTTP answer"),
        timeoutMs: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Override every target's budget (0 = no deadline)"),
        everyMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Override the pause between attempts"),
        stable: z
          .number()
          .int()
          .min(1)
          .max(1000)
          .optional()
          .describe("Override the consecutive passing attempts required"),
      },
    },
    async (
      { targets, config, env, status, anyResponse, timeoutMs, everyMs, stable },
      extra,
    ) => {
      const result = await runWait({
        targets,
        ...(config !== undefined ? { config } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(status !== undefined ? { status } : {}),
        ...(anyResponse ? { anyResponse: true } : {}),
        ...(timeoutMs !== undefined ? { timeout: timeoutMs } : {}),
        ...(everyMs !== undefined ? { every: everyMs } : {}),
        ...(stable !== undefined ? { stable } : {}),
        signal: extra.signal,
      });
      const lines = result.error
        ? [`cairn_wait: ${result.error}`]
        : result.gates.map(
            (gate) =>
              `${
                gate.ok ? "ready" : "NOT READY"
              } ${gate.name} — ${gate.attempts} attempt(s), ${gate.durationMs}ms: ${gate.lastDetail}`,
          );
      return {
        content: [{ type: "text", text: lines.join("\n") }],
        structuredContent: { ...result },
        ...(result.ok ? {} : { isError: true }),
      };
    },
  );

  // F3b: config fixtures registry — one tool per `cairn fixtures` verb.
  const fixtureScopeInput = {
    config: z
      .string()
      .optional()
      .describe("Explicit cairntrace.config.yml (its fixtures: registry)"),
    env: z
      .string()
      .optional()
      .describe(
        "Environment (datasources, vars, secrets, policy); default: config defaultEnvironment, else local",
      ),
  };
  const fixtureVerbInput = {
    ...fixtureScopeInput,
    name: z.string().min(1).describe("Fixture name (config fixtures:)"),
    with: z
      .record(z.string(), z.unknown())
      .optional()
      .describe("Fixture parameters (override the fixture's with: defaults)"),
    allowWrites: z
      .boolean()
      .optional()
      .describe(
        "Write on an environment whose policy trait is shared or protected (otherwise the verb is dry-run there; policy.mutations: deny keeps it dry-run regardless)",
      ),
  };

  server.registerTool(
    "cairn_fixtures_list",
    {
      title: "List config fixtures",
      description:
        "List the config fixtures: registry — name, kind (exec | mongo | http), scope (run | suite | seed), verbs (ensure/reset/verify/teardown), needs, output keys, owner, ttl. Specs reference them as fixtures: [name | name.reset | {use, with, write}] and splice ${fixtures.<name>.<key>}. Mirrors cairn fixtures list. " +
        FIXTURES_SCHEMA_NOTE,
      inputSchema: fixtureScopeInput,
    },
    async ({ config, env }, extra) =>
      fixturesToolResult(
        await runFixturesTool(
          "list",
          {
            ...(config !== undefined ? { config } : {}),
            ...(env !== undefined ? { env } : {}),
          },
          extra.signal,
        ),
      ),
  );

  server.registerTool(
    "cairn_fixtures_status",
    {
      title: "Fixture ledger status",
      description:
        "Ledger state of each fixture in the environment (~/.cairntrace/fixtures/<project>.ledger.jsonl): live, expired, failed, torn-down, released or never, with ensuredAt, expiresAt, last verb and recorded outputs (a run-scoped fixture shows its newest open instance and `instances` when several runs left one open); verify: true runs each fixture's read-only verify verb against its recorded outputs. Mirrors cairn fixtures status. " +
        FIXTURES_SCHEMA_NOTE,
      inputSchema: {
        ...fixtureScopeInput,
        names: z
          .array(z.string().min(1))
          .optional()
          .describe("Only these fixtures (default: all)"),
        verify: z
          .boolean()
          .optional()
          .describe("Run each recorded fixture's verify verb"),
      },
    },
    async ({ config, env, names, verify }, extra) =>
      fixturesToolResult(
        await runFixturesTool(
          "status",
          {
            ...(config !== undefined ? { config } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(names ? { names } : {}),
            ...(verify ? { verify: true } : {}),
          },
          extra.signal,
        ),
      ),
  );

  for (const verb of ["ensure", "reset", "teardown"] as const) {
    server.registerTool(
      `cairn_fixtures_${verb}`,
      {
        title: `Fixture ${verb}`,
        description: `${
          verb === "ensure"
            ? "Ensure a fixture (its needs first) and record it in the ledger; nothing is torn down afterwards (cairn_fixtures_teardown or cairn_fixtures_sweep does)."
            : verb === "reset"
              ? "Ensure a fixture's needs, then run its reset verb."
              : "Tear a fixture down with the outputs and parameters its ensure recorded in the ledger (every open instance of a run-scoped fixture); a record the ensure found but did not create is left in place."
        } On an environment whose policy trait is shared or protected the verb is dry-run unless allowWrites; under policy.mutations: deny it is always dry-run. Events in \`events\` (fixture.${verb} {name, adapter, status ok|failed|skipped|dry-run, durationMs, outputs?, error?}). Mirrors cairn fixtures ${verb}. ${FIXTURES_SCHEMA_NOTE}`,
        inputSchema: fixtureVerbInput,
      },
      async ({ config, env, name, with: params, allowWrites }, extra) =>
        fixturesToolResult(
          await runFixturesTool(
            verb,
            {
              names: [name],
              ...(config !== undefined ? { config } : {}),
              ...(env !== undefined ? { env } : {}),
              ...(params ? { with: params } : {}),
              ...(allowWrites ? { allowWrites: true } : {}),
            },
            extra.signal,
          ),
        ),
    );
  }

  server.registerTool(
    "cairn_fixtures_sweep",
    {
      title: "Sweep leftover fixtures",
      description:
        "Find fixtures the ledger still shows live or failed in the environment (a crash or a kill skipped their teardown; one row per run instance of a run-scoped fixture) and, with apply: true, tear them down. Skips fixtures whose recording process is still running, those without a teardown verb or no longer in the config, records the ensure found but did not create (skipped-adopted), those younger than olderThan (default 1h; an expired ttl always qualifies) and seed fixtures unless includeSeed; a failed ensure whose teardown needs outputs it never recorded is skipped-no-outputs, and apply releases it from the ledger. Mirrors cairn fixtures sweep. " +
        FIXTURES_SCHEMA_NOTE,
      inputSchema: {
        ...fixtureScopeInput,
        olderThan: z
          .string()
          .optional()
          .describe("Minimum age: ms or 30m / 2h / 1d (default 1h)"),
        apply: z
          .boolean()
          .optional()
          .describe("Tear the candidates down (default: report only)"),
        includeSeed: z
          .boolean()
          .optional()
          .describe("Seed-scoped fixtures too"),
        allowWrites: z
          .boolean()
          .optional()
          .describe(
            "Write on an environment whose policy trait is shared or protected",
          ),
      },
    },
    async (
      { config, env, olderThan, apply, includeSeed, allowWrites },
      extra,
    ) =>
      fixturesToolResult(
        await runFixturesTool(
          "sweep",
          {
            ...(config !== undefined ? { config } : {}),
            ...(env !== undefined ? { env } : {}),
            ...(olderThan !== undefined ? { olderThan } : {}),
            ...(apply ? { apply: true } : {}),
            ...(includeSeed ? { includeSeed: true } : {}),
            ...(allowWrites ? { allowWrites: true } : {}),
          },
          extra.signal,
        ),
      ),
  );

  server.registerTool(
    "cairn_publish",
    {
      title: "Publish a run to file.cheap",
      description:
        "Publish one run to the private file.cheap artifact service (fcheap publish) " +
        "with a metadata-only RunIndexV1 sidecar, then record publish-receipt.json " +
        "and an artifact.publish event. Needs FILECHEAP_ARTIFACT_SERVICE_URL and " +
        "FILECHEAP_INGEST_TOKEN. Same evidence gate as cairn publish (default " +
        "text + screenshots; secret-bearing members and traces never leave). Mirrors cairn publish.",
      inputSchema: {
        runId: z.string().min(1).describe("Run id, 'latest', or 'previous'"),
        retentionDays: z
          .number()
          .int()
          .min(1)
          .max(31)
          .optional()
          .describe(
            "Remote retention in days (default config retention.publish.retentionDays, else 7)",
          ),
        include: z
          .array(EvidenceCategorySchema)
          .optional()
          .describe(
            "Evidence categories (default config retention.publish.include, else text + screenshots)",
          ),
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
    async ({ runId, retentionDays, include, artifactRoot, config }) => {
      try {
        const effectiveInclude = parseIncludeFlag(include);
        const outcome = await publishRunRef(runId, {
          ...(artifactRoot ? { artifactRoot } : {}),
          ...(config ? { config } : {}),
          ...(retentionDays !== undefined ? { retentionDays } : {}),
          ...(effectiveInclude ? { include: effectiveInclude } : {}),
        });
        const uri =
          typeof outcome.artifactRef?.uri === "string"
            ? outcome.artifactRef.uri
            : undefined;
        return {
          content: [
            {
              type: "text",
              text:
                outcome.status === "published"
                  ? `Published ${outcome.runId}${
                      uri ? ` → ${uri}` : ""
                    } (expires ${outcome.expiresAt})`
                  : `Publish failed (${outcome.reason ?? "unknown"}): ${outcome.error ?? "unknown"}`,
            },
          ],
          structuredContent: { ...outcome },
          ...(outcome.status === "published" ? {} : { isError: true }),
        };
      } catch (error) {
        return toolError(`cairn_publish: ${(error as Error).message}`);
      }
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
      const r = await runFcheap(args);
      if (!r.ok) {
        return {
          content: [{ type: "text", text: `fcheap list failed: ${r.stderr}` }],
          isError: true,
        };
      }
      let stashes;
      try {
        stashes = parseFcheapListOutput(r.stdout);
      } catch (error) {
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              stashes.length > 0
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
    "cairn_stash_info",
    {
      title: "Inspect a stashed run",
      description:
        "Read and validate one local file.cheap v0.30 stash manifest, including its file inventory and provenance metadata.",
      inputSchema: {
        stashId: SafeStashIdSchema.describe("The local file.cheap stash ID"),
      },
      outputSchema: StashInfoResultSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ stashId }) => {
      const r = await runFcheap(["info", stashId], { json: true });
      if (!r.ok) {
        return stashMcpError({
          code:
            r.exitCode === -1 ? "FCHEAP_UNAVAILABLE" : "FCHEAP_COMMAND_FAILED",
          command: "info",
          message:
            r.stderr ||
            `file.cheap info exited with status ${String(r.exitCode)}`,
          hint:
            r.exitCode === -1
              ? "Install file.cheap with `brew install --no-quarantine abdul-hamid-achik/tap/fcheap`, or set FCHEAP_BIN."
              : "Confirm the ID with cairn_stash_list, then retry cairn_stash_info.",
          stashId,
        });
      }

      try {
        const info = StashInfoResultSchema.parse(
          createArtifactRedactor(undefined).value(
            parseFcheapInfoOutput(r.stdout),
          ),
        );
        return {
          content: [
            {
              type: "text",
              text: `Stash ${info.id}: ${info.fileCount} file(s), ${info.sizeBytes} bytes`,
            },
          ],
          structuredContent: info,
        };
      } catch (error) {
        return stashMcpError({
          code: "FCHEAP_INVALID_RESPONSE",
          command: "info",
          message: (error as Error).message,
          hint: "Upgrade file.cheap to v0.30 or newer and retry; Cairntrace rejected an invalid info response.",
          stashId,
        });
      }
    },
  );

  server.registerTool(
    "cairn_stash_restore",
    {
      title: "Restore a stashed run",
      description:
        "Restore one local file.cheap v0.30 stash, validate the structured receipt, and require hash verification to pass.",
      inputSchema: {
        stashId: SafeStashIdSchema.describe("The local file.cheap stash ID"),
        to: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe(
            "Target directory; omit to let file.cheap create a private temporary directory",
          ),
      },
      outputSchema: StashRestoreResultSchema,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ stashId, to }) => {
      const args = ["restore", stashId];
      if (to) args.push("--to", to);
      const r = await runFcheap(args, { json: true });

      let restored;
      try {
        restored = StashRestoreResultSchema.parse(
          createArtifactRedactor(undefined).value(
            parseFcheapRestoreOutput(r.stdout),
          ),
        );
      } catch (error) {
        return stashMcpError({
          code:
            r.exitCode === -1
              ? "FCHEAP_UNAVAILABLE"
              : r.ok
                ? "FCHEAP_INVALID_RESPONSE"
                : "FCHEAP_COMMAND_FAILED",
          command: "restore",
          message: !r.ok && r.stderr ? r.stderr : (error as Error).message,
          hint:
            r.exitCode === -1
              ? "Install file.cheap with `brew install --no-quarantine abdul-hamid-achik/tap/fcheap`, or set FCHEAP_BIN."
              : r.ok
                ? "Upgrade file.cheap to v0.30 or newer and retry; Cairntrace rejected an invalid restore response."
                : "Confirm the stash exists with cairn_stash_info and choose a writable, non-overlapping target directory.",
          stashId,
        });
      }

      if (!r.ok || !restored.verified) {
        return stashMcpError({
          code: restored.verified
            ? "FCHEAP_COMMAND_FAILED"
            : "FCHEAP_RESTORE_UNVERIFIED",
          command: "restore",
          message: restored.verified
            ? r.stderr ||
              `file.cheap restore exited with status ${String(r.exitCode)}`
            : `Restored ${restored.fileCount} file(s), but integrity verification failed.`,
          hint: restored.verified
            ? "Inspect the restore receipt and target, then retry with a fresh target directory."
            : "Treat the restored directory as forensic-only; inspect `restore.mismatches` and retry from a known-good stash.",
          stashId,
          restore: restored,
        });
      }

      return {
        content: [
          {
            type: "text",
            text: `Restored ${restored.stashId} to ${restored.restoredTo}; ${restored.fileCount} file(s) verified`,
          },
        ],
        structuredContent: restored,
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
      const r = await runFcheap(args);
      if (!r.ok) {
        return {
          content: [
            { type: "text", text: `fcheap search failed: ${r.stderr}` },
          ],
          isError: true,
        };
      }
      let results;
      try {
        results = parseFcheapSearchOutput(r.stdout);
      } catch (error) {
        return {
          content: [{ type: "text", text: (error as Error).message }],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text:
              results.length > 0
                ? results
                    .map(
                      (s) =>
                        `- ${s.stashId} (${s.score.toFixed(2)}): ${s.snippet}`,
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
        runId: z.string().min(1).describe("Run id, 'latest', or 'previous'"),
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
        // Same gated stash as `cairn clip --stash` (config stash.include).
        const stashResult = await stashClipRun(runDir, sourceVideo, {
          ...(opts.tags ? { tags: opts.tags } : {}),
          extraTags: ["mcp"],
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
        "Stash a run directory to file.cheap and optionally connect it to a " +
        "codebase for file:line candidates. Connection requires vecgrep.",
      inputSchema: {
        runId: z.string().describe("Run id, 'latest', or 'previous'"),
        codebase: z
          .string()
          .optional()
          .describe(
            "Codebase to search; implies connect. Relative paths resolve from the server cwd.",
          ),
        connect: z
          .boolean()
          .optional()
          .describe(
            "Connect after stashing; uses investigate.codebaseDir when codebase is omitted",
          ),
        clips: z
          .boolean()
          .optional()
          .describe(
            "Stash videos/clips instead of the full run when available",
          ),
        artifactRoot: z
          .string()
          .optional()
          .describe("Override the run artifact root"),
        config: z
          .string()
          .optional()
          .describe("Explicit cairntrace.config.yml path"),
        query: z
          .string()
          .optional()
          .describe("Override the query extracted from the stashed run"),
        mode: z
          .enum(["semantic", "keyword", "hybrid"])
          .optional()
          .describe("vecgrep mode (default: config or hybrid)"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max code matches (default: config or 10)"),
        index: z
          .boolean()
          .optional()
          .describe("Build or refresh the vecgrep index before connecting"),
      },
      outputSchema: InvestigateResultSchema,
    },
    async (args) => {
      let candidate: unknown;
      try {
        candidate = await investigateRunRef(args.runId, {
          codebase: args.codebase,
          connect: args.connect,
          clips: args.clips,
          artifactRoot: args.artifactRoot,
          config: args.config,
          query: args.query,
          mode: args.mode,
          limit: args.limit,
          index: args.index,
        });
      } catch (error) {
        candidate = {
          $schema: "urn:cairntrace.dev:investigate:v1",
          version: "1",
          runId: args.runId,
          runDir: "",
          codeMatches: [],
          error: (error as Error).message,
        };
      }
      const result = InvestigateResultSchema.parse(candidate);
      return {
        content: [
          {
            type: "text",
            text: result.error
              ? result.error
              : result.codeMatches.length > 0
                ? result.codeMatches
                    .map(
                      (match) =>
                        `- ${match.file}:${match.line} (${match.score.toFixed(2)})`,
                    )
                    .join("\n")
                : `Stashed run ${result.runId} as ${result.stashId ?? "(unknown)"}`,
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
        ...(result.error || result.warnings?.length ? { isError: true } : {}),
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
        "the recording, and optionally connect the evidence to a codebase. " +
        "Playwright is required; file.cheap/vecgrep are required only when " +
        "connecting. vidtrace is optional.",
      inputSchema: {
        specPath: z.string().min(1).describe("Path to the spec YAML file"),
        codebase: z
          .string()
          .optional()
          .describe(
            "Codebase to search; implies connect. Relative paths resolve from the server cwd.",
          ),
        connect: z
          .boolean()
          .optional()
          .describe(
            "Connect after stashing; uses investigate.codebaseDir when omitted",
          ),
        artifactRoot: z.string().optional().describe("Override artifact root"),
        config: z
          .string()
          .optional()
          .describe("Explicit cairntrace.config.yml path"),
        speed: z
          .number()
          .min(0.25)
          .max(4)
          .optional()
          .describe("Video playback speed 0.25-4.0 (default: none)"),
        slowMo: z
          .number()
          .min(0)
          .max(5_000)
          .optional()
          .describe("Delay in ms between actions during recording (0-5000)"),
        mode: z
          .enum(["semantic", "keyword", "hybrid"])
          .optional()
          .describe("vecgrep mode (default: config or hybrid)"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Max code matches (default: config or 10)"),
        index: z
          .boolean()
          .optional()
          .describe("Build or refresh the vecgrep index before connecting"),
        env: z.string().optional().describe("Environment name override"),
        coldStart: z
          .boolean()
          .optional()
          .describe("Clear browser state before running (default: true)"),
        reuseServices: z
          .boolean()
          .optional()
          .describe(
            "Run against the services cairn_services_up owns for this config + env (no start, no teardown); without it the audit refuses (exit 4) while that lock exists",
          ),
        noServices: z
          .boolean()
          .optional()
          .describe(
            "Skip the config services lifecycle (the stack is already up). A config whose services would start refuses (exit 4) unless the server runs with --allow-services",
          ),
      },
      outputSchema: AuditResultSchema,
    },
    async (args) => {
      const result = AuditResultSchema.parse(
        await auditSpec(args.specPath, {
          codebase: args.codebase,
          connect: args.connect,
          artifactRoot: args.artifactRoot,
          config: args.config,
          speed: args.speed,
          slowMo: args.slowMo,
          mode: args.mode,
          limit: args.limit,
          index: args.index,
          env: args.env,
          coldStart: args.coldStart ?? true,
          ...(args.reuseServices ? { reuseServices: true } : {}),
          ...(args.noServices ? { noServices: true } : {}),
          allowServicesBoot: allowServices,
        }),
      );
      return {
        content: [
          {
            type: "text",
            text: result.error
              ? result.error
              : `Audit ${result.runId ?? result.specPath}: ${result.codeMatches.length} code match(es)`,
          },
        ],
        structuredContent: result as unknown as Record<string, unknown>,
        ...(auditResultExitCode(result) !== 0 ? { isError: true } : {}),
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
        const listed = await getTvaultKeys(
          { project },
          { skipAvailabilityCheck: true },
        );
        result.target = project;
        result.keys = listed.keys;
        result.error = listed.error;
      } else if (tvaultOk && hasGroup && hasEnv && !hasProject) {
        const listed = await getTvaultKeys(
          { group, env },
          { skipAvailabilityCheck: true },
        );
        result.target = `${group}/${env}`;
        result.keys = listed.keys;
        result.error = listed.error;
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

  /* ----- discovery sessions ----- */

  // Live discovery sessions (tools in ./discoveryTools.ts; each journals to
  // <artifactRoot>/_sessions/<id>/, which outlives the browser).
  const sessions: SessionRegistry = new Map();

  // Auto-sweep expired sessions every 60s
  const sweepTimer = setInterval(() => {
    void sweepSessions(sessions);
    void sweepExpiredAccompany();
  }, 60_000);
  sweepTimer.unref?.();

  // Close all discovery sessions on server shutdown. Signal handlers are named
  // (not inline arrows) and removed on dispose, so building many servers in one
  // process — e.g. across a test suite — doesn't leak SIGINT/SIGTERM listeners.
  let disposed = false;
  function disposeSignalState(): void {
    if (disposed) return;
    disposed = true;
    clearInterval(sweepTimer);
    process.off("SIGINT", onSigint);
    process.off("SIGTERM", onSigterm);
    process.off("exit", onExit);
  }
  let shuttingDown = false;
  function shutdownDiscovery(): void {
    if (shuttingDown) return;
    shuttingDown = true;
    disposeSignalState();
    // These backends are created inline (not via trackBackend), so cleanup.ts
    // does NOT see them. close() is async and won't finish before the process
    // exits on a signal, so synchronously kill each backend's daemon/browser
    // first — otherwise every open discovery session orphans an agent-browser
    // daemon + Chrome on Ctrl-C. Then best-effort async close for the rest.
    endAllJournalsSync(sessions);
    for (const handle of sessions.values()) {
      try {
        handle.backend.terminateSync?.();
      } catch {
        // best-effort — keep terminating the remaining sessions
      }
    }
    terminateAllAccompanySync();
    void closeAllSessions(sessions);
    void closeAllAccompany();
  }
  function onSigint(): void {
    runInvocations.terminateAllSync("SIGINT");
    shutdownDiscovery();
  }
  function onSigterm(): void {
    runInvocations.terminateAllSync("SIGTERM");
    shutdownDiscovery();
  }
  // 'exit' covers the cases the signal handlers miss — an uncaught-exception
  // crash or a process.exit() elsewhere. The handler must be synchronous;
  // terminateSync is, so each daemon is killed instead of orphaned. Idempotent
  // with the signal path (killing an already-dead daemon is a no-op).
  function onExit(): void {
    runInvocations.terminateAllSync("SIGTERM");
    endAllJournalsSync(sessions);
    for (const handle of sessions.values()) {
      try {
        handle.backend.terminateSync?.();
      } catch {
        // best-effort — keep terminating the remaining sessions
      }
    }
    terminateAllAccompanySync();
  }
  process.on("SIGINT", onSigint);
  process.on("SIGTERM", onSigterm);
  process.on("exit", onExit);

  // When the server closes (InMemory transport teardown in tests, or the
  // `cairn mcp` stdio transport ending), dispose the process-global signal
  // listeners + sweep timer and close any open sessions. Chain any onclose the
  // SDK already set so we don't clobber its own teardown.
  const prevOnClose = server.server.onclose?.bind(server.server);
  // `onclose` is the SDK Protocol's callback property, not a DOM EventTarget —
  // assignment is the only way to set it; addEventListener does not apply.
  // oxlint-disable-next-line unicorn/prefer-add-event-listener
  server.server.onclose = () => {
    disposeSignalState();
    void runInvocations.shutdown();
    void closeAllSessions(sessions);
    void closeAllAccompany();
    prevOnClose?.();
  };

  registerDiscoveryTools(server, {
    sessions,
    clientName: () => {
      const info = server.server.getClientVersion();
      return info ? `${info.name}/${info.version}` : undefined;
    },
  });

  server.registerTool(
    "cairn_export_brief",
    {
      title: "Export a journey brief",
      description:
        "Compile a Cairntrace spec into an agent-neutral brief (what to fill, " +
        "what to look for, locator approximations). JSON is urn:cairntrace.dev:brief:v1. " +
        "Use when authored locators will not replay and a harness must complete the journey. " +
        "See `cairn docs brief`.",
      inputSchema: {
        path: z.string().min(1).describe("Path to a single spec YAML"),
        fromRun: z
          .string()
          .optional()
          .describe(
            "Run dir or 'latest' to attach seenLocally from StepResult.resolved",
          ),
        config: z.string().optional().describe("cairntrace.config.yml path"),
        env: z.string().optional().describe("Config environment name"),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X}"),
      },
    },
    async ({ path: inputPath, fromRun, config, env, var: varFlags }) => {
      try {
        const { document, markdown } = await exportOneBrief(inputPath, {
          ...(fromRun ? { fromRun } : {}),
          ...(config ? { config } : {}),
          ...(env ? { env } : {}),
          ...(varFlags ? { var: varFlags } : {}),
        });
        return {
          content: [{ type: "text", text: markdown }],
          structuredContent: document as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `export brief failed: ${(e as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  server.registerTool(
    "cairn_export_playwright",
    {
      title: "Export spec(s) to Playwright",
      description:
        "Convert a Cairntrace YAML spec (or directory of specs) into " +
        "@playwright/test source (TypeScript or JavaScript). Returns a " +
        "coverage report with skips so agents know what was not fully " +
        "translated. Use after authoring/healing when a Playwright handoff " +
        "is required. See `cairn docs export`.",
      inputSchema: {
        path: z
          .string()
          .min(1)
          .describe("Spec file or directory of YAML specs"),
        out: z
          .string()
          .optional()
          .describe("Single-file output path (not for directories)"),
        outDir: z
          .string()
          .optional()
          .describe(
            "Directory for batch export (required for directory input)",
          ),
        lang: z
          .enum(["js", "ts"])
          .optional()
          .describe("Output language; default ts"),
        stdout: z
          .boolean()
          .optional()
          .describe(
            "When true and path is a single file, return source in content (no write)",
          ),
        project: z
          .boolean()
          .optional()
          .describe("Emit a structured Playwright project (requires outDir)"),
        into: z
          .string()
          .optional()
          .describe(
            "Write actions/lib/tests/verifiers into an existing Playwright tree",
          ),
        config: z.string().optional().describe("cairntrace.config.yml path"),
        env: z.string().optional().describe("Config environment name"),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X}"),
      },
    },
    async ({
      path: inputPath,
      out,
      outDir,
      lang,
      stdout,
      project,
      into,
      config,
      env,
      var: varFlags,
    }) => {
      // Same code paths as `cairn export playwright`: project/into exports
      // copy upload fixtures and write `.cairn-export.json`; batch `outDir`
      // exports write the README and manifest too.
      const { parseForExport, writeBatchExport, writeProjectExport } =
        await import("../cli/commands/export");
      const { exportPlaywright } = await import(
        "../core/exporters/playwrightExporter"
      );
      const { expandSpecArgs } = await import("../cli/commands/run");
      const resolvedLang = lang ?? "ts";
      const runtimeOpts = {
        ...(config !== undefined ? { config } : {}),
        ...(env !== undefined ? { env } : {}),
        ...(varFlags !== undefined ? { var: varFlags } : {}),
      };

      try {
        const paths = await expandSpecArgs([inputPath]);
        if (project || into) {
          if (into && project)
            return toolError("use either project or into, not both");
          const dest = into ?? outDir;
          if (!dest) {
            return toolError(
              project
                ? "project export requires outDir"
                : "into requires a directory",
            );
          }
          if (paths.length === 0)
            return toolError(`no specs found at ${inputPath}`);
          const report = await writeProjectExport(
            paths,
            resolvedLang,
            {
              ...runtimeOpts,
              ...(into ? { into } : { project: true }),
              outDir: dest,
            },
            inputPath,
          );
          return {
            content: [
              {
                type: "text",
                text: `Exported Playwright ${
                  into ? "into" : "project"
                } at ${report.outDir} (manifest: ${report.manifest})`,
              },
            ],
            structuredContent: { ...report },
          };
        }
        if (paths.length === 0)
          return toolError(`no specs found at ${inputPath}`);
        if (stdout) {
          if (paths.length !== 1) {
            return toolError("stdout requires a single spec file");
          }
          const { parsed, envTarget } = await parseForExport(
            paths[0]!,
            runtimeOpts,
          );
          const result = exportPlaywright(parsed.resolved, {
            sourcePath: parsed.path,
            lang: resolvedLang,
            // Like `cairn export playwright --stdout`: an imported action's
            // eval.file / upload.path resolve against the action (F13), and
            // the requires guard follows the baked environment.
            stepOrigins: parsed,
            ...(envTarget ? { envTarget } : {}),
          });
          return {
            content: [{ type: "text", text: result.source }],
            structuredContent: {
              status: result.coverage.skips.length > 0 ? "partial" : "written",
              lang: resolvedLang,
              source: result.source,
              coverage: result.coverage,
              name: parsed.spec.name,
            },
          };
        }
        if (paths.length > 1 && !outDir) {
          return toolError("directory export requires outDir");
        }
        if (out && paths.length > 1) {
          return toolError("out is for a single spec; use outDir for batch");
        }
        const written = await writeBatchExport(
          paths,
          resolvedLang,
          {
            ...runtimeOpts,
            ...(out ? { out } : {}),
            ...(outDir ? { outDir } : {}),
          },
          inputPath,
        );
        const failures = (written.report?.errors ?? written.errors)
          .map((e) => `${e.source}: ${e.message}`)
          .join("; ");
        if (!written.report) {
          return toolError(`export failed: ${failures || "nothing exported"}`);
        }
        const report = written.report;
        return {
          content: [
            {
              type: "text",
              text:
                `Exported ${report.files.length} file(s) (${report.status}): ${report.files.map((f) => f.path).join(", ")}` +
                (failures ? `; failed: ${failures}` : ""),
            },
          ],
          structuredContent: { ...report },
          // A leaked late-bound placeholder is an exporter defect (CLI exit 2).
          ...(written.leaked ? { isError: true } : {}),
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text",
              text: `export failed: ${(e as Error).message}`,
            },
          ],
          isError: true,
        };
      }
    },
  );

  return server;
}

/* ----- helpers (inlined from CLI counterparts) ----- */

/** `cairn_spec_heal` error answer: the CLI's error document and exit code. */
function healFailure(err: Error): {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: Record<string, unknown>;
  isError: true;
} {
  return {
    content: [{ type: "text", text: `heal failed: ${err.message}` }],
    structuredContent: {
      $schema: "urn:cairntrace.dev:heal:v1",
      version: "1",
      status: "no-heal-possible",
      error: { name: err.name, message: err.message },
      exitCode: healErrorExitCode(err),
    },
    isError: true,
  };
}

/** A tool-level error result (isError) with one text block. */
function toolError(text: string): {
  content: Array<{ type: "text"; text: string }>;
  isError: true;
} {
  return { content: [{ type: "text", text }], isError: true };
}

async function runDoctorChecks(): Promise<
  Array<{ name: string; ok: boolean; detail: string }>
> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [
    { name: "node", ok: true, detail: `node ${process.versions.node}` },
  ];
  for (const [name, command, args] of [
    ["bun", "bun", ["--version"]],
    ["agent-browser", "agent-browser", ["--version"]],
    ["vecgrep", "vecgrep", ["version"]],
    ["vidtrace", "vidtrace", ["version"]],
    ["monitor", "monitor", ["--version"]],
    ["ffmpeg", "ffmpeg", ["-version"]],
    ["codemap", "codemap", ["version"]],
    ["tvault", "tvault", ["--version"]],
  ] as const) {
    try {
      const r = await execa(command, args, { reject: false });
      checks.push({
        name,
        ok: r.exitCode === 0,
        detail:
          r.exitCode === 0
            ? `${name} ${
                typeof r.stdout === "string"
                  ? name === "ffmpeg"
                    ? (r.stdout.trim().split("\n")[0] ?? "")
                    : r.stdout.trim()
                  : ""
              }`
            : `${name} not on $PATH`,
      });
    } catch {
      checks.push({ name, ok: false, detail: `${name} not on $PATH` });
    }
  }
  checks.push(...(await resolvePlaywrightChecks()));
  // Same file.cheap checks as `cairn doctor`: version and save --meta /
  // publish --run-index support, console session, publisher readiness
  // (never printing values).
  checks.push(...(await resolveFcheapChecks()));
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
