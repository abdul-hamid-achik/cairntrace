import {
  healSpec,
  healVerify,
  type HealOutput,
  type HealVerifyResult,
} from "../../../core/healer/Healer";
import { ContractHashMismatchError } from "../../../core/parser/parseSpec";
import {
  resolveSpecRuntimeContext,
  UnknownEnvironmentError,
} from "../../../core/config/runtimeContext";
import type { BrowserConfig } from "../../../core/schema/config.v1";
import type { HealResult, PatchOp } from "../../../core/schema/heal.v1";
import { type BackendChoice, createBackend } from "../../backendFactory";
import { trackBackend } from "../../cleanup";
import { emit, resolveFormat } from "../../format";
import { log } from "../../logger";
import { makePlainListener, resolveProgressMode } from "../../progress";
import {
  type ProgressListener,
  SpecRefusedError,
} from "../../../core/runner/Runner";
import { getTuiStore, makeInkProgressListener, mountTui } from "../../ui";
import { TuiStore } from "../../ui/store";
import { backendOpts, parseVarFlags } from "../run";

export interface HealCommandOptions {
  apply?: boolean;
  verify?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  provider?: string;
  device?: string;
  headed?: boolean;
  /** Environment override, resolved exactly like `cairn run --env`. */
  env?: string;
  /** Explicit cairntrace.config.yml (overrides auto-discovery). */
  config?: string;
  /** Repeatable `--var key=value` overrides; win over config env vars. */
  var?: string[];
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

/** What heal needs from config before it builds a backend and runs. */
export interface HealRuntime {
  /** Forwarded to healSpec / healVerify (and from there to every run). */
  runtime: {
    environmentOverride?: string;
    configPath?: string;
    vars?: Record<string, string>;
  };
  /** Config `browser:` block — backend tuning + `testIdAttribute`. */
  browser?: BrowserConfig;
  /** Non-fatal resolution warnings (implicit environment not defined, …). */
  warnings: string[];
}

/**
 * Resolve `--env` / `--config` / `--var` for heal the same way `cairn run`
 * does: config discovery from the spec (or the explicit path), environment
 * selection, var overrides. Fails fast — before a browser starts — on a
 * malformed `--var` or an unknown explicit environment
 * ({@link UnknownEnvironmentError}, exit 4).
 */
export async function resolveHealRuntime(
  specPath: string,
  opts: Pick<HealCommandOptions, "env" | "config" | "var">,
): Promise<HealRuntime> {
  const vars = parseVarFlags(opts.var);
  const ctx = await resolveSpecRuntimeContext(specPath, {
    ...(opts.env !== undefined ? { envOverride: opts.env } : {}),
    ...(opts.config !== undefined ? { configPath: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  });
  return {
    runtime: {
      ...(opts.env !== undefined ? { environmentOverride: opts.env } : {}),
      ...(opts.config !== undefined ? { configPath: opts.config } : {}),
      ...(Object.keys(vars).length > 0 ? { vars } : {}),
    },
    ...(ctx.browser ? { browser: ctx.browser } : {}),
    warnings: ctx.warnings,
  };
}

/**
 * Exit code for an error thrown before or during a heal (CLI and MCP):
 * 6 contract changed, 4 unknown --env, 7 the environment policy refused the
 * spec (heal never runs it there), else 2.
 */
export function healErrorExitCode(err: Error): number {
  if (err instanceof ContractHashMismatchError) return 6;
  if (err instanceof UnknownEnvironmentError) return err.exitCode;
  if (err instanceof SpecRefusedError) return err.exitCode;
  return 2;
}

function writeHealError(err: Error, format: string, exitCode: number): void {
  if (format === "json") {
    process.stdout.write(
      JSON.stringify({
        $schema: "urn:cairntrace.dev:heal:v1",
        version: "1",
        status: "no-heal-possible",
        error: { name: err.name, message: err.message },
        exitCode,
      }),
    );
  } else {
    process.stderr.write(`cairn spec heal: ${err.message}\n`);
  }
}

export async function healCommand(
  specPath: string,
  opts: HealCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let resolved: HealRuntime;
  try {
    resolved = await resolveHealRuntime(specPath, opts);
  } catch (e) {
    const err = e as Error;
    const code = healErrorExitCode(err);
    writeHealError(err, format, code);
    process.exit(code);
    return;
  }
  for (const warning of resolved.warnings) log.warn(warning);

  // CLI flags win over config `browser.*`, exactly like `cairn run`.
  const backend = createBackend(backendOpts(opts, resolved.browser));
  const untrack = trackBackend(backend);

  // Heal re-runs the spec; narrate it with the same renderer `cairn run`
  // uses (auto/CAIRN_PROGRESS, stderr), instead of healing in silence.
  const progressMode =
    format === "md" ? resolveProgressMode(undefined) : undefined;
  let listener: ProgressListener | undefined;
  if (progressMode === "tty") {
    // Same Ink TUI as `cairn run`; the exit handler unmounts it.
    mountTui(new TuiStore());
    listener = makeInkProgressListener(getTuiStore()!);
  } else if (progressMode) {
    listener = makePlainListener();
  }

  let exitCode = 2;
  try {
    if (opts.verify) {
      const vr = await healVerify({
        specPath,
        backend,
        ...(listener ? { listener } : {}),
        ...resolved.runtime,
      });
      exitCode = vr.verified ? 0 : 5;
      if (format === "json" || format === "yaml") {
        process.stdout.write(emit(format, vr, () => ""));
      } else {
        process.stdout.write(renderVerifyMarkdown(vr));
      }
      if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    } else {
      const output = await healSpec({
        specPath,
        backend,
        ...(opts.apply ? { apply: opts.apply } : {}),
        ...(listener ? { listener } : {}),
        ...resolved.runtime,
      });

      exitCode = output.exitCode;

      if (format === "json" || format === "yaml") {
        const wire = toHealResult(output);
        process.stdout.write(emit(format, wire, () => ""));
      } else {
        process.stdout.write(renderMarkdown(output));
      }
      if (format !== "json" && format !== "yaml") process.stdout.write("\n");
    }
  } catch (e) {
    const err = e as Error;
    exitCode = healErrorExitCode(err);
    writeHealError(err, format, exitCode);
  } finally {
    untrack();
    await backend.close().catch(() => undefined);
  }

  process.exit(exitCode);
}

export function toHealResult(o: HealOutput): HealResult {
  const patch =
    o.ops.length > 0
      ? { format: "json-pointer-ops" as const, ops: o.ops }
      : undefined;
  return {
    $schema: "urn:cairntrace.dev:heal:v1",
    version: "1",
    spec: { path: o.specPath },
    basedOnRunId: o.basedOnRunId,
    status: o.status,
    outcomesStillReachable: o.outcomesStillReachable,
    ...(patch ? { patch } : {}),
    ...(o.appliedPath ? { appliedPath: o.appliedPath } : {}),
    exitCode: o.exitCode,
  };
}

function renderMarkdown(o: HealOutput): string {
  const banner =
    o.status === "patch-applied"
      ? "✓ patch applied"
      : o.status === "patch-proposed"
        ? "▸ patch proposed (re-run with --apply to write)"
        : "· no heal possible";

  const lines: string[] = [
    `# Heal: ${o.specPath}`,
    `Status: ${o.status}`,
    `Outcomes still reachable: ${o.outcomesStillReachable ? "yes" : "no"}`,
    `Based on run: ${o.basedOnRunId}`,
    "",
    banner,
    "",
    o.summary,
  ];

  if (o.ops.length > 0) {
    lines.push("", `## Proposed ops (${o.ops.length})`);
    for (const op of o.ops) {
      lines.push("", renderOp(op));
    }
  }

  if (o.appliedPath) {
    lines.push("", `Wrote to: ${o.appliedPath}`);
  }

  return lines.join("\n");
}

function renderOp(op: PatchOp): string {
  const head = `- **${op.op}** \`${op.path}\``;
  if (op.op === "replace") {
    return [
      head,
      `  - from: ${JSON.stringify((op as { from: unknown }).from)}`,
      `  - to:   ${JSON.stringify((op as { to: unknown }).to)}`,
      `  - why:  ${op.reason}`,
    ].join("\n");
  }
  if (op.op === "insert") {
    return [
      head,
      `  - value: ${JSON.stringify((op as { value: unknown }).value)}`,
      `  - why:  ${op.reason}`,
    ].join("\n");
  }
  return `${head}\n  - why: ${op.reason}`;
}

function renderVerifyMarkdown(vr: HealVerifyResult): string {
  const lines: string[] = [
    "# Cairntrace Verified Heal",
    "",
    "- spec: " + vr.specPath,
    "- before run: " + vr.beforeRun,
  ];
  if (vr.afterRun) lines.push("- after run: " + vr.afterRun);
  lines.push("- verified: " + (vr.verified ? "yes" : "no"));
  lines.push("- confidence: " + vr.confidence);
  if (vr.reason) lines.push("- reason: " + vr.reason);
  if (vr.evidence) lines.push("- evidence: " + vr.evidence);
  if (vr.replay) lines.push("- replay: " + vr.replay);
  lines.push("");
  for (const op of vr.ops) {
    lines.push("## " + op.op + " " + op.path);
    if (op.reason) lines.push("- " + op.reason);
    lines.push("");
  }
  return lines.join("\n") + "\n";
}
