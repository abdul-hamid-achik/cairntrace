import {
  type BrowseTarget,
  redactBrowseUrl,
  resolveBrowseTarget,
} from "../../core/discovery/browseTarget";
import {
  collectLocatorInventory,
  type LocatorInventory,
} from "../../core/snapshot/locatorInventory";
import { type BackendChoice, createBackend } from "../backendFactory";
import { trackBackend } from "../cleanup";
import { emit, resolveFormat } from "../format";
import { log } from "../logger";
import { browseErrorExitCode } from "./discover";
import { backendOpts, parseVarFlags } from "./run";

export interface SnapshotCommandOptions {
  roles?: boolean;
  testids?: boolean;
  waitUntil?: "networkidle" | "load" | "domcontentloaded";
  env?: string;
  headed?: boolean;
  mock?: boolean;
  backend?: BackendChoice;
  provider?: string;
  device?: string;
  config?: string;
  /** Repeatable `--var key=value` overrides for `${vars.X}` in the URL. */
  var?: string[];
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
  // Same config/env/var resolution as `cairn discover`: URL, baseUrl and the
  // project `browser:` block (testIdAttribute!) come from cairntrace.config.yml.
  let target: BrowseTarget;
  try {
    target = await resolveSnapshotTarget(targetUrl, opts);
  } catch (e) {
    process.stderr.write(`cairn snapshot: ${(e as Error).message}\n`);
    process.exit(browseErrorExitCode(e));
    return;
  }
  for (const warning of target.warnings) log.warn(warning);

  const backend = createBackend(backendOpts(opts, target.browser));
  const untrack = trackBackend(backend);

  try {
    const resolvedUrl = target.url;
    // Use the object-form open with waitUntil so SPA inventory isn't captured
    // pre-hydration (a bare open snapshots immediately, before the framework
    // renders interactive elements).
    const openStep =
      opts.waitUntil !== undefined
        ? { open: { path: resolvedUrl, waitUntil: opts.waitUntil } }
        : { open: resolvedUrl };
    const opened = await backend.runStep(openStep);
    if (!opened.ok) {
      throw new Error(
        redactBrowseUrl(
          target,
          opened.stderr || opened.stdout || "open step failed",
        ),
      );
    }

    const includeRoles = opts.roles || (!opts.roles && !opts.testids);
    const includeTestIds = opts.testids || (!opts.roles && !opts.testids);
    const inventory = await collectLocatorInventory(backend, {
      roles: includeRoles,
      testids: includeTestIds,
      ...(target.testIdAttribute
        ? { testIdAttribute: target.testIdAttribute }
        : {}),
    });
    const report: SnapshotReport = {
      status: "ok",
      requestedUrl: targetUrl,
      // The page URL can carry a secret the resolved URL had; never print it.
      url: redactBrowseUrl(target, await backend.getUrl()),
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

/**
 * Resolve the snapshot target (URL + project browser settings) from config.
 * `--var` values feed `${vars.X}` in the URL.
 */
export async function resolveSnapshotTarget(
  targetUrl: string,
  opts: Pick<SnapshotCommandOptions, "config" | "env" | "var"> = {},
): Promise<BrowseTarget> {
  const vars = parseVarFlags(opts.var);
  return resolveBrowseTarget({
    url: targetUrl,
    label: "snapshot",
    ...(opts.env !== undefined ? { env: opts.env } : {}),
    ...(opts.config !== undefined ? { config: opts.config } : {}),
    ...(Object.keys(vars).length > 0 ? { vars } : {}),
  });
}

export async function resolveSnapshotUrl(
  targetUrl: string,
  opts: Pick<SnapshotCommandOptions, "config" | "env" | "var"> = {},
): Promise<string> {
  return (await resolveSnapshotTarget(targetUrl, opts)).url;
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
        const count =
          entry.count > 1
            ? ` (${entry.count} matches; add nth to disambiguate)`
            : "";
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
    const attribute = report.testIdAttribute ?? "data-testid";
    lines.push(
      "",
      attribute === "data-testid"
        ? "## Test IDs"
        : `## Test IDs (${attribute})`,
    );
    if (report.testids.length === 0) {
      lines.push(`- No ${attribute} attributes found`);
    } else {
      for (const entry of report.testids) {
        const count =
          entry.count > 1
            ? ` (${entry.count} matches; add nth to disambiguate)`
            : "";
        const tags = entry.tagNames.join(", ");
        const sample = entry.textSamples[0]
          ? ` text: ${entry.textSamples[0]}`
          : "";
        // `by: testid` reads browser.testIdAttribute at run time, so the
        // first-class locator stays portable; the raw selector is kept too.
        lines.push(
          `- ${entry.testId}${count} -> { by: testid, testid: ${entry.testId} } (selector: ${entry.selector}) tags: ${tags}${sample}`,
        );
      }
    }
  }

  return lines.join("\n");
}
