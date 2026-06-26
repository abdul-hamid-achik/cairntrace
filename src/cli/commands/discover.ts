import { resolve } from "node:path";
import { isRelativeUrl, joinUrl } from "../../core/runner/url";
import { loadConfig } from "../../core/config/loader";
import { collectLocatorInventory } from "../../core/snapshot/locatorInventory";
import { parseSnapshot } from "../../core/healer/snapshotParser";
import { type BackendChoice, createBackend } from "../backendFactory";
import { trackBackend } from "../cleanup";
import { emit, resolveFormat } from "../format";

export interface DiscoverCommandOptions {
  roles?: boolean;
  testids?: boolean;
  env?: string;
  headed?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  config?: string;
  format?: string;
  json?: boolean;
  yaml?: boolean;
  md?: boolean;
}

export interface DiscoverReport {
  status: "ok";
  requestedUrl: string;
  url: string;
  backend: string;
  snapshot: Array<{
    role: string;
    name?: string;
    level: number;
    ref?: string;
  }>;
  inventory?: {
    roles?: Array<{
      role: string;
      name?: string;
      count: number;
      refs: string[];
      locator: { by: "role"; role: string; name?: string };
    }>;
    testids?: Array<{
      testId: string;
      count: number;
      selector: string;
      tagNames: string[];
      textSamples: string[];
    }>;
  };
}

/**
 * `cairn discover <url>` — enhanced snapshot that returns the full
 * accessibility tree + locator inventory in one call. The MCP discovery
 * tools (cairn_discover_*) are the primary interactive interface; this
 * CLI command is the one-shot equivalent.
 */
export async function discoverCommand(
  targetUrl: string,
  opts: DiscoverCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const backend = createBackend({
    ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
  });
  const untrack = trackBackend(backend);

  try {
    const resolvedUrl = await resolveDiscoverUrl(targetUrl, opts);
    const opened = await backend.runStep({ open: resolvedUrl });
    if (!opened.ok) {
      throw new Error(opened.stderr || opened.stdout || "open step failed");
    }

    // Capture full accessibility snapshot
    const snap = await backend.snapshot({ interactive: true });
    const snapshotElements = snap.ok ? parseSnapshot(snap.text) : [];

    // Collect inventory
    const includeRoles = opts.roles || (!opts.roles && !opts.testids);
    const includeTestIds = opts.testids || (!opts.roles && !opts.testids);
    let inventory;
    try {
      inventory = await collectLocatorInventory(backend, {
        roles: includeRoles,
        testids: includeTestIds,
      });
    } catch {
      // inventory is best-effort
    }

    const report: DiscoverReport = {
      status: "ok",
      requestedUrl: targetUrl,
      url: await backend.getUrl(),
      backend: backend.name,
      snapshot: snapshotElements.map((e) => ({
        role: e.role,
        ...(e.name ? { name: e.name } : {}),
        level: e.level,
        ...(e.ref ? { ref: e.ref } : {}),
      })),
      ...(inventory ? { inventory } : {}),
    };

    process.stdout.write(emit(format, report, discoverToMarkdown));
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  } catch (e) {
    process.stderr.write(`cairn discover: ${(e as Error).message}\n`);
    process.exit(2);
  } finally {
    untrack();
    await backend.close().catch(() => undefined);
  }
}

export async function resolveDiscoverUrl(
  targetUrl: string,
  opts: Pick<DiscoverCommandOptions, "config" | "env"> = {},
): Promise<string> {
  if (!isRelativeUrl(targetUrl)) return targetUrl;

  const loaded = await loadConfig(
    resolve(process.cwd(), "__cairntrace_discover__.yml"),
    opts.config,
  );
  const envName = opts.env ?? loaded?.config.defaultEnvironment ?? "local";
  const baseUrl = loaded?.config.environments[envName]?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `relative discover URL "${targetUrl}" requires environments.${envName}.baseUrl`,
    );
  }
  return joinUrl(baseUrl, targetUrl);
}

export function discoverToMarkdown(report: DiscoverReport): string {
  const lines = [
    `# Discover: ${report.url}`,
    "",
    `Backend: ${report.backend}`,
    "",
    "## Accessibility Snapshot",
  ];

  if (report.snapshot.length === 0) {
    lines.push("- (empty snapshot)");
  } else {
    for (const el of report.snapshot) {
      const indent = "  ".repeat(el.level);
      const name = el.name ? ` "${el.name}"` : "";
      const ref = el.ref ? ` [ref=${el.ref}]` : "";
      lines.push(`${indent}- ${el.role}${name}${ref}`);
    }
  }

  if (report.inventory?.roles) {
    lines.push("", "## Roles");
    if (report.inventory.roles.length === 0) {
      lines.push("- No role locators found");
    } else {
      for (const entry of report.inventory.roles) {
        const name = entry.name ? ` "${entry.name}"` : "";
        const count = entry.count > 1 ? ` (${entry.count} matches)` : "";
        const refs =
          entry.refs.length > 0 ? ` refs: ${entry.refs.join(", ")}` : "";
        const locator = entry.name
          ? `{ by: role, role: ${entry.role}, name: ${entry.name} }`
          : `{ by: role, role: ${entry.role} }`;
        lines.push(`- ${entry.role}${name}${count} -> ${locator}${refs}`);
      }
    }
  }

  if (report.inventory?.testids) {
    lines.push("", "## Test IDs");
    if (report.inventory.testids.length === 0) {
      lines.push("- No data-testid attributes found");
    } else {
      for (const entry of report.inventory.testids) {
        const count = entry.count > 1 ? ` (${entry.count} matches)` : "";
        const tags = entry.tagNames.join(", ");
        const sample = entry.textSamples[0]
          ? ` text: ${entry.textSamples[0]}`
          : "";
        lines.push(
          `- ${entry.testId}${count} -> ${entry.selector} tags: ${tags}${sample}`,
        );
      }
    }
  }

  return lines.join("\n");
}
