import {
  healSpec,
  healVerify,
  type HealOutput,
  type HealVerifyResult,
} from "../../../core/healer/Healer";
import { ContractHashMismatchError } from "../../../core/parser/parseSpec";
import type { HealResult, PatchOp } from "../../../core/schema/heal.v1";
import { type BackendChoice, createBackend } from "../../backendFactory";
import { trackBackend } from "../../cleanup";
import { emit, resolveFormat } from "../../format";
import { log } from "../../logger";
import { makeProgressListener, resolveProgressMode } from "../../progress";

export interface HealCommandOptions {
  apply?: boolean;
  verify?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  provider?: string;
  device?: string;
  headed?: boolean;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function healCommand(
  specPath: string,
  opts: HealCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const backend = createBackend({
    ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.device !== undefined ? { device: opts.device } : {}),
  });
  const untrack = trackBackend(backend);

  // Heal re-runs the spec; narrate it with the same renderer `cairn run`
  // uses (auto/CAIRN_PROGRESS, stderr), instead of healing in silence.
  const progressMode =
    format === "md" ? resolveProgressMode(undefined) : undefined;
  const listener = progressMode
    ? makeProgressListener(progressMode, {
        color: log.color && process.env.TERM !== "dumb",
      })
    : undefined;

  let exitCode = 2;
  try {
    if (opts.verify) {
      const vr = await healVerify({
        specPath,
        backend,
        ...(listener ? { listener } : {}),
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
    exitCode = err instanceof ContractHashMismatchError ? 6 : 2;
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
