import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { stringify as yamlStringify } from "yaml";
import { z } from "zod";
import { createBackend } from "../cli/backendFactory";
import {
  openDiscovery,
  resumeDiscovery,
  journalRootFor,
} from "../cli/commands/discover";
import { parseVarFlags } from "../cli/commands/run";
import { resolveScopedSecrets } from "../cli/commands/secrets";
import {
  chooseAccompany,
  closeAccompany,
  listAccompany,
  locatorFromSnapshotRef,
  openAccompany,
  statusAccompany,
} from "../core/accompany/AccompanySession";
import { resolveBrowseTarget } from "../core/discovery/browseTarget";
import {
  closeSession,
  captureSnapshot,
  getExportableSteps,
  getInventory,
  getNetwork,
  interact,
  loadNetwork,
  navigate,
  publicUrl,
  removeStep,
  sweepSessions,
  type DiscoverySessionHandle,
  type SessionRegistry,
} from "../core/discovery/DiscoverySession";
import {
  exportJournalSession,
  exportLiveSession,
} from "../core/discovery/exportSession";
import { queryNetwork } from "../core/discovery/networkLog";
import {
  journalSteps,
  listSessions,
  readSessionJournal,
  resolveSessionDir,
} from "../core/discovery/sessionJournal";
import { renderBriefStepMarkdown } from "../core/exporters/briefExporter";
import {
  DiscoveryActionSchema,
  DiscoveryAssertInputSchema,
  DiscoveryEvalInputSchema,
  DiscoveryRequestInputSchema,
  DiscoverySetupSchema,
  DiscoveryWaitInputSchema,
  SnapshotModeSchema,
} from "../core/schema/discovery.v1";
import {
  DiscoveryActionResultSchema,
  DiscoveryExportResultSchema,
  DiscoveryInventoryResultSchema,
  DiscoveryListResultSchema,
  DiscoveryOpenResultSchema,
  DiscoverySnapshotResultSchema,
  DiscoverySuggestResultSchema,
} from "../core/schema/mcp.v1";
import {
  LocatorSchema,
  SpecRequiresSchema,
  type Locator,
} from "../core/schema/spec.v1";
import { VerifierSchema } from "../core/schema/verifier.v1";

/**
 * The interactive authoring tools: `cairn_discover_*` (explore a live page
 * and record a spec) and `cairn_accompany_*` (play a spec, try-then-ask on
 * locator misses). Both journal to `<artifactRoot>/_sessions/<id>/`.
 */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

/** An action's non-fatal notes (a screenshot timeout turned screenshots off). */
function actionWarningLines(warnings: string[] | undefined): string[] {
  return (warnings ?? []).map((warning) => `warning: ${warning}`);
}

function textError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

/** Cap concurrent live browser sessions (a runaway loop can't exhaust fds). */
export const MAX_DISCOVERY_SESSIONS = 8;

const snapshotModeInput = SnapshotModeSchema.optional().describe(
  "What the result's snapshot holds: diff (default — elements added/changed since the previous snapshot, with stable `key`s), compact (elements with a ref or a name), full, or none. The full snapshot is always written to the session journal (snapshotInfo.path).",
);
const configLookupInput = z
  .string()
  .optional()
  .describe(
    "For a session not opened by this server: the cairntrace.config.yml whose artifactRoot holds its journal (default: the cwd's config)",
  );
const maxBytesInput = z
  .number()
  .int()
  .positive()
  .optional()
  .describe("Cap the returned snapshot JSON (default 16384 bytes)");

export interface DiscoveryToolsContext {
  sessions: SessionRegistry;
  /** MCP client `name/version`. */
  clientName: () => string | undefined;
}

export function registerDiscoveryTools(
  server: McpServer,
  ctx: DiscoveryToolsContext,
): void {
  const { sessions } = ctx;
  // Counts opens that passed the cap check but haven't registered their
  // session yet. The cap check and this increment are synchronous (no await
  // between), so two concurrent opens can't both slip under the cap.
  let pendingOpens = 0;
  /** Journal dirs of sessions this server opened (export/resume by id). */
  const journals = new Map<string, string>();

  /**
   * A session's journal dir: live, opened by this server, or under the
   * artifact root of `config` (default: the cwd's config).
   */
  const journalDirOf = async (
    sessionId: string,
    config?: string,
  ): Promise<string> => {
    const live = sessions.get(sessionId)?.journal?.dir;
    if (live) return live;
    const known = journals.get(sessionId);
    if (known) return known;
    return resolveSessionDir(sessionId, await defaultJournalRoot(config));
  };

  const remember = (handle: DiscoverySessionHandle): void => {
    if (handle.journal) journals.set(handle.session.id, handle.journal.dir);
  };

  server.registerTool(
    "cairn_discover_open",
    {
      title: "Open a discovery session",
      description:
        "Start exploring a live page to author a spec. Creates a stateful browser session " +
        "(journaled to <artifactRoot>/_sessions/<id>/, which Cairntrace Studio shows live), " +
        "optionally reaches the starting state first with `setup` — imported reusable actions " +
        "([{use: login_as_admin}]) or a spec's own steps ({fromSpec, untilStep}) — and/or a " +
        "`resume` checkpoint, then opens `url`. Every step runs through the same engine as " +
        "`cairn run` (config, env, vars, ${secrets.X} from the configured provider). Returns the " +
        "first snapshot + locator inventory. A relative URL with no baseUrl is an error on a " +
        "real browser; mock=true explores offline. The browser closes after `ttlMs` idle " +
        "(default 30 min, config discovery.sessionTtlMs); the journal stays, so " +
        "cairn_discover_export and cairn_discover_resume still work.",
      inputSchema: {
        url: z
          .string()
          .min(1)
          .optional()
          .describe(
            "URL or path to open (relative paths join the env baseUrl; ${vars.X}/${env.X}/${secrets.X} resolve for navigation only — the recorded open step keeps the URL exactly as given). Optional when setup or resume leaves you on the page to explore.",
          ),
        setup: DiscoverySetupSchema.optional().describe(
          "Reach the starting state before exploring: [{ use: <action>, vars? }] (imported reusable actions, exported as imports + use:), or { fromSpec: <spec path>, untilStep: <step id | 1-based position> } (replays that spec's steps through untilStep).",
        ),
        imports: z
          .array(z.string().min(1))
          .optional()
          .describe(
            "Action files for setup `use:` (relative to the cwd). Default: config authoring.template.imports, then actions/ directories under the config dir.",
          ),
        resume: z
          .string()
          .regex(/^[a-z][a-z0-9-_]*$/i)
          .optional()
          .describe(
            "Checkpoint to restore before setup (scoped like a run's session.resume; exported as session: { resume }).",
          ),
        env: z
          .string()
          .optional()
          .describe(
            "Environment name for config baseUrl (default: config defaultEnvironment, else local)",
          ),
        config: z
          .string()
          .optional()
          .describe(
            "Explicit cairntrace.config.yml (default: discovered from cwd)",
          ),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X}"),
        backend: z
          .enum(["agent-browser", "playwright"])
          .optional()
          .describe(
            "Browser backend (default: config discovery.backend, else agent-browser)",
          ),
        mock: z
          .boolean()
          .optional()
          .describe("Use mock backend (no real browser)"),
        headed: z
          .boolean()
          .optional()
          .describe("Show the browser window (real backends only)"),
        waitUntil: z
          .enum(["networkidle", "load", "domcontentloaded"])
          .optional()
          .describe("Wait condition after navigation"),
        ttlMs: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            "Idle time before the browser closes (default config discovery.sessionTtlMs, else 30 min)",
          ),
        snapshotMode: snapshotModeInput,
        maxBytes: maxBytesInput,
        sessionName: z
          .string()
          .optional()
          .describe("Custom agent-browser session name"),
        provider: z
          .string()
          .optional()
          .describe(
            "agent-browser provider: ios (Mobile Safari via Appium) | browserbase | kernel | …",
          ),
        device: z
          .string()
          .optional()
          .describe(
            'iOS device name, e.g. "iPhone 15 Pro" (with provider: ios)',
          ),
      },
    },
    async (input) => {
      if (input.url === undefined && !input.setup && !input.resume) {
        return textError(
          "discovery open failed: pass url, setup, or resume (setup/resume alone explore the page they leave you on)",
        );
      }
      // Sweep expired sessions first so the cap reflects live sessions only.
      await sweepSessions(sessions);
      if (sessions.size + pendingOpens >= MAX_DISCOVERY_SESSIONS) {
        return textError(
          `too many open discovery sessions (${sessions.size}/${MAX_DISCOVERY_SESSIONS}); close some with cairn_discover_close before opening more`,
        );
      }
      // Reserve the slot synchronously — no await between the cap check and
      // this increment, so a concurrent open can't also pass the check.
      pendingOpens++;
      // Owned here until registered: a failure after openDiscovery returned
      // must not orphan the browser or leave the journal `open`.
      let owned: DiscoverySessionHandle | undefined;
      try {
        const client = ctx.clientName();
        const { handle, target } = await openDiscovery({
          ...input,
          origin: "mcp",
          ...(client ? { client } : {}),
        });
        owned = handle;
        let inventory;
        try {
          inventory = await getInventory(handle);
        } catch {
          // inventory is best-effort
        }
        const opened = handle.opened!;
        const result = {
          sessionId: handle.session.id,
          url: publicUrl(handle),
          snapshot: opened.snapshot,
          snapshotInfo: opened.snapshotInfo,
          ...(inventory ? { inventory } : {}),
          env: target.envName,
          backend: handle.backend.name,
          ttlMs: handle.ttlMs,
          ...(handle.journal ? { journal: handle.journal.dir } : {}),
          ...(opened.setup ? { setup: opened.setup } : {}),
          ...(opened.screenshot ? { screenshot: opened.screenshot } : {}),
          ...(target.testIdAttribute
            ? { testIdAttribute: target.testIdAttribute }
            : {}),
          ...(opened.warnings.length > 0 ? { warnings: opened.warnings } : {}),
        };
        // Parse before registering so a schema failure can't leave a dead
        // handle in the registry counting against the session cap.
        const structuredContent = DiscoveryOpenResultSchema.parse(result);
        sessions.set(handle.session.id, handle);
        owned = undefined;
        remember(handle);
        return {
          content: [
            {
              type: "text",
              text: openText(handle, [
                ...(opened.setup
                  ? [
                      `Setup ok: ${opened.setup.steps} steps in ${opened.setup.durationMs}ms`,
                    ]
                  : []),
                ...(inventory?.roles
                  ? [`${inventory.roles.length} role locators`]
                  : []),
                ...(inventory?.testids
                  ? [`${inventory.testids.length} testid locators`]
                  : []),
              ]),
            },
          ],
          structuredContent: structuredContent as unknown as Record<
            string,
            unknown
          >,
        };
      } catch (e) {
        if (owned) await closeSession(owned, "close").catch(() => undefined);
        return textError(`discovery open failed: ${(e as Error).message}`);
      } finally {
        pendingOpens--;
      }
    },
  );

  server.registerTool(
    "cairn_discover_resume",
    {
      title: "Resume a discovery session from its journal",
      description:
        "Re-open an expired or closed discovery session (or one from another server process): " +
        "a fresh browser restores its checkpoint, runs its setup again and replays every " +
        "recorded step through the runner to reach the same state. Recording continues in the " +
        "same journal under the same sessionId.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        config: configLookupInput,
        var: z
          .array(z.string())
          .optional()
          .describe(
            "key=value vars (re-supply any whose value the journal redacted)",
          ),
        backend: z.enum(["agent-browser", "playwright"]).optional(),
        mock: z.boolean().optional(),
        headed: z.boolean().optional(),
        ttlMs: z.number().int().positive().optional(),
        snapshotMode: snapshotModeInput,
        maxBytes: maxBytesInput,
      },
    },
    async ({ sessionId, config, ...input }) => {
      if (sessions.has(sessionId)) {
        return textError(
          `session ${sessionId} is open; resume is for an expired or closed session`,
        );
      }
      await sweepSessions(sessions);
      if (sessions.size + pendingOpens >= MAX_DISCOVERY_SESSIONS) {
        return textError(
          `too many open discovery sessions (${sessions.size}/${MAX_DISCOVERY_SESSIONS})`,
        );
      }
      pendingOpens++;
      try {
        const dir = await journalDirOf(sessionId, config);
        const client = ctx.clientName();
        const { handle } = await resumeDiscovery(dir, {
          ...input,
          origin: "mcp",
          ...(client ? { client } : {}),
        });
        sessions.set(handle.session.id, handle);
        remember(handle);
        const opened = handle.opened!;
        return {
          content: [
            {
              type: "text",
              text: openText(handle, [
                `Resumed: ${handle.session.steps.length} steps replayed`,
              ]),
            },
          ],
          structuredContent: DiscoveryOpenResultSchema.parse({
            sessionId: handle.session.id,
            url: publicUrl(handle),
            snapshot: opened.snapshot,
            snapshotInfo: opened.snapshotInfo,
            backend: handle.backend.name,
            ttlMs: handle.ttlMs,
            replayed: handle.session.steps.length,
            ...(handle.journal ? { journal: handle.journal.dir } : {}),
            ...(opened.setup ? { setup: opened.setup } : {}),
            ...(opened.screenshot ? { screenshot: opened.screenshot } : {}),
            ...(opened.warnings.length > 0
              ? { warnings: opened.warnings }
              : {}),
          }) as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return textError(`discovery resume failed: ${(e as Error).message}`);
      } finally {
        pendingOpens--;
      }
    },
  );

  server.registerTool(
    "cairn_discover_snapshot",
    {
      title: "Capture current page snapshot",
      description:
        "Capture the accessibility tree of the current page in a discovery " +
        "session. Default snapshotMode diff returns only what changed since " +
        "the previous snapshot (elements carry a stable `key`); the full text " +
        "is written to the journal (snapshotInfo.path).",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        snapshotMode: snapshotModeInput,
        maxBytes: maxBytesInput,
      },
    },
    async ({ sessionId, snapshotMode, maxBytes }) => {
      const handle = sessions.get(sessionId);
      if (!handle) return notFound(sessionId);
      try {
        const { snapshot, url, snapshotInfo } = await captureSnapshot(handle, {
          ...(snapshotMode ? { mode: snapshotMode } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text: `Snapshot at ${url}: ${snapshotInfo.elements} elements (${snapshot.length} returned, ${snapshotInfo.mode})`,
            },
          ],
          structuredContent: DiscoverySnapshotResultSchema.parse({
            snapshot,
            url,
            snapshotInfo,
          }) as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return textError(`snapshot failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_discover_interact",
    {
      title: "Interact with the page in a discovery session",
      description:
        "Perform one step on the current page and record it as a spec step: click, fill, " +
        "hover, type, select, upload, scroll, press (+target), focus, eval {js|file, args, " +
        "assign}, wait {text|notText|url|value|selector|load|ms}, request {method, url, body, " +
        "expectStatus, assign}, or assert (a wait condition that must hold; recorded as a wait " +
        "step). `step` takes any spec step instead (validated with the spec schema; `use:` " +
        "resolves imported actions). It runs through the same engine as `cairn run`; an " +
        "eval/request `assign` from an earlier action fills `${evals.X…}` / `${requests.X…}` " +
        "in later ones (a reference nothing captured is refused). Returns " +
        "the post-action snapshot (snapshotMode, default diff), network.mutations (non-GET " +
        "requests seen: method, path, status), a journal screenshot, and eval/request values " +
        "in `result`. Failed steps are not recorded.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        action: DiscoveryActionSchema.optional().describe(
          "Action to perform (or pass `step`)",
        ),
        target: z
          .union([LocatorSchema, z.string().min(1)])
          .optional()
          .describe(
            'Element locator (role/label/text/testid/selector) or CSS selector string. Required for click/fill/hover/type/focus/select/upload; optional for scroll and press. Use a stable locator from cairn_discover_inventory — snapshot @refs (e.g. "@e2") are rejected because they cannot replay.',
          ),
        value: z
          .string()
          .optional()
          .describe(
            "fill/type text, press key name, or select option value. Write secrets as ${secrets.NAME} (a known secret literal is recorded as its placeholder anyway).",
          ),
        label: z
          .string()
          .optional()
          .describe(
            "select action: the option's visible text (alternative to value; provide exactly one of value | label)",
          ),
        path: z
          .string()
          .optional()
          .describe(
            "upload action: the file to set (relative paths resolve against the cwd and are recorded as ${config.dir}/…)",
          ),
        scrollDirection: z
          .enum(["up", "down", "left", "right"])
          .optional()
          .describe("Scroll direction (scroll action only)"),
        scrollPixels: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe("Pixels to scroll (scroll action only, default 500)"),
        eval: DiscoveryEvalInputSchema.optional().describe(
          "eval action: { js | file, args?, assign?, timeoutMs? } (the spec eval step body)",
        ),
        wait: DiscoveryWaitInputSchema.optional().describe(
          "wait action: a spec wait condition",
        ),
        assert: DiscoveryAssertInputSchema.optional().describe(
          "assert action: a wait condition (text/notText/url/value/selector) that must hold; recorded as a wait step",
        ),
        request: DiscoveryRequestInputSchema.optional().describe(
          "request action: the spec request step body (browser cookies included)",
        ),
        step: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            "Any spec step object instead of action (e.g. { click: {...}, until: ... } or { use: { action, vars } })",
          ),
        id: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .optional()
          .describe("Step id to record (snake_case)"),
        snapshotMode: snapshotModeInput,
        maxBytes: maxBytesInput,
      },
    },
    async ({ sessionId, ...input }) => {
      const handle = sessions.get(sessionId);
      if (!handle) return notFound(sessionId);
      try {
        const result = await interact(handle, {
          ...(input as Parameters<typeof interact>[1]),
          ...(input.eval
            ? { eval: input.eval as Record<string, unknown> }
            : {}),
          ...(input.request
            ? { request: input.request as Record<string, unknown> }
            : {}),
        });
        const label = input.action ?? "step";
        const mutations = result.network?.mutations ?? [];
        return {
          content: [
            {
              type: "text",
              text: result.ok
                ? [
                    `${label} ok at ${result.url} (${result.snapshot.length} snapshot elements returned)`,
                    ...(mutations.length > 0
                      ? [
                          `network: ${mutations
                            .map(
                              (m) =>
                                `${m.method} ${m.path}${
                                  m.status !== undefined ? ` ${m.status}` : ""
                                }`,
                            )
                            .join(", ")}`,
                        ]
                      : []),
                    ...(result.result
                      ? [`result: ${JSON.stringify(result.result)}`]
                      : []),
                    ...actionWarningLines(result.warnings),
                  ].join("\n")
                : [
                    `${label} failed: ${result.error ?? "unknown"}`,
                    ...actionWarningLines(result.warnings),
                  ].join("\n"),
            },
          ],
          structuredContent: DiscoveryActionResultSchema.parse(
            result,
          ) as unknown as Record<string, unknown>,
          isError: !result.ok,
        };
      } catch (e) {
        return textError(`interact failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_discover_navigate",
    {
      title: "Navigate to a new URL in a discovery session",
      description:
        "Navigate the session's browser to a new URL. The navigation is " +
        "recorded as an open step (a relative URL joins the config baseUrl " +
        "and is recorded relative). Returns the new page snapshot " +
        "(snapshotMode, default diff) and network.mutations.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        url: z.string().min(1).describe("URL or path to navigate to"),
        waitUntil: z
          .enum(["networkidle", "load", "domcontentloaded"])
          .optional()
          .describe("Wait condition after navigation"),
        snapshotMode: snapshotModeInput,
        maxBytes: maxBytesInput,
      },
    },
    async ({ sessionId, url, waitUntil, snapshotMode, maxBytes }) => {
      const handle = sessions.get(sessionId);
      if (!handle) return notFound(sessionId);
      try {
        const result = await navigate(handle, url, {
          ...(waitUntil !== undefined ? { waitUntil } : {}),
          ...(snapshotMode ? { snapshotMode } : {}),
          ...(maxBytes !== undefined ? { maxBytes } : {}),
        });
        return {
          content: [
            {
              type: "text",
              text: [
                result.ok
                  ? `Navigated to ${result.url} (${result.snapshot.length} snapshot elements returned)`
                  : `Navigation failed: ${result.error ?? result.url}`,
                ...actionWarningLines(result.warnings),
              ].join("\n"),
            },
          ],
          structuredContent: DiscoveryActionResultSchema.parse(
            result,
          ) as unknown as Record<string, unknown>,
          isError: !result.ok,
        };
      } catch (e) {
        return textError(`navigate failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_discover_network",
    {
      title: "Requests a discovery session observed",
      description:
        "Network requests seen during the session's actions (including requests that " +
        "completed after an action returned), redacted: method, URL without query string, " +
        "path, status, resource type, timing — no headers or bodies. Use it to find the " +
        "mutation a step triggers (e.g. a PATCH to assert with postcondition.network). " +
        "Works on an expired or closed session from its journal.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        sinceAction: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Only requests of action index >= this (result `index`)"),
        method: z.string().optional().describe("Only this HTTP method"),
        urlContains: z
          .string()
          .optional()
          .describe("Only URLs containing this"),
        limit: z
          .number()
          .int()
          .positive()
          .max(1000)
          .optional()
          .describe("Newest entries returned (default 200)"),
      },
    },
    async ({ sessionId, sinceAction, method, urlContains, limit }) => {
      const query = {
        ...(sinceAction !== undefined ? { sinceAction } : {}),
        ...(method !== undefined ? { method } : {}),
        ...(urlContains !== undefined ? { urlContains } : {}),
        ...(limit !== undefined ? { limit } : {}),
      };
      try {
        const handle = sessions.get(sessionId);
        const result = handle
          ? await getNetwork(handle, query)
          : queryNetwork(loadNetwork(await journalDirOf(sessionId)), query);
        return {
          content: [
            {
              type: "text",
              text:
                result.entries.length === 0
                  ? "No matching requests"
                  : result.entries
                      .map(
                        (entry) =>
                          `#${entry.action} ${entry.method} ${entry.url}${
                            entry.status !== undefined ? ` ${entry.status}` : ""
                          }${entry.late ? " (late)" : ""}`,
                      )
                      .join("\n"),
            },
          ],
          structuredContent: {
            sessionId,
            ...result,
          },
        };
      } catch (e) {
        return textError(`network failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_discover_inventory",
    {
      title: "Get locator inventory from current page",
      description:
        "Collect role-based and data-testid locator inventory from the " +
        "current page in the session. Returns structured locator entries " +
        "with refs, counts, and ready-to-use spec locator objects.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        roles: z
          .boolean()
          .optional()
          .describe("Include role locators (default: true if neither set)"),
        testids: z
          .boolean()
          .optional()
          .describe(
            "Include test-id locators on the session's browser.testIdAttribute (default data-testid; default: true if neither set)",
          ),
      },
    },
    async ({ sessionId, roles, testids }) => {
      const handle = sessions.get(sessionId);
      if (!handle) return notFound(sessionId);
      try {
        const inventory = await getInventory(handle, {
          ...(roles !== undefined ? { roles } : {}),
          ...(testids !== undefined ? { testids } : {}),
        });
        const result = {
          ...(inventory.roles ? { roles: inventory.roles } : {}),
          ...(inventory.testids ? { testids: inventory.testids } : {}),
          ...(inventory.total !== undefined ? { total: inventory.total } : {}),
          ...(inventory.truncated !== undefined
            ? { truncated: inventory.truncated }
            : {}),
          ...(inventory.limit !== undefined ? { limit: inventory.limit } : {}),
          ...(inventory.testIdAttribute !== undefined
            ? { testIdAttribute: inventory.testIdAttribute }
            : {}),
        };
        return {
          content: [
            {
              type: "text",
              text: [
                `Inventory at ${publicUrl(handle)}:`,
                ...(inventory.roles
                  ? [`  ${inventory.roles.length} role locators`]
                  : []),
                ...(inventory.testids
                  ? [`  ${inventory.testids.length} testid locators`]
                  : []),
              ].join("\n"),
            },
          ],
          structuredContent: DiscoveryInventoryResultSchema.parse(
            result,
          ) as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return textError(`inventory failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_discover_suggest",
    {
      title: "Show recorded steps as spec YAML",
      description:
        "Return the session's exportable steps (failed interactions excluded — " +
        "exactly what cairn_discover_export will write after the setup steps) as " +
        "spec-compatible YAML text, with each step's action `index` " +
        "(cairn_discover_remove_step undoes one). Works from the journal after " +
        "the browser closed.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
      },
    },
    async ({ sessionId }) => {
      let steps: Record<string, unknown>[];
      let indexes: number[];
      let skippedFailed: number;
      const handle = sessions.get(sessionId);
      try {
        if (handle) {
          const exportable = getExportableSteps(handle);
          steps = exportable.steps;
          skippedFailed = exportable.skippedFailed;
          indexes = handle.session.steps
            .filter((step) => step.ok && !step.removed)
            .map((step) => step.index ?? 0);
        } else {
          const read = await readSessionJournal(await journalDirOf(sessionId));
          if (!read) return notFound(sessionId);
          const fromJournal = journalSteps(read.events);
          steps = fromJournal.steps.map((entry) => entry.step);
          indexes = fromJournal.steps.map((entry) => entry.index);
          skippedFailed = fromJournal.failedActions;
        }
      } catch {
        return notFound(sessionId);
      }
      const yaml = yamlStringify(steps);
      const skipNote =
        skippedFailed > 0
          ? `# (excluded ${skippedFailed} failed step${
              skippedFailed === 1 ? "" : "s"
            } that did not replay)\n`
          : "";
      return {
        content: [{ type: "text", text: skipNote + yaml }],
        structuredContent: DiscoverySuggestResultSchema.parse({
          steps,
          stepCount: steps.length,
          skippedFailed,
          indexes,
        }) as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "cairn_discover_remove_step",
    {
      title: "Undo a recorded discovery step",
      description:
        "Drop the step recorded by action `index` (see cairn_discover_suggest indexes or " +
        "the interact result's index) from what export writes. The browser state is not " +
        "rolled back; the journal keeps the removal as step.removed.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        index: z.number().int().positive().describe("Action index to undo"),
      },
    },
    async ({ sessionId, index }) => {
      const handle = sessions.get(sessionId);
      if (!handle) return notFound(sessionId);
      const result = removeStep(handle, index);
      return {
        content: [
          {
            type: "text",
            text: result.removed
              ? `Removed step #${index} (${result.steps} steps remain)`
              : `No recorded step #${index}`,
          },
        ],
        structuredContent: { sessionId, index, ...result },
        isError: !result.removed,
      };
    },
  );

  server.registerTool(
    "cairn_discover_export",
    {
      title: "Export recorded steps as a spec YAML",
      description:
        "Write the session as a spec: the setup as imports + `use:` steps (or the source " +
        "spec's steps through untilStep), the recorded steps, and the provided intent + " +
        "outcomes. The spec is immediately parsed with the session's config/env/vars and " +
        "cold-start/contractHash gaps are reported as warnings. Works from the journal alone " +
        "after the browser expired or closed. The session's draft.spec.yml follows the " +
        "exported intent/outcomes. CONVENTIONS (on with `into`, `conventions: true`, or no " +
        "`path`): the spec lands in the drafts dir (config authoring.draftsDir, default " +
        "flows/_drafts, which `cairn run <dir>` skips) and is written the project's way — " +
        "runs of steps an existing catalog action performs become `use: {action, vars}`, " +
        "literals equal to a config var become ${vars.X}, absolute URLs under the env baseUrl " +
        "become relative, every step gets a snake_case id, navigations get a wait, mutations " +
        "the session observed become postcondition.network, and authoring.template " +
        "requires/metadata.tags/imports apply. Known secret values are always written as their " +
        "placeholders; with conventions, a literal typed into a password-type field that matches " +
        "no known secret refuses the export (refuseSecrets:false keeps it with a warning; a plain " +
        "path export warns unless refuseSecrets:true). The result's `report` " +
        "lists liftedVars, reusedActions (with confidence), secretsPlaceholdered and warnings; " +
        "next: cairn_spec_finish.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Output path for the spec YAML file (relative to the cwd). Optional with into/conventions.",
          ),
        into: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Convention export target relative to the config dir: a folder (the spec is <name>.yml inside) or a .yml file. Default: the drafts dir. Refuses an existing file unless overwrite.",
          ),
        name: z
          .string()
          .regex(/^[a-z][a-z0-9_]*$/)
          .optional()
          .describe(
            "Spec name (snake_case); also the file name inside `into`. Default: from path, else the intent's first words.",
          ),
        conventions: z
          .boolean()
          .optional()
          .describe(
            "Apply the project conventions (default: true with into or without path)",
          ),
        reuseActions: z
          .boolean()
          .optional()
          .describe(
            "Replace runs of recorded steps an existing action performs by use: (default true)",
          ),
        liftVars: z
          .boolean()
          .optional()
          .describe(
            "Write literals equal to a config var of the session env as ${vars.X} (default true)",
          ),
        refuseSecrets: z
          .boolean()
          .optional()
          .describe(
            "Refuse a literal typed into a password-type field that matches no known secret (default: true with conventions, false for a plain path export, which warns)",
          ),
        requires: SpecRequiresSchema.optional().describe(
          "requires: for the spec, e.g. { env: [local], mutates: true } (default: the setup's, else authoring.template.requires)",
        ),
        tags: z
          .array(z.string().min(1))
          .optional()
          .describe("metadata.tags added to authoring.template.metadata.tags"),
        intent: z
          .string()
          .min(1)
          .describe("One-line intent statement for the spec"),
        outcomes: z
          .array(
            z.object({
              id: z.string().min(1).describe("Snake_case outcome ID"),
              description: z
                .string()
                .min(1)
                .describe("Human-readable outcome description"),
              verify: VerifierSchema.describe(
                "Verifier object (e.g. { text: { contains: 'Dashboard' } })",
              ),
            }),
          )
          .min(1)
          .describe("Outcome definitions (the spec contract)"),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            "Replace an existing spec even if it carries a stamped contractHash. Without this, exporting over a stamped spec is refused so its locked intent/outcomes aren't silently clobbered.",
          ),
        resume: z
          .string()
          .regex(/^[a-z][a-z0-9-_]*$/i)
          .optional()
          .describe(
            "Checkpoint name to resume from (captured via cairn_checkpoint_capture). Sets `session: { resume: <name> }` so the exported spec satisfies the cold-start contract for an authenticated flow. Default: the session's own resume.",
          ),
        close: z
          .boolean()
          .optional()
          .describe("Close the session's browser after exporting"),
        config: configLookupInput,
      },
    },
    async ({ sessionId, close, config, ...opts }) => {
      const handle = sessions.get(sessionId);
      try {
        const exportOpts = {
          ...(opts.path !== undefined ? { path: opts.path } : {}),
          intent: opts.intent,
          outcomes: opts.outcomes,
          ...(opts.overwrite ? { overwrite: true } : {}),
          ...(opts.resume !== undefined ? { resume: opts.resume } : {}),
          ...(opts.into !== undefined ? { into: opts.into } : {}),
          ...(opts.name !== undefined ? { name: opts.name } : {}),
          ...(opts.conventions !== undefined
            ? { conventions: opts.conventions }
            : {}),
          ...(opts.reuseActions !== undefined
            ? { reuseActions: opts.reuseActions }
            : {}),
          ...(opts.liftVars !== undefined ? { liftVars: opts.liftVars } : {}),
          ...(opts.refuseSecrets !== undefined
            ? { refuseSecrets: opts.refuseSecrets }
            : {}),
          ...(opts.requires !== undefined ? { requires: opts.requires } : {}),
          ...(opts.tags !== undefined ? { tags: opts.tags } : {}),
        };
        let result;
        if (handle) {
          result = await exportLiveSession(handle, exportOpts);
        } else {
          let dir: string;
          try {
            dir = await journalDirOf(sessionId, config);
          } catch {
            return notFound(sessionId);
          }
          result = await exportJournalSession(dir, exportOpts);
        }
        if (handle && close) {
          sessions.delete(sessionId);
          await closeSession(handle, "export");
        }
        const { writtenTo: _writtenTo, ...shown } = result;
        const skipNote =
          result.skippedFailed > 0
            ? ` (excluded ${result.skippedFailed} failed step${
                result.skippedFailed === 1 ? "" : "s"
              } that did not replay)`
            : "";
        const warningNote =
          result.warnings && result.warnings.length > 0
            ? ` Warnings: ${result.warnings.join(" ")}`
            : "";
        const report = result.report;
        const conventionNote = report
          ? ` Conventions: reused ${
              report.reusedActions
                .filter((r) => r.applied)
                .map((r) => r.action)
                .join(", ") || "no action"
            }; lifted ${report.liftedVars.length} var(s); ${report.secretsPlaceholdered.length} secret(s) as placeholders${
              report.warnings.length > 0
                ? `; notes: ${report.warnings.join(" ")}`
                : ""
            }.${result.nextActions ? ` Next: ${result.nextActions[0]}` : ""}`
          : "";
        return {
          content: [
            {
              type: "text",
              text: result.verifyOk
                ? `Exported ${result.stepCount} steps to ${result.path} (parses OK)${skipNote}.${warningNote}${conventionNote}`
                : `Exported ${result.stepCount} steps to ${result.path} (verify FAILED: ${result.verifyErrors?.join("; ")})${skipNote}`,
            },
          ],
          structuredContent: DiscoveryExportResultSchema.parse(
            shown,
          ) as unknown as Record<string, unknown>,
          isError: !result.verifyOk,
        };
      } catch (e) {
        return textError(`export failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_discover_close",
    {
      title: "Close a discovery session",
      description:
        "Close the browser session and free the backend. The journal stays " +
        "(export and resume still work). Call this when exploration is done.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Discovery session ID"),
      },
    },
    async ({ sessionId }) => {
      const handle = sessions.get(sessionId);
      if (!handle) return notFound(sessionId);
      // Remove from the registry before closing so a concurrent call sees
      // "session not found" rather than racing the teardown.
      sessions.delete(sessionId);
      await closeSession(handle);
      return {
        content: [{ type: "text", text: `Session ${sessionId} closed` }],
        structuredContent: {
          sessionId,
          closed: true,
          ...(handle.journal ? { journal: handle.journal.dir } : {}),
        },
      };
    },
  );

  server.registerTool(
    "cairn_discover_list",
    {
      title: "List discovery sessions",
      description:
        "List the open discovery sessions (IDs, URLs, recorded step counts). " +
        "all=true adds the journaled sessions under the artifact root " +
        "(expired, closed, exported; discovery and accompany).",
      inputSchema: {
        all: z
          .boolean()
          .optional()
          .describe("Include journaled sessions that are no longer open"),
      },
    },
    async ({ all }) => {
      const list = [...sessions.values()].map((h) => ({
        sessionId: h.session.id,
        url: publicUrl(h),
        stepCount: getExportableSteps(h).steps.length,
        lastActivity: new Date(h.session.lastActivity).toISOString(),
        status: "open",
        ...(h.journal ? { journal: h.journal.dir } : {}),
      }));
      const journaled = all
        ? (await listSessions(await defaultJournalRoot()))
            .filter(({ session }) => !sessions.has(session.sessionId))
            .slice(0, 50)
            .map(({ dir, session }) => ({
              sessionId: session.sessionId,
              url: session.currentUrl ?? session.startUrl,
              stepCount: session.stepCount ?? 0,
              lastActivity: session.lastActivityAt,
              status: session.status,
              kind: session.kind,
              journal: dir,
            }))
        : [];
      const rows = [...list, ...journaled];
      return {
        content: [
          {
            type: "text",
            text:
              rows.length === 0
                ? "No active discovery sessions"
                : rows
                    .map(
                      (s) =>
                        `  ${s.sessionId} ${s.status} → ${s.url} (${s.stepCount} steps, last: ${s.lastActivity})`,
                    )
                    .join("\n"),
          },
        ],
        structuredContent: DiscoveryListResultSchema.parse({
          sessions: rows,
        }) as unknown as Record<string, unknown>,
      };
    },
  );

  /* ----- accompany ----- */

  server.registerTool(
    "cairn_accompany_open",
    {
      title: "Open an accompanied spec run",
      description:
        "Run a spec with try-then-ask: authored locators are attempted first. " +
        "On a miss the session parks with a brief + live inventory. Choose a locator " +
        "with cairn_accompany_choose. The harness chooses WHERE; values stay authored. " +
        "Every choice is journaled (_sessions/<id>/, kind accompany) and accepted " +
        "replacements are applied to a draft copy of the spec (draft.spec.yml, or " +
        "`draftTo`) — the source spec is never written.",
      inputSchema: {
        path: z.string().min(1).describe("Path to the spec YAML"),
        env: z.string().optional().describe("Environment name override"),
        mock: z.boolean().optional().describe("Use the in-memory backend"),
        backend: z
          .enum(["agent-browser", "playwright", "mock"])
          .optional()
          .describe("Browser backend"),
        coldStart: z
          .boolean()
          .optional()
          .describe("Wipe browser state before steps"),
        headed: z
          .boolean()
          .optional()
          .describe("Show the browser window (real backends only)"),
        config: z.string().optional().describe("cairntrace.config.yml path"),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X}"),
        draftTo: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Also write the draft copy here (e.g. flows/_drafts/<name>.yml); never the source spec",
          ),
      },
    },
    async ({
      path,
      env,
      mock,
      backend: backendChoice,
      coldStart,
      headed,
      config,
      var: varFlags,
      draftTo,
    }) => {
      const backend = createBackend({
        ...(backendChoice !== undefined ? { backend: backendChoice } : {}),
        mock,
        session: `cairntrace-accompany-${process.pid}-${randomUUID()}`,
        ...(headed !== undefined ? { headed } : {}),
      });
      try {
        const varOverrides = parseVarFlags(varFlags);
        const scopedSecrets = await resolveScopedSecrets(path, {
          ...(env !== undefined ? { environmentOverride: env } : {}),
          ...(config !== undefined ? { configPath: config } : {}),
          ...(Object.keys(varOverrides).length > 0
            ? { vars: varOverrides }
            : {}),
        });
        const client = ctx.clientName();
        const { open, handle } = await openAccompany({
          specPath: path,
          backend,
          env: scopedSecrets.env,
          childEnv: scopedSecrets.childEnv,
          secretValues: scopedSecrets.secretValues,
          selectedTvaultKeys: scopedSecrets.selectedKeys,
          ...(env !== undefined ? { environmentOverride: env } : {}),
          ...(coldStart !== undefined ? { coldStart } : {}),
          ...(config !== undefined ? { configPath: config } : {}),
          ...(Object.keys(varOverrides).length > 0
            ? { vars: varOverrides }
            : {}),
          journal: {
            origin: "mcp",
            ...(client ? { client } : {}),
            ...(headed !== undefined ? { headed } : {}),
            ...(draftTo !== undefined ? { draftTo } : {}),
          },
        });
        const text =
          open.status === "needs_choice" && open.parked
            ? renderBriefStepMarkdown(open.parked.step)
            : `accompany ${open.status}`;
        return {
          content: [{ type: "text", text }],
          structuredContent: {
            ...open,
            ...(handle.journal ? { journal: handle.journal } : {}),
          } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        await backend.close().catch(() => undefined);
        return textError(`accompany open failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_accompany_choose",
    {
      title: "Choose a locator for a parked accompany step",
      description:
        "Supply a Locator or a snapshot ref (e12 / @e12) for the parked step. " +
        "Cairntrace retries the same authored value against that locator; an " +
        "accepted choice is journaled and applied to the draft copy (as role + " +
        "name, never the ephemeral ref).",
      inputSchema: {
        sessionId: z.string().min(1).describe("Accompany session ID"),
        locator: LocatorSchema.optional().describe("Chosen locator (WHERE)"),
        ref: z
          .string()
          .min(1)
          .optional()
          .describe("Snapshot ref from the miss packet (e12 or @e12)"),
      },
    },
    async ({ sessionId, locator, ref }) => {
      try {
        const chosen = locator ?? locatorFromAccompanyRef(sessionId, ref);
        const open = await chooseAccompany(sessionId, chosen);
        const handle = statusAccompany(sessionId);
        return {
          content: [{ type: "text", text: `accompany ${open.status}` }],
          structuredContent: {
            ...open,
            ...(handle?.draftPath ? { draftPath: handle.draftPath } : {}),
            ...(handle?.journal ? { journal: handle.journal } : {}),
          } as unknown as Record<string, unknown>,
        };
      } catch (e) {
        return textError(`accompany choose failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_accompany_status",
    {
      title: "Accompany session status",
      description:
        "Current cursor, parked miss packet, outcomes so far, the locator decisions " +
        "made, and the draft copy path.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Accompany session ID"),
      },
    },
    async ({ sessionId }) => {
      const handle = statusAccompany(sessionId);
      if (!handle) {
        return textError(`accompany session not found: ${sessionId}`);
      }
      return {
        content: [{ type: "text", text: `accompany ${handle.status}` }],
        structuredContent: handle as unknown as Record<string, unknown>,
      };
    },
  );

  server.registerTool(
    "cairn_accompany_close",
    {
      title: "Close an accompany session",
      description:
        "Abort a parked miss if needed, write the run if it finished, free the backend. The journal and draft copy stay.",
      inputSchema: {
        sessionId: z.string().min(1).describe("Accompany session ID"),
      },
    },
    async ({ sessionId }) => {
      const handle = statusAccompany(sessionId);
      await closeAccompany(sessionId);
      return {
        content: [{ type: "text", text: "closed" }],
        structuredContent: {
          closed: true,
          sessionId,
          ...(handle?.journal ? { journal: handle.journal } : {}),
          ...(handle?.draftPath ? { draftPath: handle.draftPath } : {}),
        },
      };
    },
  );

  server.registerTool(
    "cairn_accompany_list",
    {
      title: "List accompany sessions",
      description: "Active try-then-ask sessions.",
      inputSchema: {},
    },
    async () => {
      const accompanySessions = listAccompany().map((s) => ({
        sessionId: s.id,
        status: s.status,
        lastActivity: new Date(s.lastActivity).toISOString(),
        parkedStep: s.parked?.step.id,
        ...(s.journal ? { journal: s.journal } : {}),
      }));
      return {
        content: [
          {
            type: "text",
            text:
              accompanySessions.length === 0
                ? "no accompany sessions"
                : accompanySessions
                    .map((s) => `  ${s.sessionId} ${s.status}`)
                    .join("\n"),
          },
        ],
        structuredContent: { sessions: accompanySessions },
      };
    },
  );
}

function openText(
  handle: DiscoverySessionHandle,
  extra: string[] = [],
): string {
  return [
    `Session ${handle.session.id} at ${publicUrl(handle)}`,
    ...extra,
    `${handle.opened?.snapshotInfo.elements ?? 0} elements on the page (${handle.opened?.snapshotInfo.returned ?? 0} returned, ${handle.snapshotMode})`,
    ...(handle.journal ? [`Journal: ${handle.journal.dir}`] : []),
    "Next: cairn_discover_interact / cairn_discover_navigate; cairn_discover_export when the journey is recorded.",
  ].join("\n");
}

function notFound(sessionId: string): ToolResult {
  return textError(`session not found: ${sessionId}`);
}

/** Journal root of a config (default: the cwd's) — artifactRoot or ~/.cairntrace/runs. */
async function defaultJournalRoot(config?: string): Promise<string> {
  const target = await resolveBrowseTarget({
    url: "about:blank",
    ...(config !== undefined ? { config } : {}),
  }).catch(() => undefined);
  return target
    ? journalRootFor(target)
    : resolvePath(join(homedir(), ".cairntrace", "runs"));
}

function locatorFromAccompanyRef(
  sessionId: string,
  ref: string | undefined,
): Locator {
  if (!ref) {
    throw new Error("accompany choose needs locator or ref");
  }
  const handle = statusAccompany(sessionId);
  if (!handle?.lastSnapshot) {
    throw new Error(`snapshot ref ${ref} not found in session ${sessionId}`);
  }
  try {
    return locatorFromSnapshotRef(handle.lastSnapshot, ref, handle.backend);
  } catch {
    throw new Error(`snapshot ref ${ref} not found in session ${sessionId}`);
  }
}
