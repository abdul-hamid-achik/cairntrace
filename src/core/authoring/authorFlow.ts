/**
 * The author-flow recipe: how an agent goes from a few sentences ("log in as
 * a supplier, edit the profile website, save, check it persisted") to a
 * promoted spec. One source for the MCP prompt `author-flow`, `cairn docs
 * author-flow` and the agent-kit snippet, so they never disagree.
 */

export interface AuthorFlowArgs {
  /** What the human asked for, in their words. */
  request: string;
  /** Environment to explore and finish in (default: the config default). */
  env?: string;
  /** Where the draft goes (default: the drafts dir). */
  targetDir?: string;
}

export interface AuthorFlowStep {
  title: string;
  body: string;
}

/** The recipe steps; `<env>` / `<targetDir>` are filled by the prompt. */
export function authorFlowSteps(
  env = "<env>",
  targetDir = "<drafts dir>",
): AuthorFlowStep[] {
  const envArg = `env: "${env}"`;
  return [
    {
      title: "Catalog first: reuse before you record",
      body: [
        `cairn_catalog { query: "<key words of the request>", ${envArg} }  (CLI: cairn catalog --query "…" --env ${env} --json)`,
        "Note the actions it lists (login, edit-and-save helpers), the config vars of the environment and similar flows. Never re-record what an action already does; never hardcode a value a var already holds.",
      ].join("\n"),
    },
    {
      title: "Open a discovery session where the journey starts",
      body: [
        `cairn_discover_open { ${envArg}, setup: [{ use: "<login action from the catalog>" }], url: "<path to start from>", snapshotMode: "diff" }`,
        "Setup runs through the same engine as `cairn run` (config, vars, ${secrets.X} from the provider). The session is journaled under <artifactRoot>/_sessions/<id>/, so the human can follow it in Cairntrace Studio.",
      ].join("\n"),
    },
    {
      title: "Explore and record, one step per call",
      body: [
        'cairn_discover_interact { sessionId, action: "fill" | "click" | "select" | "press" | "wait" | "assert" | …, target: { by: "role" | "label" | "text" | "testid", … }, snapshotMode: "diff" }',
        "cairn_discover_navigate { sessionId, url } for URLs; cairn_discover_inventory lists stable locators. Check result.network.mutations: the save you expect must appear (for example PATCH /api/profile 204).",
        "Type credentials as ${secrets.NAME} or ${env.NAME}, never as values. Undo a wrong step with cairn_discover_remove_step { sessionId, index }.",
      ].join("\n"),
    },
    {
      title: "Export with the project's conventions into the drafts dir",
      body: [
        `cairn_discover_export { sessionId, into: "${targetDir}", intent: "<one sentence: what the journey proves>", outcomes: [ … ], requires: { env: ["${env}"] } }`,
        "Outcomes are the contract: assert what the human asked for (text, url, network, a value that persisted after a reload), not how you clicked.",
        "Read result.report: reusedActions (steps replaced by use:), liftedVars (literals now ${vars.X}), secretsPlaceholdered and warnings. A refused export names the secret literal to replace.",
      ].join("\n"),
    },
    {
      title: "Finish: lint, cold-start run, stamp when green",
      body: [
        `cairn_spec_finish { path: "<result.path>", ${envArg} }  (CLI: cairn spec finish <path> --env ${env} --json)`,
        "lint-failed: apply the fixes (cairn_spec_lint { paths: [<path>], fix: true } applies the safe ones) and finish again. red: read result.context, fix the steps (not the outcomes), finish again. Repeat until status is green.",
        'Finish on a real browser: a mock finish never touches the app and promote does not accept it. If the dev server already runs, pass noWebServer: true (errored with "already listening" means exactly that).',
      ].join("\n"),
    },
    {
      title: "Report and stop",
      body: [
        "Tell the human the draft path, the intent, each outcome, the run report (result.run.report) and what you reused.",
        "Ask them to review it. Only after they approve: cairn_spec_promote { path }  (CLI: cairn spec promote <path> --json). Never promote on your own, and never edit the intent or outcomes of an existing spec without showing the diff.",
      ].join("\n"),
    },
  ];
}

/** The text of the MCP prompt `author-flow`. */
export function authorFlowPrompt(args: AuthorFlowArgs): string {
  const env = args.env?.trim() || "<the config's default environment>";
  const targetDir =
    args.targetDir?.trim() ||
    "<the drafts dir: config authoring.draftsDir, default flows/_drafts>";
  const steps = authorFlowSteps(
    args.env?.trim() || "<env>",
    args.targetDir?.trim() || "flows/_drafts",
  );
  return [
    "Author a Cairntrace behavioral spec for this request:",
    "",
    ...args.request
      .trim()
      .split("\n")
      .map((line) => `> ${line}`),
    "",
    `Environment: ${env}. Draft target: ${targetDir}.`,
    "Follow this recipe exactly. Every tool is a Cairntrace MCP tool; the CLI equivalent is in parentheses.",
    "",
    ...steps.flatMap((step, i) => [
      `${i + 1}. ${step.title}`,
      indent(step.body),
      "",
    ]),
  ]
    .join("\n")
    .trimEnd();
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((line) => `   ${line}`)
    .join("\n");
}
