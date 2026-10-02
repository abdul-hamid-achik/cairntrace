import { readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import {
  buildAgentKitSnippet,
  upsertAgentKit,
} from "../../core/authoring/agentKit";
import {
  AgentKitResultSchema,
  type AgentKitResult,
} from "../../core/authoring/authoring.v1";
import { emit, resolveFormat } from "../format";

/**
 * `cairn init agent-kit [--write]`: print the project's AGENTS.md section
 * on authoring Cairntrace specs; `--write` puts it in the AGENTS.md next to
 * the config (created, appended, or the previous block replaced).
 */

export interface AgentKitCommandOptions {
  write?: boolean;
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export async function agentKit(
  opts: { write?: boolean; config?: string; cwd?: string } = {},
): Promise<AgentKitResult> {
  const cwd = opts.cwd ?? process.cwd();
  const kit = await buildAgentKitSnippet({
    cwd,
    ...(opts.config !== undefined ? { config: opts.config } : {}),
  });
  let written: AgentKitResult["written"];
  if (opts.write) {
    const path = join(kit.root, "AGENTS.md");
    const existing = await readFile(path, "utf8").catch(() => undefined);
    const next = upsertAgentKit(existing, kit.snippet);
    if (next.action !== "unchanged") await writeFile(path, next.text);
    const shown = relative(cwd, path);
    written = {
      path: shown && !shown.startsWith("..") ? shown : path,
      action: next.action,
    };
  }
  return AgentKitResultSchema.parse({
    $schema: "urn:cairntrace.dev:agent-kit:v1",
    version: "1",
    snippet: kit.snippet,
    ...(written ? { written } : {}),
    ...(kit.configPath ? { configPath: kit.configPath } : {}),
  });
}

export async function agentKitCommand(
  opts: AgentKitCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  let result: AgentKitResult;
  try {
    result = await agentKit({
      ...(opts.write ? { write: true } : {}),
      ...(opts.config !== undefined ? { config: opts.config } : {}),
    });
  } catch (e) {
    process.stderr.write(`cairn init agent-kit: ${(e as Error).message}\n`);
    process.exitCode = 2;
    return;
  }
  process.stdout.write(
    emit(format, result, (r) =>
      r.written
        ? `${r.written.path}: ${r.written.action}\n\n${r.snippet.trimEnd()}`
        : r.snippet.trimEnd(),
    ),
  );
  if (format !== "json" && format !== "yaml") process.stdout.write("\n");
}
