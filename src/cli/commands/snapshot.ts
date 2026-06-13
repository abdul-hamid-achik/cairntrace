import { resolve } from "node:path";
import { loadConfig } from "../../core/config/loader";
import {
  collectLocatorInventory,
  type LocatorInventory,
} from "../../core/snapshot/locatorInventory";
import { isRelativeUrl, joinUrl } from "../../core/runner/url";
import { type BackendChoice, createBackend } from "../backendFactory";
import { trackBackend } from "../cleanup";
import { emit, resolveFormat } from "../format";

export interface SnapshotCommandOptions {
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

export interface SnapshotReport extends LocatorInventory {
  status: "ok";
  requestedUrl: string;
  url: string;
  backend: string;
}

export async function snapshotCommand(
  targetUrl: string,
  opts: SnapshotCommandOptions,
): Promise<void> {
  const format = resolveFormat(opts, "md");
  const backend = createBackend({
    ...(opts.mock !== undefined ? { mock: opts.mock } : {}),
    ...(opts.headed !== undefined ? { headed: opts.headed } : {}),
    ...(opts.backend !== undefined ? { backend: opts.backend } : {}),
  });
  const untrack = trackBackend(backend);

  try {
    const resolvedUrl = await resolveSnapshotUrl(targetUrl, opts);
    const opened = await backend.runStep({ open: resolvedUrl });
    if (!opened.ok) {
      throw new Error(opened.stderr || opened.stdout || "open step failed");
    }

    const includeRoles = opts.roles || (!opts.roles && !opts.testids);
    const includeTestIds = opts.testids || (!opts.roles && !opts.testids);
    const inventory = await collectLocatorInventory(backend, {
      roles: includeRoles,
      testids: includeTestIds,
    });
    const report: SnapshotReport = {
      status: "ok",
      requestedUrl: targetUrl,
      url: await backend.getUrl(),
      backend: backend.name,
      ...inventory,
    };

    process.stdout.write(emit(format, report, snapshotToMarkdown));
    if (format !== "json" && format !== "yaml") process.stdout.write("\n");
  } catch (e) {
    process.stderr.write(`cairn snapshot: ${(e as Error).message}\n`);
    process.exit(2);
  } finally {
    untrack();
    await backend.close().catch(() => undefined);
  }
}

export async function resolveSnapshotUrl(
  targetUrl: string,
  opts: Pick<SnapshotCommandOptions, "config" | "env"> = {},
): Promise<string> {
  if (!isRelativeUrl(targetUrl)) return targetUrl;

  const loaded = await loadConfig(
    resolve(process.cwd(), "__cairntrace_snapshot__.yml"),
    opts.config,
  );
  const envName = opts.env ?? loaded?.config.defaultEnvironment ?? "local";
  const baseUrl = loaded?.config.environments[envName]?.baseUrl;
  if (!baseUrl) {
    throw new Error(
      `relative snapshot URL "${targetUrl}" requires environments.${envName}.baseUrl`,
    );
  }
  return joinUrl(baseUrl, targetUrl);
}

function snapshotToMarkdown(report: SnapshotReport): string {
  const lines = [`# Snapshot: ${report.url}`, "", `Backend: ${report.backend}`];

  if (report.roles) {
    lines.push("", "## Roles");
    if (report.roles.length === 0) {
      lines.push("- No role locators found");
    } else {
      for (const entry of report.roles) {
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

  if (report.testids) {
    lines.push("", "## Test IDs");
    if (report.testids.length === 0) {
      lines.push("- No data-testid attributes found");
    } else {
      for (const entry of report.testids) {
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
