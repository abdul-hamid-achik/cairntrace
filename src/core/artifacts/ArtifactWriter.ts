import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  dirname,
  isAbsolute,
  relative as relativePath,
  resolve as resolvePath,
  win32,
} from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReportConfig } from "../schema/config.v1";
import {
  ArtifactManifestSchema,
  type ArtifactManifest,
  type ArtifactManifestEntry,
  type ArtifactSensitivity,
  type RunResult,
} from "../schema/run.v1";
import {
  inferArtifactSensitivity,
  inferUnredactedSensitivity,
} from "./evidenceSelection";
import { isServicesEventType, type RunEvent } from "../schema/events.v1";
import type { ReplayManifest } from "../schema/replay.v1";
import type { Spec } from "../schema/spec.v1";
import { renderAgentContext } from "./agentContext";
import { renderEvidenceMarkdown, type EvidenceInput } from "./evidence";
import { renderJson } from "./renderers/json";
import { renderRunMarkdown } from "./renderers/markdown";
import {
  buildReportModel,
  renderReportHtml,
  renderReportJson,
} from "./renderers/report";
import { renderYaml } from "./renderers/yaml";

const ARTIFACT_DIRECTORY_MODE = 0o700;
const ARTIFACT_FILE_MODE = 0o600;

export interface ArtifactRedactor {
  value<T>(input: T): T;
  text(input: string): string;
}

export interface ArtifactWriterOptions {
  report?: ReportConfig;
}

const IDENTITY_REDACTOR: ArtifactRedactor = {
  value: <T>(input: T) => input,
  text: (input: string) => input,
};

/**
 * Writes artifacts to the per-run directory.
 *
 * Path convention:
 *   runDir/                            (absolute; created lazily)
 *   ├── run.json | run.yaml | run.md
 *   ├── report.html | report.json
 *   ├── events.ndjson
 *   ├── run.log                        (plain narration, always written)
 *   ├── logs/                          (live precondition / verifier logs)
 *   ├── agent_context.md
 *   ├── screenshots/                   (created on first capture)
 *   ├── snapshots/
 *   ├── videos/                        (when video capture is enabled)
 *   └── outcomes/
 *       ├── results.json | .yaml | .md
 *       ├── <outcomeId>.md
 *       └── <outcomeId>.raw.json       (when a verifier emits raw data)
 */
export class ArtifactWriter {
  public readonly runDir: string;

  private readonly artifactKinds = new Map<string, string>();
  /** Explicit manifest sensitivities (redacted writes, sanitized traces). */
  private readonly artifactSensitivity = new Map<string, ArtifactSensitivity>();
  private readonly pendingWrites = new Set<Promise<unknown>>();
  private eventTail: Promise<void> = Promise.resolve();
  private eventLogPermissionsSealed = false;

  constructor(
    runDir: string,
    private readonly redactor: ArtifactRedactor = IDENTITY_REDACTOR,
    private readonly opts: ArtifactWriterOptions = {},
  ) {
    this.runDir = resolvePath(runDir);
  }

  async ensureDirs(): Promise<void> {
    await mkdir(this.runDir, {
      recursive: true,
      mode: ARTIFACT_DIRECTORY_MODE,
    });
    await tightenMode(this.runDir, ARTIFACT_DIRECTORY_MODE);
    await Promise.all(
      [
        "screenshots",
        "snapshots",
        "videos",
        "videos/clips",
        "downloads",
        "transforms",
        "evals",
        "diagnostics",
        "outcomes",
      ].map((directory) => this.ensureDir(directory)),
    );
  }

  /**
   * Resolve a run-relative artifact path without allowing an absolute path or
   * traversal outside runDir. Both POSIX and Windows path syntax are rejected
   * so callers cannot bypass confinement with a path intended for another OS.
   */
  resolve(relative: string): string {
    const portable = relative.replaceAll("\\", "/");
    const segments = portable.split("/");
    if (
      portable.length === 0 ||
      portable.includes("\0") ||
      isAbsolute(relative) ||
      win32.isAbsolute(relative) ||
      segments.includes("..")
    ) {
      throw new Error(`artifact path must stay within runDir: ${relative}`);
    }

    const target = resolvePath(this.runDir, ...segments);
    const fromRunDir = relativePath(this.runDir, target);
    if (
      fromRunDir === "" ||
      fromRunDir === ".." ||
      fromRunDir.startsWith(`..${win32.sep}`) ||
      isAbsolute(fromRunDir)
    ) {
      throw new Error(`artifact path must stay within runDir: ${relative}`);
    }
    return target;
  }

  /** Ensure a confined artifact directory exists. */
  async ensureDir(relative: string): Promise<string> {
    const absolute = this.resolve(relative);
    await mkdir(absolute, {
      recursive: true,
      mode: ARTIFACT_DIRECTORY_MODE,
    });
    await tightenMode(absolute, ARTIFACT_DIRECTORY_MODE);
    return absolute;
  }

  /**
   * Prepare a destination for a producer that must write the bytes itself
   * (browser screenshots, downloads, traces, videos, or transforms).
   */
  async preparePath(
    relative: string,
    kind = inferArtifactKind(relative),
  ): Promise<string> {
    const absolute = this.resolve(relative);
    await ensurePrivateDirectory(dirname(absolute));
    this.artifactKinds.set(toPortablePath(relative), kind);
    this.markUnredacted(relative);
    return absolute;
  }

  /**
   * Register a producer-owned file so its semantic kind appears in the
   * manifest. The writer never saw its bytes, so it is not `redacted`
   * unless the caller says so; LiveLog-backed logs (`run-log` / `log`) are
   * redacted line by line before they reach disk.
   */
  registerExisting(
    relative: string,
    kind = inferArtifactKind(relative),
    sensitivity?: ArtifactSensitivity,
  ): string {
    const absolute = this.resolve(relative);
    this.artifactKinds.set(toPortablePath(relative), kind);
    const resolved =
      sensitivity ??
      (LINE_REDACTED_LOG_KINDS.has(kind) ? "redacted" : undefined);
    if (resolved) this.markSensitivity(relative, resolved);
    else this.markUnredacted(relative);
    return absolute;
  }

  async remove(relative: string): Promise<void> {
    const absolute = this.resolve(relative);
    await rm(absolute, { force: true });
    this.artifactKinds.delete(toPortablePath(relative));
    this.artifactSensitivity.delete(toPortablePath(relative));
  }

  /**
   * Record how a producer-owned file was treated (a sanitized trace is
   * `sanitized`, one that could not be sanitized `secret-bearing`). Files the
   * writer never saw get `secret-bearing` (text) or `safe` (media) in the
   * manifest; only bytes written through the redactor are `redacted`.
   */
  markSensitivity(relative: string, sensitivity: ArtifactSensitivity): void {
    this.artifactSensitivity.set(toPortablePath(relative), sensitivity);
  }

  /** Raw bytes written without the redactor can never be `redacted`. */
  private markUnredacted(relative: string): void {
    this.markSensitivity(
      relative,
      inferUnredactedSensitivity(toPortablePath(relative)),
    );
  }

  async writeText(
    relative: string,
    contents: string,
    kind = inferArtifactKind(relative),
  ): Promise<void> {
    const absolute = this.resolve(relative);
    const operation = (async () => {
      await ensurePrivateDirectory(dirname(absolute));
      await writeFile(absolute, this.redactor.text(contents), {
        mode: ARTIFACT_FILE_MODE,
      });
      await tightenMode(absolute, ARTIFACT_FILE_MODE);
      this.artifactKinds.set(toPortablePath(relative), kind);
      this.artifactSensitivity.set(toPortablePath(relative), "redacted");
    })();
    return this.track(operation);
  }

  async writeJson(
    relative: string,
    value: unknown,
    kind = inferArtifactKind(relative),
  ): Promise<void> {
    const rendered = JSON.stringify(this.redactor.value(value), null, 2);
    if (rendered === undefined) {
      throw new TypeError(
        `artifact JSON value is not serializable: ${relative}`,
      );
    }
    await this.writeText(relative, `${rendered}\n`, kind);
  }

  /**
   * Write newline-delimited JSON while values are still structured. Redacting
   * the rendered string is too late for dynamic header values such as
   * Authorization, Cookie, and Set-Cookie: their field names are then only
   * escaped text, rather than keys the redactor can classify.
   */
  async writeNdjson(
    relative: string,
    values: readonly unknown[],
    kind = inferArtifactKind(relative),
  ): Promise<void> {
    const rendered = values
      .map((value, index) => {
        const line = JSON.stringify(this.redactor.value(value));
        if (line === undefined) {
          throw new TypeError(
            `artifact NDJSON value is not serializable: ${relative}[${index}]`,
          );
        }
        return line;
      })
      .join("\n");
    await this.writeText(
      relative,
      `${rendered}${values.length > 0 ? "\n" : ""}`,
      kind,
    );
  }

  async writeBinary(
    relative: string,
    contents: Uint8Array,
    kind = inferArtifactKind(relative),
  ): Promise<void> {
    const absolute = this.resolve(relative);
    const operation = (async () => {
      await ensurePrivateDirectory(dirname(absolute));
      await writeFile(absolute, contents, { mode: ARTIFACT_FILE_MODE });
      await tightenMode(absolute, ARTIFACT_FILE_MODE);
      this.artifactKinds.set(toPortablePath(relative), kind);
      this.markUnredacted(relative);
    })();
    return this.track(operation);
  }

  /**
   * Copy a stream into the run with a hard byte limit. The stream is piped
   * directly to disk; no whole-file buffer is created. Partial files are
   * removed when the bound is exceeded or the source fails.
   */
  async copyStream(
    relative: string,
    source: Readable,
    options: { maxBytes: number; kind?: string },
  ): Promise<{ path: string; bytes: number }> {
    assertMaxBytes(options.maxBytes);
    const kind = options.kind ?? inferArtifactKind(relative);
    const absolute = await this.preparePath(relative, kind);
    this.markUnredacted(relative);
    let bytes = 0;
    const limiter = new Transform({
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.byteLength;
        if (bytes > options.maxBytes) {
          callback(
            new Error(
              `artifact exceeds maxBytes (${options.maxBytes}): ${relative}`,
            ),
          );
          return;
        }
        callback(null, chunk);
      },
    });
    const operation = (async () => {
      try {
        await pipeline(
          source,
          limiter,
          createWriteStream(absolute, { mode: ARTIFACT_FILE_MODE }),
        );
        await tightenMode(absolute, ARTIFACT_FILE_MODE);
        return { path: absolute, bytes };
      } catch (error) {
        await rm(absolute, { force: true });
        this.artifactKinds.delete(toPortablePath(relative));
        throw error;
      }
    })();
    return this.track(operation);
  }

  /**
   * Stream a file into the run. The preflight size check fails early when
   * possible; copyStream enforces the same bound while bytes are flowing.
   */
  async copyFile(
    relative: string,
    sourcePath: string,
    options: { maxBytes: number; kind?: string },
  ): Promise<{ path: string; bytes: number }> {
    assertMaxBytes(options.maxBytes);
    const sourceStat = await stat(sourcePath);
    if (!sourceStat.isFile()) {
      throw new Error(`artifact source is not a file: ${sourcePath}`);
    }
    if (sourceStat.size > options.maxBytes) {
      throw new Error(
        `artifact exceeds maxBytes (${options.maxBytes}): ${relative}`,
      );
    }
    return this.copyStream(relative, createReadStream(sourcePath), options);
  }

  async writeRun(result: RunResult): Promise<void> {
    const redacted = this.redactor.value(result);
    await this.writeText("run.json", renderJson(redacted), "run");
    await this.writeText("run.yaml", renderYaml(redacted), "run");
    await this.writeText("run.md", renderRunMarkdown(redacted), "run");

    const report = this.redactor.value(
      buildReportModel(redacted, { config: this.opts.report }),
    );
    await this.writeText("report.json", renderReportJson(report), "report");
    await this.writeText("report.html", renderReportHtml(report), "report");
  }

  async writeOutcomesIndex(result: RunResult): Promise<void> {
    const summary = {
      runId: result.runId,
      status: result.status,
      outcomes: result.outcomes,
    };
    await this.writeText(
      "outcomes/results.json",
      renderJson(this.redactor.value(summary)),
      "outcome-index",
    );
    await this.writeText(
      "outcomes/results.yaml",
      renderYaml(this.redactor.value(summary)),
      "outcome-index",
    );
    const md =
      [
        `# Outcomes — ${result.status}`,
        `Run: ${result.runId}`,
        "",
        ...result.outcomes.map((o) => {
          const mark =
            o.status === "passed" ? "✓" : o.status === "failed" ? "✗" : "·";
          return `- ${mark} ${o.id}${o.evidence ? ` → ${o.evidence}` : ""}`;
        }),
      ].join("\n") + "\n";
    await this.writeText("outcomes/results.md", md, "outcome-index");
  }

  async writeOutcomeEvidence(evidence: EvidenceInput): Promise<void> {
    const redacted = this.redactor.value(evidence);
    await this.writeText(
      `outcomes/${evidence.outcomeId}.md`,
      renderEvidenceMarkdown(redacted),
      "outcome-evidence",
    );
    if (redacted.raw !== undefined) {
      await this.writeText(
        `outcomes/${evidence.outcomeId}.raw.json`,
        renderJson(redacted.raw),
        "outcome-evidence",
      );
    }
  }

  async writeAgentContext(spec: Spec, result: RunResult): Promise<void> {
    await this.writeText(
      "agent_context.md",
      renderAgentContext(spec, result),
      "agent-context",
    );
  }

  /**
   * Write the exact-replay manifest (SPEC §7.3) as replay.json, redacted like
   * every other artifact. Env values are never present in the manifest (only
   * key names), but the redactor is still applied as a last-line filter.
   */
  async writeReplay(manifest: ReplayManifest): Promise<void> {
    await this.writeText("replay.json", renderJson(manifest), "replay");
  }

  /**
   * Append one event to events.ndjson. Events are typed against the
   * events.v1 contract (`schema/events.v1.ts`) and redacted before writing.
   */
  async appendEvent(event: RunEvent): Promise<void> {
    const line = `${JSON.stringify(this.redactor.value(event))}\n`;
    const absolute = this.resolve("events.ndjson");
    const operation = this.eventTail.then(async () => {
      if (!this.eventLogPermissionsSealed) {
        await ensurePrivateDirectory(dirname(absolute));
      }
      await appendFile(absolute, line, { mode: ARTIFACT_FILE_MODE });
      // appendFile's mode only applies when creating the file. Seal an existing
      // permissive event log on this writer's first append, then avoid two
      // extra filesystem syscalls for every subsequent event. writeManifest()
      // seals the complete tree again before publishing it.
      if (!this.eventLogPermissionsSealed) {
        await tightenMode(absolute, ARTIFACT_FILE_MODE);
        this.eventLogPermissionsSealed = true;
      }
      this.artifactKinds.set("events.ndjson", "event-log");
      this.artifactSensitivity.set("events.ndjson", "redacted");
    });
    this.eventTail = operation.catch(() => undefined);
    return this.track(operation);
  }

  /**
   * Write services lifecycle events (from startServices) to events.ndjson.
   * Each ServicesEvent is mapped to a `services.<phase>.<event>` RunEvent.
   * A pairing outside the events.v1 vocabulary is dropped instead of being
   * written as an unvalidated line; every emit site in services.ts is pinned
   * to that vocabulary by a unit test.
   */
  async appendServicesEvents(
    events: ReadonlyArray<{
      phase: string;
      event: string;
      message: string;
      timestamp: string;
      data?: Record<string, unknown>;
    }>,
  ): Promise<void> {
    for (const event of events) {
      const type = `services.${event.phase}.${event.event}`;
      if (!isServicesEventType(type)) continue;
      await this.appendEvent({
        ts: event.timestamp,
        type,
        message: event.message,
        ...(event.data ? { data: event.data } : {}),
      });
    }
  }

  /** Used by the runner to write a resolved snapshot of the spec for this run. */
  async writeResolvedSpec(spec: Spec): Promise<void> {
    await this.writeText(
      "spec.resolved.yml",
      renderYaml(spec),
      "resolved-spec",
    );
  }

  /**
   * Build and write a deterministic inventory of every regular run artifact.
   * Files are hashed as streams and sorted by portable relative path. The
   * manifest excludes itself so repeated generation over unchanged artifacts
   * produces identical bytes.
   */
  async writeManifest(
    relative = "artifact-manifest.json",
  ): Promise<ArtifactManifest> {
    const absolute = this.resolve(relative);
    await this.flushPendingWrites();
    await this.normalizeArtifactPermissions(this.runDir);
    const excluded = toPortablePath(relative);
    // A writer that reopens a finalized run (stash receipt, pin, publish)
    // keeps the kinds and sensitivities the original run recorded.
    const previous = await readPreviousManifest(absolute);
    const artifacts = await this.collectManifestEntries(
      this.runDir,
      "",
      excluded,
      previous,
    );
    artifacts.sort((a, b) => a.path.localeCompare(b.path));
    const manifest: ArtifactManifest = { version: "1", artifacts };
    await ensurePrivateDirectory(dirname(absolute));
    await writeFile(absolute, `${JSON.stringify(manifest, null, 2)}\n`, {
      mode: ARTIFACT_FILE_MODE,
    });
    await tightenMode(absolute, ARTIFACT_FILE_MODE);
    this.artifactKinds.set(excluded, "manifest");
    return manifest;
  }

  private track<T>(operation: Promise<T>): Promise<T> {
    this.pendingWrites.add(operation);
    void operation
      .finally(() => {
        this.pendingWrites.delete(operation);
      })
      .catch(() => undefined);
    return operation;
  }

  private async flushPendingWrites(): Promise<void> {
    while (this.pendingWrites.size > 0) {
      await Promise.all(this.pendingWrites);
    }
  }

  private async collectManifestEntries(
    directory: string,
    prefix: string,
    excluded: string,
    previous: ReadonlyMap<string, ArtifactManifestEntry>,
  ): Promise<ArtifactManifestEntry[]> {
    const entries: ArtifactManifestEntry[] = [];
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const portable = prefix ? `${prefix}/${child.name}` : child.name;
      const absolute = resolvePath(directory, child.name);
      if (child.isSymbolicLink()) {
        throw new Error(`artifact manifest refuses symbolic link: ${portable}`);
      }
      if (child.isDirectory()) {
        entries.push(
          ...(await this.collectManifestEntries(
            absolute,
            portable,
            excluded,
            previous,
          )),
        );
        continue;
      }
      if (!child.isFile() || portable === excluded) continue;
      const { bytes, sha256 } = await hashFile(absolute);
      const before = previous.get(portable);
      entries.push({
        path: portable,
        kind:
          this.artifactKinds.get(portable) ??
          before?.kind ??
          inferArtifactKind(portable),
        bytes,
        sha256,
        // A file this writer never recorded and no earlier manifest listed
        // (an `--after` collector output, a tool's raw capture) was not
        // written through the redactor. A legacy entry without sensitivity
        // keeps the path inference of the version that wrote it.
        sensitivity:
          this.artifactSensitivity.get(portable) ??
          before?.sensitivity ??
          (before
            ? inferArtifactSensitivity(portable)
            : inferUnredactedSensitivity(portable)),
      });
    }
    return entries;
  }

  /**
   * Producer-owned artifacts (screenshots, traces, downloads) are written
   * outside ArtifactWriter's write helpers. Seal the complete tree before its
   * manifest is published. Symbolic links are deliberately ignored here and
   * rejected by collectManifestEntries, so chmod never follows one outside the
   * run directory.
   */
  private async normalizeArtifactPermissions(directory: string): Promise<void> {
    await tightenMode(directory, ARTIFACT_DIRECTORY_MODE);
    const children = await readdir(directory, { withFileTypes: true });
    for (const child of children) {
      if (child.isSymbolicLink()) continue;
      const absolute = resolvePath(directory, child.name);
      if (child.isDirectory()) {
        await this.normalizeArtifactPermissions(absolute);
      } else if (child.isFile()) {
        await tightenMode(absolute, ARTIFACT_FILE_MODE);
      }
    }
  }
}

/** Entries of an existing manifest by path (empty when absent or invalid). */
async function readPreviousManifest(
  absolute: string,
): Promise<Map<string, ArtifactManifestEntry>> {
  try {
    const parsed = ArtifactManifestSchema.safeParse(
      JSON.parse(await readFile(absolute, "utf8")),
    );
    return parsed.success
      ? new Map(parsed.data.artifacts.map((entry) => [entry.path, entry]))
      : new Map();
  } catch {
    return new Map();
  }
}

async function ensurePrivateDirectory(absolute: string): Promise<void> {
  await mkdir(absolute, {
    recursive: true,
    mode: ARTIFACT_DIRECTORY_MODE,
  });
  await tightenMode(absolute, ARTIFACT_DIRECTORY_MODE);
}

async function tightenMode(absolute: string, mode: number): Promise<void> {
  // Windows does not implement POSIX permission bits. Parent-directory
  // confinement still applies there; ACL hardening requires a platform-native
  // policy outside this writer.
  if (process.platform === "win32") return;
  const entry = await lstat(absolute);
  if (entry.isSymbolicLink()) {
    throw new Error(`artifact permissions refuse symbolic link: ${absolute}`);
  }
  await chmod(absolute, mode);
}

/** LiveLog files: every line goes through the run redactor before disk. */
const LINE_REDACTED_LOG_KINDS: ReadonlySet<string> = new Set([
  "run-log",
  "log",
]);

function toPortablePath(relative: string): string {
  return relative.replaceAll("\\", "/");
}

function inferArtifactKind(relative: string): string {
  const portable = toPortablePath(relative);
  if (portable.startsWith("videos/clips/")) return "clip";
  const exact: Record<string, string> = {
    "agent_context.md": "agent-context",
    "artifact-manifest.json": "manifest",
    "events.ndjson": "event-log",
    "replay.json": "replay",
    "run.log": "run-log",
    "spec.resolved.yml": "resolved-spec",
    "stash-receipt.json": "stash-receipt",
  };
  if (exact[portable]) return exact[portable]!;
  if (portable.startsWith("run.")) return "run";
  if (portable.startsWith("report.")) return "report";
  if (portable.startsWith("outcomes/")) return "outcome";
  const directory = portable.split("/", 1)[0]!;
  const directories: Record<string, string> = {
    console: "console",
    diagnostics: "diagnostic",
    downloads: "download",
    evals: "eval",
    logs: "log",
    network: "network",
    requests: "request",
    screenshots: "screenshot",
    snapshots: "snapshot",
    traces: "trace",
    transforms: "transform",
    videos: "video",
  };
  return directories[directory] ?? "artifact";
}

function assertMaxBytes(maxBytes: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }
}

async function hashFile(
  absolute: string,
): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(absolute)) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  return { bytes, sha256: hash.digest("hex") };
}
