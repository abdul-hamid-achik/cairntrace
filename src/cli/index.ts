import { Command } from "commander";
import { cleanCommand } from "./commands/clean";
import { clipCommand } from "./commands/clip";
import { captureFromSessionCommand } from "./commands/checkpoint/capture";
import { deleteCheckpointCommand } from "./commands/checkpoint/delete";
import { listCheckpointsCommand } from "./commands/checkpoint/list";
import { showCheckpointCommand } from "./commands/checkpoint/show";
import { contextCommand } from "./commands/context";
import { diffCommand } from "./commands/diff";
import { doctorCommand } from "./commands/doctor";
import { docsCommand } from "./commands/docs";
import { explainCommand } from "./commands/explain";
import { exportPlaywrightCommand } from "./commands/export";
import { importPlaywrightCommand } from "./commands/import";
import { loginCommand } from "./commands/login";
import { mcpCommand } from "./commands/mcp";
import { runCommand } from "./commands/run";
import { snapshotCommand } from "./commands/snapshot";
import { discoverCommand } from "./commands/discover";
import { healCommand } from "./commands/spec/heal";
import { scaffoldCommand } from "./commands/spec/scaffold";
import { verifyCommand } from "./commands/spec/verify";
import {
  stashInfoCommand,
  stashListCommand,
  stashRestoreCommand,
  stashSaveCommand,
  stashSearchCommand,
} from "./commands/stash";
import { investigateCommand, auditCommand } from "./commands/investigate";
import { annotateCommand } from "./commands/annotate";
import { isTvaultAvailable, getTvaultKeys } from "./commands/secrets";
import { configValidateCommand } from "./commands/config/validate";
import { servicesStatusCommand } from "./commands/services/status";
import { CAIRN_VERSION } from "./version";

const program = new Command();

program
  .name("cairn")
  .description(
    "Cairntrace — behavioral browser-spec layer for agent-in-session use",
  )
  .version(CAIRN_VERSION);

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

addFormatFlags(
  program
    .command("run <spec...>")
    .description("Run one or more behavioral specs")
    .option("--env <name>", "environment override")
    .option("--cold-start", "force fresh browser profile (default: on in CI)")
    .option("--headed", "show the browser window", false)
    .option("--mock", "use the in-memory mock backend", false)
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option(
      "--parallel <n>",
      "run N specs concurrently (each in its own browser session)",
      "1",
    )
    .option("--artifact-root <path>", "override artifact root directory")
    .option("--junit <file>", "write a JUnit XML report")
    .option(
      "--stamp-if-green",
      "write contractHash only after all requested specs pass",
      false,
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
      "--no-web-server",
      "skip the config webServer lifecycle (manage the server yourself)",
    )
    .option(
      "--no-services",
      "skip the config services lifecycle (docker/seed/tmux)",
    )
    .option(
      "--services-dry-run",
      "preview the services lifecycle plan without executing (prints what would happen)",
      false,
    )
    .option(
      "--stash-on-failure",
      "auto-stash failed run directories to fcheap (non-fatal if fcheap is missing)",
      false,
    )
    .option(
      "--auto-annotate <mode>",
      "auto-annotate runs into codemap: on-run (pass+fail) | never (default: config annotate.autoAnnotate or never)",
    )
    .option(
      "--monitor",
      "sample the browser process tree (CPU/RSS) during the run via the `monitor` CLI; writes diagnostics/process.{md,json}. Zero-cost when absent.",
      false,
    )
    .option("--no-color", "disable ANSI colors in interactive output"),
).action((specs: string[], opts) => runCommand(specs, opts));

addFormatFlags(
  program
    .command("doctor")
    .description("Check environment for cairn dependencies"),
).action((opts) => doctorCommand(opts));

addFormatFlags(
  program
    .command("clean")
    .description(
      "Prune old run directories from the artifact root (keeps newest N per spec)",
    )
    .option("--keep <n>", "keep the newest N runs per spec")
    .option("--all", "remove ALL run directories", false)
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
    .description(
      "Return focused agent docs; topics: overview, authoring, steps, verifiers, downloads, scripts, artifacts, mcp, backends, discovery",
    ),
).action((topic: string | undefined, opts) => docsCommand(topic, opts));

addFormatFlags(
  program
    .command("snapshot <url>")
    .description("Inspect a page and print agent-facing locator inventory")
    .option("--roles", "include accessibility role locators", false)
    .option("--testids", "include data-testid locators", false)
    .option("--env <name>", "environment override for config baseUrl")
    .option("--headed", "show the browser window", false)
    .option("--mock", "use the in-memory mock backend", false)
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((url: string, opts) => snapshotCommand(url, opts));

addFormatFlags(
  program
    .command("discover <url>")
    .description(
      "Inspect a page and return full accessibility tree + locator inventory",
    )
    .option("--roles", "include accessibility role locators", false)
    .option("--testids", "include data-testid locators", false)
    .option("--env <name>", "environment override for config baseUrl")
    .option("--headed", "show the browser window", false)
    .option("--mock", "use the in-memory mock backend", false)
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    ),
).action((url: string, opts) => discoverCommand(url, opts));

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

program
  .command("mcp")
  .description("Start the Cairntrace MCP server on stdio")
  .action(() => mcpCommand());

const exportCmd = program
  .command("export")
  .description("Export a spec to another test framework");

exportCmd
  .command("playwright <spec>")
  .description(
    "Emit a @playwright/test .spec.ts from the given Cairntrace spec",
  )
  .option(
    "--out <file>",
    "where to write (defaults to <spec-dir>/<name>.spec.ts)",
  )
  .option("--stdout", "print to stdout instead of writing", false)
  .action((p: string, opts) => exportPlaywrightCommand(p, opts));

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
    .option("--stdout", "print YAML to stdout instead of writing", false),
).action((p: string, opts) => importPlaywrightCommand(p, opts));

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
    .option("--mock", "use the in-memory mock backend", false)
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option("--headed", "show the browser window", false),
).action((p: string, opts) => healCommand(p, opts));

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
    .option("--tag <tag>", "filter by tag")
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

/* ----- investigate (fcheap connect + vecgrep) ----- */

addFormatFlags(
  program
    .command("investigate <run-id>")
    .description(
      "Stash a run to fcheap and find code responsible for failures via vecgrep",
    )
    .option(
      "--codebase <dir>",
      "codebase directory to search with fcheap connect (vecgrep)",
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
      "--mode <mode>",
      "vecgrep search mode: semantic | keyword | hybrid (default: hybrid)",
    )
    .option("--limit <n>", "max code matches to return", "10")
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
      "codebase directory to search with fcheap connect (vecgrep)",
    )
    .option(
      "--connect",
      "run fcheap connect to find code matches after stashing",
      false,
    )
    .option("--mode <mode>", "vecgrep search mode: semantic | keyword | hybrid")
    .option("--limit <n>", "max code matches to return", "10")
    .option("--env <name>", "environment override")
    .option("--cold-start", "force fresh browser profile")
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

/* ----- services (status) ----- */

const servicesCmd = program
  .command("services")
  .description("Cairntrace services lifecycle management");

addFormatFlags(
  servicesCmd
    .command("status")
    .description(
      "Check the current state of the services environment (docker, seed, tmux)",
    )
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option("--project <name>", "project name override (default: from config)"),
).action((opts) => servicesStatusCommand(opts));

await program.parseAsync(process.argv);
