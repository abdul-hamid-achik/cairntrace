/**
 * `.cairn-export.json` — the export manifest (E6).
 *
 * Written into the export root by `cairn export playwright --project|--into`
 * and batch `--out-dir` exports. It records which exporter version generated
 * the tree, each spec's contract hash + source digest, and a sha256 per
 * generated/copied file. The export check (`checkPlaywrightExport` in the
 * CLI command) regenerates the export IN MEMORY from the current sources and
 * compares it with the files on disk, so a committed export can never
 * silently drift from its specs (stale tests, deleted specs, hand edits).
 * Everything recorded is relocatable: paths are relative to the export root
 * and digests cover content, never absolute paths.
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ExportManifestVerify } from "../schema/exportVerify.v1";
import type { ExportLang } from "./playwrightExporter";

export const EXPORT_MANIFEST_FILE = ".cairn-export.json";

export type ExportManifestMode = "project" | "into" | "files";

export interface ExportManifestSpec {
  /** Source spec path relative to the export root (POSIX separators). */
  spec: string;
  contractHash: string;
  /** Generated test file relative to the export root. */
  testFile: string;
  /** sha256 over the spec source and its imported actions (name + source). */
  sourceDigest: string;
}

/**
 * A precondition command listed for the host to run
 * (`--preconditions manifest`). `run` is the authored command text with
 * `${env.X}` placeholders — never an environment value — run through
 * `/bin/sh -c` from `cwd`, like `cairn run`.
 */
export interface ExportManifestPrecondition {
  /** Source spec relative to the export root (POSIX separators). */
  spec: string;
  name?: string;
  run: string;
  /** Directory it runs in, relative to `source.projectRoot` (POSIX). */
  cwd: string;
  timeoutMs: number;
  /** Names of the `preconditions.env` entries layered over the env (no values). */
  envKeys?: string[];
}

export interface ExportManifestFile {
  /** Path relative to the export root (POSIX separators). */
  path: string;
  /** Hex sha256 of the file bytes as written. */
  sha256: string;
}

export interface ExportManifestV1 {
  version: 1;
  /** package.json version of the cairntrace that generated the export. */
  exporterVersion: string;
  generatedAt: string;
  mode: ExportManifestMode;
  lang: ExportLang;
  /** What the export check needs to regenerate the export. */
  source: {
    /** Export input (spec file or directory) relative to the export root. */
    input: string;
    /** Explicit --config, relative to the export root, when one was given. */
    config?: string;
    env?: string;
    /** Names of --var overrides (values are never recorded). */
    varKeys: string[];
    /** sha256 of the --var overrides, so the check can tell they differ. */
    varsDigest?: string;
    /** `--preconditions` mode, when one was given. */
    preconditions?: string;
    /** `--verifiers` mode, when one was given. */
    verifiers?: string;
    /** `--gate-env` names (sorted). */
    gateEnv?: string[];
    /** The source project root (config dir), relative to the export root. */
    projectRoot?: string;
    /** E8: the host Playwright config the tree was adapted to, relative to the export root. */
    hostConfig?: string;
    /** E8: the `export.targets` profile the export was made from. */
    target?: string;
    /** E12: `--max-eval-ratio` (specs above it were refused, so the check skips them too). */
    maxEvalRatio?: number;
    /** E8: `--allow-eval-without-bypass` was given. */
    allowEvalWithoutBypass?: boolean;
    /** `--strict-locators`: no `.first()` on a locator without `nth`. */
    strictLocators?: boolean;
    /**
     * The host Playwright project `--verify` lists, runs and mutates under
     * (`--verify-project` / `export.targets.<name>.verifyProject` at export
     * time). A later `--verify <dir>` uses it unless one is given.
     */
    verifyProject?: string;
    /**
     * E9: the export map the tree was made with: its path relative to the
     * export root and the digest of its parsed content (the check regenerates
     * with the same map and says when it changed).
     */
    map?: { file: string; digest: string };
  };
  specs: ExportManifestSpec[];
  files: ExportManifestFile[];
  /** `--preconditions manifest`: the commands the host runs before the suite. */
  preconditions?: ExportManifestPrecondition[];
  /**
   * The last `cairn export playwright --verify` result (E5): a summary that
   * names the full report. `filesDigest` ties it to the files it verified: a
   * re-export that changes any file drops it, one that does not keeps it.
   */
  verify?: ExportManifestVerify;
}

/** One generated or copied file, relative to the export root. */
export interface GeneratedExportFile {
  relPath: string;
  content: string | Buffer;
}

export function sha256Hex(content: string | Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

/** Stable digest of `--var` overrides (order-insensitive). */
export function varsDigest(vars: Record<string, string>): string | undefined {
  const keys = Object.keys(vars).toSorted();
  if (keys.length === 0) return undefined;
  return `sha256:${sha256Hex(JSON.stringify(keys.map((key) => [key, vars[key]])))}`;
}

export function buildExportManifest(input: {
  exporterVersion: string;
  mode: ExportManifestMode;
  lang: ExportLang;
  source: ExportManifestV1["source"];
  specs: ExportManifestSpec[];
  files: GeneratedExportFile[];
  preconditions?: ExportManifestPrecondition[];
  generatedAt?: string;
}): ExportManifestV1 {
  return {
    version: 1,
    exporterVersion: input.exporterVersion,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    mode: input.mode,
    lang: input.lang,
    source: input.source,
    specs: [...input.specs].toSorted((a, b) => a.spec.localeCompare(b.spec)),
    files: input.files
      .filter((file) => file.relPath !== EXPORT_MANIFEST_FILE)
      .map((file) => ({
        path: file.relPath,
        sha256: sha256Hex(file.content),
      }))
      .toSorted((a, b) => a.path.localeCompare(b.path)),
    ...(input.preconditions
      ? {
          preconditions: [...input.preconditions].toSorted(
            (a, b) =>
              a.spec.localeCompare(b.spec) || a.run.localeCompare(b.run),
          ),
        }
      : {}),
  };
}

/** Digest of the recorded file hashes: which export content a verify result covers. */
export function exportFilesDigest(
  files: ReadonlyArray<ExportManifestFile>,
): string {
  const rows = files
    .map((file) => [file.path, file.sha256] as const)
    .toSorted((a, b) => a[0].localeCompare(b[0]));
  return `sha256:${sha256Hex(JSON.stringify(rows))}`;
}

export function renderExportManifest(manifest: ExportManifestV1): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function readExportManifest(exportDir: string): ExportManifestV1 {
  const path = join(exportDir, EXPORT_MANIFEST_FILE);
  if (!existsSync(path)) {
    throw new Error(
      `no ${EXPORT_MANIFEST_FILE} in ${exportDir}; re-export with \`cairn export playwright --project|--into|--out-dir\` to create one`,
    );
  }
  const parsed = JSON.parse(
    readFileSync(path, "utf8"),
  ) as Partial<ExportManifestV1>;
  if (parsed.version !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`${path} is not a version 1 cairn export manifest`);
  }
  return parsed as ExportManifestV1;
}

/**
 * Keep the previous `generatedAt` when nothing else in the manifest changed,
 * so re-exporting unchanged sources leaves a committed manifest byte-identical.
 */
function stabilizeManifest(
  next: ExportManifestV1,
  previous: ExportManifestV1 | undefined,
): ExportManifestV1 {
  if (!previous || typeof previous.generatedAt !== "string") return next;
  // A verify result stays valid only for the exact files it verified.
  const verify =
    previous.verify &&
    previous.verify.filesDigest === exportFilesDigest(next.files)
      ? { verify: previous.verify }
      : {};
  return manifestContent(previous) === manifestContent(next)
    ? { ...next, ...verify, generatedAt: previous.generatedAt }
    : next;
}

/** Manifest identity without its timestamp. */
function manifestContent(manifest: ExportManifestV1): string {
  const { verify: _verify, ...rest } = manifest;
  return JSON.stringify({ ...rest, generatedAt: "" });
}

function readPreviousManifest(exportDir: string): ExportManifestV1 | undefined {
  try {
    return readExportManifest(exportDir);
  } catch {
    return undefined;
  }
}

/**
 * Record a verify summary in an existing manifest (everything else, the
 * timestamp included, stays byte-identical).
 */
export async function recordManifestVerify(
  exportDir: string,
  verify: ExportManifestVerify,
): Promise<void> {
  const manifest = readExportManifest(exportDir);
  await writeFile(
    join(exportDir, EXPORT_MANIFEST_FILE),
    renderExportManifest({ ...manifest, verify }),
  );
}

/** Write generated files (text or binary) plus the manifest. */
export async function writeGeneratedExport(
  exportDir: string,
  files: GeneratedExportFile[],
  manifest?: ExportManifestV1,
): Promise<void> {
  const previous = manifest ? readPreviousManifest(exportDir) : undefined;
  for (const file of files) {
    const abs = join(exportDir, file.relPath);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, file.content);
  }
  if (manifest) {
    await mkdir(exportDir, { recursive: true });
    await writeFile(
      join(exportDir, EXPORT_MANIFEST_FILE),
      renderExportManifest(stabilizeManifest(manifest, previous)),
    );
  }
}

export type ExportCheckSpecStatus = "fresh" | "changed" | "new" | "removed";

export interface ExportCheckReport {
  /** fresh = disk matches what the current sources generate. */
  status: "fresh" | "stale" | "error";
  exportDir: string;
  /** Exporter version running the check. */
  exporterVersion: string;
  manifest?: {
    exporterVersion: string;
    generatedAt: string;
    mode: ExportManifestMode;
    lang: ExportLang;
  };
  files: {
    checked: number;
    /** On disk, but differs from what the current sources generate. */
    stale: string[];
    /** Would be generated, but is not on disk. */
    missing: string[];
    /** Recorded by the previous export, no longer generated, still on disk. */
    orphaned: string[];
    /** Differs from the manifest's recorded hash (edited after export). */
    modified: string[];
  };
  /**
   * Per-spec status. `changed` means the current sources generate a
   * different test file than the previous export recorded AND disk does not
   * match it. `contractChanged` / `sourceChanged` are informational: a
   * YAML comment edit changes the source digest but not the generated test.
   */
  specs: Array<{
    spec: string;
    testFile: string;
    status: ExportCheckSpecStatus;
    contractChanged?: boolean;
    sourceChanged?: boolean;
  }>;
  /**
   * `--preconditions manifest`: the listed commands differ from what the
   * current sources generate (a command, cwd or timeout changed).
   */
  preconditionsStale?: boolean;
  warnings: string[];
  error?: string;
}

/**
 * Compare a freshly regenerated export (in memory) with the files on disk and
 * the previous manifest. Never writes anything.
 */
export function diffExport(input: {
  exportDir: string;
  exporterVersion: string;
  previous: ExportManifestV1;
  expectedFiles: GeneratedExportFile[];
  expectedSpecs: ExportManifestSpec[];
  /** `--preconditions manifest`: the commands the current sources list. */
  expectedPreconditions?: ExportManifestPrecondition[];
  warnings?: string[];
  readDisk?: (relPath: string) => Buffer | undefined;
}): ExportCheckReport {
  const readDisk =
    input.readDisk ??
    ((relPath: string) => {
      const abs = join(input.exportDir, relPath);
      return existsSync(abs) ? readFileSync(abs) : undefined;
    });
  const recorded = new Map(
    input.previous.files.map((file) => [file.path, file.sha256]),
  );
  const expected = input.expectedFiles.filter(
    (file) => file.relPath !== EXPORT_MANIFEST_FILE,
  );
  const expectedPaths = new Set(expected.map((file) => file.relPath));
  const stale: string[] = [];
  const missing: string[] = [];
  const modified: string[] = [];
  for (const file of expected) {
    const disk = readDisk(file.relPath);
    if (!disk) {
      missing.push(file.relPath);
      continue;
    }
    const diskHash = sha256Hex(disk);
    if (diskHash !== sha256Hex(file.content)) stale.push(file.relPath);
    const recordedHash = recorded.get(file.relPath);
    if (recordedHash && recordedHash !== diskHash) modified.push(file.relPath);
  }
  const orphaned = [...recorded.keys()].filter(
    (path) => !expectedPaths.has(path) && readDisk(path) !== undefined,
  );

  const previousSpecs = new Map(
    input.previous.specs.map((spec) => [spec.spec, spec]),
  );
  const regenerated = new Map(
    expected.map((file) => [file.relPath, sha256Hex(file.content)]),
  );
  const outOfDate = new Set([...stale, ...missing]);
  const specs: ExportCheckReport["specs"] = [];
  for (const spec of input.expectedSpecs) {
    const before = previousSpecs.get(spec.spec);
    if (!before) {
      specs.push({ spec: spec.spec, testFile: spec.testFile, status: "new" });
      continue;
    }
    previousSpecs.delete(spec.spec);
    const contractChanged = before.contractHash !== spec.contractHash;
    const sourceChanged = before.sourceDigest !== spec.sourceDigest;
    // A hand edit (disk != recorded == regenerated) is reported in files.*,
    // not as a spec change; a digest-only change (comment edit) is info.
    const generatesDifferently =
      recorded.get(spec.testFile) !== regenerated.get(spec.testFile);
    specs.push({
      spec: spec.spec,
      testFile: spec.testFile,
      status:
        generatesDifferently && outOfDate.has(spec.testFile)
          ? "changed"
          : "fresh",
      ...(contractChanged ? { contractChanged } : {}),
      ...(sourceChanged ? { sourceChanged } : {}),
    });
  }
  for (const removed of previousSpecs.values()) {
    specs.push({
      spec: removed.spec,
      testFile: removed.testFile,
      status: "removed",
    });
  }
  specs.sort((a, b) => a.spec.localeCompare(b.spec));

  const preconditionsStale =
    input.expectedPreconditions !== undefined &&
    JSON.stringify(sortedPreconditions(input.previous.preconditions ?? [])) !==
      JSON.stringify(sortedPreconditions(input.expectedPreconditions));
  const drift =
    stale.length > 0 ||
    missing.length > 0 ||
    orphaned.length > 0 ||
    preconditionsStale ||
    specs.some((spec) => spec.status !== "fresh");
  const warnings = [...(input.warnings ?? [])];
  if (input.previous.exporterVersion !== input.exporterVersion) {
    warnings.push(
      `export was generated by cairntrace ${input.previous.exporterVersion}; checking with ${input.exporterVersion}`,
    );
  }
  return {
    status: drift ? "stale" : "fresh",
    exportDir: input.exportDir,
    exporterVersion: input.exporterVersion,
    manifest: {
      exporterVersion: input.previous.exporterVersion,
      generatedAt: input.previous.generatedAt,
      mode: input.previous.mode,
      lang: input.previous.lang,
    },
    files: {
      checked: expected.length,
      stale: stale.toSorted(),
      missing: missing.toSorted(),
      orphaned: orphaned.toSorted(),
      modified: modified.toSorted(),
    },
    specs,
    ...(preconditionsStale ? { preconditionsStale: true } : {}),
    warnings,
  };
}

function sortedPreconditions(
  list: readonly ExportManifestPrecondition[],
): ExportManifestPrecondition[] {
  return [...list].toSorted(
    (a, b) => a.spec.localeCompare(b.spec) || a.run.localeCompare(b.run),
  );
}

/**
 * realpath of the nearest existing ancestor plus the not-yet-created
 * remainder. Export-relative paths are computed on real paths so a symlinked
 * directory (macOS `/tmp` → `/private/tmp`) cannot skew `..` arithmetic.
 */
export function realpathNearest(path: string): string {
  let current = path;
  const rest: string[] = [];
  for (;;) {
    if (existsSync(current)) {
      try {
        return join(realpathSync(current), ...rest.toReversed());
      } catch {
        return path;
      }
    }
    const parent = dirname(current);
    if (parent === current) return path;
    rest.push(basename(current));
    current = parent;
  }
}
