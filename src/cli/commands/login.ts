import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { AgentBrowserAdapter } from "../../adapters/agent-browser/AgentBrowserAdapter";
import { CheckpointStore } from "../../core/checkpoint/CheckpointStore";

export interface LoginOptions {
  url?: string;
  waitFor?: string;
  timeout?: string;
}

const ANSI = { dim: "\x1b[2m", green: "\x1b[32m", reset: "\x1b[0m" };

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
  const adapter = new AgentBrowserAdapter({ session, headed: true });

  const timeoutMs = Number(opts.timeout ?? 300_000);

  process.stdout.write(
    `${ANSI.dim}Opening browser at${ANSI.reset} ${opts.url}\n`,
  );
  const opened = await adapter.runStep({ open: opts.url });
  if (!opened.ok) {
    process.stderr.write(
      `cairn login: failed to open ${opts.url}: ${opened.stderr.trim() || `exit ${opened.exitCode}`}\n`,
    );
    process.exit(2);
  }

  if (opts.waitFor) {
    process.stdout.write(
      `${ANSI.dim}Waiting for${ANSI.reset} ${opts.waitFor} ${ANSI.dim}(timeout ${timeoutMs}ms)${ANSI.reset}\n`,
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
    const rl = createInterface({ input: stdin, output: stdout });
    try {
      await rl.question(
        `${ANSI.dim}Log in in the browser, then press ENTER to capture…${ANSI.reset} `,
      );
    } finally {
      rl.close();
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

  process.stdout.write(
    `${ANSI.green}✓ Saved checkpoint${ANSI.reset} "${name}" → ${outPath}\n`,
  );
  process.stdout.write(
    `${ANSI.dim}Reference it with:${ANSI.reset} session: { resume: ${name} }\n`,
  );
}
