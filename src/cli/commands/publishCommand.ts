import { basename } from "node:path";
import { ArtifactWriter } from "../../core/artifacts/ArtifactWriter";
import { createArtifactRedactor } from "../../core/artifacts/redaction";
import { evidenceFailureReason } from "../../core/artifacts/retention";
import type { EvidenceCategory } from "../../core/schema/config.v1";
import type { EvidenceFailureReason } from "../../core/schema/events.v1";
import { PublishReceiptSchema } from "../../core/schema/stash.v1";
import { emit, resolveFormat } from "../format";
import { resolveArtifactRootContext, resolveRunRef } from "../runRefs";
import {
  DEFAULT_REMOTE_RETENTION_DAYS,
  publishRunDirectory,
  type RunIndexSkipReason,
} from "./publish";
import { parseIncludeFlag, pathFreeMessage } from "./stash";

/**
 * `cairn publish <run|latest>` — publish one run to the private file.cheap
 * artifact service (`fcheap publish`) through the evidence gate, with a
 * metadata-only RunIndexV1 sidecar, and record `publish-receipt.json` plus an
 * `artifact.publish` event in the run. Shared by MCP `cairn_publish`.
 */

export interface PublishRunOptions {
  artifactRoot?: string;
  config?: string;
  /** Remote retention, 1–31 days (default retention.publish.retentionDays, else 7). */
  retentionDays?: number;
  /** Evidence categories (default retention.publish.include, else [text, screenshots]). */
  include?: readonly EvidenceCategory[];
}

export interface PublishRunOutcome {
  runId: string;
  runDir: string;
  status: "published" | "error";
  artifactRef?: Record<string, unknown>;
  webUrl?: string;
  sha256?: string;
  sizeBytes?: number;
  publishedAt?: string;
  expiresAt?: string;
  retentionDays: number;
  /** Run-relative paths/dirs left out of the package. */
  excluded: string[];
  /** Whether a RunIndexV1 sidecar was sent. */
  runIndex?: boolean;
  /** Why it was not: unsupported | too-large | build-failed. */
  runIndexSkipped?: RunIndexSkipReason;
  /** `publish-receipt.json` when it was written. */
  receipt?: string;
  reason?: EvidenceFailureReason;
  error?: string;
}

export async function publishRunRef(
  runRef: string,
  opts: PublishRunOptions = {},
): Promise<PublishRunOutcome> {
  const context = await resolveArtifactRootContext({
    ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
    ...(opts.config ? { config: opts.config } : {}),
  });
  const runDir = await resolveRunRef(runRef, context.artifactRoot);
  const runId = basename(runDir);
  const publishConfig = context.loaded?.config.retention?.publish;
  const retentionDays =
    opts.retentionDays ??
    publishConfig?.retentionDays ??
    DEFAULT_REMOTE_RETENTION_DAYS;
  const include = opts.include ?? publishConfig?.include;
  const writer = new ArtifactWriter(runDir, createArtifactRedactor(undefined));
  try {
    const published = await publishRunDirectory(runDir, runId, {
      retentionDays,
      ...(include ? { include } : {}),
    });
    const receipt = PublishReceiptSchema.parse({
      version: 1,
      artifactRef: published.artifactRef,
      sha256: published.sha256,
      sizeBytes: published.sizeBytes,
      publishedAt: published.publishedAt,
      expiresAt: published.expiresAt,
      ...(published.webUrl ? { webUrl: published.webUrl } : {}),
      ...(published.excluded.length > 0
        ? { excluded: published.excluded }
        : {}),
      ...(published.runIndexSkipped
        ? { runIndexSkipped: published.runIndexSkipped }
        : {}),
    });
    await writer.writeJson("publish-receipt.json", receipt, "publish-receipt");
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.publish",
      status: "published",
      artifactRef: published.artifactRef,
      ...(published.webUrl ? { webUrl: published.webUrl } : {}),
      receipt: "publish-receipt.json",
      ...(published.excluded.length > 0
        ? { excluded: published.excluded }
        : {}),
    });
    await writer.writeManifest();
    return {
      runId,
      runDir,
      status: "published",
      artifactRef: published.artifactRef,
      ...(published.webUrl ? { webUrl: published.webUrl } : {}),
      sha256: published.sha256,
      sizeBytes: published.sizeBytes,
      publishedAt: published.publishedAt,
      expiresAt: published.expiresAt,
      retentionDays,
      excluded: published.excluded,
      runIndex: published.runIndex,
      ...(published.runIndexSkipped
        ? { runIndexSkipped: published.runIndexSkipped }
        : {}),
      receipt: "publish-receipt.json",
    };
  } catch (error) {
    const reason = evidenceFailureReason(error);
    const message = pathFreeMessage(
      error instanceof Error ? error.message : String(error),
    );
    await writer
      .appendEvent({
        ts: new Date().toISOString(),
        type: "artifact.publish",
        status: "error",
        reason,
        message,
      })
      .catch(() => undefined);
    return {
      runId,
      runDir,
      status: "error",
      retentionDays,
      excluded: [],
      reason,
      error: message,
    };
  }
}

export interface PublishCommandOptions {
  artifactRoot?: string;
  config?: string;
  retentionDays?: string;
  include?: string[];
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function publishCommand(
  runRef: string,
  opts: PublishCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let retentionDays: number | undefined;
  let include: EvidenceCategory[] | undefined;
  try {
    if (opts.retentionDays !== undefined) {
      retentionDays = Number(opts.retentionDays);
      if (
        !Number.isInteger(retentionDays) ||
        retentionDays < 1 ||
        retentionDays > 31
      ) {
        throw new Error(
          `--retention-days expects an integer between 1 and 31, got "${opts.retentionDays}"`,
        );
      }
    }
    include = parseIncludeFlag(opts.include);
  } catch (error) {
    process.stderr.write(`cairn publish: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  let outcome: PublishRunOutcome;
  try {
    outcome = await publishRunRef(runRef, {
      ...(opts.artifactRoot ? { artifactRoot: opts.artifactRoot } : {}),
      ...(opts.config ? { config: opts.config } : {}),
      ...(retentionDays !== undefined ? { retentionDays } : {}),
      ...(include ? { include } : {}),
    });
  } catch (error) {
    process.stderr.write(`cairn publish: ${(error as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(emit(format, outcome, () => publishMarkdown(outcome)));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  if (outcome.status !== "published") {
    process.stderr.write(
      `cairn publish: ${outcome.error ?? "publication failed"} (${outcome.reason ?? "unknown"})\n`,
    );
    process.exitCode = 2;
  }
}

function publishMarkdown(r: PublishRunOutcome): string {
  if (r.status !== "published") {
    return [
      `# Publish failed — ${r.runId}`,
      "",
      `- reason: ${r.reason ?? "unknown"}`,
      ...(r.error ? [`- error: ${r.error}`] : []),
      "- the local run was not changed",
    ].join("\n");
  }
  const uri =
    typeof r.artifactRef?.uri === "string" ? r.artifactRef.uri : undefined;
  return [
    `# Published ${r.runId}`,
    "",
    ...(uri ? [`- artifact: ${uri}`] : []),
    ...(r.webUrl ? [`- console: ${r.webUrl}`] : []),
    `- sha256: ${r.sha256}`,
    `- size: ${r.sizeBytes} bytes`,
    `- expires: ${r.expiresAt} (${r.retentionDays} days)`,
    `- run index: ${
      r.runIndex
        ? "sent"
        : `not sent${r.runIndexSkipped ? ` (${r.runIndexSkipped})` : ""}`
    }`,
    ...(r.excluded.length > 0 ? [`- excluded: ${r.excluded.join(", ")}`] : []),
    `- receipt: ${r.receipt}`,
  ].join("\n");
}
