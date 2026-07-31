import { confirm, isCancel, S_BAR, S_INFO, S_SUCCESS } from "@clack/prompts";
import { AgentBrowserAdapter } from "../../adapters/agent-browser/AgentBrowserAdapter";
import { CheckpointStore } from "../../core/checkpoint/CheckpointStore";
import { ansiColors as c, clackLine } from "../progress";

export interface LoginOptions {
  url?: string;
  waitFor?: string;
  timeout?: string;
  provider?: string;
  device?: string;
}

/**
 * Interactive login flow.
 *
 *   cairn login my-app --url https://app.com/login
 *   cairn login my-app --url ... --wait-for text:Dashboard
 *   cairn login my-app --url ... --wait-for url:/dashboard
 *
 * Opens a headed browser, lets the user authenticate manually, then captures
 * the resulting state into `~/.cairntrace/checkpoints/<name>.json`.
 *
 * Without `--wait-for`, prompts the user to press ENTER once they're done.
 */
export async function loginCommand(
  name: string,
  opts: LoginOptions,
): Promise<void> {
  if (!opts.url) {
    process.stderr.write(
      "cairn login: --url is required (the page where the user logs in)\n",
    );
    process.exit(2);
  }

  const store = new CheckpointStore();
  let outPath: string;
  try {
    outPath = store.pathFor(name);
  } catch (e) {
    process.stderr.write(`cairn login: ${(e as Error).message}\n`);
    process.exit(2);
  }
  await store.ensureRoot();

  // Stable session name lets the user re-attach if cairn is killed mid-flow.
  const session = `cairn-login-${name}`;
  const adapter = new AgentBrowserAdapter({
    session,
    headed: true,
    ...(opts.provider !== undefined ? { provider: opts.provider } : {}),
    ...(opts.device !== undefined ? { device: opts.device } : {}),
  });

  const timeoutMs = Number(opts.timeout ?? 300_000);

  clackLine(`${c.dim}${S_INFO}${c.reset}`, `Opening browser at ${opts.url}`);
  const opened = await adapter.runStep({ open: opts.url });
  if (!opened.ok) {
    process.stderr.write(
      `cairn login: failed to open ${opts.url}: ${opened.stderr.trim() || `exit ${opened.exitCode}`}\n`,
    );
    process.exit(2);
  }

  if (opts.waitFor) {
    clackLine(
      `${c.dim}${S_INFO}${c.reset}`,
      `Waiting for ${opts.waitFor} ${c.dim}(timeout ${timeoutMs}ms)${c.reset}`,
    );
    const colon = opts.waitFor.indexOf(":");
    if (colon < 0) {
      process.stderr.write(
        `cairn login: invalid --wait-for "${opts.waitFor}" — use text:<...> or url:<...>\n`,
      );
      process.exit(2);
    }
    const kind = opts.waitFor.slice(0, colon);
    const arg = opts.waitFor.slice(colon + 1);
    let result;
    switch (kind) {
      case "text":
        result = await adapter.waitForText(arg, timeoutMs);
        break;
      case "url":
        result = await adapter.waitForUrl(arg, timeoutMs);
        break;
      default:
        process.stderr.write(
          `cairn login: unknown --wait-for kind "${kind}" — supported: text, url\n`,
        );
        process.exit(2);
    }
    if (!result.ok) {
      process.stderr.write(
        `cairn login: signal "${opts.waitFor}" not received before timeout\n`,
      );
      process.exit(2);
    }
  } else {
    // clack's confirm is the interactive capture gate: the user logs in in
    // the headed browser, then presses Enter (Yes is the default). A cancel
    // (Esc/Ctrl+C) aborts without capturing.
    const answer = await confirm({
      message: "Log in in the browser, then press Enter to capture",
      initialValue: true,
      output: process.stderr,
    });
    if (isCancel(answer) || answer === false) {
      process.stderr.write("cairn login: canceled\n");
      process.exit(2);
    }
  }

  const saved = await adapter.saveState(outPath);
  if (!saved.ok) {
    process.stderr.write(
      `cairn login: state save failed: ${saved.stderr.trim() || `exit ${saved.exitCode}`}\n`,
    );
    process.exit(2);
  }

  // Best-effort close — the user might keep the session alive.
  await adapter.close().catch(() => undefined);

  clackLine(
    `${c.green}${S_SUCCESS}${c.reset}`,
    `Saved checkpoint ${c.bold}${name}${c.reset} → ${outPath}`,
  );
  clackLine(
    `${c.dim}${S_BAR}${c.reset}`,
    `${c.dim}Reference it with:${c.reset} session: { resume: ${name} }`,
  );
}
