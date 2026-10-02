import { existsSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
} from "node:path";
import { parse as parseYaml } from "yaml";
import {
  SpecPromoteResultSchema,
  type SpecPromoteResult,
} from "../../../core/authoring/authoring.v1";
import {
  draftsDirFor,
  isDraftSpec,
  isInside,
} from "../../../core/authoring/config";
import {
  contentHash,
  defaultPromoteTarget,
  isSyntheticBackend,
  readFinishReceipt,
  rebaseRelativePaths,
  removeFinishReceipt,
} from "../../../core/authoring/promote";
import { lintSpecs, type LintFinding } from "../../../core/authoring/lint";
import { findConfigFile, loadConfig } from "../../../core/config/loader";
import { emit, resolveFormat } from "../../format";
import { resolveBatchArtifactRoot } from "../../invocation/lifecycle";
import { stampSpecContractHash } from "./verify";

/**
 * `cairn spec promote <draft> [--to <path>] [--force]` (A8): move a draft
 * out of the drafts dir once `cairn spec finish` ran it green — the exact
 * content that ran, checked against the finish receipt — rebase its
 * relative paths, stamp the contract hash and return what the human
 * approved: {from, to, intent, outcomes, contractHash}.
 */

export interface PromoteSpecOptions {
  to?: string;
  /** Promote without a green finish of this exact content. */
  force?: boolean;
  /**
   * sha256 (hex) of the draft text the human reviewed: any other content is
   * refused (exit 4), even with `force` — what was shown is what is stamped.
   */
  expectContentHash?: string;
  config?: string;
  artifactRoot?: string;
  cwd?: string;
}

/** Promotion refused (exit 4) or failed (exit 2). */
export class PromoteError extends Error {
  override name = "PromoteError";
  constructor(
    message: string,
    readonly exitCode: 2 | 4 = 4,
  ) {
    super(message);
  }
}

/**
 * A directory with symlinks resolved (`/var` vs `/private/var` on macOS),
 * through its deepest existing ancestor, so two paths to the same place
 * rebase to the same relative path.
 */
function realDir(dir: string): string {
  const missing: string[] = [];
  let current = resolve(dir);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return resolve(dir);
    missing.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...missing);
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function shown(path: string, cwd: string): string {
  const rel = relative(cwd, path);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path;
}

/** Lint rules that mean "a referenced file is not there". */
const REFERENCE_RULES = new Set(["missing-file", "unresolved-action"]);

function referenceKey(f: LintFinding): string {
  return `${f.rule}\u0000${f.where ?? f.message}\u0000${f.file ?? ""}`;
}

/**
 * File-reference findings the promoted copy has and the draft did not
 * (missing files, precondition folders, imports that no longer resolve).
 */
async function brokenReferences(
  from: string,
  to: string,
  opts: { config?: string; cwd: string },
): Promise<string[]> {
  const result = await lintSpecs([from, to], opts);
  const before = new Set(
    (result.files[0]?.findings ?? [])
      .filter((f) => REFERENCE_RULES.has(f.rule))
      .map(referenceKey),
  );
  return (result.files[1]?.findings ?? [])
    .filter((f) => REFERENCE_RULES.has(f.rule) && !before.has(referenceKey(f)))
    .map((f) => f.message);
}

export async function promoteSpec(
  draftPath: string,
  opts: PromoteSpecOptions = {},
): Promise<SpecPromoteResult> {
  const cwd = opts.cwd ?? process.cwd();
  const from = isAbsolute(draftPath) ? draftPath : resolve(cwd, draftPath);
  let text: string;
  try {
    text = await readFile(from, "utf8");
  } catch (e) {
    throw new PromoteError(`cannot read ${draftPath}: ${(e as Error).message}`);
  }
  if (opts.expectContentHash !== undefined) {
    const expected = opts.expectContentHash.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(expected)) {
      throw new PromoteError(
        `--expect-content-hash must be a sha256 hex digest (64 characters), got "${opts.expectContentHash}"`,
        2,
      );
    }
    const actual = contentHash(text);
    if (actual !== expected) {
      throw new PromoteError(
        `refusing to promote ${draftPath}: its content changed since it was reviewed (sha256 ${actual.slice(
          0,
          12,
        )}…, expected ${expected.slice(0, 12)}…); review the current draft before promoting it`,
      );
    }
  }

  const configPath =
    opts.config !== undefined
      ? resolve(cwd, opts.config)
      : await findConfigFile(dirname(from));
  const loaded = configPath
    ? await loadConfig(from, configPath).catch((e: Error) => {
        throw new PromoteError(`config: ${e.message}`);
      })
    : undefined;
  // Without a config, the project root is the cwd (drafts: <cwd>/flows/_drafts).
  const root = loaded ? dirname(loaded.path) : cwd;
  const draftsDir = draftsDirFor(root, loaded?.config);
  if (!isDraftSpec(from, { draftsDir, root })) {
    throw new PromoteError(
      `${draftPath} is not a draft: drafts live in ${shown(draftsDir, cwd)} (config authoring.draftsDir) or under a folder/file starting with _`,
    );
  }

  let to = opts.to
    ? resolve(cwd, opts.to)
    : defaultPromoteTarget(from, { draftsDir, root });
  // `--to` naming a folder (existing, trailing slash, or no .yml/.yaml
  // extension) keeps the draft's file name.
  if (
    opts.to &&
    (opts.to.endsWith("/") ||
      !/\.ya?ml$/i.test(to) ||
      (await stat(to).catch(() => undefined))?.isDirectory())
  ) {
    to = join(to, basename(from).replace(/^_+/, ""));
  }
  if (resolve(to) === resolve(from)) {
    throw new PromoteError(
      `${draftPath} would be promoted onto itself; pass --to`,
    );
  }
  if (isDraftSpec(to, { draftsDir, root }) || isInside(to, draftsDir)) {
    throw new PromoteError(
      `${shown(to, cwd)} is still a draft location (the drafts dir or a _ folder); pass --to outside it`,
    );
  }
  if (await exists(to)) {
    throw new PromoteError(
      `${shown(to, cwd)} already exists; pass --to <another path> (promote never replaces a spec)`,
    );
  }

  // The green finish of this exact content.
  const artifactRoot =
    opts.artifactRoot !== undefined
      ? resolve(cwd, opts.artifactRoot)
      : await resolveBatchArtifactRoot(
          from,
          opts.config !== undefined ? { config: opts.config } : {},
          cwd,
        );
  const receipt = readFinishReceipt(artifactRoot, from);
  const greenSameContent =
    receipt?.status === "green" && receipt.contentHash === contentHash(text);
  // A mock run never touched the app: it is not the green the gate means.
  const mockFinish = greenSameContent && isSyntheticBackend(receipt.backend);
  const fresh = greenSameContent && !mockFinish;
  if (!fresh && !opts.force) {
    const why = !receipt
      ? "no `cairn spec finish` ran for it"
      : receipt.status !== "green"
        ? `its last \`cairn spec finish\` was ${receipt.status}`
        : mockFinish
          ? "its green `cairn spec finish` ran on the mock backend, which never touches the app"
          : "it changed since its green `cairn spec finish`";
    throw new PromoteError(
      `refusing to promote ${draftPath}: ${why}. Run \`cairn spec finish ${draftPath}\`${
        mockFinish ? " on a real backend" : ""
      } until it is green (or pass --force)`,
    );
  }

  const doc = parseYaml(text) as Record<string, unknown> | null;
  if (!doc || typeof doc !== "object") {
    throw new PromoteError(`${draftPath} is not a spec`);
  }
  const rebased = rebaseRelativePaths(
    text,
    realDir(dirname(from)),
    realDir(dirname(to)),
  );
  await mkdir(dirname(to), { recursive: true });
  await writeFile(to, rebased.text, { flag: "wx" }).catch((e: Error) => {
    throw new PromoteError(`cannot write ${shown(to, cwd)}: ${e.message}`, 2);
  });
  let contractHash: string;
  try {
    contractHash = await stampSpecContractHash(to);
  } catch (e) {
    await rm(to, { force: true });
    throw new PromoteError(
      `cannot stamp ${shown(to, cwd)}: ${(e as Error).message} (the draft was left in place)`,
    );
  }
  // The promoted file must reach every file the draft reached.
  const broken = await brokenReferences(from, to, {
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    cwd,
  });
  if (broken.length > 0) {
    await rm(to, { force: true });
    throw new PromoteError(
      `promoting ${draftPath} to ${shown(to, cwd)} would break its file references: ${broken.join(
        "; ",
      )} (the draft was left in place; fix the paths or pick a --to next to it)`,
    );
  }
  // The receipt is keyed by the draft's real path: drop it while it exists.
  removeFinishReceipt(artifactRoot, from);
  await rm(from, { force: true });

  return SpecPromoteResultSchema.parse({
    $schema: "urn:cairntrace.dev:spec-promote:v1",
    version: "1",
    from: shown(from, cwd),
    to: shown(to, cwd),
    intent: typeof doc["intent"] === "string" ? doc["intent"] : "",
    outcomes: Array.isArray(doc["outcomes"]) ? doc["outcomes"] : [],
    contractHash,
    ...(fresh ? {} : { forced: true }),
    ...(greenSameContent && receipt
      ? {
          finish: {
            ...(receipt.runId ? { runId: receipt.runId } : {}),
            ...(receipt.runDir ? { runDir: receipt.runDir } : {}),
            ...(receipt.backend ? { backend: receipt.backend } : {}),
            finishedAt: receipt.finishedAt,
          },
        }
      : {}),
    ...(rebased.rebased.length > 0 ? { rebased: rebased.rebased } : {}),
    warnings: [
      ...rebased.warnings,
      ...(fresh
        ? []
        : mockFinish
          ? [
              "promoted with --force: the green `cairn spec finish` ran on the mock backend; no real browser ran this spec against the app",
            ]
          : [
              "promoted with --force: no green `cairn spec finish` of this content",
            ]),
    ],
  });
}

/* ----- CLI ----- */

export interface PromoteCommandOptions {
  to?: string;
  force?: boolean;
  expectContentHash?: string;
  config?: string;
  artifactRoot?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function promoteCommand(
  draftPath: string,
  opts: PromoteCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let result: SpecPromoteResult;
  try {
    result = await promoteSpec(draftPath, {
      ...(opts.to !== undefined ? { to: opts.to } : {}),
      ...(opts.force ? { force: true } : {}),
      ...(opts.expectContentHash !== undefined
        ? { expectContentHash: opts.expectContentHash }
        : {}),
      ...(opts.config !== undefined ? { config: opts.config } : {}),
      ...(opts.artifactRoot !== undefined
        ? { artifactRoot: opts.artifactRoot }
        : {}),
    });
  } catch (e) {
    process.stderr.write(`cairn spec promote: ${(e as Error).message}\n`);
    process.exitCode = e instanceof PromoteError ? e.exitCode : 2;
    return;
  }
  process.stdout.write(emit(format, result, promoteToMarkdown));
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}

export function promoteToMarkdown(r: SpecPromoteResult): string {
  const lines = [
    `# Promoted ${r.from} → ${r.to}`,
    "",
    `- intent: ${r.intent}`,
    `- outcomes: ${r.outcomes
      .map((o) => (typeof o["id"] === "string" ? o["id"] : "?"))
      .join(", ")}`,
    `- contractHash: ${r.contractHash}`,
  ];
  if (r.finish) {
    lines.push(
      `- green finish: ${r.finish.runId ?? "run"} at ${r.finish.finishedAt}${
        r.finish.backend ? ` on ${r.finish.backend}` : ""
      }`,
    );
  }
  for (const path of r.rebased ?? []) {
    lines.push(`- rebased ${path.where}: ${path.from} → ${path.to}`);
  }
  for (const warning of r.warnings) lines.push(`- warning: ${warning}`);
  return lines.join("\n");
}
