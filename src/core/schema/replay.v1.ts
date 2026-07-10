import { z } from "zod";
import { BackendSchema } from "./shared";

/**
 * Wire schema for the exact-replay manifest `replay.json` (SPEC §7.3) written
 * alongside `run.json`. It captures everything an agent or operator needs to
 * reproduce a run bit-for-bit WITHOUT re-reading the resolved spec: the exact
 * `cairn run` command, the backend, environment, base URL, viewport, resolved
 * capture policy, the redacted env/var KEY NAMES (never values), the cairn
 * version, and the run id. Treat as a v1 contract — bumping is a breaking
 * change for in-session agents.
 */
export const ReplayManifestSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:replay:v1")
      .default("urn:cairntrace.dev:replay:v1"),
    version: z.literal("1"),
    runId: z.string().min(1),
    specName: z.string().min(1),
    specPath: z.string().min(1),
    contractHash: z.string().optional(),
    /** The one exact shell command that reproduces this run. */
    replay: z.string().min(1),
    backend: BackendSchema,
    environment: z.string().optional(),
    baseUrl: z.string().optional(),
    viewport: z
      .object({
        width: z.number().int().positive(),
        height: z.number().int().positive(),
      })
      .optional(),
    capturePolicy: z
      .object({
        screenshots: z.enum(["always", "on-failure", "never"]).optional(),
        snapshots: z.enum(["always", "on-failure", "never"]).optional(),
        trace: z.enum(["always", "on-failure", "never"]).optional(),
        video: z.enum(["always", "on-failure", "never"]).optional(),
      })
      .optional(),
    /** NAMES of config/env vars the run resolved (never values). */
    envKeys: z.array(z.string()).optional(),
    versions: z
      .object({
        cairn: z.string(),
      })
      .passthrough(),
    generatedAt: z.string().min(1),
  })
  .strict();
export type ReplayManifest = z.infer<typeof ReplayManifestSchema>;

/**
 * Build the replay manifest for a run. `envKeys` must be NAMES ONLY — the
 * caller is responsible for never passing values (config var names + secret
 * key names). The manifest is redacted by the writer like every other artifact.
 */
export function buildReplayManifest(args: {
  runId: string;
  specName: string;
  specPath: string;
  contractHash?: string;
  backend: string;
  environment?: string;
  baseUrl?: string;
  viewport?: { width: number; height: number };
  capturePolicy?: {
    screenshots?: "always" | "on-failure" | "never";
    snapshots?: "always" | "on-failure" | "never";
    trace?: "always" | "on-failure" | "never";
    video?: "always" | "on-failure" | "never";
  };
  envKeys?: string[];
  cairnVersion: string;
  generatedAt: string;
}): ReplayManifest {
  return {
    $schema: "urn:cairntrace.dev:replay:v1",
    version: "1",
    runId: args.runId,
    specName: args.specName,
    specPath: args.specPath,
    ...(args.contractHash ? { contractHash: args.contractHash } : {}),
    replay: `cairn run ${args.specPath} --json`,
    backend: args.backend as ReplayManifest["backend"],
    ...(args.environment ? { environment: args.environment } : {}),
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.viewport ? { viewport: args.viewport } : {}),
    ...(args.capturePolicy ? { capturePolicy: args.capturePolicy } : {}),
    ...(args.envKeys && args.envKeys.length > 0
      ? { envKeys: args.envKeys }
      : {}),
    versions: { cairn: args.cairnVersion },
    generatedAt: args.generatedAt,
  };
}
