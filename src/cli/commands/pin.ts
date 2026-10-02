import { readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { ArtifactWriter } from "../../core/artifacts/ArtifactWriter";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { RunPinSchema, type RunPin } from "../../core/schema/run.v1";
import { emit, resolveFormat } from "../format";
import { resolveArtifactRootContext, resolveRunRef } from "../runRefs";
import { stashRunDirectory, type RunStashResult } from "./stash";

/**
 * `cairn pin <run-ref>` / `cairn unpin <run-ref>` — keep a run's evidence.
 * Pinning stamps `pinned: {at, reason?}` on run.json (the manifest is
 * rebuilt so it stays truthful); retention never prunes a pinned run and it
 * takes no keepRuns/keepFailedRuns slot (`cairn clean --include-pinned`
 * overrides). `--stash` also saves it to file.cheap with the `keep` tag and
 * no TTL. Shared by MCP `cairn_pin`.
 */

export interface PinRunOptions {
  artifactRoot?: string;
  config?: string;
  reason?: string;
  /** Also stash the run (tag `keep`, no TTL) through the evidence gate. */
  stash?: boolean;
}

export interface PinRunOutcome {
  runId: string;
  runDir: string;
  /** The pin now on run.json, or false after unpin. */
  pinned: RunPin | false;
  /** Whether run.json changed (pinning an already-pinned run is a no-op). */
  changed: boolean;
  stash?: {
    ok: boolean;
    stashId?: string;
    status?: string;
    excluded?: string[];
    secretsFound?: number;
    reason?: string;
    error?: string;
  };
}

const MAX_REASON_CHARS = 500;

export async function pinRunRef(
  runRef: string,
  opts: PinRunOptions = {},
): Promise<PinRunOutcome> {
  const { runDir, stashConfig } = await resolvePinTarget(runRef, opts);
  const run = await readRunJson(runDir);
  const existing = RunPinSchema.safeParse(run.pinned);
  const reason = opts.reason?.trim().slice(0, MAX_REASON_CHARS);
  let pin: RunPin;
  let changed = false;
  if (existing.success && (!reason || existing.data.reason === reason)) {
    pin = existing.data;
  } else {
    pin = RunPinSchema.parse({
      at: existing.success ? existing.data.at : new Date().toISOString(),
      ...(reason ? { reason } : {}),
    });
    await rewriteRunJson(runDir, { ...run, pinned: pin });
    changed = true;
  }
  const outcome: PinRunOutcome = {
    runId: basename(runDir),
    runDir,
    pinned: pin,
    changed,
  };
  if (opts.stash) {
    const saved: RunStashResult = await stashRunDirectory(runDir, {
      action: "manual",
      tool: "cairntrace",
      tags: ["keep"],
      ...(stashConfig?.include ? { include: stashConfig.include } : {}),
      ...(stashConfig?.unsafeIncludeRawTraces
        ? { unsafeIncludeRawTraces: true }
        : {}),
      meta: stashConfig?.meta !== false,
    });
    outcome.stash = {
      ok: saved.ok,
      ...(saved.stashId ? { stashId: saved.stashId } : {}),
      ...(saved.status ? { status: saved.status } : {}),
      ...(saved.excluded.length > 0 ? { excluded: saved.excluded } : {}),
      ...(saved.secretsFound !== undefined
        ? { secretsFound: saved.secretsFound }
        : {}),
      ...(saved.reason && !saved.ok ? { reason: saved.reason } : {}),
      ...(saved.error && !saved.ok ? { error: saved.error } : {}),
    };
  }
  return outcome;
}

export async function unpinRunRef(
  runRef: string,
  opts: Pick<PinRunOptions, "artifactRoot" | "config"> = {},
): Promise<PinRunOutcome> {
  const { runDir } = await resolvePinTarget(runRef, opts);
  const run = await readRunJson(runDir);
  const changed = run.pinned !== undefined;
  if (changed) {
    const { pinned: _pinned, ...rest } = run;
    await rewriteRunJson(runDir, rest);
  }
  return { runId: basename(runDir), runDir, pinned: false, changed };
}

async function resolvePinTarget(
  runRef: string,
  opts: Pick<PinRunOptions, "artifactRoot" | "config">,
) {
  const context = await resolveArtifactRootContext({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });
  const runDir = await resolveRunRef(runRef, context.artifactRoot);
  return { runDir, stashConfig: context.loaded?.config.stash };
}

async function readRunJson(runDir: string): Promise<Record<string, unknown>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(join(runDir, "run.json"), "utf8"));
  } catch (error) {
    throw new Error(
      `cannot pin ${basename(runDir)}: run.json is missing or invalid (${(error as Error).message})`,
      { cause: error },
    );
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(
      `cannot pin ${basename(runDir)}: run.json is not an object`,
    );
  }
  return raw as Record<string, unknown>;
}

/** Rewrite run.json (redacted, same formatting) and rebuild the manifest. */
async function rewriteRunJson(
  runDir: string,
  run: Record<string, unknown>,
): Promise<void> {
  const writer = new ArtifactWriter(runDir, createArtifactRedactor(undefined));
  await writer.writeJson("run.json", run, "run");
  await writer.writeManifest();
}

export interface PinCommandOptions extends PinRunOptions {
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function pinCommand(
  runRef: string,
  opts: PinCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let outcome: PinRunOutcome;
  try {
    outcome = await pinRunRef(runRef, opts);
  } catch (error) {
    process.stderr.write(`cairn pin: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(emit(format, outcome, () => pinMarkdown(outcome)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  if (outcome.stash && !outcome.stash.ok) {
    process.stderr.write(
      `cairn pin: pinned, but the stash failed: ${outcome.stash.error ?? "unknown"}\n`,
    );
    process.exitCode = 2;
  }
}

export async function unpinCommand(
  runRef: string,
  opts: Omit<PinCommandOptions, "reason" | "stash">,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let outcome: PinRunOutcome;
  try {
    outcome = await unpinRunRef(runRef, opts);
  } catch (error) {
    process.stderr.write(`cairn unpin: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(emit(format, outcome, () => pinMarkdown(outcome)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

function pinMarkdown(r: PinRunOutcome): string {
  const lines = [
    r.pinned
      ? `# Pinned ${r.runId}`
      : `# ${r.changed ? "Unpinned" : "Not pinned"} ${r.runId}`,
    "",
    `- runDir: ${r.runDir}`,
  ];
  if (r.pinned) {
    lines.push(`- at: ${r.pinned.at}`);
    if (r.pinned.reason) lines.push(`- reason: ${r.pinned.reason}`);
    lines.push(
      "- retention: never pruned (cairn clean --include-pinned overrides)",
    );
  }
  if (r.stash) {
    lines.push(
      r.stash.ok
        ? `- stash: ${r.stash.stashId} (tag keep, no TTL)`
        : `- stash failed: ${r.stash.error ?? "unknown"}`,
    );
  }
  return lines.join("\n");
}
