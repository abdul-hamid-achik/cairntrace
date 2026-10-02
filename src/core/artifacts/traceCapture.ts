import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { ArtifactRedactor, ArtifactWriter } from "./ArtifactWriter";
import { sanitizeTraceFile, type TraceFormat } from "./traceSanitizer";

function nowIso(): string {
  return new Date().toISOString();
}

/** Default `artifacts.capture.traceMaxBytes`: 50 MiB. */
export const DEFAULT_TRACE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Run-relative trace path and format for a backend. agent-browser's
 * `trace stop` writes Chrome trace-event JSON (open it in Perfetto or
 * chrome://tracing), so it is no longer named `.zip`; Playwright writes a
 * Trace Viewer zip. Readers still accept the legacy
 * `traces/agent-browser-trace.zip` name.
 */
export function tracePathForBackend(backend: string): {
  path: string;
  format: TraceFormat;
} {
  return backend === "agent-browser"
    ? { path: `traces/${backend}-trace.json`, format: "chrome-trace-json" }
    : { path: `traces/${backend}-trace.zip`, format: "playwright-zip" };
}

/**
 * Validate a trace the backend just stopped: a stop failure, an empty file
 * or a file over `maxBytes` is removed and reported as an `artifact.trace`
 * event (never a run failure). Returns the kept run-relative path.
 */
export async function checkStoppedTrace(input: {
  writer: ArtifactWriter;
  relativePath: string;
  format: TraceFormat;
  /** undefined when stopTrace threw. */
  stopped: { ok: boolean } | undefined;
  maxBytes: number;
}): Promise<string | undefined> {
  const { writer, relativePath, format, maxBytes } = input;
  const discard = async (): Promise<void> => {
    await writer.remove(relativePath).catch(() => undefined);
  };
  if (!input.stopped?.ok) {
    await discard();
    await writer.appendEvent({
      ts: nowIso(),
      type: "artifact.trace",
      action: "error",
      path: relativePath,
      format,
      reason: "stop-failed",
      warning: "the backend could not stop/save the trace; no trace was kept",
    });
    return undefined;
  }
  const bytes = await stat(join(writer.runDir, relativePath)).then(
    (info) => (info.isFile() ? info.size : 0),
    () => 0,
  );
  if (bytes === 0) {
    await discard();
    await writer.appendEvent({
      ts: nowIso(),
      type: "artifact.trace",
      action: "error",
      path: relativePath,
      format,
      reason: "empty",
      warning: "the backend wrote an empty trace; no trace was kept",
    });
    return undefined;
  }
  if (bytes > maxBytes) {
    await discard();
    await writer.appendEvent({
      ts: nowIso(),
      type: "artifact.trace",
      action: "dropped",
      path: relativePath,
      format,
      reason: "too-large",
      bytes,
      maxBytes,
      warning: `trace was ${bytes} bytes, over artifacts.capture.traceMaxBytes (${maxBytes}); it was dropped`,
    });
    return undefined;
  }
  return relativePath;
}

/**
 * Sanitize a kept trace in place and record its manifest sensitivity:
 * `sanitized` when every member was rewritten (best effort: stashable when
 * `traces` is included, never published), `secret-bearing` when the
 * sanitizer failed (the raw trace stays local unless
 * `stash.unsafeIncludeRawTraces`).
 */
export async function sanitizeKeptTrace(input: {
  writer: ArtifactWriter;
  relativePath: string;
  format: TraceFormat;
  redactor: ArtifactRedactor;
  sensitiveNames?: readonly string[];
}): Promise<void> {
  const { writer, relativePath } = input;
  const result = await sanitizeTraceFile(join(writer.runDir, relativePath), {
    redactor: input.redactor,
    ...(input.sensitiveNames ? { sensitiveNames: input.sensitiveNames } : {}),
  });
  if (result.ok) {
    writer.markSensitivity(relativePath, "sanitized");
    await writer.appendEvent({
      ts: new Date().toISOString(),
      type: "artifact.trace",
      action: "saved",
      path: relativePath,
      format: result.format,
      bytes: result.bytes,
      sensitivity: "sanitized",
    });
    return;
  }
  writer.markSensitivity(relativePath, "secret-bearing");
  await writer.appendEvent({
    ts: new Date().toISOString(),
    type: "artifact.trace",
    action: "saved",
    path: relativePath,
    format: input.format,
    reason: "sanitize-failed",
    sensitivity: "secret-bearing",
    warning: `trace could not be sanitized (${result.error}); it is kept locally as secret-bearing and is never published`,
  });
}
