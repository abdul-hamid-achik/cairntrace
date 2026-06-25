import { z } from "zod";

/**
 * Wire schema for `cairn docs --json` and MCP `cairn_docs`.
 * This is intentionally concise: agents can fetch topic-sized docs without
 * scraping README prose or loading the whole project into context.
 */

export const DocsTopicSchema = z.enum([
  "overview",
  "authoring",
  "steps",
  "verifiers",
  "downloads",
  "scripts",
  "artifacts",
  "mcp",
  "backends",
  "stash",
  "investigate",
  "clip",
  "annotate",
  "secrets",
  "services",
]);
export type DocsTopic = z.infer<typeof DocsTopicSchema>;

export const DocsExampleSchema = z
  .object({
    title: z.string().min(1),
    language: z.string().min(1),
    code: z.string().min(1),
  })
  .strict();
export type DocsExample = z.infer<typeof DocsExampleSchema>;

export const DocsSectionSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().min(1),
  })
  .strict();
export type DocsSection = z.infer<typeof DocsSectionSchema>;

export const DocsResultSchema = z
  .object({
    $schema: z
      .literal("urn:cairntrace.dev:docs:v1")
      .default("urn:cairntrace.dev:docs:v1"),
    version: z.literal("1"),
    topic: DocsTopicSchema,
    title: z.string().min(1),
    summary: z.string().min(1),
    sections: z.array(DocsSectionSchema),
    examples: z.array(DocsExampleSchema).default([]),
    relatedTopics: z.array(DocsTopicSchema).default([]),
  })
  .strict();
export type DocsResult = z.infer<typeof DocsResultSchema>;
