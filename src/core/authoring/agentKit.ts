import { dirname, resolve } from "node:path";
import { buildCatalog } from "../catalog/buildCatalog";
import { findConfigFile, loadConfig } from "../config/loader";
import { draftsDirFor, relativePosix } from "./config";

/**
 * `cairn init agent-kit`: a short AGENTS.md section that tells any coding
 * agent how specs are authored in THIS project (its config, environments,
 * drafts dir and actions), pointing at the full recipe.
 */

export const AGENT_KIT_START = "<!-- cairntrace:agent-kit:start -->";
export const AGENT_KIT_END = "<!-- cairntrace:agent-kit:end -->";

const MAX_ACTIONS = 6;

export async function buildAgentKitSnippet(opts: {
  cwd?: string;
  config?: string;
}): Promise<{ snippet: string; configPath?: string; root: string }> {
  const cwd = opts.cwd ?? process.cwd();
  const configPath = opts.config
    ? resolve(cwd, opts.config)
    : await findConfigFile(cwd);
  const loaded = configPath
    ? await loadConfig(resolve(cwd, "agent-kit"), configPath).catch(
        () => undefined,
      )
    : undefined;
  const root = loaded ? dirname(loaded.path) : cwd;
  const config = loaded?.config;
  const rel = (path: string): string => relativePosix(root, path);
  const envs = config ? Object.keys(config.environments) : [];
  // The environment a run picks without --env: defaultEnvironment, else local.
  const defaultEnv =
    config?.defaultEnvironment && envs.includes(config.defaultEnvironment)
      ? config.defaultEnvironment
      : envs.includes("local")
        ? "local"
        : undefined;
  const env = defaultEnv ?? envs[0] ?? "local";
  const drafts = rel(draftsDirFor(root, config));
  let actions: Array<{ name: string; file: string }> = [];
  try {
    const catalog = await buildCatalog({
      cwd: root,
      ...(loaded ? { config: loaded.path } : {}),
      kinds: ["actions"],
      maxRuns: 0,
    });
    actions = (catalog.actions ?? []).map((a) => ({
      name: a.name,
      file: a.file,
    }));
  } catch {
    actions = [];
  }
  const shownActions = actions.slice(0, MAX_ACTIONS);
  const login = actions.find((a) => /log_?in|sign_?in|auth/i.test(a.name));

  const lines = [
    AGENT_KIT_START,
    "## Browser flows (Cairntrace specs)",
    "",
    `Browser journeys in this project are Cairntrace specs (\`cairn\` CLI, \`cairn mcp\`). Config: \`${
      loaded ? rel(loaded.path) : "cairntrace.config.yml (none yet)"
    }\`${
      envs.length > 0
        ? `; environments: ${envs.map((e) => (e === defaultEnv ? `${e} (default)` : e)).join(", ")}`
        : ""
    }; drafts: \`${drafts}/\` (\`cairn run <dir>\` skips folders and files starting with \`_\`).`,
    ...(shownActions.length > 0
      ? [
          `Reusable actions: ${shownActions
            .map((a) => `\`${a.name}\` (${a.file})`)
            .join(", ")}${
            actions.length > shownActions.length
              ? `, … (${actions.length} in all)`
              : ""
          }.`,
        ]
      : []),
    "",
    "To automate or check a flow someone describes, author a spec — do not write ad-hoc scripts:",
    "",
    `1. \`cairn catalog --query "<words>" --env ${env} --json\` (MCP \`cairn_catalog\`): reuse the actions, vars and verifiers it lists.`,
    `2. \`cairn_discover_open { env: ${env}, setup: [{ use: ${login?.name ?? "<login action>"} }], url, snapshotMode: diff }\`, then \`cairn_discover_interact\` / \`cairn_discover_navigate\`, one step per call.`,
    `3. \`cairn_discover_export { sessionId, into: "${drafts}", intent, outcomes }\` (CLI \`cairn discover export --from-session <id> --into ${drafts} --intent … --outcomes <file>\`): reuses actions, lifts config vars, keeps secrets as placeholders; read its \`report\`.`,
    `4. \`cairn spec finish <draft> --env ${env} --json\` (MCP \`cairn_spec_finish\`) until \`status: green\` (lint, cold-start run, contract stamped; a real browser, not \`--mock\`; \`--no-web-server\` when the dev server already runs).`,
    "5. Show the human the intent, outcomes and run report. Promote only after they approve: `cairn spec promote <draft> --json`.",
    "",
    "Rules:",
    "- Outcomes are the contract: never change `intent`/`outcomes` of an existing spec without showing the diff.",
    "- Credentials are `${secrets.NAME}` / `${env.NAME}` placeholders, never literals; no host-specific absolute paths.",
    "- Prefer typed steps (open, click, fill, wait, request) over `eval`; `cairn spec lint <spec> --fix` catches the rest.",
    "- Every spec replays from a cold browser: `imports:` + `use:` a login action, `session.resume`, or `coldStart: guest`.",
    "- Full recipe: MCP prompt `author-flow`, or `cairn docs author-flow`.",
    AGENT_KIT_END,
  ];
  return {
    snippet: `${lines.join("\n")}\n`,
    ...(loaded ? { configPath: loaded.path } : {}),
    root,
  };
}

/**
 * Put the snippet into an AGENTS.md text: replace an existing agent-kit
 * block, else append one.
 */
export function upsertAgentKit(
  existing: string | undefined,
  snippet: string,
): { text: string; action: "created" | "appended" | "replaced" | "unchanged" } {
  if (existing === undefined || existing.trim() === "") {
    return { text: snippet, action: "created" };
  }
  const start = existing.indexOf(AGENT_KIT_START);
  const end = existing.indexOf(AGENT_KIT_END);
  if (start >= 0 && end > start) {
    const after = end + AGENT_KIT_END.length;
    const tail = existing.slice(after).replace(/^\n/, "");
    const text = `${existing.slice(0, start)}${snippet}${tail}`;
    return { text, action: text === existing ? "unchanged" : "replaced" };
  }
  const separator = existing.endsWith("\n\n")
    ? ""
    : existing.endsWith("\n")
      ? "\n"
      : "\n\n";
  return { text: `${existing}${separator}${snippet}`, action: "appended" };
}
