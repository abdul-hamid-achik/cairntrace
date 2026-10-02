import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  CommandDoc,
  CommandFlag,
  ExplainResult,
  VerifierDoc,
} from "../../core/schema/explain.v1";
import { DOC_TOPICS } from "./docs";
import { emit, resolveFormat } from "../format";
import { CAIRN_VERSION } from "../version";

export interface ExplainOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/**
 * Placeholder vocabulary, shared by the `run` command notes (JSON) and the
 * markdown "Placeholders" section so both say the same thing.
 */
export const PLACEHOLDER_NOTES =
  "Placeholders in specs and imported actions: ${baseUrl} (active environment baseUrl); " +
  "${env.X} / ${env.X:-default}; ${vars.X} (CLI --var > spec vars: > environments.<env>.vars > action vars: defaults; a missing var is a parse error); " +
  "${secrets.X}; ${worker.index}; ${run.token}; " +
  "${file.dir} (alias ${project.root}) = directory of the FILE being parsed (inside an imported action it is the action's directory, not the spec's); relative step paths (upload.path, eval.file, transform.file/input, eval args.filePath/fixtureFiles) resolve against it too, with a deprecated spec-relative fallback for actions; " +
  "${config.dir} = directory of the resolved cairntrace.config.yml (an explicit --config, else the one found by walking up from the spec; the cwd when there is none) — the stable anchor for shared fixtures. " +
  "${fixtures.<name>.<key>} = an output of a config fixture the spec lists under fixtures: (spliced at run time into steps, teardown and verifiers; a reference to a fixture the spec does not list errors the run before anything starts). " +
  "cairntrace.config.yml text itself substitutes ${env.X} and ${config.dir}, and supports YAML anchors + merge keys (<<: *anchor).";

/* Browser flags shared by every command that launches a backend. */
const HEADED_FLAG: CommandFlag = {
  name: "--headed",
  type: "boolean",
  default: false,
  description: "Show the browser window",
};
const MOCK_FLAG: CommandFlag = {
  name: "--mock",
  type: "boolean",
  default: false,
  description: "Use the in-memory mock backend",
};
const PROVIDER_FLAG: CommandFlag = {
  name: "--provider",
  type: "string",
  description:
    "agent-browser provider: ios (Mobile Safari via Appium) | browserbase | kernel | … (wins over config browser.provider)",
};
const DEVICE_FLAG: CommandFlag = {
  name: "--device",
  type: "string",
  description:
    'iOS device name, e.g. "iPhone 15 Pro" (with --provider ios; wins over config browser.device)',
};
const WAIT_UNTIL_FLAG: CommandFlag = {
  name: "--wait-until",
  type: "enum",
  values: ["networkidle", "load", "domcontentloaded"],
  description:
    "Wait for this load state before capturing (SPA hydration); otherwise the tree may be captured pre-hydration",
};
const INDEX_FLAG: CommandFlag = {
  name: "--index",
  type: "boolean",
  default: false,
  description: "Build or refresh the vecgrep index before connecting",
};

export async function explainCommand(opts: ExplainOptions): Promise<void> {
  const format = resolveFormat(opts, "md");
  const doc = buildExplain();
  process.stdout.write(emit(format, doc, explainToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

/** This installation's launcher (`bin/cairn` next to `src/`), absolute. */
const CAIRN_BINARY = fileURLToPath(
  new URL("../../../bin/cairn", import.meta.url),
);

/**
 * Build the canonical ExplainResult. Exported so the MCP server's
 * `cairn_explain` tool returns the exact same structuredContent as
 * `cairn explain --json` — agents bootstrapping via MCP get the same surface
 * as agents shelling out, no schema drift.
 */
export function buildExplain(): ExplainResult {
  return {
    $schema: "urn:cairntrace.dev:explain:v1",
    version: "1",
    cairntrace: { version: CAIRN_VERSION, binary: CAIRN_BINARY },
    commands: [
      {
        name: "run",
        summary: "Run behavioral specs; emit machine-readable result",
        synopsis:
          "cairn run <spec-path-or-dir...> [--env <name>] [--cold-start] [--headed] [--mock] [--backend agent-browser|playwright|mock] [--parallel N] [--junit <file>] [--stamp-if-green] [--tag <tag>] [--label key=value] [--before <shell>] [--after <shell>] [--repeat N] [--matrix key=a,b] [--since-codemap <ref>] [--select-only] [--stash-on-failure] [--no-web-server] [--no-services] [--format json|yaml|md]",
        flags: [
          {
            name: "--env",
            type: "string",
            description:
              "Environment override; when a config exists, an environment it does not define is a config error (exit 4, before any secret/service/hook/spec starts) instead of a run without baseUrl/vars",
          },
          {
            name: "--cold-start",
            type: "boolean",
            default: false,
            description: "Force fresh browser profile",
          },
          HEADED_FLAG,
          MOCK_FLAG,
          {
            name: "--backend",
            type: "enum",
            values: ["agent-browser", "playwright", "mock"],
            default: "agent-browser",
            description: "Browser backend",
          },
          PROVIDER_FLAG,
          DEVICE_FLAG,
          {
            name: "--progress",
            type: "enum",
            values: ["auto", "tty", "plain"],
            default: "auto",
            description:
              "Narration renderer on stderr (md format only): tty redraws, plain prints sequential milestones, auto = tty on a terminal and plain when piped. Falls back to CAIRN_PROGRESS when the flag is absent.",
          },
          {
            name: "--parallel",
            type: "number",
            default: 1,
            description:
              "Run N specs concurrently, each in its own browser session",
          },
          {
            name: "--junit",
            type: "string",
            description:
              "Write a JUnit XML report for CI. Directory inputs expand recursively, skipping actions/ and drafts (folders and files starting with _).",
          },
          {
            name: "--stamp-if-green",
            type: "boolean",
            default: false,
            description:
              "Write fresh contractHash values only after every requested spec passes",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override the artifact root directory",
          },
          {
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value); repeatable, wins over config env vars",
          },
          {
            name: "--no-web-server",
            type: "boolean",
            default: false,
            description:
              "Skip the config `webServer` block (build/boot/ready/teardown) when you manage the server yourself. Otherwise cairn starts it once for the whole invocation, reusing an already-running one unless --cold-start/CI forces a fresh boot.",
          },
          {
            name: "--no-services",
            type: "boolean",
            default: false,
            description:
              "Skip the config `services` block (docker/seed/tmux lifecycle) when you manage the environment yourself.",
          },
          {
            name: "--services-dry-run",
            type: "boolean",
            default: false,
            description:
              "Preview the services lifecycle (docker/seed/tmux) without executing any commands. Prints the plan and exits before web-server, hooks, browser, preconditions, or specs.",
          },
          {
            name: "--reuse-services",
            type: "boolean",
            default: false,
            description:
              "Run against the services `cairn services up` owns for this config + env: one quick readiness check (docker readinessCheck / compose ps with the command's -f/-p options, tmux session + windows, readyOn URLs), no start, no teardown (events services.docker.reuse / seed.skip / tmux.reuse), cold browser unless coldStart is set. A stale lock, a lock held for another env of the config, or this flag without a lock is exit 4. Without the flag a run refuses (exit 4) before any hook, service, webServer or browser starts while that lock exists (one lock per config file; every env of the config is refused). MCP: reuseServices.",
          },
          {
            name: "--auto-annotate",
            type: "enum",
            values: ["on-run", "never"],
            description:
              "Auto-annotate each run (pass+fail) into codemap with run context (specName, contractHash, runId, status, outcomes, failedVerifier). Best-effort: skipped if codemap isn't installed. Overrides config annotate.autoAnnotate.",
          },
          {
            name: "--stash-on-failure",
            type: "boolean",
            default: false,
            description:
              "Auto-stash failed run directories to fcheap (non-fatal if fcheap is missing).",
          },
          {
            name: "--stash",
            type: "boolean",
            default: false,
            description:
              "Stash every run to fcheap regardless of status; config stash.include, tags and ttl apply. Refused runs are never stashed.",
          },
          {
            name: "--tag",
            type: "string",
            description:
              "Run only specs whose `metadata.tags` includes this tag. Repeatable (AND). Case-insensitive. Pair with --select-only to preview matches.",
          },
          {
            name: "--label",
            type: "string",
            description:
              "Stamp free-form cohort labels onto each run.json as key=value (repeatable). Used by `cairn stats --group-by` for A/B cohorts (e.g. path=legacy, suite=checkout-ab).",
          },
          {
            name: "--before",
            type: "string",
            description:
              "Shell command run after services/secrets and before the first spec of each run (repeatable; with --repeat/--matrix it runs once per iteration). Use for domain setup like flipping a feature path. Failures abort.",
          },
          {
            name: "--after",
            type: "string",
            description:
              "Shell command run after EACH spec finishes (pass or fail), while services are still up (repeatable; sequential, in the order given). Env: CAIRN_RUN_DIR (absolute run dir; diagnostics/ is pre-created), CAIRN_RUN_ID, CAIRN_RUN_STATUS (passed|failed|errored), CAIRN_SPEC_PATH. Numeric top-level fields of $CAIRN_RUN_DIR/diagnostics/report.json become `cairn stats --metric` values. Skipped for specs that errored before a run dir existed. Failures and timeouts are logged, non-fatal.",
          },
          {
            name: "--hook-timeout-ms",
            type: "number",
            default: 600000,
            description:
              "Maximum duration of each --before/--after hook in ms (default 600000, max 7200000); a timeout kills the hook's whole process tree.",
          },
          {
            name: "--repeat",
            type: "number",
            description:
              "Run the spec set N times sequentially (distinct run dirs), stamping label repeat=<i>; --before hooks run per iteration and CAIRN_REPEAT is exported to hooks and ${env.…}.",
          },
          {
            name: "--matrix",
            type: "string",
            description:
              "Run the cartesian product of key=a,b[;key2=x,y]; each combination is stamped as key=value labels and exported as CAIRN_MATRIX_<KEY> env vars to hooks and ${env.…}. Capped at 5000 runs.",
          },
          {
            name: "--stop-on-fail",
            type: "boolean",
            default: false,
            description:
              "With --repeat/--matrix: stop at the first run that does not pass.",
          },
          {
            name: "--strict-requires",
            type: "boolean",
            default: false,
            description:
              "Fail a batch with exit 7 when the environment policy (spec requires.env / requires.mutates vs environments.<name>.policy) refuses any spec; without it refused specs are reported (status refused, summary.refused) and skipped, and the batch exits 7 only when every spec was refused.",
          },
          {
            name: "--allow-fixture-writes",
            type: "boolean",
            default: false,
            description:
              "Let fixture ensure/reset/teardown write on an environment whose policy trait is shared; without it they are dry-run there (fixture.* events with status dry-run; ensure still runs the read-only verify) unless the spec's fixture reference says write: true. MCP: allowFixtureWrites.",
          },
          {
            name: "--since-codemap",
            type: "string",
            description:
              "Run only specs whose `coversSymbol` intersects `codemap review --since <ref>` blast radius; degrades to run-all when codemap is absent.",
          },
          {
            name: "--select-only",
            type: "boolean",
            default: false,
            description:
              "Resolve which specs WOULD run and exit 0 without launching a browser (emits SelectionResult v1: selected/skipped with reasons). Pair with --tag and/or --since-codemap <ref>; without filters, lists all expanded specs as selected.",
          },
          {
            name: "--monitor",
            type: "boolean",
            default: false,
            description:
              "Sample the browser process tree (CPU/RSS) during the run via the `monitor` CLI; writes diagnostics/process.{md,json} and enables the `process` verifier. Implicitly on under MONITOR=1. Zero-cost when absent.",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "all outcomes passed",
          "1": "one or more outcomes failed",
          "2": "errored (browser crash, spec parse failure, webServer boot/setup failure)",
          "3": "cold-start gate not satisfied",
          "4": "unknown --env for the resolved config (errored result documents still printed under --format json|yaml), or the `cairn services up` lock of the config: held without --reuse-services, held for another env of the config, stale or unreadable, or --reuse-services without a lock (no hook, service, webServer or browser started)",
          "6": "contract hash mismatch",
          "7": "refused by the environment policy: every spec of the run was refused (one spec or many, whatever --parallel), or any spec under --strict-requires",
        },
        outputSchema: "urn:cairntrace.dev:run:v1",
        notes: `Environment: --env, else the spec's environment:, else config defaultEnvironment, else local. When a config exists, an --env (MCP env) that config.environments does not define is a config error (exit 4) before any spec runs, not a silent run without baseUrl/vars. A spec's environment: or defaultEnvironment that the config does not define is a default, not a request: that spec runs without the environment's baseUrl/vars, and cairn run prints the warning once per invocation on stderr. MCP cairn_run runs the same engine with the same options (camelCase keys: noServices, stampIfGreen, sinceCodemap, …), boots and tears down the same services/webServer, and returns the --format json document (one aggregated BatchRunResult for --repeat/--matrix, where the CLI prints one per iteration); wait:false runs it in the background (cairn_run_status / cairn_run_cancel / cairn_logs). Environment policy: a spec's requires.env (names, or { <env>: { optIn: VAR } } needing VAR=1/true) and requires.mutates are checked against environments.<name>.policy (trait owned|shared|protected, mutations allow|deny) before secrets, services, hooks, preconditions or a browser start; a refused spec has status refused, a refusal block, no run directory (synthetic: true — its runId/runDir are placeholders, also on a spec that errored before its run started), a run.refused journal event (summary.refused), and is never stashed or retained; --select-only lists it under skipped; exit 7 when nothing ran because every spec was refused. A session.resume checkpoint that is missing, expired or captured for another origin fails the run after its preconditions (which may create or refresh the state file) and before the browser starts (failure.phase session); scope metadata that no longer matches the state file (rewritten by another tool) is ignored (health unscoped); a failed loadState fails the session.resume step. Cancel (MCP cairn_run_cancel, request cancel) kills the running command's process tree (hook, services boot command, precondition, node transform/script verifier), skips the rest and writes status errored with failure.phase cancelled. ${PLACEHOLDER_NOTES}`,
      },
      {
        name: "snapshot",
        summary: "Inspect a page and return agent-facing locator inventory",
        synopsis:
          "cairn snapshot <url> [--roles] [--testids] [--wait-until networkidle|load|domcontentloaded] [--env <name>] [--config <path>] [--var key=value] [--backend agent-browser|playwright|mock] [--mock] [--headed] [--format json|yaml|md]",
        flags: [
          {
            name: "--roles",
            type: "boolean",
            default: false,
            description:
              "Include accessibility role locators. If neither --roles nor --testids is set, both are included.",
          },
          {
            name: "--testids",
            type: "boolean",
            default: false,
            description:
              "Include test-id locators, scanned on the config's browser.testIdAttribute (default data-testid). If neither --roles nor --testids is set, both are included.",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Environment override for config baseUrl; an environment the config does not define is an error (exit 4)",
          },
          {
            name: "--backend",
            type: "enum",
            values: ["agent-browser", "playwright", "mock"],
            default: "agent-browser",
            description: "Browser backend",
          },
          WAIT_UNTIL_FLAG,
          HEADED_FLAG,
          MOCK_FLAG,
          PROVIDER_FLAG,
          DEVICE_FLAG,
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (baseUrl, browser settings incl. testIdAttribute); default: discovered upward from the cwd",
          },
          {
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value) for ${vars.X} in the URL; repeatable, wins over config env vars",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "navigation or backend error (or a relative URL with no baseUrl)",
          "4": "unknown --env for the resolved config",
        },
      },
      {
        name: "discover",
        summary:
          "Inspect a page and return full accessibility tree + locator inventory",
        synopsis:
          "cairn discover [url] [--use <action>[:k=v,…]]… [--import <file>]… [--from-spec <path> --until-step <id>] [--resume <checkpoint>] [--snapshot-mode none|diff|compact|full] [--max-bytes n] [--roles] [--testids] [--wait-until networkidle|load|domcontentloaded] [--env <name>] [--config <path>] [--var key=value] [--backend agent-browser|playwright|mock] [--mock] [--headed] [--format json|yaml|md]",
        flags: [
          {
            name: "--roles",
            type: "boolean",
            default: false,
            description:
              "Include accessibility role locators. If neither --roles nor --testids is set, both are included.",
          },
          {
            name: "--testids",
            type: "boolean",
            default: false,
            description:
              "Include test-id locators, scanned on the config's browser.testIdAttribute (default data-testid). If neither --roles nor --testids is set, both are included.",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Environment override for config baseUrl; an environment the config does not define is an error (exit 4)",
          },
          {
            name: "--backend",
            type: "enum",
            values: ["agent-browser", "playwright", "mock"],
            default: "agent-browser",
            description: "Browser backend",
          },
          WAIT_UNTIL_FLAG,
          HEADED_FLAG,
          MOCK_FLAG,
          PROVIDER_FLAG,
          DEVICE_FLAG,
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (baseUrl, browser settings incl. testIdAttribute); default: discovered upward from the cwd",
          },
          {
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value) for ${vars.X} in the URL; repeatable, wins over config env vars",
          },
          {
            name: "--use",
            type: "string",
            description:
              "Setup: run an imported reusable action before opening the URL (repeatable; name or name:key=value,…); exported as imports + use:",
          },
          {
            name: "--import",
            type: "string",
            description:
              "Action file for --use (repeatable; default: config authoring.template.imports, then actions/ dirs under the config dir)",
          },
          {
            name: "--from-spec",
            type: "string",
            description: "Setup: replay this spec's steps through --until-step",
          },
          {
            name: "--until-step",
            type: "string",
            description:
              "Last --from-spec step to replay (step id or 1-based position)",
          },
          {
            name: "--resume",
            type: "string",
            description: "Restore a scoped checkpoint before the setup",
          },
          {
            name: "--snapshot-mode",
            type: "enum",
            values: ["none", "diff", "compact", "full"],
            default: "full",
            description:
              "What the returned snapshot holds (the journal always keeps the full text)",
          },
          {
            name: "--max-bytes",
            type: "number",
            description: "Cap the returned snapshot JSON (default 16384 bytes)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "navigation or backend error (or a relative URL with no baseUrl)",
          "4": "unknown --env for the resolved config",
        },
        notes:
          "The URL may use ${vars.X} (config environment vars), ${env.X}, ${secrets.X} and ${baseUrl}; a relative URL joins the environment baseUrl. Printed URLs are redacted (secret values, token-like query params, userinfo). MCP tools cairn_discover_open/_snapshot/_interact/_navigate/_inventory/_suggest/_export/_close/_list provide interactive session-based discovery — see `cairn docs discovery`. cairn_discover_open and cairn_snapshot take env/config inputs plus var (key=value list for ${vars.X}). The session records the open URL as requested — placeholders and relative paths intact — so an exported spec never holds a resolved secret and follows the run's environment baseUrl; relative cairn_discover_navigate URLs join the config baseUrl and are recorded relative. The session also keeps browser.testIdAttribute (cairn_discover_inventory scans it).",
      },
      {
        name: "clean",
        summary: "Prune old run directories from the artifact root",
        synopsis:
          "cairn clean [--keep <n>] [--all] [--include-pinned] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--keep",
            type: "number",
            description:
              "Keep the newest N runs per spec (default: config retention.keepRuns, else 3)",
          },
          {
            name: "--all",
            type: "boolean",
            default: false,
            description:
              "Remove ALL run directories (pinned runs stay unless --include-pinned)",
          },
          {
            name: "--include-pinned",
            type: "boolean",
            default: false,
            description:
              "Also prune pinned runs (cairn pin); retention otherwise never removes them",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Artifact root to clean",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "bad arguments" },
      },
      {
        name: "spec heal",
        summary: "Run a spec and propose selector-drift fixes",
        synopsis:
          "cairn spec heal <spec-path> [--apply] [--verify] [--env <name>] [--config <path>] [--var key=value] [--backend agent-browser|playwright|mock] [--format json|yaml|md]",
        flags: [
          {
            name: "--apply",
            type: "boolean",
            default: false,
            description: "Write the proposed patch in place",
          },
          {
            name: "--verify",
            type: "boolean",
            default: false,
            description:
              "Apply to the owning file, rerun, keep the patch only if the rerun passes (else roll back)",
          },
          {
            name: "--backend",
            type: "string",
            description: "Backend override",
          },
          MOCK_FLAG,
          HEADED_FLAG,
          PROVIDER_FLAG,
          DEVICE_FLAG,
          {
            name: "--env",
            type: "string",
            description:
              "Environment override, resolved like cairn run --env; an environment the config does not define is an error (exit 4)",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value); repeatable, wins over config env vars",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "patch proposed or applied",
          "2": "error",
          "4": "unknown --env for the resolved config",
          "5": "no heal possible",
          "6": "contract hash mismatch",
          "7": "the environment policy refuses the spec in the resolved environment (nothing ran)",
        },
        outputSchema: "urn:cairntrace.dev:heal:v1",
        notes:
          "--env/--config/--var resolve exactly like cairn run (environment, vars, config browser block) and apply to every heal rerun; MCP cairn_spec_heal takes the same env/config/var inputs. An --env the config does not define is a config error (exit 4) before any browser starts; a spec whose requires/env policy refuses the resolved environment exits 7 with status no-heal-possible (MCP cairn_spec_heal returns the same exitCode). The --verify replay hint repeats the --env/--config/--var used.",
      },
      {
        name: "docs",
        summary:
          "Return focused agent documentation for a topic as structured data",
        synopsis: `cairn docs [${DOC_TOPICS.join("|")}] [--format json|yaml|md]`,
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "unknown topic" },
        outputSchema: "urn:cairntrace.dev:docs:v1",
      },
      {
        name: "doctor",
        summary: "Check environment for cairn dependencies",
        synopsis: "cairn doctor [--ios] [--format json|yaml|md]",
        flags: [
          {
            name: "--ios",
            type: "boolean",
            default: false,
            description:
              "Also probe iOS readiness (Xcode / Appium / xcuitest / simulators)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "all checks passed",
          "2": "one or more checks failed",
        },
      },
      {
        name: "explain",
        summary: "Return the full agent-facing surface as structured data",
        synopsis: "cairn explain [--format json|yaml|md]",
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success" },
        outputSchema: "urn:cairntrace.dev:explain:v1",
      },
      {
        name: "context",
        summary: "Print or locate the agent_context.md for a run",
        synopsis:
          "cairn context <run-id|latest> [--path] [--artifact-root <path>] [--config <path>]",
        flags: [
          {
            name: "--path",
            type: "boolean",
            default: false,
            description: "Print the file path instead of contents",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
        ],
        exitCodes: { "0": "success", "2": "no such run" },
      },
      {
        name: "spec scaffold",
        summary: "Write a starter behavioral spec YAML",
        synopsis:
          "cairn spec scaffold <name> --intent <text> [--out <dir>] [--from-codemap [query]] [--from-risk [--top <n>]]",
        flags: [
          {
            name: "--intent",
            type: "string",
            description: "One-line intent for the spec",
          },
          {
            name: "--out",
            type: "string",
            default: "./flows",
            description: "Output directory",
          },
          {
            name: "--from-codemap",
            type: "string",
            description:
              "Bind coversSymbol to an untested entrypoint via codemap orphans/semantic (optional query)",
          },
          {
            name: "--from-risk",
            type: "boolean",
            default: false,
            description:
              "Scaffold N stubs bound to the highest-risk untested entrypoints (read-order + risk)",
          },
          {
            name: "--top",
            type: "number",
            default: 3,
            description:
              "Number of risky entrypoints to scaffold with --from-risk",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
      },
      {
        name: "diff",
        summary:
          "Structurally compare two runs by outcomes, steps, console, and network",
        synopsis:
          "cairn diff <runA> <runB> [--artifact-root <path>] [--config <path>] [--format json|yaml|md] (each arg: run id, absolute path, or 'latest'/'previous')",
        flags: [
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "run not found" },
        outputSchema: "urn:cairntrace.dev:diff:v1",
      },
      {
        name: "stats",
        summary:
          "Aggregate labeled runs into A/B cohorts (pass rate, duration p50/p95, optional domain metric)",
        synopsis:
          "cairn stats --group-by <key> [--label key=value] [--metric <field>] [--baseline <group>] [--limit N] [--include-runs] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--group-by",
            type: "string",
            description:
              "Label key to cohort by (required), e.g. path for path=legacy|next",
          },
          {
            name: "--label",
            type: "string",
            description:
              "Only include runs that have this label (key=value). Repeatable (AND).",
          },
          {
            name: "--metric",
            type: "string",
            description:
              "Harvest this numeric field from outcomes/*.raw.json (default: processingDurationMS)",
          },
          {
            name: "--baseline",
            type: "string",
            description:
              "Baseline cohort key for ratio deltas (default: first sorted group)",
          },
          {
            name: "--limit",
            type: "number",
            description: "Max run dirs to scan, newest first (default 500)",
          },
          {
            name: "--include-runs",
            type: "boolean",
            default: false,
            description: "Include per-run rows in the structured payload",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success (empty cohorts still exit 0)",
          "2": "usage or artifact-root error",
        },
        outputSchema: "urn:cairntrace.dev:stats:v1",
      },
      {
        name: "catalog",
        summary:
          "List what the project already has — reusable actions, config vars per environment, script verifiers and their fixtures contract, environments, flows, checkpoints — so an agent reuses them instead of re-recording literals",
        synopsis:
          "cairn catalog [--config <path>] [--env <name>] [--query <text>] [--kind actions|vars|verifiers|envs|flows|checkpoints|fixtures] [--limit N] [--artifact-root <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery from the cwd)",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Vars of this environment only, last runs in it, checkpoint origin checked against its baseUrl; an environment the config does not define, or --env with no config found, exits 4",
          },
          {
            name: "--query",
            type: "string",
            description:
              "Keyword ranking (name > description/intent/tags > inputs > comments); keeps matching rows with score and matched {token, field}",
          },
          {
            name: "--kind",
            type: "string",
            description:
              "actions | vars | verifiers | envs | flows | checkpoints | fixtures; repeatable or comma-separated (default: all)",
          },
          {
            name: "--limit",
            type: "number",
            description:
              "Rows per kind (default 10 with --query, otherwise all); totals keeps the full count",
          },
          {
            name: "--artifact-root",
            type: "string",
            description:
              "Artifact root scanned for last runs (default: config artifactRoot, else ~/.cairntrace/runs)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "usage error (--kind, --limit) or an unexpected failure",
          "4": "config error (invalid config, unknown --env, or --env with no config found)",
        },
        outputSchema: "urn:cairntrace.dev:catalog:v1",
        notes:
          "Reads files only (never runs a spec, script, hook or service). actions: description (description: field, else the leading YAML comment), inputs (declared/referenced/default/required/configEnvs), steps, usedBy, lastGreenRun, problems (inputs: that disagree with vars:). vars: per environment, authored value (placeholders kept; secret-like names/values [redacted]), YAML comment, definedIn environment|inherited (<<: merge). verifiers: script.file header comment, fixtures contract (header Fixtures: block / @fixture, exported fixtures|contract object, else keys the code reads), per use fixtureKeys, unknownKeys, missingKeys. envs: baseUrl, policy, services, secrets provider + key names. flows: intent, tags, requires, actions, checkpoint, draft, lastRun (matched by the spec's path; matchedBy: name when only a same-named run was found). checkpoints: the ones specs resume plus ones captured for a configured environment's origin, with health, scope, problem; others are only counted (scan.otherCheckpoints). A malformed file or row is left out and named in warnings, never an error. Files are cached by path + mtime in-process; at most 500 run.json files are read. MCP: cairn_catalog (same inputs, camelCase artifactRoot; text is a short summary, rows are in structuredContent; without query or limit at most 20 rows per kind) and the cairn://catalog resource.",
      },
      {
        name: "logs",
        summary:
          "List runs and replay or follow their files of record (events.ndjson, run.log, logs/*, service pane logs, invocation journals)",
        synopsis:
          "cairn logs [run-id|latest|previous] [--events] [--follow] [--log run|precondition|outcome|<file>] [--services] [--service <window>] [--artifact-root <path>] [--config <path>] | cairn logs --invocation <id|latest|previous> [--follow] [--log narration|services|hook|<file>] [--format json|yaml|md]",
        flags: [
          {
            name: "--events",
            type: "boolean",
            default: false,
            description: "Stream the run's events.ndjson to stdout",
          },
          {
            name: "--follow",
            type: "boolean",
            default: false,
            description:
              "Keep streaming (events.ndjson, or the --log files) until the run or invocation settles; exit 0 when it settled, 2 when its process died first or the target does not exist. `latest --follow` follows the current run of a still-running cairn run invocation (waiting while it boots services or --before hooks); `--invocation latest --follow` streams that boot phase itself",
          },
          {
            name: "--log",
            type: "string",
            description:
              "A live log instead of events. Runs: run (run.log), precondition, outcome, or a file name under logs/. With --invocation: narration, services, hook, or a file name under the journal's logs/",
          },
          {
            name: "--invocation",
            type: "string",
            description:
              "Read the invocation journal (<artifactRoot>/_invocations/<id>) instead of a run: an id, latest or previous. Without --follow/--log/--events prints its summary (invocation.json)",
          },
          {
            name: "--services",
            type: "boolean",
            default: false,
            description: "List the run's captured service artifacts",
          },
          {
            name: "--service",
            type: "string",
            description: "Stream one tmux window's captured pane log to stdout",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description:
              "Invocation summary format (--invocation without --follow/--log/--events); other modes stream raw file content, and json/yaml on a run reference is refused with exit 2",
          },
        ],
        exitCodes: {
          "0": "success (or the followed run/invocation settled)",
          "2": "no such run/invocation/log, or a followed process died without settling",
        },
        notes:
          "latest/previous resolve only real run directories (never _invocations/). Every cairn run writes run.log, logs/precondition-NN-<name>.log and logs/outcome-<id>.log in the run dir, plus an invocation journal _invocations/<id>/ (invocation.json, events.ndjson, logs/narration.log, logs/services-*.log, logs/hook-*.log). All live logs are redacted line by line.",
      },
      {
        name: "checkpoint list",
        summary: "List saved browser-state checkpoints",
        synopsis: "cairn checkpoint list [--format json|yaml|md]",
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success" },
        notes:
          "Each checkpoint reports health (ok | expired | unscoped — captured before scope metadata existed, or staleMeta: the state was rewritten after its metadata) plus env, baseUrl, createdAt, ttl and expiresAt when recorded. MCP cairn_checkpoint_list / cairn_checkpoint_show return the same fields; MCP cairn_checkpoint_capture writes the scope metadata (discovery env baseUrl, else the page origin; optional ttl).",
      },
      {
        name: "checkpoint show",
        summary: "Inspect a saved checkpoint",
        synopsis: "cairn checkpoint show <name> [--format json|yaml|md]",
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "no such checkpoint" },
      },
      {
        name: "checkpoint delete",
        summary: "Remove a saved checkpoint",
        synopsis: "cairn checkpoint delete <name>",
        flags: [],
        exitCodes: { "0": "success", "2": "no such checkpoint" },
      },
      {
        name: "checkpoint capture-from-session",
        summary:
          "Save the current state of an existing agent-browser session as a named checkpoint (for spec session.resume)",
        synopsis:
          "cairn checkpoint capture-from-session <name> --session <ab-session> [--env <name>] [--config <path>] [--ttl <duration>] [--provider <name>] [--device <name>]",
        flags: [
          {
            name: "--session",
            type: "string",
            description: "agent-browser --session value to read state from",
          },
          {
            name: "--provider",
            type: "string",
            description:
              "agent-browser provider the target session uses (e.g. ios)",
          },
          {
            name: "--device",
            type: "string",
            description: "iOS device name the target session uses",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Environment the checkpoint is for: its baseUrl scopes the checkpoint (resume refuses another origin); an environment the config does not define exits 4",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml for --env",
          },
          {
            name: "--ttl",
            type: "string",
            description:
              "Checkpoint lifetime (30m, 12h, 7d, 2w); a run refuses to resume it afterwards",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "error",
          "4": "unknown --env for the resolved config",
        },
        notes:
          "Writes <name>.json (the browser state) and <name>.meta.json (scope: baseUrl — the --env baseUrl, else the session's current origin — env, createdAt, ttl, expiresAt; never cookies).",
      },
      {
        name: "login",
        summary:
          "Open a headed browser, let a human log in, then capture state into a checkpoint",
        synopsis:
          "cairn login <name> --url <url> [--wait-for text:<...>|url:<...>] [--timeout <ms>] [--env <name>] [--config <path>] [--ttl <duration>]",
        flags: [
          {
            name: "--url",
            type: "string",
            description: "Page to load in the headed browser",
          },
          {
            name: "--wait-for",
            type: "string",
            description:
              "Wait for text:<...> or url:<...> instead of an ENTER keypress",
          },
          {
            name: "--timeout",
            type: "number",
            default: 300000,
            description: "Max wait time in ms when --wait-for is set",
          },
          PROVIDER_FLAG,
          DEVICE_FLAG,
          {
            name: "--env",
            type: "string",
            description:
              "Environment the checkpoint is for: its baseUrl scopes the checkpoint (resume refuses another origin); an environment the config does not define exits 4",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml for --env",
          },
          {
            name: "--ttl",
            type: "string",
            description:
              "Checkpoint lifetime (30m, 12h, 7d, 2w); a run refuses to resume it afterwards",
          },
        ],
        exitCodes: {
          "0": "checkpoint saved",
          "2": "error",
          "4": "unknown --env for the resolved config",
        },
        notes:
          "Also writes <name>.meta.json: baseUrl (the --env baseUrl, else the origin of the page the login ended on — not the --url start page, which may be an identity provider; --env is the reliable scope), env, createdAt, ttl/expiresAt, and the state file's sha256. A spec that resumes the checkpoint is refused on another origin or after the ttl; a state file rewritten without its metadata reads as unscoped.",
      },
      {
        name: "export playwright",
        summary:
          "Emit a @playwright/test .spec.ts|.spec.js from a Cairntrace spec (or directory), with a coverage report",
        synopsis:
          "cairn export playwright <spec|dir> [--out <file>] [--out-dir <dir>] [--lang js|ts] [--stdout] [--project] [--into <dir>] [--config <path>] [--env <name>] [--var key=value] [--format json|yaml|md] | cairn export playwright [spec|dir] --check <exportDir> [--config <path>] [--env <name>] [--var key=value] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "cairntrace.config.yml supplying ${vars.*}/baseUrl (auto-discovered from the spec dir when omitted)",
          },
          {
            name: "--env",
            type: "string",
            description: "Config environment for var resolution",
          },
          {
            name: "--var",
            type: "string",
            description: "Override a ${vars.X} value (key=value; repeatable)",
          },
          {
            name: "--project",
            type: "boolean",
            default: false,
            description:
              "Generate a structured project (actions/, verifiers/, config, global-setup) instead of standalone spec files",
          },
          {
            name: "--into",
            type: "string",
            description:
              "Write actions/lib/tests/verifiers into an existing Playwright tree (no package.json or playwright.config)",
          },
          {
            name: "--check",
            type: "string",
            description:
              "Verify an existing export dir against its .cairn-export.json: regenerate in memory from the current sources (the manifest's input unless a spec/dir is given) and report stale/missing/orphaned/modified files. Writes nothing. Exit 0 fresh, 1 stale, 2 error",
          },
          {
            name: "--out",
            type: "string",
            description:
              "Where to write a single file (defaults to <spec-dir>/<name>.spec.ts|js)",
          },
          {
            name: "--out-dir",
            type: "string",
            description:
              "Batch-write exported specs into this directory (required for directory input)",
          },
          {
            name: "--lang",
            type: "enum",
            values: ["js", "ts"],
            default: "ts",
            description: "Output language (TypeScript or JavaScript)",
          },
          {
            name: "--stdout",
            type: "boolean",
            default: false,
            description:
              "Print source only to stdout (single-spec; no coverage report)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description:
              "Coverage report format when writing files (not used with --stdout)",
          },
        ],
        exitCodes: {
          "0": "success (written or partial with skips); --check: export is fresh",
          "1": "--check: export is stale (files or specs drifted from the sources)",
          "2": "usage/IO error, or a late-bound placeholder leaked into generated code; --check: no/unreadable manifest or regeneration failed",
          "4": "spec parse failure",
        },
      },
      {
        name: "export brief",
        summary:
          "Emit an agent-neutral journey brief (what to fill, what to look for) from a spec, optionally enriched from a passing run",
        synopsis:
          "cairn export brief <spec|dir> [--from-run <runDir|latest>] [--out <file>] [--out-dir <dir>] [--stdout] [--format json|yaml|md]",
        flags: [
          {
            name: "--out",
            type: "string",
            description: "Where to write a single file",
          },
          {
            name: "--out-dir",
            type: "string",
            description:
              "Batch-write briefs into this directory (required for directory input)",
          },
          {
            name: "--stdout",
            type: "boolean",
            default: false,
            description: "Print the brief only (single-spec)",
          },
          {
            name: "--from-run",
            type: "string",
            description:
              "Enrich approximations from a run dir or 'latest' (uses StepResult.resolved)",
          },
          {
            name: "--config",
            type: "string",
            description: "cairntrace.config.yml path",
          },
          {
            name: "--env",
            type: "string",
            description: "Config environment name",
          },
          {
            name: "--var",
            type: "string",
            description: "Override a ${vars.X} value (repeatable key=value)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Brief or report format",
          },
        ],
        exitCodes: {
          "0": "written",
          "2": "usage or runtime error",
          "4": "nothing exported",
        },
        outputSchema: "urn:cairntrace.dev:brief:v1",
        notes:
          "MCP: cairn_export_brief. Live try-then-ask: cairn_accompany_open / _choose / _status / _close / _list.",
      },
      {
        name: "import playwright",
        summary:
          "Convert a @playwright/test file into reviewable Cairntrace YAML",
        synopsis:
          "cairn import playwright <file> [--out <file>] [--stdout] [--format json|yaml|md]",
        flags: [
          {
            name: "--out",
            type: "string",
            description:
              "Where to write (defaults to <source-dir>/<test-title>.yml)",
          },
          {
            name: "--stdout",
            type: "boolean",
            default: false,
            description: "Print generated YAML to stdout instead of writing",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Report output format when writing a file",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
      },
      {
        name: "mcp",
        summary:
          "Start the Cairntrace MCP server on stdio (tools mirror this CLI surface)",
        synopsis: "cairn mcp [--allow-hooks] [--allow-services]",
        flags: [
          {
            name: "--allow-hooks",
            type: "boolean",
            default: false,
            description:
              "Accept cairn_run before/after hooks (arbitrary shell commands). Without it (or CAIRN_MCP_ALLOW_HOOKS=1) a cairn_run with before/after fails with an error naming this flag.",
          },
          {
            name: "--allow-services",
            type: "boolean",
            default: false,
            description:
              "Let MCP tools start config services (docker/seed/tmux) and run their teardown. Without it (or CAIRN_MCP_ALLOW_SERVICES=1) cairn_run, cairn_spec_finish and cairn_audit whose config would start services fail with exit 4 before anything starts (noServices / reuseServices still work), and cairn_services_up / cairn_services_down refuse.",
          },
        ],
        exitCodes: { "0": "clean shutdown" },
        notes:
          "Run tools: cairn_run runs specs through the same engine as cairn run — every run flag is an input under its camelCase name (env, config, var, coldStart, headed, mock, backend, provider, device, parallel, artifactRoot, junit, stampIfGreen, noWebServer, noServices, servicesDryRun, reuseServices, stashOnFailure, autoAnnotate, monitor, sinceCodemap (alias since), selectOnly, tag, label (plus a labels object), before, after, hookTimeoutMs, repeat, matrix, stopOnFail) plus specs (paths/directories), path (one spec) and wait. Like cairn run it boots the config webServer and runs its teardown unless noWebServer; config services start (and their teardown runs) only with --allow-services, otherwise a run that would start them fails with exit 4 before anything starts (pass noServices or reuseServices). wait:true (default) returns the cairn run --format json document (RunResult, BatchRunResult, SelectionResult; repeat/matrix → one BatchRunResult over every iteration) with nextActions and sends notifications/progress for run/step/outcome milestones when the request carries a progressToken; cancelling or timing out the request cancels the run. wait:false returns {invocationId, journalDir, status: running} at once (at most 8 running invocations per server). cairn_run_status {invocationId} reports status, runs and the final document; cairn_run_cancel {invocationId} cancels gracefully (browsers and running hooks killed, a booting webServer killed, specs not yet started skipped, services/webServer torn down, journal aborted; idempotent) — the process tree of a running services boot command, precondition, node transform or node script verifier is killed and the rest of the spec is skipped (status errored, failure.phase cancelled); only teardown commands and an in-flight file/xlsx check keep running; a client that disconnects cancels its background invocations. cairn_logs {invocationId?, run?, log?, cursor?, maxBytes?} returns {text, nextCursor, eof, settled} slices of events.ndjson, run.log, precondition/outcome logs, or the invocation's narration/services/hook logs; pass nextCursor back as cursor (one position per file; single-file logs also accept nextOffset as offset). Invocations that boot services or a webServer from the same config file run one at a time inside the server, whatever their env. --allow-hooks gates hooks and --allow-services gates the services boot/teardown; neither is a sandbox: config and spec shell (webServer, preconditions, script verifiers) still runs. invocation.json records origin (cli | mcp) and the MCP client. Other tools: explain, docs, doctor, context, snapshot, catalog, spec scaffold/verify/heal/lint/finish/promote, checkpoint list/show/delete/capture, config validate, services status/up/down, stash save/list/info/restore/search, clip, investigate, audit, annotate, secrets status, discover_* (12: open, resume, snapshot, interact, navigate, inventory, network, suggest, remove_step, export, close, list), export_brief, export_playwright, accompany_* (5).",
      },
      {
        name: "spec verify",
        summary: "Lint and (optionally) stamp the contract hash on a spec",
        synopsis:
          "cairn spec verify <spec-path> [--stamp] [--env <name>] [--config <path>] [--var key=value] [--format json|yaml|md]",
        flags: [
          {
            name: "--stamp",
            type: "boolean",
            default: false,
            description: "Write a fresh contractHash into the file",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Environment override (an environment the config does not define fails verify with exit 4)",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit config path",
          },
          {
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value); repeatable, wins over config env vars",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "valid",
          "4": "lint failed (schema, unknown --env, an --env the environment policy refuses, a referenced file that does not exist, or placeholder reference audit)",
          "6": "contract hash mismatch",
        },
        notes:
          "MCP cairn_spec_verify runs this exact code path (env/config/var inputs, placeholder reference audit, exit code in structuredContent.exitCode). Structured findings (additive): env-not-allowed (error with an explicit --env, warning for the default env), unknown-env, missing-file (eval.file, eval args.filePath/fixtureFiles, transform.file/input, upload.path, script.file — resolved exactly like a run, actions against their own directory), absolute-path and deprecated-path (warnings), checkpoint-missing / checkpoint-expired / checkpoint-base-url-mismatch (warnings), unknown-gate (a preconditions.wait gate the config's gates: lacks) and unknown-fixture (a fixtures: name the config lacks) (errors). environment {name, allowed, explicit} and environments[] (every config environment with allowed, code, optIn, trait) list where the spec may run.",
      },
      {
        name: "spec lint",
        summary:
          "Friendly fix-it findings before a spec runs (quoting, schema per step, files, cold start, fixtures, secrets, evals, host paths, shell placeholders, step ids, vars per env)",
        synopsis:
          "cairn spec lint <spec...> [--env a,b] [--config <path>] [--var key=value] [--fix] [--format json|yaml|md]",
        flags: [
          {
            name: "--env",
            type: "string",
            description:
              "Environments to resolve vars and files in (comma-separated or repeatable; default the spec's default environment)",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit config path",
          },
          {
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value); repeatable, wins over config env vars",
          },
          {
            name: "--fix",
            type: "boolean",
            default: false,
            description:
              "Apply safe fixes in place: quote # selectors, insert step ids (comments and quoting elsewhere unchanged)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "no error findings (warnings allowed)",
          "2": "error",
          "4": "at least one error finding",
        },
        outputSchema: "urn:cairntrace.dev:spec-lint:v1",
        notes:
          "Rules: unquoted-hash (a `selector: #id` is a YAML comment that leaves the value empty; a comment after a key holding a nested map is fine), yaml-syntax, schema (each failing step checked against its own kind), unknown-env / unresolved-var / unresolved-action / contract-hash-mismatch per --env, unresolved-reference (${env.X} / ${secrets.X} nothing supplies), missing-file / absolute-path / deprecated-path (resolved like a run, including preconditions.commands[].cwd), cold-start-echo-only / cold-start-missing (warnings), unknown-fixture-key / missing-fixture-key (script verifier contracts, as cairn catalog reads them), literal-secret (errors: a known secret value, a credential var; warnings: a literal typed into a field whose name sounds like a credential, token-looking values), eval-typed-equivalent (location.assign → open, fetch login → request, .click() → click, value setter → fill, polling loops → wait / click.until), residual-placeholder (a ${requests.x} in a precondition would reach the shell literally), missing-step-id, shell-arg-unset (warning: a run: shell command reads $N the step does not pass in args). Each finding: rule, severity, message, line, where, env, fix {description, safe, applied}. --fix writes only when the edited file parses to the same document plus the quoted values / new ids, and skips step ids in documents with YAML anchors/aliases; applied says what was written. Directories expand like cairn run (actions/ and _ drafts skipped); reusable action files are linted as actions. MCP: cairn_spec_lint {paths | path, env (string or array), config, var, fix}.",
      },
      {
        name: "spec finish",
        summary:
          "Lint, run cold through the cairn run engine, stamp the contract when green, summarize the run",
        synopsis:
          "cairn spec finish <spec> [--env <name>] [--config <path>] [--var key=value] [--headed] [--mock] [--backend agent-browser|playwright|mock] [--provider <name>] [--device <name>] [--artifact-root <path>] [--reuse-services] [--no-services] [--no-web-server] [--format json|yaml|md]",
        flags: [
          {
            name: "--env",
            type: "string",
            description: "Environment (as cairn run --env)",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit config path",
          },
          {
            name: "--var",
            type: "string",
            description:
              "Runtime var override (key=value); repeatable, wins over config env vars",
          },
          HEADED_FLAG,
          MOCK_FLAG,
          {
            name: "--backend",
            type: "enum",
            values: ["agent-browser", "playwright", "mock"],
            default: "agent-browser",
            description: "Browser backend",
          },
          {
            name: "--provider",
            type: "string",
            description:
              "agent-browser provider (wins over config browser.provider)",
          },
          {
            name: "--device",
            type: "string",
            description: "iOS device name (with --provider ios)",
          },
          {
            name: "--artifact-root",
            type: "string",
            description:
              "Run artifact root; finish receipts live under it (pass the same to cairn spec promote)",
          },
          {
            name: "--reuse-services",
            type: "boolean",
            description:
              "Run against the services cairn services up owns (default: yes when the config's lock is held for this env)",
          },
          {
            name: "--no-services",
            type: "boolean",
            default: false,
            description: "Skip the config services lifecycle",
          },
          {
            name: "--no-web-server",
            type: "boolean",
            default: false,
            description:
              "Skip the config webServer lifecycle (use the dev server you already run; a cold start otherwise boots it fresh)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "green: no lint errors, the cold-start run passed, the contract hash is stamped",
          "1": "red: an outcome failed",
          "2": "errored",
          "3": "cold-start gate",
          "4": "lint-failed (or a config error)",
          "6": "contract hash mismatch",
          "7": "refused by the environment policy",
        },
        outputSchema: "urn:cairntrace.dev:spec-finish:v1",
        notes:
          "Result: {status: green | red | lint-failed | errored | refused, exitCode, draft, lint {status, errors, warnings, findings}, run {status, exitCode, invocationId, runId, runDir, report (report.html), environment, backend, coldStart, durationMs, reusedServices}, contractHash, stamped, context {path, summary} (agent_context.md outcome results + suggested next steps), nextActions}. The run is the same engine and options as cairn run --cold-start --stamp-if-green (config, browser.*, vars, scoped secrets, services/webServer, invocation journal). A green finish writes a receipt (content hash, backend, run) under <artifactRoot>/_finish/ that cairn spec promote checks against the file's content; a finish on the mock backend never touches the app, says so in nextActions, and promote refuses it without --force. MCP: cairn_spec_finish {path, env, config, var, headed, mock, backend, provider, device, artifactRoot, reuseServices, noServices, noWebServer} (cancelling the request cancels the run).",
      },
      {
        name: "spec promote",
        summary:
          "Move a draft out of the drafts dir after a green cairn spec finish, rebase its paths, stamp the contract",
        synopsis:
          "cairn spec promote <draft> [--to <file|dir>] [--force] [--expect-content-hash <sha256>] [--config <path>] [--artifact-root <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--to",
            type: "string",
            description:
              "Destination spec file or folder (default: the drafts dir's parent, keeping sub-folders and dropping leading _)",
          },
          {
            name: "--force",
            type: "boolean",
            default: false,
            description:
              "Promote without a green real-backend finish of this exact content (reported in warnings)",
          },
          {
            name: "--expect-content-hash",
            type: "string",
            description:
              "sha256 hex of the draft text the reviewer saw; any other content is refused (exit 4), even with --force",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit config path",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Where finish receipts live (default: as cairn run)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "promoted",
          "2": "error (including a malformed --expect-content-hash)",
          "4": "refused: not a draft, no green finish of this content (or only a mock one), content that differs from --expect-content-hash, target exists or is still a draft, or the promoted copy would point at missing files (rolled back)",
        },
        outputSchema: "urn:cairntrace.dev:spec-promote:v1",
        notes:
          "Drafts live in config authoring.draftsDir (default flows/_drafts; its folder name must start with _) or under any _ folder/file. Relative imports, eval/transform files, eval args.filePath / args.fixtureFiles next to the draft, upload paths, script verifier files and preconditions.commands[].cwd are rewritten to keep pointing at the same files (rebased[]); precondition commands without cwd are reported (they run in the spec's new folder). The promoted copy is linted for missing files and removed again (draft kept) when it finds new ones. A finish on the mock backend does not count without --force. Never replaces an existing spec. Result: {from, to, intent, outcomes, contractHash, forced?, finish {runId, runDir, backend, finishedAt}?, rebased?, warnings}. MCP: cairn_spec_promote — call it only after the human approved the draft.",
      },
      {
        name: "init agent-kit",
        summary:
          "Print (or --write into AGENTS.md) a short project section on authoring Cairntrace specs",
        synopsis:
          "cairn init agent-kit [--write] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--write",
            type: "boolean",
            default: false,
            description:
              "Put the section in the AGENTS.md next to the config (created, appended, or the earlier agent-kit block replaced)",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit config path",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
        outputSchema: "urn:cairntrace.dev:agent-kit:v1",
        notes:
          "The section names the project's config, environments, drafts dir and actions, gives the five-step author flow (catalog → discover → convention export → spec finish → promote after review) and the authoring rules, between <!-- cairntrace:agent-kit:start/end --> markers.",
      },
      {
        name: "discover export",
        summary:
          "Write a discovery session as a spec from its journal alone, optionally with the project's conventions",
        synopsis:
          "cairn discover export --from-session <dir|id> (--path <spec> | --into <dir|file> [--name <name>] | --conventions) [--intent <text>] [--outcomes <file>] [--no-reuse-actions] [--no-lift-vars] [--allow-secret-literals] [--requires-env a,b] [--mutates] [--tag t]… [--resume <checkpoint>] [--overwrite] [--artifact-root <path>]",
        flags: [
          {
            name: "--from-session",
            type: "string",
            description:
              "Session journal directory, or a session id under <artifactRoot>/_sessions/",
          },
          {
            name: "--path",
            type: "string",
            description: "Spec to write (relative to the cwd)",
          },
          {
            name: "--intent",
            type: "string",
            description:
              "One-line intent of the spec (default: the intent of the session's last export; required when it has none)",
          },
          {
            name: "--outcomes",
            type: "string",
            description:
              "YAML/JSON file with the outcomes array, the contract (default: the outcomes of the session's last export; required when it has none)",
          },
          {
            name: "--resume",
            type: "string",
            description:
              "Write session: { resume } (default: the session's own)",
          },
          {
            name: "--overwrite",
            type: "boolean",
            default: false,
            description:
              "Replace a stamped spec (or, with conventions, any existing file)",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override the artifact root holding _sessions/",
          },
          {
            name: "--into",
            type: "string",
            description:
              "Convention export: folder (or .yml) relative to the config dir; default the drafts dir",
          },
          {
            name: "--name",
            type: "string",
            description:
              "Spec name (snake_case) and file name inside --into (default: the intent's first words)",
          },
          {
            name: "--conventions",
            type: "boolean",
            default: false,
            description:
              "Apply the project conventions (implied by --into or a missing --path)",
          },
          {
            name: "--no-reuse-actions",
            type: "boolean",
            description:
              "Keep recorded steps instead of replacing runs an existing action performs by use:",
          },
          {
            name: "--no-lift-vars",
            type: "boolean",
            description: "Keep literals equal to config var values as written",
          },
          {
            name: "--allow-secret-literals",
            type: "boolean",
            default: false,
            description:
              "Keep a password-field literal no known secret explains (warning instead of refusal; known secrets are always placeholders)",
          },
          {
            name: "--requires-env",
            type: "string",
            description:
              "requires.env of the spec (comma-separated; default the setup's, else authoring.template.requires)",
          },
          {
            name: "--mutates",
            type: "boolean",
            default: false,
            description: "requires.mutates: true",
          },
          {
            name: "--tag",
            type: "string",
            description:
              "metadata.tags entry (repeatable; merged with authoring.template.metadata.tags)",
          },
        ],
        exitCodes: {
          "0": "written and parsed",
          "2": "error (journal not found, unreadable outcomes)",
          "4": "refused (existing file, stamped spec, secret literal, invalid spec, no --intent/--outcomes and no earlier export to reuse) or verify failed",
        },
        notes:
          "--config and --format are read from the parent discover command. With conventions: setup/recorded steps an existing action performs become use: (report.reusedActions with confidence), literals equal to a config var become ${vars.X} (report.liftedVars), known secrets become placeholders (report.secretsPlaceholdered), absolute URLs under the env baseUrl become relative, open gets waitUntil networkidle, page-changing clicks get a wait, observed mutations become postcondition.network, every step gets a snake_case id, authoring.template requires/metadata.tags apply. MCP cairn_discover_export takes the same options (into, name, conventions, reuseActions, liftVars, refuseSecrets, requires, tags).",
      },
      {
        name: "discover sessions",
        summary:
          "List session journals (discovery and accompany), newest first",
        synopsis:
          "cairn discover sessions [--limit n] [--artifact-root <path>]",
        flags: [
          {
            name: "--artifact-root",
            type: "string",
            description: "Override the artifact root holding _sessions/",
          },
          {
            name: "--limit",
            type: "number",
            description: "Newest n sessions (default 20)",
          },
        ],
        exitCodes: { "0": "success" },
        notes:
          "--config and --format are read from the parent discover command.",
      },
      {
        name: "stash save",
        summary: "Stash a run directory to the fcheap vault",
        synopsis:
          "cairn stash save <run-id> [--tag <tag>] [--labels-as-tags] [--ttl <duration>] [--include <category>] [--tool <name>] [--source <path>] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--tag",
            type: "string",
            description: "Tag for this stash; repeatable",
          },
          {
            name: "--labels-as-tags",
            type: "boolean",
            default: false,
            description:
              "Also tag the stash with every run.json label as key=value (from cairn run --label)",
          },
          {
            name: "--ttl",
            type: "string",
            description:
              "file.cheap time-to-live, e.g. 30d (default: never expires)",
          },
          {
            name: "--include",
            type: "string",
            description:
              "Evidence category to stash (text, screenshots, traces, videos, downloads); repeatable. Default: config stash.include, else text + screenshots. Secret-bearing members (unsanitized traces, raw monitor profiles, files cairn did not write) stay out unless stash.unsafeIncludeRawTraces.",
          },
          {
            name: "--tool",
            type: "string",
            default: "cairntrace",
            description: "Tool name recorded in the stash manifest",
          },
          {
            name: "--source",
            type: "string",
            description: "Source artifact path",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "fcheap not installed or run not found",
        },
        notes:
          "The run goes through the evidence gate (traces, videos and downloads stay local unless included) and gains stash-receipt.json (contentHash, fileCount, sizeBytes, ttl/expiresAt, tags, excluded, secretsFound) plus an artifact.stash event with action manual. When the installed fcheap supports it, run identity is passed as --meta (run_id, status, spec, env, backend, cairn_version).",
      },
      {
        name: "pin",
        summary: "Keep a run past retention",
        synopsis:
          "cairn pin <run-ref> [--reason <text>] [--stash] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--reason",
            type: "string",
            description:
              "Why the run is kept (stored as run.json pinned.reason)",
          },
          {
            name: "--stash",
            type: "boolean",
            default: false,
            description:
              "Also stash the run to fcheap with the keep tag and no TTL (evidence gate applies)",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "pinned",
          "2": "run not found, run.json invalid, or the --stash save failed (the pin is kept)",
        },
        notes:
          "Writes pinned: {at, reason?} to run.json and rebuilds artifact-manifest.json. Retention never prunes a pinned run, and pinned runs take no keepRuns/keepFailedRuns slot; cairn clean --include-pinned overrides. MCP: cairn_pin (unpin: true to remove).",
      },
      {
        name: "unpin",
        summary: "Let retention prune a pinned run again",
        synopsis:
          "cairn unpin <run-ref> [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "unpinned (or was not pinned)",
          "2": "run not found or run.json invalid",
        },
      },
      {
        name: "publish",
        summary:
          "Publish a run to the private file.cheap artifact service (fcheap publish)",
        synopsis:
          "cairn publish <run-ref> [--retention-days <n>] [--include <category>] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--retention-days",
            type: "number",
            description:
              "Remote retention, 1-31 days (default: config retention.publish.retentionDays, else 7)",
          },
          {
            name: "--include",
            type: "string",
            description:
              "Evidence category to publish (text, screenshots, traces, videos, downloads); repeatable. Default: config retention.publish.include, else text + screenshots. Secret-bearing and sanitized members (so every trace) are never published.",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "published (publish-receipt.json written)",
          "2": "run not found, bad flags, or the publication failed (reason code in the result and in an artifact.publish event)",
        },
        notes:
          "Needs FILECHEAP_ARTIFACT_SERVICE_URL and FILECHEAP_INGEST_TOKEN (the token reaches only fcheap). Packages the gated run as a bounded tar.gz (32 MiB producer quota), sends a metadata-only RunIndexV1 sidecar (--run-index) when the installed fcheap supports it, verifies the server receipt, and writes publish-receipt.json {version, artifactRef, sha256, sizeBytes, publishedAt, expiresAt, webUrl?, excluded?, runIndexSkipped?}. The local run is never deleted. `cairn doctor` reports publisher readiness. MCP: cairn_publish.",
      },
      {
        name: "stash list",
        summary: "List stashes in the fcheap vault",
        synopsis:
          "cairn stash list [--tag <tag>] [--tool <name>] [--format json|yaml|md]",
        flags: [
          {
            name: "--tag",
            type: "string",
            description: "Filter by tag",
          },
          {
            name: "--tool",
            type: "string",
            description: "Filter by tool name",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "fcheap not installed" },
      },
      {
        name: "stash info",
        summary: "Get detailed info about a stash",
        synopsis: "cairn stash info <stash-id> [--format json|yaml|md]",
        flags: [
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "fcheap not installed or stash not found",
        },
      },
      {
        name: "stash restore",
        summary: "Restore a stash to a directory",
        synopsis:
          "cairn stash restore <stash-id> [--to <dir>] [--format json|yaml|md]",
        flags: [
          {
            name: "--to",
            type: "string",
            description: "Target directory (default: a fresh temp dir)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "fcheap not installed or restore failed",
        },
      },
      {
        name: "stash search",
        summary: "Search across all stashed run artifacts",
        synopsis:
          "cairn stash search <query> [--mode keyword|semantic|hybrid] [--limit <n>] [--format json|yaml|md]",
        flags: [
          {
            name: "--mode",
            type: "string",
            description: "Search mode: keyword | semantic | hybrid",
          },
          {
            name: "--limit",
            type: "number",
            default: 20,
            description: "Max results",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "fcheap not installed" },
      },
      {
        name: "investigate",
        summary:
          "Stash a run to fcheap and find code responsible for failures via vecgrep",
        synopsis:
          "cairn investigate <run-id> [--codebase <dir>] [--connect] [--index] [--query <q>] [--clips] [--mode semantic|keyword|hybrid] [--limit <n>] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          INDEX_FLAG,
          {
            name: "--codebase",
            type: "string",
            description:
              "Codebase directory to search; passing it implies --connect",
          },
          {
            name: "--connect",
            type: "boolean",
            default: false,
            description:
              "Connect after stashing; uses investigate.codebaseDir when codebase is omitted",
          },
          {
            name: "--query",
            type: "string",
            description: "Override the auto-extracted search query for vecgrep",
          },
          {
            name: "--clips",
            type: "boolean",
            default: false,
            description:
              "Stash videos/clips instead of the full run when available",
          },
          {
            name: "--mode",
            type: "string",
            description:
              "vecgrep search mode: semantic | keyword | hybrid (default: config or hybrid)",
          },
          {
            name: "--limit",
            type: "number",
            description: "Max code matches (default: config or 10)",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success (code matches returned or run stashed without --connect)",
          "2": "run resolution, file.cheap process, or JSON contract failure",
        },
        outputSchema: "urn:cairntrace.dev:investigate:v1",
      },
      {
        name: "audit",
        summary:
          "Run a spec with video, extract vidtrace evidence, and find code matches",
        synopsis:
          "cairn audit <spec> [--codebase <dir>] [--connect] [--index] [--speed <0.25-4.0>] [--slow-mo <ms>] [--mode semantic|keyword|hybrid] [--limit <n>] [--env <name>] [--no-cold-start] [--no-services] [--reuse-services] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          INDEX_FLAG,
          {
            name: "--codebase",
            type: "string",
            description:
              "Codebase directory to search; passing it implies --connect",
          },
          {
            name: "--connect",
            type: "boolean",
            default: false,
            description:
              "Connect after stashing; uses investigate.codebaseDir when codebase is omitted",
          },
          {
            name: "--speed",
            type: "number",
            description:
              "Video playback speed multiplier (0.25–4.0; <1 slows, >1 speeds up)",
          },
          {
            name: "--slow-mo",
            type: "number",
            description:
              "Delay in ms between Playwright actions during recording (0–5000)",
          },
          {
            name: "--mode",
            type: "string",
            description:
              "vecgrep search mode: semantic | keyword | hybrid (default: config or hybrid)",
          },
          {
            name: "--limit",
            type: "number",
            description: "Max code matches (default: config or 10)",
          },
          {
            name: "--env",
            type: "string",
            description: "Environment override",
          },
          {
            name: "--no-cold-start",
            type: "boolean",
            default: false,
            description:
              "Reuse existing browser state instead of audit's default cold start",
          },
          {
            name: "--reuse-services",
            type: "boolean",
            default: false,
            description:
              "Run against the services `cairn services up` owns for this config + env (readiness check, no start, no teardown). Without it the audit refuses (exit 4) before anything starts while that lock exists. MCP: reuseServices.",
          },
          {
            name: "--no-services",
            type: "boolean",
            default: false,
            description:
              "Skip the config services lifecycle (the stack is already up). MCP: noServices; an MCP server without --allow-services refuses (exit 4) an audit whose config would start services.",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "audit passed (optional vidtrace warnings may still be present)",
          "1": "behavioral spec failure",
          "2": "run setup, contract, or required integration failure",
          "4": "a `cairn services up` lock refused the audit (held without --reuse-services, held for another env of the config, stale or unreadable, or --reuse-services without a lock); nothing started",
        },
        outputSchema: "urn:cairntrace.dev:audit:v1",
      },
      {
        name: "clip",
        summary: "Cut named clips from a run video using vidtrace",
        synopsis:
          "cairn clip <run-ref> --label <label=start-end> [--label ...] [--out <dir>] [--name <prefix>] [--reencode] [--stash] [--tag <tag>] [--artifact-root <path>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--label",
            type: "string",
            description:
              "Clip label with start/end timestamps (name=start-end); repeatable. At least one is required.",
          },
          {
            name: "--out",
            type: "string",
            description: "Clip output directory (default: run/videos/clips)",
          },
          {
            name: "--name",
            type: "string",
            description: "Clip filename prefix",
          },
          {
            name: "--reencode",
            type: "boolean",
            default: false,
            description: "Re-encode clips instead of stream-copy",
          },
          {
            name: "--stash",
            type: "boolean",
            default: false,
            description:
              "Stash the run directory to fcheap after cutting clips",
          },
          {
            name: "--tag",
            type: "string",
            description: "Tag for the stash; repeatable",
          },
          {
            name: "--artifact-root",
            type: "string",
            description: "Override artifact root directory",
          },
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success (a missing run video, bad --label, or missing vidtrace is reported in-band in the result error field)",
        },
        notes:
          "MCP tool cairn_clip mirrors this command — see `cairn docs clip`.",
      },
      {
        name: "annotate",
        summary: "Pin a note and/or data to a code symbol via codemap annotate",
        synopsis:
          "cairn annotate <symbol> [--note <text>] [--data <json>] [--source <label>] [--from <sym>] [--to <sym>] [--format json|yaml|md]",
        flags: [
          {
            name: "--note",
            type: "string",
            description: "Free-form note text to attach to the symbol",
          },
          {
            name: "--data",
            type: "string",
            description:
              "Opaque data payload (e.g. JSON from a cairntrace run)",
          },
          {
            name: "--source",
            type: "string",
            default: "cairntrace",
            description: "Annotation source label",
          },
          {
            name: "--from",
            type: "string",
            description:
              "Annotate a call path from→to instead of a single symbol",
          },
          {
            name: "--to",
            type: "string",
            description: "Call path end symbol (use with --from)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "codemap not installed or annotation failed",
        },
      },
      {
        name: "secrets",
        summary: "Check TinyVault secrets provider status and available keys",
        synopsis:
          "cairn secrets [--project <name> | --group <name> --env <name>] [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--project",
            type: "string",
            description: "TinyVault project name (direct mode)",
          },
          {
            name: "--group",
            type: "string",
            description:
              "TinyVault environment group (inheritance mode; requires --env)",
          },
          {
            name: "--env",
            type: "string",
            description: "Environment name within the group (requires --group)",
          },
          {
            name: "--config",
            type: "string",
            description: "Explicit cairntrace.config.yml",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "success",
          "2": "tvault not installed or project/group not found",
        },
      },
      {
        name: "services status",
        summary:
          "Check the status of the services environment (docker, seed freshness, tmux session) and its `cairn services up` owner lock",
        synopsis:
          "cairn services status [--config <path>] [--env <name>] [--project <name>] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Environment whose effective services and owner lock are reported (default: config defaultEnvironment, else local)",
          },
          {
            name: "--project",
            type: "string",
            description: "Project name override (default: from config)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: { "0": "success", "2": "error" },
        notes:
          "`lock` reports the owner lock of the config (one per config file): state absent|held|unreadable, the lock (owner services-up, env, by cli|mcp, pid, startedAt), ageSeconds, and for a lock held for this env stale + problems when the services it owns are not actually up (the same quick check `cairn run --reuse-services` makes, with the env's scoped secrets) plus unchecked for phases it could not see (a compose command `docker compose ps` cannot resolve: trusted, set docker.readinessCheck). A lock held for another env is reported without a liveness check. MCP: cairn_services_status {config, env}.",
      },
      {
        name: "services up",
        summary:
          "Start the config services (docker → seed → tmux) like `cairn run` would, leave them running, and write the config's owner lock; runs of that env then need --reuse-services and runs of other envs of the config refuse",
        synopsis:
          "cairn services up [--config <path>] [--env <name>] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery from the cwd)",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Environment (default: config defaultEnvironment, else local); its effective services block is started",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "services up and the lock written",
          "2": "boot failure (failure cleanup tears down what started; no lock), a --config that does not exist or cannot be read, or a vault failure",
          "4": "no config found by discovery, unknown --env, no services configured for the environment, or the config's lock is held for another env",
        },
        outputSchema: "urn:cairntrace.dev:services-up:v1",
        notes:
          "Same code path as cairn run (reuse rules, scoped TinyVault secrets, redacted narration on stderr). Lock: one per config file, ~/.cairntrace/services/<config dir>.<sha256(config path)[0:16]>.lock.json {version: 1, owner: services-up, project, env, configPath (canonical), startedAt, pid (of the up command; informational), by: cli|mcp}, written atomically; readers ignore unknown keys. Running up again for the same env heals the stack and refreshes it (replacedLock); up for another env of the config is exit 4 (environments share its compose project and tmux session). While it exists cairn run for that env refuses with exit 4 unless --reuse-services (MCP reuseServices), and runs of other envs of the config refuse. Ctrl-C during the boot tears down what started. MCP: cairn_services_up {config, env} (waits for a cairn_run of the same server on that config).",
      },
      {
        name: "services down",
        summary:
          "Tear the config services down (the configured teardown commands in order, then the tmux session) and remove the `cairn services up` lock",
        synopsis:
          "cairn services down [--config <path>] [--env <name>] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery from the cwd)",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Environment (default: config defaultEnvironment, else local)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "torn down (also when nothing was running or no lock existed)",
          "2": "a teardown command failed (the rest still ran and the lock is removed), or a --config that does not exist or cannot be read",
          "4": "no config found by discovery, unknown --env, or the config's lock is held for another env (nothing torn down)",
        },
        outputSchema: "urn:cairntrace.dev:services-down:v1",
        notes:
          "Unlike a run's teardown there is no reuse skipping: docker compose down and tmux kill-session run when the config's teardown list has them (a docker phase no teardown command stops gets a warning: its containers keep running), then a still-running tmux session is killed. Works without a lock (a stack a run left alive for reuse). A vault that cannot be read does not block it (warning; teardown runs without vault values). MCP: cairn_services_down {config, env}.",
      },
      {
        name: "config validate",
        summary:
          "Validate a cairntrace.config.yml file (structure + cross-field rules), parsed exactly like cairn run (${env.X}, YAML merge keys, ${config.dir})",
        synopsis:
          "cairn config validate [--config <path>] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml (overrides auto-discovery)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "config is valid",
          "4": "config is invalid (schema or cross-field violation)",
        },
      },
      {
        name: "wait",
        summary:
          "Wait for typed readiness gates in order (config gates: names, http(s):// URLs, tcp://host:port), stopping at the first that is not ready",
        synopsis:
          "cairn wait <gate|url...> [--config <path>] [--env <name>] [--status <codes>] [--any-response] [--timeout <duration>] [--every <duration>] [--stable <n>] [--format json|yaml|md]",
        flags: [
          {
            name: "--config",
            type: "string",
            description:
              "Explicit cairntrace.config.yml whose gates: registry resolves names (default: discovered from the cwd)",
          },
          {
            name: "--env",
            type: "string",
            description:
              "Environment whose scoped secrets gates may reference as ${secrets.X} (default: config defaultEnvironment, else local)",
          },
          {
            name: "--status",
            type: "string",
            description:
              "Accepted statuses for URL targets: codes, classes or ranges, comma-separated (default 2xx,3xx)",
          },
          {
            name: "--any-response",
            type: "boolean",
            default: false,
            description:
              "URL targets accept any HTTP answer (the old readiness rule)",
          },
          {
            name: "--timeout",
            type: "string",
            description:
              "Override every target's budget: ms or 30s/5m/1h; 0 = no deadline (default: the gate's timeout, else 60s)",
          },
          {
            name: "--every",
            type: "string",
            description:
              "Override the pause between attempts (default: the gate's every, else 1s)",
          },
          {
            name: "--stable",
            type: "string",
            description:
              "Override the consecutive passing attempts required (default: the gate's stable, else 1)",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "every gate is ready",
          "1": "a gate was not ready (failed, timed out or cancelled); the wait stops there",
          "2": "error: a --config that does not exist or cannot be read",
          "4": "invalid input: unknown gate or env, an invalid config, or a bad --status/--timeout/--every/--stable",
        },
        outputSchema: "urn:cairntrace.dev:wait:v1",
        notes:
          "A gate is one of tcp (host:port), http (url, method, status: code | 2xx | 200-299 | list, json: {dotted.path: value | {equals, in, contains, matches, exists, gt, gte, lt, lte}}, text, headers, auth: {basic | bearer} with ${env.X}/${secrets.X}), command (run, exitCode, stdout), gate (another name), all/any (lists), plus stable (N consecutive passing attempts), every (pause, default 1s) and timeout (budget, default 60s; 0 = none). String targets: a registry name, http(s)://… (2xx/3xx unless --status/--any-response) or tcp://host:port. Narration of each attempt goes to stderr (info level); stdout carries only the result {ok, gates[{name, ok, attempts, durationMs, budgetMs, lastDetail, timedOut?, cancelled?}], exitCode, error?, config?}. The same gates serve services.docker.ready, tmux readyOn.gate / after, webServer.ready and a spec's preconditions.wait (events gate.started / gate.attempt / gate.passed / gate.failed). MCP: cairn_wait {targets, config, env, status, anyResponse, timeoutMs, everyMs, stable}.",
      },
      {
        name: "verifier schema",
        summary:
          "Print a node script verifier's fixtures contract: read statically from defineVerifier({ fixtures: z.object(…) }) (the file is never executed), else the header comment / exported fixtures object / code reads",
        synopsis:
          "cairn verifier schema <file> [--load] [--timeout-ms <ms>] [--format json|yaml|md]",
        flags: [
          {
            name: "--load",
            type: "boolean",
            default: false,
            description:
              "Import the module in a Node child to read a contract the static reader reports as dynamic (runs its top-level code: trusted files only)",
          },
          {
            name: "--timeout-ms",
            type: "number",
            default: 10000,
            description: "Kill the --load child after this many ms",
          },
          {
            name: "--format",
            type: "enum",
            values: ["json", "yaml", "md"],
            default: "md",
            description: "Output format",
          },
        ],
        exitCodes: {
          "0": "contract reported (mode sdk | dynamic | legacy)",
          "2": "the file cannot be read, or --load failed",
        },
        outputSchema: "urn:cairntrace.dev:verifier-schema:v1",
        notes:
          "Keys, types, required, defaults, .describe() text, enum values and strictness of the SDK fixtures schema. cairn spec lint, spec finish and cairn catalog use the same contract: with an SDK schema an unknown or missing required fixture key is an error. See cairn docs scripts.",
      },
      ...fixturesCommandDocs(),
    ],
    steps: [
      {
        id: "open",
        kind: "navigation",
        summary:
          "Navigate to a URL or config-resolved path; the object form waits for a load state to beat SPA hydration races",
        yamlExample:
          "steps:\n  - open: /settings\n  - open: { path: /admin, waitUntil: networkidle, timeoutMs: 45000 }",
      },
      {
        id: "click",
        kind: "interaction",
        summary:
          "Activate a locator. Semantic locators match accessible names (whole-name, case-insensitive; `exact: true` for case-sensitive), scroll into view first, fail loudly on zero or ambiguous matches (`nth` picks among several). Agent-browser confirms same-tab link delivery by default without network-idle. Optional click.until retries at most four clicks until selectorGone|selector|text|notText|url holds. A positive sibling/spec settleMs or browser.postClickSettleMs opts into network-idle; click/spec values take precedence and 0 skips both the settle and link probe",
        yamlExample:
          "settleMs: 10000\nsteps:\n  - click: { by: role, role: button, name: Save, until: { selectorGone: '#editor', timeoutMs: 12000 } }\n  - click: { by: selector, selector: '.company-link', until: { url: { includes: '/connection/' }, timeoutMs: 60000 } }\n    settleMs: 0",
      },
      {
        id: "hover",
        kind: "interaction",
        summary: "Move the pointer over a locator to reveal hover-only UI",
        yamlExample:
          'steps:\n  - hover: { by: selector, selector: ".question-table-wrap .table-title" }',
      },
      {
        id: "focus",
        kind: "interaction",
        summary:
          "Focus a locator without clicking it; useful for custom comboboxes and controls that reveal options on focus",
        yamlExample:
          'steps:\n  - focus: { by: selector, selector: "[data-qa=country] input" }',
      },
      {
        id: "fill",
        kind: "interaction",
        summary:
          "Fill a locator with a string value, then re-read the live value after settling; retries three times when hydration wipes it. Set sibling verifyFill: false to opt out for transformed/masked controls",
        yamlExample:
          "steps:\n  - fill: { by: label, name: Email, value: user@example.com }\n  - fill: { by: label, name: Masked ID, value: '1234' }\n    verifyFill: false",
      },
      {
        id: "type",
        kind: "interaction",
        summary:
          "Type text into a locator character-by-character as real keyboard events (value, optional delayMs per keystroke), then re-read and retry when hydration wipes it (sibling verifyFill: false opts out). Use instead of fill when an SPA framework listens for keydown/input events that fill's bulk value-set doesn't fire",
        yamlExample:
          "steps:\n  - type: { by: label, name: Email, value: user@example.com }\n  - type: { by: label, name: Code, value: '1234', delayMs: 50 }",
      },
      {
        id: "select",
        kind: "interaction",
        summary:
          "Choose an option in a native <select> by option value or visible label (exactly one of value | label). Fires native input/change events; a non-matching choice fails listing the available options",
        yamlExample:
          "steps:\n  - select: { by: label, name: Plan, value: pro }\n  - select: { by: selector, selector: '#plan', label: Pro plan }",
      },
      {
        id: "upload",
        kind: "file",
        summary: "Set a file input from a local path",
        yamlExample:
          "steps:\n  - upload: { by: label, name: File, path: ./fixtures/sample.xlsx }",
      },
      {
        id: "download",
        kind: "file",
        summary: "Click a locator and capture the resulting download artifact",
        yamlExample:
          "steps:\n  - download: { by: role, role: button, name: Download template, saveAs: template.xlsx, assign: template }",
      },
      {
        id: "transform",
        kind: "file",
        summary: "Run a Node transform that writes a new named file artifact",
        yamlExample:
          "steps:\n  - transform: { runtime: node, file: ./transforms/make-invalid-template.ts, input: ${artifacts.template.path}, saveAs: invalid-template.xlsx, assign: invalidTemplate }",
      },
      {
        id: "request",
        kind: "network",
        summary:
          "Authenticated API call with browser-session cookies and a hard timeout; Playwright runs it out of page with browser-context cookie sharing and an isolated Bun bridge, while backends without native request support use a bounded page-fetch fallback; assign captures the response for ${requests.<name>.body.<field>} splicing into later steps",
        yamlExample:
          "steps:\n  - request: { method: POST, url: /api/qr-token, body: { memberId: 42 }, timeoutMs: 15000, expectStatus: 200, assign: qr }\n  - fill: { by: label, name: Scanner code, value: '${requests.qr.body.token}' }",
      },
      {
        id: "wait",
        kind: "wait",
        summary:
          "Wait for text, notText, selector, exact control value, load state, or URL (includes/equals/pattern); text is whitespace-normalized and case-insensitive unless caseSensitive is true",
        yamlExample:
          "steps:\n  - wait: { text: Saved, timeoutMs: 10000, caseSensitive: false }\n  - wait: { value: { by: label, name: Country, equals: United States }, timeoutMs: 40000 }\n  - wait: { url: { includes: /connection/ } }",
      },
      {
        id: "press",
        kind: "interaction",
        summary:
          "Keyboard key press (e.g. Enter to submit, Control+a). Optional target focuses a locator first so Vue @keyup.enter fires; optional until retries the key",
        yamlExample:
          'steps:\n  - press: Enter\n    target: { by: selector, selector: "#search" }\n    until: { selector: ".company-link", timeoutMs: 180000 }',
      },
      {
        id: "scroll",
        kind: "interaction",
        summary:
          "Scroll the page by direction/pixels, or bring a locator into view",
        yamlExample:
          "steps:\n  - scroll: { direction: down, px: 600 }\n  - scroll: { to: { by: role, role: button, name: Submit } }",
      },
      {
        id: "snapshot",
        kind: "artifact",
        summary: "Capture an accessibility snapshot for evidence or healing",
        yamlExample: "steps:\n  - snapshot: { interactive: true }",
      },
      {
        id: "use",
        kind: "interaction",
        summary:
          "Invoke an imported reusable action. Inside the action file, ${project.root} is the ACTION's directory; use ${config.dir} for paths anchored at the project config. An action may declare its own imports: (relative to the action file) and use: other actions — resolved against its own imports, then its importer's; call vars flow down; import/use cycles and duplicate action names are parse errors",
        yamlExample:
          "steps:\n  - use: login_admin\n  - use:\n      action: edit_and_save_text_field\n      vars:\n        textFieldValue: https://example.com",
      },
      {
        id: "batch",
        kind: "interaction",
        summary:
          "Run a chain of selector interactions in ONE backend invocation (agent-browser `batch --bail`), so transient UI state (a hover popover, focus) survives long enough to act on it. Sub-steps are selector-only (no semantic locators); clicks are paced, checkable state is verified with one recovery attempt, and the first failing sub-step fails the step",
        yamlExample:
          'steps:\n  - batch:\n      - hover: { by: selector, selector: "#row-actions" }\n      - click: { by: selector, selector: \'button[aria-label="Upload data"]\' }',
      },
      {
        id: "eval",
        kind: "escape-hatch",
        summary:
          "Run arbitrary JavaScript in the page context via backend.evaluate() and optionally capture the JSON-serializable return value as evals/<assign>.json; splice captured values into later steps via ${evals.<name>.value.<field>}. Opaque to heal, bypasses the semantic-locator contract — use for state setup and internal-state assertions that no UI affordance can reach",
        yamlExample:
          'steps:\n  - eval:\n      js: "window.__APP__.$store.state.profile.answers"\n      assign: answersBefore\n  - eval:\n      file: ./scripts/seed-state.js\n      assign: seeded\n      args: { flag: "stripped" }\n  - fill: { by: label, name: Token, value: "${evals.answersBefore.value.token}" }',
      },
      {
        id: "monitor",
        kind: "process",
        summary:
          "Capture a process profile (heap/cpu/goroutine/sample) or one-shot sample of the backend's browser process tree at a point in the flow, via the external `monitor` CLI. With assign, the result is written to monitor/<assign>.json and reusable via ${artifacts.<assign>.path}. Fails if no browser PID is available or monitor isn't installed. Requires action: profile|snapshot; profile requires type",
        yamlExample:
          "steps:\n  - open: /heavy-dashboard\n  - monitor: { action: profile, type: heap, assign: heapAfterLoad }\n  - monitor: { action: snapshot, label: after-scroll }",
      },
      {
        id: "run",
        kind: "process",
        summary:
          "Run a host shell command (/bin/sh -c; args become $1…$n) or a node script (resolved against the declaring file) as a step — fixtures, seeds, worker kills, cleanup — instead of an outcome with side effects. Gets CAIRN_ENV/CAIRN_BASE_URL/CAIRN_RUN_ID/CAIRN_RUN_DIR/CAIRN_RUN_TOKEN/CAIRN_CONFIG_DIR; its process tree is killed past timeoutMs (default 120000) or on cancel; a non-zero exit fails the step. With assign, the last stdout line must be JSON, spliced later as ${runs.<assign>.<path>}. The spec-level teardown: list (or {steps, failRun, timeoutMs}) runs after the outcomes on every exit path with CAIRN_RUN_STATUS (passed|failed|errored); its run steps also run on SIGINT/SIGTERM",
        yamlExample:
          "steps:\n  - run: { node: ./fixtures/provision.mjs, args: [--count, 3], timeoutMs: 60000, assign: fixture }\n  - open: /entities/${runs.fixture.entity.id}\nteardown:\n  - run: { shell: 'node ./fixtures/cleanup.mjs \"$1\"', args: ['${runs.fixture.entity.id}'] }",
      },
      {
        id: "expect",
        kind: "assertion",
        summary:
          "Assert mid-flow on a locator — visible | hidden | count (number or {equals|atLeast|atMost}) | text (string or {equals|contains|matches, caseSensitive}; normalized, case-insensitive) | value | attribute {name, equals|contains|matches|exists} | enabled — or on expect.request {method, url, status, json: {path: matcher}} sent with the browser session. Retries until timeoutMs (default 5000 × waitScale), writes expects/NNN_<id>.json, emits expect.passed|expect.failed, and fails the step on mismatch (no eval that throws). Semantic locators follow the authoring rules (whole accessible name, case-insensitive, visible-only); several matches need nth for text/value/attribute/enabled. Inside expect, visible/hidden are assertions; for by: text, text is the locator",
        yamlExample:
          "steps:\n  - expect: { id: saved_banner, by: role, role: status, visible: true, text: { contains: Saved } }\n  - expect: { by: selector, selector: '.worker-row', count: { atLeast: 1 } }\n  - expect: { by: label, name: Email, value: ops@example.test }\n  - expect: { request: { url: '/api/orders/${captures.order.id}', json: { status: shipped } } }",
      },
      {
        id: "capture",
        kind: "assertion",
        summary:
          "Store a structured value from the page as ${captures.<assign>…} for later steps and outcome verifiers (and captures/<assign>.json): exactly one of text (normalized text), value (live control value), attribute (locator + attributeName) or table ({headers, rows: [{<header>: <cell>}], cells, rowCount}). Waits up to timeoutMs (default 5000 × waitScale) for the target",
        yamlExample:
          "steps:\n  - capture: { assign: rowsBefore, table: { by: testid, testid: workers-table } }\n  - capture: { assign: companyName, text: { by: role, role: heading, name: Company } }\n  - capture: { assign: nextHref, attribute: { by: role, role: link, name: Next, attributeName: href } }\n  - fill: { by: label, name: Search, value: '${captures.companyName}' }",
      },
    ],
    verifiers: withPollParameter([
      {
        id: "text",
        kind: "ui",
        summary: "Text appears on the page",
        yamlExample:
          "verify:\n  text:\n    contains: dead\n    region: '[data-testid=\"objective-ticker\"]'",
        parameters: [
          {
            name: "equals",
            type: "string",
            description: "whole whitespace-normalized text",
            oneOfGroup: "matcher",
          },
          {
            name: "contains",
            type: "string",
            description: "whitespace-normalized substring",
            oneOfGroup: "matcher",
          },
          {
            name: "matches",
            type: "regex",
            description: "raw case-sensitive regex source",
            oneOfGroup: "matcher",
          },
          {
            name: "caseSensitive",
            type: "boolean",
            default: false,
            description:
              "equals/contains only; whitespace is always normalized",
          },
          {
            name: "region",
            type: "string",
            default: "page",
            description:
              "optional selector or 'page'; nested under text (legacy sibling region is still accepted)",
          },
        ],
      },
      {
        id: "notText",
        kind: "ui",
        summary: "Text does NOT appear on the page",
        yamlExample:
          'verify:\n  notText:\n    contains: "Something went wrong"\n    region: page',
        parameters: [
          {
            name: "equals",
            type: "string",
            description: "whole whitespace-normalized text",
            oneOfGroup: "matcher",
          },
          {
            name: "contains",
            type: "string",
            description: "whitespace-normalized substring",
            oneOfGroup: "matcher",
          },
          {
            name: "matches",
            type: "regex",
            description: "raw case-sensitive regex source",
            oneOfGroup: "matcher",
          },
          {
            name: "caseSensitive",
            type: "boolean",
            default: false,
            description:
              "equals/contains only; whitespace is always normalized",
          },
          {
            name: "region",
            type: "string",
            default: "page",
            description:
              "optional selector or 'page'; nested under notText (legacy sibling region is still accepted)",
          },
        ],
      },
      {
        id: "url",
        kind: "navigation",
        summary: "URL post-condition",
        yamlExample: 'verify:\n  url: { endsWith: "/invoices?imported=42" }',
        parameters: [
          { name: "equals", type: "string", oneOfGroup: "matcher" },
          { name: "startsWith", type: "string", oneOfGroup: "matcher" },
          { name: "endsWith", type: "string", oneOfGroup: "matcher" },
          { name: "matches", type: "regex", oneOfGroup: "matcher" },
        ],
      },
      {
        id: "network",
        kind: "network",
        summary: "At least one matching request happened",
        yamlExample:
          "verify:\n  network:\n    method: POST\n    urlContains: /api/invoices/import\n    status: { in: [200, 201] }",
        parameters: [
          {
            name: "method",
            type: "enum",
            values: [
              "GET",
              "POST",
              "PUT",
              "PATCH",
              "DELETE",
              "HEAD",
              "OPTIONS",
            ],
          },
          { name: "urlContains", type: "string" },
          {
            name: "status",
            type: "string",
            description:
              "{ equals | below | atLeast | in }; optional (absent: any status, pending included)",
          },
          {
            name: "body",
            type: "matcher",
            description:
              "{ json, match: subset (default) | exact } against the captured JSON request body; ${captures.x} refs resolved",
          },
          {
            name: "count",
            type: "matcher",
            description:
              "number or { equals | atLeast | atMost } over the matching requests (0 allowed); without it at least one must match",
          },
          {
            name: "assign",
            type: "string",
            description:
              "expose the last match to later outcomes as ${network.<assign>.at|firstAt|count|url|status|body}",
          },
        ],
      },
      {
        id: "noFailedRequests",
        kind: "network",
        summary: "No matching request failed (4xx/5xx)",
        yamlExample: "verify:\n  noFailedRequests:\n    urlContains: /api/",
        parameters: [
          { name: "urlContains", type: "string" },
          {
            name: "method",
            type: "enum",
            values: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          },
        ],
      },
      {
        id: "console",
        kind: "console",
        summary: "Bounded console errors",
        yamlExample: "verify:\n  console: { errorsMax: 0 }",
        parameters: [{ name: "errorsMax", type: "number" }],
      },
      {
        id: "count",
        kind: "ui",
        summary: "N elements match a role/selector in an optional region",
        yamlExample:
          "verify:\n  count:\n    role: row\n    in_region: 'table[name=\"Invoices\"]'\n    equals: 42",
        parameters: [
          { name: "role", type: "string" },
          { name: "selector", type: "string" },
          { name: "in_region", type: "string" },
          { name: "equals", type: "number", oneOfGroup: "matcher" },
          { name: "atLeast", type: "number", oneOfGroup: "matcher" },
          { name: "atMost", type: "number", oneOfGroup: "matcher" },
          { name: "between", type: "tuple", oneOfGroup: "matcher" },
        ],
      },
      {
        id: "file",
        kind: "file",
        summary:
          "Poll for a file on disk (file-based test doubles, e.g. local email captures), optionally requiring contained text",
        yamlExample:
          "verify:\n  file:\n    glob: ./mail-captures/*-welcome-*.json\n    contains: Your QR code\n    timeoutMs: 5000",
        parameters: [
          {
            name: "glob",
            type: "string",
            description:
              "Relative to the spec dir; * and ? in the filename only",
          },
          {
            name: "contains",
            type: "string",
            description: "Text the file must contain",
          },
          {
            name: "timeoutMs",
            type: "number",
            default: 10000,
            description: "Poll deadline",
          },
        ],
      },
      {
        id: "httpJson",
        kind: "network",
        summary:
          "Fetch app JSON in the browser session and assert a simple JSON path without a script verifier",
        yamlExample:
          'verify:\n  httpJson:\n    url: /api/test/state?gameId=${requests.game.body.gameId}\n    jsonPath: "$.roshan.alive"\n    equals: false',
        parameters: [
          {
            name: "url",
            type: "string",
            description:
              "URL to fetch; relative paths use config baseUrl or the current page origin",
          },
          {
            name: "jsonPath",
            type: "string",
            default: "$",
            description: "Simple dotted path, e.g. $.game.score",
          },
          { name: "equals", type: "string", oneOfGroup: "matcher" },
          { name: "contains", type: "string", oneOfGroup: "matcher" },
          { name: "matches", type: "regex", oneOfGroup: "matcher" },
          { name: "atLeast", type: "number", oneOfGroup: "matcher" },
          { name: "atMost", type: "number", oneOfGroup: "matcher" },
          { name: "exists", type: "boolean", oneOfGroup: "matcher" },
        ],
      },
      {
        id: "script",
        kind: "escape-hatch",
        summary:
          "Browser or Node JS returning { ok, evidence }; use run inline or file for external JS/TS",
        yamlExample:
          "verify:\n  script:\n    runtime: node\n    file: ./verifiers/check-template.ts\n    fixtures:\n      templatePath: ${artifacts.template.path}",
        parameters: [
          {
            name: "runtime",
            type: "enum",
            values: ["browser", "node"],
            default: "browser",
            description:
              "browser runs in page context; node runs in a Node process with fs/import access",
          },
          {
            name: "fixtures",
            type: "string",
            description: "fixture name → path (object)",
          },
          { name: "run", type: "string", description: "JS body" },
          {
            name: "file",
            type: "string",
            description:
              "Path to JS/TS verifier body, resolved relative to the spec file",
          },
        ],
      },
      {
        id: "xlsx",
        kind: "file",
        summary: "Inspect workbook text and Excel data validations",
        yamlExample:
          "verify:\n  xlsx:\n    path: ${artifacts.template.path}\n    sheets:\n      - name: Template Guide\n        contains: [Help Text, Allowed Values, Examples]\n    validations:\n      - sheet: RBA Academy Training\n        column: Email\n        type: textLength",
        parameters: [
          {
            name: "path",
            type: "string",
            description: "Workbook path; artifact placeholders are supported",
          },
          {
            name: "sheets",
            type: "array",
            description: "sheet name plus contains text checks",
          },
          {
            name: "validations",
            type: "array",
            description: "sheet, column header, and optional validation type",
          },
        ],
      },
      {
        id: "process",
        kind: "process",
        summary:
          "Assert on monitor-reported browser process metrics (peak/mean RSS+CPU, samples) collected by the --monitor run sampler. Reports skipped (not failed) when the run wasn't monitored. RSS matchers compare against megabytes; CPU against summed tree CPU percent",
        yamlExample:
          "verify:\n  process:\n    peakRss: { below: 500 }\n    meanCpu: { below: 90 }",
        parameters: [
          {
            name: "peakRss",
            type: "matcher",
            description: "peak tree RSS (MB): { below | atLeast | equals }",
          },
          {
            name: "meanRss",
            type: "matcher",
            description: "mean tree RSS (MB)",
          },
          {
            name: "finalRss",
            type: "matcher",
            description: "final tree RSS at the last sample (MB)",
          },
          {
            name: "peakCpu",
            type: "matcher",
            description: "peak summed tree CPU%",
          },
          {
            name: "meanCpu",
            type: "matcher",
            description: "mean summed tree CPU%",
          },
          {
            name: "samples",
            type: "matcher",
            description: "number of successful sample points",
          },
        ],
      },
      ...DATA_VERIFIER_DOCS,
    ]),
    rules: {
      coldStart: {
        summary: "Every spec must run from a clean browser session",
        satisfyVia: [
          "imports of a setup action",
          "session.resume: <checkpoint>",
          "preconditions.commands",
          "coldStart: guest for an intentionally public/sessionless flow",
        ],
        authoringGate:
          "Run `cairn spec finish <spec> --json` (lint + cold-start run + stamp when green; MCP cairn_spec_finish) — or `cairn run --cold-start --json` — before declaring a spec done",
      },
      contractImmutability: {
        summary: "intent and outcomes are immutable without human review",
        enforcedBy:
          "contractHash (sha256 of intent + outcomes) stamped at scaffold; heal refuses writes that would change it",
      },
      evidenceBudget: {
        maxLines: 80,
        maxListItems: 20,
        deepDataLocation: "outcomes/<id>.raw.json",
      },
      stepTimeouts: {
        summary:
          "Cairn enforces hard deadlines on backend invocations; request and Playwright wait steps default to 30000ms, Playwright's Bun request bridge plus wait/evaluate paths are parent-bounded, and real Chromium waits/evaluates use an external browser-kill watchdog so hung browser commands fail instead of wedging the run",
        defaultMs: 60_000,
        graceMs: 5_000,
      },
      blockedOutcomes: {
        summary:
          "Outcomes referencing ${artifacts.<name>.…} / ${requests.<name>.…} that a failed step never produced report status `skipped` with blocked evidence, not `failed`",
      },
    },
    config: {
      artifactRoot: join(homedir(), ".cairntrace", "runs"),
      workflowRoots: ["./flows"],
      defaultEnvironment: "local",
      defaultBackend: "agent-browser",
      report: {
        defaultTheme: "cairn",
        themes: ["cairn", "slate", "midnight", "contrast"],
        artifacts: ["report.html", "report.json"],
      },
      capture: {
        trace: {
          default: "on-failure",
          values: ["always", "on-failure", "never"],
          summary:
            "Playwright trace zip (screenshots + snapshots + sources); on-failure deletes the trace on passing runs",
        },
        video: {
          default: "never",
          values: ["always", "on-failure", "never"],
          summary:
            "Watchable .webm recording (Playwright only); opt in with always or on-failure for audit-grade recordings. Feed to vidtrace for timestamped evidence extraction.",
          slowMo:
            "Delay in ms between Playwright actions (0–5000) so fast clicks are visible in the recording",
          speed:
            "Playback speed multiplier (0.25–4.0); values < 1 slow the video via ffmpeg setpts post-processing",
        },
      },
    },
  };
}

const MATCHER_NOTE =
  "matcher: a scalar (= equals) or { equals | contains | matches | oneOf | atLeast | atMost | exists | empty | all/each, ignoreCase } — every present key must hold; paths are $-rooted (a.b, items[0], rows[*].name)";

/** Datasource / value / table verifiers (F4, F16). */
const DATA_VERIFIER_DOCS: VerifierDoc[] = [
  {
    id: "mongo",
    kind: "data",
    summary:
      "Query a config datasource of kind mongo (uri via the optional mongodb driver or mongosh; or docker exec into the compose service) and assert count/exists/fields of the first (sorted) document. Filters are extended JSON with ${captures|requests|evals|fixtures|network|runs}.… refs and ${run.startedAt}; values travel as data, never as JS. Evidence: outcomes/<id>.raw.json {kind, source, request, observed (≤20 docs, ≤4KB each), attempts, polledMs}; connection strings are never written",
    yamlExample:
      "verify:\n  mongo:\n    source: app\n    collection: tasks\n    filter: { title: '${vars.taskTitle}', updatedAt: { $gte: { $date: '${run.startedAt}' } } }\n    sort: { updatedAt: -1 }\n    expect: { count: { atLeast: 1 }, fields: { completed: true, deleted: false } }\n  poll: { timeoutMs: 45000, everyMs: 2000 }",
    parameters: [
      {
        name: "source",
        type: "string",
        description: "config datasources.<name> (kind: mongo)",
      },
      { name: "collection", type: "string" },
      {
        name: "database",
        type: "string",
        description:
          "override the datasource database (guard.databases still applies)",
      },
      {
        name: "filter",
        type: "string",
        description: "extended JSON object; a whole ${…} ref keeps its type",
      },
      {
        name: "projection",
        type: "string",
        description: "extended JSON object",
      },
      { name: "sort", type: "string", description: "{ field: 1 | -1 }" },
      {
        name: "limit",
        type: "number",
        default: 20,
        description: "documents fetched (max 100)",
      },
      { name: "queryTimeoutMs", type: "number", default: 15000 },
      {
        name: "assign",
        type: "string",
        description:
          "${captures.<assign>.count|docs.N.<field>} for later outcomes (plain view: ObjectIds as hex, dates as ISO)",
      },
      {
        name: "expect",
        type: "matcher",
        description: `{ count?, exists?, fields?: { path: matcher } }; default exists: true. ${MATCHER_NOTE}`,
      },
    ],
  },
  {
    id: "temporal",
    kind: "data",
    summary:
      "Inspect Temporal through a datasource of kind temporal (UI/HTTP API, basic or bearer auth, 5xx retried, 404 = absent): exactly one of workflowId (describe) or query (visibility query + count). activities/inputBytes read the full history (all pages, following continue-as-new). absent: { stableMs } must hold for that window",
    yamlExample:
      "verify:\n  temporal:\n    source: temporal\n    workflowId: 'order-${captures.order.id}'\n    expect:\n      status: COMPLETED\n      activities: { includeAll: [reserveStock, chargeCard], maxAttempts: 3 }\n      inputBytes: { atMost: 4096 }\n  poll: { timeoutMs: 120000, everyMs: 2000 }",
    parameters: [
      {
        name: "source",
        type: "string",
        description: "config datasources.<name> (kind: temporal)",
      },
      { name: "workflowId", type: "string", oneOfGroup: "target" },
      {
        name: "query",
        type: "string",
        description:
          "visibility query, e.g. WorkflowType='Sync' AND ExecutionStatus='Running'",
        oneOfGroup: "target",
      },
      {
        name: "runId",
        type: "string",
        description:
          "with workflowId: pin the run (history follows continue-as-new from it)",
      },
      { name: "requestTimeoutMs", type: "number", default: 15000 },
      {
        name: "assign",
        type: "string",
        description: "${captures.<assign>.status|runId|…}",
      },
      {
        name: "expect",
        type: "matcher",
        description:
          "{ status (string or list), count (query), activities: { includeAnyOf, includeAll, maxAttempts }, inputBytes: { atMost }, absent: true | { stableMs } }",
      },
    ],
  },
  {
    id: "http",
    kind: "data",
    summary:
      "Node-side HTTP call (no browser cookies) to a datasource of kind http (baseUrl + headers/auth) or a URL (relative to the environment baseUrl); asserts status (default 2xx) and JSON paths. Use httpJson / expect.request for calls that need the signed-in browser session",
    yamlExample:
      "verify:\n  http:\n    source: api\n    url: /ready\n    expect: { status: 200, json: { ready: true, workers: { atLeast: 1 } } }",
    parameters: [
      {
        name: "source",
        type: "string",
        description: "config datasources.<name> (kind: http); optional",
      },
      {
        name: "url",
        type: "string",
        description: "path under the datasource baseUrl, or a URL",
      },
      {
        name: "method",
        type: "enum",
        values: ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"],
        default: "GET",
      },
      {
        name: "headers",
        type: "string",
        description: "object; credential headers are redacted in evidence",
      },
      {
        name: "body",
        type: "string",
        description: "JSON body; ${…} refs resolved",
      },
      { name: "requestTimeoutMs", type: "number", default: 15000 },
      {
        name: "assign",
        type: "string",
        description: "${captures.<assign>.status|body.…}",
      },
      {
        name: "expect",
        type: "matcher",
        description: `{ status: number | { equals | below | atLeast | in }, json: { path: matcher } }. ${MATCHER_NOTE}`,
      },
    ],
  },
  {
    id: "value",
    kind: "data",
    summary:
      "Assert on a value the run already holds — actual: ${evals.x.value} | ${requests.y.body} | ${captures.z} | ${fixtures.a.b} | ${network.n.at} | ${runs.r} (a whole ref keeps its type; objects may embed refs) — or a JSON/text file; expect maps paths ($ = the value) to matchers. Replaces script verifiers that re-read evals/*.json or requests/*.json",
    yamlExample:
      "verify:\n  value:\n    actual: '${evals.finalState.value}'\n    expect: { blankRowCount: 0, 'rows[*].status': { each: { oneOf: [active, pending] } } }",
    parameters: [
      {
        name: "actual",
        type: "string",
        description: "runtime expression (or an object/array embedding refs)",
        oneOfGroup: "source",
      },
      {
        name: "file",
        type: "string",
        description:
          "JSON or text file; artifact placeholders allowed; relative to the spec dir",
        oneOfGroup: "source",
      },
      {
        name: "expect",
        type: "matcher",
        description: `{ path: matcher }. ${MATCHER_NOTE}`,
      },
    ],
  },
  {
    id: "table",
    kind: "ui",
    summary:
      "Read a rendered table (<table>, or role table/grid with row/cell roles) found by locator, waiting up to timeoutMs (default 5000) for it: rows {equals|atLeast|atMost, noBlank, ignoreCells}, contains (row text, or {header: cell text} — normalized, case-insensitive substring), headers {includes, inOrder}. Hidden rows are ignored",
    yamlExample:
      "verify:\n  table:\n    locator: { by: testid, testid: workers-table }\n    rows: { atLeast: 1, noBlank: true, ignoreCells: [Edit, Delete] }\n    contains: [{ Name: Ada, Country: Mexico }]\n    headers: { includes: [Name, Country], inOrder: true }",
    parameters: [
      {
        name: "locator",
        type: "string",
        description: "{ by: role|label|text|selector|testid, … }",
      },
      {
        name: "rows",
        type: "matcher",
        description: "{ equals | atLeast | atMost, noBlank, ignoreCells }",
      },
      {
        name: "contains",
        type: "array",
        description: "row text strings or { header: cell } objects",
      },
      {
        name: "headers",
        type: "matcher",
        description: "{ includes: [...], inOrder? }",
      },
      { name: "timeoutMs", type: "number", default: 5000 },
    ],
  },
];

/** Every verifier accepts `poll` next to its kind key (F5). */
function withPollParameter(docs: VerifierDoc[]): VerifierDoc[] {
  return docs.map((doc) => ({
    ...doc,
    parameters: [
      ...doc.parameters,
      {
        name: "poll",
        type: "matcher",
        description:
          "sibling of the kind key: { timeoutMs, everyMs (default 1000), stableMs (green must hold that long), failFastOnStepFailure (default true) } — re-evaluates until green; attempts/polledMs land in events and raw evidence",
      },
    ],
  }));
}

/** Markdown renderer for the explain doc. Exported for MCP reuse. */
export function explainToMarkdown(e: ExplainResult): string {
  const lines: string[] = [
    `# Cairntrace ${e.cairntrace.version}`,
    "",
    "## Commands",
    ...e.commands.map(
      (c) => `- **${c.name}** — ${c.summary}\n  \`${c.synopsis}\``,
    ),
    "",
    "## Verifier vocabulary (v0)",
    ...e.verifiers.map((v) => `- **${v.id}** *(${v.kind})* — ${v.summary}`),
    "",
    "## Step vocabulary",
    ...e.steps.map((s) => `- **${s.id}** *(${s.kind})* — ${s.summary}`),
    "",
    "## Rules",
    `- cold-start: ${e.rules.coldStart.summary}`,
    `- contract immutability: ${e.rules.contractImmutability.summary}`,
    `- evidence budget: ≤${e.rules.evidenceBudget.maxLines} lines, ≤${e.rules.evidenceBudget.maxListItems} list items`,
    ...(e.rules.stepTimeouts
      ? [`- step timeouts: ${e.rules.stepTimeouts.summary}`]
      : []),
    ...(e.rules.blockedOutcomes
      ? [`- blocked outcomes: ${e.rules.blockedOutcomes.summary}`]
      : []),
    "",
    "## Placeholders",
    `- ${PLACEHOLDER_NOTES}`,
    "",
    "## Config",
    `- artifactRoot: ${e.config.artifactRoot}`,
    `- defaultEnvironment: ${e.config.defaultEnvironment}`,
    `- defaultBackend: ${e.config.defaultBackend}`,
    ...(e.config.report
      ? [
          `- reports: ${e.config.report.artifacts.join(", ")} (default theme: ${e.config.report.defaultTheme})`,
        ]
      : []),
    ...(e.config.capture?.trace
      ? [
          `- trace capture: ${e.config.capture.trace.default} (${e.config.capture.trace.values.join(" | ")})`,
        ]
      : []),
    ...(e.config.capture?.video
      ? [
          `- video capture: ${e.config.capture.video.default} (${e.config.capture.video.values.join(" | ")}); slowMo: ${e.config.capture.video.slowMo ?? "n/a"}, speed: ${e.config.capture.video.speed ?? "n/a"}`,
        ]
      : []),
    "",
    "## Agent Docs",
    `- topics: ${DOC_TOPICS.join(", ")}`,
    "- use `cairn docs <topic> --json` or MCP `cairn_docs` for focused guidance",
  ];
  return lines.join("\n");
}

/* ----- cairn fixtures (F3b) ----- */

const FIXTURE_SCOPE_FLAGS: CommandFlag[] = [
  {
    name: "--config",
    type: "string",
    description:
      "Explicit cairntrace.config.yml whose fixtures: registry to use (default: discovered from the cwd)",
  },
  {
    name: "--env",
    type: "string",
    description:
      "Environment: its datasources, vars, scoped secrets and policy trait (default: config defaultEnvironment, else local)",
  },
];
const FIXTURE_FORMAT_FLAG: CommandFlag = {
  name: "--format",
  type: "enum",
  values: ["json", "yaml", "md"],
  default: "md",
  description: "Output format",
};
const FIXTURE_WITH_FLAG: CommandFlag = {
  name: "--with",
  type: "string",
  description:
    "Fixture parameter key=value (repeatable; JSON values are parsed); overrides the fixture's with: defaults",
};
const FIXTURE_WRITES_FLAG: CommandFlag = {
  name: "--allow-writes",
  type: "boolean",
  default: false,
  description:
    "Write on an environment whose policy trait is shared (otherwise the verb is dry-run there)",
};
const FIXTURE_EXIT_CODES = {
  "0": "ok (a dry-run included)",
  "1": "a verb failed (or a --verify / sweep teardown failed)",
  "2": "error: an unreadable config or an unexpected failure",
  "4": "invalid input: unknown fixture or env, an invalid config, a bad --with / --older-than, or no config found",
};
const FIXTURE_NOTES =
  "Config fixtures: <name>: {kind: exec | mongo | http, scope: run (default) | suite | seed, ensure, reset, verify, teardown, with, outputs, needs, owner: {exactlyOne, marker}, ttl, timeoutMs}. exec verbs are shell strings or {shell | node, args, cwd, env, timeoutMs} (last stdout line JSON = the result); mongo verbs are op lists (insertOne, insertMany, updateOne, updateMany, replaceOne, deleteOne, deleteMany, cloneDoc, findOne, count, each with expect {matched, modified, upserted, deleted, inserted, count, found, fields} and as) on a datasources: entry, or {script, args} run through mongosh with EJSON args; http verbs are {find: {path, items, where}, create, refind, requests} or a request list, against datasource or baseUrl (default the env's), with an optional login {path, body, token: JSONPath, header, scheme}. outputs map keys to a JSONPath into the verb result ($.id, $.item.id, $.<as>.upsertedId) or a template; {from, secret: true} keeps a value out of evidence. Every verb run is appended to ~/.cairntrace/fixtures/<project>.ledger.jsonl (status and sweep read it). Result urn:cairntrace.dev:fixtures:v1.";

function fixturesCommandDocs(): CommandDoc[] {
  return [
    {
      name: "fixtures list",
      summary:
        "List the config fixtures: registry (kind, scope, verbs, needs, outputs, owner, ttl)",
      synopsis:
        "cairn fixtures list [--config <path>] [--env <name>] [--format json|yaml|md]",
      flags: [...FIXTURE_SCOPE_FLAGS, FIXTURE_FORMAT_FLAG],
      exitCodes: FIXTURE_EXIT_CODES,
      outputSchema: "urn:cairntrace.dev:fixtures:v1",
      notes: `${FIXTURE_NOTES} MCP: cairn_fixtures_list {config, env}.`,
    },
    {
      name: "fixtures status",
      summary:
        "Ledger state of each fixture in the environment: live, expired, failed, torn-down or never",
      synopsis:
        "cairn fixtures status [name...] [--verify] [--config <path>] [--env <name>] [--format json|yaml|md]",
      flags: [
        ...FIXTURE_SCOPE_FLAGS,
        {
          name: "--verify",
          type: "boolean",
          default: false,
          description:
            "Run each recorded fixture's verify verb against its recorded outputs (exit 1 when one fails)",
        },
        FIXTURE_FORMAT_FLAG,
      ],
      exitCodes: FIXTURE_EXIT_CODES,
      outputSchema: "urn:cairntrace.dev:fixtures:v1",
      notes:
        "Rows {name, env, adapter, scope, state, ensuredAt, expiresAt, lastVerb, lastStatus, lastAt, lastError, origin (run | invocation | cli | sweep), runId, outputs (non-secret), verify}; ledger entries of fixtures the config no longer declares are listed with unknown: true. MCP: cairn_fixtures_status {config, env, names, verify}.",
    },
    ...(["ensure", "reset"] as const).map(
      (verb): CommandDoc => ({
        name: `fixtures ${verb}`,
        summary:
          verb === "ensure"
            ? "Ensure a fixture (its needs first) and record it in the ledger; nothing is torn down"
            : "Ensure a fixture's needs, then run its reset verb",
        synopsis: `cairn fixtures ${verb} <name> [--with key=value...] [--allow-writes] [--config <path>] [--env <name>] [--format json|yaml|md]`,
        flags: [
          ...FIXTURE_SCOPE_FLAGS,
          FIXTURE_WITH_FLAG,
          FIXTURE_WRITES_FLAG,
          FIXTURE_FORMAT_FLAG,
        ],
        exitCodes: FIXTURE_EXIT_CODES,
        outputSchema: "urn:cairntrace.dev:fixtures:v1",
        notes: `events: the fixture.* events of the verbs that ran (status ok | failed | skipped | dry-run); outputs: non-secret outputs by fixture. A seed or suite fixture with ttl is reused while its ledger record is fresh and its verify passes. MCP: cairn_fixtures_${verb} {config, env, name, with, allowWrites}.`,
      }),
    ),
    {
      name: "fixtures teardown",
      summary:
        "Tear a fixture down with the outputs and parameters its last ensure recorded",
      synopsis:
        "cairn fixtures teardown <name> [--with key=value...] [--allow-writes] [--config <path>] [--env <name>] [--format json|yaml|md]",
      flags: [
        ...FIXTURE_SCOPE_FLAGS,
        {
          ...FIXTURE_WITH_FLAG,
          description: "Override a recorded parameter key=value (repeatable)",
        },
        FIXTURE_WRITES_FLAG,
        FIXTURE_FORMAT_FLAG,
      ],
      exitCodes: FIXTURE_EXIT_CODES,
      outputSchema: "urn:cairntrace.dev:fixtures:v1",
      notes:
        "${fixtures.<name>.<key>} in the teardown verb reads the recorded outputs (secret outputs are not recorded). A fixture without a teardown verb is reported skipped. MCP: cairn_fixtures_teardown {config, env, name, with, allowWrites}.",
    },
    {
      name: "fixtures sweep",
      summary:
        "Find fixtures the ledger still shows live (a crash or a kill skipped their teardown) and tear them down with --apply",
      synopsis:
        "cairn fixtures sweep [--older-than <duration>] [--apply] [--include-seed] [--allow-writes] [--config <path>] [--env <name>] [--format json|yaml|md]",
      flags: [
        ...FIXTURE_SCOPE_FLAGS,
        {
          name: "--older-than",
          type: "string",
          description:
            "Only leftovers ensured at least this long ago: ms or 30m / 2h / 1d (default 1h); a fixture past its ttl always qualifies",
        },
        {
          name: "--apply",
          type: "boolean",
          default: false,
          description: "Tear the candidates down (default: report only)",
        },
        {
          name: "--include-seed",
          type: "boolean",
          default: false,
          description:
            "Seed-scoped fixtures too (default: only those past their ttl)",
        },
        {
          ...FIXTURE_WRITES_FLAG,
          description:
            "Write on an environment whose policy trait is shared (otherwise teardowns are dry-run there)",
        },
        FIXTURE_FORMAT_FLAG,
      ],
      exitCodes: FIXTURE_EXIT_CODES,
      outputSchema: "urn:cairntrace.dev:fixtures:v1",
      notes:
        "sweep.candidates[{name, env, scope, state (live | failed), ensuredAt, ageMs, action (teardown | skipped-owner-alive | skipped-no-teardown | skipped-unknown | skipped-young | skipped-seed), result, error}]; a fixture whose recording process is still running on this host is never swept. MCP: cairn_fixtures_sweep {config, env, olderThan, apply, includeSeed, allowWrites}.",
    },
  ];
}
