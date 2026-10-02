import type { Command } from "commander";
import type { InvocationJournal } from "../../core/artifacts/invocationJournal";
import { renderRunMarkdown } from "../../core/artifacts/renderers/markdown";
import type { ServicesHandle } from "../../core/runner/services";
import type { WebServerHandle } from "../../core/runner/webServer";
import type { BrowserConfig } from "../../core/schema/config.v1";
import type { RunResult } from "../../core/schema/run.v1";
import type { BatchRunResult } from "../../core/schema/runBatch.v1";
import type { RunInvocationOptions } from "../../core/schema/runInvocation.v1";
import type { SelectionResult } from "../../core/schema/selection.v1";
import type { ExitCode } from "../../core/schema/shared";
import type { BackendChoice } from "../backendFactory";
import { trackAbortReporter } from "../cleanup";
import { emit, resolveFormat } from "../format";
import {
  startRunInvocation,
  type RunDocument,
  type RunDocumentMeta,
  type RunNarration,
} from "../invocation/executeRunInvocation";
import { formatMs } from "../invocation/hooks";
import { renderIterationSummary } from "../invocation/iterations";
import * as lifecycle from "../invocation/lifecycle";
import { parseHookTimeoutMs } from "../invocation/options";
import { summarizeStartingSpecs } from "../invocation/selection";
import {
  completionMark,
  makeJsonNarrationListener,
  makePlainListener,
  resolveProgressMode,
  type ProgressMode,
} from "../progress";
import {
  getTuiStore,
  isTuiMounted,
  makeInkProgressListener,
  makeInkServicesNarrator,
  mountTui,
  tuiFatal,
  tuiNote,
  unmountTui,
} from "../ui";
import { TuiStore } from "../ui/store";
import { log, reconfigureWithConfig, setNarrationDefault } from "../logger";
import type { ScopedSecrets } from "./secrets";
import { parseRepeat } from "./runMatrix";

/*
 * `cairn run` — the CLI adapter over the shared run engine
 * (src/cli/invocation/executeRunInvocation.ts). This file parses commander
 * flags into RunInvocationOptions (one function), owns the presentation
 * (Ink TUI / plain / NDJSON narration, stdout documents) and the process
 * (signal handlers, exit codes). Everything a run DOES lives in the engine,
 * which MCP `cairn_run` calls with the same options.
 */

// Kept importable from here for the commands and tests that always did.
export { parseVarFlags, parseHookTimeoutMs } from "../invocation/options";
export { runHookCommands, runAfterHooksForResult } from "../invocation/hooks";
export {
  mergeExitCodes,
  renderIterationSummary,
  withIterationEnv,
} from "../invocation/iterations";
export {
  collectSpecRedaction,
  preflightEnvironments,
} from "../invocation/lifecycle";
export {
  buildSelectionResult,
  expandSpecArgs,
  normalizeTagFilters,
  selectSpecsByBlastRadius,
  selectSpecsByTags,
  specMatchesTags,
  summarizeStartingSpecs,
} from "../invocation/selection";
export { synthesizeErroredResult } from "../invocation/results";
export { backendOpts } from "../invocation/options";

export interface RunCommandOptions {
  env?: string;
  coldStart?: boolean;
  headed?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  /** agent-browser provider (-p): ios, browserbase, kernel, etc. */
  provider?: string;
  /** iOS device name (--device), e.g. "iPhone 15 Pro" (provider: ios). */
  device?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
  /**
   * Narration renderer: auto (default) | tty | plain. `tty` is the cursor
   * renderer (spinner, redrawn lines); `plain` is sequential timestamped
   * milestones, safe to pipe/tee. `auto` picks by stdout TTY-ness.
   */
  progress?: string;
  artifactRoot?: string;
  config?: string;
  parallel?: string;
  /** Repeatable `--var key=value` overrides; win over config env vars. */
  var?: string[];
  /** Write a JUnit XML report to this file. */
  junit?: string;
  /** Stamp contract hashes only when the entire run invocation passes. */
  stampIfGreen?: boolean;
  /** Commander sets this to false when `--no-color` is passed. */
  color?: boolean;
  /** Commander sets this to false when `--no-web-server` is passed. */
  webServer?: boolean;
  /** Commander sets this to false when `--no-services` is passed. */
  services?: boolean;
  /** Preview the services lifecycle plan without executing. */
  servicesDryRun?: boolean;
  /** Run against the services a `cairn services up` lock owns. */
  reuseServices?: boolean;
  /** Auto-stash failed runs to fcheap. */
  stashOnFailure?: boolean;
  /** Stash every run to fcheap regardless of status. */
  stash?: boolean;
  /** Auto-annotate runs into codemap (on-run | never). */
  autoAnnotate?: string;
  /** Sample the browser process tree (CPU/RSS) during the run via the `monitor` CLI. */
  monitor?: boolean;
  /**
   * `--select-only` (FEATURES item 2): resolve which specs WOULD run for a
   * change and exit 0 without launching a browser. Emits a SelectionResult
   * v1 envelope. Pairs with `--since-codemap <ref>` for blast-radius scoping
   * and/or `--tag` for metadata.tags filtering; without either, lists all
   * expanded specs as selected.
   */
  selectOnly?: boolean;
  /**
   * `--since-codemap <ref>` (FEATURES item 1): run only the specs whose
   * `coversSymbol` code-match provenance intersects the blast radius of
   * `codemap review --since <ref>`. Degrades to "run all" when codemap is
   * absent (best-effort, never fails the run).
   */
  sinceCodemap?: string;
  /**
   * Repeatable `--tag <tag>`: keep only specs whose `metadata.tags` includes
   * every requested tag (AND, case-insensitive). Empty / absent = no filter.
   */
  tag?: string[];
  /**
   * Repeatable `--label key=value`: free-form cohort labels stamped into each
   * run.json (e.g. path=legacy, suite=checkout-ab). Consumed by `cairn stats`.
   */
  label?: string[];
  /**
   * Repeatable `--before <shell>`: run once after services/secrets, before the
   * first spec (e.g. flip a feature path, warm caches). Failures abort.
   */
  before?: string[];
  /**
   * Repeatable `--after <shell>`: run after EACH spec finishes (pass or fail),
   * while services are still up, with `CAIRN_RUN_DIR` pointing at that spec's
   * run directory so external collectors can drop files into
   * `$CAIRN_RUN_DIR/diagnostics/`. Failures are logged but do not change the
   * run exit code.
   */
  after?: string[];
  /** Per-command timeout shared by `--before` and `--after` hooks. */
  hookTimeoutMs?: string;
  /** `--repeat N`: run the whole spec set N times, labeling `repeat=<i>`. */
  repeat?: string;
  /**
   * `--matrix key=a,b[;key2=x,y]`: run the cartesian product, exporting each
   * combination as CAIRN_MATRIX_<KEY> env vars and `key=value` labels.
   */
  matrix?: string;
  /** With --repeat/--matrix: stop at the first iteration that fails. */
  stopOnFail?: boolean;
  /** Fail a batch (exit 7) when the environment policy refuses a spec. */
  strictRequires?: boolean;
  allowFixtureWrites?: boolean;
}

/** Scoped logger for the run command's lifecycle/errors. */
const runLog = log.scope("run");

/** Batch-row narration for structured formats under --log-format json. */
const progressLog = log.scope("progress");

function collectRepeatable(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/**
 * The `cairn run` commander definition (every flag + the format flags).
 * Every long flag except the presentation ones (--progress, --format and
 * its shorthands) is a RunInvocationOptions key; a parity test enforces it.
 */
export function configureRunCommand(command: Command): Command {
  return command
    .description("Run one or more behavioral specs")
    .option("--env <name>", "environment override")
    .option("--cold-start", "force fresh browser profile (default: on in CI)")
    .option(
      "--progress <mode>",
      "narration renderer: auto | tty | plain (auto = tty on a terminal, plain when piped)",
    )
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
      "print the services lifecycle plan and exit without running specs",
      false,
    )
    .option(
      "--reuse-services",
      "run against the services `cairn services up` owns for this config + env: quick readiness check (stale lock = exit 4), no start, no teardown, cold browser; without it a run refuses (exit 4) while that lock exists, and so does a run of another env of the config",
      false,
    )
    .option(
      "--stash-on-failure",
      "auto-stash failed run directories to fcheap (non-fatal if fcheap is missing)",
      false,
    )
    .option(
      "--stash",
      "stash every run to fcheap regardless of status (config stash.include/ttl apply; refused runs are never stashed)",
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
    .option(
      "--since-codemap <ref>",
      "run only specs whose coversSymbol intersects `codemap review --since <ref>` blast radius (degrades to run-all when codemap is absent)",
    )
    .option(
      "--tag <tag>",
      "run only specs whose metadata.tags includes this tag (repeatable = AND, case-insensitive)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--label <key=value>",
      "stamp free-form cohort labels onto each run.json (repeatable); used by `cairn stats --group-by` for A/B cohorts (e.g. path=legacy)",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--before <shell>",
      "run a shell command after services/secrets and before the first spec of each run (repeatable; e.g. tools/flip-path.sh next). Failures abort the run.",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--after <shell>",
      "run a shell command after EACH spec finishes (pass or fail), while services are still up (repeatable). $CAIRN_RUN_DIR points at the run directory; collectors may write $CAIRN_RUN_DIR/diagnostics/ (numeric top-level fields of diagnostics/report.json become `cairn stats --metric` values). Failures are logged, non-fatal.",
      collectRepeatable,
      [] as string[],
    )
    .option(
      "--repeat <n>",
      "run the spec set n times sequentially (distinct run dirs), stamping label repeat=<i>; --before hooks run per run",
    )
    .option(
      "--matrix <spec>",
      "run the cartesian product of key=a,b[;key2=x,y]: each combination exports CAIRN_MATRIX_<KEY> env vars and key=value labels (so `cairn stats --group-by key` works)",
    )
    .option(
      "--stop-on-fail",
      "with --repeat/--matrix: stop at the first run that does not pass",
      false,
    )
    .option(
      "--strict-requires",
      "fail a batch with exit 7 when the environment policy (requires.env / requires.mutates vs environments.<name>.policy) refuses any spec; without it refused specs are reported and skipped (a run where every spec was refused exits 7 either way)",
      false,
    )
    .option(
      "--allow-fixture-writes",
      "let fixture ensure/reset/teardown write on an environment whose policy trait is shared (otherwise they are dry-run there unless the spec's fixture reference says write: true)",
      false,
    )
    .option(
      "--hook-timeout-ms <ms>",
      "maximum duration of each --before/--after hook (default 600000; max 7200000)",
      "600000",
    )
    .option(
      "--select-only",
      "resolve which specs WOULD run and exit 0 without launching a browser (SelectionResult v1); pairs with --tag and/or --since-codemap",
      false,
    )
    .option("--format <format>", "output format: json | yaml | md", "md")
    .option("--json", "shorthand for --format json")
    .option("--yaml", "shorthand for --format yaml")
    .option("--md", "shorthand for --format md");
}

/** `{ key: value }` when the flag was given, else nothing. */
function defined<K extends keyof RunInvocationOptions>(
  key: K,
  value: RunInvocationOptions[K] | undefined,
): Partial<RunInvocationOptions> {
  return value === undefined
    ? {}
    : ({ [key]: value } as Partial<RunInvocationOptions>);
}

/**
 * THE mapping from commander flags to the engine's options. Throws (with the
 * flag's own message) on a malformed `--hook-timeout-ms` or `--repeat`.
 */
export function runInvocationOptionsFromCli(
  opts: RunCommandOptions,
): RunInvocationOptions {
  const hookTimeoutMs = parseHookTimeoutMs(opts.hookTimeoutMs);
  const repeat = parseRepeat(opts.repeat);
  return {
    ...defined("env", opts.env),
    ...defined("config", opts.config),
    ...defined("var", opts.var),
    ...defined("coldStart", opts.coldStart),
    ...defined("headed", opts.headed),
    ...defined("mock", opts.mock),
    ...defined("backend", opts.backend),
    ...defined("provider", opts.provider),
    ...defined("device", opts.device),
    // Commander hands `--parallel` over as a string; the engine floors it at 1.
    parallel: Number(opts.parallel ?? "1"),
    ...defined("artifactRoot", opts.artifactRoot),
    ...defined("junit", opts.junit),
    ...defined("stampIfGreen", opts.stampIfGreen),
    ...(opts.webServer === false ? { noWebServer: true } : {}),
    ...(opts.services === false ? { noServices: true } : {}),
    ...defined("servicesDryRun", opts.servicesDryRun),
    ...defined("reuseServices", opts.reuseServices),
    ...defined("stashOnFailure", opts.stashOnFailure),
    ...defined("stash", opts.stash),
    ...defined(
      "autoAnnotate",
      opts.autoAnnotate as RunInvocationOptions["autoAnnotate"],
    ),
    ...defined("monitor", opts.monitor),
    ...defined("sinceCodemap", opts.sinceCodemap),
    ...defined("selectOnly", opts.selectOnly),
    ...defined("tag", opts.tag),
    ...defined("label", opts.label),
    ...defined("before", opts.before),
    ...defined("after", opts.after),
    hookTimeoutMs,
    ...defined("repeat", repeat),
    ...defined("matrix", opts.matrix),
    ...defined("stopOnFail", opts.stopOnFail),
    ...defined("strictRequires", opts.strictRequires),
    ...defined("allowFixtureWrites", opts.allowFixtureWrites),
  };
}

/**
 * Narration mode for `cairn run`: only md format narrates (stdout stays the
 * structured document), and the mode is its own axis (`--progress`/env/TTY).
 * Resolved once at the top of the command so early narration (starting specs,
 * prepared secrets) speaks the same visual language as the rest of the run.
 */
function resolveRunProgressMode(
  opts: RunCommandOptions,
): ProgressMode | undefined {
  return resolveFormat(opts, "md") === "md"
    ? resolveProgressMode(opts.progress)
    : undefined;
}

/**
 * Structured formats (json/yaml) keep stdout for the document and skip the
 * human narration. With `--log-format json` they get the same milestones as
 * NDJSON entries on stderr (logger scope `progress`) instead of silence.
 */
function wantsJsonNarration(opts: RunCommandOptions): boolean {
  return resolveFormat(opts, "md") !== "md" && log.format === "json";
}

/** Info/warn narration: through the Ink tree when mounted, else the logger. */
function cliNote(kind: "info" | "warn", message: string): void {
  if (isTuiMounted()) tuiNote(kind, message);
  else if (kind === "warn") runLog.warn(message);
  else runLog.info(message);
}

/**
 * Fatal run error: through the tree (final frame) when mounted, else logger.
 * When the tree is mounted, give React a frame to paint the alert before
 * exiting — a synchronous process.exit would unmount before the render.
 */
function failRun(message: string, code: ExitCode = 2): void {
  if (isTuiMounted()) {
    tuiFatal(message);
    setTimeout(() => process.exit(code), 100);
  } else {
    runLog.error(message);
    process.exit(code);
  }
}

/** Spec label for batch narration: the basename minus .yml/.yaml. */
function specLabel(specPath: string): string {
  return (
    specPath
      .split("/")
      .pop()
      ?.replace(/\.ya?ml$/, "") ?? specPath
  );
}

/**
 * The CLI presentation: the Ink TUI (`--progress tty`), the byte-stable
 * plain listener (pipes/CI) or NDJSON narration (`--format json|yaml` +
 * `--log-format json`). The engine calls these hooks exactly where the run
 * command used to render.
 */
function makeCliNarration(
  progressMode: ProgressMode | undefined,
  jsonNarration: boolean,
): RunNarration {
  const interactive = progressMode === "tty";
  // Bold and colored marks only exist in the tty renderer; plain mode is a
  // designed sequential format, not tty with codes stripped.
  const bold = (s: string) => (interactive ? `\x1b[1m${s}\x1b[0m` : s);
  const narration: RunNarration = {
    note: cliNote,
    specListener(ctx) {
      if (ctx.mode === "single") {
        // Narration mode is an axis of its own (--progress auto|tty|plain):
        // tty is the cursor renderer, plain is timestamped sequential lines.
        // Structured formats skip human narration; with --log-format json
        // they narrate NDJSON on stderr.
        return progressMode
          ? interactive
            ? makeInkProgressListener(getTuiStore()!)
            : makePlainListener()
          : jsonNarration
            ? makeJsonNarrationListener()
            : undefined;
      }
      // With one worker there is no cursor contention, so a batch gets the
      // same live narration as a single run; parallel > 1 keeps completion
      // lines only (interleaved redraws would corrupt). JSON narration is
      // line-atomic and tagged with runId/specIndex.
      return progressMode && ctx.parallel === 1
        ? progressMode === "tty"
          ? makeInkProgressListener(getTuiStore()!)
          : makePlainListener()
        : jsonNarration
          ? makeJsonNarrationListener({
              batch: { index: ctx.idx + 1, total: ctx.total },
            })
          : undefined;
    },
    specsStart({ mode, total, parallel }) {
      if (progressMode) setNarrationDefault(true);
      if (mode !== "batch" || !progressMode) return;
      if (progressMode === "tty") {
        getTuiStore()?.push({ type: "specs-count", count: total });
        // The "starting N specs" note already announces the batch.
      } else {
        log.raw(
          `${bold("Running")} ${total} spec${
            total === 1 ? "" : "s"
          } (parallel: ${parallel})\n\n`,
        );
      }
    },
    specStart({ specPath, idx, total }) {
      if (progressMode) {
        const label = specLabel(specPath);
        if (progressMode === "tty") {
          getTuiStore()?.push({ type: "spec-start", idx, total, label });
        } else {
          log.raw(`${bold(`[${idx + 1}/${total}]`)} ${label} — starting…\n`);
        }
      } else if (jsonNarration) {
        progressLog.info("spec starting", {
          specIndex: idx + 1,
          specTotal: total,
          spec: specPath,
        });
      }
    },
    specFinish({ specPath, idx, total, result: r, error }) {
      if (r) {
        const passed = r.outcomes.filter((o) => o.status === "passed").length;
        if (progressMode === "tty") {
          getTuiStore()?.push({
            type: "spec-finish",
            idx,
            // A refused spec never ran: a skipped row with its reason.
            status:
              r.status === "passed"
                ? "passed"
                : r.status === "errored"
                  ? "errored"
                  : r.status === "refused"
                    ? "skipped"
                    : "failed",
            name: r.spec.name,
            durationMs: r.durationMs,
            passed,
            totalOutcomes: r.outcomes.length,
            error:
              r.status === "refused"
                ? `refused: ${r.refusal?.reason ?? r.failure?.message ?? "environment policy"}`
                : r.failure?.message,
          });
        } else if (progressMode) {
          log.raw(
            `  ${completionMark(r.status, interactive)} [${idx + 1}/${total}] ${r.spec.name} (${formatMs(r.durationMs)}, ${passed}/${r.outcomes.length} outcomes)\n`,
          );
        } else if (jsonNarration) {
          const fields = {
            specIndex: idx + 1,
            specTotal: total,
            spec: r.spec.name,
            runId: r.runId,
            status: r.status,
            durationMs: r.durationMs,
            outcomesPassed: passed,
            outcomesTotal: r.outcomes.length,
          };
          if (r.status === "passed") progressLog.info("spec finished", fields);
          else progressLog.warn("spec finished", fields);
        }
        return;
      }
      const message = error ?? "errored";
      if (progressMode === "tty") {
        getTuiStore()?.push({
          type: "spec-finish",
          idx,
          status: "errored",
          name: specLabel(specPath),
          durationMs: 0,
          passed: 0,
          totalOutcomes: 0,
          error: message,
        });
      } else if (progressMode) {
        log.raw(
          `  ${completionMark("errored", interactive)} [${idx + 1}/${total}] ${specPath}: ${message}\n`,
        );
      } else if (jsonNarration) {
        progressLog.warn("spec finished", {
          specIndex: idx + 1,
          specTotal: total,
          spec: specPath,
          status: "errored",
          error: message,
        });
      }
    },
    batchEnd(summary) {
      if (isTuiMounted()) {
        getTuiStore()?.push({ type: "batch-end", summary });
      }
    },
    singleErrored() {
      if (isTuiMounted()) {
        getTuiStore()?.push({
          type: "run-end",
          status: "errored",
          durationMs: 0,
        });
      }
    },
    // Interactive services narration: same axis as spec progress — only
    // under `--format md` + `--progress tty`. Every other mode keeps the
    // leveled logger narration (info milestones, debug detail, raw
    // streaming), which respects --quiet/--log-level/--log-format json.
    services() {
      const narrator =
        progressMode === "tty"
          ? makeInkServicesNarrator(getTuiStore()!)
          : undefined;
      if (progressMode) setNarrationDefault(true);
      return narrator;
    },
    // The dry-run plan prints raw to stderr; release the viewport first.
    servicesDryRunStarting() {
      if (isTuiMounted()) unmountTui();
    },
    servicesPlan(text) {
      process.stderr.write(text);
    },
    // Apply the config `logging` block as a project default (flags/env win).
    loggingConfig(config) {
      reconfigureWithConfig(config);
    },
    iterationsSummary(rows, planned) {
      if (log.format === "json") {
        // Keep stderr valid NDJSON under --log-format json.
        const passedIterations = rows.filter(
          (row) => row.exitCode === 0,
        ).length;
        progressLog.info("iterations summary", {
          executed: rows.length,
          planned,
          passed: passedIterations,
          failed: rows.length - passedIterations,
        });
      } else {
        process.stderr.write(`${renderIterationSummary(rows, planned)}\n`);
      }
    },
    abortedBatchSummary(outcome) {
      process.stderr.write(
        "path" in outcome
          ? `cairn: wrote aborted batch summary to ${outcome.path}\n`
          : `cairn: could not write aborted batch summary: ${outcome.error}\n`,
      );
    },
  };
  if (progressMode === "tty") {
    narration.postRun = (message, kind) => tuiNote(kind, message);
  }
  return narration;
}

/** Wait for a piped stdout buffer to drain without forcing process exit. */
async function writeStdoutFully(output: string): Promise<void> {
  if (process.stdout.write(output)) return;
  await new Promise<void>((resolveDrain, rejectDrain) => {
    const onDrain = (): void => {
      process.stdout.off("error", onError);
      resolveDrain();
    };
    const onError = (error: Error): void => {
      process.stdout.off("drain", onDrain);
      rejectDrain(error);
    };
    process.stdout.once("drain", onDrain);
    process.stdout.once("error", onError);
  });
}

function emitErroredResult(result: RunResult, format: string): void {
  // Errored runs go through the same synthesizeErroredResult path as
  // mid-run failures so consumers see a schema-valid RunResult either way.
  if (format === "json" || format === "yaml") {
    process.stdout.write(
      emit(format as "json" | "yaml", result, renderRunMarkdown),
    );
  } else {
    const failed = result.steps.find((s) => s.status === "failed");
    runLog.error(failed?.error ?? "run errored");
  }
}

/** Print one iteration's document exactly where `cairn run` always did. */
async function writeRunDocument(
  document: RunDocument,
  meta: RunDocumentMeta,
  opts: RunCommandOptions,
  interactive: boolean,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  if (meta.kind === "preflight") {
    // An invocation stopped before any spec: structured formats still get a
    // schema-valid errored document; md only gets the stderr error.
    if (format === "json" || format === "yaml") {
      await writeStdoutFully(emit(format, document, () => ""));
    }
    return;
  }
  if (meta.kind === "batch") {
    const output =
      format === "json" || format === "yaml"
        ? emit(format, document, () => "")
        : `${renderBatchMarkdown(document as BatchRunResult)}\n`;
    await writeStdoutFully(output);
    return;
  }
  const result = document as RunResult;
  if (meta.errored) {
    emitErroredResult(result, format);
    return;
  }
  if (!interactive) {
    process.stdout.write(emit(format, result, renderRunMarkdown));
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  }
}

/**
 * `cairn run <spec...> [--parallel N]`
 *
 * - Single spec, parallel=1 → rich interactive progress, RunResult output
 *   (back-compat with v0.0 — existing JSON consumers still get RunResult).
 * - Multiple specs OR parallel>1 → BatchRunResult, per-spec one-liners only.
 */
export async function runCommand(
  specs: string[],
  opts: RunCommandOptions,
): Promise<void> {
  const progressMode = resolveRunProgressMode(opts);
  const jsonNarration = wantsJsonNarration(opts);
  // --format json|yaml + --log-format json: narrate as NDJSON on stderr. The
  // narration floor (info) applies exactly like the md narration path, so
  // flags/env/config still win (--quiet keeps only warnings and failures).
  if (jsonNarration) setNarrationDefault(true);
  // First output, before ANY resolution work (config, secrets, services,
  // browser). A wedged environment (dead docker socket, thrashing swap,
  // locked secret agent) can stall the later phases for minutes with no
  // other output; this line makes such hangs localizable from the log
  // instead of presenting as a 0-byte mystery. Kept compact by default; the
  // full list is still one --verbose away. In tty narration the line
  // renders with the same flat mark as the services milestones.
  const startingLine = summarizeStartingSpecs(specs, process.cwd());
  if (progressMode === "tty") {
    // The Ink tree owns stderr from here on; every later narration line goes
    // through the store. The exit handler unmounts it on process.exit.
    mountTui(new TuiStore());
    tuiNote("info", startingLine);
  } else {
    runLog.info(startingLine);
  }
  runLog.debug(`starting: ${specs.join(", ")}`);

  let options: RunInvocationOptions;
  try {
    options = runInvocationOptionsFromCli(opts);
  } catch (e) {
    failRun((e as Error).message, 2);
    return;
  }

  const interactive = progressMode === "tty";
  const controller = new AbortController();
  const handle = startRunInvocation(
    {
      specs,
      options,
      cwd: process.cwd(),
      argv: process.argv.slice(2),
    },
    {
      origin: "cli",
      logger: log,
      narration: makeCliNarration(progressMode, jsonNarration),
      signal: controller.signal,
      onDocument: (document, meta) =>
        writeRunDocument(document, meta, opts, interactive),
    },
  );
  // SIGINT/SIGTERM: the engine's synchronous emergency hook marks the
  // journal aborted, captures signal-time service artifacts, writes the
  // aborted batch summary and kills browser daemons, the webServer and
  // services; cleanup.ts then exits 130/143.
  const untrackSignal = trackAbortReporter((signal) => {
    handle.terminateSync(signal);
    controller.abort();
  });
  let result: Awaited<typeof handle.result>;
  try {
    result = await handle.result;
  } finally {
    untrackSignal();
  }

  switch (result.kind) {
    case "selection": {
      const format = resolveFormat(opts, "md");
      await writeStdoutFully(
        `${emit(format, result.document as SelectionResult, renderSelectionMarkdown)}${
          format !== "json" && format !== "yaml" ? "\n" : ""
        }`,
      );
      process.exitCode = 0;
      return;
    }
    case "skipped":
    case "services-dry-run":
      process.exitCode = 0;
      return;
    case "errored":
      if (result.fatal) {
        failRun(result.error ?? "run errored", result.exitCode);
        return;
      }
      process.exitCode = result.exitCode;
      return;
    default:
      // The engine returns the stable wire exit code after lifecycle
      // teardown. Do not force process.exit here: stdout may still be
      // draining a large batch JSON/YAML document into a pipe.
      process.exitCode = result.exitCode;
  }
}

/* ----- lifecycle entry points kept for `cairn audit` (investigate.ts) ----- */

/**
 * Resolve an invocation-scoped TinyVault environment (see
 * lifecycle.maybeInjectTvaultSecrets) with the CLI's narration.
 */
export async function maybeInjectTvaultSecrets(
  firstSpec: string,
  opts: RunCommandOptions,
): Promise<ScopedSecrets> {
  return lifecycle.maybeInjectTvaultSecrets(firstSpec, opts, {
    warn: (m) => runLog.warn(m),
    info: (m) => cliNote("info", m),
  });
}

/**
 * Resolve config for the invocation and, if it declares a `webServer`, start
 * it once (see lifecycle.maybeStartWebServer).
 */
export async function maybeStartWebServer(
  firstSpec: string,
  opts: RunCommandOptions,
  onSpawn: (terminateSync: () => void) => void,
): Promise<WebServerHandle | undefined> {
  return lifecycle.maybeStartWebServer(
    firstSpec,
    { ...opts, ...(opts.webServer === false ? { noWebServer: true } : {}) },
    onSpawn,
    {
      onLoggingConfig: reconfigureWithConfig,
      // Lifecycle narration always routes through the logger (leveled,
      // stderr); on non-interactive/json paths the default warn level
      // suppresses info.
      log: (m: string) => log.scope("web-server").info(m),
    },
  );
}

/** The config `browser:` block for the invocation (first spec). */
export async function resolveBrowserConfig(
  firstSpec: string,
  opts: RunCommandOptions,
): Promise<BrowserConfig | undefined> {
  return lifecycle.resolveBrowserConfig(firstSpec, opts);
}

/**
 * Resolve config for the invocation and, if it declares a `services` block,
 * start the environment (docker/seed/tmux) once, with the CLI narration.
 */
export async function maybeStartServices(
  firstSpec: string,
  opts: RunCommandOptions,
  scopedSecrets: ScopedSecrets,
  onSpawn: (terminateSync: () => void) => void,
  journal?: InvocationJournal,
  /** allowServicesBoot false: refuse to start services (MCP without --allow-services). */
  gate: { allowServicesBoot?: boolean } = {},
): Promise<ServicesHandle | undefined> {
  return lifecycle.maybeStartServices(
    firstSpec,
    { ...opts, ...(opts.services === false ? { noServices: true } : {}) },
    scopedSecrets,
    onSpawn,
    {
      ...(journal ? { journal } : {}),
      ...(gate.allowServicesBoot !== undefined
        ? { allowServicesBoot: gate.allowServicesBoot }
        : {}),
      narration: () =>
        makeCliNarration(resolveRunProgressMode(opts), false).services?.(),
      onDryRunPlan: (text) => process.stderr.write(text),
      log: (m) => log.scope("services").info(m),
      logDetail: (m) => log.scope("services").debug(m),
      onOutput: (c) => log.raw(c),
    },
  );
}

/* ----- rendering ----- */

function renderSelectionMarkdown(s: SelectionResult): string {
  const filterBits: string[] = [];
  if (s.tags && s.tags.length > 0) {
    filterBits.push(`--tag ${s.tags.join(" --tag ")}`);
  }
  if (s.since) filterBits.push(`--since-codemap ${s.since}`);
  const lines: string[] = [
    "",
    `\x1b[1mSelection\x1b[0m ${s.selected.length} selected, ${s.skipped.length} skipped` +
      (filterBits.length > 0 ? `  (${filterBits.join(", ")})` : ""),
  ];
  if (s.selected.length > 0) {
    lines.push("", "Selected:");
    for (const x of s.selected) {
      const extras: string[] = [];
      if (x.coversSymbol) extras.push(x.coversSymbol);
      if (x.tags && x.tags.length > 0)
        extras.push(`tags: ${x.tags.join(", ")}`);
      lines.push(
        `  \x1b[32m✓\x1b[0m ${x.name}${
          extras.length > 0 ? `  (${extras.join(" · ")})` : ""
        }`,
      );
    }
  }
  if (s.skipped.length > 0) {
    lines.push("", "Skipped:");
    for (const x of s.skipped) {
      lines.push(`  \x1b[33m·\x1b[0m ${x.name}  — ${x.reason}`);
    }
  }
  if (!s.codemapAvailable && s.since) {
    lines.push(
      "",
      "\x1b[2m(codemap unavailable — selection degraded to run-all on remaining specs)\x1b[0m",
    );
  }
  return lines.join("\n");
}

function renderBatchMarkdown(b: BatchRunResult): string {
  const bannerColor =
    b.exitCode === 0 ? "\x1b[32m" : b.exitCode === 1 ? "\x1b[31m" : "\x1b[33m";
  const refusedCount = b.summary.refused ?? 0;
  const lines: string[] = [
    "",
    `${bannerColor}\x1b[1m${b.summary.passed}/${b.summary.total} passed\x1b[0m  ${b.summary.failed} failed  ${b.summary.errored} errored${
      refusedCount > 0 ? `  ${refusedCount} refused` : ""
    }  in ${formatMs(b.totalDurationMs)}`,
    "",
  ];
  const failed = b.results.filter(
    (r) => r.status !== "passed" && r.status !== "refused",
  );
  if (failed.length > 0) {
    lines.push("Failing specs:");
    for (const r of failed) {
      const headline = r.failure?.message
        ? ` — ${truncate(r.failure.message, 140)}`
        : "";
      // A synthetic result (errored before its run started) has no run dir.
      lines.push(
        r.synthetic
          ? `  - ${r.spec.name} (no run directory)${headline}`
          : `  - ${r.spec.name} → ${r.runDir}/${r.artifacts.agentContext}${headline}`,
      );
    }
  }
  // A refused spec never ran: no run directory to point at, only the reason.
  const refused = b.results.filter((r) => r.status === "refused");
  if (refused.length > 0) {
    lines.push("Refused by the environment policy:");
    for (const r of refused) {
      lines.push(
        `  - ${r.spec.name} (${r.refusal?.env ?? r.environment}) — ${truncate(
          r.refusal?.reason ?? r.failure?.message ?? "refused",
          140,
        )}`,
      );
    }
  }
  return lines.join("\n");
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}
