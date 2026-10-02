import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  SpecFinishResultSchema,
  SpecLintResultSchema,
  SpecPromoteResultSchema,
} from "../core/authoring/authoring.v1";
import { authorFlowPrompt } from "../core/authoring/authorFlow";
import type { RunInvocationRegistry } from "../cli/invocation/registry";
import { RegistryFullError } from "../cli/invocation/registry";
import { finishSpec, finishToMarkdown } from "../cli/commands/spec/finish";
import {
  lintToMarkdown,
  runSpecLint,
  splitEnvs,
} from "../cli/commands/spec/lint";
import {
  PromoteError,
  promoteSpec,
  promoteToMarkdown,
} from "../cli/commands/spec/promote";
import { log } from "../cli/logger";

/**
 * Authoring tools (A7/A8): `cairn_spec_lint`, `cairn_spec_finish`,
 * `cairn_spec_promote`, and the `author-flow` prompt — the recipe from a
 * few sentences of request to a promoted spec.
 */

type ToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function textError(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

const envInput = z
  .union([z.string().min(1), z.array(z.string().min(1))])
  .optional();

export function registerAuthoringTools(
  server: McpServer,
  ctx: {
    registry: RunInvocationRegistry;
    /** Start config services / run their teardown (`cairn mcp --allow-services`). */
    allowServices: boolean;
  },
): void {
  const clientName = (): string | undefined => {
    const info = server.server.getClientVersion();
    return info ? `${info.name}/${info.version}` : undefined;
  };

  server.registerTool(
    "cairn_spec_lint",
    {
      title: "Lint specs with fix-its",
      description:
        "Friendly findings before a spec runs (same as `cairn spec lint --json`): an unquoted # " +
        "selector (YAML reads it as a comment), schema problems explained per step, files that do " +
        "not exist, a cold start satisfied only by echo preconditions, script verifier fixture keys " +
        "outside the verifier's contract, literal secrets, evals a typed step does better " +
        "(location.assign → open, fetch login → request, .click() → click, value setter → fill, " +
        "polling loops → wait / click.until), host-specific absolute paths, placeholders that " +
        "would reach a shell literally, missing step ids, and ${vars.X} that do not resolve in " +
        "each `env`. fix:true applies only safe edits in place (quote # selectors, add step ids; " +
        "comments kept). exitCode 4 when any finding is an error.",
      inputSchema: {
        paths: z
          .array(z.string().min(1))
          .min(1)
          .optional()
          .describe(
            "Spec/action files or directories (directories skip actions/ and _ drafts)",
          ),
        path: z
          .string()
          .min(1)
          .optional()
          .describe("One spec (same as paths: [path])"),
        env: envInput.describe(
          "Environment(s) to resolve vars and files in: a name, a comma list, or an array",
        ),
        config: z.string().optional().describe("Explicit config path"),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X}"),
        fix: z
          .boolean()
          .optional()
          .describe(
            "Apply safe fixes in place (quote # selectors, add step ids)",
          ),
      },
    },
    async (input) => {
      const specs = [
        ...(input.paths ?? []),
        ...(input.path !== undefined ? [input.path] : []),
      ];
      if (specs.length === 0)
        return textError("cairn_spec_lint needs paths or path");
      try {
        const { result, exitCode } = await runSpecLint(specs, {
          envs: splitEnvs(input.env),
          ...(input.config !== undefined ? { config: input.config } : {}),
          ...(input.var ? { var: input.var } : {}),
          ...(input.fix ? { fix: true } : {}),
        });
        return {
          content: [{ type: "text", text: lintToMarkdown(result) }],
          structuredContent: {
            ...SpecLintResultSchema.parse(result),
            exitCode,
          } as Record<string, unknown>,
          ...(exitCode !== 0 ? { isError: true } : {}),
        };
      } catch (e) {
        return textError(`lint failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_spec_finish",
    {
      title: "Finish a spec: lint, cold-start run, stamp when green",
      description:
        "The one call that says whether an authored spec is done (same as `cairn spec finish " +
        "--json`): lint (errors stop with status lint-failed), then a cold-start run through the " +
        "same engine as `cairn run` and `cairn_run` (config, browser.*, vars, scoped secrets, " +
        "services/webServer; services a `cairn services up` lock owns are reused automatically), " +
        "stamping the contract hash when it passes. Returns {status: green | red | lint-failed | " +
        "errored | refused, lint, run {status, runDir, report}, contractHash, context (the run's " +
        "agent_context.md outcome results and next steps), nextActions}. A green finish of a draft " +
        "on a real backend is what cairn_spec_promote checks (a mock finish does not count). With a " +
        "dev server you already run, pass noWebServer:true. Config services start only on a server " +
        "started as `cairn mcp --allow-services`; otherwise a finish whose config would start them " +
        "errors (exit 4) before anything starts: pass noServices:true when the stack is already up. " +
        "Cancelling the request cancels the run.",
      inputSchema: {
        path: z.string().min(1).describe("Spec path"),
        env: z
          .string()
          .min(1)
          .optional()
          .describe("Environment (as cairn run --env)"),
        config: z.string().optional().describe("Explicit config path"),
        var: z
          .array(z.string())
          .optional()
          .describe("Repeatable key=value overrides for ${vars.X}"),
        headed: z.boolean().optional().describe("Show the browser window"),
        mock: z
          .boolean()
          .optional()
          .describe(
            "In-memory mock backend (no real browser; it never touches the app, so cairn_spec_promote refuses a mock finish without force)",
          ),
        backend: z.enum(["agent-browser", "playwright", "mock"]).optional(),
        provider: z
          .string()
          .min(1)
          .optional()
          .describe("agent-browser provider (as cairn run --provider)"),
        device: z
          .string()
          .min(1)
          .optional()
          .describe("iOS device name (with provider ios)"),
        artifactRoot: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Run artifact root (finish receipts live under it; pass the same to cairn_spec_promote)",
          ),
        reuseServices: z
          .boolean()
          .optional()
          .describe(
            "Run against services `cairn services up` owns (default: when the config's lock is held for this env)",
          ),
        noServices: z
          .boolean()
          .optional()
          .describe(
            "Skip the config services lifecycle (needed for a config with services unless the server runs with --allow-services)",
          ),
        noWebServer: z
          .boolean()
          .optional()
          .describe(
            "Skip the config webServer lifecycle (use the dev server you already run)",
          ),
      },
    },
    async (input, extra) => {
      const client = clientName();
      try {
        const result = await finishSpec(
          input.path,
          {
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.config !== undefined ? { config: input.config } : {}),
            ...(input.var ? { var: input.var } : {}),
            ...(input.headed ? { headed: true } : {}),
            ...(input.mock ? { mock: true } : {}),
            ...(input.backend !== undefined ? { backend: input.backend } : {}),
            ...(input.provider !== undefined
              ? { provider: input.provider }
              : {}),
            ...(input.device !== undefined ? { device: input.device } : {}),
            ...(input.artifactRoot !== undefined
              ? { artifactRoot: input.artifactRoot }
              : {}),
            ...(input.reuseServices !== undefined
              ? { reuseServices: input.reuseServices }
              : {}),
            ...(input.noServices ? { noServices: true } : {}),
            ...(input.noWebServer ? { noWebServer: true } : {}),
          },
          async (request) => {
            const entry = ctx.registry.start(request, {
              origin: "mcp",
              ...(client ? { client } : {}),
              logger: log,
              allowServicesBoot: ctx.allowServices,
            });
            const onCancel = (): void => {
              ctx.registry.cancel(entry.id);
            };
            extra.signal.addEventListener("abort", onCancel, { once: true });
            try {
              await entry.settled;
            } finally {
              extra.signal.removeEventListener("abort", onCancel);
            }
            if (!entry.result) {
              throw new Error(entry.failure ?? `invocation ${entry.id} failed`);
            }
            return entry.result;
          },
        );
        return {
          content: [{ type: "text", text: finishToMarkdown(result) }],
          structuredContent: SpecFinishResultSchema.parse(result) as Record<
            string,
            unknown
          >,
          ...(result.status !== "green" ? { isError: true } : {}),
        };
      } catch (e) {
        if (e instanceof RegistryFullError) {
          return textError(`cairn_spec_finish refused: ${e.message}`);
        }
        return textError(`finish failed: ${(e as Error).message}`);
      }
    },
  );

  server.registerTool(
    "cairn_spec_promote",
    {
      title: "Promote a draft spec",
      description:
        "Move a draft out of the drafts dir (config authoring.draftsDir, default flows/_drafts) " +
        "once cairn_spec_finish ran this exact content green on a real backend (a mock finish " +
        "does not count), rebase its relative paths, stamp the contract hash (same as `cairn spec " +
        "promote --json`). Returns {from, to, intent, outcomes, contractHash, finish {backend}}. " +
        "Call it only after the human reviewed and approved the draft. force:true promotes " +
        "without such a finish (reported in warnings). Never replaces an existing spec, and " +
        "rolls back when the promoted file would point at files that do not exist.",
      inputSchema: {
        path: z.string().min(1).describe("Draft spec path"),
        to: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Destination file or folder (default: the drafts dir's parent)",
          ),
        force: z.boolean().optional(),
        expectContentHash: z
          .string()
          .optional()
          .describe(
            "sha256 hex of the draft text the human reviewed; any other content is refused, even with force",
          ),
        config: z.string().optional().describe("Explicit config path"),
        artifactRoot: z
          .string()
          .optional()
          .describe("Where finish receipts live"),
      },
    },
    async (input) => {
      try {
        const result = await promoteSpec(input.path, {
          ...(input.to !== undefined ? { to: input.to } : {}),
          ...(input.force ? { force: true } : {}),
          ...(input.expectContentHash !== undefined
            ? { expectContentHash: input.expectContentHash }
            : {}),
          ...(input.config !== undefined ? { config: input.config } : {}),
          ...(input.artifactRoot !== undefined
            ? { artifactRoot: input.artifactRoot }
            : {}),
        });
        return {
          content: [{ type: "text", text: promoteToMarkdown(result) }],
          structuredContent: SpecPromoteResultSchema.parse(result) as Record<
            string,
            unknown
          >,
        };
      } catch (e) {
        return {
          ...textError(`promote refused: ${(e as Error).message}`),
          structuredContent: {
            error: (e as Error).message,
            exitCode: e instanceof PromoteError ? e.exitCode : 2,
          },
        };
      }
    },
  );

  server.registerPrompt(
    "author-flow",
    {
      title: "Author a spec from a request",
      description:
        "The recipe from a few sentences of request to a promoted Cairntrace spec: catalog → " +
        "discover with setup → interact (snapshotMode diff) → export with conventions into the " +
        "drafts dir → spec_finish → report and ask the human to promote.",
      argsSchema: {
        request: z
          .string()
          .min(1)
          .describe("What the human asked for, in their words"),
        env: z
          .string()
          .optional()
          .describe(
            "Environment to explore and finish in (default: the config default)",
          ),
        targetDir: z
          .string()
          .optional()
          .describe(
            "Where the draft goes, relative to the config dir (default: the drafts dir)",
          ),
      },
    },
    ({ request, env, targetDir }) => ({
      description: "Cairntrace author-flow recipe",
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: authorFlowPrompt({
              request,
              ...(env ? { env } : {}),
              ...(targetDir ? { targetDir } : {}),
            }),
          },
        },
      ],
    }),
  );
}
