import { healSpec, type HealOutput } from "../../../core/healer/Healer";
import type { HealResult, PatchOp } from "../../../core/schema/heal.v1";
import { type BackendChoice, createBackend } from "../../backendFactory";
import { emit, resolveFormat } from "../../format";
import { isInteractive } from "../../progress";

export interface HealCommandOptions {
  apply?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
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
  });

  let exitCode = 2;
  try {
    if (format === "md" && isInteractive()) {
      process.stdout.write(`Healing ${specPath}…\n\n`);
    }

    const output = await healSpec({
      specPath,
      backend,
      ...(opts.apply ? { apply: opts.apply } : {}),
    });

    exitCode = output.exitCode;

    if (format === "json" || format === "yaml") {
      const wire = toHealResult(output);
      process.stdout.write(emit(format, wire, () => ""));
    } else {
      process.stdout.write(renderMarkdown(output));
    }
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  } catch (e) {
    const err = e as Error;
    if (format === "json") {
      process.stdout.write(
        JSON.stringify({
          $schema: "https://cairntrace.dev/schemas/heal.v1.json",
          version: "1",
          status: "no-heal-possible",
          error: { name: err.name, message: err.message },
          exitCode: 2,
        }),
      );
    } else {
      process.stderr.write(`cairn spec heal: ${err.message}\n`);
    }
  } finally {
    await backend.close().catch(() => undefined);
  }

  process.exit(exitCode);
}

function toHealResult(o: HealOutput): HealResult {
  const patch =
    o.ops.length > 0
      ? { format: "json-pointer-ops" as const, ops: o.ops }
      : undefined;
  return {
    $schema: "https://cairntrace.dev/schemas/heal.v1.json",
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
