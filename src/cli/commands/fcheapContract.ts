import { z } from "zod";

export type FcheapContractCommand =
  | "save"
  | "list"
  | "info"
  | "search"
  | "connect"
  | "restore"
  | "publish";

export class FcheapContractError extends Error {
  readonly command: FcheapContractCommand;

  constructor(
    command: FcheapContractCommand,
    detail: string,
    options?: ErrorOptions,
  ) {
    super(`Invalid fcheap ${command} JSON: ${detail}`, options);
    this.name = "FcheapContractError";
    this.command = command;
  }
}

const NonEmptyStringSchema = z.string().trim().min(1);
const NonNegativeIntegerSchema = z.number().int().nonnegative();
const StringMapSchema = z.record(z.string());

const FileEntrySchema = z
  .object({
    path: NonEmptyStringSchema,
    size: NonNegativeIntegerSchema,
    hash: NonEmptyStringSchema.optional(),
  })
  .passthrough();

const ManifestSchema = z
  .object({
    schema_version: NonEmptyStringSchema,
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema.optional(),
    created_at: NonEmptyStringSchema,
    source_path: NonEmptyStringSchema.optional(),
    tool: NonEmptyStringSchema.optional(),
    tags: z.array(z.string()).optional(),
    file_count: NonNegativeIntegerSchema,
    total_size: NonNegativeIntegerSchema,
    content_hash: NonEmptyStringSchema,
    compression: NonEmptyStringSchema.optional(),
    compressed_size: NonNegativeIntegerSchema.optional(),
    bundle_type: NonEmptyStringSchema.optional(),
    expires_at: NonEmptyStringSchema.optional(),
    files: z.array(FileEntrySchema).optional(),
    custom: StringMapSchema.optional(),
  })
  .passthrough();

const SaveFailureSchema = z
  .object({
    id: NonEmptyStringSchema,
    stage: NonEmptyStringSchema,
    error: NonEmptyStringSchema,
  })
  .passthrough();

const SaveOutputSchema = ManifestSchema.partial()
  .extend({
    id: z.string().optional(),
    stashId: z.string().optional(),
    path: z.string().optional(),
    status: z.enum(["saved", "saved_with_failures"]).optional(),
    index_requested: z.boolean().optional(),
    indexed: z.boolean().optional(),
    auto_compression_requested: z.boolean().optional(),
    auto_compressed: z.boolean().optional(),
    failed: z.array(SaveFailureSchema).optional(),
  })
  .superRefine((value, context) => {
    if (
      ![value.id, value.stashId, value.path].some(
        (candidate) =>
          typeof candidate === "string" && candidate.trim().length > 0,
      )
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["id"],
        message: "expected a non-empty id, stashId, or path",
      });
    }
  });

const ListItemSchema = z
  .object({
    id: NonEmptyStringSchema,
    name: NonEmptyStringSchema.optional(),
    tool: NonEmptyStringSchema.optional(),
    tags: z.array(z.string()).optional(),
    file_count: NonNegativeIntegerSchema,
    total_size: NonNegativeIntegerSchema,
    compression: NonEmptyStringSchema.optional(),
    expires_at: NonEmptyStringSchema.optional(),
    created_at: NonEmptyStringSchema,
    custom: StringMapSchema.optional(),
  })
  .passthrough();

const ListOutputSchema = z.array(ListItemSchema);

const SearchResultSchema = z
  .object({
    stash_id: NonEmptyStringSchema,
    score: z.number(),
    text: z.string(),
    file: NonEmptyStringSchema.optional(),
    line: NonNegativeIntegerSchema.optional(),
    source: NonEmptyStringSchema.optional(),
  })
  .passthrough();

const SearchOutputSchema = z.array(SearchResultSchema);

const ConnectMatchSchema = SearchResultSchema.extend({
  file: NonEmptyStringSchema,
});
const ConnectMatchesSchema = z.array(ConnectMatchSchema);

const ConnectOutputSchema = z.union([
  z
    .object({
      stash_id: NonEmptyStringSchema,
      codebase: NonEmptyStringSchema,
      query: z.string(),
      matches: ConnectMatchesSchema,
      index_status: NonEmptyStringSchema.optional(),
    })
    .passthrough(),
  ConnectMatchesSchema,
]);

const RestoreStatusSchema = z.enum([
  "restored",
  "restored_unverified",
  "restored_with_mismatches",
]);

const RestoreOutputSchema = z
  .object({
    stash_id: NonEmptyStringSchema,
    target: NonEmptyStringSchema,
    file_count: NonNegativeIntegerSchema,
    verified: z.boolean(),
    mismatches: z.array(z.string()),
    status: RestoreStatusSchema,
  })
  .passthrough();

export const CAIRNTRACE_PUBLISH_KIND = "cairntrace.run";
export const CAIRNTRACE_PUBLISH_NATIVE_SCHEMA = "urn:cairntrace.dev:run:v1";
export const CAIRNTRACE_PUBLISH_ENTRYPOINT = "run.json";

const Sha256DigestSchema = z.string().regex(/^[a-f0-9]{64}$/);
const PortableRemoteIdSchema = z
  .string()
  .min(1)
  .max(160)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/)
  .refine((value) => value !== "." && value !== "..");
const ArtifactRefV1Schema = z
  .object({
    $schema: z.literal("urn:filecheap.dev:artifact-ref:v1"),
    version: z.literal(1),
    provider: z.literal("fcheap-cloud"),
    uri: NonEmptyStringSchema,
    artifact_id: PortableRemoteIdSchema,
    kind: z.literal(CAIRNTRACE_PUBLISH_KIND),
    producer: z
      .object({
        tool: z.literal("cairntrace"),
        version: z
          .string()
          .min(1)
          .max(64)
          .regex(/^[A-Za-z0-9][A-Za-z0-9._+-]*$/),
        native_schema: z.literal(CAIRNTRACE_PUBLISH_NATIVE_SCHEMA),
        native_id: PortableRemoteIdSchema,
        entrypoint: z.literal(CAIRNTRACE_PUBLISH_ENTRYPOINT),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      value.uri !==
      `fcheap://cloud/vaults/private/artifacts/${value.artifact_id}`
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["uri"],
        message:
          "must exactly match the canonical private fcheap-cloud URI for artifact_id",
      });
    }
    try {
      const parsed = new URL(value.uri);
      if (parsed.username || parsed.password || parsed.search || parsed.hash) {
        throw new Error("credentialed or unstable URI");
      }
    } catch {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "must be a credential-free stable URI",
      });
    }
  });

const PublishOutputSchema = z
  .object({
    version: z.literal("filecheap-publish/1"),
    artifact_ref: ArtifactRefV1Schema,
    sha256: Sha256DigestSchema,
    size_bytes: NonNegativeIntegerSchema,
    verification: z.literal("server-sha256"),
    published_at: z.string().datetime({ offset: true }),
  })
  .strict();

export interface FcheapFileEntry {
  path: string;
  size: number;
  hash?: string;
}

export interface FcheapSaveResult {
  stashId: string;
  schemaVersion?: string;
  status?: "saved" | "saved_with_failures";
  name?: string;
  createdAt?: string;
  sourcePath?: string;
  tool?: string;
  tags?: string[];
  fileCount?: number;
  sizeBytes?: number;
  contentHash?: string;
  compression?: string;
  compressedSizeBytes?: number;
  bundleType?: string;
  expiresAt?: string;
  files?: FcheapFileEntry[];
  custom?: Record<string, string>;
  indexRequested?: boolean;
  indexed?: boolean;
  autoCompressionRequested?: boolean;
  autoCompressed?: boolean;
  failed?: Array<{ id: string; stage: string; error: string }>;
}

export interface FcheapListItem {
  id: string;
  name?: string;
  tool?: string;
  tags?: string[];
  fileCount: number;
  sizeBytes: number;
  compression?: string;
  expiresAt?: string;
  createdAt: string;
  custom?: Record<string, string>;
}

export interface FcheapInfo {
  schemaVersion: string;
  id: string;
  name?: string;
  createdAt: string;
  sourcePath?: string;
  source?: string;
  tool?: string;
  tags: string[];
  fileCount: number;
  sizeBytes: number;
  contentHash: string;
  compression?: string;
  compressedSizeBytes?: number;
  bundleType?: string;
  expiresAt?: string;
  files?: FcheapFileEntry[];
  custom?: Record<string, string>;
}

export interface FcheapSearchResult {
  stashId: string;
  snippet: string;
  score: number;
  file?: string;
  line?: number;
  source?: string;
}

export interface FcheapConnectResult {
  stashId?: string;
  codebase?: string;
  query?: string;
  matches: FcheapSearchResult[];
  indexStatus?: string;
}

export type FcheapRestoreStatus = z.infer<typeof RestoreStatusSchema>;

export interface FcheapRestoreResult {
  stashId: string;
  restoredTo: string;
  fileCount: number;
  verified: boolean;
  mismatches: string[];
  status: FcheapRestoreStatus;
}

export interface FcheapPublishResult {
  artifactRef: z.infer<typeof ArtifactRefV1Schema>;
  sha256: string;
  sizeBytes: number;
  verification: "server-sha256";
  publishedAt: string;
}

function parseOutput<TSchema extends z.ZodTypeAny>(
  command: FcheapContractCommand,
  stdout: string,
  schema: TSchema,
): z.infer<TSchema> {
  let decoded: unknown;
  try {
    decoded = JSON.parse(stdout);
  } catch (cause) {
    throw new FcheapContractError(command, "malformed JSON", {
      cause,
    });
  }

  const result = schema.safeParse(decoded);
  if (!result.success) {
    const details = result.error.issues
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "output";
        return `${path}: ${issue.message}`;
      })
      .join("; ");
    throw new FcheapContractError(command, details, {
      cause: result.error,
    });
  }
  return result.data;
}

function normalizeFileEntry(
  entry: z.infer<typeof FileEntrySchema>,
): FcheapFileEntry {
  return {
    path: entry.path,
    size: entry.size,
    ...(entry.hash ? { hash: entry.hash } : {}),
  };
}

export function parseFcheapSaveOutput(stdout: string): FcheapSaveResult {
  const output = parseOutput("save", stdout, SaveOutputSchema);
  const stashId = [output.id, output.stashId, output.path]
    .find(
      (candidate) =>
        typeof candidate === "string" && candidate.trim().length > 0,
    )
    ?.trim();

  if (!stashId) {
    throw new FcheapContractError(
      "save",
      "expected a non-empty id, stashId, or path",
    );
  }

  return {
    stashId,
    schemaVersion: output.schema_version,
    status: output.status,
    name: output.name,
    createdAt: output.created_at,
    sourcePath: output.source_path,
    tool: output.tool,
    tags: output.tags,
    fileCount: output.file_count,
    sizeBytes: output.total_size,
    contentHash: output.content_hash,
    compression: output.compression,
    compressedSizeBytes: output.compressed_size,
    bundleType: output.bundle_type,
    expiresAt: output.expires_at,
    files: output.files?.map(normalizeFileEntry),
    custom: output.custom,
    indexRequested: output.index_requested,
    indexed: output.indexed,
    autoCompressionRequested: output.auto_compression_requested,
    autoCompressed: output.auto_compressed,
    failed: output.failed?.map((failure) => ({
      id: failure.id,
      stage: failure.stage,
      error: failure.error,
    })),
  };
}

export function parseFcheapListOutput(stdout: string): FcheapListItem[] {
  return parseOutput("list", stdout, ListOutputSchema).map((item) => ({
    id: item.id,
    name: item.name,
    tool: item.tool,
    tags: item.tags,
    fileCount: item.file_count,
    sizeBytes: item.total_size,
    compression: item.compression,
    expiresAt: item.expires_at,
    createdAt: item.created_at,
    custom: item.custom,
  }));
}

export function parseFcheapInfoOutput(stdout: string): FcheapInfo {
  const info = parseOutput("info", stdout, ManifestSchema);
  return {
    schemaVersion: info.schema_version,
    id: info.id,
    name: info.name,
    createdAt: info.created_at,
    sourcePath: info.source_path,
    source: info.custom?.source,
    tool: info.tool,
    tags: info.tags ?? [],
    fileCount: info.file_count,
    sizeBytes: info.total_size,
    contentHash: info.content_hash,
    compression: info.compression,
    compressedSizeBytes: info.compressed_size,
    bundleType: info.bundle_type,
    expiresAt: info.expires_at,
    files: info.files?.map(normalizeFileEntry),
    custom: info.custom,
  };
}

export function parseFcheapSearchOutput(stdout: string): FcheapSearchResult[] {
  return normalizeSearchResults(
    parseOutput("search", stdout, SearchOutputSchema),
  );
}

function normalizeSearchResults(
  results: z.infer<typeof SearchOutputSchema>,
): FcheapSearchResult[] {
  return results.map((result) => ({
    stashId: result.stash_id,
    snippet: result.text,
    score: result.score,
    file: result.file,
    line: result.line,
    source: result.source,
  }));
}

export function parseFcheapConnectOutput(stdout: string): FcheapConnectResult {
  const result = parseOutput("connect", stdout, ConnectOutputSchema);
  if (Array.isArray(result)) {
    return { matches: normalizeSearchResults(result) };
  }
  return {
    stashId: result.stash_id,
    codebase: result.codebase,
    query: result.query,
    matches: normalizeSearchResults(result.matches),
    indexStatus: result.index_status,
  };
}

export function parseFcheapRestoreOutput(stdout: string): FcheapRestoreResult {
  const result = parseOutput("restore", stdout, RestoreOutputSchema);
  return {
    stashId: result.stash_id,
    restoredTo: result.target,
    fileCount: result.file_count,
    verified: result.verified,
    mismatches: result.mismatches,
    status: result.status,
  };
}

/** Parse only a durable remote-publication receipt; pending uploads are invalid. */
export function parseFcheapPublishOutput(stdout: string): FcheapPublishResult {
  const result = parseOutput("publish", stdout, PublishOutputSchema);
  return {
    artifactRef: result.artifact_ref,
    sha256: result.sha256,
    sizeBytes: result.size_bytes,
    verification: result.verification,
    publishedAt: result.published_at,
  };
}
