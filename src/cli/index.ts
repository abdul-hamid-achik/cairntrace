import { Command } from "commander";
import { cleanCommand } from "./commands/clean";
import { clipCommand } from "./commands/clip";
import { captureFromSessionCommand } from "./commands/checkpoint/capture";
import { deleteCheckpointCommand } from "./commands/checkpoint/delete";
import { listCheckpointsCommand } from "./commands/checkpoint/list";
import { showCheckpointCommand } from "./commands/checkpoint/show";
import { contextCommand } from "./commands/context";
import { diffCommand } from "./commands/diff";
import { logsCommand } from "./commands/logs";
import { statsCommand } from "./commands/stats";
import { catalogCommand } from "./commands/catalog";
import { doctorCommand } from "./commands/doctor";
import { docsCommand, DOC_TOPICS } from "./commands/docs";
import { explainCommand } from "./commands/explain";
import { exportPlaywrightCommand } from "./commands/export";
import { exportBriefCommand } from "./commands/exportBrief";
import {
  importPlaywrightCommand,
  importPlaywrightTraceCommand,
} from "./commands/import";
import { loginCommand } from "./commands/login";
import { mcpCommand } from "./commands/mcp";
import { configureRunCommand, runCommand } from "./commands/run";
import { snapshotCommand } from "./commands/snapshot";
import {
  discoverCommand,
  discoverExportCommand,
  discoverSessionsCommand,
} from "./commands/discover";
import { finishCommand } from "./commands/spec/finish";
import { healCommand } from "./commands/spec/heal";
import { lintCommand } from "./commands/spec/lint";
import { promoteCommand } from "./commands/spec/promote";
import { agentKitCommand } from "./commands/init";
import { scaffoldCommand } from "./commands/spec/scaffold";
import { verifyCommand } from "./commands/spec/verify";
import {
  stashInfoCommand,
  stashListCommand,
  stashRestoreCommand,
  stashSaveCommand,
  stashSearchCommand,
} from "./commands/stash";
import { pinCommand, unpinCommand } from "./commands/pin";
import { publishCommand } from "./commands/publishCommand";
import { investigateCommand, auditCommand } from "./commands/investigate";
import { annotateCommand } from "./commands/annotate";
import { isTvaultAvailable, getTvaultKeys } from "./commands/secrets";
import { configValidateCommand } from "./commands/config/validate";
import { configVarsCommand } from "./commands/config/vars";
import { servicesStatusCommand } from "./commands/services/status";
import { servicesUpCommand } from "./commands/services/up";
import { servicesDownCommand } from "./commands/services/down";
import { servicesRestartCommand } from "./commands/services/restart";
import { servicesLogsCommand } from "./commands/services/logs";
import { waitCommand } from "./commands/wait";
import { fixturesCommand } from "./commands/fixtures";
import { suitesListCommand } from "./commands/suites";
import { verifierSchemaCommand } from "./commands/verifier";
import { CAIRN_VERSION } from "./version";
import { configureLoggerFromFlags } from "./logger";
import { applyUsageExitCodes } from "./usageExit";

const program = new Command();

program
  .name("cairn")
  .description(
    "Cairntrace — behavioral browser-spec layer for agent-in-session use",
  )
  .version(CAIRN_VERSION)
  .option(
    "--log-level <level>",
    "log verbosity: debug | info | warn | error | silent",
  )
  .option("--log-format <format>", "log line format: human | json")
  .option("--quiet", "quiet logs (warn level); suppresses info + live output")
  .option("--verbose", "verbose logs (debug level)")
  .option("--no-color", "disable ANSI colors in log/interactive output");

// Configure the singleton logger once, before any command action runs, from
// the global flags + env. Commands that load cairntrace.config.yml (run/clean)
// re-resolve with the config `logging` block so it can set a project default.
program.hook("preAction", () => {
  const opts = program.opts();
  configureLoggerFromFlags({
    logLevel: opts.logLevel,
    logFormat: opts.logFormat,
    quiet: opts.quiet,
    verbose: opts.verbose,
    color: opts.color,
  });
});

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function addFormatFlags(c: Command): Command {
  return c
    .option("--format <format>", "output format: json | yaml | md", "md")
    .option("--json", "shorthand for --format json")
    .option("--yaml", "shorthand for --format yaml")
    .option("--md", "shorthand for --format md");
}

configureRunCommand(program.command("run [spec...]")).action(
  (specs: string[], opts) => runCommand(specs, opts),
);

addFormatFlags(
  program
    .command("doctor")
    .description("Check environment for cairn dependencies")
    .option(
      "--ios",
      "also probe iOS readiness (Xcode / Appium / xcuitest / simulators)",
      false,
    )
    .option(
      "--orphans",
      "list the browser sessions cairn started whose cairn run is gone but whose processes survive (found through the owned-session ledger, never by pattern); exit 1 when any, 0 when none",
      false,
    )
    .option(
      "--kill",
      "with --orphans: end those processes (asks on a terminal; structured or non-interactive runs need --yes)",
      false,
    )
    .option("--yes", "with --orphans --kill: do not ask", false)
    .option(
      "--only <sessions-or-pids>",
      "with --orphans: only these sessions and/or pids (comma-separated, repeatable); with --kill, what is no longer an orphan by then is left alone",
      collectRepeatable,
      [],
    )
    .option(
      "--config <path>",
      "also check the config's requires.cairntrace and runtimes.node (default: the cairntrace.config.yml found from the cwd; exit 4 when a pin is not met)",
    ),
).action((opts) => doctorCommand(opts));

addFormatFlags(
  program
    .command("clean")
    .description(
      "Prune old run directories from the artifact root (keeps newest N per spec)",
    )
    .option("--keep <n>", "keep the newest N runs per spec")
    .option("--all", "remove ALL run directories", false)
    .option(
      "--include-pinned",
      "also prune pinned runs (cairn pin), which retention otherwise never removes",
      false,
    )
    .option("--artifact-root <path>", "artifact root to clean")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((opts) => cleanCommand(opts));

addFormatFlags(
  program
    .command("explain")
    .description("Return the full agent-facing surface"),
).action((opts) => explainCommand(opts));

addFormatFlags(
  program
    .command("docs [topic]")
    .description(`Return focused agent docs; topics: ${DOC_TOPICS.join(", ")}`),
).action((topic: string | undefined, opts) => docsCommand(topic, opts));

addFormatFlags(
  program
    .command("snapshot <url>")
    .description("Inspect a page and print agent-facing locator inventory")
    .option("--roles", "include accessibility role locators", false)
    .option("--testids", "include data-testid locators", false)
    .option(
      "--wait-until <state>",
      "wait for networkidle | load | domcontentloaded before inventory (SPA hydration)",
    )
    .option("--env <name>", "environment override for config baseUrl")
    .option("--headed", "show the browser window", false)
    .option("--mock", "use the in-memory mock backend", false)
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option(
      "--provider <name>",
      "agent-browser provider: ios (Mobile Safari via Appium) | browserbase | kernel | …",
    )
    .option(
      "--device <name>",
      'iOS device name, e.g. "iPhone 15 Pro" (with --provider ios)',
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--var <key=value>",
      "runtime var override; repeatable, wins over config env vars",
      collectRepeatable,
      [] as string[],
    ),
).action((url: string, opts) => snapshotCommand(url, opts));

const discover = addFormatFlags(
  program
    .command("discover")
    .argument(
      "[url]",
      "page to inspect (a relative path joins the environment baseUrl)",
    )
    .description(
      "Inspect a page and return full accessibility tree + locator inventory (subcommands: export, sessions)",
    )
    .option("--roles", "include accessibility role locators", false)
    .option("--testids", "include data-testid locators", false)
    .option(
      "--wait-until <state>",
      "wait for networkidle | load | domcontentloaded before snapshot (SPA hydration)",
    )
    .option("--env <name>", "environment override for config baseUrl")
    .option("--headed", "show the browser window", false)
    .option("--mock", "use the in-memory mock backend", false)
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option(
      "--provider <name>",
      "agent-browser provider: ios (Mobile Safari via Appium) | browserbase | kernel | …",
    )
    .option(
      "--device <name>",
      'iOS device name, e.g. "iPhone 15 Pro" (with --provider ios)',
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--var <key=value>",
      "runtime var override; repeatable, wins over config env vars",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--use <action>",
      "setup: run an imported reusable action first (repeatable; name or name:key=value,…)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--import <file>",
      "action file for --use (repeatable; default: actions/ dirs under the config dir)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--from-spec <path>",
      "setup: replay this spec's steps through --until-step",
    )
    .option(
      "--until-step <id>",
      "last --from-spec step to replay (step id or 1-based position)",
    )
    .option(
      "--resume <checkpoint>",
      "restore a scoped checkpoint before the setup",
    )
    .option(
      "--snapshot-mode <mode>",
      "returned snapshot: none | diff | compact | full (default full; the journal keeps the full text)",
    )
    .option(
      "--max-bytes <n>",
      "cap the returned snapshot JSON at n bytes (default 16384)",
    ),
).action((url: string | undefined, opts) => discoverCommand(url, opts));

// Subcommands read --config / --format from `discover` (optsWithGlobals):
// commander lets the parent consume the options both would define.
discover
  .command("export")
  .description(
    "Write a discovery session as a spec from its journal alone (works after the browser expired or closed)",
  )
  .option(
    "--from-session <dir|id>",
    "session journal directory, or a session id under <artifactRoot>/_sessions/",
  )
  .option("--path <file>", "spec to write")
  .option(
    "--intent <text>",
    "one-line intent of the spec (default: the session's last export)",
  )
  .option(
    "--outcomes <file>",
    "YAML/JSON file with the outcomes array, the contract (default: the session's last export)",
  )
  .option(
    "--resume <checkpoint>",
    "write session: { resume } (default: the session's own)",
  )
  .option(
    "--overwrite",
    "replace a stamped spec (or, with conventions, any existing file)",
    false,
  )
  .option("--artifact-root <path>", "override artifact root directory")
  .option(
    "--into <dir|file>",
    "convention export: folder (or .yml) relative to the config dir; default the drafts dir",
  )
  .option("--name <name>", "spec name (snake_case) and file name inside --into")
  .option(
    "--conventions",
    "apply project conventions (implied by --into or a missing --path)",
    false,
  )
  .option("--no-reuse-actions", "do not replace steps by existing actions")
  .option("--no-lift-vars", "do not write config var values as ${vars.X}")
  .option(
    "--allow-secret-literals",
    "keep a password-field literal no known secret explains (warning instead of refusal; convention exports only, a plain --path export warns)",
    false,
  )
  .option(
    "--requires-env <envs>",
    "requires.env for the spec (comma-separated environment names)",
  )
  .option("--mutates", "requires.mutates: true (the flow changes data)", false)
  .option(
    "--tag <tag>",
    "metadata.tags entry (repeatable)",
    collectRepeatable,
    [] as string[],
  )
  .action((_opts, cmd: Command) =>
    discoverExportCommand(cmd.optsWithGlobals()),
  );

discover
  .command("sessions")
  .description("List session journals (discovery and accompany), newest first")
  .option("--artifact-root <path>", "override artifact root directory")
  .option("--limit <n>", "newest n sessions (default 20)")
  .action((_opts, cmd: Command) =>
    discoverSessionsCommand(cmd.optsWithGlobals()),
  );

program
  .command("context <run>")
  .description(
    "Print or locate the agent_context.md for a run ('latest' is allowed)",
  )
  .option("--path", "print the file path instead of contents", false)
  .option("--artifact-root <path>", "override artifact root directory")
  .option(
    "--config <path>",
    "explicit cairntrace.config.yml (overrides auto-discovery)",
  )
  .action((run: string, opts) => contextCommand(run, opts));

addFormatFlags(
  program
    .command("diff <runA> <runB>")
    .description(
      "Structurally compare two runs (outcomes / steps / console / network); each arg is a run id, absolute path, or 'latest'/'previous'",
    )
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((a: string, b: string, opts) => diffCommand(a, b, opts));

addFormatFlags(
  program
    .command("stats")
    .description(
      "Aggregate labeled runs into A/B cohorts (pass rate, duration p50/p95, optional domain metric from outcomes/*.raw.json)",
    )
    .option(
      "--group-by <key>",
      "label key to cohort by (required; e.g. path for path=legacy|next)",
    )
    .option(
      "--label <key=value>",
      "only include runs that have this label (repeatable = AND)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--invocation <id>",
      "only include runs of this cairn run invocation (the id of _invocations/<id>, run.json invocation.id)",
    )
    .option(
      "--metric <field>",
      "harvest this numeric field from outcomes/*.raw.json (default: processingDurationMS)",
    )
    .option(
      "--baseline <group>",
      "baseline cohort key for ratio deltas (default: first sorted group)",
    )
    .option("--limit <n>", "max run dirs to scan, newest first (default 500)")
    .option(
      "--include-runs",
      "include per-run rows in the structured payload",
      false,
    )
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((opts) => statsCommand(opts));

addFormatFlags(
  program
    .command("catalog")
    .description(
      "List what the project already has (actions, vars, verifiers, envs, flows, checkpoints) so agents reuse it",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--env <name>",
      "environment for vars, last runs and checkpoint origin checks",
    )
    .option(
      "--query <text>",
      "keyword ranking across names, descriptions, intents and comments",
    )
    .option(
      "--kind <kinds>",
      "actions | vars | verifiers | envs | flows | checkpoints | fixtures | suites (repeatable or comma-separated)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--limit <n>",
      "rows per kind (default 10 with --query, otherwise all)",
    )
    .option(
      "--artifact-root <path>",
      "override the artifact root scanned for last runs",
    ),
).action((opts) => catalogCommand(opts));

program
  .command("logs [ref]")
  .description(
    "List runs and replay their files of record (events.ndjson, service pane logs). ref: run name | latest | previous",
  )
  .option("--config <path>", "path to cairntrace.config.yml")
  .option("--artifact-root <dir>", "override the runs root")
  .option("--events", "stream the run's events.ndjson to stdout")
  .option("--services", "list captured tmux pane logs")
  .option(
    "--service <window>",
    "stream one tmux window's captured pane log to stdout",
  )
  .option(
    "--follow",
    "keep streaming until the run/invocation settles (exit 2 if its process died)",
  )
  .option(
    "--log <name>",
    "live log instead of events: run|precondition|outcome|<file>; with --invocation: narration|services|hook|<file>",
  )
  .option(
    "--invocation <id>",
    "invocation journal: <id> | latest | previous | label:<key>=<value> (newest with that label; waited for with --follow)",
  )
  .option(
    "--relay",
    "with --invocation: print the delegated-runner events stream (journal events + invocation.run.* + invocation.summary) for CAIRN_DELEGATE_EVENTS",
  )
  .option(
    "--wait-timeout <duration>",
    "with --invocation label:<key>=<value> --follow: wait at most this long for the journal to appear (ms or 30s/10m/1h; default 10m; 0 = no end); exit 2 when it never does",
  )
  .option("--format <fmt>", "invocation summary format: json|yaml|md")
  .option("--json", "shorthand for --format json")
  .action((ref: string | undefined, opts) => logsCommand(ref, opts));

program
  .command("mcp")
  .description("Start the Cairntrace MCP server on stdio")
  .option(
    "--allow-hooks",
    "accept cairn_run before/after shell hooks (arbitrary shell; also CAIRN_MCP_ALLOW_HOOKS=1)",
    false,
  )
  .option(
    "--allow-services",
    "let MCP tools start config services (docker/seed/tmux) and run their teardown: cairn_run / cairn_spec_finish / cairn_audit without noServices, cairn_services_up / _down (also CAIRN_MCP_ALLOW_SERVICES=1)",
    false,
  )
  .action((opts: { allowHooks?: boolean; allowServices?: boolean }) =>
    mcpCommand(opts),
  );

const exportCmd = program
  .command("export")
  .description("Export a spec to another test framework");

addFormatFlags(
  exportCmd
    .command("playwright [spec]")
    .description(
      "Emit a @playwright/test .spec.ts|.spec.js from a Cairntrace spec (or directory)",
    )
    .option(
      "--out <file>",
      "where to write a single file (defaults to <spec-dir>/<name>.spec.ts|js)",
    )
    .option(
      "--out-dir <dir>",
      "batch-write exported specs into this directory (required for directory input)",
    )
    .option("--lang <js|ts>", "output language (default: ts)")
    .option("--stdout", "print source to stdout (single-spec only)", false)
    .option(
      "--config <path>",
      "cairntrace.config.yml supplying ${vars.*}/baseUrl (auto-discovered from the spec dir when omitted)",
    )
    .option("--env <name>", "config environment for var resolution")
    .option(
      "--var <key=value>",
      "override a ${vars.X} value (repeatable)",
      (v: string, prev: string[] = []) => [...prev, v],
    )
    .option(
      "--project",
      "generate a structured project (actions/, verifiers/, config, global-setup) instead of standalone spec files",
      false,
    )
    .option(
      "--into <dir>",
      "write actions/lib/tests/verifiers into an existing Playwright tree (no package.json or playwright.config)",
    )
    .option(
      "--host-config <playwright.config.ts>",
      "with --into: adapt the generated code to this existing Playwright tree. The config is read statically (never executed) with its tsconfig and package.json: module system (__dirname vs import.meta.url), test timeouts (no test.setTimeout the host already covers), testIdAttribute, bypassCSP (refuses page evals when the host does not set it, unless --allow-eval-without-bypass), testDir / testMatch (where and how tests are named), tsconfig path aliases, import order, and the host's local prettier",
    )
    .option(
      "--map <export.map.yml>",
      "with --into / --project: the export map that binds cairn actions to the host's constructs. A `fixture` mapping destructures a host Playwright fixture in the test signature instead of inlining the action's steps; a `method` mapping calls a host page object (`new SomePage(page).openThing(arg)`); an `apiLogin` writes a request-based login as a storageState; actions the map leaves alone become generated page objects over the host's base page (lib/pages). `strict: true` makes an unmapped action an error. See `cairn docs export`",
    )
    .option(
      "--target <name>",
      "an export.targets.<name> profile of the cairntrace config (into, hostConfig, input, preconditions, verifiers, gateEnv, lang, env, mapFile, maxEvalRatio, allowEvalWithoutBypass, strictLocators, verifyProject); a flag given here overrides the profile",
    )
    .option(
      "--max-eval-ratio <0..1>",
      "refuse a spec whose share of page eval steps (inside actions and blocks included) is above this; other specs are still exported, exit 1 when any was refused",
    )
    .option(
      "--allow-eval-without-bypass",
      "with --host-config: export page evals even though the host config does not set use.bypassCSP: true",
    )
    .option(
      "--strict-locators",
      "emit no .first() on a locator without nth: an ambiguous locator fails the exported test (Playwright strict mode), exactly as cairn run --backend playwright does. Default: .first() on every such locator (the agent-browser first-match semantics, so an exported test can pass where the Playwright-backend run fails). With --verify the manifest's mode is regenerated; export.targets.<name>.strictLocators sets it per profile",
    )
    .option(
      "--no-strict-locators",
      "keep .first() (the default) even when the target profile sets strictLocators: true",
    )
    .option(
      "--preconditions <mode>",
      "host commands (preconditions, run: steps, teardown:, fixtures, gates): inline = bounded helper in the generated runtime (beforeAll + test body); global = once in the project's global-setup (--project/--into; fixtures and gates call the cairn CLI); skip = list only; manifest = list in .cairn-export.json for the host to run. Default: standalone files skip, --project/--into run preconditions in each file's beforeAll",
    )
    .option(
      "--verifiers <mode>",
      "node / datasource verifiers: keep (default: node file verifiers run, datasource ones are test.fixme) | gate (run only when the required env is present; otherwise the test ends skipped, never passed) | drop (omit with a diagnostic)",
    )
    .option(
      "--gate-env <names>",
      "env var names every gated node verifier requires with --verifiers gate (repeatable or comma-separated)",
      (v: string, prev: string[] = []) => [...prev, v],
    )
    .option(
      "--check <exportDir>",
      "verify an export against its .cairn-export.json (regenerates in memory; writes nothing; exit 0 fresh, 1 stale, 2 error)",
    )
    .option(
      "--verify [dirOrMode]",
      "prove an export faithful: static gates (no leaked sentinels, tsc with the target tsconfig, the host's eslint, playwright test --list == exported specs, manifest freshness), each passed | failed | skipped(reason). A value is an export directory (--verify ./export) or a mode (static | differential) for the export this command writes. On a host config with several projects every Playwright run uses one project (--verify-project). Writes .cairn-export-verify.json/.md and the manifest's verify field; exit 0 all pass, 1 a gate / differential / mutant failed, 2 usage or environment error, 3 inconclusive (nothing proven: neither tsc nor playwright --list ran, the differential matched no spec, no mutant was killed or survived; never a pass)",
    )
    .option(
      "--differential",
      "with --verify: also run cairn run --backend playwright and the exported test with the same CAIRN_RUN_TOKEN against the running app (sequentially) and compare per-step / per-outcome verdicts, network evidence and duration",
      false,
    )
    .option(
      "--mutate [scope]",
      "with --verify: invert one assertion per spec (scope all: every outcome) in a temp copy of each exported test; the test must fail at that outcome, a mutant that passes is an 'assertion not effective' finding",
    )
    .option(
      "--verify-strict",
      "with --verify: a skipped gate or an inconclusive result counts as a failure (exit 1)",
      false,
    )
    .option(
      "--verify-only <spec>",
      "with --differential / --mutate: only the specs whose path or test file contains this (repeatable); the static gates still cover the whole export",
      (v: string, prev: string[] = []) => [...prev, v],
    )
    .option(
      "--duration-ratio <n>",
      "with --differential: warn when the slower side exceeds the faster by more than this ratio (default 3)",
    )
    .option(
      "--verify-project <name>",
      "with --verify on a host config with several projects: the Playwright project the list gate, the differential and the mutants run under (passed as --project; Playwright still runs its dependencies, a setup project included). Default: the one recorded in .cairn-export.json, else the first project that discovers the exported tests and runs Chromium. Recorded in the manifest when given at export time (profile field verifyProject)",
    ),
).action(
  (p: string | undefined, opts: Record<string, unknown> & { map?: string }) => {
    // `--map <file>` is the profile's `mapFile`.
    const { map, ...rest } = opts;
    return exportPlaywrightCommand(p, {
      ...rest,
      ...(map !== undefined ? { mapFile: map } : {}),
    });
  },
);

addFormatFlags(
  exportCmd
    .command("brief <spec>")
    .description(
      "Emit an agent-neutral journey brief (markdown/json/yaml) from a spec",
    )
    .option("--out <file>", "where to write a single file")
    .option(
      "--out-dir <dir>",
      "batch-write briefs (required for directory input)",
    )
    .option("--stdout", "print the brief only (single-spec)", false)
    .option("--from-run <ref>", "enrich from a run dir or 'latest'")
    .option(
      "--config <path>",
      "cairntrace.config.yml supplying ${vars.*}/baseUrl",
    )
    .option("--env <name>", "config environment")
    .option(
      "--var <key=value>",
      "override a ${vars.X} value (repeatable)",
      (v: string, prev: string[] = []) => [...prev, v],
    ),
).action((p: string, opts) => exportBriefCommand(p, opts));

const importCmd = program
  .command("import")
  .description("Import tests from another framework");

addFormatFlags(
  importCmd
    .command("playwright <file>")
    .description("Convert a @playwright/test .spec.ts file to Cairntrace YAML")
    .option(
      "--out <file>",
      "where to write (defaults to <source-dir>/<test-title>.yml)",
    )
    .option(
      "--test <title|n>",
      "import this test (title substring or 1-based index) instead of the first",
    )
    .option("--stdout", "print YAML to stdout instead of writing", false)
    .option("--force", "overwrite an existing --out file", false)
    .option(
      "--allow-empty",
      "write the placeholder draft even when nothing mapped (default: refuse, exit 1)",
      false,
    ),
).action((p: string, opts) => importPlaywrightCommand(p, opts));

addFormatFlags(
  importCmd
    .command("playwright-trace <trace.zip>")
    .description(
      "Convert a Playwright trace archive into a DRAFT Cairntrace spec (steps from the recorded actions, draft outcomes from expects, final URL and API calls)",
    )
    .option("--out <file>", "where to write (defaults to ./<name>.yml)")
    .option("--name <name>", "spec name (default: the trace's test title)")
    .option("--intent <text>", "spec intent (default: the trace's test title)")
    .option("--stdout", "print YAML to stdout instead of writing", false)
    .option("--force", "overwrite an existing --out file", false)
    .option(
      "--allow-empty",
      "write the placeholder draft even when nothing mapped (default: refuse, exit 1)",
      false,
    ),
).action((p: string, opts) => importPlaywrightTraceCommand(p, opts));

program
  .command("login <name>")
  .description(
    "Open a headed browser at --url, let the user log in, then capture state into a checkpoint",
  )
  .requiredOption("--url <url>", "page to load in the headed browser")
  .option(
    "--wait-for <signal>",
    "wait for text:<...> or url:<...> instead of an ENTER keypress",
  )
  .option("--timeout <ms>", "max wait time when --wait-for is set", "300000")
  .option(
    "--provider <name>",
    "agent-browser provider: ios (Mobile Safari via Appium) | browserbase | kernel | …",
  )
  .option(
    "--device <name>",
    'iOS device name, e.g. "iPhone 15 Pro" (with --provider ios)',
  )
  .option(
    "--env <name>",
    "environment the checkpoint is for: its baseUrl scopes the checkpoint (resume refuses another origin)",
  )
  .option("--config <path>", "explicit cairntrace.config.yml for --env")
  .option(
    "--ttl <duration>",
    "checkpoint lifetime, e.g. 30m, 12h, 7d; resume refuses it afterwards",
  )
  .action((name: string, opts) => loginCommand(name, opts));

const spec = program.command("spec").description("Spec authoring helpers");

spec
  .command("scaffold <name>")
  .description("Write a starter behavioral spec YAML")
  .requiredOption("--intent <text>", "one-line intent for the spec")
  .option("--out <dir>", "output directory (defaults to ./flows)")
  .option(
    "--from-codemap [query]",
    "bind coversSymbol to an untested entrypoint via codemap orphans/semantic",
  )
  .option(
    "--from-risk",
    "scaffold N stubs bound to the highest-risk untested entrypoints (read-order + risk)",
  )
  .option(
    "--top <n>",
    "number of risky entrypoints to scaffold with --from-risk",
    "3",
  )
  .action((name: string, opts) => scaffoldCommand(name, opts));

addFormatFlags(
  spec
    .command("verify <spec>")
    .description("Lint and (optionally) stamp the contract hash on a spec")
    .option("--stamp", "write a fresh contractHash into the file", false)
    .option("--env <name>", "environment override")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--var <key=value>",
      "runtime var override; repeatable, wins over config env vars",
      collectRepeatable,
      [] as string[],
    ),
).action((p: string, opts) => verifyCommand(p, opts));

addFormatFlags(
  spec
    .command("heal <spec>")
    .description(
      "Run a spec and propose selector-drift fixes from the snapshot",
    )
    .option("--apply", "write the patched spec back to disk", false)
    .option(
      "--verify",
      "apply to a temp, cold-start rerun, write only if it passes (SPEC §7.2)",
      false,
    )
    .option("--mock", "use the in-memory mock backend", false)
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option(
      "--provider <name>",
      "agent-browser provider: ios (Mobile Safari via Appium) | browserbase | kernel | …",
    )
    .option(
      "--device <name>",
      'iOS device name, e.g. "iPhone 15 Pro" (with --provider ios)',
    )
    .option("--headed", "show the browser window", false)
    .option(
      "--env <name>",
      "environment override (resolved like cairn run --env)",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--var <key=value>",
      "runtime var override; repeatable, wins over config env vars",
      collectRepeatable,
      [] as string[],
    ),
).action((p: string, opts) => healCommand(p, opts));

addFormatFlags(
  spec
    .command("lint <spec...>")
    .description(
      "Friendly fix-it findings before a spec runs (quoting, files, cold start, secrets, evals, ids, vars per env)",
    )
    .option(
      "--env <names>",
      "resolve vars/files in these environments (comma-separated or repeatable)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--var <key=value>",
      "runtime var override; repeatable, wins over config env vars",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--fix",
      "apply safe fixes in place (quote # selectors, add step ids)",
      false,
    ),
).action((specs: string[], opts) =>
  lintCommand(specs, { ...opts, env: opts.env.join(",") }),
);

addFormatFlags(
  spec
    .command("finish <spec>")
    .description(
      "Lint, run cold through the cairn run engine, stamp the contract when green, summarize the run",
    )
    .option("--env <name>", "environment (as cairn run --env)")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--var <key=value>",
      "runtime var override; repeatable, wins over config env vars",
      collectRepeatable,
      [] as string[],
    )
    .option("--headed", "show the browser window", false)
    .option(
      "--mock",
      "use the in-memory mock backend (never touches the app; promote refuses it without --force)",
      false,
    )
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option(
      "--provider <name>",
      "agent-browser provider: ios | browserbase | kernel | … (wins over config browser.provider)",
    )
    .option(
      "--device <name>",
      "iOS device name (with --provider ios; wins over config browser.device)",
    )
    .option(
      "--artifact-root <path>",
      "run artifact root (finish receipts live under it; pass the same to promote)",
    )
    .option(
      "--reuse-services",
      "run against the services cairn services up owns (default: when such a lock exists)",
    )
    .option("--no-services", "skip the config services lifecycle")
    .option(
      "--no-web-server",
      "skip the config webServer lifecycle (use the dev server you already run)",
    ),
).action((p: string, opts) => finishCommand(p, opts));

addFormatFlags(
  spec
    .command("promote <draft>")
    .description(
      "Move a draft out of the drafts dir after a green cairn spec finish, rebase its paths, stamp the contract",
    )
    .option("--to <path>", "destination spec file or folder")
    .option(
      "--force",
      "promote without a green finish of this exact content",
      false,
    )
    .option(
      "--expect-content-hash <sha256>",
      "refuse unless the draft text still has this sha256 (the content a reviewer saw)",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option("--artifact-root <path>", "where finish receipts live"),
).action((p: string, opts) => promoteCommand(p, opts));

const init = program.command("init").description("Set up a project for agents");

addFormatFlags(
  init
    .command("agent-kit")
    .description(
      "Print (or --write into AGENTS.md) a short project section on authoring Cairntrace specs",
    )
    .option(
      "--write",
      "append to AGENTS.md next to the config (replaces an earlier agent-kit block)",
      false,
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((opts) => agentKitCommand(opts));

const checkpoint = program
  .command("checkpoint")
  .description("Manage browser-state checkpoints used by spec session.resume");

checkpoint
  .command("capture-from-session <name>")
  .description(
    "Save the current state of an existing agent-browser session as a named checkpoint",
  )
  .requiredOption(
    "--session <ab-session>",
    "agent-browser --session value to read state from",
  )
  .option(
    "--provider <name>",
    "agent-browser provider the target session uses (e.g. ios)",
  )
  .option("--device <name>", "iOS device name the target session uses")
  .option(
    "--env <name>",
    "environment the checkpoint is for: its baseUrl scopes the checkpoint (resume refuses another origin)",
  )
  .option("--config <path>", "explicit cairntrace.config.yml for --env")
  .option(
    "--ttl <duration>",
    "checkpoint lifetime, e.g. 30m, 12h, 7d; resume refuses it afterwards",
  )
  .action((name: string, opts) => captureFromSessionCommand(name, opts));

addFormatFlags(
  checkpoint.command("list").description("List all saved checkpoints"),
).action((opts) => listCheckpointsCommand(opts));

addFormatFlags(
  checkpoint.command("show <name>").description("Inspect a saved checkpoint"),
).action((name: string, opts) => showCheckpointCommand(name, opts));

checkpoint
  .command("delete <name>")
  .description("Remove a saved checkpoint")
  .action((name: string) => deleteCheckpointCommand(name));

/* ----- clip (vidtrace video clips) ----- */

addFormatFlags(
  program
    .command("clip <run-ref>")
    .description("Cut named clips from a run video using vidtrace")
    .requiredOption(
      "--label <label=start-end>",
      "clip label with start/end timestamps (repeatable)",
      collectRepeatable,
      [] as string[],
    )
    .option("--out <dir>", "clip output directory (default: run/videos/clips)")
    .option("--name <prefix>", "clip filename prefix")
    .option("--reencode", "re-encode clips instead of stream-copy", false)
    .option(
      "--stash",
      "stash the run directory to fcheap after cutting clips",
      false,
    )
    .option(
      "--tag <tag>",
      "tag for the stash; repeatable",
      collectRepeatable,
      [] as string[],
    )
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((runRef: string, opts) => clipCommand(runRef, opts));

/* ----- stash (fcheap integration) ----- */

const stash = program
  .command("stash")
  .description("Save, list, and search run artifacts via fcheap");

addFormatFlags(
  stash
    .command("save <run-id>")
    .description(
      "Stash a run directory to the fcheap vault (run-id: run id, 'latest', or 'previous')",
    )
    .option(
      "--tag <tag>",
      "tag for this stash; repeatable",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--labels-as-tags",
      "also tag the stash with every run.json label as key=value (from cairn run --label)",
    )
    .option(
      "--ttl <duration>",
      "file.cheap time-to-live, e.g. 30d (default: never expires)",
    )
    .option(
      "--include <category>",
      "evidence category to stash: text | screenshots | traces | videos | downloads; repeatable (default: config stash.include, else text + screenshots)",
      collectRepeatable,
      [] as string[],
    )
    .option("--tool <name>", "tool name (default: cairntrace)")
    .option("--source <path>", "source artifact path")
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((runId: string, opts) => stashSaveCommand(runId, opts));

addFormatFlags(
  stash
    .command("list")
    .description("List stashes in the fcheap vault")
    .option(
      "--tag <tag>",
      "filter by tag; repeatable (a stash must have every tag)",
      collectRepeatable,
      [] as string[],
    )
    .option("--tool <name>", "filter by tool name"),
).action((opts) => stashListCommand(opts));

addFormatFlags(
  stash
    .command("info <stash-id>")
    .description("Get detailed info about a stash"),
).action((stashId: string, opts) => stashInfoCommand(stashId, opts));

addFormatFlags(
  stash
    .command("restore <stash-id>")
    .description("Restore a stash to a directory")
    .option("--to <dir>", "target directory (default: a fresh temp dir)"),
).action((stashId: string, opts) => stashRestoreCommand(stashId, opts));

addFormatFlags(
  stash
    .command("search <query>")
    .description("Search across all stashes")
    .option("--mode <mode>", "search mode: keyword | semantic | hybrid")
    .option("--limit <n>", "max results", "20"),
).action((query: string, opts) => stashSearchCommand(query, opts));

/* ----- pin / unpin / publish (evidence kept past retention) ----- */

addFormatFlags(
  program
    .command("pin <run-ref>")
    .description(
      "Keep a run: retention never prunes a pinned run (run-ref: run id, 'latest', or 'previous')",
    )
    .option("--reason <text>", "why the run is kept (stored on run.json)")
    .option(
      "--stash",
      "also stash it to fcheap with the keep tag and no TTL",
      false,
    )
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((runRef: string, opts) => pinCommand(runRef, opts));

addFormatFlags(
  program
    .command("unpin <run-ref>")
    .description("Let retention prune a pinned run again")
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((runRef: string, opts) => unpinCommand(runRef, opts));

addFormatFlags(
  program
    .command("publish <run-ref>")
    .description(
      "Publish a run to the private file.cheap artifact service with a RunIndexV1 sidecar (run-ref: run id, 'latest', or 'previous')",
    )
    .option(
      "--retention-days <n>",
      "remote retention, 1-31 days (default: config retention.publish.retentionDays, else 7)",
    )
    .option(
      "--include <category>",
      "evidence category to publish: text | screenshots | traces | videos | downloads; repeatable (default: config retention.publish.include, else text + screenshots)",
      collectRepeatable,
      [] as string[],
    )
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((runRef: string, opts) => publishCommand(runRef, opts));

/* ----- investigate (fcheap connect + vecgrep) ----- */

addFormatFlags(
  program
    .command("investigate <run-id>")
    .description(
      "Stash a run to fcheap and find code responsible for failures via vecgrep",
    )
    .option(
      "--codebase <dir>",
      "codebase directory to search with fcheap connect (relative to cwd)",
    )
    .option(
      "--connect",
      "run fcheap connect to find code matches after stashing",
      false,
    )
    .option(
      "--query <query>",
      "override the auto-extracted search query for vecgrep",
    )
    .option(
      "--clips",
      "stash videos/clips instead of the full run when that directory exists",
      false,
    )
    .option(
      "--mode <mode>",
      "vecgrep search mode: semantic | keyword | hybrid (default: config or hybrid)",
    )
    .option("--limit <n>", "max code matches to return (default: config or 10)")
    .option("--index", "build or refresh the vecgrep index before connecting")
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((runId: string, opts) => investigateCommand(runId, opts));

/* ----- audit (run + video + vidtrace + investigate) ----- */

addFormatFlags(
  program
    .command("audit <spec>")
    .description(
      "Run a spec with video, extract vidtrace evidence, and find code matches",
    )
    .option(
      "--codebase <dir>",
      "codebase directory to search with fcheap connect (relative to cwd)",
    )
    .option(
      "--connect",
      "run fcheap connect to find code matches after stashing",
      false,
    )
    .option("--mode <mode>", "vecgrep search mode: semantic | keyword | hybrid")
    .option("--limit <n>", "max code matches to return (default: config or 10)")
    .option("--index", "build or refresh the vecgrep index before connecting")
    .option(
      "--speed <multiplier>",
      "recorded video playback speed from 0.25 to 4",
    )
    .option(
      "--slow-mo <ms>",
      "delay between recorded browser actions from 0 to 5000ms",
    )
    .option("--env <name>", "environment override")
    .option("--no-cold-start", "reuse existing browser state for this audit")
    .option("--no-services", "skip the config services lifecycle")
    .option(
      "--reuse-services",
      "run against the services `cairn services up` owns for this config + env (no start, no teardown); without it the audit refuses (exit 4) while that lock exists",
    )
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((specPath: string, opts) => auditCommand(specPath, opts));

/* ----- annotate (codemap integration) ----- */

addFormatFlags(
  program
    .command("annotate <symbol>")
    .description(
      "Pin a note and/or data to a code symbol via codemap (codemap annotate wrapper)",
    )
    .option("--note <text>", "free-form note text to attach to the symbol")
    .option(
      "--data <json>",
      "opaque data payload (e.g. JSON from a cairntrace run)",
    )
    .option("--source <label>", "annotation source label (default: cairntrace)")
    .option(
      "--from <symbol>",
      "annotate a call path from→to instead of a single symbol",
    )
    .option("--to <symbol>", "call path end symbol (use with --from)"),
).action((symbol: string, opts) => annotateCommand(symbol, opts));

/* ----- secrets (TinyVault integration) ----- */

addFormatFlags(
  program
    .command("secrets")
    .description("Check TinyVault secrets provider status and available keys")
    // Commander 12 silently ignores excess positionals by default — without
    // this, `cairn secrets list-projects` would print the status report and
    // exit 0 instead of erroring on the nonexistent subcommand.
    .allowExcessArguments(false)
    .option("--project <name>", "TinyVault project name (direct mode)")
    .option(
      "--group <name>",
      "TinyVault environment group (inheritance mode; requires --env)",
    )
    .option(
      "--env <name>",
      "Environment name within the group (requires --group)",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action(async (opts) => {
  const { emit, resolveFormat } = await import("./format");
  const format = resolveFormat(opts, "md");

  const tvaultOk = await isTvaultAvailable();
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

  const hasProject = !!opts.project;
  const hasGroup = !!opts.group;
  const hasEnv = !!opts.env;

  if (tvaultOk && hasProject && !hasGroup && !hasEnv) {
    const keys = await getTvaultKeys({ project: opts.project });
    result.target = opts.project;
    result.keys = keys.keys;
    if (keys.error) result.error = keys.error;
  } else if (tvaultOk && hasGroup && hasEnv && !hasProject) {
    const keys = await getTvaultKeys({ group: opts.group, env: opts.env });
    result.target = `${opts.group}/${opts.env}`;
    result.keys = keys.keys;
    if (keys.error) result.error = keys.error;
  } else if (tvaultOk && (hasProject || hasGroup || hasEnv)) {
    result.error =
      "specify either --project <name> or both --group <name> --env <name>";
  } else if (tvaultOk) {
    result.error =
      "pass --project <name> or --group <name> --env <name> to list keys";
  }

  const md = [
    `# Secrets status`,
    "",
    `- provider: ${result.provider}`,
    `- tvault: ${result.tvaultInstalled ? "installed" : "not on $PATH"}`,
    ...(result.target ? [`- target: ${result.target}`] : []),
    ...(result.keys.length > 0
      ? [`- keys: ${result.keys.join(", ")}`]
      : ["- keys: (none or not checked)"]),
    ...(result.error ? [`- error: ${result.error}`] : []),
  ].join("\n");

  process.stdout.write(emit(format, result, () => md));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
});

/* ----- config (validation) ----- */

const configCmd = program
  .command("config")
  .description("Cairntrace config management");

addFormatFlags(
  configCmd
    .command("validate")
    .description(
      "Validate a cairntrace.config.yml file (structure + cross-field rules)",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((opts) => configValidateCommand(opts));

addFormatFlags(
  configCmd
    .command("vars")
    .description(
      "List config vars: kind, effective value per environment (secret-looking values masked), where defined, overrides and what uses them",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option("--env <name>", "only this environment")
    .option("--unused", "only vars nothing uses")
    .option(
      "--used-by <spec>",
      "only vars a spec (path or name) reaches through its actions, fixtures, script verifiers and login",
    ),
).action((opts) => configVarsCommand(opts));

/* ----- services (status / up / down) ----- */

const servicesCmd = program
  .command("services")
  .description("Cairntrace services lifecycle management");

addFormatFlags(
  servicesCmd
    .command("status")
    .description(
      "Check the current state of the services environment (docker, seed, tmux) and its `services up` lock",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--env <name>",
      "environment (default: config defaultEnvironment, else local)",
    )
    .option("--project <name>", "project name override (default: from config)"),
).action((opts) => servicesStatusCommand(opts));

addFormatFlags(
  servicesCmd
    .command("up")
    .description(
      "Start the config services (docker → seed → tmux) like `cairn run` would, leave them running and write the config's owner lock; runs of that env then need --reuse-services",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--env <name>",
      "environment (default: config defaultEnvironment, else local)",
    ),
).action((opts) => servicesUpCommand(opts));

addFormatFlags(
  servicesCmd
    .command("down")
    .description(
      "Tear the config services down (the configured teardown commands in order, then the tmux session) and remove the `services up` lock",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--env <name>",
      "environment (default: config defaultEnvironment, else local)",
    ),
).action((opts) => servicesDownCommand(opts));

addFormatFlags(
  servicesCmd
    .command("restart <window...>")
    .description(
      "Restart service windows of the configured tmux session: Ctrl-C, wait for the process to exit, clear the history, resend the command and wait for readyOn of the NEW output (refuses windows the config does not own; exit 4)",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--env <name>",
      "environment (default: config defaultEnvironment, else local)",
    )
    .option(
      "--stop-timeout <duration>",
      "wait this long for the old process to exit after Ctrl-C (default 30s)",
    )
    .option(
      "--ready-timeout <duration>",
      "wait this long for the new process to be ready (default: tmux readyTimeoutMs, else 90s)",
    ),
).action((windows: string[], opts) => servicesRestartCommand(windows, opts));

addFormatFlags(
  servicesCmd
    .command("logs <window>")
    .description(
      "Show the captured text of a service window (redacted, wrapped lines joined); --since-restart keeps the current restart generation, --wait <regex> waits for a line, --follow streams",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option(
      "--env <name>",
      "environment (default: config defaultEnvironment, else local)",
    )
    .option(
      "--since-restart",
      "only the output after the last `services restart` of this window",
    )
    .option("--lines <n>", "show the last N lines (default 200)")
    .option(
      "--wait <regex>",
      "wait until a line matches (exit 0), or --timeout passes (exit 1)",
    )
    .option("--timeout <duration>", "budget of --wait (default 30s)")
    .option(
      "--follow",
      "keep printing new lines until interrupted (text output only)",
    ),
).action((window: string, opts) => servicesLogsCommand(window, opts));

const verifierCmd = program
  .command("verifier")
  .description("Inspect script verifiers (the verifier SDK fixtures contract)");

addFormatFlags(
  verifierCmd
    .command("schema <file>")
    .description(
      "Print a script verifier's fixtures contract: read statically from defineVerifier({ fixtures: z.object(…) }) (never executed), else the header comment / code reads",
    )
    .option(
      "--load",
      "import the module in a Node child to read a contract the static reader reports as dynamic (RUNS its top-level code: trusted files only)",
    )
    .option(
      "--timeout-ms <ms>",
      "kill the --load child after this many ms (default 10000)",
    ),
).action((file: string, opts) => verifierSchemaCommand(file, opts));

/* ----- wait (typed readiness gates) ----- */

addFormatFlags(
  program
    .command("wait <target...>")
    .description(
      "Wait for readiness gates in order: config gates: names, http(s):// URLs (2xx/3xx unless --status) or tcp://host:port; exit 0 ready, 1 not ready",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (its gates: registry; default: discovered from the cwd)",
    )
    .option(
      "--env <name>",
      "environment whose scoped secrets gates may reference (default: config defaultEnvironment, else local)",
    )
    .option(
      "--status <codes>",
      "accepted statuses for URL targets: codes, classes, ranges (e.g. 2xx,401); default 2xx,3xx",
    )
    .option(
      "--any-response",
      "URL targets accept any HTTP answer (the old readiness rule)",
    )
    .option(
      "--timeout <duration>",
      "override every target's budget (ms or 30s/5m; 0 = no deadline; default: the gate's timeout, else 60s)",
    )
    .option(
      "--every <duration>",
      "override the pause between attempts (default: the gate's every, else 1s)",
    )
    .option(
      "--stable <n>",
      "override the consecutive passing attempts required (default: the gate's stable, else 1)",
    ),
).action((targets: string[], opts) => waitCommand(targets, opts));

/* ----- suites (config suites: registry) ----- */

const suites = program
  .command("suites")
  .description(
    "Inspect the config suites: registry that `cairn run --suite <name>` runs",
  );

addFormatFlags(
  suites
    .command("list")
    .description(
      "List the suites with the specs each resolves to per environment (and why one does not)",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (default: discovered from the cwd)",
    )
    .option(
      "--env <name>",
      "only this environment (default: every environment of the config)",
    ),
).action((opts) => suitesListCommand(opts));

/* ----- fixtures (config fixtures: registry) ----- */

const fixtures = program
  .command("fixtures")
  .description(
    "Inspect and drive the config fixtures: registry (exec / mongo / http test data): list, status, ensure, reset, teardown, sweep",
  );

function fixtureScopeFlags(c: Command): Command {
  return c
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (default: discovered from the cwd)",
    )
    .option(
      "--env <name>",
      "environment (datasources, vars, secrets, policy; default: config defaultEnvironment, else local)",
    );
}

addFormatFlags(
  fixtureScopeFlags(
    fixtures
      .command("list")
      .description(
        "List the registry: kind, scope, verbs, needs, outputs, owner, ttl",
      ),
  ),
).action((opts) => fixturesCommand("list", [], opts));

addFormatFlags(
  fixtureScopeFlags(
    fixtures
      .command("status [name...]")
      .description(
        "Ledger state per fixture in the environment: live, expired, failed, torn-down or never",
      ),
  ).option(
    "--verify",
    "run each recorded fixture's verify verb against its recorded outputs (exit 1 when one fails)",
  ),
).action((names: string[], opts) => fixturesCommand("status", names, opts));

for (const verb of ["ensure", "reset"] as const) {
  addFormatFlags(
    fixtureScopeFlags(
      fixtures
        .command(`${verb} <name>`)
        .description(
          verb === "ensure"
            ? "Ensure a fixture (its needs first) and record it in the ledger; nothing is torn down"
            : "Ensure a fixture's needs, then run its reset verb",
        ),
    )
      .option(
        "--with <key=value>",
        "fixture parameter (repeatable; JSON values are parsed)",
        collectRepeatable,
        [] as string[],
      )
      .option(
        "--allow-writes",
        "write on an environment whose policy trait is shared (otherwise the verb is dry-run there)",
      ),
  ).action((name: string, opts) => fixturesCommand(verb, [name], opts));
}

addFormatFlags(
  fixtureScopeFlags(
    fixtures
      .command("teardown <name>")
      .description(
        "Tear a fixture down with the outputs and parameters its last ensure recorded",
      ),
  )
    .option(
      "--with <key=value>",
      "override a recorded parameter (repeatable; JSON values are parsed)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--allow-writes",
      "write on an environment whose policy trait is shared (otherwise the verb is dry-run there)",
    ),
).action((name: string, opts) => fixturesCommand("teardown", [name], opts));

addFormatFlags(
  fixtureScopeFlags(
    fixtures
      .command("sweep")
      .description(
        "Find fixtures the ledger still shows live (a crash, a kill) and tear them down with --apply",
      ),
  )
    .option(
      "--older-than <duration>",
      "only leftovers ensured at least this long ago (ms or 30m/2h/1d; default 1h); expired ttls always qualify",
    )
    .option("--apply", "tear the candidates down (default: report only)")
    .option(
      "--include-seed",
      "seed-scoped fixtures too (default: only those past their ttl)",
    )
    .option(
      "--allow-writes",
      "write on an environment whose policy trait is shared (otherwise teardowns are dry-run there)",
    ),
).action((opts) => fixturesCommand("sweep", [], opts));

// A commander usage error is exit 2 (errored), never 1 (failed outcome).
applyUsageExitCodes(program);

await program.parseAsync(process.argv);
