import { Command } from "commander";
import { captureFromSessionCommand } from "./commands/checkpoint/capture";
import { deleteCheckpointCommand } from "./commands/checkpoint/delete";
import { listCheckpointsCommand } from "./commands/checkpoint/list";
import { showCheckpointCommand } from "./commands/checkpoint/show";
import { contextCommand } from "./commands/context";
import { diffCommand } from "./commands/diff";
import { doctorCommand } from "./commands/doctor";
import { explainCommand } from "./commands/explain";
import { exportPlaywrightCommand } from "./commands/export";
import { loginCommand } from "./commands/login";
import { mcpCommand } from "./commands/mcp";
import { runCommand } from "./commands/run";
import { healCommand } from "./commands/spec/heal";
import { scaffoldCommand } from "./commands/spec/scaffold";
import { verifyCommand } from "./commands/spec/verify";

const program = new Command();

program
  .name("cairn")
  .description(
    "Cairntrace — behavioral browser-spec layer for agent-in-session use",
  )
  .version("0.0.1");

function addFormatFlags(c: Command): Command {
  return c
    .option("--format <format>", "output format: json | yaml | md", "md")
    .option("--json", "shorthand for --format json")
    .option("--yaml", "shorthand for --format yaml")
    .option("--md", "shorthand for --format md");
}

addFormatFlags(
  program
    .command("run <spec>")
    .description("Run a behavioral spec")
    .option("--env <name>", "environment override")
    .option("--cold-start", "force fresh browser profile (default: on in CI)")
    .option("--headed", "show the browser window", false)
    .option("--mock", "use the in-memory mock backend", false)
    .option("--backend <name>", "agent-browser (default) | playwright | mock")
    .option("--artifact-root <path>", "override artifact root directory")
    .option(
      "--config <path>",
      "explicit cairntrace.config.yml (overrides auto-discovery)",
    )
    .option("--no-color", "disable ANSI colors in interactive output"),
).action((spec: string, opts) => runCommand(spec, opts));

addFormatFlags(
  program
    .command("doctor")
    .description("Check environment for cairn dependencies"),
).action((opts) => doctorCommand(opts));

addFormatFlags(
  program
    .command("explain")
    .description("Return the full agent-facing surface"),
).action((opts) => explainCommand(opts));

program
  .command("context <run>")
  .description(
    "Print or locate the agent_context.md for a run ('latest' is allowed)",
  )
  .option("--path", "print the file path instead of contents", false)
  .action((run: string, opts) => contextCommand(run, opts));

addFormatFlags(
  program
    .command("diff <runA> <runB>")
    .description(
      "Structurally compare two runs (outcomes / steps / console / network); each arg is a run id, absolute path, or 'latest'/'previous'",
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
  .action((name: string, opts) => scaffoldCommand(name, opts));

addFormatFlags(
  spec
    .command("verify <spec>")
    .description("Lint and (optionally) stamp the contract hash on a spec")
    .option("--stamp", "write a fresh contractHash into the file", false),
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

await program.parseAsync(process.argv);
